/**
 * Q4 §5: gives every existing future one-patient consultation (pending/confirmed, held slot with maxBookings 1) its
 * doctor interval, so new bookings and instant consultations can no longer overlap it. Idempotent (one interval per
 * booking). Bookings that already overlap each other are listed, never changed. The cursor only proposes candidates:
 * each reservation transaction re-reads the booking and its slot and write-fences the booking, so a cancellation or
 * reschedule racing the backfill either commits first (the booking is skipped) or conflicts and runs after it (and then
 * releases or moves the interval it now finds).
 *   npm run migrate:q4-reservations              # dry run
 *   npm run migrate:q4-reservations -- --commit
 */
import mongoose, { ClientSession } from 'mongoose';
import { CONFIG } from '@/config/config';
import BookingModel from '@/modules/bookings/model';
import SlotModel from '@/modules/slots/model';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { reserveInterval } from '@/modules/doctors/services/reservations';
import { slotIntervalOf } from '@/modules/common/utils/slotInterval';
import { DoctorReservationModel } from '@/modules/doctors/model/reservation';

/**
 * Q16a (L1): `conflicts` — bookings whose interval overlaps another booking's (computed in the dry run too, from the
 * existing reservations and the other candidates); `failed` — bookings that could not be processed (logged by id and
 * error code only; the run goes on with the next booking).
 */
export interface BackfillReport { candidates: number; reserved: number; conflicts: string[]; failed: { bookingId: string; code: string }[] }

/** The booking still needs an interval: live one-patient consultation, slot held, interval not yet over. */
async function eligible(bookingId: string, now: Date, s?: ClientSession) {
  const b = await BookingModel.findById(bookingId).session(s ?? null).lean() as any;
  if (!b || !['pending', 'confirmed'].includes(b.status) || !['consultation', 'second-opinion'].includes(b.bookingType)
      || typeof b.specialistId !== 'string' || typeof b.slotId !== 'string') return null;
  const slot = await SlotModel.findById(b.slotId).session(s ?? null).lean() as any;
  if (!slot || Number(slot.maxBookings ?? 1) !== 1) return null;
  const w = slotIntervalOf(slot);
  if (!w || w.end <= now) return null;
  return { b, slot, w };
}

export async function runReservationBackfill(commit: boolean, now = new Date()): Promise<BackfillReport> {
  const report: BackfillReport = { candidates: 0, reserved: 0, conflicts: [], failed: [] };
  // Dry run: the intervals the commit would reserve, per doctor, to find overlaps without writing anything.
  const planned = new Map<string, { id: string; start: Date; end: Date }[]>();
  const cursor = BookingModel.find({ status: { $in: ['pending', 'confirmed'] }, bookingType: { $in: ['consultation', 'second-opinion'] },
    specialistId: { $type: 'string' }, slotId: { $type: 'string' } }).select({ _id: 1 }).lean().cursor();
  for await (const c of cursor as AsyncIterable<any>) {
    let proposal: Awaited<ReturnType<typeof eligible>>;
    try {
      proposal = await eligible(String(c._id), now);
    } catch (e: any) {
      report.failed.push({ bookingId: String(c._id), code: String(e?.code ?? e?.name ?? 'ERROR') });
      continue;
    }
    if (!proposal) continue;
    report.candidates += 1;
    if (!commit) {
      try {
        const doctorId = String(proposal.b.specialistId).toLowerCase();
        const id = String(proposal.b._id).toLowerCase();
        const held = await DoctorReservationModel.findOne({ doctorId, isActive: true, startTime: { $lt: proposal.w.end }, endTime: { $gt: proposal.w.start },
          refId: { $ne: id } }).select({ _id: 1 }).lean();
        const mine = planned.get(doctorId) ?? [];
        const own = await DoctorReservationModel.exists({ refId: id, kind: 'scheduled', isActive: true });
        if (!own && (held || mine.some((m) => m.start < proposal!.w.end && m.end > proposal!.w.start))) report.conflicts.push(String(c._id));
        else if (!own) mine.push({ id, start: proposal.w.start, end: proposal.w.end });
        planned.set(doctorId, mine);
      } catch (e: any) {
        report.failed.push({ bookingId: String(c._id), code: String(e?.code ?? e?.name ?? 'ERROR') });
      }
      continue;
    }
    try {
      const done = await runLedgerTransaction(async (s) => {
        // Re-admitted on committed state inside the transaction, then fenced: same status, same slot.
        const current = await eligible(String(c._id), now, s);
        if (!current) return false;
        // A definite write (version increment, never a same-value no-op), so every admitted candidate conflicts with a racing change.
        const fenced = await BookingModel.collection.updateOne({ _id: current.b._id, status: current.b.status, slotId: current.b.slotId },
          { $inc: { __v: 1 } }, { session: s });
        if (fenced.modifiedCount !== 1) return false;
        await reserveInterval({ doctorId: String(current.b.specialistId), kind: 'scheduled', refId: String(current.b._id).toLowerCase(),
          start: current.w.start, end: current.w.end, branchId: current.slot.branchId }, s);
        return true;
      });
      if (done) report.reserved += 1;
    } catch (e: any) {
      if (e?.code === 'DOCTOR_BUSY') report.conflicts.push(String(c._id));
      else report.failed.push({ bookingId: String(c._id), code: String(e?.code ?? e?.name ?? 'ERROR') });
    }
  }
  return report;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    const report = await runReservationBackfill(commit);
    console.log(JSON.stringify({ mode: commit ? 'commit' : 'dry-run', ...report }, null, 2));
    if (report.conflicts.length) console.log('Overlapping bookings already exist (listed above); resolve them with the doctors.');
    if (report.failed.length) { console.log('Some bookings could not be processed (listed above by id and error); fix them and re-run.'); process.exitCode = 2; }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
