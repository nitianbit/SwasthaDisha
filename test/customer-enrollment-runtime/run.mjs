// No source/application import precedes exact approval; controller imports only inert public profiles.
import { readFileSync, lstatSync, openSync, closeSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEnrollmentFixture } from '../application/app-container.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const check = (ok, why) => { if (!ok) throw new Error(why); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function regular(path) { const s = lstatSync(path); check(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size < 16 * 1024 * 1024, 'Regular bounded input'); return readFileSync(path); }
check(process.argv.length === 2 && process.execArgv.length === 0 && Object.keys(process.env).every(k => ['PATH', 'TMPDIR', 'LANG', 'LC_CTYPE'].includes(k))
  && process.env.PATH === '/usr/bin:/bin', 'Fixed clean run invocation');
const profile = JSON.parse(regular(new URL('profile.json', import.meta.url)));
check(sha(readFileSync(profile.nodeTool)) === profile.nodeToolSha256 && process.execPath === profile.nodeTool, 'Reviewed host Node tool');
const descriptorPath = '/private/tmp/sd-customer-enrollment-build.json';
const receiptPath = '/private/tmp/sd-customer-enrollment-run-approval.json';
const descriptorBytes = regular(descriptorPath); const descriptor = JSON.parse(descriptorBytes);
const receiptStat = lstatSync(receiptPath); check(receiptStat.uid === process.getuid() && (receiptStat.mode & 0o777) === 0o600, 'Private run receipt');
const receiptBytes = regular(receiptPath); const receipt = JSON.parse(receiptBytes);
const git = spawnSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'], { cwd: root, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
check(git.status === 0 && !git.error && !git.signal, 'Source commit observation');
const expected = { schema: 'SD-ENROLLMENT-RUN-APPROVAL-1', decision: 'APPROVE_ONE_ENROLLMENT_SERVICE_RUN_ONLY', sourceRoot: root,
  sourceCommit: git.stdout.trim(), inputs: descriptor.inputs, descriptorSha256: sha(descriptorBytes), endpoint: profile.endpoint,
  engineId: profile.engineId, image: profile.nodeImage };
check(Object.keys(receipt).sort().join() === Object.keys({ ...expected, nonce: '', reviewers: [] }).sort().join()
  && Object.entries(expected).every(([k, v]) => JSON.stringify(receipt[k]) === JSON.stringify(v)), 'Exact one-run receipt binding');
check(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(receipt.nonce), 'Run nonce');
check(Array.isArray(receipt.reviewers) && receipt.reviewers.length === 2 && new Set(receipt.reviewers.map(r => r.agent)).size === 2
  && receipt.reviewers.every(r => Object.keys(r).sort().join() === 'agent,decision' && /^\/root(?:\/[A-Za-z0-9_]+)*$/.test(r.agent)
    && r.agent !== '/root/milestone_composition_r9' && r.decision === expected.decision), 'Two actual nonauthor run decisions');
for (const [name, digest] of Object.entries(descriptor.inputs)) check(sha(regular(root + '/' + name)) === digest, 'Selected source drift');
// Consume approval before controller allocation/Docker observation. No retry on failure.
const once = openSync('/private/tmp/sd-customer-enrollment-run-' + receipt.nonce + '.once', 'wx', 0o600);
try { writeSync(once, JSON.stringify({ receiptSha256: sha(receiptBytes), sourceCommit: expected.sourceCommit })); } finally { closeSync(once); }
const fixture = createEnrollmentFixture({ endpoint: profile.endpoint });
let result; let failure;
try { result = fixture.run(); } catch (error) { failure = error; }
try { fixture.dispose(); } catch (cleanupError) {
  console.error(JSON.stringify({ id: fixture.id, runId: fixture.runId, directory: fixture.directory, cleanupAcknowledged: false }));
  throw failure ? new AggregateError([failure, cleanupError], 'Enrollment run and cleanup failed') : cleanupError;
}
if (failure) {
  console.error(JSON.stringify({ id: fixture.id, runId: fixture.runId, directory: fixture.directory, cleanupAcknowledged: true })); throw failure;
}
console.log(JSON.stringify({ ...result, containerId: fixture.id, directory: fixture.directory, image: fixture.image, cleanupAcknowledged: true }));
