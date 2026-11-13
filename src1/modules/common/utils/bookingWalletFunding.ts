import { ClientSession, Model, startSession } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletRepository } from '@/modules/wallet/repository';

/**
 * The booking is the single ledger of customer money it holds (`walletFunding`):
 *   total     wallet money currently applied (rupees)
 *   captures  each captured gateway payment, once: 'applied' to this booking or 'returned' to the wallet
 *   closed    set by the cancellation refund: everything held was returned; nothing can be added afterwards
 *   revision  +1 on every money effect; wallet ledger operation keys derive from it (never from amounts)
 * Every function below changes this record and the matching wallet ledger row in ONE transaction, fenced on the
 * revision it read, so cancellation, unapplied-capture returns, excess returns and new funding can never pay the
 * same money twice or lose any of it, whatever order they run in.
 *
 * Bookings created before this existed are initialised on first touch from `legacyFunded` (the linked payment
 * record's notes.walletDeductedAmount) and, for refunds, `legacyGateway` (a paid linked record).
 */
export type FundedBookingKind = 'booking' | 'external_booking';
export interface Capture { recordId: string; amount: number; state: 'applied' | 'returned' }
interface Funding { total: number; revision: number; closed: boolean; captures: Capture[] }
interface Row { _id?: unknown; status?: string; paymentStatus?: string; paymentTransactionId?: string; userId?: string; walletFunding?: Partial<Funding> }

const rupees = (n: number) => Math.round(n * 100) / 100;
const has = (b: Row) => !!b.walletFunding && typeof b.walletFunding.total === 'number';
const read = (b: Row, legacyFunded = 0): Funding => has(b)
  ? { total: Number(b.walletFunding!.total), revision: Number(b.walletFunding!.revision ?? 0), closed: !!b.walletFunding!.closed,
      captures: (b.walletFunding!.captures ?? []).map(c => ({ recordId: String(c.recordId), amount: Number(c.amount), state: c.state })) }
  : { total: rupees(legacyFunded), revision: 0, closed: false, captures: [] };

/**
 * Ledger for this row, hydrating a pre-ledger booking from its AUTHORITATIVE linked payment record (never from the
 * payment currently being processed): that record's wallet portion, plus its gateway amount as an applied capture
 * if the booking was already paid through it. `fallbackFunded` is used only when there is no linked record.
 */
async function hydrate(b: Row, s: ClientSession, fallbackFunded = 0): Promise<Funding> {
  if (has(b)) return read(b);
  const linked = b.paymentTransactionId ? await PaymentRecordModel.findById(String(b.paymentTransactionId)).session(s).lean() : null;
  const funded = linked ? Number(linked.notes?.walletDeductedAmount || 0) : fallbackFunded;
  const f = read(b, funded);
  if (linked && b.paymentStatus === 'paid' && linked.status === 'paid' && Number(linked.finalAmount || 0) > 0) {
    f.captures.push({ recordId: String(linked._id).toLowerCase(), amount: rupees(Number(linked.finalAmount)), state: 'applied' });
  }
  return f;
}
export const fundedTotal = (b: Row, legacyFunded = 0): number => read(b, legacyFunded).total;
// 'cancellation_requested': an external booking with a recorded cancellation intent (A2b) is never payable again.
export const isPayable = (b: Row) => !['cancelled', 'cancellation_requested'].includes(String(b.status)) && !['paid', 'refunded', 'cancelled'].includes(String(b.paymentStatus))
  && !(has(b) && b.walletFunding!.closed);

const notPayable = () => new AppError({ status: 409, code: 'BOOKING_NOT_PAYABLE', message: 'This booking is already paid or cancelled' });
const changed = () => Object.assign(new AppError({ status: 409, code: 'BOOKING_FUNDING_CHANGED', message: 'Booking payment changed; try again' }), { retryable: true });

/** Fence: exactly the funding revision (or absence) read in this transaction. */
const fence = (b: Row) => ({ _id: b._id, ...(has(b) ? { 'walletFunding.revision': b.walletFunding!.revision ?? 0, 'walletFunding.total': b.walletFunding!.total }
  : { walletFunding: { $exists: false } }) });
const store = (f: Funding) => ({ walletFunding: { total: rupees(f.total), revision: f.revision, closed: f.closed, captures: f.captures, updatedAt: new Date() } });

/** The ledger's transaction runner (retries write conflicts and duplicate-key races); shared by booking settlement. */
export async function runLedgerTransaction<T>(work: (s: ClientSession) => Promise<T>): Promise<T> {
  return inTransaction(work);
}

async function inTransaction<T>(work: (s: ClientSession) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const session = await startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => { result = await work(session); });
      return result as T;
    } catch (error) {
      const retry = (error as { code?: number })?.code === 11000 || (error as { retryable?: boolean })?.retryable;
      if (retry && attempt < 4) continue;
      throw error;
    } finally { await session.endSession(); }
  }
}

/** Credits never need an active wallet (money owed back is owed back); a missing wallet is created. */
async function walletOf(userId: string, s: ClientSession) {
  return WalletModel.findOneAndUpdate({ userId }, { $setOnInsert: { userId, balance: 0, isActive: true } },
    { upsert: true, new: true, session: s }).lean();
}

async function credit(p: { wallets: WalletRepository; kind: FundedBookingKind; id: string; userId: string; amount: number; key: string; description: string }, s: ClientSession) {
  if (!(p.amount > 0)) return;
  const wallet = await walletOf(p.userId, s);
  await p.wallets.postEntry({ userId: p.userId, walletId: wallet._id, transactionType: 'refund', amount: rupees(p.amount), referenceType: p.kind,
    referenceId: p.id, operationKey: p.key, description: p.description, transactionDate: getTodayYyyymmdd() }, s);
}

const appliedGateway = (f: Funding) => f.captures.filter(c => c.state === 'applied').reduce((a, c) => a + c.amount, 0);

/**
 * Brings wallet funding towards `gross` (amount due after discounts), using at most `requested` from the wallet;
 * funding above `gross` (terms changed) goes back to the wallet. requested=0 only reconciles.
 */
export async function fundBookingFromWallet(p: {
  model: Model<any>; kind: FundedBookingKind; bookingId: string; userId: string;
  gross: number; requested: number; legacyFunded: number; wallets?: WalletRepository;
}): Promise<{ total: number; debited: number; returned: number }> {
  const wallets = p.wallets ?? new WalletRepository();
  const id = String(p.bookingId).toLowerCase();
  const gross = rupees(Math.max(0, p.gross));
  return inTransaction(async s => {
    const b = await p.model.findById(id).session(s).lean() as Row | null;
    if (!b) throw new AppError({ status: 404, code: 'BOOKING_NOT_FOUND', message: 'Booking not found' });
    if (!isPayable(b)) throw notPayable();
    const f = await hydrate(b, s, p.legacyFunded);
    const save = async (next: Funding) => {
      const r = await p.model.updateOne({ ...fence(b), status: b.status, paymentStatus: b.paymentStatus }, { $set: store(next) }, { session: s });
      if (r.matchedCount !== 1) throw changed();
    };
    if (f.total > gross) {
      const back = rupees(f.total - gross);
      const next = { ...f, total: gross, revision: f.revision + 1 };
      await save(next);
      await credit({ wallets, kind: p.kind, id, userId: p.userId, amount: back, key: `${p.kind}_funding:${id}:r${next.revision}`,
        description: 'Wallet amount above the new amount due returned' }, s);
      return { total: gross, debited: 0, returned: back };
    }
    const want = rupees(Math.min(gross - f.total, Math.max(0, p.requested)));
    const wallet = want > 0 ? await WalletModel.findOne({ userId: p.userId }).session(s).lean() : null;
    const amount = wallet?.isActive ? rupees(Math.min(want, Number(wallet.balance))) : 0;
    if (!(amount > 0)) {
      if (!has(b)) await save(f); // first touch records the legacy/zero funding
      return { total: f.total, debited: 0, returned: 0 };
    }
    const next = { ...f, total: rupees(f.total + amount), revision: f.revision + 1 };
    await save(next);
    const posted = await wallets.postEntry({ userId: p.userId, walletId: wallet!._id, transactionType: 'debit', amount, referenceType: p.kind, referenceId: id,
      operationKey: `${p.kind}_funding:${id}:r${next.revision}`,
      description: p.kind === 'booking' ? 'Wallet used for booking payment' : 'Wallet used for external booking payment',
      transactionDate: getTodayYyyymmdd() }, s);
    if (!posted) throw changed();
    return { total: next.total, debited: amount, returned: 0 };
  });
}

/**
 * Records one captured gateway payment exactly once. It is applied to the booking only when `applicable(row)` holds
 * (the caller's own payable/winner test, evaluated inside the transaction); otherwise it is returned to the wallet.
 * When applied, `applyPatch` is written in the same transaction (e.g. paymentStatus/link), and any wallet funding
 * above the amount due is returned. Replays re-run the excess check, so a crash after applying cannot strand it.
 */
export async function recordGatewayCapture(p: {
  model: Model<any>; kind: FundedBookingKind; bookingId: string; userId: string; recordId: string; amount: number; gross: number;
  legacyFunded: number; applicable: (b: Row) => boolean;
  /** Written with the applied capture; a function is evaluated on the booking read in this transaction. */
  applyPatch?: Record<string, unknown> | ((b: Row) => Record<string, unknown>); wallets?: WalletRepository;
}): Promise<{ state: 'applied' | 'returned'; fresh: boolean; excessReturned: number }> {
  const wallets = p.wallets ?? new WalletRepository();
  const id = String(p.bookingId).toLowerCase();
  const recordId = String(p.recordId).toLowerCase();
  return inTransaction(async s => {
    const b = await p.model.findById(id).session(s).lean() as Row | null;
    if (!b) throw new AppError({ status: 404, code: 'BOOKING_NOT_FOUND', message: 'Booking not found' });
    const f = await hydrate(b, s, p.legacyFunded);
    let next = { ...f, captures: [...f.captures] };
    let patch: Record<string, unknown> = {};
    const known = f.captures.find(c => c.recordId === recordId);
    // Exclusive financial winner: at most one gateway capture is ever applied to a booking, chosen here in the
    // ledger transaction, independent of any mutable payment link a provider callback may have overwritten.
    const winner = f.captures.find(c => c.state === 'applied');
    let state: 'applied' | 'returned';
    let returnCapture = 0;
    if (known) {
      state = known.state;
      // A replayed losing callback may have re-linked the booking to this returned capture: point it back.
      if (state === 'returned' && winner && String(b.paymentTransactionId).toLowerCase() === recordId) patch = { paymentTransactionId: winner.recordId };
    } else if (!f.closed && !winner && p.applicable(b)) {
      state = 'applied';
      next.captures.push({ recordId, amount: rupees(p.amount), state });
      next.revision += 1;
      patch = typeof p.applyPatch === 'function' ? p.applyPatch(b) : (p.applyPatch ?? {});
    } else {
      state = 'returned';
      next.captures.push({ recordId, amount: rupees(p.amount), state });
      next.revision += 1;
      returnCapture = rupees(p.amount);
      // A losing capture that a provider callback linked: point the booking back at the financial winner.
      if (winner && String(b.paymentTransactionId).toLowerCase() === recordId) patch = { paymentTransactionId: winner.recordId };
    }
    let excess = 0;
    if (!next.closed && b.status !== 'cancelled' && state === 'applied') {
      excess = rupees(Math.min(next.total, next.total + appliedGateway(next) - Math.max(0, p.gross)));
      if (excess > 0) next = { ...next, total: rupees(next.total - excess), revision: next.revision + 1 };
      else excess = 0;
    }
    if (next.revision === f.revision && has(b) && !Object.keys(patch).length) return { state, fresh: false, excessReturned: 0 }; // nothing to change
    const r = await p.model.updateOne(fence(b), { $set: { ...store(next), ...patch } }, { session: s });
    if (r.matchedCount !== 1) throw changed();
    await credit({ wallets, kind: p.kind, id, userId: p.userId, amount: returnCapture, key: `${p.kind}_capture_returned:${recordId}`,
      description: 'Payment received for a cancelled or already-paid booking; returned to wallet' }, s);
    await credit({ wallets, kind: p.kind, id, userId: p.userId, amount: excess, key: `${p.kind}_funding:${id}:r${next.revision}`,
      description: 'Wallet amount above the paid total returned' }, s);
    return { state, fresh: !known, excessReturned: excess };
  });
}

/**
 * Cancellation refund: returns everything the booking holds (wallet funding + applied captures) and CLOSES it in
 * the same transaction, so no later funding, capture or excess return can add to or repeat it. Safe to call before
 * or after the caller writes its cancelled status, and safe to repeat (returns 0 once closed and reconciled).
 *
 * `paidRecords`: every captured payment record of the booking (and its owner) the caller read in this transaction.
 * One the ledger does not know (its capture registration was interrupted, e.g. an earlier attempt the booking no
 * longer links) is money the booking holds as well: it is recorded as returned and credited once under its own
 * capture key, the same key a later registration would use, so nothing is paid twice or stranded.
 */
export interface RefundAndCloseParams {
  model: Model<any>; kind: FundedBookingKind; bookingId: string; userId: string; legacyFunded: number; legacyGateway: number;
  legacyGatewayRecordId?: string; paidRecords?: { recordId: string; amount: number }[];
  /** A refund from before the ledger already returned the funding and the linked capture. */
  priorRefund?: boolean; wallets?: WalletRepository;
}
export async function refundAndClose(p: RefundAndCloseParams): Promise<number> {
  return inTransaction(s => refundAndCloseIn(p, s));
}

/** refundAndClose inside the caller's transaction (e.g. together with the cancellation write and hold releases). */
export async function refundAndCloseIn(p: RefundAndCloseParams, s: ClientSession): Promise<number> {
  const wallets = p.wallets ?? new WalletRepository();
  const id = String(p.bookingId).toLowerCase();
  const b = await p.model.findById(id).session(s).lean() as Row | null;
  if (!b) return 0;
  const f = await hydrate(b, s, p.legacyFunded);
  const paidKey = p.legacyGatewayRecordId ? String(p.legacyGatewayRecordId).toLowerCase() : undefined;
  const linkedUnknown = !!paidKey && p.legacyGateway > 0 && !f.captures.some(c => c.recordId === paidKey);
  const others: Capture[] = [];
  for (const r of p.paidRecords ?? []) {
    const recordId = String(r.recordId).toLowerCase();
    const amount = rupees(Number(r.amount));
    if (!(amount > 0) || recordId === paidKey || f.captures.some(c => c.recordId === recordId) || others.some(c => c.recordId === recordId)) continue;
    others.push({ recordId, amount, state: 'returned' });
  }
  const returnEach = async (list: Capture[], description: string) => {
    for (const c of list) {
      await credit({ wallets, kind: p.kind, id, userId: p.userId, amount: c.amount, key: `${p.kind}_capture_returned:${c.recordId}`, description }, s);
    }
    return rupees(list.reduce((a, c) => a + c.amount, 0));
  };

  if (f.closed) {
    // Already refunded and closed, but captured payments arrived that the ledger does not know: return each once.
    const late = [...(linkedUnknown ? [{ recordId: paidKey!, amount: rupees(p.legacyGateway), state: 'returned' as const }] : []), ...others];
    if (!late.length) return 0;
    const r0 = await p.model.updateOne(fence(b), { $set: store({ ...f, revision: f.revision + 1, captures: [...f.captures, ...late] }) }, { session: s });
    if (r0.matchedCount !== 1) throw changed();
    return returnEach(late, 'Payment received for a cancelled booking; returned to wallet');
  }
  const captures = [...f.captures];
  // A paid linked record the ledger does not know yet (pre-ledger booking, or a crash between the provider's
  // paid/link write and the capture registration): its money is held by this booking too, so it is refunded here
  // (closing returns every capture) and any later processing of it finds it already returned.
  if (linkedUnknown) captures.push({ recordId: paidKey!, amount: rupees(p.legacyGateway), state: 'applied' });
  const gateway = captures.filter(c => c.state === 'applied').reduce((a, c) => a + c.amount, 0);
  const amount = rupees(f.total + gateway);
  const next: Funding = { total: 0, revision: f.revision + 1, closed: true,
    captures: [...captures.map(c => c.state === 'applied' ? { ...c, state: 'returned' as const } : c), ...others] };
  const r = await p.model.updateOne(fence(b), { $set: store(next) }, { session: s });
  if (r.matchedCount !== 1) throw changed();
  const extra = await returnEach(others, 'Earlier payment attempt for a cancelled booking returned to wallet');
  // A refund from before the booking ledger existed: close without paying it again.
  if (p.priorRefund || await WalletTransactionModel.exists({ operationKey: `${p.kind}_refund:${id}` }).session(s)) return extra;
  await credit({ wallets, kind: p.kind, id, userId: p.userId, amount, key: `${p.kind}_refund:${id}`,
    description: p.kind === 'booking' ? 'Refund for cancelled booking' : 'Refund for external booking' }, s);
  return rupees(amount + extra);
}
