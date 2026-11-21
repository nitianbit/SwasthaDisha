import { Response } from 'express';
import { AuthRequest } from '@/modules/middleware/auth';
import { getPharmacyBooking, listPharmacyBookings } from '@/modules/assisted/services/pharmacyBookings';

const pharmacyOf = (req: AuthRequest) => String(req.user?.pharmacyId || req.user?._id || '');

/** GET /api/v1/pharmacy-bookings — data stays an array, plus pagination {total, nextCursor} (as the Q cursor lists). */
export const listBookings = async (req: AuthRequest, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const r = await listPharmacyBookings(pharmacyOf(req), {
    status: q.status as string | undefined, from: q.from as string | undefined, to: q.to as string | undefined,
    cursor: q.cursor as string | undefined, limit: q.limit === undefined ? undefined : Number(q.limit),
  });
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).json({ success: true, data: r.items, pagination: { total: r.total, nextCursor: r.nextCursor } });
};

/** GET /api/v1/pharmacy-bookings/:id */
export const getBooking = async (req: AuthRequest, res: Response) => {
  const data = await getPharmacyBooking(pharmacyOf(req), req.params.id);
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).json({ success: true, data });
};
