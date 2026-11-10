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
if (portsOriginal.models.length !== 12 || !portsOriginal.models.some(row => row.name === 'WellnessPackage'
  && row.collection === 'wellnesspackages' && row.source === 'src1/modules/wellnessPackages/model/index.ts'
  && Array.isArray(row.indexes) && row.indexes.length === 0)) throw new Error('OFFLINE_WELLNESS_MAP');
const bootstrap = path.join(__dirname, 'bootstrap.cjs');
let applicationImports = 0; let connections = 0; let domainWrites = 0;
const blockedWrite = () => { domainWrites++; throw new Error('OFFLINE_WRITE_DENIED'); };
for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream',
  'mkdir', 'mkdirSync', 'rm', 'rmSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync']) fs[name] = blockedWrite;
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile']) fs.promises[name] = blockedWrite;
const blockedNetwork = () => { connections++; throw new Error('OFFLINE_NETWORK_DENIED'); };
net.Socket.prototype.connect = blockedNetwork; net.connect = blockedNetwork;
net.createConnection = blockedNetwork; tls.connect = blockedNetwork; dns.lookup = blockedNetwork;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request !== bootstrap && !Module.isBuiltin(request)) { applicationImports++; throw new Error('OFFLINE_DOMAIN_IMPORT_DENIED'); }
  return originalLoad.call(this, request, parent, isMain);
};
const { validateAdmissionData, runSetupStep, SETUP_FAILURE_CODES, withOwnedCleanup } = require(bootstrap);
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
  const mutants = Object.fromEntries(ports.requiredSensitivityIds.map(name => {
    const file = 'compiled/mutants/' + name + '.js'; files[file] = Buffer.from('inert');
    return [name, { source: 'src1/modules/otp/repository/index.ts', originalSha256: 'a'.repeat(64), file }];
  }));
  const plan = { schema: 'SD-AUTH-API-PLAN-1', role: ports.role, sourceCommit, sourceFiles: sources,
    compilation: { compiler: '5.9.3', status: 'TRANSPILE_ONLY_NOT_TYPECHECKED' },
    modules: Object.fromEntries(ports.roots.map(root => [root, 'compiled/entry.js'])), mutants,
    models: ports.models, requiredCaseIds: ports.requiredCaseIds, requiredSensitivityIds: ports.requiredSensitivityIds,
    providerCounterKeys: ports.providerCounterKeys };
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
check('OMITTED_WELLNESS_PACKAGE', p => { p.ports.models.pop(); }, true);
check('PORT_PLAN_MISMATCH', p => { p.plan.portsSha = 'e'.repeat(64); });
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
  output(JSON.stringify({ schema: 'SD-AUTH-API-OFFLINE-1', cases: rows.length + cases.length,
    admissionCases: rows.length, setupDiagnosticCases: diagnosticCount, ownedCleanupCases: cases.length - diagnosticCount, failed: 0,
    applicationImports, connections, domainWrites, processGrants: 'DENIED' }) + '\n');
}
setupUnits().catch(() => {
  output(JSON.stringify({ schema: 'SD-AUTH-API-OFFLINE-1', failed: 1, code: 'OFFLINE_SETUP_UNIT_FAILED' }) + '\n');
  process.exitCode = 1;
});
