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
const { promisify } = require('node:util');
const output = process.stdout.write.bind(process.stdout);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const portsOriginal = JSON.parse(fs.readFileSync(path.join(__dirname, 'ports-manifest.json'), 'utf8'));
if (portsOriginal.models.length !== 13 || !portsOriginal.models.some(row => row.name === 'WellnessPackage'
  && row.collection === 'wellnesspackages' && row.source === 'src1/modules/wellnessPackages/model/index.ts'
  && Array.isArray(row.indexes) && row.indexes.length === 0)
  || !portsOriginal.models.some(row => row.name === 'Dependent' && row.collection === 'dependents'
    && row.source === 'src1/modules/dependents/model/index.ts' && row.indexes.length === 0)) throw new Error('OFFLINE_WELLNESS_MAP');
const bootstrap = path.join(__dirname, 'bootstrap.cjs');
let applicationImports = 0; let connections = 0; let domainWrites = 0; let nativeChildLoads = 0;
const blockedWrite = () => { domainWrites++; throw new Error('OFFLINE_WRITE_DENIED'); };
for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream',
  'mkdir', 'mkdirSync', 'rm', 'rmSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync']) fs[name] = blockedWrite;
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile']) fs.promises[name] = blockedWrite;
const blockedNetwork = () => { connections++; throw new Error('OFFLINE_NETWORK_DENIED'); };
net.Socket.prototype.connect = blockedNetwork; net.connect = blockedNetwork;
net.Server.prototype.listen = blockedNetwork;
net.createConnection = blockedNetwork; tls.connect = blockedNetwork; dns.lookup = blockedNetwork;
globalThis.fetch = blockedNetwork;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.replace(/^node:/, '') === 'child_process') { nativeChildLoads++; throw new Error('OFFLINE_NATIVE_CHILD_FORBIDDEN'); }
  if (request !== bootstrap && !Module.isBuiltin(request)) { applicationImports++; throw new Error('OFFLINE_DOMAIN_IMPORT_DENIED'); }
  return originalLoad.call(this, request, parent, isMain);
};
const { validateAdmissionData, installLoader, runSetupStep, SETUP_FAILURE_CODES, withOwnedCleanup, recordReadOperation, recordPush,
  configurationSamples, configurationFinally, configurationEnvironment, withConfigurationTaps,
  configurationSampleEvidence, collectConfigurationEvidence, meetData, meetSame, createMeetRecorder,
  meetFetchLifecycle, withMeetFetchCleanup, indexLongWords, indexScalar, projectIndexRow,
  indexManifest, collectIndexObservations, withIndexTaps, validateIndexTypeReport, createIndexCommandPort, INDEX_SOURCE_SHA, INDEX_MUTANTS, INDEX_CASE_IDS, INDEX_MUTANT_IDS, profilePolicy, profileAdmission, createProfileBoundary,
  PROFILE_POLICY_SHA, PROFILE_SOURCE_PINS, PROFILE_VARIANTS, PROFILE_STATIC_INPUTS } = require(bootstrap);
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
  sources['src1/modules/common/utils/indexReadiness.ts'] = INDEX_SOURCE_SHA;
  for (const name of ['routes', 'controller', 'validation', 'service', 'types']) sources['src1/modules/meet/' + name + '/index.ts'] = 'a'.repeat(64);
  Object.assign(sources, PROFILE_SOURCE_PINS);
  for (const row of PROFILE_STATIC_INPUTS) { sources[row.source] = row.sourceSha256; files[row.compiled] = Buffer.from('inert'); }
  const mutants = Object.fromEntries(ports.requiredSensitivityIds.map(name => {
    const file = 'compiled/mutants/' + name + '.js'; files[file] = Buffer.from('inert');
    return [name, { source: name.startsWith('SPECIALIST_PROFILE_') ? 'src1/modules/specialistPortal/services/index.ts' : name.startsWith('JWT_CONFIG_') ? 'src1/config/config.ts' : name.startsWith('MEET_') ? 'src1/modules/meet/routes/index.ts'
      : name.startsWith('INDEX_') ? 'src1/modules/common/utils/indexReadiness.ts' : 'src1/modules/otp/repository/index.ts',
      originalSha256: name.startsWith('SPECIALIST_PROFILE_') ? ports.specialistProfile.sourceGuard.sha256 : name.startsWith('INDEX_') ? INDEX_SOURCE_SHA : 'a'.repeat(64),
      ...(name.startsWith('INDEX_') ? { mutantSha256: INDEX_MUTANTS[name].sourceSha }
        : name.startsWith('SPECIALIST_PROFILE_') ? { mutantSha256: PROFILE_VARIANTS[name] } : {}), file }];
  }));
  const plan = { schema: 'SD-AUTH-API-PLAN-1', role: ports.role, sourceCommit, sourceFiles: sources,
    compilation: { compiler: '5.9.3', status: 'TRANSPILE_ONLY_NOT_TYPECHECKED', selectedHelperTypecheck: fakeIndexTypeReport() },
    modules: Object.fromEntries(ports.roots.map(root => [root, 'compiled/entry.js'])), mutants,
    models: ports.models, requiredCaseIds: ports.requiredCaseIds, requiredSensitivityIds: ports.requiredSensitivityIds,
    providerCounterKeys: ports.providerCounterKeys };
  plan.modules['@/config/config'] = 'compiled/config/config.js'; files['compiled/config/config.js'] = Buffer.from('inert');
  plan.modules['@/modules/meet/routes'] = 'compiled/modules/meet/routes/index.js'; files['compiled/modules/meet/routes/index.js'] = Buffer.from('inert');
  plan.modules['@/modules/common/utils/indexReadiness'] = 'compiled/modules/common/utils/indexReadiness.js';
  files['compiled/modules/common/utils/indexReadiness.js'] = Buffer.from('inert');
  plan.modules['@/modules/specialists/routes'] = 'compiled/modules/specialists/routes/index.js';
  files['compiled/modules/specialists/routes/index.js'] = Buffer.from('inert');
  plan.modules['@/modules/specialistPortal/services'] = 'compiled/modules/specialistPortal/services/index.js';
  files['compiled/modules/specialistPortal/services/index.js'] = Buffer.from('inert');
  for (const row of PROFILE_STATIC_INPUTS) {
    const alias = '@/' + row.source.slice(5, -3).replace(/\/index$/, '');
    plan.modules[alias] = row.compiled; plan.modules[alias + '/index'] = row.compiled;
  }
  const manifest = { schema: 'SD-AUTH-API-RUN-1', role: ports.role, runId, sourceCommit,
    database: 'sd_api_' + runId.replaceAll('-', ''), replicaSet: 'sd_rs_' + runId.replaceAll('-', ''),
    mongoId: 'c'.repeat(64), templateSha: 'd'.repeat(64) };
  const packet = { manifest, plan, ports, observed: { runId, files } };
  rebind(packet); return packet;
}
function fakeIndexTypeReport() {
  // Scripted metadata exercises admission only. No compiler/source is evaluated.
  const libraryFiles = Object.fromEntries(Array.from({ length: 45 }, (_, i) => ['lib.fake' + i + '.d.ts', 'a'.repeat(64)]));
  const programFiles = ['src1/modules/common/utils/indexReadiness.ts', ...Object.keys(libraryFiles).map(name => 'node_modules/typescript/lib/' + name)].sort();
  return { schema: 'SD-SELECTED-INDEX-TYPECHECK-1', status: 'PASS', compiler: '5.9.3',
    compilerSha256: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
    source: 'src1/modules/common/utils/indexReadiness.ts', sourceSha256: INDEX_SOURCE_SHA, libraryFiles, options: {}, programFiles,
    diagnostics: [], tdzControl: { status: 'REJECTED', sourceSha256: '6597c1a03c54702d89042a29263da81399934e68e8fb6c46f91c638cbe954400',
      requiredCode: 2448, referenceOffset: 42, programFiles: programFiles.slice(),
      diagnostics: [{ sourceId: 'VIRTUAL_SELECTED_INDEX_TDZ.ts', code: 2448, category: 1, start: 42, length: 12 }] } };
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
for (const [id, mutate] of [
  ['MISSING_MAP', p => { delete p.ports.recordingMeet; }],
  ['WRONG_TOKEN_URL', p => { p.ports.recordingMeet.tokenUrl = 'https://example.com/token'; }],
  ['WRONG_CALENDAR_URL', p => { p.ports.recordingMeet.calendarUrl += '&unexpected=true'; }],
  ['WRONG_ENVIRONMENT', p => { p.ports.recordingMeet.environment.GOOGLE_OAUTH_CLIENT_SECRET = 'other'; }],
  ['EXTRA_ENVIRONMENT', p => { p.ports.recordingMeet.environment.GOOGLE_SERVICE_ACCOUNT_FILE = 'forbidden'; }],
  ['WRONG_BODY_BOUND', p => { p.ports.recordingMeet.bodyBytes++; }],
  ['WRONG_RECORD_BOUND', p => { p.ports.recordingMeet.recordLimit++; }],
  ['WRONG_RESPONSE', p => { p.ports.recordingMeet.oauthResponse.access_token = 'other'; }],
  ['WRONG_COUNTER_SCOPE', p => { p.ports.recordingMeet.providerCounterScope = 'OTHER'; }],
  ['ALIAS_REBOUND', p => { p.plan.modules['@/modules/meet/routes'] = 'compiled/entry.js'; }],
  ['SOURCE_OMITTED', p => { delete p.plan.sourceFiles['src1/modules/meet/service/index.ts']; }],
  ['MUTANT_REBOUND', p => { p.plan.mutants.MEET_CALLBACK_GATED.source = 'src1/config/config.ts'; }],
]) check('MEET_ADMISSION_' + id, mutate, true);
for (const [id, mutate] of [
  ['HELPER_SOURCE_HASH', p => { p.plan.sourceFiles['src1/modules/common/utils/indexReadiness.ts'] = 'a'.repeat(64); }],
  ['HELPER_ALIAS', p => { p.plan.modules['@/modules/common/utils/indexReadiness'] = 'compiled/entry.js'; }],
  ['MUTANT_HASH', p => { p.plan.mutants.INDEX_KEY_ORDER_IGNORED.mutantSha256 = 'a'.repeat(64); }],
  ['MUTANT_SOURCE', p => { p.plan.mutants.INDEX_KEY_ORDER_IGNORED.source = 'src1/config/config.ts'; }],
  ['TYPE_REPORT_MISSING', p => { delete p.plan.compilation.selectedHelperTypecheck; }],
  ['TYPE_DIAGNOSTIC', p => { p.plan.compilation.selectedHelperTypecheck.diagnostics.push({ code: 1 }); }],
  ['TDZ_NOT_REJECTED', p => { p.plan.compilation.selectedHelperTypecheck.tdzControl.status = 'PASS'; }],
  ['TDZ_WRONG_REFERENCE', p => { p.plan.compilation.selectedHelperTypecheck.tdzControl.referenceOffset++; }],
]) check('INDEX_ADMISSION_' + id, mutate, true);
for (const [id, mutate] of [
  ['POLICY_MISSING', p => { delete p.ports.specialistProfile; }],
  ['POLICY_TRIAL_CHANGED', p => { p.ports.specialistProfile.trials[0].expected.status = 201; }],
  ['POLICY_EXTRA_KEY', p => { p.ports.specialistProfile.relaxed = true; }],
  ['PORTAL_ALIAS', p => { p.plan.modules['@/modules/specialistPortal/services'] = 'compiled/entry.js'; }],
  ['ROUTER_ALIAS', p => { p.plan.modules['@/modules/specialists/routes'] = 'compiled/entry.js'; }],
  ['PARENT_MISSING', p => { delete p.observed.files['compiled/modules/specialistPortal/services/index.js']; }],
  ['EXCLUSION_REMOVED', p => { delete p.ports.excludedCapabilities['@/modules/bookings/services']; }],
  ['EXCLUSION_WIDENED', p => { p.ports.excludedCapabilities['@/modules/specialists/services'] = ['SpecialistService']; }],
]) check('PROFILE_ADMISSION_' + id, mutate, true);
for (const source of Object.keys(PROFILE_SOURCE_PINS)) check('PROFILE_ADMISSION_SOURCE_' + source,
  p => { p.plan.sourceFiles[source] = 'e'.repeat(64); }, true);
for (const id of Object.keys(PROFILE_VARIANTS)) {
  check('PROFILE_ADMISSION_MUTANT_HASH_' + id, p => { p.plan.mutants[id].mutantSha256 = 'e'.repeat(64); }, true);
  check('PROFILE_ADMISSION_MUTANT_PATH_' + id, p => { p.plan.mutants[id].file = 'compiled/entry.js'; }, true);
}
for (const row of PROFILE_STATIC_INPUTS) {
  check('PROFILE_ADMISSION_STATIC_SOURCE_' + row.source, p => { p.plan.sourceFiles[row.source] = 'e'.repeat(64); }, true);
  check('PROFILE_ADMISSION_STATIC_PATH_' + row.compiled, p => { delete p.observed.files[row.compiled]; }, true);
  const alias = '@/' + row.source.slice(5, -3).replace(/\/index$/, '');
  for (const key of [alias, alias + '/index']) check('PROFILE_ADMISSION_STATIC_ALIAS_' + key, p => { p.plan.modules[key] = 'compiled/entry.js'; }, true);
}
const recordingRows = [];
const configurationRows = [];
const meetRows = [];
const indexRows = [];
const profileRows = [];
let activeProfileCase = null;
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
  const effects = Object.fromEntries(['email', 'sms', 'push', 'logger', 'console', 'unexpected', 'excluded', 'jwtIssued', 'dbWrites', 'calendar'].map(name => [name, 0]));
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
  for (const id of portsOriginal.requiredSensitivityIds.slice(14, 17)) plan.mutants[id] = {
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
        sensitivity: portsOriginal.requiredSensitivityIds.slice(14, 17).map(id => ({ id, detected: true })) }), 'CONFIG_SAFE_EVIDENCE');
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
async function meetUnits() {
  const spec = portsOriginal.recordingMeet;
  const effects = () => ({ calendar: 0, unexpected: 0 });
  const code = () => ({ kind: 'code', code: 'fixture-code', redirectUri: spec.environment.GOOGLE_OAUTH_REDIRECT_URI });
  const refresh = () => ({ kind: 'refresh', refreshToken: spec.environment.GOOGLE_OAUTH_REFRESH_TOKEN });
  const event = () => ({ kind: 'event', payload: { summary: 'Fixture Meet event', description: 'Created from test OAuth endpoint',
    start: { dateTime: '2030-01-15T10:00:00', timeZone: 'Asia/Kolkata' },
    end: { dateTime: '2030-01-15T10:30:00', timeZone: 'Asia/Kolkata' },
    attendees: [{ email: 'patient@example.com' }, { email: 'specialist@example.com' }] } });
  function request(expected) {
    const credentials = { client_id: spec.environment.GOOGLE_OAUTH_CLIENT_ID, client_secret: spec.environment.GOOGLE_OAUTH_CLIENT_SECRET };
    if (expected.kind === 'code' || expected.kind === 'refresh') return [spec.tokenUrl, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(expected.kind === 'code'
        ? { code: expected.code, ...credentials, redirect_uri: expected.redirectUri, grant_type: 'authorization_code' }
        : { ...credentials, refresh_token: expected.refreshToken, grant_type: 'refresh_token' }) }];
    return [spec.calendarUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + spec.oauthResponse.access_token,
      'Content-Type': 'application/json' }, body: JSON.stringify({ ...expected.payload,
        conferenceData: { createRequest: { requestId: 'meet-1234567890', conferenceSolutionKey: { type: 'hangoutsMeet' } } } }) }];
  }
  async function test(id, action) { await action(); meetRows.push(id); }
  function failure(action, code) {
    let caught; try { action(); } catch (error) { caught = error; }
    need(caught?.fixtureCode === code && caught.message === code && Object.keys(caught).join(',') === 'fixtureCode', 'MEET_FIXED_FAILURE');
    return caught;
  }
  async function rejection(action, code) {
    let caught; try { await action(); } catch (error) { caught = error; }
    need(caught?.fixtureCode === code && caught.message === code && Object.keys(caught).join(',') === 'fixtureCode', 'MEET_FIXED_ASYNC_FAILURE');
    return caught;
  }
  for (const expected of [code(), refresh(), event()]) await test('MEET_EXACT_' + expected.kind.toUpperCase(), async () => {
    const counters = effects(); const port = createMeetRecorder(spec, counters); port.expectMeetRequests([expected]);
    const args = request(expected); const response = await port.fetch(...args);
    need(response.ok === true && Object.keys(response).join(',') === 'ok,text' && Object.isFrozen(response), 'MEET_RESPONSE_SURFACE');
    const wanted = expected.kind === 'event' ? spec.eventResponse : spec.oauthResponse;
    need(meetSame(JSON.parse(await response.text()), wanted) && counters.calendar === 1 && counters.unexpected === 0, 'MEET_REPLY_AND_COUNTER');
    port.expectMeetRequests([]); port.assertDone();
    const captures = port.meetRequests;
    need(Object.isFrozen(captures) && captures.length === 1 && Object.isFrozen(captures[0])
      && meetSame(Object.keys(captures[0]).sort(), ['body', 'headers', 'kind', 'method', 'url'])
      && captures[0].kind === expected.kind && captures[0].url === args[0] && captures[0].method === 'POST'
      && Object.isFrozen(captures[0].headers) && Object.isFrozen(captures[0].body), 'MEET_IMMUTABLE_CAPTURE');
    let immutable = false; try { captures.push({}); } catch (error) { immutable = error instanceof TypeError; }
    need(immutable, 'MEET_CAPTURE_ARRAY_IMMUTABLE');
  });
  // Plain TypeError is intentionally not fed through a fixture-code assertion.
  await test('MEET_QUEUE_COPY_AND_CAPTURE_IMMUTABILITY', async () => {
    const counters = effects(); const port = createMeetRecorder(spec, counters); const queued = refresh();
    port.expectMeetRequests([queued]); queued.refreshToken = 'changed-after-queue';
    const args = request(refresh()); await port.fetch(...args); args[1].headers['Content-Type'] = 'changed'; args[1].body.set('refresh_token', 'changed');
    const first = port.meetRequests; const second = port.meetRequests;
    let frozen = false; try { first[0].body.refresh_token = 'changed'; } catch { frozen = true; }
    need(first !== second && frozen && second[0].body.refresh_token === refresh().refreshToken
      && second[0].headers['Content-Type'] === 'application/x-www-form-urlencoded', 'MEET_DETACHED_PRIVATE_CAPTURES');
    port.assertDone();
  });
  await test('MEET_UNQUEUED_REQUEST_LATCHES_EVEN_IF_CAUGHT', async () => {
    const counters = effects(); const port = createMeetRecorder(spec, counters);
    try { await port.fetch(...request(refresh())); } catch {}
    need(counters.unexpected === 1 && counters.calendar === 0 && port.meetRequests.length === 0, 'MEET_UNEXPECTED_LATCH');
  });
  await test('MEET_DUPLICATE_REQUEST_DENIED', async () => {
    const counters = effects(); const port = createMeetRecorder(spec, counters); port.expectMeetRequests([refresh()]);
    await port.fetch(...request(refresh())); await rejection(() => port.fetch(...request(refresh())), 'MEET_RECORDING_REQUEST');
    need(counters.calendar === 1 && counters.unexpected === 1 && port.meetRequests.length === 1, 'MEET_NO_DUPLICATE_RECORD');
  });
  await test('MEET_PENDING_QUEUE_CANNOT_BE_REPLACED_OR_CLEARED', async () => {
    const counters = effects(); const port = createMeetRecorder(spec, counters); port.expectMeetRequests([code()]);
    failure(() => port.expectMeetRequests([]), 'MEET_RECORDING_QUEUE');
    failure(() => port.expectMeetRequests([refresh()]), 'MEET_RECORDING_QUEUE');
    failure(() => port.assertDone(), 'MEET_RECORDING_PENDING');
    await port.fetch(...request(code())); port.assertDone();
    need(counters.calendar === 1 && counters.unexpected === 3 && port.meetRequests[0].kind === 'code', 'MEET_PENDING_PRESERVED');
  });
  const queueInvalid = [null, {}, [null], [{}], [refresh(), ...Array(256).fill(refresh())], Array(1),
    [{ ...refresh(), extra: true }], [{ kind: 'refresh', refreshToken: '' }],
    [{ ...code(), redirectUri: 'https://unexpected.example.com/' }],
    [{ ...code(), code: 'x'.repeat(8193) }], [{ kind: 'event', payload: {} }]];
  const arrayExtra = [refresh()]; arrayExtra.extra = true; queueInvalid.push(arrayExtra);
  const arraySymbol = [refresh()]; arraySymbol[Symbol('unexpected')] = true; queueInvalid.push(arraySymbol);
  let getters = 0; const accessor = refresh(); Object.defineProperty(accessor, 'refreshToken', { get() { getters++; return 'private-sentinel'; } }); queueInvalid.push([accessor]);
  const cyclic = refresh(); cyclic.refreshToken = cyclic; queueInvalid.push([cyclic]);
  const prototype = Object.assign(Object.create({ private: 'synthetic' }), refresh()); queueInvalid.push([prototype]);
  const symbol = refresh(); symbol[Symbol('unexpected')] = true; queueInvalid.push([symbol]);
  const wrongEvent = event(); wrongEvent.payload.start.timeZone = 'UTC'; queueInvalid.push([wrongEvent]);
  const wrongAttendee = event(); wrongAttendee.payload.attendees[0].email = 'real@unexpected.invalid'; queueInvalid.push([wrongAttendee]);
  for (const [index, input] of queueInvalid.entries()) await test('MEET_QUEUE_REJECT_' + index, async () => {
    const counters = effects(); const port = createMeetRecorder(spec, counters);
    failure(() => port.expectMeetRequests(input), 'MEET_RECORDING_QUEUE');
    need(counters.unexpected === 1 && counters.calendar === 0 && port.meetRequests.length === 0, 'MEET_INVALID_QUEUE_ZERO_EFFECT');
    port.assertDone();
  });
  need(getters === 0, 'MEET_QUEUE_ACCESSORS_UNREAD');
  const malformed = [
    ['URL', args => { args[0] = 'https://unexpected.invalid/token'; }],
    ['URL_OBJECT', args => { args[0] = new URL(args[0]); }],
    ['METHOD', args => { args[1].method = 'GET'; }],
    ['EXTRA_OPTION', args => { args[1].redirect = 'follow'; }],
    ['EXTRA_HEADER', args => { args[1].headers.Cookie = 'synthetic-private-sentinel'; }],
    ['WRONG_HEADER', args => { args[1].headers['Content-Type'] = 'application/json'; }],
    ['FORM_STRING', args => { args[1].body = args[1].body.toString(); }],
    ['FORM_DUPLICATE', args => { args[1].body.append('client_id', 'duplicate'); }],
    ['FORM_EXTRA', args => { args[1].body.append('assertion', 'not-admitted'); }],
    ['FORM_WRONG_GRANT', args => { args[1].body.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer'); }],
    ['FORM_WRONG_SECRET', args => { args[1].body.set('client_secret', 'other'); }],
    ['FORM_WRONG_TOKEN', args => { args[1].body.set('refresh_token', 'other'); }],
    ['FORM_SIZE', args => { args[1].body.set('refresh_token', 'x'.repeat(8193)); }],
    ['WRONG_OPTION_PROTOTYPE', args => { args[1] = Object.assign(Object.create({ method: 'POST' }), args[1]); }],
    ['OPTION_ACCESSOR', args => { Object.defineProperty(args[1], 'method', { get() { getters++; return 'POST'; } }); }],
    ['HEADER_ACCESSOR', args => { Object.defineProperty(args[1].headers, 'Content-Type', { get() { getters++; return 'application/x-www-form-urlencoded'; } }); }],
  ];
  for (const [id, mutate] of malformed) await test('MEET_REQUEST_REJECT_' + id, async () => {
    const counters = effects(); const port = createMeetRecorder(spec, counters); port.expectMeetRequests([refresh()]);
    const args = request(refresh()); mutate(args); await rejection(() => port.fetch(...args), 'MEET_RECORDING_REQUEST');
    need(counters.calendar === 0 && counters.unexpected === 1 && port.meetRequests.length === 0, 'MEET_MALFORMED_REQUEST_NOT_CAPTURED');
  });
  for (const [id, mutate] of [
    ['EXTRA_FIELD', body => { body.unexpected = true; }],
    ['WRONG_SUMMARY', body => { body.summary = 'other'; }],
    ['WRONG_START', body => { body.start.dateTime = '2030-01-15T11:00:00'; }],
    ['WRONG_ATTENDEES', body => { body.attendees.reverse(); }],
    ['WRONG_REQUEST_ID', body => { body.conferenceData.createRequest.requestId = 'not-generated'; }],
    ['EXTRA_CONFERENCE_FIELD', body => { body.conferenceData.unexpected = true; }],
    ['EXTRA_CREATE_FIELD', body => { body.conferenceData.createRequest.unexpected = true; }],
    ['WRONG_SOLUTION', body => { body.conferenceData.createRequest.conferenceSolutionKey.type = 'other'; }],
  ]) await test('MEET_EVENT_REJECT_' + id, async () => {
    const counters = effects(); const port = createMeetRecorder(spec, counters); port.expectMeetRequests([event()]);
    const args = request(event()); const body = JSON.parse(args[1].body); mutate(body); args[1].body = JSON.stringify(body);
    await rejection(() => port.fetch(...args), 'MEET_RECORDING_REQUEST');
    need(counters.calendar === 0 && counters.unexpected === 1 && port.meetRequests.length === 0, 'MEET_EVENT_MISMATCH_LATCHED');
  });
  await test('MEET_REQUEST_ORDER_ENFORCED', async () => {
    const counters = effects(); const port = createMeetRecorder(spec, counters); port.expectMeetRequests([code(), refresh()]);
    await rejection(() => port.fetch(...request(refresh())), 'MEET_RECORDING_REQUEST');
    await port.fetch(...request(code())); await port.fetch(...request(refresh())); port.assertDone();
    need(counters.calendar === 2 && counters.unexpected === 1 && port.meetRequests.map(row => row.kind).join(',') === 'code,refresh', 'MEET_ORDER_NO_SHIFT_ON_REJECTION');
  });
  await test('MEET_EXACT_256_RECORD_BOUND', async () => {
    const counters = effects(); const port = createMeetRecorder(spec, counters); port.expectMeetRequests(Array.from({ length: 256 }, refresh));
    for (let index = 0; index < 256; index++) await port.fetch(...request(refresh())); port.assertDone();
    failure(() => port.expectMeetRequests([refresh()]), 'MEET_RECORDING_QUEUE');
    need(counters.calendar === 256 && counters.unexpected === 1 && port.meetRequests.length === 256, 'MEET_RECORD_LIMIT_CLOSED');
  });
  let nativeCalls = 0;
  function host() { return { fetch() { nativeCalls++; throw new Error('OFFLINE_NATIVE_FETCH_DENIED'); } }; }
  await test('MEET_PHASE_RESETS_RECORDS_PRESERVES_HELD_NATIVE_AND_ZERO_DELEGATION', async () => {
    const target = host(); const original = target.fetch; const descriptor = Object.getOwnPropertyDescriptor(target, 'fetch');
    const counters = effects(); const life = meetFetchLifecycle(target, spec, counters); const first = life.phase();
    first.expectMeetRequests([code()]); await target.fetch(...request(code())); first.assertDone();
    const second = life.phase(); need(first !== second && second.meetRequests.length === 0 && first.meetRequests.length === 1, 'MEET_NEW_PHASE_RECORDS');
    second.expectMeetRequests([refresh()]); await target.fetch(...request(refresh())); second.assertDone(); life.restore();
    const restored = Object.getOwnPropertyDescriptor(target, 'fetch');
    need(target.fetch === original && meetSame(Object.keys(restored), Object.keys(descriptor))
      && restored.writable === descriptor.writable && restored.enumerable === descriptor.enumerable
      && restored.configurable === descriptor.configurable && nativeCalls === 0, 'MEET_HELD_FETCH_RESTORED');
    failure(() => life.phase(), 'MEET_FETCH_CLOSED'); failure(() => life.restore(), 'MEET_FETCH_CLOSED');
  });
  await test('MEET_PENDING_PHASE_DENIES_BUT_FINAL_RESTORE_STILL_RUNS', async () => {
    const target = host(); const original = target.fetch; const counters = effects(); const life = meetFetchLifecycle(target, spec, counters);
    const first = life.phase(); first.expectMeetRequests([code()]); failure(() => life.phase(), 'MEET_RECORDING_PENDING');
    failure(() => life.restore(), 'MEET_RECORDING_PENDING'); need(target.fetch === original && nativeCalls === 0, 'MEET_PENDING_RESTORED');
  });
  await test('MEET_FETCH_DRIFT_RESTORES_ORIGINAL_AND_REJECTS', async () => {
    const target = host(); const original = target.fetch; const life = meetFetchLifecycle(target, spec, effects()); life.phase();
    target.fetch = () => {}; failure(() => life.restore(), 'MEET_FETCH_DRIFT'); need(target.fetch === original, 'MEET_DRIFT_RESTORED');
  });
  await test('MEET_PHASE_DESCRIPTOR_DRIFT_DENIED_BEFORE_REPLACEMENT', async () => {
    const target = host(); const original = target.fetch; const life = meetFetchLifecycle(target, spec, effects()); life.phase();
    Object.defineProperty(target, 'fetch', { writable: false });
    failure(() => life.phase(), 'MEET_FETCH_DRIFT'); failure(() => life.restore(), 'MEET_FETCH_DRIFT');
    need(target.fetch === original && Object.getOwnPropertyDescriptor(target, 'fetch').writable, 'MEET_PHASE_DESCRIPTOR_RESTORED');
  });
  await test('MEET_PENDING_AND_RESTORATION_DRIFT_KEEP_BOTH_PRIVATE', async () => {
    const target = host(); const original = target.fetch; const life = meetFetchLifecycle(target, spec, effects());
    life.phase().expectMeetRequests([code()]); target.fetch = () => {};
    const error = failure(() => life.restore(), 'MEET_RECORDING_PENDING');
    need(target.fetch === original && error.meetFetchRestorationFailure.fixtureCode === 'MEET_FETCH_DRIFT'
      && !Object.getOwnPropertyDescriptor(error, 'meetFetchRestorationFailure').enumerable, 'MEET_BOTH_BOUNDARY_FAILURES_RETAINED');
  });
  await test('MEET_NO_PHASE_RESTORE_IS_SAFE', async () => {
    const target = host(); const original = target.fetch; meetFetchLifecycle(target, spec, effects()).restore();
    need(target.fetch === original && nativeCalls === 0, 'MEET_NO_INSTALL_NO_DELEGATION');
  });
  for (const primary of [false, true]) for (const badHTTP of [false, true]) for (const badODM of [false, true]) for (const badRestore of [false, true])
    await test('MEET_OWNED_CLEANUP_COMPOSITION_' + [primary, badHTTP, badODM, badRestore].map(Number).join(''), async () => {
      const order = []; const initial = new Error('synthetic-private-primary'); const httpError = new Error('synthetic-private-http');
      const odmError = new Error('synthetic-private-odm'); const fetchError = new Error('synthetic-private-fetch'); let caught; let result;
      try { result = await withMeetFetchCleanup(() => withOwnedCleanup(() => { order.push('ACTION'); if (primary) throw initial; return 'done'; },
        () => { order.push('HTTP'); if (badHTTP) throw httpError; }, () => { order.push('ODM'); if (badODM) throw odmError; }),
      () => { order.push('FETCH'); if (badRestore) throw fetchError; }); } catch (error) { caught = error; }
      need(order.join(',') === 'ACTION,HTTP,ODM,FETCH', 'MEET_ALL_CLEANUP_ONCE');
      if (primary) need(caught === initial, 'MEET_FIRST_PRIMARY_PRESERVED');
      else if (badHTTP || badODM) need(caught?.fixtureCode === 'OWNED_HANDLE_CLEANUP_FAILED' && caught.cause === (badHTTP ? httpError : odmError), 'MEET_OWNED_FAILURE_PRESERVED');
      else if (badRestore) need(caught === fetchError, 'MEET_FETCH_FAILURE_TERMINAL');
      else need(result === 'done' && caught === undefined, 'MEET_SUCCESS_AFTER_ALL_CLEANUP');
      if (badRestore && (primary || badHTTP || badODM)) need(caught.meetFetchCleanupFailure === fetchError
        && !Object.getOwnPropertyDescriptor(caught, 'meetFetchCleanupFailure').enumerable, 'MEET_SECONDARY_RESTORATION_PRIVATE');
    });
  await test('MEET_FROZEN_PRIMARY_AND_PENDING_QUEUE_RETAINED', async () => {
    const target = host(); const original = target.fetch; const life = meetFetchLifecycle(target, spec, effects());
    life.phase().expectMeetRequests([code()]); const first = Object.freeze(new Error('synthetic-private-primary')); let caught;
    try { await withMeetFetchCleanup(() => { throw first; }, () => life.restore()); } catch (error) { caught = error; }
    need(caught === first && target.fetch === original && nativeCalls === 0, 'MEET_FROZEN_PRIMARY_SAFE');
  });
  for (const missing of [0, 1]) await test('MEET_CLEANUP_PORT_MANDATORY_' + missing, async () => {
    let calls = 0; const args = [() => { calls++; }, () => { calls++; }]; args[missing] = undefined;
    await rejection(() => withMeetFetchCleanup(...args), 'MEET_FETCH_CLEANUP_PORTS'); need(calls === 0, 'MEET_NO_FALLBACK_PORT');
  });
  await test('MEET_STATIC_CANARY_AND_CONFIG_IMPORT_ORDER', async () => {
    const source = fs.readFileSync(bootstrap, 'utf8');
    const canary = source.indexOf("  const [canary] = await Promise.allSettled([fetch(");
    const guard = source.indexOf('  const httpPorts = closeNetwork();');
    const env = source.indexOf('    ...ports.recordingMeet.environment });');
    const held = source.indexOf('  const meetLifecycle = meetFetchLifecycle(globalThis, ports.recordingMeet, counters);');
    const install = source.indexOf('    currentMeet = meetLifecycle.phase();', source.indexOf('  const completed = await withMeetFetchCleanup('));
    const config = source.indexOf('    const configurationEvidence = collectConfigurationEvidence(');
    need(canary >= 0 && guard > canary && env > guard && held > env && install > held && config > install, 'MEET_STATIC_PREIMPORT_ORDER');
  });
  await test('MEET_STATIC_PUBLIC_MOUNT_AND_OWNED_CLEANUP_COMPOSITION', async () => {
    const source = fs.readFileSync(bootstrap, 'utf8');
    need(source.includes("    app.use('/api/v1/meet', loader.load('@/modules/meet/routes').default);")
      && !source.includes("app.use('/api/v1/meet', authenticate")
      && source.includes('  const completed = await withMeetFetchCleanup(() => withOwnedCleanup(async () => {')
      && source.includes('  }, endPhase, () => mongoose.disconnect()), () => meetLifecycle.restore());'), 'MEET_STATIC_MOUNT_AND_CLEANUP');
  });
  need(getters === 0 && nativeCalls === 0 && applicationImports === 0 && connections === 0 && domainWrites === 0, 'MEET_PURE_BOUNDARY');
}

class FakeIndexLong {
  constructor(low, high = 0, unsigned = false) { this.low = low; this.high = high; this.unsigned = unsigned; }
  toNumber() { throw new Error('FAKE_LONG_COERCION_FORBIDDEN'); }
  toString() { throw new Error('FAKE_LONG_COERCION_FORBIDDEN'); }
  valueOf() { throw new Error('FAKE_LONG_COERCION_FORBIDDEN'); }
}
function fakeIndexCollector() {
  const selected = indexManifest(portsOriginal.models); const database = 'sd_api_' + '1'.repeat(32);
  const session = { inTransaction: () => false }; const state = { starts: 0, ends: 0, commands: [], responses: 0, clock: 0, change: undefined };
  const port = { database, collections: portsOriginal.models.map(row => row.collection), Long: FakeIndexLong,
    now: () => state.clock, signal: milliseconds => ({ milliseconds }),
    startSession(options) { need(options.causalConsistency === false && Object.keys(options).length === 1, 'FAKE_INDEX_SESSION_OPTIONS'); state.starts++; return session; },
    async endSession(value) { need(value === session, 'FAKE_INDEX_SAME_SESSION'); state.ends++; if (state.endFailure) throw state.endFailure; },
    async runCommand(collection, command, options, bits) {
      need(options.session === session && options.promoteLongs === false && options.readPreference === 'primary'
        && options.signal.milliseconds === 5000, 'FAKE_INDEX_OPTIONS');
      const ordinal = port.collections.indexOf(collection); const initial = Object.hasOwn(command, 'listIndexes');
      if (initial) need(command.listIndexes === collection && command.includeIndexBuildInfo === true
        && command.cursor.batchSize === 1 && command.maxTimeMS === 5000 && bits === null, 'FAKE_INDEX_INITIAL_COMMAND');
      else need(command.collection === collection && command.batchSize === 1 && !Object.hasOwn(command, 'maxTimeMS')
        && command.getMore === state.lastCursor && bits[0] === -2 && bits[1] === 2147483647, 'FAKE_INDEX_GETMORE_COMMAND');
      state.commands.push(initial ? 'initial' : 'more'); state.responses++;
      const explicit = selected[ordinal].indexes[0];
      const spec = initial ? { name: '_id_', key: { _id: 1 }, v: 2 }
        : explicit ? { name: 'fixture' + ordinal, key: Object.fromEntries(explicit.key), ...explicit.options }
          : { name: 'fixture-extra', key: { fixtureExtra: 1 } };
      const cursor = initial && explicit ? new FakeIndexLong(-2, 2147483647) : new FakeIndexLong(0, 0);
      state.lastCursor = cursor;
      let reply = { ok: 1, cursor: { id: cursor, ns: database + '.' + collection,
        [initial ? 'firstBatch' : 'nextBatch']: [{ spec }] } };
      if (state.change) reply = state.change(reply, { collection, ordinal, initial, command, options, bits }) ?? reply;
      state.lastCursor = reply.cursor?.id;
      if (state.commandFailure) throw state.commandFailure;
      return reply;
    },
  };
  return { port, state, session };
}
function fakeIndexTaps() {
  const state = { delegated: 0 }; const delegate = function () { state.delegated++; };
  const mongoose = { connect: delegate, createConnection: delegate, Connection: function () {},
    mongo: { MongoClient: function () {}, Db: function () {}, Collection: function () {} }, Model: function () {} };
  for (const name of ['openUri', 'useDb']) mongoose.Connection.prototype[name] = delegate;
  for (const name of ['connect', 'db']) mongoose.mongo.MongoClient.prototype[name] = delegate;
  for (const name of ['command', 'collection', 'createCollection']) mongoose.mongo.Db.prototype[name] = delegate;
  for (const name of ['find', 'aggregate', 'countDocuments', 'distinct', 'insertOne', 'insertMany', 'updateOne', 'updateMany',
    'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'createIndex', 'createIndexes', 'dropIndex', 'dropIndexes']) mongoose.mongo.Collection.prototype[name] = delegate;
  for (const name of ['create', 'insertMany', 'bulkWrite']) mongoose.Model[name] = delegate;
  function BaseQuery() {} BaseQuery.prototype.exec = delegate;
  function SubQuery() {} Object.setPrototypeOf(SubQuery.prototype, BaseQuery.prototype);
  const models = { A: { Query: BaseQuery }, B: { Query: SubQuery } };
  mongoose.modelNames = () => ['A', 'B']; mongoose.model = name => models[name];
  const network = { Socket: function () {}, Server: function () {} };
  network.Socket.prototype.connect = delegate; network.Server.prototype.listen = delegate;
  const filesystem = { promises: {} };
  for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync',
    'rm', 'rmSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync']) filesystem[name] = delegate;
  for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile']) filesystem.promises[name] = delegate;
  const globals = Object.fromEntries(['fetch', 'setTimeout', 'setInterval', 'setImmediate'].map(name => [name, delegate]));
  const logger = Object.fromEntries(['info', 'error', 'warn', 'debug'].map(name => [name, delegate]));
  const attempts = Object.fromEntries(['denied', 'connection', 'listen', 'read', 'write', 'query', 'metadata', 'jwt', 'provider', 'timer', 'import', 'loads'].map(name => [name, 0]));
  return { runtime: { mongoose, network, jwt: { sign: delegate }, axios: { defaults: { adapter: delegate } },
    substitutes: { '@/services/firebase': { getFirebaseMessaging: delegate }, '@/services/logger': { logger } },
    filesystem, globals, attempts }, state, delegate };
}
async function indexUnits() {
  const record = (id, action) => { action(); indexRows.push(id); };
  const reject = async (id, change, code) => {
    const fixture = fakeIndexCollector(); change(fixture); let error;
    try { await collectIndexObservations(fixture.port); } catch (caught) { error = caught; }
    need(error?.fixtureCode === code && fixture.state.starts === 1 && fixture.state.ends === 1
      && applicationImports === 0 && connections === 0 && domainWrites === 0, 'INDEX_FAKE_EXPECTED_FAILURE');
    indexRows.push(id);
  };
  const positive = fakeIndexCollector(); const acquired = await collectIndexObservations(positive.port);
  need(positive.state.starts === 1 && positive.state.ends === 1 && acquired.observations.length === 13
    && acquired.counts.initial === 13 && acquired.counts.continuation === 8 && acquired.counts.batches === 21
    && acquired.counts.rows === 21 && acquired.counts.active === 0 && acquired.counts.exhausted === 13,
  'INDEX_FAKE_COMPLETE_COUNTS'); indexRows.push('INDEX_FAKE_COMPLETE_13_LISTINGS_8_HIGH64_CONTINUATIONS');
  for (const [id, change, code] of [
    ['BAD_REPLY_OK', f => { f.state.change = reply => ({ ...reply, ok: 0 }); }, 'INDEX_METADATA_REPLY'],
    ['BAD_TOP_FIELD', f => { f.state.change = reply => ({ ...reply, partialResultsReturned: false }); }, 'INDEX_METADATA_REPLY'],
    ['BAD_CURSOR_FIELD', f => { f.state.change = reply => { reply.cursor.postBatchResumeToken = {}; }; }, 'INDEX_METADATA_CURSOR'],
    ['BAD_INITIAL_BATCH_KIND', f => { f.state.change = reply => { reply.cursor.nextBatch = reply.cursor.firstBatch; delete reply.cursor.firstBatch; }; }, 'INDEX_METADATA_CURSOR'],
    ['BAD_LATER_BATCH_KIND', f => { f.state.change = (reply, ctx) => { if (!ctx.initial) { reply.cursor.firstBatch = reply.cursor.nextBatch; delete reply.cursor.nextBatch; } }; }, 'INDEX_METADATA_CURSOR'],
    ['BAD_NAMESPACE_INITIAL', f => { f.state.change = reply => { reply.cursor.ns += '.other'; }; }, 'INDEX_CURSOR_NAMESPACE'],
    ['BAD_NAMESPACE_LATER', f => { f.state.change = (reply, ctx) => { if (!ctx.initial) reply.cursor.ns += '.other'; }; }, 'INDEX_CURSOR_NAMESPACE'],
    ['NUMBER_CURSOR_REFUSED', f => { f.state.change = reply => { reply.cursor.id = 0; }; }, 'INDEX_CURSOR_LONG'],
    ['DUCK_CURSOR_REFUSED', f => { f.state.change = reply => { reply.cursor.id = { low: 0, high: 0, unsigned: false }; }; }, 'INDEX_CURSOR_LONG'],
    ['UNSIGNED_CURSOR_REFUSED', f => { f.state.change = reply => { reply.cursor.id.unsigned = true; }; }, 'INDEX_CURSOR_LONG'],
    ['EXTRA_LONG_FIELD_REFUSED', f => { f.state.change = reply => { reply.cursor.id.extra = 1; }; }, 'INDEX_CURSOR_LONG'],
    ['FRACTIONAL_LONG_FIELD_REFUSED', f => { f.state.change = reply => { reply.cursor.id.low = 0.5; }; }, 'INDEX_CURSOR_LONG'],
    ['DRIFTED_NONZERO_CURSOR', f => { f.state.change = (reply, ctx) => { if (!ctx.initial) reply.cursor.id = new FakeIndexLong(-1, 2147483647); }; }, 'INDEX_CURSOR_DRIFT'],
    ['MISSING_REAL_CONTINUATION', f => { f.state.change = reply => { reply.cursor.id = new FakeIndexLong(0); }; }, 'INDEX_CONTINUATION_REQUIRED'],
    ['INFINITE_EMPTY_BATCHES_BOUNDED', f => { f.state.change = (reply, ctx) => { reply.cursor.id = new FakeIndexLong(-2, 2147483647); reply.cursor[ctx.initial ? 'firstBatch' : 'nextBatch'] = []; }; }, 'INDEX_BATCH_LIMIT'],
    ['COLLECTION_ROW_BOUND', f => { f.state.change = (reply, ctx) => { reply.cursor[ctx.initial ? 'firstBatch' : 'nextBatch'] = Array(65).fill({ spec: { name: 'fixture', key: { field: 1 } } }); }; }, 'INDEX_METADATA_BATCH'],
    ['UNADMITTED_NATIVE_METADATA', f => { f.state.change = reply => { reply.cursor.firstBatch[0].spec.future = new FakeIndexLong(0); }; }, 'INDEX_METADATA_DATA'],
    ['CONTROL_CHARACTER_ENCODED_BOUND', f => { f.state.change = reply => { reply.cursor.firstBatch[0].spec.future = '\u0000'.repeat(50000); }; }, 'INDEX_METADATA_LIMIT'],
    ['ACQUISITION_TOTAL_DEADLINE', f => { f.state.change = reply => { f.state.clock = 30001; return reply; }; }, 'INDEX_DEADLINE'],
    ['RESERVE_FIXED_5S_WITHIN_TOTAL_30S', f => { f.state.change = reply => { f.state.clock = 25001; return reply; }; }, 'INDEX_DEADLINE'],
    ['SESSION_TRANSACTION_REFUSED', f => { f.session.inTransaction = () => true; }, 'INDEX_SESSION'],
  ]) await reject('INDEX_COLLECTOR_' + id, change, code);
  {
    const f = fakeIndexCollector(); f.state.change = reply => { f.state.clock = 25000; return reply; };
    await collectIndexObservations(f.port);
    need(f.state.commands.length === 21 && f.state.ends === 1, 'INDEX_FIXED_DEADLINE_BOUNDARY');
    indexRows.push('INDEX_COLLECTOR_EXACT_25S_START_BOUNDARY');
  }
  await reject('INDEX_COLLECTOR_GLOBAL_BATCH_BOUND', f => {
    const seen = new Map();
    f.state.change = (reply, ctx) => {
      const count = (seen.get(ctx.collection) || 0) + 1; seen.set(ctx.collection, count);
      reply.cursor.id = count === 8 ? new FakeIndexLong(0) : new FakeIndexLong(-2, 2147483647);
      reply.cursor[ctx.initial ? 'firstBatch' : 'nextBatch'] = [];
    };
  }, 'INDEX_BATCH_LIMIT');
  await reject('INDEX_COLLECTOR_GLOBAL_ROW_BOUND', f => {
    f.state.change = (reply, ctx) => {
      const count = ctx.initial && portsOriginal.models[ctx.ordinal].indexes.length ? 1
        : ctx.initial ? 20 : 19;
      reply.cursor[ctx.initial ? 'firstBatch' : 'nextBatch'] = Array.from({ length: count }, (_, i) => ({ spec: { name: 'fixture' + i, key: { ['fixture' + i]: 1 } } }));
    };
  }, 'INDEX_ROW_LIMIT');
  {
    const f = fakeIndexCollector(); const cleanup = Object.freeze(new Error('private-session-cleanup')); f.state.endFailure = cleanup;
    let caught; try { await collectIndexObservations(f.port); } catch (error) { caught = error; }
    need(caught === cleanup && f.state.ends === 1 && f.state.commands.length === 21, 'INDEX_SESSION_CLEANUP_FAILURE');
    indexRows.push('INDEX_COLLECTOR_SESSION_CLEANUP_FAILURE_IS_TERMINAL');
  }
  for (const later of [false, true]) {
    const f = fakeIndexCollector(); const primary = Object.freeze(new Error('private-fake')); const secondary = new Error('private-cleanup');
    f.state.change = (reply, ctx) => { if (later === !ctx.initial) { f.state.commandFailure = primary; f.state.endFailure = secondary; } return reply; };
    let caught; try { await collectIndexObservations(f.port); } catch (error) { caught = error; }
    need(caught === primary && f.state.starts === 1 && f.state.ends === 1 && f.state.commands.length === (later ? 2 : 1), 'INDEX_FIRST_FAILURE_SESSION_CLEANUP');
    indexRows.push('INDEX_COLLECTOR_FIRST_FAILURE_' + (later ? 'LATER' : 'INITIAL'));
  }
  record('INDEX_KNOWN_LONG_SCALARS_LOSSLESS', () => {
    need(indexScalar(new FakeIndexLong(0), 'ttl', FakeIndexLong) === 0
      && indexScalar(new FakeIndexLong(2147483647), 'ttl', FakeIndexLong) === 2147483647
      && indexScalar(new FakeIndexLong(2), 'version', FakeIndexLong) === 2
      && indexScalar(new FakeIndexLong(-1, -1), 'direction', FakeIndexLong) === -1, 'INDEX_SCALAR_POSITIVE');
  });
  for (const [id, value, kind] of [
    ['TTL_HIGH_WORD', new FakeIndexLong(0, 1), 'ttl'], ['TTL_NEGATIVE_LOW', new FakeIndexLong(-1), 'ttl'],
    ['VERSION_OUTSIDE', new FakeIndexLong(3), 'version'], ['DIRECTION_ZERO', new FakeIndexLong(0), 'direction'],
    ['UNSIGNED', new FakeIndexLong(0, 0, true), 'ttl'], ['INFINITE', Infinity, 'ttl'],
  ]) record('INDEX_SCALAR_REFUSAL_' + id, () => {
    let rejected = false; try { indexScalar(value, kind, FakeIndexLong); } catch { rejected = true; } need(rejected, 'INDEX_SCALAR_REFUSAL');
  });
  record('INDEX_MARKER_OPAQUE_IDENTITY_AND_ORDER', () => {
    let invokes = 0; const marker = Object.create(null);
    Object.defineProperty(marker, 'toJSON', { get() { invokes++; throw new Error('private'); } });
    const raw = { spec: { name: 'fixture', key: { userId: new FakeIndexLong(1), transactionType: 1 },
      expireAfterSeconds: new FakeIndexLong(0), v: new FakeIndexLong(2), buildUUID: marker }, indexBuildInfo: marker };
    const projected = projectIndexRow(raw, FakeIndexLong);
    need(projected.spec.key[0][0] === 'userId' && projected.spec.key[1][0] === 'transactionType'
      && projected.spec.expireAfterSeconds === 0 && projected.spec.v === 2 && projected.spec.buildUUID === marker
      && projected.indexBuildInfo === marker && invokes === 0, 'INDEX_OPAQUE_DATA');
  });
  record('INDEX_CURSOR_ACCESSOR_NEVER_INVOKED', () => {
    let invoked = 0; const value = new FakeIndexLong(0);
    Object.defineProperty(value, 'low', { get() { invoked++; return 0; } });
    let rejected = false; try { indexLongWords(value, FakeIndexLong); } catch { rejected = true; }
    need(rejected && invoked === 0, 'INDEX_LONG_ACCESSOR');
  });
  for (const [category, select] of [
    ['connection', r => [r.mongoose, 'connect']], ['listen', r => [r.network.Server.prototype, 'listen']],
    ['metadata', r => [r.mongoose.mongo.Db.prototype, 'command']], ['read', r => [r.mongoose.mongo.Collection.prototype, 'find']],
    ['write', r => [r.mongoose.Model, 'create']], ['query', r => [r.mongoose.model('B').Query.prototype, 'exec']],
    ['jwt', r => [r.jwt, 'sign']], ['provider', r => [r.substitutes['@/services/firebase'], 'getFirebaseMessaging']],
    ['timer', r => [r.globals, 'setTimeout']],
  ]) record('INDEX_DENIAL_TAP_' + category.toUpperCase(), () => {
    const f = fakeIndexTaps(); const [target, name] = select(f.runtime); const original = target[name]; let caught;
    try { withIndexTaps(f.runtime, () => target[name]()); } catch (error) { caught = error; }
    need(caught?.fixtureCode === 'INDEX_OPERATION_ATTEMPT' && f.runtime.attempts.denied === 1
      && f.runtime.attempts[category] === 1 && f.state.delegated === 0 && target[name] === original
      && !Object.hasOwn(f.runtime.mongoose.model('B').Query.prototype, 'exec'), 'INDEX_DENIAL_TAP_PROOF');
  });
  record('INDEX_TAPS_RESTORE_AFTER_PRIMARY_AND_DESCRIPTOR_DRIFT', () => {
    const f = fakeIndexTaps(); const primary = Object.freeze(new Error('private-primary')); let caught;
    try { withIndexTaps(f.runtime, () => { f.runtime.globals.fetch = function drifted() {}; throw primary; }); }
    catch (error) { caught = error; }
    need(caught === primary && f.runtime.globals.fetch === f.delegate && f.runtime.mongoose.connect === f.delegate
      && f.runtime.filesystem.promises.writeFile === f.delegate && f.state.delegated === 0, 'INDEX_TAPS_PRIMARY_RESTORATION');
  });
  record('INDEX_TAPS_REQUIRE_ALL_PATHS_BEFORE_INSTALL', () => {
    const f = fakeIndexTaps(); delete f.runtime.globals.setImmediate; let caught;
    try { withIndexTaps(f.runtime, () => { throw new Error('MUST_NOT_RUN'); }); } catch (error) { caught = error; }
    need(caught?.fixtureCode === 'INDEX_TAP_MISSING' && f.runtime.mongoose.connect === f.delegate
      && f.state.delegated === 0, 'INDEX_TAPS_EARLY_DENIAL');
  });
  for (const nested of [false, true]) record('INDEX_HELPER_ONLY_CACHE_LIFECYCLE_' + (nested ? 'NESTED_IMPORT_DENIED' : 'FRESH_RESTORED'), () => {
    const heldLoad = Module._load; const heldResolve = Module._resolveFilename;
    const packet = fixture(); const state = { loads: 0 }; let scope; let caught;
    const attempts = { import: 0, loads: 0 }; const parents = new Map();
    Module._load = function (request, parent, isMain) {
      if (request !== '@/modules/common/utils/indexReadiness') return heldLoad.call(this, request, parent, isMain);
      state.loads++;
      if (nested) Module._load('node:fs', parent, false);
      const filename = Module._resolveFilename(request, parent);
      if (!parents.has(parent)) parents.set(parent, { array: parent.children, values: parent.children.slice() });
      const exports = { evaluateIndexReadiness() { throw new Error('FAKE_HELPER_MUST_NOT_EXECUTE'); } };
      Object.defineProperty(exports, '__esModule', { value: true });
      const entry = { filename, exports }; require.cache[filename] = entry; parent.children.push(entry); return exports;
    };
    try {
      const loader = installLoader(packet.manifest, packet.plan, packet.ports); scope = loader.indexScope(attempts);
      if (nested) {
        try { scope.load(null); } catch (error) { caught = error; }
        need(caught?.fixtureCode === 'INDEX_NESTED_IMPORT' && attempts.import === 1 && attempts.loads === 0, 'INDEX_NESTED_IMPORT_PROOF');
      } else {
        const first = scope.load(null); const second = scope.load('INDEX_KEY_ORDER_IGNORED'); const third = scope.load(null);
        need(typeof first === 'function' && typeof second === 'function' && typeof third === 'function'
          && first !== third && attempts.loads === 3 && state.loads === 3 && attempts.import === 0, 'INDEX_FRESH_LOAD_PROOF');
      }
      scope.restore(); scope = undefined;
      need(Object.keys(require.cache).every(name => !name.startsWith('/workspace/compiled/'))
        && [...parents].every(([parent, held]) => parent.children === held.array
          && parent.children.length === held.values.length && parent.children.every((entry, i) => entry === held.values[i])), 'INDEX_CACHE_CHILDREN_PROOF');
    } finally {
      try { if (scope) scope.restore(); } finally { Module._load = heldLoad; Module._resolveFilename = heldResolve; }
    }
  });
  function commandFixture() {
    const database = 'sd_api_' + '1'.repeat(32); const db = { databaseName: database }; const client = {};
    const session = { inTransaction: () => false }; const telemetry = { metadata: 0, forbidden: 0 };
    const state = { calls: 0, db, client, session, ended: false, pending: null, change: undefined, last: null };
    const api = createIndexCommandPort({ db, client, database, Long: FakeIndexLong, telemetry,
      getDb: () => state.db, getClient: () => state.client, getSession: () => state.session, sessionOpen: () => !state.ended,
      setPending(value) { state.pending = value; if (value === null && state.cleanupFailure) throw state.cleanupFailure; },
      async runRaw(command, options) {
        state.calls++; telemetry.metadata++;
        const initial = Object.hasOwn(command, 'listIndexes'); const collection = command.listIndexes || command.collection;
        const ordinal = portsOriginal.models.findIndex(row => row.collection === collection);
        const cursor = initial && portsOriginal.models[ordinal].indexes.length ? new FakeIndexLong(-2, 2147483647) : new FakeIndexLong(0);
        const reply = { ok: 1, cursor: { id: cursor, ns: database + '.' + collection,
          [initial ? 'firstBatch' : 'nextBatch']: [] } };
        state.last = cursor;
        if (state.change) state.change(reply, { command, options, initial });
        if (state.rawFailure) throw state.rawFailure;
        return reply;
      },
    });
    const options = () => ({ promoteLongs: false, readPreference: 'primary', session, signal: new AbortController().signal });
    const initial = collection => api.run(collection, { listIndexes: collection, includeIndexBuildInfo: true,
      cursor: { batchSize: 1 }, maxTimeMS: 5000 }, options(), null);
    const more = (collection, cursor = state.last, bits = [-2, 2147483647]) => api.run(collection,
      { getMore: cursor, collection, batchSize: 1 }, options(), bits);
    return { api, state, initial, more, options };
  }
  {
    const f = commandFixture();
    for (const row of portsOriginal.models) { await f.initial(row.collection); if (row.indexes.length) await f.more(row.collection); }
    f.api.assertComplete(); need(f.state.calls === 21 && f.state.pending === null, 'INDEX_COMMAND_POSITIVE');
    indexRows.push('INDEX_COMMAND_INDEPENDENT_13_COLLECTION_21_COMMAND_STATE');
  }
  async function portRejected(id, action, code, expectedCalls) {
    const f = commandFixture(); let caught;
    try { await action(f); } catch (error) { caught = error; }
    need(caught?.fixtureCode === code && f.state.calls === expectedCalls && f.state.pending === null, 'INDEX_COMMAND_EXPECTED_REFUSAL');
    let retry; try { await f.initial('users'); } catch (error) { retry = error; }
    need(retry?.fixtureCode === 'INDEX_COMMAND_STATE' && f.state.calls === expectedCalls, 'INDEX_COMMAND_NO_RETRY');
    indexRows.push(id);
  }
  await portRejected('INDEX_COMMAND_FOREIGN_COLLECTION_BEFORE_IO', f => f.initial('admins'), 'INDEX_COMMAND_STATE', 0);
  await portRejected('INDEX_COMMAND_IDENTICAL_BITS_REPLACEMENT_ID_REFUSED', async f => {
    await f.initial('users'); await f.more('users', new FakeIndexLong(-2, 2147483647));
  }, 'INDEX_COMMAND_CURSOR', 1);
  await portRejected('INDEX_COMMAND_FORGED_CURSOR_AND_SUPPLIED_BITS_REFUSED', async f => {
    await f.initial('users'); await f.more('users', new FakeIndexLong(7, 9), [7, 9]);
  }, 'INDEX_COMMAND_CURSOR', 1);
  await portRejected('INDEX_COMMAND_CROSS_COLLECTION_BEFORE_EXHAUSTION', async f => {
    await f.initial('users'); await f.more('admins');
  }, 'INDEX_COMMAND_STATE', 1);
  await portRejected('INDEX_COMMAND_REPEATED_INITIAL_BEFORE_EXHAUSTION', async f => {
    await f.initial('users'); await f.initial('users');
  }, 'INDEX_COMMAND_PORT', 1);
  for (const [id, mutate, code] of [
    ['NAMESPACE', reply => { reply.cursor.ns += '.foreign'; }, 'INDEX_COMMAND_NAMESPACE'],
    ['UNKNOWN_REPLY_FIELD', reply => { reply.partialResultsReturned = false; }, 'INDEX_COMMAND_REPLY'],
    ['UNKNOWN_CURSOR_FIELD', reply => { reply.cursor.postBatchResumeToken = {}; }, 'INDEX_COMMAND_REPLY'],
    ['WRONG_BATCH_KIND', reply => { reply.cursor.nextBatch = []; delete reply.cursor.firstBatch; }, 'INDEX_COMMAND_REPLY'],
    ['CURSOR_NUMBER', reply => { reply.cursor.id = 0; }, 'INDEX_CURSOR_LONG'],
  ]) await portRejected('INDEX_COMMAND_RESPONSE_' + id, async f => { f.state.change = mutate; await f.initial('users'); }, code, 1);
  await portRejected('INDEX_COMMAND_RESPONSE_ORIGIN_DRIFT', async f => {
    await f.initial('users'); f.state.change = reply => { reply.cursor.id = new FakeIndexLong(1, 2); }; await f.more('users');
  }, 'INDEX_COMMAND_CURSOR', 2);
  for (const key of ['db', 'client', 'session']) await portRejected('INDEX_COMMAND_POST_RESPONSE_' + key.toUpperCase() + '_IDENTITY', async f => {
    f.state.change = () => { f.state[key] = {}; }; await f.initial('users');
  }, 'INDEX_COMMAND_HANDLES', 1);
  await portRejected('INDEX_COMMAND_POST_RESPONSE_SESSION_CLOSED', async f => {
    f.state.change = () => { f.state.ended = true; }; await f.initial('users');
  }, 'INDEX_COMMAND_HANDLES', 1);
  {
    const f = commandFixture(); const primary = Object.freeze(new Error('private-raw-failure'));
    f.state.rawFailure = primary; f.state.cleanupFailure = new Error('private-pending-cleanup'); let caught;
    try { await f.initial('users'); } catch (error) { caught = error; }
    need(caught === primary && f.state.calls === 1 && f.state.pending === null, 'INDEX_COMMAND_FIRST_FAILURE');
    indexRows.push('INDEX_COMMAND_FIRST_FAILURE_RETAINS_RAW_AND_ATTEMPTS_PENDING_RESTORE');
  }
}

// The loader and sentinels below run only against inert public metadata and hard
// fake native ports. No fixture business source or native child module is loaded.
async function profileUnits() {
  async function record(id, action) { activeProfileCase = id; await action(); profileRows.push(id); activeProfileCase = null; }
  function fixedFailure(action, code) {
    let caught; try { action(); } catch (error) { caught = error; }
    need(caught?.fixtureCode === code && caught.message === code, 'PROFILE_EXPECTED_FAILURE'); return caught;
  }
  function freshBoundary() {
    const packet = fixture(); const effects = { excluded: 0, unexpected: 0, logger: 0 };
    const admission = profileAdmission(packet.manifest, packet.plan, packet.ports);
    return { packet, effects, admission, boundary: createProfileBoundary(admission, effects) };
  }
  await record('PROFILE_BOUNDED_INDEX_CASE_AND_VARIANT_PREFIX', () => {
    need(INDEX_CASE_IDS.length === 7 && INDEX_MUTANT_IDS.length === 6 && Object.isFrozen(INDEX_CASE_IDS) && Object.isFrozen(INDEX_MUTANT_IDS)
      && JSON.stringify(INDEX_CASE_IDS) === JSON.stringify(portsOriginal.requiredCaseIds.slice(76, 83))
      && JSON.stringify(INDEX_MUTANT_IDS) === JSON.stringify(portsOriginal.requiredSensitivityIds.slice(21, 27)), 'PROFILE_INDEX_PREFIX');
  });
  await record('PROFILE_CLOSED_DEEP_FROZEN_INDEPENDENT_POLICY', () => {
    const p = fixture(); const policy = profilePolicy(p.ports);
    need(sha(Buffer.from(JSON.stringify(policy))) === PROFILE_POLICY_SHA
      && Object.isFrozen(policy) && Object.isFrozen(policy.trials) && Object.isFrozen(policy.trials[0].expected.readOpsDelta), 'PROFILE_POLICY_FROZEN');
    p.ports.specialistProfile.trials[0].expected.status = 201;
    need(policy.trials[0].expected.status === 200, 'PROFILE_POLICY_INDEPENDENT');
  });
  for (const row of PROFILE_STATIC_INPUTS) await record('PROFILE_STATIC_INVALID_DIGEST_' + row.compiled, () => {
    const p = fixture(); p.manifest.files[row.compiled] = 'not-a-digest';
    fixedFailure(() => profileAdmission(p.manifest, p.plan, p.ports), 'SPECIALIST_PROFILE_STATIC_BINDING');
  });
  for (const name of ['BookingRepository', 'BookingService', 'SlotRepository', 'SlotService']) {
    const methods = Object.values(portsOriginal.specialistProfile.throwingClasses).find(row => row.export === name).methods;
    for (const method of methods) await record('PROFILE_CLASS_THROW_' + name + '_' + method, () => {
      const f = freshBoundary(); const registrations = [];
      const classes = f.boundary.classes({ Service: () => constructor => registrations.push(constructor) });
      need(registrations.length === 4 && registrations.every(constructor => constructor.name.length > 0), 'PROFILE_CLASS_REGISTRATIONS');
      const alias = Object.keys(classes).find(key => classes[key][name]); const instance = new classes[alias][name]();
      need(instance.constructor === classes[alias][name] && f.effects.excluded === 0 && f.effects.unexpected === 0, 'PROFILE_CONSTRUCTORS_INERT');
      fixedFailure(() => instance[method](), 'SPECIALIST_PROFILE_CAPABILITY_EXCLUDED');
      need(f.boundary.attempts[name] === 1 && f.effects.excluded === 1 && f.effects.unexpected === 1, 'PROFILE_METHOD_LATCH');
    });
    for (const unknown of ['unknownBusinessMethod', 'toString', 'then']) await record('PROFILE_CLASS_UNKNOWN_' + name + '_' + unknown, () => {
      const f = freshBoundary(); const classes = f.boundary.classes({ Service: () => () => {} });
      const alias = Object.keys(classes).find(key => classes[key][name]); const instance = new classes[alias][name]();
      fixedFailure(() => instance[unknown], 'SPECIALIST_PROFILE_CAPABILITY_EXCLUDED');
      need(f.boundary.attempts[name] === 1 && f.effects.excluded === 1 && f.effects.unexpected === 1, 'PROFILE_UNKNOWN_LATCH');
    });
    await record('PROFILE_CAUGHT_REGISTRATION_CONSTRUCTOR_EFFECT_' + name, () => {
      const f = freshBoundary();
      fixedFailure(() => f.boundary.classes({ Service: () => constructor => {
        if (constructor.name === name) try { new constructor()[methods[0]](); } catch {}
      } }), 'SPECIALIST_PROFILE_REGISTRATION_EFFECT');
      need(f.boundary.attempts[name] === 1 && f.effects.excluded === 1 && f.effects.unexpected === 1, 'PROFILE_CAUGHT_CONSTRUCTOR_EFFECT_LATCH');
    });
  }
  for (const extra of ['logger', 'unexpected']) await record('PROFILE_REGISTRATION_OTHER_EFFECT_' + extra, () => {
    const f = freshBoundary();
    fixedFailure(() => f.boundary.classes({ Service: () => () => { f.effects[extra]++; } }), 'SPECIALIST_PROFILE_REGISTRATION_EFFECT');
  });
  // These fake natives cannot resolve or execute any domain/native capability.
  function withLoader(action) {
    const f = freshBoundary(); const heldLoad = Module._load; const heldResolve = Module._resolveFilename;
    const state = { loads: 0, resolves: 0, relativeTarget: '/workspace/compiled/entry.js' };
    const native = Object.freeze({ inertNative: true });
    Module._load = function () { state.loads++; return native; };
    Module._resolveFilename = function (request) { state.resolves++; return path.isAbsolute(request) ? request : state.relativeTarget; };
    try {
      const loader = installLoader(f.packet.manifest, f.packet.plan, f.packet.ports, f.effects);
      return action({ ...f, loader, state, native });
    } finally { Module._load = heldLoad; Module._resolveFilename = heldResolve; }
  }
  for (const parent of portsOriginal.specialistProfile.parentScopedBuiltinCuts.mutantParents
    .concat(portsOriginal.specialistProfile.parentScopedBuiltinCuts.nominalParent)) {
    for (const alias of ['fs', 'node:fs', 'child_process', 'node:child_process']) await record('PROFILE_PARENT_CUT_' + parent + '_' + alias, () => withLoader(f => {
      const owner = { filename: '/workspace/' + parent };
      const exported = Module._load(alias, owner, false);
      const resolved = Module._resolveFilename(alias, owner, false);
      const expectedKeys = alias.endsWith('fs') ? ['mkdirSync', 'writeFileSync', 'unlinkSync'] : ['execFile'];
      need(JSON.stringify(Object.keys(exported)) === JSON.stringify(expectedKeys)
        && resolved === 'fixture:profile:' + alias.replace(/^node:/, '')
        && f.state.loads === 0 && f.state.resolves === 0
        && Object.values(f.loader.profileAttempts).every(value => value === 0), 'PROFILE_INTERCEPT_BEFORE_NATIVE');
    }));
  }
  for (const sibling of [undefined, { filename: '/workspace/compiled/modules/specialists/services/index.js' },
    { filename: '/workspace/compiled/modules/specialistPortal/services/index.js.other' }]) {
    for (const alias of ['child_process', 'node:child_process']) await record('PROFILE_CHILD_OUTSIDE_DENIED_' + String(sibling?.filename) + alias, () => withLoader(f => {
      fixedFailure(() => Module._load(alias, sibling, false), 'DENIED_BUILTIN');
      fixedFailure(() => Module._resolveFilename(alias, sibling, false), 'DENIED_BUILTIN');
      need(f.state.loads === 0 && f.state.resolves === 0, 'PROFILE_OUTSIDE_CHILD_NEVER_NATIVE');
    }));
    for (const alias of ['fs', 'node:fs']) await record('PROFILE_FS_OUTSIDE_UNCHANGED_' + String(sibling?.filename) + alias, () => withLoader(f => {
      need(Module._load(alias, sibling, false) === f.native && f.state.loads === 1, 'PROFILE_FS_ONLY_PARENT_SCOPED');
    }));
  }
  for (const alias of ['child_process', 'node:child_process']) await record('PROFILE_PROMISIFY_CONSTRUCTION_AND_CAUGHT_CALL_' + alias, async () => {
    const f = freshBoundary(); const owner = { filename: '/workspace/' + f.admission.parents[0] };
    const exec = f.boundary.builtin(alias, owner).execFile; const asyncExec = promisify(exec);
    need(Object.values(f.boundary.attempts).every(value => value === 0), 'PROFILE_PROMISIFY_CONSTRUCTION_INERT');
    let caught; try { await asyncExec('unadmitted', []); } catch (error) { caught = error; }
    need(caught?.fixtureCode === 'SPECIALIST_PROFILE_CAPABILITY_EXCLUDED'
      && f.boundary.attempts.execFile === 1 && f.effects.excluded === 1 && f.effects.unexpected === 1, 'PROFILE_PROMISIFY_CALL_LATCH');
  });
  for (const method of ['mkdirSync', 'writeFileSync', 'unlinkSync']) await record('PROFILE_FS_THROW_' + method, () => {
    const f = freshBoundary(); const stub = f.boundary.builtin('node:fs', { filename: '/workspace/' + f.admission.parents[0] });
    need(stub.__esModule === undefined, 'PROFILE_FS_DEFAULT_IMPORT_SHAPE');
    const wrapped = stub.__esModule ? stub : { default: stub };
    fixedFailure(() => wrapped.default[method]('unadmitted'), 'SPECIALIST_PROFILE_CAPABILITY_EXCLUDED');
    need(f.boundary.attempts[method] === 1 && f.effects.excluded === 1 && f.effects.unexpected === 1, 'PROFILE_FS_METHOD_LATCH');
  });
  for (const [alias, unknown] of [['fs', 'readFileSync'], ['child_process', 'spawn']]) await record('PROFILE_BUILTIN_UNKNOWN_' + unknown, () => {
    const f = freshBoundary(); const stub = f.boundary.builtin(alias, { filename: '/workspace/' + f.admission.parents[0] });
    fixedFailure(() => stub[unknown], 'SPECIALIST_PROFILE_CAPABILITY_EXCLUDED');
    need(f.effects.excluded === 1 && f.effects.unexpected === 1, 'PROFILE_BUILTIN_UNKNOWN_LATCH');
  });
  for (const row of PROFILE_STATIC_INPUTS) {
    const alias = '@/' + row.source.slice(5, -3).replace(/\/index$/, '');
    for (const request of [alias, alias + '/index', '/workspace/' + row.compiled, './unadmitted-static'])
      await record('PROFILE_STATIC_DENIED_' + row.compiled + request, () => withLoader(f => {
        f.state.relativeTarget = '/workspace/' + row.compiled;
        fixedFailure(() => Module._load(request, { filename: '/workspace/bootstrap.cjs' }, false), 'SPECIALIST_PROFILE_STATIC_ONLY');
        fixedFailure(() => Module._resolveFilename(request, { filename: '/workspace/bootstrap.cjs' }, false), 'SPECIALIST_PROFILE_STATIC_ONLY');
        need(f.state.loads === 0, 'PROFILE_STATIC_NEVER_EVALUATED');
      }));
  }
  await record('PROFILE_PHASE_FRESH_CLASSES_AND_LIFETIME_ATTEMPT_SNAPSHOT', () => withLoader(f => {
    const first = f.loader.profileClasses({ Service: () => () => {} }); f.loader.phase(first);
    const alias = '@/modules/bookings/repository'; const Constructor = first[alias].BookingRepository;
    need(Module._load(alias, { filename: '/workspace/compiled/domain.js' }, false) === first[alias], 'PROFILE_EXCLUDED_CLASS_SUBSTITUTE');
    fixedFailure(() => new Constructor().findById('synthetic'), 'SPECIALIST_PROFILE_CAPABILITY_EXCLUDED');
    const before = f.loader.profileAttempts;
    const second = f.loader.profileClasses({ Service: () => () => {} }); f.loader.phase(second, {});
    const after = f.loader.profileAttempts;
    need(second[alias].BookingRepository !== Constructor && before !== after && Object.isFrozen(before) && Object.isFrozen(after)
      && before.BookingRepository === 1 && after.BookingRepository === 1
      && Object.keys(after).length === 8 && f.effects.excluded === 1 && f.effects.unexpected === 1, 'PROFILE_LIFETIME_NOT_RESET');
  }));
  for (const changed of ['fs', 'node:child_process', '@/modules/bookings/model', '@/modules/bookings/repository/index'])
    await record('PROFILE_PHASE_REJECTS_UNDECLARED_SUBSTITUTE_' + changed, () => withLoader(f => {
      const classes = f.loader.profileClasses({ Service: () => () => {} });
      fixedFailure(() => f.loader.phase({ ...classes, [changed]: {} }), 'SPECIALIST_PROFILE_PHASE_BINDING');
      need(f.state.loads === 0 && f.state.resolves === 0, 'PROFILE_PHASE_EARLY_DENIAL');
    }));
  for (const alias of ['@/modules/bookings/model', '@/modules/bookings/repository', '@/modules/slots/model', '@/modules/slots/repository/index'])
    await record('PROFILE_PHASE_REJECTS_STATIC_OVERRIDE_' + alias, () => withLoader(f => {
      const classes = f.loader.profileClasses({ Service: () => () => {} });
      fixedFailure(() => f.loader.phase(classes, { [alias]: 'compiled/entry.js' }), 'SPECIALIST_PROFILE_PHASE_BINDING');
    }));
  await record('PROFILE_PHASE_HOLDS_INDEPENDENT_SUBSTITUTE_AND_OVERRIDE_MAPS', () => withLoader(f => {
    const classes = f.loader.profileClasses({ Service: () => () => {} }); const supplied = { ...classes }; const overrides = {};
    f.loader.phase(supplied, overrides); supplied['@/modules/bookings/repository'] = {}; overrides['@/modules/bookings/model'] = 'compiled/entry.js';
    need(Module._load('@/modules/bookings/repository', {}, false) === classes['@/modules/bookings/repository'], 'PROFILE_SUBSTITUTE_SNAPSHOT');
    fixedFailure(() => Module._load('@/modules/bookings/model', {}, false), 'SPECIALIST_PROFILE_STATIC_ONLY');
  }));
  await record('PROFILE_RESET_COMPILED_CACHE_PRESERVES_MODELS_AND_NON_DOMAIN', () => withLoader(f => {
    const fakeModule = '/workspace/compiled/profile-fake.js'; const fakeModel = '/workspace/compiled/modules/fake/model/index.js';
    const moduleEntry = {}; const modelEntry = {}; const held = new Map(Object.entries(require.cache));
    try {
      require.cache[fakeModule] = moduleEntry; require.cache[fakeModel] = modelEntry; f.loader.resetCompiled();
      need(!Object.hasOwn(require.cache, fakeModule) && require.cache[fakeModel] === modelEntry
        && [...held].every(([filename, entry]) => require.cache[filename] === entry), 'PROFILE_CACHE_SCOPE');
    } finally { delete require.cache[fakeModule]; delete require.cache[fakeModel]; }
  }));
  need(applicationImports === 0 && connections === 0 && domainWrites === 0 && nativeChildLoads === 0, 'PROFILE_OFFLINE_EFFECTS');
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
  need(applicationImports === 0 && connections === 0 && domainWrites === 0 && nativeChildLoads === 0, 'OFFLINE_EFFECTS');
  output(JSON.stringify({ schema: 'SD-AUTH-API-OFFLINE-1', cases: rows.length + cases.length + recordingRows.length + configurationRows.length + meetRows.length + indexRows.length + profileRows.length, recordingCases: recordingRows.length,
    profileBoundaryCases: profileRows.length, nativeChildLoads,
    indexCollectorCases: indexRows.length,
    meetRecorderCases: meetRows.length,
    configurationControllerCases: configurationRows.length,
    admissionCases: rows.length, setupDiagnosticCases: diagnosticCount, ownedCleanupCases: cases.length - diagnosticCount, failed: 0,
    applicationImports, connections, domainWrites, processGrants: 'DENIED' }) + '\n');
}
recordingUnits();
configurationUnits();
profileUnits().then(meetUnits).then(indexUnits).then(setupUnits).catch(() => {
  output(JSON.stringify({ schema: 'SD-AUTH-API-OFFLINE-1', failed: 1, code: 'OFFLINE_SETUP_UNIT_FAILED', profileCase: activeProfileCase }) + '\n');
  process.exitCode = 1;
});
