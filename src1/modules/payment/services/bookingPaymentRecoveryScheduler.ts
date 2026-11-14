import cron from 'node-cron';
import { Container } from 'typedi';

import { PaymentService } from '@/modules/payment/services';
import logger from '@/services/logger';

let schedulerStarted = false;
let running = false;

/**
 * Every 5 minutes: settle booking payments whose browser confirmation never arrived (W3b). There is no Razorpay
 * webhook, so without this a payment captured after the customer left stays unapplied (or, for a booking already paid
 * through another attempt, unreturned). Fenced and idempotent: several instances only repeat work.
 */
export function runBookingPaymentRecoveryScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  cron.schedule('*/5 * * * *', async () => {
    if (running) return; // never overlap runs
    running = true;
    try {
      const counts = await Container.get(PaymentService).sweepUnsettledBookingPayments();
      if (counts.checked) logger.info('Booking payment recovery', counts);
    } catch (error) {
      logger.error('Booking payment recovery failed', { error: error instanceof Error ? error.message : String(error) });
    } finally { running = false; }
  });
}
