/**
 * Assisted booking round 2a (ASSISTED_BOOKING_DESIGN.md §24.4, owner answers of 23 Nov): a pharmacy books a partner-lab
 * test for a walk-in patient and pays from its pharmacy wallet. Money (exact debit; refund exactly once under a
 * booker / patient / lab race; refunds always post), scope (another pharmacy and another lab get the one 404), the
 * names rule, booker report access (released only, 90 days, while operational), the 1-hour booker cutoff, request keys
 * (replay, other content 409, abandoned), the switch, the index 503, earnings with cut 0, "not mine" and the admin move,
 * reconciliation. Real routes over HTTP (configureRoutes) on MongoDB; notices are captured.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r11_phase2a_check?directConnection=true' npx tsx test/assisted/r11-phase2a.integration.ts
 */
import { removeFixtureDir } from '../partners/q3-fixture-dir';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { errorHandler } from '@/modules/middleware';
import UserModel from '@/modules/user/model';
import { UserRepository } from '@/modules/user/repository';
import DependentModel from '@/modules/dependents/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { CouponModel } from '@/modules/coupon/model';
import { CouponRedemptionModel } from '@/modules/coupon/model/redemption';
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { postPharmacyMovementIn } from '@/modules/pharmacyWallet/ledger';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import CatalogueItemModel from '@/modules/partners/model/catalogueItem';
import { PartnerSlotModel } from '@/modules/partners/model/slot';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { LedgerEntryModel } from '@/modules/partners/model/settlement';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { PartnerService, type PartnerActor } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { resetIndexChecks } from '@/modules/common/utils/requiredIndex';
import { AssistedAuditEventModel, AssistedReviewItemModel } from '@/modules/assisted/model';
import { setAssistedNotifier } from '@/modules/assisted/support';
import { maskName } from '@/modules/assisted/names';
import type { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r11_phase2a_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;

// ── Services (tsx emits no decorator metadata: wired by hand) ──
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(),
  getRazorpayClient: () => ({ orders: { fetchPayments: async () => ({ items: [] }) } }), getRazorpayCredentials: () => ({ keyId: 'k', keySecret: 's' }),
}) as unknown as PaymentService;
const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
const catalogueSvc = new CatalogueService(new CatalogueItemRepository());
const labSvc = new LabBookingService(payments, new CouponService(new CouponRepository()), new WalletRepository());
const labNotices: { userId: string; key: string; title: string; message: string }[] = [];
labSvc.notify = async (n) => { labNotices.push({ userId: n.userId, key: n.key, title: n.title, message: n.message }); };
Container.set(PartnerService, partnerSvc);
Container.set(CatalogueService, catalogueSvc);
Container.set(LabBookingService, labSvc);
Container.set(PaymentService, payments);
Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
Container.set(BannerService, new BannerService(new BannerRepository()));
const assistedNotices: { audience: string; userId: string; key: string; title: string; message: string }[] = [];
setAssistedNotifier(async (n) => { assistedNotices.push({ audience: n.audience, userId: n.userId, key: n.key, title: n.title, message: n.message }); });

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let phoneSeq = 7110000000;
const nextPhone = () => String(phoneSeq++);
let keySeq = 0;
const newKey = () => `r11-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  const { configureRoutes } = await import('@/routes');
  for (const name of mongoose.modelNames()) {
    const m = mongoose.model(name);
    await m.createCollection().catch(() => undefined);
    await m.syncIndexes();
  }
  const app = express();
  app.use(express.json());
  configureRoutes(app);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '100000';
  const flagsOn = () => {
    process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
    process.env.ASSISTED_LAB_BOOKING_ENABLED_PHARMACY = 'true';
    process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';
  };
  flagsOn();

  try {
    // ── Labs: a verified lab (two branches, staff), a second verified lab, an unverified lab and a clinic ──
    const { partner, owner } = await partnerSvc.createPartner({
      kind: 'lab', name: 'Metro Labs', legalName: 'Metro Labs Pvt Ltd', contactPhone: nextPhone(), invoiceSeriesPrefix: 'ML',
      firstOwner: { phone: nextPhone(), name: 'Owner' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZH',
    } as never);
    const L = String(partner._id);
    await partnerSvc.verifyPartner(L, 'admin');
    const own = actorFor(owner);
    const branchIn = (name: string, pincode: string, city: string, services = { homeCollection: true, inLab: true, inClinic: false }) => ({ name, phone: '9876500000',
      holidays: [], hours: {}, services, address: { line1: '1 Road', city, state: 'Meghalaya', stateCode: '17', pincode } }) as never;
    const A = String((await partnerSvc.createBranch(own, branchIn('Police Bazar', '793001', 'Shillong')))._id);
    const B = String((await partnerSvc.createBranch(own, branchIn('Laitumkhrah', '793003', 'Shillong', { homeCollection: false, inLab: true, inClinic: false })))._id);
    const pathologist = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Dr Rao', role: 'staff', permissions: ['bookings.view', 'bookings.manage', 'reports.upload', 'reports.release'] } as never);
    await MemberModel.updateOne({ _id: pathologist._id }, { $set: { professional: { kind: 'pathologist', registrationNumber: 'MMC-12345' } } });
    const cbc = String((await catalogueSvc.createItem(own, { kind: 'test', name: 'CBC', priceMinor: 50000, gstRate: 0, visitModes: ['home', 'lab'], reportTatHours: 24 } as never))._id);
    const lipid = String((await catalogueSvc.createItem(own, { kind: 'test', name: 'Lipid', priceMinor: 30000, gstRate: 0, visitModes: ['lab'] } as never))._id);
    const hidden = String((await catalogueSvc.createItem(own, { kind: 'test', name: 'Hidden', priceMinor: 10000, gstRate: 0, visitModes: ['lab', 'home'] } as never))._id);
    await catalogueSvc.setAdminDisabled('adm', hidden, true);

    const second = await partnerSvc.createPartner({ kind: 'lab', name: 'Far Labs', legalName: 'Far Labs', contactPhone: nextPhone(), invoiceSeriesPrefix: 'FL',
      firstOwner: { phone: nextPhone(), name: 'Owner Two' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZX' } as never);
    const L2 = String(second.partner._id);
    await partnerSvc.verifyPartner(L2, 'admin');
    const own2 = actorFor(second.owner);
    const A2 = String((await partnerSvc.createBranch(own2, branchIn('Delhi', '110001', 'Delhi')))._id);
    const far = String((await catalogueSvc.createItem(own2, { kind: 'test', name: 'Far CBC', priceMinor: 40000, gstRate: 0, visitModes: ['lab', 'home'] } as never))._id);

    const unverified = await partnerSvc.createPartner({ kind: 'lab', name: 'New Labs', legalName: 'New Labs', contactPhone: nextPhone(), invoiceSeriesPrefix: 'NL',
      firstOwner: { phone: nextPhone(), name: 'Owner Three' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZY' } as never);
    const LU = String(unverified.partner._id);
    const AU = String((await partnerSvc.createBranch(actorFor(unverified.owner), branchIn('New', '793001', 'Shillong')))._id);
    const unvItem = String((await catalogueSvc.createItem(actorFor(unverified.owner), { kind: 'test', name: 'CBC', priceMinor: 100, gstRate: 0, visitModes: ['lab'] } as never))._id);
    const CL = oid();
    await PartnerModel.collection.insertOne({ _id: new Types.ObjectId(CL), kind: 'clinic', name: 'A Clinic', isActive: true, verification: { state: 'verified' } } as never);

    // ── Slots (manual rows; unique per branch, mode and minute) ──
    let minute = 0;
    const slotAt = async (branchId: string, mode: 'lab' | 'home', startsAt: Date, capacity = 5, partnerId = L) => {
      const s = new Date(startsAt.getTime() + IST).toISOString();
      const e = new Date(startsAt.getTime() + 30 * MIN + IST).toISOString();
      const row = await PartnerSlotModel.create({ partnerId, branchId, visitMode: mode, date: s.slice(0, 10), startTime: s.slice(11, 16), endTime: e.slice(11, 16),
        startsAt, endsAt: new Date(startsAt.getTime() + 30 * MIN), capacity, booked: 0, closed: null, source: 'manual' } as never);
      return String(row._id);
    };
    /** A fresh slot `hours` ahead, a distinct minute each time. */
    const slot = (hours = 30, mode: 'lab' | 'home' = 'lab', capacity = 5, branchId = A, partnerId = L) =>
      slotAt(branchId, mode, new Date(Math.floor(Date.now() / MIN) * MIN + hours * 3_600_000 + (++minute) * MIN), capacity, partnerId);
    const seats = async (slotId: string) => Number((await PartnerSlotModel.findById(slotId).lean())!.booked);

    // ── Pharmacies, people, wallets ──
    const P = oid(); const Q = oid(); const W = oid(); const R = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700000301', city: 'Shillong', pincode: '793001', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(Q), name: 'Other Pharmacy', phone: '9700000302', city: 'Aizawl', pincode: '796001', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(W), name: 'Small Wallet', phone: '9700000303', city: 'Shillong', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(R), name: 'Lookup Pharmacy', phone: '9700000304', city: 'Shillong', isActive: true, isVerified: true },
    ] as never);
    const X = oid(); const Y = oid(); const Z = oid(); const ADMIN = oid();
    await UserModel.collection.insertMany([
      { _id: new Types.ObjectId(X), userType: 'user', phone: '9600000301', name: 'Rina Kumari Das', createdSource: 'self_signup', otpVerified: true },
      { _id: new Types.ObjectId(Y), userType: 'user', phone: '9600000302', name: 'Bikash Thapa', createdSource: 'self_signup', otpVerified: true },
      { _id: new Types.ObjectId(Z), userType: 'user', phone: '9600000303', name: 'Zed Holder', createdSource: 'self_signup', otpVerified: true },
    ] as never);
    for (const u of [X, Y, Z]) await WalletModel.create({ userId: u, balance: 0, isActive: true });
    const depX = String((await DependentModel.create({ userId: X, name: 'Mina Das', relationship: 'Daughter', gender: 'Female', isActive: true } as never))._id);
    const credit = (pharmacyId: string, paise: number) => runLedgerTransaction((s) => postPharmacyMovementIn({ pharmacyId, kind: 'credit', amountPaise: paise,
      operationKey: `seed:${oid()}`, referenceType: 'admin_topup', referenceId: oid(), description: 'seed' }, s));
    await credit(P, 1_000_000); await credit(Q, 1_000_000); await credit(W, 60_000); await credit(R, 1_000_000);
    const balance = async (pharmacyId: string) => Number((await PharmacyWalletModel.findOne({ pharmacyId }).lean() as any)?.balancePaise ?? 0);

    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const tokens: Record<string, string> = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), Q: sign({ _id: Q, pharmacyId: Q, userType: 'pharmacy' }),
      W: sign({ _id: W, pharmacyId: W, userType: 'pharmacy' }), R: sign({ _id: R, pharmacyId: R, userType: 'pharmacy' }),
      X: sign({ _id: X, userType: 'user', authVersion: 0 }), Y: sign({ _id: Y, userType: 'user', authVersion: 0 }), Z: sign({ _id: Z, userType: 'user', authVersion: 0 }),
      ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
      LAB: sign({ _id: String(pathologist._id), memberId: String(pathologist._id), partnerId: L, userType: 'partner' }),
      LAB2: sign({ _id: String(second.owner._id), memberId: String(second.owner._id), partnerId: L2, userType: 'partner' }),
    };
    const call = async (who: string | null, method: string, url: string, body?: unknown) => {
      const r = await fetch(base + url, { method, headers: { ...(who ? { authorization: `Bearer ${tokens[who] ?? who}` } : {}), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any; try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, json, text };
    };
    const expect = async (who: string | null, method: string, url: string, status: number, body?: unknown, code?: string) => {
      const r = await call(who, method, url, body);
      assert.equal(r.status, status, `${who} ${method} ${url}: ${r.status} ${r.text.slice(0, 400)}`);
      if (code) assert.equal(r.json.code, code, `${who} ${method} ${url}: ${r.text.slice(0, 400)}`);
      return r;
    };
    const PA = '/api/v1/pharmacy-assisted';
    const WS = '/api/v1/partner-workspace';
    const order = (slotId: string, extra: Record<string, unknown> = {}) => ({
      requestKey: newKey(), phone: '9600000301', patient: { relation: 'self', name: 'Rina D' }, consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' },
      preferredLanguage: 'kha', partnerId: L, branchId: A, visitMode: 'lab', slotId, itemIds: [cbc], acceptedPriceMinor: 50000, paymentMethod: 'wallet', ...extra,
    });
    const book = async (who: string, body: Record<string, unknown>) => (await expect(who, 'POST', `${PA}/lab-bookings`, 201, body)).json.data;
    const stored = async (id: string) => await PartnerLabBookingModel.findById(id).lean() as any;
    const debitsOf = (id: string) => PharmacyWalletTransactionModel.countDocuments({ operationKey: `assisted_lab:${id}:debit` });
    const refundsOf = (id: string) => PharmacyWalletTransactionModel.find({ operationKey: `assisted_lab:${id}:refund` }).lean();

    // ───────────────────────── Switch and indexes ─────────────────────────
    await check('switch off: lab reads and new lab bookings answer 503 ASSISTED_BOOKING_DISABLED (each switch alone too); nothing is held', async () => {
      const s1 = await slot();
      for (const off of ['ASSISTED_LAB_BOOKING_ENABLED_PHARMACY', 'ASSISTED_BOOKING_ENABLED_PHARMACY']) {
        flagsOn(); delete process.env[off];
        await expect('P', 'GET', `${PA}/labs`, 503, undefined, 'ASSISTED_BOOKING_DISABLED');
        await expect('P', 'GET', `${PA}/labs/${L}/catalogue`, 503, undefined, 'ASSISTED_BOOKING_DISABLED');
        await expect('P', 'GET', `${PA}/labs/branches/${A}/slots?visitMode=lab`, 503, undefined, 'ASSISTED_BOOKING_DISABLED');
        await expect('P', 'POST', `${PA}/lab-bookings`, 503, order(s1), 'ASSISTED_BOOKING_DISABLED');
        // Reads always work.
        await expect('P', 'GET', `${PA}/lab-bookings`, 200);
      }
      flagsOn();
      assert.equal(await PartnerLabBookingModel.countDocuments({}), 0);
      assert.equal(await seats(s1), 0);
    });

    await check('index 503: without the unique assisted.requestKey index a create answers 503 INDEXES_OUTDATED and nothing is written', async () => {
      const col = mongoose.connection.collection('partner_lab_bookings');
      await col.dropIndex('assisted.requestKey_1');
      resetIndexChecks();
      const s1 = await slot();
      const before = await balance(P);
      try {
        await expect('P', 'POST', `${PA}/lab-bookings`, 503, order(s1), 'INDEXES_OUTDATED');
      } finally {
        await col.createIndex({ 'assisted.requestKey': 1 }, { unique: true, partialFilterExpression: { 'assisted.requestKey': { $type: 'string' } } });
        resetIndexChecks();
      }
      assert.equal(await PartnerLabBookingModel.countDocuments({}), 0);
      assert.equal(await balance(P), before);
      assert.equal(await seats(s1), 0);
    });

    // ───────────────────────── Reads ─────────────────────────
    await check('reads: only verified, active labs with active branches, nearest first; the catalogue hides disabled tests; slots start 60+ min ahead', async () => {
      await slot(0.5); // inside the 60-minute lead: never offered
      const labs = (await expect('P', 'GET', `${PA}/labs`, 200)).json.data;
      assert.deepEqual(labs.map((l: any) => l.partnerId), [L, L2], 'unverified lab and clinic left out; the pharmacy\'s pincode first');
      assert.equal(labs[0].nearby, 'pincode');
      assert.equal(labs[1].nearby, null);
      assert.deepEqual(Object.keys(labs[0].branches[0]).sort(), ['address', 'branchId', 'homeCollection', 'inLab', 'name', 'phone']);
      const home = (await expect('P', 'GET', `${PA}/labs?visitMode=home`, 200)).json.data;
      assert.deepEqual(home.find((l: any) => l.partnerId === L).branches.map((b: any) => b.branchId), [A], 'branch B has no home collection');
      const cat = (await expect('P', 'GET', `${PA}/labs/${L}/catalogue?visitMode=lab`, 200)).json.data;
      assert.deepEqual(cat.map((i: any) => i.name).sort(), ['CBC', 'Lipid']);
      await expect('P', 'GET', `${PA}/labs/${LU}/catalogue`, 404, undefined, 'LAB_NOT_FOUND');
      const slots = (await expect('P', 'GET', `${PA}/labs/branches/${A}/slots?visitMode=lab&days=3`, 200)).json.data;
      assert.ok(slots.length >= 1);
      assert.ok(slots.every((x: any) => x.seatsLeft >= 1));
      await expect('P', 'GET', `${PA}/labs/branches/${AU}/slots?visitMode=lab`, 404, undefined, 'BRANCH_NOT_AVAILABLE');
      await expect('P', 'GET', `${PA}/labs/branches/${A}/slots?visitMode=lab&days=15`, 400);
    });

    // ───────────────────────── Create ─────────────────────────
    let first: any; let firstSlot = '';
    await check('create: one exact wallet debit, one seat, confirmed/paid, source + assisted stored, link with the typed name; receipt shape; patient told', async () => {
      firstSlot = await slot();
      const before = await balance(P);
      const body = order(firstSlot, { itemIds: [cbc, lipid], acceptedPriceMinor: 80000 });
      const r = await expect('P', 'POST', `${PA}/lab-bookings`, 201, body);
      first = { ...r.json.data, body };
      const d = r.json.data;
      assert.equal(d.replayed, false);
      assert.equal(d.newAccount, false);
      assert.deepEqual(d.funding.method, 'wallet');
      assert.equal(d.funding.amountMinor, 80000);
      assert.equal(d.funding.state, 'captured');
      assert.deepEqual(d.split, { listMinor: 80000, discountMinor: 0, couponCode: null });
      assert.equal(await balance(P), before - 80000, 'exactly the price, in paise');
      const id = d.booking._id;
      assert.equal(await debitsOf(id), 1);
      assert.equal(await seats(firstSlot), 1);
      const b = await stored(id);
      assert.equal(b.status, 'confirmed'); assert.equal(b.paymentStatus, 'paid'); assert.equal(b.source, 'pharmacy_assisted');
      assert.equal(b.statusVersion, 0);
      assert.equal(b.userId, X);
      assert.equal(b.patient.name, 'Rina D', 'the typed name, never the account name');
      assert.equal(b.assisted.bookedBy.id, P.toLowerCase());
      assert.equal(b.assisted.split.rule, 'provider_coupon_v2');
      assert.equal(b.assisted.split.cutMinor, 0);
      assert.equal(b.assisted.referral, null);
      assert.equal(b.pricing.commissionMinor, 0);
      assert.equal(b.createRequestKey, undefined, 'the customer key namespace is untouched');
      assert.deepEqual(b.assisted.split.lines.map((l: any) => [l.listMinor, l.discountMinor, l.baseMinor, l.cutMinor]), [[50000, 0, 50000, 0], [30000, 0, 30000, 0]]);
      const link = await PharmacyCustomerModel.findOne({ pharmacyId: new Types.ObjectId(P), userId: new Types.ObjectId(X) }).lean() as any;
      assert.equal(link.consent, 'patient_agreed'); assert.equal(link.typedName, 'Rina D');
      // The receipt's booking is the booker view: no prices, keys or funding internals.
      assert.equal(d.booking.pricing, undefined); assert.equal(d.booking.assisted.requestKey, undefined); assert.equal(d.booking.assisted.funding, undefined);
      assert.deepEqual(d.booking.payment, { method: 'wallet', state: 'captured', payBy: null });
      assert.ok(labNotices.some((n) => n.key === `assisted:lab:${id}:booked:customer` && n.userId === X && n.message.includes('Sharma Medicals')));
      assert.ok(await AssistedAuditEventModel.exists({ action: 'booking.created', bookingId: id, 'detail.kind': 'lab_booking' }));
    });

    await check('request keys: the same key and body replays 200 (nothing moves); the same key with other tests is 409; by-key; an abandoned key never books', async () => {
      const before = await balance(P);
      const again = await expect('P', 'POST', `${PA}/lab-bookings`, 200, first.body);
      assert.equal(again.json.data.replayed, true);
      assert.equal(again.json.data.booking._id, first.booking._id);
      assert.equal(await balance(P), before);
      assert.equal(await seats(firstSlot), 1);
      await expect('P', 'POST', `${PA}/lab-bookings`, 409, { ...first.body, itemIds: [cbc], acceptedPriceMinor: 50000 }, 'IDEMPOTENCY_KEY_REUSED');
      const used = (await expect('P', 'GET', `${PA}/lab-bookings/by-key/${first.body.requestKey}`, 200)).json.data;
      assert.equal(used.state, 'used'); assert.equal(used.booking._id, first.booking._id);
      const k = newKey();
      assert.equal((await expect('P', 'GET', `${PA}/lab-bookings/by-key/${k}`, 200)).json.data.state, 'unknown');
      assert.equal((await expect('P', 'POST', `${PA}/lab-bookings/by-key/${k}/abandon`, 200)).json.data.state, 'abandoned');
      const s1 = await slot();
      await expect('P', 'POST', `${PA}/lab-bookings`, 409, { ...order(s1), requestKey: k }, 'REQUEST_ABANDONED');
      assert.equal(await seats(s1), 0);
      assert.equal(await balance(P), before);
      // Another pharmacy's view of the same key: its own namespace (nothing of P's is found).
      assert.equal((await expect('Q', 'GET', `${PA}/lab-bookings/by-key/${first.body.requestKey}`, 200)).json.data.state, 'unknown');
    });

    await check('race: 5 identical creates for a new number give one booking, one account, one debit and one seat', async () => {
      const s1 = await slot();
      const before = await balance(P);
      const body = order(s1, { phone: '9600000391', patient: { relation: 'self', name: 'New Walkin' } });
      const rs = await Promise.all(Array.from({ length: 5 }, () => call('P', 'POST', `${PA}/lab-bookings`, body)));
      assert.ok(rs.every((r) => r.status === 201 || r.status === 200), rs.map((r) => `${r.status} ${r.text.slice(0, 120)}`).join(' | '));
      assert.equal(rs.filter((r) => r.status === 201).length, 1);
      assert.equal(new Set(rs.map((r) => r.json.data.booking._id)).size, 1);
      assert.equal(await PartnerLabBookingModel.countDocuments({ 'assisted.requestKey': { $regex: body.requestKey } }), 1);
      assert.equal(await UserModel.countDocuments({ phone: '9600000391' }), 1);
      assert.equal(await balance(P), before - 50000);
      assert.equal(await debitsOf(rs[0]!.json.data.booking._id), 1);
      assert.equal(await seats(s1), 1);
      assert.equal(rs.find((r) => r.status === 201)!.json.data.newAccount, true);
    });

    await check('race: two different creates for the last seat — one wins, the other is 409 SLOT_UNAVAILABLE and nothing is debited for it', async () => {
      const s1 = await slot(30, 'lab', 1);
      const before = await balance(P);
      const rs = await Promise.all([call('P', 'POST', `${PA}/lab-bookings`, order(s1)), call('P', 'POST', `${PA}/lab-bookings`, order(s1, { phone: '9600000302',
        patient: { relation: 'self', name: 'Bikash' } }))]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409], rs.map((r) => r.text.slice(0, 200)).join(' | '));
      assert.equal(rs.find((r) => r.status === 409)!.json.code, 'SLOT_UNAVAILABLE');
      assert.equal(await balance(P), before - 50000);
      assert.equal(await seats(s1), 1);
      assert.equal(await PartnerLabBookingModel.countDocuments({ 'slot.slotId': s1 }), 1);
    });

    await check('race: two creates that fit the balance alone but not together — one is 409 INSUFFICIENT_BALANCE; the balance never goes negative', async () => {
      const [s1, s2] = [await slot(), await slot()];
      assert.equal(await balance(W), 60000);
      const rs = await Promise.all([call('W', 'POST', `${PA}/lab-bookings`, order(s1)), call('W', 'POST', `${PA}/lab-bookings`, order(s2, { phone: '9600000302',
        patient: { relation: 'self', name: 'Bikash' } }))]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409], rs.map((r) => r.text.slice(0, 200)).join(' | '));
      assert.equal(rs.find((r) => r.status === 409)!.json.code, 'INSUFFICIENT_BALANCE');
      assert.equal(await balance(W), 10000);
      assert.equal((await seats(s1)) + (await seats(s2)), 1);
    });

    await check('provider admission: unverified, suspended or clinic partner, inactive branch, disabled test, visit mode not offered — refused before any account, same answer for an unknown number', async () => {
      const s1 = await slot();
      const sU = await slot(30, 'lab', 5, AU, LU);
      const users0 = await UserModel.countDocuments({});
      const cases: [Record<string, unknown>, number, string][] = [
        [{ partnerId: LU, branchId: AU, slotId: sU, itemIds: [unvItem], acceptedPriceMinor: 100 }, 404, 'LAB_NOT_FOUND'],
        [{ partnerId: CL }, 404, 'LAB_NOT_FOUND'],
        [{ itemIds: [hidden], acceptedPriceMinor: 10000 }, 400, 'CATALOGUE_ITEM_NOT_AVAILABLE'],
        [{ itemIds: [lipid], visitMode: 'home', address: { line1: '2 Road', city: 'Shillong', pincode: '793001' }, acceptedPriceMinor: 30000 }, 400, 'VISIT_MODE_NOT_SUPPORTED'],
        [{ branchId: B, visitMode: 'home', address: { line1: '2 Road', city: 'Shillong', pincode: '793001' } }, 404, 'BRANCH_NOT_AVAILABLE'],
        [{ branchId: A2 }, 404, 'BRANCH_NOT_AVAILABLE'],
        [{ visitMode: 'home' }, 400, 'ADDRESS_REQUIRED'],
        [{ paymentMethod: 'razorpay' }, 400, 'PAYMENT_METHOD_UNAVAILABLE'],
        [{ consent: { agreed: false, statementVersion: 'v1', statementLanguage: 'en' } }, 400, 'CONSENT_REQUIRED'],
      ];
      for (const [extra, status, code] of cases) {
        for (const phone of ['9600000301', '9600000399']) await expect('P', 'POST', `${PA}/lab-bookings`, status, order(s1, { phone, ...extra }), code);
      }
      await PartnerModel.updateOne({ _id: L }, { $set: { isActive: false } });
      try {
        for (const phone of ['9600000301', '9600000399']) await expect('P', 'POST', `${PA}/lab-bookings`, 404, order(s1, { phone }), 'LAB_NOT_FOUND');
      } finally { await PartnerModel.updateOne({ _id: L }, { $set: { isActive: true } }); }
      await BranchModel.updateOne({ _id: A }, { $set: { isActive: false } });
      try {
        for (const phone of ['9600000301', '9600000399']) await expect('P', 'POST', `${PA}/lab-bookings`, 404, order(s1, { phone }), 'BRANCH_NOT_AVAILABLE');
      } finally { await BranchModel.updateOne({ _id: A }, { $set: { isActive: true } }); }
      assert.equal(await UserModel.countDocuments({}), users0, 'no account opened');
      assert.equal(await seats(s1), 0);
    });

    let couponBooking = '';
    await check('coupons: a per-user coupon is refused; a provider coupon gives a split whose lines sum to the base; PRICE_CHANGED with the amounts', async () => {
      const coupon = (code: string, extra: Record<string, unknown> = {}) => CouponModel.create({ code, discountType: 'fixed', discountValue: 101,
        applicableTo: 'all', eligibleFor: 'all', startDate: '20200101', endDate: '20991231', currentUsageCount: 0, isActive: true, ...extra } as never);
      await coupon('LABONCE', { usageLimitPerUser: 1 });
      await coupon('LAB101', { totalUsageLimit: 10 });
      const s1 = await slot();
      await expect('P', 'POST', `${PA}/lab-bookings`, 400, order(s1, { couponCode: 'LABONCE' }), 'COUPON_NOT_FOR_ASSISTED');
      const wrong = await expect('P', 'POST', `${PA}/lab-bookings`, 409, order(s1, { couponCode: 'LAB101', itemIds: [cbc, lipid], acceptedPriceMinor: 80000 }), 'PRICE_CHANGED');
      assert.deepEqual(wrong.json.details ?? wrong.json.error?.details ?? wrong.json.data?.details, { priceMinor: 69900, listMinor: 80000, discountMinor: 10100 });
      const before = await balance(P);
      const d = await book('P', order(s1, { couponCode: 'LAB101', itemIds: [cbc, lipid], acceptedPriceMinor: 69900 }));
      couponBooking = d.booking._id;
      assert.equal(await balance(P), before - 69900);
      const b = await stored(couponBooking);
      const sp = b.assisted.split;
      assert.equal(sp.baseMinor, 69900); assert.equal(sp.providerMinor, 69900); assert.equal(sp.couponFundedBy, 'provider');
      assert.deepEqual(sp.lines.map((l: any) => l.discountMinor), [6313, 3787], 'spread by price, largest remainder');
      assert.equal(sp.lines.reduce((x: number, l: any) => x + l.baseMinor, 0), sp.baseMinor);
      const red = await CouponRedemptionModel.findOne({ bookingKind: 'lab_booking', bookingId: couponBooking }).lean() as any;
      assert.equal(red.payerKind, 'pharmacy'); assert.equal(red.patientUserId, X); assert.equal(red.state, 'counted');
      assert.equal((await CouponModel.findOne({ code: 'LAB101' }).lean() as any).currentUsageCount, 1);
    });

    await check('owner 23 Nov: no per-number, new-account or cancellation caps on lab bookings; the hourly lookup limit still applies', async () => {
      process.env.ASSISTED_LIMIT_BOOKINGS_PER_PHONE_PER_DAY = '1';
      process.env.ASSISTED_LIMIT_NEW_ACCOUNTS_PER_DAY = '1';
      process.env.ASSISTED_LIMIT_BOOKER_CANCELLATIONS_PER_DAY = '1';
      try {
        const ids: string[] = [];
        for (const phone of ['9600000381', '9600000381', '9600000382']) ids.push((await book('R', order(await slot(), { phone, patient: { relation: 'self', name: 'Walk In' } }))).booking._id);
        for (const id of ids.slice(0, 2)) await expect('R', 'POST', `${PA}/lab-bookings/${id}/cancel`, 200, {});
        await book('R', order(await slot(), { phone: '9600000383', patient: { relation: 'self', name: 'Walk In' } }));
        process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '1';
        await expect('R', 'POST', `${PA}/lab-bookings`, 429, order(await slot()), 'ASSISTED_LIMIT_REACHED');
      } finally {
        delete process.env.ASSISTED_LIMIT_BOOKINGS_PER_PHONE_PER_DAY; delete process.env.ASSISTED_LIMIT_NEW_ACCOUNTS_PER_DAY;
        delete process.env.ASSISTED_LIMIT_BOOKER_CANCELLATIONS_PER_DAY; process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '100000';
      }
    });

    // ───────────────────────── Views and the names rule ─────────────────────────
    await check('names rule: the booker sees the typed name (never the account name); a family member by name; masked without a typed name; the real name only on customer_order', async () => {
      const view = (await expect('P', 'GET', `${PA}/lab-bookings/${first.booking._id}`, 200)).json.data;
      assert.equal(view.patientName, 'Rina D');
      assert.equal(view.holder.name, 'Rina D');
      assert.notEqual(view.holder.name, 'Rina Kumari Das');
      // A family member of the same account: their name; the holder link of a pharmacy that typed nothing: masked.
      const d = await book('Q', order(await slot(), { patient: { dependentId: depX } }));
      const qv = (await expect('Q', 'GET', `${PA}/lab-bookings/${d.booking._id}`, 200)).json.data;
      assert.equal(qv.patientName, 'Mina Das');
      assert.equal(qv.holder.name, maskName('Rina Kumari Das'));
      assert.equal((await stored(d.booking._id)).patient.name, 'Mina Das');
      // The customer linked this pharmacy by ordering: the real account name.
      await PharmacyCustomerModel.updateOne({ pharmacyId: new Types.ObjectId(Q), userId: new Types.ObjectId(X) }, { $set: { consent: 'customer_order' } });
      assert.equal((await expect('Q', 'GET', `${PA}/lab-bookings/${d.booking._id}`, 200)).json.data.holder.name, 'Rina Kumari Das');
      await PharmacyCustomerModel.updateOne({ pharmacyId: new Types.ObjectId(Q), userId: new Types.ObjectId(X) }, { $set: { consent: 'patient_agreed' } });
      // The lab sees the typed (or family member's) name, never the account name.
      const lv = (await expect('LAB', 'GET', `${WS}/lab-bookings/${first.booking._id}`, 200)).json.data;
      assert.equal(lv.patient.name, 'Rina D');
    });

    await check('views: the booker allowlist; the lab sees who booked + the identity note but no funding/split/keys; the patient sees no prices and "paid by"', async () => {
      const v = (await expect('P', 'GET', `${PA}/lab-bookings/${first.booking._id}`, 200)).json.data;
      for (const k of ['pricing', 'settlement', 'walletFunding', 'noShows', 'createRequestKey']) assert.equal(v[k], undefined, k);
      assert.deepEqual(Object.keys(v.assisted).sort(), ['bookedBy', 'preferredLanguage', 'shortRef']);
      assert.deepEqual(v.items, [{ name: 'CBC', kind: 'test' }, { name: 'Lipid', kind: 'test' }]);
      assert.equal(v.lab.name, 'Metro Labs'); assert.equal(v.branch.name, 'Police Bazar');
      assert.deepEqual(v.report, { releases: [] });
      const lv = (await expect('LAB', 'GET', `${WS}/lab-bookings/${first.booking._id}`, 200)).json.data;
      assert.deepEqual(lv.assisted, { shortRef: first.booking.assisted.shortRef, bookedBy: { name: 'Sharma Medicals' }, preferredLanguage: 'kha' });
      assert.equal(lv.identityNote, 'Identity attested by the partner, not verified');
      assert.equal(lv.source, 'pharmacy_assisted');
      const list = (await expect('LAB', 'GET', `${WS}/lab-bookings?branchId=${A}`, 200)).json.data;
      const row = list.find((x: any) => x._id === first.booking._id);
      assert.equal(row.assisted.funding, undefined); assert.equal(row.assisted.requestKey, undefined);
      const cv = (await expect('X', 'GET', `/api/v1/lab-bookings/${first.booking._id}`, 200)).json.data;
      assert.equal(cv.pricing, undefined); assert.equal(cv.paymentTransactionId, undefined);
      assert.equal(cv.paidBy, 'Sharma Medicals');
      assert.equal(cv.items[0].priceMinor, undefined);
      assert.equal(cv.assisted.funding, undefined); assert.equal(cv.assisted.requestKey, undefined); assert.equal(cv.assisted.split, undefined);
      const mine = (await expect('X', 'GET', '/api/v1/lab-bookings', 200)).json.data;
      assert.ok(mine.some((x: any) => x._id === first.booking._id && x.paidBy === 'Sharma Medicals' && x.pricing === undefined));
      await expect('X', 'POST', `/api/v1/lab-bookings/${first.booking._id}/pay`, 409, {}, 'PARTNER_PAID_BOOKING');
    });

    await check('scope: another pharmacy and another lab get the one 404 (read, cancel, accept); the list holds only its own', async () => {
      const id = first.booking._id;
      await expect('Q', 'GET', `${PA}/lab-bookings/${id}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      await expect('Q', 'POST', `${PA}/lab-bookings/${id}/cancel`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      await expect('Q', 'POST', `${PA}/lab-bookings/${id}/accept-reschedule`, 404, { version: 1 }, 'LAB_BOOKING_NOT_FOUND');
      await expect('Q', 'GET', `${PA}/lab-bookings/${oid()}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      assert.ok(!(await expect('Q', 'GET', `${PA}/lab-bookings`, 200)).json.data.some((x: any) => x._id === id));
      await expect('LAB2', 'GET', `${WS}/lab-bookings/${id}`, 404);
      await expect('LAB2', 'POST', `${WS}/lab-bookings/${id}/reject`, 404, { reason: 'not ours' });
      assert.equal((await stored(id)).status, 'confirmed');
      // The booker's own list: newest first, paged by cursor.
      const p1 = await expect('P', 'GET', `${PA}/lab-bookings?limit=2`, 200);
      assert.equal(p1.json.data.length, 2);
      assert.ok(p1.json.pagination.total >= 4);
      const p2 = await expect('P', 'GET', `${PA}/lab-bookings?limit=2&cursor=${p1.json.pagination.nextCursor}`, 200);
      assert.ok(!p2.json.data.some((x: any) => p1.json.data.some((y: any) => y._id === x._id)));
    });

    // ───────────────────────── Cancellations ─────────────────────────
    const setStart = (id: string, at: Date) => PartnerLabBookingModel.updateOne({ _id: id }, { $set: { 'slot.startsAt': at } });
    await check('booker cutoff: slot − 61 min refunds in full; slot − 59 min is 409 CANCELLATION_WINDOW_CLOSED; slot − 10 min with a pending lab reschedule refunds', async () => {
      const a = (await book('P', order(await slot(3)))).booking._id;
      const b = (await book('P', order(await slot(3)))).booking._id;
      const before = await balance(P);
      await setStart(a, new Date(Date.now() + 61 * MIN));
      const ra = (await expect('P', 'POST', `${PA}/lab-bookings/${a}/cancel`, 200, { reason: 'patient left' })).json.data;
      assert.equal(ra.refundedMinor, 50000); assert.equal(ra.alreadyCancelled, false);
      assert.equal(ra.booking.cancellation.reason, 'partner'); assert.equal(ra.booking.cancellation.byKind, 'booker');
      assert.equal(await balance(P), before + 50000);
      await setStart(b, new Date(Date.now() + 59 * MIN));
      await expect('P', 'POST', `${PA}/lab-bookings/${b}/cancel`, 409, {}, 'CANCELLATION_WINDOW_CLOSED');
      // The lab proposes a new time; the booker may now cancel even close to the slot.
      const moveTo = await slot(4);
      await expect('LAB', 'POST', `${WS}/lab-bookings/${b}/reschedule`, 200, { slotId: moveTo, reason: 'machine down' });
      await setStart(b, new Date(Date.now() + 10 * MIN));
      const rb = (await expect('P', 'POST', `${PA}/lab-bookings/${b}/cancel`, 200, {})).json.data;
      assert.equal(rb.refundedMinor, 50000);
      assert.equal(await balance(P), before + 100000);
      assert.equal(await seats(moveTo), 0, 'the moved seat is released');
      // A repeat answers alreadyCancelled; nothing moves.
      const rep = (await expect('P', 'POST', `${PA}/lab-bookings/${a}/cancel`, 200, {})).json.data;
      assert.equal(rep.alreadyCancelled, true); assert.equal(rep.refundedMinor, 0);
      assert.equal((await refundsOf(a)).length, 1);
      assert.ok(labNotices.some((n) => n.key === `plb:${a}:cancelled` && n.userId === X));
      // A stale screen (expectedVersion) is refused.
      const c = (await book('P', order(await slot()))).booking;
      await expect('P', 'POST', `${PA}/lab-bookings/${c._id}/cancel`, 409, { expectedVersion: c.statusVersion + 1 }, 'LAB_BOOKING_CHANGED');
    });

    await check('race: booker cancel vs patient cancel vs lab reject — exactly one wins; one refund to the pharmacy, one redemption reversal, one seat back', async () => {
      const s1 = await slot();
      const coupon = await CouponModel.findOne({ code: 'LAB101' }).lean() as any;
      const d = await book('P', order(s1, { couponCode: 'LAB101', acceptedPriceMinor: 39900 }));
      const id = d.booking._id;
      const before = await balance(P);
      const usage = (await CouponModel.findOne({ code: 'LAB101' }).lean() as any).currentUsageCount;
      assert.equal(usage, coupon.currentUsageCount + 1);
      assert.equal(await seats(s1), 1);
      const rs = await Promise.all([
        call('P', 'POST', `${PA}/lab-bookings/${id}/cancel`, {}),
        call('X', 'POST', `/api/v1/lab-bookings/${id}/cancel`, {}),
        call('LAB', 'POST', `${WS}/lab-bookings/${id}/reject`, { reason: 'machine down' }),
      ]);
      const wins = rs.filter((r) => r.status === 200 && r.json.data?.alreadyCancelled !== true);
      assert.equal(wins.length, 1, rs.map((r) => `${r.status} ${r.text.slice(0, 150)}`).join(' | '));
      assert.ok(rs.every((r) => r.status === 200 || r.status === 409), rs.map((r) => `${r.status} ${r.text.slice(0, 150)}`).join(' | '));
      assert.equal(await balance(P), before + 39900, 'refunded exactly once');
      assert.equal((await refundsOf(id)).length, 1);
      const b = await stored(id);
      assert.equal(b.status, 'cancelled'); assert.equal(b.assisted.funding.state, 'refunded'); assert.equal(b.assisted.funding.refunds.length, 1);
      assert.equal(await seats(s1), 0);
      assert.equal((await CouponRedemptionModel.findOne({ bookingKind: 'lab_booking', bookingId: id }).lean() as any).state, 'reversed');
      assert.equal((await CouponModel.findOne({ code: 'LAB101' }).lean() as any).currentUsageCount, usage - 1);
      assert.equal(Number((await WalletModel.findOne({ userId: X }).lean() as any).balance), 0, 'the customer wallet never moves');
    });

    await check('race: booker cancel vs lab visit — exactly one wins; no money moves after the visit', async () => {
      for (let i = 0; i < 3; i++) {
        const id = (await book('P', order(await slot()))).booking._id;
        const before = await balance(P);
        const rs = await Promise.all([call('P', 'POST', `${PA}/lab-bookings/${id}/cancel`, {}), call('LAB', 'POST', `${WS}/lab-bookings/${id}/visit`, {})]);
        assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => `${r.status} ${r.text.slice(0, 150)}`).join(' | '));
        const b = await stored(id);
        if (b.status === 'visited') {
          assert.equal(await balance(P), before);
          assert.equal((await refundsOf(id)).length, 0);
          await expect('P', 'POST', `${PA}/lab-bookings/${id}/cancel`, 409, {}, 'LAB_BOOKING_NOT_CANCELLABLE');
          assert.equal(await balance(P), before);
        } else {
          assert.equal(b.status, 'cancelled');
          assert.equal(await balance(P), before + 50000);
          await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/visit`, 409);
        }
      }
    });

    await check('patient cancel: inside 2 h refused; outside, the refund goes to the pharmacy wallet (customer wallet unchanged) and the booker is told', async () => {
      const id = (await book('P', order(await slot()))).booking._id;
      await setStart(id, new Date(Date.now() + 90 * MIN));
      await expect('X', 'POST', `/api/v1/lab-bookings/${id}/cancel`, 409, {}, 'CANCELLATION_WINDOW_CLOSED');
      await setStart(id, new Date(Date.now() + 5 * 3_600_000));
      const before = await balance(P);
      const r = (await expect('X', 'POST', `/api/v1/lab-bookings/${id}/cancel`, 200, {})).json.data;
      assert.equal(r.refunded, 0, 'nothing to the customer');
      assert.equal(r.booking.paidBy, 'Sharma Medicals');
      assert.equal(await balance(P), before + 50000);
      assert.equal(Number((await WalletModel.findOne({ userId: X }).lean() as any).balance), 0);
      assert.equal((await refundsOf(id))[0]!.amountPaise, 50000);
      assert.equal((await stored(id)).assisted.funding.refunds[0].cause, 'patient');
      assert.ok(assistedNotices.some((n) => n.audience === 'booker' && n.userId === P.toLowerCase() && n.key === `assisted:lab:${id}:cancelled:booker` && n.title === 'Cancelled by the patient'));
      assert.ok(labNotices.some((n) => n.key === `plb:${id}:cancelled` && n.message.includes('refund goes to Sharma Medicals')));
    });

    await check('refunds always post: a frozen or inactive pharmacy wallet and a non-operational pharmacy are still refunded (lab reject → partner_lab_reject)', async () => {
      for (const setup of ['frozen', 'inactive', 'unverified'] as const) {
        const id = (await book('P', order(await slot()))).booking._id;
        const before = await balance(P);
        if (setup === 'frozen') await PharmacyWalletModel.updateOne({ pharmacyId: P }, { $set: { frozen: true } });
        if (setup === 'inactive') await PharmacyWalletModel.updateOne({ pharmacyId: P }, { $set: { isActive: false } });
        if (setup === 'unverified') await PharmacyModel.updateOne({ _id: P }, { $set: { isVerified: false } });
        try {
          const r = (await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/reject`, 200, { reason: 'reagent out' })).json.data;
          assert.equal(r.refunded, 500);
        } finally {
          await PharmacyWalletModel.updateOne({ pharmacyId: P }, { $set: { isActive: true }, $unset: { frozen: 1 } });
          await PharmacyModel.updateOne({ _id: P }, { $set: { isVerified: true } });
        }
        assert.equal(await balance(P), before + 50000, setup);
        const b = await stored(id);
        assert.equal(b.assisted.funding.refunds[0].cause, 'partner_lab_reject');
        assert.equal(b.cancellation.reason, 'lab_reject');
        assert.ok(assistedNotices.some((n) => n.key === `assisted:lab:${id}:cancelled:booker`));
        assert.ok(labNotices.some((n) => n.key === `plb:${id}:cancelled` && !n.message.includes('wallet')));
      }
    });

    await check('booker accepts the lab\'s new time (owner 23 Nov): its own row, the current version only; audited; the patient told', async () => {
      const id = (await book('P', order(await slot()))).booking._id;
      const to = await slot(40);
      const moved = (await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/reschedule`, 200, { slotId: to, reason: 'staff away' })).json.data;
      assert.ok(assistedNotices.some((n) => n.key === `assisted:lab:${id}:reschedule:1:booker` && n.title === 'New time proposed'));
      await expect('P', 'POST', `${PA}/lab-bookings/${id}/accept-reschedule`, 409, { version: 0 }, 'RESCHEDULE_CHANGED');
      const v = (await expect('P', 'POST', `${PA}/lab-bookings/${id}/accept-reschedule`, 200, { version: moved.reschedule.version })).json.data;
      assert.equal(v.reschedule.pending, false);
      assert.equal(v.slot.slotId, to);
      await expect('P', 'POST', `${PA}/lab-bookings/${id}/accept-reschedule`, 409, { version: moved.reschedule.version }, 'NO_PENDING_RESCHEDULE');
      assert.ok(await AssistedAuditEventModel.exists({ action: 'booking.reschedule_accepted', bookingId: id }));
      assert.ok(labNotices.some((n) => n.userId === X && n.key.startsWith(`assisted:lab:${id}:reschedule:`)));
    });

    await check('admin cancel of a moved no-show: refund false keeps the money (forfeited, coupon stays used); refund true refunds the pharmacy; no-show earns nothing', async () => {
      const mk = async () => {
        const id = (await book('P', order(await slot()))).booking._id;
        await setStart(id, new Date(Date.now() - 3 * 3_600_000));
        await PartnerLabBookingModel.updateOne({ _id: id }, { $set: { 'slot.startTime': '00:00', 'slot.endTime': '00:30' } });
        await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/no-show`, 200, {});
        await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/reschedule-no-show`, 200, { slotId: await slot(50), requestKey: newKey() });
        return id;
      };
      const kept = await mk();
      const before = await balance(P);
      await expect('ADMIN', 'POST', `/api/v1/partner-workspace/admin/lab-bookings/${kept}/cancel-no-show`, 200, { reason: 'lab closed', refund: false });
      const k = await stored(kept);
      assert.equal(k.status, 'cancelled'); assert.equal(k.assisted.funding.state, 'forfeited'); assert.equal(k.cancellation.forfeitedMinor, 50000);
      assert.equal(await balance(P), before);
      const back = await mk();
      const beforeBack = await balance(P);
      await expect('ADMIN', 'POST', `/api/v1/partner-workspace/admin/lab-bookings/${back}/cancel-no-show`, 200, { reason: 'lab closed', refund: true });
      assert.equal(await balance(P), beforeBack + 50000);
      assert.equal((await stored(back)).assisted.funding.refunds[0].cause, 'admin');
      for (const id of [kept, back]) assert.equal(await LedgerEntryModel.countDocuments({ source: 'partner_lab_booking', sourceId: id }), 0);
      // A plain no-show: no refund, no earning, booker cannot cancel it.
      const ns = (await book('P', order(await slot()))).booking._id;
      await setStart(ns, new Date(Date.now() - 3 * 3_600_000));
      await PartnerLabBookingModel.updateOne({ _id: ns }, { $set: { 'slot.startTime': '00:00', 'slot.endTime': '00:30' } });
      const b2 = await balance(P);
      await expect('LAB', 'POST', `${WS}/lab-bookings/${ns}/no-show`, 200, {});
      await expect('P', 'POST', `${PA}/lab-bookings/${ns}/cancel`, 409, {}, 'LAB_BOOKING_NOT_CANCELLABLE');
      assert.equal(await balance(P), b2);
      assert.equal(await LedgerEntryModel.countDocuments({ source: 'partner_lab_booking', sourceId: ns }), 0);
    });

    // ───────────────────────── Reports and earnings ─────────────────────────
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const upload = async (id: string) => {
      const fd = new FormData();
      fd.append('files', new Blob([pdf], { type: 'application/pdf' }), 'report.pdf');
      const r = await fetch(`${base}${WS}/lab-bookings/${id}/reports`, { method: 'POST', headers: { authorization: `Bearer ${tokens.LAB}` }, body: fd });
      const json = await r.json() as any;
      assert.equal(r.status, 201, JSON.stringify(json).slice(0, 300));
      return String(json.data.report.draftFiles[0]).replace(/^\/api\/static\//, '');
    };
    const fileStatus = async (path: string, who: string) => (await fetch(`${base}/api/static/${path}`, { headers: { authorization: `Bearer ${tokens[who]}` } })).status;
    await check('booker report access: never a draft; the released report for 90 days from release while operational; another pharmacy never; the patient always', async () => {
      const id = first.booking._id;
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/visit`, 200, {});
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/process`, 200, {});
      const draft = await upload(id);
      assert.equal(await fileStatus(draft, 'P'), 404, 'before release: no draft for the booker');
      assert.equal(await fileStatus(draft, 'X'), 404);
      assert.deepEqual((await expect('P', 'GET', `${PA}/lab-bookings/${id}`, 200)).json.data.report, { releases: [] });
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/reports/release`, 200, { file: `/api/static/${draft}` });
      assert.ok(assistedNotices.some((n) => n.key === `assisted:lab:${id}:report_ready:booker` && n.audience === 'booker' && !/CBC|Lipid/.test(n.message)));
      assert.equal(await fileStatus(draft, 'P'), 200, 'after release: the booker reads it');
      assert.equal(await fileStatus(draft, 'X'), 200);
      assert.equal(await fileStatus(draft, 'Q'), 404, 'another pharmacy: the one 404');
      const v = (await expect('P', 'GET', `${PA}/lab-bookings/${id}`, 200)).json.data;
      assert.equal(v.report.releases.length, 1);
      assert.equal(v.report.releases[0].file, `/api/static/${draft}`);
      assert.deepEqual(Object.keys(v.report.releases[0].signer).sort(), ['kind', 'name', 'registrationNumber']);
      // A second draft is never offered to the booker.
      const draft2 = await upload(id);
      assert.equal(await fileStatus(draft2, 'P'), 404);
      // Not once the pharmacy is unverified.
      await PharmacyModel.updateOne({ _id: P }, { $set: { isVerified: false } });
      try { assert.equal(await fileStatus(draft, 'P'), 404); } finally { await PharmacyModel.updateOne({ _id: P }, { $set: { isVerified: true } }); }
      assert.equal(await fileStatus(draft, 'P'), 200);
      // 89 days after the release: still; 91 days: no longer (and the view stops offering it). The patient keeps it.
      await PartnerLabBookingModel.updateOne({ _id: id }, { $set: { 'report.releases.0.releasedAt': new Date(Date.now() - 89 * DAY) } });
      assert.equal(await fileStatus(draft, 'P'), 200);
      await PartnerLabBookingModel.updateOne({ _id: id }, { $set: { 'report.releases.0.releasedAt': new Date(Date.now() - 91 * DAY) } });
      assert.equal(await fileStatus(draft, 'P'), 404);
      assert.deepEqual((await expect('P', 'GET', `${PA}/lab-bookings/${id}`, 200)).json.data.report, { releases: [] });
      assert.equal(await fileStatus(draft, 'X'), 200, 'the patient always keeps it');
      await PartnerLabBookingModel.updateOne({ _id: id }, { $set: { 'report.releases.0.releasedAt': new Date() } });
    });

    await check('earnings: completion posts split.providerMinor once (cut 0, gross = base); the coupon booking earns the price after the coupon', async () => {
      const id = first.booking._id;
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/complete`, 200, {});
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/complete`, 409);
      const e = await LedgerEntryModel.find({ source: 'partner_lab_booking', sourceId: id, kind: 'earning' }).lean() as any[];
      assert.equal(e.length, 1); assert.equal(e[0].amountMinor, 80000); assert.equal(e[0].grossMinor, 80000); assert.equal(e[0].commissionMinor, 0);
      await expect('LAB', 'POST', `${WS}/lab-bookings/${couponBooking}/visit`, 200, {});
      await expect('LAB', 'POST', `${WS}/lab-bookings/${couponBooking}/process`, 200, {});
      const draft = await upload(couponBooking);
      await expect('LAB', 'POST', `${WS}/lab-bookings/${couponBooking}/reports/release`, 200, { file: `/api/static/${draft}` });
      await expect('LAB', 'POST', `${WS}/lab-bookings/${couponBooking}/complete`, 200, {});
      const c = await LedgerEntryModel.find({ source: 'partner_lab_booking', sourceId: couponBooking, kind: 'earning' }).lean() as any[];
      assert.deepEqual(c.map((x) => x.amountMinor), [69900]);
      await expect('P', 'POST', `${PA}/lab-bookings/${couponBooking}/cancel`, 409, {}, 'LAB_BOOKING_NOT_CANCELLABLE');
    });

    // ───────────────────────── Not mine, admin move, reconciliation ─────────────────────────
    await check('"not mine" on a lab row hides it from the holder\'s list and queues it; the admin move moves userId, patient and redemption; the old holder gets 404', async () => {
      const d = await book('P', order(await slot(), { phone: '9600000302', patient: { relation: 'self', name: 'Bikash' }, couponCode: 'LAB101', acceptedPriceMinor: 39900 }));
      const id = d.booking._id;
      assert.ok((await expect('Y', 'GET', '/api/v1/lab-bookings', 200)).json.data.some((x: any) => x._id === id));
      await expect('Z', 'POST', `/api/v1/lab-bookings/${id}/not-mine`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      await expect('Y', 'POST', `/api/v1/lab-bookings/${id}/not-mine`, 200, { note: 'not me' });
      await expect('Y', 'POST', `/api/v1/lab-bookings/${id}/not-mine`, 409, {}, 'ALREADY_REPORTED');
      assert.ok(!(await expect('Y', 'GET', '/api/v1/lab-bookings', 200)).json.data.some((x: any) => x._id === id), 'left out of the list');
      await expect('Y', 'GET', `/api/v1/lab-bookings/${id}`, 200);
      assert.ok(assistedNotices.some((n) => n.key === `assisted:lab:${id}:not_mine:booker`));
      assert.equal((await expect('P', 'GET', `${PA}/lab-bookings/${id}`, 200)).json.data.assisted.disputed.state, 'open');
      const items = (await expect('ADMIN', 'GET', '/api/v1/admin/assisted/review-items?state=open', 200)).json.data;
      const item = items.find((i: any) => i.bookingId === id);
      assert.equal(item.bookingKind, 'lab_booking'); assert.equal(item.booking.kind, 'lab_booking'); assert.equal(item.booking.shortRef, d.booking.assisted.shortRef);
      const mv = { toPhone: '9600000303', holderName: 'Zed H', reason: 'wrong number typed', requestKey: newKey() };
      const m = (await expect('ADMIN', 'POST', `/api/v1/admin/assisted-bookings/${id}/move`, 200, mv)).json.data;
      assert.equal(m.replayed, false); assert.equal(m.booking.userId, Z);
      assert.equal((await expect('ADMIN', 'POST', `/api/v1/admin/assisted-bookings/${id}/move`, 200, mv)).json.data.replayed, true);
      await expect('ADMIN', 'POST', `/api/v1/admin/assisted-bookings/${id}/move`, 409, { ...mv, reason: 'other' }, 'IDEMPOTENCY_KEY_REUSED');
      const b = await stored(id);
      assert.equal(b.userId, Z); assert.equal(b.patient.name, 'Zed H'); assert.equal(b.patient.kind, 'self');
      assert.equal(b.assisted.identity.disputed.state, 'moved');
      assert.equal((await CouponRedemptionModel.findOne({ bookingKind: 'lab_booking', bookingId: id }).lean() as any).patientUserId, Z);
      assert.equal((await AssistedReviewItemModel.findOne({ bookingKind: 'lab_booking', bookingId: id }).lean() as any).state, 'moved');
      await expect('Y', 'GET', `/api/v1/lab-bookings/${id}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      await expect('Z', 'GET', `/api/v1/lab-bookings/${id}`, 200);
      assert.ok(await PharmacyCustomerModel.exists({ pharmacyId: new Types.ObjectId(P), userId: new Types.ObjectId(Z) }));
      // The pharmacy still sees and may cancel it; the refund still goes to it.
      const before = await balance(P);
      await expect('P', 'POST', `${PA}/lab-bookings/${id}/cancel`, 200, {});
      assert.equal(await balance(P), before + 39900);
    });

    await check('reconciliation: clean on correct lab rows; flags a cancelled-but-unrefunded assisted lab row', async () => {
      const clean = (await expect('ADMIN', 'GET', '/api/v1/admin/assisted/reconciliation?full=true', 200)).json.data;
      const labMismatches = clean.checks.mismatches.filter((m: any) => String(m.check).startsWith('lab_'));
      assert.deepEqual(labMismatches, []);
      assert.ok(clean.checks.labBookings.checked >= 10);
      const id = (await book('P', order(await slot()))).booking._id;
      await PartnerLabBookingModel.updateOne({ _id: id }, { $set: { status: 'cancelled' } });
      try {
        const bad = (await expect('ADMIN', 'GET', '/api/v1/admin/assisted/reconciliation?full=true', 200)).json.data;
        assert.ok(bad.checks.mismatches.some((m: any) => m.check === 'lab_cancelled_not_refunded' && m.ref === id));
      } finally { await PartnerLabBookingModel.updateOne({ _id: id }, { $set: { status: 'confirmed' } }); }
    });

    await check('no token, OTP or phone number in the audit rows of lab bookings (ids and codes only)', async () => {
      const rows = await AssistedAuditEventModel.find({ 'detail.kind': 'lab_booking' }).lean();
      assert.ok(rows.length > 5);
      const text = JSON.stringify(rows);
      for (const phone of ['9600000301', '9600000302', '9600000391']) assert.ok(!text.includes(phone), 'no phone in audit');
      assert.ok(!text.includes('Rina'), 'no names in audit');
    });
  } finally {
    server.close();
    await mongoose.disconnect();
    removeFixtureDir();
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('failed:', failed); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
