/**
 * r11b: leftovers of the review of round 2a (ASSISTED_BOOKING_DESIGN.md §24.15). Each check fails on 7d99f2cf.
 *  1. `notes` on the lab create is neither stored nor part of the request hash (the same key with other notes replays);
 *  2. while a "not mine" report is open, the holder cannot read the lab report file (the booker and the lab still can);
 *  3. every lab-booking notice carries `data.bookingKind: 'lab_booking'` (the lab notifier; the patient's move notices);
 *  4. the patient's cancel and accept of a new time are audited, the accept tells the booker, and the lab's view of a
 *     booker cancellation does not name the pharmacy by id.
 * Same wiring as test/assisted/r11-phase2a.integration.ts (its own database).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r11b_phase2a_fixes_check?directConnection=true' npx tsx test/assisted/r11b-phase2a-fixes.integration.ts
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
import { LabBookingService, defaultLabNotifier } from '@/modules/partners/services/labBookings';
import { NotificationService } from '@/modules/notification/services';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { resetIndexChecks } from '@/modules/common/utils/requiredIndex';
import { AssistedAuditEventModel, AssistedReviewItemModel } from '@/modules/assisted/model';
import { setAssistedNotifier } from '@/modules/assisted/support';
import { maskName } from '@/modules/assisted/names';
import type { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r11b_phase2a_fixes_check?directConnection=true';
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
const assistedNotices: { audience: string; userId: string; key: string; title: string; message: string; data?: Record<string, unknown> }[] = [];
setAssistedNotifier(async (n) => { assistedNotices.push({ audience: n.audience, userId: n.userId, key: n.key, title: n.title, message: n.message, data: n.data }); });

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
const newKey = () => `r11b-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;

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

    const setStart = (id: string, at: Date) => PartnerLabBookingModel.updateOne({ _id: id }, { $set: { 'slot.startsAt': at } });
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
    void [LU, AU, unvItem, CL, A2, far, lipid, B, depX, seats, debitsOf, refundsOf, maskName, AssistedReviewItemModel, CouponModel, CouponRedemptionModel,
      PharmacyCustomerModel, LedgerEntryModel, resetIndexChecks, CatalogueItemModel, W, R, Q, Y];

    await check('1: `notes` on a lab create is neither stored nor hashed — the same key with other notes replays the booking', async () => {
      const body = order(await slot(), { notes: 'first note' });
      const d = (await expect('P', 'POST', `${PA}/lab-bookings`, 201, body)).json.data;
      assert.equal((await stored(d.booking._id)).notes, undefined, 'not stored');
      const again = (await expect('P', 'POST', `${PA}/lab-bookings`, 200, { ...body, notes: 'another note' })).json.data;
      assert.equal(again.replayed, true);
      assert.equal(again.booking._id, d.booking._id);
    });

    await check('2: while a "not mine" report is open the holder cannot read the lab report; the booker and the lab still can; a dismissal gives it back', async () => {
      const id = (await book('P', order(await slot()))).booking._id;
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/visit`, 200, {});
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/process`, 200, {});
      const file = await upload(id);
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/reports/release`, 200, { file: `/api/static/${file}` });
      assert.equal(await fileStatus(file, 'X'), 200, 'before the report');
      await expect('X', 'POST', `/api/v1/lab-bookings/${id}/not-mine`, 200, { note: 'not me' });
      assert.equal(await fileStatus(file, 'X'), 404, 'the holder: not while the report is open');
      assert.equal(await fileStatus(file, 'P'), 200, 'the booker keeps its access');
      assert.equal(await fileStatus(file, 'LAB'), 200, 'the lab keeps its access');
      const item = (await expect('ADMIN', 'GET', '/api/v1/admin/assisted/review-items?state=open', 200)).json.data.find((i: any) => i.bookingId === id);
      await expect('ADMIN', 'POST', `/api/v1/admin/assisted/review-items/${item._id ?? item.id}/dismiss`, 200, { reason: 'checked: it is theirs' });
      assert.equal(await fileStatus(file, 'X'), 200, 'dismissed: the holder reads it again');
    });

    await check('3: every lab-booking notice carries data.bookingKind "lab_booking" (the lab notifier; the patient\'s move notices)', async () => {
      // The lab notifier (every customer notice of a lab booking goes through it).
      const created: any[] = [];
      Container.set(NotificationService, { create: async (x: any) => { created.push(x); return x; } } as never);
      await defaultLabNotifier({ userId: X, type: 'general', title: 't', message: 'm', bookingId: oid(), key: 'k-' + oid() });
      assert.equal(created[0]?.data?.bookingKind, 'lab_booking');
      // The admin move: moved-off and moved-to (the patients) and the booker.
      const id = (await book('P', order(await slot(), { phone: '9600000302', patient: { relation: 'self', name: 'Bikash' } }))).booking._id;
      await expect('Y', 'POST', `/api/v1/lab-bookings/${id}/not-mine`, 200, {});
      await expect('ADMIN', 'POST', `/api/v1/admin/assisted-bookings/${id}/move`, 200, { toPhone: '9600000303', holderName: 'Zed H', reason: 'wrong number', requestKey: newKey() });
      const moved = assistedNotices.filter((n) => n.key.startsWith(`assisted:lab:${id}:moved`));
      assert.equal(moved.length, 3);
      for (const n of moved) assert.equal(n.data?.bookingKind, 'lab_booking', n.key);
    });

    await check('4: the patient\'s cancel and accept are audited; the accept tells the booker; the lab never sees the pharmacy id of a booker cancel', async () => {
      // Patient accepts the lab's new time.
      const a = (await book('P', order(await slot()))).booking._id;
      const moved = (await expect('LAB', 'POST', `${WS}/lab-bookings/${a}/reschedule`, 200, { slotId: await slot(40), reason: 'staff away' })).json.data;
      await expect('X', 'POST', `/api/v1/lab-bookings/${a}/accept-reschedule`, 200, { version: moved.reschedule.version });
      const acc = await AssistedAuditEventModel.findOne({ bookingId: a, action: 'booking.reschedule_accepted' }).lean() as any;
      assert.deepEqual([acc?.actorKind, acc?.actorId, acc?.orgId], ['customer', X.toLowerCase(), P.toLowerCase()]);
      assert.ok(assistedNotices.some((n) => n.audience === 'booker' && n.key === `assisted:lab:${a}:reschedule:${moved.reschedule.version}:accepted:booker`
        && n.data?.bookingKind === 'lab_booking'), 'the booker is told');
      await expect('X', 'POST', `/api/v1/lab-bookings/${a}/accept-reschedule`, 409, { version: moved.reschedule.version }, 'NO_PENDING_RESCHEDULE');
      // Patient cancels.
      const c = (await book('P', order(await slot()))).booking._id;
      await setStart(c, new Date(Date.now() + 5 * 3_600_000));
      await expect('X', 'POST', `/api/v1/lab-bookings/${c}/cancel`, 200, {});
      const can = await AssistedAuditEventModel.findOne({ bookingId: c, action: 'booking.cancelled' }).lean() as any;
      assert.deepEqual([can?.actorKind, can?.detail?.cause], ['customer', 'patient']);
      // Booker cancels: the lab sees "booker", not the pharmacy's id.
      const k = (await book('P', order(await slot()))).booking._id;
      await expect('P', 'POST', `${PA}/lab-bookings/${k}/cancel`, 200, {});
      const v = (await expect('LAB', 'GET', `${WS}/lab-bookings/${k}`, 200)).json.data;
      assert.equal(v.cancellation.byKind, 'booker');
      assert.equal(v.cancellation.by, undefined);
      assert.ok(!JSON.stringify(v.cancellation).includes(P), 'no pharmacy id');
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
