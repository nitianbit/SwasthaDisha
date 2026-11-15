import { randomUUID } from 'crypto';
import { Schema, model, Model } from 'mongoose';
import { AppError } from '@/modules/common/types';

interface ILease { key: string; holder: string; until: Date }
const leaseSchema = new Schema<ILease>({
  key: { type: String, required: true },
  holder: { type: String, required: true },
  until: { type: Date, required: true },
}, { versionKey: false });
leaseSchema.index({ key: 1 }, { unique: true });
export const LeaseModel: Model<ILease> = model<ILease>('WorkLease', leaseSchema, 'work_leases');

/**
 * Runs `work` while holding the named lease, so jobs that must not interleave (e.g. two slot expansions of one
 * schedule) run one after the other. The work must read the state it acts on AFTER acquiring the lease: the last one to
 * run then always acts on the latest configuration. A lease left by a crashed holder expires after `ttlMs`.
 */
export async function withLease<T>(key: string, work: () => Promise<T>, opts: { ttlMs?: number; waitMs?: number } = {}): Promise<T> {
  const ttl = opts.ttlMs ?? 120_000;
  const deadline = Date.now() + (opts.waitMs ?? 30_000);
  const holder = randomUUID();
  for (;;) {
    const now = new Date();
    try {
      const got = await LeaseModel.findOneAndUpdate(
        { key, until: { $lte: now } },
        { $set: { holder, until: new Date(now.getTime() + ttl) } },
        { upsert: true, new: true }
      ).lean();
      if (got?.holder === holder) break;
    } catch (e: any) {
      if (e?.code !== 11000) throw e; // held by someone else: wait
    }
    if (Date.now() > deadline) throw new AppError({ status: 503, code: 'WORK_BUSY', message: 'Another update of this schedule is running; try again shortly' });
    await new Promise((r) => setTimeout(r, 40));
  }
  try {
    return await work();
  } finally {
    await LeaseModel.deleteOne({ key, holder });
  }
}
