// S4 audit (read-only): booking prescriptions and reports a client may have written before S4, for an admin to review.
//
//   npm run audit:s4-client-prescriptions      prints one JSON report to stdout
//
// Lists ids only (no names, medicines, notes or file URLs):
//   - bookings: every booking with a `prescription` or `report`, when at least one of these holds:
//       prescriptionWithoutMarker  a prescription without lifecycle.prescriptionUploaded (the doctor's endpoint sets it);
//       prescriberNotSpecialist    prescription.prescribedBySpecialistId is set and differs from the booking's specialistId;
//       report                     a report (bookings have no server marker for reports: before S4 a client could write
//                                  one at create, after S4 only an admin edit can; review each);
//   - linkedPharmacyOrders: pharmacy orders whose linkedConsultationId is one of those bookings.
// It only reads (find); it writes nothing and creates no collection or index.
import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';
import BookingModel from '@/modules/bookings/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';

export type S4Reason = 'prescriptionWithoutMarker' | 'prescriberNotSpecialist' | 'report';

export interface S4ClientPrescriptionAudit {
  generatedAt: string;
  bookings: {
    bookingId: string; userId: string | null; specialistId: string | null; pharmacyId: string | null;
    prescribedBySpecialistId: string | null; reasons: S4Reason[]; createdAt: string | null;
  }[];
  linkedPharmacyOrders: { orderId: string; bookingId: string; pharmacyId: string | null }[];
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null);
const idOrNull = (v: unknown) => (v == null || v === '' ? null : String(v));

export async function auditS4ClientPrescriptions(): Promise<S4ClientPrescriptionAudit> {
  const bookings: S4ClientPrescriptionAudit['bookings'] = [];
  for await (const b of BookingModel.find({ $or: [{ prescription: { $type: 'object' } }, { report: { $type: 'object' } }] })
    .select({ userId: 1, specialistId: 1, pharmacyId: 1, 'prescription.prescribedBySpecialistId': 1, 'lifecycle.prescriptionUploaded': 1,
      report: 1, createdAt: 1 })
    .sort({ _id: 1 }).lean().cursor()) {
    const reasons: S4Reason[] = [];
    const prescribedBy = idOrNull(b.prescription?.prescribedBySpecialistId);
    if (b.prescription) {
      if (!b.lifecycle?.prescriptionUploaded?.at) reasons.push('prescriptionWithoutMarker');
      if (prescribedBy !== null && prescribedBy !== idOrNull(b.specialistId)) reasons.push('prescriberNotSpecialist');
    }
    if (b.report) reasons.push('report');
    if (!reasons.length) continue;
    bookings.push({ bookingId: String(b._id), userId: idOrNull(b.userId), specialistId: idOrNull(b.specialistId),
      pharmacyId: idOrNull(b.pharmacyId), prescribedBySpecialistId: prescribedBy, reasons, createdAt: iso(b.createdAt) });
  }

  const linkedPharmacyOrders: S4ClientPrescriptionAudit['linkedPharmacyOrders'] = [];
  const flagged = bookings.filter((b) => b.reasons.some((r) => r !== 'report')).map((b) => new mongoose.Types.ObjectId(b.bookingId));
  for (let i = 0; i < flagged.length; i += 500) {
    for await (const o of PharmacyOrderModel.find({ linkedConsultationId: { $in: flagged.slice(i, i + 500) } })
      .select({ linkedConsultationId: 1, pharmacyId: 1 }).sort({ _id: 1 }).lean().cursor()) {
      linkedPharmacyOrders.push({ orderId: String(o._id), bookingId: String(o.linkedConsultationId), pharmacyId: idOrNull(o.pharmacyId) });
    }
  }
  return { generatedAt: new Date().toISOString(), bookings, linkedPharmacyOrders };
}

async function main() {
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    const report = await auditS4ClientPrescriptions();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    const count = (r: S4Reason) => report.bookings.filter((b) => b.reasons.includes(r)).length;
    process.stderr.write(`bookings to review: ${report.bookings.length} (prescription without marker: ${count('prescriptionWithoutMarker')}; ` +
      `prescriber not the booking's doctor: ${count('prescriberNotSpecialist')}; report: ${count('report')}); ` +
      `pharmacy orders linked to them: ${report.linkedPharmacyOrders.length}\n`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
