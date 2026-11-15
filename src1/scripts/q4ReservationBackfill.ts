/**
 * Q4 §5: gives every existing future one-patient consultation (pending/confirmed, held slot with maxBookings 1) its
 * doctor interval, so new bookings and instant consultations can no longer overlap it. Idempotent (one interval per
 * booking). Bookings that already overlap each other are listed, never changed.
 *   npm run migrate:q4-reservations              # dry run
 *   npm run migrate:q4-reservations -- --commit
 */
import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';
import BookingModel from '@/modules/bookings/model';
import SlotModel from '@/modules/slots/model';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { reserveInterval } from '@/modules/doctors/services/reservations';
import { istInstant } from '@/modules/partners/services/slots';

export interface BackfillReport { candidates: number; reserved: number; conflicts: string[] }

export async function runReservationBackfill(commit: boolean, now = new Date()): Promise<BackfillReport> {
  const report: BackfillReport = { candidates: 0, reserved: 0, conflicts: [] };
  const cursor = BookingModel.find({ status: { $in: ['pending', 'confirmed'] }, bookingType: { $in: ['consultation', 'second-opinion'] },
    specialistId: { $type: 'string' }, slotId: { $type: 'string' } }).select({ _id: 1, specialistId: 1, slotId: 1 }).lean().cursor();
  for await (const b of cursor as AsyncIterable<any>) {
    const slot = await SlotModel.findById(b.slotId).lean() as any;
    if (!slot || Number(slot.maxBookings ?? 1) !== 1 || !slot.date || !slot.startTime) continue;
    const d = String(slot.date);
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const start = istInstant(date, slot.startTime);
    const end = slot.endTime && slot.endTime > slot.startTime ? istInstant(date, slot.endTime) : new Date(start.getTime() + (Number(slot.duration) || 30) * 60_000);
    if (end <= now) continue;
    report.candidates += 1;
    if (!commit) continue;
    try {
      await runLedgerTransaction((s) => reserveInterval({ doctorId: String(b.specialistId), kind: 'scheduled', refId: String(b._id).toLowerCase(),
        start, end, branchId: slot.branchId }, s));
      report.reserved += 1;
    } catch (e: any) {
      if (e?.code !== 'DOCTOR_BUSY') throw e;
      report.conflicts.push(String(b._id));
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
