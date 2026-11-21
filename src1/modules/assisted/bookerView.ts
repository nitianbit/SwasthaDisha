import logger from '@/services/logger';
import { bookerPatientNames } from '@/modules/assisted/names';
import { appointmentIntervalOf, hasPrescription, rxWindowOpen, slotsOf } from '@/modules/assisted/rxAccess';
import { ensureDispensingCopy } from '@/modules/assisted/dispensingCopy';

type Row = Record<string, any>;

/**
 * Assisted booking phase 0, §17.2 / P6: the BOOKER VIEW of a booking a pharmacy made — the allowlist below, with the raw
 * field names, so the released pharmacy app keeps reading the same keys. It is what `GET /pharmacy-bookings*` returns
 * and what the S2-scoped generic `/bookings` reads return to a pharmacy. Never the diagnosis, the full prescription
 * PDF, the booking's documents or report, notes, money internals or request keys.
 */
const TOP_LEVEL = ['_id', 'bookingType', 'bookingKind', 'userId', 'dependentId', 'pharmacyId', 'specialistId', 'doctorName',
  'primaryConcern', 'consultationMode', 'serviceMode', 'clinicVisit', 'slotId', 'bookingDate', 'bookingTime', 'contactNo', 'status',
  'paymentStatus', 'price', 'originalPrice', 'cancellationReason', 'cancelledAt', 'cancellationCause', 'createdAt', 'updatedAt'] as const;
const PRESCRIPTION_FIELDS = ['message', 'advice', 'medicines', 'testsAdvised', 'prescribedAt', 'prescribedBySpecialistName'] as const;
const LIFECYCLE_EVENTS = ['created', 'confirmed', 'completed', 'cancelled'] as const;
const JOIN_OPENS_BEFORE_MS = 10 * 60_000;

/** §5.1: rows written before `source` existed derive it (clinic desk, otherwise self). */
const sourceOf = (b: Row) => (typeof b.source === 'string' ? b.source : b.clinicDesk ? 'clinic_desk' : 'self');

/** The dispensing copy URL of each row that shows a prescription (made when missing; a failure shows no file). */
async function dispensingUrls(rows: Row[], open: (b: Row) => boolean): Promise<Map<Row, string | null>> {
  const out = new Map<Row, string | null>();
  // One at a time: a page of old prescriptions without copies converts sequentially, never a burst of converters.
  for (const b of rows) {
    if (!open(b) || !hasPrescription(b.prescription)) continue;
    try {
      out.set(b, await ensureDispensingCopy(b));
    } catch (error) {
      logger.warn('Dispensing copy unavailable', { bookingId: String(b._id), error: error instanceof Error ? error.message : String(error) });
      out.set(b, null);
    }
  }
  return out;
}

export async function bookerViews(rows: Row[], pharmacyId: string, now: Date = new Date()): Promise<Row[]> {
  const list = rows.filter((r) => r && typeof r === 'object').map((r) => (typeof r.toObject === 'function' ? r.toObject() : r));
  if (!list.length) return [];
  const [slots, names] = await Promise.all([slotsOf(list), bookerPatientNames(list, pharmacyId)]);
  const slotOf = (b: Row) => slots.get(String(b.slotId ?? ''));
  const open = (b: Row) => rxWindowOpen(b, slotOf(b), now);
  const copies = await dispensingUrls(list, open);
  return list.map((b) => {
    const v: Row = {};
    for (const k of TOP_LEVEL) if (b[k] !== undefined) v[k] = b[k];
    v.source = sourceOf(b);
    v.patientName = names.get(String(b._id).toLowerCase()) ?? null;
    if (b.noShow?.at) v.noShow = { at: b.noShow.at };
    const lifecycle: Row = {};
    for (const e of LIFECYCLE_EVENTS) if (b.lifecycle?.[e]?.at) lifecycle[e] = { at: b.lifecycle[e].at };
    if (Object.keys(lifecycle).length) v.lifecycle = lifecycle;
    if (b.assisted && typeof b.assisted === 'object') {
      const a: Row = {};
      if (b.assisted.shortRef !== undefined) a.shortRef = b.assisted.shortRef;
      if (b.assisted.bookedBy?.name !== undefined) a.bookedBy = { name: b.assisted.bookedBy.name };
      if (b.assisted.join?.on !== undefined) a.join = { on: b.assisted.join.on };
      if (b.assisted.preferredLanguage !== undefined) a.preferredLanguage = b.assisted.preferredLanguage;
      v.assisted = a;
    }
    // Join call: only when the partner's device joins (phase 1a bookings), from 10 minutes before the slot to its end.
    const interval = appointmentIntervalOf(b, slotOf(b));
    if (b.assisted?.join?.on === 'partner_device' && b.virtualMeeting?.joinUrl && interval
        && now.getTime() >= interval.start.getTime() - JOIN_OPENS_BEFORE_MS && now.getTime() <= interval.end.getTime()) {
      v.virtualMeeting = { joinUrl: b.virtualMeeting.joinUrl };
    }
    // The prescription for 90 days after the consultation (overnight H), without the diagnosis; its only file is the
    // dispensing copy. Afterwards the prescription is left out entirely.
    if (hasPrescription(b.prescription) && open(b)) {
      const p: Row = {};
      for (const k of PRESCRIPTION_FIELDS) if (b.prescription[k] !== undefined) p[k] = b.prescription[k];
      const url = copies.get(b);
      p.fileUrls = url ? [url] : [];
      v.prescription = p;
    }
    return v;
  });
}

export async function bookerView(row: Row, pharmacyId: string, now: Date = new Date()): Promise<Row> {
  return (await bookerViews([row], pharmacyId, now))[0]!;
}

/**
 * For pharmacy answers of the generic booking routes that are not plain reads (create, retry, reconcile, payment
 * details): the booking inside keeps its fields (the released app's payment flow reads them), but its clinical part
 * is the booker's — the prescription as in the booker view, and no documents or report.
 */
export async function withBookerClinicalView<T>(value: T, pharmacyId: string): Promise<T> {
  const raw = value as unknown as Row;
  if (!raw || typeof raw !== 'object') return value;
  const row: Row = typeof raw.toObject === 'function' ? raw.toObject() : raw;
  if (row.booking && typeof row.booking === 'object') return { ...row, booking: await withBookerClinicalView(row.booking, pharmacyId) } as T;
  if (!('prescription' in row) && !('documents' in row) && !('report' in row)) return value;
  const view = await bookerView(row, pharmacyId);
  const { prescription: _p, documents: _d, report: _r, ...rest } = row;
  return { ...rest, ...(view.prescription ? { prescription: view.prescription } : {}) } as T;
}
