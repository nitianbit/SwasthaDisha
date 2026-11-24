import { Service } from 'typedi';
import { startSession, Types } from 'mongoose';
import { pharmacyStore, pharmacyTopups } from '@/modules/pharmacyWallet/ledger';
import { adminTopup, checkTopup } from '@/modules/pharmacyWallet/walletCore';
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
import PharmacyModel from '@/modules/pharmacies/model';

/**
 * The released pharmacy app (WalletScreen) decides credit or debit from `transactionType` first and only knows
 * `credit` / `recharge` / `refund` and `debit` / `payment` / `booking`; anything else falls to the title text (a refund
 * of a "booking" would read as a debit). So every row answers with an app type by its sign, and the stored kind as
 * `movementType`. `credit`, `debit` and `refund` rows are unchanged.
 */
const APP_TYPES = ['credit', 'debit', 'refund'];
const ZERO_DEBIT_KINDS = ['chargeback', 'receivable_setoff', 'booking_debit', 'withdrawal_hold', 'consultation_payment'];
export function transactionView(t: IPharmacyWalletTransaction): IPharmacyWalletTransaction & { movementType: string } {
  const kind = String(t.transactionType);
  if (APP_TYPES.includes(kind)) return { ...t, movementType: kind };
  const signed = Number.isFinite(Number(t.signedAmountPaise)) ? Number(t.signedAmountPaise)
    : Math.round(Number(t.balanceAfter ?? 0) * 100) - Math.round(Number(t.balanceBefore ?? 0) * 100);
  // A zero-amount row (a chargeback the balance could not cover) reads as what its kind is.
  const credit = signed > 0 || (signed === 0 && !ZERO_DEBIT_KINDS.includes(kind));
  return { ...t, transactionType: (credit ? 'credit' : 'debit') as IPharmacyWalletTransaction['transactionType'], movementType: kind };
}

/** Assisted booking phase 1a (§17.6): the wallet answer adds the withdrawable amount and the freeze (absent = 0 / false). */
export function walletView(w: IPharmacyWallet): Record<string, unknown> {
  return { ...w, withdrawableMinor: Number(w.withdrawableMinor ?? 0), frozen: w.frozen === true,
    receivableMinor: Number(w.receivableMinor ?? 0) };
}

/** r7: the exact reads of an admin top-up by its key (now with the pharmacy store, r13). */
export { adminTopupByKeyLookups } from '@/modules/pharmacyWallet/ledger';

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

  /**
   * Assisted booking phase 1a (§6.4, W3b pattern): "check my top-up" — reconciles one of this pharmacy's Razorpay top-ups
   * with the gateway and credits it once if it was captured. Another pharmacy's (or a missing) record is 404.
   */
  async checkTopup(pharmacyId: string, paymentTransactionId: string): Promise<{ state: 'credited' | 'unpaid'; wallet: Record<string, unknown> | null }> {
    const paymentService = this.paymentService;
    if (!paymentService) throw new AppError({ status: 500, code: 'PAYMENT_SERVICE_UNAVAILABLE', message: 'Payment service is unavailable' });
    const out = await checkTopup(pharmacyTopups, pharmacyId, paymentTransactionId, (r) =>
      paymentService.reconcilePaymentAndProcess({ ...r, requesterUserType: 'pharmacy', requesterPharmacyId: pharmacyId }));
    return { state: out.state, wallet: out.wallet ? walletView(out.wallet) : null };
  }

  /**
   * r7: GET /pharmacy-wallet/topups/admin/by-key/:key?pharmacyId= — did an admin top-up with this Idempotency-Key credit
   * this pharmacy? Exact reads on the unique ledger indexes (adminTopupByKeyLookups): the row `{ pharmacyId, referenceType: 'topup',
   * referenceId: key }` (every admin top-up; older rows have only this) or `{ pharmacyId, operationKey:
   * 'admin_topup:<key>' }` (ledger rows). The key is trimmed as the top-up trims it. Never creates a wallet.
   */
  async adminTopupByKey(pharmacyId: string, rawKey: string): Promise<{ state: 'credited'; transaction: ReturnType<typeof transactionView>; wallet: Record<string, unknown> | null }
    | { state: 'not_found' }> {
    const key = String(rawKey ?? '').trim();
    const row = await pharmacyStore(pharmacyId).adminTopupByKey(key);
    if (!row) return { state: 'not_found' };
    const wallet = await this.walletRepo.findByPharmacy(pharmacyId);
    return { state: 'credited', transaction: transactionView(row), wallet: wallet ? walletView(wallet) : null };
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

  /**
   * Admin manual credit (POST /pharmacy-wallet/topup with an admin token). Review of fb4063c7 (4):
   * - the pharmacy must exist (404 PHARMACY_NOT_FOUND; no wallet is made for an unknown id);
   * - one credit per Idempotency-Key: the same key and content answers the wallet again (nothing more is credited); the
   *   same key with another amount or note is 409 IDEMPOTENCY_KEY_REUSED (content hash on the row; an older row without
   *   one is compared by amount and note);
   * - the crediting admin is stored on the ledger row (`actor`).
   */
  async topup(
    pharmacyId: string,
    req: TopupWalletRequest,
    idempotencyKey?: string,
    adminId?: string
  ): Promise<IPharmacyWallet> {
    if (!Types.ObjectId.isValid(pharmacyId) || !/^[0-9a-fA-F]{24}$/.test(pharmacyId) || !(await PharmacyModel.exists({ _id: pharmacyId }))) {
      throw new AppError({ status: 404, code: 'PHARMACY_NOT_FOUND', message: 'Pharmacy not found' });
    }
    await this.getOrCreateWallet(pharmacyId);
    const key = idempotencyKey?.trim();
    if (!key) throw new AppError({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'An Idempotency-Key header is required for an admin top-up' });
    // Assisted booking phase 1a (§17.3), r13 (shared with the lab wallet): through the ledger (signed amount, operation
    // key, version). An admin credit is never withdrawable (no lot) and posts whatever the wallet state.
    return adminTopup(pharmacyStore(pharmacyId), { key, amountMinor: Math.round(req.amount * 100), notes: req.notes, adminId });
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

    if ((consultation as { settlementSystem?: string }).settlementSystem === 'clinic') {
      throw new AppError({ status: 409, code: 'PAY_AT_CLINIC', message: 'This appointment is paid at the clinic' });
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
            // §17.3: every new row is signed (this unrouted legacy writer included).
            signedAmountPaise: -Math.round(req.amount * 100),
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
    const page = await this.txRepo.findWithPagination(params, params.page ?? 1, params.limit ?? 20);
    return { ...page, data: page.data.map(transactionView) };
  }
}
