import { createHash } from 'node:crypto';
import { Response } from 'express';
import Joi from 'joi';
import { Types } from 'mongoose';
import { Container } from 'typedi';
import BookingModel from '@/modules/bookings/model';
import { BookingAdminCloseModel, type IBookingAdminClose } from '@/modules/bookings/model/adminClose';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { BookingService } from '@/modules/bookings/services';
import { AppError } from '@/modules/common/types';
import { AuthRequest } from '@/modules/middleware/auth';
import { IBooking } from '@/modules/bookings/types';
import logger from '@/services/logger';

/**
 * S5c (stage): an admin closes a consultation nobody else can close - typically a paid appointment whose doctor is no
 * longer verified or active (the doctor's own status change is refused and, after the start time, the customer's
 * cancellation is too). POST /api/v1/specialists/admin/bookings/:bookingId/close {reason, requestKey, expectedUpdatedAt?}
 *
 * - The booking is cancelled exactly as a doctor cancellation by an admin (BookingService.cancelByDoctor): the patient
 *   is refunded in full to the wallet (a clinic-paid desk appointment refunds nothing: nothing was taken), seat and
 *   doctor time are released, the coupon is undone. No cancellation window applies, so it works after the start time.
 * - Any non-final consultation / second opinion (pending or confirmed). An instant consultation uses its own admin
 *   cancel (409 USE_INSTANT_ADMIN_CANCEL); a booking moved after a no-show uses cancel-no-show (409 from the settlement).
 * - Once only per (admin, requestKey): the audit row is written in the cancellation's transaction (unique key), so a
 *   resent request answers with the same booking (replayed: true) and the same key for another booking or reason is
 *   409 REQUEST_KEY_REUSED. A booking already cancelled by anyone else is 409 ALREADY_CANCELLED.
 * - Audit (bookingadmincloses): admin, booking, reason, the booking's doctor and statuses before, amount refunded.
 * - S5d: the reason is internal (audit only). The booking records 'Cancelled by Jansetu' with cause 'admin', and the
 *   patient is told "Your consultation was cancelled by Jansetu." plus the refund line only when money was refunded.
 */
// The model lives in bookings/model/adminClose.ts so sync-indexes builds its unique (admin, requestKey) index.
export { BookingAdminCloseModel } from '@/modules/bookings/model/adminClose';
export type { IBookingAdminClose } from '@/modules/bookings/model/adminClose';

export const adminCloseSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required(),
  requestKey: Joi.string().pattern(/^[A-Za-z0-9_-]{8,100}$/).required(),
  expectedUpdatedAt: Joi.date().iso().optional(),
});

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
/** S5d: what the patient's booking shows as the cancellation reason (the admin's reason stays in the audit row). */
export const ADMIN_CLOSE_PUBLIC_REASON = 'Cancelled by Jansetu';
const hashOf = (bookingId: string, reason: string) => createHash('sha256').update(`${bookingId.toLowerCase()}|${reason.trim()}`).digest('hex');

type CloseRow = IBookingAdminClose & { _id?: unknown };
/** S5e: what an admin is shown of a close (the admin's reason included; never shown to the patient or the doctor). */
const closeView = (r: CloseRow) => ({ auditId: String(r._id), bookingId: r.bookingId, adminId: r.adminId, requestKey: r.requestKey, reason: r.reason,
  statusBefore: r.statusBefore, paymentStatusBefore: r.paymentStatusBefore, refunded: r.refunded, closedAt: r.closedAt });

/** The stored close of this (admin, key): its booking as it is now, or 409 when the key was used for another close. */
async function storedClose(adminId: string, requestKey: string, hash: string): Promise<{ booking: IBooking; row: CloseRow } | null> {
  const row = await BookingAdminCloseModel.findOne({ adminId, requestKey }).lean() as CloseRow | null;
  if (!row) return null;
  if (row.requestHash !== hash) throw err(409, 'REQUEST_KEY_REUSED', 'This request key was used for another close; send a new request key');
  const booking = (await BookingModel.findById(row.bookingId).lean()) as IBooking | null;
  return booking ? { booking, row } : null;
}

export async function adminCloseBooking(bookingId: string, adminId: string,
  input: { reason: string; requestKey: string; expectedUpdatedAt?: Date | string }): Promise<IBooking & { replayed: boolean; refunded: number; close: ReturnType<typeof closeView> }> {
  if (!Types.ObjectId.isValid(bookingId)) throw err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
  // S5d: once-only rests on the unique (admin, requestKey) index (built by sync-indexes); without it, 503 - never two
  // refunds for one key.
  await assertUniqueIndex(BookingAdminCloseModel, { adminId: 1, requestKey: 1 });
  const id = String(bookingId).toLowerCase();
  const reason = input.reason.trim();
  const hash = hashOf(id, reason);
  const prior = await storedClose(adminId, input.requestKey, hash);
  if (prior) return { ...prior.booking, replayed: true, refunded: prior.row.refunded, close: closeView(prior.row) };

  const b = await BookingModel.findById(id).select({ bookingType: 1, bookingKind: 1, status: 1, paymentStatus: 1 }).lean() as IBooking | null;
  if (!b) throw err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
  if (b.bookingType !== 'consultation' && b.bookingType !== 'second-opinion') {
    throw err(409, 'NOT_A_CONSULTATION', 'Only a consultation or second opinion is closed here');
  }
  if (b.bookingKind === 'instant') throw err(409, 'USE_INSTANT_ADMIN_CANCEL', 'Cancel an instant consultation with its admin cancel');
  if (b.status === 'cancelled') throw err(409, 'ALREADY_CANCELLED', 'This booking is already cancelled');

  let duplicate: unknown;
  try {
    // S5d: the admin's reason is internal (audit row only); the patient sees a fixed notice and the cause is 'admin'.
    await Container.get(BookingService).cancelByDoctor(id, { _id: adminId, userType: 'admin' }, ADMIN_CLOSE_PUBLIC_REASON, {
      expectedUpdatedAt: input.expectedUpdatedAt, asAdmin: true,
      inTx: async (after, s, amount) => {
        await BookingAdminCloseModel.create([{ adminId, requestKey: input.requestKey, requestHash: hash, bookingId: id,
          specialistId: after.specialistId ? String(after.specialistId).toLowerCase() : null, reason,
          statusBefore: String(b.status), paymentStatusBefore: String(b.paymentStatus), refunded: Number(amount ?? 0), closedAt: new Date() }], { session: s });
      },
    });
  } catch (e) {
    // A concurrent resend with the same key committed first: answered below from its stored row. Any other error fails.
    if ((e as { code?: number })?.code !== 11000) throw e;
    duplicate = e;
  }
  // S5e: the answer comes from the committed audit row (never from flags an aborted, retried attempt may have set).
  const done = await storedClose(adminId, input.requestKey, hash);
  if (!done) {
    // S5f: no row - this close did not happen. "Already cancelled" only when the booking really is; a duplicate key from
    // another index (e.g. a wallet operation key) is the real failure and is passed on (the booking stays as it was).
    const now = await BookingModel.findById(id).select({ status: 1 }).lean() as { status?: string } | null;
    if (now?.status === 'cancelled') throw err(409, 'ALREADY_CANCELLED', 'This booking is already cancelled');
    if (duplicate) throw duplicate;
    throw err(500, 'ADMIN_CLOSE_NOT_RECORDED', 'The booking was not closed; try again');
  }
  logger.warn('S5c: admin closed a booking', { bookingId: id, adminId, refunded: done.row.refunded });
  return { ...done.booking, replayed: false, refunded: done.row.refunded, close: closeView(done.row) };
}

export const adminCloseHandler = async (req: AuthRequest, res: Response) => {
  if (req.user?.userType !== 'admin') throw err(403, 'FORBIDDEN', 'Admin access is required');
  const data = await adminCloseBooking(req.params.bookingId, String(req.user._id), req.body);
  res.status(200).json({ success: true, message: data.replayed ? 'Booking already closed by this request' : 'Booking closed; the patient was refunded', data });
};

/** S5e: GET /specialists/admin/bookings/:bookingId/close - the admin closes of a booking, reasons included (admin only). */
export const adminCloseAuditHandler = async (req: AuthRequest, res: Response) => {
  if (req.user?.userType !== 'admin') throw err(403, 'FORBIDDEN', 'Admin access is required');
  if (!Types.ObjectId.isValid(req.params.bookingId)) throw err(404, 'BOOKING_NOT_FOUND', 'Booking not found');
  const rows = await BookingAdminCloseModel.find({ bookingId: String(req.params.bookingId).toLowerCase() }).sort({ closedAt: 1 }).lean() as CloseRow[];
  res.status(200).json({ success: true, data: rows.map(closeView) });
};
