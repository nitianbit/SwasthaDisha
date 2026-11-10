'use strict';
// Executes only the pure fixture evidence parser. No runScenario, app/package
// import, socket, file write, child, worker, addon or operational configuration.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const output = process.stdout.write.bind(process.stdout);
const fixtureFile = path.resolve(__dirname, '../../../test/api-runtime/scenario/scenario.cjs');
let appImports = 0; let connections = 0; let writes = 0; let assertions = 0; let getters = 0;
const deniedWrite = () => { writes++; throw new Error('PURE_WRITE_DENIED'); };
for (const key of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync',
  'rm', 'rmSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync']) fs[key] = deniedWrite;
for (const key of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile']) fs.promises[key] = deniedWrite;
const deniedSocket = () => { connections++; throw new Error('PURE_SOCKET_DENIED'); };
net.Socket.prototype.connect = deniedSocket; net.Server.prototype.listen = deniedSocket;
net.connect = deniedSocket; net.createConnection = deniedSocket; tls.connect = deniedSocket; dns.lookup = deniedSocket;
const load = Module._load;
const deniedBuiltins = new Set(['child_process', 'worker_threads', 'vm', 'inspector', 'repl', 'module']);
Module._load = function (name, parent, isMain) {
  if (name !== fixtureFile && (!Module.isBuiltin(name) || deniedBuiltins.has(name.replace(/^node:/, '')))) {
    appImports++; throw new Error('PURE_APP_IMPORT_DENIED');
  }
  return load.call(this, name, parent, isMain);
};
const { requireConfigurationEvidence } = require(fixtureFile);
function need(ok, code) { if (!ok) { const error = new Error(code); error.fixtureCode = code; throw error; } }
need(process.permission && !process.permission.has('child') && !process.permission.has('worker')
  && !process.permission.has('addon') && !process.permission.has('fs.write'), 'PURE_PROCESS_GRANTS');
const ids = ['JWT_CONFIG_UNSET_DENIED', 'JWT_CONFIG_BLANK_DENIED', 'JWT_CONFIG_PLACEHOLDERS_DENIED',
  'JWT_CONFIG_VALID_VALUE', 'JWT_CONFIG_PADDED_VALUE_UNCHANGED', 'JWT_CONFIG_NONPLACEHOLDER_VALUES'];
const mutations = ['JWT_CONFIG_PUBLISHED_FALLBACK', 'JWT_CONFIG_PRODUCTION_ONLY_GUARD', 'JWT_CONFIG_TRIMMED_RETURN'];
const fresh = () => ({ cases: ids.map(id => ({ id, status: 'PASS' })), sensitivity: mutations.map(id => ({ id, detected: true })) });
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (Object.hasOwn(descriptor, 'value')) freeze(descriptor.value);
    Object.freeze(value);
  }
  return value;
}
function rejected(value) {
  let rejected = false;
  try { requireConfigurationEvidence(value, need); } catch (error) { rejected = error.fixtureCode === 'JWT_CONFIG_EVIDENCE'; }
  need(rejected, 'PURE_EVIDENCE_NEGATIVE_SURVIVED'); assertions++;
}
const valid = freeze(fresh()); need(requireConfigurationEvidence(valid, need) === valid, 'PURE_VALID_IDENTITY'); assertions++;
for (const value of [undefined, null, false, 7, 'fixture', [], fresh()]) rejected(value);
const negatives = [
  value => { delete value.cases; }, value => { delete value.sensitivity; }, value => { value.extra = true; },
  value => { value.cases.pop(); }, value => { value.cases.push({ id: 'UNKNOWN', status: 'PASS' }); },
  value => { delete value.cases[1]; }, value => { value.cases[1] = value.cases[0]; }, value => { value.cases.reverse(); },
  value => { value.cases[0].id = 'UNKNOWN'; }, value => { value.cases[0].status = 'SKIP'; },
  value => { value.cases[0].data = 'forbidden'; }, value => { value.cases.extra = true; },
  value => { value.sensitivity.pop(); }, value => { delete value.sensitivity[1]; },
  value => { value.sensitivity[1] = value.sensitivity[0]; }, value => { value.sensitivity.reverse(); },
  value => { value.sensitivity[0].detected = false; }, value => { value.sensitivity[0].status = 'PASS'; },
  value => { Object.setPrototypeOf(value.cases[0], null); }, value => { Object.setPrototypeOf(value, null); },
  value => { Object.defineProperty(value, 'hidden', { value: true }); },
  value => { Object.defineProperty(value.cases[0], 'hidden', { value: true }); },
  value => { value[Symbol('extra')] = true; }, value => { value.cases[Symbol('extra')] = true; },
  value => { value.cases[0][Symbol('extra')] = true; },
  value => { Object.defineProperty(value, 'cases', { get() { getters++; return []; } }); },
  value => { Object.defineProperty(value.cases, '0', { get() { getters++; return {}; } }); },
  value => { Object.defineProperty(value.cases[0], 'id', { get() { getters++; return ids[0]; } }); },
  value => { Object.defineProperty(value.cases[0], 'status', { get() { getters++; return 'PASS'; } }); },
  value => { Object.defineProperty(value.sensitivity[0], 'detected', { get() { getters++; return true; } }); },
];
for (const change of negatives) { const value = fresh(); change(value); rejected(freeze(value)); }
let value = fresh(); value.cases.forEach(Object.freeze); value.sensitivity.forEach(Object.freeze); Object.freeze(value.sensitivity); Object.freeze(value); rejected(value);
value = fresh(); Object.freeze(value.cases); value.sensitivity.forEach(Object.freeze); Object.freeze(value.sensitivity); Object.freeze(value); rejected(value);
value = fresh(); value.cases.forEach(Object.freeze); Object.freeze(value.cases); Object.freeze(value.sensitivity); Object.freeze(value); rejected(value);
let missingChecker = false; try { requireConfigurationEvidence(valid); } catch (error) { missingChecker = error.message === 'JWT_CONFIG_EVIDENCE_CHECKER_REQUIRED'; }
need(missingChecker, 'PURE_NO_CHECKER_FALLBACK'); assertions++;
need(getters === 0 && appImports === 0 && connections === 0 && writes === 0, 'PURE_ZERO_EFFECTS');
output(JSON.stringify({ schema: 'SD-JWT-EVIDENCE-PURE-1', cases: assertions, failed: 0, gettersInvoked: getters,
  applicationImports: appImports, connections, writes, processGrants: 'DENIED', actualConfigLoads: 0, runtime: 'NOT_RUN' }) + '\n');
