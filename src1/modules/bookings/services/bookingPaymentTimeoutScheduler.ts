import cron from 'node-cron';
import { Container } from 'typedi';

import { BookingService } from '@/modules/bookings/services';
import logger from '@/services/logger';

let schedulerStarted = false;
let running = false;

/**
 * Every 5 minutes: expire doctor/package bookings left unpaid for 30 minutes (D2), after checking their payments with
 * Razorpay. Releases the slot and any wallet money. Fenced and idempotent: several instances only repeat work.
 */
export function runBookingPaymentTimeoutScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  cron.schedule('*/5 * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const counts = await Container.get(BookingService).expireUnpaidBookings();
      if (counts.examined) logger.info('Booking payment expiry', counts);
    } catch (error) {
      logger.error('Booking payment expiry failed', { error: error instanceof Error ? error.message : String(error) });
    } finally { running = false; }
  });
}
