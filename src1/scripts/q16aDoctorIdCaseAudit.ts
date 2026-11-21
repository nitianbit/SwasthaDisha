/**
 * Q16a re-review (G): READ-ONLY audit of doctor ids stored in more than one letter case.
 *   npm run audit:q16a-doctor-id-case
 *
 * Lists (ids only — no names, phones or amounts):
 *   - doctors with more than one settlement account under different spellings of the same id (the lower-case one is
 *     the account new earnings use; the others need an admin decision);
 *   - bookings whose `specialistId` is not lower-case, and reservations / schedule guards keyed by a non-lower-case
 *     doctor id.
 * Writes nothing. Exit code 2 when anything is found.
 */
import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';
import BookingModel from '@/modules/bookings/model';
import { SettlementAccountModel } from '@/modules/partners/model/settlement';
import { DoctorReservationModel, DoctorScheduleGuardModel } from '@/modules/doctors/model/reservation';

export interface DoctorIdCaseReport {
  doubledAccounts: { doctorId: string; accountIds: string[]; canonicalAccountId: string | null }[];
  nonCanonicalBookings: string[];
  nonCanonicalReservations: string[];
  nonCanonicalGuards: string[];
}

const UPPER_HEX = /^(?=.*[A-F])[0-9a-fA-F]{24}$/;

export async function runDoctorIdCaseAudit(limit = 5000): Promise<DoctorIdCaseReport> {
  const groups = await SettlementAccountModel.aggregate([
    { $match: { ownerKind: 'doctor', ownerId: { $type: 'string' } } },
    { $group: { _id: { $toLower: '$ownerId' }, accounts: { $push: { id: '$_id', ownerId: '$ownerId' } }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]) as { _id: string; accounts: { id: unknown; ownerId: string }[] }[];
  const doubledAccounts = groups.map((g) => ({
    doctorId: g._id, accountIds: g.accounts.map((a) => String(a.id)).sort(),
    canonicalAccountId: (() => { const c = g.accounts.find((a) => a.ownerId === g._id); return c ? String(c.id) : null; })(),
  }));
  const ids = async (model: mongoose.Model<any>, field: string) =>
    (await model.find({ [field]: UPPER_HEX }).select({ _id: 1 }).limit(limit).lean() as { _id: unknown }[]).map((r) => String(r._id));
  return {
    doubledAccounts,
    nonCanonicalBookings: await ids(BookingModel, 'specialistId'),
    nonCanonicalReservations: await ids(DoctorReservationModel, 'doctorId'),
    nonCanonicalGuards: await ids(DoctorScheduleGuardModel, 'doctorId'),
  };
}

async function main(): Promise<void> {
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    const report = await runDoctorIdCaseAudit();
    console.log(JSON.stringify({ mode: 'read-only', ...report }, null, 2));
    if (report.doubledAccounts.length || report.nonCanonicalBookings.length || report.nonCanonicalReservations.length || report.nonCanonicalGuards.length) {
      console.log('FOUND: resolve the listed ids before relying on one account per doctor (nothing was changed).');
      process.exitCode = 2;
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
