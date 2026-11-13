import { Service } from 'typedi';
import { ClientSession, Model, startSession } from 'mongoose';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import {
  IWallet,
  IWalletTransaction,
  WalletQueryParams,
  WalletTransactionQueryParams,
} from '@/modules/wallet/types';
import { BaseRepository } from '@/modules/common/repository';
import { AppError } from '@/modules/common/types';

@Service()
export class WalletRepository extends BaseRepository<IWallet> {
  constructor() {
    super(WalletModel as Model<IWallet>);
  }

  async findByUserId(userId: string): Promise<IWallet | null> {
    return this.findOne({ userId });
  }

  /**
   * The only safe way to move a customer wallet balance: an atomic $inc (debits only when the balance covers the
   * amount) plus the ledger row, in one transaction. balanceBefore/After come from the post-update document, so
   * concurrent writers can neither overwrite each other nor record a stale ledger. Returns null when a debit is not
   * covered. Pass a session to join an existing transaction.
   */
  async postEntry(
    entry: Omit<IWalletTransaction, '_id' | 'walletId' | 'balanceBefore' | 'balanceAfter' | 'status' | 'createdAt' | 'updatedAt'> & { walletId: unknown },
    session?: ClientSession
  ): Promise<{ wallet: IWallet; transaction: IWalletTransaction; duplicate?: boolean } | null> {
    const debit = entry.transactionType === 'debit';
    // Operation key claimed in the same transaction as the balance change: a concurrent or replayed operation hits
    // the unique index, its whole transaction (including the $inc) aborts, and the existing receipt is returned.
    const replay = async () => {
      if (!entry.operationKey) return null;
      const existing = await WalletTransactionModel.findOne({ operationKey: entry.operationKey }).lean();
      const wallet = existing ? await WalletModel.findById(entry.walletId).lean() : null;
      return existing && wallet ? { wallet: wallet as IWallet, transaction: existing as IWalletTransaction, duplicate: true } : null;
    };
    const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000 && /operationKey/.test(String((e as Error)?.message));
    if (!session) { const prior = await replay(); if (prior) return prior; }
    const amount = Number(entry.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Wallet entry amount must be positive');
    const work = async (s: ClientSession) => {
      const wallet = await WalletModel.findOneAndUpdate(
        { _id: entry.walletId, ...(debit ? { balance: { $gte: amount } } : {}) },
        { $inc: { balance: debit ? -amount : amount } },
        { new: true, session: s }
      ).lean();
      if (!wallet) return null;
      const after = Number(wallet.balance);
      const [transaction] = await WalletTransactionModel.create([{ ...entry, amount, status: 'completed',
        balanceBefore: debit ? after + amount : after - amount, balanceAfter: after }], { session: s });
      return { wallet: wallet as IWallet, transaction: transaction.toObject() as IWalletTransaction };
    };
    if (session) return work(session); // caller's transaction: a duplicate key aborts it (caller fences/handles)
    const own = await startSession();
    try {
      let result: { wallet: IWallet; transaction: IWalletTransaction } | null = null;
      await own.withTransaction(async () => { result = await work(own); });
      return result;
    } catch (error) {
      if (isDuplicateKey(error)) { const prior = await replay(); if (prior) return prior; }
      throw error;
    } finally { await own.endSession(); }
  }

  /**
   * Debit up to `max` from the current balance (partial wallet use at checkout); returns the amount debited.
   * With an operationKey, concurrent duplicates of the same funding step debit once and all get that amount back.
   */
  async debitUpTo(
    entry: Omit<Parameters<WalletRepository['postEntry']>[0], 'amount' | 'transactionType'>,
    max: number
  ): Promise<number> {
    // This funding step may already have run (duplicate/stale request): its receipt is the answer, even when the
    // wallet is now empty. Checked before any "no funds" return.
    const receipt = async () => entry.operationKey
      ? await WalletTransactionModel.findOne({ operationKey: entry.operationKey }).lean() : null;
    // A replayed step must fit what this caller still owes; a larger earlier debit means the terms changed (e.g. a
    // coupon) between duplicate requests, so refuse rather than silently absorbing the excess.
    const replayed = (amount: number): number => {
      if (amount > max + 1e-9) {
        throw new AppError({ status: 409, code: 'WALLET_FUNDING_CONFLICT',
          message: 'This payment step was already funded with a different amount; reload and try again' });
      }
      return amount;
    };
    const existing = await receipt();
    if (existing) return replayed(Number(existing.amount));
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await WalletModel.findById(entry.walletId).select('balance').lean();
      const amount = Math.min(Number(current?.balance ?? 0), max);
      if (!(amount > 0)) { const raced = await receipt(); return raced ? replayed(Number(raced.amount)) : 0; }
      const posted = await this.postEntry({ ...entry, transactionType: 'debit', amount });
      if (posted) return posted.duplicate ? replayed(Number(posted.transaction.amount)) : amount;
      if (entry.operationKey) { // lost the race to an identical funding step? return its receipt instead of debiting again
        const prior = await WalletTransactionModel.findOne({ operationKey: entry.operationKey }).lean();
        if (prior) return replayed(Number(prior.amount));
      }
    }
    throw new Error('Wallet balance kept changing; try again');
  }

  async atomicCredit(
    userId: string,
    amount: number,
    session?: ClientSession
  ): Promise<IWallet | null> {
    return WalletModel.findOneAndUpdate(
      { userId, isActive: true },
      { $inc: { balance: amount } },
      { new: true, session }
    ).lean();
  }

  async findWithPagination(
    filter: WalletQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{ data: IWallet[]; total: number; page: number; totalPages: number }> {
    const query: any = {};

    if (filter.userId) {
      query.userId = filter.userId;
    }

    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    }

    const skip = (page - 1) * limit;
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1;
    }

    const [data, total] = await Promise.all([
      this.findAll(query, { skip, limit, sort }),
      WalletModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}

@Service()
export class WalletTransactionRepository extends BaseRepository<IWalletTransaction> {
  constructor() {
    super(WalletTransactionModel as Model<IWalletTransaction>);
  }

  private buildReferralRewardQuery(filter: WalletTransactionQueryParams = {}) {
    const query: any = {
      userId: filter.userId,
      transactionType: 'promotion',
      status: 'completed',
      referenceType: 'referral',
    };

    if (filter.transactionDateFrom || filter.transactionDateTo) {
      query.transactionDate = {};
      if (filter.transactionDateFrom) {
        query.transactionDate.$gte = filter.transactionDateFrom;
      }
      if (filter.transactionDateTo) {
        query.transactionDate.$lte = filter.transactionDateTo;
      }
    }

    return query;
  }

  async findByUserId(userId: string): Promise<IWalletTransaction[]> {
    return this.findAll({ userId }, { sort: { createdAt: -1 } });
  }

  async findByUserIdAndType(
    userId: string,
    transactionType: string
  ): Promise<IWalletTransaction[]> {
    return this.findAll(
      { userId, transactionType },
      { sort: { createdAt: -1 } }
    );
  }

  async findByReference(
    referenceType: string,
    referenceId: string
  ): Promise<IWalletTransaction[]> {
    return this.findAll(
      { referenceType, referenceId },
      { sort: { createdAt: -1 } }
    );
  }

  async findWithPagination(
    filter: WalletTransactionQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: IWalletTransaction[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query: any = {};

    if (filter.userId) {
      query.userId = filter.userId;
    }

    if (filter.transactionType) {
      query.transactionType = filter.transactionType;
    }

    if (filter.status) {
      query.status = filter.status;
    }

    if (filter.referenceType) {
      query.referenceType = filter.referenceType;
    }

    if (filter.referenceId) {
      query.referenceId = filter.referenceId;
    }

    if (filter.transactionDateFrom || filter.transactionDateTo) {
      query.transactionDate = {};
      if (filter.transactionDateFrom) {
        query.transactionDate.$gte = filter.transactionDateFrom;
      }
      if (filter.transactionDateTo) {
        query.transactionDate.$lte = filter.transactionDateTo;
      }
    }

    const skip = (page - 1) * limit;
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1; // Most recent first
    }

    const [data, total] = await Promise.all([
      this.findAll(query, { skip, limit, sort }),
      WalletTransactionModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findReferralRewardsWithPagination(
    filter: WalletTransactionQueryParams,
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: IWalletTransaction[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query = this.buildReferralRewardQuery(filter);
    const skip = (page - 1) * limit;
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1;
    }

    const [data, total] = await Promise.all([
      this.findAll(query, { skip, limit, sort }),
      WalletTransactionModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findReferralRewards(
    filter: WalletTransactionQueryParams = {}
  ): Promise<IWalletTransaction[]> {
    const query = this.buildReferralRewardQuery(filter);
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1;
    }

    return this.findAll(query, { sort });
  }

  async getReferralRewardSummary(
    filter: WalletTransactionQueryParams
  ): Promise<{ totalEarned: number; totalTransactions: number }> {
    const query = this.buildReferralRewardQuery(filter);
    const [summary] = await WalletTransactionModel.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalEarned: { $sum: '$amount' },
          totalTransactions: { $sum: 1 },
        },
      },
    ]);

    return {
      totalEarned: summary?.totalEarned || 0,
      totalTransactions: summary?.totalTransactions || 0,
    };
  }

  async getLatestTransaction(userId: string): Promise<IWalletTransaction | null> {
    const transactions = await this.findAll(
      { userId },
      { sort: { createdAt: -1 }, limit: 1 }
    );
    return transactions.length > 0 ? transactions[0] : null;
  }
}
