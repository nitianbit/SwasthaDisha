/**
 * r37 (§26.20): how a payment was made, in the Today register's words. The ONE reader of a pharmacy order's
 * `paymentSource` (free text typed when it was marked paid) and `paymentMode`: `cash` and `upi` are recognised, an
 * online-paid order is `online`, anything else is `other`.
 */
export type PaymentMethod = 'cash' | 'upi' | 'card' | 'wallet' | 'online' | 'other';
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['cash', 'upi', 'card', 'wallet', 'online', 'other'];

export function paymentMethodOf(paymentSource?: unknown, paymentMode?: unknown): PaymentMethod {
  const s = typeof paymentSource === 'string' ? paymentSource.trim().toLowerCase() : '';
  if (s === 'cash') return 'cash';
  if (s === 'upi') return 'upi';
  if (s === 'online_payment' || (!s && paymentMode === 'online_payment')) return 'online';
  return 'other';
}
