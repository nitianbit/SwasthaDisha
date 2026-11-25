import logger from '@/services/logger';
import BookingModel from '@/modules/bookings/model';
import DependentModel from '@/modules/dependents/model';
import UserModel from '@/modules/user/model';
import PartnerOrgModel from '@/modules/partners/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { appointmentIntervalOf, hasPrescription, slotsOf } from '@/modules/assisted/rxAccess';
import { unpaidCardBooking } from '@/modules/assisted/views';
import { isUnpaidCardLab } from '@/modules/assisted/labViews';
import { isDeskRow, isWalkIn, partnerOriginOf } from '@/modules/assisted/deskViews';
import { IST_OFFSET_MS, businessClock, istDateIso, istTimeHhmm } from '@/modules/common/utils/istDate';
import { SmsNoticeModel, type ISmsNotice, type SmsEvent } from '@/modules/smsNotices/model';
import { enqueueSms, setSmsComposer, type SmsComposer } from '@/modules/smsNotices/outbox';
import { smsFlags } from '@/modules/smsNotices/flags';
import { wordsFor, type SmsMessage, type SmsWords } from '@/modules/smsNotices/templates';
import { linkTokenFor } from '@/modules/smsNotices/joinLink';

/**
 * Phase 5b (ASSISTED_BOOKING_DESIGN.md §27.6): the booking events that send an SMS, and what each one says.
 *
 * - **Hooks.** One call per event, after the booking's commit (`smsBooked`, `smsRxReady`, `smsReportReady`,
 *   `smsCancelled`, `smsMoved`, `smsMovedOff`), made with `void` (fire and forget). Each never throws and only queues a
 *   row (`enqueueSms`): nothing here can change, fail or delay a booking. The caller decides whether the event is one that sends (not what the patient
 *   did in the app, not a lab's proposal); these helpers keep the rows in scope: partner-made consultations (instant
 *   ones too) and lab bookings, and lab desk rows — never a customer's own booking, a clinic desk booking, a legacy
 *   pharmacy booking or an unpaid card booking (never announced, C7). A desk walk-in (tested on arrival) only hears of
 *   its report.
 * - **Composer.** One for every event, registered with the drain (`registerSmsComposers`): it reads the booking again
 *   when the row is due, skips it when the event is no longer true (`stale`, §27.6.2) or the holder reported it as not
 *   theirs (`disputed`), and builds the variables from the booking as it is then (the outbox holds no personal data).
 */
type Row = Record<string, any>;
type Kind = 'booking' | 'lab_booking';
type NoticeEvent = Exclude<SmsEvent, 'test'>;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
/** An instant consultation's "booked" is news for an hour after the doctor accepted (§27.6.2). */
const INSTANT_BOOKED_MS = 60 * MIN_MS;
/** Lab statuses from "confirmed" on, not cancelled (a "booked" notice is still true). */
const LAB_BOOKED = ['confirmed', 'sample_collected', 'visited', 'processing', 'report_ready', 'completed'];
/** A desk walk-in was tested on arrival: never told it is booked, cancelled or moved. */
const NOT_FOR_WALK_INS: SmsEvent[] = ['booked', 'cancelled', 'moved', 'reminder'];

type Origin = NonNullable<ReturnType<typeof partnerOriginOf>>;
/** Who made the row when it is in scope (§27.4), else null. */
function inScope(kind: Kind, b: Row | null | undefined, event: SmsEvent): Origin | null {
  const o = partnerOriginOf(b);
  if (!o) return null;
  // A consultation's origin is its `assisted` block only (a desk block belongs to lab rows).
  if (kind === 'booking' && o.root !== 'assisted') return null;
  if (kind === 'booking' ? unpaidCardBooking(b) : isUnpaidCardLab(b)) return null;
  if (kind === 'lab_booking' && isWalkIn(b) && NOT_FOR_WALK_INS.includes(event)) return null;
  return o;
}

/** When the visit starts: the consultation's slot (an instant one: the acceptance), the lab slot. */
async function startOf(kind: Kind, b: Row): Promise<Date | null> {
  if (kind === 'lab_booking') {
    const t = new Date(b.slot?.startsAt ?? NaN).getTime();
    return Number.isFinite(t) ? new Date(t) : null;
  }
  return appointmentIntervalOf(b, (await slotsOf([b])).get(String(b.slotId ?? '')))?.start ?? null;
}
const minutesOf = (d: Date) => String(Math.floor(d.getTime() / MIN_MS));
/**
 * A move's version: `<the new start in epoch minutes>:<the move's write, epoch ms>`. Every move writes the booking, so a
 * move back to an earlier time (B → C → B) has its own key and is told (phase 5 stores no counter on a booking).
 */
const moveVersionOf = (start: Date, b: Row) => `${minutesOf(start)}:${new Date(b.updatedAt ?? Date.now()).getTime()}`;

// ───────────────────────────── Hooks (after the commit) ─────────────────────────────

/** The enqueues still running (hooks are fire and forget): `smsHooksSettled` waits for them (tests, shutdown). */
const inFlight = new Set<Promise<void>>();
export async function smsHooksSettled(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight]);
}

/** r34: a version, or a version with its due time (the reminder). */
type Version = string | { version: string; dueAt: Date; rearmSkipped?: boolean } | null;
function queue(kind: Kind, b: Row | null | undefined, event: NoticeEvent, version: () => Promise<Version> | Version,
  recipientUserId?: string): Promise<void> {
  const p = (async () => {
    try {
      if (!smsFlags.enabled() || !b?._id || !inScope(kind, b, event)) return;
      const v = await version();
      if (v) await enqueueSms({ bookingKind: kind, bookingId: String(b._id), event, ...(typeof v === 'string' ? { version: v } : v),
        ...(recipientUserId ? { recipientUserId: String(recipientUserId) } : {}) });
    } catch {
      logger.warn('sms enqueue skipped', { event, bookingKind: kind, reason: 'enqueue_failed' });
    }
  })();
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return p;
}

/** India-time hour of `t`, and `t`'s India day at `hour`:00 (`days` later). */
const istHourOf = (t: number) => Math.floor((((t + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / (60 * MIN_MS));
const istDayAt = (t: number, hour: number, days = 0) => t - ((((t + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS) + days * DAY_MS + hour * 60 * MIN_MS;
/** No reminder SMS from 21:00 to before 07:00 India time (SM14). */
const quietHour = (t: number) => istHourOf(t) >= 21 || istHourOf(t) < 7;
const HOUR_MS = 60 * MIN_MS;

/**
 * r34 (§27.7, SM14): when a visit's reminder is due — SMS_VISIT_REMINDER_MINUTES_BEFORE (120) before the start; a due
 * time in the quiet hours (21:00 to before 07:00 India time) moves back to the 20:00 before it. A due time under 60
 * minutes from now gives no reminder (the "booked" SMS has just gone), except (r34b, coordinator): when the 20:00 of the
 * night rule is under 60 minutes away, 07:00 on the visit's day is used if it is at least 60 minutes from now and at
 * least 60 minutes before the visit.
 */
export function reminderDueAt(start: Date, now: Date): Date | null {
  const soon = now.getTime() + HOUR_MS;
  let due = start.getTime() - smsFlags.reminderMinutesBefore() * MIN_MS;
  if (quietHour(due)) {
    due = istDayAt(due, 20, istHourOf(due) >= 21 ? 0 : -1);
    if (due < soon) {
      const morning = istDayAt(start.getTime(), 7);
      return morning >= soon && start.getTime() - morning >= HOUR_MS ? new Date(morning) : null;
    }
  }
  return due < soon ? null : new Date(due);
}

/**
 * r34 (§27.7): one reminder per visit, queued with "booked" and with every move (version = the start in epoch minutes,
 * so a move queues a new one and the old one is stale when due). Never for an instant consultation or a desk walk-in.
 * r34b: also on its own where a new time needs no "moved" SMS (the patient accepted a lab's new time in the app).
 */
export const smsReminder = (kind: Kind, b: Row | null | undefined) => (b?.bookingKind === 'instant' ? Promise.resolve() : queue(kind, b, 'reminder', async () => {
  const start = await startOf(kind, b!);
  const dueAt = start ? reminderDueAt(start, new Date(businessClock.now())) : null;
  // r34c: one row per visit time; one skipped when the visit moved away is armed again when it moves back (rearmSkipped).
  return start && dueAt ? { version: minutesOf(start), dueAt, rearmSkipped: true } : null;
}));

/** Booked and paid (a wallet create, a card confirmation, an instant acceptance, a desk booking with a slot); r34: its reminder. */
export const smsBooked = (kind: Kind, b: Row | null | undefined) => Promise.all([queue(kind, b, 'booked', () => '1'), smsReminder(kind, b)]).then(() => undefined);
/** The doctor's first prescription save (the caller checks "first"). */
export const smsRxReady = (b: Row | null | undefined) => queue('booking', b, 'rx_ready', () => '1');
/** The lab's first report release (the caller checks "first"). */
export const smsReportReady = (b: Row | null | undefined) => queue('lab_booking', b, 'report_ready', () => '1');
/** Cancelled by someone other than the patient in the app. */
export const smsCancelled = (kind: Kind, b: Row | null | undefined) => queue(kind, b, 'cancelled', () => '1');
/**
 * Moved to a new time (every move is its own notice; only the latest one is sent, §27.13.7); r34: the new time's
 * reminder.
 */
export const smsMoved = (kind: Kind, b: Row | null | undefined) => Promise.all([
  queue(kind, b, 'moved', async () => {
    const start = await startOf(kind, b!);
    return start ? moveVersionOf(start, b!) : null;
  }),
  smsReminder(kind, b),
]).then(() => undefined);
/**
 * The admin account move (SM17): the previous holder hears "moved to another number"; the new holder is told it is
 * booked. Version `move:<n>`, n = the moves made so far.
 */
export async function smsMovedOff(kind: Kind, b: Row | null | undefined, fromUserId: string): Promise<void> {
  const version = `move:${partnerOriginOf(b)?.moves.length ?? 0}`;
  await queue(kind, b, 'moved_off', () => version, fromUserId);
  await queue(kind, b, 'booked', () => version);
}

// ───────────────────────────── What each event says (at send time) ─────────────────────────────

/** Names (`name`, `place`): letters of any script, combining marks and single spaces only (§10.2). */
const cleanName = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').replace(/[^\p{L}\p{M} ]/gu, '').replace(/ +/g, ' ').trim();
const firstWord = (v: unknown) => cleanName(v).split(' ')[0] ?? '';
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const nameOf = async (model: 'user' | 'dependent', id: unknown): Promise<string> => {
  if (!OBJECT_ID.test(String(id ?? ''))) return '';
  const r = (model === 'user' ? await UserModel.findById(String(id)).select({ name: 1 }).lean() : await DependentModel.findById(String(id)).select({ name: 1 }).lean());
  return String((r as { name?: string } | null)?.name ?? '');
};

/**
 * The patient's first name: the family member's, else (lab) the booking's patient name, else the holder's account
 * name. `moved_off` goes to the previous holder, who is never told who holds it now: their own account name.
 */
async function patientName(kind: Kind, b: Row, row: ISmsNotice): Promise<string> {
  if (row.event === 'moved_off') return firstWord(await nameOf('user', row.recipientUserId));
  const dependentId = kind === 'booking' ? b.dependentId : b.patient?.kind === 'dependent' ? b.patient.dependentId : undefined;
  const candidates = [dependentId ? await nameOf('dependent', dependentId) : '', kind === 'lab_booking' && b.patient?.kind !== 'dependent' ? b.patient?.name : ''];
  for (const c of candidates) if (firstWord(c)) return firstWord(c);
  return firstWord(await nameOf('user', b.userId));
}

/**
 * `place` (§27.6.3), in the words of the text's language: the partner that booked; the lab for a report, a desk row and
 * a lab test a doctor booked (a notice never names a doctor, §10.2). r34, the reminder: "Jansetu app" for a video
 * consultation on the patient's phone, "the clinic" for a clinic visit, "home" for a home collection, else the booker
 * (a consultation on the partner's device) or the lab.
 */
async function placeOf(kind: Kind, b: Row, event: NoticeEvent): Promise<(w: SmsWords) => string> {
  if (event === 'reminder') {
    if (kind === 'booking' && b.consultationMode === 'in-person') return (w) => w.theClinic;
    if (kind === 'booking' && b.assisted?.join?.on === 'patient_phone') return (w) => w.jansetuApp;
    if (kind === 'lab_booking' && b.visitMode === 'home') return (w) => w.home;
  }
  const lab = kind === 'lab_booking' && (event === 'report_ready' || event === 'reminder' || isDeskRow(b) || b.assisted?.bookedBy?.kind === 'doctor');
  const name = cleanName(lab ? ((await PartnerOrgModel.findById(String(b.partnerId)).select({ name: 1 }).lean()) as { name?: string } | null)?.name
    : b.assisted?.bookedBy?.name);
  return () => name;
}

const shownDate = (d: Date) => istDateIso(d).split('-').reverse().join('-');

/**
 * Whether the event is still true when the row is due (§27.6.2). A "booked" is for the current holder only: one queued
 * before an account move is stale (the move queues the new holder's own, `move:<n>`), so nobody hears it twice. A
 * "moved" is true while the booking still starts at its time and no later move was queued (B → C → B: one SMS).
 */
async function stillTrue(kind: Kind, b: Row, o: Origin, row: ISmsNotice, start: Date | null, now: Date): Promise<boolean> {
  const age = now.getTime() - new Date(row.createdAt ?? now).getTime();
  switch (row.event) {
    case 'booked':
      if (!start || row.version !== (o.moves.length ? `move:${o.moves.length}` : '1')) return false;
      if (kind === 'lab_booking') return LAB_BOOKED.includes(b.status) && now < start;
      return b.status === 'confirmed' && b.paymentStatus === 'paid'
        && now.getTime() < start.getTime() + (b.bookingKind === 'instant' ? INSTANT_BOOKED_MS : 0);
    case 'rx_ready': return hasPrescription(b) && age <= 3 * DAY_MS;
    case 'report_ready': return (b.report?.releases ?? []).length > 0 && age <= 3 * DAY_MS;
    case 'cancelled': return b.status === 'cancelled' && age <= DAY_MS;
    case 'moved':
      if (b.status === 'cancelled' || !start || minutesOf(start) !== row.version.split(':')[0] || now >= start) return false;
      return !await SmsNoticeModel.exists({ bookingKind: row.bookingKind, bookingId: row.bookingId, event: 'moved',
        $or: [{ createdAt: { $gt: row.createdAt } }, { createdAt: row.createdAt, _id: { $gt: row._id } }] });
    case 'moved_off': return age <= DAY_MS;
    // r34 (§27.7): the visit is still on at the time the reminder was made for (a move or a cancel makes it stale).
    case 'reminder':
      if (!start || b.bookingKind === 'instant' || minutesOf(start) !== row.version || now >= start) return false;
      return kind === 'lab_booking' ? b.status === 'confirmed' : b.status === 'confirmed' && b.paymentStatus === 'paid';
    default: return false;
  }
}

const MESSAGE: Record<NoticeEvent, SmsMessage> = {
  booked: 'BOOKED', rx_ready: 'RX_READY', report_ready: 'REPORT_READY', reminder: 'REMINDER', cancelled: 'CANCELLED_MOVED', moved: 'CANCELLED_MOVED',
  moved_off: 'CANCELLED_MOVED',
};
/** r34 (§27.8.2): the link variants, tried first when the booking may get a join link (else the plain message). */
const LINK: Partial<Record<NoticeEvent, SmsMessage>> = { booked: 'BOOKED_LINK', reminder: 'REMINDER_LINK' };

/** The one composer: every event, both booking kinds. */
async function compose(row: ISmsNotice, now: Date): ReturnType<SmsComposer> {
  const kind = row.bookingKind as Kind;
  const event = row.event as NoticeEvent;
  const b = (kind === 'booking' ? await BookingModel.findById(row.bookingId).lean() : await PartnerLabBookingModel.findById(row.bookingId).lean()) as Row | null;
  if (!b) return { skip: 'booking_missing' };
  const o = inScope(kind, b, event);
  const start = o ? await startOf(kind, b) : null;
  if (!o || !await stillTrue(kind, b, o, row, start, now)) return { skip: 'stale' };
  if (event !== 'moved_off' && o.disputed?.state === 'open') return { skip: 'disputed' };
  // r34b: a reminder that comes due in the quiet hours (a late drain, a retry) waits for 07:00 if that is still at
  // least an hour before the visit; otherwise it is not sent.
  if (event === 'reminder' && quietHour(now.getTime())) {
    const morning = istDayAt(now.getTime(), 7, istHourOf(now.getTime()) >= 21 ? 1 : 0);
    return start!.getTime() - morning >= HOUR_MS ? { later: new Date(morning) } : { skip: 'quiet' };
  }
  const [name, place] = await Promise.all([patientName(kind, b, row), placeOf(kind, b, event)]);
  const mode = kind === 'booking' ? b.consultationMode : b.visitMode;
  const token = LINK[event] ? linkTokenFor(kind, b) : null;
  return {
    userId: String(b.userId), lang: o.preferredLanguage || 'en', messages: token ? [LINK[event]!, MESSAGE[event]] : [MESSAGE[event]],
    values: (lang) => {
      const w = wordsFor(lang);
      const date = start ? shownDate(start) : '';
      const time = start ? istTimeHhmm(start) : '';
      return { name: name || w.familyMember, service: w.service[mode as keyof typeof w.service] ?? '', date, time, place: place(w) || 'Jansetu', ref: String(o.ref ?? ''),
        what: event === 'cancelled' ? w.cancelled : event === 'moved' ? `${w.movedTo} ${date} ${time}` : w.movedOff, ...(token ? { token } : {}) };
    },
  };
}

/** Registers the composer of every booking event with the drain (at start-up, before the drain runs; and by tests). */
export function registerSmsComposers(): void {
  for (const event of Object.keys(MESSAGE) as NoticeEvent[]) setSmsComposer(event, compose);
}
