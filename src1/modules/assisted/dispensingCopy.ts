import { createHash } from 'node:crypto';
import BookingModel from '@/modules/bookings/model';
import SpecialistModel from '@/modules/specialists/model';
import UserModel from '@/modules/user/model';
import DependentModel from '@/modules/dependents/model';
import { canonicalJson } from '@/modules/common/utils/canonicalJson';
import { ageFromDob, escapeHtml, formatDisplayDate, removeBookingPdf, writeBookingPdf } from '@/modules/specialistPortal/pdf';
import { bookerPatientNames, maskName } from '@/modules/assisted/names';
import { hasPrescription } from '@/modules/assisted/rxAccess';

type Row = Record<string, any>;

/**
 * Assisted booking phase 0, ASSUMED D15 (design §17.2): the DISPENSING COPY of a prescription — a server-written PDF
 * `bookings/<id>/rx-dispense-<ts>.pdf` with the doctor's name and registration, the patient's name, age and sex, the
 * date, the medicines, advice and tests advised, and the line "Dispensing copy: diagnosis withheld". It never carries
 * the diagnosis (nor the doctor's free-text message). It is the only prescription file a booker reads; the full PDF
 * stays with the patient and the doctor (file/access.ts).
 *
 * The booking stores `prescription.dispensingCopy {url, hash, at}`; `hash` is over exactly the prescription content the
 * copy shows, so a prescription saved again (any writer) is noticed and a fresh copy made on the next request.
 */
export const DISPENSING_COPY_FILE = /^rx-dispense-\d+\.pdf$/;

export function dispensingHashOf(b: Row): string {
  const p = b.prescription ?? {};
  return createHash('sha256').update(canonicalJson({
    v: 1, specialistId: b.specialistId, medicines: p.medicines ?? [], advice: p.advice ?? '', testsAdvised: p.testsAdvised ?? [],
    prescribedAt: p.prescribedAt ?? '', prescribedBy: p.prescribedBySpecialistName ?? '',
  })).digest('hex');
}

/** The current copy's URL when it reflects the booking's prescription as stored. */
export function currentDispensingUrl(b: Row): string | null {
  const c = b?.prescription?.dispensingCopy;
  return c && typeof c.url === 'string' && c.hash === dispensingHashOf(b) ? c.url : null;
}

const MEDICINE_FIELDS: [string, string][] = [['dosage', 'Dose'], ['frequency', 'Frequency'], ['duration', 'Duration'], ['instructions', 'Instructions']];

export function buildDispensingHtml(input: { booking: Row; doctorName: string; registration?: string | null; patientName: string | null;
  age: number | null; sex?: string | null }): string {
  const p = input.booking.prescription ?? {};
  const medicines: Row[] = Array.isArray(p.medicines) ? p.medicines : [];
  const tests: string[] = Array.isArray(p.testsAdvised) ? p.testsAdvised : [];
  const medicinesHtml = medicines.length
    ? medicines.map((m) => `<tr><td class="med">${escapeHtml(String(m.name ?? ''))}</td>${MEDICINE_FIELDS.map(([k]) =>
      `<td>${escapeHtml(String(m[k] ?? ''))}</td>`).join('')}</tr>`).join('')
    : '<tr><td colspan="5">No medicines prescribed.</td></tr>';
  const testsHtml = tests.length ? `<ul>${tests.map((t) => `<li>${escapeHtml(String(t))}</li>`).join('')}</ul>` : '<p>No tests advised.</p>';
  const advice = p.advice ? escapeHtml(String(p.advice)).replace(/\n/g, '<br />') : 'No advice recorded.';
  const ref = escapeHtml(`APT-${String(input.booking._id).slice(-4).toUpperCase()}`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Dispensing copy</title>
  <style>
    body { margin: 0; padding: 28px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2937; }
    .brand { font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; color: #0f766e; font-weight: 700; }
    h1 { font-size: 24px; margin: 6px 0 4px; }
    .withheld { display: inline-block; margin: 8px 0 16px; padding: 6px 10px; border: 1px solid #f59e0b; background: #fffbeb; color: #92400e; font-weight: 700; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 18px; font-size: 14px; }
    th, td { border: 1px solid #e5e7eb; padding: 7px 9px; text-align: left; vertical-align: top; }
    th { background: #f8fafc; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #475569; }
    td.med { font-weight: 700; }
    h2 { font-size: 16px; color: #0f766e; margin: 18px 0 8px; }
    .meta td { border: 0; padding: 3px 12px 3px 0; }
    .label { color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
    .footer { margin-top: 24px; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="brand">Jansetu</div>
  <h1>Prescription — dispensing copy</h1>
  <div class="withheld">Dispensing copy: diagnosis withheld</div>
  <table class="meta">
    <tr><td><span class="label">Doctor</span><br />${escapeHtml(input.doctorName || 'Doctor')}</td>
      <td><span class="label">Registration</span><br />${escapeHtml(input.registration || 'Not recorded')}</td>
      <td><span class="label">Date</span><br />${escapeHtml(formatDisplayDate(String(input.booking.bookingDate ?? '')))}</td>
      <td><span class="label">Reference</span><br />${ref}</td></tr>
    <tr><td><span class="label">Patient</span><br />${escapeHtml(input.patientName || 'Patient')}</td>
      <td><span class="label">Age</span><br />${input.age !== null ? escapeHtml(String(input.age)) : 'N/A'}</td>
      <td><span class="label">Sex</span><br />${escapeHtml(input.sex || 'N/A')}</td><td></td></tr>
  </table>
  <h2>Medicines</h2>
  <table><tr><th>Medicine</th>${MEDICINE_FIELDS.map(([, label]) => `<th>${label}</th>`).join('')}</tr>${medicinesHtml}</table>
  <h2>Advice</h2>
  <p>${advice}</p>
  <h2>Tests advised</h2>
  ${testsHtml}
  <div class="footer">Issued by Jansetu for dispensing only. The full prescription is with the patient and the doctor.</div>
</body>
</html>`;
}

/** Writes a fresh copy for the booking as it is now (no store). */
async function renderDispensingCopy(b: Row): Promise<string> {
  const [doctor, dependent, holder] = await Promise.all([
    b.specialistId ? SpecialistModel.findById(String(b.specialistId)).select({ name: 1, medicalRegistrationNumber: 1 }).lean() as unknown as Promise<Row | null> : null,
    b.dependentId ? DependentModel.findById(String(b.dependentId)).select({ userId: 1, gender: 1, dateOfBirth: 1, age: 1 }).lean() as unknown as Promise<Row | null> : null,
    UserModel.findById(String(b.userId)).select({ name: 1, gender: 1, dateOfBirth: 1 }).lean() as unknown as Promise<Row | null>,
  ]);
  const person = b.dependentId ? (dependent && String(dependent.userId).toLowerCase() === String(b.userId).toLowerCase() ? dependent : null) : holder;
  // The name the booking pharmacy may see (§17.2); a booking without a booker names the patient masked as well.
  const patientName = b.pharmacyId
    ? (await bookerPatientNames([b], String(b.pharmacyId))).get(String(b._id).toLowerCase()) ?? null
    : maskName(holder?.name);
  const age = ageFromDob(person?.dateOfBirth) ?? (typeof person?.age === 'number' ? person.age : null);
  const html = buildDispensingHtml({ booking: b, doctorName: String(b.prescription?.prescribedBySpecialistName || doctor?.name || b.doctorName || ''),
    registration: doctor?.medicalRegistrationNumber ?? null, patientName, age, sex: person?.gender ?? null });
  return writeBookingPdf(String(b._id), `rx-dispense-${Date.now()}.pdf`, html);
}

/**
 * The booking's current dispensing copy, made when missing or stale (prescriptions saved before phase 0 get theirs on the
 * first booker request). Idempotent: the copy is stored only while the booking does not already hold a current one; a
 * copy that lost that race is removed and the stored one returned. Null when the booking has no prescription. Throws
 * when the PDF cannot be written.
 */
export async function ensureDispensingCopy(b: Row): Promise<string | null> {
  if (!b?._id || !hasPrescription(b.prescription)) return null;
  const current = currentDispensingUrl(b);
  if (current) return current;
  const hash = dispensingHashOf(b);
  const url = await renderDispensingCopy(b);
  const r = await BookingModel.updateOne(
    { _id: b._id, prescription: { $exists: true }, 'prescription.dispensingCopy.hash': { $ne: hash } },
    { $set: { 'prescription.dispensingCopy': { url, hash, at: new Date() } } });
  if (r.modifiedCount === 1) return url;
  removeBookingPdf(url);
  const now = await BookingModel.findById(b._id).lean() as Row | null;
  return now ? currentDispensingUrl(now) : null;
}
