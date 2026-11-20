import type { Model } from 'mongoose';
import { AppError } from '@/modules/common/types';

/** Indexes found built, by collection and key; a missing one is looked up again next time (sync-indexes may have run). */
const ready = new Set<string>();

/**
 * Q15 review: a keyed exactly-once command relies on a unique index. Before the first keyed call (per process), check
 * that it exists; if the collection or the index is missing (sync-indexes has not run), refuse with 503
 * INDEXES_OUTDATED rather than risk doing the work twice. Fails closed: a failed check also refuses.
 */
export async function assertUniqueIndex(model: Model<any>, keys: Record<string, 1>): Promise<void> {
  const keyJson = JSON.stringify(keys);
  const id = `${model.collection.collectionName}|${keyJson}`;
  if (ready.has(id)) return;
  let found = false;
  try {
    const indexes = await model.collection.listIndexes().toArray();
    found = indexes.some((ix) => ix.unique === true && JSON.stringify(ix.key) === keyJson);
  } catch {
    found = false; // e.g. NamespaceNotFound: the collection was never created
  }
  if (!found) {
    console.warn(`${model.collection.collectionName} lacks the unique index ${keyJson}; run npm run sync-indexes`);
    throw new AppError({ status: 503, code: 'INDEXES_OUTDATED', message: 'The database needs an update (sync-indexes) before this can be used' });
  }
  ready.add(id);
}

/** Tests only: forget what was found. */
export function resetIndexChecks(): void { ready.clear(); }

/** Q15 review: raised inside a keyed transaction attempt that finds its key already recorded (answered as a replay). */
export class KeyAlreadyUsed extends Error {
  constructor() { super('request key already used'); }
}
