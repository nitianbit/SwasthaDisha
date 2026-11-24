/**
 * Assisted booking round 3b (ASSISTED_BOOKING_DESIGN.md §25.5, build record §25.15): a DOCTOR books a partner-lab test for
 * a patient and pays from its doctor wallet — the 2a create generalised to a doctor booker. The patient comes from the
 * doctor's own consultation inside its treating window (no lookup counted) or is a walk-in by phone. Money: one debit;
 * a refund exactly once across racing cancels, to the DOCTOR wallet (all lab refunds now go through the booker
 * dispatcher; the pharmacy's still right). Report access (the booking doctor, released, 90 days, while verified), scope
 * (the one 404), names, the unverified doctor, cut 0, reconciliation. Real routes over HTTP (configureRoutes) on MongoDB.
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r26_phase3b_check?directConnection=true' npx tsx test/assisted/r26-phase3b.integration.ts
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
import BookingModel from '@/modules/bookings/model';
import SpecialistModel from '@/modules/specialists/model';
import { PartnerWalletEntryModel, PartnerWalletModel } from '@/modules/partnerWallets/model';
import { partnerStore } from '@/modules/partnerWallets/ledger';
import { postMovementIn } from '@/modules/pharmacyWallet/walletCore';
import { AssistedLinkModel } from '@/modules/assisted/model/links';
import { runReconciliation } from '@/modules/assisted/reconciliation';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r26_phase3b_check?directConnection=true';
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
const newKey = () => `r26-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;

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
    process.env.ASSISTED_BOOKING_ENABLED_DOCTOR = 'true';
    process.env.ASSISTED_LAB_BOOKING_ENABLED_DOCTOR = 'true';
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


    // ── Doctors (D verified with a wallet, D2 verified, DU unverified) and their consultations ──
    const D = oid(); const D2 = oid(); const DU = oid();
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(D), name: 'Asha Menon', email: 'asha@doc.test', specialization: 'General Physician', city: 'Shillong', pincode: '793001', consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(D2), name: 'Dr Two', email: 'two@doc.test', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(DU), name: 'Dr New', email: 'new@doc.test', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: false },
    ] as never);
    const seedDoctor = async (id: string, minor: number) => { const st = partnerStore('doctor', id); await st.ensure();
      await runLedgerTransaction((s) => postMovementIn(st, { kind: 'credit', amountMinor: minor, operationKey: `seed:${oid()}`, referenceType: 'seed', referenceId: oid(), description: 'seed' }, s)); };
    await seedDoctor(D, 1_000_000); await seedDoctor(D2, 100_000); await seedDoctor(DU, 100_000);
    const dbal = async (id = D) => Number((await PartnerWalletModel.findOne({ ownerKind: 'doctor', ownerId: id }).lean() as any)?.balanceMinor ?? 0);
    const ymd = (t: Date) => new Date(t.getTime() + IST).toISOString().slice(0, 10).replace(/-/g, '');
    const hm = (t: Date) => new Date(t.getTime() + IST).toISOString().slice(11, 16);
    /** A consultation of `doctor` for the customer X (or a family member), at `at`. */
    const consultation = async (doctor: string, at: Date, extra: Record<string, unknown> = {}) => String((await BookingModel.collection.insertOne({
      bookingType: 'consultation', specialistId: doctor, userId: X, bookingDate: ymd(at), bookingTime: hm(at), consultationMode: 'video', serviceMode: 'video',
      status: 'confirmed', paymentStatus: 'paid', createdAt: new Date(), updatedAt: new Date(), ...extra } as never)).insertedId);
    tokens.D = sign({ _id: D, specialistId: D, userType: 'specialist' });
    tokens.D2 = sign({ _id: D2, specialistId: D2, userType: 'specialist' });
    tokens.DU = sign({ _id: DU, specialistId: DU, userType: 'specialist' });
    const ME = '/api/v1/specialists/me/assisted';
    const fromVisit = (slotId: string, fromBookingId: string, extra: Record<string, unknown> = {}) => {
      const { phone: _p, patient: _q, ...rest } = order(slotId, extra) as Record<string, unknown>;
      return { ...rest, fromBookingId, typedName: 'Rina D', ...extra };
    };
    const doctorDebits = (id: string) => PartnerWalletEntryModel.find({ ownerKind: 'doctor', operationKey: `assisted_lab:${id}:debit` }).lean();
    const doctorRefunds = (id: string) => PartnerWalletEntryModel.find({ ownerKind: 'doctor', operationKey: `assisted_lab:${id}:refund` }).lean();
    const visitNow = await consultation(D, new Date(Date.now() - 20 * MIN));

    // ───────────────────────── Create ─────────────────────────
    let dFirst: any;
    await check('from the doctor\'s own consultation: one doctor-wallet debit, doctor_assisted, fromBookingId, the link\'s typed name, no lookup counted; cut 0', async () => {
      const s1 = await slot();
      const before = await dbal();
      const audits = await AssistedAuditEventModel.countDocuments({ orgKind: 'doctor', action: 'booking.attempted' });
      const out = await expect('D', 'POST', `${ME}/lab-bookings`, 201, fromVisit(s1, visitNow));
      dFirst = out.json.data;
      const b = await stored(dFirst.booking._id);
      assert.equal(b.source, 'doctor_assisted');
      assert.deepEqual([b.assisted.bookedBy.kind, b.assisted.bookedBy.id, b.assisted.bookedBy.name], ['doctor', D, 'Dr Asha Menon']);
      assert.equal(b.assisted.fromBookingId, visitNow); assert.equal(b.userId, X);
      assert.deepEqual([b.assisted.funding.payerKind, b.assisted.funding.payerId, b.assisted.funding.amountMinor], ['doctor', D, 50000]);
      assert.equal(b.assisted.split.cutMinor, 0); assert.ok(b.assisted.split.lines.every((l: any) => l.cutMinor === 0)); assert.equal(b.assisted.referral, null);
      assert.equal(await dbal(), before - 50000);
      assert.equal((await doctorDebits(dFirst.booking._id)).length, 1);
      assert.equal(await debitsOf(dFirst.booking._id), 0, 'never the pharmacy wallet');
      assert.equal((await AssistedLinkModel.findOne({ bookerKind: 'doctor', bookerId: D, userId: X }).lean() as any).typedName, 'Rina D');
      assert.equal(await AssistedAuditEventModel.countDocuments({ orgKind: 'doctor', action: 'booking.attempted' }), audits, 'no lookup counted');
      assert.equal(dFirst.booking.holder.name, 'Rina D'); assert.equal(dFirst.booking.patientName, 'Rina D');
      assert.notEqual(dFirst.booking.holder.name, 'Rina Kumari Das', 'never the account name');
      assert.equal(await seats(s1), 1);
    });

    await check('race: 5 identical creates give one booking and one debit; a replay answers 200 replayed', async () => {
      const s1 = await slot();
      const body = fromVisit(s1, visitNow);
      const before = await dbal();
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => call('D', 'POST', `${ME}/lab-bookings`, body)));
      assert.ok(rs.every((r) => r.status === 200 || r.status === 201), rs.map((r) => r.status).join(','));
      assert.equal(new Set(rs.map((r) => r.json.data.booking._id)).size, 1);
      assert.equal(await dbal(), before - 50000);
      assert.equal((await doctorDebits(rs[0]!.json.data.booking._id)).length, 1);
      const again = await expect('D', 'POST', `${ME}/lab-bookings`, 200, body);
      assert.equal(again.json.data.replayed, true);
      await expect('D', 'POST', `${ME}/lab-bookings`, 409, { ...body, typedName: 'Other Name' }, 'IDEMPOTENCY_KEY_REUSED');
    });

    await check('treating window: another doctor\'s or a missing booking 404; cancelled or long closed 409 TREATING_WINDOW_CLOSED; an unpaid card booking and an open "not mine" 404', async () => {
      const s1 = await slot();
      const other = await consultation(D2, new Date(Date.now() - 20 * MIN));
      await expect('D', 'POST', `${ME}/lab-bookings`, 404, fromVisit(s1, other), 'BOOKING_NOT_FOUND');
      await expect('D', 'POST', `${ME}/lab-bookings`, 404, fromVisit(s1, oid()), 'BOOKING_NOT_FOUND');
      const cancelled = await consultation(D, new Date(Date.now() - 20 * MIN), { status: 'cancelled' });
      await expect('D', 'POST', `${ME}/lab-bookings`, 409, fromVisit(s1, cancelled), 'TREATING_WINDOW_CLOSED');
      const old = await consultation(D, new Date(Date.now() - 40 * DAY), { status: 'completed', lifecycle: { completed: { at: new Date(Date.now() - 31 * DAY) } } });
      await expect('D', 'POST', `${ME}/lab-bookings`, 409, fromVisit(s1, old), 'TREATING_WINDOW_CLOSED');
      const recent = await consultation(D, new Date(Date.now() - 20 * DAY), { status: 'completed', lifecycle: { completed: { at: new Date(Date.now() - 20 * DAY) } } });
      const future = await consultation(D, new Date(Date.now() + 2 * DAY));
      await expect('D', 'POST', `${ME}/lab-bookings`, 409, fromVisit(s1, future), 'TREATING_WINDOW_CLOSED');
      const unpaid = await consultation(D, new Date(Date.now() - 20 * MIN), { status: 'pending', paymentStatus: 'pending', assisted: { funding: { method: 'razorpay' } } });
      await expect('D', 'POST', `${ME}/lab-bookings`, 404, fromVisit(s1, unpaid), 'BOOKING_NOT_FOUND');
      const disputed = await consultation(D, new Date(Date.now() - 20 * MIN));
      await AssistedReviewItemModel.collection.insertOne({ kind: 'not_mine', bookingKind: 'booking', bookingId: disputed, reportedBy: X, state: 'open', createdAt: new Date() } as never);
      await expect('D', 'POST', `${ME}/lab-bookings`, 404, fromVisit(s1, disputed), 'BOOKING_NOT_FOUND');
      assert.equal(await seats(s1), 0, 'nothing held');
      await expect('D', 'POST', `${ME}/lab-bookings`, 201, fromVisit(s1, recent));
      await expect('D', 'POST', `${ME}/lab-bookings`, 400, { ...fromVisit(s1, visitNow), phone: '9600000301' }, 'VALIDATION_ERROR');
    });

    await check('walk-in by phone: the masked lookup is counted; the create opens a new number\'s account in the transaction; names typed or masked', async () => {
      const lk = await expect('D', 'POST', `${ME}/patients/lookup`, 200, { phone: '9600000301' });
      assert.equal(lk.json.data.exists, true); assert.equal(lk.json.data.holderNameMasked, maskName('Rina Kumari Das'));
      const unknown = await expect('D', 'POST', `${ME}/patients/lookup`, 200, { phone: '9600000399' });
      assert.deepEqual(unknown.json.data, { exists: false, holderNameMasked: null });
      assert.ok(await AssistedAuditEventModel.countDocuments({ orgKind: 'doctor', orgId: D, action: 'patient.lookup' }) >= 2);
      const s1 = await slot();
      const r = await expect('D', 'POST', `${ME}/lab-bookings`, 201, order(s1, { phone: '9600000398', patient: { relation: 'self', name: 'Walk In' } }));
      const b = await stored(r.json.data.booking._id);
      assert.equal(r.json.data.newAccount, true); assert.equal(b.source, 'doctor_assisted'); assert.equal(b.assisted.fromBookingId, undefined);
      assert.equal(r.json.data.booking.holder.typedName, 'Walk In');
      const labs = await expect('D', 'GET', `${ME}/labs?visitMode=lab`, 200);
      assert.equal(labs.json.data.find((l: any) => l.partnerId === L).nearby, 'pincode', 'nearby the doctor\'s own pincode');
      await expect('D', 'POST', `${ME}/lab-bookings`, 400, order(await slot(), { paymentMethod: 'razorpay' }), 'PAYMENT_METHOD_UNAVAILABLE');
    });

    await check('the doctor must be verified: every route 403 SPECIALIST_NOT_VERIFIED; the in-transaction re-read refuses one that turned unverified', async () => {
      const s1 = await slot();
      await expect('DU', 'POST', `${ME}/lab-bookings`, 403, order(s1), 'SPECIALIST_NOT_VERIFIED');
      await expect('DU', 'GET', `${ME}/lab-bookings`, 403, undefined, 'SPECIALIST_NOT_VERIFIED');
      await expect('DU', 'POST', `${ME}/patients/lookup`, 403, { phone: '9600000301' }, 'SPECIALIST_NOT_VERIFIED');
      const { DOCTOR } = await import('@/modules/partnerWallets/ledger');
      await assert.rejects(runLedgerTransaction((s) => DOCTOR.assertMaySpendIn(DU, s)), (e: any) => e.code === 'SPECIALIST_NOT_VERIFIED');
      assert.equal(await seats(s1), 0);
    });

    // ───────────────────────── Cancel and refunds ─────────────────────────
    await check('race: doctor cancel vs patient cancel vs lab reject — one wins; ONE refund to the doctor wallet, one seat back; the customer wallet never moves', async () => {
      const s1 = await slot();
      const d = (await expect('D', 'POST', `${ME}/lab-bookings`, 201, fromVisit(s1, visitNow))).json.data;
      const id = d.booking._id;
      const before = await dbal();
      const rs = await Promise.all([
        call('D', 'POST', `${ME}/lab-bookings/${id}/cancel`, {}),
        call('X', 'POST', `/api/v1/lab-bookings/${id}/cancel`, {}),
        call('LAB', 'POST', `${WS}/lab-bookings/${id}/reject`, { reason: 'machine down' }),
      ]);
      const wins = rs.filter((r) => r.status === 200 && r.json.data?.alreadyCancelled !== true);
      assert.equal(wins.length, 1, rs.map((r) => `${r.status} ${r.text.slice(0, 150)}`).join(' | '));
      assert.equal(await dbal(), before + 50000, 'refunded exactly once, to the doctor');
      assert.equal((await doctorRefunds(id)).length, 1);
      const b = await stored(id);
      assert.equal(b.assisted.funding.state, 'refunded'); assert.equal(b.assisted.funding.refunds.length, 1);
      assert.equal(await seats(s1), 0);
      assert.equal(Number((await WalletModel.findOne({ userId: X }).lean() as any).balance), 0);
      assert.equal((await refundsOf(id)).length, 0, 'never the pharmacy wallet');
    });

    await check('a refund to a frozen wallet, or of a doctor no longer verified, always posts; the 1 h rule as the pharmacy\'s', async () => {
      const s1 = await slot();
      const d = (await expect('D', 'POST', `${ME}/lab-bookings`, 201, fromVisit(s1, visitNow))).json.data;
      await PartnerWalletModel.updateOne({ ownerKind: 'doctor', ownerId: D }, { $set: { frozen: true } });
      const before = await dbal();
      try {
        const c = await expect('D', 'POST', `${ME}/lab-bookings/${d.booking._id}/cancel`, 200, {});
        assert.equal(c.json.data.refundedMinor, 50000);
        assert.equal(await dbal(), before + 50000, 'a refund to a frozen wallet posts');
      } finally { await PartnerWalletModel.updateOne({ ownerKind: 'doctor', ownerId: D }, { $set: { frozen: false } }); }
      // The patient cancels a booking of a doctor that lost verification: the doctor is still refunded.
      const s2 = await slot();
      const d2 = (await expect('D', 'POST', `${ME}/lab-bookings`, 201, fromVisit(s2, visitNow))).json.data;
      await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(D) }, { $set: { isVerified: false } });
      const mid = await dbal();
      try { await expect('X', 'POST', `/api/v1/lab-bookings/${d2.booking._id}/cancel`, 200, {}); }
      finally { await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(D) }, { $set: { isVerified: true } }); }
      assert.equal(await dbal(), mid + 50000);
      // Inside the hour before the slot: refused, as for a pharmacy (the shared cancelAsBooker).
      const s3 = await slot();
      const d3 = (await expect('D', 'POST', `${ME}/lab-bookings`, 201, fromVisit(s3, visitNow))).json.data;
      await PartnerLabBookingModel.updateOne({ _id: d3.booking._id }, { $set: { 'slot.startsAt': new Date(Date.now() + 59 * MIN) } });
      await expect('D', 'POST', `${ME}/lab-bookings/${d3.booking._id}/cancel`, 409, {}, 'CANCELLATION_WINDOW_CLOSED');
    });

    await check('the pharmacy\'s lab refunds are unchanged by the dispatcher: one refund to the pharmacy wallet, lots restored', async () => {
      const s1 = await slot();
      const d = await book('P', order(s1));
      const before = await balance(P);
      await expect('P', 'POST', `${PA}/lab-bookings/${d.booking._id}/cancel`, 200, {});
      assert.equal(await balance(P), before + 50000);
      const rows = await refundsOf(d.booking._id);
      assert.equal(rows.length, 1); assert.equal((rows[0] as any).transactionType, 'refund_credit'); assert.equal((rows[0] as any).signedAmountPaise, 50000);
      assert.equal((await doctorRefunds(d.booking._id)).length, 0);
    });

    // ───────────────────────── Scope, reports, reconciliation ─────────────────────────
    await check('scope: another doctor, the pharmacy and a doctor\'s own list see only their own (the one 404)', async () => {
      const id = dFirst.booking._id;
      await expect('D2', 'GET', `${ME}/lab-bookings/${id}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      await expect('D2', 'POST', `${ME}/lab-bookings/${id}/cancel`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      await expect('P', 'GET', `${PA}/lab-bookings/${id}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      const mine = await expect('D', 'GET', `${ME}/lab-bookings?limit=50`, 200);
      assert.ok(mine.json.data.every((x: any) => x.source === 'doctor_assisted'));
      assert.ok(mine.json.data.some((x: any) => x._id === id));
      assert.ok(!(await expect('D2', 'GET', `${ME}/lab-bookings?limit=50`, 200)).json.data.some((x: any) => x._id === id));
      const byKey = await expect('D', 'GET', `${ME}/lab-bookings/by-key/${newKey()}`, 200);
      assert.equal(byKey.json.data.state, 'unknown');
    });

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
    await check('report: the booking doctor reads the RELEASED report for 90 days while verified; never a draft; another doctor and a pharmacy never; the patient always', async () => {
      const id = dFirst.booking._id;
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/visit`, 200, {});
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/process`, 200, {});
      const draft = await upload(id);
      assert.equal(await fileStatus(draft, 'D'), 404, 'never a draft');
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/reports/release`, 200, { file: `/api/static/${draft}` });
      assert.equal(await fileStatus(draft, 'D'), 200);
      assert.equal(await fileStatus(draft, 'D2'), 404); assert.equal(await fileStatus(draft, 'P'), 404);
      assert.equal(await fileStatus(draft, 'X'), 200);
      assert.equal((await expect('D', 'GET', `${ME}/lab-bookings/${id}`, 200)).json.data.report.releases.length, 1);
      await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(D) }, { $set: { isVerified: false } });
      try { assert.equal(await fileStatus(draft, 'D'), 404, 'not while unverified'); }
      finally { await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(D) }, { $set: { isVerified: true } }); }
      await PartnerLabBookingModel.updateOne({ _id: id }, { $set: { 'report.releases.0.releasedAt': new Date(Date.now() - 89 * DAY) } });
      assert.equal(await fileStatus(draft, 'D'), 200);
      await PartnerLabBookingModel.updateOne({ _id: id }, { $set: { 'report.releases.0.releasedAt': new Date(Date.now() - 91 * DAY) } });
      assert.equal(await fileStatus(draft, 'D'), 404, 'not after 90 days');
      assert.deepEqual((await expect('D', 'GET', `${ME}/lab-bookings/${id}`, 200)).json.data.report, { releases: [] });
      assert.equal(await fileStatus(draft, 'X'), 200);
    });

    await check('reconciliation: doctor rows reconcile (debit and refund read from the doctor wallet); a cancelled row left unrefunded is flagged', async () => {
      const r = await runReconciliation(new Date(), { full: true });
      assert.deepEqual(r.checks.mismatches.filter((m: any) => m.check.startsWith('lab_')), [], JSON.stringify(r.checks.mismatches).slice(0, 400));
      const s1 = await slot();
      const d = (await expect('D', 'POST', `${ME}/lab-bookings`, 201, fromVisit(s1, visitNow))).json.data;
      await PartnerLabBookingModel.updateOne({ _id: d.booking._id }, { $set: { status: 'cancelled' } });
      const bad = await runReconciliation(new Date(), { full: true });
      assert.ok(bad.checks.mismatches.some((m: any) => m.check === 'lab_cancelled_not_refunded' && m.ref === d.booking._id));
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
