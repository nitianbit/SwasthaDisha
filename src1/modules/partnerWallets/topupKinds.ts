import type { TopupKind } from '@/modules/pharmacyWallet/walletCore';
import { pharmacyTopups } from '@/modules/pharmacyWallet/ledger';
import { labTopups } from '@/modules/partnerWallets/ledger';

/**
 * r13: every kind of card top-up a wallet store takes. The payment service routes a captured `wallet_recharge` record
 * by it (none = the customer wallet), and the admin chargeback / close tools accept any of them.
 */
export const TOPUP_KINDS: TopupKind[] = [pharmacyTopups, labTopups];

export const topupKindOf = (r: object | null | undefined): TopupKind | null =>
  TOPUP_KINDS.find((k) => k.isTopup(r as Record<string, unknown> | null)) ?? null;

/** The kind whose lots carry this `walletRef.kind`. */
export const topupKindOfWallet = (walletKind: string): TopupKind | null => TOPUP_KINDS.find((k) => k.kind === walletKind) ?? null;
