import { createAuthorityFixture } from './app-container.mjs';

if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.execArgv.length || process.argv.length !== 3) {
  throw new Error('Use a clean Node invocation with only the explicit local Docker Unix endpoint');
}
// REVIEW GATE: this fixed authority role requires fresh exact source and one-invocation approval.
const fixture = createAuthorityFixture({ endpoint: process.argv[2] });
let result;
let failure;
let failed = false;
try { result = fixture.run(); } catch (error) { failed = true; failure = error; }
try { fixture.dispose(); } catch (cleanupError) {
  console.error(JSON.stringify({ id: fixture.id, runId: fixture.runId, directory: fixture.directory, cleanupAcknowledged: false }));
  throw failed ? new AggregateError([failure, cleanupError], 'Application probe and cleanup failed') : cleanupError;
}
if (failed) {
  console.error(JSON.stringify({ id: fixture.id, runId: fixture.runId, directory: fixture.directory, cleanupAcknowledged: true }));
  throw failure;
}
console.log(JSON.stringify({ ...result, containerId: fixture.id, directory: fixture.directory,
  image: fixture.image, cleanupAcknowledged: true }, null, 2));
