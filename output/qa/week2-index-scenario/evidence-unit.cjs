'use strict';
// Actual fixture parser only. No TypeScript/compiler/application helper is loaded.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const output = process.stdout.write.bind(process.stdout);
const fixture = path.resolve(__dirname, '../../../test/api-runtime/scenario/scenario.cjs');
let appImports = 0; let connections = 0; let writes = 0; let getters = 0; let cases = 0;
const denyWrite = () => { writes++; throw new Error('INDEX_PARSER_WRITE_DENIED'); };
for (const key of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync',
  'rm', 'rmSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync']) fs[key] = denyWrite;
for (const key of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile']) fs.promises[key] = denyWrite;
const denySocket = () => { connections++; throw new Error('INDEX_PARSER_SOCKET_DENIED'); };
net.Socket.prototype.connect = denySocket; net.Server.prototype.listen = denySocket;
net.connect = denySocket; net.createConnection = denySocket; tls.connect = denySocket; dns.lookup = denySocket;
const load = Module._load;
const deniedBuiltins = new Set(['child_process', 'worker_threads', 'vm', 'inspector', 'repl', 'module']);
Module._load = function (name, parent, isMain) {
  if (name !== fixture && (!Module.isBuiltin(name) || deniedBuiltins.has(name.replace(/^node:/, '')))) {
    appImports++; throw new Error('INDEX_PARSER_APP_IMPORT_DENIED');
  }
  return load.call(this, name, parent, isMain);
};
const { requireIndexEvidence } = require(fixture);
const need = (ok, code) => { if (!ok) { const error = new Error(code); error.fixtureCode = code; throw error; } };
need(process.permission && !process.permission.has('child') && !process.permission.has('worker')
  && !process.permission.has('addon') && !process.permission.has('fs.write'), 'INDEX_PARSER_GRANTS');
const caseIds = ['INDEX_SELECTED_READBACK', 'INDEX_REQUIRED_REMOVAL_DENIALS', 'INDEX_KEY_AND_IDENTITY_DENIALS',
  'INDEX_OPTIONS_DENIALS', 'INDEX_OBSERVATION_DENIALS', 'INDEX_INPUT_ADMISSION_DENIALS', 'INDEX_IMMUTABILITY_AND_SAFE_RESULT'];
const sensitivityIds = ['INDEX_MISSING_REQUIREMENT_ACCEPTED', 'INDEX_KEY_ORDER_IGNORED', 'INDEX_OPTIONS_IGNORED',
  'INDEX_PARTIAL_FILTER_IGNORED', 'INDEX_INCOMPLETE_ACCEPTED', 'INDEX_BUILD_STATUS_IGNORED'];
const fresh = () => ({ cases: caseIds.map(id => ({ id, status: 'PASS' })), sensitivity: sensitivityIds.map(id => ({ id, detected: true })) });
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (Object.hasOwn(descriptor, 'value')) freeze(descriptor.value);
    Object.freeze(value);
  }
  return value;
}
function rejected(value) {
  let denied = false;
  try { requireIndexEvidence(value, need); } catch (error) { denied = error.fixtureCode === 'INDEX_EVIDENCE'; }
  need(denied, 'INDEX_PARSER_NEGATIVE_SURVIVED'); cases++;
}
const valid = freeze(fresh()); need(requireIndexEvidence(valid, need) === valid, 'INDEX_PARSER_VALID_IDENTITY'); cases++;
for (const value of [undefined, null, false, 1, 'fixture', [], fresh()]) rejected(value);
const controls = [
  value => { delete value.cases; }, value => { delete value.sensitivity; }, value => { value.extra = true; },
  value => { value.cases.pop(); }, value => { value.cases.push({ id: 'UNKNOWN', status: 'PASS' }); },
  value => { delete value.cases[1]; }, value => { value.cases[1] = value.cases[0]; }, value => { value.cases.reverse(); },
  value => { value.cases[0].id = 'UNKNOWN'; }, value => { value.cases[0].status = 'SKIP'; },
  value => { value.cases[0].status = false; }, value => { value.cases[0].payload = 'not permitted'; },
  value => { value.cases.extra = true; }, value => { value.sensitivity.pop(); },
  value => { value.sensitivity.push({ id: 'UNKNOWN', detected: true }); }, value => { delete value.sensitivity[1]; },
  value => { value.sensitivity[1] = value.sensitivity[0]; }, value => { value.sensitivity.reverse(); },
  value => { value.sensitivity[0].id = 'UNKNOWN'; }, value => { value.sensitivity[0].detected = false; },
  value => { value.sensitivity[0].detected = 1; }, value => { value.sensitivity[0].status = 'PASS'; },
  value => { Object.setPrototypeOf(value, null); }, value => { Object.setPrototypeOf(value.cases[0], null); },
  value => { Object.setPrototypeOf(value.sensitivity[0], null); },
  value => { Object.setPrototypeOf(value.cases, Object.create(Array.prototype)); },
  value => { Object.defineProperty(value, 'hidden', { value: true }); },
  value => { Object.defineProperty(value.cases[0], 'hidden', { value: true }); },
  value => { value[Symbol('extra')] = true; }, value => { value.cases[Symbol('extra')] = true; },
  value => { value.cases[0][Symbol('extra')] = true; }, value => { value.sensitivity[0][Symbol('extra')] = true; },
  value => { Object.defineProperty(value, 'cases', { get() { getters++; return []; } }); },
  value => { Object.defineProperty(value.cases, '0', { get() { getters++; return {}; } }); },
  value => { Object.defineProperty(value.cases[0], 'id', { get() { getters++; return caseIds[0]; } }); },
  value => { Object.defineProperty(value.cases[0], 'status', { get() { getters++; return 'PASS'; } }); },
  value => { Object.defineProperty(value.sensitivity[0], 'detected', { get() { getters++; return true; } }); },
];
for (const change of controls) { const value = fresh(); change(value); rejected(freeze(value)); }
let value = fresh(); value.cases.forEach(Object.freeze); value.sensitivity.forEach(Object.freeze); Object.freeze(value.sensitivity); Object.freeze(value); rejected(value);
value = fresh(); Object.freeze(value.cases); value.sensitivity.forEach(Object.freeze); Object.freeze(value.sensitivity); Object.freeze(value); rejected(value);
value = fresh(); value.cases.forEach(Object.freeze); Object.freeze(value.cases); Object.freeze(value.sensitivity); Object.freeze(value); rejected(value);
let missingChecker = false;
try { requireIndexEvidence(valid); } catch (error) { missingChecker = error.message === 'INDEX_EVIDENCE_CHECKER_REQUIRED'; }
need(missingChecker, 'INDEX_PARSER_NO_CHECKER'); cases++;
need(getters === 0 && appImports === 0 && connections === 0 && writes === 0, 'INDEX_PARSER_ZERO_EFFECTS');
output(JSON.stringify({ schema: 'SD-INDEX-EVIDENCE-PURE-1', cases, failed: 0, gettersInvoked: getters,
  applicationImports: appImports, connections, writes, processGrants: 'DENIED', compilerExecutions: 0,
  applicationHelperEvaluations: 0, runtime: 'NOT_RUN' }) + '\n');
