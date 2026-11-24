/**
 * Assisted booking round 3a (ASSISTED_BOOKING_DESIGN.md §25.4, build record §25.12): the doctor wallet on the partner store.
 * A doctor tops up by Razorpay (order by request key in the doctor app; verify and reconcile on the existing /payments
 * routes, owned by `payerSpecialistId`; the check; the sweep: one credit under any race), never the customer wallet (DR5),
 * eligibility (DR3: an unverified doctor reads, tops up and spends nothing, but a paid top-up is credited and refunds
 * post), the switch, the index 503, the debit and refund for 3b, admin wallet tools (reads, top-up by key with the cap,
 * freeze), chargebacks (flag only) and close-compensated, reconciliation, and the pharmacy and lab wallets unchanged.
 * Real routes over HTTP (configureRoutes) on MongoDB; Razorpay is a stand-in.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r20_phase3a_check?directConnection=true' npx tsx test/assisted/r20-phase3a.integration.ts
 */
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
import { UserRepository } from '@/modules/user/repository';
import { BookingRepository } from '@/modules/bookings/repository';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { PharmacyWalletService } from '@/modules/pharmacyWallet/services';
import { postPharmacyMovementIn } from '@/modules/pharmacyWallet/ledger';
import { WalletTopupLotModel } from '@/modules/pharmacyWallet/model/lots';
import { adminTopup, walletTransaction } from '@/modules/pharmacyWallet/walletCore';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { PartnerService } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { resetIndexChecks } from '@/modules/common/utils/requiredIndex';
import { AssistedAlertModel, AssistedAuditEventModel } from '@/modules/assisted/model';
import { PartnerWalletEntryModel, PartnerWalletModel } from '@/modules/partnerWallets/model';
import { debitDoctorWalletIn, partnerStore, refundDoctorWalletIn } from '@/modules/partnerWallets/ledger';
import SpecialistModel from '@/modules/specialists/model';
import UserModel from '@/modules/user/model';
import { WalletModel } from '@/modules/wallet/model';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r20_phase3a_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
const DAY = 86_400_000;

/** Razorpay stand-in: orders are created; the payments it reports per order are set by each check. */
type GatewayPayment = { id: string; order_id: string; amount: number; currency: string; status: string; fee?: number };
const gateway: { payments: Record<string, GatewayPayment[]> } = { payments: {} };
const fakeRazorpay = {
  orders: { create: async (o: { amount: number; currency: string }) => ({ id: 'order_r20_' + oid(), amount: o.amount, currency: o.currency, status: 'created' }),
    fetchPayments: async (orderId: string) => ({ items: gateway.payments[orderId] ?? [] }) },
  payments: { fetch: async (id: string) => {
    const p = Object.values(gateway.payments).flat().find((x) => x.id === id);
    if (!p) throw Object.assign(new Error('The id provided does not exist'), { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR' } });
    return p;
  } },
};

// ── Services (tsx emits no decorator metadata: wired by hand) ──
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), getRazorpayClient: () => fakeRazorpay,
  getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
}) as unknown as PaymentService;
const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
Container.set(PartnerService, partnerSvc);
Container.set(CatalogueService, new CatalogueService(new CatalogueItemRepository()));
Container.set(LabBookingService, new LabBookingService(payments, new CouponService(new CouponRepository()), new WalletRepository()));
Container.set(PaymentService, payments);
Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
Container.set(BannerService, new BannerService(new BannerRepository()));
Container.set(PharmacyWalletService, Object.assign(Object.create(PharmacyWalletService.prototype), {
  walletRepo: new PharmacyWalletRepository(), txRepo: new PharmacyWalletTransactionRepository(), paymentService: payments }));

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
let phoneSeq = 7200000000;
const nextPhone = () => String(phoneSeq++);
let keySeq = 0;
const newKey = (p = 'r20') => `${p}-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;

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
  const flagsOn = () => { process.env.ASSISTED_BOOKING_ENABLED_DOCTOR = 'true'; process.env.ASSISTED_BOOKING_ENABLED_LAB = 'true'; process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true'; };
  flagsOn();

  try {
    // ── Doctors (verified D, a second verified D2, an unverified DU), a customer X, a pharmacy P, a lab L ──
    const D = oid(); const D2 = oid(); const DU = oid(); const X = oid(); const P = oid(); const ADMIN = oid();
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(D), name: 'Dr Asha Menon', email: 'asha@doc.test', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(D2), name: 'Dr Two', email: 'two@doc.test', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: true },
      { _id: new Types.ObjectId(DU), name: 'Dr New', email: 'new@doc.test', specialization: 'General Physician', consultationFee: 500, isActive: true, isVerified: false },
    ] as never);
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(X), userType: 'user', phone: '9600000901', name: 'Rina Das', otpVerified: true } as never);
    await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700000301', isActive: true, isVerified: true } as never);
    await walletTransaction((s) => postPharmacyMovementIn({ pharmacyId: P, kind: 'credit', amountPaise: 500_000, operationKey: `seed:${oid()}`,
      referenceType: 'seed', referenceId: oid(), description: 'seed' }, s));
    const lab = await partnerSvc.createPartner({ kind: 'lab', name: 'Metro Labs', legalName: 'Metro Labs', contactPhone: nextPhone(), invoiceSeriesPrefix: 'ML',
      firstOwner: { phone: nextPhone(), name: 'Owner' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZH' } as never);
    const L = String(lab.partner._id);
    await partnerSvc.verifyPartner(L, 'admin');

    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const tokens: Record<string, string> = {
      D: sign({ _id: D, specialistId: D, userType: 'specialist' }), D2: sign({ _id: D2, specialistId: D2, userType: 'specialist' }),
      DU: sign({ _id: DU, specialistId: DU, userType: 'specialist' }), X: sign({ _id: X, userType: 'user', authVersion: 0 }),
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
      LAB: sign({ _id: String(lab.owner._id), memberId: String(lab.owner._id), partnerId: L, userType: 'partner' }),
    };
    const call = async (who: string | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(base + url, { method, headers: { ...(who ? { authorization: `Bearer ${tokens[who] ?? who}` } : {}), 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any; try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, json, text };
    };
    const expect = async (who: string | null, method: string, url: string, status: number, body?: unknown, code?: string, headers: Record<string, string> = {}) => {
      const r = await call(who, method, url, body, headers);
      assert.equal(r.status, status, `${who} ${method} ${url}: ${r.status} ${r.text.slice(0, 400)}`);
      if (code) assert.equal(r.json.code, code, `${who} ${method} ${url}: ${r.text.slice(0, 400)}`);
      return r;
    };
    const ME = '/api/v1/specialists/me/assisted';
    const PAY = '/api/v1/payments';
    const AD = '/api/v1/admin';
    const wallet = async (id = D) => await PartnerWalletModel.findOne({ ownerKind: 'doctor', ownerId: id }).lean() as any;
    const entries = async (id = D) => await PartnerWalletEntryModel.find({ ownerKind: 'doctor', ownerId: id }).sort({ at: 1, _id: 1 }).lean() as any[];
    const topup = async (who: string, amountMinor: number, requestKey = newKey()) => (await expect(who, 'POST', `${ME}/wallet/topups`, 200, { amountMinor, requestKey })).json.data;
    const capture = (t: { paymentTransactionId: string; razorpayOrderId: string; amountMinor: number }, fee?: number) => {
      const payId = 'pay_' + oid().slice(-14);
      gateway.payments[t.razorpayOrderId] = [{ id: payId, order_id: t.razorpayOrderId, amount: t.amountMinor, currency: 'INR', status: 'captured', ...(fee !== undefined ? { fee } : {}) }];
      return { paymentTransactionId: t.paymentTransactionId, razorpayOrderId: t.razorpayOrderId, razorpayPaymentId: payId,
        razorpaySignature: crypto.createHmac('sha256', 'secret').update(`${t.razorpayOrderId}|${payId}`).digest('hex') };
    };
    const credits = (recordId: string, id = D) => PartnerWalletEntryModel.countDocuments({ ownerKind: 'doctor', ownerId: id, operationKey: `wallet_recharge:${recordId}` });
    const sweep = () => payments.sweepUnsettledBookingPayments(new Date(Date.now() + 11 * MIN), 1000);
    const customerWallets = () => WalletModel.countDocuments({ userId: { $in: [D, D2, DU] } });
    const pharmacyBefore = { wallet: await PharmacyWalletModel.findOne({ pharmacyId: P }).lean() as any, rows: await PharmacyWalletTransactionModel.countDocuments({}) };

    // ───────────────────────── Top-up ─────────────────────────
    await check('top-up: order by request key in the doctor app, verified on /payments, credited once with a lot (fee, 7 days); same key same order, other amount 409', async () => {
      const key = newKey();
      const t = await topup('D', 200_000, key);
      assert.equal(t.replayed, false); assert.equal(t.amountMinor, 200_000); assert.equal(t.razorpayKeyId, 'rzp_test_key');
      const rec = await PaymentRecordModel.findById(t.paymentTransactionId).lean() as any;
      assert.deepEqual([rec.context, rec.notes.flow, rec.payerSpecialistId, rec.userId, rec.payerUserId, rec.payerPartnerId, rec.payerPharmacyId],
        ['wallet_recharge', 'doctor_wallet_recharge', D, D, D, undefined, undefined]);
      assert.equal(rec.requestKey, `wallet_topup:doctor:${D}:${key}`); assert.match(rec.contextId, new RegExp(`^doctor_${D}_\\d+$`));
      const again = await topup('D', 200_000, key);
      assert.equal(again.paymentTransactionId, t.paymentTransactionId); assert.equal(again.replayed, true);
      await expect('D', 'POST', `${ME}/wallet/topups`, 409, { amountMinor: 200_001, requestKey: key }, 'IDEMPOTENCY_KEY_REUSED');
      const v = capture(t, 4720);
      const r = await expect('D', 'POST', `${PAY}/verify`, 200, v);
      assert.equal(r.json.data.context, 'wallet_recharge');
      assert.deepEqual(r.json.data.entity, { ...r.json.data.entity, balanceMinor: 200_000, withdrawableMinor: 200_000, frozen: false });
      assert.equal(r.json.data.entity.ownerId, undefined, 'the wallet view, not the stored document');
      await expect('D', 'POST', `${PAY}/verify`, 200, v);
      assert.equal(await credits(t.paymentTransactionId), 1);
      const lot = await WalletTopupLotModel.findOne({ paymentRecordId: t.paymentTransactionId }).lean() as any;
      assert.deepEqual([lot.walletRef.kind, lot.walletRef.id, lot.gatewayFeeMinor, lot.feeState], ['doctor', D, 4720, 'known']);
      const paidAt = new Date((await PaymentRecordModel.findById(t.paymentTransactionId).lean() as any).paidAt).getTime();
      assert.equal(new Date(lot.withdrawableAfter).getTime(), paidAt + 7 * DAY);
      const w = await expect('D', 'GET', `${ME}/wallet`, 200);
      assert.deepEqual(w.json.data, { ...w.json.data, balanceMinor: 200_000, withdrawableMinor: 200_000, receivableMinor: 0, frozen: false, isActive: true });
      const list = await expect('D', 'GET', `${ME}/wallet/entries`, 200);
      assert.deepEqual(list.json.data.map((e: any) => [e.kind, e.amountMinor, e.balanceAfterMinor]), [['credit', 200_000, 200_000]]);
      assert.equal(await customerWallets(), 0, 'no customer wallet for the doctor');
      const empty = await expect('D2', 'GET', `${ME}/wallet`, 200);
      assert.deepEqual([empty.json.data.balanceMinor, empty.json.data.updatedAt], [0, null]);
      assert.equal(await PartnerWalletModel.countDocuments({ ownerKind: 'doctor', ownerId: D2 }), 0, 'a read creates nothing');
      await expect('D', 'POST', `${ME}/wallet/topups`, 400, { amountMinor: 99, requestKey: newKey() }, 'VALIDATION_ERROR');
    });

    await check('race: verify, reconcile, the check and the sweep at once credit a doctor top-up exactly once', async () => {
      for (let round = 0; round < 3; round++) {
        const before = (await wallet()).balanceMinor;
        const t = await topup('D', 10_000 + round);
        const v = capture(t, 236);
        const out = await Promise.allSettled([call('D', 'POST', `${PAY}/verify`, v), call('D', 'POST', `${PAY}/reconcile`, { paymentTransactionId: t.paymentTransactionId }),
          call('D', 'POST', `${ME}/wallet/topups/${t.paymentTransactionId}/check`), sweep(), call('D', 'POST', `${PAY}/verify`, v)]);
        assert.ok(out.every((o) => o.status === 'fulfilled'));
        await expect('D', 'POST', `${ME}/wallet/topups/${t.paymentTransactionId}/check`, 200);
        assert.equal(await credits(t.paymentTransactionId), 1);
        assert.equal(await WalletTopupLotModel.countDocuments({ paymentRecordId: t.paymentTransactionId }), 1);
        assert.equal((await wallet()).balanceMinor, before + 10_000 + round);
      }
      assert.equal(await customerWallets(), 0);
    });

    await check('DR5: a failed doctor-wallet write fails the call and the sweep credits it later; never a customer wallet (also for a record naming no doctor)', async () => {
      const t = await topup('D', 7000);
      const v = capture(t);
      const original = PartnerWalletEntryModel.create.bind(PartnerWalletEntryModel);
      (PartnerWalletEntryModel as any).create = async () => { throw Object.assign(new Error('simulated write failure'), { code: 'SIMULATED' }); };
      try {
        const r = await call('D', 'POST', `${PAY}/verify`, v);
        assert.equal(r.status, 500, r.text);
        assert.equal(await credits(t.paymentTransactionId), 0);
        await sweep();
        assert.equal(await credits(t.paymentTransactionId), 0);
      } finally { (PartnerWalletEntryModel as any).create = original; }
      assert.equal(await customerWallets(), 0, 'no customer wallet was made or credited');
      assert.equal((await PaymentRecordModel.findById(t.paymentTransactionId).lean() as any).walletCreditedAt, undefined, 'the claim rolled back');
      await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(t.paymentTransactionId) }, { $unset: { recoveryNextAt: 1 } });
      await sweep();
      assert.equal(await credits(t.paymentTransactionId), 1, 'the sweep credited it');
      // A doctor-flow record that names no doctor (here: paid by the customer X's id) is refused, never credited to X.
      const orderId = 'order_nodoc_' + oid();
      const orphan = await PaymentRecordModel.create({ userId: X, payerUserId: X, context: 'wallet_recharge', contextId: `doctor_x_1`, baseAmount: 30, discountAmount: 0,
        finalAmount: 30, baseAmountPaise: 3000, finalAmountPaise: 3000, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: orderId, status: 'created',
        notes: { flow: 'doctor_wallet_recharge' } } as never);
      gateway.payments[orderId] = [{ id: 'pay_' + oid().slice(-14), order_id: orderId, amount: 3000, currency: 'INR', status: 'captured' }];
      await expect('X', 'POST', `${PAY}/reconcile`, 409, { paymentTransactionId: String(orphan._id) }, 'TOPUP_OWNER_MISSING');
      assert.equal(await WalletModel.countDocuments({ userId: X, balance: { $gt: 0 } }), 0, 'the customer wallet is never credited');
      const listed = await expect('ADMIN', 'GET', `${AD}/wallet-recharges/uncredited`, 200);
      assert.ok(listed.json.data.some((x: any) => x.paymentTransactionId === String(orphan._id) && x.state === 'paid_no_owner'));
      await PaymentRecordModel.deleteOne({ _id: orphan._id });
    });

    await check('scope: another doctor, a pharmacy and a customer get the one 404 on /payments; an admin may reconcile; a partner token is refused', async () => {
      const t = await topup('D', 2000);
      const v = capture(t);
      const bodies: string[] = [];
      for (const who of ['D2', 'P', 'X']) {
        bodies.push((await expect(who, 'POST', `${PAY}/verify`, 404, v, 'PAYMENT_RECORD_NOT_FOUND')).text);
        await expect(who, 'POST', `${PAY}/reconcile`, 404, { paymentTransactionId: t.paymentTransactionId }, 'PAYMENT_RECORD_NOT_FOUND');
      }
      assert.equal(new Set(bodies).size, 1);
      await expect('D2', 'POST', `${ME}/wallet/topups/${t.paymentTransactionId}/check`, 404, undefined, 'PAYMENT_RECORD_NOT_FOUND');
      await expect('LAB', 'POST', `${PAY}/verify`, 403, v, 'ROLE_NOT_ALLOWED');
      await expect('P', 'GET', `${ME}/wallet`, 403, undefined, 'FORBIDDEN');
      assert.equal(await credits(t.paymentTransactionId), 0);
      const a = await expect('ADMIN', 'POST', `${PAY}/reconcile`, 200, { paymentTransactionId: t.paymentTransactionId });
      assert.equal(a.json.data.state, 'paid'); assert.equal(a.json.data.entity.balanceMinor, (await wallet()).balanceMinor);
      assert.equal(await credits(t.paymentTransactionId), 1);
    });

    await check('DR3: an unverified doctor cannot read, top up or spend; a top-up it already paid is credited (state only); refunds post; re-verification restores reads', async () => {
      // DU paid a top-up while verified, then lost verification before the credit.
      await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(DU) }, { $set: { isVerified: true } });
      const t = await topup('DU', 5000);
      const v = capture(t);
      await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(DU) }, { $set: { isVerified: false } });
      await expect('DU', 'GET', `${ME}/wallet`, 403, undefined, 'SPECIALIST_NOT_VERIFIED');
      await expect('DU', 'GET', `${ME}/wallet/entries`, 403, undefined, 'SPECIALIST_NOT_VERIFIED');
      await expect('DU', 'POST', `${ME}/wallet/topups`, 403, { amountMinor: 1000, requestKey: newKey() }, 'SPECIALIST_NOT_VERIFIED');
      const c = await expect('DU', 'POST', `${ME}/wallet/topups/${t.paymentTransactionId}/check`, 200);
      assert.deepEqual(c.json.data, { state: 'credited' }, 'credited; no wallet for an ineligible doctor');
      const vr = await expect('DU', 'POST', `${PAY}/verify`, 200, v);
      assert.deepEqual(vr.json.data.entity, { state: 'credited' });
      assert.equal((await wallet(DU)).balanceMinor, 5000);
      await assert.rejects(walletTransaction((s) => debitDoctorWalletIn({ specialistId: DU, amountMinor: 100, operationKey: `du:${oid()}:debit`,
        referenceType: 'test', referenceId: oid(), description: 'x' }, s)), (e: any) => e.code === 'SPECIALIST_NOT_VERIFIED');
      await walletTransaction((s) => refundDoctorWalletIn({ specialistId: DU, amountMinor: 100, operationKey: `du:${oid()}:refund`,
        referenceType: 'test', referenceId: oid(), description: 'Refund' }, s));
      assert.equal((await wallet(DU)).balanceMinor, 5100, 'a refund always posts');
      await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(DU) }, { $set: { isVerified: true } });
      assert.equal((await expect('DU', 'GET', `${ME}/wallet`, 200)).json.data.balanceMinor, 5100);
    });

    await check('switch off: a new top-up answers 503; verify, the check and the sweep still credit (without a lot); reads work', async () => {
      const t = await topup('D', 3000);
      const v = capture(t);
      const before = await wallet();
      delete process.env.ASSISTED_BOOKING_ENABLED_DOCTOR;
      try {
        await expect('D', 'POST', `${ME}/wallet/topups`, 503, { amountMinor: 1000, requestKey: newKey() }, 'ASSISTED_BOOKING_DISABLED');
        await expect('D', 'POST', `${PAY}/verify`, 200, v);
        await expect('D', 'GET', `${ME}/wallet`, 200);
        const after = await wallet();
        assert.equal(after.balanceMinor, before.balanceMinor + 3000); assert.equal(after.withdrawableMinor, before.withdrawableMinor, 'no lot while off');
        assert.equal(await WalletTopupLotModel.countDocuments({ paymentRecordId: t.paymentTransactionId }), 0);
      } finally { flagsOn(); }
    });

    await check('index 503: without the entry unique index a new top-up and a credit answer 503 INDEXES_OUTDATED; the sweep credits once it is back', async () => {
      const t = await topup('D', 4000);
      const v = capture(t);
      await PartnerWalletEntryModel.collection.dropIndex('walletId_1_operationKey_1');
      resetIndexChecks();
      try {
        await expect('D', 'POST', `${ME}/wallet/topups`, 503, { amountMinor: 1000, requestKey: newKey() }, 'INDEXES_OUTDATED');
        await expect('D', 'POST', `${PAY}/verify`, 503, v, 'INDEXES_OUTDATED');
        assert.equal(await credits(t.paymentTransactionId), 0);
        assert.equal(await customerWallets(), 0);
      } finally {
        await PartnerWalletEntryModel.syncIndexes();
        resetIndexChecks();
      }
      await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(t.paymentTransactionId) }, { $unset: { recoveryNextAt: 1 } });
      await sweep();
      assert.equal(await credits(t.paymentTransactionId), 1);
    });

    // ───────────────────────── Ledger for 3b ─────────────────────────
    const debit = (amountMinor: number, key: string, id = D) => walletTransaction((s) => debitDoctorWalletIn({ specialistId: id, amountMinor, operationKey: `${key}:debit`,
      referenceType: 'test_booking', referenceId: key, description: 'Test booking' }, s));
    const refund = (amountMinor: number, key: string, restore?: { lotId: string; amountPaise: number }[], id = D) =>
      walletTransaction((s) => refundDoctorWalletIn({ specialistId: id, amountMinor, operationKey: `${key}:refund`, referenceType: 'test_booking', referenceId: `${key}:refund`,
        description: 'Refund', ...(restore ? { restore } : {}) }, s));

    await check('debit: two spends beyond the balance at once — one succeeds, never below zero; a refund posts once and restores the lots', async () => {
      const before = await wallet();
      const half = Math.floor(before.balanceMinor / 2) + 1;
      const out = await Promise.allSettled([debit(half, `a-${oid()}`), debit(half, `b-${oid()}`)]);
      assert.equal(out.filter((o) => o.status === 'fulfilled').length, 1);
      assert.equal((out.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason.code, 'INSUFFICIENT_BALANCE');
      const mid = await wallet();
      assert.equal(mid.balanceMinor, before.balanceMinor - half); assert.ok(mid.balanceMinor >= 0);
      const d = (out.find((o) => o.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
      const key = String(d.entry.operationKey).replace(/:debit$/, '');
      const twice = await Promise.all([refund(half, key, d.entry.lotAllocations), refund(half, key, d.entry.lotAllocations)]);
      assert.equal(twice.filter((x) => !x.replayed).length, 1);
      const after = await wallet();
      assert.equal(after.balanceMinor, before.balanceMinor); assert.equal(after.withdrawableMinor, before.withdrawableMinor);
    });

    await check('frozen or inactive wallet: a debit is refused (409), a credit posts; admin freeze audited (orgKind doctor)', async () => {
      await expect('ADMIN', 'PUT', `${AD}/doctors/${D}/wallet/freeze`, 200, { frozen: true, reason: 'Checking' });
      await assert.rejects(debit(100, `f-${oid()}`), (e: any) => e.code === 'WALLET_FROZEN');
      const before = (await wallet()).balanceMinor;
      await refund(100, `f-${oid()}`);
      assert.equal((await wallet()).balanceMinor, before + 100);
      assert.equal((await expect('D', 'GET', `${ME}/wallet`, 200)).json.data.frozen, true);
      await expect('ADMIN', 'PUT', `${AD}/doctors/${D}/wallet/freeze`, 200, { frozen: false, reason: 'Done' });
      await PartnerWalletModel.updateOne({ ownerKind: 'doctor', ownerId: D }, { $set: { isActive: false } });
      try {
        await assert.rejects(debit(100, `i-${oid()}`), (e: any) => e.code === 'WALLET_INACTIVE');
        await refund(100, `i-${oid()}`);
      } finally { await PartnerWalletModel.updateOne({ ownerKind: 'doctor', ownerId: D }, { $set: { isActive: true } }); }
      await debit(100, `ok-${oid()}`);
      assert.deepEqual((await AssistedAuditEventModel.find({ orgKind: 'doctor', orgId: D, action: { $in: ['wallet.frozen', 'wallet.unfrozen'] } }).lean())
        .map((a) => a.action).sort(), ['wallet.frozen', 'wallet.unfrozen']);
    });

    // ───────────────────────── Admin ─────────────────────────
    await check('admin: reads, top-up by Idempotency-Key (₹2,00,000 cap, replay once, other content 409, bad key 400), by-key; one 404; admins only; tools switch', async () => {
      const url = `${AD}/doctors/${D2}/wallet/topup`;
      const key = newKey('adm');
      await expect('ADMIN', 'POST', url, 400, { amountMinor: 1000 }, 'IDEMPOTENCY_KEY_REQUIRED');
      await expect('ADMIN', 'POST', url, 400, { amountMinor: 1000 }, 'VALIDATION_ERROR', { 'idempotency-key': 'bad key!' });
      await expect('ADMIN', 'POST', url, 400, { amountMinor: 20_000_001 }, 'VALIDATION_ERROR', { 'idempotency-key': key });
      const a = await expect('ADMIN', 'POST', url, 200, { amountMinor: 20_000_000, notes: 'Goodwill' }, undefined, { 'idempotency-key': key });
      assert.equal(a.json.data.balanceMinor, 20_000_000); assert.equal(a.json.data.withdrawableMinor, 0, 'never withdrawable');
      await expect('ADMIN', 'POST', url, 200, { amountMinor: 20_000_000, notes: 'Goodwill' }, undefined, { 'idempotency-key': key });
      assert.equal((await wallet(D2)).balanceMinor, 20_000_000);
      await expect('ADMIN', 'POST', url, 409, { amountMinor: 1000, notes: 'Goodwill' }, 'IDEMPOTENCY_KEY_REUSED', { 'idempotency-key': key });
      assert.equal((await expect('ADMIN', 'GET', `${AD}/doctors/${D2}/wallet/topups/by-key/${key}`, 200)).json.data.state, 'credited');
      assert.equal((await expect('ADMIN', 'GET', `${AD}/doctors/${D}/wallet/topups/by-key/${key}`, 200)).json.data.state, 'not_found');
      assert.equal(await AssistedAuditEventModel.countDocuments({ orgKind: 'doctor', orgId: D2, action: 'wallet.admin_topup' }), 1);
      const r = await expect('ADMIN', 'GET', `${AD}/doctors/${D}/wallet`, 200);
      assert.equal(r.json.data.exists, true);
      const ents = await expect('ADMIN', 'GET', `${AD}/doctors/${D}/wallet/entries?limit=2`, 200);
      assert.equal(ents.json.data.length, 2); assert.ok(ents.json.pagination.nextCursor); assert.ok(ents.json.data[0].operationKey);
      assert.ok((await expect('ADMIN', 'GET', `${AD}/doctors/${D}/wallet/lots`, 200)).json.data.every((l: any) => l.walletRef.kind === 'doctor' && l.walletRef.id === D));
      const nf: string[] = [];
      for (const id of [P, L, oid(), 'xyz']) nf.push((await expect('ADMIN', 'GET', `${AD}/doctors/${id}/wallet`, 404, undefined, 'SPECIALIST_NOT_FOUND')).text);
      assert.equal(new Set(nf).size, 1);
      await expect('ADMIN', 'GET', `${AD}/labs/${D}/wallet`, 404, undefined, 'LAB_NOT_FOUND');
      await expect('D', 'GET', `${AD}/doctors/${D}/wallet`, 403);
      delete process.env.ASSISTED_ADMIN_TOOLS_ENABLED;
      try {
        await expect('ADMIN', 'POST', url, 503, { amountMinor: 1000 }, 'ASSISTED_BOOKING_DISABLED', { 'idempotency-key': newKey('adm') });
        await expect('ADMIN', 'GET', `${AD}/doctors/${D}/wallet`, 200);
      } finally { flagsOn(); }
    });

    await check('chargeback on doctor top-ups: credited → flagged only (by payment and by lot, once); never credited → blocked, then never credited', async () => {
      const t = await topup('D', 50_000);
      await expect('D', 'POST', `${PAY}/verify`, 200, capture(t, 1180));
      const before = await wallet();
      const r = await expect('ADMIN', 'POST', `${AD}/wallet-payments/${t.razorpayOrderId}/chargeback`, 200, { reason: 'Lost' });
      assert.deepEqual([r.json.data.flagged, r.json.data.walletKind, r.json.data.specialistId, r.json.data.replayed], [true, 'doctor', D, false]);
      const after = await wallet();
      assert.equal(after.balanceMinor, before.balanceMinor); assert.equal(after.frozen, false); assert.equal(after.receivableMinor, 0);
      assert.equal(after.withdrawableMinor, before.withdrawableMinor - 50_000);
      const lot = await WalletTopupLotModel.findOne({ paymentRecordId: t.paymentTransactionId }).lean() as any;
      assert.equal((await expect('ADMIN', 'POST', `${AD}/wallet-lots/${String(lot._id)}/chargeback`, 200, { reason: 'Again' })).json.data.replayed, true);
      assert.equal(await AssistedAuditEventModel.countDocuments({ orgKind: 'doctor', orgId: D, action: 'wallet.chargeback' }), 1);
      const u = await topup('D', 6000);
      const v = capture(u);
      const b = await expect('ADMIN', 'POST', `${AD}/wallet-payments/${u.paymentTransactionId}/chargeback`, 200, { reason: 'Lost before verify' });
      assert.equal(b.json.data.blockedUncredited, true);
      await expect('D', 'POST', `${PAY}/verify`, 409, v, 'TOPUP_BLOCKED');
      await expect('D', 'POST', `${ME}/wallet/topups/${u.paymentTransactionId}/check`, 409, undefined, 'TOPUP_BLOCKED');
      await sweep();
      assert.equal(await credits(u.paymentTransactionId), 0);
    });

    await check('close-compensated on a doctor top-up: closed once, never credited; a credited one 409; by-key names the doctor', async () => {
      const t = await topup('D', 8000);
      const v = capture(t);
      const key = newKey('close');
      const c = await expect('ADMIN', 'POST', `${AD}/wallet-payments/${t.paymentTransactionId}/close-compensated`, 200, { reason: 'Paid by hand', requestKey: key });
      assert.deepEqual([c.json.data.closed, c.json.data.walletKind, c.json.data.specialistId, c.json.data.amountPaise], [true, 'doctor', D, 8000]);
      assert.match(c.json.data.message, /paid to the doctor/);
      await expect('D', 'POST', `${PAY}/verify`, 409, v, 'TOPUP_BLOCKED');
      await sweep();
      assert.equal(await credits(t.paymentTransactionId), 0);
      assert.equal((await expect('ADMIN', 'GET', `${AD}/wallet-payments/close-compensated/by-key/${key}`, 200)).json.data.specialistId, D);
      const t2 = await topup('D', 3000);
      await expect('D', 'POST', `${PAY}/verify`, 200, capture(t2));
      await expect('ADMIN', 'POST', `${AD}/wallet-payments/${t2.paymentTransactionId}/close-compensated`, 409, { reason: 'x', requestKey: newKey('close') }, 'TOPUP_ALREADY_CREDITED');
    });

    // ───────────────────────── Reconciliation and the other wallets ─────────────────────────
    await check('reconciliation: doctor wallets reconcile; a paid doctor top-up never credited is listed; a tampered entry is reported', async () => {
      const clean = await expect('ADMIN', 'GET', `${AD}/assisted/reconciliation?full=true`, 200);
      assert.deepEqual(clean.json.data.checks.mismatches.filter((m: any) => m.check.startsWith('partner_wallet')), []);
      const lost = await PaymentRecordModel.create({ userId: D, payerUserId: D, payerSpecialistId: D, context: 'wallet_recharge', contextId: `doctor_${D}_1`,
        baseAmount: 10, discountAmount: 0, finalAmount: 10, baseAmountPaise: 1000, finalAmountPaise: 1000, currency: 'INR', paymentGateway: 'razorpay',
        razorpayOrderId: 'order_lost_' + oid(), status: 'paid', isProcessed: false, notes: { flow: 'doctor_wallet_recharge', specialistId: D } } as never);
      const listed = await expect('ADMIN', 'GET', `${AD}/wallet-recharges/uncredited`, 200);
      assert.ok(listed.json.data.some((x: any) => x.paymentTransactionId === String(lost._id) && x.walletKind === 'doctor' && x.specialistId === D));
      const e = await PartnerWalletEntryModel.findOne({ ownerKind: 'doctor', ownerId: D }).lean();
      await PartnerWalletEntryModel.updateOne({ _id: e!._id }, { $inc: { amountMinor: 1 } });
      try {
        const bad = await expect('ADMIN', 'GET', `${AD}/assisted/reconciliation?full=true`, 200);
        assert.ok(bad.json.data.checks.mismatches.some((m: any) => m.check === 'partner_wallet_balance' && m.ref === `doctor:${D}`));
      } finally { await PartnerWalletEntryModel.updateOne({ _id: e!._id }, { $inc: { amountMinor: -1 } }); }
      await PaymentRecordModel.deleteOne({ _id: lost._id });
    });

    await check('pharmacy and lab wallets unchanged: no movement here touched them; a pharmacy top-up still credits the pharmacy store only', async () => {
      const now = await PharmacyWalletModel.findOne({ pharmacyId: P }).lean() as any;
      assert.equal(now.balancePaise, pharmacyBefore.wallet.balancePaise); assert.equal(now.version, pharmacyBefore.wallet.version);
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({}), pharmacyBefore.rows);
      assert.equal(await PartnerWalletModel.countDocuments({ ownerKind: 'lab' }), 0);
      const orderId = 'order_ph_' + oid();
      const rec = await PaymentRecordModel.create({ userId: P, payerUserId: P, payerPharmacyId: P, context: 'wallet_recharge', contextId: `pharmacy_${P}_2`,
        baseAmount: 25, discountAmount: 0, finalAmount: 25, baseAmountPaise: 2500, finalAmountPaise: 2500, currency: 'INR', paymentGateway: 'razorpay',
        razorpayOrderId: orderId, status: 'created', notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: P } } as never);
      gateway.payments[orderId] = [{ id: 'pay_' + oid().slice(-14), order_id: orderId, amount: 2500, currency: 'INR', status: 'captured', fee: 59 }];
      const doctorEntries = await PartnerWalletEntryModel.countDocuments({});
      const c = await expect('P', 'POST', `/api/v1/pharmacy-wallet/topups/${String(rec._id)}/check`, 200);
      assert.equal(c.json.data.state, 'credited'); assert.equal(c.json.data.wallet.balancePaise, now.balancePaise + 2500);
      assert.equal(await PartnerWalletEntryModel.countDocuments({}), doctorEntries);
      await expect('D', 'POST', `${ME}/wallet/topups/${String(rec._id)}/check`, 404, undefined, 'PAYMENT_RECORD_NOT_FOUND');
      assert.equal(await customerWallets(), 0);
    });

    await check('review of 2d (3): every admin top-up is at most ₹2,00,000 on the server — the pharmacy admin route too; the shared function refuses more', async () => {
      const P2 = oid();
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(P2), name: 'Cap Pharmacy', phone: '9700000399', isActive: true, isVerified: true } as never);
      const url = '/api/v1/pharmacy-wallet/topup';
      await expect('ADMIN', 'POST', url, 400, { pharmacyId: P2, amount: 200000.01 }, 'VALIDATION_ERROR', { 'idempotency-key': newKey('cap') });
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: P2 }), 0, 'nothing credited');
      const ok = await expect('ADMIN', 'POST', url, 200, { pharmacyId: P2, amount: 200000 }, undefined, { 'idempotency-key': newKey('cap') });
      assert.equal(ok.json.data.balancePaise, 20_000_000, 'the cap is inclusive');
      // The pharmacy's own Razorpay top-up is not an admin top-up: its body schema is unchanged.
      for (const store of [partnerStore('doctor', D2), partnerStore('lab', L)]) {
        await assert.rejects(adminTopup(store, { key: newKey('cap'), amountMinor: 20_000_001, adminId: ADMIN }), (e: any) => e.status === 400 && e.code === 'VALIDATION_ERROR');
      }
    });
  } finally {
    server.close();
    console.log(`\n${passed} checks passed, ${failed.length} failed`);
    if (failed.length) console.log('failed:', failed.join(' | '));
    await mongoose.disconnect();
    process.exit(failed.length ? 1 : 0);
  }
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
