import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import BookingModel from '@/modules/bookings/model';
import PartnerOrgModel from '@/modules/partners/model';
import { PartnerLabBookingModel, type IPartnerLabBooking } from '@/modules/partners/model/labBooking';
import { InvoiceEventModel, InvoiceModel } from '@/modules/partners/model/invoice';
import { PartnerWalletEntryModel } from '@/modules/partnerWallets/model';
import { hasGlobalScope, type PartnerActor } from '@/modules/partners/services';
import { invoicesScope, paymentSplitsOf, withDue } from '@/modules/partners/services/invoice';
import { labBookingsScope, partnerView } from '@/modules/partners/services/labBookings';
import type { PartnerPermission } from '@/modules/partners/types';
import { billModeMethodOf, LAB_PAYMENT_METHODS } from '@/modules/pharmacyOrders/paymentMethod';
import { bookerBookingsFilter, type LabBooker } from '@/modules/assisted/bookers';
import { bookerViews } from '@/modules/assisted/bookerView';
import { bookerNames } from '@/modules/assisted/names';
import { isDeskRow } from '@/modules/assisted/deskViews';
import { labSourceOf } from '@/modules/assisted/labViews';
import {
  capper, consultationRaw, consultationWhat, CONSULTATION_FIELDS, countIds, dayRows, firstOf, holderPhones, inDay, itemBase, labTestsWhat, listOf,
  matches, orderRaws, pageOf, searchTerms, settledQueues, TOPUP_WHAT, totalsOf, type Day, type PageQuery, type Raw, type Row,
  type WhatParts,
} from '@/modules/today/register';

/**
 * r38 (§26.22): GET /api/v1/partner-workspace/today?date&cursor&limit&order — a LAB's front-desk Today register for one
 * India day, the pharmacy's (r37) pattern on the shared rules (`today/register.ts`):
 * - the lab's bookings (desk walk-ins, home collections, patient app bookings, pharmacy and doctor bookings), at the
 *   branches in the member's scope (`labBookingsScope`, the lab list's own filter);
 * - its in-house bills and the payments recorded on them (by method: cash, upi, card, bank), in scope (`invoicesScope`);
 * - the consultations it booked (2e; `bookerBookingsFilter`, branch-scoped as the lab booker list);
 * - its wallet top-ups (partner-wide members only).
 * Each source is shown only to a member holding a permission that reads it (owners and admins hold all).
 * POST …/today/search searches the same day. Ids, names the lab already sees, amounts and short words only.
 */
export type LabTodayKind = 'lab_booking' | 'bill' | 'consultation' | 'wallet_topup';

const LAB_READERS: PartnerPermission[] = ['bookings.view', 'bookings.manage', 'reports.upload', 'reports.release'];
const INVOICE_READERS: PartnerPermission[] = ['invoices.create', 'invoices.cancel', 'payments.record', 'finance.view'];
/** The permissions that admit the lab's Today (any one); each source then needs its own. */
export const LAB_TODAY_READERS: PartnerPermission[] = [...LAB_READERS, ...INVOICE_READERS, 'assisted.book', 'wallet.view'];

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const can = (a: PartnerActor, perms: PartnerPermission[]) => a.role === 'owner' || perms.some((p) => a.permissions.includes(p));
/** Which sources this member reads. */
function sourcesOf(a: PartnerActor) {
  return { bookings: can(a, LAB_READERS), bills: can(a, INVOICE_READERS), consultations: can(a, ['assisted.book']),
    // The wallet is the whole lab's: a branch-limited member does not see its top-ups.
    topups: can(a, ['wallet.view']) && hasGlobalScope(a) };
}

/** The lab register is a lab's (another partner kind: 403 LAB_PARTNER_REQUIRED, as the lab booker routes). */
export async function assertLab(a: PartnerActor): Promise<void> {
  if (!(await PartnerOrgModel.exists({ _id: a.partnerId, kind: 'lab' }))) throw err(403, 'LAB_PARTNER_REQUIRED', 'Today is for labs here');
}

const labBooker = (a: PartnerActor): LabBooker => ({ kind: 'lab', partnerId: a.partnerId, memberId: a.memberId, branchId: '', actor: a });

const LAB_FIELDS = { status: 1, paymentStatus: 1, 'pricing.payableMinor': 1, 'assisted.shortRef': 1, 'lifecycle.paidAt': 1, 'items.name': 1, createdAt: 1,
  userId: 1, 'patient.name': 1, source: 1, visitMode: 1, 'settlement.settlementSystem': 1, 'address.phone': 1, branchId: 1 };
const BILL_FIELDS = { serial: 1, issuedAt: 1, 'customer.name': 1, 'customer.phone': 1, 'items.description': 1, 'totals.totalMinor': 1, lifecycleState: 1,
  paidMinor: 1, labBookingId: 1, branchId: 1 };
const TOPUP_FIELDS = { amountMinor: 1, at: 1, createdAt: 1 };

async function rawOf(a: PartnerActor, day: Day): Promise<{ raws: Raw[]; truncated: string[] }> {
  const src = sourcesOf(a);
  const before = { $lt: day.$gte };
  const none = Promise.resolve([] as Row[]);
  const labOwner = src.bookings ? labBookingsScope(a) : null;
  const billOwner = src.bills ? invoicesScope(a) : null;
  const consultOwner = src.consultations ? bookerBookingsFilter(labBooker(a)) : null;
  const [labs, labsPaid, bills, billsTouched, consults, consultsPaid, topups] = await Promise.all([
    labOwner ? dayRows(PartnerLabBookingModel, { ...labOwner, createdAt: day }, LAB_FIELDS) : none,
    labOwner ? dayRows(PartnerLabBookingModel, { ...labOwner, 'lifecycle.paidAt': day, createdAt: before }, LAB_FIELDS) : none,
    billOwner ? dayRows(InvoiceModel, { ...billOwner, issuedAt: day }, BILL_FIELDS) : none,
    // Earlier bills changed on or after the day began: the ones that may have a payment that day (checked on their events).
    billOwner ? dayRows(InvoiceModel, { ...billOwner, issuedAt: before, updatedAt: { $gte: day.$gte } }, BILL_FIELDS) : none,
    consultOwner ? dayRows(BookingModel, { ...consultOwner, createdAt: day }, CONSULTATION_FIELDS) : none,
    consultOwner ? dayRows(BookingModel, { ...consultOwner, 'lifecycle.paid.at': day, createdAt: before }, CONSULTATION_FIELDS) : none,
    src.topups ? dayRows(PartnerWalletEntryModel, { ownerKind: 'lab', ownerId: a.partnerId.toLowerCase(), kind: 'credit', referenceType: 'wallet_recharge',
      at: day }, TOPUP_FIELDS) : none,
  ]);
  const truncated = new Set<string>();
  const cap = capper(truncated);
  const allBills = [...cap('bill', bills), ...cap('bill', billsTouched)];
  const payments = allBills.length ? await InvoiceEventModel.find({ invoiceId: { $in: allBills.map((b) => String(b._id)) }, kind: 'payment', at: day })
    .select({ invoiceId: 1, splits: 1, mode: 1, amountMinor: 1, reference: 1, at: 1 }).lean() as unknown as Row[] : [];
  const paidToday = new Map<string, Row[]>();
  for (const e of payments) paidToday.set(String(e.invoiceId), [...(paidToday.get(String(e.invoiceId)) ?? []), e]);
  const raws: Raw[] = [
    ...[...cap('lab_booking', labs), ...cap('lab_booking', labsPaid)].map((l): Raw => {
      const paid = l.paymentStatus === 'paid';
      // A desk booking is paid at the lab through its bill (the bill's payments are the money); every other booking is
      // paid through Jansetu (the patient's app payment, or the pharmacy's or doctor's), settled to the lab later.
      const desk = isDeskRow(l);
      return { kind: 'lab_booking', row: l, at: l.createdAt, createdAt: l.createdAt, id: String(l._id), status: l.status, paymentStatus: l.paymentStatus,
        amountMinor: Number(l.pricing?.payableMinor ?? 0), paid: !desk && paid, paidAt: !desk && paid ? l.lifecycle?.paidAt ?? l.createdAt : null,
        method: !desk && paid ? 'online' : null, collects: !desk, atGateway: !desk && l.status === 'pending_payment' };
    }),
    ...allBills.flatMap((b): Raw[] => {
      const today = paidToday.get(String(b._id)) ?? [];
      const made = inDay(b.issuedAt, day);
      if (!made && !today.length) return [];
      const received = today.flatMap((e) => paymentSplitsOf(e as never, Number(b.totals?.totalMinor ?? 0))
        .map((x) => ({ method: billModeMethodOf(x.mode), amountMinor: Number(x.amountMinor ?? 0) })));
      const methods = [...new Set(received.map((x) => x.method))];
      const lastPaid = today.length ? new Date(Math.max(...today.map((e) => new Date(e.at).getTime()))) : null;
      const due = Number((withDue(b as never) as Row).dueMinor ?? 0);
      return [{ kind: 'bill', row: b, at: b.issuedAt, createdAt: b.issuedAt, id: String(b._id), status: b.lifecycleState, paymentStatus: b.lifecycleState,
        amountMinor: Number(b.totals?.totalMinor ?? 0), paid: b.lifecycleState === 'paid', paidAt: lastPaid,
        method: methods.length === 1 ? methods[0]! : methods.length ? 'other' : null, collects: true, atGateway: false, received, dueMinor: due }];
    }),
    ...[...cap('consultation', consults), ...cap('consultation', consultsPaid)].map(consultationRaw),
    // A top-up is the lab paying into its own wallet, not money collected from a patient: listed, not counted.
    ...cap('wallet_topup', topups).map((t): Raw => ({ kind: 'wallet_topup', row: t, at: t.at, createdAt: t.at, id: String(t._id), status: 'completed',
      paymentStatus: 'paid', amountMinor: Number(t.amountMinor ?? 0), paid: true, paidAt: t.at, method: 'online', collects: false, atGateway: false })),
  ];
  return { raws: orderRaws(raws, day), truncated: [...truncated] };
}

function whatOf(r: Raw): { what: string; whatParts: WhatParts } {
  const v = r.row;
  switch (r.kind) {
    // r38: a lab booking's line adds where it came from (`source`: self | pharmacy_assisted | doctor_assisted | lab_desk)
    // and the visit (`visit`: lab | home).
    case 'lab_booking': return labTestsWhat(v, { source: labSourceOf(v), visit: v.visitMode ?? null });
    case 'bill': {
      const names = (v.items ?? []).map((i: Row) => String(i.description ?? 'Item'));
      return { what: firstOf(names) || 'Bill', whatParts: { code: 'bill.items', values: listOf(names) } };
    }
    case 'consultation': return consultationWhat(v);
    default: return TOPUP_WHAT;
  }
}
const LINK: Record<LabTodayKind, string> = { lab_booking: 'lab_booking', bill: 'invoice', consultation: 'booking', wallet_topup: 'wallet_entry' };

/** The page's rows as items: lab bookings through the lab's own view (its patient name), consultations through the booker view. */
async function itemsOf(a: PartnerActor, page: Raw[], day: Day, date: string) {
  const ids = (k: LabTodayKind) => page.filter((r) => r.kind === k).map((r) => new Types.ObjectId(r.id));
  const [labRows, bookingRows] = await Promise.all([
    ids('lab_booking').length ? PartnerLabBookingModel.find({ _id: { $in: ids('lab_booking') } }).lean() as unknown as Promise<IPartnerLabBooking[]> : [],
    ids('consultation').length ? BookingModel.find({ _id: { $in: ids('consultation') } }).lean() as unknown as Promise<Row[]> : [],
  ]);
  const consults = await bookerViews(bookingRows, { kind: 'lab', id: a.partnerId }, { copies: 'queue', clinical: false });
  const byId = new Map<string, Row>([...labRows.map((b) => partnerView(b) as Row), ...consults].map((v) => [String(v._id), v]));
  return page.map((r) => {
    const v = byId.get(r.id);
    const shortRef = r.kind === 'bill' ? r.row.serial ?? null : r.kind === 'wallet_topup' ? null : r.row.assisted?.shortRef ?? null;
    // A bill names the customer the lab typed on it; a row without its view shows no name (never the raw record).
    const patientName = r.kind === 'bill' ? r.row.customer?.name ?? null : !v || r.kind === 'wallet_topup' ? null
      : r.kind === 'lab_booking' ? v.patient?.name ?? null : v.patientName ?? null;
    const b = itemBase(r, day, date);
    // A bill paid in part on this day (made earlier) is an earlier row paid that day too.
    const paidToday = r.kind === 'bill' ? b.madeOn !== date && !!r.received?.length : b.paidToday;
    return { kind: b.kind, id: b.id, at: b.at, shortRef, patientName, ...whatOf(r), amountMinor: b.amountMinor, paid: b.paid, method: b.method,
      status: b.status, madeOn: b.madeOn, paidToday, link: { kind: LINK[r.kind as LabTodayKind], id: r.id } };
  });
}

/**
 * What is waiting (any day unless said), each queue a count and its first ids; one that fails answers `null`. A queue the
 * member may not read is absent.
 */
async function pendingOf(a: PartnerActor, date: string) {
  const src = sourcesOf(a);
  const lab = labBookingsScope(a);
  const queues: Record<string, () => Promise<unknown>> = {};
  if (src.bookings) {
    // Samples to collect on this day: confirmed bookings for it (lab visits and home collections).
    queues.samplesToCollect = async () => {
      const [visits, home] = await Promise.all([countIds(PartnerLabBookingModel, { ...lab, status: 'confirmed', 'slot.date': date, visitMode: 'lab' }),
        countIds(PartnerLabBookingModel, { ...lab, status: 'confirmed', 'slot.date': date, visitMode: 'home' })]);
      return { count: visits.count + home.count, visitCount: visits.count, homeCount: home.count, visitIds: visits.ids, homeIds: home.ids };
    };
    // Reports to upload (sample in, no draft yet) or to release (a draft waiting).
    queues.reportsDue = async () => {
      const [upload, release] = await Promise.all([
        countIds(PartnerLabBookingModel, { ...lab, status: { $in: ['sample_collected', 'visited', 'processing'] }, 'report.draftFiles.0': { $exists: false } }),
        countIds(PartnerLabBookingModel, { ...lab, status: { $in: ['sample_collected', 'visited', 'processing', 'report_ready'] }, 'report.draftFiles.0': { $exists: true } }),
      ]);
      return { count: upload.count + release.count, toUploadCount: upload.count, toReleaseCount: release.count, toUploadIds: upload.ids, toReleaseIds: release.ids };
    };
  }
  if (src.bills) queues.unpaidBills = () => countIds(InvoiceModel, { ...invoicesScope(a), lifecycleState: { $in: ['issued', 'partly_paid'] } });
  if (src.consultations) {
    const own = bookerBookingsFilter(labBooker(a));
    // The lab's card consultations still waiting for their payment.
    queues.bookingsAwaitingPayment = () => countIds(BookingModel, { ...own, status: 'pending', 'assisted.funding.method': 'razorpay', 'assisted.funding.state': 'pending' });
    // Consultations it booked for this day, still to happen.
    queues.consultationsWaiting = () => countIds(BookingModel, { ...own, status: 'confirmed', bookingDate: date.replace(/-/g, '') });
  }
  return settledQueues(queues);
}

export async function labToday(a: PartnerActor, q: PageQuery, now: Date = new Date()) {
  await assertLab(a);
  const p = await pageOf(q, now, (day) => rawOf(a, day));
  const [items, pending] = await Promise.all([itemsOf(a, p.page, p.day, p.date), p.first ? pendingOf(a, p.date) : Promise.resolve(null)]);
  return {
    date: p.date, items, totals: totalsOf(p.raws, p.day, LAB_PAYMENT_METHODS),
    ...(pending ? { pending } : {}),
    ...(p.truncated.length ? { truncated: p.truncated } : {}),
    nextCursor: p.nextCursor,
  };
}

/**
 * POST …/today/search { date?, q, cursor?, limit?, order? } — the day's rows matching `q`: the patient's name as the lab
 * sees it (a booking's patient, a bill's customer, a consultation's patient by the booker names rule), the short ref or
 * bill serial, the line's text (tests, bill items, doctor), or with 4+ digits a phone the lab holds (a bill's customer
 * phone, a home collection's phone, the account holder of a desk booking or consultation it made, a consultation's
 * contact number). The same item shape; no totals or pending.
 */
export async function labTodaySearch(a: PartnerActor, q: PageQuery & { q: string }, now: Date = new Date()) {
  await assertLab(a);
  const terms = searchTerms(q.q);
  const p = await pageOf(q, now, (day) => rawOf(a, day), async (raws) => {
    const rowsOf = (k: LabTodayKind) => raws.filter((r) => r.kind === k).map((r) => r.row);
    const own = (l: Row) => isDeskRow(l);
    const [consultNames, phoneOf] = await Promise.all([
      bookerNames(rowsOf('consultation'), { kind: 'lab', id: a.partnerId }),
      holderPhones([...rowsOf('lab_booking').filter(own).map((l) => l.userId), ...rowsOf('consultation').map((b) => b.userId)], !!terms.phone),
    ]);
    return raws.filter((r) => {
      const v = r.row;
      switch (r.kind) {
        case 'lab_booking': return matches(terms, [v.patient?.name, v.assisted?.shortRef, whatOf(r).what],
          [v.address?.phone, own(v) ? phoneOf.get(String(v.userId ?? '').toLowerCase()) : null]);
        case 'bill': return matches(terms, [v.customer?.name, v.serial, whatOf(r).what], [v.customer?.phone]);
        case 'consultation': return matches(terms, [consultNames.patients.get(r.id), v.assisted?.shortRef, whatOf(r).what],
          [v.contactNo, phoneOf.get(String(v.userId ?? '').toLowerCase())]);
        default: return false;
      }
    });
  });
  return { date: p.date, items: await itemsOf(a, p.page, p.day, p.date), nextCursor: p.nextCursor };
}
