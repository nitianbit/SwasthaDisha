import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMongoFixture } from './mongo-fixture.mjs';

const request = Object.freeze({ endpoint: 'unix:///synthetic/docker.sock', image: 'mongo@sha256:' + 'a'.repeat(64) });
const containerId = 'b'.repeat(64);

function fakeDocker() {
  const state = { daemon: 'synthetic-engine', calls: [], item: null, namespace: '', replicaSet: '' };
  function execute(args) {
    state.calls.push([...args]);
    if (args[0] === 'info') return JSON.stringify([state.daemon, 'linux']);
    if (args[0] === 'create') {
      const labels = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--label') {
          const [key, value] = args[i + 1].split('='); labels[key] = value;
        }
      }
      const run = labels['swasthadisha.test.run'];
      state.namespace = 'sd_test_' + run.replaceAll('-', '');
      state.replicaSet = 'sd_rs_' + run.replaceAll('-', '');
      state.item = {
        Id: containerId, Name: '/sd-mongo-' + run,
        Config: {
          Labels: labels, Image: request.image, User: '65534:65534', Entrypoint: ['mongod'],
          Cmd: ['--replSet', state.replicaSet, '--bind_ip', 'localhost', '--port', '27017', '--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false'],
        },
        HostConfig: {
          NetworkMode: 'none', PublishAllPorts: false, Privileged: false, ReadonlyRootfs: true,
          PidMode: '', Binds: null, Mounts: [], VolumesFrom: null, PortBindings: {},
          Memory: 1073741824, NanoCpus: 1_000_000_000, PidsLimit: 128,
          CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges=true'],
          Tmpfs: {
            '/data/db': 'rw,noexec,nosuid,size=536870912,mode=1777',
            '/data/configdb': 'rw,noexec,nosuid,size=16777216,mode=1777',
            '/tmp': 'rw,noexec,nosuid,size=67108864,mode=1777',
          },
        }, Mounts: [], NetworkSettings: { Ports: { '27017/tcp': null } },
      };
      return containerId;
    }
    if (args[0] === 'inspect') return JSON.stringify([state.item]);
    if (args[0] === 'exec') {
      const script = args.at(-1);
      if (script.includes('db.hello()')) return JSON.stringify({ isWritablePrimary: true, setName: state.replicaSet });
      if (script.includes('startTransaction')) return JSON.stringify({ database: state.namespace, replicaSet: state.replicaSet, version: 'synthetic', committed: 1, aborted: 0 });
    }
    return containerId;
  }
  return { state, execute };
}

test('the owned fixture lifecycle mutates only its acknowledged container ID', async () => {
  const { state, execute } = fakeDocker();
  const fixture = createMongoFixture(request, execute);
  assert.equal(Object.isFrozen(fixture), true);
  assert.match(fixture.database, /^sd_test_[a-f0-9]{32}$/);
  const create = state.calls.find(([command]) => command === 'create');
  assert.ok(create.includes('--pull=never'));
  assert.equal(create[create.indexOf('--network') + 1], 'none');
  assert.equal(create.some((arg) => ['-p', '--publish', '-v', '--volume'].includes(arg)), false);
  await fixture.start();
  assert.equal(fixture.probeTransactions().committed, 1);
  fixture.dispose();
  const mutations = state.calls.filter(([command]) => ['start', 'exec', 'rm'].includes(command));
  assert.ok(mutations.length >= 4);
  for (const args of mutations) assert.ok(args.includes(containerId));
  const count = state.calls.length;
  fixture.dispose();
  assert.equal(state.calls.length, count);
  await assert.rejects(() => fixture.start(), /disposed/);
});

for (const [label, override] of [
  ['TCP endpoint', { endpoint: 'tcp://remote.invalid:2375' }],
  ['SSH endpoint', { endpoint: 'ssh://remote.invalid' }],
  ['unpinned image', { image: 'mongo:8.0' }],
  ['another registry', { image: 'example.invalid/mongo@sha256:' + 'a'.repeat(64) }],
  ['supplied database URI', { uri: 'mongodb://shared.invalid/latest' }],
  ['supplied container ID', { id: containerId }],
]) {
  test(`${label} is rejected before any Docker call`, () => {
    const { state, execute } = fakeDocker();
    assert.throws(() => createMongoFixture({ ...request, ...override }, execute));
    assert.equal(state.calls.length, 0);
  });
}

for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
  test(`ambient ${key} cannot select a different Docker resource`, () => {
    const { state, execute } = fakeDocker();
    process.env[key] = 'synthetic-canary';
    try {
      assert.throws(() => createMongoFixture(request, execute), /overrides/);
      assert.equal(state.calls.length, 0);
    } finally { delete process.env[key]; }
  });
}

for (const [label, change] of [
  ['container ID', (item) => { item.Id = 'c'.repeat(64); }],
  ['run label', (item) => { item.Config.Labels['swasthadisha.test.run'] = 'other-run'; }],
  ['image', (item) => { item.Config.Image = 'mongo:latest'; }],
  ['root user', (item) => { item.Config.User = '0'; }],
  ['host network', (item) => { item.HostConfig.NetworkMode = 'host'; }],
  ['published port', (item) => { item.HostConfig.PortBindings = { '27017/tcp': [{ HostPort: '27017' }] }; }],
  ['host mount', (item) => { item.HostConfig.Binds = ['/host:/data/db']; }],
  ['persistent volume', (item) => { item.Mounts = [{ Type: 'volume', Destination: '/data/db' }]; }],
  ['writeable root', (item) => { item.HostConfig.ReadonlyRootfs = false; }],
  ['added capability', (item) => { item.HostConfig.CapAdd = ['SYS_ADMIN']; }],
  ['host IPC', (item) => { item.HostConfig.IpcMode = 'host'; }],
  ['host device', (item) => { item.HostConfig.Devices = [{ PathOnHost: '/dev/synthetic' }]; }],
  ['missing memory limit', (item) => { item.HostConfig.Memory = 0; }],
  ['changed tmpfs', (item) => { item.HostConfig.Tmpfs['/data/db'] = 'rw'; }],
]) {
  test(`${label} drift prevents start and cleanup`, async () => {
    const { state, execute } = fakeDocker();
    const fixture = createMongoFixture(request, execute);
    change(state.item);
    await assert.rejects(() => fixture.start(), /changed/);
    assert.throws(() => fixture.dispose(), /changed/);
    assert.equal(state.calls.some(([command]) => ['start', 'exec', 'rm'].includes(command)), false);
  });
}

test('daemon changes cannot redirect start or cleanup', async () => {
  const { state, execute } = fakeDocker();
  const fixture = createMongoFixture(request, execute);
  state.daemon = 'different-engine';
  await assert.rejects(() => fixture.start(), /daemon identity changed/);
  assert.throws(() => fixture.dispose(), /daemon identity changed/);
  assert.equal(state.calls.some(([command]) => ['start', 'exec', 'rm'].includes(command)), false);
});

test('no external or unknown container is adopted after an unacknowledged create', () => {
  const { state, execute } = fakeDocker();
  assert.throws(() => createMongoFixture(request, (args) => {
    if (args[0] === 'create') throw new Error('synthetic timeout');
    return execute(args);
  }), /not acknowledged/);
  assert.equal(state.calls.some(([command]) => ['inspect', 'start', 'exec', 'rm'].includes(command)), false);
});

test('an invalid returned container ID cannot authorize inspection or cleanup', () => {
  const { state, execute } = fakeDocker();
  assert.throws(() => createMongoFixture(request, (args) => args[0] === 'create' ? 'some-existing-container' : execute(args)), /trusted ID/);
  assert.equal(state.calls.some(([command]) => ['inspect', 'start', 'exec', 'rm'].includes(command)), false);
});

test('database effects require readiness and revalidate ownership after start', async () => {
  const { state, execute } = fakeDocker();
  const fixture = createMongoFixture(request, execute);
  assert.throws(() => fixture.probeTransactions(), /ready/);
  await fixture.start();
  state.item.Config.Labels['swasthadisha.test.run'] = 'other-run';
  const before = state.calls.filter(([command]) => command === 'exec').length;
  assert.throws(() => fixture.probeTransactions(), /ownership changed/);
  assert.equal(state.calls.filter(([command]) => command === 'exec').length, before);
});

test('a caller cannot change the captured image after creation', async () => {
  const { execute } = fakeDocker();
  const mutable = { ...request };
  const fixture = createMongoFixture(mutable, execute);
  mutable.image = 'mongo:latest';
  await fixture.start();
  fixture.dispose();
});

test('image admission validates the same single snapshot used for creation', () => {
  const { state, execute } = fakeDocker();
  let reads = 0;
  const changing = { endpoint: request.endpoint, get image() { return ++reads <= 2 ? request.image : 'mongo:8.0'; } };
  const fixture = createMongoFixture(changing, execute);
  assert.equal(reads, 1);
  const create = state.calls.find(([command]) => command === 'create');
  assert.ok(create.includes(request.image));
  assert.equal(create.includes('mongo:8.0'), false);
  fixture.dispose();
});

test('an initially unpinned getter is rejected before Docker is invoked', () => {
  const { state, execute } = fakeDocker();
  let reads = 0;
  assert.throws(() => createMongoFixture({
    endpoint: request.endpoint, get image() { return ++reads === 1 ? 'mongo:8.0' : request.image; },
  }, execute), /digest-pinned/);
  assert.equal(state.calls.length, 0);
});

test('a second start cannot issue another start command', async () => {
  const { state, execute } = fakeDocker();
  const fixture = createMongoFixture(request, execute);
  await fixture.start();
  await assert.rejects(() => fixture.start(), /already attempted/);
  assert.equal(state.calls.filter(([command]) => command === 'start').length, 1);
  fixture.dispose();
});

for (const [label, replacement] of [
  ['missing commit', { committed: 0 }], ['failed rollback', { aborted: 1 }],
  ['wrong namespace', { database: 'some_other_database' }], ['wrong replica set', { replicaSet: 'other_set' }],
]) {
  test(`${label} cannot produce passing transaction evidence`, async () => {
    const { state, execute } = fakeDocker();
    const fixture = createMongoFixture(request, (args) => {
      if (args[0] === 'exec' && args.at(-1).includes('startTransaction')) {
        return JSON.stringify({ database: state.namespace, replicaSet: state.replicaSet, committed: 1, aborted: 0, ...replacement });
      }
      return execute(args);
    });
    await fixture.start();
    assert.throws(() => fixture.probeTransactions(), /mismatched evidence/);
    fixture.dispose();
  });
}
