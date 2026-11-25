import type { ClientSession } from 'mongoose';
import { CouponModel } from '@/modules/coupon/model';
import { couponFundedBy } from '@/modules/coupon/funding';
import { assistedFlags } from '@/modules/assisted/flags';
import { spreadByPrice } from '@/modules/assisted/patient';
import type { AssistedSplit } from '@/modules/assisted/types';

/**
 * Round 4c (§26.7, M13): `provider_coupon_v2` for every new SELF ledger booking — customer consultations, customer
 * instant and customer lab bookings — behind EARNING_RULE_V2_FOR_ALL (off). The booking is frozen with
 * `earningRule: 'provider_coupon_v2'` and a top-level `earningSplit` of the assisted split's shape (cut 0, no referral;
 * lines for labs). The earning readers take `assisted.split ?? earningSplit`.
 *
 * Only a PLATFORM-funded coupon changes anything: the provider earns the list price and Jansetu bears the discount. A
 * provider-funded coupon earns list − discount, as today (Q16a). With the switch off nothing is written (byte-identical).
 */
type SelfTerms = { listMinor: number; discountMinor: number; couponCode?: string | null;
  /** Lab bookings: the tests and packages in their stored order, with their list prices. */
  lines?: { catalogItemId: string; listMinor: number }[] };

/** The split of a self booking's terms (the coupon's funding read now). */
export async function selfSplitOf(t: SelfTerms, s?: ClientSession | null): Promise<AssistedSplit> {
  const listMinor = Math.max(0, Math.round(Number(t.listMinor) || 0));
  const discountMinor = Math.min(listMinor, Math.max(0, Math.round(Number(t.discountMinor) || 0)));
  const code = typeof t.couponCode === 'string' && t.couponCode.trim() ? t.couponCode.trim() : null;
  const coupon = code ? await CouponModel.findOne({ code: { $eq: code } }).select({ fundedBy: 1, corporateIds: 1 }).session(s ?? null).lean() : null;
  const fundedBy = code ? couponFundedBy((coupon ?? {}) as { fundedBy?: string; corporateIds?: unknown[] }) : undefined;
  const baseMinor = fundedBy === 'platform' ? listMinor : listMinor - discountMinor;
  const lineDiscounts = t.lines ? spreadByPrice(t.lines.map((l) => l.listMinor), discountMinor) : [];
  return {
    listMinor, ...(code ? { couponCode: code, couponFundedBy: fundedBy } : {}), discountMinor, baseMinor, cutMinor: 0, providerMinor: baseMinor,
    rule: 'provider_coupon_v2',
    ...(t.lines ? { lines: t.lines.map((l, n) => ({ catalogItemId: l.catalogItemId, listMinor: l.listMinor, discountMinor: lineDiscounts[n]!,
      baseMinor: fundedBy === 'platform' ? l.listMinor : l.listMinor - lineDiscounts[n]!, cutMinor: 0 })) } : {}),
  };
}

/** At create: the v2 rule and split while the switch is on; nothing at all while it is off. */
export async function selfEarningOf(t: SelfTerms, s?: ClientSession | null): Promise<{ earningRule?: 'provider_coupon_v2'; earningSplit?: AssistedSplit }> {
  if (!assistedFlags.earningRuleV2ForAll()) return {};
  return { earningRule: 'provider_coupon_v2', earningSplit: await selfSplitOf(t, s) };
}

/**
 * At payment (Q16a): the winning record's terms become the booking's price — a coupon taken at pay-again included — so a
 * v2 self booking's split is made again from them. Only for a booking frozen with the rule (whatever the switch says
 * now); assisted rows keep their own split.
 */
export async function selfSplitPatchFor(b: { earningRule?: string; assisted?: unknown },
  r: { baseAmount?: unknown; discountAmount?: unknown; couponCode?: string | null }): Promise<{ earningSplit?: AssistedSplit }> {
  if (b.earningRule !== 'provider_coupon_v2' || b.assisted) return {};
  const base = Number(r.baseAmount);
  if (!Number.isFinite(base) || base < 0) return {};
  return { earningSplit: await selfSplitOf({ listMinor: base * 100, discountMinor: Math.max(0, Number(r.discountAmount || 0)) * 100, couponCode: r.couponCode }) };
}
