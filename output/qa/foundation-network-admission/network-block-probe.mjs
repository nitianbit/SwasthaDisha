// Extracted-block probe for the bootstrap network-admission and egress-canary wiring.
// All paths resolve from this file's own checkout. Only two extracted blocks are compiled, with
// fake read-only ports and a fake fetch; bootstrap itself, its scenario and application code are
// never evaluated, and no Docker, network or provider operation is performed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../../', import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bootstrapBytes = readFileSync(new URL('test/application/bootstrap.mjs', root));
const bundleBytes = readFileSync(new URL('test/application/app-bundle.mjs', root));
const source = bootstrapBytes.toString('utf8');
const { admitNetwork, egressCanaryBlocked, entryKind, evaluateNetworkAdmission, requireThat } =
  await import(new URL('test/application/app-bundle.mjs', root));

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.ok(start >= 0 && source.indexOf(startMarker, start + 1) < 0 && end > start, 'marker ' + startMarker);
  return source.slice(start, end);
}
const networkBlock = extract('const networkAdmission = admitNetwork({', '// These precede dynamic scenario imports.');
assert.ok(networkBlock.endsWith('}, process.env.APP_RUN_ID);\n\n'));
const canaryBlock = extract('// RFC 5737 documentation address', 'const { createRecordingPorts }');
assert.ok(!source.includes('captureNetworkDiagnostics') && !source.includes("assert.deepEqual(networkInterfaces"));
assert.ok(source.includes("databaseMode: 'not-admitted', networkAdmission, calls, scenario,"));

// The exact measured record; its hash must match the unit-test literal (P1).
const evidence = JSON.parse(readFileSync(new URL('output/qa/parallel-foundation/verification.json', root), 'utf8'));
const { runId: measuredRunId, ...measured } = evidence.diagnostic_record.record;
const MEASURED_RECORD_SHA256 = '9c2f54c44a0f5398ff65629f2e5071fe956b2aa8d42bc91257864edd2dffc473';
assert.equal(sha256(JSON.stringify(measured)), MEASURED_RECORD_SHA256);
assert.match(measuredRunId, /^[a-f0-9-]{36}$/);

const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const clone = (value) => JSON.parse(JSON.stringify(value));
const active = clone(measured);
active.entries.splice(2, 0, { name: 'eth0', kind: 'symlink', flags: '0x1003', operstate: 'up', type: '1' });
active.addressedInterfaces.push({ name: 'eth0', addresses: [{ address: '172.17.0.2', family: 'IPv4', internal: false }] });
const loopbackOnly = { ...clone(measured), entries: measured.entries.filter((row) => row.name === 'lo') };
const addressedDown = clone(measured);
addressedDown.addressedInterfaces.push({ name: 'tunl0', addresses: [{ address: '10.0.0.1', family: 'IPv4', internal: false }] });

function runNetworkBlock(mode, record) {
  const state = { lists: 0, reads: 0, records: [], continued: false };
  const rows = new Map((record?.entries ?? []).map((row) => [row.name, row]));
  const raise = (code) => { throw Object.assign(new Error('synthetic'), { code }); };
  const value = (field) => (typeof field === 'string' ? field : raise(field.unavailable));
  const ports = {
    admitNetwork, entryKind,
    readdirSync(path) {
      state.lists++;
      assert.equal(path, '/sys/class/net');
      if (mode === 'readdir-throws') raise('EACCES');
      return [...rows.keys()].reverse();
    },
    lstatSync(path) {
      state.reads++;
      const kind = value(rows.get(path.slice('/sys/class/net/'.length)).kind);
      return { isSymbolicLink: () => kind === 'symlink', isFile: () => kind === 'file', isDirectory: () => kind === 'directory' };
    },
    readFileSync(path, encoding) {
      state.reads++;
      assert.equal(encoding, 'utf8');
      const [, name, field] = /^\/sys\/class\/net\/([^/]+)\/(flags|operstate|type)$/.exec(path);
      return value(rows.get(name)[field]) + '\n';
    },
    addressedNetworkInterfaces: () => Object.fromEntries(record.addressedInterfaces.map((row) => [row.name, row.addresses])),
    writeSync(fd, line) {
      assert.equal(fd, 2);
      assert.ok(typeof line === 'string' && line.endsWith('\n') && Buffer.byteLength(line) <= 8193);
      state.records.push(JSON.parse(line));
    },
    process: { env: { APP_RUN_ID: runId } },
  };
  let summary;
  let error;
  try {
    summary = vm.compileFunction(networkBlock + '\nreturn networkAdmission;\n', Object.keys(ports))(...Object.values(ports));
    state.continued = true;
  } catch (cause) { error = cause; }
  return { state, summary, error };
}

const results = [];
{
  const { state, summary } = runNetworkBlock('measured', measured);
  assert.ok(state.continued && state.records.length === 0 && state.reads === 44);
  assert.equal(JSON.stringify(summary), JSON.stringify(evaluateNetworkAdmission(measured)));
  results.push({ case: 'B1 exact measured record continues', continued: true, stderrRecords: 0, metadataReads: state.reads,
    downDevices: summary.downDevices.length, controlFiles: summary.controlFiles });
}
{
  const { state, error } = runNetworkBlock('active', active);
  assert.ok(!state.continued && /Network admission rejected/.test(error?.message));
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].tag, 'APP-NET-DIAG-1');
  assert.equal(state.records[0].runId, runId);
  results.push({ case: 'B2 active eth0 reports once then throws', continued: false, stderrRecords: 1, error: error.message });
}
{
  const { state, error } = runNetworkBlock('readdir-throws', measured);
  assert.ok(!state.continued && error?.code === 'EACCES' && state.records.length === 0 && state.reads === 0);
  results.push({ case: 'B3 readdir failure reports nothing', continued: false, stderrRecords: 0, metadataReads: 0 });
}
{
  const { state, summary } = runNetworkBlock('loopback', loopbackOnly);
  assert.ok(state.continued && state.records.length === 0 && summary.downDevices.length === 0);
  results.push({ case: "B4 ['lo'] continues", continued: true, stderrRecords: 0, metadataReads: state.reads });
}
{
  // Pins bootstrap's addresses binding: only the OS address port can supply this tunl0 row.
  const { state, error } = runNetworkBlock('addressed-down', addressedDown);
  assert.ok(!state.continued && /Network admission rejected: addressed interfaces/.test(error?.message));
  assert.equal(state.records.length, 1);
  assert.ok(state.records[0].addressedInterfaces.some((row) => row.name === 'tunl0'));
  results.push({ case: 'B5 addressed down tunl0 reports once then throws', continued: false, stderrRecords: 1, error: error.message });
}

async function runCanaryBlock(outcome) {
  const calls = [];
  const fakeFetch = (url, options) => {
    calls.push({ url, hasSignal: options?.signal instanceof AbortSignal });
    return outcome();
  };
  const parameters = { fetch: fakeFetch, AbortSignal, egressCanaryBlocked, requireThat, Promise };
  const body = 'return (async () => {\n' + canaryBlock + '\nreturn egressBlocked;\n})();\n';
  try {
    const egressBlocked = await vm.compileFunction(body, Object.keys(parameters))(...Object.values(parameters));
    return { calls, continued: true, egressBlocked };
  } catch (error) { return { calls, continued: false, error: error.message }; }
}
const unreachable = Object.assign(new Error('connect ENETUNREACH 192.0.2.1:8080'), { code: 'ENETUNREACH' });
for (const [label, outcome, expected] of [
  ['C1 ENETUNREACH continues', () => Promise.reject(new TypeError('fetch failed', { cause: unreachable })), true],
  ['C2 successful fetch throws', () => Promise.resolve({ ok: true }), false],
  ['C3 timeout throws', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), false],
  ['C4 ECONNREFUSED throws', () => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('synthetic'), { code: 'ECONNREFUSED' }) })), false],
]) {
  const result = await runCanaryBlock(outcome);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0], { url: 'http://192.0.2.1:8080/', hasSignal: true });
  assert.equal(result.continued, expected);
  if (expected) assert.equal(result.egressBlocked, true);
  else assert.equal(result.error, 'External network canary was not refused as unreachable');
  results.push({ case: label, continued: result.continued, fetchCalls: 1 });
}

console.log(JSON.stringify({
  mode: 'Extracted bootstrap network and canary blocks with fake ports and fetch; bootstrap initialization, scenario and application code not evaluated',
  bootstrapSha256: sha256(bootstrapBytes), appBundleSha256: sha256(bundleBytes), measuredRecordSha256: MEASURED_RECORD_SHA256,
  results, dockerCalls: 0, networkRequests: 0, applicationImports: 0,
}));
