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
const { validateAdmissionData } = require(bootstrap);
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
need(applicationImports === 0 && connections === 0 && domainWrites === 0, 'OFFLINE_EFFECTS');
output(JSON.stringify({ schema: 'SD-AUTH-API-OFFLINE-1', cases: rows.length, failed: 0,
  applicationImports, connections, domainWrites, processGrants: 'DENIED' }) + '\n');
