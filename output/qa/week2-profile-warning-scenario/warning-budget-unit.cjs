'use strict';
// Exercise only the ACTUAL pure fixture export. Never invoke runScenario/domain.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const output = process.stdout.write.bind(process.stdout);
const fixture = path.resolve(__dirname, '../../../test/api-runtime/scenario/scenario.cjs');
const source = fs.readFileSync(fixture, 'utf8');
const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
if (sourceSha256 !== 'cbb1260c887a7a5dc664fec9a6b47c680e1d180f78b102716122596baaae6500') throw new Error('BUDGET_UNIT_SOURCE_HASH');
let applicationImports = 0; let connections = 0; let writes = 0; let consoleCalls = 0; let warningCalls = 0;
const stop = code => { const error = new Error(code); error.fixtureCode = code; throw error; };
const need = (value, code) => { if (!value) stop(code); };
const denyWrite = () => { writes++; stop('BUDGET_UNIT_WRITE_DENIED'); };
for (const key of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync',
  'rm', 'rmSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync']) fs[key] = denyWrite;
for (const key of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile']) fs.promises[key] = denyWrite;
const denyNetwork = () => { connections++; stop('BUDGET_UNIT_NETWORK_DENIED'); };
net.Socket.prototype.connect = denyNetwork; net.Server.prototype.listen = denyNetwork;
net.connect = denyNetwork; net.createConnection = denyNetwork; tls.connect = denyNetwork; dns.lookup = denyNetwork;
for (const key of ['log', 'warn', 'error', 'info', 'debug', 'trace']) console[key] = () => { consoleCalls++; stop('BUDGET_UNIT_CONSOLE_DENIED'); };
process.emitWarning = () => { warningCalls++; stop('BUDGET_UNIT_WARNING_DENIED'); };
const load = Module._load;
Module._load = function (name, parent, isMain) {
  if (!(name === fixture && parent === module) && !['node:http', 'node:crypto'].includes(name)) {
    applicationImports++; stop('BUDGET_UNIT_IMPORT_DENIED');
  }
  return load.call(this, name, parent, isMain);
};
need(process.permission && !process.permission.has('child') && !process.permission.has('worker')
  && !process.permission.has('addon') && !process.permission.has('fs.write'), 'BUDGET_UNIT_GRANTS');
const actual = require(fixture).assertProfileWarningBudget;
need(typeof actual === 'function', 'BUDGET_UNIT_EXPORT');
function frozen(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function sample(id, changes = {}, expectedCode = null) {
  const actualWrites = Object.hasOwn(changes, 'actualWrites') ? changes.actualWrites : 1;
  const expectedWrites = Object.hasOwn(changes, 'expectedWrites') ? changes.expectedWrites : 1;
  const value = (key, fallback) => Object.hasOwn(changes, key) ? changes[key] : fallback;
  return frozen({ id, observed: { writes: { specialists: actualWrites }, effects: {
    dbWrites: value('actualDbWrites', actualWrites), mongooseNewAfterWarnings: value('known', actualWrites),
    console: value('total', actualWrites) } }, expected: { writeOpsDelta: { specialists: expectedWrites },
    dbWritesDelta: value('expectedDbWrites', expectedWrites) }, expectedCode });
}
const COUNT = 'SPECIALIST_PROFILE_WARNING_COUNT'; const UNKNOWN = 'SPECIALIST_PROFILE_UNKNOWN_CONSOLE';
const cases = [sample('ZERO_WRITES_ZERO_WARNINGS', { actualWrites: 0, expectedWrites: 0 }), sample('ONE_WRITE_ONE_EXACT_KNOWN_WARNING'),
  sample('MISSING_KNOWN_WITH_WRITE', { known: 0, total: 0 }, COUNT), sample('EXTRA_KNOWN_WITH_WRITE', { known: 2, total: 2 }, COUNT),
  sample('KNOWN_WITHOUT_WRITE', { actualWrites: 0, expectedWrites: 0, known: 1, total: 1 }, COUNT),
  sample('UNKNOWN_ONLY_NO_WRITE', { actualWrites: 0, expectedWrites: 0, known: 0, total: 1 }, UNKNOWN),
  sample('MIXED_KNOWN_AND_UNKNOWN', { total: 2 }, UNKNOWN), sample('CONSOLE_BELOW_KNOWN', { total: 0 }, UNKNOWN),
  sample('TWO_WRITES_NOT_ALLOWED', { actualWrites: 2, expectedWrites: 2 }, COUNT),
  sample('EXTRA_DB_WRITE_ACTUAL_AND_EXPECTED', { actualDbWrites: 2, expectedDbWrites: 2 }, COUNT),
  sample('ACTUAL_EXPECTED_WRITE_DISAGREEMENT', { actualWrites: 1, expectedWrites: 0 }, COUNT)];
const bad = [undefined, null, false, '1', NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1];
for (const [index, value] of bad.entries()) {
  cases.push(sample('KNOWN_TYPE_' + index, { known: value }, COUNT));
  cases.push(sample('TOTAL_TYPE_' + index, { total: value }, UNKNOWN));
  cases.push(sample('ACTUAL_WRITES_TYPE_' + index, { actualWrites: value }, COUNT));
  cases.push(sample('EXPECTED_WRITES_TYPE_' + index, { expectedWrites: value }, COUNT));
  cases.push(sample('ACTUAL_DB_WRITES_TYPE_' + index, { actualDbWrites: value }, COUNT));
  cases.push(sample('EXPECTED_DB_WRITES_TYPE_' + index, { expectedDbWrites: value }, COUNT));
}
cases.push(sample('EXPECTED_TWO_ACTUAL_ONE', { expectedWrites: 2 }, COUNT));
const beforeCache = new Map(Object.entries(require.cache));
function observe(fn, test) {
  const before = JSON.stringify([test.observed, test.expected]); let observed = 'ACCEPTED';
  try { need(fn(test.observed, test.expected, need) === undefined, 'BUDGET_UNIT_RETURN_SHAPE'); }
  catch (error) {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'fixtureCode');
    need(descriptor && Object.hasOwn(descriptor, 'value') && [COUNT, UNKNOWN].includes(descriptor.value), 'BUDGET_UNIT_UNEXPECTED_THROW');
    observed = descriptor.value;
  }
  need(JSON.stringify([test.observed, test.expected]) === before, 'BUDGET_UNIT_INPUT_MUTATION');
  return observed;
}
for (const test of cases) need(observe(actual, test) === (test.expectedCode || 'ACCEPTED'), 'BUDGET_UNIT_FIXED_CASE');
// Repeated fresh observations across fixture phases do not reset or mutate input
// counters. A later missing/unknown warning remains rejected after valid phases.
const sequence = [cases[0], cases[1], cases[2], cases[0], cases[6], cases[1]];
for (const test of sequence) need(observe(actual, test) === (test.expectedCode || 'ACCEPTED'), 'BUDGET_UNIT_PHASE_SEQUENCE');
let missingChecker = false;
try { actual(cases[0].observed, cases[0].expected); }
catch (error) { missingChecker = error.message === 'SPECIALIST_PROFILE_WARNING_CHECKER_REQUIRED'; }
need(missingChecker, 'BUDGET_UNIT_MISSING_CHECKER');
function compileFixture(text) {
  const isolated = new Module(fixture, module); isolated.filename = fixture; isolated.paths = module.paths;
  isolated._compile(text, fixture);
  need(typeof isolated.exports.assertProfileWarningBudget === 'function', 'BUDGET_UNIT_MUTANT_EXPORT');
  return isolated.exports.assertProfileWarningBudget;
}
const changes = [
  { id: 'KNOWN_COUNT_EQUALITY_REMOVED', before: '&& known === actualWrites && known === expectedWrites', after: '&& true', witness: 'MISSING_KNOWN_WITH_WRITE' },
  { id: 'UNKNOWN_CONSOLE_RESIDUAL_REMOVED', before: '&& totalConsole - known === 0', after: '&& true', witness: 'MIXED_KNOWN_AND_UNKNOWN' },
  { id: 'MULTIPLE_WRITES_ALLOWED', before: '(expectedWrites === 0 || expectedWrites === 1)', after: 'expectedWrites >= 0', witness: 'TWO_WRITES_NOT_ALLOWED' },
  { id: 'DB_WRITE_AGREEMENT_REMOVED', before: '&& actualDbWrites === actualWrites && expectedDbWrites === expectedWrites\n    && actualDbWrites === expectedDbWrites', after: '&& true', witness: 'EXTRA_DB_WRITE_ACTUAL_AND_EXPECTED' },
];
const sensitivity = [];
for (const change of changes) {
  need(source.split(change.before).length === 2, 'BUDGET_UNIT_MUTATION_ANCHOR');
  const mutated = compileFixture(source.replace(change.before, change.after));
  const observed = cases.map(test => ({ id: test.id, actual: observe(mutated, test), expected: test.expectedCode || 'ACCEPTED' }));
  const witness = observed.find(row => row.id === change.witness);
  need(witness && witness.actual === 'ACCEPTED' && witness.expected !== 'ACCEPTED'
    && observed.filter(row => row.expected === 'ACCEPTED').every(row => row.actual === 'ACCEPTED'), 'BUDGET_UNIT_MUTATION_WITNESS');
  sensitivity.push({ id: change.id, rejectedByFixedCases: true, concreteUnsafeAcceptanceWitness: change.witness,
    mismatchedFixedCases: observed.filter(row => row.actual !== row.expected).length });
}
need(Object.keys(require.cache).length === beforeCache.size
  && Object.entries(require.cache).every(([key, value]) => beforeCache.get(key) === value), 'BUDGET_UNIT_CACHE_DRIFT');
need(applicationImports === 0 && connections === 0 && writes === 0 && consoleCalls === 0 && warningCalls === 0, 'BUDGET_UNIT_ZERO_EFFECTS');
output(JSON.stringify({ schema: 'SD-PROFILE-WARNING-BUDGET-PURE-1', nominalFixedCases: cases.length,
  phaseRestorationChecks: sequence.length, missingCheckerChecks: 1, weakenedVariants: sensitivity,
  weakenedCaseExecutions: cases.length * changes.length, failed: 0, applicationImports, connections, writes, consoleCalls,
  warningCalls, domainEvaluations: 0, compilerExecutions: 0, actualFixtureSourceSha256: sourceSha256,
  scope: 'ACTUAL_PURE_FIXTURE_EXPORT_ONLY; NO_DOMAIN_OR_MONGOOSE; REAL_HTTP_WARNING_BUDGET_NOT_RUN' }) + '\n');
