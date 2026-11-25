import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { assistedFlags } from '@/modules/assisted/flags';
import { auditIn } from '@/modules/assisted/support';
import { assertBookerWalletIndexes } from '@/modules/assisted/bookerWallet';
import type { BookerKind } from '@/modules/assisted/types';
import { setOffReceivableIn, walletTransaction, type WalletStore } from '@/modules/pharmacyWallet/walletCore';
import { pharmacyStore } from '@/modules/pharmacyWallet/ledger';
import { partnerStore } from '@/modules/partnerWallets/ledger';
import { LedgerEntryModel, type ILedgerEntry, type ReferralOwnerKind } from '@/modules/partners/model/settlement';
import { financeSummary, findOwnerAccount, postReferralSetoffIn } from '@/modules/partners/services/finance';
import { abandonRequestKey, claimRequestKey } from '@/modules/requestKeys';
import { RequestKeyModel } from '@/modules/requestKeys/model';

/**
 * Round 4e (ASSISTED_BOOKING_DESIGN.md §26.9) and the referral block of 4f (§26.10): a booker's referral account, read the
 * same way everywhere, and an owed wallet amount (a lost card dispute's receivable) paid from the referral earnings —
 * behind REFERRAL_PAYOUTS_ENABLED (M8: it is a payment of the referral), off.
 */
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const lower = (v: unknown) => String(v ?? '').toLowerCase();
export const REFERRAL_ACCOUNT: Record<BookerKind, ReferralOwnerKind> = { pharmacy: 'pharmacy_referral', lab: 'lab_referral', doctor: 'doctor_referral' };

/**
 * The referral block (r33's totals, one reader): what the cuts earned, what was paid out and what is due, and the switches.
 * r35b: `setOffMinor`, what paid owed wallet amounts (earned − paid − set off = due, other admin adjustments and voided
 * payouts aside: both are statement rows). An owner with no referral account answers zeros.
 */
export async function referralSummary(kind: BookerKind, id: string) {
  const account = await findOwnerAccount(REFERRAL_ACCOUNT[kind], lower(id));
  const [f, setOff] = await Promise.all([financeSummary(account, false), account
    ? LedgerEntryModel.aggregate([{ $match: { settlementAccountId: String(account._id), source: 'receivable_setoff' } }, { $group: { _id: null, total: { $sum: '$amountMinor' } } }])
    : []]);
  return { earnedMinor: f.totals.earnedMinor, paidMinor: f.totals.paidOutMinor, setOffMinor: -Number(setOff[0]?.total ?? 0), dueMinor: f.balanceMinor,
    cutsEnabled: assistedFlags.referralCuts(), payoutsEnabled: assistedFlags.referralPayouts() };
}

/**
 * r35b (WQ48): the admin wallet reads' referral line — what the owner's referral earnings could pay now (a set-off's
 * maximum, with the wallet's receivable) and whether set-offs are on (REFERRAL_PAYOUTS_ENABLED).
 */
export async function referralDueOf(kind: BookerKind, id: string) {
  const r = await referralSummary(kind, id);
  return { dueMinor: r.dueMinor, payoutsEnabled: r.payoutsEnabled };
}

const storeOf = (kind: BookerKind, id: string): WalletStore => (kind === 'pharmacy' ? pharmacyStore(id) : partnerStore(kind, id));
const keyScope = (kind: BookerKind, id: string) => `referral_setoff:${kind}:${lower(id)}`;
const viewOf = (e: ILedgerEntry, walletEntryId: string | null, replayed: boolean, wallet: { receivableMinor: number; frozen: boolean } | null) => ({
  setoff: { amountMinor: -e.amountMinor, referralAccountId: e.settlementAccountId, ledgerEntryId: String(e._id), walletEntryId, at: e.at },
  wallet, replayed });

/**
 * POST /api/v1/admin/wallets/:kind/:id/receivable/setoff-from-referral { amountMinor, requestKey } — the owner's referral
 * earnings pay what its wallet owes. One transaction, exactly once per key: the referral account's `adjustment` −amount
 * (`source: 'receivable_setoff'`, `sourceId: <key>`) and the wallet's `receivable_setoff` of the same amount. At most the
 * smaller of the receivable and the referral balance (409 SETOFF_ABOVE_AVAILABLE). The same key with the same amount
 * answers it again (`replayed`); another amount 409 IDEMPOTENCY_KEY_REUSED; an abandoned key 409 REQUEST_ABANDONED.
 */
export async function setOffFromReferral(adminId: string, kind: BookerKind, ownerIdIn: string, body: { amountMinor: number; requestKey: string }) {
  if (!assistedFlags.referralPayouts()) throw err(409, 'REFERRAL_PAYOUTS_DISABLED', 'Referral payouts are paused until the tax question is answered');
  const ownerId = lower(ownerIdIn);
  if (!Types.ObjectId.isValid(ownerId)) throw err(404, 'WALLET_NOT_FOUND', 'Wallet not found');
  const amount = Number(body.amountMinor);
  if (!Number.isSafeInteger(amount) || amount < 1) throw err(400, 'VALIDATION_ERROR', 'amountMinor must be a positive number of paise');
  await assertUniqueIndex(LedgerEntryModel, { settlementAccountId: 1, source: 1, sourceId: 1, kind: 1 });
  await assertUniqueIndex(RequestKeyModel, { scope: 1, key: 1 });
  await assertBookerWalletIndexes(kind);
  const store = storeOf(kind, ownerId);
  const account = await findOwnerAccount(REFERRAL_ACCOUNT[kind], ownerId);
  if (!account || !(await store.findIn(null))) throw err(404, 'WALLET_NOT_FOUND', 'Wallet not found');
  const accountId = String(account._id);
  const walletOf = (w: unknown) => (w ? { receivableMinor: store.state(w).receivableMinor, frozen: store.state(w).frozen } : null);
  const replay = async (s: Parameters<typeof store.findIn>[0]) => {
    const e = await LedgerEntryModel.findOne({ settlementAccountId: accountId, source: 'receivable_setoff', sourceId: body.requestKey, kind: 'adjustment' })
      .session(s).lean() as ILedgerEntry | null;
    if (!e) return null;
    if (-e.amountMinor !== amount) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different set-off');
    const we = await store.entryIn(`referral_setoff:${accountId}:${body.requestKey}`, s) as { _id?: unknown } | null;
    return viewOf(e, we ? String(we._id) : null, true, walletOf(await store.findIn(s)));
  };
  const prior = await replay(null);
  if (prior) return prior;
  try {
    return await walletTransaction(async (s) => {
      const again = await replay(s);
      if (again) return again;
      await claimRequestKey(keyScope(kind, ownerId), body.requestKey, s);
      const posted = await setOffReceivableIn(store, { amountMinor: amount, operationKey: `referral_setoff:${accountId}:${body.requestKey}`,
        referenceType: 'referral_setoff', referenceId: `${accountId}:${body.requestKey}`, actor: { kind: 'admin', id: lower(adminId) },
        description: `Owed amount of ₹${(amount / 100).toFixed(2)} paid from your referral earnings` }, s);
      const { entry } = await postReferralSetoffIn(lower(adminId), accountId, amount, body.requestKey, s);
      await auditIn({ actorKind: 'admin', actorId: lower(adminId), orgKind: kind, orgId: ownerId, action: 'wallet.referral_setoff', requestKey: body.requestKey,
        detail: { amountMinor: amount, referralAccountId: accountId, ledgerEntryId: String(entry._id) } }, s);
      return viewOf(entry, String((posted.entry as { _id?: unknown })._id), false, walletOf(posted.wallet));
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const raced = await replay(null);
      if (raced) return raced;
    }
    throw e;
  }
}

/** GET …/setoff-from-referral/by-key/:key and POST …/by-key/:key/abandon (Q13 shape). */
export async function setOffByKey(kind: BookerKind, ownerIdIn: string, key: string) {
  const ownerId = lower(ownerIdIn);
  const account = Types.ObjectId.isValid(ownerId) ? await findOwnerAccount(REFERRAL_ACCOUNT[kind], ownerId) : null;
  const e = account ? await LedgerEntryModel.findOne({ settlementAccountId: String(account._id), source: 'receivable_setoff', sourceId: { $eq: key },
    kind: 'adjustment' }).lean() as ILedgerEntry | null : null;
  if (e) return { state: 'used' as const, setoff: viewOf(e, null, true, null).setoff };
  const k = await RequestKeyModel.findOne({ scope: keyScope(kind, ownerId), key }).lean();
  return { state: k?.state === 'abandoned' ? 'abandoned' as const : 'unknown' as const };
}
export async function abandonSetOffKey(kind: BookerKind, ownerIdIn: string, key: string) {
  const out = await setOffByKey(kind, ownerIdIn, key);
  if (out.state === 'used') return out;
  const state = await abandonRequestKey(keyScope(kind, ownerIdIn), key);
  return state === 'abandoned' ? { state } : setOffByKey(kind, ownerIdIn, key);
}
