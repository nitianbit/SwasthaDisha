import logger from '@/services/logger';
import BookingModel from '@/modules/bookings/model';
import { bookerNames } from '@/modules/assisted/names';
import { appointmentIntervalOf, hasPrescription, rxWindowOpen, slotsOf } from '@/modules/assisted/rxAccess';
import { currentDispensingUrl, ensureDispensingCopy, queueDispensingCopy } from '@/modules/assisted/dispensingCopy';

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
// Review finding 9: not `message` (the doctor's free text may be clinical; the copy withholds it too).
const PRESCRIPTION_FIELDS = ['advice', 'medicines', 'testsAdvised', 'prescribedAt', 'prescribedBySpecialistName'] as const;
const LIFECYCLE_EVENTS = ['created', 'confirmed', 'completed', 'cancelled'] as const;
const JOIN_OPENS_BEFORE_MS = 10 * 60_000;
/** The booking payment window (bookings/holds.ts BOOKING_PAYMENT_WINDOW_MS; not imported, to keep this view free of the writers). */
const PAYMENT_WINDOW_MS = 30 * 60_000;

/** §5.1: rows written before `source` existed derive it (clinic desk, otherwise self). */
const sourceOf = (b: Row) => (typeof b.source === 'string' ? b.source : b.clinicDesk ? 'clinic_desk' : 'self');

export interface BookerViewOptions {
  /**
   * 'inline' (one booking: detail reads) makes a missing copy now, bounded by the converter timeout; 'queue' (lists,
   * payment answers) never converts in the request: the row shows `fileUrls: []` and `copyPending: true` and the copy is
   * queued (review finding 6).
   */
  copies?: 'inline' | 'queue';
  /** False when the pharmacy is no longer operational: no prescription at all (access ends with authority). */
  clinical?: boolean;
  now?: Date;
}

/** The copy state (url + internal hash) of each row, read fresh (callers' rows do not carry the hidden fields). */
async function withCopyState(rows: Row[]): Promise<Row[]> {
  const ids = rows.filter((r) => hasPrescription(r)).map((r) => r._id);
  if (!ids.length) return rows;
  const states = await BookingModel.find({ _id: { $in: ids } }).select({ 'prescription.dispensingCopy': 1 }).lean() as unknown as Row[];
  const by = new Map(states.map((x) => [String(x._id), x.prescription?.dispensingCopy]));
  return rows.map((r) => (by.has(String(r._id)) ? { ...r, prescription: { ...r.prescription, dispensingCopy: by.get(String(r._id)) } } : r));
}

/** The dispensing copy URL of each row that shows a prescription (null: none yet; a failure shows no file). */
async function dispensingUrls(rows: Row[], open: (b: Row) => boolean, mode: 'inline' | 'queue'): Promise<Map<Row, string | null>> {
  const out = new Map<Row, string | null>();
  for (const b of rows) {
    if (!open(b) || !hasPrescription(b)) continue;
    const current = currentDispensingUrl(b);
    if (current || mode === 'queue') {
      out.set(b, current);
      if (!current) await queueDispensingCopy(b._id);
      continue;
    }
    try {
      out.set(b, await ensureDispensingCopy(b));
    } catch (error) {
      logger.warn('Dispensing copy unavailable', { bookingId: String(b._id), error: error instanceof Error ? error.message : String(error) });
      out.set(b, null);
    }
  }
  return out;
}

export async function bookerViews(rows: Row[], pharmacyId: string, opts: BookerViewOptions = {}): Promise<Row[]> {
  const now = opts.now ?? new Date();
  const clinical = opts.clinical !== false;
  const list = await withCopyState(rows.filter((r) => r && typeof r === 'object').map((r) => (typeof r.toObject === 'function' ? r.toObject() : r)));
  if (!list.length) return [];
  const [slots, { patients: names, holders }] = await Promise.all([slotsOf(list), bookerNames(list, pharmacyId)]);
  const slotOf = (b: Row) => slots.get(String(b.slotId ?? ''));
  const open = (b: Row) => clinical && rxWindowOpen(b, slotOf(b), now);
  const copies = await dispensingUrls(list, open, opts.copies ?? 'queue');
  return list.map((b) => {
    const v: Row = {};
    for (const k of TOP_LEVEL) if (b[k] !== undefined) v[k] = b[k];
    v.source = sourceOf(b);
    v.patientName = names.get(String(b._id).toLowerCase()) ?? null;
    // r6: the account holder as this pharmacy sees it (same names rule) and THIS pharmacy's own link to them: the `:id`
    // of PUT /pharmacy-customers/:id/typed-name (null when it has no link), and the name typed on that link (r8 B6, null
    // when none). Never another pharmacy's link.
    const holder = holders.get(String(b.userId ?? '').toLowerCase());
    v.holder = { pharmacyCustomerId: holder?.linkId ?? null, name: holder?.name ?? null, typedName: holder?.typedName ?? null };
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
      // Phase 1a (§17.5): the "reported as not mine" badge (state only).
      if (b.assisted.identity?.disputed?.state) a.disputed = { state: b.assisted.identity.disputed.state };
      v.assisted = a;
      // r10c: how this booking is paid, for its OWN booker only (pay now / refund choice on any device). Never in the
      // patient's or the doctor's views (they strip `assisted.funding`); never another pharmacy's.
      const f = b.assisted.funding;
      if (f && b.assisted.bookedBy?.kind === 'pharmacy' && String(b.assisted.bookedBy.id).toLowerCase() === String(pharmacyId).toLowerCase()) {
        const card = f.method === 'razorpay';
        const waiting = card && f.state === 'pending' && b.status === 'pending' && b.createdAt;
        v.payment = { method: card ? 'razorpay' : 'wallet', state: f.state,
          payBy: waiting ? new Date(new Date(b.createdAt).getTime() + PAYMENT_WINDOW_MS).toISOString() : null,
          ...(card ? { paymentTransactionId: f.paymentRecordId ?? null } : {}) };
      }
    }
    // Join call: only when the partner's device joins (phase 1a bookings), from 10 minutes before the slot to its end.
    const interval = appointmentIntervalOf(b, slotOf(b));
    if (b.assisted?.join?.on === 'partner_device' && b.virtualMeeting?.joinUrl && interval
        && now.getTime() >= interval.start.getTime() - JOIN_OPENS_BEFORE_MS && now.getTime() <= interval.end.getTime()) {
      v.virtualMeeting = { joinUrl: b.virtualMeeting.joinUrl };
    }
    // The prescription for 90 days after the consultation (overnight H), without the diagnosis; its only file is the
    // dispensing copy. Afterwards the prescription is left out entirely.
    // Only a prescription the doctor saved counts (review finding 2).
    if (hasPrescription(b) && open(b)) {
      const p: Row = {};
      for (const k of PRESCRIPTION_FIELDS) if (b.prescription[k] !== undefined) p[k] = b.prescription[k];
      const url = copies.get(b);
      p.fileUrls = url ? [url] : [];
      if (!url) p.copyPending = true;
      v.prescription = p;
    }
    return v;
  });
}

export async function bookerView(row: Row, pharmacyId: string, opts: BookerViewOptions = {}): Promise<Row> {
  return (await bookerViews([row], pharmacyId, opts))[0]!;
}

/**
 * Review finding 4: every pharmacy answer of the generic booking routes that carries a booking (create, retry,
 * reconcile; `booking` inside the answer, or the answer itself) gets the strict booker view of it — the §17.2 shown list
 * only. Other answer fields (payment, flags) stay. Copies are never made in these requests.
 */
export async function withBookerBooking<T>(value: T, pharmacyId: string, opts: BookerViewOptions = {}): Promise<T> {
  const raw = value as unknown as Row;
  if (!raw || typeof raw !== 'object') return value;
  const row: Row = typeof raw.toObject === 'function' ? raw.toObject() : raw;
  if (row.booking && typeof row.booking === 'object') return { ...row, booking: await bookerView(row.booking, pharmacyId, { copies: 'queue', ...opts }) } as T;
  if (row._id && row.bookingType) return await bookerView(row, pharmacyId, { copies: 'queue', ...opts }) as T;
  return value;
}
