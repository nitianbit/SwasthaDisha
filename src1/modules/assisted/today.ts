import { Container } from 'typedi';
import { Types } from 'mongoose';
import BookingModel from '@/modules/bookings/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { InventoryItemRepository } from '@/modules/pharmacyInventory/repository';
import { fundingMethodOf, paymentMethodOf, PAYMENT_METHODS } from '@/modules/pharmacyOrders/paymentMethod';
import { bookerNames, pharmacyFacingHolderNames, withPharmacyFacingCustomerNames } from '@/modules/assisted/names';
import { bookerViews } from '@/modules/assisted/bookerView';
import { assistedBookerFilter } from '@/modules/assisted/refunds';
import { bookerLabViews } from '@/modules/assisted/labBookings';
import { pharmacyBookingsFilter } from '@/modules/assisted/services/pharmacyBookings';
import type { PharmacyActor } from '@/modules/assisted/bookers';
import { isoDay,
  capper, consultationRaw, consultationWhat, CONSULTATION_FIELDS, countIds, dayRows, firstOf, holderPhones, identityMoved, matches, searchTerms, itemBase, labTestsWhat, listOf, orderRaws, pageOf,
  paise, PENDING_IDS, settledQueues, TOPUP_WHAT, totalsOf, type Count, type Day, type PageQuery, type Raw, type Row, type WhatParts,
} from '@/modules/today/register';

/**
 * r37 (§26.20): GET /api/v1/pharmacy-assisted/today?date&cursor&limit — the pharmacy's Today register for one India day:
 * the pharmacy orders it sold (counter and online), the consultations (scheduled and instant) and lab tests it booked, its
 * own wallet top-ups; oldest first. r37b: also any earlier row paid that day (`paidToday`, `madeOn`), so the money
 * (`totals.collected*`) is what was RECEIVED that day, as the cash drawer counts it. Each row is shown through its own
 * screen's reader (the order list's pharmacy-facing names, the booker views of consultations and lab tests).
 */
export type TodayKind = 'order' | 'consultation' | 'lab_booking' | 'wallet_topup';
export type { WhatParts } from '@/modules/today/register';

const UNPAID_SALE_STATUSES = ['placed', 'accepted', 'packed', 'ready_for_pickup'];

// Projections of the whole-day reads (the page's rows are read again in full for their views).
const ORDER_FIELDS = { orderNumber: 1, orderType: 1, status: 1, 'items.medicineName': 1, grandTotal: 1, grandTotalPaise: 1, paymentStatus: 1,
  paymentSource: 1, paymentMode: 1, paidAt: 1, createdAt: 1, customerId: 1 };
const LAB_FIELDS = { status: 1, paymentStatus: 1, 'pricing.payableMinor': 1, 'assisted.funding': 1, 'assisted.shortRef': 1, 'lifecycle.paidAt': 1,
  'items.name': 1, createdAt: 1, userId: 1, 'patient.dependentId': 1, 'assisted.identity.disputed.state': 1 };
const TOPUP_FIELDS = { amount: 1, amountPaise: 1, createdAt: 1 };
type Finder = { find: (f: Row) => any };

async function rawOf(pharmacyId: string, day: Day): Promise<{ raws: Raw[]; truncated: string[] }> {
  const pid = new Types.ObjectId(pharmacyId);
  const before = { $lt: day.$gte };
  const orderOwner = { pharmacyId: pid };
  const bookingOwner = pharmacyBookingsFilter(pharmacyId);
  const labOwner = assistedBookerFilter('pharmacy', pharmacyId);
  // Made that day, and (r37b) made earlier but paid that day.
  const [orders, ordersPaid, bookings, bookingsPaid, labs, labsPaid, topups] = await Promise.all([
    dayRows(PharmacyOrderModel, { ...orderOwner, createdAt: day }, ORDER_FIELDS),
    dayRows(PharmacyOrderModel, { ...orderOwner, paidAt: day, createdAt: before }, ORDER_FIELDS),
    dayRows(BookingModel, { ...bookingOwner, createdAt: day }, CONSULTATION_FIELDS),
    dayRows(BookingModel, { ...bookingOwner, 'lifecycle.paid.at': isoDay(day), createdAt: before }, CONSULTATION_FIELDS),
    dayRows(PartnerLabBookingModel, { ...labOwner, createdAt: day }, LAB_FIELDS),
    dayRows(PartnerLabBookingModel, { ...labOwner, 'lifecycle.paidAt': day, createdAt: before }, LAB_FIELDS),
    // Its own card top-ups (completed credits of a wallet recharge).
    dayRows(PharmacyWalletTransactionModel, { pharmacyId: pid, referenceType: 'wallet_recharge', status: 'completed', createdAt: day }, TOPUP_FIELDS),
  ]);
  const truncated = new Set<string>();
  const cap = capper(truncated);
  const raws: Raw[] = [
    ...[...cap('order', orders), ...cap('order', ordersPaid)].map((o): Raw => {
      const paid = o.paymentStatus === 'paid';
      return { kind: 'order', row: o, at: o.createdAt, createdAt: o.createdAt, id: String(o._id), status: o.status, paymentStatus: o.paymentStatus,
        amountMinor: Number.isSafeInteger(o.grandTotalPaise) ? Number(o.grandTotalPaise) : paise(o.grandTotal), paid,
        paidAt: paid ? o.paidAt ?? o.createdAt : null, method: paid ? paymentMethodOf(o.paymentSource, o.paymentMode) : null, collects: true,
        atGateway: o.paymentMode === 'online_payment' };
    }),
    ...[...cap('consultation', bookings), ...cap('consultation', bookingsPaid)].map(consultationRaw),
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
  return { raws: orderRaws(raws, day), truncated: [...truncated] };
}

function whatOf(r: Raw): { what: string; whatParts: WhatParts } {
  const v = r.row;
  switch (r.kind) {
    case 'order': {
      const names = (v.items ?? []).map((i: Row) => String(i.medicineName ?? 'Medicine'));
      if (names.length) return { what: firstOf(names), whatParts: { code: 'order.items', values: listOf(names) } };
      return v.orderType === 'online' ? { what: 'Online order', whatParts: { code: 'order.online' } } : { what: 'Counter sale', whatParts: { code: 'order.counter' } };
    }
    case 'consultation': return consultationWhat(v);
    case 'lab_booking': return labTestsWhat(v);
    default: return TOPUP_WHAT;
  }
}
const LINK: Record<TodayKind, string> = { order: 'pharmacy_order', consultation: 'booking', lab_booking: 'lab_booking', wallet_topup: 'wallet_transaction' };

/** The page's rows as items: each read in full and shown through its source's own view (its patient name). */
async function itemsOf(pharmacyId: string, page: Raw[], day: Day, date: string) {
  const ids = (k: string) => page.filter((r) => r.kind === k).map((r) => new Types.ObjectId(r.id));
  const full = (Model: Finder, k: string, populate = false) => {
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
    const b = itemBase(r, day, date);
    return { kind: b.kind, id: b.id, at: b.at, shortRef, patientName, ...whatOf(r), amountMinor: b.amountMinor, paid: b.paid, method: b.method,
      status: b.status, madeOn: b.madeOn, paidToday: b.paidToday, link: { kind: LINK[r.kind as TodayKind], id: r.id } };
  });
}

/**
 * What is waiting (any day): counts and the first ids, read as counts and ids. One queue failing answers `null` for it,
 * never a failed home screen. r37c: `bookingsAwaiting` = bookings waiting for their PAYMENT (the pharmacy's card
 * consultations still pending, lab tests `pending_payment`); it replaces r37b's `cardPaymentsWaiting` (the same rows).
 */
async function pendingOf(actor: PharmacyActor) {
  const pharmacyId = actor.pharmacyId;
  const labOwner = assistedBookerFilter('pharmacy', pharmacyId);
  const q = await settledQueues({
    prescriptionsToReview: () => Container.get(PharmacyOrderService).getPrescriptionReviewQueue(pharmacyId, 1, PENDING_IDS)
      .then((x): Count => ({ count: x.total, ids: (x.data as Row[]).map((r) => String(r._id)) })),
    // r37b: counter sales this pharmacy sold (never ones it bought), unpaid and not ended.
    unpaidCounterSales: () => countIds(PharmacyOrderModel, { pharmacyId: new Types.ObjectId(pharmacyId), orderType: 'in_store', paymentStatus: 'pending',
      status: { $in: UNPAID_SALE_STATUSES } }),
    consults: () => countIds(BookingModel, { ...pharmacyBookingsFilter(pharmacyId), status: 'pending', 'assisted.funding.method': 'razorpay',
      'assisted.funding.state': 'pending' }),
    labPay: () => countIds(PartnerLabBookingModel, { ...labOwner, status: 'pending_payment' }),
    labReportsReady: () => countIds(PartnerLabBookingModel, { ...labOwner, status: 'report_ready' }),
    lowStock: () => new InventoryItemRepository().findWithPagination({ pharmacyId, lowStock: true, isActive: true }, 1, PENDING_IDS)
      .then((r): Count => ({ count: r.total, ids: (r.data as Row[]).map((x) => String(x._id)) })),
  });
  return {
    prescriptionsToReview: q.prescriptionsToReview, unpaidCounterSales: q.unpaidCounterSales,
    bookingsAwaiting: q.consults && q.labPay ? { count: q.consults.count + q.labPay.count, consultationCount: q.consults.count, labCount: q.labPay.count,
      consultationIds: q.consults.ids, labBookingIds: q.labPay.ids } : null,
    labReportsReady: q.labReportsReady, lowStock: q.lowStock,
  };
}

export async function pharmacyToday(actor: PharmacyActor, q: PageQuery, now: Date = new Date()) {
  const p = await pageOf(q, now, (day) => rawOf(actor.pharmacyId, day));
  const [items, pending] = await Promise.all([itemsOf(actor.pharmacyId, p.page, p.day, p.date), p.first ? pendingOf(actor) : Promise.resolve(null)]);
  return {
    date: p.date, items, totals: totalsOf(p.raws, p.day, PAYMENT_METHODS),
    // The waiting work is the same on every page: it comes with the first.
    ...(pending ? { pending } : {}),
    ...(p.truncated.length ? { truncated: p.truncated } : {}),
    nextCursor: p.nextCursor,
  };
}

/**
 * r37c: POST /api/v1/pharmacy-assisted/today/search { date, q, cursor?, limit?, order? } — the day's rows matching `q` (a
 * POST: no phone or name in a URL). A row matches on the patient's name as THIS pharmacy sees it (the same names rule as
 * the items; never the account's own name when the pharmacy is shown a masked one), its short ref or order number, the
 * text of its line (medicine, test, doctor names), or — with 4 or more digits — the phone of the account holder it was
 * made for (or the consultation's contact number). The same item shape; no totals or pending.
 */
export async function pharmacyTodaySearch(actor: PharmacyActor, q: PageQuery & { q: string }, now: Date = new Date()) {
  const terms = searchTerms(q.q);
  const pharmacyId = actor.pharmacyId;
  const p = await pageOf(q, now, (day) => rawOf(pharmacyId, day), async (raws) => {
    const rowsOf = (k: TodayKind) => raws.filter((r) => r.kind === k).map((r) => r.row);
    const orderHolders = rowsOf('order').map((o) => o.customerId).filter(Boolean);
    const [orderNames, consultNames, labNames, phoneOf] = await Promise.all([
      pharmacyFacingHolderNames(orderHolders, pharmacyId),
      bookerNames(rowsOf('consultation'), { kind: 'pharmacy', id: pharmacyId }),
      bookerNames(rowsOf('lab_booking').map((l) => ({ _id: l._id, userId: l.userId, dependentId: l.patient?.dependentId })), { kind: 'pharmacy', id: pharmacyId }),
      holderPhones([...orderHolders, ...rowsOf('consultation').map((b) => b.userId), ...rowsOf('lab_booking').map((l) => l.userId)], !!terms.phone),
    ]);
    return raws.filter((r) => {
      const v = r.row;
      const name = r.kind === 'order' ? orderNames.get(String(v.customerId ?? '').toLowerCase()) : r.kind === 'consultation'
        ? consultNames.patients.get(r.id) : r.kind === 'lab_booking' ? labNames.patients.get(r.id) : null;
      const holder = r.kind === 'order' ? v.customerId : v.userId;
      // r38b: the account holder's phone only while the row's identity was not moved to another account ("not mine").
      return matches(terms, [name, v.orderNumber, v.assisted?.shortRef, whatOf(r).what],
        [identityMoved(v) ? null : phoneOf.get(String(holder ?? '').toLowerCase()), r.kind === 'consultation' ? v.contactNo : null]);
    });
  });
  return { date: p.date, items: await itemsOf(pharmacyId, p.page, p.day, p.date), nextCursor: p.nextCursor };
}
