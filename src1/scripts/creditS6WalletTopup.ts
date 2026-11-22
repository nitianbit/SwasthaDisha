// S6 back-credit: credits ONE pharmacy wallet top-up that Razorpay captured but the pre-S6 verify never applied.
//
//   npm run credit:s6-wallet-topup -- --record=<paymentTransactionId>            dry run: prints what it would do
//   npm run credit:s6-wallet-topup -- --record=<paymentTransactionId> --commit   applies it
//   ... --already-compensated-checked=<paymentTransactionId>                     see "refusals" below
//
// Env: MONGODB_URL (production), RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (the live keys; the gateway is always
// checked), plus whatever src1/config/config.ts needs to load (the backend .env). Runs with tsx: the payment service is
// built here from its repositories only (no typedi container), so the LabStack / Healthians / e-mail config is not
// needed and none of those services can be reached - the wallet-recharge path uses none of them.
//
// It credits only through PaymentService.reconcilePaymentAndProcess - exactly POST /payments/reconcile, run as the
// record's own payer (payerUserId, else userId, read from the record). That path is idempotent (one completed pharmacy
// wallet credit per record: unique pharmacyId + referenceType wallet_recharge + referenceId, and the record's
// isProcessed), takes the amount and capture from Razorpay's own record of the record's own order, and never revives a
// failed or refunded record. Running it again credits nothing more.
//
// Refusals (exit 2, nothing written):
//   - not a pharmacy top-up by the service's rule (wallet_recharge + payerPharmacyId + notes.flow
//     'pharmacy_wallet_recharge'), a failed / refunded record (manual review), or an inactive pharmacy wallet;
//   - no Razorpay keys, no gateway order, a captured amount that differs from the record, or a paid record whose payment
//     id differs from the gateway's capture;
//   - the pharmacy received an admin manual top-up (referenceType 'topup') on or after the record's createdAt, or
//     Razorpay shows any refunded amount on the order - support may already have compensated it. After checking by hand
//     that it was NOT compensated, re-run with --already-compensated-checked=<the same record id>.
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
  AdminTopupsSince, GatewayView, adminTopupsSince, gatewayView, orderPaymentsReaderFor, razorpayClientFromEnv, rechargeCreditOf,
  recordAmountPaise, recordFinalPaise,
} from '@/scripts/auditS6UncreditedWalletTopups';

/** The Razorpay calls the reconcile path makes (GET orders/{id}/payments). */
export interface RazorpayOrdersClient { orders: { fetchPayments: (orderId: string) => Promise<unknown> } }

export type CreditDecision = 'refused' | 'nothing_to_do' | 'credit' | 'finalize_only';
export interface CreditOutcome {
  recordId: string; decision: CreditDecision; reasons: string[]; committed: boolean;
  pharmacyId?: string; payerUserId?: string; amount?: number; status?: string; isProcessed?: boolean;
  existingCreditTransactionId?: string | null; adminTopupsSince?: AdminTopupsSince; gateway?: GatewayView;
  compensationCheckOverride?: boolean;
  result?: { state: string; status?: string; isProcessed?: boolean; creditTransactionId: string | null; walletBalanceChange: number };
}

/** PaymentService with only what the wallet-recharge reconcile path uses; any other dependency is absent and would throw. */
export function walletRechargePaymentService(client: RazorpayOrdersClient): PaymentService {
  return Object.assign(Object.create(PaymentService.prototype), {
    paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(), walletTransactionRepository: new WalletTransactionRepository(),
    pharmacyWalletRepository: new PharmacyWalletRepository(), pharmacyWalletTransactionRepository: new PharmacyWalletTransactionRepository(),
    razorpayClient: client,
  }) as PaymentService;
}

const rupees = (paise: number) => Math.round(paise) / 100;
const balancePaise = async (pharmacyId: string) => {
  const w = await PharmacyWalletModel.findOne({ pharmacyId }).select({ balance: 1, balancePaise: 1 }).lean();
  return w ? (w.balancePaise ?? Math.round(Number(w.balance || 0) * 100)) : 0;
};

export async function creditS6WalletTopup(opts: {
  recordId: string; commit: boolean; alreadyCompensatedChecked?: string; client?: RazorpayOrdersClient;
}): Promise<CreditOutcome> {
  const recordId = String(opts.recordId || '').toLowerCase();
  const out: CreditOutcome = { recordId, decision: 'refused', reasons: [], committed: false };
  const refuse = (reason: string) => { out.decision = 'refused'; out.reasons.push(reason); return out; };
  if (!/^[0-9a-f]{24}$/.test(recordId)) return refuse('--record must be a payment record id (24 hex characters)');
  if (opts.alreadyCompensatedChecked !== undefined && opts.alreadyCompensatedChecked.toLowerCase() !== recordId) {
    return refuse('--already-compensated-checked names another record; it must be this exact record id');
  }

  const r = await PaymentRecordModel.findById(recordId).lean();
  if (!r) return refuse('payment record not found');
  const pharmacyId = typeof r.payerPharmacyId === 'string' ? r.payerPharmacyId : '';
  if (!(r.context === 'wallet_recharge' && pharmacyId && (r.notes as { flow?: unknown } | undefined)?.flow === 'pharmacy_wallet_recharge')) {
    return refuse('not a pharmacy wallet top-up by the service rule (see the audit anomalies); not handled here');
  }
  const payerUserId = String(r.payerUserId || r.userId);
  Object.assign(out, { pharmacyId, payerUserId, amount: rupees(recordAmountPaise(r)), status: r.status, isProcessed: r.isProcessed === true });
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
    if (!opts.client) return refuse('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are required (the gateway is always checked)');
    if (!r.razorpayOrderId) return refuse('the record has no Razorpay order');
    const view = await gatewayView(orderPaymentsReaderFor(opts.client), r.razorpayOrderId, recordFinalPaise(r));
    out.gateway = view;
    if (!view.capturedPaymentId) {
      if (r.status === 'paid') return refuse('the record is paid but Razorpay shows no captured payment (refunded?): manual review');
      out.decision = 'nothing_to_do'; out.reasons.push('Razorpay holds no captured payment for this order: nothing to credit');
      return out;
    }
    if (!view.amountMatches) return refuse('the captured amount differs from the record');
    if (r.status === 'paid' && r.razorpayPaymentId && r.razorpayPaymentId !== view.capturedPaymentId) {
      return refuse('the record names a different payment than the gateway capture: manual review');
    }
    const admin = await adminTopupsSince(pharmacyId, r.createdAt as Date | undefined);
    out.adminTopupsSince = admin;
    const risks: string[] = [];
    if (admin.count > 0) risks.push(`${admin.count} admin top-up credit(s) totalling Rs ${admin.amount} since the record was created`);
    if (view.amountRefunded > 0) risks.push(`Razorpay shows Rs ${view.amountRefunded} refunded on this order`);
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
  }

  if (!opts.commit) { out.reasons.push('dry run: nothing written; add --commit to apply'); return out; }

  const before = await balancePaise(pharmacyId);
  const service = walletRechargePaymentService(opts.client ?? { orders: { fetchPayments: async () => { throw new Error('gateway not configured'); } } });
  const result = await service.reconcilePaymentAndProcess({ paymentTransactionId: recordId, userId: payerUserId });
  const after = await PaymentRecordModel.findById(recordId).select({ status: 1, isProcessed: 1 }).lean();
  const written = await rechargeCreditOf(pharmacyId, recordId);
  out.committed = true;
  out.result = { state: result.state, status: after?.status, isProcessed: after?.isProcessed, creditTransactionId: written ? String(written._id) : null,
    walletBalanceChange: rupees((await balancePaise(pharmacyId)) - before) };
  return out;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const recordId = arg('record') ?? '';
  const commit = process.argv.includes('--commit');
  const alreadyCompensatedChecked = arg('already-compensated-checked');
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    const outcome = await creditS6WalletTopup({ recordId, commit, alreadyCompensatedChecked, client: razorpayClientFromEnv() });
    process.stdout.write(JSON.stringify(outcome, null, 2) + '\n');
    process.exitCode = outcome.decision === 'refused' ? 2 : 0;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => { console.error((error as { code?: string })?.code, (error as Error)?.message ?? error); process.exit(1); });
}
