import { ClientSession } from 'mongoose';
import { ensureSettlementAccount, postLedgerEntry } from '@/modules/partners/services/settlement';

type EarningBooking = {
  _id?: unknown; specialistId?: string; doctorName?: string; settlementSystem?: string; paymentStatus?: string;
  price?: number; originalPrice?: number; settlement?: { settlementAccountId?: string };
};

/**
 * Q4 §7: a consultation settled by the ledger earns the doctor its price before coupons (coupons are platform-funded,
 * as for partner labs), commission 0, once per booking, inside the caller's transaction. Legacy bookings are never
 * touched here (the legacy payouts own them); unpaid bookings earn nothing.
 */
export async function postConsultationEarningIn(b: EarningBooking, s: ClientSession, actor: { by: string; byKind: 'system' | 'admin' }): Promise<void> {
  if (b.settlementSystem !== 'ledger' || b.paymentStatus !== 'paid' || !b.specialistId) return;
  const amountMinor = Math.round(Number(b.originalPrice ?? b.price ?? 0) * 100);
  if (!(amountMinor > 0)) return;
  let accountId = b.settlement?.settlementAccountId;
  if (!accountId) {
    const account = await ensureSettlementAccount('doctor', String(b.specialistId), b.doctorName || 'Doctor', s);
    accountId = String(account._id);
  }
  await postLedgerEntry({
    settlementAccountId: accountId, kind: 'earning', amountMinor, grossMinor: amountMinor, commissionMinor: 0,
    source: 'consultation', sourceId: String(b._id), by: actor.by, byKind: actor.byKind,
  }, s);
}
