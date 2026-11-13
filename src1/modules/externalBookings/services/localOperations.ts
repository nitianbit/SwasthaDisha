import { randomUUID } from 'crypto';
import { ClientSession } from 'mongoose';
import ExternalBookingModel from '@/modules/externalBookings/model';
import PaymentModel from '@/modules/payment/model';
import CouponModel from '@/modules/coupon/model';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { AppError } from '@/modules/common/types';
import { IExternalBooking, IExternalBookingLocalEffects } from '@/modules/externalBookings/types';
import { IPaymentRecord } from '@/modules/payment/types';
import { bookingMoneyPaise } from '@/modules/bookings/services/localOperations';
import { getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';

type Actor = { _id: string; userType: string };
const LIMIT = 128;
const SETUP_MS = 300000;
function conflict(message = 'External booking requires reconciliation'): never {
  throw new AppError({ status: 409, code: 'EXTERNAL_BOOKING_RECONCILIATION_REQUIRED', message });
}
function pending(): never {
  throw new AppError({ status: 409, code: 'EXTERNAL_CANCELLATION_PENDING', message: 'Provider outcome is pending reconciliation; cancellation is not complete' });
}
function sum(values: number[]): number {
  const amount = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(amount) || amount < 0) conflict('Invalid external-booking funding total');
  return amount;
}
function state(booking: IExternalBooking): IExternalBookingLocalEffects {
  const s = booking.localEffects;
  if (!s || s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 ||
      !Number.isSafeInteger(s.setupDeadlineMs) || s.setupDeadlineMs < 0 ||
      [s.setupToken, s.providerToken, s.providerPaymentId, s.cancelToken].some(value => value !== null && (typeof value !== 'string' || !value)) ||
      [s.setupFailed, s.cancelRequested, s.cancelled, s.providerAttempted, s.providerCompleted, s.providerUnknown, s.providerCancelAck].some(value => typeof value !== 'boolean') ||
      [s.walletDebitedPaise, s.walletRefundedPaise].some(value => !Number.isSafeInteger(value) || value < 0) ||
      [s.settledPaymentIds, s.couponPaymentIds, s.reversedCouponPaymentIds].some(ids => !Array.isArray(ids) || ids.length > LIMIT ||
        new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)))) conflict();
  return s;
}
export function publicExternalBooking(booking: IExternalBooking): IExternalBooking {
  const { localEffects: _internal, ...visible } = booking;
  return visible;
}

/** Only local financial/provisioning effects. All provider calls stay outside these transactions. */
export class ExternalBookingLocalOperations {
  private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const connection = ExternalBookingModel.db;
    if ([PaymentModel, CouponModel, WalletModel, WalletTransactionModel].some(model => model.db !== connection)) conflict('External booking collections use different connections');
    const session = await connection.startSession();
    let result: T | undefined;
    try {
      await session.withTransaction(async () => { result = await work(session); },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      if (result === undefined) conflict('External booking transaction did not complete');
      return result;
    } finally { await session.endSession(); }
  }
  private async read(id: string, session: ClientSession, owner?: string): Promise<IExternalBooking> {
    const booking = await ExternalBookingModel.findOne({ _id: id, ...(owner ? { userId: { $eq: owner } } : {}),
      $expr: { $eq: [{ $type: '$userId' }, 'string'] } }).session(session).select('+localEffects').lean().exec();
    if (!booking) throw new AppError({ status: 404, code: 'EXTERNAL_BOOKING_NOT_FOUND', message: 'External booking not found' });
    state(booking); return booking;
  }
  private async owned(id: string, actor: Actor, session: ClientSession): Promise<IExternalBooking> {
    if (!actor?._id || typeof actor._id !== 'string' || !['user', 'admin'].includes(actor.userType)) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Customer or admin access is required' });
    }
    return this.read(id, session, actor.userType === 'admin' ? undefined : actor._id);
  }
  private async fence(booking: IExternalBooking, patch: Record<string, unknown>, session: ClientSession): Promise<IExternalBooking> {
    const s = state(booking);
    const result = await ExternalBookingModel.findOneAndUpdate({ _id: booking._id, userId: { $eq: booking.userId },
      status: booking.status, 'localEffects.version': 1, 'localEffects.revision': s.revision,
      $expr: { $eq: [{ $type: '$userId' }, 'string'] } },
    { $set: patch, $inc: { 'localEffects.revision': 1 } }, { new: true, session }).select('+localEffects').lean().exec();
    if (!result) conflict('External booking changed; please retry');
    return result;
  }
  private payment(payment: IPaymentRecord, booking: IExternalBooking): void {
    if (payment.context !== 'external_booking' || payment.contextId !== String(booking._id) || payment.userId !== booking.userId ||
        payment.currency !== 'INR' || (payment.payerUserId && payment.payerUserId !== booking.userId) || payment.payerPharmacyId ||
        !['internal', 'razorpay'].includes(payment.paymentGateway)) conflict('External payment provenance is inconsistent');
    const amount = bookingMoneyPaise(payment.finalAmount);
    if ((payment.finalAmountPaise !== undefined && payment.finalAmountPaise !== amount) ||
        (payment.paymentGateway === 'internal' && amount !== 0) ||
        bookingMoneyPaise(payment.baseAmount) - bookingMoneyPaise(payment.discountAmount) !==
          sum([amount, bookingMoneyPaise(payment.notes?.walletDeductedAmount ?? 0)])) conflict('External payment units are inconsistent');
  }
  async createDraft(input: IExternalBooking): Promise<IExternalBooking> {
    bookingMoneyPaise(input.price ?? 0);
    return this.transaction(async session => {
      const localEffects: IExternalBookingLocalEffects = {
        version: 1, revision: 0, setupToken: null, setupDeadlineMs: 0, setupFailed: false,
        walletDebitedPaise: 0, walletRefundedPaise: 0, settledPaymentIds: [], couponPaymentIds: [], reversedCouponPaymentIds: [],
        cancelRequested: false, cancelled: false, providerAttempted: false, providerCompleted: false, providerUnknown: false,
        providerToken: null, providerPaymentId: null, cancelToken: null, providerCancelAck: false,
      };
      const [document] = await ExternalBookingModel.create([{ ...input, localEffects }], { session });
      return document.toObject();
    });
  }
  async beginSetup(id: string, actor: Actor): Promise<IExternalBooking> {
    return this.transaction(async session => {
      const booking = await this.owned(id, actor, session); const s = state(booking);
      if (s.cancelRequested || s.cancelled || s.providerAttempted || booking.paymentStatus === 'paid' ||
          (s.setupToken && s.setupDeadlineMs > Date.now())) conflict('External booking payment setup cannot start');
      return this.fence(booking, { 'localEffects.setupToken': randomUUID(), 'localEffects.setupDeadlineMs': Date.now() + SETUP_MS,
        'localEffects.setupFailed': false }, session);
    });
  }
  async endSetup(id: string, token: string, failed: boolean): Promise<void> {
    await this.transaction(async session => {
      const booking = await this.read(id, session);
      if (state(booking).setupToken !== token) conflict('External payment setup changed');
      await this.fence(booking, { 'localEffects.setupToken': null, 'localEffects.setupDeadlineMs': 0, 'localEffects.setupFailed': failed }, session);
      return true;
    });
  }
  async debitWallet(id: string, owner: string, token: string, requested: number): Promise<number> {
    const requestedPaise = bookingMoneyPaise(requested);
    return this.transaction(async session => {
      const booking = await this.read(id, session, owner); const s = state(booking);
      if (s.setupToken !== token || s.setupDeadlineMs <= Date.now() || s.cancelRequested || s.cancelled) conflict('External payment setup changed');
      const wallet = await WalletModel.findOne({ userId: owner }).session(session).lean().exec();
      if (!wallet) return 0;
      if (wallet.userId !== owner || !wallet.isActive) conflict('Active owned wallet is required');
      const before = bookingMoneyPaise(wallet.balance); const amount = Math.min(before, requestedPaise);
      if (!amount) return 0;
      const updated = await WalletModel.findOneAndUpdate({ _id: wallet._id, userId: owner, balance: wallet.balance, isActive: true },
        { $set: { balance: (before - amount) / 100 } }, { new: true, session }).lean().exec();
      if (!updated) conflict('External wallet changed');
      await WalletTransactionModel.create([{ userId: owner, walletId: String(wallet._id), transactionType: 'debit', amount: amount / 100,
        balanceBefore: before / 100, balanceAfter: (before - amount) / 100, status: 'completed', referenceType: 'external_booking',
        referenceId: id, description: 'Wallet used for external booking', transactionDate: getTodayYyyymmdd() }], { session });
      await this.fence(booking, { 'localEffects.walletDebitedPaise': sum([s.walletDebitedPaise, amount]) }, session);
      return amount / 100;
    });
  }
  async attachPayment(id: string, token: string, paymentId: string): Promise<IExternalBooking> {
    return this.transaction(async session => {
      const booking = await this.read(id, session); const s = state(booking);
      if (s.setupToken !== token || s.setupDeadlineMs <= Date.now() || s.cancelRequested || s.cancelled) conflict('External payment setup changed');
      const payment = await PaymentModel.findById(paymentId).session(session).lean().exec();
      if (!payment) conflict('External payment is missing'); this.payment(payment, booking);
      if (!['created', 'paid'].includes(payment.status) || bookingMoneyPaise(payment.notes?.walletDeductedAmount ?? 0) !== s.walletDebitedPaise) conflict('External payment funding changed');
      return this.fence(booking, { paymentTransactionId: paymentId, price: sum([bookingMoneyPaise(payment.finalAmount), s.walletDebitedPaise]) / 100,
        paymentStatus: payment.status === 'paid' ? 'paid' : 'pending' }, session);
    });
  }
  async beginProvider(id: string, paymentId?: string): Promise<{ booking: IExternalBooking; token: string | null; shouldFulfill: boolean }> {
    return this.transaction(async session => {
      const booking = await this.read(id, session); const s = state(booking);
      // A caller-owned payment must never gain authority over somebody else's completed/cancelled booking.
      const suppliedPayment = paymentId ? await PaymentModel.findById(paymentId).session(session).lean().exec() : null;
      if (paymentId) {
        if (!suppliedPayment) conflict('External payment is missing');
        this.payment(suppliedPayment, booking);
      }
      if (s.cancelRequested || s.cancelled) {
        const settled = await this.settle(booking, session);
        return { booking: settled, token: null, shouldFulfill: false };
      }
      if (s.setupToken && s.setupDeadlineMs > Date.now()) conflict('External payment setup is in progress');
      if (s.providerCompleted) return { booking, token: null, shouldFulfill: false };
      if (s.providerAttempted) conflict('Prior provider attempt requires reconciliation; it must not be duplicated');
      if (paymentId) {
        const payment = suppliedPayment!;
        if (payment.status !== 'paid' || booking.paymentTransactionId !== String(paymentId) ||
            sum([bookingMoneyPaise(payment.finalAmount), s.walletDebitedPaise]) !== bookingMoneyPaise(booking.price ?? 0) ||
            bookingMoneyPaise(payment.notes?.walletDeductedAmount ?? 0) !== s.walletDebitedPaise) conflict('Captured external funding is inconsistent');
        if (payment.couponCode && !s.couponPaymentIds.includes(String(paymentId))) {
          if (payment.isProcessed) conflict('Legacy coupon application needs reconciliation');
          const coupon = await CouponModel.findOneAndUpdate({ code: payment.couponCode, currentUsageCount: { $gte: 0 } },
            { $inc: { currentUsageCount: 1 } }, { new: true, session }).lean().exec();
          if (!coupon || !Number.isSafeInteger(coupon.currentUsageCount)) conflict('External coupon application failed');
          s.couponPaymentIds.push(String(paymentId));
        }
      } else if (bookingMoneyPaise(booking.price ?? 0) !== 0 || s.walletDebitedPaise !== 0) conflict('Captured external payment is required');
      const token = randomUUID();
      const updated = await this.fence(booking, { 'localEffects.providerAttempted': true, 'localEffects.providerToken': token,
        'localEffects.providerPaymentId': paymentId || null, 'localEffects.providerUnknown': false,
        paymentStatus: 'paid', ...(booking.status === 'pending_payment' ? { status: 'pending' } : {}),
        'localEffects.couponPaymentIds': s.couponPaymentIds }, session);
      return { booking: updated, token, shouldFulfill: true };
    });
  }
  async assertProviderAttempt(id: string, token: string): Promise<void> {
    await this.transaction(async session => {
      const booking = await this.read(id, session); const s = state(booking);
      if (!token || s.providerToken !== token || !s.providerAttempted || s.providerCompleted || s.cancelRequested || s.cancelled) conflict('Provider attempt is no longer admitted');
      return true;
    });
  }
  async recordProviderResult(id: string, token: string, patch: Record<string, unknown>): Promise<IExternalBooking> {
    return this.transaction(async session => {
      const booking = await this.read(id, session); const s = state(booking);
      if (!token || s.providerToken !== token || !s.providerAttempted) conflict('Provider attempt changed');
      if (typeof patch.externalBookingId !== 'string' || !patch.externalBookingId.trim()) conflict('Provider reference is missing');
      if (s.providerCompleted) {
        if (booking.externalBookingId !== patch.externalBookingId) conflict('A completed provider attempt cannot change its reference');
        return booking;
      }
      const allowed: Record<string, unknown> = {};
      for (const key of ['externalProviderId', 'externalBookingId', 'externalSlotRef', 'meetingLink', 'status', 'bookingDate', 'bookingTime'] as const) {
        if (patch[key] !== undefined) {
          if (typeof patch[key] !== 'string') conflict('Invalid provider result field');
          allowed[key] = patch[key];
        }
      }
      const meta = patch.meta && typeof patch.meta === 'object' && !Array.isArray(patch.meta) ? patch.meta as Record<string, unknown> : {};
      if (meta.externalPayload !== undefined) allowed['meta.externalPayload'] = meta.externalPayload;
      if (meta.labAddress !== undefined) {
        if (typeof meta.labAddress !== 'string' || meta.labAddress.length > 4096) conflict('Invalid provider lab address');
        allowed['meta.labAddress'] = meta.labAddress;
      }
      for (const key of ['labLat', 'labLong'] as const) {
        const value = meta[key];
        if (value !== undefined) {
          const bound = key === 'labLat' ? 90 : 180;
          if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > bound) conflict('Invalid provider lab coordinates');
          allowed[`meta.${key}`] = value;
        }
      }
      allowed['meta.pendingHealthians'] = false;
      allowed['meta.pendingLabstack'] = false;
      allowed['meta.providerOutcomeUnknown'] = false;
      if (s.cancelRequested || s.cancelled) {
        allowed.status = 'cancellation_pending'; allowed['meta.needsProviderCancelIfDiscovered'] = true;
        allowed['localEffects.providerCancelAck'] = false;
      } else {
        allowed.paymentStatus = 'paid';
        if (s.providerPaymentId) {
          const payment = await PaymentModel.findById(s.providerPaymentId).session(session).lean().exec();
          if (!payment) conflict('Provider payment is missing'); this.payment(payment, booking);
          if (payment.status !== 'paid') conflict('Provider payment changed');
          await PaymentModel.updateOne({ _id: payment._id, status: 'paid' }, { $set: { isProcessed: true } }, { session });
        }
      }
      return this.fence(booking, { ...allowed, 'localEffects.providerCompleted': true, 'localEffects.providerUnknown': false }, session);
    });
  }
  async failProvider(id: string, token: string, message: string): Promise<void> {
    await this.transaction(async session => {
      const booking = await this.read(id, session); const s = state(booking);
      if (s.providerToken !== token) conflict('Provider attempt changed');
      if (s.providerCompleted) return true;
      await this.fence(booking, { 'localEffects.providerUnknown': true, 'meta.providerOutcomeUnknown': true,
        'meta.providerOutcomeError': String(message).slice(0, 256) }, session); return true;
    });
  }
  async fulfillmentState(id: string): Promise<'completed' | 'pending_confirmation'> {
    return this.transaction(async session => {
      const booking = await this.read(id, session); const s = state(booking);
      return s.providerCompleted && !s.providerUnknown && !s.cancelRequested && !s.cancelled && booking.externalBookingId
        ? 'completed' : 'pending_confirmation';
    });
  }
  async rescheduleDraft(id: string, actor: Actor, bookingDate: string, bookingTime: string): Promise<IExternalBooking> {
    return this.transaction(async session => {
      const booking = await this.owned(id, actor, session); const s = state(booking);
      if (s.cancelRequested || s.cancelled || s.providerAttempted || booking.status !== 'pending_payment' ||
          (s.setupToken && s.setupDeadlineMs > Date.now())) conflict('External booking cannot be rescheduled');
      return this.fence(booking, { bookingDate, bookingTime, externalSlotRef: bookingTime }, session);
    });
  }
  async beginReschedule(id: string, actor: Actor, expectedExternalBookingId: string): Promise<{ booking: IExternalBooking; token: string }> {
    return this.transaction(async session => {
      const booking = await this.owned(id, actor, session); const s = state(booking);
      if (s.cancelRequested || s.cancelled || !s.providerCompleted || !booking.externalBookingId || booking.externalBookingId !== expectedExternalBookingId ||
          ['completed', 'report_delivered'].includes(booking.status || '')) conflict('External booking cannot be rescheduled');
      const token = randomUUID();
      const updated = await this.fence(booking, { 'localEffects.providerToken': token, 'localEffects.providerCompleted': false,
        'localEffects.providerUnknown': false, 'localEffects.providerCancelAck': false }, session);
      return { booking: updated, token };
    });
  }
  private async request(booking: IExternalBooking, reason: string, session: ClientSession, window?: (booking: IExternalBooking) => void): Promise<IExternalBooking> {
    const s = state(booking);
    if (!s.cancelRequested && (booking.status === 'completed' || booking.status === 'report_delivered')) conflict('Completed external bookings cannot be cancelled');
    const captured = await PaymentModel.findOne({ context: 'external_booking', contextId: String(booking._id),
      userId: booking.userId, status: 'paid' }).session(session).lean().exec();
    if (!s.cancelRequested && (booking.paymentStatus === 'paid' || captured)) window?.(booking);
    return this.fence(booking, { 'localEffects.cancelRequested': true, 'localEffects.setupToken': null,
      'localEffects.setupDeadlineMs': 0, 'localEffects.cancelToken': s.cancelToken || randomUUID(),
      'meta.cancellationReason': reason, 'meta.cancelRequestedAt': new Date().toISOString(),
      ...(s.providerAttempted && !s.providerCompleted ? { 'meta.providerOutcomeUnknown': true } : {}) }, session);
  }
  async requestCancellation(id: string, actor: Actor, reason: string, window: (booking: IExternalBooking) => void): Promise<IExternalBooking> {
    return this.transaction(async session => this.request(await this.owned(id, actor, session), reason, session, window));
  }
  async requestSystemCancellation(id: string, reason: string, mode: 'unpaid_timeout' | 'confirmation_timeout'): Promise<IExternalBooking> {
    return this.transaction(async session => {
      const booking = await this.read(id, session); const s = state(booking);
      const createdAt = booking.createdAt instanceof Date ? booking.createdAt.getTime() : NaN;
      if (!Number.isFinite(createdAt) || createdAt > Date.now() - 1800000 || s.providerCompleted) conflict('External timeout no longer applies');
      const captured = await PaymentModel.findOne({ context: 'external_booking', contextId: id, userId: booking.userId, status: 'paid' }).session(session).lean().exec();
      if (mode === 'unpaid_timeout') {
        if (booking.status !== 'pending_payment' || booking.paymentStatus !== 'pending' || captured) conflict('External unpaid timeout no longer applies');
      } else if (!['pending', 'pending_payment'].includes(booking.status || '') || booking.paymentStatus !== 'paid' || !captured || booking.externalBookingId) {
        conflict('External confirmation timeout no longer applies');
      }
      return this.request(booking, reason, session);
    });
  }
  async acknowledgeProviderCancellation(id: string, token: string, expectedExternalBookingId: string): Promise<IExternalBooking> {
    return this.transaction(async session => {
      const booking = await this.read(id, session); const s = state(booking);
      if (!s.cancelRequested || !token || s.cancelToken !== token || !s.providerCompleted || !booking.externalBookingId ||
          booking.externalBookingId !== expectedExternalBookingId) conflict('Provider cancellation acknowledgement is unbound');
      return this.fence(booking, { 'localEffects.providerCancelAck': true, 'meta.needsProviderCancelIfDiscovered': false }, session);
    });
  }
  private async settle(booking: IExternalBooking, session: ClientSession): Promise<IExternalBooking> {
    const s = state(booking);
    if (!s.cancelRequested) conflict('Authorized cancellation intent is required');
    if (s.providerAttempted && !s.providerCancelAck) pending();
    const id = String(booking._id);
    const payments = await PaymentModel.find({ context: 'external_booking', contextId: id, userId: booking.userId }).session(session).limit(LIMIT + 1).lean().exec();
    const ledger = await WalletTransactionModel.find({ referenceType: 'external_booking', referenceId: id }).session(session).limit(LIMIT + 1).lean().exec();
    const legacy = await WalletTransactionModel.findOne({ referenceType: 'external_booking_timeout_refund', referenceId: id }).session(session).lean().exec();
    if (payments.length > LIMIT || ledger.length > LIMIT || legacy) conflict('External financial history needs reconciliation');
    const paymentIds = payments.map(payment => String(payment._id));
    if ([...s.settledPaymentIds, ...s.couponPaymentIds, ...s.reversedCouponPaymentIds].some(id => !paymentIds.includes(id))) conflict('External payment history is incomplete');
    let wallet = await WalletModel.findOne({ userId: { $eq: booking.userId },
      $expr: { $eq: [{ $type: '$userId' }, 'string'] } }).session(session).lean().exec();
    if (ledger.some(row => row.userId !== booking.userId || row.referenceId !== id || row.referenceType !== 'external_booking' ||
        !wallet || row.walletId !== String(wallet._id) || row.status !== 'completed' || !['debit', 'refund'].includes(row.transactionType))) conflict('External wallet ledger is inconsistent');
    const debited = sum(ledger.filter(row => row.transactionType === 'debit').map(row => bookingMoneyPaise(row.amount)));
    const refunded = sum(ledger.filter(row => row.transactionType === 'refund').map(row => bookingMoneyPaise(row.amount)));
    if (debited !== s.walletDebitedPaise || refunded !== s.walletRefundedPaise) conflict('External wallet provenance is unproven');
    let gateway = 0;
    for (const payment of payments) {
      this.payment(payment, booking); const paymentId = String(payment._id);
      if (payment.status === 'refunded' && !s.settledPaymentIds.includes(paymentId)) conflict('Prior external refund destination is unknown');
      if (payment.status === 'paid' || s.settledPaymentIds.includes(paymentId)) gateway = sum([gateway, bookingMoneyPaise(payment.finalAmount)]);
      if (payment.couponCode && payment.isProcessed && !s.couponPaymentIds.includes(paymentId)) conflict('External coupon provenance is unknown');
    }
    const total = sum([debited, gateway]);
    if (refunded > total || (booking.paymentStatus === 'paid' && total < bookingMoneyPaise(booking.price ?? 0))) conflict('External paid funding is missing');
    const delta = total - refunded;
    if (delta) {
      if (!wallet) {
        // A gateway-only customer may not have used an internal wallet yet.
        const [created] = await WalletModel.create([{ userId: booking.userId, balance: 0, isActive: true }], { session });
        wallet = created.toObject();
      }
      if (!wallet || wallet.userId !== booking.userId || !wallet.isActive) conflict('Active owned internal wallet is required');
      const before = bookingMoneyPaise(wallet.balance); const after = sum([before, delta]);
      const updated = await WalletModel.findOneAndUpdate({ _id: wallet._id, userId: booking.userId, balance: wallet.balance, isActive: true },
        { $set: { balance: after / 100 } }, { new: true, session }).lean().exec();
      if (!updated) conflict('External refund wallet changed');
      await WalletTransactionModel.create([{ userId: booking.userId, walletId: String(wallet._id), transactionType: 'refund', amount: delta / 100,
        balanceBefore: before / 100, balanceAfter: after / 100, status: 'completed', referenceType: 'external_booking', referenceId: id,
        description: 'External booking refund to internal wallet', transactionDate: getTodayYyyymmdd() }], { session });
    }
    for (const payment of payments) {
      const paymentId = String(payment._id);
      if (s.couponPaymentIds.includes(paymentId) && !s.reversedCouponPaymentIds.includes(paymentId)) {
        if (!payment.couponCode) conflict('External coupon record is missing');
        const coupon = await CouponModel.findOneAndUpdate({ code: payment.couponCode, currentUsageCount: { $gte: 1 } },
          { $inc: { currentUsageCount: -1 } }, { new: true, session }).lean().exec();
        if (!coupon) conflict('External coupon reversal failed'); s.reversedCouponPaymentIds.push(paymentId);
      }
      if (payment.status === 'paid') {
        const updated = await PaymentModel.findOneAndUpdate({ _id: payment._id, status: 'paid', context: 'external_booking', contextId: id, userId: booking.userId },
          { $set: { status: total ? 'refunded' : 'paid', isProcessed: true } }, { new: true, session }).lean().exec();
        if (!updated) conflict('External refund payment changed');
        if (!s.settledPaymentIds.includes(paymentId)) s.settledPaymentIds.push(paymentId);
      }
    }
    return this.fence(booking, { status: 'cancelled', paymentStatus: total ? 'refunded' : 'cancelled',
      'localEffects.cancelled': true, 'localEffects.walletRefundedPaise': total, 'localEffects.refundDestination': 'internal_wallet',
      'localEffects.settledPaymentIds': s.settledPaymentIds, 'localEffects.reversedCouponPaymentIds': s.reversedCouponPaymentIds,
      'meta.refundSettlementCompletedAt': new Date().toISOString() }, session);
  }
  async settleCancelled(id: string, owner?: string): Promise<IExternalBooking> {
    return this.transaction(async session => this.settle(await this.read(id, session, owner), session));
  }
}
