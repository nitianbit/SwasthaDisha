import crypto from 'crypto';
import mongoose, { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import {
  SettlementAccountModel, LedgerEntryModel, LedgerHistoryRefModel, SettlementPayoutModel, SettlementEventModel,
  ISettlementAccount, ILedgerEntry, IPayoutDetails, ISettlementPayout,
  isReferralOwnerKind, type SettlementOwnerKind,
} from '@/modules/partners/model/settlement';
import { assistedFlags } from '@/modules/assisted/flags';
import PartnerOrgModel from '@/modules/partners/model';
import SpecialistModel from '@/modules/specialists/model';
import BookingModel from '@/modules/bookings/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PartnerActor, adminActor, hasGlobalScope, inTransaction, recordPartnerAudit } from '@/modules/partners/services';
import { ensureSettlementAccount, ledgerBalance, postLedgerEntry } from '@/modules/partners/services/settlement';
import { istDate, isRealDate } from '@/modules/partners/services/slots';
import { claimRequestKey, abandonRequestKey } from '@/modules/requestKeys';
import { RequestKeyModel } from '@/modules/requestKeys/model';

/**
 * Q5 — ledger statements, payout destinations and admin payout recording (§7). Money only moves through append-only
 * ledger entries (services/settlement.ts). Everything that spends or corrects a balance (payout, void, adjustment) and
 * every destination change bumps the account's `financeVersion` inside its transaction, so two such decisions never
 * read the same balance or destination: the loser conflicts, is retried and decides again on what won.
 */

/** Who acts: an admin (any account), a partner member (their partner's account) or a doctor (their own account). */
export type FinanceActor =
  | { kind: 'admin'; id: string }
  | { kind: 'member'; partner: PartnerActor }
  | { kind: 'doctor'; id: string }
  /** r32 (§26.8.1): a pharmacy sets the payout details of its home account (`pharmacy_referral`). */
  | { kind: 'pharmacy'; id: string };

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const MAX_MINOR = 1_000_000_000_00; // ₹1,00,00,00,000 — far above any single payout or adjustment
export const CSV_MAX_LINES = 5000;
/** Ids are stored canonical (lowercase hex); every boundary compares the canonical form. */
const canon = (id: string) => String(id).toLowerCase();

/** Reads that must agree with each other (rows and balances) come from one database snapshot. */
async function inSnapshot<T>(fn: (s: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let out!: T;
    await session.withTransaction(async () => { out = await fn(session); }, { readConcern: { level: 'snapshot' } });
    return out;
  } finally {
    await session.endSession();
  }
}

// ── Accounts ──

export async function accountById(id: string, s?: ClientSession): Promise<ISettlementAccount> {
  if (!Types.ObjectId.isValid(id)) throw err(404, 'SETTLEMENT_ACCOUNT_NOT_FOUND', 'Settlement account not found');
  const a = await SettlementAccountModel.findById(canon(id)).session(s ?? null).lean() as ISettlementAccount | null;
  if (!a) throw err(404, 'SETTLEMENT_ACCOUNT_NOT_FOUND', 'Settlement account not found');
  return a;
}

/** Reads never create: a partner/doctor without an account yet simply has nothing to show. */
export async function findOwnerAccount(ownerKind: SettlementOwnerKind, ownerId: string): Promise<ISettlementAccount | null> {
  return (await SettlementAccountModel.findOne({ ownerKind, ownerId: String(ownerId) }).lean()) as ISettlementAccount | null;
}

async function ensureOwnerAccount(ownerKind: 'partner' | 'doctor', ownerId: string): Promise<ISettlementAccount> {
  const existing = await findOwnerAccount(ownerKind, ownerId);
  if (existing) return existing;
  const name = ownerKind === 'partner'
    ? ((await PartnerOrgModel.findById(ownerId).lean()) as { legalName?: string; name?: string } | null)
    : ((await SpecialistModel.findById(ownerId).select({ name: 1 }).lean()) as { name?: string } | null);
  if (!name) throw err(404, 'SETTLEMENT_ACCOUNT_NOT_FOUND', 'Settlement account not found');
  return ensureSettlementAccount(ownerKind, ownerId, (name as { legalName?: string }).legalName || name.name || 'Account holder');
}

/** The partner account a member may see: finance.view and partner-wide scope (finance covers every branch). */
export function assertPartnerFinanceReader(actor: PartnerActor): void {
  if (!hasGlobalScope(actor)) throw err(403, 'FINANCE_SCOPE_REQUIRED', 'Finance covers every branch; a branch-limited member cannot view it');
}

function maskNumber(n?: string): string | undefined { return n ? `XXXX${n.slice(-4)}` : undefined; }

function detailsView(d: IPayoutDetails | undefined, full: boolean): Record<string, unknown> | null {
  if (!d) return null;
  return d.method === 'upi'
    ? { method: 'upi', upiId: d.upiId, accountName: d.accountName }
    : { method: 'bank', accountName: d.accountName, ifsc: d.ifsc, bankName: d.bankName, accountNumberLast4: d.accountNumberLast4,
      ...(full ? { accountNumber: d.accountNumber } : { accountNumberMasked: maskNumber(d.accountNumber) }) };
}

/** Owners/doctors see the destination masked; only admins (who make the transfer) see the full account number. */
export function accountView(a: ISettlementAccount, full: boolean) {
  return {
    _id: String(a._id), ownerKind: a.ownerKind, ownerId: a.ownerId, beneficiaryName: a.beneficiaryName, isActive: a.isActive,
    payoutDetails: detailsView(a.payoutDetails, full), payoutDetailsState: a.payoutDetailsState ?? 'none',
    payoutDetailsVersion: a.payoutDetailsVersion ?? 0, payoutDetailsChangedAt: a.payoutDetailsChangedAt,
    payoutDetailsVerifiedAt: a.payoutDetailsVerifiedAt,
    // Q13: the serialization version of payouts, voids, adjustments and destination changes (earnings do not move it);
    // a payout or adjustment may name the version it was decided on.
    financeVersion: a.financeVersion ?? 0,
  };
}

export function destinationLabel(d: IPayoutDetails): string {
  return d.method === 'upi' ? `UPI ${d.upiId}` : `${d.bankName ? d.bankName + ' ' : ''}${d.ifsc} ${maskNumber(d.accountNumber)}`;
}

// ── Audit ──

async function recordFinanceEvent(account: ISettlementAccount, actor: FinanceActor, action: string, detail: Record<string, unknown>, s: ClientSession) {
  const by = actor.kind === 'member' ? actor.partner.memberId : actor.id;
  await SettlementEventModel.create([{ settlementAccountId: String(account._id), action, byKind: actor.kind, by, detail, at: new Date() }], { session: s });
  if (account.ownerKind === 'partner') {
    const pa = actor.kind === 'member' ? actor.partner : actor.kind === 'admin' ? adminActor(actor.id, account.ownerId) : null;
    // The general partner audit (readable with staff.manage) records only who did what to which account; amounts,
    // references and destinations stay in the finance event stream, which needs finance.view.
    if (pa) await recordPartnerAudit(pa, action, { kind: 'settlement_account', id: String(account._id) }, undefined, s);
  }
}

/**
 * Every spending/correcting decision and destination change serializes on the account (see module note). Q13: with
 * `expected` the bump happens only from that version (an account written before the field existed counts as 0); any
 * other current version refuses the decision (409 FINANCE_CHANGED).
 */
async function bumpFinance(accountId: string, s: ClientSession, expected?: number): Promise<ISettlementAccount> {
  const fence = expected === undefined ? {}
    : expected === 0 ? { $or: [{ financeVersion: 0 }, { financeVersion: { $exists: false } }] } : { financeVersion: expected };
  const a = await SettlementAccountModel.findOneAndUpdate({ _id: accountId, ...fence }, { $inc: { financeVersion: 1 } }, { new: true, session: s }).lean();
  if (!a) {
    if (expected !== undefined && await SettlementAccountModel.exists({ _id: accountId }).session(s)) {
      throw err(409, 'FINANCE_CHANGED', 'This account changed since it was loaded (a payout, adjustment or destination change); review it again');
    }
    throw err(404, 'SETTLEMENT_ACCOUNT_NOT_FOUND', 'Settlement account not found');
  }
  return a as ISettlementAccount;
}

/** Q13: request-key scopes of admin payouts and adjustments, per account and admin (claimed with the record). */
export const payoutKeyScope = (accountId: string, adminId: string) => `settlement_payout:${canon(accountId)}:${canon(adminId)}`;
export const adjustmentKeyScope = (accountId: string, adminId: string) => `settlement_adjustment:${canon(accountId)}:${canon(adminId)}`;

// ── Summary and statement ──

export async function financeSummary(account: ISettlementAccount | null, full: boolean) {
  if (!account) {
    return { account: null, balanceMinor: 0, totals: { earnedMinor: 0, reversedMinor: 0, paidOutMinor: 0, adjustedMinor: 0 }, lastPayout: null };
  }
  const id = String(account._id);
  const rows = await LedgerEntryModel.aggregate([{ $match: { settlementAccountId: id } }, { $group: { _id: '$kind', total: { $sum: '$amountMinor' } } }]);
  const by = Object.fromEntries(rows.map((r: { _id: string; total: number }) => [r._id, r.total])) as Record<string, number>;
  const lastPayout = await SettlementPayoutModel.findOne({ settlementAccountId: id, state: 'recorded' }).sort({ createdAt: -1 })
    .select({ requestKey: 0, requestHash: 0 }).lean();
  return {
    account: accountView(account, full),
    balanceMinor: Object.values(by).reduce((a, b) => a + b, 0),
    totals: { earnedMinor: by.earning ?? 0, reversedMinor: -(by.reversal ?? 0), paidOutMinor: -(by.payout ?? 0), adjustedMinor: by.adjustment ?? 0 },
    lastPayout,
  };
}

export interface StatementLine {
  _id: string; at: Date; kind: ILedgerEntry['kind']; source: string; sourceId: string; description: string;
  reference?: string; note?: string; amountMinor: number; balanceAfterMinor: number;
  /** r24 (§26.6.2): on earnings, the base and the referral cut taken from it (net = amountMinor). */
  grossMinor?: number; commissionMinor?: number;
}

const ymdIso = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);

/** Human descriptions for entries, looked up in one batch per source kind (no patient contact data). */
async function describe(entries: ILedgerEntry[]): Promise<Map<string, string>> {
  const ids = (src: string) => [...new Set(entries.filter((e) => e.source === src).map((e) => e.sourceId))].filter((x) => Types.ObjectId.isValid(x));
  const out = new Map<string, string>();
  const lab = await PartnerLabBookingModel.find({ _id: { $in: ids('partner_lab_booking') } }).select({ slot: 1, patient: 1, visitMode: 1 }).lean() as any[];
  for (const b of lab) out.set(`partner_lab_booking:${b._id}`, `Lab booking · ${b.slot?.date ?? ''} ${b.slot?.startTime ?? ''} · ${String(b.patient?.name ?? '').split(' ')[0]}`.trim());
  const cons = await BookingModel.find({ _id: { $in: ids('consultation') } }).select({ bookingDate: 1, bookingTime: 1, consultationMode: 1, bookingKind: 1 }).lean() as any[];
  for (const b of cons) {
    out.set(`consultation:${b._id}`, `${b.bookingKind === 'instant' ? 'Instant consultation' : 'Consultation'} · ${ymdIso(b.bookingDate)} ${b.bookingTime ?? ''}${b.consultationMode ? ' · ' + b.consultationMode : ''}`.trim());
  }
  // r24 (§26.6.2): a referral row names the booking by its short ref and date, never the patient.
  const refLab = await PartnerLabBookingModel.find({ _id: { $in: ids('referral_lab_booking') } }).select({ slot: 1, 'assisted.shortRef': 1 }).lean() as any[];
  for (const b of refLab) out.set(`referral_lab_booking:${b._id}`, `Referral · lab booking · ${b.slot?.date ?? ''} · Ref ${b.assisted?.shortRef ?? ''}`.trim());
  const refCons = await BookingModel.find({ _id: { $in: ids('referral_consultation') } }).select({ bookingDate: 1, bookingKind: 1, 'assisted.shortRef': 1 }).lean() as any[];
  for (const b of refCons) {
    out.set(`referral_consultation:${b._id}`, `Referral · ${b.bookingKind === 'instant' ? 'instant consultation' : 'consultation'} · ${ymdIso(b.bookingDate)} · Ref ${b.assisted?.shortRef ?? ''}`.trim());
  }
  const pays = await SettlementPayoutModel.find({ _id: { $in: [...ids('payout'), ...ids('payout_void')] } }).select({ reference: 1, paidOn: 1, destination: 1 }).lean() as any[];
  for (const p of pays) {
    out.set(`payout:${p._id}`, `Payout · ${p.paidOn} · ${p.destination?.label ?? ''}`.trim());
    out.set(`payout_void:${p._id}`, `Payout voided · ${p.paidOn} · ref ${p.reference}`);
  }
  return out;
}

const FALLBACK: Record<string, string> = {
  partner_lab_booking: 'Lab booking', consultation: 'Consultation', payout: 'Payout', payout_void: 'Payout voided', admin_adjustment: 'Adjustment',
  referral_consultation: 'Referral · consultation', referral_lab_booking: 'Referral · lab booking',
};

/** Balance after `e` = Σ every entry at or before it in (at, _id) order — independent of any date filter. */
async function balanceThrough(accountId: string, e: Pick<ILedgerEntry, 'at'> & { _id?: unknown }, s: ClientSession): Promise<number> {
  const agg = await LedgerEntryModel.aggregate([
    { $match: { settlementAccountId: accountId, $or: [{ at: { $lt: e.at } }, { at: e.at, _id: { $lte: e._id } }] } },
    { $group: { _id: null, total: { $sum: '$amountMinor' } } },
  ]).session(s);
  return agg[0]?.total ?? 0;
}

/** Σ entries strictly before an instant (the opening balance of a period). */
async function balanceBefore(accountId: string, at: Date, s: ClientSession): Promise<number> {
  const agg = await LedgerEntryModel.aggregate([
    { $match: { settlementAccountId: accountId, at: { $lt: at } } },
    { $group: { _id: null, total: { $sum: '$amountMinor' } } },
  ]).session(s);
  return agg[0]?.total ?? 0;
}

function parseCursor(c?: string): { at: Date; id: Types.ObjectId } | null {
  if (!c) return null;
  const [ms, id] = c.split('_');
  if (!/^\d{1,15}$/.test(ms ?? '') || !Types.ObjectId.isValid(id ?? '')) throw err(400, 'INVALID_CURSOR', 'Invalid statement cursor');
  return { at: new Date(Number(ms)), id: new Types.ObjectId(id) };
}

/** IST calendar range → instants [from 00:00, to+1 00:00). */
function range(from?: string, to?: string): Record<string, unknown> {
  const q: Record<string, Date> = {};
  if (from) { if (!isRealDate(from)) throw err(400, 'INVALID_DATE', 'from must be a real date'); q.$gte = new Date(`${from}T00:00:00+05:30`); }
  if (to) { if (!isRealDate(to)) throw err(400, 'INVALID_DATE', 'to must be a real date'); q.$lt = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000); }
  return Object.keys(q).length ? { at: q } : {};
}

/** Newest first, with the running balance after each line; `nextCursor` pages further back. */
export async function statementPage(account: ISettlementAccount | null, opts: { before?: string; limit?: number; from?: string; to?: string }) {
  if (!account) return { lines: [] as StatementLine[], nextCursor: null };
  const id = String(account._id);
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const cur = parseCursor(opts.before);
  const filter: Record<string, unknown> = { settlementAccountId: id, ...range(opts.from, opts.to),
    ...(cur ? { $or: [{ at: { $lt: cur.at } }, { at: cur.at, _id: { $lt: cur.id } }] } : {}) };
  // The page and its starting balance come from one snapshot, so a row committing meanwhile is in both or in neither.
  const { page, startBalance } = await inSnapshot(async (s) => {
    const rows = await LedgerEntryModel.find(filter).sort({ at: -1, _id: -1 }).limit(limit + 1).session(s).lean() as ILedgerEntry[];
    return { page: rows, startBalance: rows.length ? await balanceThrough(id, rows[0]!, s) : 0 };
  });
  const more = page.length > limit;
  const entries = page.slice(0, limit);
  const labels = await describe(entries);
  let after = startBalance;
  const lines: StatementLine[] = entries.map((e) => {
    const line = { _id: String(e._id), at: e.at, kind: e.kind, source: e.source, sourceId: e.sourceId,
      description: labels.get(`${e.source}:${e.sourceId}`) ?? FALLBACK[e.source] ?? e.source, reference: e.reference, note: e.note,
      amountMinor: e.amountMinor, balanceAfterMinor: after,
      ...(e.kind === 'earning' && e.grossMinor !== undefined ? { grossMinor: e.grossMinor, commissionMinor: e.commissionMinor ?? 0 } : {}) };
    after -= e.amountMinor;
    return line;
  });
  const last = entries[entries.length - 1];
  return { lines, nextCursor: more && last ? `${new Date(last.at).getTime()}_${String(last._id)}` : null };
}

const rupees = (minor: number) => (minor / 100).toFixed(2);
/** CSV cell: quoted, and formula-leading text neutralised (spreadsheet injection). */
const cell = (v: unknown) => {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const istStamp = (d: Date) => new Date(new Date(d).getTime() + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ');

/**
 * Oldest first for a period, with opening (Σ before the period) and closing balance — even for a period without
 * activity. Rows and balances come from one snapshot. A period with more than CSV_MAX_LINES entries is refused (narrow
 * the period) rather than silently cut.
 */
export async function statementCsv(account: ISettlementAccount | null, opts: { from?: string; to?: string }): Promise<string> {
  const header = ['Date (IST)', 'Type', 'Description', 'Reference', 'Note', 'Amount (INR)', 'Balance (INR)'].map(cell).join(',');
  if (!account) return header + '\n';
  const id = String(account._id);
  const period = range(opts.from, opts.to) as { at?: { $gte?: Date; $lt?: Date } };
  const { entries, opening } = await inSnapshot(async (s) => {
    const rows = await LedgerEntryModel.find({ settlementAccountId: id, ...period }).sort({ at: 1, _id: 1 }).limit(CSV_MAX_LINES + 1).session(s).lean() as ILedgerEntry[];
    if (rows.length > CSV_MAX_LINES) {
      throw err(400, 'EXPORT_TOO_LARGE', `More than ${CSV_MAX_LINES} entries in this period; export a shorter period`);
    }
    return { entries: rows, opening: period.at?.$gte ? await balanceBefore(id, period.at.$gte, s) : 0 };
  });
  const labels = await describe(entries);
  let bal = opening;
  const rows = [header, ['', 'Opening balance', '', '', '', '', rupees(bal)].map(cell).join(',')];
  for (const e of entries) {
    bal += e.amountMinor;
    rows.push([istStamp(e.at), e.kind, labels.get(`${e.source}:${e.sourceId}`) ?? FALLBACK[e.source] ?? e.source, e.reference, e.note,
      rupees(e.amountMinor), rupees(bal)].map(cell).join(','));
  }
  rows.push(['', 'Closing balance', '', '', '', '', rupees(bal)].map(cell).join(','));
  return rows.join('\n') + '\n';
}

// ── Q13: exact cursor pages `<ms>_<id>` (newest first, ties broken by id), as the Q10 bills list ──

export interface PageOpts { cursor?: string; limit?: number }
export interface Page<T> { items: T[]; total: number; nextCursor: string | null }

function pageCursor(c?: string): { at: Date; id: Types.ObjectId } | null {
  if (!c) return null;
  const [ms, id] = c.split('_');
  if (!/^\d{1,15}$/.test(ms ?? '') || !/^[0-9a-fA-F]{24}$/.test(id ?? '')) throw err(400, 'INVALID_CURSOR', 'Invalid cursor');
  return { at: new Date(Number(ms)), id: new Types.ObjectId(id) };
}

async function cursorPage<T extends { _id?: unknown }>(model: mongoose.Model<any>, filter: Record<string, unknown>, field: 'createdAt' | 'at',
  opts: PageOpts, defaultLimit: number, projection?: Record<string, 0>): Promise<Page<T>> {
  const limit = Math.min(Math.max(Number(opts.limit) || defaultLimit, 1), 500);
  const cur = pageCursor(opts.cursor);
  const page = cur ? { $and: [filter, { $or: [{ [field]: { $lt: cur.at } }, { [field]: cur.at, _id: { $lt: cur.id } }] }] } : filter;
  const [total, rows] = await Promise.all([
    model.countDocuments(filter),
    model.find(page).sort({ [field]: -1, _id: -1 }).limit(limit + 1).select(projection ?? {}).lean().exec() as Promise<T[]>,
  ]);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1] as (T & Record<string, unknown>) | undefined;
  return { items, total, nextCursor: rows.length > limit && last ? `${new Date(last[field] as Date).getTime()}_${String(last._id)}` : null };
}

/** Q13: the payouts of one account, paged. */
export async function payoutsPage(account: ISettlementAccount | null, opts: PageOpts): Promise<Page<ISettlementPayout>> {
  if (!account) return { items: [], total: 0, nextCursor: null };
  return cursorPage<ISettlementPayout>(SettlementPayoutModel, { settlementAccountId: String(account._id) }, 'createdAt', opts, 100, { requestKey: 0, requestHash: 0 });
}

/** Q13: the finance events of one account, paged. */
export async function eventsPage(account: ISettlementAccount | null, opts: PageOpts) {
  if (!account) return { items: [], total: 0, nextCursor: null };
  return cursorPage(SettlementEventModel, { settlementAccountId: String(account._id) }, 'at', opts, 200);
}

/** The finance event stream of an account (who changed destinations, recorded/voided payouts, adjustments). */
export async function financeEvents(account: ISettlementAccount | null, limit = 200) {
  if (!account) return [];
  return SettlementEventModel.find({ settlementAccountId: String(account._id) }).sort({ at: -1 }).limit(Math.min(limit, 500)).lean();
}

export async function listPayouts(account: ISettlementAccount | null, limit = 100): Promise<ISettlementPayout[]> {
  if (!account) return [];
  return (await SettlementPayoutModel.find({ settlementAccountId: String(account._id) }).sort({ createdAt: -1 }).limit(Math.min(limit, 500))
    .select({ requestKey: 0, requestHash: 0 }).lean()) as ISettlementPayout[];
}

/** §7a step 4: legacy history for context (never part of the balance). */
export async function historyRefs(account: ISettlementAccount | null) {
  if (!account) return [];
  return LedgerHistoryRefModel.find({ settlementAccountId: String(account._id) }).sort({ at: -1 }).limit(500).lean();
}

// ── Payout destination ──

export interface PayoutDetailsInput {
  method: 'bank' | 'upi'; accountName?: string; accountNumber?: string; ifsc?: string; bankName?: string; upiId?: string;
  /** Q13: the payoutDetailsVersion the editor started from; another current version refuses the change. */
  expectedDetailsVersion?: number;
}

function normalizeDetails(i: PayoutDetailsInput): IPayoutDetails {
  if (i.method === 'bank') {
    const accountNumber = String(i.accountNumber ?? '').replace(/\s+/g, '');
    const ifsc = String(i.ifsc ?? '').trim().toUpperCase();
    if (!/^\d{9,18}$/.test(accountNumber)) throw err(400, 'INVALID_ACCOUNT_NUMBER', 'Account number must be 9 to 18 digits');
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw err(400, 'INVALID_IFSC', 'IFSC must look like ABCD0123456');
    if (!String(i.accountName ?? '').trim()) throw err(400, 'INVALID_ACCOUNT_NAME', 'Account holder name is required');
    return { method: 'bank', accountName: String(i.accountName).trim(), accountNumber, accountNumberLast4: accountNumber.slice(-4), ifsc,
      ...(i.bankName?.trim() ? { bankName: i.bankName.trim() } : {}) };
  }
  const upiId = String(i.upiId ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,256}@[a-z][a-z0-9]{1,63}$/.test(upiId)) throw err(400, 'INVALID_UPI_ID', 'UPI ID must look like name@bank');
  return { method: 'upi', upiId, ...(i.accountName?.trim() ? { accountName: i.accountName.trim() } : {}) };
}

/**
 * Sets the destination. Any change (even to the same values) bumps the version and needs a fresh admin verification
 * before the next payout, so a compromised login cannot redirect money silently. Partner side: owners only.
 */
export async function setPayoutDetails(target: { ownerKind: 'partner' | 'doctor'; ownerId: string } | { accountId: string },
  input: PayoutDetailsInput, actor: FinanceActor) {
  if (actor.kind === 'member' && actor.partner.role !== 'owner') throw err(403, 'OWNER_REQUIRED', 'Only an owner can change where payouts are sent');
  const details = normalizeDetails(input);
  const base = 'accountId' in target ? await accountById(canon(target.accountId)) : await ensureOwnerAccount(target.ownerKind, target.ownerId);
  const updated = await inTransaction(async (s) => {
    const current = await bumpFinance(String(base._id), s);
    if (input.expectedDetailsVersion !== undefined && (current.payoutDetailsVersion ?? 0) !== input.expectedDetailsVersion) {
      throw err(409, 'PAYOUT_DETAILS_CHANGED', 'The payout details changed since they were loaded; review them again');
    }
    const a = await SettlementAccountModel.findOneAndUpdate({ _id: base._id },
      { $set: { payoutDetails: details, payoutDetailsState: 'unverified', payoutDetailsChangedAt: new Date() }, $inc: { payoutDetailsVersion: 1 },
        $unset: { payoutDetailsVerifiedAt: 1, payoutDetailsVerifiedBy: 1 } }, { new: true, session: s }).lean() as ISettlementAccount;
    await recordFinanceEvent(a, actor, 'finance.payout_details_changed',
      { method: details.method, last4: details.accountNumberLast4, ifsc: details.ifsc, upiId: details.upiId, version: a.payoutDetailsVersion }, s);
    return a;
  });
  return accountView(updated, actor.kind === 'admin');
}

/** Admin confirms the destination they checked (penny drop / documents). Refused if it changed since they looked. */
export async function verifyPayoutDetails(rawAccountId: string, version: number, adminId: string) {
  const accountId = canon(rawAccountId);
  const updated = await inTransaction(async (s) => {
    const before = await accountById(accountId, s);
    if (before.payoutDetailsState === 'verified' && before.payoutDetailsVersion === version) return before;
    if (before.payoutDetailsState !== 'unverified' || before.payoutDetailsVersion !== version) {
      throw err(409, 'PAYOUT_DETAILS_CHANGED', 'The payout details changed since they were loaded; review them again');
    }
    await bumpFinance(accountId, s);
    const a = await SettlementAccountModel.findOneAndUpdate({ _id: accountId, payoutDetailsVersion: version, payoutDetailsState: 'unverified' },
      { $set: { payoutDetailsState: 'verified', payoutDetailsVerifiedAt: new Date(), payoutDetailsVerifiedBy: adminId } }, { new: true, session: s }).lean() as ISettlementAccount | null;
    if (!a) throw err(409, 'PAYOUT_DETAILS_CHANGED', 'The payout details changed since they were loaded; review them again');
    await recordFinanceEvent(a, { kind: 'admin', id: adminId }, 'finance.payout_details_verified', { version }, s);
    return a;
  });
  return accountView(updated, true);
}

// ── Payouts and adjustments (admin) ──

export interface RecordPayoutInput {
  amountMinor: number; method: 'bank_transfer' | 'upi' | 'other'; reference: string; paidOn: string; note?: string;
  detailsVersion: number; requestKey: string;
  /** Q13: the account's financeVersion the admin decided on (a fence, not part of the request's identity). */
  expectedFinanceVersion?: number;
}

const hashOf = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const publicPayout = (p: ISettlementPayout) => { const { requestKey: _k, requestHash: _h, ...rest } = p; return rest; };

/**
 * Records a transfer the admin made. One transaction: serialize on the account, require the verified destination
 * version the admin saw, refuse more than the balance, insert the payout and its `payout` ledger entry. Exactly once
 * per (admin, requestKey): a replay returns the original; the same key with different content is refused.
 */
export async function recordPayout(adminId: string, rawAccountId: string, input: RecordPayoutInput) {
  if (!Types.ObjectId.isValid(rawAccountId)) throw err(404, 'SETTLEMENT_ACCOUNT_NOT_FOUND', 'Settlement account not found');
  const accountId = canon(rawAccountId);
  const amount = input.amountMinor;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_MINOR) throw err(400, 'INVALID_AMOUNT', 'Amount must be a positive number of paise');
  const reference = String(input.reference ?? '').trim();
  if (reference.length < 4 || reference.length > 64) throw err(400, 'INVALID_REFERENCE', 'Reference (UTR) must be 4 to 64 characters');
  if (!isRealDate(input.paidOn) || input.paidOn > istDate(new Date())) throw err(400, 'INVALID_DATE', 'paidOn must be a real date, not in the future');
  const requestHash = hashOf({ accountId, amount, method: input.method, reference, paidOn: input.paidOn,
    note: input.note?.trim() || null, detailsVersion: input.detailsVersion });
  const replay = async (s?: ClientSession) => {
    const p = await SettlementPayoutModel.findOne({ by: adminId, requestKey: input.requestKey }).session(s ?? null).lean() as ISettlementPayout | null;
    if (!p) return null;
    if (p.requestHash !== requestHash) throw err(409, 'REQUEST_KEY_REUSED', 'This request key was already used for a different payout');
    return { payout: publicPayout(p), replayed: true };
  };
  const prior = await replay();
  if (prior) return prior;
  try {
    return await inTransaction(async (s) => {
      const again = await replay(s);
      if (again) return again;
      // Q13: claimed with the payout, so an admin's give-up of a lost answer and this payout cannot both win.
      await claimRequestKey(payoutKeyScope(accountId, adminId), input.requestKey, s);
      const a = await bumpFinance(accountId, s, input.expectedFinanceVersion);
      if (!a.isActive) throw err(409, 'ACCOUNT_INACTIVE', 'This settlement account is inactive');
      // r24 (O1, §26.9): referral cuts accrue, but are not paid out until the tax question is answered.
      if (isReferralOwnerKind(a.ownerKind) && !assistedFlags.referralPayouts()) {
        throw err(409, 'REFERRAL_PAYOUTS_DISABLED', 'Referral payouts are paused until the tax question is answered');
      }
      if (!a.payoutDetails || a.payoutDetailsState !== 'verified') throw err(409, 'PAYOUT_DETAILS_NOT_VERIFIED', 'Verify the payout details before recording a payout');
      if (a.payoutDetailsVersion !== input.detailsVersion) throw err(409, 'PAYOUT_DETAILS_CHANGED', 'The payout details changed since they were loaded; review them again');
      const balance = await ledgerBalance(String(a._id), s);
      if (amount > balance) throw err(409, 'INSUFFICIENT_BALANCE', `The balance is ₹${rupees(balance)}; a payout cannot exceed it`);
      if (await SettlementPayoutModel.exists({ settlementAccountId: String(a._id), reference, state: 'recorded' }).session(s)) {
        throw err(409, 'PAYOUT_REFERENCE_EXISTS', 'A payout with this reference is already recorded for this account');
      }
      const [p] = await SettlementPayoutModel.create([{ settlementAccountId: String(a._id), amountMinor: amount, method: input.method, reference,
        paidOn: input.paidOn, ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        destination: { method: a.payoutDetails.method, label: destinationLabel(a.payoutDetails), detailsVersion: a.payoutDetailsVersion },
        state: 'recorded', by: adminId, requestKey: input.requestKey, requestHash }], { session: s });
      const payout = p!.toObject() as ISettlementPayout;
      await postLedgerEntry({ settlementAccountId: String(a._id), kind: 'payout', amountMinor: -amount, grossMinor: amount, source: 'payout',
        sourceId: String(payout._id), reference, note: input.note?.trim() || undefined, by: `admin:${adminId}`, byKind: 'admin' }, s);
      await recordFinanceEvent(a, { kind: 'admin', id: adminId }, 'finance.payout_recorded',
        { payoutId: String(payout._id), amountMinor: amount, reference, paidOn: input.paidOn, balanceBeforeMinor: balance }, s);
      return { payout: publicPayout(payout), replayed: false };
    });
  } catch (e: any) {
    // Two submissions of one key: the loser's insert hits the unique key — answer as the replay it is.
    if (e?.code === 11000) {
      const r = await replay();
      if (r) return r;
      if (await RequestKeyModel.exists({ scope: payoutKeyScope(accountId, adminId), key: input.requestKey, state: 'abandoned' })) {
        throw err(409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
      }
      throw err(409, 'PAYOUT_REFERENCE_EXISTS', 'A payout with this reference is already recorded for this account');
    }
    throw e;
  }
}

/** A payout recorded by mistake: marked voided and compensated by an `adjustment` (+amount), exactly once. */
export async function voidPayout(adminId: string, rawPayoutId: string, reason: string) {
  if (!Types.ObjectId.isValid(rawPayoutId)) throw err(404, 'PAYOUT_NOT_FOUND', 'Payout not found');
  const payoutId = canon(rawPayoutId);
  const why = String(reason ?? '').trim();
  if (why.length < 3 || why.length > 500) throw err(400, 'INVALID_REASON', 'Give a reason (3 to 500 characters)');
  return inTransaction(async (s) => {
    const p = await SettlementPayoutModel.findById(payoutId).session(s).lean() as ISettlementPayout | null;
    if (!p) throw err(404, 'PAYOUT_NOT_FOUND', 'Payout not found');
    if (p.state === 'voided') return publicPayout(p);
    const a = await bumpFinance(p.settlementAccountId, s);
    const v = await SettlementPayoutModel.findOneAndUpdate({ _id: payoutId, state: 'recorded' },
      { $set: { state: 'voided', voidReason: why, voidedAt: new Date(), voidedBy: adminId } }, { new: true, session: s }).lean() as ISettlementPayout | null;
    if (!v) throw err(409, 'PAYOUT_CHANGED', 'Payout changed; please retry');
    await postLedgerEntry({ settlementAccountId: p.settlementAccountId, kind: 'adjustment', amountMinor: p.amountMinor, grossMinor: p.amountMinor,
      source: 'payout_void', sourceId: String(p._id), reference: p.reference, note: why, by: `admin:${adminId}`, byKind: 'admin' }, s);
    await recordFinanceEvent(a, { kind: 'admin', id: adminId }, 'finance.payout_voided', { payoutId: String(p._id), amountMinor: p.amountMinor, reason: why }, s);
    return publicPayout(v);
  });
}

/**
 * Admin correction (+ credit / − recovery) with a reason, exactly once per (admin, requestKey). It may take the balance
 * below zero: a recovery owed is a fact to record, not something to refuse.
 */
export async function postAdjustment(adminId: string, rawAccountId: string,
  input: { amountMinor: number; reason: string; requestKey: string; expectedFinanceVersion?: number }) {
  if (!Types.ObjectId.isValid(rawAccountId)) throw err(404, 'SETTLEMENT_ACCOUNT_NOT_FOUND', 'Settlement account not found');
  const accountId = canon(rawAccountId);
  const amount = input.amountMinor;
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > MAX_MINOR) throw err(400, 'INVALID_AMOUNT', 'Amount must be a non-zero number of paise');
  const why = String(input.reason ?? '').trim();
  if (why.length < 3 || why.length > 500) throw err(400, 'INVALID_REASON', 'Give a reason (3 to 500 characters)');
  const sourceId = `${adminId}:${input.requestKey}`;
  const replay = async (s?: ClientSession) => {
    const existing = await LedgerEntryModel.findOne({ settlementAccountId: accountId, source: 'admin_adjustment', sourceId, kind: 'adjustment' }).session(s ?? null).lean() as ILedgerEntry | null;
    if (!existing) return null;
    if (existing.amountMinor !== amount || existing.note !== why) throw err(409, 'REQUEST_KEY_REUSED', 'This request key was already used for a different adjustment');
    return { entry: existing, replayed: true };
  };
  try {
    return await postAdjustmentOnce(s => replay(s));
  } catch (e: any) {
    // Q13 review: a concurrent identical submission (or a competing give-up) makes this attempt's claim insert collide.
    // Answer as the payout path does: the matching receipt, or REQUEST_ABANDONED for a key given up.
    if (e?.code === 11000) {
      const r = await replay();
      if (r) return r;
      if (await RequestKeyModel.exists({ scope: adjustmentKeyScope(accountId, adminId), key: input.requestKey, state: 'abandoned' })) {
        throw err(409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
      }
    }
    throw e;
  }

  function postAdjustmentOnce(again: (s: ClientSession) => Promise<{ entry: ILedgerEntry; replayed: boolean } | null>) {
    return inTransaction(async (s) => {
    const prior = await again(s);
    if (prior) return prior;
    // Q13: claimed with the entry (see recordPayout); the version fence is checked on the account as it is now.
    await claimRequestKey(adjustmentKeyScope(accountId, adminId), input.requestKey, s);
    const a = await bumpFinance(accountId, s, input.expectedFinanceVersion);
    const entry = await postLedgerEntry({ settlementAccountId: String(a._id), kind: 'adjustment', amountMinor: amount, grossMinor: Math.abs(amount),
      source: 'admin_adjustment', sourceId, note: why, by: `admin:${adminId}`, byKind: 'admin' }, s);
    await recordFinanceEvent(a, { kind: 'admin', id: adminId }, 'finance.adjustment_posted', { entryId: String(entry._id), amountMinor: amount, reason: why }, s);
    return { entry: entry as ILedgerEntry, replayed: false };
    });
  }
}

// ── Q13: a lost payout/adjustment answer — look it up by its key, or give the key up ──

/** The payout this admin recorded on this account with this key, or null. */
export async function payoutByKey(adminId: string, rawAccountId: string, key: string) {
  const a = await accountById(rawAccountId);
  const p = await SettlementPayoutModel.findOne({ settlementAccountId: String(a._id), by: { $eq: adminId }, requestKey: { $eq: key } }).lean() as ISettlementPayout | null;
  return p ? publicPayout(p) : null;
}

/** Abandoned (the key can never record a payout on this account) or used (here is the payout). */
export async function abandonPayoutKey(adminId: string, rawAccountId: string, key: string) {
  const a = await accountById(rawAccountId);
  // A payout recorded before claims existed (no claim row) is used, never abandoned.
  const made = await payoutByKey(adminId, String(a._id), key);
  if (made) return { state: 'used' as const, payout: made };
  const state = await abandonRequestKey(payoutKeyScope(String(a._id), adminId), key);
  return state === 'abandoned' ? { state } : { state, payout: await payoutByKey(adminId, String(a._id), key) };
}

/** The adjustment entry this admin posted on this account with this key, or null. */
export async function adjustmentByKey(adminId: string, rawAccountId: string, key: string) {
  const a = await accountById(rawAccountId);
  return (await LedgerEntryModel.findOne({ settlementAccountId: String(a._id), source: 'admin_adjustment', sourceId: `${adminId}:${key}`, kind: 'adjustment' })
    .lean()) as ILedgerEntry | null;
}

export async function abandonAdjustmentKey(adminId: string, rawAccountId: string, key: string) {
  const a = await accountById(rawAccountId);
  const made = await adjustmentByKey(adminId, String(a._id), key);
  if (made) return { state: 'used' as const, entry: made };
  const state = await abandonRequestKey(adjustmentKeyScope(String(a._id), adminId), key);
  return state === 'abandoned' ? { state } : { state, entry: await adjustmentByKey(adminId, String(a._id), key) };
}

// ── Admin lists ──

/**
 * Every matching account with its balance; `due` = balance above zero (the payout queue), largest first. Balances,
 * the due filter, totals, ordering and the page are all computed by the database over every matching account.
 */
export async function adminListAccounts(q: { ownerKind?: 'partner' | 'doctor'; due?: boolean; search?: string; detailsState?: string; limit?: number; skip?: number }) {
  const filter: Record<string, unknown> = {};
  if (q.ownerKind) filter.ownerKind = q.ownerKind;
  if (q.detailsState) filter.payoutDetailsState = q.detailsState;
  if (q.search?.trim()) filter.beneficiaryName = { $regex: q.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const skip = Math.max(0, Number(q.skip) || 0);
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const [out] = await SettlementAccountModel.aggregate([
    { $match: filter },
    { $lookup: { from: LedgerEntryModel.collection.name, let: { id: { $toString: '$_id' } },
      pipeline: [{ $match: { $expr: { $eq: ['$settlementAccountId', '$$id'] } } }, { $group: { _id: null, total: { $sum: '$amountMinor' } } }], as: 'ledger' } },
    { $addFields: { balanceMinor: { $ifNull: [{ $arrayElemAt: ['$ledger.total', 0] }, 0] } } },
    ...(q.due ? [{ $match: { balanceMinor: { $gt: 0 } } }] : []),
    { $facet: {
      rows: [{ $sort: { balanceMinor: -1, beneficiaryName: 1, _id: 1 } }, { $skip: skip }, { $limit: limit }, { $project: { ledger: 0 } }],
      meta: [{ $group: { _id: null, total: { $sum: 1 }, totalDueMinor: { $sum: { $max: ['$balanceMinor', 0] } } } }],
    } },
  ]);
  const meta = out?.meta?.[0] ?? { total: 0, totalDueMinor: 0 };
  return {
    total: meta.total, totalDueMinor: meta.totalDueMinor,
    rows: (out?.rows ?? []).map((a: ISettlementAccount & { balanceMinor: number }) => ({ ...accountView(a, false), balanceMinor: a.balanceMinor })),
  };
}

type PayoutQuery = { accountId?: string; from?: string; to?: string; state?: 'recorded' | 'voided'; limit?: number };

function payoutFilter(q: PayoutQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (q.accountId) filter.settlementAccountId = canon(q.accountId);
  if (q.state) filter.state = q.state;
  if (q.from || q.to) {
    if ((q.from && !isRealDate(q.from)) || (q.to && !isRealDate(q.to))) throw err(400, 'INVALID_DATE', 'Dates must be real, YYYY-MM-DD');
    filter.paidOn = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  }
  return filter;
}

export async function adminListPayouts(q: PayoutQuery) {
  return SettlementPayoutModel.find(payoutFilter(q)).sort({ paidOn: -1, createdAt: -1 }).limit(Math.min(Number(q.limit) || 100, 500))
    .select({ requestKey: 0, requestHash: 0 }).lean();
}

/**
 * Q13: the admin payout queue, newest recorded first with an exact `<createdAt ms>_<id>` cursor and the total, each row
 * naming its account (beneficiary, owner kind/id and the owner's current display name).
 */
export async function adminPayoutsPage(q: PayoutQuery & { cursor?: string }) {
  const page = await cursorPage<ISettlementPayout>(SettlementPayoutModel, payoutFilter(q), 'createdAt', q, 100, { requestKey: 0, requestHash: 0 });
  const accountIds = [...new Set(page.items.map((p) => canon(p.settlementAccountId)))].filter((x) => Types.ObjectId.isValid(x));
  const accounts = await SettlementAccountModel.find({ _id: { $in: accountIds } }).select({ ownerKind: 1, ownerId: 1, beneficiaryName: 1 }).lean() as ISettlementAccount[];
  const ids = (kind: 'partner' | 'doctor') => accounts.filter((a) => a.ownerKind === kind).map((a) => a.ownerId).filter((x) => Types.ObjectId.isValid(x));
  const [partners, doctors] = await Promise.all([
    PartnerOrgModel.find({ _id: { $in: ids('partner') } }).select({ name: 1 }).lean().exec() as Promise<{ _id: unknown; name?: string }[]>,
    SpecialistModel.find({ _id: { $in: ids('doctor') } }).select({ name: 1 }).lean().exec() as Promise<{ _id: unknown; name?: string }[]>,
  ]);
  const names = new Map([...partners, ...doctors].map((x) => [canon(String(x._id)), x.name]));
  const byId = new Map(accounts.map((a) => [canon(String(a._id)), a]));
  return {
    ...page,
    items: page.items.map((p) => {
      const a = byId.get(canon(p.settlementAccountId));
      return { ...p, account: a ? { accountId: String(a._id), ownerKind: a.ownerKind, ownerId: a.ownerId, beneficiaryName: a.beneficiaryName,
        ownerName: names.get(canon(a.ownerId)) ?? null } : null };
    }),
  };
}

export async function adminAccountEvents(accountId: string) {
  return SettlementEventModel.find({ settlementAccountId: canon(accountId) }).sort({ at: -1 }).limit(200).lean();
}

export { ensureOwnerAccount };

// ── Q16a: consultations that were paid and are over but were never marked completed or no-show ──

export interface UnmarkedConsultationQuery { doctorId?: string; from?: string; to?: string; cursor?: string; limit?: number }

/**
 * Q16a (owner, 22 Nov 2026): a ledger consultation that is not marked completed stays unpaid to the doctor. Admins
 * list the past ones — paid through us, settled by the ledger, appointment day before today (India time), still
 * pending/confirmed (never completed, no-show or cancelled) — to chase the doctor. Newest booked first, exact
 * `<createdAt ms>_<id>` cursor and the total, as the other admin lists. `from`/`to` (YYYY-MM-DD) narrow the appointment day.
 */
export async function adminUnmarkedConsultations(q: UnmarkedConsultationQuery, now = new Date()) {
  const today = istDate(now).replace(/-/g, '');
  const day: Record<string, string> = { $lt: today };
  if (q.from) day.$gte = q.from.replace(/-/g, '');
  if (q.to && q.to.replace(/-/g, '') < today) { day.$lte = q.to.replace(/-/g, ''); delete day.$lt; }
  const filter: Record<string, unknown> = {
    bookingType: { $in: ['consultation', 'second-opinion'] }, settlementSystem: 'ledger', paymentStatus: 'paid',
    // Q16a re-review (H): a free (zero-price) consultation earns nothing either way: not listed.
    price: { $gt: 0 },
    status: { $in: ['pending', 'confirmed'] }, bookingDate: day,
    ...(q.doctorId ? { specialistId: { $in: [canon(q.doctorId), String(q.doctorId)] } } : {}),
  };
  const page = await cursorPage<Record<string, any>>(BookingModel, filter, 'createdAt', q, 100);
  return {
    total: page.total, nextCursor: page.nextCursor,
    items: page.items.map((b) => ({
      bookingId: String(b._id), doctorId: b.specialistId, doctorName: b.doctorName ?? null, bookingDate: b.bookingDate, bookingTime: b.bookingTime,
      bookingKind: b.bookingKind ?? 'scheduled', consultationMode: b.consultationMode ?? null, status: b.status,
      priceMinor: Math.round(Number(b.price ?? 0) * 100), bookedAt: b.createdAt,
    })),
  };
}

/**
 * Q16a re-review (E): legacy payout months flagged for recalculation — a moved no-show billed in that (original) month
 * changed after the month was computed. Ids only; recalculating the month (payouts "calculate billings") clears it.
 */
export async function adminLegacyRecalculations(q: { cursor?: string; limit?: number }) {
  const { PayoutBillingModel } = await import('@/modules/payouts/model');
  const page = await cursorPage<Record<string, any>>(PayoutBillingModel, { needsRecalculation: true }, 'createdAt', q, 100);
  return { total: page.total, nextCursor: page.nextCursor,
    items: page.items.map((b) => ({ billingId: String(b._id), doctorId: b.specialistId, month: b.month, bookingIds: b.recalculationReasons ?? [] })) };
}
