import { Types } from 'mongoose';
import BookingModel from '@/modules/bookings/model';
import { appointmentStartOf } from '@/modules/bookings/holds';
import DependentModel from '@/modules/dependents/model';
import UserModel from '@/modules/user/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { InvoiceModel } from '@/modules/partners/model/invoice';
import { LedgerEntryModel } from '@/modules/partners/model/settlement';
import type { PartnerActor } from '@/modules/partners/services';
import { findOwnerAccount } from '@/modules/partners/services/finance';
import { invoicesScope } from '@/modules/partners/services/invoice';
import { addDays } from '@/modules/partners/services/slots';
import { billRawsOf, billWhat } from '@/modules/partners/services/today';
import { LAB_PAYMENT_METHODS } from '@/modules/pharmacyOrders/paymentMethod';
import { assistedBookerFilter } from '@/modules/assisted/refunds';
import { bookerLabViews } from '@/modules/assisted/labBookings';
import { UNPAID_CARD_QUERY } from '@/modules/assisted/views';
import { bookerNames } from '@/modules/assisted/names';
import {
  capper, consultationWhat, countIds, dayRows, holderPhones, identityMoved, itemBase, labTestsWhat, matches, orderRaws, pageOf, paise,
  searchTerms, settledQueues, totalsOf, type Day, type PageQuery, type Raw, type Row, type WhatParts,
} from '@/modules/today/register';
import { appointmentSourceOf, channelOf, clinicIdOf, clinicNames, ownedClinicActorOrNull } from '@/modules/specialists/dashboard';

/**
 * r39 (§26.23): GET /api/v1/specialists/me/today?date&cursor&limit&order — the doctor's Today register for one India day,
 * on the shared register rules (`today/register.ts`):
 * - his appointments of that day, every source (his list's rows: patient app, clinic desk, pharmacy, lab, his own);
 * - the bills of the clinic he owns (made that day, or paid or refunded that day), as the clinic's register counts them;
 * - the lab tests he booked (made that day, or paid that day).
 * Money (`totals`): what came in that day — his clinic's bill payments by method (`collectedMinor`, `byMethod`, refunds),
 * and what his ledger earned that day (`earnedMinor`: consultation earnings and referral cuts, net of reversals).
 * Appointments and lab tests are listed, not counted (their money is the ledger's or his wallet's). POST …/today/search
 * searches the same day.
 */
export type DoctorTodayKind = 'appointment' | 'bill' | 'lab_booking';

const APPOINTMENT_FIELDS = { status: 1, paymentStatus: 1, price: 1, doctorName: 1, bookingKind: 1, bookingDate: 1, bookingTime: 1, consultationMode: 1,
  createdAt: 1, userId: 1, dependentId: 1, contactNo: 1, source: 1, 'clinicDesk.partnerId': 1, 'clinicVisit.partnerId': 1, 'assisted.shortRef': 1,
  'assisted.identity.disputed.state': 1 };
const LAB_FIELDS = { status: 1, paymentStatus: 1, 'pricing.payableMinor': 1, 'assisted.shortRef': 1, 'lifecycle.paidAt': 1, 'items.name': 1, createdAt: 1,
  userId: 1, 'patient.dependentId': 1, 'assisted.identity.disputed.state': 1 };
const spellings = (id: string) => [...new Set([id, id.toLowerCase()])];
const yyyymmdd = (date: string) => date.replace(/-/g, '');
/** His consultations, as his list reads them (never an unconfirmed card booking of a partner). */
const ownAppointments = (doctorId: string): Row => ({ specialistId: { $in: spellings(doctorId) }, bookingType: 'consultation', $nor: [UNPAID_CARD_QUERY] });

async function rawOf(doctorId: string, clinic: PartnerActor | null, day: Day, date: string): Promise<{ raws: Raw[]; truncated: string[] }> {
  const before = { $lt: day.$gte };
  const labOwner = assistedBookerFilter('doctor', doctorId);
  const truncated = new Set<string>();
  const cap = capper(truncated);
  const [appointments, billRaws, labs, labsPaid] = await Promise.all([
    dayRows(BookingModel, { ...ownAppointments(doctorId), bookingDate: yyyymmdd(date) }, APPOINTMENT_FIELDS),
    clinic ? billRawsOf(invoicesScope(clinic), day, cap) : Promise.resolve([] as Raw[]),
    dayRows(PartnerLabBookingModel, { ...labOwner, createdAt: day }, LAB_FIELDS),
    dayRows(PartnerLabBookingModel, { ...labOwner, 'lifecycle.paidAt': day, createdAt: before }, LAB_FIELDS),
  ]);
  const raws: Raw[] = [
    // At its appointment time; never moved to a payment time (`paidAt` null): its money is counted by the ledger.
    ...cap('appointment', appointments).map((b): Raw => ({ kind: 'appointment', row: b, at: appointmentStartOf(b as never) ?? b.createdAt,
      createdAt: b.createdAt, id: String(b._id), status: b.status, paymentStatus: b.paymentStatus, amountMinor: paise(b.price), paid: b.paymentStatus === 'paid',
      paidAt: null, method: null, collects: false, atGateway: false })),
    ...billRaws,
    // Paid from his wallet or by card (not money collected from the patient here): listed, not counted.
    ...[...cap('lab_booking', labs), ...cap('lab_booking', labsPaid)].map((l): Raw => {
      const paid = l.paymentStatus === 'paid';
      return { kind: 'lab_booking', row: l, at: l.createdAt, createdAt: l.createdAt, id: String(l._id), status: l.status, paymentStatus: l.paymentStatus,
        amountMinor: Number(l.pricing?.payableMinor ?? 0), paid, paidAt: paid ? l.lifecycle?.paidAt ?? l.createdAt : null, method: null, collects: false,
        atGateway: false };
    }),
  ];
  return { raws: orderRaws(raws, day), truncated: [...truncated] };
}

/** What his ledger earned that day: earnings and reversals of consultations and referral cuts (not payouts or adjustments). */
async function earnedOn(doctorId: string, day: Day): Promise<number> {
  const account = await findOwnerAccount('doctor', doctorId);
  if (!account) return 0;
  const [g] = await LedgerEntryModel.aggregate([{ $match: { settlementAccountId: String(account._id), kind: { $in: ['earning', 'reversal'] }, at: day } },
    { $group: { _id: null, total: { $sum: '$amountMinor' } } }]);
  return Number(g?.total ?? 0);
}

/** The patient seen at each appointment (the family member when booked for one, else the account holder). */
async function patientNames(rows: Row[]): Promise<Map<string, string | null>> {
  const ok = (x: unknown): x is string => typeof x === 'string' && Types.ObjectId.isValid(x);
  const userIds = [...new Set(rows.map((r) => String(r.userId ?? '')).filter(ok))];
  const depIds = [...new Set(rows.map((r) => String(r.dependentId ?? '')).filter(ok))];
  const [users, deps] = await Promise.all([
    userIds.length ? UserModel.find({ _id: { $in: userIds } }).select({ name: 1 }).lean() as unknown as Promise<Row[]> : [],
    depIds.length ? DependentModel.find({ _id: { $in: depIds } }).select({ name: 1 }).lean() as unknown as Promise<Row[]> : [],
  ]);
  const u = new Map(users.map((x) => [String(x._id).toLowerCase(), x.name ?? null]));
  const d = new Map(deps.map((x) => [String(x._id).toLowerCase(), x.name ?? null]));
  return new Map(rows.map((r) => [String(r._id), (r.dependentId ? d.get(String(r.dependentId).toLowerCase()) : undefined) ?? u.get(String(r.userId ?? '').toLowerCase()) ?? null]));
}

function whatOf(r: Raw): { what: string; whatParts: WhatParts } {
  if (r.kind === 'appointment') return consultationWhat(r.row);
  if (r.kind === 'bill') return billWhat(r.row);
  return labTestsWhat(r.row);
}
const LINK: Record<DoctorTodayKind, string> = { appointment: 'booking', bill: 'invoice', lab_booking: 'lab_booking' };

async function itemsOf(doctorId: string, page: Raw[], day: Day, date: string) {
  const of = (k: DoctorTodayKind) => page.filter((r) => r.kind === k);
  const labIds = of('lab_booking').map((r) => new Types.ObjectId(r.id));
  const [names, clinics, labs] = await Promise.all([
    patientNames(of('appointment').map((r) => r.row)),
    clinicNames(of('appointment').map((r) => r.row)),
    labIds.length ? PartnerLabBookingModel.find({ _id: { $in: labIds } }).lean().then((rows) => bookerLabViews(rows as unknown as Row[], { kind: 'doctor', specialistId: doctorId }))
      : Promise.resolve([] as Row[]),
  ]);
  const labById = new Map(labs.map((v) => [String(v._id), v]));
  return page.map((r) => {
    const b = itemBase(r, day, date);
    const v = r.row;
    const shortRef = r.kind === 'bill' ? v.serial ?? null : v.assisted?.shortRef ?? null;
    const patientName = r.kind === 'appointment' ? names.get(r.id) ?? null : r.kind === 'bill' ? v.customer?.name ?? null : labById.get(r.id)?.patientName ?? null;
    const c = r.kind === 'appointment' ? clinicIdOf(v) : null;
    return { kind: b.kind, id: b.id, at: b.at, shortRef, patientName, ...whatOf(r), amountMinor: b.amountMinor, paid: b.paid, method: b.method, status: b.status,
      madeOn: b.madeOn, paidToday: r.kind === 'bill' ? b.madeOn !== date && !!r.received?.length : b.paidToday, link: { kind: LINK[r.kind as DoctorTodayKind], id: r.id },
      ...(r.kind === 'appointment' ? { source: appointmentSourceOf(v), channel: channelOf(v), clinic: c ? clinics.get(c) ?? { id: c, name: null } : null } : {}) };
  });
}

/** What is waiting, each queue a count and its first ids; one that fails answers `null`. */
async function pendingOf(doctorId: string, clinic: PartnerActor | null, date: string, now: Date) {
  const own = ownAppointments(doctorId);
  const queues: Record<string, () => Promise<unknown>> = {
    // Consultations he completed in the last 14 days with no prescription written yet.
    prescriptionsToWrite: () => countIds(BookingModel, { ...own, status: 'completed', prescription: { $exists: false },
      bookingDate: { $gte: yyyymmdd(addDays(date, -14)), $lte: yyyymmdd(date) } }),
    // Appointments from this day on still pending (to confirm; `awaitingPayment` of them wait for the patient's payment).
    appointmentsToConfirm: async () => {
      const filter = { ...own, status: 'pending', bookingDate: { $gte: yyyymmdd(date) } };
      const [all, awaitingPayment] = await Promise.all([countIds(BookingModel, filter), BookingModel.countDocuments({ ...filter, paymentStatus: { $ne: 'paid' } })]);
      return { ...all, awaitingPaymentCount: awaitingPayment };
    },
    // Reports of lab tests he booked released in the last 7 days.
    reportsReady: () => countIds(PartnerLabBookingModel, { ...assistedBookerFilter('doctor', doctorId),
      'report.releases.releasedAt': { $gte: new Date(now.getTime() - 7 * 86_400_000) } }),
  };
  if (clinic) queues.unpaidBills = () => countIds(InvoiceModel, { ...invoicesScope(clinic), lifecycleState: { $in: ['issued', 'partly_paid'] } });
  return settledQueues(queues);
}

export async function doctorToday(doctorId: string, q: PageQuery, now: Date = new Date()) {
  const clinic = await ownedClinicActorOrNull(doctorId);
  const p = await pageOf(q, now, (day) => rawOf(doctorId, clinic, day, istDateOf(day)));
  const [items, pending, earnedMinor] = await Promise.all([itemsOf(doctorId, p.page, p.day, p.date),
    p.first ? pendingOf(doctorId, clinic, p.date, now) : Promise.resolve(null), earnedOn(doctorId, p.day)]);
  return {
    date: p.date, items, totals: { ...totalsOf(p.raws, p.day, LAB_PAYMENT_METHODS, { refunds: true }), earnedMinor },
    ...(pending ? { pending } : {}),
    ...(p.truncated.length ? { truncated: p.truncated } : {}),
    nextCursor: p.nextCursor,
  };
}
/** The India date of a day range (its start). */
const istDateOf = (day: Day) => new Date(day.$gte.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * POST …/today/search { date?, q, cursor?, limit?, order? } — the day's rows matching `q`: the patient's name, the short
 * ref or bill serial, the line's text, or with 4+ digits a phone (the account holder of an appointment or lab test, an
 * appointment's contact number, a bill's customer phone). The same item shape; no totals or pending.
 */
export async function doctorTodaySearch(doctorId: string, q: PageQuery & { q: string }, now: Date = new Date()) {
  const terms = searchTerms(q.q);
  const clinic = await ownedClinicActorOrNull(doctorId);
  const p = await pageOf(q, now, (day) => rawOf(doctorId, clinic, day, istDateOf(day)), async (raws) => {
    const rowsOf = (k: DoctorTodayKind) => raws.filter((r) => r.kind === k).map((r) => r.row);
    const labRows = rowsOf('lab_booking');
    const [names, phoneOf, labs] = await Promise.all([
      patientNames(rowsOf('appointment')),
      holderPhones([...rowsOf('appointment'), ...labRows].map((b) => b.userId), !!terms.phone),
      bookerNames(labRows.map((l) => ({ _id: l._id, userId: l.userId, dependentId: l.patient?.dependentId })), { kind: 'doctor', id: doctorId.toLowerCase() }),
    ]);
    const labNames = labs.patients;
    const holder = (v: Row) => (identityMoved(v) ? null : phoneOf.get(String(v.userId ?? '').toLowerCase()));
    return raws.filter((r) => {
      const v = r.row;
      if (r.kind === 'appointment') return matches(terms, [names.get(r.id), v.assisted?.shortRef, whatOf(r).what], [v.contactNo, holder(v)]);
      if (r.kind === 'bill') return matches(terms, [v.customer?.name, v.serial, whatOf(r).what], [v.customer?.phone]);
      return matches(terms, [labNames.get(r.id), v.assisted?.shortRef, whatOf(r).what], [holder(v)]);
    });
  });
  return { date: p.date, items: await itemsOf(doctorId, p.page, p.day, p.date), nextCursor: p.nextCursor };
}
