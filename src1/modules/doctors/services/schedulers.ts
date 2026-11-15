import cron from 'node-cron';
import logger from '@/services/logger';
import { expandAllDoctorTemplates } from '@/modules/doctors/services/schedule';
import { Container } from 'typedi';
import { InstantConsultService } from '@/modules/doctors/services/instant';

let started = false;
let running = false;
let sweeping = false;

/** Q4: nightly at 01:20 India time, extends every doctor's weekly template to the rolling 30-day window (idempotent). */
export function runDoctorSchedulers(): void {
  if (started) return;
  started = true;
  cron.schedule('20 1 * * *', async () => {
    if (running) return;
    running = true;
    try {
      const inserted = await expandAllDoctorTemplates();
      logger.info('Doctor slots extended', { inserted });
    } catch (error) {
      logger.error('Doctor slot expansion failed', { error: error instanceof Error ? error.message : String(error) });
    } finally { running = false; }
  }, { timezone: 'Asia/Kolkata' });
  // Q4b: every minute — unpaid instant requests expire after their window; held funding nobody accepted is refunded
  // after 30 minutes without customer activity. Both fenced and idempotent.
  cron.schedule('* * * * *', async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const svc = Container.get(InstantConsultService);
      const unpaid = await svc.expireUnpaid();
      const inactive = await svc.refundInactive();
      if (unpaid.examined || inactive.examined) logger.info('Instant consultation sweep', { unpaid, inactive });
    } catch (error) {
      logger.error('Instant consultation sweep failed', { error: error instanceof Error ? error.message : String(error) });
    } finally { sweeping = false; }
  });
}
