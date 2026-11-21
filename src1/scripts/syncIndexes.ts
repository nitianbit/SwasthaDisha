// Deploy-time collection/index setup: creates every collection and syncs its
// indexes explicitly so production request handlers (which run with
// autoCreate/autoIndex disabled) never trigger lazy collection or index
// creation. Run with: npm run sync-indexes
//
// NOTE: syncIndexes() also DROPS indexes that are not declared in the schema.
// Any index created manually in Mongo must be added to the model first.
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';
import { findPharmacyEmailDuplicates } from '@/scripts/pharmacyEmailDuplicates';

/**
 * Q16c: checks that must pass before a model's indexes are synced. syncIndexes() drops undeclared indexes BEFORE it
 * builds the declared ones, so for pharmacies a duplicate email would first drop the old `email_1` and only then fail
 * to build `email_unique_1`, leaving the collection with neither. While any duplicate remains the pharmacies
 * collection is not touched at all (the other models still sync) and the run fails with what to do.
 */
export async function preflightFor(model: mongoose.Model<any>): Promise<string | null> {
  if (model.collection.collectionName !== 'pharmacies') return null;
  const exists = (await model.db.db!.listCollections({ name: 'pharmacies' }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) return null;
  const { duplicates } = await findPharmacyEmailDuplicates();
  if (!duplicates.length) return null;
  return `${duplicates.length} pharmacy email(s) are held by more than one pharmacy (an empty email counts too); ` +
    'pharmacies left untouched. Run `npm run migrate:pharmacy-email-duplicates` to list them ' +
    '(`-- --clear-empty` lists empty emails to clear, add `--apply` to clear them), resolve every duplicate with the ' +
    'admin edit, then run sync-indexes again.';
}

/** Creates the collection and syncs one model's indexes, after its preflight; throws when the preflight refuses. */
export async function syncModelIndexes(model: mongoose.Model<any>): Promise<void> {
  const refusal = await preflightFor(model);
  if (refusal) throw new Error(refusal);
  await model.createCollection();
  await model.syncIndexes();
}

const loadAllModels = async (): Promise<void> => {
  const modulesDir = path.join(__dirname, '..', 'modules');
  const moduleDirs = fs.readdirSync(modulesDir, { withFileTypes: true });

  for (const entry of moduleDirs) {
    if (!entry.isDirectory()) continue;
    const modelDir = path.join(modulesDir, entry.name, 'model');
    if (!fs.existsSync(modelDir)) continue;

    const modelFiles = fs
      .readdirSync(modelDir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
    for (const file of modelFiles) {
      await import(path.join(modelDir, file));
    }
  }
};

const run = async (): Promise<void> => {
  await loadAllModels();
  // This script owns collection/index creation. Disable Mongoose's background
  // auto-build during connection so it cannot race with syncIndexes() below.
  await mongoose.connect(CONFIG.MONGODB_URL, {
    autoCreate: false,
    autoIndex: false,
  });

  const failures: string[] = [];
  for (const modelName of mongoose.modelNames().sort()) {
    const model = mongoose.model(modelName);
    try {
      await syncModelIndexes(model);
      console.log(`synced ${modelName} (${model.collection.name})`);
    } catch (error) {
      failures.push(modelName);
      console.error(`FAILED ${modelName}:`, error instanceof Error ? error.message : error);
    }
  }

  await mongoose.disconnect();

  if (failures.length) {
    console.error(`Index sync failed for: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`Index sync complete for ${mongoose.modelNames().length} models`);
};

if (require.main === module) {
  run().catch((error) => {
    console.error('Index sync crashed:', error);
    process.exit(1);
  });
}
