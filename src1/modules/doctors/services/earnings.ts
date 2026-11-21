import { ClientSession } from 'mongoose';
import { ensureSettlementAccount, postLedgerEntry } from '@/modules/partners/services/settlement';

type EarningBooking = {
  _id?: unknown; specialistId?: string; doctorName?: string; settlementSystem?: string; paymentStatus?: string;
  price?: number; originalPrice?: number; settlement?: { settlementAccountId?: string };
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
  const amountMinor = Math.round(Number(b.price ?? 0) * 100);
  if (!(amountMinor > 0)) return;
  let accountId = b.settlement?.settlementAccountId;
  if (!accountId) {
    const account = await ensureSettlementAccount('doctor', String(b.specialistId).toLowerCase(), b.doctorName || 'Doctor', s);
    accountId = String(account._id);
  }
  await postLedgerEntry({
    settlementAccountId: accountId, kind: 'earning', amountMinor, grossMinor: amountMinor, commissionMinor: 0,
    source: 'consultation', sourceId: String(b._id), by: actor.by, byKind: actor.byKind,
  }, s);
}
