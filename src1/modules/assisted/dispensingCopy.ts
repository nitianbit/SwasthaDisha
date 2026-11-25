import { createHash, randomBytes } from 'node:crypto';
import BookingModel from '@/modules/bookings/model';
import SpecialistModel from '@/modules/specialists/model';
import UserModel from '@/modules/user/model';
import DependentModel from '@/modules/dependents/model';
import { canonicalJson } from '@/modules/common/utils/canonicalJson';
import { ageFromDob, bookingPdfExists, escapeHtml, formatDisplayDate, recommendationBoxHtml, removeBookingPdf, writeBookingPdf } from '@/modules/specialistPortal/pdf';
import { formatRecommendationCode } from '@/modules/testRecommendations/code';
import { bookerPatientNames, maskName } from '@/modules/assisted/names';
import type { BookerRef } from '@/modules/assisted/bookers';
import { hasPrescription } from '@/modules/assisted/rxAccess';
import { Job } from '@/modules/queue/model';
import JobConsumer from '@/modules/queue/service/JobConsumer';
import type { JobPayload } from '@/modules/queue/types';
import logger from '@/services/logger';

type Row = Record<string, any>;

/**
 * Assisted booking phase 0, ASSUMED D15 (design §17.2): the DISPENSING COPY of a prescription — a server-written PDF
 * `bookings/<id>/rx-dispense-<ts>.pdf` with the doctor's name and registration, the patient's name, age and sex, the
 * date, the medicines, advice and tests advised, and the line "Dispensing copy: diagnosis withheld". It never carries
 * the diagnosis (nor the doctor's free-text message). It is the only prescription file a booker reads; the full PDF
 * stays with the patient and the doctor (file/access.ts).
 *
 * The booking stores `prescription.dispensingCopy {url, hash, at}` (`hash` and `at` are select: false; read them with
 * WITH_COPY_STATE); `hash` is over exactly the prescription content the copy shows, so a prescription saved again (any
 * writer) is noticed and a fresh copy made on the next request.
 * Review finding 3: every attempt writes its own file (`rx-dispense-<ms>-<random>.pdf`), the store is a compare-and-set
 * on the copy state that was read, a file whose URL is the stored one is never removed, and a stored copy whose file is
 * missing is made again.
 */
export const DISPENSING_COPY_FILE = /^rx-dispense-\d+(?:-[0-9a-f]{16})?\.pdf$/;
/** Projection that adds the copy's internal state to an ordinary booking read. */
export const WITH_COPY_STATE = '+prescription.dispensingCopy.hash +prescription.dispensingCopy.at';

export function dispensingHashOf(b: Row): string {
  const p = b.prescription ?? {};
  return createHash('sha256').update(canonicalJson({
    v: 1, specialistId: b.specialistId, medicines: p.medicines ?? [], advice: p.advice ?? '', testsAdvised: p.testsAdvised ?? [],
    prescribedAt: p.prescribedAt ?? '', prescribedBy: p.prescribedBySpecialistName ?? '',
    // Phase 3d (DR14): only when the prescription has a code, so the copies of older prescriptions stay current.
    ...(p.recommendationCode ? { recommendationCode: p.recommendationCode } : {}),
  })).digest('hex');
}

/** The current copy's URL: it reflects the booking's (doctor-saved) prescription as stored and its file is on disk. */
export function currentDispensingUrl(b: Row): string | null {
  if (!hasPrescription(b)) return null;
  const c = b?.prescription?.dispensingCopy;
  return c && typeof c.url === 'string' && c.hash === dispensingHashOf(b) && bookingPdfExists(c.url) ? c.url : null;
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
  ${p.recommendationCode ? recommendationBoxHtml(formatRecommendationCode(String(p.recommendationCode))) : ''}
  <div class="footer">Issued by Jansetu for dispensing only. The full prescription is with the patient and the doctor.</div>
</body>
</html>`;
}

/** The booker a dispensing copy is made for: the lab that booked it (2e), or the booking pharmacy (assisted or legacy). */
export const bookerOfBooking = (b: Row): BookerRef | null => (b?.assisted?.bookedBy?.kind === 'lab'
  ? { kind: 'lab', id: String(b.assisted.bookedBy.id).toLowerCase() } : b?.pharmacyId ? { kind: 'pharmacy', id: String(b.pharmacyId).toLowerCase() } : null);

/** Writes a fresh copy for the booking as it is now (no store). */
async function renderDispensingCopy(b: Row): Promise<string> {
  const [doctor, dependent, holder] = await Promise.all([
    b.specialistId ? SpecialistModel.findById(String(b.specialistId)).select({ name: 1, medicalRegistrationNumber: 1 }).lean() as unknown as Promise<Row | null> : null,
    b.dependentId ? DependentModel.findById(String(b.dependentId)).select({ userId: 1, gender: 1, dateOfBirth: 1, age: 1 }).lean() as unknown as Promise<Row | null> : null,
    UserModel.findById(String(b.userId)).select({ name: 1, gender: 1, dateOfBirth: 1 }).lean() as unknown as Promise<Row | null>,
  ]);
  const person = b.dependentId ? (dependent && String(dependent.userId).toLowerCase() === String(b.userId).toLowerCase() ? dependent : null) : holder;
  // The name the booker may see (§17.2; 2e: a lab booker's names rule); a booking without a booker names the patient masked.
  const booker = bookerOfBooking(b);
  const patientName = booker
    ? (await bookerPatientNames([b], booker)).get(String(b._id).toLowerCase()) ?? null
    : maskName(holder?.name);
  const age = ageFromDob(person?.dateOfBirth) ?? (typeof person?.age === 'number' ? person.age : null);
  const html = buildDispensingHtml({ booking: b, doctorName: String(doctor?.name || b.prescription?.prescribedBySpecialistName || b.doctorName || ''),
    registration: doctor?.medicalRegistrationNumber ?? null, patientName, age, sex: person?.gender ?? null });
  return writeBookingPdf(String(b._id), `rx-dispense-${Date.now()}-${randomBytes(8).toString('hex')}.pdf`, html);
}

/**
 * The booking's current dispensing copy, made when missing, stale or its file is gone (prescriptions saved before
 * phase 0 get theirs on the first booker request). `b` must carry the copy state (WITH_COPY_STATE). The new copy is
 * stored only while the booking still holds exactly the copy state that was read (compare-and-set on url + hash, and on
 * the prescription it was made from); losing that race removes only this attempt's own file and answers with the stored
 * copy. Null when the booking has no doctor-saved prescription. Throws when the PDF cannot be written.
 */
export async function ensureDispensingCopy(b: Row): Promise<string | null> {
  let row: Row | null = b;
  for (let attempt = 0; attempt < 3 && row; attempt++) {
    if (!row._id || !hasPrescription(row)) return null;
    const current = currentDispensingUrl(row);
    if (current) return current;
    const seen = row.prescription?.dispensingCopy;
    const hash = dispensingHashOf(row);
    const url = await renderDispensingCopy(row);
    const fence: Row = { _id: row._id, 'lifecycle.prescriptionUploaded.at': row.lifecycle.prescriptionUploaded.at,
      'prescription.prescribedAt': row.prescription.prescribedAt ?? null };
    if (seen && typeof seen.url === 'string') {
      fence['prescription.dispensingCopy.url'] = seen.url;
      fence['prescription.dispensingCopy.hash'] = seen.hash ?? null;
    } else {
      fence['prescription.dispensingCopy'] = { $exists: false };
    }
    const r = await BookingModel.updateOne(fence, { $set: { 'prescription.dispensingCopy': { url, hash, at: new Date() } } });
    if (r.modifiedCount === 1) return url;
    row = await BookingModel.findById(b._id).select(WITH_COPY_STATE).lean() as Row | null;
    // Never remove the stored copy's file (with unique names it is never ours, but check anyway).
    if (row?.prescription?.dispensingCopy?.url !== url) removeBookingPdf(url);
  }
  return row ? currentDispensingUrl(row) : null;
}

/** Reads the booking with its copy state and ensures the copy (consumer and single-booking callers). */
export async function ensureDispensingCopyById(bookingId: unknown): Promise<string | null> {
  const b = await BookingModel.findById(String(bookingId)).select(WITH_COPY_STATE).lean() as Row | null;
  return b ? ensureDispensingCopy(b) : null;
}

/**
 * Review finding 6: lists never convert inline. A missing copy is queued (one job per booking, `uniqueId` = the
 * booking) and made in the background by DispensingCopyConsumer, a few at a time, never in the request. Never throws.
 */
export const DISPENSING_COPY_CONSUMER = 'assistedDispensingCopy';
export async function queueDispensingCopy(bookingId: unknown): Promise<void> {
  try {
    const id = String(bookingId);
    await Job.findOneAndUpdate({ consumer: DISPENSING_COPY_CONSUMER, uniqueId: id },
      { $setOnInsert: { consumer: DISPENSING_COPY_CONSUMER, uniqueId: id, processAfter: Math.floor(Date.now() / 1000), payload: { bookingId: id } } },
      { upsert: true });
    setImmediate(() => { dispensingCopyConsumer.init().catch(() => undefined); });
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) return;
    logger.warn('Dispensing copy not queued', { bookingId: String(bookingId), error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Makes queued copies one at a time, in batches of BATCH, draining until the queue is empty — bounded per run at
 * MAX_PER_RUN (the scheduler's next run takes any rest).
 */
class DispensingCopyConsumer extends JobConsumer {
  static readonly BATCH = 10;
  static readonly MAX_PER_RUN = 200;
  private draining = false;
  constructor() { super(DISPENSING_COPY_CONSUMER); }

  async init(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let done = 0; done < DispensingCopyConsumer.MAX_PER_RUN;) {
        let batch = 0;
        for (; batch < DispensingCopyConsumer.BATCH && done < DispensingCopyConsumer.MAX_PER_RUN; batch++, done++) {
          const now = Math.floor(Date.now() / 1000);
          const job = await Job.findOneAndUpdate({ consumer: this.type, processAfter: { $lte: now } },
            { $set: { processAfter: now + 120 } }, { sort: { processAfter: 1 } });
          if (!job) return; // the queue is empty
          await this.consume(job.payload);
          await Job.deleteOne({ _id: job._id });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** One attempt per job: a failure is logged and the next list read queues the booking again. */
  async consume(payload: JobPayload): Promise<boolean> {
    try {
      await ensureDispensingCopyById(payload.bookingId);
    } catch (error) {
      logger.warn('Dispensing copy not made in the background', { bookingId: String(payload.bookingId),
        error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
}

export const dispensingCopyConsumer = new DispensingCopyConsumer();
