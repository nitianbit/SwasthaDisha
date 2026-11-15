import cron from 'node-cron';
import logger from '@/services/logger';
import { expandAllDoctorTemplates } from '@/modules/doctors/services/schedule';

let started = false;
let running = false;

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
}
