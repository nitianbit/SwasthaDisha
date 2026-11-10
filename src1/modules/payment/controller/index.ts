import 'reflect-metadata';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { PaymentService } from '@/modules/payment/services';
import { VerifyPaymentRequest } from '@/modules/payment/types';
import { AuthRequest } from '@/modules/middleware/auth';

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
    const result = await this.paymentService.verifyPaymentAndProcess(data);

    const message =
      result.context === 'external_booking' && !result.paymentRecord.isProcessed
        ? 'Payment received. Booking confirmation is pending. Please try again after some time.'
        : result.context === 'pharmacy_order' && result.paymentRecord.status === 'refunded'
          ? 'Payment was received after the 30-minute payment window and has been refunded to wallet. Please create a new order.'
        : 'Payment verified successfully';

    res.status(200).json({
      success: true,
      message,
      data: result,
    });
  };
}
