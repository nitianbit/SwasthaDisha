import cron from 'node-cron';
import { Container } from 'typedi';
import logger from '@/services/logger';
import { assistedFlags } from '@/modules/assisted/flags';
import { runDailyReconciliation } from '@/modules/assisted/reconciliation';
import { runCardRefundsDue } from '@/modules/assisted/cardRefunds';

let started = false;
let running = false;
let refunding = false;
let expiring = false;

/**
 * Assisted booking phase 1a (§8.8): the daily reconciliation at 02:30 India time while ASSISTED_RECONCILIATION_ENABLED is
 * on (read at each run). It stores the day's report, raises alerts and fills unknown gateway fees; it never moves money.
 * Several instances only repeat the same idempotent work.
 */
export function runAssistedSchedulers(): void {
  if (started) return;
  started = true;
  cron.schedule('30 2 * * *', async () => {
    if (running || !assistedFlags.reconciliation()) return;
    running = true;
    try {
      const { PaymentService } = await import('@/modules/payment/services');
      const payments = Container.get(PaymentService) as unknown as { fetchRazorpayPayment: (id: string) => Promise<{ fee?: number }> };
      const report = await runDailyReconciliation(async (id) => (await payments.fetchRazorpayPayment(id)).fee);
      logger.info('Assisted reconciliation', { day: report.day, ok: report.ok, mismatches: report.checks.mismatches.length, feesFilled: report.feesFilled });
    } catch (error) {
      logger.error('Assisted reconciliation failed', { error: error instanceof Error ? error.message : String(error) });
    } finally { running = false; }
  }, { timezone: 'Asia/Kolkata' });
  // Phase 1b: card refunds of assisted bookings (cancellations, late captures) every 5 minutes, whatever the switches
  // say (money owed back is always sent). Fenced per row: several instances only repeat lookups.
  cron.schedule('*/5 * * * *', async () => {
    if (refunding) return;
    refunding = true;
    try {
      // r10e: other captures on settled card orders are found first, then every due refund is pushed forward.
      const { sweepAssistedOtherCaptures } = await import('@/modules/assisted/cardPayments');
      await sweepAssistedOtherCaptures().catch((e) => logger.warn('Assisted other-capture sweep failed', { error: (e as Error)?.message }));
      const out = await runCardRefundsDue();
      if (out.advanced) logger.info('Assisted card refunds', out);
    } catch (error) {
      logger.error('Assisted card refunds failed', { error: error instanceof Error ? error.message : String(error) });
    } finally { refunding = false; }
  });
  // r30 (§25.9.4, DR21): records-access requests past 24 h or whose treating window closed expire, whatever the switch says.
  cron.schedule('*/10 * * * *', async () => {
    if (expiring) return;
    expiring = true;
    try {
      const { expireRecordRequests } = await import('@/modules/recordAccess');
      const expired = await expireRecordRequests();
      if (expired) logger.info('Records-access requests expired', { expired });
    } catch (error) {
      logger.error('Records-access expiry failed', { error: error instanceof Error ? error.message : String(error) });
    } finally { expiring = false; }
  });
}
