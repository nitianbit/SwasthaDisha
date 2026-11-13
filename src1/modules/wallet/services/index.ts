import { Service } from 'typedi';
import {
  WalletRepository,
  WalletTransactionRepository,
} from '@/modules/wallet/repository';
import {
  IWallet,
  IWalletTransaction,
  CreateWalletRequest,
  UpdateWalletRequest,
  CreateWalletTransactionRequest,
  InitiateWalletRechargeRequest,
  WalletQueryParams,
  WalletTransactionQueryParams,
} from '@/modules/wallet/types';
import { AppError } from '@/modules/common/types';
import { getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import { NotificationService } from '@/modules/notification/services';
import { PaymentService } from '@/modules/payment/services';
import { CouponService } from '@/modules/coupon/services';

@Service()
export class WalletService {
  constructor(
    private walletRepository: WalletRepository,
    private walletTransactionRepository: WalletTransactionRepository,
    private notificationService: NotificationService,
    private paymentService: PaymentService,
    private couponService: CouponService
  ) {}

  async create(data: CreateWalletRequest): Promise<IWallet> {
    // Check if wallet already exists for this user
    const existingWallet = await this.walletRepository.findByUserId(data.userId);

    if (existingWallet) {
      throw new AppError({
        status: 400,
        code: 'WALLET_ALREADY_EXISTS',
        message: 'Wallet already exists for this user',
      });
    }

    const initialBalance = data.initialBalance || 0;

    const wallet = await this.walletRepository.save({
      userId: data.userId,
      balance: initialBalance,
      isActive: data.isActive !== undefined ? data.isActive : true,
    });

    // If initial balance > 0, create a credit transaction
    if (initialBalance > 0) {
      await this.walletTransactionRepository.save({
        userId: data.userId,
        walletId: wallet._id!,
        transactionType: 'credit',
        amount: initialBalance,
        balanceBefore: 0,
        balanceAfter: initialBalance,
        status: 'completed',
        referenceType: 'initial',
        description: 'Initial wallet balance',
        transactionDate: getTodayYyyymmdd(),
      });
    }

    return wallet;
  }

  async getByUserId(userId: string): Promise<IWallet> {
    let wallet = await this.walletRepository.findByUserId(userId);

    if (!wallet) {
      // Auto-create wallet if it doesn't exist
      wallet = await this.create({ userId, initialBalance: 0 });
    }

    return wallet;
  }

  async getById(id: string): Promise<IWallet> {
    const wallet = await this.walletRepository.findById(id);

    if (!wallet) {
      throw new AppError({
        status: 404,
        code: 'WALLET_NOT_FOUND',
        message: 'Wallet not found',
      });
    }

    return wallet;
  }

  async getAll(queryParams: WalletQueryParams = {}): Promise<{
    data: IWallet[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    if (queryParams.page && queryParams.limit) {
      return this.walletRepository.findWithPagination(
        queryParams,
        queryParams.page,
        queryParams.limit
      );
    }

    const filter: any = {};

    if (queryParams.userId) {
      filter.userId = queryParams.userId;
    }

    if (queryParams.isActive !== undefined) {
      filter.isActive = queryParams.isActive;
    }

    const sort: any = {};
    if (queryParams.sortBy) {
      sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1;
    }

    const data = await this.walletRepository.findAll(filter, { sort });
    return { data };
  }

  async update(id: string, data: UpdateWalletRequest): Promise<IWallet> {
    const wallet = await this.walletRepository.findById(id);

    if (!wallet) {
      throw new AppError({
        status: 404,
        code: 'WALLET_NOT_FOUND',
        message: 'Wallet not found',
      });
    }

    const updated = await this.walletRepository.update({ _id: id }, data);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update wallet',
      });
    }

    return updated;
  }

  async addTransaction(
    data: CreateWalletTransactionRequest
  ): Promise<IWalletTransaction> {
    // Get or create wallet
    let wallet = await this.walletRepository.findByUserId(data.userId);
    if (!wallet) {
      wallet = await this.create({ userId: data.userId, initialBalance: 0 });
    }

    if (!wallet.isActive) {
      throw new AppError({
        status: 400,
        code: 'WALLET_INACTIVE',
        message: 'Wallet is not active',
      });
    }

    // Atomic balance change + ledger row (debit only if covered).
    const posted = await this.walletRepository.postEntry({
      userId: data.userId,
      walletId: wallet._id!,
      transactionType: data.transactionType,
      amount: data.amount,
      referenceType: data.referenceType,
      referenceId: data.referenceId,
      description: data.description,
      notes: data.notes,
      transactionDate: data.transactionDate || getTodayYyyymmdd(),
    });
    if (!posted) {
      throw new AppError({
        status: 400,
        code: 'INSUFFICIENT_BALANCE',
        message: 'Insufficient wallet balance',
      });
    }
    const transaction = posted.transaction;

    // Create notification for wallet credit transactions
    if (data.transactionType === 'credit' || data.transactionType === 'refund' || data.transactionType === 'cashback' || data.transactionType === 'promotion') {
      try {
        await this.notificationService.createWalletCreditNotification(
          data.userId,
          transaction._id!,
          data.amount,
          {
            transactionType: data.transactionType,
            balanceBefore: transaction.balanceBefore,
            balanceAfter: transaction.balanceAfter,
            referenceType: data.referenceType,
            referenceId: data.referenceId,
            description: data.description,
          }
        );
      } catch (error) {
        // Don't fail transaction if notification fails
        console.error('Failed to create wallet credit notification:', error);
      }
    }

    return transaction;
  }

  async getTransactions(
    userId: string,
    queryParams: WalletTransactionQueryParams = {}
  ): Promise<{
    data: IWalletTransaction[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    const params = { ...queryParams, userId };

    if (queryParams.page && queryParams.limit) {
      return this.walletTransactionRepository.findWithPagination(
        params,
        queryParams.page,
        queryParams.limit
      );
    }

    const filter: any = { userId };

    if (queryParams.transactionType) {
      filter.transactionType = queryParams.transactionType;
    }

    if (queryParams.status) {
      filter.status = queryParams.status;
    }

    if (queryParams.referenceType) {
      filter.referenceType = queryParams.referenceType;
    }

    if (queryParams.referenceId) {
      filter.referenceId = queryParams.referenceId;
    }

    const sort: any = {};
    if (queryParams.sortBy) {
      sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1; // Most recent first
    }

    const data = await this.walletTransactionRepository.findAll(filter, { sort });
    return { data };
  }

  async getTransactionById(id: string): Promise<IWalletTransaction> {
    const transaction = await this.walletTransactionRepository.findById(id);

    if (!transaction) {
      throw new AppError({
        status: 404,
        code: 'TRANSACTION_NOT_FOUND',
        message: 'Transaction not found',
      });
    }

    return transaction;
  }

  async initiateRecharge(data: InitiateWalletRechargeRequest): Promise<{
    paymentTransactionId: string;
    razorpayOrderId: string;
    razorpayKeyId: string;
    amount: number;
    baseAmount: number;
    discountAmount: number;
    couponCode?: string;
    currency: string;
  }> {
    let discountAmount = 0;
    let finalAmount = data.amount;
    let couponCode: string | undefined;

    if (data.couponCode) {
      const couponValidation = await this.couponService.validateWalletCoupon({
        code: data.couponCode,
        userId: data.userId,
        purchaseAmount: data.amount,
      });

      if (!couponValidation.isValid) {
        throw new AppError({
          status: 400,
          code: 'INVALID_COUPON',
          message: couponValidation.message || 'Invalid coupon code',
        });
      }

      discountAmount = couponValidation.discountAmount || 0;
      finalAmount = couponValidation.finalAmount ?? data.amount;
      couponCode = couponValidation.coupon?.code;
    }

    if (finalAmount <= 0) {
      throw new AppError({
        status: 400,
        code: 'INVALID_RECHARGE_AMOUNT',
        message: 'Final recharge amount must be greater than zero',
      });
    }

    const createdOrder = await this.paymentService.createOrder({
      userId: data.userId,
      context: 'wallet_recharge',
      contextId: `${data.userId}_${Date.now()}`,
      baseAmount: data.amount,
      discountAmount,
      finalAmount,
      couponCode,
      notes: {
        flow: 'wallet_recharge',
      },
    });

    return {
      paymentTransactionId: createdOrder.paymentRecord._id!,
      razorpayOrderId: createdOrder.razorpayOrder.id,
      razorpayKeyId: createdOrder.razorpayKeyId,
      amount: finalAmount,
      baseAmount: data.amount,
      discountAmount,
      couponCode,
      currency: createdOrder.razorpayOrder.currency,
    };
  }

}
