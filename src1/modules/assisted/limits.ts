import { createHash, createHmac } from 'crypto';
import { ClientSession } from 'mongoose';
import { CONFIG } from '@/config/config';
import { AppError } from '@/modules/common/types';
import { IST_OFFSET_MS, businessClock, istDateIso } from '@/modules/common/utils/istDate';
import { AssistedAlertModel, AssistedCounterModel } from '@/modules/assisted/model';
import { assistedLimits } from '@/modules/assisted/flags';

/**
 * Assisted booking phase 1a (design §6.2, §8.7, P7, P10, ASSUMED D10): limits per ORGANISATION (not per actor), per
 * phone number and per booker, on Mongo counters shared by every instance (the O1 pattern). Day windows are India
 * calendar days. A hit answers 429 ASSISTED_LIMIT_REACHED with `limit` naming the limit.
 */
export type LimitName = 'lookups' | 'new_accounts' | 'bookings_per_phone' | 'booker_cancellations' | 'pending_card_bookings';

export class AssistedLimitError extends AppError {
  limit: LimitName;
  retryAfter: number;
  constructor(limit: LimitName, retryAfter: number) {
    super({ status: 429, code: 'ASSISTED_LIMIT_REACHED', message: limitMessage(limit) });
    this.limit = limit;
    this.retryAfter = Math.max(1, retryAfter);
  }
}

function limitMessage(limit: LimitName): string {
  switch (limit) {
    case 'lookups': return 'Too many patient lookups this hour; try again later';
    case 'new_accounts': return 'Too many new patient accounts today; try again tomorrow';
    case 'bookings_per_phone': return 'This mobile number has reached today\'s limit of assisted bookings';
    case 'pending_card_bookings': return 'Too many card bookings are waiting for payment; complete or cancel one first';
    default: return 'Too many cancellations today; new assisted bookings are paused until tomorrow';
  }
}

const keyMaterial = () => createHash('sha256').update(`${CONFIG.JWT_SECRET_KEY}:assisted-limits-v1`).digest();
/** A stable, non-reversible counter name for a phone number (no phone is ever stored in a key). */
export const phoneKey = (phone: string) => createHmac('sha256', keyMaterial()).update(`phone|${phone}`).digest('base64url').slice(0, 32);

const DAY_MS = 86_400_000;
/** The end of the India day containing `now` (ms). */
const istDayEnd = (now: number) => Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS + DAY_MS - IST_OFFSET_MS;
const dayId = (kind: string, name: string, now: number) => `${kind}:${istDateIso(now)}:${name}`;

async function bump(id: string, by: number, expireAt: Date, s?: ClientSession): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      const row = await AssistedCounterModel.findOneAndUpdate({ _id: id }, { $inc: { count: by }, $setOnInsert: { expireAt } },
        { upsert: true, new: true, session: s ?? null }).lean();
      return Number(row?.count ?? 0);
    } catch (e) {
      if ((e as { code?: number }).code === 11000 && attempt < 3 && !s) continue;
      throw e;
    }
  }
}

const now = () => businessClock.now();

/** Lookups: at most N per organisation and clock hour; every call counts (refused ones too). */
export async function hitLookup(orgKey: string): Promise<void> {
  const t = now();
  const hour = 3_600_000;
  const index = Math.floor(t / hour);
  const count = await bump(`lookups:${index}:${orgKey}`, 1, new Date((index + 1) * hour + 60_000));
  if (count > assistedLimits.lookupsPerHour()) throw new AssistedLimitError('lookups', Math.ceil(((index + 1) * hour - t) / 1000));
}

/** New accounts: counted only when a booking is about to open an account for an unknown number. */
export async function hitNewAccount(orgKey: string): Promise<void> {
  const t = now();
  const count = await bump(dayId('new_accounts', orgKey, t), 1, new Date(istDayEnd(t) + DAY_MS));
  if (count > assistedLimits.newAccountsPerDay()) throw new AssistedLimitError('new_accounts', Math.ceil((istDayEnd(t) - t) / 1000));
}

/** In the booking transaction that opens the account (aborted bookings never count): one more new account today. */
export async function countNewAccountIn(orgKey: string, s: ClientSession): Promise<void> {
  const t = now();
  const count = await bump(dayId('new_accounts', orgKey, t), 1, new Date(istDayEnd(t) + DAY_MS), s);
  if (count > assistedLimits.newAccountsPerDay()) throw new AssistedLimitError('new_accounts', Math.ceil((istDayEnd(t) - t) / 1000));
}

/** In the booking transaction: one more assisted booking for this phone today, across every booker (aborts when over). */
export async function countBookingForPhoneIn(phone: string, s: ClientSession): Promise<void> {
  const t = now();
  const count = await bump(dayId('bookings_per_phone', phoneKey(phone), t), 1, new Date(istDayEnd(t) + DAY_MS), s);
  if (count > assistedLimits.bookingsPerPhonePerDay()) throw new AssistedLimitError('bookings_per_phone', Math.ceil((istDayEnd(t) - t) / 1000));
}

const cancelId = (orgKey: string, t: number) => dayId('booker_cancellations', orgKey, t);

/** P7: refuses NEW bookings once the booker cancelled N bookings today (cancellations themselves stay allowed). */
export async function assertBookerMayBook(orgKey: string, s?: ClientSession): Promise<void> {
  const t = now();
  const row = await AssistedCounterModel.findById(cancelId(orgKey, t)).session(s ?? null).lean();
  if (Number(row?.count ?? 0) >= assistedLimits.bookerCancellationsPerDay()) {
    throw new AssistedLimitError('booker_cancellations', Math.ceil((istDayEnd(t) - t) / 1000));
  }
}

/** In the cancellation transaction: counts a booker cancellation; at the threshold an alert is raised (P7, P10). */
export async function countBookerCancellationIn(orgKind: string, orgId: string, s: ClientSession): Promise<number> {
  const t = now();
  const count = await bump(cancelId(`${orgKind}:${orgId}`, t), 1, new Date(istDayEnd(t) + DAY_MS), s);
  if (count === assistedLimits.bookerCancellationsPerDay()) {
    await raiseAlertIn({ kind: 'booker_cancellations', bookerKind: orgKind, bookerId: orgId, detail: { cancellations: count } }, s);
  }
  return count;
}

/** P10: the same booker–doctor pair alerts at N bookings in a day (the booking is never refused for it). */
export async function countPairBookingIn(orgKind: string, orgId: string, doctorId: string, s: ClientSession): Promise<void> {
  const t = now();
  const count = await bump(dayId('pair_bookings', `${orgKind}:${orgId}:${doctorId}`, t), 1, new Date(istDayEnd(t) + DAY_MS), s);
  if (count === assistedLimits.samePairAlertPerDay()) {
    await raiseAlertIn({ kind: 'same_pair_bookings', bookerKind: orgKind, bookerId: orgId, detail: { doctorId, bookings: count } }, s);
  }
}

/** One alert per (kind, subject, India day); a repeat changes nothing. */
export async function raiseAlertIn(a: { kind: string; bookerKind?: string; bookerId?: string; detail?: Record<string, unknown>; subject?: string },
  s?: ClientSession | null): Promise<void> {
  const day = istDateIso(now());
  const key = `${a.kind}:${a.subject ?? `${a.bookerKind ?? ''}:${a.bookerId ?? ''}`}:${day}`;
  await AssistedAlertModel.updateOne({ key }, { $setOnInsert: { key, kind: a.kind, bookerKind: a.bookerKind, bookerId: a.bookerId, day,
    detail: a.detail ?? {}, at: new Date(now()) } }, { upsert: true, session: s ?? null });
}

/** Today's booker cancellation count (reconciliation report). */
export async function bookerCancellationsToday(orgKey: string): Promise<number> {
  const row = await AssistedCounterModel.findById(cancelId(orgKey, now())).lean();
  return Number(row?.count ?? 0);
}

/**
 * r10b: at most N card bookings of one booker waiting for their payment at once (ASSISTED_LIMIT_PENDING_CARD_BOOKINGS,
 * default 10), so unpaid card bookings cannot hold doctors' slots for free. In the booking transaction, after the insert:
 * a per-booker lock row is written first (concurrent creates of one booker conflict and run one after the other), then
 * the booker's pending card bookings — this one included — are counted.
 */
export async function assertPendingCardRoomIn(orgKind: string, orgId: string, countPending: () => Promise<number>, s: ClientSession): Promise<void> {
  await bump(`pending_card_lock:${orgKind}:${orgId}`, 1, new Date(now() + DAY_MS), s);
  if (await countPending() > assistedLimits.pendingCardBookings()) throw new AssistedLimitError('pending_card_bookings', 1800);
}
