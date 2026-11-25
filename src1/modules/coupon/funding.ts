/**
 * Decision B (§6.4): who bears a coupon's discount — the coupon's `fundedBy`, else a corporate coupon (it names
 * corporateIds) is platform-funded and any other provider-funded. One rule for every reader (assisted creates, r32 4c).
 */
export const couponFundedBy = (c: { fundedBy?: string | null; corporateIds?: unknown[] | null }): 'provider' | 'platform' =>
  (c.fundedBy === 'platform' || c.fundedBy === 'provider' ? c.fundedBy : (c.corporateIds ?? []).length > 0 ? 'platform' : 'provider');
