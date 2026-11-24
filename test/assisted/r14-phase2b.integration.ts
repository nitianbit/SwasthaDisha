/**
 * Assisted booking round 2b (ASSISTED_BOOKING_DESIGN.md §24.5, §24.14): a pharmacy pays a partner-lab booking by card/UPI
 * (Razorpay, one order per booking) through the phase 1b card machinery generalised by booking kind. Checked over HTTP
 * with the real routes (configureRoutes) on MongoDB, a stand-in Razorpay and a stand-in refund gateway:
 *  1. switches, gateway and amount gates (refused before anything is held or opened, the same answer for every number);
 *  2. the card refund rows' unique index (503 INDEXES_OUTDATED);
 *  3. create: `pending_payment` row holding its seat, one Razorpay order on a record the pharmacy owns, no wallet money;
 *     replay and by-key; the patient and the lab do not see it;
 *  4. verify / reconcile / recovery sweep / expiry sweep racing on one capture: confirmed exactly once, one patient notice;
 *  5. late capture after expiry: seat released, coupon reversed, nobody told; the capture goes back to the card ONCE;
 *  6. expiry racing the capture: confirmed or expired-and-returned, never both;
 *  7. an extra capture on the order refunded once;
 *  8. cancel by the way paid: to the card (booker, patient, lab), the booker's wallet choice, cancel before payment;
 *  9. a card dispute: flag only (C4);
 * 10. scope: another pharmacy and the patient get the uniform 404;
 * 11. S5 for labs: a capture after the lab was unverified is returned;
 * 12. customer lab bookings and their payment path unchanged;
 * 13. consultation card payments unchanged beside lab ones (their rows carry their kind);
 * 14. stuck money and the admin queue name the lab rows; reconciliation stays clean; no PII in the audit;
 * 15. r14b: a stale copy of a booking no longer waiting (expired, cancelled) never answers with a payable order.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r14_phase2b_check?directConnection=true' npx tsx test/assisted/r14-phase2b.integration.ts
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
import SlotModel from '@/modules/slots/model';
import SpecialistModel from '@/modules/specialists/model';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { CouponModel } from '@/modules/coupon/model';
import { CouponRedemptionModel } from '@/modules/coupon/model/redemption';
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { postPharmacyMovementIn } from '@/modules/pharmacyWallet/ledger';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import PartnerModel from '@/modules/partners/model';
import { PartnerSlotModel } from '@/modules/partners/model/slot';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { PartnerService, type PartnerActor } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { resetIndexChecks } from '@/modules/common/utils/requiredIndex';
import { AssistedAlertModel, AssistedAuditEventModel, AssistedCardRefundModel, AssistedCounterModel } from '@/modules/assisted/model';
import { setAssistedEffects, setAssistedNotifier } from '@/modules/assisted/support';
import { runCardRefundsDue, setAssistedRefundGateway } from '@/modules/assisted/cardRefunds';
import { openCardOrder, openCardOrderOf, sweepAssistedOtherCaptures } from '@/modules/assisted/cardPayments';
import type { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r14_phase2b_check?directConnection=true';
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
  failOrders: false,
};
const fakeRazorpay = {
  orders: {
    create: async (o: { amount: number; currency: string; receipt: string }) => {
      if (gateway.failOrders) throw Object.assign(new Error('gateway down'), { error: { description: 'gateway down' } });
      const id = 'order_r14_' + oid();
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
let phoneSeq = 7140000000;
const nextPhone = () => String(phoneSeq++);
let keySeq = 0;
const newKey = () => `r14-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;

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
  process.env.ASSISTED_LIMIT_BOOKINGS_PER_PHONE_PER_DAY = '1000';
  const flagsOn = () => {
    process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
    process.env.ASSISTED_LAB_BOOKING_ENABLED_PHARMACY = 'true';
    process.env.ASSISTED_CARD_PAYMENT_ENABLED = 'true';
    process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';
  };
  flagsOn();

  try {
    // ── A verified lab with a branch, a staff member and two tests ──
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

    // ── Pharmacies, the patient, a doctor (for the consultation check) ──
    const P = oid(); const Q = oid(); const X = oid(); const ADMIN = oid(); const D = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700000401', city: 'Shillong', pincode: '793001', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(Q), name: 'Other Pharmacy', phone: '9700000402', city: 'Shillong', pincode: '793001', isActive: true, isVerified: true },
    ] as never);
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(X), userType: 'user', phone: '9600000401', name: 'Rina Kumari Das', createdSource: 'self_signup',
      otpVerified: true } as never);
    await WalletModel.create({ userId: X, balance: 0, isActive: true });
    await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(D), name: 'Dr Asha Menon', specialization: 'General Physician', languages: ['English'],
      city: 'Shillong', pincode: '793001', consultationFee: 500, isActive: true, isVerified: true } as never);
    await runLedgerTransaction((s) => postPharmacyMovementIn({ pharmacyId: P, kind: 'credit', amountPaise: 1_000_000, operationKey: `seed:${oid()}`,
      referenceType: 'admin_topup', referenceId: oid(), description: 'seed' }, s));
    const walletOf = async (pharmacyId: string) => {
      const w = await PharmacyWalletModel.findOne({ pharmacyId }).lean() as any;
      return { paise: Number(w?.balancePaise ?? 0), withdrawable: Number(w?.withdrawableMinor ?? 0) };
    };

    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const tokens: Record<string, string> = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), Q: sign({ _id: Q, pharmacyId: Q, userType: 'pharmacy' }),
      X: sign({ _id: X, userType: 'user', authVersion: 0 }), ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
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
    const PA = '/api/v1/pharmacy-assisted';
    const WS = '/api/v1/partner-workspace';
    const PAY = '/api/v1/payments';
    const order = (slotId: string, extra: Record<string, unknown> = {}) => ({
      requestKey: newKey(), phone: '9600000401', patient: { relation: 'self', name: 'Rina D' }, consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' },
      preferredLanguage: 'en', partnerId: L, branchId: A, visitMode: 'lab', slotId, itemIds: [cbc], acceptedPriceMinor: 50000, paymentMethod: 'razorpay', ...extra,
    });
    const book = async (extra: Record<string, unknown> = {}, slotId?: string) => {
      const body = order(slotId ?? await slot(), extra);
      const r = await expect('P', 'POST', `${PA}/lab-bookings`, 201, body);
      return { body, data: r.json.data, id: String(r.json.data.booking._id) };
    };
    /** The gateway reports a capture on this booking's order; returns what verify needs. */
    const capture = (data: any) => {
      const orderId = data.payment.razorpayOrderId as string;
      const payId = 'pay_r14' + oid().slice(-12);
      gateway.payments[orderId] = [{ id: payId, order_id: orderId, amount: data.payment.amountMinor, currency: 'INR', status: 'captured', fee: 1180 }];
      const signature = crypto.createHmac('sha256', 'secret').update(`${orderId}|${payId}`).digest('hex');
      return { paymentTransactionId: data.payment.paymentTransactionId, razorpayOrderId: orderId, razorpayPaymentId: payId, razorpaySignature: signature };
    };
    /** A second captured payment on the same order (Razorpay accepts several on an "attempted" order). */
    const secondCapture = (data: any) => {
      const orderId = data.payment.razorpayOrderId as string;
      const payId = 'pay_r14x' + oid().slice(-12);
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
    const paidBooking = async (extra: Record<string, unknown> = {}) => {
      const b = await book(extra);
      const v = capture(b.data);
      await expect('P', 'POST', `${PAY}/verify`, 200, v);
      assert.equal((await stored(b.id)).status, 'confirmed');
      return { ...b, v };
    };

    // ───────────────────────── 1. Gates ─────────────────────────
    await check('gates: card switch off, lab switch off, no gateway keys, nothing to pay — refused before any account, seat, row or order (same answer for every number)', async () => {
      const users0 = await UserModel.countDocuments({});
      const orders0 = gateway.orders.length;
      const s1 = await slot();
      process.env.ASSISTED_CARD_PAYMENT_ENABLED = 'false';
      try {
        for (const phone of ['9600000401', '9600000499']) await expect('P', 'POST', `${PA}/lab-bookings`, 400, order(s1, { phone }), 'PAYMENT_METHOD_UNAVAILABLE');
        // Reads, by-key and the wallet method keep working with the card switch off.
        await expect('P', 'GET', `${PA}/lab-bookings`, 200);
      } finally { flagsOn(); }
      delete process.env.ASSISTED_LAB_BOOKING_ENABLED_PHARMACY;
      try {
        await expect('P', 'POST', `${PA}/lab-bookings`, 503, order(s1), 'ASSISTED_BOOKING_DISABLED');
      } finally { flagsOn(); }
      const creds = credentials;
      credentials = () => { throw new Error('not configured'); };
      try {
        for (const phone of ['9600000401', '9600000499']) await expect('P', 'POST', `${PA}/lab-bookings`, 503, order(s1, { phone }), 'RAZORPAY_NOT_CONFIGURED');
      } finally { credentials = creds; }
      await CouponModel.create({ code: 'LABFREE', discountType: 'fixed', discountValue: 500, applicableTo: 'all', eligibleFor: 'all', startDate: '20200101',
        endDate: '20991231', currentUsageCount: 0, totalUsageLimit: 100, isActive: true } as never);
      for (const phone of ['9600000401', '9600000499']) {
        await expect('P', 'POST', `${PA}/lab-bookings`, 400, order(s1, { phone, couponCode: 'LABFREE', acceptedPriceMinor: 0 }), 'NOTHING_TO_PAY');
      }
      assert.equal(await UserModel.countDocuments({}), users0, 'no account opened');
      assert.equal(await PartnerLabBookingModel.countDocuments({}), 0, 'nothing held');
      assert.equal(await seats(s1), 0);
      assert.equal(gateway.orders.length, orders0, 'no order');
    });

    await check('index 503: without the unique captureKey index of card refund rows a card create answers 503 INDEXES_OUTDATED; nothing is written', async () => {
      const col = mongoose.connection.collection('assisted_card_refunds');
      await col.dropIndex('captureKey_1');
      resetIndexChecks();
      const s1 = await slot();
      try {
        await expect('P', 'POST', `${PA}/lab-bookings`, 503, order(s1), 'INDEXES_OUTDATED');
      } finally {
        await col.createIndex({ captureKey: 1 }, { unique: true, partialFilterExpression: { captureKey: { $type: 'string' } } });
        resetIndexChecks();
      }
      assert.equal(await PartnerLabBookingModel.countDocuments({}), 0);
      assert.equal(await seats(s1), 0);
    });

    // ───────────────────────── 2. Create, replay, by-key ─────────────────────────
    let first: Awaited<ReturnType<typeof book>>;
    let firstSlot = '';
    await check('create: pending_payment row holds its seat; ONE Razorpay order (receipt "al") on a record the pharmacy owns; no wallet money; nobody told', async () => {
      const before = await walletOf(P);
      firstSlot = await slot();
      labNotices.length = 0; assistedNotices.length = 0;
      first = await book({}, firstSlot);
      const d = first.data;
      assert.equal(d.replayed, false);
      assert.equal(d.booking.status, 'pending_payment');
      assert.deepEqual([d.funding.method, d.funding.state, d.funding.amountMinor, d.funding.walletEntryId], ['razorpay', 'pending', 50000, null]);
      assert.equal(d.funding.paymentTransactionId, d.payment.paymentTransactionId);
      assert.deepEqual([d.payment.paymentRequired, d.payment.amountMinor, d.payment.amount, d.payment.currency, d.payment.razorpayKeyId],
        [true, 50000, 500, 'INR', 'rzp_test_key']);
      assert.match(d.payment.razorpayOrderId, /^order_r14_/);
      const row = await stored(first.id);
      assert.deepEqual([row.status, row.paymentStatus, row.statusVersion], ['pending_payment', 'pending', 0]);
      assert.equal(d.payment.payBy, new Date(row.paymentDeadline).toISOString());
      assert.ok(Math.abs(new Date(row.paymentDeadline).getTime() - (new Date(row.createdAt).getTime() + 30 * MIN)) < 5000, '30-minute pay-by');
      assert.equal(row.lifecycle?.confirmedAt, undefined);
      assert.equal(row.assisted.funding.paymentRecordId, d.payment.paymentTransactionId);
      assert.equal(await seats(firstSlot), 1, 'the seat is held');
      const rec = await PaymentRecordModel.findById(d.payment.paymentTransactionId).lean() as any;
      assert.deepEqual([rec.context, rec.contextId, String(rec.payerPharmacyId), String(rec.userId), rec.status, rec.couponCode],
        ['assisted_lab_booking', first.id, P, P, 'created', undefined]);
      assert.match(gateway.orders.find((o) => o.id === d.payment.razorpayOrderId)!.receipt, /^ewa_al_/);
      assert.deepEqual(await walletOf(P), before, 'no wallet movement');
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ operationKey: `assisted_lab:${first.id}:debit` }), 0);
      assert.equal(labNotices.length + assistedNotices.length, 0, 'the patient hears of it once it is paid');
      const audit = await AssistedAuditEventModel.findOne({ bookingId: first.id, action: 'booking.created' }).lean() as any;
      assert.deepEqual([audit.detail.kind, audit.detail.method], ['lab_booking', 'razorpay']);
    });

    await check('replay by key: same request → 200 with the SAME order (also as "wallet"); by-key shows it; other content → 409; the booker view carries pay-now', async () => {
      const orders0 = gateway.orders.length;
      const again = await expect('P', 'POST', `${PA}/lab-bookings`, 200, first.body);
      assert.equal(again.json.data.replayed, true);
      assert.equal(again.json.data.payment.razorpayOrderId, first.data.payment.razorpayOrderId);
      const asWallet = await expect('P', 'POST', `${PA}/lab-bookings`, 200, { ...first.body, paymentMethod: 'wallet' });
      assert.equal(asWallet.json.data.funding.method, 'razorpay', 'the method is not part of the request hash');
      const byKey = await expect('P', 'GET', `${PA}/lab-bookings/by-key/${first.body.requestKey}`, 200);
      assert.equal(byKey.json.data.state, 'used');
      assert.equal(byKey.json.data.payment.razorpayOrderId, first.data.payment.razorpayOrderId);
      await expect('P', 'POST', `${PA}/lab-bookings`, 409, { ...first.body, notes: 'other' }, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(gateway.orders.length, orders0, 'no second order');
      assert.equal(await PaymentRecordModel.countDocuments({ contextId: first.id }), 1);
      const v = (await expect('P', 'GET', `${PA}/lab-bookings/${first.id}`, 200)).json.data;
      assert.equal(v.status, 'pending_payment');
      assert.deepEqual(v.payment, { method: 'razorpay', state: 'pending', payBy: first.data.payment.payBy, paymentTransactionId: first.data.payment.paymentTransactionId,
        razorpayOrderId: first.data.payment.razorpayOrderId, razorpayKeyId: 'rzp_test_key', amountMinor: 50000, currency: 'INR' });
      assert.equal(v.assisted.funding, undefined, 'never the funding block');
      const waiting = (await expect('P', 'GET', `${PA}/lab-bookings?status=pending_payment`, 200)).json.data;
      assert.ok(waiting.some((x: any) => x._id === first.id));
    });

    await check('a failed order call keeps the seat; the same request makes the order once (the receipt and its booking view show it)', async () => {
      const s1 = await slot();
      const body = order(s1);
      gateway.failOrders = true;
      try { await expect('P', 'POST', `${PA}/lab-bookings`, 502, body, 'RAZORPAY_ORDER_CREATION_FAILED'); } finally { gateway.failOrders = false; }
      const row = await PartnerLabBookingModel.findOne({ 'assisted.requestKey': { $regex: body.requestKey + '$' } }).lean() as any;
      assert.equal(row.status, 'pending_payment');
      assert.equal(await seats(s1), 1, 'held');
      const byKey = (await expect('P', 'GET', `${PA}/lab-bookings/by-key/${body.requestKey}`, 200)).json.data;
      assert.deepEqual([byKey.payment, byKey.booking.payment.razorpayOrderId, byKey.booking.payment.amountMinor, byKey.booking.payment.currency],
        [null, null, null, null], 'no order yet');
      const r = (await expect('P', 'POST', `${PA}/lab-bookings`, 200, body)).json.data;
      assert.match(r.payment.razorpayOrderId, /^order_r14_/);
      assert.equal(r.booking.payment.razorpayOrderId, r.payment.razorpayOrderId);
      assert.equal(await PaymentRecordModel.countDocuments({ contextId: String(row._id) }), 1);
      await expect('P', 'POST', `${PA}/lab-bookings/${String(row._id)}/cancel`, 200, {});
      assert.equal(await seats(s1), 0);
    });

    await check('unpaid card rows are the booker\'s alone: the patient and the lab neither list nor read nor act on them (uniform 404)', async () => {
      const id = first.id;
      assert.ok(!(await expect('X', 'GET', '/api/v1/lab-bookings', 200)).json.data.some((x: any) => x._id === id));
      await expect('X', 'GET', `/api/v1/lab-bookings/${id}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      await expect('X', 'POST', `/api/v1/lab-bookings/${id}/cancel`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      await expect('X', 'POST', `/api/v1/lab-bookings/${id}/pay`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      await expect('X', 'POST', `/api/v1/lab-bookings/${id}/not-mine`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      assert.ok(!(await expect('LAB', 'GET', `${WS}/lab-bookings?branchId=${A}`, 200)).json.data.some((x: any) => x._id === id));
      await expect('LAB', 'GET', `${WS}/lab-bookings/${id}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/reject`, 404, { reason: 'not today' }, 'LAB_BOOKING_NOT_FOUND');
      await expect('LAB', 'POST', `${WS}/lab-bookings/${id}/visit`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      // The patient cannot verify or reconcile the pharmacy's payment either.
      await expect('X', 'POST', `${PAY}/reconcile`, 404, { paymentTransactionId: first.data.payment.paymentTransactionId }, 'PAYMENT_RECORD_NOT_FOUND');
      assert.equal((await stored(id)).status, 'pending_payment');
    });

    // ───────────────────────── 3. Verify / reconcile / sweeps racing ─────────────────────────
    await check('verify ×2, reconcile, recovery sweep and expiry sweep racing on one capture: confirmed exactly once, one patient notice (3 runs)', async () => {
      for (let i = 0; i < 3; i++) {
        const b = i === 0 ? first : await book();
        const v = capture(b.data);
        labNotices.length = 0;
        await PaymentRecordModel.collection.updateMany({}, { $unset: { recoveryNextAt: '' } });
        const results = await Promise.allSettled([
          call('P', 'POST', `${PAY}/verify`, v), call('P', 'POST', `${PAY}/reconcile`, { paymentTransactionId: v.paymentTransactionId }),
          payments.sweepUnsettledBookingPayments(later(11 * MIN), 1000), expireSweep(), call('P', 'POST', `${PAY}/verify`, v),
        ]);
        const answers = [results[0], results[1], results[4]].map((r) => (r as PromiseFulfilledResult<any>).value);
        for (const a of answers) assert.ok([200, 409].includes(a.status), `answer ${a.status} ${a.text.slice(0, 200)}`);
        // Anything left half-done is finished by the next sweep.
        await sweep();
        const after = await stored(b.id);
        assert.deepEqual([after.status, after.paymentStatus, after.assisted.funding.state, after.statusVersion], ['confirmed', 'paid', 'captured', 1]);
        assert.equal(after.paymentTransactionId, v.paymentTransactionId);
        assert.equal(after.assisted.funding.razorpayPaymentId, v.razorpayPaymentId);
        assert.ok(after.lifecycle.paidAt && after.lifecycle.confirmedAt);
        assert.equal(after.postPaymentCompletedFor, v.paymentTransactionId, 'follow-up done');
        assert.equal(after.assisted.followUpLeaseUntil, undefined, 'lease released');
        assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: b.id, action: 'booking.paid' }), 1, 'one confirmation');
        assert.equal((await AssistedAuditEventModel.findOne({ bookingId: b.id, action: 'booking.paid' }).lean() as any).detail.kind, 'lab_booking');
        assert.equal((await refundsOf(b.id)).length, 0, 'nothing returned');
        const rec = await PaymentRecordModel.findById(v.paymentTransactionId).lean() as any;
        assert.deepEqual([rec.status, rec.isProcessed, rec.gatewayFeeMinor], ['paid', true, 1180]);
        assert.deepEqual(labNotices.filter((n) => n.key === `assisted:lab:${b.id}:booked:customer`).length, 1, 'one patient notice');
        assert.ok(labNotices.find((n) => n.key === `assisted:lab:${b.id}:booked:customer`)!.message.includes('Sharma Medicals booked a lab test'));
        const ok = answers.find((a) => a.status === 200 && a.json.data?.context === 'assisted_lab_booking');
        assert.ok(ok, 'an answer carried the booking');
        assert.equal(ok.json.data.entity.assisted.funding, undefined, 'the pharmacy sees the booker lab view');
        assert.equal(ok.json.data.entity.lab.name, 'Metro Labs');
      }
      // Replays after the fact change nothing.
      const rec = await PaymentRecordModel.findById(first.data.payment.paymentTransactionId).lean() as any;
      const sig = crypto.createHmac('sha256', 'secret').update(`${rec.razorpayOrderId}|${rec.razorpayPaymentId}`).digest('hex');
      const again = await expect('P', 'POST', `${PAY}/verify`, 200, { paymentTransactionId: String(rec._id), razorpayOrderId: rec.razorpayOrderId,
        razorpayPaymentId: rec.razorpayPaymentId, razorpaySignature: sig });
      assert.equal(again.json.data.entity.status, 'confirmed');
      assert.deepEqual(again.json.data.entity.payment, { method: 'razorpay', state: 'captured', payBy: null, paymentTransactionId: String(rec._id) });
      assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: first.id, action: 'booking.paid' }), 1);
    });

    await check('once paid, the patient and the lab see it (no price, "paid by"); the booker\'s pay-now is gone', async () => {
      const cv = (await expect('X', 'GET', `/api/v1/lab-bookings/${first.id}`, 200)).json.data;
      assert.equal(cv.paidBy, 'Sharma Medicals');
      assert.equal(cv.pricing, undefined); assert.equal(cv.paymentTransactionId, undefined); assert.equal(cv.assisted.funding, undefined);
      assert.ok(!/"(pricing|priceMinor|mrpMinor|payableMinor|amountMinor|amount|price)"/.test(JSON.stringify(cv)), `no amount anywhere: ${JSON.stringify(cv)}`);
      assert.ok((await expect('X', 'GET', '/api/v1/lab-bookings', 200)).json.data.some((x: any) => x._id === first.id));
      const lv = (await expect('LAB', 'GET', `${WS}/lab-bookings/${first.id}`, 200)).json.data;
      assert.equal(lv.assisted.funding, undefined);
      assert.equal(lv.identityNote, 'Identity attested by the partner, not verified');
      assert.ok((await expect('LAB', 'GET', `${WS}/lab-bookings?branchId=${A}`, 200)).json.data.some((x: any) => x._id === first.id));
      await expect('X', 'POST', `/api/v1/lab-bookings/${first.id}/pay`, 409, {}, 'PARTNER_PAID_BOOKING');
      const bv = (await expect('P', 'GET', `${PA}/lab-bookings/${first.id}`, 200)).json.data;
      assert.equal(bv.payment.razorpayOrderId, undefined);
      assert.equal((await expect('P', 'POST', `${PA}/lab-bookings`, 200, first.body)).json.data.payment, null, 'a replay offers no order once paid');
    });

    // ───────────────────────── 4. Late capture after expiry ─────────────────────────
    await check('late capture after expiry: seat released, coupon reversed, nobody told, no cancellation counted; the capture goes back to the card ONCE', async () => {
      await CouponModel.create({ code: 'LABCARD', discountType: 'fixed', discountValue: 101, applicableTo: 'all', eligibleFor: 'all', startDate: '20200101',
        endDate: '20991231', currentUsageCount: 0, totalUsageLimit: 100, isActive: true } as never);
      const s1 = await slot();
      const b = await book({ couponCode: 'LABCARD', acceptedPriceMinor: 39900 }, s1);
      assert.equal((await CouponModel.findOne({ code: 'LABCARD' }).lean() as any).currentUsageCount, 1);
      labNotices.length = 0; assistedNotices.length = 0;
      const counters0 = await AssistedCounterModel.countDocuments({ _id: { $regex: '^booker_cancellations:' } });
      const out = await expireSweep();
      assert.ok(out.expired >= 1);
      const gone = await stored(b.id);
      assert.deepEqual([gone.status, gone.cancellation.reason, gone.assisted.funding.state], ['cancelled', 'timeout', 'not_paid']);
      assert.equal(await seats(s1), 0, 'seat released');
      assert.equal((await CouponRedemptionModel.findOne({ bookingKind: 'lab_booking', bookingId: b.id }).lean() as any).state, 'reversed');
      assert.equal((await CouponModel.findOne({ code: 'LABCARD' }).lean() as any).currentUsageCount, 0);
      assert.equal(labNotices.filter((n) => n.key.includes(b.id)).length + assistedNotices.filter((n) => n.key.includes(b.id)).length, 0, 'nobody told (C7)');
      assert.equal(await AssistedCounterModel.countDocuments({ _id: { $regex: '^booker_cancellations:' } }), counters0, 'owner: no cancellation count');
      // The partner paid after all.
      const v = capture(b.data);
      const calls0 = gateway.refundCalls;
      const r = await expect('P', 'POST', `${PAY}/verify`, 200, v);
      assert.equal(r.json.data.paymentRecord.status, 'refunded');
      assert.match(r.json.message, /lab is not available\); the amount is being refunded to the card or UPI/);
      await PaymentRecordModel.collection.updateMany({}, { $unset: { recoveryNextAt: '' } });
      await Promise.all([payments.sweepUnsettledBookingPayments(later(11 * MIN), 1000), call('P', 'POST', `${PAY}/verify`, v),
        call('P', 'POST', `${PAY}/reconcile`, { paymentTransactionId: v.paymentTransactionId }), worker()]);
      await worker();
      const rows = await refundsOf(b.id);
      assert.equal(rows.length, 1, 'one refund row');
      assert.deepEqual([rows[0].cause, rows[0].method, rows[0].state, rows[0].amountMinor, rows[0].bookingKind], ['late_capture', 'razorpay', 'processed', 39900, 'lab_booking']);
      assert.equal(gateway.refundCalls - calls0, 1, 'one refund sent');
      assert.equal(refundsFor(v.razorpayPaymentId).length, 1);
      const after = await stored(b.id);
      assert.equal(after.status, 'cancelled', 'never revived');
      assert.deepEqual(after.assisted.funding.refunds.map((x: any) => [x.cause, x.method, x.state]), [['late_capture', 'razorpay', 'processed']], 'the row is mirrored on the booking');
      assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: b.id, action: 'booking.paid' }), 0);
      const late = await AssistedAuditEventModel.findOne({ bookingId: b.id, action: 'booking.late_capture' }).lean() as any;
      assert.deepEqual([late.detail.kind, late.detail.labBlocked, late.detail.bookingStatus], ['lab_booking', false, 'cancelled']);
    });

    await check('expiry racing the capture (4 runs): either confirmed with no refund, or expired with exactly one card refund — never both', async () => {
      for (let i = 0; i < 4; i++) {
        const b = await book();
        const v = capture(b.data);
        const calls0 = gateway.refundCalls;
        await Promise.allSettled([labSvc.expireUnpaid(b.id, later(31 * MIN)), call('P', 'POST', `${PAY}/verify`, v)]);
        await sweep();
        await worker();
        const after = await stored(b.id);
        const rows = await refundsOf(b.id);
        if (after.status === 'confirmed') {
          assert.equal(rows.length, 0);
          assert.equal(gateway.refundCalls - calls0, 0);
          assert.equal(after.assisted.funding.state, 'captured');
        } else {
          assert.equal(after.status, 'cancelled');
          assert.equal(after.assisted.funding.state, 'not_paid');
          assert.deepEqual(rows.map((r) => r.cause), ['late_capture']);
          assert.equal(gateway.refundCalls - calls0, 1);
        }
        assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: b.id, action: 'booking.paid' }), after.status === 'confirmed' ? 1 : 0);
      }
    });

    // ───────────────────────── 5. Extra captures ─────────────────────────
    await check('a second capture on the same order: 409 DUPLICATE_PAYMENT_REFUNDED, refunded to its card once (verify, reconcile, both sweeps); the booking stays paid', async () => {
      const b = await paidBooking();
      const y = secondCapture(b.data);
      const calls0 = gateway.refundCalls;
      await expect('P', 'POST', `${PAY}/verify`, 409, y, 'DUPLICATE_PAYMENT_REFUNDED');
      await expect('P', 'POST', `${PAY}/verify`, 409, y, 'DUPLICATE_PAYMENT_REFUNDED');
      await expect('P', 'POST', `${PAY}/reconcile`, 200, { paymentTransactionId: b.v.paymentTransactionId });
      await sweepAssistedOtherCaptures(new Date(Date.now() + DAY), 1000);
      await worker();
      const rows = await refundsOf(b.id);
      assert.deepEqual(rows.map((r) => [r.cause, r.razorpayPaymentId, r.state, r.amountMinor, r.bookingKind]), [['extra_capture', y.razorpayPaymentId, 'processed', 50000, 'lab_booking']]);
      assert.equal(refundsFor(y.razorpayPaymentId).length, 1);
      assert.equal(refundsFor(b.v.razorpayPaymentId).length, 0, 'the counted capture never');
      assert.equal(gateway.refundCalls - calls0, 1);
      assert.equal((await stored(b.id)).status, 'confirmed');
      const audit = await AssistedAuditEventModel.find({ bookingId: b.id, action: 'booking.extra_capture' }).lean() as any[];
      assert.deepEqual(audit.map((a) => a.detail.kind), ['lab_booking']);
      // The booker's own cancel refund (of the counted capture) is still its own row.
      const r = await expect('P', 'POST', `${PA}/lab-bookings/${b.id}/cancel`, 200, {});
      assert.deepEqual([r.json.data.refund.cause, r.json.data.refund.state, r.json.data.refund.method], ['booker', 'processed', 'card']);
      assert.equal(refundsFor(b.v.razorpayPaymentId).length, 1);
      assert.equal((await refundsOf(b.id)).length, 2);
    });

    // ───────────────────────── 6. Cancel and refund by the way paid ─────────────────────────
    await check('booker cancel of a card-paid lab booking: back to the card once (default); the wallet untouched; the patient told; a repeat refunds nothing', async () => {
      const b = await paidBooking();
      const before = await walletOf(P);
      const calls0 = gateway.refundCalls;
      labNotices.length = 0;
      const r = await expect('P', 'POST', `${PA}/lab-bookings/${b.id}/cancel`, 200, { reason: 'patient left' });
      assert.equal(r.json.data.refundedMinor, 50000);
      assert.deepEqual([r.json.data.refund.method, r.json.data.refund.state, r.json.data.refund.cause, r.json.data.refund.amountMinor], ['card', 'processed', 'booker', 50000]);
      assert.equal(r.json.data.booking.payment.state, 'refunded');
      assert.equal(gateway.refundCalls - calls0, 1);
      assert.equal(refundsFor(b.v.razorpayPaymentId)[0]!.amount, 50000, 'in full (Jansetu bears the fee)');
      assert.deepEqual(await walletOf(P), before, 'wallet untouched');
      assert.equal((await PaymentRecordModel.findById(b.v.paymentTransactionId).lean() as any).status, 'refunded');
      const after = await stored(b.id);
      assert.deepEqual([after.status, after.paymentStatus, after.assisted.funding.state], ['cancelled', 'refunded', 'refunded']);
      assert.deepEqual(after.assisted.funding.refunds.map((x: any) => [x.method, x.state, x.cause]), [['razorpay', 'processed', 'booker']]);
      assert.ok(labNotices.some((n) => n.key === `plb:${b.id}:cancelled` && n.userId === X), 'the patient (who knew of it) is told');
      const again = await expect('P', 'POST', `${PA}/lab-bookings/${b.id}/cancel`, 200, {});
      assert.deepEqual([again.json.data.alreadyCancelled, again.json.data.refundedMinor], [true, 0]);
      await worker();
      assert.equal(gateway.refundCalls - calls0, 1, 'still one');
      assert.equal((await refundsOf(b.id)).length, 1);
    });

    await check('the wallet choice: the booker sends a card-paid lab booking\'s money to its wallet instead (once, not withdrawable, no card refund)', async () => {
      const b = await paidBooking();
      const before = await walletOf(P);
      const calls0 = gateway.refundCalls;
      await expect('P', 'POST', `${PA}/lab-bookings/${b.id}/cancel`, 400, { refundTo: 'cash' });
      const r = await expect('P', 'POST', `${PA}/lab-bookings/${b.id}/cancel`, 200, { refundTo: 'wallet' });
      assert.equal(r.json.data.refundedMinor, 50000);
      assert.deepEqual([r.json.data.refund.method, r.json.data.refund.state], ['wallet', 'processed']);
      const after = await walletOf(P);
      assert.equal(after.paise - before.paise, 50000);
      assert.equal(after.withdrawable, before.withdrawable, 'card money back in the wallet opens no lot (C3)');
      const credit = await PharmacyWalletTransactionModel.find({ operationKey: `assisted_card:${b.v.paymentTransactionId}:refund` }).lean() as any[];
      assert.deepEqual(credit.map((c) => [c.referenceType, c.amountPaise]), [['assisted_lab_booking', 50000]]);
      assert.equal(gateway.refundCalls, calls0, 'nothing sent to the card');
      await expect('P', 'POST', `${PA}/lab-bookings/${b.id}/cancel`, 200, { refundTo: 'wallet' });
      assert.equal((await walletOf(P)).paise - before.paise, 50000, 'once');
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ operationKey: `assisted_lab:${b.id}:refund` }), 0, 'never the wallet-funding refund');
    });

    await check('patient cancel and lab reject of a card-paid lab booking: back to the PARTNER\'s card, never the patient; the booker is told "card or UPI"', async () => {
      const xTx0 = await WalletTransactionModel.countDocuments({ userId: X });
      const b = await paidBooking();
      const calls0 = gateway.refundCalls;
      assistedNotices.length = 0;
      await expect('X', 'POST', `/api/v1/lab-bookings/${b.id}/cancel`, 200, { note: 'not needed' });
      assert.deepEqual((await refundsOf(b.id)).map((x) => [x.cause, x.method, x.state]), [['patient', 'razorpay', 'processed']]);
      assert.equal(gateway.refundCalls - calls0, 1);
      assert.ok(assistedNotices.some((n) => n.key === `assisted:lab:${b.id}:cancelled:booker` && /card or UPI/.test(n.message)));
      const c = await paidBooking();
      await expect('LAB', 'POST', `${WS}/lab-bookings/${c.id}/reject`, 200, { reason: 'Machine down' });
      assert.deepEqual((await refundsOf(c.id)).map((x) => [x.cause, x.method, x.state]), [['partner_lab_reject', 'razorpay', 'processed']]);
      assert.ok(assistedNotices.some((n) => n.key === `assisted:lab:${c.id}:cancelled:booker` && /card or UPI/.test(n.message)));
      assert.equal(await WalletTransactionModel.countDocuments({ userId: X }), xTx0, 'nothing to the patient\'s wallet');
    });

    await check('cancel before the payment: at any time, nothing refunded, the seat back, nobody told; a capture landing later goes back to the card once', async () => {
      const s1 = await slot();
      const b = await book({}, s1);
      labNotices.length = 0; assistedNotices.length = 0;
      const r = await expect('P', 'POST', `${PA}/lab-bookings/${b.id}/cancel`, 200, {});
      assert.deepEqual([r.json.data.refundedMinor, r.json.data.refund, r.json.data.alreadyCancelled], [0, null, false]);
      assert.equal(labNotices.length + assistedNotices.length, 0, 'the patient never heard of it');
      const row = await stored(b.id);
      assert.deepEqual([row.status, row.assisted.funding.state, row.cancellation.byKind], ['cancelled', 'not_paid', 'booker']);
      assert.equal(await seats(s1), 0);
      const v = capture(b.data);
      const calls0 = gateway.refundCalls;
      await sweep(); await sweep(); await worker();
      assert.deepEqual((await refundsOf(b.id)).map((x) => [x.cause, x.state]), [['late_capture', 'processed']]);
      assert.equal(gateway.refundCalls - calls0, 1);
      assert.equal(refundsFor(v.razorpayPaymentId).length, 1);
    });

    // ───────────────────────── 7. Card dispute: flag only (C4) ─────────────────────────
    await check('a card dispute on a lab booking payment: recorded and flagged only (C4) — no money moves, the booking unchanged, its refund held; reconcile answers PAYMENT_DISPUTED', async () => {
      const b = await paidBooking();
      const before = await walletOf(P);
      const r = await expect('ADMIN', 'POST', `/api/v1/admin/assisted-payments/${b.v.paymentTransactionId}/chargeback`, 200, { reason: 'bank dispute' });
      assert.deepEqual([r.json.data.recorded, r.json.data.replayed, r.json.data.bookingId, r.json.data.bookingStatus, r.json.data.refund],
        [true, false, b.id, 'confirmed', null]);
      const again = await expect('ADMIN', 'POST', `/api/v1/admin/assisted-payments/${b.v.razorpayPaymentId}/chargeback`, 200, { reason: 'again' });
      assert.equal(again.json.data.replayed, true);
      assert.equal(await AssistedAlertModel.countDocuments({ kind: 'booking_card_chargeback', 'detail.bookingId': b.id }), 1);
      assert.equal(await AssistedAuditEventModel.countDocuments({ bookingId: b.id, action: 'booking.card_chargeback' }), 1);
      const row = await stored(b.id);
      assert.deepEqual([row.status, row.assisted.funding.state], ['confirmed', 'captured'], 'the booking is not changed');
      assert.deepEqual(await walletOf(P), before, 'no wallet debit, no freeze');
      assert.equal((await PharmacyWalletModel.findOne({ pharmacyId: P }).lean() as any).frozen ?? false, false);
      // A later cancel refunds nothing more: its row is held for review; to-wallet is refused.
      const calls0 = gateway.refundCalls;
      const c = await expect('P', 'POST', `${PA}/lab-bookings/${b.id}/cancel`, 200, {});
      assert.deepEqual([c.json.data.refund.state, c.json.data.refund.lastError], ['manual_review', 'CHARGEBACK_RECORDED']);
      await worker();
      assert.equal(gateway.refundCalls, calls0);
      // The returned, disputed record is never applied again (dispute wording, not the top-up's).
      const r2 = await expect('P', 'POST', `${PAY}/reconcile`, 409, { paymentTransactionId: b.v.paymentTransactionId }, 'PAYMENT_DISPUTED');
      assert.ok(!/top-up/i.test(r2.json.message));
      await expect('ADMIN', 'POST', `/api/v1/admin/assisted/card-refunds/${c.json.data.refund.refundId}/to-wallet`, 409, { agreement: 'agreed on call' }, 'CHARGEBACK_RECORDED');
      const cb = (await expect('ADMIN', 'GET', '/api/v1/admin/assisted/stuck-money', 200)).json.data.cardChargebacks.find((x: any) => x.paymentRecordId === b.v.paymentTransactionId);
      assert.deepEqual([cb.bookingKind, cb.pharmacyName], ['lab_booking', 'Sharma Medicals']);
    });

    // ───────────────────────── 8. Scope ─────────────────────────
    await check('scope: another pharmacy gets the uniform 404 on the lab booking, its payment (verify, reconcile), its cancel and its key', async () => {
      const b = await book();
      const v = capture(b.data);
      await expect('Q', 'POST', `${PAY}/verify`, 404, v, 'PAYMENT_RECORD_NOT_FOUND');
      await expect('Q', 'POST', `${PAY}/reconcile`, 404, { paymentTransactionId: v.paymentTransactionId }, 'PAYMENT_RECORD_NOT_FOUND');
      await expect('X', 'POST', `${PAY}/verify`, 404, v, 'PAYMENT_RECORD_NOT_FOUND');
      await expect('Q', 'GET', `${PA}/lab-bookings/${b.id}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      await expect('Q', 'POST', `${PA}/lab-bookings/${b.id}/cancel`, 404, {}, 'LAB_BOOKING_NOT_FOUND');
      await expect('Q', 'GET', `${PA}/lab-bookings/${oid()}`, 404, undefined, 'LAB_BOOKING_NOT_FOUND');
      assert.equal((await expect('Q', 'GET', `${PA}/lab-bookings/by-key/${b.body.requestKey}`, 200)).json.data.state, 'unknown');
      assert.ok(!(await expect('Q', 'GET', `${PA}/lab-bookings?status=pending_payment`, 200)).json.data.some((x: any) => x._id === b.id));
      assert.equal((await stored(b.id)).status, 'pending_payment', 'nothing applied by another pharmacy');
      // A pharmacy no longer operational cannot verify its own card payment (403), and the capture is applied later.
      await PharmacyModel.updateOne({ _id: P }, { $set: { isVerified: false } });
      try { await expect('P', 'POST', `${PAY}/verify`, 403, v); } finally { await PharmacyModel.updateOne({ _id: P }, { $set: { isVerified: true } }); }
      await expect('P', 'POST', `${PAY}/verify`, 200, v);
      assert.equal((await stored(b.id)).status, 'confirmed');
    });

    // ───────────────────────── 9. S5 for labs ─────────────────────────
    await check('S5: a capture after the lab stopped being verified is returned to the card; the booking is not confirmed and expires', async () => {
      const b = await book();
      await PartnerModel.updateOne({ _id: L }, { $set: { 'verification.state': 'suspended' } });
      const calls0 = gateway.refundCalls;
      try {
        const v = capture(b.data);
        const r = await expect('P', 'POST', `${PAY}/verify`, 200, v);
        assert.equal(r.json.data.paymentRecord.status, 'refunded');
      } finally { await PartnerModel.updateOne({ _id: L }, { $set: { 'verification.state': 'verified' } }); }
      await worker();
      assert.equal((await stored(b.id)).status, 'pending_payment', 'not confirmed');
      assert.deepEqual((await refundsOf(b.id)).map((x) => [x.cause, x.state]), [['late_capture', 'processed']]);
      assert.equal(gateway.refundCalls - calls0, 1);
      assert.equal((await AssistedAuditEventModel.findOne({ bookingId: b.id, action: 'booking.late_capture' }).lean() as any).detail.labBlocked, true);
      await expireSweep();
      assert.deepEqual([(await stored(b.id)).status, (await stored(b.id)).assisted.funding.state], ['cancelled', 'not_paid']);
      assert.equal((await refundsOf(b.id)).length, 1, 'still one return');
    });

    // ───────────────────────── 10. Customer lab bookings unchanged ─────────────────────────
    await check('customer lab bookings unchanged: the customer pays its own booking (context lab_booking, customer view, confirmation notice); an unpaid one expires with the wallet notice', async () => {
      const s1 = await slot();
      const created = await expect('X', 'POST', '/api/v1/lab-bookings', 201, { partnerId: L, branchId: A, visitMode: 'lab', slotId: s1, itemIds: [cbc],
        patient: { kind: 'self' }, requestKey: newKey(), acceptedPayableMinor: 50000 });
      const d = created.json.data;
      assert.equal(d.paymentRequired, true);
      const rec = await PaymentRecordModel.findById(d.payment.paymentTransactionId).lean() as any;
      assert.deepEqual([rec.context, String(rec.userId), rec.payerPharmacyId], ['lab_booking', X, undefined]);
      const id = String(d.booking._id);
      assert.ok((await expect('X', 'GET', '/api/v1/lab-bookings', 200)).json.data.some((x: any) => x._id === id), 'the customer sees its own unpaid booking');
      assert.ok((await expect('LAB', 'GET', `${WS}/lab-bookings?branchId=${A}`, 200)).json.data.some((x: any) => x._id === id), 'and so does the lab');
      const orderId = d.payment.razorpayOrderId as string;
      const payId = 'pay_r14c' + oid().slice(-12);
      gateway.payments[orderId] = [{ id: payId, order_id: orderId, amount: 50000, currency: 'INR', status: 'captured' }];
      labNotices.length = 0;
      const v = await expect('X', 'POST', `${PAY}/verify`, 200, { paymentTransactionId: d.payment.paymentTransactionId, razorpayOrderId: orderId, razorpayPaymentId: payId,
        razorpaySignature: crypto.createHmac('sha256', 'secret').update(`${orderId}|${payId}`).digest('hex') });
      assert.equal(v.json.data.context, 'lab_booking');
      assert.equal(v.json.data.entity.status, 'confirmed');
      assert.equal(v.json.data.entity.pricing.payableMinor, 50000, 'the customer view keeps its prices');
      assert.ok(labNotices.some((n) => n.key === `plb:${id}:confirmed`));
      assert.equal(await AssistedCardRefundModel.countDocuments({ bookingId: id }), 0);
      // An unpaid customer booking expires exactly as before (the customer is told; the seat comes back).
      const s2 = await slot();
      const unpaid = (await expect('X', 'POST', '/api/v1/lab-bookings', 201, { partnerId: L, branchId: A, visitMode: 'lab', slotId: s2, itemIds: [cbc],
        patient: { kind: 'self' }, requestKey: newKey(), acceptedPayableMinor: 50000 })).json.data;
      const uid = String(unpaid.booking._id);
      await expireSweep();
      const gone = await stored(uid);
      assert.deepEqual([gone.status, gone.cancellation.reason], ['cancelled', 'timeout']);
      assert.ok(labNotices.some((n) => n.key === `plb:${uid}:cancelled` && /back in your wallet/.test(n.message)));
      assert.equal(await seats(s2), 0);
    });

    // ───────────────────────── 11. Consultation card payments beside lab ones ─────────────────────────
    await check('consultation card payments unchanged beside lab ones: own context, own collection; refund rows carry their kind; admin rows name it', async () => {
      const at = new Date(Date.now() + 5 * DAY + 37 * MIN);
      const sd = new Date(at.getTime() + IST).toISOString();
      const se = new Date(at.getTime() + 15 * MIN + IST).toISOString();
      const cslot = await SlotModel.create({ specialistId: D, date: sd.slice(0, 10).replace(/-/g, ''), startTime: sd.slice(11, 16), endTime: se.slice(11, 16), duration: 15,
        maxBookings: 1, currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation' } as never);
      const body = { requestKey: newKey(), phone: '9600000401', patient: { relation: 'self', name: 'Rina D' }, consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' },
        preferredLanguage: 'en', slotId: String(cslot._id), consultationMode: 'video', join: { on: 'partner_device' }, acceptedPriceMinor: 50000, paymentMethod: 'razorpay' };
      const c = (await expect('P', 'POST', `${PA}/consultations`, 201, body)).json.data;
      const cid = String(c.booking._id);
      assert.deepEqual([c.booking.status, c.funding.method, c.funding.state], ['pending', 'razorpay', 'pending']);
      const rec = await PaymentRecordModel.findById(c.payment.paymentTransactionId).lean() as any;
      assert.equal(rec.context, 'assisted_booking');
      assert.match(gateway.orders.find((o) => o.id === c.payment.razorpayOrderId)!.receipt, /^ewa_ab_/);
      const bv = (await expect('P', 'GET', `/api/v1/pharmacy-bookings/${cid}`, 200)).json.data;
      assert.deepEqual([bv.payment.method, bv.payment.state, bv.payment.razorpayOrderId], ['razorpay', 'pending', c.payment.razorpayOrderId]);
      // r14b: the consultation's booker view carries the amount and currency for "Pay now" too (the same shared function).
      assert.deepEqual([bv.payment.amountMinor, bv.payment.currency], [50000, 'INR']);
      const v = capture(c);
      const r = await expect('P', 'POST', `${PAY}/verify`, 200, v);
      assert.equal(r.json.data.context, 'assisted_booking');
      assert.equal(r.json.data.entity.status, 'confirmed');
      const paid = await AssistedAuditEventModel.findOne({ bookingId: cid, action: 'booking.paid' }).lean() as any;
      assert.equal(paid.detail.kind, undefined, 'the consultation audit is as 1b wrote it');
      assert.equal(await PartnerLabBookingModel.countDocuments({ _id: cid }), 0);
      const cancel = await expect('P', 'POST', `${PA}/bookings/${cid}/cancel`, 200, {});
      assert.deepEqual([cancel.json.data.refund.method, cancel.json.data.refund.state], ['card', 'processed']);
      const rows = await refundsOf(cid);
      assert.deepEqual(rows.map((x) => [x.bookingKind, x.cause, x.state]), [['booking', 'booker', 'processed']]);
      const booking = await BookingModel.findById(cid).lean() as any;
      // r14b: a stale copy of the consultation still "waiting" gets no payable order once it is cancelled (1b path too).
      assert.equal(await openCardOrder({ ...booking, status: 'pending', paymentStatus: 'pending', assisted: { ...booking.assisted, funding: { ...booking.assisted.funding, state: 'pending' } } }), null);
      assert.deepEqual(booking.assisted.funding.refunds.map((x: any) => x.state), ['processed'], 'mirrored on the consultation');
      // Admin rows say which kind of booking a refund belongs to.
      const one = (await expect('ADMIN', 'GET', `/api/v1/admin/assisted/card-refunds/${String(rows[0]._id)}`, 200)).json.data;
      assert.equal(one.bookingKind, 'booking');
      const lab = (await AssistedCardRefundModel.findOne({ bookingKind: 'lab_booking' }).lean()) as any;
      const labOne = (await expect('ADMIN', 'GET', `/api/v1/admin/assisted/card-refunds/${String(lab._id)}`, 200)).json.data;
      assert.deepEqual([labOne.bookingKind, labOne.pharmacyName], ['lab_booking', 'Sharma Medicals']);
    });

    // ───────────────────────── 12. Admin: refund failures, stuck money, reconciliation ─────────────────────────
    await check('a lab card refund Razorpay refuses goes to the operator queue (bookingKind lab_booking); to-wallet with agreement credits once', async () => {
      const b = await paidBooking();
      gateway.refundMode = 'reject';
      let refundId = '';
      try { refundId = (await expect('P', 'POST', `${PA}/lab-bookings/${b.id}/cancel`, 200, {})).json.data.refund.refundId; }
      finally { gateway.refundMode = 'processed'; }
      const q = (await expect('ADMIN', 'GET', '/api/v1/admin/assisted/card-refunds?state=failed', 200)).json.data.find((x: any) => x.refundId === refundId);
      assert.deepEqual([q.bookingKind, q.bookingId, q.state], ['lab_booking', b.id, 'failed']);
      const before = await walletOf(P);
      const w = await expect('ADMIN', 'POST', `/api/v1/admin/assisted/card-refunds/${refundId}/to-wallet`, 200, { agreement: 'agreed by phone' });
      assert.deepEqual([w.json.data.refund.method, w.json.data.refund.state, w.json.data.replayed], ['wallet', 'processed', false]);
      assert.equal((await walletOf(P)).paise - before.paise, 50000);
      await expect('ADMIN', 'POST', `/api/v1/admin/assisted/card-refunds/${refundId}/to-wallet`, 200, { agreement: 'agreed by phone' });
      assert.equal((await walletOf(P)).paise - before.paise, 50000, 'once');
      const credit = await PharmacyWalletTransactionModel.findOne({ operationKey: `assisted_card:${b.v.paymentTransactionId}:refund` }).lean() as any;
      assert.equal(credit.referenceType, 'assisted_lab_booking');
      assert.deepEqual((await stored(b.id)).assisted.funding.refunds.map((x: any) => [x.method, x.state]), [['wallet', 'processed']], 'mirrored on the lab booking');
    });

    await check('r14b: a stale copy of a lab booking that expired or was cancelled never answers with a payable order, nor makes one', async () => {
      // Expired while a replay held the old copy: the stored order is no longer offered.
      const a = await book();
      const staleA = await stored(a.id);
      assert.equal((await openCardOrderOf('lab_booking', staleA))?.razorpayOrderId, a.data.payment.razorpayOrderId, 'offered while it waits');
      await labSvc.expireUnpaid(a.id, later(31 * MIN));
      assert.equal((await stored(a.id)).status, 'cancelled');
      assert.equal(await openCardOrderOf('lab_booking', staleA), null);
      assert.equal(await openCardOrderOf('lab_booking', staleA, { create: false }), null);
      // Cancelled before its order was ever made: no order is made from the stale copy.
      gateway.failOrders = true;
      const body = order(await slot());
      try { await expect('P', 'POST', `${PA}/lab-bookings`, 502, body, 'RAZORPAY_ORDER_CREATION_FAILED'); } finally { gateway.failOrders = false; }
      const staleB = await PartnerLabBookingModel.findOne({ 'assisted.requestKey': { $regex: body.requestKey + '$' } }).lean() as any;
      await expect('P', 'POST', `${PA}/lab-bookings/${String(staleB._id)}/cancel`, 200, {});
      const orders0 = gateway.orders.length;
      assert.equal(await openCardOrderOf('lab_booking', staleB), null);
      assert.equal(gateway.orders.length, orders0, 'no order made');
      assert.equal(await PaymentRecordModel.countDocuments({ contextId: String(staleB._id) }), 0);
      // The replay answers without an order as well.
      assert.equal((await expect('P', 'POST', `${PA}/lab-bookings`, 200, body)).json.data.payment, null);
    });

    await check('stuck money lists a lab card booking still waiting an hour past its pay-by; reconciliation reports no mismatch for card lab rows', async () => {
      const b = await book();
      await PartnerLabBookingModel.updateOne({ _id: b.id }, { $set: { paymentDeadline: new Date(Date.now() - 2 * 3_600_000) } });
      const stuck = (await expect('ADMIN', 'GET', '/api/v1/admin/assisted/stuck-money', 200)).json.data;
      const row = stuck.pendingPaymentPastDeadline.find((x: any) => x.bookingId === b.id);
      assert.equal(row?.bookingKind, 'lab_booking');
      // r14b: late and extra captures name their kind too (rows from before r14 read as consultations).
      const late = await AssistedCardRefundModel.findOne({ bookingKind: 'lab_booking', cause: 'late_capture' }).lean() as any;
      assert.equal(stuck.lateCaptures.find((x: any) => x.refundId === String(late._id))?.bookingKind, 'lab_booking');
      const old = await AssistedCardRefundModel.collection.insertOne({ bookingId: oid(), paymentRecordId: oid(), captureKey: `record:${oid()}`, amountMinor: 100,
        cause: 'late_capture', payerKind: 'pharmacy', payerId: P, method: 'razorpay', state: 'processed', attempts: 0, submissions: 0, createdAt: new Date() } as never);
      const again = (await expect('ADMIN', 'GET', '/api/v1/admin/assisted/stuck-money', 200)).json.data;
      assert.equal(again.lateCaptures.find((x: any) => x.refundId === String(old.insertedId))?.bookingKind, 'booking');
      await AssistedCardRefundModel.collection.deleteOne({ _id: old.insertedId });
      const rec = (await expect('ADMIN', 'GET', '/api/v1/admin/assisted/reconciliation', 200)).json.data;
      const cardIds = new Set((await PartnerLabBookingModel.find({ 'assisted.funding.method': 'razorpay' }).select({ _id: 1 }).lean()).map((x) => String(x._id)));
      assert.ok(!rec.checks.mismatches.some((m: any) => cardIds.has(m.ref)), JSON.stringify(rec.checks.mismatches).slice(0, 300));
      await expireSweep();
      assert.equal((await stored(b.id)).status, 'cancelled');
    });

    await check('no phone number, name or token in the audit rows of card lab bookings (ids and codes only)', async () => {
      const ids = (await PartnerLabBookingModel.find({ 'assisted.funding.method': 'razorpay' }).select({ _id: 1 }).lean()).map((x) => String(x._id));
      const rows = await AssistedAuditEventModel.find({ bookingId: { $in: ids } }).lean();
      assert.ok(rows.length > 10);
      const text = JSON.stringify(rows);
      for (const s of ['9600000401', 'Rina', 'secret', 'rzp_test_key']) assert.ok(!text.includes(s), s);
      assert.ok(text.includes('booking.card_chargeback') && text.includes('booking.late_capture') && text.includes('booking.extra_capture'));
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
