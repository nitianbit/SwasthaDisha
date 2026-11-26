import { Types } from 'mongoose';
import BookingModel from '@/modules/bookings/model';
import type { IBooking } from '@/modules/bookings/types';
import type { PartnerActor } from '@/modules/partners/services';
import { invoicesScope, billsForAppointments } from '@/modules/partners/services/invoice';
import { clinicAppointmentsScope, clinicAppointmentViews } from '@/modules/partners/services/clinic';
import { billDayReads, billItemOf, billMatches, billRawsOf, unpaidBillsQueue } from '@/modules/partners/services/today';
import { INVOICE_READERS, type PartnerPermission } from '@/modules/partners/types';
import { LAB_PAYMENT_METHODS } from '@/modules/pharmacyOrders/paymentMethod';
import {
  can, capper, countIds, dayRows, err, holderPhones, identityMoved, isoDay, itemBase, matches, orderRaws, pageOf, paise, registerAnswer, searchTerms,
  settledQueues, unbilledQueue, type Day, type PageQuery, type Raw, type Row, type WhatParts,
} from '@/modules/today/register';

/**
 * r40 (§26.24, P3): GET /api/v1/partner-workspace/today for a CLINIC — the reception's Today register for one India day, on
 * the shared register (`today/register.ts`) and the lab's bill rules (`partners/services/today.ts`):
 * - the clinic's appointments: desk bookings (the reception's, and a doctor's own booking at the clinic: the same desk
 *   row) and online bookings for a visit at this clinic, at the branches in the member's scope (`clinicAppointmentsScope`,
 *   the appointment list's own filter);
 * - its in-house bills and the payments and refunds recorded on them (by method), in scope (`invoicesScope`).
 * A clinic books no consultations for others and has no wallet, so those sources are absent. Each source is shown only to
 * a member holding a permission that reads it (owners and admins hold all).
 */
export type ClinicTodayKind = 'appointment' | 'bill';

/** Who reads the clinic's appointments (the appointment list's guard). */
const APPOINTMENT_READERS: PartnerPermission[] = ['bookings.view', 'bookings.manage'];
function sourcesOf(a: PartnerActor) {
  const src = { appointments: can(a, APPOINTMENT_READERS), bills: can(a, INVOICE_READERS) };
  if (!src.appointments && !src.bills) throw err(403, 'FORBIDDEN', 'You do not have permission for this');
  return src;
}

const APPOINTMENT_FIELDS = { status: 1, paymentStatus: 1, price: 1, settlementSystem: 1, clinicDesk: 1, 'clinicVisit.partnerId': 1, 'lifecycle.paid.at': 1,
  doctorName: 1, bookingDate: 1, bookingTime: 1, consultationMode: 1, createdAt: 1, userId: 1, dependentId: 1, contactNo: 1, 'assisted.shortRef': 1,
  'assisted.identity.disputed.state': 1 };

/**
 * An appointment row. A desk appointment's money is its bill's (listed, not counted; paid when its bill is). An online one
 * is paid through Jansetu and settled to the doctor, not to the clinic: shown paid (`online`) on its payment day, never
 * counted in the clinic's money (C1).
 */
function appointmentRaw(b: Row): Raw {
  const desk = !!b.clinicDesk || b.settlementSystem === 'clinic';
  const paid = !desk && b.paymentStatus === 'paid';
  return { kind: 'appointment', row: b, at: b.createdAt, createdAt: b.createdAt, id: String(b._id), status: b.status, paymentStatus: b.paymentStatus,
    amountMinor: paise(b.price), paid, paidAt: paid ? b.lifecycle?.paid?.at ?? b.createdAt : null, method: paid ? 'online' : null, collects: false,
    atGateway: !desk && b.status === 'pending', paidStamp: b.lifecycle?.paid?.at ?? null };
}

async function rawOf(a: PartnerActor, day: Day): Promise<{ raws: Raw[]; truncated: string[] }> {
  const src = sourcesOf(a);
  const none = Promise.resolve([] as Row[]);
  const scope = src.appointments ? await clinicAppointmentsScope(a) : null;
  const [made, paidEarlier, bills, billsTouched] = await Promise.all([
    scope ? dayRows(BookingModel, { ...scope, createdAt: day }, APPOINTMENT_FIELDS) : none,
    scope ? dayRows(BookingModel, { ...scope, 'lifecycle.paid.at': isoDay(day), createdAt: { $lt: day.$gte } }, APPOINTMENT_FIELDS) : none,
    ...(src.bills ? billDayReads(invoicesScope(a), day) : [none, none]),
  ]);
  const truncated = new Set<string>();
  const cap = capper(truncated);
  const raws: Raw[] = [
    ...[...cap('appointment', made), ...cap('appointment', paidEarlier)].map(appointmentRaw),
    ...await billRawsOf([...cap('bill', bills), ...cap('bill', billsTouched)], day),
  ];
  return { raws: orderRaws(raws, day), truncated: [...truncated] };
}

/** An appointment's line: `doctor · date time · mode` (`clinic.appointment { doctor, date, time, mode, source }`). */
function appointmentWhat(v: Row): { what: string; whatParts: WhatParts } {
  const date = /^\d{8}$/.test(String(v.bookingDate ?? '')) ? `${v.bookingDate.slice(0, 4)}-${v.bookingDate.slice(4, 6)}-${v.bookingDate.slice(6, 8)}` : null;
  return { what: [v.doctorName, [date, v.bookingTime].filter(Boolean).join(' '), v.consultationMode].filter(Boolean).join(' · ') || 'Appointment',
    whatParts: { code: 'clinic.appointment', values: { doctor: v.doctorName ?? null, date, time: v.bookingTime ?? null, mode: v.consultationMode ?? null,
      source: v.clinicDesk ? 'desk' : 'online' } } };
}

/** The page's rows as items: appointments through the appointment list's view (the person seen, the bill). */
async function itemsOf(a: PartnerActor, page: Raw[], day: Day, date: string) {
  const reader = can(a, APPOINTMENT_READERS);
  const ids = page.filter((r) => r.kind === 'appointment').map((r) => new Types.ObjectId(r.id));
  const rows = ids.length ? await BookingModel.find({ _id: { $in: ids } }).lean() as unknown as IBooking[] : [];
  const views = new Map((await clinicAppointmentViews(a.partnerId, rows)).map((v) => [v.bookingId, v]));
  return page.map((r) => {
    // A bill names the appointment it is for (to fold the visit into one row), only to a member who reads appointments.
    if (r.kind === 'bill') return { ...billItemOf(r, day, date), appointmentId: reader && r.row.appointmentId ? String(r.row.appointmentId) : null };
    const v = views.get(r.id);
    const b = itemBase(r, day, date);
    return { kind: b.kind, id: b.id, at: b.at, shortRef: r.row.assisted?.shortRef ?? null, patientName: v?.patient.name ?? null, ...appointmentWhat(r.row),
      amountMinor: b.amountMinor,
      // A desk appointment is paid when its bill is (its money is counted on the bill).
      paid: v?.source === 'desk' ? v.bill?.state === 'paid' : b.paid, method: b.method, status: b.status, madeOn: b.madeOn, paidToday: b.paidToday,
      link: { kind: 'booking', id: r.id } };
  });
}

/** What is waiting (each queue a count and its first ids; one that fails answers `null`; one the member cannot read is absent). */
async function pendingOf(a: PartnerActor, date: string) {
  const src = sourcesOf(a);
  const queues: Record<string, () => Promise<unknown>> = {};
  if (src.appointments) {
    const scope = await clinicAppointmentsScope(a);
    const today = date.replace(/-/g, '');
    // Appointments of this date to check in (desk rows still confirmed, not arrived) or still waiting for confirmation
    // (pending: an online booking waiting for its payment; desk rows are confirmed when booked).
    queues.appointmentsToday = async () => {
      const [checkIn, confirm] = await Promise.all([
        countIds(BookingModel, { ...scope, bookingDate: today, status: 'confirmed', clinicDesk: { $exists: true }, 'clinicDesk.arrivedAt': null }),
        countIds(BookingModel, { ...scope, bookingDate: today, status: 'pending' }),
      ]);
      return { count: checkIn.count + confirm.count, toCheckInCount: checkIn.count, toConfirmCount: confirm.count, toCheckInIds: checkIn.ids, toConfirmIds: confirm.ids };
    };
    // Desk appointments (walk-ins and booked visits, not ended) up to this date, with no bill or whose bill was cancelled;
    // r40c: a later visit is not yet to bill; `truncated` when the cap was hit.
    queues.deskUnbilled = () => unbilledQueue(BookingModel, { ...scope, clinicDesk: { $exists: true }, status: { $nin: ['cancelled', 'no_show'] },
      bookingDate: { $lte: today } }, (ids) => billsForAppointments(a.partnerId, ids));
  }
  if (src.bills) queues.unpaidBills = unpaidBillsQueue(a);
  return settledQueues(queues);
}

export async function clinicToday(a: PartnerActor, q: PageQuery, now: Date = new Date()) {
  return registerAnswer(q, now, { rawOf: (day) => rawOf(a, day), itemsOf: (page, day, date) => itemsOf(a, page, day, date),
    pendingOf: (date) => pendingOf(a, date), methods: LAB_PAYMENT_METHODS, refunds: true });
}

/**
 * POST …/today/search for a clinic: the day's rows matching `q` — an appointment's patient as the clinic sees it (the
 * person seen, or the account holder), its doctor, short ref or line, or (4+ digits) its contact number or the account
 * holder's phone (not once its identity was moved to another account); a bill as the lab's.
 */
export async function clinicTodaySearch(a: PartnerActor, q: PageQuery & { q: string }, now: Date = new Date()) {
  const terms = searchTerms(q.q);
  const p = await pageOf(q, now, (day) => rawOf(a, day), async (raws) => {
    const appts = raws.filter((r) => r.kind === 'appointment').map((r) => r.row);
    const [views, phoneOf] = await Promise.all([
      clinicAppointmentViews(a.partnerId, appts as unknown as IBooking[]).then((vs) => new Map(vs.map((v) => [v.bookingId, v]))),
      holderPhones(appts.map((b) => b.userId), !!terms.phone),
    ]);
    return raws.filter((r) => {
      if (r.kind === 'bill') return billMatches(terms, r);
      const v = r.row;
      const view = views.get(r.id);
      return matches(terms, [view?.patient.name, view?.patient.accountName, v.assisted?.shortRef, appointmentWhat(v).what],
        [v.contactNo, identityMoved(v) ? null : phoneOf.get(String(v.userId ?? '').toLowerCase())]);
    });
  });
  return { date: p.date, items: await itemsOf(a, p.page, p.day, p.date), nextCursor: p.nextCursor };
}
