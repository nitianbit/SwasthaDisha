/**
 * Round r29 (ASSISTED_BOOKING_DESIGN.md §25.6, build record §25.16):
 *  A. a newly rendered prescription PDF is headed "Jansetu" (owner, 25 Nov), never "MyEwaCare";
 *  B. round 3c — a DOCTOR pays a lab-test booking by card/UPI through the one card machinery (1b/2b/2e), with the doctor
 *     as the payer: the order's payer fields, the capture's payer check, the refund rows (`payerKind: 'doctor'`), refunds
 *     to the card or to the doctor wallet, the follow-up lease, late and extra captures, chargeback flag only, and DR9
 *     (an unverified doctor's capture goes back to the card).
 * Checked over HTTP with the real routes (configureRoutes) on MongoDB, a stand-in Razorpay and a stand-in refund gateway:
 *  1. gates (card switch, doctor lab switch, gateway keys, an unverified doctor) and the card refund index (503);
 *  2. create: `pending_payment`, 30-minute pay-by, one record owned by the doctor, no wallet money; replay, by-key, the
 *     doctor's booker view `payment`; the patient and the lab never see the unpaid row;
 *  3. verify / reconcile / recovery sweep / expiry sweep racing: confirmed once, one patient notice;
 *  4. scope: another doctor, a pharmacy, the patient and an admin get the uniform 404;
 *  5. late capture after expiry, an extra capture: each refunded to the card once;
 *  6. cancel to the card (doctor, patient, lab) or to the doctor wallet; cancel before payment;
 *  7. DR9: a capture for a doctor no longer verified is returned to the card; its verify answers 403;
 *  8. admin: the card refund queue names the doctor; to-wallet; chargeback flag only;
 *  9. the switches off: only new bookings stop;
 * 10. pharmacy and lab card payments, and the doctor wallet path (3b), unchanged.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r29_phase3c_check?directConnection=true' npx tsx test/assisted/r29-phase3c.integration.ts
 */
import { removeFixtureDir } from '../partners/q3-fixture-dir';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { errorHandler } from '@/modules/middleware';
import UserModel from '@/modules/user/model';
import { UserRepository } from '@/modules/user/repository';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import SpecialistModel from '@/modules/specialists/model';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { postPharmacyMovementIn } from '@/modules/pharmacyWallet/ledger';
import { postMovementIn } from '@/modules/pharmacyWallet/walletCore';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import { PartnerSlotModel } from '@/modules/partners/model/slot';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { PartnerService, type PartnerActor } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { PartnerWalletEntryModel, PartnerWalletModel } from '@/modules/partnerWallets/model';
import { partnerStore } from '@/modules/partnerWallets/ledger';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { resetIndexChecks } from '@/modules/common/utils/requiredIndex';
import { AssistedAlertModel, AssistedAuditEventModel, AssistedCardRefundModel } from '@/modules/assisted/model';
import { setAssistedEffects, setAssistedNotifier } from '@/modules/assisted/support';
import { recordPayerFieldsOf, recordPayerOf, runCardRefundsDue, setAssistedRefundGateway } from '@/modules/assisted/cardRefunds';
import { sweepAssistedOtherCaptures } from '@/modules/assisted/cardPayments';
import { bookerAuditFields } from '@/modules/assisted/bookers';
import { buildDispensingHtml } from '@/modules/assisted/dispensingCopy';
import { runReconciliation } from '@/modules/assisted/reconciliation';
import { SpecialistPortalService } from '@/modules/specialistPortal/services';
import type { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r29_phase3c_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
const noop = new Proxy({}, { get: () => async () => undefined });

// ── Razorpay stand-in: orders made, the payments each order holds (set per check), refunds (switchable outcome) ──
type GatewayPayment = { id: string; order_id: string; amount: number; currency: string; status: string; fee?: number };
const gateway = {
  orders: [] as { id: string; amount: number; receipt: string }[],
  payments: {} as Record<string, GatewayPayment[]>,
  refunds: [] as { id: string; paymentId: string; amount: number; status: string; notes: Record<string, unknown> }[],
  refundCalls: 0,
  refundMode: 'processed' as 'processed' | 'pending' | 'reject',
};
const fakeRazorpay = {
  orders: {
    create: async (o: { amount: number; currency: string; receipt: string }) => {
      const id = 'order_r29_' + oid();
      gateway.orders.push({ id, amount: o.amount, receipt: o.receipt });
      return { id, amount: o.amount, currency: o.currency, status: 'created' };
    },
    fetchPayments: async (orderId: string) => ({ items: gateway.payments[orderId] ?? [] }),
  },
  payments: { fetch: async (id: string) => {
    const p = Object.values(gateway.payments).flat().find((x) => x.id === id);
    if (!p) throw Object.assign(new Error('The id provided does not exist'), { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR' } });
    return p;
  } },
};
const refundGateway = {
  listRefunds: async (paymentId: string) => gateway.refunds.filter((r) => r.paymentId === paymentId),
  fetchRefund: async (_p: string, refundId: string) => {
    const r = gateway.refunds.find((x) => x.id === refundId);
    if (!r) throw new Error('no such refund');
    return r;
  },
  refund: async (paymentId: string, body: { amount: number; receipt: string; notes: Record<string, string> }) => {
    gateway.refundCalls += 1;
    if (gateway.refundMode === 'reject') throw Object.assign(new Error('refund refused'), { statusCode: 400 });
    const r = { id: 'rfnd_' + oid(), paymentId, amount: body.amount, status: gateway.refundMode === 'pending' ? 'pending' : 'processed', notes: body.notes };
    gateway.refunds.push(r);
    return r;
  },
};

// ── Services (tsx emits no decorator metadata: wired by hand) ──
let credentials = () => ({ keyId: 'rzp_test_key', keySecret: 'secret' });
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), pharmacyWalletRepository: new PharmacyWalletRepository(),
  pharmacyWalletTransactionRepository: new PharmacyWalletTransactionRepository(), bookingReminderScheduler: noop,
  getRazorpayClient: () => fakeRazorpay, getRazorpayCredentials: () => credentials(),
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
setAssistedEffects({ meet: async (b: any) => b, cancelMeet: async (b: any) => b, reminders: async () => undefined, clearReminders: async () => undefined } as never);
setAssistedRefundGateway(refundGateway as never);

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let phoneSeq = 7290000000;
const nextPhone = () => String(phoneSeq++);
let keySeq = 0;
const newKey = () => `r29-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;

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
    process.env.ASSISTED_CARD_PAYMENT_ENABLED = 'true';
    process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';
    process.env.ASSISTED_BOOKING_ENABLED_DOCTOR = 'true';
    process.env.ASSISTED_LAB_BOOKING_ENABLED_DOCTOR = 'true';
  };
  flagsOn();

  try {
    // ───────────────────────── A. The prescription PDF heading ─────────────────────────
    await check('A: a newly rendered prescription is headed "Jansetu", never "MyEwaCare"; the dispensing copy says Jansetu as before', async () => {
      const portal = Object.create(SpecialistPortalService.prototype) as { buildPrescriptionHtml(input: unknown): string };
      const html = portal.buildPrescriptionHtml({ booking: { _id: oid(), bookingDate: '20261125', bookingTime: '10:00' }, patient: { name: 'Rina D' },
        specialist: { name: 'Dr Asha Menon' }, diagnosis: 'Fever', medicines: [{ name: 'Paracetamol', dosage: '500 mg' }], testsAdvised: ['CBC'], advice: 'Rest' });
      assert.ok(html.includes('<div class="brand">Jansetu</div>'), 'the heading says Jansetu');
      assert.ok(!/myewacare/i.test(html), 'no MyEwaCare anywhere on a new prescription');
      assert.ok(html.includes('Paracetamol') && html.includes('Dr Asha Menon'), 'the rest of the prescription is as before');
      const copy = buildDispensingHtml({ booking: { _id: oid(), prescription: { medicines: [{ name: 'Paracetamol' }] } }, doctorName: 'Dr Asha Menon',
        patientName: 'Rina D', age: null });
      assert.ok(copy.includes('<div class="brand">Jansetu</div>') && !/myewacare/i.test(copy), 'the dispensing copy: Jansetu (unchanged)');
    });

    // ── A verified lab with a branch, a staff member and a test ──
    const { partner, owner } = await partnerSvc.createPartner({
      kind: 'lab', name: 'Metro Labs', legalName: 'Metro Labs Pvt Ltd', contactPhone: nextPhone(), invoiceSeriesPrefix: 'ML',
      firstOwner: { phone: nextPhone(), name: 'Owner' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZH',
    } as never);
    const L = String(partner._id);
    await partnerSvc.verifyPartner(L, 'admin');
    const own = actorFor(owner);
    const A = String((await partnerSvc.createBranch(own, { name: 'Police Bazar', phone: '9876500000', holidays: [], hours: {},
      services: { homeCollection: true, inLab: true, inClinic: false }, address: { line1: '1 Road', city: 'Shillong', state: 'Meghalaya', stateCode: '17', pincode: '793001' } } as never))._id);
    const staff = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', permissions: ['bookings.view', 'bookings.manage'] } as never);
    const cbc = String((await catalogueSvc.createItem(own, { kind: 'test', name: 'CBC', priceMinor: 50000, gstRate: 0, visitModes: ['home', 'lab'], reportTatHours: 24 } as never))._id);

    let minute = 0;
    /** A fresh slot `hours` ahead (a distinct minute each time), capacity 5. */
    const slot = async (hours = 30) => {
      const startsAt = new Date(Math.floor(Date.now() / MIN) * MIN + hours * 3_600_000 + (++minute) * MIN);
      const s = new Date(startsAt.getTime() + IST).toISOString();
      const e = new Date(startsAt.getTime() + 30 * MIN + IST).toISOString();
      const row = await PartnerSlotModel.create({ partnerId: L, branchId: A, visitMode: 'lab', date: s.slice(0, 10), startTime: s.slice(11, 16), endTime: e.slice(11, 16),
        startsAt, endsAt: new Date(startsAt.getTime() + 30 * MIN), capacity: 5, booked: 0, closed: null, source: 'manual' } as never);
      return String(row._id);
    };
    const seats = async (slotId: string) => Number((await PartnerSlotModel.findById(slotId).lean())!.booked);

    // ── A pharmacy, the patient, doctors (D verified, D2 verified, D3 verified for the DR9 check, DU unverified) ──
    const P = oid(); const X = oid(); const ADMIN = oid();
    const D = oid(); const D2 = oid(); const D3 = oid(); const DU = oid();
    await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700000901', city: 'Shillong', pincode: '793001',
      isActive: true, isVerified: true } as never);
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(X), userType: 'user', phone: '9600000901', name: 'Rina Kumari Das', createdSource: 'self_signup',
      otpVerified: true } as never);
    await WalletModel.create({ userId: X, balance: 0, isActive: true });
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(D), name: 'Asha Menon', email: 'asha@doc.test', specialization: 'General Physician', city: 'Shillong', pincode: '793001', consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(D2), name: 'Dr Two', email: 'two@doc.test', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(D3), name: 'Three Rao', email: 'three@doc.test', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(DU), name: 'Dr New', email: 'new@doc.test', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: false },
    ] as never);
    const seedDoctor = async (id: string, minor: number) => { const st = partnerStore('doctor', id); await st.ensure();
      await runLedgerTransaction((s) => postMovementIn(st, { kind: 'credit', amountMinor: minor, operationKey: `seed:${oid()}`, referenceType: 'seed', referenceId: oid(), description: 'seed' }, s)); };
    await seedDoctor(D, 1_000_000); await seedDoctor(D3, 100_000);
    const dwallet = async (id = D) => {
      const w = await PartnerWalletModel.findOne({ ownerKind: 'doctor', ownerId: id }).lean() as any;
      return { minor: Number(w?.balanceMinor ?? 0), withdrawable: Number(w?.withdrawableMinor ?? 0) };
    };
    await runLedgerTransaction((s) => postPharmacyMovementIn({ pharmacyId: P, kind: 'credit', amountPaise: 1_000_000, operationKey: `seed:${oid()}`,
      referenceType: 'admin_topup', referenceId: oid(), description: 'seed' }, s));
    const ymd = (t: Date) => new Date(t.getTime() + IST).toISOString().slice(0, 10).replace(/-/g, '');
    const hm = (t: Date) => new Date(t.getTime() + IST).toISOString().slice(11, 16);
    /** A consultation of `doctor` for the customer X, at `at` (its treating window is open for a recent one). */
    const consultation = async (doctor: string, at: Date) => String((await BookingModel.collection.insertOne({
      bookingType: 'consultation', specialistId: doctor, userId: X, bookingDate: ymd(at), bookingTime: hm(at), consultationMode: 'video', serviceMode: 'video',
      status: 'confirmed', paymentStatus: 'paid', createdAt: new Date(), updatedAt: new Date() } as never)).insertedId);
    const visitD = await consultation(D, new Date(Date.now() - 20 * MIN));
    const visitD3 = await consultation(D3, new Date(Date.now() - 20 * MIN));

    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const tokens: Record<string, string> = {
      D: sign({ _id: D, specialistId: D, userType: 'specialist' }), D2: sign({ _id: D2, specialistId: D2, userType: 'specialist' }),
      D3: sign({ _id: D3, specialistId: D3, userType: 'specialist' }), DU: sign({ _id: DU, specialistId: DU, userType: 'specialist' }),
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), X: sign({ _id: X, userType: 'user', authVersion: 0 }), ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
      LAB: sign({ _id: String(staff._id), memberId: String(staff._id), partnerId: L, userType: 'partner' }),
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
    const ME = '/api/v1/specialists/me/assisted';
    const PA = '/api/v1/pharmacy-assisted';
    const WS = '/api/v1/partner-workspace';
    const PAY = '/api/v1/payments';
    const ADM = '/api/v1/admin';
    const consent = { agreed: true, statementVersion: 'v1', statementLanguage: 'en' };
    /** A doctor's lab booking of its own consultation's patient, by card unless `extra` says otherwise. */
    const doctorOrder = (slotId: string, extra: Record<string, unknown> = {}, visit = visitD) => ({
      requestKey: newKey(), fromBookingId: visit, typedName: 'Rina D', consent, preferredLanguage: 'en', partnerId: L, branchId: A, visitMode: 'lab', slotId,
      itemIds: [cbc], acceptedPriceMinor: 50000, paymentMethod: 'razorpay', ...extra,
    });
    const book = async (who = 'D', extra: Record<string, unknown> = {}, slotId?: string, visit = visitD) => {
      const body = doctorOrder(slotId ?? await slot(), extra, visit);
      const r = await expect(who, 'POST', `${ME}/lab-bookings`, 201, body);
      return { body, data: r.json.data, id: String(r.json.data.booking._id) };
    };
    /** The gateway reports a capture on this booking's order; returns what verify needs. */
    const capture = (data: any) => {
      const orderId = data.payment.razorpayOrderId as string;
      const payId = 'pay_r29' + oid().slice(-12);
      gateway.payments[orderId] = [{ id: payId, order_id: orderId, amount: data.payment.amountMinor, currency: 'INR', status: 'captured', fee: 1180 }];
      const signature = crypto.createHmac('sha256', 'secret').update(`${orderId}|${payId}`).digest('hex');
      return { paymentTransactionId: data.payment.paymentTransactionId, razorpayOrderId: orderId, razorpayPaymentId: payId, razorpaySignature: signature };
    };
    /** A second captured payment on the same order (Razorpay accepts several on an "attempted" order). */
    const secondCapture = (data: any) => {
      const orderId = data.payment.razorpayOrderId as string;
      const payId = 'pay_r29x' + oid().slice(-12);
      (gateway.payments[orderId] ??= []).push({ id: payId, order_id: orderId, amount: data.payment.amountMinor, currency: 'INR', status: 'captured', fee: 1180 });
      const signature = crypto.createHmac('sha256', 'secret').update(`${orderId}|${payId}`).digest('hex');
      return { paymentTransactionId: data.payment.paymentTransactionId, razorpayOrderId: orderId, razorpayPaymentId: payId, razorpaySignature: signature };
    };
    const later = (ms: number) => new Date(Date.now() + ms);
    /** The recovery sweep, as if 11 minutes passed (every unsettled attempt is due). */
    const sweep = async () => {
      await PaymentRecordModel.collection.updateMany({}, { $unset: { recoveryNextAt: '' } });
      return payments.sweepUnsettledBookingPayments(later(11 * MIN), 1000);
    };
    const expireSweep = () => labSvc.expireDue(later(31 * MIN), 1000);
    const worker = () => runCardRefundsDue(later(10 * MIN));
    const stored = async (id: string) => await PartnerLabBookingModel.findById(id).lean() as any;
    const refundsOf = async (id: string) => await AssistedCardRefundModel.find({ bookingId: id }).sort({ createdAt: 1 }).lean() as any[];
    const refundsFor = (payId: string) => gateway.refunds.filter((r) => r.paymentId === payId);
    const paidBooking = async (who = 'D', visit = visitD) => {
      const b = await book(who, {}, undefined, visit);
      const v = capture(b.data);
      await expect(who, 'POST', `${PAY}/verify`, 200, v);
      assert.equal((await stored(b.id)).status, 'confirmed');
      return { ...b, v };
    };
    const noticesOf = (id: string) => labNotices.filter((n) => n.key.includes(id)).length + assistedNotices.filter((n) => n.key.includes(id)).length;

    // ───────────────────────── 1. Gates, switches, index ─────────────────────────
    await check('gates: card switch off 400, doctor lab switch off 503, no gateway keys 503, an unverified doctor 403 — before any seat, row or order', async () => {
      const orders0 = gateway.orders.length;
      const s1 = await slot();
      process.env.ASSISTED_CARD_PAYMENT_ENABLED = 'false';
      try {
        await expect('D', 'POST', `${ME}/lab-bookings`, 400, doctorOrder(s1), 'PAYMENT_METHOD_UNAVAILABLE');
        await expect('D', 'GET', `${ME}/lab-bookings`, 200);
      } finally { flagsOn(); }
      delete process.env.ASSISTED_LAB_BOOKING_ENABLED_DOCTOR;
      try { await expect('D', 'POST', `${ME}/lab-bookings`, 503, doctorOrder(s1), 'ASSISTED_BOOKING_DISABLED'); } finally { flagsOn(); }
      const creds = credentials;
      credentials = () => { throw new Error('not configured'); };
      try { await expect('D', 'POST', `${ME}/lab-bookings`, 503, doctorOrder(s1), 'RAZORPAY_NOT_CONFIGURED'); } finally { credentials = creds; }
      await expect('DU', 'POST', `${ME}/lab-bookings`, 403, doctorOrder(s1), 'SPECIALIST_NOT_VERIFIED');
      assert.equal(await PartnerLabBookingModel.countDocuments({ source: 'doctor_assisted' }), 0, 'nothing held');
      assert.equal(await seats(s1), 0);
      assert.equal(gateway.orders.length, orders0, 'no order');
    });

    await check('index 503: without the unique captureKey index of card refund rows a doctor card create answers 503 INDEXES_OUTDATED; nothing is written', async () => {
      const col = mongoose.connection.collection('assisted_card_refunds');
      await col.dropIndex('captureKey_1');
      resetIndexChecks();
      const s1 = await slot();
      try {
        await expect('D', 'POST', `${ME}/lab-bookings`, 503, doctorOrder(s1), 'INDEXES_OUTDATED');
      } finally {
        await col.createIndex({ captureKey: 1 }, { unique: true, partialFilterExpression: { captureKey: { $type: 'string' } } });
        resetIndexChecks();
      }
      assert.equal(await PartnerLabBookingModel.countDocuments({ source: 'doctor_assisted' }), 0);
      assert.equal(await seats(s1), 0);
    });

    // ───────────────────────── 2. Create, replay, by-key, the booker view ─────────────────────────
    let first: Awaited<ReturnType<typeof book>>;
    await check('create: pending_payment, 30-minute pay-by, seat held; ONE order on a record the DOCTOR owns (no pharmacy); no wallet money; nobody told', async () => {
      const before = await dwallet();
      const s1 = await slot();
      labNotices.length = 0; assistedNotices.length = 0;
      first = await book('D', {}, s1);
      const d = first.data;
      assert.deepEqual([d.replayed, d.booking.status], [false, 'pending_payment']);
      assert.deepEqual([d.funding.method, d.funding.state, d.funding.amountMinor, d.funding.walletEntryId], ['razorpay', 'pending', 50000, null]);
      assert.equal(d.funding.paymentTransactionId, d.payment.paymentTransactionId);
      assert.deepEqual([d.payment.paymentRequired, d.payment.amountMinor, d.payment.amount, d.payment.currency, d.payment.razorpayKeyId], [true, 50000, 500, 'INR', 'rzp_test_key']);
      assert.match(d.payment.razorpayOrderId, /^order_r29_/);
      const row = await stored(first.id);
      assert.deepEqual([row.status, row.paymentStatus, row.statusVersion, row.source], ['pending_payment', 'pending', 0, 'doctor_assisted']);
      assert.deepEqual([row.assisted.funding.payerKind, row.assisted.funding.payerId, row.assisted.bookedBy.name], ['doctor', D, 'Dr Asha Menon']);
      assert.equal(d.payment.payBy, new Date(row.paymentDeadline).toISOString());
      assert.ok(Math.abs(new Date(row.paymentDeadline).getTime() - (new Date(row.createdAt).getTime() + 30 * MIN)) < 5000, '30-minute pay-by');
      assert.equal(row.lifecycle?.confirmedAt, undefined);
      assert.equal(row.assisted.split.cutMinor, 0, 'doctor referral cuts stay off');
      assert.equal(await seats(s1), 1, 'the seat is held');
      const rec = await PaymentRecordModel.findById(d.payment.paymentTransactionId).lean() as any;
      assert.deepEqual([rec.context, rec.contextId, rec.userId, rec.payerUserId, rec.payerSpecialistId, rec.status],
        ['assisted_lab_booking', first.id, D, D, D, 'created']);
      assert.deepEqual([rec.payerPharmacyId, rec.payerPartnerId, rec.couponCode], [undefined, undefined, undefined], 'no other payer named');
      assert.deepEqual([rec.notes.flow, rec.notes.specialistId, rec.notes.bookingId], ['assisted_lab_booking', D, first.id]);
      assert.match(gateway.orders.find((o) => o.id === d.payment.razorpayOrderId)!.receipt, /^ewa_al_/);
      assert.deepEqual(await dwallet(), before, 'no doctor wallet movement');
      assert.equal(await PartnerWalletEntryModel.countDocuments({ operationKey: `assisted_lab:${first.id}:debit` }), 0);
      assert.equal(noticesOf(first.id), 0, 'the patient hears of it once it is paid');
      const audit = await AssistedAuditEventModel.findOne({ bookingId: first.id, action: 'booking.created' }).lean() as any;
      assert.deepEqual([audit.actorKind, audit.orgKind, audit.orgId, audit.detail.method], ['doctor', 'doctor', D, 'razorpay']);
    });

    await check('replay → 200 with the SAME order (also as "wallet"); by-key shows it; the doctor\'s booker view carries pay-now; ?status=pending_payment lists it', async () => {
      const orders0 = gateway.orders.length;
      const again = await expect('D', 'POST', `${ME}/lab-bookings`, 200, first.body);
      assert.equal(again.json.data.replayed, true);
      assert.equal(again.json.data.payment.razorpayOrderId, first.data.payment.razorpayOrderId);
      const asWallet = await expect('D', 'POST', `${ME}/lab-bookings`, 200, { ...first.body, paymentMethod: 'wallet' });
      assert.equal(asWallet.json.data.funding.method, 'razorpay', 'the method is not part of the request hash');
      const byKey = (await expect('D', 'GET', `${ME}/lab-bookings/by-key/${first.body.requestKey}`, 200)).json.data;
      assert.equal(byKey.state, 'used');
      assert.equal(byKey.payment.razorpayOrderId, first.data.payment.razorpayOrderId);
      await expect('D', 'POST', `${ME}/lab-bookings`, 409, { ...first.body, preferredLanguage: 'hi' }, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(gateway.orders.length, orders0, 'no second order');
      const v = (await expect('D', 'GET', `${ME}/lab-bookings/${first.id}`, 200)).json.data;
      assert.deepEqual(v.payment, { method: 'razorpay', state: 'pending', payBy: first.data.payment.payBy, paymentTransactionId: first.data.payment.paymentTransactionId,
        razorpayOrderId: first.data.payment.razorpayOrderId, razorpayKeyId: 'rzp_test_key', amountMinor: 50000, currency: 'INR' });
      assert.equal(v.assisted.funding, undefined, 'never the funding block');
      assert.deepEqual(Object.keys(v.holder).sort(), ['linkId', 'name', 'typedName']);
      const waiting = (await expect('D', 'GET', `${ME}/lab-bookings?status=pending_payment`, 200)).json.data;
      assert.ok(waiting.some((x: any) => x._id === first.id));
    });

    await check('unpaid doctor card rows are the doctor\'s alone: the patient and the lab neither list nor read nor act on them (uniform 404)', async () => {
      const id = first.id;
      assert.ok(!(await expect('X', 'GET', '/api/v1/lab-bookings', 200)).json.data.some((x: any) => x._id === id));
      await expect('X', 'GET', `/api/v1/lab-bookings/${id}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      await expect('X', 'POST', `/api/v1/lab-bookings/${id}/cancel`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      await expect('X', 'POST', `/api/v1/lab-bookings/${id}/not-mine`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      assert.ok(!(await expect('LAB', 'GET', `${WS}/lab-bookings?branchId=${A}`, 200)).json.data.some((x: any) => x._id === id));
      await expect('LAB', 'GET', `${WS}/lab-bookings/${id}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/reject`, 404, { reason: 'not today' }, 'LAB_BOOKING_NOT_FOUND');
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/visit`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      assert.equal((await stored(id)).status, 'pending_payment');
    });

    // ───────────────────────── 3. Verify / reconcile / sweeps racing ─────────────────────────
    await check('verify ×2, reconcile, recovery sweep and expiry sweep racing on one capture: confirmed exactly once, one patient notice (2 runs)', async () => {
      for (let i = 0; i < 2; i++) {
        const b = i === 0 ? first : await book();
        const v = capture(b.data);
        const before = await dwallet();
        labNotices.length = 0;
        await PaymentRecordModel.collection.updateMany({}, { $unset: { recoveryNextAt: '' } });
        const results = await Promise.allSettled([
          call('D', 'POST', `${PAY}/verify`, v), call('D', 'POST', `${PAY}/reconcile`, { paymentTransactionId: v.paymentTransactionId }),
          payments.sweepUnsettledBookingPayments(later(11 * MIN), 1000), expireSweep(), call('D', 'POST', `${PAY}/verify`, v),
        ]);
        const answers = [results[0], results[1], results[4]].map((r) => (r as PromiseFulfilledResult<any>).value);
        for (const a of answers) assert.ok([200, 409].includes(a.status), `answer ${a.status} ${a.text.slice(0, 200)}`);
        await sweep();
        const after = await stored(b.id);
        assert.deepEqual([after.status, after.paymentStatus, after.assisted.funding.state, after.statusVersion], ['confirmed', 'paid', 'captured', 1]);
        assert.equal(after.assisted.funding.razorpayPaymentId, v.razorpayPaymentId);
        assert.equal(after.postPaymentCompletedFor, v.paymentTransactionId, 'follow-up done');
        assert.equal(after.assisted.followUpLeaseUntil, undefined, 'lease released');
        const paid = await AssistedAuditEventModel.find({ bookingId: b.id, action: 'booking.paid' }).lean() as any[];
        assert.equal(paid.length, 1, 'one confirmation');
        assert.deepEqual([paid[0].actorKind, paid[0].orgKind, paid[0].orgId, paid[0].detail.kind], ['doctor', 'doctor', D, 'lab_booking']);
        assert.equal((await refundsOf(b.id)).length, 0, 'nothing returned');
        const rec = await PaymentRecordModel.findById(v.paymentTransactionId).lean() as any;
        assert.deepEqual([rec.status, rec.isProcessed, rec.gatewayFeeMinor], ['paid', true, 1180]);
        const notices = labNotices.filter((n) => n.key === `assisted:lab:${b.id}:booked:customer`);
        assert.equal(notices.length, 1, 'one patient notice');
        assert.ok(notices[0]!.message.includes('Dr Asha Menon booked a lab test'));
        assert.deepEqual(await dwallet(), before, 'the doctor wallet never moves for a card booking');
        const ok = answers.find((a) => a.status === 200 && a.json.data?.context === 'assisted_lab_booking');
        assert.ok(ok, 'an answer carried the booking');
        assert.equal(ok.json.data.entity.lab.name, 'Metro Labs', 'the doctor sees its booker lab view');
        assert.equal(ok.json.data.entity.assisted.funding, undefined);
        assert.ok('linkId' in ok.json.data.entity.holder, 'the doctor\'s names rule');
      }
      // Once paid the patient and the lab see it; the doctor's pay-now is gone; a replay offers no order.
      assert.equal((await expect('X', 'GET', `/api/v1/lab-bookings/${first.id}`, 200)).json.data.paidBy, 'Dr Asha Menon');
      await expect('LAB', 'GET', `${WS}/lab-bookings/${first.id}`, 200);
      const bv = (await expect('D', 'GET', `${ME}/lab-bookings/${first.id}`, 200)).json.data;
      assert.deepEqual(bv.payment, { method: 'razorpay', state: 'captured', payBy: null, paymentTransactionId: first.data.payment.paymentTransactionId });
      assert.equal((await expect('D', 'POST', `${ME}/lab-bookings`, 200, first.body)).json.data.payment, null);
    });

    // ───────────────────────── 4. Scope ─────────────────────────
    await check('scope: another doctor, a pharmacy, the patient and an admin verifying or reconciling the doctor\'s payment get 404; reads of its row 404', async () => {
      const b = await book();
      const v = capture(b.data);
      for (const who of ['D2', 'P', 'X', 'ADMIN']) {
        await expect(who, 'POST', `${PAY}/verify`, 404, v, 'PAYMENT_RECORD_NOT_FOUND');
        await expect(who, 'POST', `${PAY}/reconcile`, 404, { paymentTransactionId: v.paymentTransactionId }, 'PAYMENT_RECORD_NOT_FOUND');
      }
      assert.equal((await stored(b.id)).status, 'pending_payment', 'nobody else applied it');
      await expect('D2', 'GET', `${ME}/lab-bookings/${b.id}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      await expect('D2', 'POST', `${ME}/lab-bookings/${b.id}/cancel`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      await expect('D2', 'GET', `${ME}/lab-bookings/by-key/${b.body.requestKey}`, 200).then((r) => assert.equal(r.json.data.state, 'unknown'));
      await expect('P', 'GET', `${PA}/lab-bookings/${b.id}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      const ok = await expect('D', 'POST', `${PAY}/verify`, 200, v);
      assert.equal(ok.json.data.entity.status, 'confirmed');
    });

    // ───────────────────────── 5. Late and extra captures ─────────────────────────
    await check('late capture after expiry: seat released, nobody told; the capture goes back to the card ONCE (verify, reconcile, sweeps, worker racing)', async () => {
      const s1 = await slot();
      const b = await book('D', {}, s1);
      labNotices.length = 0; assistedNotices.length = 0;
      assert.ok((await expireSweep()).expired >= 1);
      const gone = await stored(b.id);
      assert.deepEqual([gone.status, gone.cancellation.reason, gone.assisted.funding.state], ['cancelled', 'timeout', 'not_paid']);
      assert.equal(await seats(s1), 0, 'seat released');
      assert.equal(noticesOf(b.id), 0, 'nobody told (C7)');
      const v = capture(b.data);
      const calls0 = gateway.refundCalls;
      const r = await expect('D', 'POST', `${PAY}/verify`, 200, v);
      assert.equal(r.json.data.paymentRecord.status, 'refunded');
      assert.match(r.json.message, /the amount is being refunded to the card or UPI/);
      await PaymentRecordModel.collection.updateMany({}, { $unset: { recoveryNextAt: '' } });
      await Promise.all([payments.sweepUnsettledBookingPayments(later(11 * MIN), 1000), call('D', 'POST', `${PAY}/verify`, v),
        call('D', 'POST', `${PAY}/reconcile`, { paymentTransactionId: v.paymentTransactionId }), worker()]);
      await worker();
      const rows = await refundsOf(b.id);
      assert.equal(rows.length, 1, 'one refund row');
      assert.deepEqual([rows[0].cause, rows[0].method, rows[0].state, rows[0].amountMinor, rows[0].bookingKind, rows[0].payerKind, rows[0].payerId],
        ['late_capture', 'razorpay', 'processed', 50000, 'lab_booking', 'doctor', D]);
      assert.equal(gateway.refundCalls - calls0, 1, 'one refund sent');
      assert.equal(refundsFor(v.razorpayPaymentId).length, 1);
      assert.equal((await stored(b.id)).status, 'cancelled', 'never revived');
      const late = await AssistedAuditEventModel.findOne({ bookingId: b.id, action: 'booking.late_capture' }).lean() as any;
      assert.deepEqual([late.actorKind, late.orgKind, late.detail.labBlocked, late.detail.payerBlocked, late.detail.bookingStatus], ['doctor', 'doctor', false, undefined, 'cancelled']);
    });

    await check('a second capture on the same order: 409 DUPLICATE_PAYMENT_REFUNDED, refunded to its card once; the booking stays paid; the doctor\'s own cancel is its own row', async () => {
      const b = await paidBooking();
      const y = secondCapture(b.data);
      const calls0 = gateway.refundCalls;
      await expect('D', 'POST', `${PAY}/verify`, 409, y, 'DUPLICATE_PAYMENT_REFUNDED');
      await expect('D', 'POST', `${PAY}/verify`, 409, y, 'DUPLICATE_PAYMENT_REFUNDED');
      await expect('D', 'POST', `${PAY}/reconcile`, 200, { paymentTransactionId: b.v.paymentTransactionId });
      await sweepAssistedOtherCaptures(new Date(Date.now() + DAY), 1000);
      await worker();
      const rows = await refundsOf(b.id);
      assert.deepEqual(rows.map((r) => [r.cause, r.razorpayPaymentId, r.state, r.amountMinor, r.payerKind]), [['extra_capture', y.razorpayPaymentId, 'processed', 50000, 'doctor']]);
      assert.equal(refundsFor(y.razorpayPaymentId).length, 1);
      assert.equal(refundsFor(b.v.razorpayPaymentId).length, 0, 'the counted capture never');
      assert.equal(gateway.refundCalls - calls0, 1);
      assert.equal((await stored(b.id)).status, 'confirmed');
      const audit = await AssistedAuditEventModel.find({ bookingId: b.id, action: 'booking.extra_capture' }).lean() as any[];
      assert.deepEqual(audit.map((a) => [a.actorKind, a.orgKind, a.orgId]), [['doctor', 'doctor', D]]);
      const r = await expect('D', 'POST', `${ME}/lab-bookings/${b.id}/cancel`, 200, {});
      assert.deepEqual([r.json.data.refund.cause, r.json.data.refund.state, r.json.data.refund.method], ['booker', 'processed', 'card']);
      assert.equal((await refundsOf(b.id)).length, 2);
    });

    // ───────────────────────── 6. Cancel and refund by the way paid ─────────────────────────
    await check('doctor cancel of a card-paid booking: back to the card once (default); the doctor wallet untouched; the patient told; a repeat refunds nothing', async () => {
      const b = await paidBooking();
      const before = await dwallet();
      const calls0 = gateway.refundCalls;
      labNotices.length = 0;
      const r = await expect('D', 'POST', `${ME}/lab-bookings/${b.id}/cancel`, 200, { reason: 'patient left' });
      assert.equal(r.json.data.refundedMinor, 50000);
      assert.deepEqual([r.json.data.refund.method, r.json.data.refund.state, r.json.data.refund.cause, r.json.data.refund.amountMinor], ['card', 'processed', 'booker', 50000]);
      assert.equal(r.json.data.booking.payment.state, 'refunded');
      assert.equal(gateway.refundCalls - calls0, 1);
      assert.equal(refundsFor(b.v.razorpayPaymentId)[0]!.amount, 50000, 'in full (Jansetu bears the fee)');
      assert.deepEqual(await dwallet(), before, 'wallet untouched');
      const after = await stored(b.id);
      assert.deepEqual([after.status, after.paymentStatus, after.assisted.funding.state], ['cancelled', 'refunded', 'refunded']);
      assert.ok(labNotices.some((n) => n.key === `plb:${b.id}:cancelled` && n.userId === X), 'the patient (who knew of it) is told');
      const again = await expect('D', 'POST', `${ME}/lab-bookings/${b.id}/cancel`, 200, {});
      assert.deepEqual([again.json.data.alreadyCancelled, again.json.data.refundedMinor], [true, 0]);
      await worker();
      assert.equal(gateway.refundCalls - calls0, 1, 'still one');
    });

    await check('the doctor\'s wallet choice: refundTo "wallet" credits the doctor wallet once, opens no lot (not withdrawable), sends nothing to the card', async () => {
      const b = await paidBooking();
      const before = await dwallet();
      const calls0 = gateway.refundCalls;
      await expect('D', 'POST', `${ME}/lab-bookings/${b.id}/cancel`, 400, { refundTo: 'cash' });
      const r = await expect('D', 'POST', `${ME}/lab-bookings/${b.id}/cancel`, 200, { refundTo: 'wallet' });
      assert.equal(r.json.data.refundedMinor, 50000);
      assert.deepEqual([r.json.data.refund.method, r.json.data.refund.state], ['wallet', 'processed']);
      const after = await dwallet();
      assert.equal(after.minor - before.minor, 50000);
      assert.equal(after.withdrawable, before.withdrawable, 'card money back in the wallet opens no lot (C3)');
      const credit = await PartnerWalletEntryModel.find({ ownerKind: 'doctor', operationKey: `assisted_card:${b.v.paymentTransactionId}:refund` }).lean() as any[];
      assert.deepEqual(credit.map((c) => [c.kind, c.referenceType, c.amountMinor]), [['refund_credit', 'assisted_lab_booking', 50000]]);
      assert.equal(gateway.refundCalls, calls0, 'nothing sent to the card');
      await expect('D', 'POST', `${ME}/lab-bookings/${b.id}/cancel`, 200, { refundTo: 'wallet' });
      assert.equal((await dwallet()).minor - before.minor, 50000, 'once');
      assert.equal(await PartnerWalletEntryModel.countDocuments({ operationKey: `assisted_lab:${b.id}:refund` }), 0, 'never the wallet-funding refund');
    });

    await check('patient cancel and lab reject: back to the DOCTOR\'s card (never the patient, never the doctor wallet); the doctor is told "card or UPI"', async () => {
      const xTx0 = await WalletTransactionModel.countDocuments({ userId: X });
      const before = await dwallet();
      const b = await paidBooking();
      const calls0 = gateway.refundCalls;
      assistedNotices.length = 0;
      await expect('X', 'POST', `/api/v1/lab-bookings/${b.id}/cancel`, 200, { note: 'not needed' });
      const rows = await refundsOf(b.id);
      assert.deepEqual(rows.map((x) => [x.cause, x.method, x.payerKind, x.payerId, x.state]), [['patient', 'razorpay', 'doctor', D, 'processed']]);
      assert.equal(gateway.refundCalls - calls0, 1);
      const told = assistedNotices.find((n) => n.audience === 'booker' && n.userId === D && n.key.includes(b.id));
      assert.ok(told && /card or UPI/.test(told.message), `the doctor is told: ${JSON.stringify(assistedNotices)}`);
      const c = await paidBooking();
      await expect('LAB', 'POST', `${WS}/lab-bookings/${c.id}/reject`, 200, { reason: 'Machine down' });
      assert.deepEqual((await refundsOf(c.id)).map((x) => [x.cause, x.method, x.payerKind]), [['partner_lab_reject', 'razorpay', 'doctor']]);
      assert.equal(await WalletTransactionModel.countDocuments({ userId: X }), xTx0, 'the patient\'s wallet never moves');
      assert.deepEqual(await dwallet(), before, 'nor the doctor wallet');
    });

    await check('a card booking still waiting may be cancelled at any time: nothing refunded, the seat freed, nobody else told; a capture after it is returned', async () => {
      const s1 = await slot();
      const b = await book('D', {}, s1);
      labNotices.length = 0;
      const r = await expect('D', 'POST', `${ME}/lab-bookings/${b.id}/cancel`, 200, {});
      assert.deepEqual([r.json.data.refundedMinor, r.json.data.refund, r.json.data.booking.payment.state], [0, null, 'not_paid']);
      assert.equal(await seats(s1), 0);
      assert.equal(labNotices.filter((n) => n.key.includes(b.id)).length, 0);
      const v = capture(b.data);
      await expect('D', 'POST', `${PAY}/verify`, 200, v);
      await worker();
      assert.deepEqual((await refundsOf(b.id)).map((x) => [x.cause, x.state]), [['late_capture', 'processed']]);
    });

    // ───────────────────────── 7. DR9: the doctor unverified before its capture ─────────────────────────
    await check('DR9: a capture for a doctor no longer verified is returned to the card (sweep); its own verify and reconcile answer 403; the booking expires', async () => {
      const b = await book('D3', {}, undefined, visitD3);
      const v = capture(b.data);
      const calls0 = gateway.refundCalls;
      await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(D3) }, { $set: { isVerified: false } });
      try {
        await expect('D3', 'POST', `${PAY}/verify`, 403, v, 'SPECIALIST_NOT_VERIFIED');
        await expect('D3', 'POST', `${PAY}/reconcile`, 403, { paymentTransactionId: v.paymentTransactionId }, 'SPECIALIST_NOT_VERIFIED');
        await sweep();
        await worker();
        const rows = await refundsOf(b.id);
        assert.deepEqual(rows.map((x) => [x.cause, x.method, x.state, x.payerKind, x.payerId]), [['late_capture', 'razorpay', 'processed', 'doctor', D3]]);
        assert.equal(gateway.refundCalls - calls0, 1);
        const row = await stored(b.id);
        assert.deepEqual([row.status, row.assisted.funding.state], ['pending_payment', 'pending'], 'never confirmed');
        const late = await AssistedAuditEventModel.findOne({ bookingId: b.id, action: 'booking.late_capture' }).lean() as any;
        assert.deepEqual([late.detail.payerBlocked, late.detail.labBlocked], [true, false]);
        assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: b.id, action: 'booking.paid' }), 0);
        await sweep();
        await expireSweep();
        const gone = await stored(b.id);
        assert.deepEqual([gone.status, gone.assisted.funding.state], ['cancelled', 'not_paid']);
        assert.equal((await refundsOf(b.id)).length, 1, 'returned once');
        // Its wallet top-ups still settle while unverified (DR3): the gate is for booking payments only.
        await expect('D3', 'POST', `${ME}/wallet/topups/${oid()}/check`, 404, undefined, 'PAYMENT_RECORD_NOT_FOUND');
      } finally {
        await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(D3) }, { $set: { isVerified: true } });
      }
    });

    // ───────────────────────── 8. Admin ─────────────────────────
    await check('admin: a doctor card refund Razorpay refuses is queued naming the doctor ("Dr <name>", lab booking); to-wallet with agreement credits the doctor once', async () => {
      const b = await paidBooking();
      gateway.refundMode = 'reject';
      let refundId = '';
      try { refundId = (await expect('D', 'POST', `${ME}/lab-bookings/${b.id}/cancel`, 200, {})).json.data.refund.refundId; }
      finally { gateway.refundMode = 'processed'; }
      const q = (await expect('ADMIN', 'GET', `${ADM}/assisted/card-refunds?state=failed`, 200)).json.data.find((x: any) => x.refundId === refundId);
      assert.deepEqual([q.bookingKind, q.bookingId, q.state, q.payerKind, q.payerId, q.payerName], ['lab_booking', b.id, 'failed', 'doctor', D, 'Dr Asha Menon']);
      assert.equal(q.pharmacyId, undefined, 'no pharmacy fields on a doctor row');
      const one = (await expect('ADMIN', 'GET', `${ADM}/assisted/card-refunds/${refundId}`, 200)).json.data;
      assert.equal(one.payerName, 'Dr Asha Menon');
      const before = await dwallet();
      const w = await expect('ADMIN', 'POST', `${ADM}/assisted/card-refunds/${refundId}/to-wallet`, 200, { agreement: 'agreed by phone' });
      assert.deepEqual([w.json.data.refund.method, w.json.data.refund.state, w.json.data.replayed], ['wallet', 'processed', false]);
      await expect('ADMIN', 'POST', `${ADM}/assisted/card-refunds/${refundId}/to-wallet`, 200, { agreement: 'agreed by phone' });
      const after = await dwallet();
      assert.equal(after.minor - before.minor, 50000, 'once');
      assert.equal(after.withdrawable, before.withdrawable, 'not withdrawable (C3)');
      const audit = await AssistedAuditEventModel.findOne({ bookingId: b.id, action: 'card_refund.to_wallet' }).lean() as any;
      assert.deepEqual([audit.orgKind, audit.orgId], ['doctor', D]);
    });

    await check('admin: a card dispute on a doctor\'s payment is flagged only (C4): recorded once, no wallet money, the booking unchanged; a later cancel refunds nothing', async () => {
      const b = await paidBooking();
      const before = await dwallet();
      const r = await expect('ADMIN', 'POST', `${ADM}/assisted-payments/${b.v.razorpayPaymentId}/chargeback`, 200, { reason: 'bank says lost' });
      assert.deepEqual([r.json.data.recorded, r.json.data.replayed, r.json.data.bookingStatus], [true, false, 'confirmed']);
      const alert = await AssistedAlertModel.findOne({ kind: 'booking_card_chargeback', 'detail.paymentRecordId': b.v.paymentTransactionId }).lean() as any;
      assert.deepEqual([alert.bookerKind, alert.bookerId], ['doctor', D]);
      const stuck = (await expect('ADMIN', 'GET', `${ADM}/assisted/stuck-money`, 200)).json.data;
      const item = stuck.cardChargebacks.find((x: any) => x.paymentRecordId === b.v.paymentTransactionId);
      assert.deepEqual([item.payerKind, item.payerId, item.payerName, item.bookingKind], ['doctor', D, 'Dr Asha Menon', 'lab_booking']);
      const calls0 = gateway.refundCalls;
      const c = await expect('D', 'POST', `${ME}/lab-bookings/${b.id}/cancel`, 200, {});
      assert.deepEqual([c.json.data.refund.state, c.json.data.refund.lastError], ['manual_review', 'CHARGEBACK_RECORDED']);
      await worker();
      assert.equal(gateway.refundCalls, calls0, 'nothing sent');
      assert.deepEqual(await dwallet(), before, 'no wallet money moved');
    });

    // ───────────────────────── 9. Switches off: only new bookings stop ─────────────────────────
    await check('switches off: new doctor card bookings stop; verify, reads, cancel and refunds of the waiting one go on', async () => {
      const b = await book();
      const v = capture(b.data);
      for (const k of ['ASSISTED_CARD_PAYMENT_ENABLED', 'ASSISTED_LAB_BOOKING_ENABLED_DOCTOR', 'ASSISTED_BOOKING_ENABLED_DOCTOR']) process.env[k] = 'false';
      try {
        await expect('D', 'POST', `${ME}/lab-bookings`, 503, doctorOrder(await slot()), 'ASSISTED_BOOKING_DISABLED');
        const ok = await expect('D', 'POST', `${PAY}/verify`, 200, v);
        assert.equal(ok.json.data.entity.status, 'confirmed');
        await expect('D', 'GET', `${ME}/lab-bookings/${b.id}`, 200);
        await expect('D', 'GET', `${ME}/lab-bookings/by-key/${b.body.requestKey}`, 200);
        const c = await expect('D', 'POST', `${ME}/lab-bookings/${b.id}/cancel`, 200, {});
        assert.deepEqual([c.json.data.refund.method, c.json.data.refund.state], ['card', 'processed']);
      } finally { flagsOn(); }
    });

    // ───────────────────────── 10. Pharmacy and lab card, and the doctor wallet path, unchanged ─────────────────────────
    await check('unchanged: the pharmacy\'s card lab booking (record, notes, verify answer, refund row); the payer table keeps the pharmacy and lab fields byte-identical', async () => {
      const body = { requestKey: newKey(), phone: '9600000901', patient: { relation: 'self', name: 'Rina D' }, consent, preferredLanguage: 'en', partnerId: L, branchId: A,
        visitMode: 'lab', slotId: await slot(), itemIds: [cbc], acceptedPriceMinor: 50000, paymentMethod: 'razorpay' };
      const d = (await expect('P', 'POST', `${PA}/lab-bookings`, 201, body)).json.data;
      const rec = await PaymentRecordModel.findById(d.payment.paymentTransactionId).lean() as any;
      assert.deepEqual([rec.userId, rec.payerUserId, rec.payerPharmacyId, rec.payerSpecialistId, rec.payerPartnerId], [P, P, P, undefined, undefined]);
      assert.deepEqual(Object.keys(rec.notes), ['flow', 'pharmacyId', 'bookingId']);
      const v = capture(d);
      const ok = (await expect('P', 'POST', `${PAY}/verify`, 200, v)).json.data;
      assert.equal(ok.entity.status, 'confirmed');
      assert.ok('pharmacyCustomerId' in ok.entity.holder, 'the pharmacy\'s booker lab view');
      const paid = await AssistedAuditEventModel.findOne({ bookingId: d.booking._id, action: 'booking.paid' }).lean() as any;
      assert.deepEqual([paid.actorKind, paid.orgKind], ['pharmacy', 'pharmacy']);
      const c = await expect('P', 'POST', `${PA}/lab-bookings/${d.booking._id}/cancel`, 200, {});
      assert.equal(c.json.data.refund.method, 'card');
      assert.deepEqual((await refundsOf(d.booking._id)).map((x) => [x.payerKind, x.payerId]), [['pharmacy', P]]);
      // The one payer table: pharmacy and lab exactly as 1b / 2e wrote them.
      assert.deepEqual(recordPayerFieldsOf('pharmacy', 'AbC', 'actor'), { fields: { payerPharmacyId: 'AbC' }, notes: { pharmacyId: 'AbC' } });
      assert.deepEqual(recordPayerFieldsOf('lab', 'LAB1', 'MEM1'), { fields: { payerPartnerId: 'lab1', payerMemberId: 'mem1' }, notes: { partnerId: 'LAB1' } });
      assert.deepEqual(recordPayerFieldsOf('doctor', 'DOC1', 'DOC1'), { fields: { payerSpecialistId: 'doc1' }, notes: { specialistId: 'DOC1' } });
      assert.deepEqual(recordPayerOf({ payerPharmacyId: 'P1' }), { kind: 'pharmacy', id: 'p1' });
      assert.deepEqual(recordPayerOf({ payerPartnerId: 'L1', payerPharmacyId: undefined }), { kind: 'lab', id: 'l1' });
      assert.deepEqual(recordPayerOf({ payerSpecialistId: 'D1' }), { kind: 'doctor', id: 'd1' });
      assert.deepEqual(bookerAuditFields('pharmacy', 'A', 'P'), { actorKind: 'pharmacy', actorId: 'a', orgKind: 'pharmacy', orgId: 'p' });
      assert.deepEqual(bookerAuditFields('lab', 'M', 'L'), { actorKind: 'member', actorId: 'm', orgKind: 'lab', orgId: 'l' });
      assert.deepEqual(bookerAuditFields('doctor', 'D', 'D'), { actorKind: 'doctor', actorId: 'd', orgKind: 'doctor', orgId: 'd' });
    });

    await check('unchanged: the doctor wallet path (3b) — one debit, confirmed at once, refund to the doctor wallet; its view now says how it was paid', async () => {
      const before = await dwallet();
      const d = (await expect('D', 'POST', `${ME}/lab-bookings`, 201, doctorOrder(await slot(), { paymentMethod: 'wallet' }))).json.data;
      assert.deepEqual([d.booking.status, d.funding.method, d.funding.state], ['confirmed', 'wallet', 'captured']);
      assert.equal(d.payment, undefined, 'a wallet receipt has no order');
      assert.deepEqual(d.booking.payment, { method: 'wallet', state: 'captured', payBy: null });
      assert.equal((await dwallet()).minor, before.minor - 50000);
      assert.equal(await PartnerWalletEntryModel.countDocuments({ operationKey: `assisted_lab:${d.booking._id}:debit` }), 1);
      assert.equal(await PaymentRecordModel.countDocuments({ contextId: d.booking._id }), 0, 'no payment record');
      await expect('D', 'POST', `${ME}/lab-bookings/${d.booking._id}/cancel`, 200, { refundTo: 'card' });
      assert.equal((await dwallet()).minor, before.minor, 'refundTo is ignored for a wallet booking: back to the wallet');
      assert.equal(await PartnerWalletEntryModel.countDocuments({ operationKey: `assisted_lab:${d.booking._id}:refund` }), 1);
    });

    await check('reconciliation stays clean on doctor rows (card rows are not wallet-checked; wallet rows reconcile)', async () => {
      const r = await runReconciliation(new Date(), { full: true });
      assert.deepEqual(r.checks.mismatches.filter((m: any) => m.check.startsWith('lab_')), [], JSON.stringify(r.checks.mismatches).slice(0, 400));
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
