import crypto from 'crypto';
import { Service } from 'typedi';
import { UserRepository } from '@/modules/user/repository';
import { WalletTransactionRepository } from '@/modules/wallet/repository';
import { WalletService } from '@/modules/wallet/services';
import { IWalletTransaction } from '@/modules/wallet/types';
import { AppError } from '@/modules/common/types';
import { CONFIG } from '@/config/config';
import {
  ApplyReferralRequest,
  ApplyReferralResult,
  ReferralEarningsResult,
  ReferralCodeResult,
  ReferralTransactionQueryParams,
} from '@/modules/referral/types';

@Service()
export class ReferralService {
  constructor(
    private userRepository: UserRepository,
    private walletService: WalletService,
    private walletTransactionRepository: WalletTransactionRepository
  ) {}

  private generateReferralCodeSeed(): string {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
  }

  private async ensureReferralCode(userId: string): Promise<string> {
    const user = await this.userRepository.findById(userId);

    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    if (user.referralCode) {
      return user.referralCode;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidateCode = `EWA${this.generateReferralCodeSeed()}`;
      const existingUser = await this.userRepository.findByReferralCode(
        candidateCode
      );

      if (existingUser) {
        continue;
      }

      const updatedUser = await this.userRepository.update(
        {
          _id: userId,
          referralCode: { $exists: false },
        } as any,
        {
          referralCode: candidateCode,
        }
      );

      if (updatedUser?.referralCode) {
        return updatedUser.referralCode;
      }

      const reloadedUser = await this.userRepository.findById(userId);
      if (reloadedUser?.referralCode) {
        return reloadedUser.referralCode;
      }
    }

    throw new AppError({
      status: 500,
      code: 'REFERRAL_CODE_GENERATION_FAILED',
      message: 'Failed to generate referral code',
    });
  }

  async getReferralCode(userId: string): Promise<ReferralCodeResult> {
    const referralCode = await this.ensureReferralCode(userId);

    return {
      userId,
      referralCode,
    };
  }

  async getReferralEarnings(
    userId: string,
    queryParams: ReferralTransactionQueryParams = {}
  ): Promise<ReferralEarningsResult> {
    const summary =
      await this.walletTransactionRepository.getReferralRewardSummary({
        ...queryParams,
        userId,
      });

    return {
      userId,
      totalEarned: summary.totalEarned,
      totalTransactions: summary.totalTransactions,
    };
  }

  async getReferralTransactions(
    userId: string,
    queryParams: ReferralTransactionQueryParams = {}
  ): Promise<{
    data: IWalletTransaction[];
    totalEarned: number;
    totalTransactions: number;
    page?: number;
    total?: number;
    totalPages?: number;
  }> {
    const params = { ...queryParams, userId };
    const summary =
      await this.walletTransactionRepository.getReferralRewardSummary(params);

    if (queryParams.page && queryParams.limit) {
      const result =
        await this.walletTransactionRepository.findReferralRewardsWithPagination(
          params,
          queryParams.page,
          queryParams.limit
        );

      return {
        ...result,
        totalEarned: summary.totalEarned,
        totalTransactions: summary.totalTransactions,
      };
    }

    const data = await this.walletTransactionRepository.findReferralRewards(
      params
    );

    return {
      data,
      totalEarned: summary.totalEarned,
      totalTransactions: summary.totalTransactions,
    };
  }

  async applyReferral(
    referredUserId: string,
    data: ApplyReferralRequest
  ): Promise<ApplyReferralResult> {
    const referralCode = data.referralCode.trim().toUpperCase();

    const referredUser = await this.userRepository.findById(referredUserId);

    if (!referredUser) {
      throw new AppError({
        status: 404,
        code: 'REFERRED_USER_NOT_FOUND',
        message: 'Referred user not found',
      });
    }

    if (referredUser.referredByUserId) {
      throw new AppError({
        status: 400,
        code: 'REFERRAL_ALREADY_APPLIED',
        message: 'Referral has already been applied for this user',
      });
    }

    const referrerUser = await this.userRepository.findByReferralCode(
      referralCode
    );

    if (!referrerUser) {
      throw new AppError({
        status: 404,
        code: 'INVALID_REFERRAL_CODE',
        message: 'Referral code is invalid',
      });
    }

    const referrerUserId = referrerUser._id!;

    if (referredUserId === referrerUserId) {
      throw new AppError({
        status: 400,
        code: 'SELF_REFERRAL_NOT_ALLOWED',
        message: 'Users cannot use their own referral code',
      });
    }

    const referralRewardAmount = CONFIG.REFERRAL_REWARD_AMOUNT;

    if (referralRewardAmount <= 0) {
      throw new AppError({
        status: 500,
        code: 'INVALID_REFERRAL_REWARD_AMOUNT',
        message: 'Referral reward amount must be greater than zero',
      });
    }

    const updatedUser = await this.userRepository.update(
      {
        _id: referredUserId,
        referredByUserId: { $exists: false },
      } as any,
      {
        referredByUserId: referrerUserId,
      }
    );

    if (!updatedUser) {
      throw new AppError({
        status: 400,
        code: 'REFERRAL_ALREADY_APPLIED',
        message: 'Referral has already been applied for this user',
      });
    }

    try {
      const transaction = await this.walletService.addTransaction({
        userId: referrerUserId,
        transactionType: 'promotion',
        amount: referralRewardAmount,
        referenceType: 'referral',
        referenceId: referredUserId,
        description: 'Referral reward credited to wallet for inviting a user',
      });

      return {
        referredUserId,
        referrerUserId,
        referrerReferralCode: referralCode,
        rewardAmount: referralRewardAmount,
        referredByUserId: updatedUser.referredByUserId!,
        walletTransactionId: transaction._id!,
      };
    } catch (error) {
      await this.userRepository.update(
        {
          _id: referredUserId,
          referredByUserId: referrerUserId,
        } as any,
        {
          $unset: { referredByUserId: 1 },
        } as any
      );

      throw error;
    }
  }
}
