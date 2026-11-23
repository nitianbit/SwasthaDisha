/**
 * r9 owner decisions (ASSISTED_BOOKING_DESIGN.md §22). Each check fails on 92d47079 except 5a (an already-decided rule
 * that held there; kept as a guard):
 * 1. Admin "close as already compensated" for a pharmacy card top-up support paid by hand: once per (admin, key) with a
 *    content hash, by-key read, audited in the transaction; every credit path (verify, reconcile, top-up check, sweep,
 *    the S6 credit script) refuses the closed record; the S6 audit lists it; a credited top-up is 409; the race with a
 *    credit gives exactly one of two outcomes; the unique key index fails closed (503).
 * 2. A partner member linked to a doctor (`doctorId`) signs in and uses the clinic workspace only while that doctor is
 *    verified and active (403 CLINIC_DOCTOR_NOT_VERIFIED); staff without a doctorId are unaffected.
 * 3. An admin prescription clear also withdraws the dispensing copy bound to a medicine order made from it (the order
 *    stays); a replay of the order key does not bring it back.
 * 4. After a clear and a new prescription, every copy made up to the clear stays hidden from all but admins.
 * 5. Already-decided rules: (a) the pharmacy sees the real name only on a customer_order link; (b) the patient's view of
 *    a partner-paid booking shows `paidBy` and never the partner's amount (A10: a kept payment's `forfeitedAmount`).
 * Real authenticate + routers over HTTP against MongoDB; Razorpay, Meet, reminders, SMS and notifications are stubs.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_r9_owner_decisions_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/r9-owner-decisions.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import UserModel from '@/modules/user/model';
import { UserRepository } from '@/modules/user/repository';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import SlotModel from '@/modules/slots/model';
import { DependentRepository } from '@/modules/dependents/repository';
import { DependentService } from '@/modules/dependents/services';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { PharmacyCustomerRepository } from '@/modules/pharmacyCustomers/repository';
import { PharmacyCustomerService } from '@/modules/pharmacyCustomers/services';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { PrescriptionRefundService } from '@/modules/pharmacyOrders/prescriptionRefund';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { PharmacyWalletService } from '@/modules/pharmacyWallet/services';
import SpecialistModel from '@/modules/specialists/model';
import { SpecialistService } from '@/modules/specialists/services';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { AuthService } from '@/modules/auth/services';
import { AdminRepository } from '@/modules/admin/repository';
import { HRRepository } from '@/modules/hr/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { PartnerRepository } from '@/modules/partners/repository';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { NotificationRepository } from '@/modules/notification/repository';
import { NotificationService } from '@/modules/notification/services';
import { OTPRepository } from '@/modules/otp/repository';
import { OTPService } from '@/modules/otp/services';
import { OtpThrottleModel } from '@/modules/otp/model/throttle';
import MemberModel from '@/modules/partners/model/member';
import PartnerOrgModel from '@/modules/partners/model';
import { PartnerService } from '@/modules/partners/services';
import { BookingAdminClearModel } from '@/modules/bookings/model/adminClear';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_r9_owner_decisions_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
const istParts = (at: Date) => { const s = new Date(at.getTime() + IST).toISOString(); return { date: s.slice(0, 10).replace(/-/g, ''), time: s.slice(11, 16) }; };

// The test's own upload directory: a dispensing copy counts as current only while its file exists.
const UPLOAD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assisted-r9-')));
(CONFIG as { UPLOAD_DIR: string }).UPLOAD_DIR = UPLOAD;

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.error('FAIL -', name, '\n  ', (e as Error).message.split('\n').slice(0, 3).join(' | ')); }
}
const noop = new Proxy({}, { get: () => async () => undefined });

/** Razorpay stand-in: the order payments it reports are set per test. */
type GatewayPayment = { id: string; order_id: string; amount: number; currency: string; status: string; fee?: number };
const gateway: { payments: Record<string, GatewayPayment[]> } = { payments: {} };
const fakeRazorpay = {
  orders: { create: async (o: { amount: number; currency: string }) => ({ id: 'order_r9_' + oid(), amount: o.amount, currency: o.currency, status: 'created' }),
    fetchPayments: async (orderId: string) => ({ items: gateway.payments[orderId] ?? [] }) },
  payments: { fetch: async (id: string) => {
    const p = Object.values(gateway.payments).flat().find((x) => x.id === id);
    if (!p) throw Object.assign(new Error('The id provided does not exist'), { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR' } });
    return p;
  } },
};

/** Every key name in a JSON value (nested). */
const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
};

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();

  // tsx emits no decorator metadata: the services the controllers resolve are wired by hand before the routers load.
  const payments = Object.assign(Object.create(PaymentService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(), pharmacyWalletRepository: new PharmacyWalletRepository(),
    pharmacyWalletTransactionRepository: new PharmacyWalletTransactionRepository(), bookingReminderScheduler: noop,
    finalizePaymentProcessing: async (r: { _id: unknown }) => {
      await PaymentRecordModel.updateOne({ _id: r._id }, { $set: { isProcessed: true } });
      return PaymentRecordModel.findById(r._id).lean();
    },
    getRazorpayClient: () => fakeRazorpay,
    getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
  }) as unknown as PaymentService;
  const bookingService = Object.assign(Object.create(BookingService.prototype), {
    bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
    walletTransactionRepository: new WalletTransactionRepository(), userRepository: new UserRepository(),
    notificationService: noop, paymentService: payments, couponService: {}, emailService: {}, bookingReminderScheduler: noop,
    specialistService: { getById: async (id: string) => SpecialistModel.findById(id).lean() },
    slotService: { getById: async (id: string) => SlotModel.findById(id).lean() },
  }) as BookingService;
  Container.set(BookingService, bookingService);
  Container.set(PaymentService, payments);
  Container.set(DependentService, Object.assign(Object.create(DependentService.prototype), { dependentRepository: new DependentRepository() }));
  const pharmacyCustomerService = Object.assign(Object.create(PharmacyCustomerService.prototype), {
    pharmacyCustomerRepo: new PharmacyCustomerRepository(), pharmacyRepo: new PharmacyRepository(), userRepo: new UserRepository() }) as PharmacyCustomerService;
  Container.set(PharmacyCustomerService, pharmacyCustomerService);
  Container.set(PharmacyWalletService, Object.assign(Object.create(PharmacyWalletService.prototype), {
    walletRepo: new PharmacyWalletRepository(), txRepo: new PharmacyWalletTransactionRepository(), paymentService: payments }));
  Container.set(SpecialistService, { getById: async (id: string) => SpecialistModel.findById(id).lean() } as never);
  const MED = oid();
  const inventory = {
    getInventoryByMedicine: async () => ({ retailPrice: 50, wholesalePrice: 40 }),
    reserveOrderStockBulk: async (_p: string, items: { medicineId: string }[]) => new Map(items.map((i) => [String(i.medicineId), []])),
    returnStockBulk: async () => [], releaseOrderStockBulk: async () => undefined, consumeOrderReservedStockBulk: async () => undefined,
  };
  const medicines = {
    findById: async () => ({ _id: MED, name: 'Paracetamol 500', isActive: true, prescriptionRequired: true, gstPercent: 0 }),
    findAll: async () => [{ _id: MED, name: 'Paracetamol 500', isActive: true, prescriptionRequired: true }],
  };
  const refunds = new PrescriptionRefundService({ listRefunds: async () => [], fetchRefund: async () => { throw new Error('x'); },
    refund: async () => { throw new Error('x'); } } as never, new WalletRepository());
  Container.set(PharmacyOrderService, new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
    new PharmacyOrderRepository(), pharmacyCustomerService, inventory, payments, new BookingRepository(), {},
    { queueNotification: async () => undefined, queueSubscriptionSync: async () => undefined }, medicines, refunds));
  const partners = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
  Container.set(PartnerService, partners);

  const sms: { to: string; text: string }[] = [];
  const users = new UserRepository();
  const auth = new (AuthService as unknown as new (...a: unknown[]) => AuthService)(users, new AdminRepository(), new HRRepository(),
    new SpecialistRepository(), new PharmacyRepository(), {}, new OTPService(new OTPRepository()), { getByUserId: async () => ({}) },
    new NotificationService(new NotificationRepository(), users, {} as never), { sendEmail: async () => ({ success: true }) },
    { buildSMSContent: (_t: string, p: { otp: string }) => ({ text: 'OTP ' + p.otp }),
      sendSMS: async (m: { to: string; text: string }) => { sms.push(m); return { success: true, data: null }; } }, new MemberRepository());

  const support = await import('@/modules/assisted/support');
  support.setAssistedNotifier(async () => undefined);
  support.setAssistedEffects({ meet: async (b: any) => b, cancelMeet: async (b: any) => b, reminders: async () => undefined, clearReminders: async () => undefined } as never);
  const phase1a = await import('@/modules/assisted/routes/phase1a');
  const { AssistedAuditEventModel } = await import('@/modules/assisted/model');
  const { default: bookingRouter } = await import('@/modules/bookings/routes');
  const { default: pharmacyBookingRouter } = await import('@/modules/assisted/routes');
  const { default: pharmacyWalletRouter } = await import('@/modules/pharmacyWallet/routes');
  const { default: pharmacyOrderRouter } = await import('@/modules/pharmacyOrders/routes');
  const { default: paymentRouter } = await import('@/modules/payment/routes');
  const { default: partnerWorkspaceRouter } = await import('@/modules/partners/routes');
  const { authenticate } = await import('@/modules/middleware/auth');
  const { clearBookingField } = await import('@/modules/bookings/adminClear');
  const { decideFileAccess } = await import('@/modules/file/access');
  const { dispensingHashOf } = await import('@/modules/assisted/dispensingCopy');
  const { creditS6WalletTopup } = await import('@/scripts/creditS6WalletTopup');
  const { auditS6UncreditedWalletTopups } = await import('@/scripts/auditS6UncreditedWalletTopups');
  for (const name of mongoose.modelNames()) {
    const m = mongoose.model(name);
    await m.createCollection().catch(() => undefined);
    await m.syncIndexes();
  }

  const app = express();
  app.use(express.json());
  app.use('/api/v1/bookings', authenticate, bookingRouter);
  app.use('/api/v1/pharmacy-bookings', authenticate, pharmacyBookingRouter);
  app.use('/api/v1/pharmacy-assisted', authenticate, phase1a.pharmacyAssistedRouter);
  app.use('/api/v1/admin', authenticate, phase1a.adminAssistedRouter);
  app.use('/api/v1/pharmacy-wallet', authenticate, pharmacyWalletRouter);
  app.use('/api/v1/pharmacy-orders', authenticate, pharmacyOrderRouter);
  app.use('/api/v1/payments', authenticate, paymentRouter);
  app.use('/api/v1/partner-workspace', authenticate, partnerWorkspaceRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  process.env.ASSISTED_LIMIT_BOOKINGS_PER_PHONE_PER_DAY = '1000';
  process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '100000';
  process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
  process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';

  try {
    const P = oid(); const ADMIN = oid(); const ADMIN2 = oid(); const X = oid(); const D = oid();
    await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(P), name: 'Rnine Medicals', phone: '9700000901', email: 'rnine@pharm.test',
      city: 'Shillong', pincode: '793001', isActive: true, isVerified: true } as never);
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(X), userType: 'user', phone: '9600000901', name: 'Rina Kumari Das',
      createdSource: 'self_signup', otpVerified: true } as never);
    await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(D), name: 'Dr Asha Menon', specialization: 'General Physician',
      languages: ['English'], city: 'Shillong', pincode: '793001', consultationFee: 500, isActive: true, isVerified: true } as never);
    const tokens: Record<string, string> = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), X: sign({ _id: X, userType: 'user' }),
      ADMIN: sign({ _id: ADMIN, userType: 'admin' }), ADMIN2: sign({ _id: ADMIN2, userType: 'admin' }),
    };
    const call = async (who: string | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(base + url, { method, headers: { ...(who ? { authorization: 'Bearer ' + (tokens[who] ?? who) } : {}),
        'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any; try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, json, text };
    };
    const expect = async (who: string | null, method: string, url: string, status: number, body?: unknown, code?: string) => {
      const r = await call(who, method, url, body);
      assert.equal(r.status, status, `${method} ${url}: ${r.status} ${r.text.slice(0, 300)}`);
      if (code) assert.equal(r.json.code, code, `${method} ${url}: ${r.text.slice(0, 300)}`);
      return r;
    };
    const pharmacyWithToken = async (name: string, phone: string) => {
      const id = oid();
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(id), name, phone, isActive: true, isVerified: true } as never);
      tokens[id] = sign({ _id: id, pharmacyId: id, userType: 'pharmacy' });
      return id;
    };
    const topupRecord = async (pharmacyId: string, amount: number, status: 'created' | 'paid') => {
      const orderId = 'order_r9_' + oid();
      const payId = 'pay_r9' + oid().slice(-12);
      const rec = await PaymentRecordModel.create({ userId: pharmacyId, payerUserId: pharmacyId, payerPharmacyId: pharmacyId, context: 'wallet_recharge',
        contextId: `pharmacy_${pharmacyId}_${oid()}`, baseAmount: amount, discountAmount: 0, finalAmount: amount, baseAmountPaise: amount * 100,
        finalAmountPaise: amount * 100, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: orderId, status,
        ...(status === 'paid' ? { razorpayPaymentId: payId, paidAt: new Date() } : {}), notes: { flow: 'pharmacy_wallet_recharge', pharmacyId } } as never);
      gateway.payments[orderId] = [{ id: payId, order_id: orderId, amount: amount * 100, currency: 'INR', status: 'captured', fee: 100 }];
      const recordId = String((rec as any)._id);
      return { recordId, orderId, payId, verify: { paymentTransactionId: recordId, razorpayOrderId: orderId, razorpayPaymentId: payId,
        razorpaySignature: crypto.createHmac('sha256', 'secret').update(`${orderId}|${payId}`).digest('hex') } };
    };
    const credits = (recordId: string) => PharmacyWalletTransactionModel.countDocuments({ referenceType: 'wallet_recharge', referenceId: recordId });
    const balanceOf = async (pharmacyId: string) => Number(((await PharmacyWalletModel.findOne({ pharmacyId }).lean()) as any)?.balancePaise ?? 0);
    let keySeq = 0;
    const newKey = (p = 'r9') => `${p}-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;
    const close = (who: string, paymentId: string, body: Record<string, unknown>) => call(who, 'POST', `/admin/wallet-payments/${paymentId}/close-compensated`, body);
    const closeAudits = (pharmacyId: string) => AssistedAuditEventModel.countDocuments({ action: 'wallet.closed_compensated' as never, orgId: pharmacyId });

    // ───────────────────────── 1. Close as already compensated ─────────────────────────
    await check('1a the close route fails closed (503 INDEXES_OUTDATED) while the unique key index is missing; nothing is written', async () => {
      const B = await pharmacyWithToken('Index Pharmacy', '9700000950');
      const t = await topupRecord(B, 200, 'created');
      await PaymentRecordModel.collection.dropIndex('compensation.requestKey_1');
      try {
        const r = await close('ADMIN', t.recordId, { reason: 'paid by bank transfer', requestKey: newKey() });
        assert.equal(r.status, 503, r.text.slice(0, 300)); assert.equal(r.json.code, 'INDEXES_OUTDATED');
        await expect('ADMIN', 'GET', `/admin/wallet-payments/close-compensated/by-key/${newKey()}`, 503, undefined, 'INDEXES_OUTDATED');
        const rec = await PaymentRecordModel.findById(t.recordId).lean() as any;
        assert.deepEqual([rec.status, rec.compensatedAt], ['created', undefined]);
      } finally { await PaymentRecordModel.syncIndexes(); }
    });

    await check('1b close: closed once in one audited transaction, replays idempotent, key reuse 409, by-key read; never credited by any path', async () => {
      const B = await pharmacyWithToken('Compensated Pharmacy', '9700000951');
      const t = await topupRecord(B, 400, 'created');
      const key = newKey();
      const first = await close('ADMIN', t.orderId, { reason: 'paid by bank transfer', requestKey: key });
      assert.equal(first.status, 200, first.text.slice(0, 300));
      const d = first.json.data;
      assert.deepEqual([d.closed, d.credited, d.replayed, d.paymentRecordId, d.pharmacyId, d.amountPaise, d.status],
        [true, false, false, t.recordId, B, 40000, 'failed']);
      const rec = await PaymentRecordModel.findById(t.recordId).lean() as any;
      assert.equal(rec.status, 'failed'); assert.ok(rec.compensatedAt);
      assert.deepEqual([rec.compensation.by, rec.compensation.requestKey, rec.compensation.previousStatus, rec.compensation.reason],
        [ADMIN, `${ADMIN}:${key}`, 'created', 'paid by bank transfer']);
      assert.equal(await closeAudits(B), 1);
      const audit = await AssistedAuditEventModel.findOne({ action: 'wallet.closed_compensated' as never, orgId: B }).lean() as any;
      assert.deepEqual([audit.actorKind, audit.actorId, audit.requestKey, audit.detail.paymentRecordId, audit.detail.amountPaise], ['admin', ADMIN, key, t.recordId, 40000]);
      // Replays: the same key and content (named by its record id this time), another key, another admin.
      const again = await close('ADMIN', t.recordId, { reason: 'paid by bank transfer', requestKey: key });
      assert.deepEqual([again.status, again.json.data.replayed, again.json.data.paymentRecordId], [200, true, t.recordId]);
      const other = await close('ADMIN2', t.payId, { reason: 'second click', requestKey: newKey() });
      assert.deepEqual([other.status, other.json.data.replayed], [200, true], other.text.slice(0, 300));
      assert.equal(await closeAudits(B), 1, 'audited once');
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${t.recordId}/close-compensated`, 409, { reason: 'another reason', requestKey: key }, 'IDEMPOTENCY_KEY_REUSED');
      const t2 = await topupRecord(B, 100, 'created');
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${t2.recordId}/close-compensated`, 409, { reason: 'paid by bank transfer', requestKey: key }, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal((await PaymentRecordModel.findById(t2.recordId).lean() as any).compensatedAt, undefined, 'the other top-up stays open');
      // By-key: this admin's key only.
      const byKey = await expect('ADMIN', 'GET', `/admin/wallet-payments/close-compensated/by-key/${key}`, 200);
      assert.deepEqual([byKey.json.data.state, byKey.json.data.paymentRecordId, byKey.json.data.amountPaise], ['closed', t.recordId, 40000]);
      assert.equal((await expect('ADMIN2', 'GET', `/admin/wallet-payments/close-compensated/by-key/${key}`, 200)).json.data.state, 'not_found');
      assert.equal((await expect('ADMIN', 'GET', `/admin/wallet-payments/close-compensated/by-key/${newKey()}`, 200)).json.data.state, 'not_found');
      // Every credit path refuses it.
      await expect(B, 'POST', '/payments/verify', 409, t.verify, 'TOPUP_BLOCKED');
      await expect(B, 'POST', '/payments/reconcile', 409, { paymentTransactionId: t.recordId }, 'TOPUP_BLOCKED');
      await expect(B, 'POST', `/pharmacy-wallet/topups/${t.recordId}/check`, 409, undefined, 'TOPUP_BLOCKED');
      process.env.WALLET_RECHARGE_SWEEP_FROM = new Date(Date.now() - DAY).toISOString();
      try {
        await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(t.recordId) }, { $set: { createdAt: new Date(Date.now() - 3600_000) } });
        await payments.sweepUnsettledBookingPayments(new Date(), 500);
      } finally { delete process.env.WALLET_RECHARGE_SWEEP_FROM; }
      const credit = await creditS6WalletTopup({ recordId: t.recordId, commit: true, client: fakeRazorpay as never });
      assert.equal(credit.decision, 'refused'); assert.match(credit.reasons[0]!, /closed as compensated: never credit/);
      assert.equal(await credits(t.recordId), 0, 'never credited');
      assert.equal(await balanceOf(B), 0);
      assert.equal((await PaymentRecordModel.findById(t.recordId).lean() as any).status, 'failed');
      const unc = (await expect('ADMIN', 'GET', '/admin/wallet-recharges/uncredited', 200)).json.data.map((x: any) => x.paymentTransactionId);
      assert.equal(unc.includes(t.recordId), false, 'not listed as owed to the pharmacy');
      // The S6 audit lists it in its own section, never as a credit candidate.
      const report = await auditS6UncreditedWalletTopups() as any;
      const listed = report.closedAsCompensated.find((r: any) => r.paymentTransactionId === t.recordId);
      assert.deepEqual([listed?.review, listed?.amount, listed?.status], ['closed as compensated: never credit', 400, 'failed']);
      assert.equal(report.rows.some((r: any) => r.paymentTransactionId === t.recordId), false);
      assert.equal(report.summary.closedAsCompensated, report.closedAsCompensated.length);
    });

    await check('1c close by payment id of a paid, uncredited top-up; a credited top-up is 409 (nothing to close); 404 / 403 / blocked answers', async () => {
      const B = await pharmacyWithToken('Paid Pharmacy', '9700000952');
      const paid = await topupRecord(B, 300, 'paid');
      const r = await close('ADMIN', paid.payId, { reason: 'refunded by hand', requestKey: newKey() });
      assert.deepEqual([r.status, r.json.data.paymentRecordId, r.json.data.status], [200, paid.recordId, 'failed'], r.text.slice(0, 300));
      assert.equal((await PaymentRecordModel.findById(paid.recordId).lean() as any).compensation.previousStatus, 'paid');
      await expect(B, 'POST', '/payments/verify', 409, paid.verify, 'TOPUP_BLOCKED');
      assert.equal(await credits(paid.recordId), 0);
      // Credited first (the top-up check): nothing to close; the record is untouched.
      const done = await topupRecord(B, 250, 'created');
      await expect(B, 'POST', `/pharmacy-wallet/topups/${done.recordId}/check`, 200);
      assert.equal(await credits(done.recordId), 1);
      const before = await balanceOf(B);
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${done.recordId}/close-compensated`, 409, { reason: 'x', requestKey: newKey() }, 'TOPUP_ALREADY_CREDITED');
      const rec = await PaymentRecordModel.findById(done.recordId).lean() as any;
      assert.deepEqual([rec.status, rec.compensatedAt], ['paid', undefined]);
      assert.equal(await balanceOf(B), before);
      assert.equal(await closeAudits(B), 1, 'only the first close is audited');
      // Blocked after a lost dispute: already never credited.
      const blocked = await topupRecord(B, 120, 'created');
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${blocked.recordId}/chargeback`, 200, { reason: 'dispute lost' });
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${blocked.recordId}/close-compensated`, 409, { reason: 'x', requestKey: newKey() }, 'TOPUP_BLOCKED');
      // Not a pharmacy top-up; not an admin; bad body.
      const other = await PaymentRecordModel.create({ userId: X, payerUserId: X, context: 'booking', contextId: oid(), baseAmount: 100, discountAmount: 0,
        finalAmount: 100, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_r9_bk' + oid(), status: 'created' } as never);
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${String((other as any)._id)}/close-compensated`, 404, { reason: 'x', requestKey: newKey() }, 'TOPUP_NOT_FOUND');
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${oid()}/close-compensated`, 404, { reason: 'x', requestKey: newKey() }, 'TOPUP_NOT_FOUND');
      const fresh = await topupRecord(B, 90, 'created');
      assert.equal((await close(B, fresh.recordId, { reason: 'x', requestKey: newKey() })).status, 403);
      assert.equal((await close('ADMIN', fresh.recordId, { reason: 'x' })).status, 400, 'requestKey is required');
      assert.equal((await close('ADMIN', fresh.recordId, { reason: 'x', requestKey: 'bad key!' })).status, 400);
    });

    await check('1d race: close against a credit gives credited (close refused) or closed (never credited), nothing else', async () => {
      const seen = { closed: 0, credited: 0 };
      for (let i = 0; i < 10; i++) {
        const B = await pharmacyWithToken(`Race Pharmacy ${i}`, `97000009${String(60 + i)}`);
        const t = await topupRecord(B, 300, 'created');
        const creditCall = i % 2 === 0 ? call(B, 'POST', `/pharmacy-wallet/topups/${t.recordId}/check`) : call(B, 'POST', '/payments/verify', t.verify);
        const [cl, cr] = await Promise.all([close('ADMIN', t.recordId, { reason: 'race', requestKey: newKey() }), creditCall]);
        const rec = await PaymentRecordModel.findById(t.recordId).lean() as any;
        const c = await credits(t.recordId);
        if (cl.status === 200) {
          seen.closed += 1;
          assert.deepEqual([c, !!rec.compensatedAt, rec.status, await balanceOf(B)], [0, true, 'failed', 0], `closed: credit answered ${cr.status} ${cr.text.slice(0, 200)}`);
          assert.notEqual(cr.status, 200, 'the credit was refused');
          assert.equal(await closeAudits(B), 1);
        } else {
          seen.credited += 1;
          assert.deepEqual([cl.status, cl.json.code], [409, 'TOPUP_ALREADY_CREDITED'], cl.text.slice(0, 300));
          assert.deepEqual([c, rec.compensatedAt, await balanceOf(B)], [1, undefined, 30000]);
          assert.equal(await closeAudits(B), 0);
        }
      }
      console.log('   race outcomes', JSON.stringify(seen));
    });

    // ───────────────────────── 2. Clinic workspace sign-in of a doctor-linked member ─────────────────────────
    let phoneSeq = 0;
    const nextPhone = () => '95' + String(10_000_000 + ++phoneSeq).padStart(8, '0');
    const signIn = async (phone: string, partnerId?: string) => {
      await OtpThrottleModel.deleteMany({});
      await auth.sendOTP({ userType: 'partner', phone, ...(partnerId ? { partnerId } : {}) } as never);
      const otp = /(\d{6})/.exec(sms[sms.length - 1]!.text)![1]!;
      return auth.verifyOTP({ userType: 'partner', phone, otp, ...(partnerId ? { partnerId } : {}) } as never);
    };
    const refusedWith = (code: string) => (e: any) => { if (e?.code !== code || e?.status !== 403) throw e; return true; };
    const DS = oid();
    await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(DS), name: 'Dr Solo Owner', specialization: 'General Physician',
      consultationFee: 400, isActive: true, isVerified: true } as never);
    const ownerPhone = nextPhone();
    const { partner: solo, owner } = await partners.createPartner({ kind: 'clinic', name: 'Dr Solo Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'DS',
      firstOwner: { phone: ownerPhone, name: 'Dr Solo Owner' } } as any);
    const SOLO = String(solo._id);
    await partners.verifyPartner(SOLO, ADMIN);
    await PartnerOrgModel.updateOne({ _id: SOLO }, { $set: { solo: true, soloDoctorId: DS } });
    await MemberModel.updateOne({ _id: owner._id }, { $set: { doctorId: DS } });
    const staffPhone = nextPhone();
    await MemberModel.create({ partnerId: SOLO, phone: staffPhone, name: 'Front Desk', role: 'staff', permissions: ['bookings.view'], isActive: true } as never);
    const setDoctor = (s: { isVerified?: boolean; isActive?: boolean }) => SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(DS) }, { $set: s });

    await check('2 a doctor-linked member is refused at sign-in and on an existing session while the doctor is ineligible; staff unaffected; re-verify restores', async () => {
      const signed = await signIn(ownerPhone, SOLO);
      assert.ok(signed.accessToken, 'a verified owner signs in');
      const session = signed.accessToken;
      await expect(session, 'GET', '/partner-workspace/me', 200);
      const staff = (await signIn(staffPhone, SOLO)).accessToken;
      for (const s of [{ isVerified: false, isActive: true }, { isVerified: true, isActive: false }]) {
        await setDoctor(s);
        try {
          await expect(session, 'GET', '/partner-workspace/me', 403, undefined, 'CLINIC_DOCTOR_NOT_VERIFIED');
          await assert.rejects(signIn(ownerPhone, SOLO), refusedWith('CLINIC_DOCTOR_NOT_VERIFIED'));
          await expect(staff, 'GET', '/partner-workspace/me', 200);
          assert.ok((await signIn(staffPhone, SOLO)).accessToken, 'staff without a doctorId sign in');
        } finally { await setDoctor({ isVerified: true, isActive: true }); }
      }
      await expect(session, 'GET', '/partner-workspace/me', 200);
      assert.ok((await signIn(ownerPhone, SOLO)).accessToken, 're-verified: signs in again');
    });

    await check('2b the workspace choice refuses the doctor-linked membership while the doctor is ineligible; the person\'s other membership opens', async () => {
      const { partner: lab } = await partners.createPartner({ kind: 'lab', name: 'Other Lab', contactPhone: nextPhone(), invoiceSeriesPrefix: 'OL',
        firstOwner: { phone: nextPhone(), name: 'Lab Owner' } } as any);
      const LAB = String(lab._id);
      await partners.verifyPartner(LAB, ADMIN);
      await MemberModel.create({ partnerId: LAB, phone: ownerPhone, name: 'Dr Solo at the lab', role: 'staff', permissions: ['bookings.view'], isActive: true } as never);
      await setDoctor({ isVerified: false });
      try {
        const first = await signIn(ownerPhone);
        assert.ok(first.selection, 'two workspaces: a choice');
        await assert.rejects(auth.selectPartner({ ticket: first.selection!.ticket, partnerId: SOLO }), refusedWith('CLINIC_DOCTOR_NOT_VERIFIED'));
        const second = await signIn(ownerPhone);
        const opened = await auth.selectPartner({ ticket: second.selection!.ticket, partnerId: LAB });
        assert.ok(opened.accessToken);
        await expect(opened.accessToken, 'GET', '/partner-workspace/me', 200);
      } finally { await setDoctor({ isVerified: true }); }
    });

    // ───────────────────────── Bookings with a prescription ─────────────────────────
    const slotAt = async (doctor: string, at: Date) => {
      const s = istParts(at); const e = istParts(new Date(at.getTime() + 15 * MIN));
      const slot = await SlotModel.create({ specialistId: doctor, date: s.date, startTime: s.time, endTime: e.time, duration: 15, maxBookings: 1,
        currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation' } as never);
      return String(slot._id);
    };
    let hour = 0;
    const futureSlot = async () => slotAt(D, new Date(Date.now() + 6 * DAY + (++hour) * 3600_000 / 4));
    const adminTopup = (amount: number) => call('ADMIN', 'POST', '/pharmacy-wallet/topup', { pharmacyId: P, amount }, { 'idempotency-key': 'r9-topup-' + oid() });
    assert.equal((await adminTopup(10000)).status, 200);
    const book = async () => {
      const r = await expect('P', 'POST', '/pharmacy-assisted/consultations', 201, {
        requestKey: newKey('bk'), phone: '9600000901', patient: { relation: 'self', name: 'Rina Das' },
        consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' }, preferredLanguage: 'en', slotId: await futureSlot(),
        consultationMode: 'video', join: { on: 'partner_device' }, acceptedPriceMinor: 50000, primaryConcern: 'fever', paymentMethod: 'wallet' });
      return String(r.json.data.booking._id);
    };
    /** The doctor saves a prescription: content, marker, full PDF and its current dispensing copy (both named by `ms`). */
    const prescribe = async (id: string, medicine: string) => {
      await sleep(5);
      const ms = Date.now();
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: {
        prescription: { advice: 'rest', medicines: [{ name: medicine }], testsAdvised: [], prescribedAt: new Date().toISOString(),
          prescribedBySpecialistId: D, prescribedBySpecialistName: 'Dr Asha Menon', fileUrls: [`/api/static/bookings/${id}/prescription-${ms}.pdf`] },
        'lifecycle.prescriptionUploaded': { at: new Date().toISOString() } } });
      const b = await BookingModel.findById(id).lean() as any;
      const url = `/api/static/bookings/${id}/rx-dispense-${ms}.pdf`;
      fs.mkdirSync(path.join(UPLOAD, 'bookings', id), { recursive: true });
      fs.writeFileSync(path.join(UPLOAD, 'bookings', id, `rx-dispense-${ms}.pdf`), 'copy');
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { 'prescription.dispensingCopy': { url, hash: dispensingHashOf(b), at: new Date() } } });
      await sleep(5);
      return { copyUrl: url, copy: url.replace('/api/static/', ''), pdf: `bookings/${id}/prescription-${ms}.pdf` };
    };
    const who = {
      patient: { _id: X, userType: 'user' }, doctor: { _id: D, specialistId: D, userType: 'specialist' },
      pharmacy: { _id: P, pharmacyId: P, userType: 'pharmacy' }, admin: { _id: ADMIN, userType: 'admin' },
    } as const;
    const readable = async (r: object, rel: string) => (await decideFileAccess(r as never, rel)).allow;

    // ───────────────────────── 3. A clear takes back the copy bound to an order ─────────────────────────
    await check('3 an admin clear withdraws the dispensing copy bound to an order made before it; the order stays; a replay of the key does not restore it', async () => {
      const id = await book();
      const rx = await prescribe(id, 'Paracetamol 500');
      const key = newKey('rx');
      const order = { orderType: 'in_store', prescriptionFromBookingId: id, requestKey: key, items: [{ medicineId: MED, orderedQty: 2 }],
        paymentMode: 'in_store_payment', deliveryMode: 'pickup' };
      const made = await expect('P', 'POST', '/pharmacy-orders', 201, order);
      const orderId = String(made.json.data.order._id);
      assert.deepEqual(made.json.data.order.prescriptionUrls, [rx.copyUrl], 'the order binds the dispensing copy');
      assert.equal(await readable(who.pharmacy, rx.copy), true, 'the pharmacy reads it before the clear');
      await clearBookingField(id, 'prescription', ADMIN, 'planted prescription');
      for (const r of [who.pharmacy, who.patient, who.doctor]) {
        assert.deepEqual(await decideFileAccess(r as never, rx.copy), { allow: false, status: 404 }, `${r.userType}: the order's copy is withdrawn`);
      }
      assert.equal(await readable(who.admin, rx.copy), true, 'admins still read it');
      const kept = await PharmacyOrderModel.findById(orderId).lean() as any;
      assert.ok(kept, 'the order stays'); assert.deepEqual(kept.prescriptionUrls, [rx.copyUrl]);
      const replay = await expect('P', 'POST', '/pharmacy-orders', 201, order);
      assert.deepEqual([String(replay.json.data.order._id), replay.json.data.replayed], [orderId, true]);
      assert.equal(await PharmacyOrderModel.countDocuments({ 'prescriptionFromBooking.bookingId': id }), 1);
      for (const r of [who.pharmacy, who.patient]) assert.equal(await readable(r, rx.copy), false, `${r.userType}: still withdrawn after the replay`);
    });

    // ───────────────────────── 4. Older copies stay hidden after a clear ─────────────────────────
    await check('4 Rx1 copy C1, Rx2 copy C2, clear, Rx3: C1 and C2 are refused to patient, doctor and pharmacy; C3 and the new PDF are read', async () => {
      const id = await book();
      const c1 = await prescribe(id, 'Paracetamol 500');
      const c2 = await prescribe(id, 'Ibuprofen 400');
      for (const r of [who.patient, who.doctor]) assert.equal(await readable(r, c1.copy), true, `${r.userType} reads the older copy before the clear`);
      await clearBookingField(id, 'prescription', ADMIN, 'planted prescription');
      const row = await BookingAdminClearModel.findOne({ bookingId: id }).lean() as any;
      assert.deepEqual([...row.paths].sort(), [c2.copy, c2.pdf].sort(), 'the clear records what the booking held');
      const c3 = await prescribe(id, 'Cetirizine 10');
      for (const r of [who.patient, who.doctor, who.pharmacy]) {
        assert.equal(await readable(r, c1.copy), false, `${r.userType}: C1 refused`);
        assert.equal(await readable(r, c2.copy), false, `${r.userType}: C2 refused`);
        assert.equal(await readable(r, c3.copy), true, `${r.userType}: C3 read`);
      }
      for (const r of [who.patient, who.doctor]) assert.equal(await readable(r, c3.pdf), true, `${r.userType}: the new PDF is read`);
      assert.equal(await readable(who.admin, c1.copy), true, 'admins still read C1');
    });

    // ───────────────────────── 5. Already-decided rules ─────────────────────────
    await check('5a the pharmacy sees the real account name only on a customer_order link (typed name otherwise)', async () => {
      const id = await book();
      const link = { pharmacyId: new Types.ObjectId(P), userId: new Types.ObjectId(X) };
      assert.equal((await PharmacyCustomerModel.findOne(link).lean() as any).consent, 'patient_agreed');
      const typed = (await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200)).json.data;
      assert.deepEqual([typed.patientName, typed.holder.name], ['Rina Das', 'Rina Das']);
      assert.equal(JSON.stringify(typed).includes('Rina Kumari Das'), false);
      await PharmacyCustomerModel.collection.updateOne(link, { $set: { consent: 'customer_order' } });
      try {
        const real = (await expect('P', 'GET', `/pharmacy-bookings/${id}`, 200)).json.data;
        assert.deepEqual([real.patientName, real.holder.name], ['Rina Kumari Das', 'Rina Kumari Das']);
      } finally { await PharmacyCustomerModel.collection.updateOne(link, { $set: { consent: 'patient_agreed' } }); }
    });

    await check('5b A10: the patient sees "paid by" the partner and never its amount, a kept (forfeited) payment included', async () => {
      const id = await book();
      // A moved no-show an admin cancelled without a refund: the partner's payment is kept and its amount recorded.
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { status: 'cancelled', cancellationCause: 'admin',
        noShowCancel: { at: new Date(), by: ADMIN, refund: false, forfeitedAmount: 500 }, 'assisted.funding.state': 'forfeited' } });
      const forbidden = ['price', 'originalPrice', 'forfeitedAmount', 'funding', 'walletFunding', 'paymentTransactionId', 'createTerms', 'amountMinor', 'split'];
      const one = (await expect('X', 'GET', `/bookings/${id}`, 200)).json.data;
      const list = ((await expect('X', 'GET', '/bookings', 200)).json.data as any[]).find((b) => String(b._id) === id);
      for (const [where, v] of [['detail', one], ['list', list]] as const) {
        assert.equal(v.paidBy, 'Rnine Medicals', `${where}: paid by the partner`);
        const keys = keysOf(v);
        for (const k of forbidden) assert.equal(keys.has(k), false, `${where}: no ${k}`);
        assert.equal(v.noShowCancel?.refund, false, `${where}: the cancel itself is still shown`);
      }
      await expect('X', 'GET', `/bookings/${id}/payment-details`, 404, undefined, 'BOOKING_NOT_FOUND');
    });
  } finally {
    server.close();
    await mongoose.disconnect();
    fs.rmSync(UPLOAD, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('failed:', failed.join('; ')); process.exit(1); }
  process.exit(0);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
