import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { PaymentService } from '@/modules/payment/services';
import { IPaymentRecord, VerifyPaymentRequest } from '@/modules/payment/types';
import { DOCTOR } from '@/modules/partnerWallets/ledger';
import { doctorTopupEntity } from '@/modules/partnerWallets/service';
import { AuthRequest } from '@/modules/middleware/auth';
import { bookerView } from '@/modules/assisted/bookerView';
import { isOperationalPharmacy } from '@/modules/assisted/rxAccess';

/**
 * Assisted booking phase 0 (review finding 1): a pharmacy verifying or reconciling the payment of a booking it made
 * gets the booker view of that booking (§17.2 shown list; the prescription only while it is operational and inside
 * the 90-day window), never the raw booking. Customers keep the customer view and admins the booking as before.
 */
async function forRequester<T extends object>(req: AuthRequest, result: T): Promise<T> {
  const r = result as { context?: unknown; entity?: unknown; paymentRecord?: IPaymentRecord };
  // r20 (§25.4.2): a doctor top-up answers the doctor wallet view (only its state for a doctor no longer eligible).
  if (r?.context === 'wallet_recharge' && r.paymentRecord && DOCTOR.topups.isTopup(r.paymentRecord as unknown as Record<string, unknown>)) {
    return { ...result, entity: await doctorTopupEntity(DOCTOR, r.paymentRecord) };
  }
  // Phase 1b: an assisted card payment (only its paying pharmacy can verify it) answers the booker view too; anyone else
  // gets the booking's id and states only.
  if (r?.context === 'assisted_booking' && req.user?.userType !== 'pharmacy') {
    const e = (r.entity ?? {}) as Record<string, unknown>;
    return { ...result, entity: { _id: e._id, status: e.status, paymentStatus: e.paymentStatus } };
  }
  if (req.user?.userType !== 'pharmacy' || (r?.context !== 'booking' && r?.context !== 'assisted_booking')) return result;
  const entity = r.entity as Record<string, any> | null | undefined;
  if (!entity || typeof entity !== 'object' || !entity._id) return result;
  const pharmacyId = String(req.user.pharmacyId || req.user._id);
  return { ...result, entity: await bookerView(entity, pharmacyId, { copies: 'queue', clinical: await isOperationalPharmacy(pharmacyId) }) };
}

export class PaymentController {
  private paymentService: PaymentService;

  constructor() {
    this.paymentService = Container.get(PaymentService);
  }

  verify = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const data: VerifyPaymentRequest = {
      ...req.body,
      userId: req.user!._id,
      requesterUserType: req.user!.userType,
      requesterPharmacyId: req.user?.pharmacyId,
    };
    const result = await forRequester(req, await this.paymentService.verifyPaymentAndProcess(data));

    const message =
      result.context === 'external_booking' && !result.paymentRecord.isProcessed
        ? 'Payment received. Booking confirmation is pending. Please try again after some time.'
        : result.context === 'pharmacy_order' && result.paymentRecord.status === 'refunded'
          ? 'Payment was received after the 30-minute payment window and has been refunded to wallet. Please create a new order.'
        : result.context === 'assisted_booking' && result.paymentRecord.status === 'refunded'
          ? 'The booking could not take this payment (it expired, was cancelled, or the doctor is not available); the amount is being refunded to the card or UPI it was paid with.'
        : 'Payment verified successfully';

    res.status(200).json({
      success: true,
      message,
      data: result,
    });
  };

  reconcile = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const result = await forRequester(req, await this.paymentService.reconcilePaymentAndProcess({
      paymentTransactionId: String(req.body.paymentTransactionId),
      userId: req.user!._id,
      requesterUserType: req.user!.userType,
      requesterPharmacyId: req.user?.pharmacyId,
    }));
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({
      success: true,
      message: result.state === 'paid' ? 'Payment found and applied' : 'No completed payment was found for this order',
      data: result,
    });
  };
}
