import { randomUUID, createHash } from 'node:crypto';
import { lstatSync, realpathSync, statSync, readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import profileJson from './profile.json' with { type: 'json' };
import { verifyNetworkAdmission } from '../application/app-bundle.mjs';

export const PROFILE = Object.freeze({ ...profileJson });
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROLE = 'auth-user-wallet-api';
const PURPOSE = 'auth-api-runtime';
const MONGO_TMPFS = Object.freeze({
  '/data/db': 'rw,noexec,nosuid,size=536870912,mode=1777',
  '/data/configdb': 'rw,noexec,nosuid,size=16777216,mode=1777',
  '/tmp': 'rw,noexec,nosuid,size=67108864,mode=1777',
});
const NODE_TMPFS = Object.freeze({ '/tmp': 'rw,noexec,nosuid,size=134217728,mode=1777' });
const NODE_ARGS = Object.freeze(['--permission', '--allow-fs-read=/workspace', '--allow-fs-read=/sys/class/net',
  '--allow-fs-read=/tmp', '--allow-fs-write=/tmp', '/workspace/bootstrap.cjs']);
const PROVIDER_KEYS = Object.freeze(['email', 'sms', 'push', 'logger', 'payments', 'calendar', 'storage', 'queue', 'deniedCapabilities', 'unexpected']);
const RESULT_KEYS = Object.freeze(['schema', 'runId', 'role', 'database', 'replicaSet', 'sourceCommit', 'domainScope',
  'admissionPassed', 'egressBlocked', 'filesystemCanariesPassed', 'networkAdmission', 'failed', 'skipped', 'cases', 'sensitivity', 'providerSummary']);
const PREPARATION_SOURCES = Object.freeze(['bootstrap.cjs', 'scenario.cjs', 'ports-manifest.json', 'prepare.py', 'compile.cjs', 'package-plan.json']
  .map((name) => 'test/api-runtime/scenario/' + name).concat(['test/application/app-bundle.mjs', 'package-lock.json']));
const plain = (v) => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const commit = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const sameMap = (a, b) => plain(a) && plain(b) && same(Object.keys(a).sort(), Object.keys(b).sort())
  && Object.keys(b).every((key) => a[key] === b[key]);
const exactKeys = (value, names) => plain(value) && same(Object.keys(value).sort(), [...names].sort());
function safeJson(bytes, message) {
  try { return JSON.parse(bytes); } catch { throw new Error(message); }
}

const FAILURE_STAGES = Object.freeze(['ADMISSION', 'ROUTER_IMPORT', 'OWNED_DATABASE_CONNECT', 'API_SCENARIOS']);
const OPERATIONS = Object.freeze(['info', 'image', 'create', 'inspect', 'start', 'exec', 'rm', 'ps']);
class OwnedOperationFailure extends Error {
  constructor(diagnostic) { super('Owned Docker operation failed: ' + diagnostic.operation); this.diagnostic = diagnostic; }
}

/** Only public literals from the frozen fixture can become diagnostic codes. */
export function fixtureFailureCodes(files) {
  const literals = new Set(['RUNTIME_FIXTURE_FAILED']);
  for (const name of ['bootstrap.cjs', 'scenario.cjs']) {
    const source = files[name]; if (!source) continue;
    for (const match of source.toString().matchAll(/['"]([A-Z][A-Z0-9_]{1,80})['"]/g)) literals.add(match[1]);
  }
  for (const field of ['ISACTIVE', 'ISVERIFIED', 'ISCORPORATEEMAILVERIFIED', 'CORPORATEID', 'ISCORPORATEUSER']) literals.add('SELF_FIELD_' + field);
  requireThat(literals.size <= 1000, 'Fixture failure-code set exceeds its bound');
  const codes = new Set(literals);
  for (const code of literals) for (const suffix of ['_STATUS', '_STATE', '_EFFECTS', '_SIDE_EFFECTS', '_PROOF_UNCHANGED']) codes.add(code + suffix);
  return codes;
}

/** No raw stdout, stderr, Error text, errorType or validation fields escape. */
export function decodeDockerResult(result, args, codes) {
  requireThat(OPERATIONS.includes(args[0]) && codes instanceof Set, 'Invalid fixed Docker decoder input');
  if (!result.error && !result.signal && result.status === 0) return result.stdout.trim();
  let child = null;
  if (args[0] === 'start' && args[1] === '--attach' && typeof result.stdout === 'string' && result.stdout.length <= 64 * 1024) {
    let value;
    try { value = JSON.parse(result.stdout); } catch { /* Unavailable; never echo a parser snippet. */ }
    if (exactKeys(value, ['schema', 'stage', 'code', 'errorType', 'fieldNames', 'failed', 'skipped'])
      && value.schema === 'SD-AUTH-API-FAILURE-1' && FAILURE_STAGES.includes(value.stage)
      && codes.has(value.code) && value.failed === 1 && value.skipped === 0) {
      child = Object.freeze({ stage: value.stage, code: value.code });
    }
  }
  throw new OwnedOperationFailure(Object.freeze({ operation: args[0],
    outcome: result.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : result.signal ? 'INTERRUPTED' : 'FAILED', child }));
}

/** A failed read is never absence proof. This helper grants no resource ownership. */
export function assertPathAbsent(path, read = lstatSync) {
  try { read(path); } catch (error) { if (error.code === 'ENOENT') return; throw new Error('Workspace absence proof unavailable'); }
  throw new Error('Owned workspace remains present');
}

function regular(path) {
  const st = lstatSync(path);
  requireThat(st.isFile() && !st.isSymbolicLink() && st.nlink === 1, 'Input must be one regular unlinked file');
  return readFileSync(path);
}

function safePath(root, path) {
  requireThat(typeof path === 'string' && path.length > 0 && !isAbsolute(path)
    && !/[\0\r\n\\]/.test(path) && path.split('/').every((p) => p && p !== '.' && p !== '..'), 'Unsafe template path');
  const target = resolve(root, path);
  requireThat(!relative(root, target).startsWith('..'), 'Template path escaped its root');
  return target;
}

/** Reading a frozen template grants no resource ownership and never cleans it up. */
function reviewedTemplate() {
  const bytes = regular(new URL('./scenario/runtime-template.json', import.meta.url));
  const meta = JSON.parse(bytes);
  requireThat(meta.schema === 'SD-AUTH-API-TEMPLATE-1' && commit(meta.sourceCommit)
    && plain(meta.files) && plain(meta.sourceFiles) && digest(meta.lockSha) && digest(meta.portsSha), 'Invalid prepared template');
  requireThat(typeof meta.directory === 'string'
    && /^\/private\/tmp\/sd-auth-api-build-[A-Za-z0-9_-]+\/runtime$/.test(meta.directory)
    && realpathSync(meta.directory) === meta.directory, 'Template is outside the reviewed preparation area');
  requireThat(meta.packageVersions?.mongoose === PROFILE.mongooseVersion
    && meta.packageVersions?.typescript === PROFILE.compilerVersion, 'Unreviewed test dependency profile');
  const names = Object.keys(meta.files);
  requireThat(names.length > 4 && names.length <= 20_000
    && ['bootstrap.cjs', 'runtime-plan.json', 'ports-manifest.json', 'package-lock.json'].every((n) => names.includes(n)),
  'Incomplete prepared template');
  const files = {}; let total = 0;
  for (const name of names) {
    requireThat(digest(meta.files[name]) && !name.split('/').includes('.bin')
      && !/(^|\/)\.env(?:\.|$)|\.node$|service.?account.*\.json$/i.test(name), 'Disallowed prepared file');
    const path = safePath(meta.directory, name);
    let parent = dirname(path);
    while (parent !== meta.directory) {
      const st = lstatSync(parent);
      requireThat(st.isDirectory() && !st.isSymbolicLink(), 'Linked template directory');
      parent = dirname(parent);
    }
    const data = regular(path); total += data.length;
    requireThat(data.length <= 32 * 1024 * 1024 && total <= 256 * 1024 * 1024
      && sha256(data) === meta.files[name], 'Prepared file size/hash differs');
    files[name] = data;
  }
  requireThat(sha256(files['package-lock.json']) === meta.lockSha
    && sha256(files['ports-manifest.json']) === meta.portsSha, 'Lock or port manifest differs');
  requireThat(Object.keys(meta.sourceFiles).length > 0, 'Source closure is empty');
  for (const [name, hash] of Object.entries(meta.sourceFiles)) {
    requireThat(((name.startsWith('src1/') && name.endsWith('.ts')) || PREPARATION_SOURCES.includes(name)) && digest(hash)
      && sha256(regular(safePath(ROOT, name))) === hash, 'Current production source differs from template');
  }
  return Object.freeze({ meta, files: Object.freeze(files), templateSha: sha256(bytes) });
}

function realExecutor(endpoint, configuration, codes) {
  const socket = fileURLToPath(new URL(endpoint.replace(/^unix:/, 'file:')));
  requireThat(statSync(realpathSync(socket)).isSocket(), 'Recorded endpoint is not a local socket');
  return (args, timeout = 25_000) => {
    const r = spawnSync('/usr/local/bin/docker', ['--config', configuration, '--host', endpoint, ...args], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024,
    });
    // Child output is not interpolated: failures must not disclose test JWT/OTP/key material.
    return decodeDockerResult(r, args, codes);
  };
}

/** No Docker operation occurs until run(); a returned handle retains all acknowledged IDs. */
export function createApiRuntimeFixture(input, seams = {}) {
  requireThat(plain(input) && plain(seams), 'Plain input and test seams required');
  const request = Object.freeze({ ...input });
  const fake = Reflect.ownKeys(seams).length > 0;
  const ports = Object.freeze({ ...seams });
  requireThat(Reflect.ownKeys(ports).every((key) => ['executor', 'template', 'reportCreated'].includes(key)), 'Unknown test seam');
  requireThat(!fake || (Object.hasOwn(ports, 'executor') && typeof ports.executor === 'function'
    && Object.hasOwn(ports, 'template') && plain(ports.template)), 'Simulated mode requires explicit fake executor and template');
  requireThat(!Object.hasOwn(ports, 'reportCreated') || typeof ports.reportCreated === 'function', 'Invalid creation reporter');
  requireThat(Reflect.ownKeys(request).length === 1 && request.endpoint === PROFILE.endpoint, 'Only the fixed endpoint is accepted');
  requireThat(!Object.keys(process.env).some((k) => /^(DOCKER_|NODE_OPTIONS$|NODE_PATH$|MONGODB_|DATABASE_URL$|JWT_SECRET|SMTP|SMS_|FIREBASE_|RAZORPAY_|GOOGLE_|AWS_)/.test(k)),
    'Operational/preload configuration is forbidden');
  const template = fake ? ports.template : reviewedTemplate();
  requireThat(plain(template.files) && plain(template.meta) && digest(template.templateSha), 'Invalid admitted template');
  const failureCodes = fixtureFailureCodes(template.files);
  const plan = JSON.parse(template.files['runtime-plan.json'].toString());
  requireThat(plan.schema === 'SD-AUTH-API-PLAN-1' && plan.role === ROLE && Array.isArray(plan.requiredCaseIds)
    && plan.requiredCaseIds.length >= 20 && new Set(plan.requiredCaseIds).size === plan.requiredCaseIds.length
    && plan.requiredCaseIds.every((v) => typeof v === 'string' && /^[A-Z][A-Z0-9_-]{1,80}$/.test(v)), 'Incomplete API case plan');
  requireThat(Array.isArray(plan.requiredSensitivityIds) && plan.requiredSensitivityIds.length >= 2
    && new Set(plan.requiredSensitivityIds).size === plan.requiredSensitivityIds.length
    && plan.requiredSensitivityIds.every((v) => typeof v === 'string' && /^[A-Z][A-Z0-9_-]{1,80}$/.test(v)), 'Incomplete sensitivity plan');
  requireThat(Array.isArray(plan.providerCounterKeys) && plan.providerCounterKeys.includes('unexpected')
    && new Set(plan.providerCounterKeys).size === plan.providerCounterKeys.length
    && plan.providerCounterKeys.every((key) => PROVIDER_KEYS.includes(key)), 'Unreviewed provider counter plan');
  const runId = randomUUID(); const compact = runId.replaceAll('-', '');
  const database = 'sd_api_' + compact; const replicaSet = 'sd_rs_' + compact;
  requireThat(fake || realpathSync(tmpdir()) === '/private/tmp', 'Real fixture requires the reviewed temporary root');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sd-auth-api-run-')));
  const identity = lstatSync(directory); const marker = join(directory, '.owner.json');
  const bundle = join(directory, 'bundle'); const config = join(directory, 'docker');
  let phase = 'prepared'; let disposed = false; let uncertainCreate; let cleanupUnresolved = false; let cleanupReceipt; let failure;
  const resources = []; const identities = new Map(); let admission; let manifestSha;

  function owned() {
    const st = lstatSync(directory);
    requireThat(!disposed && st.isDirectory() && !st.isSymbolicLink() && st.dev === identity.dev && st.ino === identity.ino,
      'Fixture workspace identity changed');
    requireThat(same(JSON.parse(regular(marker)), { runId }), 'Fixture ownership marker differs');
    for (const [path, id] of identities) {
      const current = lstatSync(path);
      requireThat(current.isDirectory() && !current.isSymbolicLink() && current.dev === id.dev && current.ino === id.ino,
        'Owned directory identity changed');
    }
    requireThat(regular(join(config, 'config.json')).toString() === '{"auths":{}}\n', 'Docker configuration changed');
  }

  try {
    requireThat(!/[,\r\n]/.test(bundle), 'Bundle path cannot be safely represented as a Docker mount');
    writeFileSync(marker, JSON.stringify({ runId }), { mode: 0o600, flag: 'wx' });
    for (const path of [bundle, config]) { mkdirSync(path, { mode: path === bundle ? 0o755 : 0o700 }); identities.set(path, lstatSync(path)); }
    writeFileSync(join(config, 'config.json'), '{"auths":{}}\n', { mode: 0o600, flag: 'wx' });
    for (const [name, data] of Object.entries(template.files)) {
      const target = safePath(bundle, name);
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      writeFileSync(target, data, { mode: 0o444, flag: 'wx' });
    }
  } catch (cause) {
    const st = lstatSync(directory);
    if (st.isDirectory() && !st.isSymbolicLink() && st.dev === identity.dev && st.ino === identity.ino) rmSync(directory, { recursive: true });
    throw cause;
  }
  let executor;
  try { executor = fake ? ports.executor : realExecutor(request.endpoint, config, failureCodes); }
  catch (cause) { owned(); rmSync(directory, { recursive: true }); throw cause; }
  function execute(args, timeout) {
    try { return executor(args, timeout); }
    catch (error) { if (!failure && error instanceof OwnedOperationFailure) failure = error.diagnostic; throw error; }
  }
  function engine() {
    const row = JSON.parse(execute(['info', '--format', '[{{json .ID}},{{json .OSType}}]']));
    requireThat(same(row, [PROFILE.engineId, 'linux']), 'Recorded engine identity changed');
  }
  function purposeIds() {
    const output = execute(['ps', '--all', '--filter', 'label=swasthadisha.test.purpose=' + PURPOSE, '--no-trunc', '--format', '{{.ID}}']);
    requireThat(typeof output === 'string', 'Purpose-label proof unavailable');
    const ids = output.trim() ? output.trim().split(/\r?\n/) : [];
    requireThat(ids.every((id) => /^[a-f0-9]{64}$/.test(id)), 'Purpose-label proof unavailable');
    return ids;
  }
  function exactAbsent(id) {
    engine();
    const output = execute(['ps', '--all', '--filter', 'id=' + id, '--no-trunc', '--format', '{{.ID}}']);
    requireThat(typeof output === 'string' && output.trim() === '', 'Exact owned ID absence not proven');
    engine();
  }
  function sources() {
    owned();
    const seen = [];
    const walk = (path, prefix = '') => {
      for (const name of readdirSync(path)) {
        const child = join(path, name); const kind = lstatSync(child);
        requireThat(!kind.isSymbolicLink(), 'Linked bundle member');
        if (kind.isDirectory()) walk(child, prefix + name + '/');
        else { requireThat(kind.isFile() && kind.nlink === 1, 'Nonregular bundle member'); seen.push(prefix + name); }
      }
    };
    walk(bundle);
    requireThat(same(seen.sort(), [...Object.keys(template.files), ...(admission ? ['.admission.json'] : [])].sort()), 'Unmanifested bundle member');
    for (const [name, bytes] of Object.entries(template.files)) requireThat(sha256(regular(safePath(bundle, name))) === sha256(bytes), 'Bundle source changed');
    if (admission) requireThat(sha256(regular(join(bundle, '.admission.json'))) === manifestSha, 'Run admission manifest changed');
  }
  function cachedImage(reference, kind) {
    const rows = JSON.parse(execute(['image', 'inspect', reference])); const row = rows[0];
    requireThat(rows.length === 1 && row.Os === 'linux' && ['amd64', 'arm64'].includes(row.Architecture)
      && /^sha256:[a-f0-9]{64}$/.test(row.Id) && row.RepoDigests?.includes(reference), 'Cached image mismatch');
    const env = row.Config?.Env;
    requireThat(Array.isArray(env) && env.every((v) => typeof v === 'string' && v.includes('='))
      && new Set(env.map((v) => v.split('=')[0])).size === env.length
      && !env.some((v) => /^(JWT_SECRET|MONGODB_URL|MONGO_INITDB_ROOT_|AWS_|GOOGLE_|FIREBASE_|RAZORPAY_)/.test(v)), 'Unexpected image environment');
    if (kind === 'node') requireThat(env.includes('NODE_VERSION=' + PROFILE.nodeVersion)
      && env.every((v) => /^(PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin|NODE_VERSION=22\.23\.4|YARN_VERSION=[0-9.]+)$/.test(v))
      && Object.keys(row.Config?.Volumes ?? {}).length === 0, 'Node image profile mismatch');
    else requireThat(env.includes('MONGO_VERSION=' + PROFILE.mongoVersion)
      && Object.keys(row.Config?.Volumes ?? {}).every((v) => ['/data/db', '/data/configdb'].includes(v)), 'Mongo image profile mismatch');
    return { id: row.Id, env: [...env] };
  }
  function validateResource(resource) {
    const rows = JSON.parse(execute(['inspect', resource.id])); requireThat(rows.length === 1, 'Ambiguous owned resource');
    const row = rows[0]; const c = row.Config ?? {}; const h = row.HostConfig ?? {};
    requireThat(row.Id === resource.id && row.Name === '/' + resource.name && row.Image === resource.imageId
      && c.Labels?.['swasthadisha.test.run'] === runId && c.Labels?.['swasthadisha.test.purpose'] === PURPOSE
      && c.Labels?.['swasthadisha.test.role'] === resource.kind, 'Resource ownership changed');
    requireThat(c.Image === resource.image && c.User === resource.user && c.WorkingDir === resource.cwd
      && same(c.Entrypoint, [resource.entry]) && same(c.Cmd, resource.command)
      && same([...(c.Env ?? [])].sort(), [...resource.env].sort()) && same(c.Healthcheck?.Test, ['NONE']), 'Resource executable/environment changed');
    requireThat(h.NetworkMode === resource.network && !h.PublishAllPorts && !h.Privileged && h.ReadonlyRootfs === true
      && !h.PidMode && !h.UTSMode && !h.UsernsMode && ['', 'private'].includes(h.IpcMode ?? '')
      && ['', 'private'].includes(h.CgroupnsMode ?? '') && h.Runtime === 'runc' && !(h.GroupAdd?.length)
      && Object.keys(h.Sysctls ?? {}).length === 0 && !(h.CapAdd?.length) && !(h.Devices?.length)
      && !(h.DeviceRequests?.length) && !(h.Binds?.length) && !(h.VolumesFrom?.length) && !(h.Links?.length)
      && Object.keys(h.PortBindings ?? {}).length === 0
      && Object.keys(row.NetworkSettings?.Networks ?? {}).every((v) => v === 'none')
      && Object.values(row.NetworkSettings?.Ports ?? {}).every((v) => v === null), 'Resource isolation changed');
    requireThat(h.Memory === resource.memory && h.NanoCpus === 1_000_000_000 && h.PidsLimit === resource.pids
      && same(h.CapDrop, ['ALL']) && h.SecurityOpt?.length === 1
      && ['no-new-privileges', 'no-new-privileges=true'].includes(h.SecurityOpt[0]) && h.LogConfig?.Type === 'none', 'Resource bounds changed');
    requireThat(sameMap(h.Tmpfs, resource.tmpfs), 'Resource tmpfs changed');
    const declared = h.Mounts ?? []; const mounts = row.Mounts ?? [];
    if (resource.kind === 'mongo') requireThat(declared.length === 0
      && mounts.every((m) => m.Type === 'tmpfs' && Object.hasOwn(resource.tmpfs, m.Destination)), 'Mongo storage changed');
    else requireThat(declared.length === 1 && declared[0].Type === 'bind' && declared[0].Source === bundle
      && declared[0].Target === '/workspace' && declared[0].ReadOnly === true && declared[0].BindOptions?.Propagation === 'rprivate'
      && mounts.filter((m) => m.Type === 'bind').length === 1
      && mounts.every((m) => m.Type === 'tmpfs' ? m.Destination === '/tmp'
        : m.Type === 'bind' && m.Source === bundle && m.Destination === '/workspace' && m.RW === false && m.Propagation === 'rprivate'),
    'Node storage changed');
    return row;
  }
  function validateAll(checkSources = true) {
    owned(); if (checkSources) sources(); engine();
    for (const r of resources) if (!r.removed) validateResource(r);
  }
  function mongoRunning(mongo) {
    const state = validateResource(mongo).State;
    requireThat(state?.Status === 'running' && state.OOMKilled === false, 'Owned Mongo is not running without OOM');
  }
  function create(kind, image, imageMeta, command) {
    validateAll();
    const mongo = resources.find((r) => r.kind === 'mongo');
    if (kind === 'node') mongoRunning(mongo);
    const r = { kind, name: 'sd-api-' + kind + '-' + runId, image, imageId: imageMeta.id,
      user: kind === 'mongo' ? '65534:65534' : '1000:1000', cwd: kind === 'mongo' ? '/' : '/workspace',
      entry: kind === 'mongo' ? 'mongod' : 'node', command,
      network: kind === 'mongo' ? 'none' : 'container:' + mongo.id,
      memory: kind === 'mongo' ? 1073741824 : 536870912, pids: kind === 'mongo' ? 128 : 64,
      tmpfs: kind === 'mongo' ? MONGO_TMPFS : NODE_TMPFS,
      env: [], removed: false };
    const env = new Map(imageMeta.env.map((value) => { const n = value.indexOf('='); return [value.slice(0, n), value.slice(n + 1)]; }));
    for (const value of (kind === 'mongo' ? ['MONGOSH_DISABLE_TELEMETRY=1', 'XDG_CONFIG_HOME=/tmp/mongosh']
      : ['NODE_ENV=test', 'APP_ROLE=' + ROLE, 'APP_RUN_ID=' + runId, 'APP_MANIFEST_SHA=' + manifestSha])) {
      const n = value.indexOf('='); env.set(value.slice(0, n), value.slice(n + 1));
    }
    r.env = [...env].map(([key, value]) => key + '=' + value);
    const args = ['create', '--pull=never', '--name', r.name, '--network', r.network, '--read-only', '--user', r.user,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', String(r.memory), '--cpus', '1',
      '--pids-limit', String(r.pids), '--log-driver', 'none', '--no-healthcheck', '--workdir', r.cwd, '--entrypoint', r.entry,
      '--label', 'swasthadisha.test.run=' + runId, '--label', 'swasthadisha.test.purpose=' + PURPOSE,
      '--label', 'swasthadisha.test.role=' + kind];
    for (const [path, options] of Object.entries(r.tmpfs)) args.push('--tmpfs', path + ':' + options);
    if (kind === 'node') args.push('--mount', `type=bind,source=${bundle},target=/workspace,readonly,bind-propagation=rprivate`);
    for (const value of r.env) args.push('--env', value);
    args.push(image, ...command); uncertainCreate = { kind, name: r.name };
    const id = execute(args).trim(); requireThat(/^[a-f0-9]{64}$/.test(id), 'Create returned no acknowledged exact ID');
    r.id = id; resources.push(r); uncertainCreate = undefined;
    const receipt = Object.freeze({ phase: 'created', kind, id, runId, directory });
    if (fake) ports.reportCreated?.(receipt); else writeSync(2, JSON.stringify(receipt) + '\n');
    validateAll(); return r;
  }
  function shell(mongo, script) {
    validateAll(); mongoRunning(mongo);
    return execute(['exec', mongo.id, 'mongosh', '--norc', '--quiet', 'mongodb://localhost:27017/admin?directConnection=true', '--eval', script]);
  }

  return Object.freeze({ runId, directory, database, replicaSet,
    async run() {
      requireThat(phase === 'prepared', 'API run was already attempted'); phase = 'starting';
      validateAll(); requireThat(purposeIds().length === 0, 'Purpose-labelled resources already exist'); engine();
      const mongoImage = cachedImage(PROFILE.mongoImage, 'mongo'); const nodeImage = cachedImage(PROFILE.nodeImage, 'node');
      const mongo = create('mongo', PROFILE.mongoImage, mongoImage,
        ['--replSet', replicaSet, '--bind_ip', 'localhost', '--port', '27017', '--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false']);
      validateAll(); execute(['start', mongo.id]); mongoRunning(mongo);
      const deadline = Date.now() + 30_000; let ready = false; let initialized = false;
      while (Date.now() < deadline) {
        mongoRunning(mongo);
        try {
          if (!initialized) {
            shell(mongo, `const r=rs.initiate({_id:${JSON.stringify(replicaSet)},members:[{_id:0,host:'localhost:27017'}]});if(r.ok!==1&&r.codeName!=='AlreadyInitialized')throw Error('INIT_FAILED');`);
            initialized = true;
          }
          const hello = JSON.parse(shell(mongo, 'print(JSON.stringify(db.hello()));'));
          if (hello.isWritablePrimary === true && hello.setName === replicaSet) { ready = true; break; }
        } catch { validateAll(); mongoRunning(mongo); }
        await delay(100);
      }
      requireThat(ready, 'Owned replica set did not become ready'); mongoRunning(mongo);
      admission = { schema: 'SD-AUTH-API-RUN-1', runId, role: ROLE, database, replicaSet, mongoId: mongo.id,
        templateSha: template.templateSha, files: Object.fromEntries(Object.entries(template.files).map(([p, b]) => [p, sha256(b)])),
        lockSha: template.meta.lockSha, portsSha: template.meta.portsSha, sourceCommit: template.meta.sourceCommit };
      const bytes = JSON.stringify(admission); manifestSha = sha256(bytes);
      writeFileSync(join(bundle, '.admission.json'), bytes, { flag: 'wx', mode: 0o444 });
      const node = create('node', PROFILE.nodeImage, nodeImage, [...NODE_ARGS]);
      validateAll(); mongoRunning(mongo); phase = 'running'; const output = execute(['start', '--attach', node.id], 180_000);
      validateAll(); mongoRunning(mongo); const state = validateResource(node).State;
      requireThat(state?.Status === 'exited' && state.ExitCode === 0 && state.OOMKilled === false, 'API child did not exit successfully');
      const result = safeJson(output, 'Invalid API result JSON');
      requireThat(exactKeys(result, RESULT_KEYS) && result.schema === 'SD-AUTH-API-RESULT-1' && result.runId === runId && result.role === ROLE
        && result.database === database && result.replicaSet === replicaSet && result.sourceCommit === template.meta.sourceCommit
        && result.domainScope === 'FOCUSED_PRODUCTION_ROUTERS' && result.admissionPassed === true
        && result.egressBlocked === true && result.filesystemCanariesPassed === true
        && !Object.hasOwn(result, 'networkInterfaces') && verifyNetworkAdmission(result.networkAdmission)
        && result.failed === 0 && result.skipped === 0 && Array.isArray(result.cases)
        && result.cases.length === plan.requiredCaseIds.length
        && new Set(result.cases.map((c) => c.id)).size === result.cases.length
        && result.cases.every((c) => exactKeys(c, ['id', 'status']) && plan.requiredCaseIds.includes(c.id) && c.status === 'PASS'), 'API acceptance evidence mismatch');
      requireThat(Array.isArray(result.sensitivity) && result.sensitivity.length === plan.requiredSensitivityIds.length
        && new Set(result.sensitivity.map((s) => s.id)).size === result.sensitivity.length
        && result.sensitivity.every((s) => exactKeys(s, ['id', 'detected']) && plan.requiredSensitivityIds.includes(s.id) && s.detected === true), 'Sensitivity evidence mismatch');
      requireThat(exactKeys(result.providerSummary, plan.providerCounterKeys) && result.providerSummary.unexpected === 0
        && Object.values(result.providerSummary).every((v) => Number.isSafeInteger(v) && v >= 0), 'Unsafe or unexpected provider evidence');
      for (const row of [...result.cases, ...result.sensitivity]) Object.freeze(row);
      Object.freeze(result.cases); Object.freeze(result.sensitivity); Object.freeze(result.providerSummary);
      phase = 'finished'; return Object.freeze(result);
    },
    describe() { return Object.freeze({ runId, directory, phase, uncertainCreate, cleanupUnresolved, failure,
      resources: resources.map((r) => ({ kind: r.kind, id: r.id, name: r.name, removed: r.removed })) }); },
    dispose() {
      if (disposed) return cleanupReceipt;
      requireThat(!cleanupUnresolved, 'Cleanup UNRESOLVED; automatic retry withheld');
      try {
        requireThat(!uncertainCreate, 'Create outcome unresolved; no adoption or cleanup by name');
        if (resources.length > 0) {
          validateAll(false);
          for (const r of [...resources].reverse()) {
            if (r.removed) continue;
            validateAll(false); execute(['rm', '--force', '--volumes', r.id]); exactAbsent(r.id); r.removed = true;
          }
          engine(); requireThat(purposeIds().length === 0, 'Purpose-labelled resources remain'); engine();
        }
        owned(); rmSync(directory, { recursive: true }); assertPathAbsent(directory);
        cleanupReceipt = Object.freeze({ runId, directory, exactIdsAbsent: Object.freeze(resources.map((r) => r.id)),
          engineId: resources.length ? PROFILE.engineId : null, zeroPurposeLabels: resources.length ? true : null, workspaceAbsent: true });
        disposed = true; phase = 'disposed'; return cleanupReceipt;
      } catch (error) {
        cleanupUnresolved = true; phase = 'cleanup-unresolved'; throw error;
      }
    },
  });
}
