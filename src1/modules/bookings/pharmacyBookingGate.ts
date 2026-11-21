import { NextFunction, Response } from 'express';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { AuthRequest, assertOperationalPharmacy } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';

const walletRefused = () => new AppError({ status: 403, code: 'PHARMACY_WALLET_NOT_ALLOWED',
  message: "A pharmacy cannot pay from the customer's wallet" });

/**
 * S3: a pharmacy creates a booking only while it is operational and verified (as requireOperationalPharmacy), only for
 * a customer linked to it (PharmacyCustomer) with the patient's consent recorded, never paid from that customer's wallet and never with the customer's free
 * follow-up. Every other role passes unchanged. (A pharmacy's dependentId is checked against that customer by the
 * controller.)
 */
export async function gatePharmacyBookingCreate(req: AuthRequest, _res: Response, next: NextFunction): Promise<void> {
  if (req.user?.userType !== 'pharmacy') return next();
  await assertOperationalPharmacy(req);
  const body = (req.body ?? {}) as { userId?: unknown; useWalletBalance?: unknown; followUp?: { isFollowUp?: unknown } };
  if (body.userId === undefined || body.userId === '') {
    throw new AppError({ status: 400, code: 'USER_ID_REQUIRED', message: 'userId is required when a pharmacy creates a booking' });
  }
  const link = typeof body.userId === 'string' && /^[0-9a-fA-F]{24}$/.test(body.userId)
    ? await PharmacyCustomerModel.findOne({ pharmacyId: { $eq: req.user.pharmacyId }, userId: { $eq: body.userId } })
      .select({ consent: 1 }).lean()
    : null;
  if (!link) {
    throw new AppError({ status: 403, code: 'CUSTOMER_NOT_LINKED', message: 'This customer is not linked to your pharmacy' });
  }
  // Only a link the patient agreed to (the partner's tick, or the customer's own order with this pharmacy); a link
  // made without it (before S3, or by the released app without the tick) is re-made with consent first.
  if (link.consent !== 'patient_agreed' && link.consent !== 'customer_order') {
    throw new AppError({ status: 403, code: 'CUSTOMER_CONSENT_REQUIRED',
      message: "The patient's agreement to this link is not recorded; link the customer again with the patient's consent" });
  }
  if (body.useWalletBalance === true) throw walletRefused();
  if (body.followUp?.isFollowUp === true) {
    throw new AppError({ status: 403, code: 'PHARMACY_FOLLOW_UP_NOT_ALLOWED',
      message: "A pharmacy cannot book the customer's free follow-up" });
  }
  next();
}

/** S3: a pharmacy's payment retry never adds funding from the customer's wallet. */
export async function gatePharmacyBookingRetry(req: AuthRequest, _res: Response, next: NextFunction): Promise<void> {
  if (req.user?.userType === 'pharmacy' && (req.body as { useWalletBalance?: unknown } | undefined)?.useWalletBalance === true) {
    throw walletRefused();
  }
  next();
}
