/**
 * Assisted booking round 2d (ASSISTED_BOOKING_DESIGN.md §24.7, §24.13): the lab wallet. A lab tops up by Razorpay in the
 * partner workspace (order by request key, verify, reconcile, "check my top-up", the recovery sweep: one credit under any
 * race), the O2 limits, admin top-up / freeze / by-key, chargebacks (flag only, owner C4) and close-compensated through
 * the shared admin routes, the lab debit and refund (never below zero, refund once, freeze blocks spending only), the
 * scope (another lab, a pharmacy, a clinic), the switch, the index 503, reconciliation, and the pharmacy wallet unchanged.
 * Real routes over HTTP (configureRoutes) on MongoDB; Razorpay is a stand-in.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r13_phase2d_check?directConnection=true' npx tsx test/assisted/r13-phase2d.integration.ts
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
import { walletTransaction } from '@/modules/pharmacyWallet/walletCore';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
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
import { debitLabWalletIn, refundLabWalletIn } from '@/modules/partnerWallets/ledger';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r13_phase2d_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
const DAY = 86_400_000;

/** Razorpay stand-in: orders are created; the payments it reports per order are set by each check. */
type GatewayPayment = { id: string; order_id: string; amount: number; currency: string; status: string; fee?: number };
const gateway: { payments: Record<string, GatewayPayment[]> } = { payments: {} };
const fakeRazorpay = {
  orders: { create: async (o: { amount: number; currency: string }) => ({ id: 'order_r13_' + oid(), amount: o.amount, currency: o.currency, status: 'created' }),
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
let phoneSeq = 7130000000;
const nextPhone = () => String(phoneSeq++);
let keySeq = 0;
const newKey = (p = 'r13') => `${p}-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;

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
  const flagsOn = () => { process.env.ASSISTED_BOOKING_ENABLED_LAB = 'true'; process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true'; };
  flagsOn();

  try {
    // ── Labs: a verified lab (owner, wallet staff, a reader, a member without wallet rights), a second lab, an unverified lab, a clinic ──
    const { partner, owner } = await partnerSvc.createPartner({ kind: 'lab', name: 'Metro Labs', legalName: 'Metro Labs', contactPhone: nextPhone(),
      invoiceSeriesPrefix: 'ML', firstOwner: { phone: nextPhone(), name: 'Owner' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZH' } as never);
    const L = String(partner._id);
    await partnerSvc.verifyPartner(L, 'admin');
    const ownActor = { memberId: String(owner._id), partnerId: L, role: 'owner' as const, permissions: [], branchIds: [] };
    const manager = await partnerSvc.addMember(ownActor as never, { phone: nextPhone(), name: 'Cashier', role: 'staff', permissions: ['wallet.manage'] } as never);
    const reader = await partnerSvc.addMember(ownActor as never, { phone: nextPhone(), name: 'Reader', role: 'staff', permissions: ['wallet.view'] } as never);
    const desk = await partnerSvc.addMember(ownActor as never, { phone: nextPhone(), name: 'Desk', role: 'staff', permissions: ['bookings.view'] } as never);
    const second = await partnerSvc.createPartner({ kind: 'lab', name: 'Far Labs', legalName: 'Far Labs', contactPhone: nextPhone(), invoiceSeriesPrefix: 'FL',
      firstOwner: { phone: nextPhone(), name: 'Owner Two' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZX' } as never);
    const L2 = String(second.partner._id);
    await partnerSvc.verifyPartner(L2, 'admin');
    const unverified = await partnerSvc.createPartner({ kind: 'lab', name: 'New Labs', legalName: 'New Labs', contactPhone: nextPhone(), invoiceSeriesPrefix: 'NL',
      firstOwner: { phone: nextPhone(), name: 'Owner Three' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZY' } as never);
    const LU = String(unverified.partner._id);
    const third = await partnerSvc.createPartner({ kind: 'lab', name: 'Hill Labs', legalName: 'Hill Labs', contactPhone: nextPhone(), invoiceSeriesPrefix: 'HL',
      firstOwner: { phone: nextPhone(), name: 'Owner Four' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZZ' } as never);
    const L3 = String(third.partner._id);
    await partnerSvc.verifyPartner(L3, 'admin');
    const CL = oid(); const CLM = oid();
    await PartnerModel.collection.insertOne({ _id: new Types.ObjectId(CL), kind: 'clinic', name: 'A Clinic', isActive: true, verification: { state: 'verified' },
      invoiceSeries: { prefix: 'AC' }, activeOwnerCount: 1, contact: { phone: nextPhone() } } as never);
    await MemberModel.collection.insertOne({ _id: new Types.ObjectId(CLM), partnerId: CL, phone: nextPhone(), name: 'Clinic Owner', role: 'owner',
      permissions: [], branchIds: [], isActive: true } as never);
    const P = oid(); const ADMIN = oid();
    await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700000301', isActive: true, isVerified: true } as never);
    await walletTransaction((s) => postPharmacyMovementIn({ pharmacyId: P, kind: 'credit', amountPaise: 500_000, operationKey: `seed:${oid()}`,
      referenceType: 'seed', referenceId: oid(), description: 'seed' }, s));

    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const member = (m: { _id?: unknown }, partnerId: string) => sign({ _id: String(m._id), memberId: String(m._id), partnerId, userType: 'partner' });
    const tokens: Record<string, string> = {
      OWNER: member(owner, L), MANAGER: member(manager, L), READER: member(reader, L), DESK: member(desk, L), LAB2: member(second.owner, L2),
      UNVERIFIED: member(unverified.owner, LU), CLINIC: sign({ _id: CLM, memberId: CLM, partnerId: CL, userType: 'partner' }),
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
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
    const WS = '/api/v1/partner-workspace/assisted';
    const AD = '/api/v1/admin';
    const wallet = async (partnerId = L) => await PartnerWalletModel.findOne({ ownerKind: 'lab', ownerId: partnerId }).lean() as any;
    const entries = async (partnerId = L) => await PartnerWalletEntryModel.find({ ownerKind: 'lab', ownerId: partnerId }).sort({ at: 1, _id: 1 }).lean() as any[];
    const topup = async (who: string, amountMinor: number, requestKey = newKey()) => (await expect(who, 'POST', `${WS}/wallet/topups`, 200, { amountMinor, requestKey })).json.data;
    /** Razorpay reports a capture on the order; returns the verify body (signed as Checkout signs it). */
    const capture = (t: { paymentTransactionId: string; razorpayOrderId: string; amountMinor: number }, fee?: number) => {
      const payId = 'pay_' + oid().slice(-14);
      gateway.payments[t.razorpayOrderId] = [{ id: payId, order_id: t.razorpayOrderId, amount: t.amountMinor, currency: 'INR', status: 'captured', ...(fee !== undefined ? { fee } : {}) }];
      return { paymentTransactionId: t.paymentTransactionId, razorpayOrderId: t.razorpayOrderId, razorpayPaymentId: payId,
        razorpaySignature: crypto.createHmac('sha256', 'secret').update(`${t.razorpayOrderId}|${payId}`).digest('hex') };
    };
    const credits = (recordId: string, partnerId = L) => PartnerWalletEntryModel.countDocuments({ ownerKind: 'lab', ownerId: partnerId, operationKey: `wallet_recharge:${recordId}` });
    const sweep = () => payments.sweepUnsettledBookingPayments(new Date(Date.now() + 11 * MIN), 1000);
    const pharmacyBefore = { wallet: await PharmacyWalletModel.findOne({ pharmacyId: P }).lean() as any, rows: await PharmacyWalletTransactionModel.countDocuments({}) };

    // ───────────────────────── Top-up by card ─────────────────────────
    await check('top-up: order by request key, verified by another member, credited once with a lot holding the fee (withdrawable 7 days after payment)', async () => {
      const t = await topup('OWNER', 200_000);
      assert.equal(t.replayed, false); assert.equal(t.amountMinor, 200_000); assert.equal(t.razorpayKeyId, 'rzp_test_key'); assert.equal(t.state, 'awaiting_payment');
      const rec = await PaymentRecordModel.findById(t.paymentTransactionId).lean() as any;
      assert.equal(rec.context, 'wallet_recharge'); assert.equal(rec.notes.flow, 'lab_wallet_recharge'); assert.equal(rec.payerPartnerId, L);
      assert.equal(rec.payerMemberId, String(owner._id)); assert.equal(rec.payerPharmacyId, undefined);
      assert.ok(String(rec.requestKey).startsWith(`wallet_topup:lab:${L}:${String(owner._id).toLowerCase()}:`));
      const v = capture(t, 4720);
      const r = await expect('MANAGER', 'POST', `${WS}/payments/verify`, 200, v);
      assert.equal(r.json.data.context, 'wallet_recharge'); assert.equal(r.json.data.paymentRecord.status, 'paid'); assert.equal(r.json.data.paymentRecord.credited, true);
      assert.equal(r.json.data.entity.balanceMinor, 200_000); assert.equal(r.json.data.entity.withdrawableMinor, 200_000);
      assert.equal(r.json.data.paymentRecord.razorpaySignature, undefined, 'no signature in the answer');
      await expect('MANAGER', 'POST', `${WS}/payments/verify`, 200, v);
      assert.equal(await credits(t.paymentTransactionId), 1);
      const lot = await WalletTopupLotModel.findOne({ paymentRecordId: t.paymentTransactionId }).lean() as any;
      assert.deepEqual([lot.walletRef.kind, lot.walletRef.id, lot.gatewayFeeMinor, lot.feeState, lot.remainingMinor], ['lab', L, 4720, 'known', 200_000]);
      const paidAt = new Date((await PaymentRecordModel.findById(t.paymentTransactionId).lean() as any).paidAt).getTime();
      assert.equal(new Date(lot.withdrawableAfter).getTime(), paidAt + 7 * DAY, 'O2: card money is withdrawable 7 days after payment');
      const w = await expect('READER', 'GET', `${WS}/wallet`, 200);
      assert.deepEqual(w.json.data, { ...w.json.data, balanceMinor: 200_000, withdrawableMinor: 200_000, receivableMinor: 0, frozen: false, isActive: true });
      const list = await expect('READER', 'GET', `${WS}/wallet/entries`, 200);
      assert.deepEqual(list.json.data.map((e: any) => [e.kind, e.amountMinor, e.balanceAfterMinor, e.referenceType]), [['credit', 200_000, 200_000, 'wallet_recharge']]);
      const history = await expect('READER', 'GET', `${WS}/wallet/topups`, 200);
      assert.equal(history.json.data.find((x: any) => x.paymentTransactionId === t.paymentTransactionId).state, 'credited');
    });

    await check('race: verify, reconcile, the check and the sweep at once credit a top-up exactly once', async () => {
      for (let round = 0; round < 3; round++) {
        const before = (await wallet()).balanceMinor;
        const t = await topup('MANAGER', 10_000 + round);
        const v = capture(t, 236);
        const out = await Promise.allSettled([
          call('MANAGER', 'POST', `${WS}/payments/verify`, v), call('OWNER', 'POST', `${WS}/payments/reconcile`, { paymentTransactionId: t.paymentTransactionId }),
          call('READER', 'POST', `${WS}/wallet/topups/${t.paymentTransactionId}/check`), sweep(), call('MANAGER', 'POST', `${WS}/payments/verify`, v),
        ]);
        assert.ok(out.every((o) => o.status === 'fulfilled'));
        await expect('READER', 'POST', `${WS}/wallet/topups/${t.paymentTransactionId}/check`, 200);
        assert.equal(await credits(t.paymentTransactionId), 1, 'one credit');
        assert.equal(await WalletTopupLotModel.countDocuments({ paymentRecordId: t.paymentTransactionId }), 1, 'one lot');
        assert.equal((await wallet()).balanceMinor, before + 10_000 + round);
      }
    });

    await check('a captured top-up whose verify never came is recovered by the sweep (with the switch off: credited, without a lot)', async () => {
      const t = await topup('OWNER', 30_000);
      capture(t, 708);
      const before = await wallet();
      delete process.env.ASSISTED_BOOKING_ENABLED_LAB;
      try {
        await sweep();
        assert.equal(await credits(t.paymentTransactionId), 1, 'credited by the sweep');
        const after = await wallet();
        assert.equal(after.balanceMinor, before.balanceMinor + 30_000);
        assert.equal(after.withdrawableMinor, before.withdrawableMinor, 'switch off: non-withdrawable (no lot)');
        assert.equal(await WalletTopupLotModel.countDocuments({ paymentRecordId: t.paymentTransactionId }), 0);
        // The switch off stops new top-ups only: reads, the check and verify keep working.
        await expect('OWNER', 'POST', `${WS}/wallet/topups`, 503, { amountMinor: 1000, requestKey: newKey() }, 'ASSISTED_BOOKING_DISABLED');
        const c = await expect('READER', 'POST', `${WS}/wallet/topups/${t.paymentTransactionId}/check`, 200);
        assert.equal(c.json.data.state, 'credited');
        await expect('READER', 'GET', `${WS}/wallet`, 200);
      } finally { flagsOn(); }
      const unpaid = await topup('OWNER', 1000);
      const c = await expect('READER', 'POST', `${WS}/wallet/topups/${unpaid.paymentTransactionId}/check`, 200);
      assert.equal(c.json.data.state, 'unpaid');
    });

    await check('request key: the same key and amount answers the same order; another amount 409; parallel first sends make one order', async () => {
      const key = newKey();
      const a = await topup('OWNER', 5000, key);
      const b = await topup('OWNER', 5000, key);
      assert.equal(b.paymentTransactionId, a.paymentTransactionId); assert.equal(b.razorpayOrderId, a.razorpayOrderId); assert.equal(b.replayed, true);
      await expect('OWNER', 'POST', `${WS}/wallet/topups`, 409, { amountMinor: 5001, requestKey: key }, 'IDEMPOTENCY_KEY_REUSED');
      // Another member's same key is another request.
      const c = await topup('MANAGER', 5000, key);
      assert.notEqual(c.paymentTransactionId, a.paymentTransactionId);
      const k2 = newKey();
      const many = await Promise.all([1, 2, 3].map(() => call('OWNER', 'POST', `${WS}/wallet/topups`, { amountMinor: 7000, requestKey: k2 })));
      assert.ok(many.every((r) => r.status === 200), many.map((r) => r.text).join(' | '));
      assert.equal(new Set(many.map((r) => r.json.data.paymentTransactionId)).size, 1);
      assert.equal(await PaymentRecordModel.countDocuments({ requestKey: { $regex: `:${k2}$` } }), 1);
      await expect('OWNER', 'POST', `${WS}/wallet/topups`, 400, { amountMinor: 99, requestKey: newKey() }, 'VALIDATION_ERROR');
      await expect('OWNER', 'POST', `${WS}/wallet/topups`, 400, { amountMinor: 1000, requestKey: 'short' }, 'VALIDATION_ERROR');
    });

    await check('O2 cap: balance + unpaid orders of 30 minutes + this one ≤ ₹50,000 (409 WALLET_LIMIT_REACHED with the amounts); a paid top-up is still credited', async () => {
      const w = await wallet();
      const pending = (await PaymentRecordModel.find({ payerPartnerId: L2, status: 'created' }).lean()).length;
      assert.equal(pending, 0);
      const t1 = await topup('LAB2', 3_000_000);
      const r = await expect('LAB2', 'POST', `${WS}/wallet/topups`, 409, { amountMinor: 2_000_001, requestKey: newKey() }, 'WALLET_LIMIT_REACHED');
      assert.deepEqual(r.json.details, { maxBalanceMinor: 5_000_000, balanceMinor: 0, pendingMinor: 3_000_000, allowedMinor: 2_000_000 });
      const t2 = await topup('LAB2', 2_000_000);
      // An old unpaid order no longer counts; both paid ones are credited even past ₹50,000.
      await PaymentRecordModel.collection.updateOne({ _id: new Types.ObjectId(t1.paymentTransactionId) }, { $set: { createdAt: new Date(Date.now() - 31 * MIN) } });
      const t3 = await topup('LAB2', 3_000_000);
      for (const t of [t1, t2, t3]) await expect('LAB2', 'POST', `${WS}/payments/verify`, 200, capture(t, 100));
      assert.equal((await wallet(L2)).balanceMinor, 8_000_000, 'paid money is always credited');
      await expect('LAB2', 'POST', `${WS}/wallet/topups`, 409, { amountMinor: 100, requestKey: newKey() }, 'WALLET_LIMIT_REACHED');
      assert.equal((await wallet()).balanceMinor, w.balanceMinor, 'the first lab is untouched');
    });

    await check('scope: another lab and a pharmacy record get the one 404; a pharmacy token 403; no wallet rights 403; a clinic 404; an unverified lab reads but cannot top up', async () => {
      const t = await topup('OWNER', 2000);
      const v = capture(t);
      const pharmacyRecord = await PaymentRecordModel.create({ userId: P, payerUserId: P, payerPharmacyId: P, context: 'wallet_recharge', contextId: `pharmacy_${P}_1`,
        baseAmount: 20, discountAmount: 0, finalAmount: 20, baseAmountPaise: 2000, finalAmountPaise: 2000, currency: 'INR', paymentGateway: 'razorpay',
        razorpayOrderId: 'order_ph_' + oid(), status: 'created', notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: P } } as never);
      const PR = String(pharmacyRecord._id);
      const bodies: string[] = [];
      for (const [who, id] of [['LAB2', t.paymentTransactionId], ['OWNER', PR], ['OWNER', oid()], ['OWNER', 'not-an-id']] as const) {
        bodies.push((await expect(who, 'POST', `${WS}/wallet/topups/${id}/check`, 404, undefined, 'PAYMENT_RECORD_NOT_FOUND')).text);
        await expect(who, 'POST', `${WS}/payments/reconcile`, id === 'not-an-id' ? 400 : 404, { paymentTransactionId: id });
      }
      assert.equal(new Set(bodies).size, 1, 'one answer for another lab, a pharmacy and an unknown id');
      await expect('LAB2', 'POST', `${WS}/payments/verify`, 404, v, 'PAYMENT_RECORD_NOT_FOUND');
      await expect('OWNER', 'POST', `${WS}/payments/verify`, 404, { ...v, paymentTransactionId: PR }, 'PAYMENT_RECORD_NOT_FOUND');
      await expect('P', 'POST', `${WS}/payments/verify`, 403, v, 'FORBIDDEN');
      await expect('P', 'GET', `${WS}/wallet`, 403, undefined, 'FORBIDDEN');
      // The generic payment routes refuse partners; a customer, admin or pharmacy there never reaches a lab top-up.
      await expect('OWNER', 'POST', '/api/v1/payments/verify', 403, v, 'ROLE_NOT_ALLOWED');
      await expect('P', 'POST', '/api/v1/payments/verify', 404, v, 'PAYMENT_RECORD_NOT_FOUND');
      await expect('DESK', 'GET', `${WS}/wallet`, 403, undefined, 'INSUFFICIENT_PERMISSIONS');
      await expect('READER', 'POST', `${WS}/wallet/topups`, 403, { amountMinor: 1000, requestKey: newKey() }, 'INSUFFICIENT_PERMISSIONS');
      await expect('READER', 'POST', `${WS}/payments/verify`, 403, v, 'INSUFFICIENT_PERMISSIONS');
      await expect('CLINIC', 'GET', `${WS}/wallet`, 404, undefined, 'WALLET_NOT_FOUND');
      await expect('UNVERIFIED', 'GET', `${WS}/wallet`, 200);
      await expect('UNVERIFIED', 'POST', `${WS}/wallet/topups`, 403, { amountMinor: 1000, requestKey: newKey() }, 'PARTNER_NOT_VERIFIED');
      assert.equal(await credits(t.paymentTransactionId), 0, 'nothing credited by the refused calls');
      await expect('OWNER', 'POST', `${WS}/payments/verify`, 200, v);
      assert.equal(await credits(t.paymentTransactionId), 1);
    });

    await check('index 503: without the partner entry unique index a top-up and an admin top-up answer 503 INDEXES_OUTDATED, before anything is written', async () => {
      await PartnerWalletEntryModel.collection.dropIndex('walletId_1_operationKey_1');
      resetIndexChecks();
      try {
        const records = await PaymentRecordModel.countDocuments({});
        await expect('OWNER', 'POST', `${WS}/wallet/topups`, 503, { amountMinor: 1000, requestKey: newKey() }, 'INDEXES_OUTDATED');
        await expect('ADMIN', 'POST', `${AD}/labs/${L}/wallet/topup`, 503, { amountMinor: 1000 }, 'INDEXES_OUTDATED', { 'idempotency-key': newKey('adm') });
        await expect('ADMIN', 'GET', `${AD}/labs/${L}/wallet/topups/by-key/${newKey('adm')}`, 503, undefined, 'INDEXES_OUTDATED');
        assert.equal(await PaymentRecordModel.countDocuments({}), records);
      } finally {
        await PartnerWalletEntryModel.syncIndexes();
        resetIndexChecks();
      }
      await topup('OWNER', 1000);
    });

    // ───────────────────────── Admin ─────────────────────────
    await check('admin top-up: Idempotency-Key required and checked, ₹2,00,000 cap, replay credits once, other content 409, by-key, audited, never withdrawable', async () => {
      const url = `${AD}/labs/${L3}/wallet/topup`;
      const key = newKey('adm');
      await expect('ADMIN', 'POST', url, 400, { amountMinor: 1000 }, 'IDEMPOTENCY_KEY_REQUIRED');
      await expect('ADMIN', 'POST', url, 400, { amountMinor: 1000 }, 'VALIDATION_ERROR', { 'idempotency-key': 'bad key!' });
      await expect('ADMIN', 'POST', url, 400, { amountMinor: 1000 }, 'VALIDATION_ERROR', { 'idempotency-key': 'short' });
      await expect('ADMIN', 'POST', url, 400, { amountMinor: 20_000_001 }, 'VALIDATION_ERROR', { 'idempotency-key': key });
      const before = await wallet(L3) ?? { balanceMinor: 0, withdrawableMinor: 0 };
      const a = await expect('ADMIN', 'POST', url, 200, { amountMinor: 20_000_000, notes: 'Goodwill' }, undefined, { 'idempotency-key': key });
      assert.equal(a.json.data.balanceMinor, before.balanceMinor + 20_000_000, 'the cap is inclusive');
      assert.equal(a.json.data.withdrawableMinor, before.withdrawableMinor, 'L20: never withdrawable');
      const twice = await Promise.all([1, 2].map(() => call('ADMIN', 'POST', url, { amountMinor: 20_000_000, notes: 'Goodwill' }, { 'idempotency-key': key })));
      assert.ok(twice.every((r) => r.status === 200));
      assert.equal((await wallet(L3)).balanceMinor, before.balanceMinor + 20_000_000, 'replays credit nothing more');
      await expect('ADMIN', 'POST', url, 409, { amountMinor: 20_000_000, notes: 'Other' }, 'IDEMPOTENCY_KEY_REUSED', { 'idempotency-key': key });
      await expect('ADMIN', 'POST', url, 409, { amountMinor: 1000, notes: 'Goodwill' }, 'IDEMPOTENCY_KEY_REUSED', { 'idempotency-key': key });
      const row = (await entries(L3)).filter((e) => e.operationKey === `admin_topup:${key}`);
      assert.equal(row.length, 1); assert.deepEqual(row[0].actor, { kind: 'admin', id: ADMIN }); assert.equal(row[0].notes, 'Goodwill');
      const found = await expect('ADMIN', 'GET', `${AD}/labs/${L3}/wallet/topups/by-key/${key}`, 200);
      assert.equal(found.json.data.state, 'credited'); assert.equal(found.json.data.entry.amountMinor, 20_000_000);
      assert.equal((await expect('ADMIN', 'GET', `${AD}/labs/${L2}/wallet/topups/by-key/${key}`, 200)).json.data.state, 'not_found');
      await expect('ADMIN', 'GET', `${AD}/labs/${L}/wallet/topups/by-key/bad!key`, 400, undefined, 'VALIDATION_ERROR');
      const audits = await AssistedAuditEventModel.find({ orgKind: 'lab', orgId: L3, action: 'wallet.admin_topup' }).lean();
      assert.equal(audits.length, 1); assert.equal(audits[0]!.actorId, ADMIN); assert.equal(audits[0]!.requestKey, key);
      // One 404 for a pharmacy id, a clinic, an unknown id and a malformed id; admins only.
      const nf: string[] = [];
      for (const id of [P, CL, oid(), 'xyz']) {
        nf.push((await expect('ADMIN', 'GET', `${AD}/labs/${id}/wallet`, 404, undefined, 'LAB_NOT_FOUND')).text);
        await expect('ADMIN', 'POST', url.replace(L3, id), 404, { amountMinor: 1000 }, 'LAB_NOT_FOUND', { 'idempotency-key': newKey('adm') });
      }
      assert.equal(new Set(nf).size, 1);
      await expect('OWNER', 'GET', `${AD}/labs/${L}/wallet`, 403);
      await expect('P', 'GET', `${AD}/labs/${L}/wallet`, 403);
      const reads = await expect('ADMIN', 'GET', `${AD}/labs/${L}/wallet`, 200);
      assert.equal(reads.json.data.exists, true);
      const ents = await expect('ADMIN', 'GET', `${AD}/labs/${L}/wallet/entries?limit=2`, 200);
      assert.equal(ents.json.data.length, 2); assert.ok(ents.json.pagination.nextCursor);
      const more = await expect('ADMIN', 'GET', `${AD}/labs/${L}/wallet/entries?limit=50&cursor=${ents.json.pagination.nextCursor}`, 200);
      assert.equal(ents.json.data.length + more.json.data.length, (await entries()).length, 'the cursor walks every entry once');
      assert.ok((await expect('ADMIN', 'GET', `${AD}/labs/${L}/wallet/lots`, 200)).json.data.every((l: any) => l.walletRef.kind === 'lab' && l.walletRef.id === L));
      delete process.env.ASSISTED_ADMIN_TOOLS_ENABLED;
      try {
        await expect('ADMIN', 'POST', url, 503, { amountMinor: 1000 }, 'ASSISTED_BOOKING_DISABLED', { 'idempotency-key': newKey('adm') });
        await expect('ADMIN', 'GET', `${AD}/labs/${L}/wallet`, 200);
      } finally { flagsOn(); }
    });

    // ───────────────────────── Ledger: debit and refund (2e spends through these) ─────────────────────────
    const debit = (amountMinor: number, key: string, partnerId = L) => walletTransaction((s) => debitLabWalletIn({ partnerId, amountMinor, operationKey: `${key}:debit`,
      referenceType: 'test_booking', referenceId: key, description: 'Test booking' }, s));
    const refund = (amountMinor: number, key: string, restore?: { lotId: string; amountPaise: number }[], partnerId = L) =>
      walletTransaction((s) => refundLabWalletIn({ partnerId, amountMinor, operationKey: `${key}:refund`, referenceType: 'test_booking', referenceId: `${key}:refund`,
        description: 'Refund', ...(restore ? { restore } : {}) }, s));

    await check('debit: two spends beyond the balance at once — one succeeds, the balance never goes below zero; card money is spent first, oldest lot first', async () => {
      const lab = L2;
      const before = await wallet(lab);
      const half = Math.floor(before.balanceMinor / 2) + 1;
      const out = await Promise.allSettled([debit(half, `race-a-${oid()}`, lab), debit(half, `race-b-${oid()}`, lab)]);
      assert.equal(out.filter((o) => o.status === 'fulfilled').length, 1, 'exactly one spend');
      const refused = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      assert.equal(refused.reason.code, 'INSUFFICIENT_BALANCE');
      const after = await wallet(lab);
      assert.equal(after.balanceMinor, before.balanceMinor - half); assert.ok(after.balanceMinor >= 0);
      const row = (await entries(lab)).find((e) => e.kind === 'booking_debit')!;
      assert.equal(row.amountMinor, -half);
      const lots = await WalletTopupLotModel.find({ 'walletRef.kind': 'lab', 'walletRef.id': lab }).sort({ createdAt: 1, _id: 1 }).lean();
      assert.equal(row.lotAllocations[0].lotId, String(lots[0]!._id), 'D9: oldest lot first');
      assert.equal(row.lotAllocations.reduce((a: number, x: any) => a + x.amountPaise, 0), half);
      await assert.rejects(debit(after.balanceMinor + 1, `over-${oid()}`, lab), (e: any) => e.code === 'INSUFFICIENT_BALANCE');
    });

    await check('refund: posts once (a replay or a race posts nothing more) and restores exactly the lots the spend used', async () => {
      const lab = L2;
      const key = `refund-${oid()}`;
      const before = await wallet(lab);
      const d = await debit(150_000, key, lab);
      assert.equal((await wallet(lab)).withdrawableMinor, before.withdrawableMinor - 150_000);
      const restore = (d.entry as any).lotAllocations;
      const out = await Promise.all([refund(150_000, key, restore, lab), refund(150_000, key, restore, lab), refund(150_000, key, restore, lab)]);
      assert.equal(out.filter((o) => !o.replayed).length, 1);
      const after = await wallet(lab);
      assert.equal(after.balanceMinor, before.balanceMinor); assert.equal(after.withdrawableMinor, before.withdrawableMinor, 'card money restored');
      assert.equal((await entries(lab)).filter((e) => e.operationKey === `${key}:refund`).length, 1);
    });

    await check('freeze: a frozen wallet refuses spending (409 WALLET_FROZEN) but refunds and top-ups still post; audited; an unverified or suspended lab cannot spend', async () => {
      const key = `frz-${oid()}`;
      await debit(1000, key);
      const f = await expect('ADMIN', 'PUT', `${AD}/labs/${L}/wallet/freeze`, 200, { frozen: true, reason: 'Checking a dispute' });
      assert.equal(f.json.data.frozen, true); assert.equal(f.json.data.frozenReason, 'Checking a dispute');
      await assert.rejects(debit(1000, `frz2-${oid()}`), (e: any) => e.code === 'WALLET_FROZEN');
      const before = (await wallet()).balanceMinor;
      await refund(1000, key);
      const t = await topup('OWNER', 4000);
      await expect('MANAGER', 'POST', `${WS}/payments/verify`, 200, capture(t, 94));
      assert.equal((await wallet()).balanceMinor, before + 5000, 'credits post while frozen');
      assert.equal((await expect('READER', 'GET', `${WS}/wallet`, 200)).json.data.frozen, true);
      const u = await expect('ADMIN', 'PUT', `${AD}/labs/${L}/wallet/freeze`, 200, { frozen: false, reason: 'Cleared' });
      assert.equal(u.json.data.frozen, false); assert.equal(u.json.data.frozenReason, null);
      await debit(1000, `frz3-${oid()}`);
      const audits = await AssistedAuditEventModel.find({ orgKind: 'lab', orgId: L, action: { $in: ['wallet.frozen', 'wallet.unfrozen'] } }).lean();
      assert.deepEqual(audits.map((a) => a.action).sort(), ['wallet.frozen', 'wallet.unfrozen']);
      await expect('ADMIN', 'PUT', `${AD}/labs/${P}/wallet/freeze`, 404, { frozen: true, reason: 'x' }, 'LAB_NOT_FOUND');
      // S5: spending needs an active, verified lab (refunds always post).
      await PartnerModel.updateOne({ _id: L }, { $set: { 'verification.state': 'suspended' } });
      try {
        await assert.rejects(debit(1000, `susp-${oid()}`), (e: any) => e.code === 'PARTNER_NOT_VERIFIED');
        await refund(500, `susp-r-${oid()}`);
        await expect('OWNER', 'POST', `${WS}/wallet/topups`, 403, { amountMinor: 1000, requestKey: newKey() }, 'PARTNER_NOT_VERIFIED');
        await expect('READER', 'GET', `${WS}/wallet`, 200);
      } finally { await PartnerModel.updateOne({ _id: L }, { $set: { 'verification.state': 'verified' } }); }
      await assert.rejects(debit(1000, `unv-${oid()}`, LU), (e: any) => e.code === 'PARTNER_NOT_VERIFIED');
    });

    await check('receivable (shared rule): a wallet owing money refuses spending and cannot be unfrozen; the next credit sets it off first', async () => {
      const lab = L2;
      const w = await wallet(lab);
      await PartnerWalletModel.updateOne({ _id: w._id }, { $set: { receivableMinor: 700, frozen: true } });
      await assert.rejects(debit(100, `recv-${oid()}`, lab), (e: any) => e.code === 'WALLET_RECEIVABLE');
      await expect('ADMIN', 'PUT', `${AD}/labs/${lab}/wallet/freeze`, 409, { frozen: false, reason: 'x' }, 'WALLET_RECEIVABLE');
      await refund(1000, `recv-r-${oid()}`, undefined, lab);
      const after = await wallet(lab);
      assert.equal(after.receivableMinor, 0); assert.equal(after.balanceMinor, w.balanceMinor + 300);
      const setoff = (await entries(lab)).filter((e) => e.kind === 'receivable_setoff');
      assert.equal(setoff.length, 1); assert.equal(setoff[0].amountMinor, -700); assert.equal(setoff[0].receivableDeltaMinor, -700);
      await expect('ADMIN', 'PUT', `${AD}/labs/${lab}/wallet/freeze`, 200, { frozen: false, reason: 'Settled' });
    });

    // ───────────────────────── Chargebacks (flag only) and close-compensated ─────────────────────────
    await check('chargeback on a credited lab top-up: flagged only (no debit, no receivable, no freeze), its card money no longer withdrawable; once; alert and audit', async () => {
      const t = await topup('OWNER', 50_000);
      await expect('MANAGER', 'POST', `${WS}/payments/verify`, 200, capture(t, 1180));
      const before = await wallet();
      const r = await expect('ADMIN', 'POST', `${AD}/wallet-payments/${t.razorpayOrderId}/chargeback`, 200, { reason: 'Dispute lost' });
      assert.equal(r.json.data.flagged, true); assert.equal(r.json.data.blockedUncredited, false); assert.equal(r.json.data.replayed, false);
      assert.equal(r.json.data.walletKind, 'lab'); assert.equal(r.json.data.partnerId, L);
      const after = await wallet();
      assert.equal(after.balanceMinor, before.balanceMinor, 'nothing taken');
      assert.equal(after.frozen, false); assert.equal(after.receivableMinor, 0);
      assert.equal(after.withdrawableMinor, before.withdrawableMinor - 50_000, 'the disputed card money is not withdrawable');
      const lot = await WalletTopupLotModel.findOne({ paymentRecordId: t.paymentTransactionId }).lean() as any;
      assert.equal(lot.disputeState, 'lost'); assert.equal(lot.closed, false);
      assert.ok((await PaymentRecordModel.findById(t.paymentTransactionId).lean() as any).chargebackAt);
      // Again (by payment and by its lot): replayed, nothing more.
      assert.equal((await expect('ADMIN', 'POST', `${AD}/wallet-payments/${t.paymentTransactionId}/chargeback`, 200, { reason: 'Again' })).json.data.replayed, true);
      const byLot = await expect('ADMIN', 'POST', `${AD}/wallet-lots/${String(lot._id)}/chargeback`, 200, { reason: 'Again' });
      assert.equal(byLot.json.data.flagged, true); assert.equal(byLot.json.data.replayed, true);
      assert.equal(await AssistedAuditEventModel.countDocuments({ orgKind: 'lab', orgId: L, action: 'wallet.chargeback' }), 1);
      assert.equal(await AssistedAlertModel.countDocuments({ kind: 'wallet_topup_chargeback' }), 1);
      assert.equal((await entries()).filter((e) => e.kind === 'chargeback').length, 0);
      // Spending still works (not frozen); a lab lot from the lot route is flagged too.
      await debit(1000, `after-cb-${oid()}`);
      const t2 = await topup('OWNER', 2000);
      await expect('MANAGER', 'POST', `${WS}/payments/verify`, 200, capture(t2, 47));
      const lot2 = await WalletTopupLotModel.findOne({ paymentRecordId: t2.paymentTransactionId }).lean() as any;
      const viaLot = await expect('ADMIN', 'POST', `${AD}/wallet-lots/${String(lot2._id)}/chargeback`, 200, { reason: 'Lost' });
      assert.equal(viaLot.json.data.flagged, true); assert.equal(viaLot.json.data.replayed, false);
      delete process.env.ASSISTED_ADMIN_TOOLS_ENABLED;
      try { await expect('ADMIN', 'POST', `${AD}/wallet-payments/${t2.paymentTransactionId}/chargeback`, 503, { reason: 'x' }, 'ASSISTED_BOOKING_DISABLED'); }
      finally { flagsOn(); }
    });

    await check('chargeback on a lab top-up never credited: blocked, then never credited by verify, the check or the sweep', async () => {
      const t = await topup('OWNER', 6000);
      const v = capture(t);
      const r = await expect('ADMIN', 'POST', `${AD}/wallet-payments/${t.paymentTransactionId}/chargeback`, 200, { reason: 'Lost before verify' });
      assert.equal(r.json.data.blockedUncredited, true); assert.equal(r.json.data.credited, false);
      await expect('MANAGER', 'POST', `${WS}/payments/verify`, 409, v, 'TOPUP_BLOCKED');
      await expect('READER', 'POST', `${WS}/wallet/topups/${t.paymentTransactionId}/check`, 409, undefined, 'TOPUP_BLOCKED');
      await sweep();
      assert.equal(await credits(t.paymentTransactionId), 0);
      assert.equal((await expect('READER', 'GET', `${WS}/wallet/topups?limit=50`, 200)).json.data.find((x: any) => x.paymentTransactionId === t.paymentTransactionId).state, 'blocked');
    });

    await check('close-compensated on a lab top-up: closed once per (admin, key), never credited afterwards; a credited one 409; by-key read; audited', async () => {
      const t = await topup('OWNER', 8000);
      const v = capture(t);
      const key = newKey('close');
      const url = `${AD}/wallet-payments/${t.razorpayOrderId}/close-compensated`;
      const c = await expect('ADMIN', 'POST', url, 200, { reason: 'Paid by bank transfer', requestKey: key });
      assert.deepEqual([c.json.data.closed, c.json.data.credited, c.json.data.replayed, c.json.data.walletKind, c.json.data.partnerId, c.json.data.amountPaise],
        [true, false, false, 'lab', L, 8000]);
      assert.match(c.json.data.message, /paid to the lab/);
      assert.equal((await expect('ADMIN', 'POST', url, 200, { reason: 'Paid by bank transfer', requestKey: key })).json.data.replayed, true);
      await expect('ADMIN', 'POST', url, 409, { reason: 'Other reason', requestKey: key }, 'IDEMPOTENCY_KEY_REUSED');
      await expect('MANAGER', 'POST', `${WS}/payments/verify`, 409, v, 'TOPUP_BLOCKED');
      await expect('READER', 'POST', `${WS}/wallet/topups/${t.paymentTransactionId}/check`, 409, undefined, 'TOPUP_BLOCKED');
      await sweep();
      assert.equal(await credits(t.paymentTransactionId), 0);
      const bk = await expect('ADMIN', 'GET', `${AD}/wallet-payments/close-compensated/by-key/${key}`, 200);
      assert.equal(bk.json.data.state, 'closed'); assert.equal(bk.json.data.partnerId, L);
      assert.equal(await AssistedAuditEventModel.countDocuments({ orgKind: 'lab', orgId: L, action: 'wallet.closed_compensated' }), 1);
      // A later lost dispute on it is flagged only (nothing taken).
      const before = (await wallet()).balanceMinor;
      const cb = await expect('ADMIN', 'POST', `${AD}/wallet-payments/${t.paymentTransactionId}/chargeback`, 200, { reason: 'Lost' });
      assert.equal(cb.json.data.flagged, true); assert.equal(cb.json.data.compensated, true);
      assert.equal((await wallet()).balanceMinor, before);
      // A credited top-up cannot be closed.
      const t2 = await topup('OWNER', 3000);
      await expect('MANAGER', 'POST', `${WS}/payments/verify`, 200, capture(t2));
      await expect('ADMIN', 'POST', `${AD}/wallet-payments/${t2.paymentTransactionId}/close-compensated`, 409, { reason: 'x', requestKey: newKey('close') }, 'TOPUP_ALREADY_CREDITED');
    });

    // ───────────────────────── Reconciliation and the pharmacy wallet ─────────────────────────
    await check('reconciliation: lab wallets reconcile; a paid lab top-up never credited is listed; a tampered entry is reported', async () => {
      const clean = await expect('ADMIN', 'GET', `${AD}/assisted/reconciliation?full=true`, 200);
      const partnerMismatches = clean.json.data.checks.mismatches.filter((m: any) => m.check.startsWith('partner_wallet'));
      assert.deepEqual(partnerMismatches, []); assert.ok(clean.json.data.checks.partnerWallets.checked >= 2);
      const lost = await PaymentRecordModel.create({ userId: String(owner._id), payerUserId: String(owner._id), payerPartnerId: L, payerMemberId: String(owner._id),
        context: 'wallet_recharge', contextId: `lab_${L}_1`, baseAmount: 10, discountAmount: 0, finalAmount: 10, baseAmountPaise: 1000, finalAmountPaise: 1000,
        currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_lost_' + oid(), status: 'paid', isProcessed: false, notes: { flow: 'lab_wallet_recharge', partnerId: L } } as never);
      const listed = await expect('ADMIN', 'GET', `${AD}/wallet-recharges/uncredited`, 200);
      assert.ok(listed.json.data.some((x: any) => x.paymentTransactionId === String(lost._id) && x.walletKind === 'lab' && x.partnerId === L));
      const e = await PartnerWalletEntryModel.findOne({ ownerKind: 'lab', ownerId: L }).lean();
      await PartnerWalletEntryModel.updateOne({ _id: e!._id }, { $inc: { amountMinor: 1 } });
      try {
        const bad = await expect('ADMIN', 'GET', `${AD}/assisted/reconciliation?full=true`, 200);
        assert.ok(bad.json.data.checks.mismatches.some((m: any) => m.check === 'partner_wallet_balance' && m.ref === `lab:${L}`));
      } finally { await PartnerWalletEntryModel.updateOne({ _id: e!._id }, { $inc: { amountMinor: -1 } }); }
      await PaymentRecordModel.deleteOne({ _id: lost._id });
    });

    await check('pharmacy wallet unchanged by every lab movement; a pharmacy top-up still credits the pharmacy store only', async () => {
      const now = await PharmacyWalletModel.findOne({ pharmacyId: P }).lean() as any;
      assert.equal(now.balancePaise, pharmacyBefore.wallet.balancePaise); assert.equal(now.version, pharmacyBefore.wallet.version);
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({}), pharmacyBefore.rows);
      assert.equal(await PartnerWalletModel.countDocuments({ ownerId: P }), 0);
      const orderId = 'order_ph2_' + oid();
      const rec = await PaymentRecordModel.create({ userId: P, payerUserId: P, payerPharmacyId: P, context: 'wallet_recharge', contextId: `pharmacy_${P}_2`,
        baseAmount: 25, discountAmount: 0, finalAmount: 25, baseAmountPaise: 2500, finalAmountPaise: 2500, currency: 'INR', paymentGateway: 'razorpay',
        razorpayOrderId: orderId, status: 'created', notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: P } } as never);
      gateway.payments[orderId] = [{ id: 'pay_' + oid().slice(-14), order_id: orderId, amount: 2500, currency: 'INR', status: 'captured', fee: 59 }];
      const labBefore = await PartnerWalletEntryModel.countDocuments({});
      const c = await expect('P', 'POST', `/api/v1/pharmacy-wallet/topups/${String(rec._id)}/check`, 200);
      assert.equal(c.json.data.state, 'credited'); assert.equal(c.json.data.wallet.balancePaise, now.balancePaise + 2500);
      const row = await PharmacyWalletTransactionModel.findOne({ operationKey: `wallet_recharge:${String(rec._id)}` }).lean() as any;
      assert.deepEqual([row.transactionType, row.amount, row.amountPaise, row.signedAmountPaise, row.referenceType, row.description],
        ['credit', 25, 2500, 2500, 'wallet_recharge', 'Pharmacy wallet recharge via Razorpay']);
      assert.equal(await PartnerWalletEntryModel.countDocuments({}), labBefore, 'nothing in the lab store');
      // A lab member can never check it (the one 404, as above), and the lab check route never credits a pharmacy.
      await expect('OWNER', 'POST', `${WS}/wallet/topups/${String(rec._id)}/check`, 404, undefined, 'PAYMENT_RECORD_NOT_FOUND');
    });

    await check('audit and logs: lab wallet audits hold ids, codes and amounts only', async () => {
      const rows = await AssistedAuditEventModel.find({ orgKind: 'lab' }).lean();
      const text = JSON.stringify(rows);
      for (const secret of ['Owner', 'Cashier', 'Reader', '9700000301', 'pay_']) assert.equal(text.includes(secret), false, secret);
      assert.equal(await PartnerAuditEventModel.countDocuments({ action: /^wallet\./ }), 0, 'lab admin wallet actions are in the assisted audit');
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
