import { Container } from 'typedi';
import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { assertAdminToolsOn, assertLabWalletOn } from '@/modules/assisted/flags';
import { auditIn } from '@/modules/assisted/support';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentService } from '@/modules/payment/services';
import type { IPaymentRecord, VerifyPaymentRequest } from '@/modules/payment/types';
import { adminTopup, checkTopup, setFrozenIn, walletTransaction } from '@/modules/pharmacyWallet/walletCore';
import { lotsOf } from '@/modules/pharmacyWallet/walletLots';
import { PartnerWalletEntryModel, type IPartnerWallet, type IPartnerWalletEntry } from '@/modules/partnerWallets/model';
import { assertPartnerWalletIndexes, LAB_WALLET_POLICY, labOrNotFound, labStore, labTopups } from '@/modules/partnerWallets/ledger';

/**
 * r13 (round 2d, §24.7.3): the lab wallet's reads and commands, for the lab workspace (members) and the admin tools.
 * Money moves only through the shared wallet rules (`walletCore.ts`); answers are integer paise.
 */
export interface LabMember { partnerId: string; memberId: string }

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const payments = (): PaymentService => Container.get(PaymentService);
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const recordNotFound = () => err(404, 'PAYMENT_RECORD_NOT_FOUND', 'Payment record not found');
const PENDING_WINDOW_MS = 30 * 60_000;

// ── Views ──
export function labWalletView(w: IPartnerWallet | null | undefined) {
  return { balanceMinor: w?.balanceMinor ?? 0, withdrawableMinor: w?.withdrawableMinor ?? 0, receivableMinor: w?.receivableMinor ?? 0,
    frozen: w?.frozen === true, isActive: w ? w.isActive !== false : true, updatedAt: w?.updatedAt ?? null };
}
const adminWalletView = (w: IPartnerWallet | null) => ({ ...labWalletView(w), exists: !!w, frozenReason: w?.frozenReason ?? null,
  frozenAt: w?.frozenAt ?? null, version: w?.version ?? 0, createdAt: w?.createdAt ?? null });
const entryView = (e: IPartnerWalletEntry) => ({ _id: String(e._id), kind: e.kind, amountMinor: e.amountMinor, balanceAfterMinor: e.balanceAfterMinor,
  description: e.description, referenceType: e.referenceType, referenceId: e.referenceId, at: e.at });
const adminEntryView = (e: IPartnerWalletEntry) => ({ ...entryView(e), withdrawableDeltaMinor: e.withdrawableDeltaMinor, receivableDeltaMinor: e.receivableDeltaMinor,
  operationKey: e.operationKey, notes: e.notes ?? null, lotAllocations: e.lotAllocations ?? [], actor: e.actor ?? null });
const recordPaise = (r: IPaymentRecord) => (Number.isSafeInteger(r.finalAmountPaise) ? Number(r.finalAmountPaise) : Math.round(Number(r.finalAmount) * 100));
const recordView = (r: IPaymentRecord) => ({ _id: String(r._id), status: r.status, amountMinor: recordPaise(r), currency: r.currency,
  razorpayOrderId: r.razorpayOrderId, razorpayPaymentId: r.razorpayPaymentId ?? null, paidAt: r.paidAt ?? null, credited: !!r.walletCreditedAt });
/** Where a lab top-up stands, for the history and the web's "Check" button. */
const topupState = (r: IPaymentRecord) => (r.walletCreditedAt ? 'credited' : r.compensatedAt ? 'closed_compensated' : r.chargebackAt ? 'blocked'
  : r.status === 'created' ? 'awaiting_payment' : r.status === 'paid' ? 'paid_not_credited' : r.status);
const topupView = (r: IPaymentRecord) => ({ paymentTransactionId: String(r._id), amountMinor: recordPaise(r), state: topupState(r), status: r.status,
  memberId: r.payerMemberId ?? null, razorpayOrderId: r.razorpayOrderId, createdAt: r.createdAt, paidAt: r.paidAt ?? null });

/** `<at ms>_<id>` cursors over a newest-first list. */
const CURSOR = /^(\d{1,15})_([0-9a-fA-F]{24})$/;
function page<T extends { _id?: unknown }>(rows: T[], limit: number, timeOf: (r: T) => Date | undefined): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? `${new Date(timeOf(last) ?? 0).getTime()}_${String(last._id)}` : null };
}
function after(field: string, cursor?: string): Record<string, unknown> {
  const m = cursor ? CURSOR.exec(cursor) : null;
  if (!m) return {};
  const at = new Date(Number(m[1]));
  const id = new Types.ObjectId(m[2]);
  return { $or: [{ [field]: { $lt: at } }, { [field]: at, _id: { $lt: id } }] };
}

// ── Reads (members with wallet.view; admins) ──
export async function walletOf(partnerId: string) {
  return labWalletView(await labStore(partnerId).findIn(null));
}

export async function entriesOf(partnerId: string, q: { cursor?: string; limit?: number }, admin = false) {
  const limit = Math.min(50, Math.max(1, Number(q.limit ?? 20)));
  const rows = await PartnerWalletEntryModel.find({ ownerKind: 'lab', ownerId: lower(partnerId), ...after('at', q.cursor) })
    .sort({ at: -1, _id: -1 }).limit(limit + 1).lean() as IPartnerWalletEntry[];
  const { items, nextCursor } = page(rows, limit, (e) => e.at);
  return { items: items.map(admin ? adminEntryView : entryView), nextCursor };
}

/** The lab's card top-ups, newest first (a lost answer: find it and press "Check"). */
export async function topupsOf(partnerId: string, q: { cursor?: string; limit?: number }) {
  const limit = Math.min(50, Math.max(1, Number(q.limit ?? 20)));
  const rows = await PaymentRecordModel.find({ payerPartnerId: lower(partnerId), context: 'wallet_recharge', 'notes.flow': labTopups.flow, ...after('createdAt', q.cursor) })
    .sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean() as unknown as IPaymentRecord[];
  const { items, nextCursor } = page(rows, limit, (r) => r.createdAt);
  return { items: items.map(topupView), nextCursor };
}

// ── Top-up by card (members with wallet.manage, operational lab, switch on) ──
function razorpayKeyId(): string {
  try {
    return (payments() as unknown as { getRazorpayCredentials(): { keyId: string } }).getRazorpayCredentials().keyId;
  } catch {
    throw err(503, 'RAZORPAY_NOT_CONFIGURED', 'Card and UPI top-ups are not available right now');
  }
}
const orderView = (r: IPaymentRecord, replayed: boolean) => ({ paymentTransactionId: String(r._id), razorpayOrderId: r.razorpayOrderId,
  razorpayKeyId: razorpayKeyId(), amountMinor: recordPaise(r), currency: r.currency, state: topupState(r), replayed });

/**
 * POST /partner-workspace/assisted/wallet/topups { amountMinor, requestKey } — one Razorpay order per request key (scope
 * `wallet_topup:lab:<partnerId>:<memberId>`, content hash of the amount): the same key and amount answers the same order
 * (`replayed`), another amount 409 IDEMPOTENCY_KEY_REUSED. O2: the balance, the lab's unpaid top-ups of the last 30
 * minutes and this one may not pass ₹50,000 (409 WALLET_LIMIT_REACHED); a paid top-up is always credited.
 */
export async function createLabTopup(m: LabMember, body: { amountMinor: number; requestKey: string }) {
  assertLabWalletOn();
  await assertPartnerWalletIndexes();
  await assertUniqueIndex(PaymentRecordModel, { requestKey: 1 });
  const partnerId = lower(m.partnerId);
  const requestKey = `wallet_topup:lab:${partnerId}:${lower(m.memberId)}:${body.requestKey}`;
  const requestHash = requestHashOf({ kind: 'lab_wallet_topup', amountMinor: body.amountMinor });
  const replay = async () => {
    const r = await PaymentRecordModel.findOne({ requestKey: { $eq: requestKey } }).lean() as unknown as IPaymentRecord | null;
    if (!r) return null;
    if (r.requestHash !== requestHash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different top-up');
    return orderView(r, true);
  };
  const prior = await replay();
  if (prior) return prior;
  const balanceMinor = (await labStore(partnerId).findIn(null))?.balanceMinor ?? 0;
  const pending = await PaymentRecordModel.find({ payerPartnerId: partnerId, context: 'wallet_recharge', 'notes.flow': labTopups.flow, status: 'created',
    createdAt: { $gte: new Date(Date.now() - PENDING_WINDOW_MS) } }).select({ finalAmount: 1, finalAmountPaise: 1 }).lean() as unknown as IPaymentRecord[];
  const pendingMinor = pending.reduce((a, r) => a + recordPaise(r), 0);
  const max = LAB_WALLET_POLICY.maxBalanceMinor;
  if (balanceMinor + pendingMinor + body.amountMinor > max) {
    throw Object.assign(err(409, 'WALLET_LIMIT_REACHED', `A lab wallet holds at most ₹${(max / 100).toLocaleString('en-IN')}`),
      { details: { maxBalanceMinor: max, balanceMinor, pendingMinor, allowedMinor: Math.max(0, max - balanceMinor - pendingMinor) } });
  }
  razorpayKeyId();
  try {
    const out = await payments().createOrder({ userId: m.memberId, payerUserId: m.memberId, payerPartnerId: partnerId, payerMemberId: m.memberId,
      requestKey, requestHash, context: 'wallet_recharge', contextId: `lab_${partnerId}_${Date.now()}`,
      baseAmount: body.amountMinor / 100, finalAmount: body.amountMinor / 100, notes: { flow: labTopups.flow, partnerId } });
    return orderView(out.paymentRecord, false);
  } catch (e) {
    // A twin with the same key saved its record first: that order is the answer (this one is never shown or paid).
    if (isDuplicateKeyError(e)) {
      const raced = await replay();
      if (raced) return raced;
    }
    throw e;
  }
}

/** The lab's own top-up record, or the one 404 (another lab's, a pharmacy's, a customer's, a booking's). */
async function ownTopup(partnerId: string, paymentTransactionId: string): Promise<void> {
  const r = /^[0-9a-fA-F]{24}$/.test(String(paymentTransactionId ?? ''))
    ? await PaymentRecordModel.findById(paymentTransactionId).lean() as Record<string, unknown> | null : null;
  if (!r || !labTopups.isTopup(r) || labTopups.ownerOf(r) !== lower(partnerId)) throw recordNotFound();
}

const requester = (m: LabMember) => ({ userId: m.memberId, requesterUserType: 'partner', requesterPartnerId: lower(m.partnerId) });

/** POST …/topups/:id/check — any active member with wallet.view, operational or not (§19.8 item b): its own money. */
export async function checkLabTopup(m: LabMember, paymentTransactionId: string) {
  const out = await checkTopup(labTopups, m.partnerId, paymentTransactionId, (r) => payments().reconcilePaymentAndProcess({ ...r, ...requester(m), userId: r.userId }));
  return { state: out.state, wallet: labWalletView(out.wallet) };
}

/** POST …/payments/verify — after Checkout (members with wallet.manage). */
export async function verifyLabPayment(m: LabMember, body: Omit<VerifyPaymentRequest, 'userId'>) {
  await ownTopup(m.partnerId, body.paymentTransactionId);
  const out = await payments().verifyPaymentAndProcess({ ...body, ...requester(m) } as VerifyPaymentRequest);
  return { context: out.context, paymentRecord: recordView(out.paymentRecord), entity: labWalletView(out.entity as IPartnerWallet) };
}

/** POST …/payments/reconcile — a lost answer or a closed Checkout: Razorpay's own record of the order decides. */
export async function reconcileLabPayment(m: LabMember, paymentTransactionId: string) {
  await ownTopup(m.partnerId, paymentTransactionId);
  const out = await payments().reconcilePaymentAndProcess({ paymentTransactionId, ...requester(m) });
  if (out.state !== 'paid') return out;
  return { state: out.state, context: out.context, paymentRecord: recordView(out.paymentRecord), entity: labWalletView(out.entity as IPartnerWallet) };
}

// ── Admin ──
export async function adminWallet(partnerId: string) {
  await labOrNotFound(partnerId);
  return adminWalletView(await labStore(partnerId).findIn(null));
}
export async function adminEntries(partnerId: string, q: { cursor?: string; limit?: number }) {
  await labOrNotFound(partnerId);
  return entriesOf(partnerId, q, true);
}
export async function adminLots(partnerId: string) {
  await labOrNotFound(partnerId);
  return lotsOf({ kind: 'lab', id: partnerId });
}

/**
 * POST /admin/labs/:partnerId/wallet/topup (admin tools switch; L20): the shared admin top-up — one credit per
 * Idempotency-Key with the content hash, never withdrawable, posts whatever the wallet state — audited
 * `wallet.admin_topup` in the credit's transaction.
 */
export async function adminLabTopup(adminId: string, partnerId: string, key: string, body: { amountMinor: number; notes?: string }) {
  assertAdminToolsOn();
  await labOrNotFound(partnerId);
  await assertPartnerWalletIndexes();
  const store = labStore(partnerId);
  await store.ensure();
  const wallet = await adminTopup(store, { key, amountMinor: body.amountMinor, notes: body.notes, adminId }, (posted, s) =>
    auditIn({ actorKind: 'admin', actorId: lower(adminId), orgKind: 'lab', orgId: lower(partnerId), action: 'wallet.admin_topup', requestKey: key,
      detail: { amountMinor: body.amountMinor, entryId: String(posted.entry._id) } }, s));
  return adminWalletView(wallet);
}

/** GET /admin/labs/:partnerId/wallet/topups/by-key/:key — did the admin top-up with this key credit this lab? */
export async function adminLabTopupByKey(partnerId: string, key: string) {
  await labOrNotFound(partnerId);
  const store = labStore(partnerId);
  const row = await store.adminTopupByKey(key);
  if (!row) return { state: 'not_found' as const };
  return { state: 'credited' as const, entry: adminEntryView(row), wallet: adminWalletView(await store.findIn(null)) };
}

/** PUT /admin/labs/:partnerId/wallet/freeze { frozen, reason } — audited; a frozen wallet refuses spending, credits still post. */
export async function adminLabFreeze(adminId: string, partnerId: string, frozen: boolean, reason: string) {
  assertAdminToolsOn();
  await labOrNotFound(partnerId);
  const store = labStore(partnerId);
  await store.ensure();
  const wallet = await walletTransaction(async (s) => {
    const updated = await setFrozenIn(store, frozen, reason, s);
    await auditIn({ actorKind: 'admin', actorId: lower(adminId), orgKind: 'lab', orgId: lower(partnerId), action: frozen ? 'wallet.frozen' : 'wallet.unfrozen',
      detail: { reason } }, s);
    return updated;
  });
  return adminWalletView(wallet);
}
