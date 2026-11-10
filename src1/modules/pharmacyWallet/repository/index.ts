import { Service } from 'typedi';
import { ClientSession, Model } from 'mongoose';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { IPharmacyWallet, IPharmacyWalletTransaction, WalletTxQueryParams } from '@/modules/pharmacyWallet/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class PharmacyWalletRepository extends BaseRepository<IPharmacyWallet> {
  constructor() {
    super(PharmacyWalletModel as Model<IPharmacyWallet>);
  }

  async findByPharmacy(pharmacyId: string): Promise<IPharmacyWallet | null> {
    return this.findOne({ pharmacyId });
  }

  // Atomic create-or-return: safe under concurrent first access thanks to the
  // unique pharmacyId index (the losing insert retries as a plain match).
  async upsertWallet(pharmacyId: string): Promise<IPharmacyWallet> {
    const wallet = await PharmacyWalletModel.findOneAndUpdate(
      { pharmacyId },
      { $setOnInsert: { balance: 0, balancePaise: 0, isActive: true } },
      { new: true, upsert: true }
    ).lean();
    return wallet as IPharmacyWallet;
  }

  // Atomic balance update — returns null if balance would go negative
  async atomicDebit(
    pharmacyId: string,
    amount: number,
    session?: ClientSession
  ): Promise<IPharmacyWallet | null> {
    const amountPaise = Math.round(amount * 100);
    return PharmacyWalletModel.findOneAndUpdate(
      { pharmacyId, balance: { $gte: amount }, isActive: true },
      [
        {
          $set: {
            balancePaise: {
              $subtract: [
                { $ifNull: ['$balancePaise', { $round: [{ $multiply: ['$balance', 100] }, 0] }] },
                amountPaise,
              ],
            },
          },
        },
        { $set: { balance: { $divide: ['$balancePaise', 100] } } },
      ] as any,
      { new: true, session }
    ).lean();
  }

  async atomicCredit(
    pharmacyId: string,
    amount: number,
    session?: ClientSession
  ): Promise<IPharmacyWallet | null> {
    const amountPaise = Math.round(amount * 100);
    return PharmacyWalletModel.findOneAndUpdate(
      { pharmacyId, isActive: true },
      [
        {
          $set: {
            balancePaise: {
              $add: [
                { $ifNull: ['$balancePaise', { $round: [{ $multiply: ['$balance', 100] }, 0] }] },
                amountPaise,
              ],
            },
          },
        },
        { $set: { balance: { $divide: ['$balancePaise', 100] } } },
      ] as any,
      { new: true, upsert: false, session }
    ).lean();
  }
}

@Service()
export class PharmacyWalletTransactionRepository extends BaseRepository<IPharmacyWalletTransaction> {
  constructor() {
    super(PharmacyWalletTransactionModel as Model<IPharmacyWalletTransaction>);
  }

  async findWithPagination(
    params: WalletTxQueryParams,
    page = 1,
    limit = 20
  ): Promise<{ data: IPharmacyWalletTransaction[]; total: number; page: number; totalPages: number }> {
    const query: any = { pharmacyId: params.pharmacyId };
    if (params.transactionType) query.transactionType = params.transactionType;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      PharmacyWalletTransactionModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      PharmacyWalletTransactionModel.countDocuments(query),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }
}
