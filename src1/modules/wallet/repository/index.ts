import { Service } from 'typedi';
import { ClientSession, Model } from 'mongoose';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import {
  IWallet,
  IWalletTransaction,
  WalletQueryParams,
  WalletTransactionQueryParams,
} from '@/modules/wallet/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class WalletRepository extends BaseRepository<IWallet> {
  constructor() {
    super(WalletModel as Model<IWallet>);
  }

  async findByUserId(userId: string): Promise<IWallet | null> {
    return this.findOne({ userId });
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
