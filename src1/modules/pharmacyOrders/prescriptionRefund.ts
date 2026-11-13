import { Service } from 'typedi';
import { ClientSession, startSession, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import Razorpay from 'razorpay';
import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';
import { getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { IPharmacyOrder, PrescriptionRefund } from '@/modules/pharmacyOrders/types';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository } from '@/modules/wallet/repository';
import logger from '@/services/logger';

/** Minimal gateway surface used for refunds; amounts are in paise. */
export interface GatewayRefund { id: string; amount: number; status: string; paymentId?: string; notes?: Record<string, unknown> }
export interface RefundGateway {
  /** Every refund on the payment (all pages). */
  listRefunds(paymentId: string): Promise<GatewayRefund[]>;
  fetchRefund(paymentId: string, refundId: string): Promise<GatewayRefund>;
  refund(paymentId: string, body: { amount: number; receipt: string; notes: Record<string, string> }): Promise<GatewayRefund>;
}

const GATEWAY_TIMEOUT_MS = 20_000;
/** Total budget for listing all refunds of a payment (all pages). */
const LIST_DEADLINE_MS = 60_000;
/** > worst case per attempt: list (60s) + create (20s) + list (60s) + fetch (20s). DB writes are also attemptId-fenced. */
const SOURCE_LEASE_MS = 300_000;
const MAX_AUTOMATIC_ATTEMPTS = 20;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('gateway timeout'), { gatewayTimeout: true })), GATEWAY_TIMEOUT_MS);
  })]).finally(() => clearTimeout(timer));
}

const toRefund = (raw: object): GatewayRefund => {
  const r = raw as { id: string; amount: unknown; status: unknown; payment_id?: unknown; notes?: unknown };
  return { id: r.id, amount: Number(r.amount), status: String(r.status), paymentId: r.payment_id ? String(r.payment_id) : undefined,
    notes: r.notes as Record<string, unknown> };
};

@Service()
export class RazorpayRefundGateway implements RefundGateway {
  private client?: Razorpay;
  private razorpay(): Razorpay {
    if (!CONFIG.RAZORPAY_KEY_ID || !CONFIG.RAZORPAY_KEY_SECRET) {
      throw new AppError({ status: 503, code: 'RAZORPAY_NOT_CONFIGURED', message: 'Refunds to the original payment method are unavailable' });
    }
    this.client ??= new Razorpay({ key_id: CONFIG.RAZORPAY_KEY_ID, key_secret: CONFIG.RAZORPAY_KEY_SECRET });
    return this.client;
  }
  async listRefunds(paymentId: string): Promise<GatewayRefund[]> {
    const all: GatewayRefund[] = [];
    const deadline = Date.now() + LIST_DEADLINE_MS;
    for (let skip = 0; skip < 10_000; skip += 100) {
      if (Date.now() > deadline) throw new Error('Refund lookup exceeded its deadline');
      const page = await withTimeout(this.razorpay().payments.fetchMultipleRefund(paymentId, { count: 100, skip }));
      all.push(...page.items.map(toRefund));
      if (page.items.length < 100) return all;
    }
    throw new Error('Too many refunds on one payment');
  }
  async fetchRefund(paymentId: string, refundId: string): Promise<GatewayRefund> {
    return toRefund(await withTimeout(this.razorpay().payments.fetchRefund(paymentId, refundId)));
  }
  async refund(paymentId: string, body: { amount: number; receipt: string; notes: Record<string, string> }): Promise<GatewayRefund> {
    return toRefund(await withTimeout(this.razorpay().payments.refund(paymentId,
      { amount: body.amount, speed: 'normal', receipt: body.receipt, notes: body.notes })));
  }
}

/** One receipt per transfer generation (<= 40 chars): an old failed refund never matches a new attempt. */
const receiptKey = (orderId: string, generation: number) => `rx-${orderId}-${generation}`;

const notFound = () => new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });

/** Why the order was refunded; shown on the customer's wallet history. */
export type RefundCause = 'prescription_rejected' | 'delivery_not_collected' | 'delivery_refused';
const REFUND_DESCRIPTION: Record<RefundCause, string> = {
  prescription_rejected: 'Refund for pharmacy order rejected by pharmacist',
  delivery_not_collected: 'Refund for pharmacy order not collected',
  delivery_refused: 'Refund for pharmacy order refused at delivery',
};
/**
 * Every ledger reference, operation key and Razorpay receipt uses this canonical form (lowercase hex, as
 * String(ObjectId) produces), whatever spelling the request URL used.
 */
const canonicalOrderId = (id: unknown): string => {
  if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) throw notFound();
  return id.toLowerCase();
};
const stateChanged = () => new AppError({ status: 409, code: 'REFUND_STATE_CHANGED', message: 'Refund state changed; reload and try again' });
const sameRupees = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);

/**
 * Refunds for pharmacist-rejected prescription orders that were already paid. Owner policy: "customer chooses".
 * 1. The refund intent is written in the same transaction as the rejection (buildIntent), then the whole paid
 *    amount (gateway + wallet portion) is credited to the payer's wallet (settleWallet; retried by the reconciler).
 * 2. The payer may move the gateway-paid portion back to the original card/UPI (refundToSource): wallet debit,
 *    then a Razorpay refund. Each attempt owns a fenced attemptId; only a refund Razorpay reports "processed"
 *    completes it; "pending" stays reconcilable; "failed", or a 400 with no matching refund on a fresh lookup,
 *    re-credits the wallet exactly once. Unknown outcomes are reconciled by the scheduled reconciler.
 */
@Service()
export class PrescriptionRefundService {
  constructor(private gateway: RazorpayRefundGateway, private wallets: WalletRepository = new WalletRepository()) {}

  private async inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => { result = await work(session); });
      return result as T;
    } finally { await session.endSession(); }
  }

  /** Refund intent for a paid order, computed from its PaymentRecord. Used inside the rejection transaction. */
  async buildIntent(order: Pick<IPharmacyOrder, '_id' | 'paymentTransactionId'>, session?: ClientSession,
    cause: RefundCause = 'prescription_rejected'): Promise<PrescriptionRefund> {
    const orderId = canonicalOrderId(String(order._id));
    const now = new Date();
    const linked = order.paymentTransactionId && Types.ObjectId.isValid(String(order.paymentTransactionId))
      ? await PaymentRecordModel.findById(String(order.paymentTransactionId)).session(session ?? null).lean() : null;
    const record = linked ?? await PaymentRecordModel.findOne({ context: 'pharmacy_order', contextId: orderId, status: 'paid' }).session(session ?? null).lean();
    if (!record || record.context !== 'pharmacy_order' || record.contextId !== orderId || record.status !== 'paid') {
      return { cause, status: 'manual_review', walletAmount: 0, gatewayAmountPaise: 0, generation: 0, lastError: 'PAID_PAYMENT_RECORD_NOT_FOUND', updatedAt: now };
    }
    const walletPart = Number(record.notes?.walletDeductedAmount || 0);
    const gatewayPart = Number(record.finalAmount || 0);
    const gatewayPaise = record.paymentGateway === 'razorpay' && record.razorpayPaymentId
      ? (Number.isSafeInteger(record.finalAmountPaise) ? Number(record.finalAmountPaise) : Math.round(gatewayPart * 100)) : 0;
    if (!Number.isFinite(walletPart) || walletPart < 0 || !Number.isFinite(gatewayPart) || gatewayPart < 0 ||
      (gatewayPaise > 0 && Math.round(gatewayPart * 100) !== gatewayPaise)) {
      return { cause, status: 'manual_review', walletAmount: 0, gatewayAmountPaise: 0, generation: 0, lastError: 'PAYMENT_AMOUNT_INVALID', updatedAt: now };
    }
    return { cause, status: 'wallet_pending', payerUserId: String(record.payerUserId || record.userId), paymentRecordId: String(record._id),
      walletAmount: Math.round((walletPart + gatewayPart) * 100) / 100, gatewayAmountPaise: gatewayPaise, generation: 0,
      ...(gatewayPaise > 0 ? { razorpayPaymentId: record.razorpayPaymentId } : {}), updatedAt: now };
  }

  /** Recovery for a rejected refund-required order that somehow has no intent (e.g. data from before P2). */
  private async ensureIntent(orderId: string): Promise<void> {
    orderId = canonicalOrderId(orderId);
    const order = await PharmacyOrderModel.findById(orderId).lean();
    if (!order || order.prescriptionRefund || order.prescriptionStatus !== 'rejected' || !order.prescriptionReview?.refundRequired) return;
    const intent = await this.buildIntent(order as IPharmacyOrder);
    await PharmacyOrderModel.updateOne({ _id: orderId, prescriptionRefund: { $exists: false } }, { $set: { prescriptionRefund: intent } });
  }

  /** Credits the wallet for a wallet_pending refund. Idempotent; fenced by the order state. */
  async settleWallet(orderId: string): Promise<IPharmacyOrder> {
    orderId = canonicalOrderId(orderId);
    const initial = await PharmacyOrderModel.findById(orderId).lean();
    if (!initial) throw notFound();
    const pending = initial.prescriptionRefund;
    if (!pending || pending.status !== 'wallet_pending' || !pending.payerUserId) return initial as IPharmacyOrder;
    const payer = pending.payerUserId;
    if (pending.walletAmount > 0 && !(await WalletModel.exists({ userId: payer }))) {
      await WalletModel.updateOne({ userId: payer }, { $setOnInsert: { userId: payer, balance: 0, isActive: true } }, { upsert: true });
    }
    try {
      await this.inTransaction(async session => {
        const order = await PharmacyOrderModel.findById(orderId).session(session).lean();
        const refund = order?.prescriptionRefund;
        if (refund?.status !== 'wallet_pending') return true;
        const amount = refund.walletAmount;
        const prior = await WalletTransactionModel.find({ userId: payer, transactionType: 'refund', referenceType: 'pharmacy_order',
          referenceId: orderId, status: 'completed' }).session(session).lean();
        const fence = { _id: orderId, 'prescriptionRefund.status': 'wallet_pending' };
        if (prior.length) {
          // An earlier refund for this order exists (e.g. the late-payment path). Only an exact full match settles it.
          const priorTotal = prior.reduce((sum, t) => sum + Number(t.amount || 0), 0);
          if (!sameRupees(priorTotal, amount)) {
            const flagged = await PharmacyOrderModel.updateOne(fence, { $set: { 'prescriptionRefund.status': 'manual_review',
              'prescriptionRefund.lastError': 'PRIOR_REFUND_AMOUNT_MISMATCH', 'prescriptionRefund.updatedAt': new Date() } }, { session });
            if (flagged.modifiedCount !== 1) throw stateChanged();
            return true;
          }
        } else if (amount > 0) {
          const wallet = await WalletModel.findOne({ userId: payer }).session(session).lean();
          if (!wallet?.isActive) throw new AppError({ status: 409, code: 'WALLET_INACTIVE', message: 'Customer wallet is not active' });
          await this.wallets.postEntry({ userId: payer, walletId: wallet._id, transactionType: 'refund', amount, referenceType: 'pharmacy_order',
            referenceId: orderId, operationKey: `pharmacy_order_refund:${orderId}`, description: REFUND_DESCRIPTION[refund.cause ?? 'prescription_rejected'],
            transactionDate: getTodayYyyymmdd() }, session);
        }
        const moved = await PharmacyOrderModel.updateOne(fence,
          { $set: { 'prescriptionRefund.status': 'wallet_credited', 'prescriptionRefund.walletCreditedAt': new Date(),
            'prescriptionRefund.updatedAt': new Date(), paymentStatus: 'refunded' }, $unset: { 'prescriptionRefund.lastError': '' } }, { session });
        if (moved.modifiedCount !== 1) throw stateChanged();
        if (refund.paymentRecordId) {
          await PaymentRecordModel.updateOne({ _id: refund.paymentRecordId, status: 'paid' }, { $set: { status: 'refunded', isProcessed: true } }, { session });
        }
        return true;
      });
    } catch (error) {
      await PharmacyOrderModel.updateOne({ _id: orderId, 'prescriptionRefund.status': 'wallet_pending' },
        { $set: { 'prescriptionRefund.lastError': (error as { code?: string }).code ?? 'WALLET_CREDIT_FAILED', 'prescriptionRefund.updatedAt': new Date() } });
      throw error;
    }
    return (await PharmacyOrderModel.findById(orderId).lean()) as IPharmacyOrder;
  }

  /** After the rejection commit: credit now if possible. Never throws; the reconciler retries wallet_pending. */
  async settleAfterRejection(orderId: string): Promise<void> {
    try { await this.settleWallet(canonicalOrderId(orderId)); }
    catch (error) {
      logger.error('Prescription refund wallet credit deferred to reconciler', { orderId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Pharmacy (own order) or admin: create a missing intent and/or retry a pending wallet credit. */
  async retryWalletCredit(orderId: string, actor: { userType: string; pharmacyId?: string }): Promise<IPharmacyOrder> {
    orderId = canonicalOrderId(orderId);
    const order = await PharmacyOrderModel.findById(orderId).lean();
    if (!order) throw notFound();
    if (actor.userType !== 'admin' && !(actor.userType === 'pharmacy' && actor.pharmacyId && String(order.pharmacyId) === actor.pharmacyId)) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    await this.ensureIntent(orderId);
    const current = await PharmacyOrderModel.findById(orderId).lean();
    if (current?.prescriptionRefund?.status !== 'wallet_pending') {
      throw new AppError({ status: 409, code: 'REFUND_NOT_PENDING', message: 'There is no pending wallet refund for this order' });
    }
    return this.settleWallet(orderId);
  }

  /** Payer moves the gateway-paid amount from the wallet back to the original card/UPI. */
  async refundToSource(orderId: string, actorUserId: string): Promise<IPharmacyOrder> {
    orderId = canonicalOrderId(orderId);
    const order = await PharmacyOrderModel.findById(orderId).lean();
    const refund = order?.prescriptionRefund;
    if (!order || !refund || refund.payerUserId !== actorUserId) throw notFound();
    if (!refund.razorpayPaymentId || !Number.isSafeInteger(refund.gatewayAmountPaise) || refund.gatewayAmountPaise <= 0) {
      throw new AppError({ status: 409, code: 'SOURCE_REFUND_NOT_AVAILABLE', message: 'This refund cannot be sent to the original payment method' });
    }
    if (refund.status === 'source_refunded') return order as IPharmacyOrder;
    if (refund.status === 'source_processing') {
      const resumed = await this.advanceSource(orderId);
      if (!resumed) throw new AppError({ status: 409, code: 'SOURCE_REFUND_IN_PROGRESS', message: 'This refund is already being processed' });
      return resumed;
    }
    if (refund.status !== 'wallet_credited') {
      throw new AppError({ status: 409, code: 'SOURCE_REFUND_NOT_AVAILABLE', message: 'This refund cannot be sent to the original payment method yet' });
    }
    const amount = refund.gatewayAmountPaise / 100;
    const attemptId = randomUUID();
    const now = new Date();
    await this.inTransaction(async session => {
      const claimed = await PharmacyOrderModel.updateOne({ _id: orderId, 'prescriptionRefund.status': 'wallet_credited',
        'prescriptionRefund.generation': refund.generation ?? 0 },
        { $set: { 'prescriptionRefund.status': 'source_processing', 'prescriptionRefund.updatedAt': now,
          'prescriptionRefund.generation': (refund.generation ?? 0) + 1,
          'prescriptionRefund.source': { attemptId, requestedAt: now, leaseUntil: new Date(now.getTime() + SOURCE_LEASE_MS), attempts: 1 } },
          $unset: { 'prescriptionRefund.lastError': '' } }, { session });
      if (claimed.modifiedCount !== 1) throw stateChanged();
      const wallet = await WalletModel.findOne({ userId: actorUserId }).session(session).lean();
      const debited = wallet?.isActive ? await this.wallets.postEntry({ userId: actorUserId, walletId: wallet._id, transactionType: 'debit', amount,
        referenceType: 'pharmacy_order_source_refund', referenceId: orderId, description: 'Moved to original payment method',
        operationKey: `pharmacy_order_source_debit:${orderId}:${(refund.generation ?? 0) + 1}`,
        transactionDate: getTodayYyyymmdd() }, session) : null;
      if (!debited) {
        throw new AppError({ status: 409, code: 'WALLET_BALANCE_INSUFFICIENT', message: 'The refunded amount is no longer fully available in your wallet' });
      }
      return true;
    });
    return this.runAttempt(orderId, attemptId);
  }

  /** Claim an expired/unowned source_processing refund and push it forward. Returns null if someone else owns it. */
  async advanceSource(orderId: string): Promise<IPharmacyOrder | null> {
    orderId = canonicalOrderId(orderId);
    const attemptId = randomUUID();
    const now = new Date();
    const claimed = await PharmacyOrderModel.updateOne({ _id: orderId, 'prescriptionRefund.status': 'source_processing',
      $or: [{ 'prescriptionRefund.source.leaseUntil': { $lte: now } }, { 'prescriptionRefund.source.leaseUntil': { $exists: false } }] },
      { $set: { 'prescriptionRefund.source.attemptId': attemptId, 'prescriptionRefund.source.leaseUntil': new Date(now.getTime() + SOURCE_LEASE_MS),
        'prescriptionRefund.updatedAt': now }, $inc: { 'prescriptionRefund.source.attempts': 1 } });
    if (claimed.modifiedCount !== 1) return null;
    return this.runAttempt(orderId, attemptId);
  }

  private fence(orderId: string, attemptId: string) {
    return { _id: orderId, 'prescriptionRefund.status': 'source_processing', 'prescriptionRefund.source.attemptId': attemptId };
  }

  /** Work for one owned attempt. Every write is fenced by attemptId, so a stale worker cannot change anything. */
  private async runAttempt(orderId: string, attemptId: string): Promise<IPharmacyOrder> {
    const order = (await PharmacyOrderModel.findOne(this.fence(orderId, attemptId)).lean()) as IPharmacyOrder | null;
    const refund = order?.prescriptionRefund;
    if (!order || !refund?.source || !refund.razorpayPaymentId || !refund.payerUserId) {
      return (await PharmacyOrderModel.findById(orderId).lean()) as IPharmacyOrder;
    }
    const paymentId = refund.razorpayPaymentId;
    const paise = refund.gatewayAmountPaise;
    const key = receiptKey(orderId, refund.generation);
    // Identify by operation key only; amount/payment are validated afterwards so a wrong refund is flagged, not hidden.
    const ours = (r: GatewayRefund) => r.notes?.swasthadisha_refund_key === key;

    const lookup = async (): Promise<GatewayRefund | undefined> => refund.source?.razorpayRefundId
      ? await this.gateway.fetchRefund(paymentId, refund.source.razorpayRefundId)
      : (await this.gateway.listRefunds(paymentId)).find(ours);

    let found: GatewayRefund | undefined;
    try { found = await lookup(); }
    catch { return this.release(orderId, attemptId, 'GATEWAY_LOOKUP_FAILED'); }

    if (!found) {
      // Count every submission for this generation BEFORE sending it (fenced). A submission that never got a clear
      // answer may still complete at Razorpay later, so only a generation's single, clearly refused submission
      // can ever be compensated.
      const marked = await PharmacyOrderModel.findOneAndUpdate(this.fence(orderId, attemptId),
        { $inc: { 'prescriptionRefund.source.submissions': 1 }, $set: { 'prescriptionRefund.source.lastSubmittedAt': new Date() } },
        { new: true }).lean();
      if (!marked) return (await PharmacyOrderModel.findById(orderId).lean()) as IPharmacyOrder;
      const submissions = marked.prescriptionRefund?.source?.submissions ?? 0;
      try {
        found = await this.gateway.refund(paymentId, { amount: paise, receipt: key, notes: { swasthadisha_refund_key: key, order_id: orderId } });
      } catch (error) {
        let after: GatewayRefund | undefined;
        try { after = (await this.gateway.listRefunds(paymentId)).find(ours); }
        catch { return this.release(orderId, attemptId, 'GATEWAY_OUTCOME_UNKNOWN'); }
        if (after) found = after;
        else if (submissions === 1 && (error as { statusCode?: unknown })?.statusCode === 400) {
          await this.compensate(orderId, attemptId, refund.payerUserId, paise / 100, refund.generation, 'GATEWAY_REJECTED');
          throw new AppError({ status: 502, code: 'SOURCE_REFUND_REJECTED', message: 'The payment provider refused the refund; the amount is back in your wallet' });
        } else return this.release(orderId, attemptId, submissions > 1 ? 'GATEWAY_SUBMISSION_UNRESOLVED' : 'GATEWAY_OUTCOME_UNKNOWN');
      }
    }
    if (found.amount !== paise || (found.paymentId && found.paymentId !== paymentId)) {
      return this.release(orderId, attemptId, 'GATEWAY_REFUND_MISMATCH', MAX_AUTOMATIC_ATTEMPTS);
    }
    await PharmacyOrderModel.updateOne(this.fence(orderId, attemptId),
      { $set: { 'prescriptionRefund.source.razorpayRefundId': found.id, 'prescriptionRefund.source.razorpayStatus': found.status } });

    if (found.status === 'processed') {
      await PharmacyOrderModel.updateOne(this.fence(orderId, attemptId),
        { $set: { 'prescriptionRefund.status': 'source_refunded', 'prescriptionRefund.source.refundedAt': new Date(), 'prescriptionRefund.updatedAt': new Date() },
          $unset: { 'prescriptionRefund.lastError': '', 'prescriptionRefund.source.leaseUntil': '', 'prescriptionRefund.source.attemptId': '' } });
      return (await PharmacyOrderModel.findById(orderId).lean()) as IPharmacyOrder;
    }
    if (found.status === 'failed') {
      // Razorpay's terminal failure for this exact refund: the money did not leave, so restore the wallet.
      await this.compensate(orderId, attemptId, refund.payerUserId, paise / 100, refund.generation, 'GATEWAY_REFUND_FAILED');
      return (await PharmacyOrderModel.findById(orderId).lean()) as IPharmacyOrder;
    }
    return this.release(orderId, attemptId, 'GATEWAY_REFUND_PENDING'); // pending (or unknown): reconciler checks again
  }

  /** Keep source_processing, record why, and free the lease (fenced) so a later attempt reconciles first. */
  private async release(orderId: string, attemptId: string, reason: string, attemptsFloor?: number): Promise<IPharmacyOrder> {
    await PharmacyOrderModel.updateOne(this.fence(orderId, attemptId),
      { $set: { 'prescriptionRefund.lastError': reason, 'prescriptionRefund.source.leaseUntil': new Date(), 'prescriptionRefund.updatedAt': new Date() },
        $unset: { 'prescriptionRefund.source.attemptId': '' },
        ...(attemptsFloor ? { $max: { 'prescriptionRefund.source.attempts': attemptsFloor } } : {}) });
    return (await PharmacyOrderModel.findById(orderId).lean()) as IPharmacyOrder;
  }

  /** Confirmed no money left via the gateway: back to the wallet exactly once (fenced by attemptId). */
  private async compensate(orderId: string, attemptId: string, payer: string, amount: number, generation: number, reason: string): Promise<void> {
    await this.inTransaction(async session => {
      const moved = await PharmacyOrderModel.updateOne(this.fence(orderId, attemptId),
        { $set: { 'prescriptionRefund.status': 'wallet_credited', 'prescriptionRefund.lastError': reason, 'prescriptionRefund.updatedAt': new Date() },
          $unset: { 'prescriptionRefund.source': '' } }, { session });
      if (moved.modifiedCount !== 1) return true;
      const wallet = await WalletModel.findOne({ userId: payer }).session(session).lean();
      if (!wallet) throw new AppError({ status: 500, code: 'WALLET_REVERSAL_FAILED', message: 'Wallet could not be re-credited' });
      await this.wallets.postEntry({ userId: payer, walletId: wallet._id, transactionType: 'refund', amount,
        referenceType: 'pharmacy_order_source_refund_reversal', referenceId: orderId,
        operationKey: `pharmacy_order_source_reversal:${orderId}:${generation}`,
        description: 'Refund to original payment method did not complete; returned to wallet', transactionDate: getTodayYyyymmdd() }, session);
      return true;
    });
  }

  /**
   * Scheduled sweep: settles wallet_pending refunds (missing intents first) and pushes unattended
   * source_processing refunds forward. Bounded per run; refunds over the attempt cap are left for operators.
   */
  async reconcileDue(limit = 25): Promise<{ wallet: number; source: number }> {
    const counts = { wallet: 0, source: 0 };
    const missing = await PharmacyOrderModel.find({ prescriptionStatus: 'rejected', 'prescriptionReview.refundRequired': true,
      prescriptionRefund: { $exists: false } }).select('_id').limit(limit).lean();
    for (const o of missing) await this.ensureIntent(String(o._id)).catch(() => undefined);
    const wallet = await PharmacyOrderModel.find({ 'prescriptionRefund.status': 'wallet_pending' })
      .sort({ 'prescriptionRefund.updatedAt': 1 }).select('_id').limit(limit).lean();
    for (const o of wallet) { try { await this.settleWallet(String(o._id)); counts.wallet++; } catch { /* lastError recorded */ } }
    const source = await PharmacyOrderModel.find({ 'prescriptionRefund.status': 'source_processing',
      'prescriptionRefund.source.attempts': { $lt: MAX_AUTOMATIC_ATTEMPTS },
      $or: [{ 'prescriptionRefund.source.leaseUntil': { $lte: new Date() } }, { 'prescriptionRefund.source.leaseUntil': { $exists: false } }] })
      .sort({ 'prescriptionRefund.updatedAt': 1 }).select('_id').limit(limit).lean();
    for (const o of source) { try { if (await this.advanceSource(String(o._id))) counts.source++; } catch { /* recorded */ } }
    return counts;
  }

  /** Operator queue: everything that did not settle on its own. */
  async needsAttention(limit = 50): Promise<IPharmacyOrder[]> {
    return (await PharmacyOrderModel.find({ $or: [
      { 'prescriptionRefund.status': { $in: ['manual_review', 'wallet_pending'] } },
      { 'prescriptionRefund.status': 'source_processing', 'prescriptionRefund.source.attempts': { $gte: MAX_AUTOMATIC_ATTEMPTS } },
    ] }).sort({ 'prescriptionRefund.updatedAt': 1 }).limit(Math.min(Math.max(1, limit), 100))
      .select('_id orderNumber pharmacyId customerId status paymentStatus prescriptionRefund updatedAt').lean()) as IPharmacyOrder[];
  }
}
