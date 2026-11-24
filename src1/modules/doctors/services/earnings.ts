import { ClientSession } from 'mongoose';
import { ensureSettlementAccount, postLedgerEntry } from '@/modules/partners/services/settlement';
import { postReferralEarningIn } from '@/modules/referralCuts/service';
import type { AssistedReferral } from '@/modules/assisted/types';

type EarningBooking = {
  _id?: unknown; specialistId?: string; doctorName?: string; settlementSystem?: string; paymentStatus?: string;
  price?: number; originalPrice?: number; settlement?: { settlementAccountId?: string };
  earningRule?: string; assisted?: { split?: { providerMinor?: number; baseMinor?: number; cutMinor?: number; rule?: string }; referral?: AssistedReferral | null } | null;
};

/**
 * Q4 §7: a consultation settled by the ledger earns the doctor, commission 0, once per booking, inside the caller's
 * transaction. Q16a (owner, 22 Nov 2026): coupons are borne by the PROVIDER, as the legacy payouts always did, so the
 * earning is the price the patient was charged AFTER the coupon (`price`), never the pre-coupon `originalPrice`; a
 * coupon is never turned into money. Legacy bookings are never touched here (the legacy payouts own them); unpaid
 * bookings earn nothing. Called on completion only: a no-show earns nothing (Q14, owner 18 Nov 2026).
 */
export async function postConsultationEarningIn(b: EarningBooking, s: ClientSession, actor: { by: string; byKind: 'system' | 'admin' }): Promise<void> {
  if (b.settlementSystem !== 'ledger' || b.paymentStatus !== 'paid' || !b.specialistId) return;
  // Assisted booking phase 1a (§8.3, P5): a row frozen with `provider_coupon_v2` earns its split — base (after a
  // provider-funded coupon; the list price for a platform-funded one) minus the cut, which is 0 until phase 4.
  const split = b.earningRule === 'provider_coupon_v2' ? b.assisted?.split : undefined;
  const v2 = !!split && Number.isSafeInteger(split.providerMinor) && Number.isSafeInteger(split.baseMinor);
  const amountMinor = v2 ? Number(split!.providerMinor) : Math.round(Number(b.price ?? 0) * 100);
  const grossMinor = v2 ? Number(split!.baseMinor) : amountMinor;
  const commissionMinor = v2 ? Number(split!.cutMinor ?? 0) : 0;
  if (amountMinor > 0) {
    let accountId = b.settlement?.settlementAccountId;
    if (!accountId) {
      const account = await ensureSettlementAccount('doctor', String(b.specialistId).toLowerCase(), b.doctorName || 'Doctor', s);
      accountId = String(account._id);
    }
    await postLedgerEntry({
      settlementAccountId: accountId, kind: 'earning', amountMinor, grossMinor, commissionMinor,
      source: 'consultation', sourceId: String(b._id), by: actor.by, byKind: actor.byKind,
    }, s);
  }
  // Phase 4b (§26.6.1): the booking partner's referral cut, out of that earning, once, in the same transaction.
  if (v2) await postReferralEarningIn(b, 'referral_consultation', s, actor);
}
