'use strict';
// Builtins/fake capabilities only. Never load Mongoose, TypeDI or domain code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fixture = require('./bootstrap.cjs');
const output = process.stdout.write.bind(process.stdout);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
assert(process.permission && !process.permission.has('child') && !process.permission.has('worker') && !process.permission.has('addon'));
assert(!process.env.NODE_OPTIONS);
const portsBytes = fs.readFileSync(path.join(__dirname, 'ports-manifest.json'));
const casesBytes = fs.readFileSync(path.join(__dirname, 'cases.json'));
const lockBytes = fs.readFileSync(path.join(__dirname, 'public-lock.json'));
assert.equal(sha(portsBytes), fixture.PORTS_SHA); assert.equal(sha(casesBytes), fixture.CASES_SHA); assert.equal(sha(lockBytes), fixture.LOCK_SHA);
const ports = JSON.parse(portsBytes); const cases = JSON.parse(casesBytes);
const tests = []; const test = (name, action) => tests.push({ name, action });
const rejected = action => assert.throws(action, error => fixture.FAILURE_CODES.includes(error.message));
const copied = value => JSON.parse(JSON.stringify(value));

// Explicit fake BSON observations; these classes are not a BSON implementation.
class FakeObjectId { constructor(value = 'a'.repeat(24)) { this.hex = value; } toHexString() { return this.hex; } }
class FakeLong {
  constructor(value = 0, high = 0, unsigned = false) { this.low = value; this.high = high; this.unsigned = unsigned; }
  static fromBits(low, high, unsigned) { return new this(low, high, unsigned); }
  isZero() { return this.low === 0 && this.high === 0; }
  toString() { return String(this.low); }
}
class FakeTimestamp extends FakeLong {
  constructor(value = { i: 0, t: 0 }) { super(value.i, value.t, true); }
  getHighBitsUnsigned() { return this.high; } getLowBitsUnsigned() { return this.low; }
}
class FakeBinary { constructor(value = Buffer.alloc(16), subtype = 4) { this.buffer = Buffer.from(value); this.position = value.length; this.sub_type = subtype; } }
const bson = { ObjectId: FakeObjectId, Long: FakeLong, Timestamp: FakeTimestamp, Binary: FakeBinary };
const sid = byte => ({ id: new FakeBinary(Buffer.alloc(16, byte)) });

test('failure codes are finite, unique, safe and include all21 scenario codes', () => {
  assert.equal(new Set(fixture.FAILURE_CODES).size, fixture.FAILURE_CODES.length);
  assert.equal(fixture.FAILURE_CODES.length, 164);
  assert.equal(sha(JSON.stringify(fixture.FAILURE_CODES)), 'e583b9276983636d7f28e4495eed68904334800b88684492e41418bb42a96103');
  assert(fixture.FAILURE_CODES.every(code => /^INVENTORY_[A-Z0-9_]+$|^RUNTIME_FIXTURE_FAILED$/.test(code)));
  for (const code of ['INVENTORY_DATA_BINDING', 'INVENTORY_CONTEXT', 'INVENTORY_CASE_SET', 'INVENTORY_INDEX_PROOF',
    'INVENTORY_TYPED_VALUE', 'INVENTORY_OWNERSHIP_PROOF', 'INVENTORY_SEED_STATE', 'INVENTORY_CLEANUP', 'INVENTORY_EFFECTS',
    'INVENTORY_COMMANDS', 'INVENTORY_SESSION', 'INVENTORY_TRANSACTION', 'INVENTORY_RETURN', 'INVENTORY_ERROR', 'INVENTORY_FULL_STATE',
    'INVENTORY_GENERATED_FIELD', 'INVENTORY_QUALITY_STATUS', 'INVENTORY_DEPLETED_AT_PRESERVATION', 'INVENTORY_REPOSITORY_FRESHNESS',
    'INVENTORY_SENSITIVITY', 'INVENTORY_UNEXPECTED_FAILURE']) assert(fixture.FAILURE_CODES.includes(code));
});
test('unknown Error.code cannot enter diagnostic', () => {
  const error = new Error('private-detail'); error.code = 'INVENTORY_QUALITY_STATUS';
  const actual = fixture.failureResult(error); assert.equal(actual.code, 'RUNTIME_FIXTURE_FAILED');
  assert.deepEqual(Object.keys(actual), ['schema', 'stage', 'code', 'caseId', 'variantId', 'phase', 'failed', 'skipped']);
  assert(!JSON.stringify(actual).includes('private-detail'));
});
test('closed objects reject symbols, accessors and hidden extras', () => {
  assert(fixture.keys({ a: 1 }, ['a'])); assert(!fixture.keys({ a: 1, b: 2 }, ['a']));
  assert(!fixture.keys({ get a() { throw new Error('must-not-read'); } }, ['a']));
  const hidden = { a: 1 }; Object.defineProperty(hidden, 'hidden', { value: 2 }); assert(!fixture.keys(hidden, ['a']));
  const symbol = { a: 1, [Symbol()]: 2 }; assert(!fixture.keys(symbol, ['a']));
});
test('typed comparisons preserve category, date, subtype and effective bytes', () => {
  assert(!fixture.same(new FakeLong(1, 2, true), new FakeTimestamp({ i: 1, t: 2 }), bson));
  assert(!fixture.same(new FakeObjectId(), { hex: 'a'.repeat(24) }, bson));
  assert(!fixture.same(new Date(1), { date: 1 }, bson));
  assert(!fixture.same(new FakeBinary(Buffer.from([1]), 0), new FakeBinary(Buffer.from([1]), 4), bson));
  const left = new FakeBinary(Buffer.from([1, 2, 99]), 0); left.position = 2;
  const right = new FakeBinary(Buffer.from([1, 2]), 0); assert(fixture.same(left, right, bson));
  assert.deepEqual([...fixture.clone(left, bson).buffer], [1, 2]);
  assert(fixture.clone(new FakeTimestamp({ i: 1, t: 2 }), bson) instanceof FakeTimestamp);
});
for (const position of [-1, NaN, 4, 1.5]) test('bad Binary position ' + String(position), () => {
  const value = new FakeBinary(Buffer.from([1, 2])); value.position = position; rejected(() => fixture.clone(value, bson));
});
test('ordinary object order ignored; arrays and index pairs ordered', () => {
  assert(fixture.same({ a: 1, b: 2 }, { b: 2, a: 1 }, bson)); assert(!fixture.same([1, 2], [2, 1], bson));
  assert(!fixture.same(new Map([['a', 1], ['b', 1]]), new Map([['b', 1], ['a', 1]]), bson));
});
for (const value of [undefined, null, false, 0, '']) {
  test('preserve exact falsy action failure ' + String(value), async () => {
    let caught = false; let cleanup = false;
    try { await fixture.withCleanup(() => { throw value; }, () => { cleanup = true; throw new Error('later'); }); }
    catch (error) { caught = true; assert.equal(error, value); }
    assert(caught && cleanup);
  });
  test('propagate exact falsy cleanup failure ' + String(value), async () => {
    let caught = false; try { await fixture.withCleanup(() => 7, () => { throw value; }); } catch (error) { caught = true; assert.equal(error, value); }
    assert(caught);
  });
}
test('cleanup executes once and retains action result', async () => { let count = 0; assert.equal(await fixture.withCleanup(() => 42, () => count++), 42); assert.equal(count, 1); });

test('safe failure context null only before case entry', () => {
  const boundary = fixture.makeFailureContext(ports); boundary.set({ caseId: null, variantId: null, phase: null });
  boundary.set({ caseId: cases.cases[0].id, variantId: null, phase: 'NOMINAL' });
  assert.equal(boundary.get().caseId, cases.cases[0].id); rejected(() => boundary.set({ caseId: null, variantId: null, phase: null }));
});
for (const value of [
  { caseId: 'private', variantId: null, phase: 'NOMINAL' },
  { caseId: cases.cases[0].id, variantId: null, phase: null },
  { caseId: cases.cases[0].id, variantId: 'private', phase: 'UNSAFE' },
  { caseId: cases.cases[0].id, variantId: null, phase: 'UNSAFE' },
  { caseId: cases.cases[0].id, variantId: null, phase: 'NOMINAL', raw: 'private' }
]) test('reject unbound diagnostic ' + JSON.stringify(value), () => rejected(() => fixture.makeFailureContext(ports).set(value)));

function initFixture() {
  const effects = fixture.effectsState(); const calls = [];
  const init = fixture.createPublicInitialization({ isBuildingSnapshot: () => 0, tracingChannel: name => { calls.push(name); return { name }; } }, ports, effects);
  return { effects, calls, init };
}
function completeInit(init) {
  let predicate; let tracing;
  init.run(() => {
    predicate = init.retrieve('v8').startupSnapshot.isBuildingSnapshot; assert.equal(predicate(), 0);
    tracing = init.retrieve('node:diagnostics_channel').tracingChannel;
    for (const name of ports.publicInitialization.tracingNames) assert.equal(tracing(name).name, name);
  });
  init.assertComplete(); return { predicate, tracing };
}
test('exact real-projection init protocol then closes retained methods', () => {
  const { init, effects, calls } = initFixture(); const retained = completeInit(init);
  assert.equal(calls.length, 6); rejected(() => retained.tracing(ports.publicInitialization.tracingNames[0]));
  rejected(() => retained.predicate()); assert.equal(effects.operationDenials, 2);
});
test('init window closes after falsy failure', () => {
  const { init } = initFixture(); let caught = false;
  try { init.run(() => { throw null; }); } catch (error) { caught = true; assert.equal(error, null); }
  assert(caught); rejected(() => init.retrieve('v8')); rejected(() => init.run(() => {}));
});
test('retained tracing function independently rejects a previously unused name after close', () => {
  const { init, effects, calls } = initFixture(); let retained;
  init.run(() => { retained = init.retrieve('node:diagnostics_channel').tracingChannel; });
  rejected(() => retained(ports.publicInitialization.tracingNames[0])); assert.equal(calls.length, 0); assert.equal(effects.operationDenials, 1);
});
for (const mode of ['unknown', 'duplicate', 'unknown-property', 'write', 'duplicate-trace', 'unknown-trace']) test('init permanent denial ' + mode, () => {
  const { init, effects } = initFixture();
  init.run(() => {
    if (mode === 'unknown') rejected(() => init.retrieve('node:child_process'));
    else if (mode === 'duplicate') { init.retrieve('v8'); rejected(() => init.retrieve('v8')); }
    else if (mode === 'unknown-property') rejected(() => init.retrieve('v8').serialize);
    else if (mode === 'write') rejected(() => { init.retrieve('v8').startupSnapshot = {}; });
    else { const fn = init.retrieve('node:diagnostics_channel').tracingChannel; if (mode === 'duplicate-trace') fn(ports.publicInitialization.tracingNames[0]); rejected(() => fn(mode === 'unknown-trace' ? 'not-admitted' : ports.publicInitialization.tracingNames[0])); }
  });
  assert(effects.operationDenials > 0); rejected(() => init.assertComplete());
});
test('snapshot true cannot be swallowed into complete projection proof', () => {
  const effects = fixture.effectsState(); const init = fixture.createPublicInitialization({ isBuildingSnapshot: () => true, tracingChannel: () => ({}) }, ports, effects);
  init.run(() => rejected(() => init.retrieve('v8').startupSnapshot.isBuildingSnapshot())); assert(effects.operationDenials > 0);
});

function fakeSurface() {
  const calls = []; let meta = { isFile: () => true, isSymbolicLink: () => false, nlink: 1 };
  let caller = 'at driver (/workspace/node_modules/mongoose/node_modules/mongodb/lib/cmap/connect.js:1:1)';
  const invoked = name => (...args) => { calls.push(name); return args; };
  const files = { constants: fs.constants, promises: {} };
  const writers = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'write', 'writeSync', 'writev', 'writevSync', 'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync',
    'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
    'link', 'linkSync', 'symlink', 'symlinkSync', 'chmod', 'chmodSync', 'fchmod', 'fchmodSync', 'chown', 'chownSync', 'fchown', 'fchownSync', 'lchown', 'lchownSync',
    'utimes', 'utimesSync', 'futimes', 'futimesSync', 'lutimes', 'lutimesSync', 'createWriteStream', 'watch', 'watchFile', 'unwatchFile', 'fsync', 'fsyncSync', 'fdatasync', 'fdatasyncSync', 'statfs', 'statfsSync', 'glob', 'globSync'];
  for (const name of writers) { files[name] = invoked(name); files.promises[name] = invoked('promise.' + name); }
  files.readFileSync = () => { calls.push('readFileSync'); return Buffer.from('safe'); };
  files.readFile = (...args) => { calls.push('readFile'); args.at(-1)(null, Buffer.from('safe')); };
  files.createReadStream = invoked('readStream'); files.openAsBlob = invoked('openAsBlob');
  files.lstatSync = () => meta;
  for (const name of ['stat', 'statSync', 'lstat', 'realpath', 'realpathSync', 'readdir', 'readdirSync', 'opendir', 'opendirSync', 'access', 'accessSync', 'existsSync', 'readlink', 'readlinkSync']) files[name] = invoked(name);
  for (const name of ['readFile', 'stat', 'lstat', 'realpath', 'readdir', 'opendir', 'access', 'readlink']) files.promises[name] = invoked('promise.' + name);
  files.openSync = () => 7; files.open = (...args) => args.at(-1)(null, 8);
  for (const name of ['read', 'readSync', 'readv', 'readvSync', 'fstat', 'fstatSync', 'close', 'closeSync']) files[name] = invoked(name);
  files.promises.open = async () => Object.fromEntries(['readFile', 'read', 'createReadStream', 'close', 'appendFile', 'writeFile', 'write', 'writev', 'truncate', 'chmod', 'chown', 'utimes', 'createWriteStream'].map(name => [name, invoked('handle.' + name)]));
  class Socket { connect() { calls.push('socket.connect'); return this; } }
  class Server { listen() { calls.push('server.listen'); } }
  const network = { Socket, Server, createServer: () => new Server(), connect: (...args) => new Socket().connect(...args), createConnection: (...args) => new Socket().connect(...args) };
  class Resolver {}
  class PromiseResolver {}
  const dnsFake = { Resolver, promises: { Resolver: PromiseResolver } };
  for (const name of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse', 'setServers']) {
    dnsFake[name] = invoked('dns.' + name); dnsFake.promises[name] = invoked('dns.promise.' + name); Resolver.prototype[name] = invoked('resolver.' + name); PromiseResolver.prototype[name] = invoked('promiseResolver.' + name);
  }
  const proc = { stdout: { write: invoked('stdout') }, stderr: { write: invoked('stderr') }, nextTick: invoked('nextTick'),
    binding: invoked('binding'), _linkedBinding: invoked('_linkedBinding'), dlopen: invoked('dlopen'), chdir: invoked('chdir'), kill: invoked('kill'),
    setuid: invoked('setuid'), seteuid: invoked('seteuid'), setgid: invoked('setgid'), setegid: invoked('setegid'), setgroups: invoked('setgroups'), initgroups: invoked('initgroups'), emitWarning: invoked('emitWarning') };
  const timer = Object.fromEntries(['setTimeout', 'setImmediate', 'setInterval'].map(name => [name, invoked(name)]));
  const surface = { fs: files, net: network, tls: Object.fromEntries(['connect', 'createServer', 'createSecureContext'].map(name => [name, invoked('tls.' + name)])),
    dns: dnsFake, http: Object.fromEntries(['request', 'get', 'createServer'].map(name => [name, invoked('http.' + name)])),
    https: Object.fromEntries(['request', 'get', 'createServer'].map(name => [name, invoked('https.' + name)])), timers: timer, process: proc,
    globals: {}, console: { log: invoked('log'), error: invoked('error'), warn: invoked('warn') }, caller: () => caller };
  const effects = fixture.effectsState(); const boundary = fixture.installNativeBoundary({ files: { safe: sha(Buffer.from('safe')) } }, ports, effects,
    { retrieve() { throw new Error('outside-init'); } }, surface);
  return { surface, effects, calls, boundary, writers, setMeta(value) { meta = value; }, setCaller(value) { caller = value; } };
}
for (const name of ['writeFileSync', 'appendFile', 'renameSync', 'unlink', 'mkdirSync', 'symlink', 'copyFile', 'chmod', 'ftruncate', 'createWriteStream', 'watch', 'fsync', 'statfs', 'glob']) test('native filesystem writer ' + name, () => {
  const fake = fakeSurface(); rejected(() => fake.surface.fs[name]('/workspace/safe', 'bad')); assert.equal(fake.calls.length, 0); assert.equal(fake.effects.operationDenials, 1);
});
for (const name of ['writeFile', 'appendFile', 'copyFile', 'rename', 'rm', 'mkdir', 'symlink', 'watch', 'glob']) test('promise writer ' + name, () => {
  const fake = fakeSurface(); rejected(() => fake.surface.fs.promises[name]('/workspace/safe', 'bad')); assert.equal(fake.calls.length, 0);
});
for (const filename of ['/etc/passwd', '/tmp/private', '/workspace/../etc/passwd', '/workspace/not-declared']) test('native undeclared read ' + filename, () => {
  const fake = fakeSurface(); rejected(() => fake.surface.fs.readFileSync(filename)); assert.equal(fake.calls.length, 0);
});
test('admitted read uses captured primitive and rejects file identity drift', () => {
  const fake = fakeSurface(); assert.equal(fake.surface.fs.readFileSync('/workspace/safe').toString(), 'safe');
  fake.setMeta({ isFile: () => true, isSymbolicLink: () => true, nlink: 1 }); rejected(() => fake.surface.fs.readFileSync('/workspace/safe'));
  fake.setMeta({ isFile: () => true, isSymbolicLink: () => false, nlink: 2 }); rejected(() => fake.surface.fs.readFileSync('/workspace/safe')); assert.equal(fake.calls.length, 1);
});
for (const flags of ['w', 'w+', 'a', 'r+', fs.constants.O_RDWR, fs.constants.O_CREAT | fs.constants.O_RDONLY]) test('read open rejects write flags ' + flags, () => {
  const fake = fakeSurface(); rejected(() => fake.surface.fs.openSync('/workspace/safe', flags));
});
test('owned read FD only, closes eligibility permanently', () => {
  const fake = fakeSurface(); rejected(() => fake.surface.fs.readSync(0)); const fd = fake.surface.fs.openSync('/workspace/safe', 'r');
  fake.surface.fs.readSync(fd); fake.surface.fs.closeSync(fd); rejected(() => fake.surface.fs.readSync(fd));
});
test('read APIs reject hidden writer flags/custom fs/unowned FD', () => {
  const fake = fakeSurface(); rejected(() => fake.surface.fs.readFileSync('/workspace/safe', { flag: 'w' }));
  rejected(() => fake.surface.fs.createReadStream('/workspace/safe', { fd: 0 })); rejected(() => fake.surface.fs.createReadStream('/workspace/safe', { fs: {} }));
  rejected(() => fake.surface.fs.promises.readFile('/workspace/safe', { flag: 'r+' })); assert.equal(fake.calls.length, 0);
});
test('promise read handle retains read API and denies every write method', async () => {
  const fake = fakeSurface(); const handle = await fake.surface.fs.promises.open('/workspace/safe', 'r');
  handle.readFile(); for (const name of ['appendFile', 'writeFile', 'write', 'writev', 'truncate', 'chmod', 'chown', 'utimes', 'createWriteStream']) rejected(() => handle[name]('bad'));
  assert.deepEqual(fake.calls, ['handle.readFile']);
});
test('Mongo network requires client activation and captured public caller', () => {
  const fake = fakeSurface(); rejected(() => fake.surface.net.connect({ host: '127.0.0.1', port: 27017 }));
  fake.boundary.mongoStarted(); fake.surface.net.createConnection({ host: '127.0.0.1', port: 27017 }); assert.deepEqual(fake.calls, ['socket.connect']);
  fake.setCaller('at domain (/workspace/compiled/domain.js:1:1)'); rejected(() => fake.surface.net.connect({ host: '127.0.0.1', port: 27017 }));
  fake.boundary.mongoClosed(); rejected(() => fake.surface.net.connect({ host: '127.0.0.1', port: 27017 }));
});
for (const value of [{ host: '192.0.2.1', port: 27017 }, { host: 'fixture.invalid', port: 27017 }, { host: '127.0.0.1', port: 80 }, { host: '127.0.0.1', port: '27017' }, { path: '/tmp/socket' }]) test('reject network target ' + JSON.stringify(value), () => {
  const fake = fakeSurface(); fake.boundary.mongoStarted(); rejected(() => fake.surface.net.connect(value)); assert.equal(fake.calls.length, 0);
});
for (const [owner, name] of [['http', 'request'], ['http', 'get'], ['https', 'request'], ['https', 'createServer'], ['tls', 'connect'], ['tls', 'createSecureContext'], ['net', 'createServer'], ['dns', 'lookup'], ['dns', 'resolveSrv']]) test('permanent native denial ' + owner + '.' + name, () => {
  const fake = fakeSurface(); rejected(() => fake.surface[owner][name]()); assert.equal(fake.calls.length, 0);
});
test('DNS promises/resolvers/server listen aliases remain denied', () => {
  const fake = fakeSurface(); rejected(() => fake.surface.dns.promises.lookup('localhost')); rejected(() => new fake.surface.dns.Resolver().resolve4('localhost'));
  rejected(() => new fake.surface.dns.promises.Resolver().resolveTxt('localhost')); rejected(() => new fake.surface.net.Server().listen(27017)); assert.equal(fake.calls.length, 0);
});
for (const name of ['binding', '_linkedBinding', 'dlopen', 'chdir', 'kill', 'setuid', 'setgroups']) test('process escape ' + name, () => {
  const fake = fakeSurface(); rejected(() => fake.surface.process[name]()); assert.equal(fake.calls.length, 0);
});
test('fetch, console, warning and raw stdio attempts are latched', () => {
  const fake = fakeSurface(); rejected(() => fake.surface.globals.fetch('https://fixture.invalid')); rejected(() => fake.surface.console.warn('private'));
  rejected(() => fake.surface.process.emitWarning('private')); rejected(() => fake.surface.process.stdout.write('private'));
  assert.equal(fake.effects.consoleCalls, 2); assert.equal(fake.effects.warnings, 1); rejected(() => fake.boundary.assertClean()); assert.equal(fake.calls.length, 0);
});
test('timers require active owned driver; domain/interval remain denied', () => {
  const fake = fakeSurface(); rejected(() => fake.surface.timers.setTimeout(() => {}, 1)); fake.boundary.mongoStarted();
  fake.surface.timers.setTimeout(() => {}, 1); assert.deepEqual(fake.calls, ['setTimeout']); rejected(() => fake.surface.timers.setInterval(() => {}, 1));
  fake.setCaller('at domain (/workspace/compiled/domain.js:1:1)'); rejected(() => fake.surface.globals.setTimeout(() => {}, 1));
});

for (const source of ['eval("x")', 'new Function("x")', 'import("node:fs")', 'process.getBuiltinModule("fs")', 'module.constructor', 'setTimeout(()=>{},1)', 'require(name)', 'globalThis.fetch("x")']) test('domain source audit rejects ' + source, () => rejected(() => fixture.auditDomainSource(Buffer.from(source))));
test('domain literal imports and ordinary class constructor are accepted as data', () => fixture.auditDomainSource(Buffer.from("const m = require('mongoose'); class Repository { constructor() {} }")));

function modelFixture() {
  class Mongoose {}
  const mongoose = new Mongoose(); const models = {}; const calls = []; let importing = false;
  mongoose.Mongoose = Mongoose;
  mongoose.model = function (name, schema, collection) {
    assert.equal(this, mongoose); calls.push({ name, schema, collection, receiver: this });
    return schema ? { collection: { collectionName: collection || ports.models.find(row => row.name === name).collection } } : models[name];
  };
  fixture.installModelRegistrationBoundary(mongoose, ports, models, () => importing);
  return { mongoose, models, calls, importing: value => { importing = value; } };
}
test('actual model wrapper preserves unbound named import for all three singleton models', () => {
  const data = modelFixture(); data.importing(true); const namedModel = data.mongoose.model;
  for (const name of fixture.MODEL_NAMES) {
    const schema = {}; const value = (0, namedModel)(name, schema);
    assert.equal(value, data.models[name]); assert.equal(data.calls.at(-1).receiver, data.mongoose);
  }
  data.importing(false);
  for (const name of fixture.MODEL_NAMES) assert.equal((0, namedModel)(name), data.models[name]);
  assert.equal(data.calls.length, 6);
});
for (const mode of ['foreign instance', 'prototype unbound', 'prototype foreign', 'unknown model', 'outside import', 'wrong collection', 'extra option', 'duplicate model']) {
  test('actual model wrapper rejects ' + mode, () => {
    const data = modelFixture(); const { mongoose } = data; data.importing(true); const schema = {};
    if (mode === 'foreign instance') rejected(() => new mongoose.Mongoose().model('InventoryItem', schema));
    else if (mode === 'prototype unbound') rejected(() => (0, mongoose.Mongoose.prototype.model)('InventoryItem', schema));
    else if (mode === 'prototype foreign') rejected(() => mongoose.Mongoose.prototype.model.call({}, 'InventoryItem', schema));
    else if (mode === 'unknown model') rejected(() => mongoose.model('Patient', schema));
    else if (mode === 'outside import') { data.importing(false); rejected(() => mongoose.model('InventoryItem', schema)); }
    else if (mode === 'wrong collection') rejected(() => mongoose.model('InventoryItem', schema, 'patients'));
    else if (mode === 'extra option') rejected(() => mongoose.model('InventoryItem', schema, 'inventoryitems', undefined));
    else { mongoose.model('InventoryItem', schema); rejected(() => mongoose.model('InventoryItem', schema)); assert.equal(data.calls.length, 1); return; }
    assert.equal(data.calls.length, 0);
  });
}
test('actual singleton and strictly bound prototype lookups remain available', () => {
  const data = modelFixture(); data.importing(true);
  for (const name of fixture.MODEL_NAMES) data.mongoose.model(name, {});
  data.importing(false);
  assert.equal(data.mongoose.Mongoose.prototype.model.call(data.mongoose, 'InventoryItem'), data.models.InventoryItem);
  assert.equal(data.mongoose.model('InventoryItem'), data.models.InventoryItem);
});
test('borrowed public model export retains singleton binding rather than granting foreign instance authority', () => {
  const data = modelFixture(); data.importing(true);
  assert.equal(data.mongoose.model.call(new data.mongoose.Mongoose(), 'InventoryItem', {}), data.models.InventoryItem);
  assert.equal(data.calls.length, 1); assert.equal(data.calls[0].receiver, data.mongoose);
});

function typeDiFixture(config = {}) {
  const empty = Symbol('EMPTY_VALUE'); const calls = []; let target = null;
  class ContainerInstance {
    constructor() { this.services = []; }
    set(metadata, value) {
      calls.push({ stage: 'instance', receiver: this, metadata, value, arity: arguments.length });
      if (config.throwValue) throw config.throwValue.value;
      if (config.onInstance) config.onInstance(metadata, value, Container);
      this.services.push({ ...metadata }); return this;
    }
  }
  class Container {
    static set(metadata, value) {
      calls.push({ stage: 'container', receiver: this, metadata, value, arity: arguments.length });
      if (config.beforeForward) config.beforeForward(this, metadata);
      this.globalInstance.set(...(config.forward ? config.forward(metadata, value) : [metadata, value]));
      if (config.twice) this.globalInstance.set(metadata, value);
      return this;
    }
  }
  Container.globalInstance = new ContainerInstance();
  const typedi = { Container, ContainerInstance };
  const guards = fixture.installTypeDiSetBoundary(typedi, () => target, empty);
  const metadata = type => ({ id: type, type, factory: undefined, multiple: false, global: false, eager: false, transient: false, value: empty });
  return { typedi, empty, calls, guards, metadata, run(type, action) { target = type; try { return action(metadata(type)); } finally { target = null; } } };
}
test('actual metadata guards allow exact Container.set to globalInstance.set(metadata, undefined) forwarding', () => {
  const data = typeDiFixture(); class InventoryItemRepository {}
  assert.equal(data.run(InventoryItemRepository, metadata => data.typedi.Container.set(metadata)), data.typedi.Container);
  assert.deepEqual(data.calls.map(row => [row.stage, row.arity, row.value]), [['container', 1, undefined], ['instance', 2, undefined]]);
  assert.equal(data.typedi.Container.globalInstance.services.length, 1);
  assert.equal(data.typedi.Container.globalInstance.services[0].value, data.empty);
});
for (const mode of ['outside decorator', 'foreign container', 'foreign instance', 'direct instance', 'static undefined extra', 'static concrete extra', 'wrong symbol', 'wrong type', 'eager', 'factory', 'instance missing undefined', 'instance extra undefined', 'instance concrete value']) {
  test('actual metadata forwarding boundary rejects ' + mode, () => {
    const forwarded = mode === 'instance missing undefined' ? metadata => [metadata]
      : mode === 'instance extra undefined' ? metadata => [metadata, undefined, undefined]
        : mode === 'instance concrete value' ? metadata => [metadata, 1] : undefined;
    const data = typeDiFixture({ forward: forwarded }); class InventoryItemRepository {}
    const action = metadata => {
      const { Container, ContainerInstance } = data.typedi;
      if (mode === 'outside decorator') return Container.set(metadata);
      if (mode === 'foreign container') return Container.set.call({ globalInstance: Container.globalInstance }, metadata);
      if (mode === 'foreign instance') return ContainerInstance.prototype.set.call(new ContainerInstance(), metadata, undefined);
      if (mode === 'direct instance') return Container.globalInstance.set(metadata, undefined);
      if (mode === 'static undefined extra') return Container.set(metadata, undefined);
      if (mode === 'static concrete extra') return Container.set(metadata, 1);
      if (mode === 'wrong symbol') metadata.value = Symbol('EMPTY_VALUE');
      else if (mode === 'wrong type') metadata.type = class Foreign {};
      else if (mode === 'eager') metadata.eager = true;
      else if (mode === 'factory') metadata.factory = () => { throw new Error('must never run'); };
      return Container.set(metadata);
    };
    rejected(() => mode === 'outside decorator' ? action(data.metadata(InventoryItemRepository)) : data.run(InventoryItemRepository, action));
    assert.equal(data.typedi.Container.globalInstance.services.length, 0);
  });
}
test('metadata forwarding lease binds exact original metadata object', () => {
  const data = typeDiFixture({ forward: metadata => [{ ...metadata }, undefined] }); class InventoryItemRepository {}
  rejected(() => data.run(InventoryItemRepository, metadata => data.typedi.Container.set(metadata)));
  assert.equal(data.calls.filter(row => row.stage === 'instance').length, 0);
});
test('metadata forwarding lease cannot replace the captured global instance', () => {
  const data = typeDiFixture({ beforeForward: container => { container.globalInstance = new data.typedi.ContainerInstance(); } }); class InventoryItemRepository {}
  rejected(() => data.run(InventoryItemRepository, metadata => data.typedi.Container.set(metadata)));
  assert.equal(data.calls.filter(row => row.stage === 'instance').length, 0);
});
test('metadata forwarding lease permits one instance stage only', () => {
  const data = typeDiFixture({ twice: true }); class InventoryItemRepository {}
  rejected(() => data.run(InventoryItemRepository, metadata => data.typedi.Container.set(metadata)));
  assert.equal(data.calls.filter(row => row.stage === 'instance').length, 1);
});
test('metadata forwarding lease rejects nested static registration', () => {
  const data = typeDiFixture({ onInstance: (metadata, value, container) => { container.set(metadata); } }); class InventoryItemRepository {}
  rejected(() => data.run(InventoryItemRepository, metadata => data.typedi.Container.set(metadata)));
  assert.equal(data.calls.filter(row => row.stage === 'container').length, 1);
});
for (const value of [undefined, null, false, 0, '']) test('metadata forwarding lease closes after falsy native failure ' + String(value), () => {
  const data = typeDiFixture({ throwValue: { value } }); class InventoryItemRepository {}
  data.run(InventoryItemRepository, metadata => {
    let caught = false; try { data.typedi.Container.set(metadata); } catch (error) { caught = true; assert.equal(error, value); }
    assert(caught); rejected(() => data.typedi.Container.globalInstance.set(metadata, undefined));
    caught = false; try { data.typedi.Container.set(metadata); } catch (error) { caught = true; assert.equal(error, value); }
    assert(caught);
  });
  assert.equal(data.calls.filter(row => row.stage === 'instance').length, 2);
});
for (const value of [undefined, null, false, 0, '']) test('metadata forwarding lease closes after falsy static failure ' + String(value), () => {
  const data = typeDiFixture({ beforeForward: () => { throw value; } }); class InventoryItemRepository {}
  data.run(InventoryItemRepository, metadata => {
    let caught = false; try { data.typedi.Container.set(metadata); } catch (error) { caught = true; assert.equal(error, value); }
    assert(caught); rejected(() => data.typedi.Container.globalInstance.set(metadata, undefined));
  });
  assert.equal(data.calls.filter(row => row.stage === 'instance').length, 0);
});

function readFixture(kind = 'SNAPSHOT') {
  let nanos = 0n; let throwNext = null; let clockReads = 0;
  const clock = () => { clockReads++; if (throwNext) { const value = throwNext.value; throwNext = null; throw value; } return nanos; };
  const budget = fixture.createReadBudget(kind, clock); const leases = new Set(); const cursors = [];
  const advance = millis => { nanos += BigInt(millis) * 1000000n; };
  function factory(config = {}) {
    return () => {
      advance(config.factoryMillis || 0); let index = 0; let initial = true;
      const cursor = {
        id: new FakeLong(0), closes: 0,
        async hasNext() {
          if (config.readFailure) throw config.readFailure.value;
          if (initial) { advance(config.readMillis || 0); initial = false; }
          return index < (config.rows || []).length;
        },
        async next() { advance(config.nextMillis || 0); return config.rows[index++]; },
        async close() { this.closes++; advance(config.closeMillis || 0); if (config.closeFailure) throw config.closeFailure.value; leases.delete(this); }
      };
      if (config.liveId) cursor.id = new FakeLong(1);
      cursors.push(cursor); if (!config.unowned) leases.add(cursor); return cursor;
    };
  }
  return { budget, leases, cursors, advance, clockReads: () => clockReads, failClock(value) { throwNext = { value }; },
    collect(config, limit = kind === 'SNAPSHOT' ? 16 : 32) { return fixture.collectReadCursor(factory(config), limit, budget, leases); } };
}
const rejectedAsync = action => assert.rejects(action, error => fixture.FAILURE_CODES.includes(error.message));
test('whole snapshot rejects three individually admissible two-second reads', async () => {
  const data = readFixture();
  await rejectedAsync(async () => { for (let i = 0; i < 3; i++) await data.collect({ readMillis: 2000 }); data.budget.check(); });
  assert(data.cursors.every(cursor => cursor.closes === 1)); assert.equal(data.leases.size, 0);
});
test('whole snapshot accepts exactly five seconds across all three closed cursors', async () => {
  const data = readFixture();
  for (const readMillis of [2000, 2000, 1000]) assert.deepEqual(await data.collect({ readMillis }), []);
  data.budget.check(); assert.equal(data.cursors.length, 3); assert(data.cursors.every(cursor => cursor.closes === 1));
});
test('metadata five-listing budget accepts exactly five seconds while excluding only private creation work', async () => {
  const data = readFixture('METADATA'); let creations = 0;
  for (let i = 0; i < 5; i++) {
    await data.collect({ readMillis: 1000 });
    if (i < 4) for (let j = 0; j < (i === 3 ? 7 : 6); j++) await data.budget.creation(async () => { creations++; data.advance(100000); });
  }
  data.budget.check(); assert.equal(creations, 25); assert.equal(data.cursors.length, 5);
});
test('metadata five listings share five seconds despite individually short reads', async () => {
  const data = readFixture('METADATA');
  await rejectedAsync(async () => { for (let i = 0; i < 5; i++) await data.collect({ readMillis: 1001 }); data.budget.check(); });
  assert(data.cursors.every(cursor => cursor.closes === 1)); assert.equal(data.leases.size, 0);
});
test('metadata creation pauses never reset time already charged to earlier listings', async () => {
  const data = readFixture('METADATA'); let creations = 0;
  await rejectedAsync(async () => {
    for (let i = 0; i < 5; i++) {
      await data.collect({ readMillis: 1001 });
      if (i < 4) for (let j = 0; j < (i === 3 ? 7 : 6); j++) await data.budget.creation(async () => { creations++; data.advance(100000); });
    }
  });
  assert.equal(creations, 25); assert(data.cursors.every(cursor => cursor.closes === 1)); rejected(() => data.budget.check());
});
test('metadata interstitial noncreation work remains inside the shared budget', async () => {
  const data = readFixture('METADATA'); await data.collect({ readMillis: 2500 }); data.advance(2501);
  await rejectedAsync(() => data.collect({})); rejected(() => data.budget.check());
});
for (const mode of ['factory', 'hasNext', 'next', 'close']) test('read budget checks before and after ' + mode, async () => {
  const data = readFixture(); const config = mode === 'factory' ? { factoryMillis: 5001 }
    : mode === 'hasNext' ? { readMillis: 5001 } : mode === 'next' ? { rows: [{}], nextMillis: 5001 } : { closeMillis: 5001 };
  await rejectedAsync(() => data.collect(config)); assert.equal(data.cursors[0].closes, 1); assert.equal(data.leases.size, 0);
  rejected(() => data.budget.check());
});
test('late final validation cannot pass after all cursors were individually closed', async () => {
  const data = readFixture(); for (let i = 0; i < 3; i++) await data.collect({ readMillis: 1500 });
  data.advance(501); rejected(() => data.budget.check());
});
test('caught budget failure remains latched across subsequent collection attempts', async () => {
  const data = readFixture(); await rejectedAsync(() => data.collect({ readMillis: 5001 }));
  await rejectedAsync(() => data.collect({})); assert.equal(data.cursors.length, 1); rejected(() => data.budget.check());
});
for (const value of [undefined, null, false, 0, '']) {
  test('collector preserves falsy first read failure despite later close failure ' + String(value), async () => {
    const data = readFixture(); let caught = false;
    try { await data.collect({ readFailure: { value }, closeFailure: { value: new Error('later close') } }); }
    catch (error) { caught = true; assert.equal(error, value); }
    assert(caught); assert.equal(data.cursors[0].closes, 1); assert.equal(data.leases.size, 0); rejected(() => data.budget.check());
  });
  test('collector preserves falsy close failure and latches it ' + String(value), async () => {
    const data = readFixture(); let caught = false;
    try { await data.collect({ closeFailure: { value } }); } catch (error) { caught = true; assert.equal(error, value); }
    assert(caught); assert.equal(data.cursors[0].closes, 1); rejected(() => data.budget.check());
  });
  test('creation preserves falsy mutation failure despite resume clock failure ' + String(value), async () => {
    const data = readFixture('METADATA'); let caught = false; const before = data.clockReads();
    try { await data.budget.creation(async () => { data.failClock(new Error('later resume')); throw value; }); }
    catch (error) { caught = true; assert.equal(error, value); }
    assert(caught); assert.equal(data.clockReads() - before, 2); rejected(() => data.budget.check());
  });
}
test('snapshot cannot pause its continuous clock for creation', async () => {
  const data = readFixture(); let called = false;
  await rejectedAsync(() => data.budget.creation(() => { called = true; })); assert.equal(called, false);
});
test('metadata creation cannot recursively pause or hide a caught budget failure', async () => {
  const data = readFixture('METADATA');
  await rejectedAsync(() => data.budget.creation(async () => { await rejectedAsync(() => data.budget.creation(async () => {})); }));
  rejected(() => data.budget.check());
});
test('metadata aggregate permits exactly100 rows over five listing cursors', async () => {
  const data = readFixture('METADATA'); let rows = 0;
  for (const count of [3, 32, 32, 30, 3]) rows += (await data.collect({ rows: Array.from({ length: count }, (_, i) => ({ i })) }, count === 3 ? 3 : 32)).length;
  assert.equal(rows, 100); data.budget.check();
});
test('metadata rejects aggregate102 rows although each listing is within its own cap', async () => {
  const data = readFixture('METADATA');
  await rejectedAsync(async () => { for (const count of [3, 32, 32, 32, 3]) await data.collect({ rows: Array.from({ length: count }, (_, i) => ({ i })) }, count === 3 ? 3 : 32); });
  assert(data.cursors.every(cursor => cursor.closes === 1)); rejected(() => data.budget.check());
});
test('metadata rejects aggregate bytes while every individual cursor stays below128KiB', async () => {
  const data = readFixture('METADATA');
  await rejectedAsync(async () => { for (let i = 0; i < 5; i++) await data.collect({ rows: [{ payload: 'x'.repeat(30000) }] }); });
  assert(data.cursors.every(cursor => cursor.closes === 1)); rejected(() => data.budget.check());
});
test('snapshot aggregate permits exactly128KiB including all three array delimiters', async () => {
  const data = readFixture(); const payload = 'x'.repeat(128 * 1024 - 6 - Buffer.byteLength(JSON.stringify({ payload: '' })));
  await data.collect({ rows: [{ payload }] }); await data.collect({}); await data.collect({}); data.budget.check();
});
test('snapshot aggregate rejects one byte beyond128KiB', async () => {
  const data = readFixture(); const payload = 'x'.repeat(128 * 1024 - 5 - Buffer.byteLength(JSON.stringify({ payload: '' })));
  await rejectedAsync(async () => { await data.collect({ rows: [{ payload }] }); await data.collect({}); await data.collect({}); });
});
test('snapshot aggregate retains64-row limit independently of per-cursor policy', async () => {
  const data = readFixture();
  await rejectedAsync(async () => { for (const count of [22, 22, 21]) await data.collect({ rows: Array.from({ length: count }, (_, i) => ({ i })) }, 32); });
});
test('collector retains individual row caps and exhaustion proof', async () => {
  const data = readFixture('METADATA'); await rejectedAsync(() => data.collect({ rows: Array.from({ length: 33 }, () => ({})) }, 32));
  const live = readFixture(); await rejectedAsync(() => live.collect({ liveId: true })); assert.equal(live.cursors[0].closes, 1);
});
test('unowned cursor cannot receive cleanup authority', async () => {
  const data = readFixture(); await rejectedAsync(() => data.collect({ unowned: true })); assert.equal(data.cursors[0].closes, 0);
});
test('captured read clock requires monotonic bigint observations', () => {
  rejected(() => fixture.createReadBudget('SNAPSHOT', () => 1)); let now = 2n;
  const budget = fixture.createReadBudget('SNAPSHOT', () => now); now = 1n; rejected(() => budget.check());
});

function wireFixture() {
  const effects = fixture.effectsState(); const wire = fixture.createWireBoundary({ database: 'sd_iq_' + 'a'.repeat(32) }, ports, cases, bson, effects);
  const control = sid(1); const action = sid(2); wire.ownSession(control, true); wire.ownSession(action);
  const row = cases.cases[0]; const ids = { pharmacy: new FakeObjectId('1'.repeat(24)), medicine: new FakeObjectId('2'.repeat(24)), targetItem: new FakeObjectId('3'.repeat(24)) };
  const scope = { row, token: {}, fixture: { ids }, sessionId: wire.sid(action), transaction: false };
  wire.phase('ACTION', scope);
  const started = { requestId: 1, commandName: 'find', databaseName: 'sd_iq_' + 'a'.repeat(32), command: { find: 'inventoryitems', filter: { pharmacyId: ids.pharmacy, medicineId: ids.medicine }, limit: 1, singleBatch: true, lsid: action, $db: 'sd_iq_' + 'a'.repeat(32) } };
  wire.expectCursor({ cursor: {}, command: 'find', collection: 'inventoryitems', database: started.databaseName, session: wire.sid(action), rowLimit: 1 });
  return { wire, effects, started, scope, control, action };
}
test('actual wire fixture correlates immutable started/succeeded typed records', () => {
  const { wire, started } = wireFixture(); wire.started(started);
  started.command.filter.pharmacyId = new FakeObjectId('4'.repeat(24));
  wire.succeeded({ requestId: 1, commandName: 'find', reply: { ok: 1, cursor: { id: 0, ns: started.databaseName + '.inventoryitems', firstBatch: [] } } });
  wire.assertHealthy(); const events = wire.events(); assert.equal(events.length, 2); events.pop(); assert.equal(wire.events().length, 2);
  assert.equal(wire.events()[0].command.filter.pharmacyId.toHexString(), '1'.repeat(24)); assert(Object.isFrozen(wire.events()[0].command.filter));
});
test('cursor reply requires primitive numeric positive zero and rejects Timestamp subclass', () => {
  const { wire, started, effects } = wireFixture(); wire.started(started);
  rejected(() => wire.succeeded({ requestId: 1, commandName: 'find', reply: { ok: 1,
    cursor: { id: new FakeTimestamp({ i: 0, t: 0 }), ns: started.databaseName + '.inventoryitems', firstBatch: [] } } }));
  assert.equal(effects.commandFailures, 1);
});
for (const commandName of ['getMore', 'killCursors']) test(commandName + ' rejects live APM reply and cannot acquire an outgoing cursor owner', () => {
  const data = wireFixture(); data.wire.started(data.started);
  rejected(() => data.wire.succeeded({ requestId: 1, commandName: 'find', reply: { ok: 1,
    cursor: { id: 1, ns: data.started.databaseName + '.inventoryitems', firstBatch: [] } } }));
  for (const [i, id] of [new FakeLong(1), new FakeTimestamp({ i: 1, t: 0 })].entries()) {
    const command = commandName === 'getMore' ? { getMore: id, collection: 'inventoryitems' } : { killCursors: 'inventoryitems', cursors: [id] };
    Object.assign(command, { lsid: data.action, $db: data.started.databaseName });
    rejected(() => data.wire.started({ requestId: i + 2, commandName, command, databaseName: data.started.databaseName }));
  }
  assert.equal(data.effects.commandFailures, 1); rejected(() => data.wire.assertHealthy());
});
test('closing a cursor rejects Timestamp instead of silently interpreting it as Long', () => {
  const { wire } = wireFixture(); wire.closeCursor(new FakeLong(0)); rejected(() => wire.closeCursor(new FakeTimestamp({ i: 0, t: 0 })));
});
test('initial transaction number requires Long and rejects Timestamp subclass', () => {
  const data = wireFixture(); data.scope.transaction = true; data.scope.row = cases.cases.find(row => row.id === 'IQS_ADJUST_COMMIT');
  Object.assign(data.started.command, { txnNumber: new FakeTimestamp({ i: 1, t: 0 }), autocommit: false,
    startTransaction: true, readConcern: { level: 'snapshot' } });
  rejected(() => data.wire.started(data.started));
});
test('gossip keyId accepts zero Long while rejecting zero Timestamp', () => {
  const gossip = keyId => ({ clusterTime: new FakeTimestamp({ i: 1, t: 1 }), signature: { hash: new FakeBinary(Buffer.alloc(20), 0), keyId } });
  const good = wireFixture(); good.started.command.$clusterTime = gossip(new FakeLong(0)); good.wire.started(good.started);
  const bad = wireFixture(); bad.started.command.$clusterTime = gossip(new FakeTimestamp({ i: 0, t: 0 })); rejected(() => bad.wire.started(bad.started));
});
for (const [name, mutate] of [
  ['unknown namespace', event => { event.databaseName = event.command.$db = 'other'; }],
  ['unknown collection', event => { event.command.find = 'users'; }],
  ['unknown session', event => { event.command.lsid = sid(9); }],
  ['unknown field', event => { event.command.comment = 'private'; }],
  ['wrong filter', event => { event.command.filter = {}; }],
  ['wrong read preference', event => { event.command.$readPreference = { mode: 'secondary' }; }],
  ['untyped gossip', event => { event.command.$clusterTime = { clusterTime: 1, signature: {} }; }],
  ['extra batchSize', event => { event.command.batchSize = 1; }],
  ['unbound transaction', event => { event.command.txnNumber = new FakeLong(1); }]
]) test('wire rejects ' + name, () => { const data = wireFixture(); mutate(data.started); rejected(() => data.wire.started(data.started)); assert(data.effects.unexpectedCommands > 0); rejected(() => data.wire.assertHealthy()); });
for (const reply of [{ ok: 0 }, { ok: 1, writeConcernError: {} }, { ok: 1, writeErrors: [] }]) test('wire rejects apparent success ' + JSON.stringify(reply), () => {
  const { wire, started, effects } = wireFixture(); wire.started(started); rejected(() => wire.succeeded({ requestId: 1, commandName: 'find', reply })); assert(effects.commandFailures > 0);
});
test('wire rejects missing/duplicate/mismatched completion', () => {
  const { wire, started } = wireFixture(); wire.started(started); rejected(() => wire.assertHealthy());
  rejected(() => wire.succeeded({ requestId: 2, commandName: 'find', reply: { ok: 1 } }));
});
test('unknown lsids cannot become authority by forged matching scope', () => {
  const data = wireFixture(); data.scope.sessionId = data.wire.sid(sid(9)); data.started.command.lsid = sid(9);
  rejected(() => data.wire.started(data.started));
});
test('unknown action write lsid is denied independently of cursor binding', () => {
  const data = wireFixture(); data.scope.sessionId = data.wire.sid(sid(9));
  rejected(() => data.wire.started({ requestId: 2, commandName: 'update', databaseName: data.started.databaseName,
    command: { update: 'inventoryitems', updates: [{ q: { _id: data.scope.fixture.ids.targetItem, __v: 0 }, u: { $set: { batches: [{}] }, $inc: { __v: 1 } } }],
      ordered: true, lsid: sid(9), $db: data.started.databaseName } }));
});
test('caught commandFailed is permanent even without raw error output', () => {
  const { wire, started, effects } = wireFixture(); wire.started(started); rejected(() => wire.failed({ requestId: 1, commandName: 'find', failure: new Error('private') }));
  assert.equal(effects.commandFailures, 1); assert.deepEqual(wire.events().at(-1), { kind: 'failed', requestId: 1, commandName: 'find' }); rejected(() => wire.assertHealthy());
});
test('unowned getMore cursor rejected before arbitrary continuation', () => {
  const data = wireFixture(); data.wire.phase('CONTROL', data.scope);
  rejected(() => data.wire.started({ requestId: 2, commandName: 'getMore', databaseName: data.started.databaseName,
    command: { getMore: new FakeLong(123), collection: 'inventoryitems', lsid: data.action, $db: data.started.databaseName } }));
});
function transactionWire() {
  const data = wireFixture(); data.scope.transaction = true; data.scope.row = cases.cases.find(row => row.id === 'IQS_ADJUST_COMMIT');
  Object.assign(data.started.command, { txnNumber: new FakeLong(1), autocommit: false, startTransaction: true, readConcern: { level: 'snapshot' } });
  data.wire.started(data.started);
  data.wire.succeeded({ requestId: 1, commandName: 'find', reply: { ok: 1, cursor: { id: 0, ns: data.started.databaseName + '.inventoryitems', firstBatch: [] } } });
  data.scope.terminal = 'COMMIT'; data.wire.phase('CONTROL', data.scope);
  const terminal = { requestId: 2, commandName: 'commitTransaction', databaseName: 'admin', command: { commitTransaction: 1,
    writeConcern: { w: 'majority', wtimeout: 5000 }, maxTimeMS: 5000, autocommit: false, txnNumber: new FakeLong(1), lsid: data.action, $db: 'admin' } };
  return { ...data, terminal };
}
test('manual transaction terminal requires one matched actual-style success event', () => {
  const { wire, terminal } = transactionWire(); wire.started(terminal); wire.succeeded({ requestId: 2, commandName: 'commitTransaction', reply: { ok: 1 } }); wire.assertHealthy();
  rejected(() => wire.started({ ...terminal, requestId: 3 }));
});
for (const [name, mutate] of [['wrong txnNumber', row => { row.command.txnNumber = new FakeLong(2); }],
  ['wrong write concern', row => { row.command.writeConcern.w = 1; }], ['wrong timeout', row => { row.command.maxTimeMS = 10000; }],
  ['unknown terminal session', row => { row.command.lsid = sid(9); }], ['startTransaction at terminal', row => { row.command.startTransaction = true; }],
  ['abort instead of commit', row => { row.commandName = 'abortTransaction'; delete row.command.commitTransaction; delete row.command.maxTimeMS; row.command.abortTransaction = 1; }]]) test('terminal rejects ' + name, () => {
  const data = transactionWire(); mutate(data.terminal); rejected(() => data.wire.started(data.terminal));
});
test('terminal acknowledged failure cannot be hidden by later successful completion', () => {
  const data = transactionWire(); data.wire.started(data.terminal);
  rejected(() => data.wire.succeeded({ requestId: 2, commandName: 'commitTransaction', reply: { ok: 1, writeConcernError: { code: 64 } } }));
  rejected(() => data.wire.assertHealthy()); assert.equal(data.effects.commandFailures, 1);
});

function cleanupFixture() {
  const target = new FakeObjectId('1'.repeat(24)); const other = new FakeObjectId('2'.repeat(24));
  const adjustment = new FakeObjectId('3'.repeat(24)); const reservation = new FakeObjectId('4'.repeat(24)); const created = new FakeObjectId('5'.repeat(24));
  const eligible = { inventoryitems: [target, other], inventoryadjustments: [adjustment], inventoryreservations: [reservation] };
  const proof = { emptyProved: true, seedIds: Object.fromEntries(Object.entries(eligible).map(([name, ids]) => [name, new Set(ids.map(id => id.toHexString()))])),
    returnedNewId: created.toHexString(), observedNewId: created.toHexString(), inserted: { _id: created } };
  const oid = value => { assert(value instanceof FakeObjectId); return value.toHexString(); };
  return { eligible, proof, oid, created };
}
function returnedFixture() {
  const pharmacy = new FakeObjectId('1'.repeat(24)); const medicine = new FakeObjectId('2'.repeat(24));
  const fixtureData = { ids: { pharmacy, medicine }, generated: new Set([pharmacy.toHexString(), medicine.toHexString()]) };
  const result = { item: { _id: new FakeObjectId('3'.repeat(24)), pharmacyId: pharmacy, medicineId: medicine } };
  return { fixtureData, result };
}
test('new-row ownership accepts actual repository plain toObject return shape', () => {
  const data = returnedFixture(); assert.equal(fixture.returnedNewItemId(data.result, 'adjustBatchStock', data.fixtureData, bson), '3'.repeat(24));
});
for (const [name, mutate] of [['string ID', data => { data.result.item._id = '3'.repeat(24); }], ['wrong tuple', data => { data.result.item.pharmacyId = new FakeObjectId('4'.repeat(24)); }],
  ['old generated ID', data => { data.result.item._id = data.fixtureData.ids.pharmacy; }], ['nonplain response', data => { data.result.item = Object.create({ _id: new FakeObjectId('3'.repeat(24)) }); }]]) test('new-row return ownership rejects ' + name, () => {
  const data = returnedFixture(); mutate(data); rejected(() => fixture.returnedNewItemId(data.result, 'adjustBatchStock', data.fixtureData, bson));
});
test('eligible cleanup is exact seeded IDs and independently qualified new row', () => {
  const data = cleanupFixture(); data.eligible.inventoryitems.push(data.created);
  const actual = fixture.validateCleanupIds(data.eligible, data.proof, data.oid);
  assert.deepEqual(actual, data.eligible); assert.notEqual(actual.inventoryitems, data.eligible.inventoryitems);
});
for (const [name, mutate] of [['no independent empty proof', data => { data.proof.emptyProved = false; }],
  ['unowned negative probe', data => { data.eligible.inventoryitems.push(new FakeObjectId('9'.repeat(24))); }],
  ['created ID without returned proof', data => { data.eligible.inventoryitems.push(data.created); data.proof.returnedNewId = null; }],
  ['created ID without database proof', data => { data.eligible.inventoryitems.push(data.created); data.proof.observedNewId = null; }],
  ['created ID without held inserted row', data => { data.eligible.inventoryitems.push(data.created); data.proof.inserted = null; }],
  ['created ID mismatch', data => { data.eligible.inventoryitems.push(data.created); data.proof.inserted._id = new FakeObjectId('8'.repeat(24)); }],
  ['other collection cannot acquire new row', data => { data.eligible.inventoryadjustments.push(data.created); }],
  ['duplicate eligible ID', data => { data.eligible.inventoryitems.push(data.eligible.inventoryitems[0]); }],
  ['extra collection', data => { data.eligible.users = []; }], ['sparse array', data => { data.eligible.inventoryitems = new Array(2); }],
  ['accessor ID', data => { Object.defineProperty(data.eligible.inventoryitems, '0', { get() { throw new Error('must-not-evaluate'); }, enumerable: true }); }]]) test('cleanup rejects ' + name, () => {
  const data = cleanupFixture(); mutate(data); rejected(() => fixture.validateCleanupIds(data.eligible, data.proof, data.oid));
});

test('private seed lease admits exact native insertMany delegation then closes', async () => {
  const lease = fixture.createSeedBulkLease(); const collection = {}; const control = {}; const documents = [{ _id: 1 }, { _id: 2 }];
  const operations = documents.map(document => ({ insertOne: { document } }));
  await lease.run(collection, documents, async () => {
    await Promise.resolve(); lease.assertBulk(collection, operations, { session: control }, control); lease.assertOrdered(collection, { session: control }, control);
  });
  lease.assertIdle(); rejected(() => lease.assertBulk(collection, operations, { session: control }, control));
});
for (const [name, mutate] of [['different collection', data => { data.collection = {}; }], ['wrong session', data => { data.options.session = {}; }],
  ['unordered', data => { data.options.ordered = false; }], ['extra operation', data => { data.operations.push(data.operations[0]); }],
  ['delete operation', data => { data.operations[0] = { deleteOne: { filter: {} } }; }], ['copied document', data => { data.operations[0].insertOne.document = { _id: 1 }; }],
  ['extra operation option', data => { data.operations[0].insertOne.bypassDocumentValidation = true; }], ['sparse ops', data => { data.operations = new Array(2); }]]) test('private seed lease rejects ' + name, async () => {
  const lease = fixture.createSeedBulkLease(); const collection = {}; const control = {}; const documents = [{ _id: 1 }, { _id: 2 }];
  await lease.run(collection, documents, async () => {
    const data = { collection, options: { session: control }, operations: documents.map(document => ({ insertOne: { document } })) };
    mutate(data); rejected(() => lease.assertBulk(data.collection, data.operations, data.options, control));
  }); lease.assertIdle();
});
for (const value of [undefined, null, false, 0, '']) test('seed async lease closes after exact falsy throw ' + String(value), async () => {
  const lease = fixture.createSeedBulkLease(); let caught = false;
  try { await lease.run({}, [{}], async () => { await Promise.resolve(); throw value; }); } catch (error) { caught = true; assert.equal(error, value); }
  assert(caught); lease.assertIdle(); rejected(() => lease.assertOrdered({}, { session: 1 }, 1));
});
test('OS projection proves actual clone, exact function refs and resolver identity', async () => {
  const projection = Object.fromEntries(['platform', 'arch', 'release', 'type'].map(name => [name, () => name]));
  const actual = { ...projection }; const adapters = { os: actual }; const runtime = { os: actual };
  await fixture.proveOSAdapter({ options: { runtimeAdapters: adapters, runtime: Promise.resolve(runtime) } }, projection);
  assert(Object.isFrozen(actual) && Object.isFrozen(adapters) && Object.isFrozen(runtime));
});
function constructorFixture() {
  const calls = []; let active = false; let captured;
  class OriginalClient { constructor(uri, options) { calls.push({ uri, options }); this.options = options; } }
  const projection = Object.fromEntries(['platform', 'arch', 'release', 'type'].map(name => [name, () => name]));
  const options = { ...ports.ownedConnection.options, runtimeAdapters: { os: { ...projection } } };
  const uri = 'mongodb://127.0.0.1:27017/sd_iq_' + 'a'.repeat(32) + '?replicaSet=sd_iq_rs_' + 'a'.repeat(32) + '&directConnection=true';
  const Constructor = fixture.guardOwnedClientConstructor(OriginalClient, () => active, uri, ports.ownedConnection.options, projection, value => { captured = value; });
  return { Constructor, OriginalClient, calls, options, uri, projection, active(value) { active = value; }, captured: () => captured };
}
test('native constructor guard runs before underlying constructor and permits one owned cloned adapter', () => {
  const data = constructorFixture(); rejected(() => new data.Constructor(data.uri, data.options)); assert.equal(data.calls.length, 0);
  data.active(true); const actual = new data.Constructor(data.uri, data.options);
  assert(actual instanceof data.OriginalClient); assert.equal(data.captured(), actual); assert.equal(data.calls.length, 1);
  assert.notEqual(actual.options.runtimeAdapters.os, data.projection); rejected(() => new data.Constructor(data.uri, data.options)); assert.equal(data.calls.length, 1);
});
for (const [name, mutate] of [['wrong URI', data => { data.uri = 'mongodb://192.0.2.1:27017/other'; }],
  ['missing OS adapter', data => { delete data.options.runtimeAdapters; }], ['wrong OS function', data => { data.options.runtimeAdapters.os.type = () => 'fake'; }],
  ['extra OS method', data => { data.options.runtimeAdapters.os.homedir = () => 'private'; }], ['wrong retry option', data => { data.options.retryWrites = true; }]]) test('constructor guard rejects before eager adapter resolution: ' + name, () => {
  const data = constructorFixture(); data.active(true); mutate(data); rejected(() => new data.Constructor(data.uri, data.options)); assert.equal(data.calls.length, 0);
});
test('constructor guard rejects apply and subclass aliases before original code', () => {
  const data = constructorFixture(); data.active(true); rejected(() => data.Constructor(data.uri, data.options));
  class Subclass extends data.Constructor {} rejected(() => new Subclass(data.uri, data.options)); assert.equal(data.calls.length, 0);
});
for (const mode of ['wrong-ref', 'extra-key', 'wrong-resolver', 'wrong-runtime-key', 'getter']) test('OS proof rejects ' + mode, async () => {
  const projection = Object.fromEntries(['platform', 'arch', 'release', 'type'].map(name => [name, () => name])); let actual = { ...projection };
  if (mode === 'wrong-ref') actual.release = () => 'fake'; if (mode === 'extra-key') actual.homedir = () => 'private';
  if (mode === 'getter') Object.defineProperty(actual, 'release', { get: () => projection.release });
  const runtime = mode === 'wrong-resolver' ? { os: { ...projection } } : mode === 'wrong-runtime-key' ? { os: actual, extra: 1 } : { os: actual };
  await assert.rejects(fixture.proveOSAdapter({ options: { runtimeAdapters: { os: actual }, runtime: Promise.resolve(runtime) } }, projection));
});

const validResult = () => ({ cases: ports.requiredCaseIds.map(id => ({ id, status: 'PASS' })), sensitivity: ports.requiredSensitivityIds.map(id => ({ id, detected: true })), providerSummary: Object.fromEntries(fixture.PROVIDERS.map(key => [key, 0])) });
test('exact20/8/allzero result accepted', () => fixture.validateResult(validResult(), ports));
for (const [name, mutate] of [['extra case', row => row.cases.push(row.cases[0])], ['missing case', row => row.cases.pop()], ['reordered cases', row => row.cases.reverse()],
  ['undetected variant', row => row.sensitivity[0].detected = false], ['positive provider', row => row.providerSummary.logger = 1], ['extra provider', row => row.providerSummary.other = 0], ['extra field', row => row.private = 'private']]) test('result rejects ' + name, () => {
  const value = validResult(); mutate(value); rejected(() => fixture.validateResult(value, ports));
});

function admittedData() {
  // These are inert bytes and fake compiler observations, not emitted app code.
  const files = {};
  for (const name of fixture.LIBRARY_NAMES) files['node_modules/typescript/lib/' + name] = Buffer.from('synthetic-library-' + name);
  for (let i = fixture.LIBRARY_NAMES.length; i < 2755; i++) files['node_modules/inert-fixture/file-' + i + '.js'] = Buffer.from('inert-not-executed');
  const modules = {};
  for (const name of Object.keys(ports.sourceFiles)) {
    const stem = name.slice(5, -3); const compiled = 'compiled/' + stem + '.js';
    modules['@/' + stem] = compiled; modules['@/' + stem.replace(/\/index$/, '')] = compiled; files[compiled] = Buffer.from('inert nominal bytes');
  }
  const mutants = {};
  for (const row of cases.sourceMutations) {
    const file = 'compiled/mutants/' + row.id + '.js'; files[file] = Buffer.from('inert variant bytes');
    mutants[row.id] = { source: 'src1/modules/pharmacyInventory/repository/index.ts', originalSha256: ports.sourceFiles['src1/modules/pharmacyInventory/repository/index.ts'], mutantSha256: row.predictedSourceSha256, file };
  }
  Object.assign(files, { 'bootstrap.cjs': Buffer.from('inert bootstrap bytes'), 'scenario.cjs': Buffer.from('inert scenario bytes'),
    'network-admission.mjs': Buffer.from('inert network bytes'), 'ports-manifest.json': portsBytes, 'cases.json': casesBytes, 'package-lock.json': lockBytes });
  const sourceFiles = { ...ports.sourceFiles };
  for (const name of ['bootstrap.cjs', 'scenario.cjs', 'ports-manifest.json', 'cases.json', 'prepare.py', 'compile.cjs', 'package-plan.json', 'npm-config-shield.cjs']) {
    sourceFiles['test/inventory-runtime/scenario/' + name] = files[name] ? sha(files[name]) : 'a'.repeat(64);
  }
  sourceFiles['test/application/app-bundle.mjs'] = 'b'.repeat(64); sourceFiles['package-lock.json'] = 'c'.repeat(64);
  const libraries = Object.fromEntries(fixture.LIBRARY_NAMES.map(name => [name, sha(files['node_modules/typescript/lib/' + name])]));
  const libraryIds = fixture.LIBRARY_NAMES.map(name => 'node_modules/typescript/lib/' + name);
  const probe = positive => ({ sourceId: positive ? 'VIRTUAL_BROAD_LIBRARY_POSITIVE.ts' : 'VIRTUAL_BROAD_LIBRARY_NEGATIVE.ts',
    sourceSha256: positive ? 'a87b8ce179592546ff13030df86086acbc248858e865ca6f7bc47d9e57aa9c6d' : 'b9c73432db9319697fc34612cbc2188123e6f29fb4b2716a9b388499bdc31bce',
    status: 'COMPLETE', programFiles: [positive ? 'VIRTUAL_BROAD_LIBRARY_POSITIVE.ts' : 'VIRTUAL_BROAD_LIBRARY_NEGATIVE.ts', ...libraryIds].sort(), libraryFiles: { ...libraries },
    diagnostics: positive ? [] : [{ sourceId: 'VIRTUAL_BROAD_LIBRARY_NEGATIVE.ts', code: 2322, category: 1, start: 13, length: 12, message: "Type 'string' is not assignable to type 'number'." }] });
  const old = probe(true); old.libraryFiles = {}; old.programFiles = [old.sourceId];
  old.diagnostics = [{ sourceId: null, code: 2318, category: 1, start: null, length: null, message: "Cannot find global type 'Array'." }];
  const libraryAdmission = { schema: 'SD-COMPILER-LIBRARY-ADMISSION-1', status: 'PASS', compiler: '5.9.3',
    compilerSha256: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
    options: { target: 7, module: 1, moduleResolution: 2, experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true, noEmit: true, skipLibCheck: true, types: [] },
    semanticProgram: { programFiles: [...libraryIds, ...Object.keys(ports.sourceFiles)].sort(), libraryFiles: { ...libraries } },
    positive: probe(true), negative: probe(false), oldHostControl: old, restoredPositive: probe(true) };
  const plan = { schema: 'SD-INVENTORY-QUALITY-PLAN-1', role: ports.role, sourceCommit: 'd'.repeat(40), sourceFiles, modules, mutants,
    models: copied(ports.models), modelDeclarations: fixture.MODEL_NAMES.slice().sort().map(name => ({ name, source: 'src1/modules/pharmacyInventory/model/index.ts', compiled: 'compiled/modules/pharmacyInventory/model/index.js' })),
    modelMapAudit: { status: 'STATIC_EMITTED_MODEL_MAP_VERIFIED', reachableModules: 5, modelCount: 3, applicationEvaluations: 0,
      controls: ['OMITTED_ADJUSTMENT_MODEL', 'EXTRA_UNREACHABLE_MODEL', 'DUPLICATE_MODEL', 'WRONG_MODEL_SOURCE', 'OMITTED_RESERVATION_MODEL'].map(id => ({ id, rejected: true })) },
    packageVersions: JSON.parse(lockBytes).packages[''].dependencies, lockSha: fixture.LOCK_SHA, portsSha: fixture.PORTS_SHA, casesSha: fixture.CASES_SHA,
    requiredCaseIds: [...ports.requiredCaseIds], requiredGroupMethodCounts: { ...ports.requiredGroupMethodCounts }, requiredSensitivityIds: [...ports.requiredSensitivityIds],
    providerCounterKeys: [...ports.providerCounterKeys], providerCounterScope: 'ALL_PHASES_INCLUDING_SENSITIVITY_ZERO', nominalMethodCalls: 139, unsafeMethodCalls: 8, restorationMethodCalls: 16,
    compilation: { status: 'TRANSPILE_ONLY_NOT_TYPECHECKED', compiler: '5.9.3', diagnostics: [], semanticDiagnostics: [{ code: 9999, message: 'synthetic-retained-diagnostic' }],
      semanticScope: 'DECLARED_SEVEN_SOURCE_CLOSURE_AND_PUBLIC_TYPES', fullBuild: false, libraryAdmission } };
  files['runtime-plan.json'] = Buffer.from(JSON.stringify(plan));
  const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const nonce = runId.replaceAll('-', '');
  const manifest = { schema: 'SD-INVENTORY-QUALITY-RUN-1', runId, role: ports.role, database: 'sd_iq_' + nonce, replicaSet: 'sd_iq_rs_' + nonce,
    mongoId: 'e'.repeat(64), templateSha: 'f'.repeat(64), files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)])),
    lockSha: fixture.LOCK_SHA, portsSha: fixture.PORTS_SHA, casesSha: fixture.CASES_SHA, sourceCommit: plan.sourceCommit };
  return { manifest, plan, ports: copied(ports), cases: copied(cases), observed: { runId, files } };
}
const admitted = data => fixture.validateAdmissionData(data.manifest, data.plan, data.ports, data.cases, data.observed);
test('full2777-byte-map/17-source/three-model admission accepts inert positive fixture', () => admitted(admittedData()));
for (const [name, mutate] of [
  ['wrong schema', d => { d.manifest.schema = 'SD-AUTH-API-RUN-1'; }], ['wrong role', d => { d.manifest.role = 'auth-user-wallet-api'; }],
  ['wrong run nonce', d => { d.manifest.database = 'sd_iq_' + '0'.repeat(32); }], ['missing runtime file', d => { delete d.observed.files['scenario.cjs']; }],
  ['extra runtime file', d => { d.observed.files.extra = Buffer.from('extra'); d.manifest.files.extra = sha(d.observed.files.extra); }],
  ['changed runtime bytes', d => { d.observed.files['scenario.cjs'] = Buffer.from('changed'); }], ['wrong cases binding', d => { d.manifest.casesSha = '0'.repeat(64); }],
  ['auth plan schema', d => { d.plan.schema = 'SD-AUTH-API-PLAN-1'; }], ['extra plan key', d => { d.plan.extra = true; }],
  ['missing source binding', d => { delete d.plan.sourceFiles['test/inventory-runtime/scenario/npm-config-shield.cjs']; }],
  ['extra source binding', d => { d.plan.sourceFiles.other = '0'.repeat(64); }], ['wrong original repo source', d => { d.plan.sourceFiles['src1/modules/pharmacyInventory/repository/index.ts'] = '0'.repeat(64); }],
  ['unmapped alias', d => { d.plan.modules['@/config/config'] = d.plan.modules['@/modules/pharmacyInventory/repository']; }],
  ['mutant source drift', d => { d.plan.mutants[ports.requiredSensitivityIds[0]].mutantSha256 = '0'.repeat(64); }],
  ['reordered case groups', d => { d.plan.requiredCaseIds.reverse(); }], ['changed counters', d => { d.plan.providerCounterScope = 'SOME_PHASES'; }],
  ['missing model control', d => { d.plan.modelMapAudit.controls.pop(); }], ['unchecked model control', d => { d.plan.modelMapAudit.controls[0].rejected = false; }],
  ['forged runtime model evaluation', d => { d.plan.modelMapAudit.applicationEvaluations = 1; }], ['transpile diagnostic', d => { d.plan.compilation.diagnostics.push({ code: 1 }); }],
  ['full build claim', d => { d.plan.compilation.fullBuild = true; }], ['semantic diagnostics omitted', d => { delete d.plan.compilation.semanticDiagnostics; }],
  ['legacy helper field', d => { d.plan.compilation.selectedHelperTypecheck = {}; }], ['bad library positive', d => { d.plan.compilation.libraryAdmission.positive.diagnostics.push({ code: 1 }); }],
  ['missing standard library', d => { delete d.plan.compilation.libraryAdmission.positive.libraryFiles['lib.es5.d.ts']; }],
  ['false old-host control', d => { d.plan.compilation.libraryAdmission.oldHostControl.diagnostics = []; }],
  ['unrestored host', d => { d.plan.compilation.libraryAdmission.restoredPositive.status = 'EXCEPTION'; }]
]) test('admission rejects ' + name, () => { const data = admittedData(); mutate(data); rejected(() => admitted(data)); });

async function main() {
  let completed = 0;
  for (const { name, action } of tests) {
    try { await action(); completed++; }
    catch (error) { output(JSON.stringify({ schema: 'SD-INVENTORY-BOOTSTRAP-UNIT-1', status: 'FAIL', test: name, completed, failed: 1, error: error?.message || 'UNKNOWN' }) + '\n'); process.exitCode = 1; return; }
  }
  output(JSON.stringify({ schema: 'SD-INVENTORY-BOOTSTRAP-UNIT-1', status: 'PASS', checks: completed, failed: 0,
    applicationEvaluations: 0, packageEvaluations: 0, DockerCalls: 0 }) + '\n');
}
main().catch(() => { output(JSON.stringify({ schema: 'SD-INVENTORY-BOOTSTRAP-UNIT-1', status: 'FAIL', failed: 1 }) + '\n'); process.exitCode = 1; });
