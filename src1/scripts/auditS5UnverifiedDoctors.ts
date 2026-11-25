// S5 audit (read-only): doctors who are not verified or not active but have slots, bookings or prescriptions, and the
// bookings with such a doctor, for an admin to review (S5 leaves existing bookings as they are).
//
//   npm run audit:s5-unverified-doctors      prints one JSON report to stdout
//
// Lists ids and counts only (no names, phones, medicines, notes or file URLs):
//   - specialists: each doctor with isVerified !== true or isActive !== true that has at least one slot, booking or
//     prescription (as the booking's doctor or as prescribedBySpecialistId);
//   - bookings: every booking whose specialistId (or prescription.prescribedBySpecialistId) is such a doctor, with
//     whether it carries a prescription (and its marker) or a report, its appointment date / time, price and payment
//     status, and `timing` (open = pending/confirmed; paid = paymentStatus paid or wallet/gateway money applied):
//       'upcoming_cancel_before_start'  open, not started: the patient or an admin cancels it now (full refund);
//       'past_start_stuck'              open, paid, already started: nobody can cancel it on the main line (the cancel
//                                       answers BOOKING_ALREADY_STARTED); stage: admin close;
//       'unpaid_will_expire'            open, unpaid, already started: not stuck - the payment-timeout sweep expires it;
//       'paid_unknown_time_stuck'       open, paid, date/time cannot be read: stuck too (a cancel answers 400
//                                       INVALID_BOOKING_DATETIME, admin included);
//       'unknown_time'                  open, unpaid, date/time cannot be read (no money is held);
//       'closed'                        cancelled, completed or no-show;
//   - linkedPharmacyOrders: pharmacy orders whose linkedConsultationId is one of those bookings;
//   - nameChangesAfterVerification: not available - specialist edits keep no history (no verifiedAt, no name log).
// It only reads (find / aggregate without $out or $merge); it writes nothing and creates no collection or index.
//
// Acting on the list (main line): the doctor cannot close these bookings itself (its status change is refused, and on
// main the portal's cancel answers 409 DEDICATED_BOOKING_COMMAND_REQUIRED). The patient or an admin cancels with
// POST /bookings/:id/cancel before the appointment time (full refund to the wallet); a booking whose time has passed
// needs the stage-line admin close (S5c) or manual handling. A planted prescription or report is removed with
// DELETE /bookings/:id/prescription | /report (admin, reason). Deploy: run npm run sync-indexes first (it creates the
// bookingadminclears and specialistverifications collections the S5 admin commands require; without them they answer 503).
import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';
import SpecialistModel from '@/modules/specialists/model';
import SlotModel from '@/modules/slots/model';
import BookingModel from '@/modules/bookings/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { parseAppointment } from '@/modules/common/utils/cancellationWindow';

export type S5Timing = 'upcoming_cancel_before_start' | 'past_start_stuck' | 'unpaid_will_expire' | 'paid_unknown_time_stuck'
  | 'unknown_time' | 'closed';

export interface S5UnverifiedDoctorAudit {
  generatedAt: string;
  specialists: {
    specialistId: string; isActive: boolean; isVerified: boolean;
    slots: number; openSlots: number; bookings: number; prescriptions: number;
  }[];
  bookings: {
    bookingId: string; specialistId: string | null; prescribedBySpecialistId: string | null; userId: string | null;
    bookingType: string | null; status: string | null; hasPrescription: boolean; prescriptionMarker: boolean; hasReport: boolean;
    bookingDate: string | null; bookingTime: string | null; price: number | null; paymentStatus: string | null; timing: S5Timing;
    createdAt: string | null;
  }[];
  linkedPharmacyOrders: { orderId: string; bookingId: string; pharmacyId: string | null }[];
  nameChangesAfterVerification: 'unavailable: specialist edits keep no history';
}

const low = (v: unknown) => (v == null || v === '' ? null : String(v).toLowerCase());
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null);

const OPEN = new Set(['pending', 'confirmed']);
type TimingInput = { status?: unknown; bookingDate?: unknown; bookingTime?: unknown; paymentStatus?: unknown;
  walletFunding?: { total?: number; captures?: { state?: string }[] } };
/** Money is held: paid, or wallet / gateway money applied to it (an unpaid booking holds none and simply expires). */
const holdsMoney = (b: TimingInput) => b.paymentStatus === 'paid' || Number(b.walletFunding?.total || 0) > 0 ||
  (b.walletFunding?.captures ?? []).some((c) => c.state === 'applied');
/** Whether an open booking can still be cancelled (before its start, India time), will expire, or is stuck. */
export function timingOf(b: TimingInput, now: Date): S5Timing {
  if (!OPEN.has(String(b.status))) return 'closed';
  const paid = holdsMoney(b);
  let at: Date | null = null;
  try { at = parseAppointment({ bookingDate: String(b.bookingDate ?? ''), bookingTime: String(b.bookingTime ?? '') })?.at ?? null; } catch { at = null; }
  if (!at || Number.isNaN(at.getTime())) return paid ? 'paid_unknown_time_stuck' : 'unknown_time';
  if (at.getTime() > now.getTime()) return 'upcoming_cancel_before_start';
  return paid ? 'past_start_stuck' : 'unpaid_will_expire';
}

export async function auditS5UnverifiedDoctors(now = new Date()): Promise<S5UnverifiedDoctorAudit> {
  const ineligible = new Map<string, { isActive: boolean; isVerified: boolean }>();
  for await (const sp of SpecialistModel.find({ $or: [{ isActive: { $ne: true } }, { isVerified: { $ne: true } }] })
    .select({ isActive: 1, isVerified: 1 }).sort({ _id: 1 }).lean().cursor()) {
    ineligible.set(String(sp._id).toLowerCase(), { isActive: sp.isActive === true, isVerified: sp.isVerified === true });
  }

  const counts = new Map<string, { slots: number; openSlots: number; bookings: number; prescriptions: number }>();
  const countOf = (id: string) => counts.get(id) ?? (counts.set(id, { slots: 0, openSlots: 0, bookings: 0, prescriptions: 0 }), counts.get(id)!);

  // Ids are strings and may differ in letter case: grouped by their lower-case form.
  const slotGroups = await SlotModel.aggregate([
    { $match: { specialistId: { $type: 'string', $ne: '' } } },
    { $group: { _id: { $toLower: '$specialistId' }, slots: { $sum: 1 },
      openSlots: { $sum: { $cond: [{ $and: [{ $eq: ['$isActive', true] }, { $eq: ['$isAvailable', true] }] }, 1, 0] } } } },
  ]);
  for (const g of slotGroups) if (ineligible.has(g._id)) Object.assign(countOf(g._id), { slots: g.slots, openSlots: g.openSlots });

  const bookings: S5UnverifiedDoctorAudit['bookings'] = [];
  for await (const b of BookingModel.find({ $or: [{ specialistId: { $type: 'string', $ne: '' } }, { 'prescription.prescribedBySpecialistId': { $exists: true } }] })
    .select({ specialistId: 1, userId: 1, bookingType: 1, status: 1, bookingDate: 1, bookingTime: 1, price: 1, paymentStatus: 1,
      'walletFunding.total': 1, 'walletFunding.captures.state': 1,
      'prescription.prescribedBySpecialistId': 1, 'prescription.prescribedAt': 1,
      'prescription.fileUrls': 1, 'lifecycle.prescriptionUploaded': 1, 'report.message': 1, 'report.fileUrls': 1, createdAt: 1 })
    .sort({ _id: 1 }).lean().cursor()) {
    const doctor = low(b.specialistId);
    const prescriber = low(b.prescription?.prescribedBySpecialistId);
    const doctorFlagged = !!doctor && ineligible.has(doctor);
    const prescriberFlagged = !!prescriber && ineligible.has(prescriber);
    if (!doctorFlagged && !prescriberFlagged) continue;
    const hasPrescription = !!b.prescription && Object.keys(b.prescription).length > 0;
    if (doctorFlagged) countOf(doctor!).bookings++;
    if (hasPrescription) for (const id of new Set([doctorFlagged ? doctor : null, prescriberFlagged ? prescriber : null])) if (id) countOf(id).prescriptions++;
    bookings.push({
      bookingId: String(b._id), specialistId: doctor, prescribedBySpecialistId: prescriber, userId: b.userId ? String(b.userId) : null,
      bookingType: b.bookingType ?? null, status: b.status ?? null, hasPrescription,
      prescriptionMarker: !!b.lifecycle?.prescriptionUploaded?.at, hasReport: !!b.report && Object.keys(b.report).length > 0,
      bookingDate: b.bookingDate ?? null, bookingTime: b.bookingTime ?? null,
      price: typeof b.price === 'number' ? b.price : null, paymentStatus: b.paymentStatus ?? null, timing: timingOf(b as TimingInput, now),
      createdAt: iso(b.createdAt),
    });
  }

  const linkedPharmacyOrders: S5UnverifiedDoctorAudit['linkedPharmacyOrders'] = [];
  const ids = bookings.map((b) => new mongoose.Types.ObjectId(b.bookingId));
  for (let i = 0; i < ids.length; i += 500) {
    for await (const o of PharmacyOrderModel.find({ linkedConsultationId: { $in: ids.slice(i, i + 500) } })
      .select({ linkedConsultationId: 1, pharmacyId: 1 }).sort({ _id: 1 }).lean().cursor()) {
      linkedPharmacyOrders.push({ orderId: String(o._id), bookingId: String(o.linkedConsultationId), pharmacyId: o.pharmacyId ? String(o.pharmacyId) : null });
    }
  }

  const specialists = [...counts.entries()]
    .filter(([, c]) => c.slots || c.bookings || c.prescriptions)
    .map(([id, c]) => ({ specialistId: id, ...ineligible.get(id)!, ...c }))
    .sort((a, b) => a.specialistId.localeCompare(b.specialistId));
  return { generatedAt: new Date().toISOString(), specialists, bookings, linkedPharmacyOrders,
    nameChangesAfterVerification: 'unavailable: specialist edits keep no history' };
}

async function main() {
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    const report = await auditS5UnverifiedDoctors();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.stderr.write(`unverified or inactive doctors with slots, bookings or prescriptions: ${report.specialists.length}; ` +
      `bookings with such a doctor: ${report.bookings.length} (with a prescription: ${report.bookings.filter((b) => b.hasPrescription).length}); ` +
      `pharmacy orders linked to them: ${report.linkedPharmacyOrders.length}; ` +
      `upcoming (cancel before start): ${report.bookings.filter((b) => b.timing === 'upcoming_cancel_before_start').length}; ` +
      `stuck (paid, past start or unreadable time): ${report.bookings.filter((b) => b.timing === 'past_start_stuck' || b.timing === 'paid_unknown_time_stuck').length}; ` +
      `unpaid, will expire: ${report.bookings.filter((b) => b.timing === 'unpaid_will_expire').length}; name history: not available\n`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
