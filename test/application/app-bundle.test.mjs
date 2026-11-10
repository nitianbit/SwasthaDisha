import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBundle, makeManifest, PORT_OPERATIONS, sha256, SOURCE_NAMES } from './app-bundle.mjs';
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
