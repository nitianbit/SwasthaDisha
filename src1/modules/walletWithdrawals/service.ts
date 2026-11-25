import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { assistedFlags, withdrawalMinMinor } from '@/modules/assisted/flags';
import { auditIn } from '@/modules/assisted/support';
import { assertBookerWalletIndexes } from '@/modules/assisted/bookerWallet';
import { postMovementIn, walletTransaction, type WalletState, type WalletStore } from '@/modules/pharmacyWallet/walletCore';
import { planLots, withdrawableNowFilter, withdrawableNowOf, type WalletRef } from '@/modules/pharmacyWallet/walletLots';
import { WalletTopupLotModel } from '@/modules/pharmacyWallet/model/lots';
import { pharmacyStore } from '@/modules/pharmacyWallet/ledger';
import { partnerStore } from '@/modules/partnerWallets/ledger';
import PharmacyModel from '@/modules/pharmacies/model';
import PartnerOrgModel from '@/modules/partners/model';
import SpecialistModel from '@/modules/specialists/model';
import { HOME_KIND, SettlementAccountModel, SettlementEventModel, type ISettlementAccount } from '@/modules/partners/model/settlement';
import { ensureSettlementAccount } from '@/modules/partners/services/settlement';
import { assertPartnerFinanceReader, destinationLabel, destinationOf, setPayoutDetails, type PayoutDetailsInput } from '@/modules/partners/services/finance';
import { hasGlobalScope, type PartnerActor } from '@/modules/partners/services';
import { isRealDate, istDate } from '@/modules/partners/services/slots';
import { abandonRequestKey, claimRequestKey } from '@/modules/requestKeys';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { WalletWithdrawalModel, type IWalletWithdrawal, type WithdrawalState, type WithdrawalWalletKind } from '@/modules/walletWithdrawals/model';

/**
 * Round 4d (ASSISTED_BOOKING_DESIGN.md §26.8): wallet withdrawals of pharmacies, labs and doctors — built, OFF
 * (`WALLET_WITHDRAWALS_ENABLED`, GATE-RBI). Money moves only through the shared wallet rules (`walletCore`):
 * - request: one transaction — the key claimed, the home account's destination verified at the version the owner saw,
 *   the wallet read fresh (frozen, receivable), one withdrawal per rolling 7 days (Q5), only card money withdrawable NOW
 *   (past its 7-day hold, oldest first), the `withdrawal_hold` debit (its compare-and-set on the wallet version also
 *   serialises two requests), the row and its audit;
 * - cancel (owner) / reject (admin): `requested` → state on `version`, `withdrawal_release` restores the lots; always posts;
 * - paid (admin): `requested` → `paid` only (a compare-and-set; nothing moves, M7), the reference (UTR) once per home
 *   account, a `withdrawal_paid` SettlementEvent on the home account;
 * - void (admin): `paid` → `voided` (the transfer bounced), `withdrawal_void` restores the gross and the lots; always posts.
 * Owner decision 25 Nov: the card fee is deducted only from UNSPENT card money withdrawn — each lot's gateway fee in
 * proportion to what is withdrawn from it (rounded down: the remainder stays Jansetu's); money spent on bookings never
 * pays a fee. Integer paise; no PII in logs or audits (ids, amounts, codes).
 */
const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new AppError({ status, code, message }), extra);
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const WEEK_MS = 7 * 86_400_000;
const notFound = () => err(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal not found');
const rupees = (m: number) => (m / 100).toFixed(2);

/**
 * Who withdraws: the wallet (its kind and owner id) and the person acting for it. r35b: `member`, a lab's acting member as
 * re-read for the request (role, permissions, branch scope); absent for a pharmacy or a doctor (the owner itself).
 */
export interface WithdrawalOwner { kind: WithdrawalWalletKind; id: string; actor: { kind: 'pharmacy' | 'member' | 'doctor'; id: string }; member?: PartnerActor }

/**
 * r35b (coordinator): a lab member requests with partner-wide scope (403 FINANCE_SCOPE_REQUIRED); cancels and abandons with
 * it, or when the withdrawal is its own request. The destination's details (its account name) go to a partner-wide member
 * holding `finance.view` (owners hold all); others read the masked line only.
 */
function assertActs(o: WithdrawalOwner, w?: Pick<IWalletWithdrawal, 'requestedBy'> | null): void {
  if (o.member && !(w?.requestedBy.kind === 'member' && w.requestedBy.id === lower(o.actor.id))) assertPartnerFinanceReader(o.member);
}
const seesDetails = (o: WithdrawalOwner) => !o.member || (hasGlobalScope(o.member) && (o.member.role === 'owner' || o.member.permissions.includes('finance.view')));

/** §5.4: where an owner's withdrawals go (`HOME_KIND`, the one map). */
const storeOf = (kind: WithdrawalWalletKind, id: string): WalletStore => (kind === 'pharmacy' ? pharmacyStore(id) : partnerStore(kind, id));
const refOf = (kind: WithdrawalWalletKind, id: string) => ({ 'walletRef.kind': kind, 'walletRef.id': lower(id) });
const keyScope = (kind: WithdrawalWalletKind, id: string) => `wallet_withdrawal:${kind}:${lower(id)}`;

async function ownerName(kind: WithdrawalWalletKind, id: string): Promise<string> {
  const row = kind === 'pharmacy' ? await PharmacyModel.findById(id).select({ name: 1 }).lean() as { name?: string } | null
    : kind === 'lab' ? await PartnerOrgModel.findById(id).select({ name: 1, legalName: 1 }).lean() as { name?: string; legalName?: string } | null
      : await SpecialistModel.findById(id).select({ name: 1 }).lean() as { name?: string } | null;
  return (row as { legalName?: string } | null)?.legalName || row?.name || 'Account holder';
}
/** The owner's home account (opened idempotently on first use). */
async function homeAccount(kind: WithdrawalWalletKind, id: string): Promise<ISettlementAccount> {
  return ensureSettlementAccount(HOME_KIND[kind], lower(id), await ownerName(kind, id));
}
/** The owner's home account as it is (never opened by a read). */
const homeAccountRead = async (kind: WithdrawalWalletKind, id: string, s: ClientSession | null) =>
  await SettlementAccountModel.findOne({ ownerKind: HOME_KIND[kind], ownerId: lower(id) }).session(s).lean() as ISettlementAccount | null;

/** Writers fail closed until sync-indexes has run (503 INDEXES_OUTDATED). */
async function assertWithdrawalIndexes(kind: WithdrawalWalletKind): Promise<void> {
  await assertUniqueIndex(WalletWithdrawalModel, { 'walletRef.kind': 1, 'walletRef.id': 1, requestKey: 1 });
  await assertUniqueIndex(WalletWithdrawalModel, { 'destination.homeAccountId': 1, 'paid.reference': 1 });
  await assertUniqueIndex(RequestKeyModel, { scope: 1, key: 1 });
  await assertUniqueIndex(WalletTopupLotModel, { paymentRecordId: 1 });
  await assertBookerWalletIndexes(kind);
}

// ── Views ──
const feeLine = (w: Pick<IWalletWithdrawal, 'grossMinor' | 'feeMinor' | 'transferMinor'>) => (w.feeMinor > 0
  ? `Card fee on unspent card money: ₹${rupees(w.feeMinor)}. You receive ₹${rupees(w.transferMinor)} of ₹${rupees(w.grossMinor)}.`
  : `No card fee. You receive ₹${rupees(w.transferMinor)}.`);
export function withdrawalView(w: IWalletWithdrawal) {
  return { _id: String(w._id), walletKind: w.walletRef.kind, state: w.state, grossMinor: w.grossMinor, feeMinor: w.feeMinor, transferMinor: w.transferMinor,
    feeLine: feeLine(w), lots: w.lotAllocations.map((l) => ({ lotId: l.lotId, amountMinor: l.amountMinor, feeMinor: l.feeMinor })),
    destination: { masked: w.destination.masked, detailsVersion: w.destination.detailsVersion },
    paid: w.paid ? { method: w.paid.method, reference: w.paid.reference, paidOn: w.paid.paidOn, at: w.paid.at } : null,
    reason: w.reason ?? null, version: w.version, createdAt: w.createdAt, updatedAt: w.updatedAt };
}
const adminView = (w: IWalletWithdrawal) => ({ ...withdrawalView(w), walletRef: w.walletRef, requestedBy: w.requestedBy,
  destination: w.destination, holdEntryId: w.holdEntryId, releaseEntryId: w.releaseEntryId ?? null, voidEntryId: w.voidEntryId ?? null,
  paid: w.paid ? { method: w.paid.method, reference: w.paid.reference, paidOn: w.paid.paidOn, note: w.paid.note ?? null, by: w.paid.by, at: w.paid.at,
    detailsVersion: w.paid.detailsVersion, ...(w.paid.disputeAcknowledged ? { disputeAcknowledged: true, disputedMinor: w.paid.disputedMinor ?? 0 } : {}) } : null });
const walletOut = (store: WalletStore, w: unknown) => {
  const st = store.state(w);
  return { balanceMinor: st.balanceMinor, withdrawableMinor: st.withdrawableMinor, receivableMinor: st.receivableMinor, frozen: st.frozen };
};

/** The last withdrawal that counts toward "one a week" (requested or paid, created in the last 7 days; Q5 rolling). */
async function lastCounted(kind: WithdrawalWalletKind, id: string, now: Date, s: ClientSession | null) {
  return await WalletWithdrawalModel.findOne({ ...refOf(kind, id), state: { $in: ['requested', 'paid'] }, createdAt: { $gt: new Date(now.getTime() - WEEK_MS) } })
    .sort({ createdAt: -1 }).session(s).lean() as IWalletWithdrawal | null;
}

/** The lots a withdrawal of `amount` takes now (oldest first) with each lot's fee share (spent money never pays one). */
async function planTake(ref: WalletRef, amount: number, now: Date, s: ClientSession | null) {
  const plan = await planLots(ref, amount, s, withdrawableNowFilter(now));
  const lots = plan.map((l) => ({ lotId: l.lotId, amountMinor: l.amountPaise,
    feeMinor: l.lotAmountMinor > 0 ? Math.floor((l.gatewayFeeMinor * l.amountPaise) / l.lotAmountMinor) : 0 }));
  const covered = lots.reduce((a, l) => a + l.amountMinor, 0);
  return { lots, covered, feeMinor: lots.reduce((a, l) => a + l.feeMinor, 0) };
}

// ── Eligibility (r35b: one rule for the quote's reason and the request's refusal) ──

/** What a withdrawal now depends on beyond the switch and the minimum; `plan` only for an amount. */
interface Facts {
  labVerified: boolean; account: ISettlementAccount | null; wallet: WalletState | null; last: IWalletWithdrawal | null;
  plan: Awaited<ReturnType<typeof planTake>> | null;
}
/** Read in `s` (the request's transaction) or outside one (the quote, which passes the wallet it already read). */
async function factsIn(o: WithdrawalOwner, amount: number | null, now: Date, s: ClientSession | null, wallet?: WalletState | null): Promise<Facts> {
  const store = storeOf(o.kind, o.id);
  const lab = o.kind === 'lab' ? await PartnerOrgModel.findById(o.id).select({ 'verification.state': 1 }).session(s).lean() as { verification?: { state?: string } } | null : null;
  const account = await homeAccountRead(o.kind, o.id, s);
  let state = wallet;
  if (state === undefined) {
    const w = await store.findIn(s);
    state = w ? store.state(w) : null;
  }
  return { labVerified: o.kind !== 'lab' || lab?.verification?.state === 'verified', account, wallet: state, last: await lastCounted(o.kind, o.id, now, s),
    plan: amount === null ? null : await planTake(store.ref, amount, now, s) };
}

/** Why a withdrawal is refused (the quote's `reason`). */
export type WithdrawalRefusal = 'WITHDRAWALS_DISABLED' | 'BELOW_MINIMUM' | 'LAB_NOT_VERIFIED' | 'DESTINATION_NOT_VERIFIED' | 'WALLET_RECEIVABLE'
  | 'WALLET_FROZEN' | 'WALLET_INACTIVE' | 'WEEKLY_LIMIT' | 'ABOVE_WITHDRAWABLE';
/**
 * The ONE eligibility rule: the first reason a request of `amount` is refused, in the request's order, else null. Without
 * facts only what needs no read (the switch, the minimum), which the request checks before it reads or writes anything.
 * The lab's verified-lab rule is here (a lab's request route admits an unverified lab, so the switch answers first).
 */
function refusalOf(amount: number, f?: Facts): WithdrawalRefusal | null {
  if (!assistedFlags.withdrawals()) return 'WITHDRAWALS_DISABLED';
  if (!Number.isSafeInteger(amount) || amount < withdrawalMinMinor()) return 'BELOW_MINIMUM';
  if (!f) return null;
  if (!f.labVerified) return 'LAB_NOT_VERIFIED';
  if (!f.account?.payoutDetails || f.account.payoutDetailsState !== 'verified') return 'DESTINATION_NOT_VERIFIED';
  if (f.wallet && f.wallet.receivableMinor > 0) return 'WALLET_RECEIVABLE';
  if (f.wallet?.frozen) return 'WALLET_FROZEN';
  if (f.wallet && !f.wallet.isActive) return 'WALLET_INACTIVE';
  if (f.last) return 'WEEKLY_LIMIT';
  return f.plan?.covered === amount ? null : 'ABOVE_WITHDRAWABLE';
}
const nextAllowedOf = (last: IWalletWithdrawal) => new Date(new Date(last.createdAt!).getTime() + WEEK_MS);
/** The request's error for a refusal (codes as before r35b; a lab not verified as its route guard answered it). */
function refusalError(r: WithdrawalRefusal, f?: Facts): AppError {
  switch (r) {
    case 'WITHDRAWALS_DISABLED': return err(503, 'WITHDRAWALS_DISABLED', 'Withdrawals are not available yet');
    case 'BELOW_MINIMUM': {
      const min = withdrawalMinMinor();
      return err(400, 'WITHDRAWAL_BELOW_MINIMUM', `The smallest withdrawal is ₹${rupees(min)}`, { details: { minimumMinor: min } });
    }
    case 'LAB_NOT_VERIFIED': return err(403, 'PARTNER_NOT_VERIFIED', 'Partner verification is required for this operation');
    case 'DESTINATION_NOT_VERIFIED':
      return err(409, 'PAYOUT_DESTINATION_NOT_VERIFIED', 'Add your bank or UPI details and wait for Jansetu to verify them before withdrawing');
    case 'WALLET_RECEIVABLE': return err(409, 'WALLET_RECEIVABLE', 'This wallet owes Jansetu money (a lost card dispute); nothing can be withdrawn');
    case 'WALLET_FROZEN': return err(409, 'WALLET_FROZEN', 'This wallet is frozen; contact Jansetu support');
    case 'WALLET_INACTIVE': return err(409, 'WALLET_INACTIVE', 'This wallet is not active');
    case 'WEEKLY_LIMIT': {
      const nextAllowedAt = nextAllowedOf(f!.last!);
      return err(409, 'WITHDRAWAL_WEEKLY_LIMIT', `One withdrawal a week: the next one from ${nextAllowedAt.toISOString()}`, { details: { nextAllowedAt } });
    }
    default: return err(409, 'WITHDRAWAL_ABOVE_AVAILABLE', 'That is more than the card money you can withdraw now', { details: { withdrawableNowMinor: f?.plan?.covered ?? 0 } });
  }
}

// ── Owner ──

/**
 * r35 (§26.10): the owner's home account destination, read only — its state, one masked line, the version to send back and
 * the owner's own details as the finance reads show them (never the full account number).
 */
export async function destinationFor(kind: WithdrawalWalletKind, id: string) {
  return destinationOf(await homeAccountRead(kind, id, null));
}

/** The one wallet read of the finance block and the quote: the wallet's state, its card money withdrawable now and later. */
async function walletRead(kind: WithdrawalWalletKind, id: string, now: Date) {
  const store = storeOf(kind, id);
  const w = await store.findIn(null);
  const { nowMinor, later } = await withdrawableNowOf(store.ref, now);
  return { state: w ? store.state(w) : null, nowMinor, later };
}
/** r35 (§26.10): the wallet block of the finance reads — the balance, card money withdrawable now and later, what is owed. */
export async function walletSummary(kind: WithdrawalWalletKind, id: string, now: Date = new Date()) {
  const { state: st, nowMinor, later } = await walletRead(kind, id, now);
  return { balanceMinor: st?.balanceMinor ?? 0, withdrawableNowMinor: nowMinor, availableLater: later, receivableMinor: st?.receivableMinor ?? 0, frozen: st?.frozen ?? false };
}

/** r35 (§26.10): the withdrawals block — requested ones waiting for an admin, the last paid one (r35b: a voided one is not), the switch. */
export async function withdrawalsSummary(kind: WithdrawalWalletKind, id: string) {
  const [openCount, lastPaid] = await Promise.all([
    WalletWithdrawalModel.countDocuments({ ...refOf(kind, id), state: 'requested' }),
    WalletWithdrawalModel.findOne({ ...refOf(kind, id), state: 'paid', 'paid.at': { $exists: true } }).sort({ 'paid.at': -1 })
      .select({ 'paid.at': 1 }).lean() as unknown as Promise<{ paid?: { at?: Date } } | null>,
  ]);
  return { openCount, lastPaidAt: lastPaid?.paid?.at ?? null, enabled: assistedFlags.withdrawals() };
}

/**
 * GET …/wallet/withdrawable: what may be withdrawn now (card money past its 7-day hold), what becomes withdrawable later,
 * the next allowed request time, the destination (masked; r35b: its details only to whom `seesDetails`) and, with
 * `?amountMinor=`, the quote (gross, card fee, transfer) with `reason` — the request's own eligibility rule (`refusalOf`):
 * `available` = the request would go through (for a caller allowed to request).
 */
export async function withdrawableOf(o: WithdrawalOwner, q: { amountMinor?: number } = {}, now: Date = new Date()) {
  const { state, nowMinor, later } = await walletRead(o.kind, o.id, now);
  const amount = Number(q.amountMinor);
  const quoted = Number.isSafeInteger(amount) && amount > 0;
  const f = await factsIn(o, quoted ? amount : null, now, null, state);
  const reason = quoted ? refusalOf(amount, f) : null;
  return {
    enabled: assistedFlags.withdrawals(), minimumMinor: withdrawalMinMinor(), withdrawableNowMinor: nowMinor, availableLater: later,
    nextAllowedAt: f.last ? nextAllowedOf(f.last) : null, destination: destinationOf(f.account, seesDetails(o)),
    ...(quoted && f.plan ? { quote: { grossMinor: amount, feeMinor: f.plan.feeMinor, transferMinor: amount - f.plan.feeMinor, available: reason === null, reason } } : {}),
  };
}

/**
 * POST …/wallet/withdrawals { amountMinor, requestKey, detailsVersion } — 201 `{ withdrawal, wallet, replayed }`; the same
 * key and amount answers the same withdrawal (200, replayed); another amount 409 IDEMPOTENCY_KEY_REUSED.
 */
export async function requestWithdrawal(o: WithdrawalOwner, body: { amountMinor: number; requestKey: string; detailsVersion: number; expectedTransferMinor?: number },
  now: Date = new Date()) {
  const amount = Number(body.amountMinor);
  // r35b: the switch and the minimum before anything is read or written (the switch before a lab member's scope).
  const early = refusalOf(amount);
  if (early) throw refusalError(early);
  assertActs(o);
  await assertWithdrawalIndexes(o.kind);
  const store = storeOf(o.kind, o.id);
  // r35 (WQ29): `expectedTransferMinor` (what the screen showed) is part of the request only when sent.
  const expected = body.expectedTransferMinor === undefined ? undefined : Number(body.expectedTransferMinor);
  const requestHash = requestHashOf({ kind: 'wallet_withdrawal', amountMinor: amount, ...(expected !== undefined ? { expectedTransferMinor: expected } : {}) });
  const replay = async (s: ClientSession | null) => {
    const w = await WalletWithdrawalModel.findOne({ ...refOf(o.kind, o.id), requestKey: { $eq: body.requestKey } }).session(s).lean() as IWalletWithdrawal | null;
    if (!w) return null;
    if (w.requestHash !== requestHash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different withdrawal');
    return { withdrawal: withdrawalView(w), wallet: walletOut(store, await store.findIn(s)), replayed: true };
  };
  const prior = await replay(null);
  if (prior) return prior;
  const account = await homeAccount(o.kind, o.id);
  await store.ensure();
  try {
    return await walletTransaction(async (s) => {
      const again = await replay(s);
      if (again) return again;
      await claimRequestKey(keyScope(o.kind, o.id), body.requestKey, s);
      // r35b: the one eligibility rule, on what this transaction reads.
      const f = await factsIn(o, amount, now, s);
      const refused = refusalOf(amount, f);
      if (refused) throw refusalError(refused, f);
      const plan = f.plan!;
      // r35 (WQ29): the home account written (its finance version) in this transaction at the version the owner saw, so a
      // payout-details change (refused while a withdrawal is requested, 409 WITHDRAWAL_OPEN) and a request never pass each other.
      const a = await SettlementAccountModel.findOneAndUpdate({ _id: account._id, payoutDetailsState: 'verified', payoutDetailsVersion: Number(body.detailsVersion) },
        { $inc: { financeVersion: 1 } }, { new: true, session: s }).lean() as ISettlementAccount | null;
      if (!a?.payoutDetails) throw err(409, 'PAYOUT_DETAILS_CHANGED', 'Your payout details changed since they were loaded; review them again');
      const id = new Types.ObjectId();
      const transfer = amount - plan.feeMinor;
      if (expected !== undefined && expected !== transfer) {
        throw err(409, 'WITHDRAWAL_QUOTE_CHANGED', 'The card fee changed since the screen was loaded; review the new amount',
          { details: { grossMinor: amount, feeMinor: plan.feeMinor, transferMinor: transfer } });
      }
      const posted = await postMovementIn(store, { kind: 'withdrawal_hold', amountMinor: amount, operationKey: `withdrawal:${String(id)}:hold`,
        referenceType: 'wallet_withdrawal', referenceId: `${String(id)}:hold`, lotsWithdrawableAt: now,
        description: `Withdrawal to your bank: ₹${rupees(amount)} (card fee ₹${rupees(plan.feeMinor)} on unspent card money; you receive ₹${rupees(transfer)})` }, s);
      const entry = posted.entry as { _id?: unknown; lotAllocations?: { lotId: string; amountPaise: number }[] };
      const took = (entry.lotAllocations ?? []).map((l) => `${l.lotId}:${l.amountPaise}`).join(',');
      if (took !== plan.lots.map((l) => `${l.lotId}:${l.amountMinor}`).join(',')) {
        throw Object.assign(err(409, 'WALLET_CHANGED', 'The wallet changed; please retry'), { retryable: true });
      }
      const [row] = await WalletWithdrawalModel.create([{ _id: id, walletRef: { kind: o.kind, id: lower(o.id) }, requestedBy: { kind: o.actor.kind, id: lower(o.actor.id) },
        grossMinor: amount, feeMinor: plan.feeMinor, transferMinor: transfer, lotAllocations: plan.lots, state: 'requested',
        destination: { homeAccountId: String(a._id), detailsVersion: a.payoutDetailsVersion ?? 0, masked: destinationLabel(a.payoutDetails) },
        holdEntryId: String(entry._id), requestKey: body.requestKey, requestHash, version: 0 }], { session: s });
      await audit(o.kind, o.id, o.actor, 'withdrawal.requested', String(id), { grossMinor: amount, feeMinor: plan.feeMinor, transferMinor: transfer }, s, body.requestKey);
      return { withdrawal: withdrawalView(row!.toObject() as IWalletWithdrawal), wallet: walletOut(store, posted.wallet), replayed: false };
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const raced = await replay(null);
      if (raced) return raced;
    }
    throw e;
  }
}

type Page = { state?: WithdrawalState; cursor?: string; limit?: number };
const CURSOR = /^(\d{1,15})_([0-9a-fA-F]{24})$/;
async function pageOf(filter: Record<string, unknown>, q: Page, dir: 1 | -1) {
  const limit = Math.min(50, Math.max(1, Number(q.limit ?? 20)));
  const m = q.cursor ? CURSOR.exec(q.cursor) : null;
  if (q.cursor && !m) throw err(400, 'INVALID_CURSOR', 'Invalid cursor');
  const op = dir === 1 ? '$gt' : '$lt';
  const after = m ? { $or: [{ createdAt: { [op]: new Date(Number(m[1])) } }, { createdAt: new Date(Number(m[1])), _id: { [op]: new Types.ObjectId(m[2]) } }] } : {};
  const rows = await WalletWithdrawalModel.find({ ...filter, ...(q.state ? { state: { $eq: q.state } } : {}), ...after })
    .sort({ createdAt: dir, _id: dir }).limit(limit + 1).lean() as IWalletWithdrawal[];
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? `${new Date(last.createdAt!).getTime()}_${String(last._id)}` : null };
}

/** GET …/wallet/withdrawals — the owner's, newest first. */
export async function listOwn(o: WithdrawalOwner, q: Page) {
  const p = await pageOf(refOf(o.kind, o.id), q, -1);
  return { items: p.items.map(withdrawalView), nextCursor: p.nextCursor };
}
async function ownRow(o: WithdrawalOwner, id: string, s: ClientSession | null = null) {
  if (!Types.ObjectId.isValid(id)) throw notFound();
  const w = await WalletWithdrawalModel.findOne({ _id: id, ...refOf(o.kind, o.id) }).session(s).lean() as IWalletWithdrawal | null;
  if (!w) throw notFound();
  return w;
}
/** GET …/wallet/withdrawals/:id — another owner's row is the one 404. */
export const getOwn = async (o: WithdrawalOwner, id: string) => withdrawalView(await ownRow(o, id));

/** GET …/withdrawals/by-key/:key and POST …/by-key/:key/abandon (Q13 shape). */
export async function ownByKey(o: WithdrawalOwner, key: string) {
  const w = await WalletWithdrawalModel.findOne({ ...refOf(o.kind, o.id), requestKey: { $eq: key } }).lean() as IWalletWithdrawal | null;
  if (w) return { state: 'used' as const, withdrawal: withdrawalView(w) };
  const k = await RequestKeyModel.findOne({ scope: keyScope(o.kind, o.id), key }).lean();
  return { state: k?.state === 'abandoned' ? 'abandoned' as const : 'unknown' as const };
}
export async function abandonOwnKey(o: WithdrawalOwner, key: string) {
  const w = await WalletWithdrawalModel.findOne({ ...refOf(o.kind, o.id), requestKey: { $eq: key } }).select({ requestedBy: 1 }).lean() as IWalletWithdrawal | null;
  assertActs(o, w);
  if (w) return ownByKey(o, key);
  const state = await abandonRequestKey(keyScope(o.kind, o.id), key);
  return state === 'abandoned' ? { state } : ownByKey(o, key);
}

/** The audit of a withdrawal step (ids and amounts only), in its transaction. */
async function audit(kind: WithdrawalWalletKind, ownerId: string, actor: { kind: string; id: string }, action: 'withdrawal.requested' | 'withdrawal.cancelled'
  | 'withdrawal.rejected' | 'withdrawal.paid' | 'withdrawal.voided', withdrawalId: string, detail: Record<string, unknown>, s: ClientSession, requestKey?: string) {
  await auditIn({ actorKind: actor.kind as 'pharmacy' | 'member' | 'doctor' | 'admin', actorId: lower(actor.id), orgKind: kind, orgId: lower(ownerId), action,
    ...(requestKey ? { requestKey } : {}), detail: { withdrawalId, ...detail } }, s);
}

/**
 * The money of a `requested` withdrawal given back (cancel by its owner, reject by an admin): `requested` → `to` on
 * `version`, then `withdrawal_release` restores the gross and exactly the held lots. Always posts (a frozen, owing or
 * over-cap wallet included). A repeat on a row already in `to` answers it again.
 */
async function release(w0: IWalletWithdrawal, to: 'cancelled' | 'rejected', expectedVersion: number, actor: { kind: string; id: string }, reason: string | undefined,
  s: ClientSession) {
  const store = storeOf(w0.walletRef.kind, w0.walletRef.id);
  if (w0.state === to) return { withdrawal: withdrawalView(w0), wallet: walletOut(store, await store.findIn(s)), replayed: true };
  if (w0.state !== 'requested') throw err(409, 'WITHDRAWAL_NOT_REQUESTED', `This withdrawal is ${w0.state}`);
  if (w0.version !== expectedVersion) throw err(409, 'WITHDRAWAL_CHANGED', 'This withdrawal changed since it was loaded; review it again');
  const moved = await WalletWithdrawalModel.updateOne({ _id: w0._id, state: 'requested', version: w0.version },
    { $set: { state: to, ...(reason ? { reason } : {}) }, $inc: { version: 1 } }, { session: s });
  if (moved.modifiedCount !== 1) throw err(409, 'WITHDRAWAL_CHANGED', 'This withdrawal changed since it was loaded; review it again');
  const posted = await postMovementIn(store, { kind: 'withdrawal_release', amountMinor: w0.grossMinor, operationKey: `withdrawal:${String(w0._id)}:release`,
    referenceType: 'wallet_withdrawal', referenceId: `${String(w0._id)}:release`, restore: w0.lotAllocations.map((l) => ({ lotId: l.lotId, amountPaise: l.amountMinor })),
    description: to === 'cancelled' ? 'Withdrawal cancelled: the amount is back in your wallet' : 'Withdrawal rejected by Jansetu: the amount is back in your wallet' }, s);
  await WalletWithdrawalModel.updateOne({ _id: w0._id }, { $set: { releaseEntryId: String((posted.entry as { _id?: unknown })._id) } }, { session: s });
  await audit(w0.walletRef.kind, w0.walletRef.id, actor, to === 'cancelled' ? 'withdrawal.cancelled' : 'withdrawal.rejected', String(w0._id),
    { grossMinor: w0.grossMinor, ...(reason ? { reason } : {}) }, s);
  const after = await WalletWithdrawalModel.findById(w0._id).session(s).lean() as IWalletWithdrawal;
  return { withdrawal: withdrawalView(after), wallet: walletOut(store, posted.wallet), replayed: false };
}

/** POST …/wallet/withdrawals/:id/cancel { expectedVersion } — only while `requested`; the owner's money comes back at once. */
export async function cancelOwn(o: WithdrawalOwner, id: string, expectedVersion: number) {
  return walletTransaction(async (s) => {
    const w = await ownRow(o, id, s);
    assertActs(o, w);
    return release(w, 'cancelled', expectedVersion, o.actor, undefined, s);
  });
}

// ── Admin ──
const adminRow = async (id: string, s: ClientSession | null = null) => {
  if (!Types.ObjectId.isValid(id)) throw notFound();
  const w = await WalletWithdrawalModel.findById(id).session(s).lean() as IWalletWithdrawal | null;
  if (!w) throw notFound();
  return w;
};
/** GET /admin/wallet-withdrawals?state&cursor — oldest first (the queue). */
export async function adminList(q: Page) {
  const p = await pageOf({}, q, 1);
  return { items: p.items.map(adminView), nextCursor: p.nextCursor };
}
export const adminGet = async (id: string) => adminView(await adminRow(id));

/** POST /admin/wallet-withdrawals/:id/reject { reason, expectedVersion }. */
export async function adminReject(adminId: string, id: string, body: { reason: string; expectedVersion: number }) {
  const out = await walletTransaction(async (s) => release(await adminRow(id, s), 'rejected', body.expectedVersion, { kind: 'admin', id: adminId },
    String(body.reason).trim(), s));
  return { ...out, withdrawal: adminView(await adminRow(id)) };
}

/**
 * POST /admin/wallet-withdrawals/:id/paid { method, reference, paidOn, note?, detailsVersion, expectedVersion, requestKey } —
 * the admin made the transfer. `requested` → `paid` only (nothing moves; M7). The home account's destination must be
 * verified at the version the admin saw (as `recordPayout`); the reference (UTR) is unique per home account. A
 * `withdrawal_paid` SettlementEvent on the home account. The same key and content again answers it (replayed).
 */
export async function adminPaid(adminId: string, id: string, body: { method: 'bank_transfer' | 'upi'; reference: string; paidOn: string; note?: string;
  detailsVersion: number; expectedVersion: number; requestKey: string; disputeAcknowledged?: boolean }) {
  const ack = body.disputeAcknowledged === true;
  const reference = String(body.reference ?? '').trim();
  if (reference.length < 4 || reference.length > 64) throw err(400, 'INVALID_REFERENCE', 'Reference (UTR) must be 4 to 64 characters');
  if (!isRealDate(body.paidOn) || body.paidOn > istDate(new Date())) throw err(400, 'INVALID_DATE', 'paidOn must be a real date, not in the future');
  await assertUniqueIndex(WalletWithdrawalModel, { 'destination.homeAccountId': 1, 'paid.reference': 1 });
  const note = body.note?.trim() || undefined;
  const requestHash = requestHashOf({ kind: 'withdrawal_paid', method: body.method, reference, paidOn: body.paidOn, note: note ?? null, detailsVersion: body.detailsVersion,
    ...(ack ? { disputeAcknowledged: true } : {}) });
  try {
    return await walletTransaction(async (s) => {
      const w = await adminRow(id, s);
      if (w.state === 'paid' && w.paid?.requestKey === body.requestKey) {
        if (w.paid.requestHash !== requestHash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different payment record');
        return { withdrawal: adminView(w), replayed: true };
      }
      if (w.state !== 'requested') throw err(409, 'WITHDRAWAL_NOT_REQUESTED', `This withdrawal is ${w.state}`);
      if (w.version !== body.expectedVersion) throw err(409, 'WITHDRAWAL_CHANGED', 'This withdrawal changed since it was loaded; review it again');
      // r32b: card money whose dispute was recorded since the request is not paid out (reject it, or Recover first). r35
      // (WQ29): unless the admin already transferred it and says so (`disputeAcknowledged`): it is marked paid, nothing more
      // is taken from the held lots, and that money is owed back — the lot's Recover makes the receivable (then set-off).
      const disputed = await WalletTopupLotModel.find({ _id: { $in: w.lotAllocations.map((l) => l.lotId) },
        $or: [{ disputeState: { $ne: 'none' } }, { chargedBackAt: { $exists: true } }] }).select({ _id: 1 }).session(s).lean();
      const disputedMinor = w.lotAllocations.filter((l) => disputed.some((d) => String(d._id) === l.lotId)).reduce((x, l) => x + l.amountMinor, 0);
      if (disputed.length && !ack) {
        throw err(409, 'WITHDRAWAL_LOT_DISPUTED', 'A card dispute was recorded on money this withdrawal holds; reject it, or (if already transferred) mark it paid with disputeAcknowledged');
      }
      const a = await SettlementAccountModel.findById(w.destination.homeAccountId).session(s).lean() as ISettlementAccount | null;
      if (!a?.payoutDetails || a.payoutDetailsState !== 'verified') throw err(409, 'PAYOUT_DESTINATION_NOT_VERIFIED', 'Verify the payout details before recording the transfer');
      if ((a.payoutDetailsVersion ?? 0) !== Number(body.detailsVersion)) throw err(409, 'PAYOUT_DETAILS_CHANGED', 'The payout details changed since they were loaded; review them again');
      if (await WalletWithdrawalModel.exists({ 'destination.homeAccountId': w.destination.homeAccountId, 'paid.reference': reference }).session(s)) {
        throw err(409, 'REFERENCE_REUSED', 'A withdrawal with this reference is already recorded for this account');
      }
      const at = new Date();
      const moved = await WalletWithdrawalModel.updateOne({ _id: w._id, state: 'requested', version: w.version },
        { $set: { state: 'paid', paid: { method: body.method, reference, paidOn: body.paidOn, ...(note ? { note } : {}), by: lower(adminId), at,
          detailsVersion: a.payoutDetailsVersion ?? 0, requestKey: body.requestKey, requestHash, ...(disputed.length ? { disputeAcknowledged: true, disputedMinor } : {}) } },
          $inc: { version: 1 } }, { session: s });
      if (moved.modifiedCount !== 1) throw err(409, 'WITHDRAWAL_CHANGED', 'This withdrawal changed since it was loaded; review it again');
      await SettlementEventModel.create([{ settlementAccountId: String(a._id), action: 'withdrawal_paid', byKind: 'admin', by: lower(adminId), at,
        detail: { withdrawalId: String(w._id), grossMinor: w.grossMinor, feeMinor: w.feeMinor, transferMinor: w.transferMinor, method: body.method, reference,
          paidOn: body.paidOn, ...(disputed.length ? { disputeAcknowledged: true, disputedMinor } : {}) } }], { session: s });
      await audit(w.walletRef.kind, w.walletRef.id, { kind: 'admin', id: adminId }, 'withdrawal.paid', String(w._id), { transferMinor: w.transferMinor, reference,
        ...(disputed.length ? { disputeAcknowledged: true, disputedMinor } : {}) }, s);
      return { withdrawal: adminView(await adminRow(id, s)), replayed: false };
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) throw err(409, 'REFERENCE_REUSED', 'A withdrawal with this reference is already recorded for this account');
    throw e;
  }
}

/**
 * POST /admin/wallet-withdrawals/:id/void { reason, expectedVersion } — a paid transfer bounced: `paid` → `voided`, and
 * `withdrawal_void` gives the gross and exactly the held lots back. Always posts.
 */
export async function adminVoid(adminId: string, id: string, body: { reason: string; expectedVersion: number }) {
  return walletTransaction(async (s) => {
    const w = await adminRow(id, s);
    const store = storeOf(w.walletRef.kind, w.walletRef.id);
    if (w.state === 'voided') return { withdrawal: adminView(w), wallet: walletOut(store, await store.findIn(s)), replayed: true };
    if (w.state !== 'paid') throw err(409, 'WITHDRAWAL_NOT_PAID', `Only a paid withdrawal can be voided; this one is ${w.state}`);
    if (w.version !== body.expectedVersion) throw err(409, 'WITHDRAWAL_CHANGED', 'This withdrawal changed since it was loaded; review it again');
    const reason = String(body.reason).trim();
    const moved = await WalletWithdrawalModel.updateOne({ _id: w._id, state: 'paid', version: w.version }, { $set: { state: 'voided', reason }, $inc: { version: 1 } },
      { session: s });
    if (moved.modifiedCount !== 1) throw err(409, 'WITHDRAWAL_CHANGED', 'This withdrawal changed since it was loaded; review it again');
    const posted = await postMovementIn(store, { kind: 'withdrawal_void', amountMinor: w.grossMinor, operationKey: `withdrawal:${String(w._id)}:void`,
      referenceType: 'wallet_withdrawal', referenceId: `${String(w._id)}:void`, restore: w.lotAllocations.map((l) => ({ lotId: l.lotId, amountPaise: l.amountMinor })),
      description: 'Withdrawal transfer returned by the bank: the amount is back in your wallet' }, s);
    await WalletWithdrawalModel.updateOne({ _id: w._id }, { $set: { voidEntryId: String((posted.entry as { _id?: unknown })._id) } }, { session: s });
    await audit(w.walletRef.kind, w.walletRef.id, { kind: 'admin', id: adminId }, 'withdrawal.voided', String(w._id), { grossMinor: w.grossMinor, reason }, s);
    return { withdrawal: adminView(await adminRow(id, s)), wallet: walletOut(store, posted.wallet), replayed: false };
  });
}

/**
 * PUT /api/v1/pharmacy-assisted/finance/payout-details — the pharmacy's withdrawal destination on its home account
 * (`pharmacy_referral`, opened here when missing), with the Q5 versioned rules: every change needs a fresh admin
 * verification (`/api/v1/settlements/accounts/:id/payout-details/verify`).
 */
export async function setPharmacyPayoutDetails(pharmacyId: string, input: PayoutDetailsInput) {
  const account = await homeAccount('pharmacy', pharmacyId);
  return setPayoutDetails({ accountId: String(account._id) }, input, { kind: 'pharmacy', id: lower(pharmacyId) });
}
