import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationFixture } from './app-container.mjs';
import { SOURCE_NAMES } from './app-bundle.mjs';

const endpoint = 'unix:///synthetic/docker.sock';
const pinnedImage = 'node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d';
const imageId = 'sha256:' + 'c'.repeat(64);
const id = 'd'.repeat(64);
const bundle = Object.freeze(Object.fromEntries(SOURCE_NAMES.map((name) => [name, '// synthetic-only\n'])));
const baseEnv = ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'NODE_VERSION=22.23.4', 'YARN_VERSION=1.22.22'];
const operations = { payments: 'create-order', sms: 'send', email: 'send', push: 'send',
  calendar: 'create-event', storage: 'put', queue: 'enqueue' };

function fakeDocker() {
  const state = { calls: [], engine: 'synthetic-engine', item: null, editResult: (result) => result,
    image: { Id: imageId, Os: 'linux', Architecture: 'arm64', RepoDigests: [pinnedImage], Config: { Env: [...baseEnv] } } };
  const executor = (args) => {
    state.calls.push([...args]);
    if (args[0] === 'info') return JSON.stringify([state.engine, 'linux']);
    if (args[0] === 'image') return JSON.stringify([state.image]);
    if (args[0] === 'create') {
      const get = (flag) => args[args.indexOf(flag) + 1];
      const env = []; const labels = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--env') env.push(args[i + 1]);
        if (args[i] === '--label') { const [key, value] = args[i + 1].split('='); labels[key] = value; }
      }
      const source = /source=([^,]+),target=/.exec(get('--mount'))[1];
      state.item = {
        Id: id, Name: '/' + get('--name'), Image: imageId,
        Config: { Labels: labels, Image: pinnedImage, User: '1000:1000', WorkingDir: '/workspace',
          Entrypoint: ['node'], Cmd: ['--permission', '--allow-fs-read=/workspace', '--allow-fs-read=/sys/class/net', '--allow-fs-write=/tmp', '/workspace/bootstrap.mjs'],
          Env: env, Healthcheck: { Test: ['NONE'] } },
        HostConfig: { NetworkMode: 'none', Privileged: false, ReadonlyRootfs: true,
          Memory: 536870912, NanoCpus: 1_000_000_000, PidsLimit: 64, CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges=true'], LogConfig: { Type: 'none' },
          Mounts: [{ Type: 'bind', Source: source, Target: '/workspace', ReadOnly: true, BindOptions: { Propagation: 'rprivate' } }],
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=67108864,mode=1777' } },
        Mounts: [{ Type: 'bind', Source: source, Destination: '/workspace', RW: false, Propagation: 'rprivate' }],
        NetworkSettings: { Networks: { none: {} }, Ports: {} },
        State: { Status: 'created', ExitCode: 0, OOMKilled: false },
      };
      return id;
    }
    if (args[0] === 'inspect') return JSON.stringify([state.item]);
    if (args[0] === 'start') {
      state.item.State.Status = 'exited';
      const env = Object.fromEntries(state.item.Config.Env.map((entry) => { const at = entry.indexOf('='); return [entry.slice(0, at), entry.slice(at + 1)]; }));
      const result = { runId: env.APP_RUN_ID, role: 'synthetic-ports-only', manifestSha: env.APP_MANIFEST_SHA,
        admissionPassed: true, egressBlocked: true, filesystemCanariesPassed: true, databaseMode: 'not-admitted', networkInterfaces: ['lo'],
        calls: Object.entries(operations).map(([port, operation]) => ({ port, operation, status: 'recorded', effect: false })),
        scenario: { literalSearchPassed: true, unknownOperationRejected: true } };
      return JSON.stringify(state.editResult(result));
    }
    if (args[0] === 'rm') return id;
    throw new Error('Unexpected synthetic Docker command');
  };
  return { state, executor, bundle, profile: { endpoint, engineId: 'synthetic-engine' } };
}

function fixture(t) {
  const transport = fakeDocker();
  const instance = createApplicationFixture({ endpoint }, transport);
  t.after(() => instance.dispose());
  return { ...transport, instance };
}

test('the owned application fixture runs once and removes only its own resources', (t) => {
  const { state, instance } = fixture(t);
  const create = state.calls.find((args) => args[0] === 'create');
  assert.ok(create.includes('--pull=never'));
  assert.ok(create.includes(pinnedImage));
  assert.equal(create[create.indexOf('--network') + 1], 'none');
  assert.equal(create.some((value) => ['-p', '--publish', '--volume', '-v'].includes(value)), false);
  const evidence = instance.run();
  assert.equal(evidence.calls.length, 7);
  assert.equal(Object.isFrozen(evidence.calls), true);
  assert.throws(() => instance.run(), /already attempted/);
  instance.dispose();
  assert.equal(existsSync(instance.directory), false);
  const count = state.calls.length;
  instance.dispose();
  assert.equal(state.calls.length, count);
  for (const args of state.calls.filter((args) => ['start', 'rm'].includes(args[0]))) assert.ok(args.includes(id));
});

for (const [label, request] of [
  ['remote endpoint', { endpoint: 'tcp://remote.invalid:2375' }],
  ['supplied image', { endpoint, image: 'node:latest' }],
  ['supplied DB URI', { endpoint, uri: 'mongodb://shared.invalid/latest' }],
  ['supplied directory', { endpoint, directory: '/shared' }],
  ['supplied container ID', { endpoint, id }],
]) {
  test(`${label} is refused before Docker`, () => {
    const transport = fakeDocker();
    assert.throws(() => createApplicationFixture(request, transport), /Only an explicit/);
    assert.equal(transport.state.calls.length, 0);
  });
}

for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'MONGODB_URL', 'PHARMACY_TEST_MONGODB_URI', 'PAYMENT_SECRET', 'NODE_OPTIONS']) {
  test(`ambient ${key} is refused before Docker`, () => {
    const transport = fakeDocker(); process.env[key] = 'synthetic-only';
    try {
      assert.throws(() => createApplicationFixture({ endpoint }, transport), /overrides/);
      assert.equal(transport.state.calls.length, 0);
    } finally { delete process.env[key]; }
  });
}

for (const [label, change] of [
  ['container ID', (item) => { item.Id = 'e'.repeat(64); }],
  ['engine image ID', (item) => { item.Image = 'sha256:' + 'f'.repeat(64); }],
  ['run label', (item) => { item.Config.Labels['swasthadisha.test.run'] = 'forged'; }],
  ['image reference', (item) => { item.Config.Image = 'node:latest'; }],
  ['environment', (item) => { item.Config.Env.push('PAYMENT_SECRET=synthetic'); }],
  ['command', (item) => { item.Config.Cmd = ['other.mjs']; }],
  ['root user', (item) => { item.Config.User = '0'; }],
  ['working directory', (item) => { item.Config.WorkingDir = '/'; }],
  ['healthcheck', (item) => { item.Config.Healthcheck.Test = ['CMD', 'synthetic']; }],
  ['network mode', (item) => { item.HostConfig.NetworkMode = 'bridge'; }],
  ['extra network', (item) => { item.NetworkSettings.Networks.bridge = {}; }],
  ['published port', (item) => { item.HostConfig.PortBindings = { '80/tcp': [{ HostPort: '1234' }] }; }],
  ['writable root', (item) => { item.HostConfig.ReadonlyRootfs = false; }],
  ['privilege', (item) => { item.HostConfig.Privileged = true; }],
  ['added capability', (item) => { item.HostConfig.CapAdd = ['SYS_ADMIN']; }],
  ['host IPC', (item) => { item.HostConfig.IpcMode = 'host'; }],
  ['weakened security profile', (item) => { item.HostConfig.SecurityOpt.push('seccomp=unconfined'); }],
  ['memory bound', (item) => { item.HostConfig.Memory = 0; }],
  ['tmpfs', (item) => { item.HostConfig.Tmpfs['/tmp'] = 'rw'; }],
  ['logging', (item) => { item.HostConfig.LogConfig.Type = 'json-file'; }],
  ['declared mount', (item) => { item.HostConfig.Mounts[0].Source = '/unowned'; }],
  ['effective mount', (item) => { item.Mounts[0].Source = '/unowned'; }],
  ['host bind syntax', (item) => { item.HostConfig.Binds = ['/host:/workspace']; }],
  ['declared writable mount', (item) => { item.HostConfig.Mounts[0].ReadOnly = false; }],
  ['writable mount', (item) => { item.Mounts[0].RW = true; }],
  ['extra mount', (item) => { item.Mounts.push({ Type: 'bind', Source: '/host', Destination: '/host', RW: true }); }],
]) {
  test(`${label} drift refuses start and destructive cleanup`, (t) => {
    const { state, instance } = fixture(t);
    const original = structuredClone(state.item);
    change(state.item);
    assert.throws(() => instance.run(), /changed/);
    assert.throws(() => instance.dispose(), /changed/);
    assert.equal(state.calls.some((args) => ['start', 'rm'].includes(args[0])), false);
    state.item = original;
  });
}

test('daemon drift cannot redirect execution or cleanup', (t) => {
  const { state, instance } = fixture(t);
  state.engine = 'different-engine';
  assert.throws(() => instance.run(), /engine identity changed/);
  assert.throws(() => instance.dispose(), /engine identity changed/);
  assert.equal(state.calls.some((args) => ['start', 'rm'].includes(args[0])), false);
  state.engine = 'synthetic-engine';
});

test('changed bundle bytes are denied before any container start', (t) => {
  const { state, instance } = fixture(t);
  const source = join(instance.directory, 'bundle/scenario.mjs');
  chmodSync(source, 0o644); writeFileSync(source, '// changed');
  assert.throws(() => instance.run(), /source hash changed/);
  assert.equal(state.calls.some((args) => args[0] === 'start'), false);
});

for (const [label, edit] of [
  ['wrong identity', (result) => { result.runId = 'forged'; }],
  ['missing admission', (result) => { result.admissionPassed = false; }],
  ['network success', (result) => { result.egressBlocked = false; }],
  ['external interface', (result) => { result.networkInterfaces.push('eth0'); }],
  ['database mode', (result) => { result.databaseMode = 'external'; }],
  ['missing port', (result) => { result.calls.pop(); }],
  ['duplicate port', (result) => { result.calls[1] = result.calls[0]; }],
  ['reported effect', (result) => { result.calls[0].effect = true; }],
  ['wrong operation', (result) => { result.calls[0].operation = 'settle-real-funds'; }],
  ['missing scenario assertion', (result) => { result.scenario.literalSearchPassed = false; }],
]) {
  test(`${label} cannot produce passing application evidence`, (t) => {
    const { state, instance } = fixture(t);
    state.editResult = (result) => { edit(result); return result; };
    assert.throws(() => instance.run(), /evidence mismatched/);
  });
}

test('an image lookup failure cleans only its fresh filesystem workspace', () => {
  const before = readdirSync(tmpdir()).sort();
  const transport = fakeDocker();
  const executor = (args) => { if (args[0] === 'image') throw new Error('synthetic absent image'); return transport.executor(args); };
  assert.throws(() => createApplicationFixture({ endpoint }, { ...transport, executor }), /absent image/);
  assert.deepEqual(readdirSync(tmpdir()).sort(), before);
  assert.equal(transport.state.calls.some((args) => ['create', 'start', 'rm'].includes(args[0])), false);
});

test('an unacknowledged create never adopts or removes a container', () => {
  const transport = fakeDocker();
  const executor = (args) => { if (args[0] === 'create') throw new Error('synthetic timeout'); return transport.executor(args); };
  assert.throws(() => createApplicationFixture({ endpoint }, { ...transport, executor }), /unresolved; cleanup withheld/);
  assert.equal(transport.state.calls.some((args) => ['inspect', 'start', 'rm'].includes(args[0])), false);
  // The fixed unit runner owns this entire temporary parent, including this intentional exception.
});

test('a getter is read once and cannot change the admitted endpoint', (t) => {
  const transport = fakeDocker(); let reads = 0;
  const instance = createApplicationFixture({ get endpoint() { reads++; return endpoint; } }, transport);
  t.after(() => instance.dispose());
  assert.equal(reads, 1);
});

for (const [label, change] of [
  ['nonzero exit', (state) => { state.item.State.ExitCode = 1; }],
  ['OOM kill', (state) => { state.item.State.OOMKilled = true; }],
  ['still-running container', (state) => { state.item.State.Status = 'running'; }],
]) {
  test(`${label} rejects an otherwise successful payload`, (t) => {
    const { state, instance } = fixture(t);
    state.editResult = (result) => { change(state); return result; };
    assert.throws(() => instance.run(), /did not exit successfully/);
  });
}

test('an invalid create ID never authorizes inspection or cleanup', () => {
  const transport = fakeDocker();
  const executor = (args) => args[0] === 'create' ? 'some-existing-container' : transport.executor(args);
  assert.throws(() => createApplicationFixture({ endpoint }, { ...transport, executor }), /unresolved; cleanup withheld/);
  assert.equal(transport.state.calls.some((args) => ['inspect', 'start', 'rm'].includes(args[0])), false);
});

test('an unreviewed engine cannot create an application container', () => {
  const transport = fakeDocker();
  transport.state.engine = 'unreviewed-engine';
  assert.throws(() => createApplicationFixture({ endpoint }, transport), /outside the reviewed local/);
  assert.equal(transport.state.calls.some((args) => ['create', 'start', 'rm'].includes(args[0])), false);
});


function rejectBeforeEffects(action) {
  const calls = { allocation: 0, socketMetadata: 0, process: 0 };
  const original = { mkdtempSync: fs.mkdtempSync, statSync: fs.statSync, spawnSync: childProcess.spawnSync };
  fs.mkdtempSync = () => { calls.allocation++; throw new Error('Unexpected filesystem allocation'); };
  fs.statSync = () => { calls.socketMetadata++; throw new Error('Unexpected socket access'); };
  childProcess.spawnSync = () => { calls.process++; throw new Error('Unexpected Docker process'); };
  syncBuiltinESMExports();
  try {
    assert.throws(action, /explicit callable test executor/);
    assert.deepEqual(calls, { allocation: 0, socketMetadata: 0, process: 0 });
  } finally {
    fs.mkdtempSync = original.mkdtempSync;
    fs.statSync = original.statSync;
    childProcess.spawnSync = original.spawnSync;
    syncBuiltinESMExports();
  }
}

for (const [name, settings] of [
  ['profile-only', { profile: { endpoint, engineId: 'synthetic-engine' } }],
  ['bundle-only', { bundle }],
  ['combined', { profile: { endpoint, engineId: 'synthetic-engine' }, bundle }],
]) {
  for (const [kind, executor] of [['omitted', undefined], ['undefined', undefined], ['null', null],
    ['object', {}], ['string', 'not-callable'], ['boolean', false]]) {
    test(`${name} overrides with ${kind} executor are rejected before allocation or Docker`, () => {
      const seams = { ...settings };
      if (kind !== 'omitted') seams.executor = executor;
      rejectBeforeEffects(() => createApplicationFixture({ endpoint }, seams));
    });
  }
}

for (const settings of [{ profile: undefined }, { profile: null }, { bundle: undefined }, { bundle: null }]) {
  test(`present ${Object.keys(settings)[0]} override cannot hide behind a nullish value`, () => {
    rejectBeforeEffects(() => createApplicationFixture({ endpoint }, settings));
  });
}

test('a callable executor is snapshotted once and never falls back to real transport', (t) => {
  const transport = fakeDocker(); let reads = 0;
  const seams = { profile: transport.profile, bundle, get executor() { return ++reads === 1 ? transport.executor : undefined; } };
  const instance = createApplicationFixture({ endpoint }, seams);
  t.after(() => instance.dispose());
  assert.equal(reads, 1);
  assert.equal(instance.run().calls.length, 7);
});

for (const [name, change] of [
  ['NODE_OPTIONS', (image) => { image.Config.Env.push('NODE_OPTIONS=synthetic-not-executed'); }],
  ['extra environment key', (image) => { image.Config.Env.push('SYNTHETIC_EXTRA=1'); }],
  ['PATH equals suffix', (image) => { image.Config.Env[0] += '=x'; }],
  ['duplicate environment key', (image) => { image.Config.Env.push(image.Config.Env[0]); }],
  ['RepoDigest mismatch', (image) => { image.RepoDigests = ['node@sha256:' + 'f'.repeat(64)]; }],
  ['image volumes', (image) => { image.Config.Volumes = { '/data': {} }; }],
]) {
  test(`${name} is denied by image admission before create`, () => {
    const transport = fakeDocker(); change(transport.state.image);
    assert.throws(() => createApplicationFixture({ endpoint }, transport), /runtime image environment|Pinned Linux image/);
    assert.equal(transport.state.calls.some((args) => ['create', 'start', 'rm'].includes(args[0])), false);
  });
}

test('a different well-formed Unix endpoint is not the recorded profile', () => {
  const transport = fakeDocker();
  assert.throws(() => createApplicationFixture({ endpoint: 'unix:///different/docker.sock' }, transport), /outside the reviewed local/);
  assert.equal(transport.state.calls.length, 0);
});

test('replaced ownership marker prevents execution and cleanup', (t) => {
  const { state, instance } = fixture(t);
  const marker = join(instance.directory, '.owner.json'); const original = readFileSync(marker);
  try {
    writeFileSync(marker, JSON.stringify({ runId: 'forged' }));
    assert.throws(() => instance.run(), /Workspace ownership changed/);
    assert.throws(() => instance.dispose(), /Workspace ownership changed/);
    assert.equal(state.calls.some((args) => ['start', 'rm'].includes(args[0])), false);
  } finally { writeFileSync(marker, original); }
});

test('a replacement directory with a copied marker does not acquire ownership', (t) => {
  const { state, instance } = fixture(t);
  const originalDirectory = instance.directory + '-original';
  const marker = readFileSync(join(instance.directory, '.owner.json'));
  renameSync(instance.directory, originalDirectory);
  try {
    mkdirSync(instance.directory); writeFileSync(join(instance.directory, '.owner.json'), marker);
    assert.throws(() => instance.run(), /Workspace identity changed/);
    assert.throws(() => instance.dispose(), /Workspace identity changed/);
    assert.equal(state.calls.some((args) => ['start', 'rm'].includes(args[0])), false);
  } finally {
    rmSync(instance.directory, { recursive: true, force: false });
    renameSync(originalDirectory, instance.directory);
  }
});

test('acknowledged container removal is not repeated after workspace-cleanup failure', (t) => {
  const { state, instance } = fixture(t); const original = fs.rmSync;
  fs.rmSync = (path, options) => {
    if (path === instance.directory) throw Object.assign(new Error('synthetic cleanup denial'), { code: 'EACCES' });
    return original(path, options);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => instance.dispose(), /synthetic cleanup denial/); }
  finally { fs.rmSync = original; syncBuiltinESMExports(); }
  assert.equal(state.calls.filter((args) => args[0] === 'rm').length, 1);
  const beforeRetry = state.calls.length;
  instance.dispose();
  assert.equal(state.calls.length, beforeRetry);
  assert.equal(existsSync(instance.directory), false);
});

test('a disappeared pre-create workspace does not replace the original failure', () => {
  const transport = fakeDocker(); const originalAllocate = fs.mkdtempSync;
  const cause = new Error('synthetic original metadata failure'); let directory;
  fs.mkdtempSync = (...args) => { directory = originalAllocate(...args); return directory; };
  syncBuiltinESMExports();
  const executor = (args) => {
    if (args[0] === 'info') { rmSync(directory, { recursive: true, force: false }); throw cause; }
    return transport.executor(args);
  };
  try { assert.throws(() => createApplicationFixture({ endpoint }, { ...transport, executor }), (error) => error === cause); }
  finally { fs.mkdtempSync = originalAllocate; syncBuiltinESMExports(); }
  assert.equal(existsSync(directory), false);
  assert.equal(transport.state.calls.some((args) => ['create', 'start', 'rm'].includes(args[0])), false);
});
