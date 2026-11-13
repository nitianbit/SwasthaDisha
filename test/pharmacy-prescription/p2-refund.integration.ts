/**
 * P2 focused integration check: refunds for pharmacist-rejected paid prescription orders, against a real MongoDB
 * replica set. Real order/wallet/payment models, transactions and HTTP router; the Razorpay gateway is a fake.
 * After every scenario the customer's wallet balance must equal their ledger (credits/refunds minus debits).
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/p2_refund_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/pharmacy-prescription/p2-refund.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import '@/modules/user/model';
import PharmacyModel from '@/modules/pharmacies/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { GatewayRefund, PrescriptionRefundService, RefundGateway } from '@/modules/pharmacyOrders/prescriptionRefund';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository } from '@/modules/wallet/repository';
import { WalletService } from '@/modules/wallet/services';
import { PaymentService } from '@/modules/payment/services';
import { WalletTransactionRepository } from '@/modules/wallet/repository';

// The script clears its database: accept only this exact disposable fixture URL, never a pattern match.
const FIXTURE_URL = 'mongodb://127.0.0.1:27917/p2_refund_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

type Mode = 'ok' | 'pending' | 'refuse400' | 'timeout' | 'createThenTimeout' | 'createThenOutage' | 'createThen400' | 'hang' | 'timeoutButLater' | 'wrongAmount' | 'failedNow';
/** Fake Razorpay: refunds per payment (cap = captured 10000 paise); behaviour of each create call is scripted. */
class FakeGateway implements RefundGateway {
  refunds = new Map<string, GatewayRefund[]>();
  refundCalls = 0;
  next: Mode[] = [];
  listFails = false;
  hung?: { resolve: (r: GatewayRefund) => void; reject: (e: unknown) => void };
  later?: () => void;
  async listRefunds(paymentId: string) {
    if (this.listFails) throw new Error('network');
    return (this.refunds.get(paymentId) ?? []).map(r => ({ ...r }));
  }
  async fetchRefund(paymentId: string, refundId: string) {
    if (this.listFails) throw new Error('network');
    const r = (this.refunds.get(paymentId) ?? []).find(x => x.id === refundId);
    if (!r) throw Object.assign(new Error('not found'), { statusCode: 400 });
    return { ...r };
  }
  setStatus(paymentId: string, status: string) { for (const r of this.refunds.get(paymentId) ?? []) r.status = status; }
  private create(paymentId: string, body: { amount: number; notes: Record<string, string> }, status: string): GatewayRefund {
    const live = (this.refunds.get(paymentId) ?? []).filter(r => r.status !== 'failed').reduce((a, r) => a + r.amount, 0);
    if (live + body.amount > 10_000) throw Object.assign(new Error('exceeds captured'), { statusCode: 400 });
    const r = { id: 'rfnd_' + (++this.refundCalls), amount: body.amount, status, paymentId, notes: body.notes };
    this.refunds.set(paymentId, [...(this.refunds.get(paymentId) ?? []), r]);
    return { ...r };
  }
  async refund(paymentId: string, body: { amount: number; receipt: string; notes: Record<string, string> }) {
    const mode = this.next.shift() ?? 'ok';
    if (mode === 'hang') return new Promise<GatewayRefund>((resolve, reject) => { this.hung = { resolve, reject }; });
    if (mode === 'refuse400') { this.refundCalls++; throw Object.assign(new Error('BAD_REQUEST'), { statusCode: 400 }); }
    if (mode === 'timeout') { this.refundCalls++; throw new Error('ETIMEDOUT'); }
    if (mode === 'timeoutButLater') { this.later = () => { this.create(paymentId, body, 'processed'); }; throw new Error('ETIMEDOUT'); }
    if (mode === 'wrongAmount') return this.create(paymentId, { ...body, amount: body.amount / 2 }, 'processed');
    if (mode === 'failedNow') return this.create(paymentId, body, 'failed');
    const r = this.create(paymentId, body, mode === 'pending' ? 'pending' : 'processed');
    if (mode === 'createThenTimeout') throw new Error('socket hang up');
    if (mode === 'createThenOutage') { this.listFails = true; throw new Error('socket hang up'); } // provider unreachable after create
    if (mode === 'createThen400') throw Object.assign(new Error('duplicate receipt'), { statusCode: 400 });
    return r;
  }
}

const gateway = new FakeGateway();
const refunds = new PrescriptionRefundService(gateway as never, new WalletRepository());
Container.set(PrescriptionRefundService, refunds);
const recorder = { queueNotification: async () => undefined, queueSubscriptionSync: async () => undefined };
const inventory = { returnStockBulk: async () => [], releaseOrderStockBulk: async () => undefined, consumeOrderReservedStockBulk: async () => undefined };
const orders = new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
  new PharmacyOrderRepository(), {}, inventory, {}, {}, {}, recorder, {}, refunds);

const pharmacyA = new Types.ObjectId().toHexString();
const pharmacyB = new Types.ObjectId().toHexString();
const RX = ['https://files.example/rx.jpg'];
const pharmacist = { pharmacistName: 'A. Pharmacist', pharmacistRegistrationNumber: 'KA/PH/12345' };

/** A paid Rx order: 100.00 via Razorpay + 20.00 from wallet, pending pharmacist review. */
async function paidOrder(opts: { record?: boolean; walletActive?: boolean } = {}) {
  const customer = new Types.ObjectId().toHexString();
  const paymentId = 'pay_' + new Types.ObjectId().toHexString().slice(-12);
  const order = await PharmacyOrderModel.create({ pharmacyId: pharmacyA, orderType: 'online', status: 'accepted', customerId: customer,
    createdById: customer, createdByRole: 'user', paymentMode: 'online_payment', paymentStatus: 'paid',
    items: [{ medicineId: new Types.ObjectId(), medicineName: 'Rx', orderedQty: 1, unitPrice: 120, lineTotal: 120, prescriptionRequired: true, itemStatus: 'active' }],
    prescriptionUrls: RX, prescriptionStatus: 'pending' });
  const id = String(order._id);
  if (opts.record !== false) {
    const rec = await PaymentRecordModel.create({ userId: customer, payerUserId: customer, context: 'pharmacy_order', contextId: id,
      baseAmount: 120, discountAmount: 0, finalAmount: 100, finalAmountPaise: 10_000, currency: 'INR', paymentGateway: 'razorpay',
      razorpayOrderId: 'order_' + id, razorpayPaymentId: paymentId, status: 'paid', isProcessed: true, notes: { walletDeductedAmount: 20 } });
    await PharmacyOrderModel.updateOne({ _id: id }, { $set: { paymentTransactionId: String(rec._id) } });
  }
  await WalletModel.create({ userId: customer, balance: 0, isActive: opts.walletActive ?? true });
  return { id, customer, paymentId };
}
const reject = (id: string) => orders.reviewPrescription(id, pharmacyA, { decision: 'reject', ...pharmacist, reason: 'Invalid prescription', reviewedPrescriptionUrls: RX });
const balance = async (u: string) => (await WalletModel.findOne({ userId: u }).lean())?.balance;
const txns = (u: string) => WalletTransactionModel.find({ userId: u }).sort({ createdAt: 1 }).lean();
const refundOf = async (id: string) => (await PharmacyOrderModel.findById(id).lean())!.prescriptionRefund!;
const expireLease = (id: string) => PharmacyOrderModel.updateOne({ _id: id }, { $set: { 'prescriptionRefund.source.leaseUntil': new Date(0) } });
async function ledgerMatches(u: string) {
  const sum = (await txns(u)).reduce((a, t) => a + (t.transactionType === 'debit' ? -t.amount : t.amount), 0);
  assert.equal(Math.round(sum * 100), Math.round(Number(await balance(u)) * 100), 'wallet balance must equal its ledger');
}
/** Simulates "rejected, but the refund intent was never written" (crash / pre-P2 data), undoing any credit. */
async function dropIntent(o: { id: string; customer: string }) {
  await PharmacyOrderModel.updateOne({ _id: o.id }, { $unset: { prescriptionRefund: '' }, $set: { paymentStatus: 'paid' } });
  await WalletTransactionModel.deleteMany({ userId: o.customer });
  await WalletModel.updateOne({ userId: o.customer }, { $set: { balance: 0 } });
  await PaymentRecordModel.updateOne({ contextId: o.id }, { $set: { status: 'paid' } });
}
async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: { code?: string; status?: number }) => e.code === code && (status === undefined || e.status === status));
}

/** Customer tokens are admitted only for an existing customer account (credential generation check): create it. */
async function bearer(claims: { _id?: unknown; userType?: unknown }): Promise<string> {
  if (claims.userType === 'user' && typeof claims._id === 'string') {
    await mongoose.model('User').collection.updateOne({ _id: new mongoose.Types.ObjectId(claims._id) },
      { $setOnInsert: { userType: 'user', isActive: true } }, { upsert: true });
  }
  return jwt.sign(claims, CONFIG.JWT_SECRET_KEY);
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([PharmacyOrderModel.init(), WalletModel.init(), WalletTransactionModel.init(), PaymentRecordModel.init()]);

  await check('reject paid order: intent + full wallet credit (100 + 20) once; order/payment refunded; replays are no-ops', async () => {
    const o = await paidOrder();
    const out = await reject(o.id);
    assert.equal(out.status, 'cancelled'); assert.equal(out.paymentStatus, 'refunded');
    assert.equal(out.prescriptionRefund?.status, 'wallet_credited');
    assert.equal(await balance(o.customer), 120);
    const t = await txns(o.customer);
    assert.equal(t.length, 1); assert.equal(t[0].amount, 120); assert.equal(t[0].balanceBefore, 0); assert.equal(t[0].balanceAfter, 120);
    assert.equal((await PaymentRecordModel.findOne({ contextId: o.id }).lean())?.status, 'refunded');
    await refunds.settleWallet(o.id); await refunds.reconcileDue();
    assert.equal(await balance(o.customer), 120); await ledgerMatches(o.customer);
  });

  await check('[#4] intent commits with the rejection; credit failure is retried by the reconciler', async () => {
    const o = await paidOrder({ walletActive: false });
    const out = await reject(o.id);
    assert.equal(out.status, 'cancelled');
    assert.equal(out.prescriptionRefund?.status, 'wallet_pending'); assert.equal(out.prescriptionRefund?.lastError, 'WALLET_INACTIVE');
    await refunds.reconcileDue();
    assert.equal((await refundOf(o.id)).status, 'wallet_pending'); // still inactive
    await WalletModel.updateOne({ userId: o.customer }, { $set: { isActive: true } });
    await refunds.reconcileDue();
    assert.equal((await refundOf(o.id)).status, 'wallet_credited'); assert.equal(await balance(o.customer), 120);
    await ledgerMatches(o.customer);
  });

  await check('[#4] rejected paid order with NO intent is recovered by the reconciler and by the pharmacy retry', async () => {
    const a = await paidOrder(); await reject(a.id); await dropIntent(a);
    await refunds.reconcileDue();
    assert.equal((await refundOf(a.id)).status, 'wallet_credited'); assert.equal(await balance(a.customer), 120);
    const b = await paidOrder(); await reject(b.id); await dropIntent(b);
    await rejects(refunds.retryWalletCredit(b.id, { userType: 'pharmacy', pharmacyId: pharmacyB }), 'FORBIDDEN', 403);
    const done = await refunds.retryWalletCredit(b.id, { userType: 'pharmacy', pharmacyId: pharmacyA });
    assert.equal(done.prescriptionRefund?.status, 'wallet_credited'); assert.equal(await balance(b.customer), 120);
    await rejects(refunds.retryWalletCredit(b.id, { userType: 'admin' }), 'REFUND_NOT_PENDING', 409);
    await ledgerMatches(a.customer); await ledgerMatches(b.customer);
  });

  await check('[#5] prior refund entry with a different amount -> manual_review, no extra credit; exact match settles without credit', async () => {
    const o = await paidOrder();
    const w = (await WalletModel.findOne({ userId: o.customer }).lean())!;
    await new WalletRepository().postEntry({ userId: o.customer, walletId: w._id, transactionType: 'refund', amount: 20,
      referenceType: 'pharmacy_order', referenceId: o.id, description: 'manual', transactionDate: '20261113' });
    const out = await reject(o.id);
    assert.equal(out.prescriptionRefund?.status, 'manual_review'); assert.equal(out.prescriptionRefund?.lastError, 'PRIOR_REFUND_AMOUNT_MISMATCH');
    assert.equal(await balance(o.customer), 20); assert.equal(out.paymentStatus, 'paid');
    assert.ok((await refunds.needsAttention()).some(q => String(q._id) === o.id));
    const e = await paidOrder();
    const we = (await WalletModel.findOne({ userId: e.customer }).lean())!;
    await new WalletRepository().postEntry({ userId: e.customer, walletId: we._id, transactionType: 'refund', amount: 120,
      referenceType: 'pharmacy_order', referenceId: e.id, description: 'late payment path', transactionDate: '20261113' });
    const out2 = await reject(e.id);
    assert.equal(out2.prescriptionRefund?.status, 'wallet_credited'); assert.equal(await balance(e.customer), 120);
    await ledgerMatches(o.customer); await ledgerMatches(e.customer);
  });

  await check('no matching paid payment record -> manual_review, wallet untouched', async () => {
    const o = await paidOrder({ record: false });
    const out = await reject(o.id);
    assert.equal(out.prescriptionRefund?.status, 'manual_review'); assert.equal(await balance(o.customer), 0);
  });

  await check('transfer to card/UPI: wallet -100, one processed refund under the generation-1 key', async () => {
    const o = await paidOrder(); await reject(o.id);
    const out = await refunds.refundToSource(o.id, o.customer);
    assert.equal(out.prescriptionRefund?.status, 'source_refunded');
    const g = gateway.refunds.get(o.paymentId)!;
    assert.equal(g.length, 1); assert.equal(g[0].amount, 10_000); assert.equal(g[0].notes?.swasthadisha_refund_key, `rx-${o.id}-1`);
    assert.equal(out.prescriptionRefund?.source?.razorpayRefundId, g[0].id);
    assert.equal(await balance(o.customer), 20);
    await refunds.refundToSource(o.id, o.customer); // no-op
    assert.equal(gateway.refunds.get(o.paymentId)!.length, 1); await ledgerMatches(o.customer);
  });

  await check('only the payer; spent money blocks the transfer with nothing changed', async () => {
    const o = await paidOrder(); await reject(o.id);
    await rejects(refunds.refundToSource(o.id, new Types.ObjectId().toHexString()), 'ORDER_NOT_FOUND', 404);
    const w = (await WalletModel.findOne({ userId: o.customer }).lean())!;
    await new WalletRepository().postEntry({ userId: o.customer, walletId: w._id, transactionType: 'debit', amount: 50, referenceType: 'booking',
      referenceId: 'b1', description: 'spent', transactionDate: '20261113' });
    await rejects(refunds.refundToSource(o.id, o.customer), 'WALLET_BALANCE_INSUFFICIENT', 409);
    assert.equal((await refundOf(o.id)).status, 'wallet_credited'); assert.equal(gateway.refunds.get(o.paymentId), undefined);
    await ledgerMatches(o.customer);
  });

  await check('[#1] concurrent booking-style wallet spend vs transfer: never negative, always equals the ledger', async () => {
    for (let round = 0; round < 5; round++) {
      const o = await paidOrder(); await reject(o.id); // wallet 120
      const w = (await WalletModel.findOne({ userId: o.customer }).lean())!;
      const [spend, transfer] = await Promise.allSettled([
        new WalletRepository().debitUpTo({ userId: o.customer, walletId: w._id, referenceType: 'booking', referenceId: 'bk' + round,
          description: 'Wallet used for booking payment', transactionDate: '20261113' }, 50),
        refunds.refundToSource(o.id, o.customer),
      ]);
      assert.equal(spend.status, 'fulfilled');
      const spent = (spend as PromiseFulfilledResult<number>).value;
      const bal = Number(await balance(o.customer));
      assert.ok(bal >= 0);
      assert.equal(bal, transfer.status === 'fulfilled' ? 120 - 100 - spent : 120 - spent);
      await ledgerMatches(o.customer);
    }
  });

  await check('[#1] admin wallet service writes are atomic under concurrency (booking writers: test/booking-payment)', async () => {
    const user = new Types.ObjectId().toHexString();
    const w = await WalletModel.create({ userId: user, balance: 0, isActive: true });
    void w;
    const admin = new (WalletService as unknown as new (...a: unknown[]) => WalletService)(new WalletRepository(), {}, { createWalletCreditNotification: async () => undefined });
    await rejects(admin.addTransaction({ userId: user, transactionType: 'debit', amount: 1, description: 'x' } as never), 'INSUFFICIENT_BALANCE', 400);
    await Promise.all(Array.from({ length: 4 }, () => admin.addTransaction({ userId: user, transactionType: 'credit', amount: 10, description: 'top-up' } as never)));
    assert.equal(await balance(user), 40); await ledgerMatches(user);
  });

  await check('[re#1] five concurrent verifications of one wallet recharge credit it exactly once', async () => {
    const user = new Types.ObjectId().toHexString();
    await WalletModel.create({ userId: user, balance: 0, isActive: true });
    const record = await PaymentRecordModel.create({ userId: user, context: 'wallet_recharge', contextId: user, baseAmount: 100, discountAmount: 0,
      finalAmount: 100, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: 'order_r_' + user, razorpayPaymentId: 'pay_r', status: 'paid' });
    const proto = PaymentService.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const ctx: Record<string, unknown> = { walletRepository: new WalletRepository(), walletTransactionRepository: new WalletTransactionRepository() };
    ctx.getOrCreateActiveWallet = proto.getOrCreateActiveWallet.bind(ctx);
    await Promise.all(Array.from({ length: 5 }, () => proto.ensureWalletRechargeTransaction.call(ctx, record.toObject())));
    assert.equal(await balance(user), 100);
    assert.equal((await txns(user)).length, 1); await ledgerMatches(user);
  });

  await check('[re#1] the same refund operation posted concurrently from two code paths credits once', async () => {
    const user = new Types.ObjectId().toHexString();
    const w = await WalletModel.create({ userId: user, balance: 0, isActive: true });
    const repo = new WalletRepository();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => repo.postEntry({ userId: user, walletId: w._id, transactionType: 'refund',
      amount: 75, referenceType: i % 2 ? 'external_booking' : 'external_booking', referenceId: 'eb1', operationKey: 'external_booking_refund:eb1',
      description: 'Refund for external booking', transactionDate: '20261113' })));
    assert.ok(results.every(r => r && r.transaction.operationKey === 'external_booking_refund:eb1'));
    assert.equal(await balance(user), 75); assert.equal((await txns(user)).length, 1); await ledgerMatches(user);
  });

  await check('[re#2] timed-out submission that succeeds later + in-progress 400: never compensated, reconciled when it appears', async () => {
    const o = await paidOrder(); await reject(o.id);
    gateway.next.push('timeoutButLater');
    assert.equal((await refunds.refundToSource(o.id, o.customer)).prescriptionRefund?.status, 'source_processing');
    gateway.next.push('refuse400'); // Razorpay: "another operation is in progress"; list still empty
    await refunds.reconcileDue();
    let r = await refundOf(o.id);
    assert.equal(r.status, 'source_processing'); assert.equal(r.lastError, 'GATEWAY_SUBMISSION_UNRESOLVED'); assert.equal(r.source?.submissions, 2);
    assert.equal(await balance(o.customer), 20, 'uncertain submission must not restore wallet money');
    gateway.later!(); gateway.later = undefined; // the first submission completes at Razorpay
    await refunds.reconcileDue();
    r = await refundOf(o.id);
    assert.equal(r.status, 'source_refunded'); assert.equal(gateway.refunds.get(o.paymentId)!.length, 1);
    assert.equal(await balance(o.customer), 20); await ledgerMatches(o.customer);
  });

  await check('[re#2] refund under our key with the wrong amount is flagged for operators, not hidden or completed', async () => {
    const o = await paidOrder(); await reject(o.id);
    gateway.next.push('wrongAmount');
    const out = await refunds.refundToSource(o.id, o.customer);
    assert.equal(out.prescriptionRefund?.status, 'source_processing'); assert.equal(out.prescriptionRefund?.lastError, 'GATEWAY_REFUND_MISMATCH');
    assert.ok((await refunds.needsAttention()).some(q => String(q._id) === o.id));
    await refunds.reconcileDue();
    assert.equal((await refundOf(o.id)).status, 'source_processing', 'no automatic action after a mismatch');
    assert.equal(await balance(o.customer), 20); await ledgerMatches(o.customer);
  });

  await check('[r3#1] uppercase order IDs: no second credit beside a lowercase earlier refund; reconciler finds the same receipt', async () => {
    const e = await paidOrder();
    const we = (await WalletModel.findOne({ userId: e.customer }).lean())!;
    // earlier late-payment refund, recorded the way PaymentService does it (canonical lowercase id + key)
    await new WalletRepository().postEntry({ userId: e.customer, walletId: we._id, transactionType: 'refund', amount: 120,
      referenceType: 'pharmacy_order', referenceId: e.id, operationKey: `pharmacy_order_refund:${e.id}`, description: 'late', transactionDate: '20261113' });
    const out = await orders.reviewPrescription(e.id.toUpperCase(), pharmacyA,
      { decision: 'reject', ...pharmacist, reason: 'Invalid prescription', reviewedPrescriptionUrls: RX });
    assert.equal(out.prescriptionRefund?.status, 'wallet_credited');
    assert.equal(await balance(e.customer), 120, 'no second credit'); await ledgerMatches(e.customer);
    // uppercase retry on an intent-less order also settles under the canonical key
    const b = await paidOrder(); await reject(b.id); await dropIntent(b);
    await refunds.retryWalletCredit(b.id.toUpperCase(), { userType: 'admin' });
    await refunds.retryWalletCredit(b.id, { userType: 'admin' }).catch(() => undefined);
    assert.equal(await balance(b.customer), 120);
    assert.equal((await txns(b.customer))[0].operationKey, `pharmacy_order_refund:${b.id}`); await ledgerMatches(b.customer);
    // transfer started via an uppercase URL, finished by the (lowercase) reconciler: one receipt, one refund
    const s = await paidOrder(); await reject(s.id);
    gateway.next.push('createThenOutage');
    assert.equal((await refunds.refundToSource(s.id.toUpperCase(), s.customer)).prescriptionRefund?.status, 'source_processing');
    gateway.listFails = false;
    await refunds.reconcileDue();
    assert.equal((await refundOf(s.id)).status, 'source_refunded');
    const g = gateway.refunds.get(s.paymentId)!;
    assert.equal(g.length, 1); assert.equal(g[0].notes?.swasthadisha_refund_key, `rx-${s.id}-1`); await ledgerMatches(s.customer);
  });

  await check('WalletRepository.debitUpTo with an operation key: duplicates get the original amount, even once the wallet is empty', async () => {
    const user = new Types.ObjectId().toHexString();
    const w = await WalletModel.create({ userId: user, balance: 100, isActive: true });
    await WalletTransactionModel.create({ userId: user, walletId: w._id, transactionType: 'credit', amount: 100, balanceBefore: 0, balanceAfter: 100,
      status: 'completed', referenceType: 'seed', transactionDate: '20261113' });
    const step = { userId: user, walletId: w._id, referenceType: 'test', referenceId: 'step1', operationKey: 'test_step:1',
      description: 'keyed debit', transactionDate: '20261113' };
    const results = await Promise.all(Array.from({ length: 5 }, () => new WalletRepository().debitUpTo(step, 100)));
    assert.deepEqual(results, [100, 100, 100, 100, 100]);
    assert.equal(await new WalletRepository().debitUpTo(step, 100), 100, 'sequential duplicate after the wallet is empty');
    assert.equal(await balance(user), 0); await ledgerMatches(user);
  });

  await check('[r7#2] duplicates of one funding step that owe different amounts never absorb a larger earlier debit', async () => {
    const user = new Types.ObjectId().toHexString();
    const w = await WalletModel.create({ userId: user, balance: 100, isActive: true });
    await WalletTransactionModel.create({ userId: user, walletId: w._id, transactionType: 'credit', amount: 100, balanceBefore: 0, balanceAfter: 100,
      status: 'completed', referenceType: 'seed', transactionDate: '20261113' });
    const step = (k: string) => ({ userId: user, walletId: w._id, referenceType: 'booking', referenceId: k, operationKey: `booking_wallet:${k}:p0`,
      description: 'Wallet used for booking payment', transactionDate: '20261113' });
    // deterministic: A owes 100 and debits 100; B (coupon) owes 50 for the same step -> refused, not charged 100
    assert.equal(await new WalletRepository().debitUpTo(step('bk1'), 100), 100);
    await rejects(new WalletRepository().debitUpTo(step('bk1'), 50), 'WALLET_FUNDING_CONFLICT', 409);
    assert.equal(await balance(user), 0);
    // concurrent: whichever wins, no caller gets more than it owes and the wallet is charged once
    await new WalletRepository().postEntry({ userId: user, walletId: w._id, transactionType: 'credit', amount: 100, referenceType: 'topup', description: 't', transactionDate: '20261113' });
    const [a, b] = await Promise.allSettled([new WalletRepository().debitUpTo(step('bk2'), 100), new WalletRepository().debitUpTo(step('bk2'), 50)]);
    if (a.status === 'fulfilled') assert.ok(a.value <= 100);
    if (b.status === 'fulfilled') assert.ok(b.value <= 50);
    assert.equal((await txns(user)).filter(t => t.operationKey === 'booking_wallet:bk2:p0').length, 1);
    assert.ok(Number(await balance(user)) >= 0); await ledgerMatches(user);
  });

  await check('[#3] pending refund stays processing; reconciler completes it once processed', async () => {
    const o = await paidOrder(); await reject(o.id);
    gateway.next.push('pending');
    const out = await refunds.refundToSource(o.id, o.customer);
    assert.equal(out.prescriptionRefund?.status, 'source_processing'); assert.equal(out.prescriptionRefund?.lastError, 'GATEWAY_REFUND_PENDING');
    assert.ok(out.prescriptionRefund?.source?.razorpayRefundId);
    await refunds.reconcileDue();
    assert.equal((await refundOf(o.id)).status, 'source_processing');
    gateway.setStatus(o.paymentId, 'processed');
    await refunds.reconcileDue();
    assert.equal((await refundOf(o.id)).status, 'source_refunded'); assert.equal(await balance(o.customer), 20);
    await ledgerMatches(o.customer);
  });

  await check('[#3] pending refund that later FAILS: wallet re-credited exactly once; retry uses a new key', async () => {
    const o = await paidOrder(); await reject(o.id);
    gateway.next.push('pending');
    await refunds.refundToSource(o.id, o.customer);
    gateway.setStatus(o.paymentId, 'failed');
    await refunds.reconcileDue(); await refunds.reconcileDue();
    const r = await refundOf(o.id);
    assert.equal(r.status, 'wallet_credited'); assert.equal(r.lastError, 'GATEWAY_REFUND_FAILED');
    assert.equal(await balance(o.customer), 120);
    const out = await refunds.refundToSource(o.id, o.customer);
    assert.equal(out.prescriptionRefund?.status, 'source_refunded');
    const g = gateway.refunds.get(o.paymentId)!;
    assert.equal(g.length, 2); assert.equal(g[1].notes?.swasthadisha_refund_key, `rx-${o.id}-2`);
    assert.equal(await balance(o.customer), 20); await ledgerMatches(o.customer);
  });

  await check('[#2] a stale attempt cannot reverse a newer attempt\'s successful refund', async () => {
    const o = await paidOrder(); await reject(o.id);
    gateway.next.push('hang');
    const stale = refunds.refundToSource(o.id, o.customer); // attempt A hangs inside the gateway call
    while (!gateway.hung) await new Promise(r => setTimeout(r, 10));
    const hung = gateway.hung; gateway.hung = undefined;
    await expireLease(o.id);
    const b = await refunds.advanceSource(o.id); // attempt B takes over and completes
    assert.equal(b?.prescriptionRefund?.status, 'source_refunded');
    hung.reject(Object.assign(new Error('BAD_REQUEST'), { statusCode: 400 })); // A finally gets a 400
    await stale.catch(() => undefined);
    assert.equal((await refundOf(o.id)).status, 'source_refunded');
    assert.equal(await balance(o.customer), 20, 'stale attempt must not re-credit the wallet');
    assert.equal(gateway.refunds.get(o.paymentId)!.length, 1); await ledgerMatches(o.customer);
  });

  await check('[#2] 400 for a refund that was actually created (duplicate receipt) is NOT compensated', async () => {
    const o = await paidOrder(); await reject(o.id);
    gateway.next.push('createThen400');
    assert.equal((await refunds.refundToSource(o.id, o.customer)).prescriptionRefund?.status, 'source_refunded');
    assert.equal(await balance(o.customer), 20); await ledgerMatches(o.customer);
  });

  await check('genuine 400 with no refund created: money back to wallet once; retry later succeeds', async () => {
    const o = await paidOrder(); await reject(o.id);
    gateway.next.push('refuse400');
    await rejects(refunds.refundToSource(o.id, o.customer), 'SOURCE_REFUND_REJECTED', 502);
    const r = await refundOf(o.id);
    assert.equal(r.status, 'wallet_credited'); assert.equal(r.lastError, 'GATEWAY_REJECTED');
    assert.equal(await balance(o.customer), 120);
    assert.equal((await refunds.refundToSource(o.id, o.customer)).prescriptionRefund?.status, 'source_refunded');
    assert.equal(await balance(o.customer), 20); await ledgerMatches(o.customer);
  });

  await check('timeout after Razorpay created the refund: the immediate lookup finds it, completes, no 2nd refund', async () => {
    const o = await paidOrder(); await reject(o.id);
    gateway.next.push('createThenTimeout');
    assert.equal((await refunds.refundToSource(o.id, o.customer)).prescriptionRefund?.status, 'source_refunded');
    assert.equal(gateway.refunds.get(o.paymentId)!.length, 1); await ledgerMatches(o.customer);
  });

  await check('[#6] created then provider unreachable, customer never returns: reconciler completes, no 2nd refund', async () => {
    const o = await paidOrder(); await reject(o.id);
    gateway.next.push('createThenOutage');
    assert.equal((await refunds.refundToSource(o.id, o.customer)).prescriptionRefund?.status, 'source_processing');
    gateway.listFails = false; // provider back
    await refunds.reconcileDue();
    assert.equal((await refundOf(o.id)).status, 'source_refunded');
    assert.equal(gateway.refunds.get(o.paymentId)!.length, 1); assert.equal(await balance(o.customer), 20);
    await ledgerMatches(o.customer);
  });

  await check('[#6] timeout before creation + lookup outage: no blind refund; reconciler finishes once lookups work', async () => {
    const o = await paidOrder(); await reject(o.id);
    gateway.next.push('timeout');
    await refunds.refundToSource(o.id, o.customer);
    gateway.listFails = true;
    try { await refunds.reconcileDue(); } finally { gateway.listFails = false; }
    assert.equal(gateway.refunds.get(o.paymentId), undefined, 'nothing created while lookups failed');
    await refunds.reconcileDue();
    assert.equal((await refundOf(o.id)).status, 'source_refunded');
    assert.equal(gateway.refunds.get(o.paymentId)!.length, 1); await ledgerMatches(o.customer);
  });

  await check('five concurrent transfer requests: one debit, one Razorpay refund', async () => {
    const o = await paidOrder(); await reject(o.id);
    await Promise.allSettled(Array.from({ length: 5 }, () => refunds.refundToSource(o.id, o.customer)));
    assert.equal(gateway.refunds.get(o.paymentId)!.length, 1);
    assert.equal((await txns(o.customer)).filter(t => t.transactionType === 'debit').length, 1);
    assert.equal(await balance(o.customer), 20); await ledgerMatches(o.customer);
  });

  await check('HTTP: customer transfer, pharmacy retry, admin attention queue through the real router and auth', async () => {
    await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(pharmacyA), isActive: true, isVerified: true } as never);
    Container.set(PharmacyOrderService, orders);
    const { default: router } = await import('@/modules/pharmacyOrders/routes');
    const { authenticate } = await import('@/modules/middleware/auth');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/pharmacy-orders', authenticate, router);
    app.use((err: { status?: number; code?: string }, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
      res.status(err.status ?? 500).json({ success: false, code: err.code });
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const call = async (method: string, path: string, claims: { _id?: unknown; userType?: unknown }) => fetch(`http://127.0.0.1:${port}/api/v1/pharmacy-orders${path}`,
        { method, headers: { authorization: 'Bearer ' + await bearer(claims), 'content-type': 'application/json' },
          body: method === 'POST' ? '{}' : undefined });
      const pharmacy = { _id: pharmacyA, pharmacyId: pharmacyA, userType: 'pharmacy' };
      const o = await paidOrder(); await reject(o.id);
      assert.equal((await call('POST', `/${o.id}/prescription-refund/to-source`, pharmacy)).status, 403);
      const res = await call('POST', `/${o.id}/prescription-refund/to-source`, { _id: o.customer, userType: 'user' });
      assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'private, no-store');
      assert.equal(((await res.json()) as { data: { prescriptionRefund: { status: string } } }).data.prescriptionRefund.status, 'source_refunded');
      assert.equal((await call('POST', `/${o.id}/prescription-refund/retry`, pharmacy)).status, 409);
      // confirmed provider failure -> honest "back in your wallet" (not "being confirmed")
      const f = await paidOrder(); await reject(f.id);
      gateway.next.push('failedNow');
      const fr = await call('POST', `/${f.id}/prescription-refund/to-source`, { _id: f.customer, userType: 'user' });
      const fb = await fr.json() as { message: string; data: { prescriptionRefund: { status: string } } };
      assert.equal(fr.status, 200); assert.equal(fb.data.prescriptionRefund.status, 'wallet_credited'); assert.match(fb.message, /in your wallet/);
      // retry that ends in manual review -> says so, not "credited"
      const m = await paidOrder({ walletActive: false }); await reject(m.id);
      const mw = (await WalletModel.findOne({ userId: m.customer }).lean())!;
      await WalletTransactionModel.create({ userId: m.customer, walletId: mw._id, transactionType: 'refund', amount: 5, balanceBefore: 0, balanceAfter: 0,
        status: 'completed', referenceType: 'pharmacy_order', referenceId: m.id, transactionDate: '20261113' });
      await WalletModel.updateOne({ userId: m.customer }, { $set: { isActive: true, balance: 5 } });
      const mr = await call('POST', `/${m.id}/prescription-refund/retry`, pharmacy);
      const mb = await mr.json() as { message: string; data: { prescriptionRefund: { status: string } } };
      assert.equal(mb.data.prescriptionRefund.status, 'manual_review'); assert.match(mb.message, /manual review/);
      assert.equal((await call('GET', '/prescription-refunds/attention', pharmacy)).status, 403);
      const q = await call('GET', '/prescription-refunds/attention', { _id: new Types.ObjectId().toHexString(), userType: 'admin' });
      assert.equal(q.status, 200);
      const rows = ((await q.json()) as { data: { prescriptionRefund: { status: string } }[] }).data;
      assert.ok(rows.length > 0);
      assert.ok(rows.every(x => ['manual_review', 'wallet_pending', 'source_processing'].includes(x.prescriptionRefund.status)));
    } finally { server.close(); }
  });

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); },
  async (error) => { console.error(error); process.exitCode = 1; await mongoose.disconnect(); });
