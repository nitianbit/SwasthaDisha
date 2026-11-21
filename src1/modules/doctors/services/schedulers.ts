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
    try { await runInstantSweeps(Container.get(InstantConsultService)); }
    finally { sweeping = false; }
  });
}

/**
 * Q16a: the two instant sweeps run independently — the inactivity refund runs even when the unpaid expiry throws
 * (and the other way round); each failure is logged without patient data.
 */
export async function runInstantSweeps(svc: Pick<InstantConsultService, 'expireUnpaid' | 'refundInactive'>, now = new Date()) {
  const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let unpaid: Awaited<ReturnType<InstantConsultService['expireUnpaid']>> | null = null;
  let inactive: Awaited<ReturnType<InstantConsultService['refundInactive']>> | null = null;
  try { unpaid = await svc.expireUnpaid(now); }
  catch (error) { logger.error('Instant unpaid-expiry sweep failed', { error: errorOf(error) }); }
  try { inactive = await svc.refundInactive(now); }
  catch (error) { logger.error('Instant inactivity-refund sweep failed', { error: errorOf(error) }); }
  if (unpaid?.examined || inactive?.examined) logger.info('Instant consultation sweep', { unpaid, inactive });
  return { unpaid, inactive };
}
