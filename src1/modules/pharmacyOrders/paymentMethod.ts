/**
 * r37 (§26.20): how a payment was made, in the Today register's words — the ONE place that turns a stored payment into a
 * method. r37b: an order's `paymentSource` (what the pay step sent, or free text typed when it was marked paid) `cash`,
 * `upi` or `card` as it is; `counter_cash` and `cash_on_delivery` are cash; an online-paid order is `online`; anything
 * else (an in-store order with no source included) is `other`. A booking's funding (`fundingMethodOf`) is card or wallet.
 */
export type PaymentMethod = 'cash' | 'upi' | 'card' | 'bank' | 'wallet' | 'online' | 'other';
/** The pharmacy register's methods (r37). */
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['cash', 'upi', 'card', 'wallet', 'online', 'other'];
/** r38: the lab register's methods — a lab bill can also be paid by bank transfer. */
export const LAB_PAYMENT_METHODS: readonly PaymentMethod[] = ['cash', 'upi', 'card', 'bank', 'wallet', 'online', 'other'];
/** r38: a lab bill payment's method (its recorded mode: cash, upi, card, bank; anything else other). */
export const billModeMethodOf = (mode: unknown): PaymentMethod => (mode === 'cash' || mode === 'upi' || mode === 'card' || mode === 'bank' ? mode : 'other');

const SOURCES: Record<string, PaymentMethod> = { cash: 'cash', counter_cash: 'cash', cash_on_delivery: 'cash', upi: 'upi', card: 'card', online_payment: 'online' };

export function paymentMethodOf(paymentSource?: unknown, paymentMode?: unknown): PaymentMethod {
  const s = typeof paymentSource === 'string' ? paymentSource.trim().toLowerCase() : '';
  if (s) return SOURCES[s] ?? 'other';
  return paymentMode === 'online_payment' ? 'online' : 'other';
}

/**
 * A consultation's or lab booking's method from its stored funding: a card booking (`razorpay`) card, a wallet one
 * wallet; a partner's instant consultation (its funding a pointer to the request) is paid from the partner's wallet (r17);
 * a legacy booking without funding is `other`.
 */
export function fundingMethodOf(funding: unknown): PaymentMethod {
  const f = funding as { method?: unknown; instantRequestId?: unknown } | null | undefined;
  if (f && typeof f.instantRequestId === 'string') return 'wallet';
  return f?.method === 'razorpay' ? 'card' : f?.method === 'wallet' ? 'wallet' : 'other';
}
