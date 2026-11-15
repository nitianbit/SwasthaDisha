import { CONFIG } from '@/config/config';

/**
 * Q3 §7a: every booking is settled by exactly one system. Bookings created at or after SETTLEMENT_CUTOVER_AT go to the
 * ledger; everything else (and everything while the date is unset or invalid) stays with the legacy monthly payouts.
 * Legacy payout queries select `settlementSystem != 'ledger'`; ledger earnings require `settlementSystem == 'ledger'`.
 */
export function settlementCutoverAt(): Date | null {
  const raw = CONFIG.SETTLEMENT_CUTOVER_AT;
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function settlementSystemFor(createdAt: Date): 'legacy' | 'ledger' {
  const at = settlementCutoverAt();
  return at && createdAt.getTime() >= at.getTime() ? 'ledger' : 'legacy';
}
