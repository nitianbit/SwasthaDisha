import { Types } from 'mongoose';
import BookingModel from '@/modules/bookings/model';
import { AppError } from '@/modules/common/types';
import { bookerView, bookerViews } from '@/modules/assisted/bookerView';

type Row = Record<string, any>;

export interface PharmacyBookingQuery {
  status?: string;
  /** Appointment date range (India calendar days, YYYY-MM-DD), inclusive. */
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export const PHARMACY_BOOKINGS_DEFAULT_LIMIT = 20;
export const PHARMACY_BOOKINGS_MAX_LIMIT = 50;

const notFound = () => new AppError({ status: 404, code: 'BOOKING_NOT_FOUND', message: 'Booking not found' });
const ymd = (d: string) => d.replace(/-/g, '');

function parseCursor(c?: string): { at: Date; id: Types.ObjectId } | null {
  if (c === undefined || c === '') return null;
  const [ms, id, extra] = c.split('_');
  if (extra !== undefined || !/^\d{1,15}$/.test(ms ?? '') || !/^[0-9a-fA-F]{24}$/.test(id ?? '')) {
    throw new AppError({ status: 400, code: 'INVALID_CURSOR', message: 'Invalid cursor' });
  }
  return { at: new Date(Number(ms)), id: new Types.ObjectId(id) };
}

/**
 * Assisted booking phase 0 (§17.2): the bookings this pharmacy made (`pharmacyId` = it; legacy and, from phase 1a,
 * assisted), newest first with an exact cursor `<createdAt ms>_<id>`, filtered by status and appointment date range,
 * each in the booker view.
 */
export async function listPharmacyBookings(pharmacyId: string, q: PharmacyBookingQuery): Promise<{ items: Row[]; total: number; nextCursor: string | null }> {
  const filter: Row = { pharmacyId: { $eq: pharmacyId } };
  if (q.status) filter.status = { $eq: q.status };
  if (q.from || q.to) {
    if (q.from && q.to && q.from > q.to) throw new AppError({ status: 400, code: 'INVALID_DATE_RANGE', message: 'from must not be after to' });
    filter.bookingDate = { ...(q.from ? { $gte: ymd(q.from) } : {}), ...(q.to ? { $lte: ymd(q.to) } : {}) };
  }
  const limit = Math.min(Math.max(Number(q.limit) || PHARMACY_BOOKINGS_DEFAULT_LIMIT, 1), PHARMACY_BOOKINGS_MAX_LIMIT);
  const cur = parseCursor(q.cursor);
  const page = cur ? { $and: [filter, { $or: [{ createdAt: { $lt: cur.at } }, { createdAt: cur.at, _id: { $lt: cur.id } }] }] } : filter;
  const [total, rows] = await Promise.all([
    BookingModel.countDocuments(filter),
    BookingModel.find(page).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean() as unknown as Promise<Row[]>,
  ]);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: await bookerViews(items, pharmacyId),
    total,
    nextCursor: rows.length > limit && last ? `${new Date(last.createdAt).getTime()}_${String(last._id)}` : null,
  };
}

/** One booking this pharmacy made, in the booker view; any other booking (or a malformed id) is 404 like a missing one. */
export async function getPharmacyBooking(pharmacyId: string, bookingId: unknown): Promise<Row> {
  if (typeof bookingId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(bookingId)) throw notFound();
  const b = await BookingModel.findOne({ _id: bookingId, pharmacyId: { $eq: pharmacyId } }).lean() as Row | null;
  if (!b) throw notFound();
  return bookerView(b, pharmacyId);
}
