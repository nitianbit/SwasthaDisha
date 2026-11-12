'use strict';
// Builtins and explicit fake observations only; no BSON/driver/app evaluation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fixture = require('./bootstrap.cjs');
const output = process.stdout.write.bind(process.stdout);
assert(process.permission && !process.permission.has('child') && !process.permission.has('worker') && !process.permission.has('addon'));
assert(!process.env.NODE_OPTIONS);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const portsBytes = fs.readFileSync(path.join(__dirname, 'ports-manifest.json'));
const casesBytes = fs.readFileSync(path.join(__dirname, 'cases.json'));
assert.equal(sha(portsBytes), fixture.PORTS_SHA); assert.equal(sha(casesBytes), fixture.CASES_SHA);
const ports = JSON.parse(portsBytes); const cases = JSON.parse(casesBytes);
const tests = []; const test = (name, action) => tests.push({ name, action });
const rejected = action => assert.throws(action, error => error.message === 'INVENTORY_CURSOR');
const wireRejected = action => assert.throws(action, error => fixture.FAILURE_CODES.includes(error.message));

// These are deliberately small fake observations, not copied BSON algorithms.
class FakeObjectId { constructor(hex) { this.hex = hex; } toHexString() { return this.hex; } }
class FakeLong {
  constructor(low = 0, high = 0, unsigned = false) { this.low = low; this.high = high; this.unsigned = unsigned; }
  static fromBits(low, high, unsigned) { return new this(low, high, unsigned); }
  isZero() { return this.low === 0 && this.high === 0; }
  toString() { return String(this.low); }
}
class FakeTimestamp extends FakeLong {
  constructor(value = { i: 0, t: 0 }) { super(value.i, value.t, true); }
  getHighBitsUnsigned() { return this.high; } getLowBitsUnsigned() { return this.low; }
}
class FakeBinary { constructor(bytes = Buffer.alloc(16), subtype = 4) { this.buffer = Buffer.from(bytes); this.position = bytes.length; this.sub_type = subtype; } }
const bson = { ObjectId: FakeObjectId, Long: FakeLong, Timestamp: FakeTimestamp, Binary: FakeBinary };
const database = 'sd_iq_' + 'a'.repeat(32);
const sid = byte => ({ id: new FakeBinary(Buffer.alloc(16, byte)) });
function wireFixture(lease = true) {
  const effects = fixture.effectsState(); const wire = fixture.createWireBoundary({ database }, ports, cases, bson, effects);
  const control = sid(1); const action = sid(2); wire.ownSession(control, true); wire.ownSession(action);
  const ids = { pharmacy: new FakeObjectId('1'.repeat(24)), medicine: new FakeObjectId('2'.repeat(24)), targetItem: new FakeObjectId('3'.repeat(24)) };
  const scope = { row: cases.cases[0], token: {}, fixture: { ids }, sessionId: wire.sid(action), transaction: false };
  wire.phase('ACTION', scope);
  let nativeIdReads = 0;
  const nativeCursor = { get id() { nativeIdReads++; throw new Error('APM precedes native cursor initialization'); } };
  if (lease) wire.expectCursor({ cursor: nativeCursor, command: 'find', collection: 'inventoryitems', database, session: wire.sid(action), rowLimit: 1 });
  const started = { requestId: 1, commandName: 'find', databaseName: database, command: {
    find: 'inventoryitems', filter: { pharmacyId: ids.pharmacy, medicineId: ids.medicine }, limit: 1, singleBatch: true, lsid: action, $db: database
  } };
  function reply(id, firstBatch = []) {
    if (arguments.length === 0) id = 0;
    return { requestId: 1, commandName: 'find', reply: { ok: 1, cursor: { id, ns: database + '.inventoryitems', firstBatch } } };
  }
  return { wire, effects, started, action, control, scope, reply, nativeIdReads: () => nativeIdReads };
}

// This first test is also the exact old-source baseline RED entry.
test('actual wire accepts primitive positive-zero reply without reading native cursor id', () => {
  const data = wireFixture(); data.wire.started(data.started); const event = data.reply(0);
  data.wire.succeeded(event); data.wire.assertHealthy(); data.wire.assertClosed();
  assert.equal(data.nativeIdReads(), 0); assert(Object.is(event.reply.cursor.id, 0));
  assert(Object.is(data.wire.events()[1].reply.cursor.id, 0)); assert.equal(data.effects.commandFailures, 0);
});
test('dedicated decoder accepts only positive-zero and returns the existing private comparison token', () => {
  assert.equal(fixture.apmCursorZero(0), '0');
});

const rejectedValues = [
  ['negative zero', () => -0], ['Long zero', () => new FakeLong(0)], ['Long one', () => new FakeLong(1)],
  ['Timestamp zero', () => new FakeTimestamp()], ['one', () => 1], ['negative one', () => -1],
  ['largest safe integer', () => Number.MAX_SAFE_INTEGER], ['unsafe integer', () => 2 ** 53],
  ['NaN', () => NaN], ['positive infinity', () => Infinity], ['negative infinity', () => -Infinity],
  ['BigInt zero', () => 0n], ['BigInt one', () => 1n], ['boxed zero', () => new Number(0)],
  ['string zero', () => '0'], ['string decimal zero', () => '0.0'], ['string negative zero', () => '-0'], ['empty string', () => ''],
  ['false', () => false], ['true', () => true], ['null', () => null], ['undefined', () => undefined],
  ['plain object', () => ({})], ['plain marker', () => ({ $numberLong: '0' })], ['null prototype', () => Object.create(null)],
  ['empty array', () => []], ['array zero', () => [0]], ['Date zero', () => new Date(0)],
  ['Binary', () => new FakeBinary()], ['symbol', () => Symbol('0')], ['function', () => () => 0]
];
for (const [name, make] of rejectedValues) test('decoder rejects ' + name, () => rejected(() => fixture.apmCursorZero(make())));
for (const [name, make] of rejectedValues) test('actual wire rejects ' + name + ' reply and latches failure', () => {
  const data = wireFixture(); data.wire.started(data.started);
  wireRejected(() => data.wire.succeeded(data.reply(make()))); assert.equal(data.effects.commandFailures, 1);
  assert.equal(data.wire.events().length, 1); wireRejected(() => data.wire.assertHealthy()); assert.equal(data.nativeIdReads(), 0);
});
for (const property of ['valueOf', 'toString', Symbol.toPrimitive]) test('decoder never reads coercion property ' + String(property), () => {
  let reads = 0; const value = {};
  Object.defineProperty(value, property, { get() { reads++; throw new Error('must not inspect coercion capability'); } });
  rejected(() => fixture.apmCursorZero(value)); assert.equal(reads, 0);
});
test('decoder does not invoke proxy traps', () => {
  let reads = 0; const value = new Proxy({}, {
    get() { reads++; throw new Error('get trap'); }, getPrototypeOf() { reads++; throw new Error('prototype trap'); },
    ownKeys() { reads++; throw new Error('keys trap'); }, getOwnPropertyDescriptor() { reads++; throw new Error('descriptor trap'); }
  });
  rejected(() => fixture.apmCursorZero(value)); assert.equal(reads, 0);
});
test('decoder rejects revoked proxy without inspecting it', () => {
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); rejected(() => fixture.apmCursorZero(proxy));
});
test('wire rejects cursor id accessor without invoking it', () => {
  const data = wireFixture(); data.wire.started(data.started); const event = data.reply(); let reads = 0;
  Object.defineProperty(event.reply.cursor, 'id', { get() { reads++; throw new Error('must not read cursor slot getter'); }, enumerable: true });
  wireRejected(() => data.wire.succeeded(event)); assert.equal(reads, 0); assert.equal(data.effects.commandFailures, 1);
});
test('wire rejects object-valued cursor slot without reading its proxy traps', () => {
  const data = wireFixture(); data.wire.started(data.started); let reads = 0;
  const value = new Proxy({}, { get() { reads++; throw new Error('must not read slot value'); }, getPrototypeOf() { reads++; throw new Error('must not inspect slot type'); } });
  wireRejected(() => data.wire.succeeded(data.reply(value))); assert.equal(reads, 0);
});
test('captured payload retains numeric zero and typed row without rewriting the input', () => {
  const data = wireFixture(); const row = { _id: new FakeObjectId('4'.repeat(24)), payload: 'original' };
  data.wire.started(data.started); const event = data.reply(0, [row]); data.wire.succeeded(event);
  assert(Object.is(event.reply.cursor.id, 0)); assert.equal(event.reply.cursor.firstBatch[0], row);
  const captured = data.wire.events()[1]; assert(Object.is(captured.reply.cursor.id, 0));
  assert(captured.reply.cursor.firstBatch[0]._id instanceof FakeObjectId); assert.equal(captured.reply.cursor.firstBatch[0].payload, 'original');
  assert(Object.isFrozen(captured.reply.cursor.firstBatch)); assert(Object.isFrozen(captured.reply.cursor));
  event.reply.cursor.id = -0; row.payload = 'changed';
  assert(Object.is(captured.reply.cursor.id, 0)); assert.equal(captured.reply.cursor.firstBatch[0].payload, 'original');
  data.wire.assertHealthy(); data.wire.assertClosed();
});
for (const mode of ['missing start', 'wrong request', 'wrong command', 'duplicate reply']) test('positive-zero reply still rejects ' + mode, () => {
  const data = wireFixture(); const event = data.reply();
  if (mode !== 'missing start') data.wire.started(data.started);
  if (mode === 'wrong request') event.requestId = 2;
  if (mode === 'wrong command') event.commandName = 'listIndexes';
  if (mode === 'duplicate reply') data.wire.succeeded(event);
  wireRejected(() => data.wire.succeeded(event)); assert.equal(data.effects.commandFailures, 1); wireRejected(() => data.wire.assertHealthy());
});
for (const mode of ['missing lease', 'wrong lease session']) test('started read still rejects ' + mode, () => {
  const data = wireFixture(false);
  if (mode === 'wrong lease session') data.wire.expectCursor({ cursor: {}, command: 'find', collection: 'inventoryitems', database, session: data.wire.sid(data.control), rowLimit: 1 });
  wireRejected(() => data.wire.started(data.started)); assert.equal(data.effects.unexpectedCommands, 1);
});
for (const mode of ['wrong namespace', 'rows beyond lease', 'bytes beyond lease', 'nonarray batch', 'extra cursor field', 'failed reply']) test('positive-zero reply retains ' + mode + ' rejection', () => {
  const data = wireFixture(); data.wire.started(data.started); const event = data.reply();
  if (mode === 'wrong namespace') event.reply.cursor.ns = 'other.inventoryitems';
  else if (mode === 'rows beyond lease') event.reply.cursor.firstBatch = [{}, {}];
  else if (mode === 'bytes beyond lease') event.reply.cursor.firstBatch = [{ payload: 'x'.repeat(128 * 1024) }];
  else if (mode === 'nonarray batch') event.reply.cursor.firstBatch = {};
  else if (mode === 'extra cursor field') event.reply.cursor.extra = true;
  else event.reply.ok = 0;
  wireRejected(() => data.wire.succeeded(event)); assert.equal(data.effects.commandFailures, 1); wireRejected(() => data.wire.assertHealthy());
});
for (const commandName of ['getMore', 'killCursors']) for (const kind of ['Long', 'Timestamp', 'number']) test('rejected live reply cannot own outgoing ' + commandName + ' ' + kind, () => {
  const data = wireFixture(); data.wire.started(data.started); wireRejected(() => data.wire.succeeded(data.reply(1)));
  const id = kind === 'Long' ? new FakeLong(1) : kind === 'Timestamp' ? new FakeTimestamp({ i: 1, t: 0 }) : 1;
  const command = commandName === 'getMore' ? { getMore: id, collection: 'inventoryitems' } : { killCursors: 'inventoryitems', cursors: [id] };
  Object.assign(command, { lsid: data.action, $db: database });
  wireRejected(() => data.wire.started({ requestId: 2, commandName, command, databaseName: database }));
  assert.equal(data.effects.commandFailures, 1); assert.equal(data.effects.unexpectedCommands, 1); wireRejected(() => data.wire.assertHealthy());
});
test('native cursor close slot still accepts Long zero and rejects numeric zero and Timestamp', () => {
  const data = wireFixture(); data.wire.closeCursor(new FakeLong(0));
  rejected(() => data.wire.closeCursor(0)); rejected(() => data.wire.closeCursor(new FakeTimestamp()));
});
test('native reader still inspects held Long after read completion', async () => {
  const leases = new Set(); const order = []; let cursor;
  const budget = fixture.createReadBudget('SNAPSHOT', () => 0n);
  const rows = await fixture.collectReadCursor(() => {
    cursor = { get id() { order.push('native id'); return new FakeLong(0); },
      async hasNext() { order.push('hasNext'); return false; }, async close() { order.push('close'); leases.delete(cursor); } };
    leases.add(cursor); return cursor;
  }, 16, budget, leases);
  assert.deepEqual(rows, []); assert.deepEqual(order, ['hasNext', 'native id', 'native id', 'close']);
});
test('transaction remains typed Long while its APM cursor reply is numeric zero', () => {
  const data = wireFixture(); data.scope.transaction = true; data.scope.row = cases.cases.find(row => row.id === 'IQS_ADJUST_COMMIT');
  Object.assign(data.started.command, { txnNumber: new FakeLong(1), autocommit: false, startTransaction: true, readConcern: { level: 'snapshot' } });
  data.wire.started(data.started); data.wire.succeeded(data.reply()); data.wire.assertHealthy();
  assert(data.wire.events()[0].command.txnNumber instanceof FakeLong); assert(Object.is(data.wire.events()[1].reply.cursor.id, 0));
});
for (const kind of ['number', 'Timestamp']) test('transaction still rejects ' + kind + ' txnNumber before APM reply', () => {
  const data = wireFixture(); data.scope.transaction = true; data.scope.row = cases.cases.find(row => row.id === 'IQS_ADJUST_COMMIT');
  Object.assign(data.started.command, { txnNumber: kind === 'number' ? 1 : new FakeTimestamp({ i: 1, t: 0 }), autocommit: false, startTransaction: true, readConcern: { level: 'snapshot' } });
  wireRejected(() => data.wire.started(data.started)); assert.equal(data.effects.unexpectedCommands, 1);
});

async function main() {
  assert(tests.length > 0 && tests.length <= 160); let completed = 0;
  for (const { name, action } of tests) {
    try { await action(); completed++; }
    catch (error) { output(JSON.stringify({ schema: 'SD-INVENTORY-APM-CURSOR-UNIT-1', status: 'FAIL', test: name, completed,
      plannedChecks: tests.length, failed: 1, error: error?.message || 'UNKNOWN' }) + '\n'); process.exitCode = 1; return; }
  }
  output(JSON.stringify({ schema: 'SD-INVENTORY-APM-CURSOR-UNIT-1', status: 'PASS', checks: completed, failed: 0,
    applicationEvaluations: 0, packageEvaluations: 0, DockerCalls: 0 }) + '\n');
}
main().catch(() => { output(JSON.stringify({ schema: 'SD-INVENTORY-APM-CURSOR-UNIT-1', status: 'FAIL', failed: 1 }) + '\n'); process.exitCode = 1; });
