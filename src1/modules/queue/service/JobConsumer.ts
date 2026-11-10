import { Job } from '@/modules/queue/model';
import { JobPayload } from '@/modules/queue/types';
import TaskQueue from '@/modules/queue/service/TaskQueue';

export default abstract class JobConsumer {
  public readonly type: string;
  private running: boolean;

  constructor(type: string) {
    this.type = type;
    this.running = false;
    TaskQueue.consumerMap.set(type, this);
  }

  async init(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const now = Math.floor(Date.now() / 1000);
      const job = await Job.findOneAndUpdate(
        { consumer: this.type, processAfter: { $lte: now } },
        { $set: { processAfter: now + 120 } },
        { sort: { processAfter: 1 } }
      );

      if (!job) return;

      const shouldDelete = await this.consume(job.payload);
      if (shouldDelete) {
        await Job.deleteOne({ _id: job._id });
      }
    } finally {
      this.running = false;
    }
  }

  abstract consume(payload: JobPayload): Promise<boolean>;
}
