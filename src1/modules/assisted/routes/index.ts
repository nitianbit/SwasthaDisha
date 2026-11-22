import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireOperationalPharmacy } from '@/modules/middleware/auth';
import { getBooking, listBookings } from '@/modules/assisted/controller';
import { pharmacyBookingQuerySchema } from '@/modules/assisted/validation';

/**
 * Assisted booking phase 0: the booking pharmacy's own bookings (§17.2). Pharmacy only, operational and verified
 * (`requireOperationalPharmacy`, so access ends with the pharmacy's authority).
 */
const pharmacyBookingRouter = Router();
pharmacyBookingRouter.use(requireOperationalPharmacy);
pharmacyBookingRouter.get('/', validate(pharmacyBookingQuerySchema, 'query'), catchAsync(listBookings));
pharmacyBookingRouter.get('/:id', catchAsync(getBooking));

export default pharmacyBookingRouter;
