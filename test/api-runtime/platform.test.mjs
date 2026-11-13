import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PROFILE, PRIVATE_DOCUMENT_PROFILE, CUSTOMER_CONTACT_PROFILE, PHARMACY_REFILL_PROFILE, createPharmacyRefillRuntimeFixture, createApiRuntimeFixture, createPrivateDocumentRuntimeFixture, createCustomerContactRuntimeFixture, sha256, assertPathAbsent, decodeDockerResult, fixtureFailureCodes } from './platform.mjs';
import { evaluateNetworkAdmission } from '../application/app-bundle.mjs';

const CASES = Array.from({ length: 20 }, (_, i) => 'CASE_' + String(i).padStart(2, '0'));
const SENSITIVITY = ['OTP_UNCONDITIONAL_CONSUME', 'OTP_LOGIN_TARGET_UNBOUND'];
const net = evaluateNetworkAdmission({ tag: 'APP-NET-DIAG-1',
  entries: [{ name: 'lo', kind: 'symlink', flags: '0x9', type: '772', operstate: 'unknown' }],
  addressedInterfaces: [{ name: 'lo', addresses: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }] });
const PRIVATE_CASES = ['ADMISSION', 'DEFAULT_CLOSED', 'OBSERVED_CATALOG', 'AUTH_AND_SCOPE', 'UNBOUND_CAPTURE',
  'BOUND_CAPTURE', 'MULTIPART_LIMITS', 'IMMUTABLE_DEDUPE', 'CAPTURE_RACE', 'VALIDATION', 'RELEASE', 'HISTORICAL_BYTES',
  'LIST_AND_DTO', 'REVOKE_REPLAY', 'READ_AUDIT', 'STREAM_AND_HASH', 'PRIVATE_HEADERS', 'LEGACY_READ_ALIASES',
  'LEGACY_WRITE_DELETE', 'TRANSACTION_ROLLBACK', 'POST_PARSE_TIMEOUT', 'ABORT_AND_LEASE', 'INITIAL_STAT_CLEANUP', 'FINAL_RESTORATION'];
const PRIVATE_SENSITIVITY = Array.from({ length: 8 }, (_, i) => 'PRIVATE_CONTROL_' + (i + 1));
const CONTACT_CASES = Array.from({ length: 32 }, (_, i) => 'CONTACT_GROUP_' + i);
const CONTACT_SENSITIVITY = Array.from({ length: 16 }, (_, i) => 'CONTACT_CONTROL_' + i);
const REFILL_CASES = ["ADMISSION", "AUTHENTICATION", "OPERATIONAL_AUTHORITY", "RAW_QUERY", "CALENDAR", "LIMITS", "CURSOR_CANONICAL", "CURSOR_SCOPE", "DUE_SLICE", "SCALAR_FILTERS", "RAW_ROW_SHAPES", "BSON4_POSITIVES", "BSON4_HOSTILE", "DENSE_ARRAY", "DTO_AND_HEADERS", "QUERY_AND_CATALOG", "PERSISTED_RESUME", "PAUSE_AND_COMPATIBILITY", "UPDATE_AUTHORITY", "SENSITIVITY_AND_RESTORATION"];
const REFILL_SENSITIVITY = ["OWNER_AND_SCALAR_FENCES_REMOVED", "QUERY_ROW_BOUND_REMOVED", "RAW_QUERY_ALLOWLIST_WEAKENED", "PATIENT_FIELD_LEAKED", "UNDEFINED_RESUME_RESTORED", "SYMBOL_GETTER_GUARD_REGRESSED", "DENSE_ARRAY_GUARD_REGRESSED"];
const template = (privateRole = false) => ({ templateSha: 'a'.repeat(64), meta: {
  sourceCommit: 'b'.repeat(40), lockSha: sha256('{}'), portsSha: sha256('{}'),
}, files: { 'bootstrap.cjs': Buffer.from('// synthetic bootstrap, never executed\n'),
  'runtime-plan.json': Buffer.from(JSON.stringify({ schema: privateRole === 'refill' ? 'SD-PHARMACY-REFILL-API-PLAN-1' : privateRole === 'contact' ? 'SD-CUSTOMER-CONTACT-API-PLAN-1' : privateRole ? 'SD-PRIVATE-DOCUMENT-API-PLAN-1' : 'SD-AUTH-API-PLAN-1',
    role: privateRole === 'refill' ? PHARMACY_REFILL_PROFILE.role : privateRole === 'contact' ? CUSTOMER_CONTACT_PROFILE.role : privateRole ? PRIVATE_DOCUMENT_PROFILE.role : PROFILE.role,
    requiredCaseIds: privateRole === 'refill' ? REFILL_CASES : privateRole === 'contact' ? CONTACT_CASES : privateRole ? PRIVATE_CASES : CASES,
    requiredSensitivityIds: privateRole === 'refill' ? REFILL_SENSITIVITY : privateRole === 'contact' ? CONTACT_SENSITIVITY : privateRole ? PRIVATE_SENSITIVITY : SENSITIVITY,
    providerCounterKeys: privateRole === 'refill' ? ['logger', 'unexpected'] : privateRole === 'contact' ? ['unexpected', 'wallet'] : ['unexpected'] })),
  'package-lock.json': Buffer.from('{}'), 'ports-manifest.json': Buffer.from('{}') } });

function transport(privateRole = false) {
  const contactRole = privateRole === 'contact'; const refillRole = privateRole === 'refill';
  const selectedProfile = refillRole ? PHARMACY_REFILL_PROFILE : contactRole ? CUSTOMER_CONTACT_PROFILE : privateRole ? PRIVATE_DOCUMENT_PROFILE : PROFILE;
  const selectedCases = refillRole ? REFILL_CASES : contactRole ? CONTACT_CASES : privateRole ? PRIVATE_CASES : CASES;
  const selectedSensitivity = refillRole ? REFILL_SENSITIVITY : contactRole ? CONTACT_SENSITIVITY : privateRole ? PRIVATE_SENSITIVITY : SENSITIVITY;
  const calls = []; const rows = new Map(); const receipts = [];
  const state = { calls, rows, receipts, drift: null, resultMutation: null, failNodeCreate: false, beforeNode: null,
    engineId: selectedProfile.engineId, beforeInfo: null, afterMongoStart: null, afterNodeExit: null,
    leaveRemoved: false, afterRemove: null, failAbsence: false, extraPurposeId: null, rawOutput: null, failAttach: false,
    ordinaryProbeFailures: 0, terminalProbe: null };
  const images = new Map([
    [selectedProfile.nodeImage, { Id: 'sha256:' + '1'.repeat(64), Os: 'linux', Architecture: 'arm64', RepoDigests: [selectedProfile.nodeImage],
      Config: { Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'NODE_VERSION=22.23.4'] } }],
    [selectedProfile.mongoImage, { Id: 'sha256:' + '2'.repeat(64), Os: 'linux', Architecture: 'arm64', RepoDigests: [selectedProfile.mongoImage],
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
      assert.equal(filter, 'label=swasthadisha.test.purpose=' + (refillRole ? 'pharmacy-refill-api-runtime' : contactRole ? 'customer-contact-api-runtime' : privateRole ? 'private-document-api-runtime' : 'auth-api-runtime'));
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
      if (state.terminalProbe) return decodeDockerResult({ status: null, stdout: '',
        ...(state.terminalProbe === 'TIMEOUT' ? { error: { code: 'ETIMEDOUT' } } : { signal: 'SIGTERM' }) }, args, new Set());
      if (state.ordinaryProbeFailures > 0) {
        state.ordinaryProbeFailures--;
        return decodeDockerResult({ status: 1, stdout: 'synthetic not ready' }, args, new Set());
      }
      const row = rows.get(args[1]); const rs = row.Config.Cmd[row.Config.Cmd.indexOf('--replSet') + 1];
      return args.at(-1).includes('db.hello') ? JSON.stringify({ isWritablePrimary: true, setName: rs }) : '';
    }
    if (args[0] === 'start') {
      const row = rows.get(args.at(-1));
      if (!args.includes('--attach')) { row.State.Status = 'running'; state.afterMongoStart?.(row); return args.at(-1); }
      row.State.Status = 'exited';
      if (state.failAttach) return decodeDockerResult({ status: 1, stdout: JSON.stringify({ schema: 'SD-AUTH-API-FAILURE-1',
        stage: 'ROUTER_IMPORT', code: 'RUNTIME_FIXTURE_FAILED', errorType: 'Error', fieldNames: [], failed: 1, skipped: 0 }) }, args,
      new Set(['RUNTIME_FIXTURE_FAILED']));
      state.afterNodeExit?.([...rows.values()].find((r) => r.Config.Labels['swasthadisha.test.role'] === 'mongo'));
      const bundle = row.HostConfig.Mounts[0].Source;
      const admission = JSON.parse(readFileSync(join(bundle, '.admission.json')));
      const result = { schema: refillRole ? 'SD-PHARMACY-REFILL-API-RESULT-1' : contactRole ? 'SD-CUSTOMER-CONTACT-API-RESULT-1' : privateRole ? 'SD-PRIVATE-DOCUMENT-API-RESULT-1' : 'SD-AUTH-API-RESULT-1', runId: admission.runId, role: selectedProfile.role,
        database: admission.database, replicaSet: admission.replicaSet, sourceCommit: admission.sourceCommit,
        domainScope: refillRole ? 'FOCUSED_PHARMACY_REFILL' : contactRole ? 'FOCUSED_CUSTOMER_CONTACT' : privateRole ? 'FOCUSED_PRIVATE_DOCUMENT_CORE' : 'FOCUSED_PRODUCTION_ROUTERS', admissionPassed: true, egressBlocked: true,
        filesystemCanariesPassed: true, networkAdmission: net, failed: 0, skipped: 0,
        cases: selectedCases.map((id) => ({ id, status: 'PASS' })),
        sensitivity: selectedSensitivity.map((id) => ({ id, detected: true })), providerSummary: refillRole ? { logger: 0, unexpected: 0 } : contactRole ? { unexpected: 0, wallet: 0 } : { unexpected: 0 } };
      state.resultMutation?.(result); return state.rawOutput ?? JSON.stringify(result);
    }
    if (args[0] === 'rm') { if (!state.leaveRemoved) assert.equal(rows.delete(args.at(-1)), true); state.afterRemove?.(); return args.at(-1); }
    throw Error('Unexpected synthetic transport operation');
  };
  return { state, executor, images, seams: { executor, template: template(privateRole), reportCreated: (receipt) => receipts.push(receipt) } };
}

function fixture(t, alter, privateRole = false) {
  const parent = mkdtempSync(join(process.env.TMPDIR || '/private/tmp', 'api-platform-unit-'));
  const previous = process.env.TMPDIR; process.env.TMPDIR = parent;
  t.after(() => { process.env.TMPDIR = previous; rmSync(parent, { recursive: true, force: true }); });
  const fake = transport(privateRole); alter?.(fake);
  const create = privateRole === 'refill' ? createPharmacyRefillRuntimeFixture : privateRole === 'contact' ? createCustomerContactRuntimeFixture : privateRole ? createPrivateDocumentRuntimeFixture : createApiRuntimeFixture;
  const handle = create({ endpoint: PROFILE.endpoint }, fake.seams);
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
  assert.equal(PROFILE.schema, 'SD-AUTH-API-PROFILE-2');
  assert.equal(PROFILE.indexBuildMinAvailableDiskSpaceMB, 64);
  assert.deepEqual(f.state.rows.get(mongo.id).Config.Cmd, ['--replSet', f.handle.replicaSet,
    '--bind_ip', 'localhost', '--port', '27017', '--wiredTigerCacheSizeGB', '0.25',
    '--setParameter', 'diagnosticDataCollectionEnabled=false',
    '--setParameter', 'indexBuildMinAvailableDiskSpaceMB=64']);
  await assert.rejects(f.handle.run(), /already attempted/);
  const receipt = f.handle.dispose(); assert.equal(f.handle.dispose(), receipt);
  assert.deepEqual(receipt.exactIdsAbsent, [mongo.id, node.id]); assert.equal(receipt.workspaceAbsent, true);
  assert.equal(receipt.zeroPurposeLabels, true); assert.equal(receipt.engineId, PROFILE.engineId);
  assert.deepEqual(f.state.calls.filter((a) => a[0] === 'rm').map((a) => a.at(-1)), [node.id, mongo.id]);
  assert.equal(f.state.rows.size, 0); assert.equal(existsSync(f.handle.directory), false);
});

for (const [label, kind, mutate] of [
  ['index-space-omitted', 'mongo', (r) => {
    const at = r.Config.Cmd.indexOf('indexBuildMinAvailableDiskSpaceMB=64');
    if (at > 0) r.Config.Cmd.splice(at - 1, 2);
  }],
  ['index-space-zero', 'mongo', (r) => { r.Config.Cmd = r.Config.Cmd.map(v => v === 'indexBuildMinAvailableDiskSpaceMB=64' ? 'indexBuildMinAvailableDiskSpaceMB=0' : v); }],
  ['index-space-changed', 'mongo', (r) => { r.Config.Cmd = r.Config.Cmd.map(v => v === 'indexBuildMinAvailableDiskSpaceMB=64' ? 'indexBuildMinAvailableDiskSpaceMB=65' : v); }],
  ['index-space-malformed', 'mongo', (r) => { r.Config.Cmd = r.Config.Cmd.map(v => v === 'indexBuildMinAvailableDiskSpaceMB=64' ? 'indexBuildMinAvailableDiskSpaceMB=64.0' : v); }],
  ['index-space-extra', 'mongo', (r) => { r.Config.Cmd.push('--setParameter', 'syntheticUnapprovedParameter=1'); }],
  ['index-space-duplicate', 'mongo', (r) => { r.Config.Cmd.push('--setParameter', 'indexBuildMinAvailableDiskSpaceMB=64'); }],
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

const childFailure = () => ({ schema: 'SD-AUTH-API-FAILURE-1', stage: 'API_SCENARIOS', code: 'ERROR_ENVELOPE',
  errorType: 'Error', fieldNames: [], failed: 1, skipped: 0 });
const safeCodes = new Set(['ERROR_ENVELOPE']);
function decodedFailure(result, args = ['start', '--attach', 'a'.repeat(64)]) {
  try { decodeDockerResult(result, args, safeCodes); } catch (error) { return error; }
  throw Error('Expected owned Docker failure');
}
test('fixed decoder returns successful stdout for subsequent existing result admission', () => {
  assert.equal(decodeDockerResult({ status: 0, stdout: ' synthetic ' }, ['info'], safeCodes), 'synthetic');
});
test('closed child failure projects only known stage and frozen fixture code', () => {
  const failure = childFailure(); failure.errorType = 'synthetic-secret'; failure.fieldNames = ['synthetic-secret'];
  const error = decodedFailure({ status: 1, stdout: JSON.stringify(failure), stderr: 'synthetic-secret' });
  assert.deepEqual(error.diagnostic, { operation: 'start', outcome: 'FAILED', child: { stage: 'API_SCENARIOS', code: 'ERROR_ENVELOPE' } });
  assert.equal(JSON.stringify(error.diagnostic).includes('synthetic-secret'), false);
  assert.equal(error.message, 'Owned Docker operation failed: start');
});
for (const [name, mutate] of [
  ['extra-token', f => { f.token = 'synthetic-secret'; }], ['unknown-code', f => { f.code = 'OTP_123456'; }],
  ['unknown-stage', f => { f.stage = 'synthetic-secret'; }], ['false-failure', f => { f.failed = 0; }],
  ['skip', f => { f.skipped = 1; }], ['missing-field', f => { delete f.fieldNames; }],
]) test('untrusted failure payload is not retained: ' + name, () => {
  const failure = childFailure(); mutate(failure);
  assert.equal(decodedFailure({ status: 1, stdout: JSON.stringify(failure) }).diagnostic.child, null);
});
test('invalid JSON has no raw parse snippet or error text in failure evidence', () => {
  const error = decodedFailure({ status: 1, stdout: '{"token":"synthetic-secret" invalid', error: new Error('synthetic-secret') });
  assert.equal(error.diagnostic.child, null); assert.equal(JSON.stringify(error.diagnostic).includes('synthetic-secret'), false);
});
test('timeout records a closed unresolved outcome without system error text', () => {
  const error = decodedFailure({ error: { code: 'ETIMEDOUT', message: 'synthetic-secret' }, signal: 'SIGTERM', status: null, stdout: '' });
  assert.equal(error.diagnostic.outcome, 'TIMEOUT'); assert.equal(JSON.stringify(error.diagnostic).includes('synthetic-secret'), false);
});
test('signal records interrupted outcome without raw signal/output evidence', () => {
  const error = decodedFailure({ signal: 'SIGKILL', status: null, stdout: 'synthetic-secret' });
  assert.deepEqual(error.diagnostic, { operation: 'start', outcome: 'INTERRUPTED', child: null });
});
test('other Docker operations cannot masquerade as an attached API failure', () => {
  assert.equal(decodedFailure({ status: 1, stdout: JSON.stringify(childFailure()) }, ['inspect']).diagnostic.child, null);
});
test('failure-code set derives only frozen public literals and known assertion suffixes', () => {
  const codes = fixtureFailureCodes({ 'bootstrap.cjs': Buffer.from("need(ok, 'ADMISSION_FAILED')"),
    'scenario.cjs': Buffer.from("deny('OTHER_OWNER')") });
  assert.equal(codes.has('OTHER_OWNER_STATUS'), true); assert.equal(codes.has('ADMISSION_FAILED'), true);
  assert.equal(codes.has('OTP_123456'), false);
});
test('failed attach retains a closed diagnostic through exact owned cleanup', async (t) => {
  const f = fixture(t); f.state.failAttach = true;
  await assert.rejects(f.handle.run(), /Owned Docker operation failed: start/);
  const diagnostic = f.handle.describe().failure;
  assert.deepEqual(diagnostic, { operation: 'start', outcome: 'FAILED', child: { stage: 'ROUTER_IMPORT', code: 'RUNTIME_FIXTURE_FAILED' } });
  f.handle.dispose(); assert.equal(f.state.rows.size, 0); assert.equal(f.handle.describe().failure, diagnostic);
});

test('ordinary failed readiness probe cannot taint an otherwise successful run', async (t) => {
  const f = fixture(t); f.state.ordinaryProbeFailures = 1;
  const result = await f.handle.run(); assert.equal(result.failed, 0);
  assert.equal(f.handle.describe().failure, undefined);
  assert.equal(f.state.calls.filter(a => a[0] === 'exec').length, 3);
  f.handle.dispose(); assert.equal(f.state.rows.size, 0);
});
test('tolerated readiness probe cannot mask a later genuine attached-child failure', async (t) => {
  const f = fixture(t); f.state.ordinaryProbeFailures = 1; f.state.failAttach = true;
  await assert.rejects(f.handle.run(), /Owned Docker operation failed: start/);
  assert.deepEqual(f.handle.describe().failure, { operation: 'start', outcome: 'FAILED', child: { stage: 'ROUTER_IMPORT', code: 'RUNTIME_FIXTURE_FAILED' } });
  f.handle.dispose(); assert.equal(f.state.rows.size, 0);
});
for (const outcome of ['TIMEOUT', 'INTERRUPTED']) test('terminal readiness ' + outcome + ' is never retried', async (t) => {
  const f = fixture(t); f.state.terminalProbe = outcome;
  await assert.rejects(f.handle.run(), /Owned Docker operation failed: exec/);
  assert.equal(f.handle.describe().failure.outcome, outcome);
  assert.equal(f.state.calls.filter(a => a[0] === 'exec').length, 1);
  assert.equal(f.state.calls.filter(a => a[0] === 'create').length, 1);
  f.handle.dispose(); assert.equal(f.state.rows.size, 0);
});


test('fixed private role shares owned lifecycle with distinct admission, purpose and finite evidence', async (t) => {
  const f = fixture(t, undefined, true); const result = await f.handle.run();
  assert.equal(result.schema, 'SD-PRIVATE-DOCUMENT-API-RESULT-1');
  assert.equal(result.role, 'private-document-core-api');
  assert.equal(result.domainScope, 'FOCUSED_PRIVATE_DOCUMENT_CORE');
  assert.deepEqual(result.cases.map(row => row.id), PRIVATE_CASES);
  assert.equal(result.sensitivity.length, 8);
  assert.match(f.handle.directory, /sd-private-document-api-run-/);
  const [mongo, node] = f.state.receipts;
  const row = f.state.rows.get(node.id);
  assert.equal(row.HostConfig.NetworkMode, 'container:' + mongo.id);
  assert.equal(row.HostConfig.Memory, 536870912); assert.equal(row.HostConfig.PidsLimit, 64);
  assert.equal(row.HostConfig.ReadonlyRootfs, true); assert.deepEqual(row.HostConfig.CapDrop, ['ALL']);
  const admission = JSON.parse(readFileSync(join(row.HostConfig.Mounts[0].Source, '.admission.json')));
  assert.equal(admission.schema, 'SD-PRIVATE-DOCUMENT-API-RUN-1');
  assert.equal(admission.role, PRIVATE_DOCUMENT_PROFILE.role);
  assert.equal(row.Config.Labels['swasthadisha.test.purpose'], 'private-document-api-runtime');
  const receipt = f.handle.dispose();
  assert.deepEqual(receipt.exactIdsAbsent, [mongo.id, node.id]); assert.equal(f.state.rows.size, 0);
  assert.equal(receipt.workspaceAbsent, true); assert.equal(receipt.zeroPurposeLabels, true);
});

for (const [label, change] of [
  ['role', plan => { plan.role = PROFILE.role; }],
  ['schema', plan => { plan.schema = 'SD-AUTH-API-PLAN-1'; }],
  ['missing-group', plan => { plan.requiredCaseIds.pop(); }],
  ['extra-group', plan => { plan.requiredCaseIds.push('EXTRA'); }],
  ['missing-control', plan => { plan.requiredSensitivityIds.pop(); }],
  ['extra-control', plan => { plan.requiredSensitivityIds.push('EXTRA'); }],
]) test('private role rejects substituted finite plan before allocation: ' + label, () => {
  const f = transport(true); const plan = JSON.parse(f.seams.template.files['runtime-plan.json']);
  change(plan); f.seams.template.files['runtime-plan.json'] = Buffer.from(JSON.stringify(plan));
  assert.throws(() => createPrivateDocumentRuntimeFixture({ endpoint: PROFILE.endpoint }, f.seams), /Incomplete/);
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.receipts.length, 0);
});

test('callers cannot select private grants through either public input or an auth template', () => {
  const auth = transport(); const privateFake = transport(true);
  assert.throws(() => createPrivateDocumentRuntimeFixture({ endpoint: PROFILE.endpoint, role: PRIVATE_DOCUMENT_PROFILE.role }, privateFake.seams), /fixed endpoint/);
  assert.throws(() => createPrivateDocumentRuntimeFixture({ endpoint: PROFILE.endpoint }, auth.seams), /Incomplete API/);
  assert.throws(() => createApiRuntimeFixture({ endpoint: PROFILE.endpoint }, privateFake.seams), /Incomplete API/);
  assert.equal(auth.state.calls.length + privateFake.state.calls.length, 0);
});

for (const [label, change] of [
  ['schema', result => { result.schema = 'SD-AUTH-API-RESULT-1'; }],
  ['role', result => { result.role = PROFILE.role; }],
  ['scope', result => { result.domainScope = 'FOCUSED_PRODUCTION_ROUTERS'; }],
  ['missing-group', result => { result.cases.pop(); }],
  ['undetected-control', result => { result.sensitivity[0].detected = false; }],
]) test('private role rejects cross-role or incomplete runtime claims: ' + label, async (t) => {
  const f = fixture(t, fake => { fake.state.resultMutation = change; }, true);
  await assert.rejects(f.handle.run(), /evidence mismatch/);
  f.handle.dispose(); assert.equal(f.state.rows.size, 0);
});


test('fixed contact role retains owned lifecycle and separates its diagnostic profile and wallet intent', async (t) => {
  const f = fixture(t, fake => { fake.state.resultMutation = result => { result.providerSummary.wallet = 3; }; }, 'contact');
  const result = await f.handle.run();
  assert.equal(result.schema, 'SD-CUSTOMER-CONTACT-API-RESULT-1');
  assert.equal(result.role, 'customer-contact-api'); assert.equal(result.domainScope, 'FOCUSED_CUSTOMER_CONTACT');
  assert.equal(CUSTOMER_CONTACT_PROFILE.mongooseVersion, '6.13.8');
  assert.equal(PRIVATE_DOCUMENT_PROFILE.mongooseVersion, '9.12.0');
  assert.deepEqual(result.cases.map(row => row.id), CONTACT_CASES); assert.equal(result.sensitivity.length, 16);
  assert.deepEqual(result.providerSummary, { unexpected: 0, wallet: 3 });
  assert.match(f.handle.directory, /sd-customer-contact-api-run-/);
  const [mongo, node] = f.state.receipts; const row = f.state.rows.get(node.id);
  assert.equal(row.Config.Labels['swasthadisha.test.purpose'], 'customer-contact-api-runtime');
  assert.equal(row.HostConfig.NetworkMode, 'container:' + mongo.id);
  assert.equal(row.HostConfig.Memory, 536870912); assert.equal(row.HostConfig.PidsLimit, 64);
  assert.equal(row.HostConfig.ReadonlyRootfs, true); assert.deepEqual(row.HostConfig.CapDrop, ['ALL']);
  const admission = JSON.parse(readFileSync(join(row.HostConfig.Mounts[0].Source, '.admission.json')));
  assert.equal(admission.schema, 'SD-CUSTOMER-CONTACT-API-RUN-1'); assert.equal(admission.role, CUSTOMER_CONTACT_PROFILE.role);
  const receipt = f.handle.dispose();
  assert.deepEqual(receipt.exactIdsAbsent, [mongo.id, node.id]); assert.equal(f.state.rows.size, 0);
  assert.equal(receipt.workspaceAbsent, true); assert.equal(receipt.zeroPurposeLabels, true);
});

for (const [label, change] of [
  ['role', plan => { plan.role = PROFILE.role; }],
  ['schema', plan => { plan.schema = 'SD-PRIVATE-DOCUMENT-API-PLAN-1'; }],
  ['missing-group', plan => { plan.requiredCaseIds.pop(); }],
  ['extra-group', plan => { plan.requiredCaseIds.push('EXTRA'); }],
  ['missing-control', plan => { plan.requiredSensitivityIds.pop(); }],
  ['extra-control', plan => { plan.requiredSensitivityIds.push('EXTRA'); }],
  ['missing-wallet', plan => { plan.providerCounterKeys = ['unexpected']; }],
]) test('contact role rejects substituted finite plan before allocation: ' + label, () => {
  const f = transport('contact'); const plan = JSON.parse(f.seams.template.files['runtime-plan.json']);
  change(plan); f.seams.template.files['runtime-plan.json'] = Buffer.from(JSON.stringify(plan));
  assert.throws(() => createCustomerContactRuntimeFixture({ endpoint: PROFILE.endpoint }, f.seams), /Incomplete|provider counter plan/);
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.receipts.length, 0);
});

test('callers cannot select contact grants or exchange templates with either existing role', () => {
  const contact = transport('contact');
  assert.throws(() => createCustomerContactRuntimeFixture({ endpoint: PROFILE.endpoint, role: CUSTOMER_CONTACT_PROFILE.role }, contact.seams), /fixed endpoint/);
  for (const [oldRole, create] of [[false, createApiRuntimeFixture], [true, createPrivateDocumentRuntimeFixture]]) {
    const old = transport(oldRole);
    assert.throws(() => createCustomerContactRuntimeFixture({ endpoint: PROFILE.endpoint }, old.seams), /Incomplete API/);
    assert.throws(() => create({ endpoint: PROFILE.endpoint }, contact.seams), /Incomplete API/);
    assert.equal(old.state.calls.length, 0);
  }
  assert.equal(contact.state.calls.length, 0);
});

for (const [label, role, key] of [['auth-wallet', false, 'wallet'], ['private-wallet', true, 'wallet'], ['contact-unknown', 'contact', 'unplanned']])
  test('wallet admission stays confined to the fixed contact role: ' + label, () => {
    const f = transport(role); const plan = JSON.parse(f.seams.template.files['runtime-plan.json']); plan.providerCounterKeys.push(key);
    f.seams.template.files['runtime-plan.json'] = Buffer.from(JSON.stringify(plan));
    const create = role === 'contact' ? createCustomerContactRuntimeFixture : role ? createPrivateDocumentRuntimeFixture : createApiRuntimeFixture;
    assert.throws(() => create({ endpoint: PROFILE.endpoint }, f.seams), /provider counter plan/);
    assert.equal(f.state.calls.length, 0); assert.equal(f.state.receipts.length, 0);
  });

for (const [label, change] of [
  ['schema', result => { result.schema = 'SD-PRIVATE-DOCUMENT-API-RESULT-1'; }],
  ['role', result => { result.role = PROFILE.role; }],
  ['scope', result => { result.domainScope = 'FOCUSED_PRIVATE_DOCUMENT_CORE'; }],
  ['missing-group', result => { result.cases.pop(); }],
  ['undetected-control', result => { result.sensitivity[0].detected = false; }],
  ['wallet-negative', result => { result.providerSummary.wallet = -1; }],
  ['wallet-missing', result => { delete result.providerSummary.wallet; }],
]) test('contact role rejects cross-role, incomplete or invalid wallet evidence: ' + label, async (t) => {
  const f = fixture(t, fake => { fake.state.resultMutation = change; }, 'contact');
  await assert.rejects(f.handle.run(), /evidence mismatch|provider evidence/);
  f.handle.dispose(); assert.equal(f.state.rows.size, 0);
});


test('REFILL_FIXED_ROLE_POSITIVE', async (t) => {
  const f = fixture(t, fake => { fake.state.resultMutation = result => { result.providerSummary.logger = 2; }; }, 'refill');
  const result = await f.handle.run();
  assert.equal(result.schema, 'SD-PHARMACY-REFILL-API-RESULT-1');
  assert.equal(result.role, PHARMACY_REFILL_PROFILE.role);
  assert.equal(result.domainScope, 'FOCUSED_PHARMACY_REFILL');
  assert.deepEqual(result.cases.map(row => row.id), REFILL_CASES);
  assert.deepEqual(result.sensitivity.map(row => row.id), REFILL_SENSITIVITY);
  assert.deepEqual(result.providerSummary, { logger: 2, unexpected: 0 });
  assert.match(f.handle.directory, /sd-pharmacy-refill-api-run-/);
  const [mongo, node] = f.state.receipts; const row = f.state.rows.get(node.id);
  assert.equal(row.Config.Labels['swasthadisha.test.purpose'], 'pharmacy-refill-api-runtime');
  assert.equal(row.HostConfig.NetworkMode, 'container:' + mongo.id);
  assert.equal(row.HostConfig.Memory, 536870912); assert.equal(row.HostConfig.PidsLimit, 64);
  assert.equal(row.HostConfig.ReadonlyRootfs, true); assert.deepEqual(row.HostConfig.CapDrop, ['ALL']);
  const admission = JSON.parse(readFileSync(join(row.HostConfig.Mounts[0].Source, '.admission.json')));
  assert.equal(admission.schema, 'SD-PHARMACY-REFILL-API-RUN-1'); assert.equal(admission.role, PHARMACY_REFILL_PROFILE.role);
  const receipt = f.handle.dispose();
  assert.deepEqual(receipt.exactIdsAbsent, [mongo.id, node.id]); assert.equal(f.state.rows.size, 0);
  assert.equal(receipt.workspaceAbsent, true); assert.equal(receipt.zeroPurposeLabels, true);
});
for (const [id, change] of [
  ['REFILL_PLAN_WRONG_ROLE', plan => { plan.role = PROFILE.role; }],
  ['REFILL_PLAN_WRONG_SCHEMA', plan => { plan.schema = 'SD-AUTH-API-PLAN-1'; }],
  ['REFILL_PLAN_MISSING_GROUP', plan => { plan.requiredCaseIds.pop(); }],
  ['REFILL_PLAN_EXTRA_GROUP', plan => { plan.requiredCaseIds.push('EXTRA'); }],
  ['REFILL_PLAN_MISSING_CONTROL', plan => { plan.requiredSensitivityIds.pop(); }],
  ['REFILL_PLAN_EXTRA_CONTROL', plan => { plan.requiredSensitivityIds.push('EXTRA'); }],
  ['REFILL_PLAN_MISSING_LOGGER', plan => { plan.providerCounterKeys = ['unexpected']; }],
  ['REFILL_PLAN_MISSING_UNEXPECTED', plan => { plan.providerCounterKeys = ['logger']; }],
  ['REFILL_PLAN_EXTRA_EMAIL', plan => { plan.providerCounterKeys.push('email'); }],
  ['REFILL_PLAN_EXTRA_WALLET', plan => { plan.providerCounterKeys.push('wallet'); }],
]) test(id, () => {
  const f = transport('refill'); const plan = JSON.parse(f.seams.template.files['runtime-plan.json']);
  change(plan); f.seams.template.files['runtime-plan.json'] = Buffer.from(JSON.stringify(plan));
  assert.throws(() => createPharmacyRefillRuntimeFixture({ endpoint: PROFILE.endpoint }, f.seams), /Incomplete|provider counter plan/);
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.receipts.length, 0);
});
for (const [id, extra] of [
  ['REFILL_CALLER_ROLE_OVERRIDE', { role: PROFILE.role }],
  ['REFILL_CALLER_TEMPLATE_OVERRIDE', { template: '/private/tmp/arbitrary' }],
]) test(id, () => {
  const f = transport('refill');
  assert.throws(() => createPharmacyRefillRuntimeFixture({ endpoint: PROFILE.endpoint, ...extra }, f.seams), /fixed endpoint/);
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.receipts.length, 0);
});
test('REFILL_CROSS_ROLE_TEMPLATES', () => {
  const refill = transport('refill');
  for (const [role, create] of [[false, createApiRuntimeFixture], [true, createPrivateDocumentRuntimeFixture], ['contact', createCustomerContactRuntimeFixture]]) {
    const old = transport(role);
    assert.throws(() => createPharmacyRefillRuntimeFixture({ endpoint: PROFILE.endpoint }, old.seams), /Incomplete API/);
    assert.throws(() => create({ endpoint: PROFILE.endpoint }, refill.seams), /Incomplete API/);
    assert.equal(old.state.calls.length, 0); assert.equal(old.state.receipts.length, 0);
  }
  assert.equal(refill.state.calls.length, 0); assert.equal(refill.state.receipts.length, 0);
});
for (const [id, change] of [
  ['REFILL_RESULT_WRONG_SCHEMA', result => { result.schema = 'SD-AUTH-API-RESULT-1'; }],
  ['REFILL_RESULT_WRONG_ROLE', result => { result.role = PROFILE.role; }],
  ['REFILL_RESULT_WRONG_SCOPE', result => { result.domainScope = 'FOCUSED_PRODUCTION_ROUTERS'; }],
  ['REFILL_RESULT_MISSING_GROUP', result => { result.cases.pop(); }],
  ['REFILL_RESULT_UNDETECTED_CONTROL', result => { result.sensitivity[0].detected = false; }],
  ['REFILL_RESULT_MISSING_LOGGER', result => { delete result.providerSummary.logger; }],
  ['REFILL_RESULT_UNEXPECTED', result => { result.providerSummary.unexpected = 1; }],
  ['REFILL_RESULT_EXTRA_EMAIL', result => { result.providerSummary.email = 0; }],
  ['REFILL_RESULT_UNSAFE_LOGGER', result => { result.providerSummary.logger = 1.5; }],
  ['REFILL_RESULT_NEGATIVE_LOGGER', result => { result.providerSummary.logger = -1; }],
]) test(id, async (t) => {
  const f = fixture(t, fake => { fake.state.resultMutation = change; }, 'refill');
  await assert.rejects(f.handle.run(), /evidence mismatch|provider evidence/);
  const receipt = f.handle.dispose(); assert.equal(f.state.rows.size, 0);
  assert.equal(receipt.workspaceAbsent, true); assert.equal(receipt.zeroPurposeLabels, true);
});
