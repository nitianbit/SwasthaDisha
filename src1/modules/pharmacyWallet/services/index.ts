import { Service } from 'typedi';
import { startSession } from 'mongoose';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { BookingRepository } from '@/modules/bookings/repository';
import { PharmacyCustomerService } from '@/modules/pharmacyCustomers/services';
import {
  IPharmacyWallet,
  IPharmacyWalletTransaction,
  TopupWalletRequest,
  InitiatePharmacyWalletTopupResponse,
  ConsultationPaymentRequest,
  WalletTxQueryParams,
} from '@/modules/pharmacyWallet/types';
import { AppError } from '@/modules/common/types';
import { PaymentService } from '@/modules/payment/services';

@Service()
export class PharmacyWalletService {
  constructor(
    private walletRepo: PharmacyWalletRepository,
    private txRepo: PharmacyWalletTransactionRepository,
    private bookingRepository: BookingRepository,
    private pharmacyCustomerService: PharmacyCustomerService,
    private paymentService?: PaymentService
  ) {}

  async initiateTopupPayment(
    pharmacyId: string,
    actorUserId: string,
    req: TopupWalletRequest
  ): Promise<InitiatePharmacyWalletTopupResponse> {
    if (!this.paymentService) {
      throw new AppError({
        status: 500,
        code: 'PAYMENT_SERVICE_UNAVAILABLE',
        message: 'Payment service is unavailable',
      });
    }

    await this.getOrCreateWallet(pharmacyId);
    const createdOrder = await this.paymentService.createOrder({
      userId: actorUserId,
      payerUserId: actorUserId,
      payerPharmacyId: pharmacyId,
      context: 'wallet_recharge',
      contextId: `pharmacy_${pharmacyId}_${Date.now()}`,
      baseAmount: req.amount,
      finalAmount: req.amount,
      notes: {
        flow: 'pharmacy_wallet_recharge',
        pharmacyId,
        ...(req.notes ? { topupNotes: req.notes } : {}),
      },
    });

    return {
      paymentRequired: true,
      paymentTransactionId: createdOrder.paymentRecord._id!,
      razorpayOrderId: createdOrder.razorpayOrder.id,
      razorpayKeyId: createdOrder.razorpayKeyId,
      amount: req.amount,
      currency: createdOrder.razorpayOrder.currency,
    };
  }

  async getOrCreateWallet(pharmacyId: string): Promise<IPharmacyWallet> {
    try {
      return await this.walletRepo.upsertWallet(pharmacyId);
    } catch (error) {
      // Two concurrent first accesses can both take the upsert insert path;
      // the loser retries and matches the existing wallet.
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      return this.walletRepo.upsertWallet(pharmacyId);
    }
  }

  async getWallet(pharmacyId: string, createIfMissing: boolean = true): Promise<IPharmacyWallet | null> {
    if (createIfMissing) {
      return this.getOrCreateWallet(pharmacyId);
    }

    return this.walletRepo.findByPharmacy(pharmacyId);
  }

  async topup(
    pharmacyId: string,
    req: TopupWalletRequest,
    idempotencyKey?: string
  ): Promise<IPharmacyWallet> {
    await this.getOrCreateWallet(pharmacyId);
    const normalizedKey = idempotencyKey?.trim();
    if (normalizedKey) {
      const existing = await this.txRepo.findOne({
        pharmacyId,
        referenceType: 'topup',
        referenceId: normalizedKey,
      });
      if (existing) {
        const wallet = await this.walletRepo.findByPharmacy(pharmacyId);
        if (wallet) return wallet;
      }
    }

    const amountPaise = Math.round(req.amount * 100);
    const session = await startSession();
    try {
      let result: IPharmacyWallet | undefined;
      await session.withTransaction(async () => {
        const updated = await this.walletRepo.atomicCredit(pharmacyId, req.amount, session);
        if (!updated) {
          throw new AppError({ status: 500, code: 'TOPUP_FAILED', message: 'Failed to top up wallet' });
        }
        const balanceAfterPaise = updated.balancePaise ?? Math.round(updated.balance * 100);
        const balanceBeforePaise = balanceAfterPaise - amountPaise;

        await this.txRepo.save({
          pharmacyId,
          walletId: String(updated._id),
          transactionType: 'credit',
          amount: amountPaise / 100,
          amountPaise,
          balanceBefore: balanceBeforePaise / 100,
          balanceAfter: balanceAfterPaise / 100,
          balanceBeforePaise,
          balanceAfterPaise,
          status: 'completed',
          referenceType: 'topup',
          referenceId: normalizedKey,
          description: 'Admin top-up',
          notes: req.notes,
          transactionDate: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
        }, { session });
        result = updated;
      });
      if (!result) {
        throw new AppError({ status: 500, code: 'TOPUP_FAILED', message: 'Failed to top up wallet' });
      }
      return result;
    } catch (error) {
      if (normalizedKey && isDuplicateKeyError(error)) {
        const wallet = await this.walletRepo.findByPharmacy(pharmacyId);
        if (wallet) return wallet;
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async payConsultation(
    pharmacyId: string,
    req: ConsultationPaymentRequest
  ): Promise<IPharmacyWallet> {
    const consultation = await this.bookingRepository.findById(req.consultationId);
    if (!consultation || consultation.bookingType !== 'consultation') {
      throw new AppError({
        status: 404,
        code: 'CONSULTATION_NOT_FOUND',
        message: 'Consultation booking not found',
      });
    }

    await this.pharmacyCustomerService.assertLinked(pharmacyId, consultation.userId);

    if (consultation.status === 'cancelled') {
      throw new AppError({
        status: 400,
        code: 'CONSULTATION_CANCELLED',
        message: 'Cannot pay for a cancelled consultation',
      });
    }

    if (consultation.paymentStatus === 'paid') {
      throw new AppError({
        status: 400,
        code: 'CONSULTATION_ALREADY_PAID',
        message: 'Consultation is already marked as paid',
      });
    }

    const wallet = await this.getOrCreateWallet(pharmacyId);

    if (wallet.balance < req.amount) {
      throw new AppError({
        status: 400,
        code: 'INSUFFICIENT_BALANCE',
        message: `Insufficient wallet balance. Available: ${wallet.balance}`,
      });
    }

    // Debit, transaction record, and booking update commit or roll back as
    // one unit, so a failed booking update can never leave the wallet debited.
    const session = await startSession();
    try {
      let updatedWallet: IPharmacyWallet | undefined;

      await session.withTransaction(async () => {
        const updated = await this.walletRepo.atomicDebit(pharmacyId, req.amount, session);
        if (!updated) {
          throw new AppError({
            status: 400,
            code: 'INSUFFICIENT_BALANCE',
            message: 'Insufficient wallet balance',
          });
        }

        const transaction = await this.txRepo.save(
          {
            pharmacyId,
            walletId: String(wallet._id),
            transactionType: 'consultation_payment',
            amount: req.amount,
            amountPaise: Math.round(req.amount * 100),
            balanceBefore: updated.balance + req.amount,
            balanceAfter: updated.balance,
            balanceBeforePaise: (updated.balancePaise ?? Math.round(updated.balance * 100)) + Math.round(req.amount * 100),
            balanceAfterPaise: updated.balancePaise ?? Math.round(updated.balance * 100),
            status: 'completed',
            referenceType: 'consultation',
            referenceId: req.consultationId,
            description: 'Consultation payment from pharmacy wallet',
            notes: req.notes,
            transactionDate: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
          },
          { session }
        );

        const paidAt = new Date().toISOString();
        // Conditional on paymentStatus so two concurrent payment calls cannot
        // both mark the same consultation paid — the loser aborts and its
        // debit rolls back.
        const bookingUpdated = await this.bookingRepository.update(
          { _id: req.consultationId, paymentStatus: { $ne: 'paid' } },
          {
            paymentStatus: 'paid',
            paymentTransactionId: String(transaction._id),
            lifecycle: {
              ...(consultation.lifecycle || {}),
              paid: {
                at: paidAt,
                by: 'pharmacy_wallet',
                amount: req.amount,
              },
            },
          } as any,
          { new: true, session }
        );

        if (!bookingUpdated) {
          throw new AppError({
            status: 409,
            code: 'CONSULTATION_ALREADY_PAID',
            message: 'Consultation was already paid; wallet was not charged',
          });
        }

        updatedWallet = updated;
      });

      if (!updatedWallet) {
        throw new AppError({
          status: 500,
          code: 'CONSULTATION_PAYMENT_SYNC_FAILED',
          message: 'Consultation payment could not be completed',
        });
      }

      return updatedWallet;
    } finally {
      await session.endSession();
    }
  }

  async getTransactions(
    params: WalletTxQueryParams
  ): Promise<{ data: IPharmacyWalletTransaction[]; total: number; page: number; totalPages: number }> {
    return this.txRepo.findWithPagination(params, params.page ?? 1, params.limit ?? 20);
  }
}
