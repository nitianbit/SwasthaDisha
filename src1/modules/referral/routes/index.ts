import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { ReferralController } from '@/modules/referral/controller';
import {
  applyReferralSchema,
  referralTransactionQuerySchema,
} from '@/modules/referral/validation';

const referralRouter = Router();

const referralController = new ReferralController();

referralRouter.get(
  '/code',
  catchAsync(referralController.getCode)
);

referralRouter.get(
  '/earnings',
  validate(referralTransactionQuerySchema, 'query'),
  catchAsync(referralController.getEarnings)
);

referralRouter.get(
  '/transactions',
  validate(referralTransactionQuerySchema, 'query'),
  catchAsync(referralController.getTransactions)
);

referralRouter.post(
  '/apply',
  validate(applyReferralSchema, 'body'),
  catchAsync(referralController.apply)
);

export default referralRouter;
