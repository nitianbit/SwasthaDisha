import cron from 'node-cron';
import { Container } from 'typedi';
import { InventoryImportService } from '@/modules/pharmacyInventoryImports/services';
import logger from '@/services/logger';

let started = false;

export function runInventoryImportCleanupScheduler(): void {
  if (started) return;
  started = true;

  cron.schedule('17 2 * * *', async () => {
    try {
      const cleaned = await Container.get(InventoryImportService).cleanupExpiredSourceFiles(7);
      if (cleaned > 0) {
        logger.info('Cleaned expired pharmacy inventory import files', { cleaned });
      }
    } catch (error) {
      logger.error('Failed to clean expired pharmacy inventory import files', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
