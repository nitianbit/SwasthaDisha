import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBundle, captureNetworkDiagnostics, makeManifest, PORT_OPERATIONS, sha256, SOURCE_NAMES } from './app-bundle.mjs';
import { createRecordingPorts } from './app-ports.mjs';

const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sources = Object.fromEntries(SOURCE_NAMES.map((name) => [name, '// synthetic fixture\n']));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bundle-unit-'));
  t.after(() => rmSync(directory, { recursive: true, force: false }));
  const manifest = makeManifest(runId, sources);
  const bytes = JSON.stringify(manifest);
  for (const [name, content] of Object.entries(sources)) writeFileSync(join(directory, name), content);
  writeFileSync(join(directory, '.admission.json'), bytes);
  return { directory, expected: { runId, manifestSha: sha256(bytes) } };
}

test('the exact staged bundle admits the expected identity and hashes', (t) => {
  const { directory, expected } = fixture(t);
  const result = assertBundle(directory, expected);
  assert.equal(result.runId, runId);
  assert.equal(Object.isFrozen(result.files), true);
});

for (const name of ['.env', '.env.production', 'credentials.json', 'extra.mjs']) {
  test(`${name} is rejected before a scenario import`, (t) => {
    const { directory, expected } = fixture(t);
    writeFileSync(join(directory, name), 'synthetic-only');
    let imports = 0;
    assert.throws(() => { assertBundle(directory, expected); imports++; }, /unapproved/);
    assert.equal(imports, 0);
  });
}

test('changed source bytes are rejected before a scenario import', (t) => {
  const { directory, expected } = fixture(t);
  writeFileSync(join(directory, 'scenario.mjs'), '// changed');
  assert.throws(() => assertBundle(directory, expected), /source hash changed/);
});

test('a copied manifest cannot change the expected run identity', (t) => {
  const { directory, expected } = fixture(t);
  assert.throws(() => assertBundle(directory, { ...expected, runId: 'different-run' }), /identity changed/);
});

test('changed manifest bytes cannot supply their own expected hash', (t) => {
  const { directory, expected } = fixture(t);
  writeFileSync(join(directory, '.admission.json'), '{}');
  assert.throws(() => assertBundle(directory, expected), /admission hash changed/);
});

test('source construction rejects unknown filenames and non-text values', () => {
  assert.throws(() => makeManifest(runId, { ...sources, '.env': 'synthetic' }), /Unexpected source/);
  assert.throws(() => makeManifest(runId, { ...sources, 'scenario.mjs': {} }), /bounded text/);
});

test('provider ports record each configured request without a transport or success authority', () => {
  const ports = createRecordingPorts();
  for (const [port, operation] of Object.entries(PORT_OPERATIONS)) {
    const receipt = ports.request(port, operation, { syntheticId: 'fixture-only' });
    assert.deepEqual(receipt, { port, operation, status: 'recorded', effect: false });
    assert.equal(Object.isFrozen(receipt), true);
  }
  assert.equal(ports.snapshot().length, 7);
  assert.equal(Object.isFrozen(ports.snapshot()), true);
});

test('unknown provider operations cannot create a recorded effect', () => {
  const ports = createRecordingPorts();
  assert.throws(() => ports.request('payments', 'settle-real-funds', { syntheticId: 'fixture-only' }), /Unconfigured/);
  assert.throws(() => ports.request('database', 'connect', { syntheticId: 'fixture-only' }), /Unconfigured/);
  assert.equal(ports.snapshot().length, 0);
});

test('realistic or extra payload fields are rejected without recording a call', () => {
  const ports = createRecordingPorts();
  assert.throws(() => ports.request('sms', 'send', { phone: 'synthetic-not-a-number' }), /fixed synthetic/);
  assert.throws(() => ports.request('sms', 'send', { syntheticId: 'fixture-only', other: true }), /fixed synthetic/);
  assert.equal(ports.snapshot().length, 0);
});


function diagnosticPorts(overrides = {}) {
  const calls = [];
  return { calls,
    entryType(path) { calls.push(path); return path.endsWith('/bonding_masters') ? 'file' : 'symlink'; },
    readText(path) { calls.push(path); return path.endsWith('/flags') ? '0x0\n' : path.endsWith('/operstate') ? 'down\n' : '768\n'; },
    addresses() { return { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }; },
    ...overrides };
}

test('network diagnostics capture raw state and addressed interfaces without admission authority', () => {
  const ports = diagnosticPorts();
  const record = captureNetworkDiagnostics(['bonding_masters', 'lo', 'tunl0'], ports);
  assert.equal(record.tag, 'APP-NET-DIAG-1');
  assert.equal(record.entries[0].kind, 'file');
  assert.equal(record.entries[2].flags, '0x0');
  assert.equal(record.entries[2].operstate, 'down');
  assert.deepEqual(record.addressedInterfaces, [{ name: 'lo', addresses: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }]);
  assert.equal(Object.hasOwn(record, 'admissionPassed'), false);
  assert.equal(Object.hasOwn(record, 'routes'), false);
  assert.ok(ports.calls.every((path) => /^\/sys\/class\/net\/(bonding_masters|lo|tunl0)(\/(flags|operstate|type))?$/.test(path)));
});

for (const code of ['ERR_ACCESS_DENIED', 'ENOENT', 'ENOTDIR']) {
  test(`network diagnostic ${code} stays unavailable without fallback`, () => {
    const fail = () => { throw Object.assign(new Error('do not log raw exception or credentials'), { code }); };
    const record = captureNetworkDiagnostics(['lo', 'tunl0'], diagnosticPorts({ readText: fail, entryType: fail, addresses: fail }));
    assert.deepEqual(record.entries[1].flags, { unavailable: code });
    assert.deepEqual(record.entries[1].kind, { unavailable: code });
    assert.deepEqual(record.addressedInterfaces, { unavailable: code });
    assert.equal(JSON.stringify(record).includes('credentials'), false);
  });
}

for (const names of [['..'], ['../outside'], ['a/b'], ['bad\nname'], ['lo', 'lo'], Array.from({ length: 17 }, (_, i) => 'if' + i)]) {
  test('invalid or oversized network entry names fail before reading metadata', () => {
    const ports = diagnosticPorts();
    assert.throws(() => captureNetworkDiagnostics(names, ports), /Invalid diagnostic entry names/);
    assert.equal(ports.calls.length, 0);
  });
}

test('oversized text and malformed address snapshots are explicitly unavailable', () => {
  const record = captureNetworkDiagnostics(['lo'], diagnosticPorts({ readText: () => 'x'.repeat(65), addresses: () => ({ lo: 'invalid' }) }));
  assert.deepEqual(record.entries[0].flags, { unavailable: 'UNAVAILABLE' });
  assert.deepEqual(record.addressedInterfaces, { unavailable: 'UNAVAILABLE' });
});

test('network diagnostic output has an explicit byte limit', () => {
  const names = Array.from({ length: 16 }, (_, i) => 'interface' + i.toString().padStart(2, '0') + 'x'.repeat(20));
  const addresses = Object.fromEntries(names.map((name) => [name, Array.from({ length: 4 }, () => ({ address: '2001:db8:1234:5678:1234:5678:1234:5678', family: 'IPv6', internal: false }))]));
  assert.throws(() => captureNetworkDiagnostics(names, diagnosticPorts({ addresses: () => addresses, readText: () => 'x'.repeat(64) })), /diagnostic output limit/);
});


test('network diagnostic readers have no live defaults', () => {
  assert.throws(() => captureNetworkDiagnostics(['lo'], {}), /Explicit diagnostic readers/);
});

test('network diagnostic error codes cannot leak raw exception text', () => {
  const fail = () => { throw Object.assign(new Error('synthetic-private-detail'), { code: 'synthetic-secret=do-not-log' }); };
  const record = captureNetworkDiagnostics(['lo'], diagnosticPorts({ readText: fail }));
  assert.deepEqual(record.entries[0].flags, { unavailable: 'UNAVAILABLE' });
  assert.equal(JSON.stringify(record).includes('synthetic-secret'), false);
});
