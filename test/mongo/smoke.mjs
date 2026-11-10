import { readFileSync } from 'node:fs';
import { createMongoFixture } from '../foundation/mongo-fixture.mjs';

if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.execArgv.length) {
  throw new Error('Use a clean Node invocation without preload flags');
}
if (process.argv.length !== 3) throw new Error('Provide only the explicit local Unix Docker endpoint');
const { image } = JSON.parse(readFileSync(new URL('./image.json', import.meta.url), 'utf8'));
const fixture = createMongoFixture({ endpoint: process.argv[2], image });
let primaryError;
let evidence;
try {
  await fixture.start();
  evidence = fixture.probeTransactions();
} catch (error) {
  primaryError = error;
}
try {
  fixture.dispose();
} catch (error) {
  console.error(JSON.stringify({ containerId: fixture.id, runId: fixture.runId, image, cleanupAcknowledged: false }));
  if (primaryError) throw new AggregateError([primaryError, error], 'Fixture probe and cleanup failed');
  throw error;
}
if (primaryError) {
  console.error(JSON.stringify({ containerId: fixture.id, runId: fixture.runId, image, cleanupAcknowledged: true }));
  throw primaryError;
}
console.log(JSON.stringify({ ...evidence, containerId: fixture.id, runId: fixture.runId, image, cleanupAcknowledged: true }, null, 2));
