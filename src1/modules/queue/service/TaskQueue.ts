import { Job } from '@/modules/queue/model';
import JobConsumer from '@/modules/queue/service/JobConsumer';
import { JobPayload } from '@/modules/queue/types';
import cron from 'node-cron';

export default class TaskQueue {
  static consumerMap: Map<string, JobConsumer> = new Map();
  private static schedulerStarted = false;

  private static async process(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const consumers: string[] = await Job.distinct('consumer', {
      processAfter: { $lte: now },
    });

    for (const consumerType of consumers) {
      const consumer = TaskQueue.consumerMap.get(consumerType);
      if (consumer) {
        await consumer.init();
      }
    }
  }

  static runScheduler(): void {
    if (TaskQueue.schedulerStarted) return;
    TaskQueue.schedulerStarted = true;

    cron.schedule('*/10 * * * * *', async () => {
      try {
        await TaskQueue.process();
      } catch (_error) {
        // Keep scheduler alive even if one cycle fails.
      }
    });
  }

  static async publishNow(consumerType: string, payload: JobPayload): Promise<void> {
    await Job.create({
      consumer: consumerType,
      processAfter: Math.floor(Date.now() / 1000),
      payload,
    });

    const consumer = TaskQueue.consumerMap.get(consumerType);
    if (consumer) {
      await consumer.init();
    }
  }

  static async publishUniqueNow(
    consumerType: string,
    uniqueId: string,
    payload: JobPayload
  ): Promise<void> {
    await Job.findOneAndUpdate(
      { consumer: consumerType, uniqueId },
      {
        consumer: consumerType,
        processAfter: Math.floor(Date.now() / 1000),
        payload,
        uniqueId,
      },
      { upsert: true }
    );

    const consumer = TaskQueue.consumerMap.get(consumerType);
    if (consumer) {
      await consumer.init();
    }
  }

  // Backward-compatible alias used in older code.
  static async publisUniqueNow(
    consumerType: string,
    uniqueId: string,
    payload: JobPayload
  ): Promise<void> {
    await TaskQueue.publishUniqueNow(consumerType, uniqueId, payload);
  }

  static async publishLater(
    consumerType: string,
    processAfter: number,
    payload: JobPayload
  ): Promise<void> {
    await Job.create({ consumer: consumerType, processAfter, payload });
  }

  static async publishUniqueLater(
    consumerType: string,
    uniqueId: string,
    processAfter: number,
    payload: JobPayload
  ): Promise<void> {
    await Job.findOneAndUpdate(
      { consumer: consumerType, uniqueId },
      { consumer: consumerType, processAfter, payload, uniqueId },
      { upsert: true }
    );
  }

  static async deletePublishings(consumerType: string, uniqueIds: string[]): Promise<void> {
    if (!Array.isArray(uniqueIds) || uniqueIds.length === 0) return;

    await Job.deleteMany({
      consumer: consumerType,
      uniqueId: { $in: uniqueIds },
    });
  }

  static async deleteUniqueJob(consumerType: string, uniqueId: string): Promise<void> {
    await Job.deleteOne({ consumer: consumerType, uniqueId });
  }
}
