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
      await model.createCollection();
      await model.syncIndexes();
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

run().catch((error) => {
  console.error('Index sync crashed:', error);
  process.exit(1);
});
