import { recordPaiseOf, type TopupKind } from '@/modules/pharmacyWallet/walletCore';
import { WalletTopupLotModel, type IWalletTopupLot } from '@/modules/pharmacyWallet/model/lots';
import PaymentRecordModel from '@/modules/payment/model';
import { pharmacyTopups } from '@/modules/pharmacyWallet/ledger';
import { doctorTopups, labTopups } from '@/modules/partnerWallets/ledger';

/**
 * r13: every kind of card top-up a wallet store takes. The payment service routes a captured `wallet_recharge` record
 * by it (none = the customer wallet), and the admin chargeback / close tools accept any of them. r20: doctors.
 */
export const TOPUP_KINDS: TopupKind[] = [pharmacyTopups, labTopups, doctorTopups];

export const topupKindOf = (r: object | null | undefined): TopupKind | null =>
  TOPUP_KINDS.find((k) => k.isTopup(r as Record<string, unknown> | null)) ?? null;

/** The kind whose lots carry this `walletRef.kind`. */
export const topupKindOfWallet = (walletKind: string): TopupKind | null => TOPUP_KINDS.find((k) => k.kind === walletKind) ?? null;

/** The flows of the partner-store kinds (lab, doctor): every such top-up joins the recovery sweep (none predates it). */
export const PARTNER_TOPUP_FLOWS = TOPUP_KINDS.filter((k) => k.kind !== 'pharmacy').map((k) => k.flow);

/**
 * r20 (DR5): a record that carries a partner-store flow but names no owner is never credited elsewhere (never the
 * customer wallet of its `userId`): the credit refuses it. Pharmacy records keep their old routing.
 */
export const isOwnerlessPartnerTopup = (r: { context?: unknown; notes?: unknown } | null | undefined): boolean =>
  !!r && r.context === 'wallet_recharge' && !topupKindOf(r) && PARTNER_TOPUP_FLOWS.includes(String((r.notes as { flow?: unknown } | undefined)?.flow));

/**
 * r35 (§26.10): the admin's disputes list — every card top-up with a recorded dispute, newest first (at most 200): flagged
 * (nothing taken yet; Recover is the admin's), recovered (taken: the lot closed, the shortfall owed), or blocked (never
 * credited). `?state` filters; `?walletKind` narrows to one store. Ids and amounts only.
 */
export async function topupDisputes(q: { state?: 'flagged' | 'recovered' | 'blocked'; walletKind?: 'pharmacy' | 'lab' | 'doctor'; limit?: number } = {}) {
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
  const lots = await WalletTopupLotModel.find({ disputeState: { $ne: 'none' }, ...(q.walletKind ? { 'walletRef.kind': q.walletKind } : {}) })
    .sort({ updatedAt: -1 }).limit(500).lean() as (IWalletTopupLot & { _id: unknown; updatedAt?: Date })[];
  const records = await PaymentRecordModel.find({ context: 'wallet_recharge', chargebackAt: { $exists: true } }).sort({ chargebackAt: -1 }).limit(500)
    .lean() as Record<string, any>[];
  const lotOf = new Map(lots.map((l) => [l.paymentRecordId, l]));
  const recordOf = new Map(records.map((r) => [String(r._id), r]));
  const ids = [...new Set([...lots.map((l) => l.paymentRecordId), ...records.map((r) => String(r._id))])];
  const missing = ids.filter((id) => !recordOf.has(id));
  for (const r of missing.length ? await PaymentRecordModel.find({ _id: { $in: missing } }).lean() as Record<string, any>[] : []) recordOf.set(String(r._id), r);
  const rows = (await Promise.all(ids.map(async (id) => {
    const r = recordOf.get(id);
    const lot = lotOf.get(id);
    const kind = r ? topupKindOf(r) : null;
    const walletKind = lot?.walletRef.kind ?? kind?.kind ?? null;
    // r35b: an old top-up credited without a lot and without `walletCreditedAt` is found by the wallet's own credit row.
    const credited = !!lot || !!r?.walletCreditedAt || !!r?.compensatedAt || (!!r && !!kind && !!(await kind.storeFor(r).rechargeCreditIn(id, null)));
    const state = !credited ? 'blocked' as const : lot?.closed === true && lot.disputeState === 'lost' ? 'recovered' as const : 'flagged' as const;
    return { paymentRecordId: id, walletKind, ownerId: lot?.walletRef.id ?? (r && kind ? kind.ownerOf(r) : null), lotId: lot ? String(lot._id) : null,
      amountMinor: lot ? Number(lot.amountMinor) : r ? recordPaiseOf(r) : null,
      remainingMinor: lot ? Number(lot.remainingMinor) : null, state, chargebackAt: r?.chargebackAt ?? null, recoveredAt: lot?.chargedBackAt ?? null,
      at: r?.chargebackAt ?? lot?.chargedBackAt ?? lot?.updatedAt ?? null };
  }))).filter((x) => (!q.state || x.state === q.state) && (!q.walletKind || x.walletKind === q.walletKind));
  return rows.sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime()).slice(0, limit);
}

/**
 * r35 (WQ29): an owner's card top-ups credited WITHOUT a lot (before phase 1a, with the lot switch off or before
 * sync-indexes): never withdrawable, and found by nothing else, so a lost dispute on one is recorded and recovered by its
 * payment id. Newest first, at most 200. Ids, amounts and times only. r35b (WQ48): one recovered since (its take opened a
 * closed lot, `openedAtChargeback`) stays listed with `recoveredAt` (null: not recovered).
 */
export async function topupsWithoutLot(walletKind: 'pharmacy' | 'lab' | 'doctor', ownerIdIn: string) {
  const kind = topupKindOfWallet(walletKind)!;
  const raw = String(ownerIdIn);
  const records = await PaymentRecordModel.find({ [kind.payerField]: { $in: [...new Set([raw, raw.toLowerCase()])] }, context: 'wallet_recharge',
    'notes.flow': kind.flow, status: { $in: ['paid', 'refunded'] } }).sort({ createdAt: -1 }).limit(500).lean() as Record<string, any>[];
  const lotOf = new Map((await WalletTopupLotModel.find({ paymentRecordId: { $in: records.map((r) => String(r._id)) } })
    .select({ paymentRecordId: 1, openedAtChargeback: 1, chargedBackAt: 1 }).lean()).map((l) => [l.paymentRecordId, l]));
  const rows: Record<string, unknown>[] = [];
  for (const r of records) {
    const lot = lotOf.get(String(r._id));
    if (lot && lot.openedAtChargeback !== true) continue;
    const credit = r.walletCreditedAt ? null : await kind.storeFor(r).rechargeCreditIn(String(r._id), null);
    if (!r.walletCreditedAt && !credit) continue;
    rows.push({ paymentRecordId: String(r._id), walletKind, ownerId: kind.ownerOf(r), razorpayPaymentId: r.razorpayPaymentId ?? null,
      amountMinor: credit?.amountMinor ?? recordPaiseOf(r),
      paidAt: r.paidAt ?? null, creditedAt: r.walletCreditedAt ?? null, chargebackAt: r.chargebackAt ?? null, recoveredAt: lot?.chargedBackAt ?? null });
    if (rows.length >= 200) break;
  }
  return rows;
}
