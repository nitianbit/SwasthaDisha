import cron from 'node-cron';
import { Container } from 'typedi';
import { LowStockAlertService } from '@/modules/pharmacyInventory/lowStockAlerts';
import logger from '@/services/logger';

let started = false;
let running = false;

/** Every 15 minutes: notify pharmacies of items that dropped below their reorder threshold (P7c). */
export function runLowStockAlertScheduler(): void {
  if (started) return;
  started = true;
  cron.schedule('*/15 * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const r = await Container.get(LowStockAlertService).sweep();
      if (r.notified || r.cleared) logger.info('Low-stock alert sweep', r);
    } catch (error) {
      logger.error('Low-stock alert sweep failed', { error: error instanceof Error ? error.message : String(error) });
    } finally { running = false; }
  });
}
