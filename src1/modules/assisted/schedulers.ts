import cron from 'node-cron';
import { Container } from 'typedi';
import logger from '@/services/logger';
import { assistedFlags } from '@/modules/assisted/flags';
import { runDailyReconciliation } from '@/modules/assisted/reconciliation';

let started = false;
let running = false;

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
}
