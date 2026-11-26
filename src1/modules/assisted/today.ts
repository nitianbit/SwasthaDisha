import { Container } from 'typedi';
import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import BookingModel from '@/modules/bookings/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { InventoryItemRepository } from '@/modules/pharmacyInventory/repository';
import { paymentMethodOf, PAYMENT_METHODS, type PaymentMethod } from '@/modules/pharmacyOrders/paymentMethod';
import { withPharmacyFacingCustomerNames } from '@/modules/assisted/names';
import { bookerViews } from '@/modules/assisted/bookerView';
import { assistedBookerFilter } from '@/modules/assisted/refunds';
import { bookerLabViews, listLabBookingsForPharmacy } from '@/modules/assisted/labBookings';
import { listPharmacyBookings } from '@/modules/assisted/services/pharmacyBookings';
import { isInstantFunding } from '@/modules/assisted/types';
import type { PharmacyActor } from '@/modules/assisted/bookers';
import { isRealDate, istDate } from '@/modules/partners/services/slots';

/**
 * r37 (§26.20): GET /api/v1/pharmacy-assisted/today?date&cursor&limit — the pharmacy's Today register: everything done at
 * its desk on one India day, oldest first, from the pharmacy orders it sold (counter and online), the consultations
 * (scheduled and instant) and lab tests it booked, and its own wallet top-ups; the day's money; and what is waiting.
 * Each source keeps its own reader for what a row shows: the order list's pharmacy-facing names, the booker views of
 * consultations and lab tests (their `patientName`, short ref and status). Ids and short words only.
 */
type Row = Record<string, any>;
export type TodayKind = 'order' | 'consultation' | 'lab_booking' | 'wallet_topup';
export interface TodayItem {
  kind: TodayKind; id: string; at: Date; shortRef: string | null; patientName: string | null; what: string; amountMinor: number;
  paid: boolean; method: PaymentMethod | null; status: string; link: { kind: string; id: string };
}

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
/** Rows read per source for one day (a busy counter makes a few hundred); the answer says when a source had more. */
export const TODAY_SOURCE_CAP = 2000;
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;
const PENDING_IDS = 20;
const ENDED = ['cancelled', 'abandoned', 'rejected', 'no_show'];
const UNPAID_SALE_STATUSES = ['placed', 'accepted', 'packed', 'ready_for_pickup'];
const paise = (rupees: unknown) => Math.round(Number(rupees ?? 0) * 100);

/** The instants of one India day: [00:00 IST, next 00:00 IST). */
function dayRange(date: string) {
  const from = new Date(`${date}T00:00:00+05:30`);
  return { $gte: from, $lt: new Date(from.getTime() + 86_400_000) };
}

/** Cursor `<at ms>_<id>`: the next page starts after it (the merged list is ordered by time, then id). */
const CURSOR = /^(\d{1,15})_([0-9a-fA-F]{24})$/;
const keyOf = (at: Date, id: string) => [new Date(at).getTime(), id] as const;
const after = (a: readonly [number, string], b: readonly [number, string]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

/** One source's rows of the day (raw), with how each counts in the day's money. */
interface Raw { kind: TodayKind; row: Row; at: Date; id: string; amountMinor: number; paid: boolean; method: PaymentMethod | null; status: string; collects: boolean }

async function rawOf(pharmacyId: string, created: Record<string, Date>): Promise<{ raws: Raw[]; truncated: TodayKind[] }> {
  const pid = new Types.ObjectId(pharmacyId);
  const [orders, bookings, labs, topups] = await Promise.all([
    PharmacyOrderModel.find({ pharmacyId: pid, createdAt: created }).sort({ createdAt: 1, _id: 1 }).limit(TODAY_SOURCE_CAP + 1)
      .populate('customerId', 'name phone').lean() as unknown as Promise<Row[]>,
    // The consultations this pharmacy booked: the owner filter of its booking list (`listPharmacyBookings`).
    BookingModel.find({ pharmacyId: { $eq: pharmacyId }, createdAt: created }).sort({ createdAt: 1, _id: 1 }).limit(TODAY_SOURCE_CAP + 1).lean() as unknown as Promise<Row[]>,
    // The lab tests it booked: the owner filter of its lab booking list (`listLabBookingsFor`).
    PartnerLabBookingModel.find({ ...assistedBookerFilter('pharmacy', pharmacyId), createdAt: created }).sort({ createdAt: 1, _id: 1 })
      .limit(TODAY_SOURCE_CAP + 1).lean() as unknown as Promise<Row[]>,
    // Its own card top-ups (completed credits of a wallet recharge).
    PharmacyWalletTransactionModel.find({ pharmacyId: pid, referenceType: 'wallet_recharge', status: 'completed', createdAt: created })
      .sort({ createdAt: 1, _id: 1 }).limit(TODAY_SOURCE_CAP + 1).lean() as unknown as Promise<Row[]>,
  ]);
  const truncated: TodayKind[] = [];
  const cap = (kind: TodayKind, rows: Row[]) => { if (rows.length > TODAY_SOURCE_CAP) truncated.push(kind); return rows.slice(0, TODAY_SOURCE_CAP); };
  const raws: Raw[] = [
    ...cap('order', orders).map((o): Raw => {
      const paid = o.paymentStatus === 'paid';
      return { kind: 'order', row: o, at: o.createdAt, id: String(o._id), status: o.status,
        amountMinor: Number.isSafeInteger(o.grandTotalPaise) ? Number(o.grandTotalPaise) : paise(o.grandTotal), paid,
        method: paid ? paymentMethodOf(o.paymentSource, o.paymentMode) : null, collects: true };
    }),
    ...cap('consultation', bookings).map((b): Raw => {
      const paid = b.paymentStatus === 'paid';
      const f = b.assisted?.funding;
      // An instant consultation booked by a partner is paid from the partner's wallet (r17); a card booking by card.
      const method: PaymentMethod = isInstantFunding(f) ? 'wallet' : f?.method === 'razorpay' ? 'card' : f?.method === 'wallet' ? 'wallet' : 'other';
      return { kind: 'consultation', row: b, at: b.createdAt, id: String(b._id), status: b.status, amountMinor: paise(b.price), paid,
        method: paid ? method : null, collects: true };
    }),
    ...cap('lab_booking', labs).map((l): Raw => {
      const paid = l.paymentStatus === 'paid';
      const method: PaymentMethod = l.assisted?.funding?.method === 'razorpay' ? 'card' : l.assisted?.funding?.method === 'wallet' ? 'wallet' : 'other';
      return { kind: 'lab_booking', row: l, at: l.createdAt, id: String(l._id), status: l.status, amountMinor: Number(l.pricing?.payableMinor ?? 0), paid,
        method: paid ? method : null, collects: true };
    }),
    // A top-up is the pharmacy paying into its own wallet, not money collected from a customer: listed, not counted.
    ...cap('wallet_topup', topups).map((t): Raw => ({ kind: 'wallet_topup', row: t, at: t.createdAt, id: String(t._id), status: 'completed',
      amountMinor: Number.isSafeInteger(t.amountPaise) ? Number(t.amountPaise) : paise(t.amount), paid: true, method: 'online', collects: false })),
  ];
  raws.sort((a, b) => (after(keyOf(a.at, a.id), keyOf(b.at, b.id)) ? 1 : -1));
  return { raws, truncated };
}

/** The day's money: collected (paid) by method, and what live rows still owe; top-ups are not collections. */
function totalsOf(raws: Raw[]) {
  const byMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as Record<PaymentMethod, number>;
  let collectedMinor = 0;
  let unpaidMinor = 0;
  for (const r of raws) {
    if (!r.collects) continue;
    if (r.paid) { collectedMinor += r.amountMinor; byMethod[r.method ?? 'other'] += r.amountMinor; }
    else if (!ENDED.includes(r.status)) unpaidMinor += r.amountMinor;
  }
  return { collectedMinor, byMethod, unpaidMinor, count: raws.length };
}

const firstOf = (names: string[]) => (names.length ? `${names[0]}${names.length > 1 ? ` +${names.length - 1} more` : ''}` : '');

/** The page's rows as items, each through its source's own view. */
async function itemsOf(pharmacyId: string, page: Raw[]): Promise<TodayItem[]> {
  const of = (k: TodayKind) => page.filter((r) => r.kind === k).map((r) => r.row);
  const [orders, consults, labs] = await Promise.all([
    withPharmacyFacingCustomerNames(of('order'), pharmacyId),
    bookerViews(of('consultation'), pharmacyId, { copies: 'queue', clinical: false }),
    bookerLabViews(of('lab_booking'), pharmacyId),
  ]);
  const byId = new Map<string, Row>([...orders, ...consults, ...labs].map((v) => [String(v._id), v]));
  return page.map((r) => {
    const v = byId.get(r.id) ?? r.row;
    const base = { kind: r.kind, id: r.id, at: r.at, amountMinor: r.amountMinor, paid: r.paid, method: r.method, status: r.status };
    switch (r.kind) {
      case 'order':
        return { ...base, shortRef: v.orderNumber ?? null, patientName: v.customerId?.name ?? null,
          what: firstOf((v.items ?? []).map((i: Row) => String(i.medicineName ?? 'Medicine'))) || (v.orderType === 'online' ? 'Online order' : 'Counter sale'),
          link: { kind: 'pharmacy_order', id: r.id } };
      case 'consultation':
        return { ...base, shortRef: v.assisted?.shortRef ?? null, patientName: v.patientName ?? null,
          what: [v.doctorName, v.bookingKind === 'instant' ? 'now' : v.bookingTime, v.consultationMode].filter(Boolean).join(' · ') || 'Consultation',
          link: { kind: 'booking', id: r.id } };
      case 'lab_booking':
        return { ...base, shortRef: v.assisted?.shortRef ?? null, patientName: v.patientName ?? null,
          what: firstOf((v.items ?? []).map((i: Row) => String(i.name ?? 'Test'))) || 'Lab tests', link: { kind: 'lab_booking', id: r.id } };
      default:
        return { ...base, shortRef: null, patientName: null, what: 'Wallet top-up', link: { kind: 'wallet_transaction', id: r.id } };
    }
  });
}

/** What is waiting (any day): counts and the first ids, each from the reader its own screen uses. */
async function pendingOf(actor: PharmacyActor) {
  const pharmacyId = actor.pharmacyId;
  const ids = (rows: Row[]) => rows.slice(0, PENDING_IDS).map((r) => String(r._id));
  const [rx, sales, consults, labPay, reports, low] = await Promise.all([
    Container.get(PharmacyOrderService).getPrescriptionReviewQueue(pharmacyId, 1, PENDING_IDS),
    new PharmacyOrderRepository().findWithPagination({ pharmacyId, viewerPharmacyId: pharmacyId, orderType: 'in_store', paymentStatus: 'pending',
      status: { $in: UNPAID_SALE_STATUSES } as never }, 1, PENDING_IDS),
    listPharmacyBookings(pharmacyId, { status: 'pending', limit: PENDING_IDS }),
    listLabBookingsForPharmacy(actor, { status: 'pending_payment', limit: PENDING_IDS }),
    listLabBookingsForPharmacy(actor, { status: 'report_ready', limit: PENDING_IDS }),
    new InventoryItemRepository().findWithPagination({ pharmacyId, lowStock: true, isActive: true }, 1, PENDING_IDS),
  ]);
  return {
    prescriptionsToReview: { count: rx.total, ids: ids(rx.data as Row[]) },
    unpaidCounterSales: { count: sales.total, ids: ids(sales.data as Row[]) },
    bookingsAwaiting: { count: consults.total + labPay.total, consultationIds: ids(consults.items), labBookingIds: ids(labPay.items) },
    labReportsReady: { count: reports.total, ids: ids(reports.items) },
    lowStock: { count: low.total, ids: ids(low.data as Row[]) },
  };
}

export async function pharmacyToday(actor: PharmacyActor, q: { date?: string; cursor?: string; limit?: number }, now: Date = new Date()) {
  const date = q.date ?? istDate(now);
  if (!isRealDate(date)) throw err(400, 'INVALID_DATE', 'date must be a real date (YYYY-MM-DD)');
  const m = q.cursor ? CURSOR.exec(q.cursor) : null;
  if (q.cursor && !m) throw err(400, 'INVALID_CURSOR', 'Invalid cursor');
  const limit = Math.min(Math.max(Number(q.limit) || LIMIT_DEFAULT, 1), LIMIT_MAX);
  const { raws, truncated } = await rawOf(actor.pharmacyId, dayRange(date));
  const from = m ? [Number(m[1]), m[2]!.toLowerCase()] as const : null;
  const rest = from ? raws.filter((r) => after(keyOf(r.at, r.id), from)) : raws;
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  const [items, pending] = await Promise.all([itemsOf(actor.pharmacyId, page), m ? Promise.resolve(null) : pendingOf(actor)]);
  return {
    date, items, totals: totalsOf(raws),
    // The waiting work is the same on every page: it comes with the first.
    ...(pending ? { pending } : {}),
    ...(truncated.length ? { truncated } : {}),
    nextCursor: rest.length > limit && last ? `${new Date(last.at).getTime()}_${last.id}` : null,
  };
}
