import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PROFILE, createApiRuntimeFixture, sha256, assertPathAbsent } from './platform.mjs';
import { evaluateNetworkAdmission } from '../application/app-bundle.mjs';

const CASES = Array.from({ length: 20 }, (_, i) => 'CASE_' + String(i).padStart(2, '0'));
const SENSITIVITY = ['OTP_UNCONDITIONAL_CONSUME', 'OTP_LOGIN_TARGET_UNBOUND'];
const net = evaluateNetworkAdmission({ tag: 'APP-NET-DIAG-1',
  entries: [{ name: 'lo', kind: 'symlink', flags: '0x9', type: '772', operstate: 'unknown' }],
  addressedInterfaces: [{ name: 'lo', addresses: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }] });
const template = () => ({ templateSha: 'a'.repeat(64), meta: {
  sourceCommit: 'b'.repeat(40), lockSha: sha256('{}'), portsSha: sha256('{}'),
}, files: { 'bootstrap.cjs': Buffer.from('// synthetic bootstrap, never executed\n'),
  'runtime-plan.json': Buffer.from(JSON.stringify({ schema: 'SD-AUTH-API-PLAN-1', role: PROFILE.role, requiredCaseIds: CASES, requiredSensitivityIds: SENSITIVITY, providerCounterKeys: ['unexpected'] })),
  'package-lock.json': Buffer.from('{}'), 'ports-manifest.json': Buffer.from('{}') } });

function transport() {
  const calls = []; const rows = new Map(); const receipts = [];
  const state = { calls, rows, receipts, drift: null, resultMutation: null, failNodeCreate: false, beforeNode: null,
    engineId: PROFILE.engineId, beforeInfo: null, afterMongoStart: null, afterNodeExit: null,
    leaveRemoved: false, afterRemove: null, failAbsence: false, extraPurposeId: null, rawOutput: null };
  const images = new Map([
    [PROFILE.nodeImage, { Id: 'sha256:' + '1'.repeat(64), Os: 'linux', Architecture: 'arm64', RepoDigests: [PROFILE.nodeImage],
      Config: { Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'NODE_VERSION=22.23.4'] } }],
    [PROFILE.mongoImage, { Id: 'sha256:' + '2'.repeat(64), Os: 'linux', Architecture: 'arm64', RepoDigests: [PROFILE.mongoImage],
      Config: { Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'MONGO_VERSION=8.0.34'], Volumes: { '/data/db': {}, '/data/configdb': {} } } }],
  ]);
  const executor = (args) => {
    calls.push([...args]);
    if (args[0] === 'info') { state.beforeInfo?.(); return JSON.stringify([state.engineId, 'linux']); }
    if (args[0] === 'ps') {
      const filter = args[args.indexOf('--filter') + 1];
      if (filter.startsWith('id=')) {
        if (state.failAbsence) throw Error('Synthetic unavailable absence proof');
        const id = filter.slice(3); return rows.has(id) ? id : '';
      }
      assert.equal(filter, 'label=swasthadisha.test.purpose=auth-api-runtime');
      return [...rows.keys(), ...(state.extraPurposeId ? [state.extraPurposeId] : [])].join('\n');
    }
    if (args[0] === 'image') return JSON.stringify([images.get(args[2])]);
    if (args[0] === 'create') {
      const imageAt = args.findIndex((v) => /^(node|mongo)@sha256:/.test(v));
      const image = args[imageAt]; const kind = image.startsWith('node@') ? 'node' : 'mongo';
      if (kind === 'node') { state.beforeNode?.(); if (state.failNodeCreate) throw Error('Synthetic unknown create'); }
      const options = {}; const env = []; const labels = {}; const tmpfs = {}; let mount;
      for (let i = 1; i < imageAt; i++) {
        const key = args[i];
        if (['--read-only', '--no-healthcheck'].includes(key) || key.startsWith('--pull=')) continue;
        const value = args[++i];
        if (key === '--env') env.push(value);
        else if (key === '--label') { const n = value.indexOf('='); labels[value.slice(0, n)] = value.slice(n + 1); }
        else if (key === '--tmpfs') { const n = value.indexOf(':'); tmpfs[value.slice(0, n)] = value.slice(n + 1); }
        else if (key === '--mount') mount = Object.fromEntries(value.split(',').map((v) => { const n = v.indexOf('='); return n < 0 ? [v, true] : [v.slice(0, n), v.slice(n + 1)]; }));
        else options[key] = value;
      }
      const id = createHash('sha256').update(options['--name']).digest('hex');
      rows.set(id, { Id: id, Name: '/' + options['--name'], Image: images.get(image).Id,
        Config: { Image: image, User: options['--user'], WorkingDir: options['--workdir'], Entrypoint: [options['--entrypoint']],
          Cmd: args.slice(imageAt + 1), Env: env, Labels: labels, Healthcheck: { Test: ['NONE'] } },
        HostConfig: { NetworkMode: options['--network'], PublishAllPorts: false, Privileged: false, ReadonlyRootfs: true,
          PidMode: '', UTSMode: '', UsernsMode: '', IpcMode: 'private', CgroupnsMode: 'private', Runtime: 'runc',
          GroupAdd: [], Sysctls: {}, CapAdd: [], Devices: [], DeviceRequests: [], Binds: [], VolumesFrom: [], Links: [], PortBindings: {},
          Memory: Number(options['--memory']), NanoCpus: 1_000_000_000, PidsLimit: Number(options['--pids-limit']),
          CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], LogConfig: { Type: 'none' }, Tmpfs: tmpfs,
          Mounts: mount ? [{ Type: 'bind', Source: mount.source, Target: mount.target, ReadOnly: true, BindOptions: { Propagation: 'rprivate' } }] : [] },
        NetworkSettings: { Networks: kind === 'mongo' ? { none: {} } : {}, Ports: kind === 'mongo' ? { '27017/tcp': null } : {} },
        Mounts: mount ? [{ Type: 'bind', Source: mount.source, Destination: mount.target, RW: false, Propagation: 'rprivate' }]
          : Object.keys(tmpfs).map((Destination) => ({ Type: 'tmpfs', Destination })),
        State: { Status: 'created', ExitCode: 0, OOMKilled: false } });
      return id;
    }
    if (args[0] === 'inspect') {
      const row = JSON.parse(JSON.stringify(rows.get(args[1])));
      state.drift?.(row); return JSON.stringify([row]);
    }
    if (args[0] === 'exec') {
      const row = rows.get(args[1]); const rs = row.Config.Cmd[row.Config.Cmd.indexOf('--replSet') + 1];
      return args.at(-1).includes('db.hello') ? JSON.stringify({ isWritablePrimary: true, setName: rs }) : '';
    }
    if (args[0] === 'start') {
      const row = rows.get(args.at(-1));
      if (!args.includes('--attach')) { row.State.Status = 'running'; state.afterMongoStart?.(row); return args.at(-1); }
      row.State.Status = 'exited';
      state.afterNodeExit?.([...rows.values()].find((r) => r.Config.Labels['swasthadisha.test.role'] === 'mongo'));
      const bundle = row.HostConfig.Mounts[0].Source;
      const admission = JSON.parse(readFileSync(join(bundle, '.admission.json')));
      const result = { schema: 'SD-AUTH-API-RESULT-1', runId: admission.runId, role: PROFILE.role,
        database: admission.database, replicaSet: admission.replicaSet, sourceCommit: admission.sourceCommit,
        domainScope: 'FOCUSED_PRODUCTION_ROUTERS', admissionPassed: true, egressBlocked: true,
        filesystemCanariesPassed: true, networkAdmission: net, failed: 0, skipped: 0,
        cases: CASES.map((id) => ({ id, status: 'PASS' })),
        sensitivity: SENSITIVITY.map((id) => ({ id, detected: true })), providerSummary: { unexpected: 0 } };
      state.resultMutation?.(result); return state.rawOutput ?? JSON.stringify(result);
    }
    if (args[0] === 'rm') { if (!state.leaveRemoved) assert.equal(rows.delete(args.at(-1)), true); state.afterRemove?.(); return args.at(-1); }
    throw Error('Unexpected synthetic transport operation');
  };
  return { state, executor, images, seams: { executor, template: template(), reportCreated: (receipt) => receipts.push(receipt) } };
}

function fixture(t, alter) {
  const parent = mkdtempSync(join(process.env.TMPDIR || '/private/tmp', 'api-platform-unit-'));
  const previous = process.env.TMPDIR; process.env.TMPDIR = parent;
  t.after(() => { process.env.TMPDIR = previous; rmSync(parent, { recursive: true, force: true }); });
  const fake = transport(); alter?.(fake);
  const handle = createApiRuntimeFixture({ endpoint: PROFILE.endpoint }, fake.seams);
  return { ...fake, handle, parent };
}

test('reject invalid request, operational configuration and incomplete fake seams before transport', () => {
  const fake = transport();
  for (const input of [{}, { endpoint: 'unix:///tmp/other.sock' }, { endpoint: PROFILE.endpoint, uri: 'mongodb://latest' }])
    assert.throws(() => createApiRuntimeFixture(input, fake.seams), /fixed endpoint/);
  for (const seams of [{ template: template() }, { executor: undefined, template: template() }, { executor: fake.executor }])
    assert.throws(() => createApiRuntimeFixture({ endpoint: PROFILE.endpoint }, seams), /explicit fake executor/);
  process.env.MONGODB_URL = 'mongodb://latest';
  try { assert.throws(() => createApiRuntimeFixture({ endpoint: PROFILE.endpoint }, fake.seams), /configuration is forbidden/); }
  finally { delete process.env.MONGODB_URL; }
  assert.equal(fake.state.calls.length, 0);
});

test('construction and pre-resource disposal make no Docker calls', (t) => {
  const f = fixture(t); const path = f.handle.directory;
  assert.equal(f.state.calls.length, 0); f.handle.dispose(); f.handle.dispose();
  assert.equal(f.state.calls.length, 0); assert.equal(existsSync(path), false);
});

test('positive two-resource lifecycle joins only owned Mongo namespace and removes Node first once', async (t) => {
  const f = fixture(t); const result = await f.handle.run();
  assert.equal(result.cases.length, 20); assert.equal(f.state.receipts.length, 2);
  const [mongo, node] = f.state.receipts;
  assert.equal(f.state.rows.get(node.id).HostConfig.NetworkMode, 'container:' + mongo.id);
  assert.equal(f.state.rows.get(mongo.id).HostConfig.NetworkMode, 'none');
  await assert.rejects(f.handle.run(), /already attempted/);
  const receipt = f.handle.dispose(); assert.equal(f.handle.dispose(), receipt);
  assert.deepEqual(receipt.exactIdsAbsent, [mongo.id, node.id]); assert.equal(receipt.workspaceAbsent, true);
  assert.equal(receipt.zeroPurposeLabels, true); assert.equal(receipt.engineId, PROFILE.engineId);
  assert.deepEqual(f.state.calls.filter((a) => a[0] === 'rm').map((a) => a.at(-1)), [node.id, mongo.id]);
  assert.equal(f.state.rows.size, 0); assert.equal(existsSync(f.handle.directory), false);
});

for (const [label, kind, mutate] of [
  ['mongo-network', 'mongo', (r) => { r.HostConfig.NetworkMode = 'bridge'; }],
  ['node-network', 'node', (r) => { r.HostConfig.NetworkMode = 'container:' + 'f'.repeat(64); }],
  ['node-root', 'node', (r) => { r.Config.User = '0:0'; }],
  ['mongo-image', 'mongo', (r) => { r.Image = 'sha256:' + 'f'.repeat(64); }],
  ['command', 'node', (r) => { r.Config.Cmd = ['-e', 'unsafe']; }],
  ['environment', 'node', (r) => { r.Config.Env.push('JWT_SECRET_KEY=unexpected'); }],
  ['privileged', 'mongo', (r) => { r.HostConfig.Privileged = true; }],
  ['host-namespace', 'node', (r) => { r.HostConfig.PidMode = 'host'; }],
  ['runtime', 'node', (r) => { r.HostConfig.Runtime = 'unreviewed'; }],
  ['group', 'node', (r) => { r.HostConfig.GroupAdd = ['0']; }],
  ['sysctl', 'mongo', (r) => { r.HostConfig.Sysctls = { unsafe: '1' }; }],
  ['capability', 'node', (r) => { r.HostConfig.CapAdd = ['NET_ADMIN']; }],
  ['published-port', 'mongo', (r) => { r.HostConfig.PortBindings = { '27017/tcp': [{}] }; }],
  ['memory', 'node', (r) => { r.HostConfig.Memory = 0; }],
  ['writable-bind', 'node', (r) => { r.Mounts[0].RW = true; }],
  ['mongo-host-mount', 'mongo', (r) => { r.HostConfig.Mounts.push({ Type: 'bind', Source: '/host' }); }],
  ['tmpfs', 'node', (r) => { r.HostConfig.Tmpfs = {}; }],
]) test('reject drift before affected start/cleanup: ' + label, async (t) => {
  const f = fixture(t); f.state.drift = (row) => { if (row.Config.Labels['swasthadisha.test.role'] === kind) mutate(row); };
  await assert.rejects(f.handle.run(), /changed/);
  assert.equal(f.state.calls.some((a) => a[0] === 'start' && (kind === 'mongo' || a.includes('--attach'))), false);
  assert.throws(() => f.handle.dispose(), /changed/);
  assert.equal(f.state.calls.filter((a) => a[0] === 'rm').length, 0);
});

test('unknown Node create acknowledgement preserves known resources and withholds cleanup', async (t) => {
  const f = fixture(t); f.state.failNodeCreate = true;
  await assert.rejects(f.handle.run(), /Synthetic unknown create/);
  assert.equal(f.handle.describe().uncertainCreate.kind, 'node');
  assert.throws(() => f.handle.dispose(), /Create outcome unresolved/);
  assert.equal(f.state.calls.filter((a) => a[0] === 'rm').length, 0);
});

for (const [label, mutate] of [
  ['skip', (r) => { r.skipped = 1; }], ['failure', (r) => { r.failed = 1; }],
  ['empty', (r) => { r.cases = []; }], ['duplicate', (r) => { r.cases[1] = r.cases[0]; }],
  ['forged-network', (r) => { r.networkAdmission = { tag: 'APP-NET-ADMIT-1' }; }],
  ['wrong-database', (r) => { r.database = 'latest'; }], ['wrong-source', (r) => { r.sourceCommit = 'f'.repeat(40); }],
  ['raw-token', (r) => { r.token = 'synthetic-secret'; }], ['case-otp', (r) => { r.cases[0].otp = 'synthetic-secret'; }],
]) test('reject false API evidence: ' + label, async (t) => {
  const f = fixture(t); f.state.resultMutation = mutate;
  await assert.rejects(f.handle.run(), /evidence mismatch/);
  await assert.rejects(f.handle.run(), /already attempted/);
  f.handle.dispose(); assert.equal(f.state.rows.size, 0);
});

test('unmanifested bundle source is rejected before any resource creation', async (t) => {
  const f = fixture(t); writeFileSync(join(f.handle.directory, 'bundle', 'unexpected.cjs'), '// not admitted');
  await assert.rejects(f.handle.run(), /Unmanifested/);
  assert.equal(f.state.calls.length, 0); f.handle.dispose();
});

test('replaced workspace with copied marker grants no ownership', async (t) => {
  const f = fixture(t); const path = f.handle.directory;
  const marker = readFileSync(join(path, '.owner.json'));
  renameSync(path, path + '-original'); mkdirSync(path); writeFileSync(join(path, '.owner.json'), marker);
  await assert.rejects(f.handle.run(), /identity changed/);
  assert.equal(f.state.calls.length, 0); assert.throws(() => f.handle.dispose(), /identity changed/);
});

test('missing mutation sensitivity cannot count as runtime acceptance', async (t) => {
  const f = fixture(t); f.state.resultMutation = (r) => { r.sensitivity = []; };
  await assert.rejects(f.handle.run(), /Sensitivity evidence mismatch/); f.handle.dispose();
});

test('raw or unexpected provider data cannot count as runtime acceptance', async (t) => {
  const f = fixture(t); f.state.resultMutation = (r) => { r.providerSummary = { unexpected: 0, payload: 'not permitted' }; };
  await assert.rejects(f.handle.run(), /provider evidence/); f.handle.dispose();
});

test('nested sensitivity payload is rejected with fixed safe error', async (t) => {
  const f = fixture(t); f.state.resultMutation = (r) => { r.sensitivity[0].token = 'synthetic-secret'; };
  await assert.rejects(f.handle.run(), { message: 'Sensitivity evidence mismatch' }); f.handle.dispose();
});

test('unknown numeric provider counters are rejected', async (t) => {
  const f = fixture(t); f.state.resultMutation = (r) => { r.providerSummary.token123 = 1; };
  await assert.rejects(f.handle.run(), /provider evidence/); f.handle.dispose();
});

test('invalid result JSON never echoes raw output', async (t) => {
  const f = fixture(t); f.state.rawOutput = '{"token":"synthetic-secret" invalid';
  await assert.rejects(f.handle.run(), { message: 'Invalid API result JSON' }); f.handle.dispose();
});

for (const keys of [['unexpected', 'token123'], ['unexpected', 'unexpected'], [], ['logger']]) {
  test('provider plan rejects unreviewed or incomplete keys: ' + JSON.stringify(keys), (t) => {
    const fake = transport(); const plan = JSON.parse(fake.seams.template.files['runtime-plan.json']); plan.providerCounterKeys = keys;
    fake.seams.template.files['runtime-plan.json'] = Buffer.from(JSON.stringify(plan));
    assert.throws(() => createApiRuntimeFixture({ endpoint: PROFILE.endpoint }, fake.seams), /provider counter plan/);
    assert.equal(fake.state.calls.length, 0);
  });
}

for (const stage of ['afterMongoStart', 'afterNodeExit']) for (const failure of ['stopped', 'OOM']) {
  test('Mongo liveness denial: ' + stage + '/' + failure, async (t) => {
    const f = fixture(t); f.state[stage] = (row) => {
      if (failure === 'stopped') row.State.Status = 'exited'; else row.State.OOMKilled = true;
    };
    await assert.rejects(f.handle.run(), /Mongo is not running without OOM/);
    if (stage === 'afterMongoStart') assert.equal(f.state.calls.filter((a) => a[0] === 'create').length, 1);
    // Cleanup needs ownership proof, not a healthy process.
    f.handle.dispose(); assert.equal(f.state.rows.size, 0);
  });
}

test('pre-existing purpose labels stop before create without adoption', async (t) => {
  const f = fixture(t); f.state.extraPurposeId = 'f'.repeat(64);
  await assert.rejects(f.handle.run(), /already exist/);
  assert.equal(f.state.calls.filter((a) => a[0] === 'create').length, 0);
  f.handle.dispose(); assert.equal(f.state.calls.filter((a) => a[0] === 'rm').length, 0);
});

for (const [name, arm, expected] of [
  ['stale-remove-ack', (s) => { s.leaveRemoved = true; }, /Exact owned ID absence/],
  ['unavailable-absence', (s) => { s.failAbsence = true; }, /unavailable absence proof/],
  ['engine-drift', (s) => { s.afterRemove = () => { s.engineId = 'different'; }; }, /engine identity changed/],
  ['remaining-purpose-label', (s) => { s.afterRemove = () => { s.extraPurposeId = 'f'.repeat(64); }; }, /resources remain/],
]) test('cleanup refuses incomplete readback: ' + name, async (t) => {
  const f = fixture(t); await f.handle.run(); arm(f.state);
  assert.throws(() => f.handle.dispose(), expected);
  assert.equal(f.handle.describe().cleanupUnresolved, true);
  assert.equal(existsSync(f.handle.directory), true);
  const removals = f.state.calls.filter((a) => a[0] === 'rm').length;
  assert.equal(removals, name === 'remaining-purpose-label' ? 2 : 1);
  assert.throws(() => f.handle.dispose(), /UNRESOLVED/);
  assert.equal(f.state.calls.filter((a) => a[0] === 'rm').length, removals);
});

test('workspace absence requires ENOENT rather than an unreadable path', () => {
  const error = (code) => { throw Object.assign(new Error('synthetic'), { code }); };
  assert.doesNotThrow(() => assertPathAbsent('/synthetic', () => error('ENOENT')));
  assert.throws(() => assertPathAbsent('/synthetic', () => error('EACCES')), /proof unavailable/);
  assert.throws(() => assertPathAbsent('/synthetic', () => ({})), /remains present/);
});
