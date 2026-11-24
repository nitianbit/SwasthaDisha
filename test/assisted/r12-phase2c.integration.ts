/**
 * Assisted booking round 2c (ASSISTED_BOOKING_DESIGN.md §24.6, §5.5, §7.5; owner answers of 23 Nov): the LAB FRONT DESK
 * books the lab's own tests for a walk-in patient — a walk-in tested now (no seat), a lab visit on a slot, a home
 * collection (address, home slot, collector) — paid at the lab. Checks: each desk mode; the §5.5 guards (pay-again 409
 * PAY_AT_LAB, the expiry sweep, no earning or payout, a patient cancel refunds nothing); patient cancel before and after
 * the visit (and its race); walk-ins are never no-shows or rescheduled; scope (another lab, another branch: 404); names
 * (typed or masked only); request keys (replay, other content 409, abandoned, by-key); the Q2 bill link (at most one
 * open bill, its race, cancel frees it, wrong customer, online rows); the switch; the index 503; the admin mirror; the
 * report to the patient; and an online customer lab booking unchanged. Real routes over HTTP (configureRoutes) on
 * MongoDB; notices are captured.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r12_phase2c_check?directConnection=true' npx tsx test/assisted/r12-phase2c.integration.ts
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
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { postPharmacyMovementIn } from '@/modules/pharmacyWallet/ledger';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import { PartnerSlotModel } from '@/modules/partners/model/slot';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { InvoiceModel } from '@/modules/partners/model/invoice';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { LedgerEntryModel } from '@/modules/partners/model/settlement';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { InvoiceService } from '@/modules/partners/services/invoice';
import { InvoiceRepository, InvoiceEventRepository, InvoiceCounterRepository } from '@/modules/partners/repository/invoice';
import { SMSService } from '@/modules/sms/services';
import { PartnerService, type PartnerActor } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { resetIndexChecks } from '@/modules/common/utils/requiredIndex';
import { AssistedLinkModel } from '@/modules/assisted/model/links';
import { setAssistedNotifier } from '@/modules/assisted/support';
import { maskName } from '@/modules/assisted/names';
import type { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r12_phase2c_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
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
const sms = Object.assign(Object.create(SMSService.prototype), { sendSMS: async () => ({ success: true }) }) as SMSService;
Container.set(PartnerService, partnerSvc);
Container.set(CatalogueService, catalogueSvc);
Container.set(LabBookingService, labSvc);
Container.set(PaymentService, payments);
Container.set(InvoiceService, new InvoiceService(new InvoiceRepository(), new InvoiceEventRepository(), new InvoiceCounterRepository(),
  new PartnerRepository(), new BranchRepository(), new CatalogueItemRepository(), sms));
Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
Container.set(BannerService, new BannerService(new BannerRepository()));
setAssistedNotifier(async () => undefined);

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let phoneSeq = 7120000000;
const nextPhone = () => String(phoneSeq++);
let keySeq = 0;
const newKey = () => `r12-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;

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
  process.env.LAB_DESK_ENABLED = 'true';
  process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
  process.env.ASSISTED_LAB_BOOKING_ENABLED_PHARMACY = 'true';

  try {
    // ── Labs: a verified lab (two branches, a desk member on branch A only), a second lab, an unverified lab, a clinic ──
    const branchIn = (name: string, services = { homeCollection: true, inLab: true, inClinic: false }) => ({ name, phone: '9876500000',
      holidays: [], hours: {}, services, address: { line1: '1 Road', city: 'Shillong', state: 'Meghalaya', stateCode: '17', pincode: '793001' } }) as never;
    const { partner, owner } = await partnerSvc.createPartner({
      kind: 'lab', name: 'Metro Labs', legalName: 'Metro Labs Pvt Ltd', contactPhone: nextPhone(), invoiceSeriesPrefix: 'ML',
      firstOwner: { phone: nextPhone(), name: 'Owner' }, taxRegime: 'regular', gstin: '17AABCM1234F1ZH',
    } as never);
    const L = String(partner._id);
    await partnerSvc.verifyPartner(L, 'admin');
    const own = actorFor(owner);
    const A = String((await partnerSvc.createBranch(own, branchIn('Police Bazar')))._id);
    const B = String((await partnerSvc.createBranch(own, branchIn('Laitumkhrah')))._id);
    const deskMember = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk A', role: 'staff', permissions: ['bookings.view', 'bookings.manage'], branchIds: [A] } as never);
    const viewer = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Viewer', role: 'staff', permissions: ['bookings.view'] } as never);
    const pathologist = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Dr Rao', role: 'staff', permissions: ['bookings.view', 'bookings.manage', 'reports.upload', 'reports.release'] } as never);
    await MemberModel.updateOne({ _id: pathologist._id }, { $set: { professional: { kind: 'pathologist', registrationNumber: 'MMC-12345' } } });
    const cbc = String((await catalogueSvc.createItem(own, { kind: 'test', name: 'CBC', priceMinor: 50000, gstRate: 0, visitModes: ['home', 'lab'], reportTatHours: 24 } as never))._id);
    const lipid = String((await catalogueSvc.createItem(own, { kind: 'test', name: 'Lipid', priceMinor: 30000, gstRate: 0, visitModes: ['lab'] } as never))._id);

    const second = await partnerSvc.createPartner({ kind: 'lab', name: 'Far Labs', legalName: 'Far Labs', contactPhone: nextPhone(), invoiceSeriesPrefix: 'FL',
      firstOwner: { phone: nextPhone(), name: 'Owner Two' }, taxRegime: 'regular', gstin: '17AABCM1234F1ZX' } as never);
    const L2 = String(second.partner._id);
    await partnerSvc.verifyPartner(L2, 'admin');
    const own2 = actorFor(second.owner);
    const A2 = String((await partnerSvc.createBranch(own2, branchIn('Far')))._id);
    const far = String((await catalogueSvc.createItem(own2, { kind: 'test', name: 'Far CBC', priceMinor: 40000, gstRate: 0, visitModes: ['lab', 'home'] } as never))._id);

    const unverified = await partnerSvc.createPartner({ kind: 'lab', name: 'New Labs', legalName: 'New Labs', contactPhone: nextPhone(), invoiceSeriesPrefix: 'NL',
      firstOwner: { phone: nextPhone(), name: 'Owner Three' }, taxRegime: 'regular', gstin: '17AABCM1234F1ZY' } as never);
    const LU = String(unverified.partner._id);
    const clinic = await partnerSvc.createPartner({ kind: 'clinic', name: 'A Clinic', legalName: 'A Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'AC',
      firstOwner: { phone: nextPhone(), name: 'Owner Four' }, taxRegime: 'regular', gstin: '17AABCM1234F1ZW' } as never);
    const CL = String(clinic.partner._id);
    await partnerSvc.verifyPartner(CL, 'admin');

    // ── Slots (manual rows; unique per branch, mode and minute) ──
    let minute = 0;
    const slot = async (hours = 30, mode: 'lab' | 'home' = 'lab', capacity = 5, branchId = A, partnerId = L) => {
      const startsAt = new Date(Math.floor(Date.now() / MIN) * MIN + hours * 3_600_000 + (++minute) * MIN);
      const s = new Date(startsAt.getTime() + IST).toISOString();
      const e = new Date(startsAt.getTime() + 30 * MIN + IST).toISOString();
      const row = await PartnerSlotModel.create({ partnerId, branchId, visitMode: mode, date: s.slice(0, 10), startTime: s.slice(11, 16), endTime: e.slice(11, 16),
        startsAt, endsAt: new Date(startsAt.getTime() + 30 * MIN), capacity, booked: 0, closed: null, source: 'manual' } as never);
      return String(row._id);
    };
    const seats = async (slotId: string) => Number((await PartnerSlotModel.findById(slotId).lean())!.booked);

    // ── People ──
    const X = oid(); const Y = oid(); const ADMIN = oid();
    await UserModel.collection.insertMany([
      { _id: new Types.ObjectId(X), userType: 'user', phone: '9600000401', name: 'Rina Kumari Das', createdSource: 'self_signup', otpVerified: true },
      { _id: new Types.ObjectId(Y), userType: 'user', phone: '9600000402', name: 'Bikash Thapa', createdSource: 'self_signup', otpVerified: true },
    ] as never);
    await WalletModel.create({ userId: X, balance: 0, isActive: true });
    await WalletModel.create({ userId: Y, balance: 5000, isActive: true });
    const depX = String((await DependentModel.create({ userId: X, name: 'Mina Das', relationship: 'Daughter', gender: 'Female', isActive: true } as never))._id);
    const wallet = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean() as any).balance);

    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const member = (m: { _id: unknown }, partnerId: string) => sign({ _id: String(m._id), memberId: String(m._id), partnerId, userType: 'partner' });
    const tokens: Record<string, string> = {
      OWN: member(owner, L), DESK: member(deskMember, L), VIEW: member(viewer, L), PATH: member(pathologist, L),
      LAB2: member(second.owner, L2), UNV: member(unverified.owner, LU), CLIN: member(clinic.owner, CL),
      X: sign({ _id: X, userType: 'user', authVersion: 0 }), Y: sign({ _id: Y, userType: 'user', authVersion: 0 }),
      ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
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
    const WS = '/api/v1/partner-workspace';
    const DESK = `${WS}/lab-desk`;
    const order = (extra: Record<string, unknown> = {}) => ({
      requestKey: newKey(), phone: '9600000401', patient: { relation: 'self', name: 'Rina D' }, consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' },
      preferredLanguage: 'kha', branchId: A, visitMode: 'lab', itemIds: [cbc], acceptedTotalMinor: 50000, ...extra,
    });
    const book = async (body: Record<string, unknown>, who = 'DESK') => (await expect(who, 'POST', `${DESK}/bookings`, 201, body)).json.data;
    const stored = async (id: string) => await PartnerLabBookingModel.findById(id).lean() as any;
    const home = { line1: '2 Hill Road', city: 'Shillong', pincode: '793001' };

    // ───────────────────────── Switch and indexes ─────────────────────────
    await check('switch off: lookup and new desk bookings answer 503 ASSISTED_BOOKING_DISABLED; nothing is written; by-key still works', async () => {
      delete process.env.LAB_DESK_ENABLED;
      try {
        await expect('DESK', 'POST', `${DESK}/patients/lookup`, 503, { phone: '9600000401' }, 'ASSISTED_BOOKING_DISABLED');
        await expect('DESK', 'POST', `${DESK}/bookings`, 503, order(), 'ASSISTED_BOOKING_DISABLED');
        process.env.LAB_DESK_ENABLED = 'yes';
        await expect('DESK', 'POST', `${DESK}/bookings`, 503, order(), 'ASSISTED_BOOKING_DISABLED');
        assert.equal((await expect('DESK', 'GET', `${DESK}/bookings/by-key/${newKey()}`, 200)).json.data.state, 'unknown');
      } finally { process.env.LAB_DESK_ENABLED = 'true'; }
      assert.equal(await PartnerLabBookingModel.countDocuments({}), 0);
    });

    await check('index 503: without the unique desk.requestKey index a create answers 503 INDEXES_OUTDATED and nothing is written', async () => {
      const col = mongoose.connection.collection('partner_lab_bookings');
      await col.dropIndex('desk.requestKey_1');
      resetIndexChecks();
      try {
        await expect('DESK', 'POST', `${DESK}/bookings`, 503, order(), 'INDEXES_OUTDATED');
      } finally {
        await col.createIndex({ 'desk.requestKey': 1 }, { unique: true, partialFilterExpression: { 'desk.requestKey': { $type: 'string' } } });
        resetIndexChecks();
      }
      assert.equal(await PartnerLabBookingModel.countDocuments({}), 0);
    });

    // ───────────────────────── Lookup ─────────────────────────
    await check('lookup: { exists, holderNameMasked } only; audited with ids, never the phone; a clinic is 403 LAB_PARTNER_REQUIRED; bookings.view alone is 403', async () => {
      const known = (await expect('DESK', 'POST', `${DESK}/patients/lookup`, 200, { phone: '9600000401' })).json.data;
      assert.deepEqual(known, { exists: true, holderNameMasked: maskName('Rina Kumari Das') });
      assert.deepEqual((await expect('DESK', 'POST', `${DESK}/patients/lookup`, 200, { phone: '9600000499' })).json.data, { exists: false, holderNameMasked: null });
      await expect('DESK', 'POST', `${DESK}/patients/lookup`, 400, { phone: '12' }, 'INVALID_PHONE');
      await expect('CLIN', 'POST', `${DESK}/patients/lookup`, 403, { phone: '9600000401' }, 'LAB_PARTNER_REQUIRED');
      await expect('VIEW', 'POST', `${DESK}/patients/lookup`, 403, { phone: '9600000401' }, 'INSUFFICIENT_PERMISSIONS');
      const rows = await PartnerAuditEventModel.find({ action: 'lab_desk.patient_lookup' }).lean();
      assert.equal(rows.length, 2);
      assert.ok(!JSON.stringify(rows).includes('9600000401'));
    });

    // ───────────────────────── Desk modes ─────────────────────────
    let walk: any;
    await check('walk-in: confirmed, no seat, walkIn + arrival time, lab_desk settlement, pending payment, no deadline; typed-name link; the patient sees "pay at the lab"', async () => {
      const d = await book(order({ itemIds: [cbc, lipid], acceptedTotalMinor: 80000 }));
      walk = d;
      assert.equal(d.replayed, false); assert.equal(d.newAccount, false);
      assert.deepEqual(d.patient, { name: 'Rina D' });
      const b = await stored(d.booking._id);
      assert.equal(b.status, 'confirmed'); assert.equal(b.statusVersion, 0); assert.equal(b.source, 'lab_desk');
      assert.equal(b.paymentStatus, 'pending'); assert.equal(b.paymentDeadline, undefined);
      assert.equal(b.settlement.settlementSystem, 'lab_desk');
      assert.equal(b.slot.walkIn, true); assert.equal(b.slot.slotId, undefined);
      assert.ok(Math.abs(new Date(b.slot.startsAt).getTime() - Date.now()) < 60_000);
      assert.ok(b.desk.arrivedAt); assert.equal(b.desk.payAtLab, true); assert.equal(b.desk.memberId, String(deskMember._id));
      assert.equal(b.pricing.subtotalMinor, 80000); assert.equal(b.pricing.commissionMinor, 0);
      assert.equal(b.assisted, undefined);
      assert.equal(b.userId, X); assert.equal(b.patient.name, 'Rina D');
      assert.deepEqual(b.items.map((i: any) => i.name), ['CBC', 'Lipid']);
      const link = await AssistedLinkModel.findOne({ bookerKind: 'lab', bookerId: L.toLowerCase(), userId: X }).lean() as any;
      assert.equal(link.typedName, 'Rina D'); assert.equal(link.consent, 'patient_agreed');
      // The lab view: the desk block without its key or hash; the bill (none yet).
      assert.equal(d.booking.source, 'lab_desk'); assert.equal(d.booking.payAtLab, true); assert.equal(d.booking.bill, null);
      assert.equal(d.booking.desk.requestKey, undefined); assert.equal(d.booking.desk.requestHash, undefined);
      assert.equal(d.booking.slot.walkIn, true);
      // The patient: pay at the lab, the lab's price, the bill link; no desk internals.
      const cv = (await expect('X', 'GET', `/api/v1/lab-bookings/${d.booking._id}`, 200)).json.data;
      assert.equal(cv.payAtLab, true); assert.equal(cv.source, 'lab_desk'); assert.equal(cv.desk, undefined); assert.equal(cv.bill, null);
      assert.equal(cv.pricing.subtotalMinor, 80000); assert.equal(cv.lab.name, 'Metro Labs');
      assert.ok((await expect('X', 'GET', '/api/v1/lab-bookings', 200)).json.data.some((x: any) => x._id === d.booking._id && x.payAtLab === true));
      assert.ok(labNotices.some((n) => n.key === `labdesk:${d.booking._id}:booked:customer` && n.userId === X && n.message.includes('Pay at the lab')));
      assert.ok(await PartnerAuditEventModel.exists({ action: 'lab_desk.booked', targetId: d.booking._id }));
    });

    let visit: any; let visitSlot = '';
    await check('lab visit on a slot: one seat; a slot starting in minutes is fine at the desk (no 60-minute lead)', async () => {
      visitSlot = await slot(0.2);
      visit = await book(order({ slotId: visitSlot }));
      assert.equal(await seats(visitSlot), 1);
      const b = await stored(visit.booking._id);
      assert.equal(b.slot.slotId, visitSlot); assert.equal(b.slot.walkIn, undefined);
      assert.equal(b.desk.arrivedAt, undefined);
    });

    let homeBooking: any; let homeSlot = '';
    await check('home collection: address and slot required, collector must be a member; one seat, the collector stored', async () => {
      homeSlot = await slot(5, 'home');
      await expect('DESK', 'POST', `${DESK}/bookings`, 400, order({ visitMode: 'home', slotId: homeSlot }), 'ADDRESS_REQUIRED');
      await expect('DESK', 'POST', `${DESK}/bookings`, 400, order({ visitMode: 'home', address: home }), 'SLOT_REQUIRED');
      await expect('DESK', 'POST', `${DESK}/bookings`, 400, order({ visitMode: 'home', address: home, slotId: homeSlot, collector: { memberId: String(second.owner._id), name: 'X' } }),
        'COLLECTOR_NOT_MEMBER');
      await expect('DESK', 'POST', `${DESK}/bookings`, 400, order({ collector: { name: 'Raju' } }), 'VALIDATION_ERROR');
      await expect('DESK', 'POST', `${DESK}/bookings`, 400, order({ visitMode: 'home', address: home, slotId: homeSlot, itemIds: [lipid], acceptedTotalMinor: 30000 }),
        'VISIT_MODE_NOT_SUPPORTED');
      assert.equal(await seats(homeSlot), 0);
      homeBooking = await book(order({ visitMode: 'home', address: home, slotId: homeSlot, collector: { memberId: String(pathologist._id), name: 'Dr Rao' } }));
      assert.equal(await seats(homeSlot), 1);
      const b = await stored(homeBooking.booking._id);
      assert.equal(b.visitMode, 'home'); assert.equal(b.address.line1, '2 Hill Road'); assert.equal(b.collector.name, 'Dr Rao');
      assert.equal(b.collector.memberId, String(pathologist._id));
    });

    await check('a new number opens an account as lab_desk (typed name); a family member by name is created; by id is stored MASKED (labs see typed or masked names only)', async () => {
      const d = await book(order({ phone: '9600000477', patient: { relation: 'self', name: 'Walk In Person' } }));
      assert.equal(d.newAccount, true);
      const u = await UserModel.findOne({ phone: '9600000477' }).lean() as any;
      assert.equal(u.createdSource, 'lab_desk'); assert.equal(u.name, 'Walk In Person'); assert.equal(u.otpVerified, false);
      const dep = await book(order({ patient: { relation: 'Son', name: 'Tiny Das' }, holderName: 'Rina D' }));
      assert.equal((await stored(dep.booking._id)).patient.name, 'Tiny Das');
      assert.ok(await DependentModel.exists({ userId: X, name: 'Tiny Das' }));
      const byId = await book(order({ patient: { dependentId: depX } }));
      assert.equal(byId.patient.name, maskName('Mina Das'));
      assert.equal((await stored(byId.booking._id)).patient.name, maskName('Mina Das'));
      // The lab never sees the account name of the holder anywhere in its views.
      const list = (await expect('OWN', 'GET', `${WS}/lab-bookings?source=lab_desk&limit=200`, 200)).json.data;
      assert.ok(list.length >= 5);
      assert.ok(!JSON.stringify(list).includes('Rina Kumari Das'));
      assert.ok(!JSON.stringify(list).includes('Mina Das'));
      assert.ok(list.every((x: any) => x.source === 'lab_desk'));
    });

    // ───────────────────────── Request keys ─────────────────────────
    await check('request keys: same key and body replays 200 (no second row or seat, uncounted); other content 409; by-key; abandoned never books', async () => {
      const s1 = await slot();
      const body = order({ slotId: s1 });
      const first = await book(body);
      const again = await expect('DESK', 'POST', `${DESK}/bookings`, 200, body);
      assert.equal(again.json.data.replayed, true); assert.equal(again.json.data.booking._id, first.booking._id);
      assert.equal(await seats(s1), 1);
      await expect('DESK', 'POST', `${DESK}/bookings`, 409, { ...body, itemIds: [lipid], acceptedTotalMinor: 30000 }, 'IDEMPOTENCY_KEY_REUSED');
      const used = (await expect('DESK', 'GET', `${DESK}/bookings/by-key/${body.requestKey}`, 200)).json.data;
      assert.equal(used.state, 'used'); assert.equal(used.booking._id, first.booking._id);
      // Another member's namespace: nothing of DESK's is found.
      assert.equal((await expect('OWN', 'GET', `${DESK}/bookings/by-key/${body.requestKey}`, 200)).json.data.state, 'unknown');
      const k = newKey();
      assert.equal((await expect('DESK', 'POST', `${DESK}/bookings/by-key/${k}/abandon`, 200)).json.data.state, 'abandoned');
      const s2 = await slot();
      await expect('DESK', 'POST', `${DESK}/bookings`, 409, order({ slotId: s2, requestKey: k }), 'REQUEST_ABANDONED');
      assert.equal(await seats(s2), 0);
      assert.equal((await expect('DESK', 'POST', `${DESK}/bookings/by-key/${body.requestKey}/abandon`, 200)).json.data.state, 'used');
    });

    await check('race: 5 identical creates for a new number give one booking, one account and one seat', async () => {
      const s1 = await slot();
      const body = order({ slotId: s1, phone: '9600000488', patient: { relation: 'self', name: 'Race Walkin' } });
      const rs = await Promise.all(Array.from({ length: 5 }, () => call('DESK', 'POST', `${DESK}/bookings`, body)));
      assert.ok(rs.every((r) => r.status === 201 || r.status === 200), rs.map((r) => `${r.status} ${r.text.slice(0, 120)}`).join(' | '));
      assert.equal(rs.filter((r) => r.status === 201).length, 1);
      assert.equal(new Set(rs.map((r) => r.json.data.booking._id)).size, 1);
      assert.equal(await PartnerLabBookingModel.countDocuments({ 'desk.requestKey': { $regex: body.requestKey } }), 1);
      assert.equal(await UserModel.countDocuments({ phone: '9600000488' }), 1);
      assert.equal(await seats(s1), 1);
      assert.equal(await AssistedLinkModel.countDocuments({ bookerKind: 'lab', bookerId: L.toLowerCase() }), 3, 'X, the new walk-in and this one');
    });

    await check('price fence: another total is 409 PRICE_CHANGED with the lab total (the 2a detail shape, no discount); consent and request key are required', async () => {
      const r = await expect('DESK', 'POST', `${DESK}/bookings`, 409, order({ acceptedTotalMinor: 49999 }), 'PRICE_CHANGED');
      assert.deepEqual(r.json.details ?? r.json.error?.details ?? r.json.data?.details, { priceMinor: 50000, listMinor: 50000, discountMinor: 0 });
      await expect('DESK', 'POST', `${DESK}/bookings`, 400, order({ consent: { agreed: false, statementVersion: 'v1', statementLanguage: 'en' } }), 'CONSENT_REQUIRED');
    });

    // ───────────────────────── Scope and eligibility ─────────────────────────
    await check('scope: another lab\'s test or branch is refused; a branch outside the member\'s scope is 403; another lab and another branch get the one 404 on reads and cancel', async () => {
      const users0 = await UserModel.countDocuments({});
      for (const phone of ['9600000401', '9600000466']) {
        await expect('DESK', 'POST', `${DESK}/bookings`, 400, order({ phone, itemIds: [far], acceptedTotalMinor: 40000 }), 'CATALOGUE_ITEM_NOT_AVAILABLE');
        await expect('DESK', 'POST', `${DESK}/bookings`, 404, order({ phone, branchId: A2 }), 'BRANCH_NOT_AVAILABLE');
        await expect('DESK', 'POST', `${DESK}/bookings`, 403, order({ phone, branchId: B }), 'BRANCH_SCOPE_EXCEEDED');
      }
      assert.equal(await UserModel.countDocuments({}), users0, 'no account opened');
      // A booking at branch B (by the owner): the branch-A desk member never sees or cancels it.
      const atB = await book(order({ branchId: B }), 'OWN');
      await expect('DESK', 'GET', `${WS}/lab-bookings/${atB.booking._id}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      await expect('DESK', 'POST', `${DESK}/bookings/${atB.booking._id}/cancel`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      // Another lab: the one 404 on read, steps, cancel and bill.
      await expect('LAB2', 'GET', `${WS}/lab-bookings/${walk.booking._id}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      await expect('LAB2', 'POST', `${DESK}/bookings/${walk.booking._id}/cancel`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      await expect('LAB2', 'POST', `${WS}/lab-bookings/${walk.booking._id}/visit`, 404);
      assert.equal((await stored(walk.booking._id)).status, 'confirmed');
    });

    await check('eligibility (S5): an unverified lab\'s member is 403 PARTNER_NOT_VERIFIED; an admin acting for it too; a clinic is 403 LAB_PARTNER_REQUIRED', async () => {
      await expect('UNV', 'POST', `${DESK}/bookings`, 403, order(), 'PARTNER_NOT_VERIFIED');
      await expect('ADMIN', 'POST', `${WS}/admin/${LU}/workspace/lab-desk/bookings`, 403, order(), 'PARTNER_NOT_VERIFIED');
      await expect('ADMIN', 'POST', `${WS}/admin/${CL}/workspace/lab-desk/bookings`, 403, order(), 'LAB_PARTNER_REQUIRED');
      await expect('CLIN', 'POST', `${DESK}/bookings`, 403, order(), 'LAB_PARTNER_REQUIRED');
      // Suspended meanwhile (admin acting): refused, nothing held.
      await PartnerModel.updateOne({ _id: L }, { $set: { isActive: false } });
      try {
        const s1 = await slot();
        await expect('ADMIN', 'POST', `${WS}/admin/${L}/workspace/lab-desk/bookings`, 403, order({ slotId: s1 }), 'PARTNER_NOT_VERIFIED');
        assert.equal(await seats(s1), 0);
      } finally { await PartnerModel.updateOne({ _id: L }, { $set: { isActive: true } }); }
      // The admin mirror books for a verified lab.
      const d = (await expect('ADMIN', 'POST', `${WS}/admin/${L}/workspace/lab-desk/bookings`, 201, order({ branchId: B }))).json.data;
      assert.equal((await stored(d.booking._id)).desk.memberId, `admin:${ADMIN}`);
    });

    // ───────────────────────── §5.5 guards ─────────────────────────
    await check('guards: pay-again 409 PAY_AT_LAB; the expiry sweep never touches a desk row; completion posts no ledger entry; the lab\'s balance never moves', async () => {
      const id = visit.booking._id;
      for (const b of [walk, visit, homeBooking]) await expect('X', 'POST', `/api/v1/lab-bookings/${b.booking._id}/pay`, 409, { useWalletBalance: true }, 'PAY_AT_LAB');
      const before = await stored(id);
      const swept = await labSvc.expireDue(new Date(Date.now() + 3 * 3_600_000));
      assert.equal(swept.examined, 0);
      assert.equal((await stored(id)).status, 'confirmed');
      assert.equal((await stored(id)).updatedAt.getTime(), before.updatedAt.getTime());
      const account = before.settlement.settlementAccountId;
      await expect('PATH', 'POST', `${WS}/lab-bookings/${id}/visit`, 200, {});
      await expect('PATH', 'POST', `${WS}/lab-bookings/${id}/process`, 200, {});
      await PartnerLabBookingModel.updateOne({ _id: id }, { $set: { status: 'report_ready' } });
      await expect('PATH', 'POST', `${WS}/lab-bookings/${id}/complete`, 200, {});
      assert.equal(await LedgerEntryModel.countDocuments({ source: 'partner_lab_booking', sourceId: id }), 0);
      assert.equal(await LedgerEntryModel.countDocuments({ settlementAccountId: account }), 0, 'no earning, so no payout ever sees it');
      assert.equal((await stored(id)).paymentStatus, 'pending');
    });

    await check('patient cancel before the visit: nothing refunded (wallet unchanged), payment stays pending, the seat back once, the desk member told; after the visit: 409', async () => {
      const s1 = await slot();
      const d = await book(order({ slotId: s1 }));
      const w = await wallet(X);
      const r = (await expect('X', 'POST', `/api/v1/lab-bookings/${d.booking._id}/cancel`, 200, {})).json.data;
      assert.equal(r.refunded, 0); assert.equal(r.booking.status, 'cancelled'); assert.equal(r.booking.payAtLab, true);
      assert.equal(await wallet(X), w);
      const b = await stored(d.booking._id);
      assert.equal(b.paymentStatus, 'pending'); assert.equal(b.cancellation.reason, 'customer');
      assert.equal(await seats(s1), 0);
      assert.ok(labNotices.some((n) => n.userId === String(deskMember._id) && n.key === `labdesk:${d.booking._id}:cancelled:member` && n.title === 'Cancelled by the patient'));
      await expect('X', 'POST', `/api/v1/lab-bookings/${d.booking._id}/cancel`, 409, {}, 'LAB_BOOKING_NOT_CANCELLABLE');
      assert.equal(await seats(s1), 0, 'released once');
      // A slot starting within 2 hours is still cancellable (no window: nothing was paid through Jansetu).
      const s2 = await slot(0.5);
      const near = await book(order({ slotId: s2 }));
      await expect('X', 'POST', `/api/v1/lab-bookings/${near.booking._id}/cancel`, 200, {});
      // After the visit (or a home sample): refused.
      await expect('X', 'POST', `/api/v1/lab-bookings/${visit.booking._id}/cancel`, 409, {}, 'LAB_BOOKING_NOT_CANCELLABLE');
      await expect('PATH', 'POST', `${WS}/lab-bookings/${homeBooking.booking._id}/collect`, 200, {});
      await expect('X', 'POST', `/api/v1/lab-bookings/${homeBooking.booking._id}/cancel`, 409, {}, 'LAB_BOOKING_NOT_CANCELLABLE');
    });

    await check('race: patient cancel vs lab visit — exactly one wins; the seat goes back only if the cancel won', async () => {
      for (let i = 0; i < 3; i++) {
        const s1 = await slot();
        const id = (await book(order({ slotId: s1 }))).booking._id;
        const rs = await Promise.all([call('X', 'POST', `/api/v1/lab-bookings/${id}/cancel`, {}), call('PATH', 'POST', `${WS}/lab-bookings/${id}/visit`, {})]);
        assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => `${r.status} ${r.text.slice(0, 150)}`).join(' | '));
        const b = await stored(id);
        assert.equal(await seats(s1), b.status === 'cancelled' ? 0 : 1, b.status);
        assert.equal(b.paymentStatus, 'pending');
      }
    });

    await check('walk-in: never a no-show (409 WALK_IN_ARRIVED), never rescheduled (409 WALK_IN_NOT_RESCHEDULABLE); visit at once; a patient cancel releases no seat', async () => {
      const w = await book(order());
      await expect('PATH', 'POST', `${WS}/lab-bookings/${w.booking._id}/no-show`, 409, {}, 'WALK_IN_ARRIVED');
      await expect('PATH', 'POST', `${WS}/lab-bookings/${w.booking._id}/reschedule`, 409, { slotId: await slot(), reason: 'move it' }, 'WALK_IN_NOT_RESCHEDULABLE');
      await expect('PATH', 'POST', `${WS}/lab-bookings/${walk.booking._id}/visit`, 200, {});
      const c = (await expect('X', 'POST', `/api/v1/lab-bookings/${w.booking._id}/cancel`, 200, {})).json.data;
      assert.equal(c.booking.status, 'cancelled');
    });

    await check('desk cancel: nothing refunded, seat back, patient told; a repeat is alreadyCancelled; a stale version is 409; not after the visit; an online row is 404', async () => {
      const s1 = await slot();
      const d = await book(order({ slotId: s1 }));
      await expect('DESK', 'POST', `${DESK}/bookings/${d.booking._id}/cancel`, 409, { expectedVersion: 7 }, 'LAB_BOOKING_CHANGED');
      const r = (await expect('DESK', 'POST', `${DESK}/bookings/${d.booking._id}/cancel`, 200, { reason: 'patient left', expectedVersion: 0 })).json.data;
      assert.equal(r.alreadyCancelled, false); assert.equal(r.booking.status, 'cancelled'); assert.equal(r.booking.cancellation.reason, 'desk');
      assert.equal(await seats(s1), 0);
      assert.equal((await stored(d.booking._id)).paymentStatus, 'pending');
      assert.ok(labNotices.some((n) => n.key === `plb:${d.booking._id}:cancelled` && n.userId === X));
      assert.ok(await PartnerAuditEventModel.exists({ action: 'lab_desk.cancelled', targetId: d.booking._id }));
      assert.equal((await expect('DESK', 'POST', `${DESK}/bookings/${d.booking._id}/cancel`, 200, {})).json.data.alreadyCancelled, true);
      assert.equal(await seats(s1), 0);
      await expect('PATH', 'POST', `${DESK}/bookings/${walk.booking._id}/cancel`, 409, {}, 'LAB_BOOKING_NOT_CANCELLABLE');
      // An online (customer-paid) row of this lab: not a desk row.
      const online = await PartnerLabBookingModel.create({ partnerId: L, branchId: A, userId: Y, patient: { kind: 'self', name: 'Bikash' }, visitMode: 'lab',
        slot: { slotId: await slot(), date: '2030-01-01', startTime: '10:00', endTime: '10:30', startsAt: new Date(Date.now() + 30 * 3_600_000) },
        items: [{ catalogItemId: cbc, kind: 'test', name: 'CBC', priceMinor: 50000, gstRate: 0 }],
        pricing: { subtotalMinor: 50000, discountMinor: 0, payableMinor: 50000, commissionMinor: 0, currency: 'INR' },
        settlement: { settlementAccountId: oid(), beneficiaryName: 'Metro', settlementSystem: 'ledger' }, status: 'confirmed', statusVersion: 1, paymentStatus: 'paid',
        paymentDeadline: new Date(), reschedule: { version: 0, pending: false }, report: { draftFiles: [], releasedFiles: [], releases: [] }, lifecycle: {} } as never);
      await expect('OWN', 'POST', `${DESK}/bookings/${online._id}/cancel`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      // …and it cannot be billed by the lab (L10).
      await expect('OWN', 'POST', `${WS}/invoices`, 404, { branchId: A, customer: { name: 'Bikash', phone: '9600000402' }, labBookingId: String(online._id),
        items: [{ catalogItemId: cbc, description: 'CBC', qty: 1, unitPriceMinor: 50000, gstRate: 0 }], idempotencyKey: newKey() }, 'LAB_BOOKING_NOT_FOUND');
    });

    // ───────────────────────── Q2 bill link ─────────────────────────
    const bill = (labBookingId: string, extra: Record<string, unknown> = {}) => ({ branchId: A, customer: { name: 'Rina D', phone: '9600000401' }, labBookingId,
      items: [{ catalogItemId: cbc, description: 'CBC', qty: 1, unitPriceMinor: 50000, gstRate: 0 }], idempotencyKey: newKey(), ...extra });
    await check('bill link: once per desk booking (race: one wins, the other 409 LAB_BOOKING_ALREADY_BILLED); views show it; a cancelled bill frees it', async () => {
      const d = await book(order({ slotId: await slot() }));
      const id = d.booking._id;
      const rs = await Promise.all([call('OWN', 'POST', `${WS}/invoices`, bill(id)), call('OWN', 'POST', `${WS}/invoices`, bill(id))]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409], rs.map((r) => r.text.slice(0, 200)).join(' | '));
      assert.equal(rs.find((r) => r.status === 409)!.json.code, 'LAB_BOOKING_ALREADY_BILLED');
      const inv = rs.find((r) => r.status === 201)!.json.data;
      assert.equal(inv.labBookingId, id); assert.equal(inv.openLabBookingId, id);
      assert.equal(await InvoiceModel.countDocuments({ labBookingId: id }), 1);
      const lv = (await expect('DESK', 'GET', `${WS}/lab-bookings/${id}`, 200)).json.data;
      assert.deepEqual(lv.bill, { invoiceId: String(inv._id), serial: inv.serial, number: inv.number, state: 'issued' });
      const cv = (await expect('X', 'GET', `/api/v1/lab-bookings/${id}`, 200)).json.data;
      assert.equal(cv.bill.invoiceId, String(inv._id));
      await expect('X', 'GET', `/api/v1/bills/${inv._id}`, 200);
      await expect('OWN', 'POST', `${WS}/invoices/${inv._id}/cancel`, 200, { reason: 'wrong tests' });
      assert.equal((await InvoiceModel.findById(inv._id).lean() as any).openLabBookingId, undefined);
      assert.equal((await expect('DESK', 'GET', `${WS}/lab-bookings/${id}`, 200)).json.data.bill.state, 'cancelled');
      const second2 = (await expect('OWN', 'POST', `${WS}/invoices`, 201, bill(id))).json.data;
      assert.equal((await expect('DESK', 'GET', `${WS}/lab-bookings?source=lab_desk&limit=200`, 200)).json.data.find((x: any) => x._id === id).bill.invoiceId, String(second2._id));
    });

    await check('bill link refusals: the wrong customer 409; a cancelled booking 409; another branch 400; appointment and lab booking together 400; another lab 404', async () => {
      const d = await book(order({ slotId: await slot() }));
      await expect('OWN', 'POST', `${WS}/invoices`, 409, bill(d.booking._id, { customer: { name: 'Bikash', phone: '9600000402' } }), 'LAB_BOOKING_CUSTOMER_MISMATCH');
      await expect('OWN', 'POST', `${WS}/invoices`, 409, bill(d.booking._id, { customer: { name: 'No phone' } }), 'LAB_BOOKING_CUSTOMER_MISMATCH');
      await expect('OWN', 'POST', `${WS}/invoices`, 400, bill(d.booking._id, { branchId: B }), 'LAB_BOOKING_BRANCH_MISMATCH');
      await expect('OWN', 'POST', `${WS}/invoices`, 400, bill(d.booking._id, { appointmentId: oid() }), 'VALIDATION_ERROR');
      await expect('LAB2', 'POST', `${WS}/invoices`, 404, bill(d.booking._id, { branchId: A2, items: [{ catalogItemId: far, description: 'Far', qty: 1, unitPriceMinor: 40000, gstRate: 0 }] }),
        'LAB_BOOKING_NOT_FOUND');
      await expect('DESK', 'POST', `${DESK}/bookings/${d.booking._id}/cancel`, 200, {});
      await expect('OWN', 'POST', `${WS}/invoices`, 409, bill(d.booking._id), 'LAB_BOOKING_CANCELLED');
      assert.equal(await InvoiceModel.countDocuments({ labBookingId: d.booking._id }), 0);
    });

    await check('bill index 503: without the unique openLabBookingId index a linked bill answers 503 INDEXES_OUTDATED; unlinked bills still work', async () => {
      const d = await book(order({ slotId: await slot() }));
      const col = mongoose.connection.collection('partner_invoices');
      await col.dropIndex('openLabBookingId_1');
      resetIndexChecks();
      try {
        await expect('OWN', 'POST', `${WS}/invoices`, 503, bill(d.booking._id), 'INDEXES_OUTDATED');
        const { labBookingId: _l, ...plain } = bill(d.booking._id);
        await expect('OWN', 'POST', `${WS}/invoices`, 201, plain);
      } finally {
        await col.createIndex({ openLabBookingId: 1 }, { unique: true, partialFilterExpression: { openLabBookingId: { $type: 'string' } } });
        resetIndexChecks();
      }
      assert.equal(await InvoiceModel.countDocuments({ labBookingId: d.booking._id }), 0);
    });

    // ───────────────────────── Report ─────────────────────────
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    await check('report: released to the patient\'s app (the patient reads it); another lab\'s member gets 404', async () => {
      const id = walk.booking._id;
      await expect('PATH', 'POST', `${WS}/lab-bookings/${id}/process`, 200, {});
      const fd = new FormData();
      fd.append('files', new Blob([pdf], { type: 'application/pdf' }), 'report.pdf');
      const up = await fetch(`${base}${WS}/lab-bookings/${id}/reports`, { method: 'POST', headers: { authorization: `Bearer ${tokens.PATH}` }, body: fd });
      const upJson = await up.json() as any;
      assert.equal(up.status, 201, JSON.stringify(upJson).slice(0, 300));
      const path = String(upJson.data.report.draftFiles[0]).replace(/^\/api\/static\//, '');
      await expect('PATH', 'POST', `${WS}/lab-bookings/${id}/reports/release`, 200, { file: `/api/static/${path}` });
      const read = async (who: string) => (await fetch(`${base}/api/static/${path}`, { headers: { authorization: `Bearer ${tokens[who]}` } })).status;
      assert.equal(await read('X'), 200);
      assert.equal(await read('LAB2'), 404);
      assert.equal(await read('Y'), 404);
      assert.ok(labNotices.some((n) => n.userId === X && n.key === `plb:${id}:report:${path}`));
      await expect('PATH', 'POST', `${WS}/lab-bookings/${id}/complete`, 200, {});
      assert.equal(await LedgerEntryModel.countDocuments({ source: 'partner_lab_booking', sourceId: id }), 0);
    });

    // ───────────────────────── Online customer bookings unchanged ─────────────────────────
    await check('an online customer lab booking behaves as before: wallet-paid, ledger settlement, no desk fields; its cancel refunds the wallet; completion earns', async () => {
      const mk = async () => {
        const r = await expect('Y', 'POST', '/api/v1/lab-bookings', 201, { partnerId: L, branchId: A, visitMode: 'lab', slotId: await slot(), itemIds: [cbc],
          patient: { kind: 'self' }, useWalletBalance: true, requestKey: newKey(), acceptedPayableMinor: 50000 });
        return r.json.data;
      };
      const w0 = await wallet(Y);
      const a = await mk();
      assert.equal(a.paymentRequired, false);
      const b = await stored(a.booking._id);
      assert.equal(b.status, 'confirmed'); assert.equal(b.paymentStatus, 'paid'); assert.equal(b.settlement.settlementSystem, 'ledger');
      assert.ok(b.paymentDeadline); assert.equal(b.desk, undefined);
      assert.equal(a.booking.payAtLab, undefined); assert.equal(a.booking.desk, undefined);
      assert.equal(await wallet(Y), w0 - 500);
      const view = (await expect('OWN', 'GET', `${WS}/lab-bookings/${a.booking._id}`, 200)).json.data;
      assert.equal(view.payAtLab, undefined); assert.equal(view.bill, undefined);
      assert.ok(!(await expect('OWN', 'GET', `${WS}/lab-bookings?source=lab_desk&limit=200`, 200)).json.data.some((x: any) => x._id === a.booking._id));
      assert.ok((await expect('OWN', 'GET', `${WS}/lab-bookings?source=self&limit=200`, 200)).json.data.some((x: any) => x._id === a.booking._id));
      const c = await mk();
      const back = (await expect('Y', 'POST', `/api/v1/lab-bookings/${c.booking._id}/cancel`, 200, {})).json.data;
      assert.equal(back.refunded, 500);
      assert.equal((await stored(c.booking._id)).paymentStatus, 'refunded');
      assert.equal(await wallet(Y), w0 - 500);
      await expect('PATH', 'POST', `${WS}/lab-bookings/${a.booking._id}/visit`, 200, {});
      await expect('PATH', 'POST', `${WS}/lab-bookings/${a.booking._id}/process`, 200, {});
      await PartnerLabBookingModel.updateOne({ _id: a.booking._id }, { $set: { status: 'report_ready' } });
      await expect('PATH', 'POST', `${WS}/lab-bookings/${a.booking._id}/complete`, 200, {});
      const e = await LedgerEntryModel.find({ source: 'partner_lab_booking', sourceId: a.booking._id, kind: 'earning' }).lean() as any[];
      assert.deepEqual(e.map((x) => x.amountMinor), [50000]);
    });

    await check('a pharmacy-booked (assisted) row is never billed by the lab nor cancelled at the desk', async () => {
      const P = oid();
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700000401', city: 'Shillong', pincode: '793001', isActive: true, isVerified: true } as never);
      await runLedgerTransaction((s) => postPharmacyMovementIn({ pharmacyId: P, kind: 'credit', amountPaise: 1_000_000, operationKey: `seed:${oid()}`,
        referenceType: 'admin_topup', referenceId: oid(), description: 'seed' }, s));
      const ph = jwt.sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
      const r = await call(ph, 'POST', '/api/v1/pharmacy-assisted/lab-bookings', { requestKey: newKey(), phone: '9600000401', patient: { relation: 'self', name: 'Rina D' },
        consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' }, preferredLanguage: 'kha', partnerId: L, branchId: A, visitMode: 'lab',
        slotId: await slot(), itemIds: [cbc], acceptedPriceMinor: 50000, paymentMethod: 'wallet' });
      assert.equal(r.status, 201, r.text.slice(0, 300));
      const id = r.json.data.booking._id;
      await expect('OWN', 'POST', `${DESK}/bookings/${id}/cancel`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      await expect('OWN', 'POST', `${WS}/invoices`, 404, bill(id), 'LAB_BOOKING_NOT_FOUND');
      const lv = (await expect('OWN', 'GET', `${WS}/lab-bookings/${id}`, 200)).json.data;
      assert.equal(lv.payAtLab, undefined); assert.equal(lv.desk, undefined); assert.equal(lv.source, 'pharmacy_assisted');
    });

    await check('no OTP, token or phone number in the desk audit rows (ids and codes only)', async () => {
      const rows = await PartnerAuditEventModel.find({ action: { $regex: '^lab_desk\\.' } }).lean();
      assert.ok(rows.length > 10);
      const text = JSON.stringify(rows);
      for (const phone of ['9600000401', '9600000477', '9600000488']) assert.ok(!text.includes(phone), 'no phone in audit');
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
