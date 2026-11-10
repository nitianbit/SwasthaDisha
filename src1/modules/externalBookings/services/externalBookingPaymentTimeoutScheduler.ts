import cron from 'node-cron';
import { Container } from 'typedi';

import { ExternalBookingService } from '@/modules/externalBookings/services';
import logger from '@/services/logger';

let schedulerStarted = false;

/** Every 5 minutes: cancel LabStack + DB for external bookings stuck in unpaid pending > 30 min. */
export function runExternalBookingPaymentTimeoutScheduler(): void {
  if (schedulerStarted) {
    return;
  }
  schedulerStarted = true;

  cron.schedule('*/5 * * * *', async () => {
    try {
      await Container.get(ExternalBookingService).cancelStaleUnpaidExternalBookings();
    } catch (error) {
      logger.error('External booking payment-timeout sweep failed', { error });
    }
  });
}
