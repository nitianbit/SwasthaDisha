/**
 * r9b follow-ups of the review of 0ca329aa (ASSISTED_BOOKING_DESIGN.md §22.4). Each check fails on 0ca329aa:
 * 1. A card dispute lost on a top-up closed as compensated takes the hand-paid amount back (balance to 0 at most, the
 *    rest owed, wallet frozen), once, audited; the S6 audit lists the record in both sections.
 * 2. (a) The doctor rule's error code is CLINIC_DOCTOR_NOT_VERIFIED; (b) choosing a workspace closed by it does not use
 *    up the sign-in ticket.
 * 3. A refunded top-up cannot be closed as compensated (409 TOPUP_REFUNDED).
 * 4. A credit row whose pharmacy id is stored as a raw (mixed-case) string counts as a credit (409 TOPUP_ALREADY_CREDITED).
 * Same wiring as test/assisted/r9-owner-decisions.integration.ts (its own database).
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_r9b_followups_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/r9b-followups.integration.ts
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

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_r9b_followups_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
const istParts = (at: Date) => { const s = new Date(at.getTime() + IST).toISOString(); return { date: s.slice(0, 10).replace(/-/g, ''), time: s.slice(11, 16) }; };

// The test's own upload directory: a dispensing copy counts as current only while its file exists.
const UPLOAD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assisted-r9b-')));
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


    // ───────────────────────── 1. A lost dispute after a close-compensated ─────────────────────────
    await check('1 a dispute lost on a top-up closed as compensated takes the hand payment back: once, audited, owed shortfall, frozen; S6 lists both', async () => {
      const B = await pharmacyWithToken('Hand Paid Pharmacy', '9700000971');
      // Support paid the ₹300 by hand as an admin top-up; the pharmacy spent part of it meanwhile (₹200 left).
      assert.equal((await call('ADMIN', 'POST', '/pharmacy-wallet/topup', { pharmacyId: B, amount: 200 }, { 'idempotency-key': 'r9b-hand-' + oid() })).status, 200);
      const t = await topupRecord(B, 300, 'created');
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${t.recordId}/close-compensated`, 200, { reason: 'paid by hand', requestKey: newKey() });
      const flag = await expect('ADMIN', 'POST', `/admin/wallet-payments/${t.orderId}/chargeback`, 200, { reason: 'card dispute lost' });
      assert.deepEqual([flag.json.data.blockedUncredited, flag.json.data.compensated, flag.json.data.flagged, flag.json.data.replayed], [false, true, true, false]);
      // r32 (§26.8.4): flagged only; the admin's Recover takes the hand payment back.
      const recover = (id: string) => expect('ADMIN', 'POST', `/admin/wallet-payments/${id}/recover`, 200, { reason: 'recover the hand payment', requestKey: newKey() });
      const r = await recover(t.orderId);
      const d = r.json.data;
      assert.deepEqual([d.compensated, d.replayed, d.entry.amountPaise, d.entry.receivableDeltaPaise], [true, false, 20000, 10000]);
      const w = await PharmacyWalletModel.findOne({ pharmacyId: B }).lean() as any;
      assert.deepEqual([w.balancePaise, w.receivableMinor, w.frozen], [0, 10000, true]);
      const again = await expect('ADMIN', 'POST', `/admin/wallet-payments/${t.recordId}/chargeback`, 200, { reason: 'again' });
      assert.equal(again.json.data.replayed, true);
      assert.equal((await recover(t.recordId)).json.data.replayed, true);
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: B, transactionType: 'chargeback' }), 1, 'once');
      assert.equal(await AssistedAuditEventModel.countDocuments({ action: 'wallet.chargeback', orgId: B }), 1);
      const audits = await AssistedAuditEventModel.find({ action: 'wallet.recovered', orgId: B }).lean() as any[];
      assert.equal(audits.length, 1); assert.deepEqual([audits[0].detail.compensated, audits[0].detail.debitedMinor], [true, 20000]);
      const rows = await PharmacyWalletTransactionModel.find({ pharmacyId: B }).lean() as any[];
      assert.equal(rows.reduce((a, x) => a + Number(x.signedAmountPaise ?? 0), 0), 0, 'balance = Σ entries');
      const rec = await PaymentRecordModel.findById(t.recordId).lean() as any;
      assert.ok(rec.chargebackAt && rec.compensatedAt);
      assert.equal(rec.compensation.amountPaise, 30000, 'the hand-paid amount is recorded on the close');
      await expect(B, 'POST', '/payments/verify', 409, t.verify, 'TOPUP_BLOCKED');
      assert.equal(await credits(t.recordId), 0, 'still never credited');
      const report = await auditS6UncreditedWalletTopups() as any;
      assert.ok(report.blockedAfterLostDispute.some((x: any) => x.paymentTransactionId === t.recordId), 'listed as lost in a dispute');
      assert.ok(report.closedAsCompensated.some((x: any) => x.paymentTransactionId === t.recordId), 'and as closed as compensated');
      // A record an r9 chargeback already marked (chargebackAt, nothing taken) is charged back now.
      const C = await pharmacyWithToken('Marked Pharmacy', '9700000972');
      assert.equal((await call('ADMIN', 'POST', '/pharmacy-wallet/topup', { pharmacyId: C, amount: 500 }, { 'idempotency-key': 'r9b-hand-' + oid() })).status, 200);
      const m = await topupRecord(C, 300, 'created');
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${m.recordId}/close-compensated`, 200, { reason: 'paid by hand', requestKey: newKey() });
      await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(m.recordId) }, { $set: { chargebackAt: new Date() } });
      assert.equal((await expect('ADMIN', 'POST', `/admin/wallet-payments/${m.recordId}/chargeback`, 200, { reason: 'card dispute lost' })).json.data.replayed, true);
      const later = await recover(m.recordId);
      assert.deepEqual([later.json.data.compensated, later.json.data.entry.amountPaise, await balanceOf(C)], [true, 30000, 20000]);
    });

    // ───────────────────────── 2. The workspace choice keeps its ticket ─────────────────────────
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

    await check('2a the doctor rule answers 403 CLINIC_DOCTOR_NOT_VERIFIED (renamed)', async () => {
      const session = (await signIn(ownerPhone, SOLO)).accessToken;
      await setDoctor({ isVerified: false });
      try {
        await expect(session, 'GET', '/partner-workspace/me', 403, undefined, 'CLINIC_DOCTOR_NOT_VERIFIED');
        await assert.rejects(signIn(ownerPhone, SOLO), refusedWith('CLINIC_DOCTOR_NOT_VERIFIED'));
      } finally { await setDoctor({ isVerified: true }); }
    });

    await check('2b choosing the workspace closed by the doctor rule keeps the ticket; the other workspace opens with it', async () => {
      const { partner: lab } = await partners.createPartner({ kind: 'lab', name: 'Other Lab', contactPhone: nextPhone(), invoiceSeriesPrefix: 'OL',
        firstOwner: { phone: nextPhone(), name: 'Lab Owner' } } as any);
      const LAB = String(lab._id);
      await partners.verifyPartner(LAB, ADMIN);
      await MemberModel.create({ partnerId: LAB, phone: ownerPhone, name: 'Dr Solo at the lab', role: 'staff', permissions: ['bookings.view'], isActive: true } as never);
      await setDoctor({ isVerified: false });
      try {
        const first = await signIn(ownerPhone);
        await assert.rejects(auth.selectPartner({ ticket: first.selection!.ticket, partnerId: SOLO }), (e: any) => e?.status === 403);
        const opened = await auth.selectPartner({ ticket: first.selection!.ticket, partnerId: LAB });
        assert.ok(opened.accessToken, 'the same ticket opens the other workspace');
        await assert.rejects(auth.selectPartner({ ticket: first.selection!.ticket, partnerId: LAB }), (e: any) => e?.code === 'SELECTION_EXPIRED', 'then it is used');
      } finally { await setDoctor({ isVerified: true }); }
    });

    // ───────────────────────── 3, 4. Close answers ─────────────────────────
    await check('3 a refunded top-up is not closed as compensated (409 TOPUP_REFUNDED)', async () => {
      const B = await pharmacyWithToken('Refunded Pharmacy', '9700000973');
      const t = await topupRecord(B, 150, 'created');
      await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(t.recordId) }, { $set: { status: 'refunded' } });
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${t.recordId}/close-compensated`, 409, { reason: 'x', requestKey: newKey() }, 'TOPUP_REFUNDED');
      const rec = await PaymentRecordModel.findById(t.recordId).lean() as any;
      assert.deepEqual([rec.status, rec.compensatedAt], ['refunded', undefined]);
    });

    await check('4 a credit row whose pharmacy id was stored as the record\'s raw mixed-case string counts: 409 TOPUP_ALREADY_CREDITED, nothing closed', async () => {
      const B = await pharmacyWithToken('Mixed Case Pharmacy', '9700000974');
      const t = await topupRecord(B, 120, 'paid');
      const upper = B.toUpperCase();
      await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(t.recordId) }, { $set: { payerPharmacyId: upper, 'notes.pharmacyId': upper } });
      await PharmacyWalletTransactionModel.collection.insertOne({ pharmacyId: upper, walletId: oid(), transactionType: 'credit', amount: 120, amountPaise: 12000,
        balanceBefore: 0, balanceAfter: 120, status: 'completed', referenceType: 'wallet_recharge', referenceId: t.recordId, description: 'old credit',
        transactionDate: '20250101', signedAmountPaise: 12000 } as never);
      await expect('ADMIN', 'POST', `/admin/wallet-payments/${t.recordId}/close-compensated`, 409, { reason: 'x', requestKey: newKey() }, 'TOPUP_ALREADY_CREDITED');
      assert.equal((await PaymentRecordModel.findById(t.recordId).lean() as any).compensatedAt, undefined);
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
