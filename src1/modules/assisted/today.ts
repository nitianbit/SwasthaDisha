import { Container } from 'typedi';
import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import BookingModel from '@/modules/bookings/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { InventoryItemRepository } from '@/modules/pharmacyInventory/repository';
import { fundingMethodOf, paymentMethodOf, PAYMENT_METHODS, type PaymentMethod } from '@/modules/pharmacyOrders/paymentMethod';
import { bookerNames, pharmacyFacingHolderNames, withPharmacyFacingCustomerNames } from '@/modules/assisted/names';
import UserModel from '@/modules/user/model';
import { bookerViews } from '@/modules/assisted/bookerView';
import { assistedBookerFilter } from '@/modules/assisted/refunds';
import { bookerLabViews } from '@/modules/assisted/labBookings';
import { pharmacyBookingsFilter } from '@/modules/assisted/services/pharmacyBookings';
import type { PharmacyActor } from '@/modules/assisted/bookers';
import { isRealDate, istDate } from '@/modules/partners/services/slots';

/**
 * r37 (§26.20): GET /api/v1/pharmacy-assisted/today?date&cursor&limit — the pharmacy's Today register for one India day:
 * the pharmacy orders it sold (counter and online), the consultations (scheduled and instant) and lab tests it booked, its
 * own wallet top-ups; oldest first. r37b: also any earlier row paid that day (`paidToday`, `madeOn`), so the money
 * (`totals.collected*`) is what was RECEIVED that day, as the cash drawer counts it. Each row is shown through its own
 * screen's reader (the order list's pharmacy-facing names, the booker views of consultations and lab tests).
 */
type Row = Record<string, any>;
type Day = { $gte: Date; $lt: Date };
export type TodayKind = 'order' | 'consultation' | 'lab_booking' | 'wallet_topup';

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
/** Rows read per source and query for one day (a busy counter makes a few hundred); the answer says when one had more. */
export const TODAY_SOURCE_CAP = 2000;
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;
const PENDING_IDS = 20;
const ENDED = ['cancelled', 'abandoned', 'rejected', 'no_show'];
/** What a patient may still owe the pharmacy (r37b); `paid` and `refunded` owe nothing. */
const OWED = ['pending', 'failed', 'partially_paid'];
const UNPAID_SALE_STATUSES = ['placed', 'accepted', 'packed', 'ready_for_pickup'];
const paise = (rupees: unknown) => Math.round(Number(rupees ?? 0) * 100);

/** The instants of one India day: [00:00 IST, next 00:00 IST). */
function dayRange(date: string): Day {
  const from = new Date(`${date}T00:00:00+05:30`);
  return { $gte: from, $lt: new Date(from.getTime() + 86_400_000) };
}
const inDay = (at: unknown, day: Day) => !!at && new Date(at as Date) >= day.$gte && new Date(at as Date) < day.$lt;

/** Cursor `<at ms>_<id>`: the next page starts after it (the merged list is ordered by time, then id). */
const CURSOR = /^(\d{1,15})_([0-9a-fA-F]{24})$/;
const keyOf = (at: Date, id: string) => [new Date(at).getTime(), id] as const;
const after = (a: readonly [number, string], b: readonly [number, string]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

/** One row of the day (projected), with how it counts in the day's money. */
interface Raw {
  kind: TodayKind; row: Row; at: Date; id: string; createdAt: Date; paidAt: Date | null; amountMinor: number; paid: boolean;
  method: PaymentMethod | null; status: string; paymentStatus: string; collects: boolean;
  /** r37b: the money waits for the pharmacy's own card payment or an online checkout (not owed by a patient at the desk). */
  atGateway: boolean;
}

// Projections of the whole-day reads (the page's rows are read again in full for their views).
const ORDER_FIELDS = { orderNumber: 1, orderType: 1, status: 1, 'items.medicineName': 1, grandTotal: 1, grandTotalPaise: 1, paymentStatus: 1,
  paymentSource: 1, paymentMode: 1, paidAt: 1, createdAt: 1, customerId: 1 };
const BOOKING_FIELDS = { status: 1, paymentStatus: 1, price: 1, 'assisted.funding': 1, 'assisted.shortRef': 1, 'lifecycle.paid.at': 1, doctorName: 1,
  bookingKind: 1, bookingTime: 1, consultationMode: 1, createdAt: 1, userId: 1, dependentId: 1, contactNo: 1 };
const LAB_FIELDS = { status: 1, paymentStatus: 1, 'pricing.payableMinor': 1, 'assisted.funding': 1, 'assisted.shortRef': 1, 'lifecycle.paidAt': 1,
  'items.name': 1, createdAt: 1, userId: 1, 'patient.dependentId': 1 };
const TOPUP_FIELDS = { amount: 1, amountPaise: 1, createdAt: 1 };

type Finder = { find: (f: Row) => any };
const dayRows = (Model: Finder, filter: Row, fields: Row) =>
  Model.find(filter).select(fields).sort({ createdAt: 1, _id: 1 }).limit(TODAY_SOURCE_CAP + 1).lean() as Promise<Row[]>;

async function rawOf(pharmacyId: string, day: Day): Promise<{ raws: Raw[]; truncated: TodayKind[] }> {
  const pid = new Types.ObjectId(pharmacyId);
  const before = { $lt: day.$gte };
  const orderOwner = { pharmacyId: pid };
  const bookingOwner = pharmacyBookingsFilter(pharmacyId);
  const labOwner = assistedBookerFilter('pharmacy', pharmacyId);
  // Made that day, and (r37b) made earlier but paid that day.
  const [orders, ordersPaid, bookings, bookingsPaid, labs, labsPaid, topups] = await Promise.all([
    dayRows(PharmacyOrderModel, { ...orderOwner, createdAt: day }, ORDER_FIELDS),
    dayRows(PharmacyOrderModel, { ...orderOwner, paidAt: day, createdAt: before }, ORDER_FIELDS),
    dayRows(BookingModel, { ...bookingOwner, createdAt: day }, BOOKING_FIELDS),
    dayRows(BookingModel, { ...bookingOwner, 'lifecycle.paid.at': day, createdAt: before }, BOOKING_FIELDS),
    dayRows(PartnerLabBookingModel, { ...labOwner, createdAt: day }, LAB_FIELDS),
    dayRows(PartnerLabBookingModel, { ...labOwner, 'lifecycle.paidAt': day, createdAt: before }, LAB_FIELDS),
    // Its own card top-ups (completed credits of a wallet recharge).
    dayRows(PharmacyWalletTransactionModel, { pharmacyId: pid, referenceType: 'wallet_recharge', status: 'completed', createdAt: day }, TOPUP_FIELDS),
  ]);
  const truncated = new Set<TodayKind>();
  const cap = (kind: TodayKind, rows: Row[]) => { if (rows.length > TODAY_SOURCE_CAP) truncated.add(kind); return rows.slice(0, TODAY_SOURCE_CAP); };
  const raws: Raw[] = [
    ...[...cap('order', orders), ...cap('order', ordersPaid)].map((o): Raw => {
      const paid = o.paymentStatus === 'paid';
      return { kind: 'order', row: o, at: o.createdAt, createdAt: o.createdAt, id: String(o._id), status: o.status, paymentStatus: o.paymentStatus,
        amountMinor: Number.isSafeInteger(o.grandTotalPaise) ? Number(o.grandTotalPaise) : paise(o.grandTotal), paid,
        paidAt: paid ? o.paidAt ?? o.createdAt : null, method: paid ? paymentMethodOf(o.paymentSource, o.paymentMode) : null, collects: true,
        atGateway: o.paymentMode === 'online_payment' };
    }),
    ...[...cap('consultation', bookings), ...cap('consultation', bookingsPaid)].map((b): Raw => {
      const paid = b.paymentStatus === 'paid';
      const f = b.assisted?.funding;
      return { kind: 'consultation', row: b, at: b.createdAt, createdAt: b.createdAt, id: String(b._id), status: b.status, paymentStatus: b.paymentStatus,
        amountMinor: paise(b.price), paid, paidAt: paid ? b.lifecycle?.paid?.at ?? b.createdAt : null, method: paid ? fundingMethodOf(f) : null,
        collects: true, atGateway: f?.method === 'razorpay' && f?.state === 'pending' };
    }),
    ...[...cap('lab_booking', labs), ...cap('lab_booking', labsPaid)].map((l): Raw => {
      const paid = l.paymentStatus === 'paid';
      const f = l.assisted?.funding;
      return { kind: 'lab_booking', row: l, at: l.createdAt, createdAt: l.createdAt, id: String(l._id), status: l.status, paymentStatus: l.paymentStatus,
        amountMinor: Number(l.pricing?.payableMinor ?? 0), paid, paidAt: paid ? l.lifecycle?.paidAt ?? l.createdAt : null,
        method: paid ? fundingMethodOf(f) : null, collects: true, atGateway: f?.method === 'razorpay' && f?.state === 'pending' };
    }),
    // A top-up is the pharmacy paying into its own wallet, not money collected from a customer: listed, not counted.
    ...cap('wallet_topup', topups).map((t): Raw => ({ kind: 'wallet_topup', row: t, at: t.createdAt, createdAt: t.createdAt, id: String(t._id),
      status: 'completed', paymentStatus: 'paid', amountMinor: Number.isSafeInteger(t.amountPaise) ? Number(t.amountPaise) : paise(t.amount), paid: true,
      paidAt: t.createdAt, method: 'online', collects: false, atGateway: false })),
  ];
  // An earlier row paid that day appears at its payment time.
  for (const r of raws) if (r.createdAt < day.$gte && r.paidAt) r.at = r.paidAt;
  raws.sort((a, b) => (after(keyOf(a.at, a.id), keyOf(b.at, b.id)) ? 1 : -1));
  return { raws, truncated: [...truncated] };
}

/**
 * The day's money. Collected = paid rows whose payment fell on that day (by method), whatever day they were made; a paid
 * row later cancelled stays collected until it is refunded. Unpaid = live rows a patient may still owe the pharmacy
 * (`pending`, `failed`, `partially_paid`); the pharmacy's own card payments and online checkouts still at the gateway are
 * not owed at the desk (its card bookings are `pending.bookingsAwaiting`). Top-ups count in neither.
 */
function totalsOf(raws: Raw[], day: Day) {
  const byMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as Record<PaymentMethod, number>;
  let collectedMinor = 0;
  let unpaidMinor = 0;
  for (const r of raws) {
    if (!r.collects) continue;
    if (r.paid && inDay(r.paidAt, day)) { collectedMinor += r.amountMinor; byMethod[r.method ?? 'other'] += r.amountMinor; }
    else if (OWED.includes(r.paymentStatus) && !ENDED.includes(r.status) && !r.atGateway) unpaidMinor += r.amountMinor;
  }
  return { collectedMinor, byMethod, unpaidMinor, count: raws.length };
}

const firstOf = (names: string[]) => (names.length ? `${names[0]}${names.length > 1 ? ` +${names.length - 1} more` : ''}` : '');
/**
 * r37c: a row's short line as a code with values (`whatParts`), so the web words it in each language; medicine, test and
 * doctor names stay data. `what` (the English line) is kept for compatibility.
 */
export type WhatParts = { code: string; values?: Record<string, string | number | null> };
function whatOf(r: Raw): { what: string; whatParts: WhatParts } {
  const v = r.row;
  const list = (names: string[]) => ({ first: names[0] ?? null, more: Math.max(0, names.length - 1) });
  switch (r.kind) {
    case 'order': {
      const names = (v.items ?? []).map((i: Row) => String(i.medicineName ?? 'Medicine'));
      if (names.length) return { what: firstOf(names), whatParts: { code: 'order.items', values: list(names) } };
      return v.orderType === 'online' ? { what: 'Online order', whatParts: { code: 'order.online' } } : { what: 'Counter sale', whatParts: { code: 'order.counter' } };
    }
    case 'consultation': {
      const instant = v.bookingKind === 'instant';
      return { what: [v.doctorName, instant ? 'now' : v.bookingTime, v.consultationMode].filter(Boolean).join(' · ') || 'Consultation',
        whatParts: instant ? { code: 'consult.instant', values: { doctor: v.doctorName ?? null, mode: v.consultationMode ?? null } }
          : { code: 'consult.scheduled', values: { doctor: v.doctorName ?? null, time: v.bookingTime ?? null, mode: v.consultationMode ?? null } } };
    }
    case 'lab_booking': {
      const names = (v.items ?? []).map((i: Row) => String(i.name ?? 'Test'));
      return { what: firstOf(names) || 'Lab tests', whatParts: { code: 'lab.tests', values: list(names) } };
    }
    default: return { what: 'Wallet top-up', whatParts: { code: 'wallet.topup' } };
  }
}
const LINK: Record<TodayKind, string> = { order: 'pharmacy_order', consultation: 'booking', lab_booking: 'lab_booking', wallet_topup: 'wallet_transaction' };

/** The page's rows as items: each read in full and shown through its source's own view (its patient name). */
async function itemsOf(pharmacyId: string, page: Raw[], day: Day, date: string) {
  const ids = (k: TodayKind) => page.filter((r) => r.kind === k).map((r) => new Types.ObjectId(r.id));
  const full = (Model: Finder, k: TodayKind, populate = false) => {
    const list = ids(k);
    if (!list.length) return Promise.resolve([] as Row[]);
    const q = Model.find({ _id: { $in: list } });
    return (populate ? q.populate('customerId', 'name phone') : q).lean() as Promise<Row[]>;
  };
  const [orderRows, bookingRows, labRows] = await Promise.all([full(PharmacyOrderModel, 'order', true), full(BookingModel, 'consultation'),
    full(PartnerLabBookingModel, 'lab_booking')]);
  const [orders, consults, labs] = await Promise.all([
    withPharmacyFacingCustomerNames(orderRows, pharmacyId),
    bookerViews(bookingRows, pharmacyId, { copies: 'queue', clinical: false }),
    bookerLabViews(labRows, pharmacyId),
  ]);
  const byId = new Map<string, Row>([...orders, ...consults, ...labs].map((v) => [String(v._id), v]));
  return page.map((r) => {
    // r37b: a row without its view (it changed between the reads) shows no patient name; never the raw record.
    const v = byId.get(r.id);
    const shortRef = r.kind === 'order' ? r.row.orderNumber ?? null : r.kind === 'wallet_topup' ? null : r.row.assisted?.shortRef ?? null;
    const patientName = !v || r.kind === 'wallet_topup' ? null : r.kind === 'order' ? v.customerId?.name ?? null : v.patientName ?? null;
    const madeOn = istDate(new Date(r.createdAt));
    // r37c: `paidToday` marks only an earlier row paid on this day (one made this day needs no mark).
    return { kind: r.kind, id: r.id, at: r.at, shortRef, patientName, ...whatOf(r), amountMinor: r.amountMinor, paid: r.paid, method: r.method,
      status: r.status, madeOn, paidToday: madeOn !== date && r.paid && inDay(r.paidAt, day), link: { kind: LINK[r.kind], id: r.id } };
  });
}

/**
 * What is waiting (any day): counts and the first ids, read as counts and ids. One queue failing answers `null` for it,
 * never a failed home screen. r37c: `bookingsAwaiting` = bookings waiting for their PAYMENT (the pharmacy's card
 * consultations still pending, lab tests `pending_payment`); it replaces r37b's `cardPaymentsWaiting` (the same rows).
 */
async function pendingOf(actor: PharmacyActor) {
  const pharmacyId = actor.pharmacyId;
  const countIds = async (Model: Finder & { countDocuments: (f: Row) => PromiseLike<number> }, filter: Row) => {
    const [count, rows] = await Promise.all([Model.countDocuments(filter),
      Model.find(filter).sort({ createdAt: -1, _id: -1 }).limit(PENDING_IDS).select({ _id: 1 }).lean() as Promise<Row[]>]);
    return { count, ids: rows.map((r) => String(r._id)) };
  };
  const labOwner = assistedBookerFilter('pharmacy', pharmacyId);
  const settled = await Promise.allSettled([
    Container.get(PharmacyOrderService).getPrescriptionReviewQueue(pharmacyId, 1, PENDING_IDS)
      .then((q) => ({ count: q.total, ids: (q.data as Row[]).map((r) => String(r._id)) })),
    // r37b: counter sales this pharmacy sold (never ones it bought), unpaid and not ended.
    countIds(PharmacyOrderModel, { pharmacyId: new Types.ObjectId(pharmacyId), orderType: 'in_store', paymentStatus: 'pending', status: { $in: UNPAID_SALE_STATUSES } }),
    countIds(BookingModel, { ...pharmacyBookingsFilter(pharmacyId), status: 'pending', 'assisted.funding.method': 'razorpay', 'assisted.funding.state': 'pending' }),
    countIds(PartnerLabBookingModel, { ...labOwner, status: 'pending_payment' }),
    countIds(PartnerLabBookingModel, { ...labOwner, status: 'report_ready' }),
    new InventoryItemRepository().findWithPagination({ pharmacyId, lowStock: true, isActive: true }, 1, PENDING_IDS)
      .then((r) => ({ count: r.total, ids: (r.data as Row[]).map((x) => String(x._id)) })),
  ]);
  type Count = { count: number; ids: string[] };
  const ok = (i: number): Count | null => (settled[i]!.status === 'fulfilled' ? (settled[i] as PromiseFulfilledResult<Count>).value : null);
  const consults = ok(2);
  const labPay = ok(3);
  return {
    prescriptionsToReview: ok(0), unpaidCounterSales: ok(1),
    bookingsAwaiting: consults && labPay ? { count: consults.count + labPay.count, consultationCount: consults.count, labCount: labPay.count,
      consultationIds: consults.ids, labBookingIds: labPay.ids } : null,
    labReportsReady: ok(4), lowStock: ok(5),
  };
}

type PageQuery = { date?: string; cursor?: string; limit?: number; order?: 'asc' | 'desc' };
/** The date, the day's rows and one page of them in the asked order (r37c: `desc` = newest first; the cursor continues it). */
async function pageOf(actor: PharmacyActor, q: PageQuery, now: Date, pick?: (raws: Raw[]) => Promise<Raw[]>) {
  const date = q.date ?? istDate(now);
  if (!isRealDate(date)) throw err(400, 'INVALID_DATE', 'date must be a real date (YYYY-MM-DD)');
  const m = q.cursor ? CURSOR.exec(q.cursor) : null;
  if (q.cursor && !m) throw err(400, 'INVALID_CURSOR', 'Invalid cursor');
  const limit = Math.min(Math.max(Number(q.limit) || LIMIT_DEFAULT, 1), LIMIT_MAX);
  const desc = q.order === 'desc';
  const day = dayRange(date);
  const { raws, truncated } = await rawOf(actor.pharmacyId, day);
  const chosen = pick ? await pick(raws) : raws;
  const ordered = desc ? [...chosen].reverse() : chosen;
  const from = m ? [Number(m[1]), m[2]!.toLowerCase()] as const : null;
  const rest = from ? ordered.filter((r) => (desc ? after(from, keyOf(r.at, r.id)) : after(keyOf(r.at, r.id), from))) : ordered;
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return { date, day, raws, truncated, page, first: !m,
    nextCursor: rest.length > limit && last ? `${new Date(last.at).getTime()}_${last.id}` : null };
}

export async function pharmacyToday(actor: PharmacyActor, q: PageQuery, now: Date = new Date()) {
  const p = await pageOf(actor, q, now);
  const [items, pending] = await Promise.all([itemsOf(actor.pharmacyId, p.page, p.day, p.date), p.first ? pendingOf(actor) : Promise.resolve(null)]);
  return {
    date: p.date, items, totals: totalsOf(p.raws, p.day),
    // The waiting work is the same on every page: it comes with the first.
    ...(pending ? { pending } : {}),
    ...(p.truncated.length ? { truncated: p.truncated } : {}),
    nextCursor: p.nextCursor,
  };
}

const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
/**
 * r37c: POST /api/v1/pharmacy-assisted/today/search { date, q, cursor?, limit?, order? } — the day's rows matching `q` (a
 * POST: no phone or name in a URL). A row matches on the patient's name as THIS pharmacy sees it (the same names rule as
 * the items; never the account's own name when the pharmacy is shown a masked one), its short ref or order number, the
 * text of its line (medicine, test, doctor names), or — with 4 or more digits — the phone of the account holder it was
 * made for (or the consultation's contact number). The same item shape; no totals or pending.
 */
export async function pharmacyTodaySearch(actor: PharmacyActor, q: PageQuery & { q: string }, now: Date = new Date()) {
  const needle = String(q.q ?? '').trim().toLowerCase();
  if (needle.length < 2 || needle.length > 100) throw err(400, 'VALIDATION_ERROR', 'q must be 2 to 100 characters');
  const phone = digits(needle);
  const pharmacyId = actor.pharmacyId;
  const p = await pageOf(actor, q, now, async (raws) => {
    const rowsOf = (k: TodayKind) => raws.filter((r) => r.kind === k).map((r) => r.row);
    const orderHolders = rowsOf('order').map((o) => o.customerId).filter(Boolean);
    const userIds = [...orderHolders, ...rowsOf('consultation').map((b) => b.userId), ...rowsOf('lab_booking').map((l) => l.userId)]
      .map(String).filter((x) => /^[0-9a-fA-F]{24}$/.test(x));
    const [orderNames, consultNames, labNames, users] = await Promise.all([
      pharmacyFacingHolderNames(orderHolders, pharmacyId),
      bookerNames(rowsOf('consultation'), { kind: 'pharmacy', id: pharmacyId }),
      bookerNames(rowsOf('lab_booking').map((l) => ({ _id: l._id, userId: l.userId, dependentId: l.patient?.dependentId })), { kind: 'pharmacy', id: pharmacyId }),
      phone.length >= 4 && userIds.length ? UserModel.find({ _id: { $in: [...new Set(userIds)] } }).select({ phone: 1 }).lean() as unknown as Promise<Row[]> : Promise.resolve([] as Row[]),
    ]);
    const phoneOf = new Map(users.map((u) => [String(u._id).toLowerCase(), digits(u.phone)]));
    return raws.filter((r) => {
      const v = r.row;
      const name = r.kind === 'order' ? orderNames.get(String(v.customerId ?? '').toLowerCase()) : r.kind === 'consultation'
        ? consultNames.patients.get(r.id) : r.kind === 'lab_booking' ? labNames.patients.get(r.id) : null;
      const text = [name, v.orderNumber, v.assisted?.shortRef, whatOf(r).what].filter(Boolean).join(' ').toLowerCase();
      if (text.includes(needle)) return true;
      if (phone.length < 4) return false;
      const holder = r.kind === 'order' ? v.customerId : v.userId;
      return [phoneOf.get(String(holder ?? '').toLowerCase()), r.kind === 'consultation' ? digits(v.contactNo) : ''].some((x) => !!x && x.includes(phone));
    });
  });
  return { date: p.date, items: await itemsOf(pharmacyId, p.page, p.day, p.date), nextCursor: p.nextCursor };
}
