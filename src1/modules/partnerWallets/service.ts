import { Container } from 'typedi';
import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { assertAdminToolsOn } from '@/modules/assisted/flags';
import { auditIn } from '@/modules/assisted/support';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentService } from '@/modules/payment/services';
import type { IPaymentRecord, VerifyPaymentRequest } from '@/modules/payment/types';
import { adminTopup, assertTopupWithinCap, checkTopup, setFrozenIn, walletTransaction } from '@/modules/pharmacyWallet/walletCore';
import { lotsOf } from '@/modules/pharmacyWallet/walletLots';
import MemberModel from '@/modules/partners/model/member';
import PartnerOrgModel from '@/modules/partners/model';
import { hasGlobalScope, type PartnerActor } from '@/modules/partners/services';
import { labAdmissible } from '@/modules/assisted/labViews';
import type { PartnerPermission } from '@/modules/partners/types';
import { PartnerWalletEntryModel, type IPartnerWallet, type IPartnerWalletEntry } from '@/modules/partnerWallets/model';
import { assertPartnerWalletIndexes, partnerStore, type PartnerOwner } from '@/modules/partnerWallets/ledger';
import { doctorIsEligible } from '@/modules/specialists/eligibility';
import { referralDueOf } from '@/modules/referralCuts/payouts';

/**
 * r13 (round 2d, §24.7.3) and r20 (round 3a, §25.4.2): the partner wallets' reads and commands — the lab workspace
 * (members), the doctor app (the doctor) and the admin tools — for any owner (`LAB`, `DOCTOR`). Money moves only through
 * the shared wallet rules (`walletCore.ts`); answers are integer paise.
 */
export interface LabMember { partnerId: string; memberId: string }

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const payments = (): PaymentService => Container.get(PaymentService);
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const recordNotFound = () => err(404, 'PAYMENT_RECORD_NOT_FOUND', 'Payment record not found');

// ── Views ──
export function walletView(w: IPartnerWallet | null | undefined) {
  return { balanceMinor: w?.balanceMinor ?? 0, withdrawableMinor: w?.withdrawableMinor ?? 0, receivableMinor: w?.receivableMinor ?? 0,
    frozen: w?.frozen === true, isActive: w ? w.isActive !== false : true, updatedAt: w?.updatedAt ?? null };
}
const adminWalletView = (w: IPartnerWallet | null) => ({ ...walletView(w), exists: !!w, frozenReason: w?.frozenReason ?? null,
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

// ── Reads (members with wallet.view, the doctor, admins) ──
export async function walletOf(owner: PartnerOwner, ownerId: string) {
  return walletView(await partnerStore(owner.kind, ownerId).findIn(null));
}

export async function entriesOf(owner: PartnerOwner, ownerId: string, q: { cursor?: string; limit?: number }, admin = false) {
  const limit = Math.min(50, Math.max(1, Number(q.limit ?? 20)));
  const rows = await PartnerWalletEntryModel.find({ ownerKind: owner.kind, ownerId: lower(ownerId), ...after('at', q.cursor) })
    .sort({ at: -1, _id: -1 }).limit(limit + 1).lean() as IPartnerWalletEntry[];
  const { items, nextCursor } = page(rows, limit, (e) => e.at);
  return { items: items.map(admin ? adminEntryView : entryView), nextCursor };
}

/** The owner's card top-ups, newest first (a lost answer: find it and press "Check"). */
export async function topupsOf(owner: PartnerOwner, ownerId: string, q: { cursor?: string; limit?: number }) {
  const limit = Math.min(50, Math.max(1, Number(q.limit ?? 20)));
  const rows = await PaymentRecordModel.find({ [owner.topups.payerField]: lower(ownerId), context: 'wallet_recharge', 'notes.flow': owner.topups.flow,
    ...after('createdAt', q.cursor) }).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean() as unknown as IPaymentRecord[];
  const { items, nextCursor } = page(rows, limit, (r) => r.createdAt);
  return { items: items.map(topupView), nextCursor };
}

// ── Top-up by card (lab members with wallet.manage of an operational lab; an eligible doctor; the owner's switch on) ──
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
 * POST …/wallet/topups { amountMinor, requestKey } — one Razorpay order per request key (scope: the owner's
 * `topupOrder`, e.g. `wallet_topup:lab:<partnerId>:<memberId>` or `wallet_topup:doctor:<specialistId>`; content hash of
 * the amount): the same key and amount answers the same order (`replayed`), another amount 409 IDEMPOTENCY_KEY_REUSED.
 * O2: the balance, the owner's unpaid top-ups of the last 30 minutes and this one may not pass ₹50,000 (409
 * WALLET_LIMIT_REACHED); a paid top-up is always credited.
 */
export async function createTopup(owner: PartnerOwner, ownerIdIn: string, actorId: string, body: { amountMinor: number; requestKey: string }) {
  owner.assertOn();
  await assertPartnerWalletIndexes();
  await assertUniqueIndex(PaymentRecordModel, { requestKey: 1 });
  const ownerId = lower(ownerIdIn);
  const order = owner.topupOrder(ownerId, actorId);
  const requestKey = `${order.scope}:${body.requestKey}`;
  const requestHash = requestHashOf({ kind: `${owner.kind}_wallet_topup`, amountMinor: body.amountMinor });
  const replay = async () => {
    const r = await PaymentRecordModel.findOne({ requestKey: { $eq: requestKey } }).lean() as unknown as IPaymentRecord | null;
    if (!r) return null;
    if (r.requestHash !== requestHash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different top-up');
    return orderView(r, true);
  };
  const prior = await replay();
  if (prior) return prior;
  // O2: the one cap check of every top-up kind (r32: shared with the pharmacy's top-up).
  await assertTopupWithinCap(owner.topups, ownerId, body.amountMinor);
  razorpayKeyId();
  try {
    const out = await payments().createOrder({ ...order.fields, requestKey, requestHash, context: 'wallet_recharge',
      baseAmount: body.amountMinor / 100, finalAmount: body.amountMinor / 100 } as Parameters<PaymentService['createOrder']>[0]);
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

/**
 * 2e: a payment this lab may settle on the two routes — its own top-up (`wallet.manage`), or the card payment of a
 * consultation it booked (`assisted_booking`, paid by this lab: `payerPartnerId`; the member needs `assisted.book`).
 * Anything else, or the member lacking that permission: the one 404 / 403.
 */
type MemberScope = Pick<PartnerActor, 'role' | 'branchIds'>;
type Payment = { kind: 'topup' | 'booking'; member: MemberScope };
async function ownPayment(owner: PartnerOwner, m: LabMember, paymentTransactionId: string): Promise<Payment> {
  const r = /^[0-9a-fA-F]{24}$/.test(String(paymentTransactionId ?? ''))
    ? await PaymentRecordModel.findById(paymentTransactionId).lean() as Record<string, unknown> | null : null;
  if (r && owner.topups.isTopup(r) && owner.topups.ownerOf(r) === lower(m.partnerId)) return { kind: 'topup', member: await memberMay(m, 'wallet.manage') };
  if (r?.context === 'assisted_booking' && lower(r.payerPartnerId) === lower(m.partnerId)) return { kind: 'booking', member: await memberMay(m, 'assisted.book') };
  throw recordNotFound();
}
async function memberMay(m: LabMember, perm: PartnerPermission): Promise<MemberScope> {
  const member = await MemberModel.findById(m.memberId).select({ role: 1, permissions: 1, branchIds: 1 }).lean() as
    { role?: string; permissions?: string[]; branchIds?: unknown[] } | null;
  if (member?.role !== 'owner' && !(member?.permissions ?? []).includes(perm)) throw err(403, 'INSUFFICIENT_PERMISSIONS', `Missing permissions: ${perm}`);
  return { role: String(member?.role ?? '') as PartnerActor['role'], branchIds: (member?.branchIds ?? []).map(lower) };
}
/**
 * The entity of a settled payment, as this lab sees it: its wallet, or (2e) its booker view of the consultation. r21b:
 * as the booking detail route — a member scoped to other branches gets the payment's state only (never the booking),
 * and the prescription shows only while the lab is active and verified (`clinical`, as an operational pharmacy).
 */
async function entityView(p: Payment, m: LabMember, entity: unknown) {
  if (p.kind === 'topup') return walletView(entity as IPartnerWallet);
  const b = entity as Record<string, any> | null;
  if (!b?._id) return b;
  if (!hasGlobalScope(p.member) && !p.member.branchIds.includes(lower(b.assisted?.bookedBy?.branchId))) {
    return { _id: String(b._id), status: b.status, paymentStatus: b.paymentStatus };
  }
  const { bookerView } = await import('@/modules/assisted/bookerView');
  const lab = await PartnerOrgModel.findById(m.partnerId).select({ kind: 1, isActive: 1, verification: 1 }).lean();
  return bookerView(b, { kind: 'lab', id: lower(m.partnerId) }, { copies: 'queue', clinical: labAdmissible(lab) });
}

const memberRequester = (m: LabMember) => ({ userId: m.memberId, requesterUserType: 'partner', requesterPartnerId: lower(m.partnerId) });

/** POST …/topups/:id/check (lab) — any active member with wallet.view, operational or not (§19.8 item b): its own money. */
export async function checkLabTopup(owner: PartnerOwner, m: LabMember, paymentTransactionId: string) {
  const out = await checkTopup(owner.topups, m.partnerId, paymentTransactionId,
    (r) => payments().reconcilePaymentAndProcess({ ...r, ...memberRequester(m), userId: r.userId }));
  return { state: out.state, wallet: walletView(out.wallet) };
}

/**
 * POST /specialists/me/assisted/wallet/topups/:id/check — the doctor's own top-up, whether or not it is eligible (DR3: a
 * paid top-up is always credited); the wallet only for an eligible doctor.
 */
export async function checkDoctorTopup(owner: PartnerOwner, specialistId: string, paymentTransactionId: string) {
  const out = await checkTopup(owner.topups, specialistId, paymentTransactionId,
    (r) => payments().reconcilePaymentAndProcess({ ...r, userId: lower(specialistId), requesterUserType: 'specialist' }));
  return { state: out.state, ...(await doctorIsEligible(specialistId) ? { wallet: walletView(out.wallet) } : {}) };
}

/**
 * The `entity` of a `/payments/verify` or `/reconcile` answer for a doctor top-up (§25.4.2): the wallet view, or only
 * the state for a doctor no longer eligible.
 */
export async function doctorTopupEntity(owner: PartnerOwner, record: IPaymentRecord) {
  const ownerId = owner.topups.ownerOf(record as unknown as Record<string, unknown>);
  if (!(await doctorIsEligible(ownerId))) return { state: record.walletCreditedAt ? 'credited' : 'unpaid' };
  return walletView(await partnerStore(owner.kind, ownerId).findIn(null));
}

/** POST …/payments/verify (lab) — after Checkout: its top-up (wallet.manage) or (2e) its consultation's card payment (assisted.book). */
export async function verifyLabPayment(owner: PartnerOwner, m: LabMember, body: Omit<VerifyPaymentRequest, 'userId'>) {
  const own = await ownPayment(owner, m, body.paymentTransactionId);
  const out = await payments().verifyPaymentAndProcess({ ...body, ...memberRequester(m) } as VerifyPaymentRequest);
  return { context: out.context, paymentRecord: recordView(out.paymentRecord), entity: await entityView(own, m, out.entity) };
}

/** POST …/payments/reconcile (lab) — a lost answer or a closed Checkout: Razorpay's own record of the order decides. */
export async function reconcileLabPayment(owner: PartnerOwner, m: LabMember, paymentTransactionId: string) {
  const own = await ownPayment(owner, m, paymentTransactionId);
  const out = await payments().reconcilePaymentAndProcess({ paymentTransactionId, ...memberRequester(m) });
  if (out.state !== 'paid') return out;
  return { state: out.state, context: out.context, paymentRecord: recordView(out.paymentRecord), entity: await entityView(own, m, out.entity) };
}

// ── Admin (any owner; writes behind the admin tools switch) ──
export async function adminWallet(owner: PartnerOwner, ownerId: string) {
  await owner.assertExists(ownerId);
  // r35b (WQ48): the owner's referral line for the set-off (its maximum and switch).
  return { ...adminWalletView(await partnerStore(owner.kind, ownerId).findIn(null)), referral: await referralDueOf(owner.kind, ownerId) };
}
export async function adminEntries(owner: PartnerOwner, ownerId: string, q: { cursor?: string; limit?: number }) {
  await owner.assertExists(ownerId);
  return entriesOf(owner, ownerId, q, true);
}
export async function adminLots(owner: PartnerOwner, ownerId: string) {
  await owner.assertExists(ownerId);
  return lotsOf({ kind: owner.kind, id: ownerId });
}

/**
 * POST /admin/{labs|doctors}/:id/wallet/topup (admin tools switch; L20): the shared admin top-up — one credit per
 * Idempotency-Key with the content hash, never withdrawable, posts whatever the wallet state — audited
 * `wallet.admin_topup` in the credit's transaction.
 */
export async function adminWalletTopup(owner: PartnerOwner, adminId: string, ownerId: string, key: string, body: { amountMinor: number; notes?: string }) {
  assertAdminToolsOn();
  await owner.assertExists(ownerId);
  await assertPartnerWalletIndexes();
  const store = partnerStore(owner.kind, ownerId);
  await store.ensure();
  const wallet = await adminTopup(store, { key, amountMinor: body.amountMinor, notes: body.notes, adminId }, (posted, s) =>
    auditIn({ actorKind: 'admin', actorId: lower(adminId), orgKind: owner.kind, orgId: lower(ownerId), action: 'wallet.admin_topup', requestKey: key,
      detail: { amountMinor: body.amountMinor, entryId: String(posted.entry._id) } }, s));
  return adminWalletView(wallet);
}

/** GET /admin/{labs|doctors}/:id/wallet/topups/by-key/:key — did the admin top-up with this key credit this wallet? */
export async function adminWalletTopupByKey(owner: PartnerOwner, ownerId: string, key: string) {
  await owner.assertExists(ownerId);
  const store = partnerStore(owner.kind, ownerId);
  const row = await store.adminTopupByKey(key);
  if (!row) return { state: 'not_found' as const };
  return { state: 'credited' as const, entry: adminEntryView(row), wallet: adminWalletView(await store.findIn(null)) };
}

/** PUT /admin/{labs|doctors}/:id/wallet/freeze { frozen, reason } — audited; a frozen wallet refuses spending, credits still post. */
export async function adminWalletFreeze(owner: PartnerOwner, adminId: string, ownerId: string, frozen: boolean, reason: string) {
  assertAdminToolsOn();
  await owner.assertExists(ownerId);
  const store = partnerStore(owner.kind, ownerId);
  await store.ensure();
  const wallet = await walletTransaction(async (s) => {
    const updated = await setFrozenIn(store, frozen, reason, s);
    await auditIn({ actorKind: 'admin', actorId: lower(adminId), orgKind: owner.kind, orgId: lower(ownerId), action: frozen ? 'wallet.frozen' : 'wallet.unfrozen',
      detail: { reason } }, s);
    return updated;
  });
  return adminWalletView(wallet);
}
