import cron from 'node-cron';
import { Container } from 'typedi';

import { PrescriptionRefundService } from '@/modules/pharmacyOrders/prescriptionRefund';
import logger from '@/services/logger';

let schedulerStarted = false;
let running = false;

/** Every 5 minutes: settle pending wallet refunds and reconcile unattended refunds to card/UPI. */
export function runPrescriptionRefundScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  cron.schedule('*/5 * * * *', async () => {
    if (running) return; // never overlap runs
    running = true;
    try {
      const counts = await Container.get(PrescriptionRefundService).reconcileDue();
      if (counts.wallet || counts.source) logger.info('Prescription refund reconciliation', counts);
    } catch (error) {
      logger.error('Prescription refund reconciliation failed', { error: error instanceof Error ? error.message : String(error) });
    } finally { running = false; }
  });
}
