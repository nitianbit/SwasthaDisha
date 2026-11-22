import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdminOrOperationalPharmacy, requirePharmacy } from '@/modules/middleware/auth';
import { PharmacyWalletController } from '@/modules/pharmacyWallet/controller';
import { topupSchema } from '@/modules/pharmacyWallet/validation';

const pharmacyWalletRouter = Router();
const controller = new PharmacyWalletController();

// Get wallet balance
pharmacyWalletRouter.get('/', requireAdminOrOperationalPharmacy, catchAsync(controller.getWallet));

// Get transaction history
pharmacyWalletRouter.get('/transactions', requireAdminOrOperationalPharmacy, catchAsync(controller.getTransactions));

// Admin: manual credit. Pharmacy: initiate Razorpay-backed self top-up.
pharmacyWalletRouter.post(
  '/topup',
  requireAdminOrOperationalPharmacy,
  validate(topupSchema, 'body'),
  catchAsync(controller.topup)
);

// Assisted booking phase 1a (§17.6): reconcile one of this pharmacy's Razorpay top-ups with the gateway (credited once).
// Review of db252c1 (item b): any pharmacy, operational or not — a captured top-up is its own money and is credited; the
// wallet funds nothing while the pharmacy is not operational.
pharmacyWalletRouter.post('/topups/:paymentTransactionId/check', requirePharmacy, catchAsync(controller.checkTopup));

export default pharmacyWalletRouter;
