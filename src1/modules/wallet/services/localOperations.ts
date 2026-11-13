import { ClientSession } from 'mongoose';
import PaymentModel from '@/modules/payment/model';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { AppError } from '@/modules/common/types';
import { bookingMoneyPaise } from '@/modules/bookings/services/localOperations';
import { getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import { CreateWalletTransactionRequest, IWallet, IWalletTransaction } from '@/modules/wallet/types';

function conflict(message = 'Wallet history needs reconciliation'): never {
  throw new AppError({ status: 409, code: 'WALLET_RECONCILIATION_REQUIRED', message });
}
function owner(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || !userId) conflict('A scalar wallet owner is required');
}
function total(before: number, change: number): number {
  const after = before + change;
  if (!Number.isSafeInteger(after) || after < 0) conflict('Wallet amount exceeds the supported range');
  return after;
}

/** Two existing customer-wallet writers, with local balance and ledger committed together. */
export class WalletLocalOperations {
  private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const connection = WalletModel.db;
    if (WalletTransactionModel.db !== connection || PaymentModel.db !== connection) conflict('Wallet collections use different connections');
    const session = await connection.startSession();
    let result: T | undefined;
    try {
      await session.withTransaction(async () => { result = await work(session); },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      if (result === undefined) conflict('Wallet transaction did not complete');
      return result;
    } finally { await session.endSession(); }
  }

  private async wallet(userId: string, session: ClientSession): Promise<IWallet> {
    owner(userId);
    const existing = await WalletModel.findOne({ userId: { $eq: userId },
      $expr: { $eq: [{ $type: '$userId' }, 'string'] } }).session(session).lean().exec();
    if (existing) return existing;
    // The existing unique userId index remains a required native deployment fact.
    const [created] = await WalletModel.create([{ userId, balance: 0, isActive: true }], { session });
    return created.toObject();
  }

  private async adjust(wallet: IWallet, changePaise: number, session: ClientSession): Promise<IWallet> {
    owner(wallet.userId);
    if (!wallet.isActive) throw new AppError({ status: 400, code: 'WALLET_INACTIVE', message: 'Wallet is not active' });
    const before = bookingMoneyPaise(wallet.balance);
    if (before + changePaise < 0) throw new AppError({ status: 400, code: 'INSUFFICIENT_BALANCE', message: 'Insufficient wallet balance' });
    const after = total(before, changePaise);
    const updated = await WalletModel.findOneAndUpdate({ _id: wallet._id, userId: { $eq: wallet.userId },
      balance: wallet.balance, isActive: true, $expr: { $eq: [{ $type: '$userId' }, 'string'] } },
    { $set: { balance: after / 100 } }, { new: true, session }).lean().exec();
    if (!updated) conflict('Wallet changed; retry the operation');
    return updated;
  }

  async addTransaction(data: CreateWalletTransactionRequest): Promise<IWalletTransaction> {
    owner(data.userId);
    if (!['credit', 'debit', 'refund', 'cashback', 'promotion'].includes(data.transactionType)) conflict('Unsupported wallet transaction type');
    const amount = bookingMoneyPaise(data.amount);
    return this.transaction(async session => {
      const wallet = await this.wallet(data.userId, session);
      const before = bookingMoneyPaise(wallet.balance);
      const change = data.transactionType === 'debit' ? -amount : amount;
      const updated = await this.adjust(wallet, change, session);
      const [ledger] = await WalletTransactionModel.create([{ userId: data.userId, walletId: String(wallet._id),
        transactionType: data.transactionType, amount: amount / 100, balanceBefore: before / 100,
        balanceAfter: updated.balance, status: 'completed', referenceType: data.referenceType, referenceId: data.referenceId,
        description: data.description, notes: data.notes, transactionDate: data.transactionDate || getTodayYyyymmdd() }], { session });
      return ledger.toObject();
    });
  }

  async creditRecharge(paymentId: string): Promise<IWallet> {
    return this.transaction(async session => {
      const payment = await PaymentModel.findById(paymentId).session(session).lean().exec();
      if (!payment || String(payment._id) !== String(paymentId) || payment.context !== 'wallet_recharge' || payment.status !== 'paid' || payment.paymentGateway !== 'razorpay' ||
          payment.currency !== 'INR' || typeof payment.razorpayOrderId !== 'string' || !payment.razorpayOrderId.trim() ||
          typeof payment.razorpayPaymentId !== 'string' || !payment.razorpayPaymentId.trim() ||
          (payment.payerUserId && payment.payerUserId !== payment.userId) || payment.payerPharmacyId) conflict('Captured customer recharge provenance is missing');
      owner(payment.userId);
      const amount = bookingMoneyPaise(payment.baseAmount);
      const discount = bookingMoneyPaise(payment.discountAmount);
      const charged = bookingMoneyPaise(payment.finalAmount);
      if (charged <= 0 || amount <= 0 || amount - discount !== charged || payment.baseAmountPaise !== amount ||
          payment.discountAmountPaise !== discount || payment.finalAmountPaise !== charged) conflict('Recharge funding units are inconsistent');
      const prior = await WalletTransactionModel.find({ referenceType: 'wallet_recharge', referenceId: String(payment._id) })
        .session(session).limit(2).lean().exec();
      if (payment.notes !== undefined && (!payment.notes || typeof payment.notes !== 'object' || Array.isArray(payment.notes))) conflict('Recharge metadata is malformed');
      const marker = payment.notes?.walletRechargeCreditV1;
      const wallet = await this.wallet(payment.userId, session);
      if (marker !== undefined) {
        if (!marker || typeof marker !== 'object' || Array.isArray(marker)) conflict();
        const proof = marker as Record<string, unknown>;
        const ledger = prior[0];
        if (prior.length !== 1 || proof.version !== 1 || proof.ledgerId !== String(ledger._id) || proof.walletId !== String(wallet._id) ||
            proof.amountPaise !== amount || ledger.userId !== payment.userId || ledger.walletId !== String(wallet._id) ||
            ledger.transactionType !== 'credit' || ledger.status !== 'completed' || ledger.referenceType !== 'wallet_recharge' ||
            ledger.referenceId !== String(payment._id) || bookingMoneyPaise(ledger.amount) !== amount ||
            bookingMoneyPaise(ledger.balanceAfter) - bookingMoneyPaise(ledger.balanceBefore) !== amount) conflict();
        return wallet;
      }
      if (prior.length || payment.isProcessed) conflict('Legacy recharge credit requires reconciliation');
      const before = bookingMoneyPaise(wallet.balance);
      const credited = await this.adjust(wallet, amount, session);
      const [created] = await WalletTransactionModel.create([{ userId: payment.userId, walletId: String(wallet._id),
        transactionType: 'credit', amount: amount / 100, balanceBefore: before / 100, balanceAfter: credited.balance,
        status: 'completed', referenceType: 'wallet_recharge', referenceId: String(payment._id),
        description: `Wallet recharge via Razorpay${payment.couponCode ? ` (coupon: ${payment.couponCode})` : ''}`,
        notes: payment.razorpayPaymentId, transactionDate: getTodayYyyymmdd() }], { session });
      const fenced = await PaymentModel.findOneAndUpdate({ _id: payment._id, context: 'wallet_recharge', userId: payment.userId,
        status: 'paid', 'notes.walletRechargeCreditV1': { $exists: false } },
      { $set: { 'notes.walletRechargeCreditV1': { version: 1, ledgerId: String(created._id), walletId: String(wallet._id), amountPaise: amount } } },
      { new: true, session }).lean().exec();
      if (!fenced) conflict('Recharge credit changed; retry before applying another credit');
      return credited;
    });
  }
}
