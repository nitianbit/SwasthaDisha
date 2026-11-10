import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  admitNetwork, assertBundle, captureNetworkDiagnostics, egressCanaryBlocked, entryKind, evaluateNetworkAdmission,
  makeManifest, NETWORK_ADMISSION_TAG, PORT_OPERATIONS, sha256, SOURCE_NAMES, verifyNetworkAdmission,
} from './app-bundle.mjs';
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

// ---- Network admission fixtures (APP_NETWORK_ADMISSION_CONTRACT.md section 8) ----

// Exact measured 41539ca record without runId; the hashed probe ties this hash to verification.json.
const MEASURED_RECORD_SHA256 = '9c2f54c44a0f5398ff65629f2e5071fe956b2aa8d42bc91257864edd2dffc473';
const unavailable = (code) => ({ unavailable: code });
const device = (name, flags, type, operstate = 'down') => ({ name, kind: 'symlink', flags, operstate, type });
const file = (name, code = 'ENOTDIR') => ({ name, kind: 'file', flags: unavailable(code), operstate: unavailable(code), type: unavailable(code) });
const v4 = (address, internal = true) => ({ address, family: 'IPv4', internal });
const v6 = (address, internal = true) => ({ address, family: 'IPv6', internal });

function measured() {
  return {
    tag: 'APP-NET-DIAG-1',
    entries: [
      file('bonding_masters'), device('erspan0', '0x1002', '1'), device('gre0', '0x80', '778'),
      device('gretap0', '0x1002', '1'), device('ip6_vti0', '0x80', '769'), device('ip6gre0', '0x80', '823'),
      device('ip6tnl0', '0x80', '769'), device('ip_vti0', '0x80', '768'), device('lo', '0x9', '772', 'unknown'),
      device('sit0', '0x80', '776'), device('tunl0', '0x80', '768'),
    ],
    addressedInterfaces: [{ name: 'lo', addresses: [v4('127.0.0.1'), v6('::1')] }],
  };
}
const loopbackOnly = () => ({ tag: 'APP-NET-DIAG-1', entries: [device('lo', '0x9', '772', 'unknown')],
  addressedInterfaces: [{ name: 'lo', addresses: [v4('127.0.0.1'), v6('::1')] }] });
const measuredDownDevices = ['erspan0', 'gre0', 'gretap0', 'ip6_vti0', 'ip6gre0', 'ip6tnl0', 'ip_vti0', 'sit0', 'tunl0'];

function edit(change, base = measured()) { change(base); return base; }
const entry = (record, name) => record.entries.find((row) => row.name === name);
function insert(record, row) {
  record.entries.push(row);
  record.entries.sort((left, right) => (left.name < right.name ? -1 : 1));
  return record;
}
const loAddresses = (record) => record.addressedInterfaces[0].addresses;

function assertDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test('P1 the exact measured record is admitted by semantics and summarized', () => {
  assert.equal(sha256(JSON.stringify(measured())), MEASURED_RECORD_SHA256);
  const summary = evaluateNetworkAdmission(measured());
  assert.deepEqual(Object.keys(summary), ['tag', 'observation', 'loopback', 'controlFiles', 'downDevices', 'loopbackAddresses']);
  assert.equal(summary.tag, NETWORK_ADMISSION_TAG);
  assert.equal(summary.loopback, 'lo');
  assert.deepEqual(summary.controlFiles, ['bonding_masters']);
  assert.deepEqual(summary.downDevices, measuredDownDevices);
  assert.deepEqual(summary.loopbackAddresses, ['127.0.0.1', '::1']);
  assert.equal(JSON.stringify(summary.observation), JSON.stringify(measured()));
  assertDeepFrozen(summary);
  assert.equal(verifyNetworkAdmission(JSON.parse(JSON.stringify(summary))), true);
});

test('P2 a loopback-only namespace is admitted', () => {
  const summary = evaluateNetworkAdmission(loopbackOnly());
  assert.deepEqual([summary.controlFiles, summary.downDevices, summary.loopbackAddresses], [[], [], ['127.0.0.1', '::1']]);
});

test('P3 an operational-up loopback with IPv4 only and a zero-flag down device is admitted', () => {
  const summary = evaluateNetworkAdmission(edit((record) => {
    record.entries[0].operstate = 'up';
    record.entries.push(device('tunl0', '0x0', '768'));
    record.addressedInterfaces[0].addresses = [v4('127.0.0.1')];
  }, loopbackOnly()));
  assert.deepEqual(summary.downDevices, ['tunl0']);
  assert.deepEqual(summary.loopbackAddresses, ['127.0.0.1']);
});

const REASON = Object.freeze({
  malformed: 'malformed observation', loLink: 'loopback is not a device link', loFlags: 'loopback flags',
  loType: 'loopback type', loState: 'loopback operstate', file: 'control file attributes',
  devFlags: 'non-loopback device flags', devType: 'non-loopback device type', devState: 'non-loopback device operstate',
  kind: 'entry kind', loMissing: 'loopback missing', addressed: 'addressed interfaces', loAddresses: 'loopback addresses',
});
const negatives = [
  ['N1 active eth0', REASON.devFlags, () => edit((record) => {
    insert(record, device('eth0', '0x1003', '1', 'up'));
    record.addressedInterfaces.push({ name: 'eth0', addresses: [v4('172.17.0.2', false)] });
  })],
  // Keeps lo's address row so only the loopback count can reject it.
  ['N2 loopback missing', REASON.loMissing, () => ({ tag: 'APP-NET-DIAG-1', entries: [device('tunl0', '0x80', '768')],
    addressedInterfaces: [{ name: 'lo', addresses: [v4('127.0.0.1')] }] })],
  ['N3 loopback down', REASON.loFlags, () => edit((record) => { Object.assign(entry(record, 'lo'), { flags: '0x8', operstate: 'down' }); })],
  ['N4 loopback without IFF_LOOPBACK', REASON.loFlags, () => edit((record) => { entry(record, 'lo').flags = '0x1'; })],
  ['N4 loopback with Ethernet type', REASON.loType, () => edit((record) => { entry(record, 'lo').type = '1'; })],
  ['N4 loopback as a control file', REASON.loLink, () => edit((record) => { Object.assign(entry(record, 'lo'), file('lo')); })],
  ['N4 loopback as a directory', REASON.loLink, () => edit((record) => { entry(record, 'lo').kind = 'directory'; })],
  ['N5 second loopback by type', REASON.devType, () => insert(measured(), device('lo2', '0x0', '772'))],
  ['N5 second loopback by flag', REASON.devFlags, () => insert(measured(), device('dummy0', '0x88', '1'))],
];
for (const target of ['lo', 'tunl0']) {
  for (const flags of ['9', '0x', '0xg1', '0X9', '0xA', '0x09', '0x123456789', unavailable('ERR_ACCESS_DENIED')]) {
    negatives.push([`N6 ${target} flags ${JSON.stringify(flags)}`, target === 'lo' ? REASON.loFlags : REASON.devFlags, () => edit((record) => { entry(record, target).flags = flags; })]);
  }
}
for (const flags of ['0X80', '0xA0', '0x080']) {
  negatives.push([`N6 tunl0 non-canonical flags ${flags}`, REASON.devFlags, () => edit((record) => { entry(record, 'tunl0').flags = flags; })]);
}
for (const operstate of ['unknown', 'dormant', 'up', 'lowerlayerdown', 'notpresent', 'testing', 'DOWN']) {
  negatives.push([`N7 non-loopback operstate ${operstate}`, REASON.devState, () => edit((record) => { entry(record, 'tunl0').operstate = operstate; })]);
}
for (const operstate of ['dormant', 'testing', 'lowerlayerdown', 'down', 'notpresent']) {
  negatives.push([`N8 loopback operstate ${operstate}`, REASON.loState, () => edit((record) => { entry(record, 'lo').operstate = operstate; })]);
}
negatives.push(
  ['N9 IFF_UP with operstate down', REASON.devFlags, () => edit((record) => { entry(record, 'tunl0').flags = '0x81'; })],
  ['N9 up unaddressed eth0', REASON.devFlags, () => insert(measured(), device('eth0', '0x1003', '1', 'up'))],
);
for (const [target, flags] of [['tunl0', '0xc0'], ['tunl0', '0x10080'], ['tunl0', '0x20080'], ['lo', '0x49']]) {
  negatives.push([`N10 ${target} volatile flags ${flags}`, target === 'lo' ? REASON.loFlags : REASON.devFlags, () => edit((record) => { entry(record, target).flags = flags; })]);
}
for (const kind of ['directory', 'other', unavailable('EACCES')]) {
  negatives.push([`N11 device kind ${JSON.stringify(kind)}`, REASON.kind, () => edit((record) => { entry(record, 'tunl0').kind = kind; })]);
}
negatives.push(
  ['N12 control file with readable flags', REASON.file, () => edit((record) => { entry(record, 'bonding_masters').flags = '0x0'; })],
  ['N12 control file with access denial', REASON.file, () => edit((record) => { Object.assign(entry(record, 'bonding_masters'), file('bonding_masters', 'ERR_ACCESS_DENIED')); })],
  ['N12 control file with missing attributes', REASON.file, () => edit((record) => { Object.assign(entry(record, 'bonding_masters'), file('bonding_masters', 'ENOENT')); })],
  ['N13 device link with all ENOTDIR', REASON.devFlags, () => edit((record) => { Object.assign(entry(record, 'tunl0'), file('tunl0'), { kind: 'symlink' }); })],
  ['N13 device link with all ENOENT', REASON.devFlags, () => edit((record) => { Object.assign(entry(record, 'tunl0'), file('tunl0', 'ENOENT'), { kind: 'symlink' }); })],
);
for (const type of ['772x', '-1', '70000', '0772', unavailable('ENOENT')]) {
  negatives.push([`N14 device type ${JSON.stringify(type)}`, REASON.devType, () => edit((record) => { entry(record, 'tunl0').type = type; })]);
}
negatives.push(
  ['N14 loopback type 0772', REASON.loType, () => edit((record) => { entry(record, 'lo').type = '0772'; })],
  ['N15 addressed down device', REASON.addressed, () => edit((record) => { record.addressedInterfaces.push({ name: 'tunl0', addresses: [v4('10.0.0.1', false)] }); })],
  ['N16 non-internal loopback address', REASON.loAddresses, () => edit((record) => { loAddresses(record).push(v4('10.1.2.3', false)); })],
  ['N16 other IPv4 loopback address', REASON.loAddresses, () => edit((record) => { loAddresses(record).push(v4('127.0.0.2')); })],
  ['N16 link-local loopback address', REASON.loAddresses, () => edit((record) => { loAddresses(record).push(v6('fe80::1')); })],
  ['N16 mapped loopback address', REASON.loAddresses, () => edit((record) => { loAddresses(record).push(v6('::ffff:127.0.0.1')); })],
  ['N16 swapped loopback families', REASON.loAddresses, () => edit((record) => { record.addressedInterfaces[0].addresses = [v6('127.0.0.1'), v4('::1')]; })],
  ['N16 duplicate IPv6 loopback', REASON.loAddresses, () => edit((record) => { loAddresses(record).push(v6('::1')); })],
  ['N16 IPv6 loopback only', REASON.loAddresses, () => edit((record) => { record.addressedInterfaces[0].addresses = [v6('::1')]; })],
  ['N16 non-internal 127.0.0.1', REASON.loAddresses, () => edit((record) => { loAddresses(record)[0].internal = false; })],
  ['N16 unavailable addresses', REASON.addressed, () => edit((record) => { record.addressedInterfaces = unavailable('UNAVAILABLE'); })],
  ['N16 no addressed loopback', REASON.addressed, () => edit((record) => { record.addressedInterfaces = []; })],
  ['N16 empty loopback address list', REASON.malformed, () => edit((record) => { record.addressedInterfaces[0].addresses = []; })],
  ['N16 second addressed interface', REASON.addressed, () => edit((record) => { record.addressedInterfaces.push({ name: 'lo2', addresses: [v4('127.0.0.1')] }); })],
  // Only the addressed-name check can reject this: the single row carries a valid loopback address.
  ['N16 loopback address on a non-loopback name', REASON.addressed, () => ({ tag: 'APP-NET-DIAG-1',
    entries: [device('lo', '0x9', '772', 'unknown'), device('tunl0', '0x80', '768')],
    addressedInterfaces: [{ name: 'tunl0', addresses: [v4('127.0.0.1')] }] })],
  ['N17 seventeen entries', REASON.malformed, () => {
    const record = measured();
    for (let index = 0; index < 6; index++) insert(record, device('zz' + index, '0x80', '768'));
    assert.equal(record.entries.length, 17);
    return record;
  }],
  ['N18 wrong tag', REASON.malformed, () => edit((record) => { record.tag = 'APP-NET-DIAG-2'; })],
  ['N18 unknown key', REASON.malformed, () => edit((record) => { record.routes = []; })],
  ['N18 missing key', REASON.malformed, () => edit((record) => { delete record.addressedInterfaces; })],
  ['N18 extra entry key', REASON.malformed, () => edit((record) => { entry(record, 'tunl0').extra = 'synthetic'; })],
  ['N18 unsorted names', REASON.malformed, () => edit((record) => { record.entries.reverse(); })],
  ['N18 duplicate names', REASON.malformed, () => edit((record) => { record.entries.push(device('tunl0', '0x80', '768')); })],
  ['N18 null record', REASON.malformed, () => null],
  ['N18 empty entries', REASON.malformed, () => edit((record) => { record.entries = []; })],
  ['N18 numeric field', REASON.malformed, () => edit((record) => { entry(record, 'tunl0').type = 768; })],
  ['N18 unavailable object with extra key', REASON.malformed, () => edit((record) => { entry(record, 'bonding_masters').flags = { unavailable: 'ENOTDIR', detail: 'x' }; })],
  ['N18 lowercase unavailable code', REASON.malformed, () => edit((record) => { entry(record, 'bonding_masters').flags = { unavailable: 'enotdir' }; })],
);
// Each negative pins the exact rejection reason, so its intended check is fixed in the repository.
for (const [label, reason, build] of negatives) {
  test(`${label} is rejected for ${reason}`, () => {
    assert.throws(() => evaluateNetworkAdmission(build()), { name: 'Error', message: `Network admission rejected: ${reason}` });
  });
}

function servedPorts(record, overrides = {}) {
  const state = { lists: 0, reads: 0, reports: [] };
  const rows = new Map(record.entries.map((row) => [row.name, row]));
  const raise = (code) => { throw Object.assign(new Error('synthetic denial'), { code }); };
  const value = (field) => (typeof field === 'string' ? field : raise(field.unavailable));
  const ports = {
    list() { state.lists++; return record.entries.map((row) => row.name).reverse(); },
    entryType(path) { state.reads++; return value(rows.get(path.slice('/sys/class/net/'.length)).kind); },
    readText(path) {
      state.reads++;
      const [, name, field] = /^\/sys\/class\/net\/([^/]+)\/(flags|operstate|type)$/.exec(path);
      return value(rows.get(name)[field]) + '\n';
    },
    addresses: () => (Array.isArray(record.addressedInterfaces)
      ? Object.fromEntries(record.addressedInterfaces.map((row) => [row.name, row.addresses]))
      : raise(record.addressedInterfaces.unavailable)),
    report(line) { state.reports.push(line); },
    ...overrides,
  };
  return { state, ports };
}

test('A1 the measured listing is admitted through explicit readers without a report', () => {
  const { state, ports } = servedPorts(measured());
  const summary = admitNetwork(ports, runId);
  assert.equal(JSON.stringify(summary), JSON.stringify(evaluateNetworkAdmission(measured())));
  assert.equal(state.reports.length, 0);
  assert.equal(state.reads, 11 * 4);
});

test('A2 a rejected observation is reported once with its run identity before the throw', () => {
  const record = negatives.find(([label]) => label === 'N1 active eth0')[2]();
  const { state, ports } = servedPorts(record);
  assert.throws(() => admitNetwork(ports, runId), /Network admission rejected/);
  assert.equal(state.reports.length, 1);
  const [line] = state.reports;
  assert.ok(line.endsWith('\n') && Buffer.byteLength(line) <= 8193);
  const reported = JSON.parse(line);
  assert.equal(reported.tag, 'APP-NET-DIAG-1');
  assert.equal(reported.runId, runId);
  assert.equal(reported.entries.find((row) => row.name === 'eth0').flags, '0x1003');
});

test('A3 a failed listing reports nothing and reads no metadata', () => {
  const { state, ports } = servedPorts(measured(), { list() { throw new Error('synthetic list failure'); } });
  assert.throws(() => admitNetwork(ports, runId), /synthetic list failure/);
  assert.deepEqual([state.reads, state.reports.length], [0, 0]);
});

test('A4 more than sixteen entries are refused before metadata reads', () => {
  const { state, ports } = servedPorts(measured(), { list: () => Array.from({ length: 17 }, (_, index) => 'if' + index) });
  assert.throws(() => admitNetwork(ports, runId), /Invalid diagnostic entry names/);
  assert.deepEqual([state.reads, state.reports.length], [0, 0]);
});

for (const reader of ['entryType', 'readText', 'addresses']) {
  test(`A5 a throwing ${reader} reader is reported as unavailable and rejected`, () => {
    const { state, ports } = servedPorts(measured(), { [reader]() { throw Object.assign(new Error('synthetic'), { code: 'EIO' }); } });
    assert.throws(() => admitNetwork(ports, runId), /Network admission rejected/);
    assert.equal(state.reports.length, 1);
    assert.ok(state.reports[0].includes('"unavailable":"EIO"'));
  });
}

for (const [label, change] of [
  ['missing report port', (ports) => { delete ports.report; return runId; }],
  ['missing list port', (ports) => { delete ports.list; return runId; }],
  ['missing entryType port', (ports) => { delete ports.entryType; return runId; }],
  ['missing readText port', (ports) => { delete ports.readText; return runId; }],
  ['missing addresses port', (ports) => { delete ports.addresses; return runId; }],
  ['invalid run identity', () => 'forged'],
]) {
  test(`A6 ${label} is refused before listing`, () => {
    const { state, ports } = servedPorts(measured());
    const identity = change(ports);
    assert.throws(() => admitNetwork(ports, identity), /Explicit network admission ports/);
    assert.equal(state.lists, 0);
  });
}

test('A6 a non-array listing is refused before metadata reads', () => {
  const { state, ports } = servedPorts(measured(), { list: () => 'lo' });
  assert.throws(() => admitNetwork(ports, runId), /Invalid diagnostic entry names/);
  assert.equal(state.reads, 0);
});

test('A7 a loopback-only listing is admitted and listings are sorted before capture', () => {
  const { ports } = servedPorts(loopbackOnly());
  assert.deepEqual(admitNetwork(ports, runId).downDevices, []);
  const seen = [];
  const { ports: measuredPorts } = servedPorts(measured());
  const summary = admitNetwork({ ...measuredPorts, entryType(path) { seen.push(path); return measuredPorts.entryType(path); } }, runId);
  assert.deepEqual(seen, [...seen].sort());
  assert.deepEqual(summary.downDevices, measuredDownDevices);
});

test('entryKind maps lstat results with symbolic links taking precedence', () => {
  const stat = (link, regular, directory) => ({ isSymbolicLink: () => link, isFile: () => regular, isDirectory: () => directory });
  assert.equal(entryKind(stat(true, true, true)), 'symlink');
  assert.equal(entryKind(stat(false, true, true)), 'file');
  assert.equal(entryKind(stat(false, false, true)), 'directory');
  assert.equal(entryKind(stat(false, false, false)), 'other');
});

const unreachable = () => Object.assign(new Error('connect ENETUNREACH 192.0.2.1:8080'), { code: 'ENETUNREACH' });
const failedFetch = (cause) => new TypeError('fetch failed', { cause });

test('E1 a fetch failure caused by ENETUNREACH is measured blocking', async () => {
  assert.equal(egressCanaryBlocked({ status: 'rejected', reason: failedFetch(unreachable()) }), true);
  const [settled] = await Promise.allSettled([Promise.reject(failedFetch(unreachable()))]);
  assert.equal(egressCanaryBlocked(settled), true);
});

test('E2 a direct ENETUNREACH error is measured blocking', () => {
  assert.equal(egressCanaryBlocked({ status: 'rejected', reason: unreachable() }), true);
});

const notBlocked = [
  ['E3 successful fetch', { status: 'fulfilled', value: { ok: true } }],
  ['E4 timeout', { status: 'rejected', reason: new DOMException('The operation was aborted due to timeout', 'TimeoutError') }],
  ['E5 abort', { status: 'rejected', reason: new DOMException('This operation was aborted', 'AbortError') }],
  ...['ECONNREFUSED', 'EHOSTUNREACH', 'ENETDOWN', 'ETIMEDOUT'].map((code) =>
    [`E6 ${code}`, { status: 'rejected', reason: failedFetch(Object.assign(new Error('synthetic'), { code })) }]),
  ...[null, undefined, 'ENETUNREACH', 0].map((reason) => [`E7 reason ${String(reason)}`, { status: 'rejected', reason }]),
  ['E7 absent reason', { status: 'rejected' }],
  ...[undefined, null, {}, 'rejected', { status: 'pending' }, { status: 'REJECTED', reason: unreachable() }].map((settled) =>
    [`E8 settled ${JSON.stringify(settled) ?? 'undefined'}`, settled]),
  ['E9 lowercase code', { status: 'rejected', reason: failedFetch(Object.assign(new Error('synthetic'), { code: 'enetunreach' })) }],
  // Fail closed: message text alone, or a code nested deeper than one cause, is not a measurement.
  ['E10 ENETUNREACH only in message text', { status: 'rejected', reason: failedFetch(new Error('connect ENETUNREACH 192.0.2.1:8080')) }],
  ['E11 nested cause code', { status: 'rejected', reason: failedFetch(new Error('wrapper', { cause: unreachable() })) }],
];
for (const [label, settled] of notBlocked) {
  test(`${label} is not measured egress blocking`, () => {
    assert.equal(egressCanaryBlocked(settled), false);
  });
}
