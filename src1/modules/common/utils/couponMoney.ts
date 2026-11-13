import { AppError } from '@/modules/common/types';

/**
 * Exact INR -> paise for a stored or requested amount: non-negative, at most two decimals, safe integer
 * (milestone `bookingMoneyPaise`). Anything else is refused rather than rounded.
 */
export function inrToPaise(value: unknown, code: string): number {
  const refuse = (message: string): never => { throw new AppError({ status: 409, code, message }); };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) refuse('Invalid INR amount');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) refuse('INR amounts must have at most two decimal places');
  const paise = Number(match![1]) * 100 + Number((match![2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(paise)) refuse('INR amount exceeds the supported range');
  return paise;
}

/**
 * Coupon discounts are server calculations (percentages can produce fractions of a paisa). Round the new discount
 * once to paise, bound it to [0, base], and derive the final amount from the same paise values (milestone C6), so
 * base - discount == final exactly. A malformed calculation is refused with `code`.
 */
export function normalizeCouponDiscount(baseAmount: number, rawDiscount: unknown, code: string): { discountAmount: number; finalAmount: number } {
  const basePaise = inrToPaise(baseAmount, code);
  const discount = rawDiscount ?? 0;
  const discountPaise = typeof discount === 'number' && Number.isFinite(discount) && discount >= 0 ? Math.round(discount * 100) : NaN;
  if (!Number.isSafeInteger(discountPaise) || discountPaise < 0 || discountPaise > basePaise) {
    throw new AppError({ status: 409, code, message: 'Calculated coupon amount is invalid' });
  }
  return { discountAmount: discountPaise / 100, finalAmount: (basePaise - discountPaise) / 100 };
}
