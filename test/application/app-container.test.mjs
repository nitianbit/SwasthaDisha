import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
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
  const state = { calls: [], engine: 'synthetic-engine', item: null, editResult: (result) => result };
  const executor = (args) => {
    state.calls.push([...args]);
    if (args[0] === 'info') return JSON.stringify([state.engine, 'linux']);
    if (args[0] === 'image') return JSON.stringify([{ Id: imageId, Os: 'linux', Architecture: 'arm64', RepoDigests: [pinnedImage], Config: { Env: baseEnv } }]);
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
