import { randomUUID } from 'crypto';
import { ClientSession } from 'mongoose';
import BookingModel from '@/modules/bookings/model';
import SlotModel from '@/modules/slots/model';
import PaymentModel from '@/modules/payment/model';
import CouponModel from '@/modules/coupon/model';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { AppError } from '@/modules/common/types';
import { IBooking, IBookingLocalEffects } from '@/modules/bookings/types';
import { IPaymentRecord } from '@/modules/payment/types';
import { buildBookingLifecyclePatch } from '@/modules/bookings/utils/lifecycle';
import { getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';

type Actor = { _id: string; userType: string; pharmacyId?: string };
const MAX_EFFECT_ROWS = 128;
const SETUP_LIFETIME_MS = 5 * 60 * 1000;
function conflict(message = 'Booking needs reconciliation before this operation'): never {
  throw new AppError({ status: 409, code: 'BOOKING_RECONCILIATION_REQUIRED', message });
}
function changed(): never {
  throw new AppError({ status: 409, code: 'BOOKING_CHANGED', message: 'Booking changed; please retry' });
}
export function bookingMoneyPaise(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) conflict('Invalid INR amount');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) conflict('INR amounts must have at most two decimal places');
  const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) conflict('INR amount exceeds the supported range');
  return amount;
}
function sum(values: number[]): number {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result) || result < 0) conflict('INR total exceeds the supported range');
  return result;
}
function state(booking: IBooking): IBookingLocalEffects {
  const effects = booking.localEffects;
  if (!effects || effects.version !== 1 || !Number.isSafeInteger(effects.revision) || effects.revision < 0 ||
      !Number.isSafeInteger(effects.setupDeadlineMs) || effects.setupDeadlineMs < 0 ||
      (effects.setupToken !== null && (typeof effects.setupToken !== 'string' || !effects.setupToken)) ||
      typeof effects.cancelled !== 'boolean' ||
      !Number.isSafeInteger(effects.walletDebitedPaise) || effects.walletDebitedPaise < 0 ||
      !Number.isSafeInteger(effects.walletRefundedPaise) || effects.walletRefundedPaise < 0 ||
      !Array.isArray(effects.settledPaymentIds) || !Array.isArray(effects.couponPaymentIds) ||
      !Array.isArray(effects.reversedCouponPaymentIds) ||
      [effects.settledPaymentIds, effects.couponPaymentIds, effects.reversedCouponPaymentIds].some(ids =>
        ids.length > MAX_EFFECT_ROWS || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)))) conflict();
  return effects;
}

/** Local ordinary-booking effects only. Every write shares the booking's model connection/session. */
export class BookingLocalOperations {
  private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const connection = BookingModel.db;
    if ([SlotModel, PaymentModel, CouponModel, WalletModel, WalletTransactionModel].some(model => model.db !== connection)) conflict('Booking collections use different connections');
    const session = await connection.startSession();
    let result: T | undefined;
    try {
      await session.withTransaction(async () => { result = await work(session); },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      if (result === undefined) changed();
      return result;
    } finally { await session.endSession(); }
  }

  private async owned(id: string, actor: Actor, session: ClientSession, allowPharmacy = false): Promise<IBooking> {
    const pharmacy = allowPharmacy && actor?.userType === 'pharmacy' && typeof actor.pharmacyId === 'string' && actor.pharmacyId.length > 0;
    if (!actor?._id || (!['user', 'admin'].includes(actor.userType) && !pharmacy)) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Only the customer or admin can perform this operation' });
    }
    const booking = await BookingModel.findOne({ _id: id,
      ...(actor.userType === 'admin' ? {} : pharmacy ? { pharmacyId: { $eq: actor.pharmacyId }, $and: [{ $expr: { $eq: [{ $type: '$pharmacyId' }, 'string'] } }] } : { userId: { $eq: actor._id } }),
      $expr: { $eq: [{ $type: '$userId' }, 'string'] } }).session(session).select('+localEffects').lean().exec();
    if (!booking) throw new AppError({ status: 404, code: 'BOOKING_NOT_FOUND', message: 'Booking not found' });
    state(booking); return booking;
  }

  private async fence(booking: IBooking, session: ClientSession, patch: Record<string, unknown> = {}): Promise<IBooking> {
    const effects = state(booking);
    const updated = await BookingModel.findOneAndUpdate({ _id: booking._id, userId: { $eq: booking.userId },
      status: booking.status, 'localEffects.version': 1, 'localEffects.revision': effects.revision,
      $expr: { $eq: [{ $type: '$userId' }, 'string'] } },
    { $set: patch, $inc: { 'localEffects.revision': 1 } }, { new: true, session }).select('+localEffects').lean().exec();
    if (!updated) changed(); return updated;
  }

  private async reserve(slotId: string, booking: IBooking, session: ClientSession): Promise<void> {
    const slot = await SlotModel.findById(slotId).session(session).lean().exec();
    if (!slot || !slot.isActive || !slot.isAvailable || slot.date !== booking.bookingDate || slot.startTime !== booking.bookingTime ||
        (booking.specialistId && slot.specialistId !== booking.specialistId) ||
        (booking.wellnessPackageId && slot.wellnessPackageId !== booking.wellnessPackageId) ||
        !Number.isSafeInteger(slot.currentBookings) || slot.currentBookings! < 0 ||
        !Number.isSafeInteger(slot.maxBookings) || slot.currentBookings! >= slot.maxBookings!) {
      throw new AppError({ status: 409, code: 'SLOT_NOT_AVAILABLE', message: 'Slot is not available' });
    }
    const next = slot.currentBookings! + 1;
    const updated = await SlotModel.findOneAndUpdate({ _id: slotId, currentBookings: slot.currentBookings, isActive: true, isAvailable: true },
      { $inc: { currentBookings: 1 }, $set: { isAvailable: next < slot.maxBookings! } }, { new: true, session }).lean().exec();
    if (!updated) changed();
  }

  private async release(slotId: string, session: ClientSession): Promise<void> {
    const slot = await SlotModel.findById(slotId).session(session).lean().exec();
    if (!slot || !Number.isSafeInteger(slot.currentBookings) || slot.currentBookings! <= 0 || !Number.isSafeInteger(slot.maxBookings)) conflict('Recorded slot hold cannot be released');
    const updated = await SlotModel.findOneAndUpdate({ _id: slotId, currentBookings: slot.currentBookings },
      { $inc: { currentBookings: -1 }, $set: { isAvailable: slot.isActive && slot.currentBookings! - 1 < slot.maxBookings! } }, { new: true, session }).lean().exec();
    if (!updated) changed();
  }

  async createDraft(input: IBooking, setup = true): Promise<IBooking> {
    bookingMoneyPaise(input.price);
    if (input.bookingType !== 'surgery' && !input.slotId) conflict('A slot reservation is required');
    return this.transaction(async session => {
      const effects: IBookingLocalEffects = { version: 1, revision: 0, setupToken: setup ? randomUUID() : null,
        setupDeadlineMs: setup ? Date.now() + SETUP_LIFETIME_MS : 0, setupFailed: false, heldSlotId: input.bookingType !== 'surgery' ? input.slotId || null : null,
        followUpParentId: null, followUpHeldByBookingId: null, walletDebitedPaise: 0, walletRefundedPaise: 0,
        settledPaymentIds: [], couponPaymentIds: [], reversedCouponPaymentIds: [], cancelled: false };
      if (effects.heldSlotId) await this.reserve(effects.heldSlotId, input, session);
      const [document] = await BookingModel.create([{ ...input, paymentStatus: setup ? 'pending' : input.paymentStatus, localEffects: effects }], { session });
      const booking = document.toObject();
      if (input.followUp?.isFollowUp && input.followUp.parentConsultationId) {
        const parent = await BookingModel.findById(input.followUp.parentConsultationId).session(session).select('+localEffects').lean().exec();
        if (!parent || parent.userId !== input.userId || parent.dependentId !== input.dependentId || parent.status !== 'completed' ||
            parent.followUp?.benefitUsed || state(parent).followUpHeldByBookingId) conflict('Follow-up benefit is unavailable or requires reconciliation');
        await this.fence(parent, session, { 'followUp.benefitUsed': true, 'localEffects.followUpHeldByBookingId': String(booking._id) });
        booking.localEffects!.followUpParentId = String(parent._id);
        return this.fence(booking, session, { 'localEffects.followUpParentId': String(parent._id) });
      }
      return booking;
    });
  }

  async beginSetup(id: string, actor: Actor): Promise<IBooking> {
    return this.transaction(async session => {
      const booking = await this.owned(id, actor, session, true); const effects = state(booking);
      if (booking.status === 'cancelled' || booking.status === 'completed' || booking.paymentStatus === 'paid' || (effects.setupToken && effects.setupDeadlineMs > Date.now())) changed();
      return this.fence(booking, session, { 'localEffects.setupToken': randomUUID(), 'localEffects.setupDeadlineMs': Date.now() + SETUP_LIFETIME_MS, 'localEffects.setupFailed': false });
    });
  }

  async endSetup(id: string, token: string, failed: boolean): Promise<void> {
    await this.transaction(async session => {
      const booking = await BookingModel.findById(id).session(session).select('+localEffects').lean().exec();
      if (!booking || state(booking).setupToken !== token) changed();
      await this.fence(booking, session, { 'localEffects.setupToken': null, 'localEffects.setupDeadlineMs': 0, 'localEffects.setupFailed': failed });
      return true;
    });
  }

  async debitWallet(id: string, owner: string, token: string, requested: number): Promise<number> {
    const requestedPaise = bookingMoneyPaise(requested);
    return this.transaction(async session => {
      const booking = await this.owned(id, { _id: owner, userType: 'user' }, session); const effects = state(booking);
      if (effects.setupToken !== token || effects.setupDeadlineMs <= Date.now() || booking.status === 'cancelled') changed();
      const wallet = await WalletModel.findOne({ userId: owner }).session(session).lean().exec();
      if (!wallet) return 0;
      if (wallet.userId !== owner) conflict('Wallet owner is inconsistent');
      if (!wallet.isActive) throw new AppError({ status: 400, code: 'WALLET_INACTIVE', message: 'Wallet is not active' });
      const before = bookingMoneyPaise(wallet.balance); const amount = Math.min(before, requestedPaise);
      if (!amount) return 0;
      const updated = await WalletModel.findOneAndUpdate({ _id: wallet._id, balance: wallet.balance, isActive: true },
        { $set: { balance: (before - amount) / 100 } }, { new: true, session }).lean().exec();
      if (!updated) changed();
      await WalletTransactionModel.create([{ userId: owner, walletId: String(wallet._id), transactionType: 'debit',
        amount: amount / 100, balanceBefore: before / 100, balanceAfter: (before - amount) / 100, status: 'completed',
        referenceType: 'booking', referenceId: id, description: 'Wallet used for booking payment', transactionDate: getTodayYyyymmdd() }], { session });
      await this.fence(booking, session, { 'localEffects.walletDebitedPaise': sum([effects.walletDebitedPaise, amount]) });
      return amount / 100;
    });
  }

  private matchingPayment(payment: IPaymentRecord, booking: IBooking): void {
    if (payment.context !== 'booking' || typeof payment.contextId !== 'string' || payment.contextId !== String(booking._id) || payment.userId !== booking.userId ||
        payment.currency !== 'INR' || (payment.payerUserId && payment.payerUserId !== booking.userId) || payment.payerPharmacyId || !['razorpay', 'internal'].includes(payment.paymentGateway)) conflict('Booking payment provenance is inconsistent');
    const paise = bookingMoneyPaise(payment.finalAmount);
    if (payment.finalAmountPaise !== undefined && payment.finalAmountPaise !== paise) conflict('Booking payment units are inconsistent');
    if (payment.paymentGateway === 'internal' && paise !== 0) conflict('Unexpected internal booking payment');
    const gross = bookingMoneyPaise(payment.baseAmount) - bookingMoneyPaise(payment.discountAmount);
    const wallet = bookingMoneyPaise(payment.notes?.walletDeductedAmount ?? 0);
    if (gross < 0 || gross !== sum([paise, wallet])) conflict('Booking payment funding units are inconsistent');
  }

  private async countCoupon(booking: IBooking, payment: IPaymentRecord, session: ClientSession): Promise<void> {
    const effects = state(booking); const id = String(payment._id);
    if (!payment.couponCode || effects.couponPaymentIds.includes(id)) return;
    if (effects.couponPaymentIds.length >= MAX_EFFECT_ROWS) conflict();
    const coupon = await CouponModel.findOneAndUpdate({ code: payment.couponCode, currentUsageCount: { $gte: 0 } },
      { $inc: { currentUsageCount: 1 } }, { new: true, session }).lean().exec();
    if (!coupon || !Number.isSafeInteger(coupon.currentUsageCount)) conflict('Coupon usage could not be recorded');
    effects.couponPaymentIds.push(id);
  }

  async attachPayment(id: string, token: string, paymentId: string): Promise<IBooking> {
    return this.transaction(async session => {
      const booking = await BookingModel.findById(id).session(session).select('+localEffects').lean().exec();
      if (!booking || state(booking).setupToken !== token || state(booking).setupDeadlineMs <= Date.now() || booking.status === 'cancelled') changed();
      const payment = await PaymentModel.findById(paymentId).session(session).lean().exec();
      if (!payment) conflict('Booking payment is missing'); this.matchingPayment(payment, booking);
      if (!['paid', 'created'].includes(payment.status)) conflict('Booking payment cannot be attached');
      const gross = sum([bookingMoneyPaise(payment.finalAmount), state(booking).walletDebitedPaise]);
      if (bookingMoneyPaise(payment.baseAmount) - bookingMoneyPaise(payment.discountAmount) !== gross) conflict('Payment total does not match booking funding');
      if (payment.status === 'paid') await this.countCoupon(booking, payment, session);
      return this.fence(booking, session, { paymentTransactionId: paymentId, price: gross / 100,
        status: payment.status === 'paid' ? 'confirmed' : booking.status,
        paymentStatus: payment.status === 'paid' ? 'paid' : 'pending',
        'localEffects.couponPaymentIds': state(booking).couponPaymentIds,
        lifecycle: buildBookingLifecyclePatch(booking.lifecycle, payment.status === 'paid' ? { paid: { amount: booking.price }, confirmed: true } : { paymentPending: { amount: payment.finalAmount } }) });
    });
  }

  private async settle(booking: IBooking, reason: string, session: ClientSession, assertWindow?: (booking: IBooking) => void): Promise<IBooking> {
    const effects = state(booking);
    if (effects.setupToken && effects.setupDeadlineMs > Date.now()) throw new AppError({ status: 409, code: 'BOOKING_SETUP_IN_PROGRESS', message: 'Booking payment setup is in progress; please retry cancellation' });
    if (booking.status === 'completed') throw new AppError({ status: 409, code: 'BOOKING_COMPLETED', message: 'Completed bookings cannot be cancelled' });
    if (booking.status === 'cancelled' && !effects.cancelled) conflict('Historical cancellation needs reconciliation');
    const payments = await PaymentModel.find({ context: 'booking', contextId: String(booking._id), userId: booking.userId }).session(session).limit(MAX_EFFECT_ROWS + 1).lean().exec();
    const debits = await WalletTransactionModel.find({ userId: booking.userId, referenceType: 'booking', referenceId: String(booking._id), transactionType: 'debit', status: 'completed' }).session(session).limit(MAX_EFFECT_ROWS + 1).lean().exec();
    const refunds = await WalletTransactionModel.find({ userId: booking.userId, referenceType: 'booking', referenceId: String(booking._id), transactionType: 'refund', status: 'completed' }).session(session).limit(MAX_EFFECT_ROWS + 1).lean().exec();
    if ([payments, debits, refunds].some(rows => rows.length > MAX_EFFECT_ROWS)) conflict('Booking effect history exceeds the supported bound');
    if (debits.some(row => row.transactionType !== 'debit' || row.status !== 'completed') || refunds.some(row => row.transactionType !== 'refund' || row.status !== 'completed')) conflict('Wallet ledger state is inconsistent');
    if (sum(debits.map(row => bookingMoneyPaise(row.amount))) !== effects.walletDebitedPaise ||
        sum(refunds.map(row => bookingMoneyPaise(row.amount))) !== effects.walletRefundedPaise) conflict('Booking wallet history requires reconciliation');
    const paymentIds = payments.map(payment => String(payment._id));
    if (effects.settledPaymentIds.some(id => !paymentIds.includes(id)) || effects.couponPaymentIds.some(id => !paymentIds.includes(id))) conflict('Booking payment history is incomplete');
    if (booking.status !== 'cancelled' && (booking.paymentStatus === 'paid' || payments.some(payment => payment.status === 'paid'))) assertWindow?.(booking);
    let gatewayPaise = 0;
    for (const payment of payments) {
      this.matchingPayment(payment, booking);
      if (payment.status === 'refunded' && !effects.settledPaymentIds.includes(String(payment._id))) conflict('Prior refund destination is unproven');
      if (payment.status === 'paid' || effects.settledPaymentIds.includes(String(payment._id))) gatewayPaise = sum([gatewayPaise, bookingMoneyPaise(payment.finalAmount)]);
    }
    const total = sum([effects.walletDebitedPaise, gatewayPaise]);
    if (effects.walletRefundedPaise > total || (booking.paymentStatus === 'paid' && total < bookingMoneyPaise(booking.price))) conflict('Paid booking funding is missing');
    const amount = total - effects.walletRefundedPaise;
    const wallet = (total > 0 || debits.length || refunds.length) ? await WalletModel.findOne({ userId: booking.userId }).session(session).lean().exec() : null;
    if (wallet && wallet.userId !== booking.userId) conflict('Wallet owner is inconsistent');
    if ([...debits, ...refunds].some(row => row.userId !== booking.userId || row.referenceType !== 'booking' ||
        row.referenceId !== String(booking._id) || !wallet || row.walletId !== String(wallet._id))) conflict('Wallet ledger provenance is inconsistent');
    if (amount) {
      if (!wallet || !wallet.isActive) conflict('Active internal wallet is required for this refund');
      const before = bookingMoneyPaise(wallet.balance); const after = sum([before, amount]);
      const updated = await WalletModel.findOneAndUpdate({ _id: wallet._id, balance: wallet.balance, isActive: true }, { $set: { balance: after / 100 } }, { new: true, session }).lean().exec();
      if (!updated) changed();
      await WalletTransactionModel.create([{ userId: booking.userId, walletId: String(wallet._id), transactionType: 'refund', amount: amount / 100,
        balanceBefore: before / 100, balanceAfter: after / 100, status: 'completed', referenceType: 'booking', referenceId: String(booking._id),
        description: 'Cancelled booking refund to internal wallet', transactionDate: getTodayYyyymmdd() }], { session });
    }
    for (const payment of payments) {
      const id = String(payment._id);
      if (effects.couponPaymentIds.includes(id) && !effects.reversedCouponPaymentIds.includes(id)) {
        if (!payment.couponCode) conflict('Recorded coupon usage is missing');
        const coupon = await CouponModel.findOneAndUpdate({ code: payment.couponCode, currentUsageCount: { $gte: 1 } }, { $inc: { currentUsageCount: -1 } }, { new: true, session }).lean().exec();
        if (!coupon) conflict('Recorded coupon usage cannot be reversed');
        effects.reversedCouponPaymentIds.push(id);
      }
      if (payment.status === 'paid') {
        const updated = await PaymentModel.findOneAndUpdate({ _id: payment._id, status: 'paid', context: 'booking', contextId: String(booking._id), userId: booking.userId },
          { $set: { status: total > 0 ? 'refunded' : 'paid', isProcessed: true } }, { new: true, session }).lean().exec();
        if (!updated) changed();
        if (!effects.settledPaymentIds.includes(id)) effects.settledPaymentIds.push(id);
      }
    }
    if (!effects.cancelled) {
      if (effects.heldSlotId) {
        if (effects.heldSlotId !== booking.slotId) conflict('Booking slot hold does not match');
        await this.release(effects.heldSlotId, session);
      }
      if (effects.followUpParentId) {
        const parent = await BookingModel.findById(effects.followUpParentId).session(session).select('+localEffects').lean().exec();
        if (!parent || parent.userId !== booking.userId || state(parent).followUpHeldByBookingId !== String(booking._id)) conflict('Follow-up hold requires reconciliation');
        await this.fence(parent, session, { 'followUp.benefitUsed': false, 'localEffects.followUpHeldByBookingId': null });
      }
    }
    return this.fence(booking, session, { status: 'cancelled', paymentStatus: total > 0 ? 'refunded' : 'failed',
      cancellationReason: booking.cancellationReason || reason, cancelledAt: booking.cancelledAt || getTodayYyyymmdd(),
      'localEffects.cancelled': true, 'localEffects.setupToken': null, 'localEffects.setupDeadlineMs': 0, 'localEffects.heldSlotId': null, 'localEffects.followUpParentId': null,
      'localEffects.walletRefundedPaise': total, 'localEffects.settledPaymentIds': effects.settledPaymentIds,
      'localEffects.reversedCouponPaymentIds': effects.reversedCouponPaymentIds, 'localEffects.refundDestination': 'internal_wallet',
      lifecycle: buildBookingLifecyclePatch(booking.lifecycle, { cancelled: { reason }, ...(total > 0 ? { refunded: { amount: total / 100, reason: 'Credited to internal wallet' } } : {}) }) });
  }

  async cancel(id: string, actor: Actor, reason: string, assertWindow: (booking: IBooking) => void): Promise<IBooking> {
    return this.transaction(async session => {
      const booking = await this.owned(id, actor, session);
      return this.settle(booking, reason, session, assertWindow);
    });
  }

  async confirmPayment(paymentId: string): Promise<{ paymentRecord: IPaymentRecord; entity: IBooking }> {
    return this.transaction(async session => {
      const payment = await PaymentModel.findById(paymentId).session(session).lean().exec();
      if (!payment) conflict('Booking payment is missing');
      const booking = await BookingModel.findById(payment.contextId).session(session).select('+localEffects').lean().exec();
      if (!booking) conflict('Booking payment target is missing'); this.matchingPayment(payment, booking);
      const effects = state(booking);
      if (effects.setupToken && effects.setupDeadlineMs > Date.now()) changed();
      let entity: IBooking;
      if (booking.status === 'cancelled') entity = await this.settle(booking, booking.cancellationReason || 'Cancelled by user', session);
      else {
        if (payment.status === 'refunded') conflict('Refunded payment cannot confirm a booking');
        if (payment.status !== 'paid') conflict('Captured payment is required');
        const gross = sum([bookingMoneyPaise(payment.finalAmount), effects.walletDebitedPaise]);
        if (gross !== bookingMoneyPaise(booking.price) || bookingMoneyPaise(payment.notes?.walletDeductedAmount ?? 0) !== effects.walletDebitedPaise) conflict('Captured payment does not match current booking funding');
        if (booking.paymentTransactionId && booking.paymentTransactionId !== String(paymentId)) conflict('A different payment attempt needs reconciliation');
        await this.countCoupon(booking, payment, session);
        entity = await this.fence(booking, session, { status: booking.status === 'pending' ? 'confirmed' : booking.status,
          paymentStatus: 'paid', paymentTransactionId: paymentId, 'localEffects.couponPaymentIds': effects.couponPaymentIds,
          lifecycle: buildBookingLifecyclePatch(booking.lifecycle, { paid: { amount: payment.finalAmount }, confirmed: booking.status === 'pending' ? true : undefined }) });
        await PaymentModel.updateOne({ _id: paymentId, status: 'paid' }, { $set: { isProcessed: true } }, { session });
      }
      const currentPayment = await PaymentModel.findById(paymentId).session(session).lean().exec();
      if (!currentPayment) changed(); return { paymentRecord: currentPayment, entity };
    });
  }

  async reschedule(id: string, actor: Actor, patch: Record<string, unknown>): Promise<IBooking> {
    return this.transaction(async session => {
      const booking = await this.owned(id, actor, session); const effects = state(booking);
      if (!['pending', 'confirmed'].includes(booking.status) || (effects.setupToken && effects.setupDeadlineMs > Date.now())) changed();
      if (!effects.heldSlotId || effects.heldSlotId !== booking.slotId) conflict('Booking slot hold requires reconciliation');
      const slotId = String(patch.slotId);
      if (slotId === effects.heldSlotId) {
        const slot = await SlotModel.findById(slotId).session(session).lean().exec();
        if (!slot || !slot.isActive || slot.date !== patch.bookingDate || slot.startTime !== patch.bookingTime ||
            (booking.specialistId && slot.specialistId !== booking.specialistId) ||
            (booking.wellnessPackageId && slot.wellnessPackageId !== booking.wellnessPackageId)) conflict('Rescheduled appointment does not match its held slot');
      }
      if (slotId !== effects.heldSlotId) {
        await this.reserve(slotId, { ...booking, ...patch } as IBooking, session);
        await this.release(effects.heldSlotId, session);
      }
      return this.fence(booking, session, { ...patch, 'localEffects.heldSlotId': slotId,
        lifecycle: buildBookingLifecyclePatch(booking.lifecycle, { rescheduled: true }) });
    });
  }
}
