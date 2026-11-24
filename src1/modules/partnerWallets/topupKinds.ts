import type { TopupKind } from '@/modules/pharmacyWallet/walletCore';
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
