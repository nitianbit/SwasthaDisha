import mongoose, { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { PaymentRecordModel } from '@/modules/payment/model';
import type { IPaymentRecord } from '@/modules/payment/types';
import { WalletTopupLotModel, type IWalletTopupLot } from '@/modules/pharmacyWallet/model/lots';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { consumeLots, openLotIn, openLotsMinorIn, restoreLots, withdrawableOfIn, type LotAllocation, type WalletRef } from '@/modules/pharmacyWallet/walletLots';

/**
 * r13 (round 2d, owner 25 Nov: one implementation, parameterised by store): the wallet money rules every partner wallet
 * shares. A STORE is one wallet's persistence (the pharmacy store `pharmacy_wallets` / `pharmacy_wallet_transactions`, in
 * `pharmacyWallet/ledger.ts`; the partner store `partner_wallets` / `partner_wallet_entries`, in `partnerWallets/ledger.ts`);
 * a TOP-UP KIND is how a card top-up record names its wallet. Everything below was the pharmacy ledger's code (phase 1a –
 * r9b), moved here unchanged in behaviour; the pharmacy suites are the regression check.
 *
 * Movements (§5.3, §17.3):
 * - exactly once per (wallet, `operationKey`): a repeat answers with the movement already posted;
 * - inside the caller's transaction: the wallet is read there and written back with a compare-and-set on `version`, so
 *   a balance is never decided on a stale read;
 * - spending (`booking_debit`) is refused on a wallet that owes a receivable, is frozen or inactive, or is short (409);
 *   credits ALWAYS post, and a credit clears an owed receivable first (`receivable_setoff`);
 * - lots: a card top-up credit opens a lot; a spend consumes lots oldest first (D9) and records `lotAllocations`; a
 *   refund restores exactly those (never a closed lot); `withdrawableMinor` is recomputed on every movement.
 */
export interface WalletState { balanceMinor: number; withdrawableMinor: number; receivableMinor: number; frozen: boolean; isActive: boolean }

/** A wallet write (compare-and-set on the version read). `freeze`: set with a reason, `null` = clear, absent = unchanged. */
export interface WalletWrite {
  balanceMinor?: number; withdrawableMinor?: number; receivableMinor?: number;
  freeze?: { reason: string; at: Date } | null;
}

/** A ledger row as every store records it (the store maps it to its own fields). Amounts in paise. */
export interface EntryDraft {
  _id?: Types.ObjectId; kind: string; amountMinor: number; signedMinor: number; beforeMinor: number; afterMinor: number;
  referenceType: string; referenceId: string; description: string; notes?: string; operationKey: string;
  withdrawableDeltaMinor: number; receivableDeltaMinor?: number; lotAllocations?: LotAllocation[]; requestHash?: string;
  actor?: { kind: 'admin' | 'member'; id: string };
}

/** What an admin top-up row says (for the replay rule). */
export interface TopupFacts { requestHash?: string; amountMinor: number; notes: string | null }

export interface WalletStore<W = any, E = any> {
  /** The lots of this wallet. */
  readonly ref: WalletRef;
  /** Outside any transaction: the empty wallet is created when missing (two first accesses may race on its unique key). */
  ensure(): Promise<void>;
  /** In the transaction; created empty when missing. */
  walletIn(s: ClientSession): Promise<W>;
  findIn(s: ClientSession | null): Promise<W | null>;
  state(w: W): WalletState;
  /** Compare-and-set on the version `w` was read at; null when another write won. */
  writeIn(w: W, next: WalletWrite, s: ClientSession): Promise<W | null>;
  entryIn(operationKey: string, s: ClientSession | null): Promise<E | null>;
  insertEntryIn(w: W, d: EntryDraft, s: ClientSession): Promise<E>;
  /** The credit row of a card top-up (its amount), however this store ever wrote it, or null. */
  rechargeCreditIn(paymentRecordId: string, s: ClientSession | null): Promise<{ amountMinor: number } | null>;
  /** The admin top-up row of an Idempotency-Key (the replay read, before the transaction). */
  adminTopupIn(key: string): Promise<E | null>;
  /** The same row for the admin's "was it credited?" read (exact reads on the unique indexes; 503 when one is missing). */
  adminTopupByKey(key: string): Promise<E | null>;
  topupFacts(e: E): TopupFacts;
}

/**
 * How a card top-up record names its wallet. `chargeback` is the rule for a card dispute lost on a top-up: `take`
 * (pharmacy, §5.3: the lot's money is debited, a shortfall owed, the wallet frozen) or `flag` (labs, owner decision C4
 * for card disputes: recorded and flagged only).
 */
export interface TopupKind<W = any, E = any> {
  readonly kind: 'pharmacy' | 'lab' | 'doctor';
  readonly flow: string;
  /** The payment record field naming the owner (`payerPharmacyId`, `payerPartnerId`, `payerSpecialistId`). */
  readonly payerField: string;
  /** How admin answers name the owner (`pharmacyId`, `partnerId`, `specialistId`). */
  readonly ownerField: string;
  isTopup(r: Record<string, any> | null | undefined): boolean;
  /** The wallet owner of a top-up record, lower-cased. */
  ownerOf(r: Record<string, any>): string;
  storeFor(r: Record<string, any>): WalletStore<W, E>;
  store(ownerId: string): WalletStore<W, E>;
  readonly chargeback: 'take' | 'flag';
  /** A captured top-up opens a lot only while its switch is on and the lot index is built (otherwise non-withdrawable). */
  lotsWritable(): Promise<boolean>;
  /** Fail closed before a credit (503 INDEXES_OUTDATED) when the store's exactly-once indexes are missing. */
  assertCreditable?(): Promise<void>;
  readonly rechargeDescription: string;
  /** O2: card money is withdrawable this many days after payment (stored on the lot); absent = not recorded. */
  readonly cardHoldDays?: number;
}

export type MovementKind = 'credit' | 'booking_debit' | 'refund_credit';
const DEBITS: MovementKind[] = ['booking_debit'];

export interface Movement {
  kind: MovementKind;
  /** Positive paise. */
  amountMinor: number;
  operationKey: string;
  referenceType: string;
  referenceId: string;
  description: string;
  notes?: string;
  /** Pre-chosen entry id (so the caller can store it on its own record in the same transaction). */
  entryId?: Types.ObjectId;
  /** A card top-up: opens a lot for this payment record. */
  lot?: { paymentRecordId: string; gatewayFeeMinor?: number | null; withdrawableAfter?: Date };
  /** A refund: the allocations of the spend it reverses. */
  restore?: LotAllocation[];
  /** Admin top-ups: the request's content hash and the admin (stored on the row). */
  requestHash?: string;
  actor?: { kind: 'admin' | 'member'; id: string };
}

export interface Posted<W = any, E = any> { entry: E; wallet: W; replayed: boolean }

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const changed = (message = 'The wallet changed; please retry') => Object.assign(err(409, 'WALLET_CHANGED', message), { retryable: true });
const HEX24 = /^[0-9a-fA-F]{24}$/;
const recordPaiseOf = (r: Record<string, any>) => (Number.isSafeInteger(r.baseAmountPaise) ? Number(r.baseAmountPaise) : Math.round(Number(r.baseAmount ?? 0) * 100));

/** r9: a top-up closed as compensated is never credited (same code as a blocked one). */
export const topupClosedCompensated = () => err(409, 'TOPUP_BLOCKED',
  'This top-up was closed: Jansetu support already paid this amount to you, so it is not credited to the wallet');
const topupBlocked = () => err(409, 'TOPUP_BLOCKED', 'This top-up was blocked after a lost card dispute and is not credited; contact Jansetu support');

/** One transaction (retried on transient conflicts). */
export async function walletTransaction<T>(fn: (s: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => { result = await fn(session); });
    return result as T;
  } finally {
    await session.endSession();
  }
}

export async function postMovementIn<W, E>(store: WalletStore<W, E>, m: Movement, s: ClientSession): Promise<Posted<W, E>> {
  if (!Number.isSafeInteger(m.amountMinor) || m.amountMinor <= 0) throw err(500, 'INVALID_AMOUNT', 'A wallet movement needs a positive paise amount');
  const prior = await store.entryIn(m.operationKey, s);
  if (prior) return { entry: prior, wallet: (await store.findIn(s)) as W, replayed: true };
  const wallet = await store.walletIn(s);
  const w = store.state(wallet);
  const debit = DEBITS.includes(m.kind);
  const before = w.balanceMinor;
  if (debit) {
    if (w.receivableMinor > 0) throw err(409, 'WALLET_RECEIVABLE', 'This wallet owes Jansetu money (a lost card dispute); top it up first');
    if (w.frozen) throw err(409, 'WALLET_FROZEN', 'This wallet is frozen; contact Jansetu support');
    if (!w.isActive) throw err(409, 'WALLET_INACTIVE', 'This wallet is not active');
    if (before < m.amountMinor) throw err(409, 'INSUFFICIENT_BALANCE', `Insufficient wallet balance. Available: ₹${(before / 100).toFixed(2)}`);
  }
  const signed = debit ? -m.amountMinor : m.amountMinor;
  const after = before + signed;
  let lotAllocations: LotAllocation[] | undefined;
  if (debit) lotAllocations = await consumeLots(store.ref, m.amountMinor, s);
  else if (m.restore?.length) lotAllocations = await restoreLots(m.restore, s);
  if (m.lot) await openLotIn(store.ref, { ...m.lot, amountMinor: m.amountMinor }, s);
  const withdrawableAfter = await withdrawableOfIn(store.ref, s);
  const updated = await store.writeIn(wallet, { balanceMinor: after, withdrawableMinor: withdrawableAfter }, s);
  if (!updated) throw changed();
  const entry = await store.insertEntryIn(wallet, {
    ...(m.entryId ? { _id: m.entryId } : {}), kind: m.kind, amountMinor: m.amountMinor, signedMinor: signed, beforeMinor: before, afterMinor: after,
    referenceType: m.referenceType, referenceId: m.referenceId, description: m.description, ...(m.notes ? { notes: m.notes } : {}),
    operationKey: m.operationKey, withdrawableDeltaMinor: withdrawableAfter - w.withdrawableMinor, ...(lotAllocations?.length ? { lotAllocations } : {}),
    ...(m.requestHash ? { requestHash: m.requestHash } : {}), ...(m.actor ? { actor: m.actor } : {}),
  }, s);
  // Chargebacks (§5.3): a credit arriving on a wallet that owes a receivable clears it first (`receivable_setoff`).
  const now = store.state(updated);
  if (!debit && now.receivableMinor > 0) {
    const setoff = Math.min(now.receivableMinor, m.amountMinor, after);
    if (setoff > 0) {
      const setoffLots = await consumeLots(store.ref, setoff, s);
      const wAfter = await withdrawableOfIn(store.ref, s);
      const cleared = await store.writeIn(updated, { balanceMinor: after - setoff, withdrawableMinor: wAfter, receivableMinor: now.receivableMinor - setoff }, s);
      if (!cleared) throw changed();
      await store.insertEntryIn(wallet, {
        kind: 'receivable_setoff', amountMinor: setoff, signedMinor: -setoff, beforeMinor: after, afterMinor: after - setoff,
        referenceType: 'receivable_setoff', referenceId: `${m.operationKey}:setoff`, description: 'Owed amount cleared from this credit',
        operationKey: `${m.operationKey}:setoff`, receivableDeltaMinor: -setoff, withdrawableDeltaMinor: wAfter - now.withdrawableMinor,
        ...(setoffLots.length ? { lotAllocations: setoffLots } : {}),
      }, s);
      return { entry, wallet: cleared, replayed: false };
    }
  }
  return { entry, wallet: updated, replayed: false };
}

/** Recomputes `withdrawableMinor` from the lots (a lot's fee became known, or a dispute was flagged), in the transaction. */
export async function refreshWithdrawableIn(store: WalletStore, s: ClientSession): Promise<void> {
  const wallet = await store.findIn(s);
  if (!wallet) return;
  const value = await withdrawableOfIn(store.ref, s);
  if (value === store.state(wallet).withdrawableMinor) return;
  if (!(await store.writeIn(wallet, { withdrawableMinor: value }, s))) throw changed();
}

/**
 * Chargebacks, `take` rule (§5.3, production gate): an admin records a card dispute LOST on a top-up lot of this store.
 * In the caller's transaction, exactly once per lot: the lot is closed for good (never restored or withdrawable again);
 * the wallet is debited the lot's amount — what the balance cannot cover becomes `receivableMinor`, owed by the partner
 * (the balance itself never goes below zero, so balance = Σ entries holds); the wallet is frozen. A frozen wallet or
 * one with a receivable funds nothing; a later credit clears the receivable first.
 */
export async function chargeBackLotIn<W, E>(store: WalletStore<W, E>, lot: IWalletTopupLot & { _id: unknown }, s: ClientSession): Promise<Posted<W, E>> {
  const key = `chargeback:${String(lot._id)}`;
  const prior = await store.entryIn(key, s);
  if (prior) return { entry: prior, wallet: (await store.findIn(s)) as W, replayed: true };
  const closed = await WalletTopupLotModel.updateOne({ _id: lot._id, disputeState: { $ne: 'lost' } },
    { $set: { closed: true, disputeState: 'lost', remainingMinor: 0 } }, { session: s });
  if (closed.modifiedCount !== 1) throw changed('The top-up changed; please retry');
  const wallet = await store.walletIn(s);
  const w = store.state(wallet);
  const before = w.balanceMinor;
  const amount = Number(lot.amountMinor);
  const fromBalance = Math.min(before, amount);
  const shortfall = amount - fromBalance;
  const after = before - fromBalance;
  // The lot's own unspent money left with it (closed above); what else the balance gives up comes out of the other lots
  // (oldest first), so open lots never exceed the balance.
  // Review of db252c1 (item c): a lot recorded at the chargeback (`openedAtChargeback`: the top-up was credited
  // non-withdrawable) gives up the non-lot money first, and the other open lots only for the remainder, so card money
  // that is still honest stays withdrawable.
  let beyondLot = Math.max(0, fromBalance - Number(lot.remainingMinor || 0));
  if (lot.openedAtChargeback === true && beyondLot > 0) {
    beyondLot = Math.max(0, beyondLot - Math.max(0, before - await openLotsMinorIn(store.ref, s)));
  }
  const lotAllocations = beyondLot > 0 ? await consumeLots(store.ref, beyondLot, s) : [];
  const withdrawableAfter = await withdrawableOfIn(store.ref, s);
  const updated = await store.writeIn(wallet, { balanceMinor: after, withdrawableMinor: withdrawableAfter, receivableMinor: w.receivableMinor + shortfall,
    freeze: { reason: 'Card dispute lost on a top-up', at: new Date() } }, s);
  if (!updated) throw changed();
  const entry = await store.insertEntryIn(wallet, {
    kind: 'chargeback', amountMinor: fromBalance, signedMinor: -fromBalance, beforeMinor: before, afterMinor: after,
    referenceType: 'chargeback', referenceId: String(lot._id), description: 'Card dispute lost on a top-up', operationKey: key,
    receivableDeltaMinor: shortfall, withdrawableDeltaMinor: withdrawableAfter - w.withdrawableMinor, ...(lotAllocations.length ? { lotAllocations } : {}),
  }, s);
  return { entry, wallet: updated, replayed: false };
}

const RAZORPAY_PAYMENT_ID = /^pay_[A-Za-z0-9]{6,40}$/;
const RAZORPAY_ORDER_ID = /^order_[A-Za-z0-9_]{6,60}$/;

/** The gateway's answer for a payment id the database does not hold (read only). */
export type GatewayOrderLookup = (razorpayPaymentId: string) => Promise<{ available: false } | { available: true; orderId: string | null }>;

/**
 * Review of b378f61 (item 1): the card top-up record a payment chargeback or close names, OUTSIDE any transaction (it may
 * ask the gateway). `paymentId` is the record id, the Razorpay order id (always stored) or the Razorpay payment id (stored
 * only once verified or reconciled). A payment id the database does not hold is looked up with the gateway (read only:
 * the payment's order id, then the record of that order) when gateway keys are configured. More than one top-up → 409
 * PAYMENT_AMBIGUOUS; a payment id that resolves to nothing → 404 TOPUP_NOT_FOUND_BY_PAYMENT_ID (try the order or record
 * id); anything else unknown → 404 TOPUP_NOT_FOUND. Only top-ups of the given kinds count.
 */
export async function resolveTopupRecord(paymentId: string, kinds: TopupKind[], gateway?: GatewayOrderLookup): Promise<{ paymentRecordId: string; kind: TopupKind }> {
  const notFound = () => err(404, 'TOPUP_NOT_FOUND', 'Top-up not found');
  const kindOf = (r: Record<string, any>) => kinds.find((k) => k.isTopup(r));
  const id = String(paymentId ?? '');
  const byOrder = async (orderId: string) => await PaymentRecordModel.find({ razorpayOrderId: { $eq: orderId } }).limit(5).lean() as Record<string, any>[];
  let records: Record<string, any>[] = [];
  if (HEX24.test(id)) {
    const r = await PaymentRecordModel.findById(id).lean() as Record<string, any> | null;
    records = r ? [r] : [];
  } else if (RAZORPAY_ORDER_ID.test(id)) {
    records = await byOrder(id);
  } else if (RAZORPAY_PAYMENT_ID.test(id)) {
    records = await PaymentRecordModel.find({ razorpayPaymentId: { $eq: id } }).limit(5).lean() as Record<string, any>[];
    if (!records.some(kindOf)) {
      const answer = gateway ? await gateway(id) : { available: false as const };
      const orderId = answer.available ? answer.orderId : null;
      records = orderId ? await byOrder(orderId) : [];
      if (!records.some(kindOf)) {
        throw err(404, 'TOPUP_NOT_FOUND_BY_PAYMENT_ID', answer.available
          ? 'Not found by payment id; try the order id or the record id'
          : 'Not found by payment id (the gateway could not be asked); try the order id or the record id');
      }
    }
  }
  records = records.filter(kindOf);
  if (records.length > 1) throw err(409, 'PAYMENT_AMBIGUOUS', 'More than one top-up carries this payment id; use the payment record id');
  if (!records[0]) throw notFound();
  return { paymentRecordId: String(records[0]._id), kind: kindOf(records[0])! };
}

/**
 * A card dispute lost on a top-up, named by its payment record (as resolved by `resolveTopupRecord`; re-read here, in the
 * transaction):
 * - `taken` (`take` rule): a top-up WITH a lot goes through `chargeBackLotIn` (same operation key, so the lot and payment
 *   paths never charge one payment back twice); one credited without a lot (switch off, before sync-indexes or before
 *   phase 1a) gets a lot recorded now, already closed (`openedAtChargeback`), charged back exactly as a lot; one closed
 *   as compensated (r9b) takes back the amount support paid by hand the same way. The lot's unique `paymentRecordId`
 *   index makes this once per payment under concurrency; it is checked first, fail closed (503 INDEXES_OUTDATED).
 * - `flagged` (`flag` rule, owner C4): a credited (or compensated) top-up gets `chargebackAt` once and its lot is marked
 *   `disputeState: 'lost'` (its money is no longer withdrawable). No debit, no receivable, no freeze: recovering the
 *   money is an admin decision.
 * - `blocked` (both rules; review of db252c1, item a): a top-up never credited is blocked in this transaction
 *   (`chargebackAt`, status `failed`; a refunded one keeps its status), guarded on the status read and on no credit
 *   claim, so verify, reconcile, the top-up check and the sweep refuse it (409 TOPUP_BLOCKED) and it is never credited.
 *   The credit claims the record with a write in its own transaction, so the block and a credit never pass each other.
 */
export type TopupChargeback<W = any, E = any> =
  | (Posted<W, E> & { outcome: 'taken'; paymentRecordId: string; ownerId: string; lotId: string; withoutLot: boolean; compensated?: true })
  | { outcome: 'flagged'; replayed: boolean; paymentRecordId: string; ownerId: string; lotId: string | null; compensated?: true }
  | { outcome: 'blocked'; replayed: boolean; paymentRecordId: string; ownerId: string };

export async function recordTopupChargebackIn<W, E>(kind: TopupKind<W, E>, paymentRecordIdIn: string, s: ClientSession): Promise<TopupChargeback<W, E>> {
  const notFound = () => err(404, 'TOPUP_NOT_FOUND', 'Top-up not found');
  if (!HEX24.test(String(paymentRecordIdIn ?? ''))) throw notFound();
  const record = await PaymentRecordModel.findById(paymentRecordIdIn).session(s).lean() as Record<string, any> | null;
  if (!record || !kind.isTopup(record)) throw notFound();
  const paymentRecordId = String(record._id);
  const ownerId = kind.ownerOf(record);
  if (!Types.ObjectId.isValid(ownerId)) throw notFound();
  const store = kind.storeFor(record);
  const base = { paymentRecordId, ownerId };
  const compensated = record.compensatedAt ? { compensated: true as const } : {};
  await assertUniqueIndex(WalletTopupLotModel, { paymentRecordId: 1 });
  const existing = await WalletTopupLotModel.findOne({ paymentRecordId: { $eq: paymentRecordId } }).session(s).lean();
  if (existing && (existing.walletRef.kind !== store.ref.kind || existing.walletRef.id !== store.ref.id)) throw notFound();
  const credit = existing ? null : await store.rechargeCreditIn(paymentRecordId, s);
  const credited = !!existing || !!credit;
  if (!credited && !record.compensatedAt) {
    if (record.chargebackAt) return { outcome: 'blocked', replayed: true, ...base };
    const blocked = await PaymentRecordModel.updateOne({ _id: record._id, status: record.status, chargebackAt: { $exists: false }, walletCreditedAt: { $exists: false } },
      { $set: { chargebackAt: new Date(), ...(record.status !== 'refunded' ? { status: 'failed' } : {}) } }, { session: s });
    if (blocked.modifiedCount !== 1) throw changed('The top-up changed; please retry');
    return { outcome: 'blocked', replayed: false, ...base };
  }
  if (kind.chargeback === 'flag') {
    const lotId = existing ? String(existing._id) : null;
    if (record.chargebackAt) return { outcome: 'flagged', replayed: true, ...base, lotId, ...compensated };
    const marked = await PaymentRecordModel.updateOne({ _id: record._id, chargebackAt: { $exists: false } }, { $set: { chargebackAt: new Date() } }, { session: s });
    if (marked.modifiedCount !== 1) throw changed('The top-up changed; please retry');
    if (existing && existing.disputeState === 'none') {
      await WalletTopupLotModel.updateOne({ _id: existing._id, disputeState: 'none' }, { $set: { disputeState: 'lost' } }, { session: s });
      await refreshWithdrawableIn(store, s);
    }
    return { outcome: 'flagged', replayed: false, ...base, lotId, ...compensated };
  }
  if (existing) {
    const r = await chargeBackLotIn(store, existing, s);
    return { ...r, outcome: 'taken', ...base, lotId: String(existing._id), withoutLot: existing.openedAtChargeback === true, ...compensated };
  }
  // r9b: a top-up closed as compensated was paid to the owner by hand; a lost dispute takes that amount back exactly as for
  // a credited top-up. The record is marked `chargebackAt` too (the S6 audit lists both).
  let amountMinor: number;
  let fee: number | null = null;
  if (!credited) {
    amountMinor = Number.isSafeInteger(record.compensation?.amountPaise) ? Number(record.compensation.amountPaise) : recordPaiseOf(record);
    if (!(amountMinor > 0)) throw notFound();
    // (A record an r9 chargeback already marked without taking anything keeps its mark and is charged back now.)
    if (!record.chargebackAt) {
      const marked = await PaymentRecordModel.updateOne({ _id: record._id, compensatedAt: { $exists: true }, chargebackAt: { $exists: false } },
        { $set: { chargebackAt: new Date() } }, { session: s });
      if (marked.modifiedCount !== 1) throw changed('The top-up changed; please retry');
    }
  } else {
    amountMinor = credit!.amountMinor;
    if (!(amountMinor > 0)) throw notFound();
    fee = typeof record.gatewayFeeMinor === 'number' && Number.isSafeInteger(record.gatewayFeeMinor) && record.gatewayFeeMinor >= 0 ? record.gatewayFeeMinor : null;
  }
  const [lot] = await WalletTopupLotModel.create([{ walletRef: store.ref, paymentRecordId, amountMinor,
    ...(fee !== null ? { gatewayFeeMinor: fee } : {}), feeState: fee !== null ? 'known' : 'unknown', disputeState: 'none', closed: true, remainingMinor: 0,
    openedAtChargeback: true }], { session: s });
  const r = await chargeBackLotIn(store, lot!.toObject() as IWalletTopupLot & { _id: unknown }, s);
  return { ...r, outcome: 'taken', ...base, lotId: String(lot!._id), withoutLot: true, ...compensated };
}

/**
 * r9 (owner decision): support already paid the owner by hand for a card top-up that never arrived, so the top-up is
 * CLOSED AS COMPENSATED in the caller's transaction: `compensatedAt` + `compensation` (with the amount paid by hand) and
 * status `failed`, guarded on the status read and on no credit claim. Verify, reconcile, the top-up check, the sweep and
 * the S6 credit script then never credit it. The credit claims the same document in its own transaction, so a close and
 * a credit never both commit: either it was credited (409 TOPUP_ALREADY_CREDITED) or it is closed and never credited.
 * - not a top-up of this kind → 404 TOPUP_NOT_FOUND; blocked after a lost dispute → 409 TOPUP_BLOCKED; refunded by the
 *   gateway → 409 TOPUP_REFUNDED (r9b);
 * - already closed → the stored closure (`replayed: true`); the same (admin, key) with other content → 409
 *   IDEMPOTENCY_KEY_REUSED. `requestKey` is the stored `<adminId>:<key>`.
 */
export interface CompensatedClose { replayed: boolean; paymentRecordId: string; ownerId: string; amountPaise: number; compensatedAt: Date; status: string }

export async function closeTopupCompensatedIn(kind: TopupKind, paymentRecordIdIn: string, c: { by: string; reason: string; requestKey: string; requestHash: string },
  s: ClientSession): Promise<CompensatedClose> {
  const notFound = () => err(404, 'TOPUP_NOT_FOUND', 'Top-up not found');
  if (!HEX24.test(String(paymentRecordIdIn ?? ''))) throw notFound();
  const record = await PaymentRecordModel.findById(paymentRecordIdIn).session(s).lean() as Record<string, any> | null;
  if (!record || !kind.isTopup(record)) throw notFound();
  const paymentRecordId = String(record._id);
  const ownerId = kind.ownerOf(record);
  const amountPaise = recordPaiseOf(record);
  const answer = (r: Record<string, any>, replayed: boolean): CompensatedClose => ({ replayed, paymentRecordId, ownerId, amountPaise,
    compensatedAt: r.compensatedAt, status: r.status });
  if (record.compensatedAt) {
    if (record.compensation?.requestKey === c.requestKey && record.compensation?.requestHash !== c.requestHash) {
      throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different close');
    }
    return answer(record, true);
  }
  if (record.chargebackAt) throw err(409, 'TOPUP_BLOCKED', 'This top-up was already blocked after a lost card dispute; it is never credited');
  if (record.status === 'refunded') throw err(409, 'TOPUP_REFUNDED', 'The gateway already returned this top-up to the payer; there is nothing to close');
  if (record.walletCreditedAt || await kind.storeFor(record).rechargeCreditIn(paymentRecordId, s)) {
    throw err(409, 'TOPUP_ALREADY_CREDITED', 'This top-up was already credited to the wallet; there is nothing to close');
  }
  const at = new Date();
  const status = 'failed';
  const closed = await PaymentRecordModel.updateOne({ _id: record._id, status: record.status, compensatedAt: { $exists: false },
    chargebackAt: { $exists: false }, walletCreditedAt: { $exists: false } },
  { $set: { compensatedAt: at, status, compensation: { by: c.by, reason: c.reason, requestKey: c.requestKey, requestHash: c.requestHash,
    previousStatus: record.status, amountPaise } } }, { session: s });
  if (closed.modifiedCount !== 1) throw changed('The top-up changed; please retry');
  return answer({ compensatedAt: at, status }, false);
}

/**
 * The credit of a captured card top-up, in the caller's transaction, exactly once. Review of db252c1 (item a): the credit
 * claims the record (`walletCreditedAt` from absent, while it is paid, not blocked after a lost dispute and not closed as
 * compensated) — a write, so a concurrent block or close and this credit never both commit. `entryId` is the credit row
 * this attempt wrote (null on a replay).
 */
export async function creditTopupIn<W, E>(kind: TopupKind<W, E>, record: IPaymentRecord, opts: { lots: boolean }, s: ClientSession):
Promise<{ wallet: W; entryId: string | null }> {
  const store = kind.storeFor(record as unknown as Record<string, any>);
  const recordId = String(record._id);
  if (await store.rechargeCreditIn(recordId, s)) return { wallet: (await store.findIn(s)) as W, entryId: null };
  const claimed = await PaymentRecordModel.updateOne(
    { _id: record._id, status: 'paid', chargebackAt: { $exists: false }, compensatedAt: { $exists: false } },
    { $set: { walletCreditedAt: new Date() } }, { session: s });
  if (claimed.modifiedCount !== 1) {
    const now = await PaymentRecordModel.findById(record._id).select({ compensatedAt: 1 }).session(s).lean();
    if (now?.compensatedAt) throw topupClosedCompensated();
    throw topupBlocked();
  }
  const paidAt = record.paidAt ? new Date(record.paidAt).getTime() : Date.now();
  const posted = await postMovementIn(store, {
    kind: 'credit', amountMinor: record.baseAmountPaise ?? Math.round(record.baseAmount * 100), operationKey: `wallet_recharge:${recordId}`,
    referenceType: 'wallet_recharge', referenceId: recordId, description: kind.rechargeDescription, notes: record.razorpayPaymentId,
    ...(opts.lots ? { lot: { paymentRecordId: recordId, gatewayFeeMinor: record.gatewayFeeMinor ?? null,
      ...(kind.cardHoldDays ? { withdrawableAfter: new Date(paidAt + kind.cardHoldDays * 86_400_000) } : {}) } } : {}),
  }, s);
  return { wallet: posted.wallet, entryId: posted.replayed ? null : String((posted.entry as { _id?: unknown })._id) };
}

/**
 * Admin manual credit (review of fb4063c7, 4): one credit per Idempotency-Key — the same key and content answers the
 * wallet again (nothing more is credited); the same key with another amount or note is 409 IDEMPOTENCY_KEY_REUSED
 * (content hash on the row; an older row without one is compared by amount and note). The admin is stored on the row.
 * Never withdrawable (no lot); posts whatever the wallet state. `audit` runs in the credit's transaction (first credit only).
 */
export async function adminTopup<W, E>(store: WalletStore<W, E>, t: { key: string; amountMinor: number; notes?: string; adminId?: string },
  audit?: (posted: Posted<W, E>, s: ClientSession) => Promise<void>): Promise<W> {
  const notes = t.notes ?? null;
  const requestHash = requestHashOf({ kind: 'admin_topup', amountPaise: t.amountMinor, notes });
  const reused = () => err(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different top-up');
  /** The wallet when this key already credited this same content; 409 when it credited something else. */
  const replayOf = async (): Promise<W | null> => {
    const existing = await store.adminTopupIn(t.key);
    if (!existing) return null;
    const f = store.topupFacts(existing);
    if (!(f.requestHash ? f.requestHash === requestHash : f.amountMinor === t.amountMinor && f.notes === notes)) throw reused();
    return store.findIn(null);
  };
  const prior = await replayOf();
  if (prior) return prior;
  try {
    const result = await walletTransaction(async (s) => {
      const posted = await postMovementIn(store, {
        kind: 'credit', amountMinor: t.amountMinor, operationKey: `admin_topup:${t.key}`, referenceType: 'topup', referenceId: t.key,
        description: 'Admin top-up', notes: t.notes, requestHash, ...(t.adminId ? { actor: { kind: 'admin' as const, id: String(t.adminId) } } : {}),
      }, s);
      const hash = store.topupFacts(posted.entry).requestHash;
      if (posted.replayed && hash && hash !== requestHash) throw reused();
      if (!posted.replayed && audit) await audit(posted, s);
      return posted.wallet;
    });
    if (!result) throw err(500, 'TOPUP_FAILED', 'Failed to top up wallet');
    return result;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const wallet = await replayOf();
      if (wallet) return wallet;
    }
    throw error;
  }
}

/** An admin sets or clears the freeze (in the caller's transaction). A wallet owing a receivable stays frozen. */
export async function setFrozenIn<W>(store: WalletStore<W>, frozen: boolean, reason: string, s: ClientSession): Promise<W> {
  const w = await store.walletIn(s);
  if (!frozen && store.state(w).receivableMinor > 0) throw err(409, 'WALLET_RECEIVABLE', 'This wallet still owes a receivable');
  const updated = await store.writeIn(w, { freeze: frozen ? { reason, at: new Date() } : null }, s);
  if (!updated) throw changed();
  return updated;
}

/**
 * §6.4 (W3b pattern): "check my top-up" — reconciles one of this owner's card top-ups with the gateway and credits it once
 * if it was captured. Another owner's (or a missing) record is the one 404.
 */
export async function checkTopup<W>(kind: TopupKind<W>, ownerId: string, paymentTransactionId: string,
  reconcile: (r: { paymentTransactionId: string; userId: string }) => Promise<{ state: string }>): Promise<{ state: 'credited' | 'unpaid'; wallet: W | null }> {
  const notFound = () => err(404, 'PAYMENT_RECORD_NOT_FOUND', 'Payment record not found');
  if (!HEX24.test(String(paymentTransactionId))) throw notFound();
  const record = await PaymentRecordModel.findById(paymentTransactionId).lean() as Record<string, any> | null;
  if (!record || !kind.isTopup(record) || kind.ownerOf(record) !== String(ownerId).toLowerCase()) throw notFound();
  const out = await reconcile({ paymentTransactionId: String(record._id), userId: String(record.payerUserId || record.userId) });
  return { state: out.state === 'paid' ? 'credited' : 'unpaid', wallet: await kind.store(ownerId).findIn(null) };
}
