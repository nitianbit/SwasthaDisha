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

export interface BackfillReport { candidates: number; reserved: number; conflicts: string[] }

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
  const report: BackfillReport = { candidates: 0, reserved: 0, conflicts: [] };
  const cursor = BookingModel.find({ status: { $in: ['pending', 'confirmed'] }, bookingType: { $in: ['consultation', 'second-opinion'] },
    specialistId: { $type: 'string' }, slotId: { $type: 'string' } }).select({ _id: 1 }).lean().cursor();
  for await (const c of cursor as AsyncIterable<any>) {
    const proposal = await eligible(String(c._id), now);
    if (!proposal) continue;
    report.candidates += 1;
    if (!commit) continue;
    try {
      const done = await runLedgerTransaction(async (s) => {
        // Re-admitted on committed state inside the transaction, then fenced: same status, same slot.
        const current = await eligible(String(c._id), now, s);
        if (!current) return false;
        const fenced = await BookingModel.updateOne({ _id: current.b._id, status: current.b.status, slotId: current.b.slotId },
          { $set: { updatedAt: new Date() } }, { session: s, timestamps: false });
        if (fenced.modifiedCount !== 1) return false;
        await reserveInterval({ doctorId: String(current.b.specialistId), kind: 'scheduled', refId: String(current.b._id).toLowerCase(),
          start: current.w.start, end: current.w.end, branchId: current.slot.branchId }, s);
        return true;
      });
      if (done) report.reserved += 1;
    } catch (e: any) {
      if (e?.code !== 'DOCTOR_BUSY') throw e;
      report.conflicts.push(String(c._id));
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
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
