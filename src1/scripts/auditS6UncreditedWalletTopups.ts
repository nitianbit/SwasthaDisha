// S6 audit (read-only): pharmacy wallet top-ups that may have been captured by Razorpay but never credited. Before S6
// the released pharmacy app's verify (`module: 'pharmacy-wallet'`) was refused by validation, so the record stayed
// `created` while the gateway kept the money.
//
//   npm run audit:s6-uncredited-wallet-topups                 one JSON report to stdout, a summary to stderr
//   npm run audit:s6-uncredited-wallet-topups -- --no-gateway skip the Razorpay lookup even if keys are set
//
// Lists, for pharmacy top-up payment records (context wallet_recharge with notes.flow 'pharmacy_wallet_recharge' or a
// payerPharmacyId):
//   - every record not yet settled (status not paid / failed / refunded, e.g. 'created');
//   - every 'paid' record without a completed pharmacy wallet credit for it (referenceType wallet_recharge,
//     referenceId = the record id), or credited but not marked processed.
// Output: ids, amounts (rupees), dates and status only - no names, phones, e-mails, notes or signatures.
// With RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in the environment it also asks Razorpay (GET orders/{id}/payments, read
// only) what each order holds. It writes nothing to MongoDB and creates no collection or index; it never calls a
// Razorpay write (no capture, refund or order creation).
//
// Crediting the listed records after S6 is deployed - only through the existing reconcile path, which is idempotent
// (one completed pharmacy wallet credit per payment record: unique pharmacyId + referenceType + referenceId, and the
// record's isProcessed), takes the amount from Razorpay's own record of the record's own order, and never revives a
// failed or refunded record:
//   - Route: POST /api/v1/payments/reconcile { paymentTransactionId } with the token of the record's payerUserId (the
//     pharmacy user who started the top-up). An admin token is refused (404): admins have no route for this on main.
//   - Manual step for an operator on the server (same code path, run as that payer; repeat-safe), per listed row:
//       S6_RECORD=<paymentTransactionId> S6_PAYER=<payerUserId> npx ts-node -r tsconfig-paths/register -T -e "require('reflect-metadata');
//       const m = require('mongoose'); const { Container } = require('typedi'); const { CONFIG } = require('@/config/config');
//       const { PaymentService } = require('@/modules/payment/services'); (async () => { await m.connect(CONFIG.MONGODB_URL); try {
//       const r = await Container.get(PaymentService).reconcilePaymentAndProcess({ paymentTransactionId: process.env.S6_RECORD,
//       userId: process.env.S6_PAYER }); console.log(JSON.stringify({ state: r.state, context: r.context, status: r.paymentRecord &&
//       r.paymentRecord.status, isProcessed: r.paymentRecord && r.paymentRecord.isProcessed })); } finally { await m.disconnect(); } })()
//       .catch((e) => { console.error(e && e.code, e && e.message); process.exit(1); });"
//     (from the backend directory with the production .env loaded; ts-node, not tsx, because the service container needs
//     decorator metadata). 'paid' = credited now or already; 'unpaid' = Razorpay holds no captured payment for that order.
//   - Do NOT use the admin manual credit (POST /pharmacy-wallet/topup with pharmacyId): it is not linked to the payment
//     record, so a later verify or reconcile of the same record would credit the pharmacy a second time.
// Re-run this audit afterwards: credited records drop out.
import mongoose from 'mongoose';
import Razorpay from 'razorpay';
import { CONFIG } from '@/config/config';
import PaymentRecordModel from '@/modules/payment/model';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';

type Finding = 'unsettled' | 'paid_not_credited' | 'credited_not_processed';
export interface S6TopupRow {
  paymentTransactionId: string; pharmacyId: string | null; payerUserId: string | null; razorpayOrderId: string | null;
  razorpayPaymentId: string | null; amount: number; status: string; isProcessed: boolean; finding: Finding;
  creditTransactionId: string | null; createdAt: string | null; paidAt: string | null;
  gateway?: { checked: true; statuses: string[]; capturedPaymentId: string | null; capturedAmount: number | null; amountMatches: boolean | null }
    | { checked: false; reason: string };
}
export interface S6TopupAudit {
  generatedAt: string; gatewayChecked: boolean; scanned: number; rows: S6TopupRow[];
  summary: Record<Finding, number> & { capturedNotCredited: number | null; capturedNotCreditedAmount: number | null };
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null);
const str = (v: unknown) => (v == null || v === '' ? null : String(v));

type OrderPayments = (orderId: string) => Promise<{ id: string; amount: number; status: string }[]>;

export async function auditS6UncreditedWalletTopups(fetchOrderPayments?: OrderPayments): Promise<S6TopupAudit> {
  const rows: S6TopupRow[] = [];
  let scanned = 0;
  const filter = { context: 'wallet_recharge', $or: [{ 'notes.flow': 'pharmacy_wallet_recharge' }, { payerPharmacyId: { $type: 'string', $ne: '' } }] };
  for await (const r of PaymentRecordModel.find(filter)
    .select({ payerPharmacyId: 1, payerUserId: 1, userId: 1, razorpayOrderId: 1, razorpayPaymentId: 1, baseAmount: 1, baseAmountPaise: 1,
      status: 1, isProcessed: 1, createdAt: 1, paidAt: 1, 'notes.pharmacyId': 1 })
    .sort({ _id: 1 }).lean().cursor()) {
    scanned++;
    const id = String(r._id);
    const pharmacyId = str(r.payerPharmacyId) ?? str((r.notes as { pharmacyId?: unknown } | undefined)?.pharmacyId);
    const credit = pharmacyId
      ? await PharmacyWalletTransactionModel.findOne({ pharmacyId, referenceType: 'wallet_recharge', referenceId: id, status: 'completed' })
        .select({ _id: 1 }).lean()
      : null;
    let finding: Finding | null = null;
    if (!['paid', 'failed', 'refunded'].includes(r.status)) finding = 'unsettled';
    else if (r.status === 'paid' && !credit) finding = 'paid_not_credited';
    else if (r.status === 'paid' && !r.isProcessed) finding = 'credited_not_processed';
    if (!finding) continue;
    rows.push({
      paymentTransactionId: id, pharmacyId, payerUserId: str(r.payerUserId) ?? str(r.userId), razorpayOrderId: str(r.razorpayOrderId),
      razorpayPaymentId: str(r.razorpayPaymentId), amount: (r.baseAmountPaise ?? Math.round(Number(r.baseAmount || 0) * 100)) / 100,
      status: r.status, isProcessed: r.isProcessed === true, finding, creditTransactionId: credit ? String(credit._id) : null,
      createdAt: iso(r.createdAt), paidAt: iso(r.paidAt),
    });
  }

  let capturedNotCredited: number | null = null;
  let capturedNotCreditedAmount: number | null = null;
  if (fetchOrderPayments) {
    capturedNotCredited = 0; capturedNotCreditedAmount = 0;
    for (const row of rows) {
      if (!row.razorpayOrderId) { row.gateway = { checked: false, reason: 'no gateway order' }; continue; }
      try {
        const items = await fetchOrderPayments(row.razorpayOrderId);
        const captured = items.find((p) => p.status === 'captured') ?? null;
        const capturedAmount = captured ? Number(captured.amount) / 100 : null;
        row.gateway = { checked: true, statuses: items.map((p) => p.status), capturedPaymentId: captured?.id ?? null, capturedAmount,
          amountMatches: captured ? Math.round(Number(captured.amount)) === Math.round(row.amount * 100) : null };
        if (captured && row.finding !== 'credited_not_processed') { capturedNotCredited++; capturedNotCreditedAmount += capturedAmount ?? 0; }
      } catch (error) {
        row.gateway = { checked: false, reason: 'gateway lookup failed: ' + String((error as { error?: { code?: string } })?.error?.code ?? (error as Error)?.message ?? error).slice(0, 80) };
      }
    }
  }
  const count = (f: Finding) => rows.filter((r) => r.finding === f).length;
  return { generatedAt: new Date().toISOString(), gatewayChecked: !!fetchOrderPayments, scanned, rows,
    summary: { unsettled: count('unsettled'), paid_not_credited: count('paid_not_credited'), credited_not_processed: count('credited_not_processed'),
      capturedNotCredited, capturedNotCreditedAmount } };
}

async function main() {
  const useGateway = !process.argv.includes('--no-gateway') && !!CONFIG.RAZORPAY_KEY_ID && !!CONFIG.RAZORPAY_KEY_SECRET;
  let fetchOrderPayments: OrderPayments | undefined;
  if (useGateway) {
    const client = new Razorpay({ key_id: CONFIG.RAZORPAY_KEY_ID!, key_secret: CONFIG.RAZORPAY_KEY_SECRET! });
    fetchOrderPayments = async (orderId) => {
      const res = (await client.orders.fetchPayments(orderId)) as unknown as { items?: { id: string; amount: number | string; status: string }[] };
      return (res.items ?? []).map((p) => ({ id: p.id, amount: Number(p.amount), status: p.status }));
    };
  }
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    const report = await auditS6UncreditedWalletTopups(fetchOrderPayments);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    const s = report.summary;
    process.stderr.write(`pharmacy top-up records scanned: ${report.scanned}; unsettled: ${s.unsettled}; paid but not credited: ${s.paid_not_credited}; ` +
      `credited but not marked processed: ${s.credited_not_processed}; ` +
      (report.gatewayChecked ? `captured at Razorpay and not credited: ${s.capturedNotCredited} (Rs ${s.capturedNotCreditedAmount})\n`
        : 'gateway not checked (no Razorpay keys in the environment, or --no-gateway)\n'));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
