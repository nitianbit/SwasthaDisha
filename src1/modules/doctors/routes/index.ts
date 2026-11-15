import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin } from '@/modules/middleware/auth';
import * as c from '@/modules/doctors/controller/instant';
import * as v from '@/modules/doctors/validation';

/** Customer "Consult now" (mounted at /api/v1/instant with authenticate + denyRoles('partner')); customers only. */
export const instantRouter = Router();
instantRouter.get('/doctors', validate(v.onlineDoctorsQuerySchema, 'query'), catchAsync(c.onlineDoctors));
instantRouter.get('/quote', validate(v.quoteQuerySchema, 'query'), catchAsync(c.getQuote));
instantRouter.post('/requests', validate(v.createInstantSchema, 'body'), catchAsync(c.createRequest));
instantRouter.get('/requests', catchAsync(c.myRequests));
instantRouter.get('/requests/:requestId', validate(v.requestIdParamSchema, 'params'), catchAsync(c.myRequest));
instantRouter.post('/requests/:requestId/pay', validate(v.requestIdParamSchema, 'params'), validate(v.payInstantSchema, 'body'), catchAsync(c.payRequest));
instantRouter.post('/requests/:requestId/reoffer', validate(v.requestIdParamSchema, 'params'), validate(v.reofferSchema, 'body'), catchAsync(c.reofferRequest));
instantRouter.post('/requests/:requestId/activity', validate(v.requestIdParamSchema, 'params'), catchAsync(c.requestActivity));
instantRouter.post('/requests/:requestId/refund', validate(v.requestIdParamSchema, 'params'), catchAsync(c.refundRequest));
instantRouter.post('/admin/bookings/:bookingId/cancel', requireAdmin, validate(v.bookingIdParamSchema, 'params'),
  validate(v.adminCancelInstantSchema, 'body'), catchAsync(c.adminCancelInstant));
