import cron from 'node-cron';
import { Container } from 'typedi';
import logger from '@/services/logger';
import { LabBookingService, registerLabBookingPayments } from '@/modules/partners/services/labBookings';
import { expandAllRolling } from '@/modules/partners/services/slots';

let started = false;
let expiring = false;
let expanding = false;

/**
 * Q3: registers the 'lab_booking' payment context, then every 5 minutes expires partner-lab bookings left unpaid past
 * their 30-minute window (after checking their payments with Razorpay), and every night at 01:10 extends each branch's
 * slots to the rolling 30-day window. Both are fenced and idempotent, so several instances only repeat work.
 */
export function runPartnerLabSchedulers(): void {
  if (started) return;
  started = true;
  registerLabBookingPayments();
  cron.schedule('*/5 * * * *', async () => {
    if (expiring) return;
    expiring = true;
    try {
      const counts = await Container.get(LabBookingService).expireDue();
      if (counts.examined) logger.info('Partner lab booking payment expiry', counts);
    } catch (error) {
      logger.error('Partner lab booking expiry failed', { error: error instanceof Error ? error.message : String(error) });
    } finally { expiring = false; }
  });
  cron.schedule('10 1 * * *', async () => {
    if (expanding) return;
    expanding = true;
    try {
      const inserted = await expandAllRolling();
      logger.info('Partner lab slots extended', { inserted });
    } catch (error) {
      logger.error('Partner lab slot expansion failed', { error: error instanceof Error ? error.message : String(error) });
    } finally { expanding = false; }
  }, { timezone: 'Asia/Kolkata' });
}
