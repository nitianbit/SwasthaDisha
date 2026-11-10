import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { networkInterfaces as addressedNetworkInterfaces } from 'node:os';
import { assertBundle, captureNetworkDiagnostics, PORT_OPERATIONS, ROLE, requireThat } from './app-bundle.mjs';

const allowedEnvironment = new Set([
  'PATH', 'NODE_VERSION', 'YARN_VERSION', 'HOME', 'HOSTNAME',
  'NODE_ENV', 'APP_RUN_ID', 'APP_ROLE', 'APP_MANIFEST_SHA',
]);
requireThat(Object.keys(process.env).every((key) => allowedEnvironment.has(key))
  && process.env.NODE_ENV === 'test' && process.env.APP_ROLE === ROLE,
  'Unexpected application harness environment');
requireThat(process.cwd() === '/workspace' && process.version === 'v22.23.4'
  && process.platform === 'linux' && process.permission, 'Unadmitted application runtime');
assertBundle('/workspace', { runId: process.env.APP_RUN_ID, manifestSha: process.env.APP_MANIFEST_SHA });
const networkInterfaces = readdirSync('/sys/class/net').sort();
if (networkInterfaces.length !== 1 || networkInterfaces[0] !== 'lo') {
  const diagnostics = captureNetworkDiagnostics(networkInterfaces, {
    entryType(path) {
      const entry = lstatSync(path);
      return entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other';
    },
    readText: (path) => readFileSync(path, 'utf8'),
    addresses: addressedNetworkInterfaces,
  });
  const record = JSON.stringify({ ...diagnostics, runId: process.env.APP_RUN_ID });
  requireThat(Buffer.byteLength(record) <= 8192, 'Network diagnostic output limit exceeded');
  writeSync(2, record + '\n');
}
assert.deepEqual(networkInterfaces, ['lo']);

// These precede dynamic scenario imports. They exercise only synthetic paths.
assert.throws(() => readFileSync('/etc/passwd'), { code: 'ERR_ACCESS_DENIED' });
assert.throws(() => writeFileSync('/workspace/unexpected-file', 'synthetic'), { code: 'ERR_ACCESS_DENIED' });
assert.equal(process.permission.has('child'), false);
assert.equal(process.permission.has('worker'), false);
assert.equal(process.permission.has('addon'), false);
writeFileSync('/tmp/permission-canary', 'synthetic');

let egressBlocked = false;
try {
  // RFC 5737 documentation address; never a real provider, with no credentials.
  await fetch('http://192.0.2.1:8080/', { signal: AbortSignal.timeout(1500) });
} catch { egressBlocked = true; }
requireThat(egressBlocked, 'External network canary unexpectedly succeeded');

const { createRecordingPorts } = await import('./app-ports.mjs');
const ports = createRecordingPorts();
const { runScenario } = await import('./scenario.mjs');
const scenario = await runScenario(ports);
const calls = ports.snapshot();
assert.deepEqual(calls.map((call) => call.port).sort(), Object.keys(PORT_OPERATIONS).sort());
requireThat(calls.every((call) => call.effect === false && call.status === 'recorded'), 'Provider fixture reported an effect');
console.log(JSON.stringify({
  runId: process.env.APP_RUN_ID, role: ROLE, manifestSha: process.env.APP_MANIFEST_SHA,
  admissionPassed: true, egressBlocked, filesystemCanariesPassed: true,
  databaseMode: 'not-admitted', networkInterfaces, calls, scenario,
}));
