import crypto from 'crypto';
import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import {
  SettlementAccountModel, LedgerEntryModel, LedgerHistoryRefModel, SettlementPayoutModel, SettlementEventModel,
  ISettlementAccount, ILedgerEntry, IPayoutDetails, ISettlementPayout,
} from '@/modules/partners/model/settlement';
import PartnerOrgModel from '@/modules/partners/model';
import SpecialistModel from '@/modules/specialists/model';
import BookingModel from '@/modules/bookings/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PartnerActor, adminActor, hasGlobalScope, inTransaction, recordPartnerAudit } from '@/modules/partners/services';
import { ensureSettlementAccount, ledgerBalance, postLedgerEntry } from '@/modules/partners/services/settlement';
import { istDate, isRealDate } from '@/modules/partners/services/slots';

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
  | { kind: 'doctor'; id: string };

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const MAX_MINOR = 1_000_000_000_00; // ₹1,00,00,00,000 — far above any single payout or adjustment

// ── Accounts ──

export async function accountById(id: string, s?: ClientSession): Promise<ISettlementAccount> {
  if (!Types.ObjectId.isValid(id)) throw err(404, 'SETTLEMENT_ACCOUNT_NOT_FOUND', 'Settlement account not found');
  const a = await SettlementAccountModel.findById(id).session(s ?? null).lean() as ISettlementAccount | null;
  if (!a) throw err(404, 'SETTLEMENT_ACCOUNT_NOT_FOUND', 'Settlement account not found');
  return a;
}

/** Reads never create: a partner/doctor without an account yet simply has nothing to show. */
export async function findOwnerAccount(ownerKind: 'partner' | 'doctor', ownerId: string): Promise<ISettlementAccount | null> {
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
  };
}

function destinationLabel(d: IPayoutDetails): string {
  return d.method === 'upi' ? `UPI ${d.upiId}` : `${d.bankName ? d.bankName + ' ' : ''}${d.ifsc} ${maskNumber(d.accountNumber)}`;
}

// ── Audit ──

async function recordFinanceEvent(account: ISettlementAccount, actor: FinanceActor, action: string, detail: Record<string, unknown>, s: ClientSession) {
  const by = actor.kind === 'member' ? actor.partner.memberId : actor.id;
  await SettlementEventModel.create([{ settlementAccountId: String(account._id), action, byKind: actor.kind, by, detail, at: new Date() }], { session: s });
  if (account.ownerKind === 'partner') {
    const pa = actor.kind === 'member' ? actor.partner : actor.kind === 'admin' ? adminActor(actor.id, account.ownerId) : null;
    if (pa) await recordPartnerAudit(pa, action, { kind: 'settlement_account', id: String(account._id) }, detail, s);
  }
}

/** Every spending/correcting decision and destination change serializes on the account (see module note). */
async function bumpFinance(accountId: string, s: ClientSession): Promise<ISettlementAccount> {
  const a = await SettlementAccountModel.findOneAndUpdate({ _id: accountId }, { $inc: { financeVersion: 1 } }, { new: true, session: s }).lean();
  if (!a) throw err(404, 'SETTLEMENT_ACCOUNT_NOT_FOUND', 'Settlement account not found');
  return a as ISettlementAccount;
}

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
  const pays = await SettlementPayoutModel.find({ _id: { $in: [...ids('payout'), ...ids('payout_void')] } }).select({ reference: 1, paidOn: 1, destination: 1 }).lean() as any[];
  for (const p of pays) {
    out.set(`payout:${p._id}`, `Payout · ${p.paidOn} · ${p.destination?.label ?? ''}`.trim());
    out.set(`payout_void:${p._id}`, `Payout voided · ${p.paidOn} · ref ${p.reference}`);
  }
  return out;
}

const FALLBACK: Record<string, string> = {
  partner_lab_booking: 'Lab booking', consultation: 'Consultation', payout: 'Payout', payout_void: 'Payout voided', admin_adjustment: 'Adjustment',
};

/** Balance after `e` = Σ every entry at or before it in (at, _id) order — independent of any date filter. */
async function balanceThrough(accountId: string, e: Pick<ILedgerEntry, 'at'> & { _id?: unknown }): Promise<number> {
  const agg = await LedgerEntryModel.aggregate([
    { $match: { settlementAccountId: accountId, $or: [{ at: { $lt: e.at } }, { at: e.at, _id: { $lte: e._id } }] } },
    { $group: { _id: null, total: { $sum: '$amountMinor' } } },
  ]);
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
  const page = await LedgerEntryModel.find(filter).sort({ at: -1, _id: -1 }).limit(limit + 1).lean() as ILedgerEntry[];
  const more = page.length > limit;
  const entries = page.slice(0, limit);
  const labels = await describe(entries);
  let after = entries.length ? await balanceThrough(id, entries[0]!) : 0;
  const lines: StatementLine[] = entries.map((e) => {
    const line = { _id: String(e._id), at: e.at, kind: e.kind, source: e.source, sourceId: e.sourceId,
      description: labels.get(`${e.source}:${e.sourceId}`) ?? FALLBACK[e.source] ?? e.source, reference: e.reference, note: e.note,
      amountMinor: e.amountMinor, balanceAfterMinor: after };
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

/** Oldest first for a period (at most 5,000 lines), opening and closing balance included. */
export async function statementCsv(account: ISettlementAccount | null, opts: { from?: string; to?: string }): Promise<string> {
  const header = ['Date (IST)', 'Type', 'Description', 'Reference', 'Note', 'Amount (INR)', 'Balance (INR)'].map(cell).join(',');
  if (!account) return header + '\n';
  const id = String(account._id);
  const entries = await LedgerEntryModel.find({ settlementAccountId: id, ...range(opts.from, opts.to) }).sort({ at: 1, _id: 1 }).limit(5000).lean() as ILedgerEntry[];
  const labels = await describe(entries);
  let bal = entries.length ? (await balanceThrough(id, entries[0]!)) - entries[0]!.amountMinor : 0;
  const rows = [header, ['', 'Opening balance', '', '', '', '', rupees(bal)].map(cell).join(',')];
  for (const e of entries) {
    bal += e.amountMinor;
    rows.push([istStamp(e.at), e.kind, labels.get(`${e.source}:${e.sourceId}`) ?? FALLBACK[e.source] ?? e.source, e.reference, e.note,
      rupees(e.amountMinor), rupees(bal)].map(cell).join(','));
  }
  rows.push(['', 'Closing balance', '', '', '', '', rupees(bal)].map(cell).join(','));
  return rows.join('\n') + '\n';
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

export interface PayoutDetailsInput { method: 'bank' | 'upi'; accountName?: string; accountNumber?: string; ifsc?: string; bankName?: string; upiId?: string }

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
  const base = 'accountId' in target ? await accountById(target.accountId) : await ensureOwnerAccount(target.ownerKind, target.ownerId);
  const updated = await inTransaction(async (s) => {
    await bumpFinance(String(base._id), s);
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
export async function verifyPayoutDetails(accountId: string, version: number, adminId: string) {
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
}

const hashOf = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const publicPayout = (p: ISettlementPayout) => { const { requestKey: _k, requestHash: _h, ...rest } = p; return rest; };

/**
 * Records a transfer the admin made. One transaction: serialize on the account, require the verified destination
 * version the admin saw, refuse more than the balance, insert the payout and its `payout` ledger entry. Exactly once
 * per (admin, requestKey): a replay returns the original; the same key with different content is refused.
 */
export async function recordPayout(adminId: string, accountId: string, input: RecordPayoutInput) {
  const amount = input.amountMinor;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_MINOR) throw err(400, 'INVALID_AMOUNT', 'Amount must be a positive number of paise');
  const reference = String(input.reference ?? '').trim();
  if (reference.length < 4 || reference.length > 64) throw err(400, 'INVALID_REFERENCE', 'Reference (UTR) must be 4 to 64 characters');
  if (!isRealDate(input.paidOn) || input.paidOn > istDate(new Date())) throw err(400, 'INVALID_DATE', 'paidOn must be a real date, not in the future');
  const requestHash = hashOf({ accountId: String(accountId).toLowerCase(), amount, method: input.method, reference, paidOn: input.paidOn,
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
      const a = await bumpFinance(accountId, s);
      if (!a.isActive) throw err(409, 'ACCOUNT_INACTIVE', 'This settlement account is inactive');
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
      throw err(409, 'PAYOUT_REFERENCE_EXISTS', 'A payout with this reference is already recorded for this account');
    }
    throw e;
  }
}

/** A payout recorded by mistake: marked voided and compensated by an `adjustment` (+amount), exactly once. */
export async function voidPayout(adminId: string, payoutId: string, reason: string) {
  if (!Types.ObjectId.isValid(payoutId)) throw err(404, 'PAYOUT_NOT_FOUND', 'Payout not found');
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
export async function postAdjustment(adminId: string, accountId: string, input: { amountMinor: number; reason: string; requestKey: string }) {
  const amount = input.amountMinor;
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > MAX_MINOR) throw err(400, 'INVALID_AMOUNT', 'Amount must be a non-zero number of paise');
  const why = String(input.reason ?? '').trim();
  if (why.length < 3 || why.length > 500) throw err(400, 'INVALID_REASON', 'Give a reason (3 to 500 characters)');
  const sourceId = `${adminId}:${input.requestKey}`;
  return inTransaction(async (s) => {
    const existing = await LedgerEntryModel.findOne({ settlementAccountId: String(accountId), source: 'admin_adjustment', sourceId, kind: 'adjustment' }).session(s).lean() as ILedgerEntry | null;
    if (existing) {
      if (existing.amountMinor !== amount || existing.note !== why) throw err(409, 'REQUEST_KEY_REUSED', 'This request key was already used for a different adjustment');
      return { entry: existing, replayed: true };
    }
    const a = await bumpFinance(accountId, s);
    const entry = await postLedgerEntry({ settlementAccountId: String(a._id), kind: 'adjustment', amountMinor: amount, grossMinor: Math.abs(amount),
      source: 'admin_adjustment', sourceId, note: why, by: `admin:${adminId}`, byKind: 'admin' }, s);
    await recordFinanceEvent(a, { kind: 'admin', id: adminId }, 'finance.adjustment_posted', { entryId: String(entry._id), amountMinor: amount, reason: why }, s);
    return { entry, replayed: false };
  });
}

// ── Admin lists ──

/** Every account with its balance; `due` = balance above zero (the payout queue), largest first. */
export async function adminListAccounts(q: { ownerKind?: 'partner' | 'doctor'; due?: boolean; search?: string; detailsState?: string; limit?: number; skip?: number }) {
  const filter: Record<string, unknown> = {};
  if (q.ownerKind) filter.ownerKind = q.ownerKind;
  if (q.detailsState) filter.payoutDetailsState = q.detailsState;
  if (q.search?.trim()) filter.beneficiaryName = { $regex: q.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const accounts = await SettlementAccountModel.find(filter).limit(5000).lean() as ISettlementAccount[];
  const sums = await LedgerEntryModel.aggregate([
    { $match: { settlementAccountId: { $in: accounts.map((a) => String(a._id)) } } },
    { $group: { _id: '$settlementAccountId', total: { $sum: '$amountMinor' } } },
  ]);
  const bal = new Map(sums.map((x: { _id: string; total: number }) => [x._id, x.total]));
  let rows = accounts.map((a) => ({ ...accountView(a, false), balanceMinor: bal.get(String(a._id)) ?? 0 }));
  if (q.due) rows = rows.filter((r) => r.balanceMinor > 0);
  rows.sort((x, y) => y.balanceMinor - x.balanceMinor || x.beneficiaryName.localeCompare(y.beneficiaryName));
  const skip = Math.max(0, Number(q.skip) || 0);
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  return { total: rows.length, totalDueMinor: rows.reduce((t, r) => t + Math.max(0, r.balanceMinor), 0), rows: rows.slice(skip, skip + limit) };
}

export async function adminListPayouts(q: { accountId?: string; from?: string; to?: string; state?: 'recorded' | 'voided'; limit?: number }) {
  const filter: Record<string, unknown> = {};
  if (q.accountId) filter.settlementAccountId = String(q.accountId);
  if (q.state) filter.state = q.state;
  if (q.from || q.to) {
    if ((q.from && !isRealDate(q.from)) || (q.to && !isRealDate(q.to))) throw err(400, 'INVALID_DATE', 'Dates must be real, YYYY-MM-DD');
    filter.paidOn = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  }
  return SettlementPayoutModel.find(filter).sort({ paidOn: -1, createdAt: -1 }).limit(Math.min(Number(q.limit) || 100, 500))
    .select({ requestKey: 0, requestHash: 0 }).lean();
}

export async function adminAccountEvents(accountId: string) {
  return SettlementEventModel.find({ settlementAccountId: String(accountId) }).sort({ at: -1 }).limit(200).lean();
}

export { ensureOwnerAccount };
