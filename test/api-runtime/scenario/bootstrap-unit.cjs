'use strict';
// Dependency-free fake admission data. The process has no write/child/worker/
// addon grants; every non-builtin application/package import and socket denies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const output = process.stdout.write.bind(process.stdout);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const portsOriginal = JSON.parse(fs.readFileSync(path.join(__dirname, 'ports-manifest.json'), 'utf8'));
if (portsOriginal.models.length !== 13 || !portsOriginal.models.some(row => row.name === 'WellnessPackage'
  && row.collection === 'wellnesspackages' && row.source === 'src1/modules/wellnessPackages/model/index.ts'
  && Array.isArray(row.indexes) && row.indexes.length === 0)
  || !portsOriginal.models.some(row => row.name === 'Dependent' && row.collection === 'dependents'
    && row.source === 'src1/modules/dependents/model/index.ts' && row.indexes.length === 0)) throw new Error('OFFLINE_WELLNESS_MAP');
const bootstrap = path.join(__dirname, 'bootstrap.cjs');
let applicationImports = 0; let connections = 0; let domainWrites = 0;
const blockedWrite = () => { domainWrites++; throw new Error('OFFLINE_WRITE_DENIED'); };
for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream',
  'mkdir', 'mkdirSync', 'rm', 'rmSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync']) fs[name] = blockedWrite;
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile']) fs.promises[name] = blockedWrite;
const blockedNetwork = () => { connections++; throw new Error('OFFLINE_NETWORK_DENIED'); };
net.Socket.prototype.connect = blockedNetwork; net.connect = blockedNetwork;
net.Server.prototype.listen = blockedNetwork;
net.createConnection = blockedNetwork; tls.connect = blockedNetwork; dns.lookup = blockedNetwork;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request !== bootstrap && !Module.isBuiltin(request)) { applicationImports++; throw new Error('OFFLINE_DOMAIN_IMPORT_DENIED'); }
  return originalLoad.call(this, request, parent, isMain);
};
const { validateAdmissionData, runSetupStep, SETUP_FAILURE_CODES, withOwnedCleanup, recordReadOperation, recordPush,
  configurationSamples, configurationFinally, configurationEnvironment, withConfigurationTaps,
  configurationSampleEvidence, collectConfigurationEvidence } = require(bootstrap);
const need = (condition, label) => { if (!condition) throw new Error(label); };
need(process.permission && !process.permission.has('child') && !process.permission.has('worker')
  && !process.permission.has('addon') && !process.permission.has('fs.write'), 'OFFLINE_PROCESS_GRANTS');

function fixture() {
  const ports = structuredClone(portsOriginal);
  const runId = '11111111-1111-4111-8111-111111111111'; const sourceCommit = 'b'.repeat(40);
  const files = { 'bootstrap.cjs': Buffer.from('inert'), 'scenario.cjs': Buffer.from('inert'),
    'network-admission.mjs': Buffer.from('inert'), 'package-lock.json': Buffer.from('{"public":true}'),
    'compiled/entry.js': Buffer.from('inert'), 'node_modules/public/index.js': Buffer.from('inert') };
  const sources = Object.fromEntries(ports.models.map(row => [row.source, 'a'.repeat(64)]));
  sources['src1/modules/otp/repository/index.ts'] = 'a'.repeat(64);
  sources['src1/config/config.ts'] = 'a'.repeat(64);
  const mutants = Object.fromEntries(ports.requiredSensitivityIds.map(name => {
    const file = 'compiled/mutants/' + name + '.js'; files[file] = Buffer.from('inert');
    return [name, { source: name.startsWith('JWT_CONFIG_') ? 'src1/config/config.ts' : 'src1/modules/otp/repository/index.ts', originalSha256: 'a'.repeat(64), file }];
  }));
  const plan = { schema: 'SD-AUTH-API-PLAN-1', role: ports.role, sourceCommit, sourceFiles: sources,
    compilation: { compiler: '5.9.3', status: 'TRANSPILE_ONLY_NOT_TYPECHECKED' },
    modules: Object.fromEntries(ports.roots.map(root => [root, 'compiled/entry.js'])), mutants,
    models: ports.models, requiredCaseIds: ports.requiredCaseIds, requiredSensitivityIds: ports.requiredSensitivityIds,
    providerCounterKeys: ports.providerCounterKeys };
  plan.modules['@/config/config'] = 'compiled/config/config.js'; files['compiled/config/config.js'] = Buffer.from('inert');
  const manifest = { schema: 'SD-AUTH-API-RUN-1', role: ports.role, runId, sourceCommit,
    database: 'sd_api_' + runId.replaceAll('-', ''), replicaSet: 'sd_rs_' + runId.replaceAll('-', ''),
    mongoId: 'c'.repeat(64), templateSha: 'd'.repeat(64) };
  const packet = { manifest, plan, ports, observed: { runId, files } };
  rebind(packet); return packet;
}
function rebind(p) {
  p.observed.files['ports-manifest.json'] = Buffer.from(JSON.stringify(p.ports));
  p.manifest.lockSha = sha(p.observed.files['package-lock.json']);
  p.manifest.portsSha = sha(p.observed.files['ports-manifest.json']);
  p.plan.lockSha = p.manifest.lockSha; p.plan.portsSha = p.manifest.portsSha;
  p.observed.files['runtime-plan.json'] = Buffer.from(JSON.stringify(p.plan));
  p.manifest.files = Object.fromEntries(Object.entries(p.observed.files).map(([name, bytes]) => [name, sha(bytes)]));
}
const rows = [];
function check(name, mutate, bind = false) {
  const packet = fixture(); mutate(packet); if (bind) rebind(packet);
  let rejected = false;
  try { validateAdmissionData(packet.manifest, packet.plan, packet.ports, packet.observed); } catch { rejected = true; }
  need(rejected && applicationImports === 0 && connections === 0 && domainWrites === 0, name);
  rows.push({ id: name, status: 'PASS' });
}
const positive = fixture(); validateAdmissionData(positive.manifest, positive.plan, positive.ports, positive.observed);
rows.push({ id: 'PURE_ADMISSION_DATA', status: 'PASS' });
check('WRONG_SCHEMA', p => { p.manifest.schema = 'OTHER'; });
check('WRONG_ROLE', p => { p.manifest.role = 'other'; });
check('WRONG_RUN_ID', p => { p.manifest.runId = '22222222-2222-4222-8222-222222222222'; });
check('WRONG_DATABASE', p => { p.manifest.database = 'operational'; });
check('WRONG_REPLICA', p => { p.manifest.replicaSet = 'operational'; });
check('WRONG_RESOURCE_ID', p => { p.manifest.mongoId = 'short'; });
check('WRONG_SOURCE_COMMIT', p => { p.plan.sourceCommit = 'e'.repeat(40); }, true);
check('WRONG_SOURCE_HASH', p => { p.plan.sourceFiles['src1/modules/otp/repository/index.ts'] = 'bad'; }, true);
check('WRONG_COMPILER', p => { p.plan.compilation.compiler = '0'; }, true);
check('WRONG_LOCK_HASH', p => { p.manifest.lockSha = 'e'.repeat(64); });
check('WRONG_DEPENDENCY_BYTES', p => { p.observed.files['node_modules/public/index.js'] = Buffer.from('changed'); });
check('UNDECLARED_FILE', p => { p.observed.files.extra = Buffer.from('changed'); });
check('MISSING_COMPILED_INPUT', p => { p.plan.modules[p.ports.roots[0]] = 'compiled/missing.js'; }, true);
check('MISSING_ROUTER', p => { delete p.plan.modules[p.ports.roots[0]]; }, true);
check('MISSING_RECORDING_PORT', p => { p.ports.recordingModules = []; }, true);
check('UNDECLARED_PROVIDER_HOST', p => { p.ports.recordingAxios.email = 'https://example.com/send'; }, true);
check('EMPTY_CASES', p => { p.ports.requiredCaseIds.length = 0; }, true);
check('DUPLICATE_CASES', p => { p.ports.requiredCaseIds.push(p.ports.requiredCaseIds[0]); }, true);
check('UNDECLARED_MUTANT_SOURCE', p => { p.plan.mutants.OTP_UNCONDITIONAL_CONSUME.originalSha256 = 'e'.repeat(64); }, true);
check('OMITTED_WELLNESS_PACKAGE', p => { p.ports.models = p.ports.models.filter(row => row.name !== 'WellnessPackage'); }, true);
check('OMITTED_DEPENDENT', p => { p.ports.models.pop(); }, true);
check('WRONG_DEPENDENT_SOURCE', p => { p.ports.models.at(-1).source = 'src1/modules/otp/repository/index.ts'; }, true);
check('WRONG_DEPENDENT_COLLECTION', p => { p.ports.models.at(-1).collection = 'other'; }, true);
check('DUPLICATE_DEPENDENT_MODEL', p => { p.ports.models[0] = p.ports.models.at(-1); }, true);
check('MISSING_AUTHORITY_ROUTER', p => { p.ports.roots.pop(); p.plan.modules = Object.fromEntries(p.ports.roots.map(root => [root, 'compiled/entry.js'])); }, true);
check('MISSING_AUTHORITY_CASE', p => { p.ports.requiredCaseIds.pop(); }, true);
check('MISSING_AUTHORITY_SENSITIVITY', p => { p.ports.requiredSensitivityIds.pop(); }, true);
check('PORT_PLAN_MISMATCH', p => { p.plan.portsSha = 'e'.repeat(64); });
check('CONFIG_ALIAS_REBOUND', p => { p.plan.modules['@/config/config'] = 'compiled/entry.js'; }, true);
check('CONFIG_SOURCE_MISSING', p => { delete p.plan.sourceFiles['src1/config/config.ts']; }, true);
check('CONFIG_MUTANT_REBOUND', p => { p.plan.mutants.JWT_CONFIG_TRIMMED_RETURN.source = 'src1/modules/otp/repository/index.ts'; }, true);
const recordingRows = [];
const configurationRows = [];
function configurationCheck(id, action) { action(); configurationRows.push(id); }
function configurationFailure(action, code) {
  let caught; try { action(); } catch (error) { caught = error; }
  need(caught?.fixtureCode === code && caught.message === code, 'CONFIG_EXPECTED_FIXED_UNIT_FAILURE'); return caught;
}
// Every configuration load/signature/connection below is a scripted fake. This
// tests orchestration and rejection, never evaluates a modeled/copied app guard.
function fakeConfigurationRuntime() {
  const key = 'synthetic-private-config-key'; const uri = 'synthetic-owned-uri';
  const env = { NODE_ENV: 'test', JWT_SECRET_KEY: key, MONGODB_URL: uri };
  const effects = Object.fromEntries(['email', 'sms', 'push', 'logger', 'console', 'unexpected', 'excluded', 'jwtIssued', 'dbWrites'].map(name => [name, 0]));
  const state = { cache: new Set(), loads: [], delegated: 0, signatures: 0, overrides: {}, models: [], hook: undefined };
  const delegated = function () { state.delegated++; return 'fake-read'; };
  const mongoose = { connect: delegated, createConnection: delegated, Connection: function () {},
    mongo: { MongoClient: function () {} }, Model: function () {}, Query: function () {},
    connection: { readyState: 0 }, modelNames: () => state.models.slice() };
  mongoose.Connection.prototype.openUri = delegated; mongoose.mongo.MongoClient.prototype.connect = delegated;
  for (const name of ['create', 'insertMany', 'bulkWrite']) mongoose.Model[name] = delegated;
  mongoose.Model.prototype.save = delegated; mongoose.Query.prototype.exec = delegated;
  const network = { Socket: function () {}, Server: function () {} };
  network.Socket.prototype.connect = delegated; network.Server.prototype.listen = delegated;
  const plan = { modules: { '@/config/config': 'compiled/config/config.js' },
    sourceFiles: { 'src1/config/config.ts': 'a'.repeat(64) }, mutants: {} };
  for (const id of portsOriginal.requiredSensitivityIds.slice(14)) plan.mutants[id] = {
    source: 'src1/config/config.ts', originalSha256: 'a'.repeat(64), file: 'compiled/mutants/' + id + '.js',
  };
  const samples = configurationSamples(key);
  const loader = {
    phase(substitutes, overrides = {}) { need(substitutes === runtime.substitutes, 'FAKE_RECORDERS_MANDATORY'); state.overrides = overrides; },
    resetCompiled() { state.cache.clear(); },
    load(alias) {
      need(alias === '@/config/config', 'FAKE_ALIAS');
      const target = state.overrides[alias] || plan.modules[alias];
      const mutant = Object.entries(plan.mutants).find(([, row]) => row.file === target)?.[0];
      const sample = samples.find(row => row.environment === env.NODE_ENV && row.value === env.JWT_SECRET_KEY);
      need(sample && Object.hasOwn(env, 'JWT_SECRET_KEY') === (sample.value !== undefined) && env.MONGODB_URL === uri, 'FAKE_SCRIPT_SAMPLE');
      state.loads.push({ sample: sample.id, mutant });
      if (state.hook) state.hook(sample, mutant);
      if (!sample.accepted && !(mutant === 'JWT_CONFIG_PUBLISHED_FALLBACK'
        || (mutant === 'JWT_CONFIG_PRODUCTION_ONLY_GUARD' && env.NODE_ENV !== 'production')))
        throw new Error('JWT_SECRET_KEY must be set to a non-placeholder value');
      let value = sample.value;
      if (mutant === 'JWT_CONFIG_PUBLISHED_FALLBACK') value = 'your-secret-key';
      if (mutant === 'JWT_CONFIG_PRODUCTION_ONLY_GUARD' && env.NODE_ENV !== 'production') value = undefined;
      if (mutant === 'JWT_CONFIG_TRIMMED_RETURN') value = sample.value.trim();
      state.cache.add(target);
      return state.reuse || { CONFIG: { JWT_SECRET_KEY: value, NODE_ENV: env.NODE_ENV, MONGODB_URL: uri } };
    },
  };
  const runtime = { env, effects, loader, plan, mongoose, network, substitutes: {}, key, uri,
    cacheHas: target => state.cache.has(target),
    originalSign(payload, signingKey) { state.signatures++; return { payload, signingKey }; },
    jwt: { verify(token, verifyingKey) {
      if (token.signingKey !== verifyingKey) { const error = new Error('FAKE_INVALID_SIGNATURE'); error.name = 'JsonWebTokenError'; throw error; }
      return token.payload;
    } },
  };
  return { runtime, state };
}
function configurationUnits() {
  configurationCheck('CONFIG_SCRIPTED_126_LOADS_AND_DEEP_FROZEN_SAFE_EVIDENCE', () => {
    const { runtime, state } = fakeConfigurationRuntime(); const original = runtime.mongoose.connect;
    const evidence = collectConfigurationEvidence(runtime);
    need(state.loads.length === 126 && state.loads.filter(row => !row.mutant).length === 117
      && state.loads.filter(row => row.mutant).length === 9 && state.signatures === 18
      && state.delegated === 0 && state.cache.size === 0 && Object.keys(state.overrides).length === 0,
    'CONFIG_FAKE_OPERATION_COUNTS');
    need(runtime.mongoose.connect === original && Object.isFrozen(evidence) && Object.isFrozen(evidence.cases)
      && Object.isFrozen(evidence.sensitivity) && evidence.cases.every(Object.isFrozen) && evidence.sensitivity.every(Object.isFrozen)
      && JSON.stringify(evidence) === JSON.stringify({ cases: portsOriginal.requiredCaseIds.slice(53, 59).map(id => ({ id, status: 'PASS' })),
        sensitivity: portsOriginal.requiredSensitivityIds.slice(14).map(id => ({ id, detected: true })) }), 'CONFIG_SAFE_EVIDENCE');
    need(runtime.env.NODE_ENV === 'test' && runtime.env.JWT_SECRET_KEY === runtime.key && runtime.env.MONGODB_URL === runtime.uri,
      'CONFIG_FINAL_ENV_RESTORED');
  });
  const samples = configurationSamples('synthetic-key');
  configurationCheck('CONFIG_EXACT_108_SAMPLE_IDENTITIES_AND_25_TRIM_POINTS', () => {
    const seen = new Set(samples.map(row => row.id));
    const evidence = configurationSampleEvidence(samples, seen);
    need(evidence.length === 6 && seen.size === 108 && samples.filter(row => row.accepted).length === 12
      && samples.filter(row => row.group === portsOriginal.requiredCaseIds[54] && row.environment === 'test').length === 27
      && samples.every(Object.isFrozen) && Object.isFrozen(samples), 'CONFIG_MATRIX_FIXED');
  });
  for (const [id, change] of [
    ['MISSING', (expected, seen) => seen.delete(expected[0].id)],
    ['EXTRA', (expected, seen) => seen.add('not-admitted')],
    ['DUPLICATE_EXPECTED', expected => { expected[1] = expected[0]; }],
    ['WRONG_GROUP', expected => { expected[0] = { ...expected[0], group: expected[1].group }; }],
    ['WRONG_ACCEPTANCE_COUNT', expected => { expected[0] = { ...expected[0], accepted: true }; }],
  ]) configurationCheck('CONFIG_SAMPLE_SET_' + id, () => {
    const expected = samples.slice(); const seen = new Set(expected.map(row => row.id)); change(expected, seen);
    let failed = false; try { configurationSampleEvidence(expected, seen); } catch { failed = true; }
    need(failed, 'CONFIG_BAD_SAMPLE_SET_REJECTED');
  });
  for (const absent of [[], ['JWT_SECRET_KEY'], ['NODE_ENV', 'MONGODB_URL'], ['NODE_ENV', 'JWT_SECRET_KEY', 'MONGODB_URL']])
    configurationCheck('CONFIG_ENV_PRESENCE_' + absent.join('_'), () => {
      const env = { NODE_ENV: 'original-env', JWT_SECRET_KEY: 'original-key', MONGODB_URL: 'original-uri' };
      for (const key of absent) delete env[key]; const before = JSON.stringify(env); const restore = configurationEnvironment(env);
      Object.assign(env, { NODE_ENV: 'changed-env', JWT_SECRET_KEY: 'changed-key', MONGODB_URL: 'changed-uri' }); restore();
      need(JSON.stringify(env) === before && absent.every(key => !Object.hasOwn(env, key)), 'CONFIG_OWN_ENV_EXACT');
    });
  for (const port of ['env', 'effects', 'loader', 'mongoose', 'network', 'substitutes', 'cacheHas', 'originalSign', 'jwt', 'uri'])
    configurationCheck('CONFIG_MISSING_PORT_' + port, () => {
      const { runtime } = fakeConfigurationRuntime(); delete runtime[port];
      configurationFailure(() => collectConfigurationEvidence(runtime), 'CONFIG_RUNTIME_PORTS');
    });
  const adversaries = [
    ['WRONG_EXCEPTION', f => { f.state.hook = () => { throw new Error('synthetic-private-sentinel'); }; }, 'CONFIG_EXPECTED_REJECTION'],
    ['CAUGHT_CONNECTION', f => { f.state.hook = () => { try { f.runtime.mongoose.connect(); } catch {} }; }, 'CONFIG_LOAD_EFFECT'],
    ['CAUGHT_LISTEN', f => { f.state.hook = () => { try { f.runtime.network.Server.prototype.listen(); } catch {} }; }, 'CONFIG_LOAD_EFFECT'],
    ['CAUGHT_WRITE', f => { f.state.hook = () => { try { f.runtime.mongoose.Model.create(); } catch {} }; }, 'CONFIG_LOAD_EFFECT'],
    ['CAUGHT_QUERY_WRITE', f => { f.state.hook = () => { try { f.runtime.mongoose.Query.prototype.exec.call({ op: 'updateOne' }); } catch {} }; }, 'CONFIG_LOAD_EFFECT'],
    ['PROVIDER', f => { f.state.hook = () => { f.runtime.effects.email++; }; }, 'CONFIG_LOAD_EFFECT'],
    ['LOGGER', f => { f.state.hook = () => { f.runtime.effects.logger++; }; }, 'CONFIG_LOAD_EFFECT'],
    ['JWT_ISSUANCE', f => { f.state.hook = () => { f.runtime.effects.jwtIssued++; }; }, 'CONFIG_LOAD_EFFECT'],
    ['MODEL_REGISTRATION', f => { f.state.hook = () => { f.state.models.push('Unadmitted'); }; }, 'CONFIG_MODEL_OR_CONNECTION'],
    ['CONNECTION_STATE', f => { f.state.hook = () => { f.runtime.mongoose.connection.readyState = 1; }; }, 'CONFIG_MODEL_OR_CONNECTION'],
    ['ENV_DRIFT', f => { f.state.hook = () => { f.runtime.env.MONGODB_URL = 'other'; }; }, 'CONFIG_LOAD_ENV_DRIFT'],
    ['UNCLEARED_CACHE', f => { f.state.cache.add('compiled/config/config.js'); f.runtime.loader.resetCompiled = () => {}; }, 'CONFIG_CACHE_NOT_CLEARED'],
    ['WRONG_CACHE_TARGET', f => { f.runtime.cacheHas = () => false; }, 'CONFIG_TARGET_CACHE'],
    ['REUSED_EXPORT', f => { f.state.reuse = { CONFIG: { JWT_SECRET_KEY: f.runtime.key, NODE_ENV: 'test', MONGODB_URL: f.runtime.uri } }; }, 'CONFIG_REUSED_EXPORT'],
    ['SIGNATURE_CONTROL', f => { f.runtime.jwt.verify = () => ({}); }, 'CONFIG_SIGNATURE_CONTROL'],
    ['TRIM_SIGNATURE_ACCEPTED', f => { f.runtime.jwt.verify = token => token.payload; }, 'CONFIG_SIGNATURE_NOT_REJECTED'],
    ['SIGNATURE_WRONG_EXCEPTION', f => { f.runtime.jwt.verify = (token, key) => { if (token.signingKey !== key) throw new Error('private'); return token.payload; }; }, 'CONFIG_SIGNATURE_WRONG_ERROR'],
    ['MUTANT_UNRELATED_EXCEPTION', f => { f.state.hook = (sample, mutant) => { if (mutant) throw new Error('private'); }; }, 'CONFIG_MUTANT_NOT_DETECTED'],
    ['NOMINAL_RESTORATION_FAILURE', f => { f.state.hook = (sample, mutant) => { if (!mutant && f.state.loads.length > 109) throw new Error('private'); }; }, 'CONFIG_EXPECTED_REJECTION'],
  ];
  for (const [id, mutate, code] of adversaries) configurationCheck('CONFIG_REJECTS_' + id, () => {
    const fake = fakeConfigurationRuntime(); const original = fake.runtime.mongoose.connect; mutate(fake);
    configurationFailure(() => collectConfigurationEvidence(fake.runtime), code);
    need(fake.runtime.env.NODE_ENV === 'test' && fake.runtime.env.JWT_SECRET_KEY === fake.runtime.key
      && fake.runtime.env.MONGODB_URL === fake.runtime.uri && fake.runtime.mongoose.connect === original
      && Object.keys(fake.state.overrides).length === 0 && fake.state.delegated === 0, 'CONFIG_FAILURE_RESTORES_BOUNDARY');
  });
  for (const name of ['sms', 'push', 'console', 'unexpected', 'excluded', 'dbWrites'])
    configurationCheck('CONFIG_REJECTS_EFFECT_' + name, () => {
      const fake = fakeConfigurationRuntime(); fake.state.hook = () => { fake.runtime.effects[name]++; };
      configurationFailure(() => collectConfigurationEvidence(fake.runtime), 'CONFIG_LOAD_EFFECT');
    });
  const tapSelectors = [
    runtime => [runtime.mongoose, 'connect'], runtime => [runtime.mongoose, 'createConnection'],
    runtime => [runtime.mongoose.Connection.prototype, 'openUri'],
    runtime => [runtime.mongoose.mongo.MongoClient.prototype, 'connect'],
    runtime => [runtime.network.Socket.prototype, 'connect'], runtime => [runtime.network.Server.prototype, 'listen'],
    runtime => [runtime.mongoose.Model, 'create'], runtime => [runtime.mongoose.Model, 'insertMany'],
    runtime => [runtime.mongoose.Model, 'bulkWrite'], runtime => [runtime.mongoose.Model.prototype, 'save'],
    runtime => [runtime.mongoose.Query.prototype, 'exec'],
  ];
  for (const [index, select] of tapSelectors.entries()) {
    configurationCheck('CONFIG_EVERY_TAP_REQUIRED_' + index, () => {
      const { runtime } = fakeConfigurationRuntime(); const originals = tapSelectors.map(get => {
        const [target, name] = get(runtime); return Object.getOwnPropertyDescriptor(target, name);
      });
      const [target, name] = select(runtime); delete target[name];
      configurationFailure(() => collectConfigurationEvidence(runtime), 'CONFIG_TAP_MISSING');
      tapSelectors.forEach((get, position) => {
        if (position === index) return;
        const [object, key] = get(runtime); const descriptor = Object.getOwnPropertyDescriptor(object, key);
        need(descriptor.value === originals[position].value && descriptor.writable === originals[position].writable
          && descriptor.configurable === originals[position].configurable && descriptor.enumerable === originals[position].enumerable,
        'CONFIG_ALL_PRIOR_GUARDED_DESCRIPTORS_RESTORED');
      });
    });
    configurationCheck('CONFIG_EVERY_TAP_BLOCKS_BEFORE_DELEGATION_' + index, () => {
      const { runtime, state } = fakeConfigurationRuntime(); const attempts = { connection: 0, listen: 0, write: 0 };
      withConfigurationTaps({ ...runtime, attempts }, () => {
        const [target, name] = select(runtime);
        configurationFailure(() => target[name].call({ op: 'deleteMany' }), 'CONFIG_OPERATION_ATTEMPT');
      });
      need(state.delegated === 0 && runtime.effects.unexpected === 1
        && attempts.connection + attempts.listen + attempts.write === 1, 'CONFIG_EVERY_ATTEMPT_LATCHED');
    });
  }
  configurationCheck('CONFIG_PARTIAL_TAP_INSTALL_RESTORES_PREVIOUS_GUARDED_REFERENCES', () => {
    const { runtime } = fakeConfigurationRuntime(); const original = runtime.mongoose.connect;
    delete runtime.mongoose.Model.bulkWrite;
    configurationFailure(() => collectConfigurationEvidence(runtime), 'CONFIG_TAP_MISSING');
    need(runtime.mongoose.connect === original, 'CONFIG_PARTIAL_INSTALL_RESTORED');
  });
  configurationCheck('CONFIG_TAP_DRIFT_RESTORED_AND_REJECTED', () => {
    const { runtime } = fakeConfigurationRuntime(); const original = runtime.mongoose.connect;
    configurationFailure(() => withConfigurationTaps({ ...runtime, attempts: { connection: 0, listen: 0, write: 0 } },
      () => { runtime.mongoose.connect = () => {}; }), 'CONFIG_RESTORATION_FAILED');
    need(runtime.mongoose.connect === original, 'CONFIG_DRIFT_RESTORED');
  });
  configurationCheck('CONFIG_QUERY_NONWRITE_DELEGATES_AND_ALL_WRITE_OPS_DENY', () => {
    const { runtime, state } = fakeConfigurationRuntime(); const attempts = { connection: 0, listen: 0, write: 0 };
    withConfigurationTaps({ ...runtime, attempts }, () => {
      need(runtime.mongoose.Query.prototype.exec.call({ op: 'find' }) === 'fake-read', 'CONFIG_NONWRITE_QUERY');
      for (const op of ['updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete'])
        configurationFailure(() => runtime.mongoose.Query.prototype.exec.call({ op }), 'CONFIG_OPERATION_ATTEMPT');
    });
    need(state.delegated === 1 && attempts.write === 8 && runtime.effects.unexpected === 8, 'CONFIG_WRITE_ATTEMPT_LATCHES');
  });
  configurationCheck('CONFIG_PRIMARY_FAILURE_PRESERVED_WITH_PRIVATE_CLEANUP_ERRORS', () => {
    const primary = Object.assign(new Error('CONFIG_EXPECTED_REJECTION'), { fixtureCode: 'CONFIG_EXPECTED_REJECTION' });
    const order = []; const caught = configurationFailure(() => configurationFinally(() => { throw primary; }, [
      () => { order.push(1); throw new Error('private-a'); }, () => { order.push(2); throw new Error('private-b'); },
    ]), 'CONFIG_EXPECTED_REJECTION');
    need(caught === primary && order.join(',') === '1,2' && caught.configurationCleanupFailures.length === 2
      && !Object.getOwnPropertyDescriptor(caught, 'configurationCleanupFailures').enumerable
      && JSON.stringify(caught) === '{"fixtureCode":"CONFIG_EXPECTED_REJECTION"}', 'CONFIG_PRIVATE_RESTORATION_FAILURES');
  });
  configurationCheck('CONFIG_FROZEN_PRIMARY_SURVIVES_CLEANUP', () => {
    const primary = Object.freeze(Object.assign(new Error('CONFIG_EXPECTED_REJECTION'), { fixtureCode: 'CONFIG_EXPECTED_REJECTION' }));
    const caught = configurationFailure(() => configurationFinally(() => { throw primary; }, [() => { throw new Error('private'); }]), 'CONFIG_EXPECTED_REJECTION');
    need(caught === primary, 'CONFIG_FROZEN_PRIMARY_PRESERVED');
  });
  configurationCheck('CONFIG_TAP_DRIFT_PRESERVES_EXISTING_PRIMARY', () => {
    const { runtime } = fakeConfigurationRuntime(); const original = runtime.network.Server.prototype.listen;
    const primary = Object.assign(new Error('CONFIG_EXPECTED_REJECTION'), { fixtureCode: 'CONFIG_EXPECTED_REJECTION' });
    const caught = configurationFailure(() => withConfigurationTaps({ ...runtime, attempts: { connection: 0, listen: 0, write: 0 } }, () => {
      runtime.network.Server.prototype.listen = () => {}; throw primary;
    }), 'CONFIG_EXPECTED_REJECTION');
    need(caught === primary && caught.configurationCleanupFailures.length === 1
      && runtime.network.Server.prototype.listen === original, 'CONFIG_DRIFT_PRIMARY_RESTORED');
  });
  configurationCheck('CONFIG_ENV_RESTORES_AFTER_UNSET_LOAD_THROWS', () => {
    const { runtime, state } = fakeConfigurationRuntime(); delete runtime.env.JWT_SECRET_KEY;
    state.hook = () => { throw new Error('private'); };
    configurationFailure(() => collectConfigurationEvidence(runtime), 'CONFIG_EXPECTED_REJECTION');
    need(!Object.hasOwn(runtime.env, 'JWT_SECRET_KEY') && runtime.env.NODE_ENV === 'test'
      && runtime.env.MONGODB_URL === runtime.uri && state.cache.size === 0, 'CONFIG_UNSET_FAILURE_RESTORED');
  });
}
function recordingCheck(id, action) { action(); recordingRows.push(id); }
function recordingUnits() {
  for (const name of ['find', 'aggregate', 'count', 'getMore']) recordingCheck('READ_' + name, () => {
    const ops = { users: 0, dependents: 0 }; const effects = { unexpected: 0 };
    const command = name === 'getMore' ? { getMore: 12345, collection: 'dependents' } : { [name]: 'dependents' };
    recordReadOperation({ databaseName: 'owned', commandName: name, command }, 'owned', ops, effects);
    need(ops.users === 0 && ops.dependents === 1 && effects.unexpected === 0
      && Object.keys(ops).join(',') === 'users,dependents', 'READ_COUNT_PRIVATE_ONLY');
  });
  for (const [id, event] of [
    ['OTHER_DB', { databaseName: 'other', commandName: 'find', command: { find: 'users' } }],
    ['NONREAD', { databaseName: 'owned', commandName: 'insert', command: { insert: 'users' } }],
  ]) recordingCheck('READ_IGNORE_' + id, () => {
    const ops = { users: 0 }; const effects = { unexpected: 0 };
    recordReadOperation(event, 'owned', ops, effects); need(ops.users === 0 && effects.unexpected === 0, 'READ_IGNORE_SCOPE');
  });
  for (const [id, command] of [['UNKNOWN', { find: 'other' }], ['PROTOTYPE', { find: '__proto__' }], ['MALFORMED', {}]])
    recordingCheck('READ_DENY_' + id, () => {
      const ops = { users: 0 }; const effects = { unexpected: 0 };
      recordReadOperation({ databaseName: 'owned', commandName: 'find', command }, 'owned', ops, effects);
      need(ops.users === 0 && effects.unexpected === 1, 'READ_UNKNOWN_LATCHED');
    });
  for (const value of [Number.MAX_SAFE_INTEGER, -1, 0.5, NaN]) recordingCheck('READ_UNSAFE_COUNTER', () => {
    const ops = { users: value }; const effects = { unexpected: 0 };
    recordReadOperation({ databaseName: 'owned', commandName: 'find', command: { find: 'users' } }, 'owned', ops, effects);
    need(Object.is(ops.users, value) && effects.unexpected === 1, 'READ_COUNTER_BOUND');
  });
  recordingCheck('READ_CUMULATIVE_SAME_OBJECT', () => {
    const ops = { users: 0 }; const original = ops; const effects = { unexpected: 0 };
    for (let i = 0; i < 2; i++) recordReadOperation({ databaseName: 'owned', commandName: 'count', command: { count: 'users' } }, 'owned', ops, effects);
    need(ops === original && ops.users === 2 && effects.unexpected === 0, 'READ_STABLE_COUNTERS');
  });
  const payload = () => ({ tokens: ['fixture-owned-token'], notification: { title: 'Synthetic', body: 'Synthetic' }, data: { type: 'test' } });
  recordingCheck('PUSH_PRIVATE_COPY_AND_FIXED_RESPONSE', () => {
    const request = payload(); const captures = []; const effects = { push: 0, unexpected: 0 };
    const response = recordPush(request, captures, effects);
    request.tokens[0] = 'changed'; request.notification.title = 'changed'; request.data.type = 'changed';
    need(effects.push === 1 && effects.unexpected === 0 && captures.length === 1
      && captures[0].tokens[0] === 'fixture-owned-token' && captures[0].notification.title === 'Synthetic'
      && captures[0].data.type === 'test' && JSON.stringify(response) === '{"successCount":0,"failureCount":0,"responses":[]}', 'PUSH_COPY');
  });
  for (const data of [undefined, {}]) recordingCheck('PUSH_OPTIONAL_DATA', () => {
    const request = payload(); request.data = data; const captures = []; const effects = { push: 0, unexpected: 0 };
    recordPush(request, captures, effects); need(captures.length === 1 && effects.push === 1 && effects.unexpected === 0, 'PUSH_OPTIONAL_DATA');
  });
  const invalid = [null, [], {}, { ...payload(), tokens: [] }, { ...payload(), tokens: Array(501).fill('synthetic') },
    { ...payload(), tokens: [4] }, { ...payload(), tokens: [''] }, { ...payload(), notification: {} },
    { ...payload(), notification: { title: 'Synthetic', body: 4 } },
    { ...payload(), notification: { title: 'Synthetic', body: 'Synthetic', extra: 'unexpected' } },
    { ...payload(), data: [] }, { ...payload(), data: { type: 4 } }, { ...payload(), unknown: 'synthetic-private-sentinel' }];
  const accessor = payload(); Object.defineProperty(accessor, 'tokens', { get() { throw new Error('synthetic-private-sentinel'); } }); invalid.push(accessor);
  for (let index = 0; index < invalid.length; index++) recordingCheck('PUSH_INVALID_' + index, () => {
    const captures = []; const effects = { push: 0, unexpected: 0 }; let caught;
    try { recordPush(invalid[index], captures, effects); } catch (error) { caught = error; }
    need(caught?.fixtureCode === 'UNDECLARED_PUSH_PAYLOAD' && caught.message === 'UNDECLARED_PUSH_PAYLOAD'
      && Object.keys(caught).join(',') === 'fixtureCode' && captures.length === 0
      && effects.push === 1 && effects.unexpected === 1, 'PUSH_UNEXPECTED_LATCHED_DESPITE_CATCH');
  });
}
async function setupUnits() {
  const cases = [];
  const named = name => Object.assign(new Error('synthetic-private-sentinel'), { name });
  const coded = code => Object.assign(new Error('synthetic-private-sentinel'), { code });
  const samples = {
    PERMISSION: () => coded('ERR_ACCESS_DENIED'),
    SELECTION: () => named('MongooseServerSelectionError'),
    NETWORK: () => coded('ECONNREFUSED'),
    SERVER: () => coded(50),
    TYPE_ERROR: () => new TypeError('synthetic-private-sentinel'),
    DUPLICATE_KEY: () => coded(11000),
    NAMESPACE_EXISTS: () => coded(48),
    INDEX_CONFLICT: () => coded(85),
    OUT_OF_DISK_SPACE: () => Object.assign(named('MongoServerError'), { code: 14031 }),
    CANNOT_CREATE_INDEX: () => Object.assign(named('MongoServerError'), { code: 67 }),
    INVALID_OPTIONS: () => Object.assign(named('MongoServerError'), { code: 72 }),
    UNKNOWN: () => new Error('synthetic-private-sentinel'),
  };
  const publicCodes = Object.values(SETUP_FAILURE_CODES).flatMap(row => Object.values(row));
  need(publicCodes.length === 48 && new Set(publicCodes).size === 48
    && publicCodes.every(code => /^DB_[A-Z_]+$/.test(code)), 'SETUP_LITERAL_CODES');
  async function failed(step, original, expected) {
    let calls = 0; let caught;
    try { await runSetupStep(step, async () => { calls++; throw original; }); } catch (error) { caught = error; }
    need(calls === 1 && caught instanceof Error && caught.fixtureCode === expected
      && caught.message === expected && caught.name === 'Error' && caught.errors === undefined
      && caught.cause === original && Object.keys(caught).join(',') === 'fixtureCode'
      && Object.getOwnPropertyDescriptor(caught, 'cause').enumerable === false, 'SETUP_SANITIZED_FAILURE');
  }
  for (const step of Object.keys(SETUP_FAILURE_CODES)) {
    const value = {}; let calls = 0;
    const returned = await runSetupStep(step, () => { calls++; return value; });
    need(returned === value && calls === 1, 'SETUP_RESULT_PASSTHROUGH');
    cases.push(step + '_SUCCESS_ONCE');
    for (const [category, create] of Object.entries(samples)) {
      await failed(step, create(), SETUP_FAILURE_CODES[step][category]); cases.push(step + '_' + category);
    }
    for (const [category, code] of [['OUT_OF_DISK_SPACE', 14031], ['CANNOT_CREATE_INDEX', 67], ['INVALID_OPTIONS', 72]]) {
      const nested = Object.assign(named('MongoServerError'), {
        cause: new Error('synthetic-private-sentinel', { cause: coded(code) }),
      });
      await failed(step, nested, SETUP_FAILURE_CODES[step][category]); cases.push(step + '_NESTED_' + category);
      await failed(step, coded(String(code)), SETUP_FAILURE_CODES[step].UNKNOWN); cases.push(step + '_STRING_' + category);
      const guarded = Object.assign(named('MongoServerError'), { code,
        cause: Object.assign(new Error('synthetic-private-sentinel'), { fixtureCode: 'UNDECLARED_DRIVER_URI' }),
      });
      await failed(step, guarded, 'UNDECLARED_DRIVER_URI'); cases.push(step + '_GUARD_BEFORE_' + category);
    }
    const guard = Object.assign(new Error('synthetic-private-sentinel'), { fixtureCode: 'UNDECLARED_DRIVER_URI' });
    await failed(step, guard, 'UNDECLARED_DRIVER_URI'); cases.push(step + '_GUARD_PRESERVED');
    await failed(step, new Error('synthetic-private-sentinel', { cause: guard }), 'UNDECLARED_DRIVER_URI');
    cases.push(step + '_WRAPPED_GUARD_PRESERVED');
    await failed(step, new Error('synthetic-private-sentinel', { cause: coded('EPERM') }), SETUP_FAILURE_CODES[step].PERMISSION);
    cases.push(step + '_KNOWN_CAUSE');
    const opaque = Object.assign(new Error('synthetic-private-sentinel'), {
      name: 'synthetic-private-sentinel', code: 'synthetic-private-sentinel',
      fixtureCode: 'synthetic-private-sentinel', errors: { 'synthetic-private-sentinel': {} },
      uri: 'synthetic-private-sentinel', rows: [{ private: 'synthetic-private-sentinel' }],
    });
    await failed(step, opaque, SETUP_FAILURE_CODES[step].UNKNOWN); cases.push(step + '_PRIVATE_DATA_IGNORED');
    let getters = 0; const accessorError = new Error('synthetic-private-sentinel');
    for (const field of ['name', 'code', 'cause', 'fixtureCode'])
      Object.defineProperty(accessorError, field, { get() { getters++; throw new Error('synthetic-private-sentinel'); } });
    await failed(step, accessorError, SETUP_FAILURE_CODES[step].UNKNOWN);
    need(getters === 0, 'SETUP_GETTERS_IGNORED'); cases.push(step + '_ACCESSORS_IGNORED');
    await failed(step, coded(999999), SETUP_FAILURE_CODES[step].UNKNOWN); cases.push(step + '_UNKNOWN_NUMBER');
  }
  let calls = 0; let invalid;
  try { await runSetupStep('OTHER', () => { calls++; }); } catch (error) { invalid = error; }
  need(calls === 0 && invalid.fixtureCode === 'UNDECLARED_SETUP_STEP', 'SETUP_UNKNOWN_STEP'); cases.push('UNKNOWN_STEP_NO_ACTION');
  invalid = undefined;
  try { await runSetupStep('CONNECT', undefined); } catch (error) { invalid = error; }
  need(invalid.fixtureCode === 'UNDECLARED_SETUP_STEP', 'SETUP_INVALID_ACTION'); cases.push('INVALID_ACTION');
  const cycle = new Error('synthetic-private-sentinel'); cycle.cause = cycle;
  await failed('CONNECT', cycle, SETUP_FAILURE_CODES.CONNECT.UNKNOWN); cases.push('CYCLIC_CAUSE_BOUNDED');
  const deep = new Error('synthetic-private-sentinel', { cause: new Error('synthetic-private-sentinel',
    { cause: new Error('synthetic-private-sentinel', { cause: coded('EPERM') }) }) });
  await failed('CONNECT', deep, SETUP_FAILURE_CODES.CONNECT.UNKNOWN); cases.push('DEEP_CAUSE_NOT_INSPECTED');
  class MongoServerSelectionError extends Error {}
  const constructorError = new MongoServerSelectionError('synthetic-private-sentinel');
  Object.defineProperty(constructorError, 'name', { get() { throw new Error('synthetic-private-sentinel'); } });
  await failed('CONNECT', constructorError, SETUP_FAILURE_CODES.CONNECT.SELECTION); cases.push('KNOWN_CONSTRUCTOR_WITHOUT_GETTER');
  const diagnosticCount = cases.length;
  for (const hasPrimary of [false, true]) for (const badHTTP of [false, true]) for (const badODM of [false, true]) {
    const order = []; const value = {};
    const primary = Object.assign(new Error('DB_CONNECT_TYPE_ERROR', { cause: new Error('synthetic-private-sentinel') }),
      { fixtureCode: 'DB_CONNECT_TYPE_ERROR' });
    const httpError = new Error('synthetic-private-sentinel'); const odmError = new Error('synthetic-private-sentinel');
    let result; let caught;
    try {
      result = await withOwnedCleanup(
        () => { order.push('ACTION'); if (hasPrimary) throw primary; return value; },
        () => { order.push('HTTP'); if (badHTTP) throw httpError; },
        () => { order.push('ODM'); if (badODM) throw odmError; }
      );
    } catch (error) { caught = error; }
    need(order.join(',') === 'ACTION,HTTP,ODM', 'CLEANUP_BOTH_HANDLES_ONCE');
    if (hasPrimary) need(caught === primary, 'CLEANUP_PRIMARY_PRESERVED');
    else if (badHTTP || badODM) need(caught.fixtureCode === 'OWNED_HANDLE_CLEANUP_FAILED'
      && caught.cause === (badHTTP ? httpError : odmError) && caught.errors === undefined, 'CLEANUP_FIXED_FAILURE');
    else need(caught === undefined && result === value, 'CLEANUP_SUCCESS_PASSTHROUGH');
    if (badHTTP || badODM) {
      need(caught.ownedCleanupFailures.length === Number(badHTTP) + Number(badODM)
        && Object.getOwnPropertyDescriptor(caught, 'ownedCleanupFailures').enumerable === false
        && JSON.stringify(caught) === JSON.stringify({ fixtureCode: hasPrimary ? 'DB_CONNECT_TYPE_ERROR' : 'OWNED_HANDLE_CLEANUP_FAILED' }),
      'CLEANUP_CAUSES_PRIVATE');
      if (badHTTP) need(caught.ownedCleanupFailures[0].step === 'HTTP'
        && caught.ownedCleanupFailures[0].error === httpError, 'CLEANUP_HTTP_PROVENANCE');
      if (badODM) need(caught.ownedCleanupFailures.at(-1).step === 'ODM'
        && caught.ownedCleanupFailures.at(-1).error === odmError, 'CLEANUP_ODM_PROVENANCE');
    }
    cases.push('CLEANUP_MATRIX_' + [hasPrimary, badHTTP, badODM].map(Number).join(''));
  }
  const frozenPrimary = Object.freeze(Object.assign(new Error('DB_CONNECT_UNKNOWN'), { fixtureCode: 'DB_CONNECT_UNKNOWN' }));
  const frozenOrder = []; let frozenCaught;
  try {
    await withOwnedCleanup(() => { throw frozenPrimary; },
      () => { frozenOrder.push('HTTP'); throw new Error('synthetic-private-sentinel'); },
      () => { frozenOrder.push('ODM'); throw new Error('synthetic-private-sentinel'); });
  } catch (error) { frozenCaught = error; }
  need(frozenCaught === frozenPrimary && frozenOrder.join(',') === 'HTTP,ODM', 'CLEANUP_FROZEN_PRIMARY');
  cases.push('CLEANUP_FROZEN_PRIMARY');
  for (const missing of [0, 1, 2]) {
    let effects = 0; let caught; const actions = [() => { effects++; }, () => { effects++; }, () => { effects++; }];
    actions[missing] = undefined;
    try { await withOwnedCleanup(...actions); } catch (error) { caught = error; }
    need(effects === 0 && caught.fixtureCode === 'INVALID_OWNED_CLEANUP_PORTS', 'CLEANUP_MANDATORY_PORTS');
    cases.push('CLEANUP_MISSING_PORT_' + missing);
  }
  need(applicationImports === 0 && connections === 0 && domainWrites === 0, 'OFFLINE_EFFECTS');
  output(JSON.stringify({ schema: 'SD-AUTH-API-OFFLINE-1', cases: rows.length + cases.length + recordingRows.length + configurationRows.length, recordingCases: recordingRows.length,
    configurationControllerCases: configurationRows.length,
    admissionCases: rows.length, setupDiagnosticCases: diagnosticCount, ownedCleanupCases: cases.length - diagnosticCount, failed: 0,
    applicationImports, connections, domainWrites, processGrants: 'DENIED' }) + '\n');
}
recordingUnits();
configurationUnits();
setupUnits().catch(() => {
  output(JSON.stringify({ schema: 'SD-AUTH-API-OFFLINE-1', failed: 1, code: 'OFFLINE_SETUP_UNIT_FAILED' }) + '\n');
  process.exitCode = 1;
});
