import type { Model } from 'mongoose';
import { AppError } from '@/modules/common/types';

/**
 * S5 review: an audit collection written by an admin command must have been created by sync-indexes (production runs
 * with autoCreate/autoIndex off, and a collection created implicitly inside a transaction fails before MongoDB 4.4).
 * Checks that the collection exists with the declared (non-unique) index `keys`; otherwise refuses with 503
 * INDEXES_OUTDATED before any work is done. Fails closed: a failed check also refuses. Not cached (admin commands only).
 * For a unique key, use assertUniqueIndex (requiredIndex.ts).
 */
export async function assertIndexBuilt(model: Model<any>, keys: Record<string, 1>): Promise<void> {
  const keyJson = JSON.stringify(keys);
  const declared = (model.schema.indexes() as unknown as [Record<string, unknown>][]).some(([fields]) => JSON.stringify(fields) === keyJson);
  if (!declared) throw new Error(`${model.modelName} declares no index ${keyJson}`);
  let found = false;
  try {
    found = (await model.collection.listIndexes().toArray()).some((ix) => JSON.stringify(ix.key) === keyJson);
  } catch {
    found = false; // NamespaceNotFound: the collection was never created
  }
  if (!found) {
    console.warn(`${model.collection.collectionName} lacks the index ${keyJson}; run npm run sync-indexes`);
    throw new AppError({ status: 503, code: 'INDEXES_OUTDATED', message: 'The database needs an update (sync-indexes) before this can be used' });
  }
}
