// S6 audit (read-only): pharmacy wallet top-ups that may have been captured by Razorpay but never credited. Before S6
// the released pharmacy app's verify (`module: 'pharmacy-wallet'`) was refused by validation, so the record stayed
// `created` while the gateway kept the money.
//
//   npm run -s audit:s6-uncredited-wallet-topups                 one JSON report to stdout, a summary to stderr
//   npm run -s audit:s6-uncredited-wallet-topups -- --no-gateway skip the Razorpay lookup even if keys are set
//   (or: npx tsx src1/scripts/auditS6UncreditedWalletTopups.ts [--no-gateway])
// Use `npm run -s` (silent): without it npm prints its own banner lines on stdout before the JSON.
// stdout is always one JSON document: the report, or on any error { ok: false, error: { code, message } } with exit 1.
//
// Pharmacy top-ups are the records the service credits to a pharmacy wallet: context wallet_recharge AND a
// payerPharmacyId AND notes.flow 'pharmacy_wallet_recharge'. For those it lists in `rows`:
//   - every record not yet settled (status not paid / failed / refunded, e.g. 'created');
//   - every 'paid' record without a completed pharmacy wallet credit for it (referenceType wallet_recharge,
//     referenceId = the record id), or credited but not marked processed;
// and, per row, the pharmacy's admin top-up credits (referenceType 'topup') made on or after the record's createdAt
// (support may already have compensated by hand) and, with the gateway, the amount Razorpay refunded on the order.
// `failedWithCapture`: 'failed' top-ups whose Razorpay order shows a capture - manual review only (the credit script
// does not handle them; reconcile never revives a failed record). Needs the gateway.
// `anomalies`: wallet_recharge records with only one of payerPharmacyId / the pharmacy flow - listed for review, no
// credit advice (the service would not credit them to a pharmacy).
// `anomalies` also lists pharmacy-flow records whose payerPharmacyId is not an ObjectId (never credited by this tooling).
// Output: ids, amounts (rupees), dates and status only - no names, phones, e-mails, notes or signatures.
// With RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in the environment it asks Razorpay (GET orders/{id}/payments and GET
// disputes, read only) what each order holds and which disputes name its captured payment.
//
// A clean row (no admin top-up since createdAt, nothing refunded, no dispute listed) is NOT proof that the top-up was
// never compensated: this report cannot see a dispute or chargeback the disputes list does not show, a bank transfer or
// other payment made outside Razorpay, or a hand-written wallet entry that is not referenceType 'topup'. The runbook
// adds a check of the payment in the Razorpay dashboard (disputes / chargebacks) and with support for every row.
// Disputes are read by paging GET /disputes (count 100, skip advanced by the items received, until an empty page, at most
// 200 pages, 20 s timeout per request, a short pause between pages): this relies on Razorpay returning every dispute
// across those pages; a missing items array, a timeout or the page cap makes the lookup "unavailable" (never "none").
// `gatewayLookupFailed`: records whose Razorpay lookup failed; such rows count as needsCompensationCheck (unknown).
// It writes nothing to MongoDB and creates no collection or index; it never calls a Razorpay write (no capture, refund
// or order creation).
//
// Crediting a listed row after S6 is deployed: `npm run -s credit:s6-wallet-topup -- --record=<paymentTransactionId>`
// (dry run; add --commit to apply). See src1/scripts/creditS6WalletTopup.ts. Do NOT use the admin manual credit
// (POST /pharmacy-wallet/topup with pharmacyId) for these: it is not linked to the payment record, so a later verify or
// reconcile of the same record would credit the pharmacy a second time. Re-run this audit afterwards: credited rows drop.
import mongoose from 'mongoose';
import Razorpay from 'razorpay';
import winston from 'winston';
import { CONFIG } from '@/config/config';
import logger from '@/services/logger';
import PaymentRecordModel from '@/modules/payment/model';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';

type Finding = 'unsettled' | 'paid_not_credited' | 'credited_not_processed';
/** What Razorpay holds for one order (amounts in rupees). */
export interface GatewayView {
  checked: true; statuses: string[]; capturedPaymentId: string | null; capturedAmount: number | null;
  amountMatches: boolean | null;
  /** All refunds on the order; `capturedRefunded` is the captured payment's own, `otherRefunded` other payments' of the order. */
  amountRefunded: number; capturedRefunded: number; otherRefunded: number;
}
export interface DisputeView { id: string; status: string; amount: number }
/** Read-only: every Razorpay dispute, keyed by payment id. */
export type DisputesReader = () => Promise<Map<string, DisputeView[]>>;
export type GatewayResult = GatewayView | { checked: false; reason: string };
export interface AdminTopupsSince { count: number; amount: number }
export interface S6TopupRow {
  paymentTransactionId: string; pharmacyId: string; payerUserId: string | null; razorpayOrderId: string | null;
  razorpayPaymentId: string | null; amount: number; status: string; isProcessed: boolean; finding: Finding;
  creditTransactionId: string | null; createdAt: string | null; paidAt: string | null;
  adminTopupsSince: AdminTopupsSince;
  /** An admin top-up since createdAt or a gateway refund: check by hand before crediting (credit script refuses). */
  needsCompensationCheck: boolean;
  gateway?: GatewayResult;
  /** Disputes Razorpay lists for the captured payment (with the gateway only). */
  disputes?: DisputeView[] | { unavailable: string };
}
export interface S6FailedRow {
  paymentTransactionId: string; pharmacyId: string; razorpayOrderId: string | null; amount: number; status: string;
  createdAt: string | null; gateway: GatewayView; review: 'manual: failed record with a captured payment; not handled by the credit script';
}
export interface S6Anomaly {
  paymentTransactionId: string; status: string; isProcessed: boolean; hasPayerPharmacyId: boolean; payerPharmacyIdValid: boolean; hasPharmacyFlow: boolean;
  amount: number; createdAt: string | null;
}
export interface S6LookupFailure { paymentTransactionId: string; status: string; section: 'rows' | 'failed'; reason: string }
export interface S6TopupAudit {
  generatedAt: string; gatewayChecked: boolean; scanned: number; rows: S6TopupRow[]; failedWithCapture: S6FailedRow[] | 'not checked (no gateway)';
  gatewayLookupFailed: S6LookupFailure[]; anomalies: S6Anomaly[];
  summary: Record<Finding, number> & { needsCompensationCheck: number; capturedNotCredited: number | null; capturedNotCreditedAmount: number | null;
    failedWithCapture: number | null; gatewayLookupFailed: number; anomalies: number };
}

/** Readable text for a thrown error; Razorpay SDK errors are { statusCode, error: { code, description } } without .message. */
export function errorText(e: unknown): string {
  const x = e as { statusCode?: number; error?: { code?: string; description?: string }; code?: unknown; message?: string } | null;
  const parts = [x?.statusCode ? `HTTP ${x.statusCode}` : '', x?.error?.code ?? '', x?.error?.description ?? '', x?.error ? '' : (x?.message ?? '')]
    .filter(Boolean);
  return (parts.length ? parts.join(' ') : String(e)).slice(0, 200);
}
export function errorCode(e: unknown): string {
  const x = e as { error?: { code?: string }; code?: unknown; name?: string } | null;
  return String(x?.error?.code ?? x?.code ?? x?.name ?? 'ERROR');
}
/** Rejects after `ms` (the Razorpay SDK has no request timeout option). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(timer));
}
export interface GatewayReadOptions { timeoutMs?: number; pageDelayMs?: number; maxPages?: number }

/** Raw Razorpay order payments (paise), as GET /orders/{id}/payments returns them. */
export type OrderPaymentsReader = (orderId: string) => Promise<{ id: string; amount: number; status: string; amount_refunded?: number }[]>;

export const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
/** The service's rule for a pharmacy wallet top-up (PaymentService.isPharmacyWalletRecharge), with a well-formed pharmacy id. */
export const PHARMACY_TOPUP_FILTER = {
  context: 'wallet_recharge', payerPharmacyId: { $regex: OBJECT_ID }, 'notes.flow': 'pharmacy_wallet_recharge',
} as const;

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null);
const str = (v: unknown) => (v == null || v === '' ? null : String(v));
const rupees = (paise: number) => Math.round(paise) / 100;
export const recordAmountPaise = (r: { baseAmountPaise?: number; baseAmount?: number }) =>
  r.baseAmountPaise ?? Math.round(Number(r.baseAmount || 0) * 100);
export const recordFinalPaise = (r: { finalAmountPaise?: number; finalAmount?: number }) =>
  r.finalAmountPaise ?? Math.round(Number(r.finalAmount || 0) * 100);

export function razorpayClientFromEnv(): Razorpay | undefined {
  if (!CONFIG.RAZORPAY_KEY_ID || !CONFIG.RAZORPAY_KEY_SECRET) return undefined;
  return new Razorpay({ key_id: CONFIG.RAZORPAY_KEY_ID, key_secret: CONFIG.RAZORPAY_KEY_SECRET });
}
export function orderPaymentsReaderFor(client: { orders: { fetchPayments: (orderId: string) => Promise<unknown> } },
  opts: GatewayReadOptions = {}): OrderPaymentsReader {
  return async (orderId) => {
    const res = (await withTimeout(client.orders.fetchPayments(orderId), opts.timeoutMs ?? 20_000, 'Razorpay order payments lookup')) as
      { items?: { id: string; amount: number | string; status: string; amount_refunded?: number | string }[] };
    if (!Array.isArray(res?.items)) throw new Error('Razorpay order payments answer has no items array');
    return res.items.map((p) => ({ id: p.id, amount: Number(p.amount), status: p.status, amount_refunded: Number(p.amount_refunded || 0) }));
  };
}

/** Read-only: pages through GET /disputes (the SDK has no per-payment lookup); undefined when the client has none. */
// Pages until an empty page (skip advances by the items received), so short pages are not taken as the end; relies on
// Razorpay returning every dispute across the pages. A missing items array, a timeout or the page cap throws.
export function disputesReaderFor(client: { disputes?: { all: (p: { count: number; skip: number }) => Promise<unknown> } },
  opts: GatewayReadOptions = {}): DisputesReader | undefined {
  const api = client.disputes;
  if (!api) return undefined;
  const maxPages = opts.maxPages ?? 200;
  const pause = opts.pageDelayMs ?? 250;
  return async () => {
    const byPayment = new Map<string, DisputeView[]>();
    let skip = 0;
    for (let page = 0; ; page++) {
      if (page >= maxPages) throw new Error(`disputes paging stopped at the ${maxPages}-page cap`);
      if (page > 0 && pause > 0) await new Promise((r) => setTimeout(r, pause));
      const res = (await withTimeout(api.all({ count: 100, skip }), opts.timeoutMs ?? 20_000, 'Razorpay disputes lookup')) as
        { items?: { id: string; payment_id: string; status: string; amount: number | string }[] };
      if (!Array.isArray(res?.items)) throw new Error('Razorpay disputes answer has no items array');
      if (!res.items.length) return byPayment;
      for (const d of res.items) {
        const list = byPayment.get(d.payment_id) ?? [];
        list.push({ id: d.id, status: d.status, amount: rupees(Number(d.amount || 0)) });
        byPayment.set(d.payment_id, list);
      }
      skip += res.items.length;
    }
  };
}

/** Read-only view of an order at Razorpay; `expectedPaise` is the record's payable amount. */
export async function gatewayView(read: OrderPaymentsReader, orderId: string, expectedPaise: number): Promise<GatewayView> {
  const items = await read(orderId);
  const captured = items.find((p) => p.status === 'captured') ?? null;
  return {
    checked: true, statuses: items.map((p) => p.status), capturedPaymentId: captured?.id ?? null,
    capturedAmount: captured ? rupees(Number(captured.amount)) : null,
    amountMatches: captured ? Math.round(Number(captured.amount)) === Math.round(expectedPaise) : null,
    amountRefunded: rupees(items.reduce((a, p) => a + Number(p.amount_refunded || 0), 0)),
    capturedRefunded: rupees(Number(captured?.amount_refunded || 0)),
    otherRefunded: rupees(items.filter((p) => p !== captured).reduce((a, p) => a + Number(p.amount_refunded || 0), 0)),
  };
}

/** Admin manual credits (POST /pharmacy-wallet/topup) to the pharmacy on or after `since`. */
export async function adminTopupsSince(pharmacyId: string, since: Date | undefined): Promise<AdminTopupsSince> {
  const rows = await PharmacyWalletTransactionModel.find({ pharmacyId, referenceType: 'topup', transactionType: 'credit', status: 'completed',
    ...(since ? { createdAt: { $gte: since } } : {}) }).select({ amount: 1, amountPaise: 1 }).lean();
  const paise = rows.reduce((a, t) => a + (t.amountPaise ?? Math.round(Number(t.amount || 0) * 100)), 0);
  return { count: rows.length, amount: rupees(paise) };
}

/** The completed pharmacy wallet credit written for this payment record, if any. */
export function rechargeCreditOf(pharmacyId: string, recordId: string) {
  return PharmacyWalletTransactionModel.findOne({ pharmacyId, referenceType: 'wallet_recharge', referenceId: recordId, status: 'completed' })
    .select({ _id: 1 }).lean();
}

export async function auditS6UncreditedWalletTopups(read?: OrderPaymentsReader, readDisputes?: DisputesReader): Promise<S6TopupAudit> {
  const rows: S6TopupRow[] = [];
  let disputes: Map<string, DisputeView[]> | { unavailable: string } | undefined;
  if (read) {
    if (!readDisputes) disputes = { unavailable: 'no disputes lookup in the gateway client' };
    else {
      try { disputes = await readDisputes(); } catch (error) {
        disputes = { unavailable: 'disputes lookup failed: ' + errorText(error) };
      }
    }
  }
  const gatewayLookupFailed: S6LookupFailure[] = [];
  const failed: { id: string; pharmacyId: string; orderId: string | null; paise: number; finalPaise: number; status: string; createdAt: unknown }[] = [];
  let scanned = 0;
  for await (const r of PaymentRecordModel.find(PHARMACY_TOPUP_FILTER)
    .select({ payerPharmacyId: 1, payerUserId: 1, userId: 1, razorpayOrderId: 1, razorpayPaymentId: 1, baseAmount: 1, baseAmountPaise: 1,
      finalAmount: 1, finalAmountPaise: 1, status: 1, isProcessed: 1, createdAt: 1, paidAt: 1 })
    .sort({ _id: 1 }).lean().cursor()) {
    scanned++;
    const id = String(r._id);
    const pharmacyId = String(r.payerPharmacyId);
    if (r.status === 'failed') {
      failed.push({ id, pharmacyId, orderId: str(r.razorpayOrderId), paise: recordAmountPaise(r), finalPaise: recordFinalPaise(r), status: r.status, createdAt: r.createdAt });
      continue;
    }
    const credit = await rechargeCreditOf(pharmacyId, id);
    let finding: Finding | null = null;
    if (!['paid', 'failed', 'refunded'].includes(r.status)) finding = 'unsettled';
    else if (r.status === 'paid' && !credit) finding = 'paid_not_credited';
    else if (r.status === 'paid' && !r.isProcessed) finding = 'credited_not_processed';
    if (!finding) continue;
    const admin = await adminTopupsSince(pharmacyId, r.createdAt as Date | undefined);
    const row: S6TopupRow = {
      paymentTransactionId: id, pharmacyId, payerUserId: str(r.payerUserId) ?? str(r.userId), razorpayOrderId: str(r.razorpayOrderId),
      razorpayPaymentId: str(r.razorpayPaymentId), amount: rupees(recordAmountPaise(r)), status: r.status, isProcessed: r.isProcessed === true,
      finding, creditTransactionId: credit ? String(credit._id) : null, createdAt: iso(r.createdAt), paidAt: iso(r.paidAt),
      adminTopupsSince: admin, needsCompensationCheck: finding !== 'credited_not_processed' && admin.count > 0,
    };
    if (read) {
      if (!row.razorpayOrderId) row.gateway = { checked: false, reason: 'no gateway order' };
      else {
        try {
          row.gateway = await gatewayView(read, row.razorpayOrderId, recordFinalPaise(r));
          if (row.gateway.amountRefunded > 0 && finding !== 'credited_not_processed') row.needsCompensationCheck = true;
          if (row.gateway.capturedPaymentId && disputes) {
            row.disputes = disputes instanceof Map ? disputes.get(row.gateway.capturedPaymentId) ?? [] : disputes;
            if ((!Array.isArray(row.disputes) || row.disputes.length) && finding !== 'credited_not_processed') row.needsCompensationCheck = true;
          }
        } catch (error) {
          row.gateway = { checked: false, reason: 'gateway lookup failed: ' + errorText(error) };
          // Unknown at the gateway: refunds and disputes could not be checked.
          if (finding !== 'credited_not_processed') row.needsCompensationCheck = true;
          gatewayLookupFailed.push({ paymentTransactionId: id, status: r.status, section: 'rows', reason: row.gateway.reason });
        }
      }
    }
    rows.push(row);
  }

  let failedWithCapture: S6TopupAudit['failedWithCapture'] = 'not checked (no gateway)';
  if (read) {
    failedWithCapture = [];
    for (const f of failed) {
      if (!f.orderId) continue;
      let view: GatewayView;
      try { view = await gatewayView(read, f.orderId, f.finalPaise); } catch (error) {
        gatewayLookupFailed.push({ paymentTransactionId: f.id, status: f.status, section: 'failed', reason: 'gateway lookup failed: ' + errorText(error) });
        continue;
      }
      if (!view.capturedPaymentId) continue;
      failedWithCapture.push({ paymentTransactionId: f.id, pharmacyId: f.pharmacyId, razorpayOrderId: f.orderId, amount: rupees(f.paise), status: f.status,
        createdAt: iso(f.createdAt), gateway: view, review: 'manual: failed record with a captured payment; not handled by the credit script' });
    }
  }

  // Only one of the two pharmacy markers (the service would not credit these to a pharmacy wallet), or a malformed pharmacy id.
  const anomalies: S6Anomaly[] = [];
  for await (const r of PaymentRecordModel.find({ context: 'wallet_recharge',
    $or: [{ 'notes.flow': 'pharmacy_wallet_recharge' }, { payerPharmacyId: { $exists: true, $nin: [null, ''] } }] })
    .select({ payerPharmacyId: 1, 'notes.flow': 1, status: 1, isProcessed: 1, baseAmount: 1, baseAmountPaise: 1, createdAt: 1 }).sort({ _id: 1 }).lean().cursor()) {
    const hasPayerPharmacyId = typeof r.payerPharmacyId === 'string' && r.payerPharmacyId !== '';
    const payerPharmacyIdValid = hasPayerPharmacyId && OBJECT_ID.test(r.payerPharmacyId as string);
    const hasPharmacyFlow = (r.notes as { flow?: unknown } | undefined)?.flow === 'pharmacy_wallet_recharge';
    if (payerPharmacyIdValid && hasPharmacyFlow) continue;
    anomalies.push({ paymentTransactionId: String(r._id), status: r.status, isProcessed: r.isProcessed === true, hasPayerPharmacyId, payerPharmacyIdValid, hasPharmacyFlow,
      amount: rupees(recordAmountPaise(r)), createdAt: iso(r.createdAt) });
  }

  const count = (f: Finding) => rows.filter((r) => r.finding === f).length;
  let capturedNotCredited: number | null = null;
  let capturedNotCreditedAmount: number | null = null;
  if (read) {
    const owed = rows.filter((r) => r.finding !== 'credited_not_processed' && r.gateway?.checked && r.gateway.capturedPaymentId);
    capturedNotCredited = owed.length;
    capturedNotCreditedAmount = rupees(owed.reduce((a, r) => a + Math.round(((r.gateway as GatewayView).capturedAmount ?? 0) * 100), 0));
  }
  return { generatedAt: new Date().toISOString(), gatewayChecked: !!read, scanned, rows, failedWithCapture, gatewayLookupFailed, anomalies,
    summary: { unsettled: count('unsettled'), paid_not_credited: count('paid_not_credited'), credited_not_processed: count('credited_not_processed'),
      needsCompensationCheck: rows.filter((r) => r.needsCompensationCheck).length, capturedNotCredited, capturedNotCreditedAmount,
      failedWithCapture: Array.isArray(failedWithCapture) ? failedWithCapture.length : null, gatewayLookupFailed: gatewayLookupFailed.length,
      anomalies: anomalies.length } };
}

/** Keeps stdout for the JSON report: every console log line (service logs included) goes to stderr. */
export function logsToStderr(): void {
  for (const t of logger.transports) {
    if (t instanceof winston.transports.Console) {
      (t as unknown as { stderrLevels: Record<string, boolean> }).stderrLevels = Object.fromEntries(Object.keys(logger.levels).map((l) => [l, true]));
    }
  }
}

/**
 * Ends the CLI once stdout has drained, with the exit code already set. A gateway request that timed out can leave its
 * socket open and keep Node's event loop alive, so the process is ended explicitly rather than left to drain.
 */
export function exitAfterFlush(): void {
  process.stdout.write('', () => process.exit(process.exitCode ?? 0));
}

/** On any error stdout still carries one JSON document; exit code 1 (set first, then exit after stdout drains). */
export function reportError(error: unknown): void {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: errorCode(error), message: errorText(error) } }) + '\n');
  process.exitCode = 1;
}

async function main() {
  logsToStderr();
  const client = process.argv.includes('--no-gateway') ? undefined : razorpayClientFromEnv();
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    const report = await auditS6UncreditedWalletTopups(client ? orderPaymentsReaderFor(client) : undefined,
      client ? disputesReaderFor(client as never) : undefined);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    const s = report.summary;
    process.stderr.write(`pharmacy top-up records scanned: ${report.scanned}; unsettled: ${s.unsettled}; paid but not credited: ${s.paid_not_credited}; ` +
      `credited but not marked processed: ${s.credited_not_processed}; need a compensation check: ${s.needsCompensationCheck}; ` +
      `anomalies: ${s.anomalies}; ` +
      (report.gatewayChecked ? `captured at Razorpay and not credited: ${s.capturedNotCredited} (Rs ${s.capturedNotCreditedAmount}); ` +
        `failed records with a capture (manual review): ${s.failedWithCapture}; gateway lookups failed: ${s.gatewayLookupFailed}\n`
        : 'gateway not checked (no Razorpay keys in the environment, or --no-gateway)\n'));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(async (error) => { reportError(error); await mongoose.disconnect().catch(() => undefined); })
    .finally(exitAfterFlush);
}
