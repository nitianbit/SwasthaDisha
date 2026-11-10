import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { HealthAssessmentController } from '@/modules/healthAssessments/controller';
import { requireAdmin } from '@/modules/middleware/auth';
import {
  healthAssessmentIdParamSchema,
  healthAssessmentQuerySchema,
  submitHealthAssessmentSchema,
} from '@/modules/healthAssessments/validation';

const healthAssessmentRouter = Router();
const healthAssessmentController = new HealthAssessmentController();

healthAssessmentRouter.get(
  '/questionnaire',
  catchAsync(healthAssessmentController.getQuestionnaire)
);

healthAssessmentRouter.post(
  '/',
  validate(submitHealthAssessmentSchema, 'body'),
  catchAsync(healthAssessmentController.submit)
);

healthAssessmentRouter.get(
  '/me',
  validate(healthAssessmentQuerySchema, 'query'),
  catchAsync(healthAssessmentController.getMine)
);

healthAssessmentRouter.get(
  '/admin/missing-offerings',
  requireAdmin,
  catchAsync(healthAssessmentController.getMissingOfferings)
);

healthAssessmentRouter.get(
  '/:id',
  validate(healthAssessmentIdParamSchema, 'params'),
  catchAsync(healthAssessmentController.getById)
);

export default healthAssessmentRouter;
