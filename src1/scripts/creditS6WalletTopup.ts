// S6 back-credit: credits ONE pharmacy wallet top-up that Razorpay captured but the pre-S6 verify never applied.
//
//   npm run -s credit:s6-wallet-topup -- --record=<paymentTransactionId>            dry run: prints what it would do
//   npm run -s credit:s6-wallet-topup -- --record=<paymentTransactionId> --commit   applies it
//   ... --already-compensated-checked=<paymentTransactionId>                        see "refusals" below
//   ... --disputes-checked-in-dashboard=<paymentTransactionId>                      only when the disputes lookup is unavailable
//   (or: npx tsx src1/scripts/creditS6WalletTopup.ts --record=<id> [--commit] ...)
// Use `npm run -s` (silent): without it npm prints its own banner lines on stdout before the JSON.
// Exit codes: 0 done (or nothing to do / dry run); 2 refused or manual review (nothing written); 3 --commit ran but the
// record was not credited (e.g. the capture was gone by then); 1 error. On an error stdout is still one JSON document,
// { ok: false, error: { code, message } }.
//
// Env: MONGODB_URL (production), RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (the live keys; the gateway is always
// checked), plus whatever src1/config/config.ts needs to load (the backend .env). Runs with tsx: the payment service is
// built here from its repositories only (no typedi container), so the LabStack / Healthians / e-mail config is not
// needed and none of those services can be reached - the wallet-recharge path uses none of them.
// stdout is one JSON report; every log line (service logs included) goes to stderr.
//
// It credits only through PaymentService.reconcilePaymentAndProcess - exactly POST /payments/reconcile, run as the
// record's own payer (payerUserId, else userId, read from the record). That path is idempotent (one completed pharmacy
// wallet credit per record: unique pharmacyId + referenceType wallet_recharge + referenceId, and the record's
// isProcessed), takes the amount and capture from Razorpay's own record of the record's own order, and never revives a
// failed or refunded record. Running it again credits nothing more ("already credited (replay)").
//
// Hard refusals (exit 2, nothing written, no override):
//   - not a pharmacy top-up by the service's rule (wallet_recharge + payerPharmacyId + notes.flow
//     'pharmacy_wallet_recharge'), or a payerPharmacyId that is not an ObjectId;
//   - a top-up blocked after a lost card dispute (`chargebackAt`): never credited, whatever its status;
//   - a failed / refunded record, an inactive pharmacy wallet, or a record that is paid and processed but has no credit
//     (decision 'processed_without_credit': manual review);
//   - a base amount (what is credited) that differs from the final amount (what was charged), or a captured amount that
//     differs from either;
//   - no Razorpay keys or order, a paid record whose payment id differs from the gateway's capture, any refund on the
//     captured payment itself, or any dispute Razorpay lists for it.
// Refusals the operator may override, after checking by hand that the top-up was NOT compensated, by re-running with
// --already-compensated-checked=<the same record id>:
//   - the pharmacy received an admin manual top-up (referenceType 'topup') on or after the record's createdAt;
//   - a refund on another payment of the same Razorpay order;
// The disputes lookup being unavailable (error, timeout, malformed answer, page cap) is never covered by that flag: it
// is refused unless the operator checked the payment's disputes in the Razorpay dashboard and passes
// --disputes-checked-in-dashboard=<the same record id>. Disputes are read by paging GET /disputes (see the audit header);
// this relies on Razorpay returning every dispute across the pages.
//
// A clean dry run is NOT proof that the top-up was never compensated: it cannot see a dispute or chargeback the disputes
// list does not show, a bank transfer or other payment made outside Razorpay, or a hand-written wallet entry that is not
// referenceType 'topup'. Before --commit, check the payment in the Razorpay dashboard (disputes / chargebacks) and ask
// support, for every record.
// It connects with autoCreate / autoIndex off: no collection or index is created.
import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { PharmacyWalletModel } from '@/modules/pharmacyWallet/model';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import {
  AdminTopupsSince, DisputeView, GatewayReadOptions, GatewayView, OBJECT_ID, adminTopupsSince, disputesReaderFor, errorText, gatewayView, logsToStderr,
  orderPaymentsReaderFor, razorpayClientFromEnv, rechargeCreditOf, recordAmountPaise, recordFinalPaise, reportError, exitAfterFlush,
} from '@/scripts/auditS6UncreditedWalletTopups';

/** The Razorpay calls made: GET orders/{id}/payments (also by reconcile) and GET disputes. */
export interface RazorpayOrdersClient {
  orders: { fetchPayments: (orderId: string) => Promise<unknown> };
  disputes?: { all: (p: { count: number; skip: number }) => Promise<unknown> };
}

export type CreditDecision = 'refused' | 'processed_without_credit' | 'nothing_to_do' | 'credit' | 'finalize_only';
export interface CreditOutcome {
  recordId: string; decision: CreditDecision; reasons: string[]; committed: boolean;
  pharmacyId?: string; payerUserId?: string; amount?: number; status?: string; isProcessed?: boolean;
  existingCreditTransactionId?: string | null; adminTopupsSince?: AdminTopupsSince; gateway?: GatewayView;
  disputes?: DisputeView[] | { unavailable: string }; compensationCheckOverride?: boolean; disputesCheckedInDashboard?: boolean;
  result?: {
    outcome: 'credited' | 'already credited (replay)' | 'not credited'; state: string; status?: string; isProcessed?: boolean;
    creditTransactionId: string | null; walletBalanceChange: number;
  };
}
/** Exit code for an outcome: 2 refused / manual review; 3 a commit that did not credit; else 0. */
export const exitCodeOf = (o: CreditOutcome) =>
  (o.decision === 'refused' || o.decision === 'processed_without_credit' ? 2 : o.committed && o.result?.outcome === 'not credited' ? 3 : 0);

/**
 * PaymentService with only what the wallet-recharge reconcile path uses; any other dependency is absent and would throw.
 * `written` collects the ids of the wallet_recharge credits this instance saved, so the caller knows whether THIS run
 * wrote the record's credit (a parallel verify / reconcile / run that credited first is a replay).
 */
export function walletRechargePaymentService(client: RazorpayOrdersClient): { service: PaymentService; written: string[] } {
  const written: string[] = [];
  // Stage merge: the credit is posted by the pharmacy wallet ledger (assisted phase 1a), which reports each row it wrote.
  const service = Object.assign(Object.create(PaymentService.prototype), {
    paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(), walletTransactionRepository: new WalletTransactionRepository(),
    pharmacyWalletRepository: new PharmacyWalletRepository(), pharmacyWalletTransactionRepository: new PharmacyWalletTransactionRepository(),
    razorpayClient: client, onWalletRechargeCredited: (entryId: string) => { written.push(entryId); },
  }) as PaymentService;
  return { service, written };
}

const rupees = (paise: number) => Math.round(paise) / 100;
const balancePaise = async (pharmacyId: string) => {
  const w = await PharmacyWalletModel.findOne({ pharmacyId }).select({ balance: 1, balancePaise: 1 }).lean();
  return w ? (w.balancePaise ?? Math.round(Number(w.balance || 0) * 100)) : 0;
};

export async function creditS6WalletTopup(opts: {
  recordId: string; commit: boolean; alreadyCompensatedChecked?: string; disputesCheckedInDashboard?: string; client?: RazorpayOrdersClient;
  gatewayOptions?: GatewayReadOptions;
}): Promise<CreditOutcome> {
  const recordId = String(opts.recordId || '').toLowerCase();
  const out: CreditOutcome = { recordId, decision: 'refused', reasons: [], committed: false };
  const refuse = (reason: string) => { out.decision = 'refused'; out.reasons.push(reason); return out; };
  if (!/^[0-9a-f]{24}$/.test(recordId)) return refuse('--record must be a payment record id (24 hex characters)');
  if (opts.alreadyCompensatedChecked !== undefined && opts.alreadyCompensatedChecked.toLowerCase() !== recordId) {
    return refuse('--already-compensated-checked names another record; it must be this exact record id');
  }
  if (opts.disputesCheckedInDashboard !== undefined && opts.disputesCheckedInDashboard.toLowerCase() !== recordId) {
    return refuse('--disputes-checked-in-dashboard names another record; it must be this exact record id');
  }

  const r = await PaymentRecordModel.findById(recordId).lean();
  if (!r) return refuse('payment record not found');
  const pharmacyId = typeof r.payerPharmacyId === 'string' ? r.payerPharmacyId : '';
  if (!(r.context === 'wallet_recharge' && pharmacyId && (r.notes as { flow?: unknown } | undefined)?.flow === 'pharmacy_wallet_recharge')) {
    return refuse('not a pharmacy wallet top-up by the service rule (see the audit anomalies); not handled here');
  }
  if (!OBJECT_ID.test(pharmacyId)) return refuse('payerPharmacyId is not an ObjectId (see the audit anomalies); not handled here');
  const payerUserId = String(r.payerUserId || r.userId);
  const basePaise = recordAmountPaise(r);
  const finalPaise = recordFinalPaise(r);
  Object.assign(out, { pharmacyId, payerUserId, amount: rupees(basePaise), status: r.status, isProcessed: r.isProcessed === true });
  // Assisted phase 1a: blocked after a lost card dispute - the bank took the money back. Never credited; no override.
  if ((r as { chargebackAt?: unknown }).chargebackAt) {
    return refuse('blocked after a lost card dispute: never credit (Jansetu already lost this money; no override)');
  }
  if (r.status === 'failed' || r.status === 'refunded') return refuse(`record is ${r.status}: manual review (reconcile never revives it)`);

  const credit = await rechargeCreditOf(pharmacyId, recordId);
  out.existingCreditTransactionId = credit ? String(credit._id) : null;
  const wallet = await PharmacyWalletModel.findOne({ pharmacyId }).select({ isActive: 1 }).lean();
  if (wallet && wallet.isActive === false) return refuse('the pharmacy wallet is inactive');

  if (credit) {
    if (r.isProcessed) { out.decision = 'nothing_to_do'; out.reasons.push('already credited and processed'); return out; }
    if (r.status !== 'paid') return refuse('a credit exists but the record is not paid: inconsistent, manual review');
    out.decision = 'finalize_only';
    out.reasons.push('already credited; only marks the record processed (no money moves)');
  } else {
    if (r.isProcessed) {
      out.decision = 'processed_without_credit';
      out.reasons.push(`the record is ${r.status} and marked processed but has no wallet credit: reconcile would credit nothing; manual review`);
      return out;
    }
    if (basePaise !== finalPaise) {
      return refuse(`the record's base amount (Rs ${rupees(basePaise)}, credited) differs from its final amount (Rs ${rupees(finalPaise)}, charged): manual review`);
    }
    if (!opts.client) return refuse('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are required (the gateway is always checked)');
    if (!r.razorpayOrderId) return refuse('the record has no Razorpay order');
    const view = await gatewayView(orderPaymentsReaderFor(opts.client, opts.gatewayOptions), r.razorpayOrderId, finalPaise);
    out.gateway = view;
    if (!view.capturedPaymentId) {
      if (r.status === 'paid') return refuse('the record is paid but Razorpay shows no captured payment (refunded?): manual review');
      out.decision = 'nothing_to_do'; out.reasons.push('Razorpay holds no captured payment for this order: nothing to credit');
      return out;
    }
    const capturedPaise = Math.round(Number(view.capturedAmount) * 100);
    if (!view.amountMatches || capturedPaise !== basePaise) return refuse('the captured amount differs from the amount that would be credited');
    if (view.capturedRefunded > 0) {
      return refuse(`Razorpay shows Rs ${view.capturedRefunded} refunded on the captured payment itself: not credited (manual review, no override)`);
    }
    if (r.status === 'paid' && r.razorpayPaymentId && r.razorpayPaymentId !== view.capturedPaymentId) {
      return refuse('the record names a different payment than the gateway capture: manual review');
    }
    const risks: string[] = [];
    const readDisputes = disputesReaderFor(opts.client, opts.gatewayOptions);
    if (!readDisputes) {
      out.disputes = { unavailable: 'no disputes lookup in the gateway client' };
    } else {
      try { out.disputes = (await readDisputes()).get(view.capturedPaymentId) ?? []; } catch (error) {
        out.disputes = { unavailable: 'disputes lookup failed: ' + errorText(error) };
      }
    }
    if (Array.isArray(out.disputes) && out.disputes.length) {
      return refuse(`Razorpay lists ${out.disputes.length} dispute(s) on the captured payment: not credited (manual review, no override)`);
    }
    if (!Array.isArray(out.disputes)) {
      // Never covered by --already-compensated-checked (that flag may have been given for an unrelated admin top-up).
      if (opts.disputesCheckedInDashboard?.toLowerCase() !== recordId) {
        return refuse(`the disputes lookup was not available (${out.disputes!.unavailable}). Check this payment's disputes in the Razorpay ` +
          `dashboard; if there are none, re-run with --disputes-checked-in-dashboard=${recordId}`);
      }
      out.disputesCheckedInDashboard = true;
      out.reasons.push(`operator checked disputes in the Razorpay dashboard (lookup unavailable: ${out.disputes!.unavailable})`);
    }
    const admin = await adminTopupsSince(pharmacyId, r.createdAt as Date | undefined);
    out.adminTopupsSince = admin;
    if (admin.count > 0) risks.push(`${admin.count} admin top-up credit(s) totalling Rs ${admin.amount} since the record was created`);
    if (view.otherRefunded > 0) risks.push(`Razorpay shows Rs ${view.otherRefunded} refunded on another payment of this order`);
    if (risks.length) {
      if (opts.alreadyCompensatedChecked?.toLowerCase() !== recordId) {
        return refuse(`may already be compensated: ${risks.join('; ')}. Check by hand; if it was NOT compensated, re-run with ` +
          `--already-compensated-checked=${recordId}`);
      }
      out.compensationCheckOverride = true;
      out.reasons.push(`operator confirmed not compensated despite: ${risks.join('; ')}`);
    }
    out.decision = 'credit';
    out.reasons.push(`credits Rs ${out.amount} to pharmacy ${pharmacyId} through reconcile as payer ${payerUserId}`);
    out.reasons.push('a clean check is not proof of no compensation: confirm Razorpay disputes/chargebacks and with support first');
  }

  if (!opts.commit) { out.reasons.push('dry run: nothing written; add --commit to apply'); return out; }

  const before = await balancePaise(pharmacyId);
  const { service, written: savedByThisRun } = walletRechargePaymentService(
    opts.client ?? { orders: { fetchPayments: async () => { throw new Error('gateway not configured'); } } });
  const result = await service.reconcilePaymentAndProcess({ paymentTransactionId: recordId, userId: payerUserId });
  const after = await PaymentRecordModel.findById(recordId).select({ status: 1, isProcessed: 1 }).lean();
  const written = await rechargeCreditOf(pharmacyId, recordId);
  // Credited by THIS run only when the committed credit is the one this run saved; otherwise someone else (a parallel
  // verify, reconcile or run) credited first and this run was a replay.
  const mine = !!written && savedByThisRun.includes(String(written._id));
  out.committed = true;
  out.result = {
    outcome: mine ? 'credited' : written ? 'already credited (replay)' : 'not credited',
    state: result.state, status: after?.status, isProcessed: after?.isProcessed, creditTransactionId: written ? String(written._id) : null,
    walletBalanceChange: rupees((await balancePaise(pharmacyId)) - before),
  };
  if (!written && after?.status === 'paid' && after?.isProcessed) {
    out.decision = 'processed_without_credit';
    out.reasons.push('after reconcile the record is paid and processed with no wallet credit: manual review');
  }
  return out;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  logsToStderr();
  const recordId = arg('record') ?? '';
  const commit = process.argv.includes('--commit');
  const alreadyCompensatedChecked = arg('already-compensated-checked');
  const disputesCheckedInDashboard = arg('disputes-checked-in-dashboard');
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    const outcome = await creditS6WalletTopup({ recordId, commit, alreadyCompensatedChecked, disputesCheckedInDashboard,
      client: razorpayClientFromEnv() as unknown as RazorpayOrdersClient });
    process.stdout.write(JSON.stringify(outcome, null, 2) + '\n');
    process.exitCode = exitCodeOf(outcome);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(async (error) => { reportError(error); await mongoose.disconnect().catch(() => undefined); })
    .finally(exitAfterFlush);
}
