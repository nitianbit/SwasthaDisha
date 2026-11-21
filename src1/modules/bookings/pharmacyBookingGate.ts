import { NextFunction, Response } from 'express';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { AuthRequest, assertOperationalPharmacy } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';

const walletRefused = () => new AppError({ status: 403, code: 'PHARMACY_WALLET_NOT_ALLOWED',
  message: "A pharmacy cannot pay from the customer's wallet" });

/**
 * S3: a pharmacy creates a booking only while it is operational and verified (as requireOperationalPharmacy), only for
 * a customer linked to it (PharmacyCustomer), never paid from that customer's wallet and never with the customer's free
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
  const linked = typeof body.userId === 'string' && /^[0-9a-fA-F]{24}$/.test(body.userId) &&
    (await PharmacyCustomerModel.exists({ pharmacyId: { $eq: req.user.pharmacyId }, userId: { $eq: body.userId } })) !== null;
  if (!linked) {
    throw new AppError({ status: 403, code: 'CUSTOMER_NOT_LINKED', message: 'This customer is not linked to your pharmacy' });
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
