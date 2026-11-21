import type { Model } from 'mongoose';
import { AppError } from '@/modules/common/types';

/**
 * Indexes found built, by collection and key, with the time the finding stops counting. Q16c: a pass is trusted for at
 * most INDEX_CHECK_TTL_MS (an index dropped later is noticed within that time); a missing one is looked up again next
 * time (sync-indexes may have run).
 */
const ready = new Map<string, number>();
export const INDEX_CHECK_TTL_MS = 5 * 60 * 1000;
/** The clock the cache reads (tests move it). */
export const indexCheckClock = { now: (): number => Date.now() };

/**
 * Q15 review: a keyed exactly-once command relies on a unique index. Before the first keyed call (per process), check
 * that it exists as the schema declares it (keys, unique, partial filter); if the collection or the index is missing (sync-indexes has not run), refuse with 503
 * INDEXES_OUTDATED rather than risk doing the work twice. Fails closed: a failed check also refuses.
 */
export async function assertUniqueIndex(model: Model<any>, keys: Record<string, 1>): Promise<void> {
  const keyJson = JSON.stringify(keys);
  const id = `${model.collection.collectionName}|${keyJson}`;
  const until = ready.get(id);
  if (until !== undefined && indexCheckClock.now() < until) return;
  ready.delete(id);
  // Q15 re-review: the index must be the one the schema declares — unique, the same keys and EXACTLY the same partial
  // filter (none when none is declared). A narrower partial index would leave some keyed writes unguarded.
  const declared = (model.schema.indexes() as unknown as [Record<string, unknown>, { unique?: boolean; partialFilterExpression?: unknown }?][])
    .find(([fields]) => JSON.stringify(fields) === keyJson);
  if (!declared || declared[1]?.unique !== true) throw new Error(`${model.modelName} declares no unique index ${keyJson}`);
  const filterJson = JSON.stringify(declared[1]?.partialFilterExpression ?? null);
  let found = false;
  try {
    const indexes = await model.collection.listIndexes().toArray();
    found = indexes.some((ix) => ix.unique === true && JSON.stringify(ix.key) === keyJson &&
      JSON.stringify(ix.partialFilterExpression ?? null) === filterJson);
  } catch {
    found = false; // e.g. NamespaceNotFound: the collection was never created
  }
  if (!found) {
    console.warn(`${model.collection.collectionName} lacks the unique index ${keyJson}; run npm run sync-indexes`);
    throw new AppError({ status: 503, code: 'INDEXES_OUTDATED', message: 'The database needs an update (sync-indexes) before this can be used' });
  }
  ready.set(id, indexCheckClock.now() + INDEX_CHECK_TTL_MS);
}

/** Tests only: forget what was found. */
export function resetIndexChecks(): void { ready.clear(); }

/** Q15 review: raised inside a keyed transaction attempt that finds its key already recorded (answered as a replay). */
export class KeyAlreadyUsed extends Error {
  constructor() { super('request key already used'); }
}
