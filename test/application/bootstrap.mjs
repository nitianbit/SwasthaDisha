import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { networkInterfaces as addressedNetworkInterfaces } from 'node:os';
import {
  admitNetwork, assertBundle, AUTHORITY_ROLE, ENROLLMENT_ROLE, egressCanaryBlocked, entryKind, PORT_OPERATIONS, ROLE, requireThat,
} from './app-bundle.mjs';

const allowedEnvironment = new Set([
  'PATH', 'NODE_VERSION', 'YARN_VERSION', 'HOME', 'HOSTNAME',
  'NODE_ENV', 'APP_RUN_ID', 'APP_ROLE', 'APP_MANIFEST_SHA',
]);
requireThat(Object.keys(process.env).every((key) => allowedEnvironment.has(key))
  && process.env.NODE_ENV === 'test' && [ROLE, AUTHORITY_ROLE, ENROLLMENT_ROLE].includes(process.env.APP_ROLE),
  'Unexpected application harness environment');
requireThat(process.cwd() === '/workspace' && process.version === 'v22.23.4'
  && process.platform === 'linux' && process.permission, 'Unadmitted application runtime');
requireThat(process.env.APP_ROLE !== ENROLLMENT_ROLE || process.arch === 'arm64', 'Enrollment runtime architecture');
assertBundle('/workspace', { runId: process.env.APP_RUN_ID, manifestSha: process.env.APP_MANIFEST_SHA, role: process.env.APP_ROLE });
// Decision logic is in app-bundle.mjs; this block only binds read-only ports and stderr.
const networkAdmission = admitNetwork({
  list: () => readdirSync('/sys/class/net'),
  entryType: (path) => entryKind(lstatSync(path)),
  readText: (path) => readFileSync(path, 'utf8'),
  addresses: addressedNetworkInterfaces,
  report: (line) => writeSync(2, line),
}, process.env.APP_RUN_ID);

// These precede dynamic scenario imports. They exercise only synthetic paths.
assert.throws(() => readFileSync('/etc/passwd'), { code: 'ERR_ACCESS_DENIED' });
assert.throws(() => writeFileSync('/workspace/unexpected-file', 'synthetic'), { code: 'ERR_ACCESS_DENIED' });
assert.equal(process.permission.has('child'), false);
assert.equal(process.permission.has('worker'), false);
assert.equal(process.permission.has('addon'), false);
writeFileSync('/tmp/permission-canary', 'synthetic');

// RFC 5737 documentation address; never a real provider, with no credentials.
const [egressCanary] = await Promise.allSettled([fetch('http://192.0.2.1:8080/', { signal: AbortSignal.timeout(1500) })]);
const egressBlocked = egressCanaryBlocked(egressCanary);
requireThat(egressBlocked, 'External network canary was not refused as unreachable');

if (process.env.APP_ROLE === AUTHORITY_ROLE) {
  const { runAuthorityScenario } = await import('./authority-scenario.mjs');
  const authority = await runAuthorityScenario();
  const output = JSON.stringify({ runId: process.env.APP_RUN_ID, role: AUTHORITY_ROLE,
    manifestSha: process.env.APP_MANIFEST_SHA, admissionPassed: true, egressBlocked,
    filesystemCanariesPassed: true, databaseMode: 'not-admitted', networkAdmission, authority });
  requireThat(Buffer.byteLength(output) < 16 * 1024, 'Authority result output limit');
  console.log(output);
} else if (process.env.APP_ROLE === ENROLLMENT_ROLE) {
  try {
  const { runEnrollmentScenario } = await import('./scenario.mjs');
  const enrollment = await runEnrollmentScenario();
  const output = JSON.stringify({ runId: process.env.APP_RUN_ID, role: ENROLLMENT_ROLE,
    manifestSha: process.env.APP_MANIFEST_SHA, admissionPassed: true, egressBlocked,
    filesystemCanariesPassed: true, databaseMode: 'not-admitted', networkAdmission, enrollment });
  requireThat(Buffer.byteLength(output) < 16 * 1024, 'Enrollment result output limit'); console.log(output);
  } catch (error) {
    // No assertion diff, token, code, address or row body escapes the private fixture.
    const message = typeof error?.message === 'string' && /^(?:PREDICATE:[A-Za-z0-9_.:-]{1,80}|ENROLLMENT_CASE_FAILED:C3-[A-Za-z0-9_.-]{1,80})$/.test(error.message)
      ? error.message : 'ENROLLMENT_SERVICE_FAILED';
    throw new Error(message);
  }
} else {
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
  databaseMode: 'not-admitted', networkAdmission, calls, scenario,
}));
}
