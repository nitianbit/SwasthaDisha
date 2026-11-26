import { AppError } from '@/modules/common/types';
import { fundingMethodOf, type PaymentMethod } from '@/modules/pharmacyOrders/paymentMethod';
import { isRealDate, istDate } from '@/modules/partners/services/slots';

/**
 * r38 (§26.22): the Today register's shared parts — the India-day range, the merged list's order and cursor, paging, the
 * day's money and the waiting work's "one failing queue answers null" — used by the pharmacy's register (r37,
 * `assisted/today.ts`) and the lab's (r38, `partners/services/today.ts`). Each register brings its own rows (`Raw`) and
 * views; the rules here are the one copy.
 */
export type Row = Record<string, any>;
export type Day = { $gte: Date; $lt: Date };

/** Rows read per source and query for one day (a busy counter makes a few hundred); the answer says when one had more. */
export const TODAY_SOURCE_CAP = 2000;
export const PENDING_IDS = 20;
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;
/** Statuses after which nothing more is owed. */
export const ENDED = ['cancelled', 'abandoned', 'rejected', 'no_show'];
/** What a patient may still owe (r37b); `paid` and `refunded` owe nothing. */
export const OWED = ['pending', 'failed', 'partially_paid'];

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
export const paise = (rupees: unknown) => Math.round(Number(rupees ?? 0) * 100);
export const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/** The instants of one India day: [00:00 IST, next 00:00 IST). */
export function dayRange(date: string): Day {
  const from = new Date(`${date}T00:00:00+05:30`);
  return { $gte: from, $lt: new Date(from.getTime() + 86_400_000) };
}
export const inDay = (at: unknown, day: Day) => !!at && new Date(at as Date) >= day.$gte && new Date(at as Date) < day.$lt;

/** One row of the day (projected), with how it counts in the day's money. */
export interface Raw {
  kind: string; row: Row; at: Date; id: string; createdAt: Date; paidAt: Date | null; amountMinor: number; paid: boolean;
  method: PaymentMethod | null; status: string; paymentStatus: string; collects: boolean;
  /** r37b: the money waits for the booker's own card payment or an online checkout (not owed at the desk). */
  atGateway: boolean;
  /** r38: money received that day in parts (a bill's payments), each by method; when present it is the row's collection. */
  received?: { method: PaymentMethod; amountMinor: number }[];
  /** r38: what is still due on the row (a part-paid bill); absent = `amountMinor` while unpaid. */
  dueMinor?: number;
}

/** Cursor `<at ms>_<id>`: the next page starts after it (the merged list is ordered by time, then id). */
const CURSOR = /^(\d{1,15})_([0-9a-fA-F]{24})$/;
const keyOf = (at: Date, id: string) => [new Date(at).getTime(), id] as const;
const after = (a: readonly [number, string], b: readonly [number, string]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

/** The day's rows in time order; an earlier row paid that day stands at its payment time. */
export function orderRaws(raws: Raw[], day: Day): Raw[] {
  for (const r of raws) if (r.createdAt < day.$gte && r.paidAt) r.at = r.paidAt;
  return raws.sort((a, b) => (after(keyOf(a.at, a.id), keyOf(b.at, b.id)) ? 1 : -1));
}

export type PageQuery = { date?: string; cursor?: string; limit?: number; order?: 'asc' | 'desc' };
/** The date, the day's rows and one page of them in the asked order (r37c: `desc` = newest first; the cursor continues it). */
export async function pageOf(q: PageQuery, now: Date, rawOf: (day: Day) => Promise<{ raws: Raw[]; truncated: string[] }>,
  pick?: (raws: Raw[]) => Promise<Raw[]>) {
  const date = q.date ?? istDate(now);
  if (!isRealDate(date)) throw err(400, 'INVALID_DATE', 'date must be a real date (YYYY-MM-DD)');
  const m = q.cursor ? CURSOR.exec(q.cursor) : null;
  if (q.cursor && !m) throw err(400, 'INVALID_CURSOR', 'Invalid cursor');
  const limit = Math.min(Math.max(Number(q.limit) || LIMIT_DEFAULT, 1), LIMIT_MAX);
  const desc = q.order === 'desc';
  const day = dayRange(date);
  const { raws, truncated } = await rawOf(day);
  const chosen = pick ? await pick(raws) : raws;
  const ordered = desc ? [...chosen].reverse() : chosen;
  const from = m ? [Number(m[1]), m[2]!.toLowerCase()] as const : null;
  const rest = from ? ordered.filter((r) => (desc ? after(from, keyOf(r.at, r.id)) : after(keyOf(r.at, r.id), from))) : ordered;
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return { date, day, raws, truncated, page, first: !m,
    nextCursor: rest.length > limit && last ? `${new Date(last.at).getTime()}_${last.id}` : null };
}

/**
 * The day's money. Collected = what came in on that day, by method (a whole paid row by its payment's day, or a bill's
 * payments of that day), whatever day the row was made; a paid row later cancelled stays collected until it is refunded.
 * Unpaid = what live rows still owe at the desk (`OWED`, not ended, not at the gateway). Rows that are not collections
 * (`collects: false`) count in neither.
 */
export function totalsOf(raws: Raw[], day: Day, methods: readonly PaymentMethod[]) {
  const byMethod = Object.fromEntries(methods.map((m) => [m, 0])) as Record<string, number>;
  const add = (m: PaymentMethod | null, amount: number) => { const k = m && m in byMethod ? m : 'other'; byMethod[k] = (byMethod[k] ?? 0) + amount; };
  let collectedMinor = 0;
  let unpaidMinor = 0;
  for (const r of raws) {
    if (!r.collects) continue;
    if (r.received) for (const x of r.received) { collectedMinor += x.amountMinor; add(x.method, x.amountMinor); }
    else if (r.paid && inDay(r.paidAt, day)) { collectedMinor += r.amountMinor; add(r.method, r.amountMinor); }
    if (!ENDED.includes(r.status) && !r.atGateway) {
      if (r.dueMinor !== undefined) unpaidMinor += r.dueMinor;
      else if (!r.received && OWED.includes(r.paymentStatus)) unpaidMinor += r.amountMinor;
    }
  }
  return { collectedMinor, byMethod, unpaidMinor, count: raws.length };
}

/** The common fields of a register item (each register adds its kind's short ref, name and line). */
export function itemBase(r: Raw, day: Day, date: string) {
  const madeOn = istDate(new Date(r.createdAt));
  // r37c: `paidToday` marks only an earlier row paid on this day.
  return { kind: r.kind, id: r.id, at: r.at, amountMinor: r.amountMinor, paid: r.paid, method: r.method, status: r.status, madeOn,
    paidToday: madeOn !== date && r.paid && inDay(r.paidAt, day) };
}

export const firstOf = (names: string[]) => (names.length ? `${names[0]}${names.length > 1 ? ` +${names.length - 1} more` : ''}` : '');
export const listOf = (names: string[]) => ({ first: names[0] ?? null, more: Math.max(0, names.length - 1) });

/** A pending queue read as a count and its first ids. */
export type Count = { count: number; ids: string[] };
type CountModel = { countDocuments: (f: Row) => PromiseLike<number>; find: (f: Row) => any };
export async function countIds(Model: CountModel, filter: Row): Promise<Count> {
  const [count, rows] = await Promise.all([Model.countDocuments(filter),
    Model.find(filter).sort({ createdAt: -1, _id: -1 }).limit(PENDING_IDS).select({ _id: 1 }).lean() as Promise<Row[]>]);
  return { count, ids: rows.map((r) => String(r._id)) };
}
/** The waiting work's queues, each its own read: one that fails answers `null`, never a failed home screen. */
export async function settledQueues<T extends Record<string, () => Promise<unknown>>>(queues: T): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> | null }> {
  const keys = Object.keys(queues) as (keyof T)[];
  const settled = await Promise.allSettled(keys.map((k) => queues[k]!()));
  return Object.fromEntries(keys.map((k, i) => [k, settled[i]!.status === 'fulfilled' ? (settled[i] as PromiseFulfilledResult<unknown>).value : null])) as never;
}

// ── Shared sources: the consultations a booker made (a pharmacy's, r37; a lab's, r38) ──

type Finder = { find: (f: Row) => any };
/** One source's rows of the day: projected, oldest first, at most TODAY_SOURCE_CAP + 1 (the extra row says "more"). */
export const dayRows = (Model: Finder, filter: Row, fields: Row) =>
  Model.find(filter).select(fields).sort({ createdAt: 1, _id: 1 }).limit(TODAY_SOURCE_CAP + 1).lean() as Promise<Row[]>;
/** Keeps a source's rows to the cap and notes the kind when it had more. */
export const capper = (truncated: Set<string>) => (kind: string, rows: Row[]) => {
  if (rows.length > TODAY_SOURCE_CAP) truncated.add(kind);
  return rows.slice(0, TODAY_SOURCE_CAP);
};

export const CONSULTATION_FIELDS = { status: 1, paymentStatus: 1, price: 1, 'assisted.funding': 1, 'assisted.shortRef': 1, 'lifecycle.paid.at': 1, doctorName: 1,
  bookingKind: 1, bookingTime: 1, consultationMode: 1, createdAt: 1, userId: 1, dependentId: 1, contactNo: 1 };
/** A consultation a booker made: its price, paid by its funding (wallet or card), waiting at the gateway while its card payment is. */
export function consultationRaw(b: Row): Raw {
  const paid = b.paymentStatus === 'paid';
  const f = b.assisted?.funding;
  return { kind: 'consultation', row: b, at: b.createdAt, createdAt: b.createdAt, id: String(b._id), status: b.status, paymentStatus: b.paymentStatus,
    amountMinor: paise(b.price), paid, paidAt: paid ? b.lifecycle?.paid?.at ?? b.createdAt : null, method: paid ? fundingMethodOf(f) : null,
    collects: true, atGateway: f?.method === 'razorpay' && f?.state === 'pending' };
}
/** r37c: a row's short line as a code with values (`whatParts`) for the web to word in each language; `what` is the English line. */
export type WhatParts = { code: string; values?: Record<string, string | number | null> };
export function consultationWhat(v: Row): { what: string; whatParts: WhatParts } {
  const instant = v.bookingKind === 'instant';
  return { what: [v.doctorName, instant ? 'now' : v.bookingTime, v.consultationMode].filter(Boolean).join(' · ') || 'Consultation',
    whatParts: instant ? { code: 'consult.instant', values: { doctor: v.doctorName ?? null, mode: v.consultationMode ?? null } }
      : { code: 'consult.scheduled', values: { doctor: v.doctorName ?? null, time: v.bookingTime ?? null, mode: v.consultationMode ?? null } } };
}
/** A lab booking's line: its tests (`lab.tests { first, more }`), with any extra values a register adds. */
export function labTestsWhat(v: Row, extra: Record<string, string | null> = {}): { what: string; whatParts: WhatParts } {
  const names = (v.items ?? []).map((i: Row) => String(i.name ?? 'Test'));
  return { what: firstOf(names) || 'Lab tests', whatParts: { code: 'lab.tests', values: { ...listOf(names), ...extra } } };
}
export const TOPUP_WHAT: { what: string; whatParts: WhatParts } = { what: 'Wallet top-up', whatParts: { code: 'wallet.topup' } };

/** r37c/r38: a register search's terms — 2 to 100 characters (400 otherwise), lower-cased, and its digits for a phone match (4 or more). */
export function searchTerms(q: unknown): { needle: string; phone: string } {
  const needle = String(q ?? '').trim().toLowerCase();
  if (needle.length < 2 || needle.length > 100) throw err(400, 'VALIDATION_ERROR', 'q must be 2 to 100 characters');
  const phone = digits(needle);
  return { needle, phone: phone.length >= 4 ? phone : '' };
}
/** Whether a row matches: its own words contain the needle, or one of its phones contains the phone digits. */
export const matches = (t: { needle: string; phone: string }, words: (string | null | undefined)[], phones: (string | null | undefined)[]) =>
  words.filter(Boolean).join(' ').toLowerCase().includes(t.needle) || (!!t.phone && phones.some((p) => !!p && digits(p).includes(t.phone)));
/** The account holders' phones of a search's rows (read only when the search has phone digits). */
export async function holderPhones(userIds: unknown[], wanted: boolean): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.map(String).filter((x) => /^[0-9a-fA-F]{24}$/.test(x)))];
  if (!wanted || !ids.length) return new Map();
  const { default: UserModel } = await import('@/modules/user/model');
  const users = await UserModel.find({ _id: { $in: ids } }).select({ phone: 1 }).lean() as unknown as Row[];
  return new Map(users.map((u) => [String(u._id).toLowerCase(), String(u.phone ?? '')]));
}
