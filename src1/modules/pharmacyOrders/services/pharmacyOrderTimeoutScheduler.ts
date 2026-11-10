import cron from 'node-cron';
import { Container } from 'typedi';

import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import logger from '@/services/logger';

let schedulerStarted = false;

export function runPharmacyOrderTimeoutScheduler(): void {
  if (schedulerStarted) {
    return;
  }
  schedulerStarted = true;

  cron.schedule('*/5 * * * *', async () => {
    try {
      await Container.get(PharmacyOrderService).abandonStaleUnpaidOrders();
    } catch (error) {
      logger.error('Pharmacy order payment-timeout sweep failed', { error });
    }
  });
}
