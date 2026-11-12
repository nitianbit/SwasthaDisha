import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import buffer from 'node:buffer';
import events from 'node:events';
import stream from 'node:stream';
import util from 'node:util';
import stringDecoder from 'node:string_decoder';

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const plan = read('ports-plan.json');
const emitted = read('emitted-modules.json');
const runtime = read('runtime-modules.json');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const check = (ok, predicate) => { if (!ok) { const error = new Error('PREDICATE:' + predicate); error.predicate = predicate; throw error; } };
check(plan.schema === 'SD-ENROLLMENT-PORTS-1' && emitted.schema === 'SD-ENROLLMENT-EMITTED-MAP-1' && runtime.schema === 'SD-ENROLLMENT-RUNTIME-MAP-1', 'map-schema');
check(Object.keys(emitted.phases).sort().join() === 'NC1,NC2,NC3,NC4,OLD,nominal', 'exact-phases');
const allowedBuiltins = { 'node:crypto': crypto, 'node:buffer': buffer, 'node:events': events, 'node:stream': stream, 'node:util': util, 'node:string_decoder': stringDecoder };
check(runtime.builtins.every(id => plan.builtinCandidates.includes(id)), 'builtin-closure');
check(Object.keys(runtime.modules).length <= 512 && Object.keys(runtime.modules).every(id => id.startsWith('node_modules/') && !id.includes('../')), 'package-map-bound');
for (const name of ['emitted-modules.json', 'runtime-modules.json']) check(Buffer.byteLength(JSON.stringify(read(name))) < 8 * 1024 * 1024, 'map-byte-bound');
for (const [id, expected] of Object.entries(plan.sourcePins)) check(emitted.phases.nominal.sourceHashes[id] === expected, 'actual-source-pin');
const S = plan.synthetic;
const copy = value => structuredClone(value);
const canonical = value => value === undefined ? '<undefined>' : Array.isArray(value) ? Array.from(value, canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function phaseLoader(phase) {
  const domain = emitted.phases[phase]; const cache = new Map();
  const privateSecret = crypto.randomBytes(32).toString('hex');
  let currentCounters;
  const sandbox = { Buffer, console: Object.freeze({ error() { currentCounters.consoleErrors++; }, warn() { currentCounters.consoleErrors++; }, log() { throw new Error('DOMAIN_CONSOLE'); } }),
    process: Object.freeze({ version: process.version, versions: Object.freeze({ node: process.versions.node }), env: Object.freeze({}) }) };
  sandbox.global = sandbox;
  const context = vm.createContext(sandbox, { name: 'customer-enrollment-' + phase, codeGeneration: { strings: false, wasm: false } });
  new vm.Script('globalThis.global = globalThis').runInContext(context, { timeout: 1000 });
  const classes = Object.fromEntries(plan.cuts.map(row => [row.specifier, Object.freeze({ [row.export]: class {} })]));
  const config = Object.freeze({ CONFIG: Object.freeze({ JWT_SECRET_KEY: privateSecret, OTP_EXPIRY_MINUTES: 10 }) });
  const nativeCrypto = Object.freeze({ ...crypto, randomInt(...args) { currentCounters.random++; return crypto.randomInt(...args); } });
  function load(id) {
    if (cache.has(id)) return cache.get(id).exports;
    const domainCode = Object.hasOwn(domain.modules, id);
    const modules = domainCode ? domain.modules : runtime.modules;
    const edges = domainCode ? domain.edges : runtime.edges;
    check(Object.hasOwn(modules, id), 'closed-module:' + id);
    const module = { exports: {} }; cache.set(id, module);
    if (id.endsWith('.json')) module.exports = JSON.parse(modules[id]);
    else {
      const require = spec => {
        check(Object.hasOwn(edges[id], spec), 'unlisted-require'); const target = edges[id][spec];
        if (target === '@/config/config') return config;
        if (Object.hasOwn(classes, target)) return classes[target];
        if (target === 'node:crypto') return nativeCrypto;
        if (target.startsWith('node:')) { check(Object.hasOwn(allowedBuiltins, target), 'native-denied'); return allowedBuiltins[target]; }
        if (Object.hasOwn(runtime.roots, target)) return load(runtime.roots[target]);
        return load(target);
      };
      const fn = new vm.Script('(function(exports,require,module,__filename,__dirname){\n' + modules[id] + '\n})', { filename: id }).runInContext(context, { timeout: 1000 });
      fn(module.exports, require, module, id, id.slice(0, id.lastIndexOf('/')));
    }
    return module.exports;
  }
  currentCounters = { random: 0, signs: 0, consoleErrors: 0 };
  load(runtime.roots['reflect-metadata']);
  const jwt = load(runtime.roots.jsonwebtoken); const sign = jwt.sign;
  jwt.sign = (...args) => { currentCounters.signs++; return sign(...args); };
  const Service = load('src1/modules/auth/services/index.ts').AuthService;
  const validation = load('src1/modules/auth/validation/index.ts');
  function verifyToken(token, expected, intendedRole) {
    const claims = jwt.verify(token, privateSecret);
    check(claims._id === S.id && claims.userType === intendedRole, 'token-trusted-fixture-identity');
    check(claims._id === expected._id && claims.userType === expected.userType && claims.exp - claims.iat === 30 * 24 * 3600, 'token-identity-lifetime');
    for (const key of ['phone', 'email', 'corporateId', 'specialistId', 'pharmacyId']) check(claims[key] === expected[key], 'token-field:' + key);
  }
  return { Service, validation, verifyToken, activate(counters) { currentCounters = counters; } };
}
function fixture(loader, options = {}) {
  const counters = { random: 0, signs: 0, consoleErrors: 0 }; loader.activate(counters);
  const calls = []; let row = options.row === undefined ? null : copy(options.row); let generated;
  let unexpected = false;
  const record = (name, args, result) => { calls.push({ name, args: copy(args) }); return result; };
  const AppError = class extends Error { constructor(code, status) { super('Synthetic proof failure'); this.name = 'AppError'; this.code = code; this.status = status; } };
  function port(name, methods) { return new Proxy(Object.freeze(methods), { get(target, key) {
    if (Object.hasOwn(target, key)) return target[key];
    unexpected = true; throw new Error('UNEXPECTED_PORT');
  } }); }
  const repository = name => {
    const methods = {
    async findByPhoneOrEmail(...args) { return record(name + '.lookup', args, row); },
    async findByPhone(...args) { return record(name + '.lookupPhone', args, row); },
    async findByEmail(...args) { return record(name + '.lookupEmail', args, row); },
    async save(data) { record(name + '.save', [data]); row = { ...copy(data), _id: S.id, ...(name === 'user' ? { userType: 'user' } : {}) }; return row; },
    async update(...args) { return record(name + '.update', args, row); },
    };
    const allowed = {
      user: ['findByPhoneOrEmail', 'save', 'update'],
      admin: ['findByPhoneOrEmail'], hr: ['findByPhoneOrEmail'],
      specialist: ['findByPhoneOrEmail', 'save'], pharmacy: ['findByPhone', 'findByEmail', 'save'],
    };
    return port(name, Object.fromEntries(allowed[name].map(key => [key, methods[key]])));
  };
  const repositories = ['user', 'admin', 'hr', 'specialist', 'pharmacy'].map(repository);
  const corporate = port('corporate', {});
  const otp = port('otp', {
    async createOTP(data) { generated = copy(data); check(/^\d{6}$/.test(data.otp), 'generated-six-digits'); return record('otp.create', [data], data); },
    async verifyOTP(data) { record('otp.verify', [data]); if (options.proofError) throw new AppError('SYNTHETIC_PROOF_REJECTED', 400); return {}; },
  });
  const wallet = port('wallet', { async getByUserId(...args) { return record('wallet.get', args, {}); } });
  const notification = port('notification', {
    async createLoginNotification(...args) { return record('notification.customer', args, {}); },
    async createSpecialistLoginNotification(...args) { return record('notification.specialist', args, {}); },
  });
  const email = port('email', { async sendEmail(data) { check(generated && data.textBody.includes(generated.otp), 'email-code-binding'); return record('email.send', [data], {}); } });
  const sms = port('sms', {
    buildSMSContent(template, data) { check(generated && data.otp === generated.otp && data.expiryMinutes === 10 && template === 'otp', 'sms-code-binding'); record('sms.build', [template, data]); return { text: data.otp, templateId: 'synthetic-template' }; },
    async sendSMS(data) { check(generated && data.text === generated.otp, 'sms-dispatch-code'); return record('sms.send', [data], {}); },
  });
  const service = new loader.Service(...repositories, corporate, otp, wallet, notification, email, sms);
  return { service, counters, calls, get row() { return row; }, get generated() { return generated; },
    assertPlanned() { check(!unexpected && counters.consoleErrors === 0, 'unexpected-port-latch'); } };
}
function request(field = 'phone', value = field === 'phone' ? S.phone : S.email, role = 'user') { return { userType: role, [field]: value }; }
function rowFor(role = 'user', overrides = {}) { return { _id: S.id, userType: role, phone: S.phone, email: S.email, isActive: true,
  ...(role === 'hr' ? { corporateId: S.corporateId } : {}), ...overrides }; }
function names(f) { return f.calls.map(c => c.name); }
function exactly(f, expected) { check(JSON.stringify(names(f)) === JSON.stringify(expected), 'call-order'); }
function noEffects(f) {
  if (f.calls.length || f.counters.random || f.counters.signs || f.counters.consoleErrors) {
    const error = new Error('PREDICATE:zero-effects'); error.predicate = 'zero-effects'; error.effectCalls = f.calls.length; throw error;
  }
}
async function invoke(f, method, data) { try { return { result: await f.service[method === 'send' ? 'sendOTP' : 'verifyOTP'](data) }; } catch (error) { return { error }; } }
async function denied(loader, v) {
  const f = fixture(loader, { row: rowFor() }); const data = { userType: 'user', ...v.data, ...(v.method === 'verify' ? { otp: S.otp } : {}) };
  if (v.kind === 'deny-otp') { data.phone = S.phone; data.otp = v.otp; if (v.omit) delete data.otp; }
  const out = await invoke(f, v.kind === 'deny-otp' ? 'verify' : v.method, data);
  noEffects(f); check(out.error?.status === 400 && out.error?.code === 'VALIDATION_ERROR', 'customer-validation-error'); f.assertPlanned(); return f;
}
async function positive(loader, v) {
  const field = v.field || 'phone'; const value = v.value || (field === 'phone' ? S.phone : S.email);
  const canonicalValue = field === 'email' ? value.trim().toLowerCase() : value;
  const other = field === 'phone' ? 'email' : 'phone'; const existing = v.kind === 'existing' || v.kind === 'undefined' && v.method === 'verify';
  const initial = existing ? rowFor('user', { [field]: canonicalValue, ...(v.secondary ? {} : { [other]: undefined }) }) : null;
  const f = fixture(loader, { row: initial }); const data = request(field, value);
  if (v.kind === 'undefined') data[other] = undefined;
  if (v.method !== 'verify') {
    const sent = await invoke(f, 'send', data); check(!sent.error && sent.result?.message === 'OTP sent successfully', 'send-success');
    const expected = ['user.lookup', ...(!existing ? ['user.save'] : []), 'otp.create', ...(field === 'phone' ? ['sms.build', 'sms.send'] : ['email.send'])]; exactly(f, expected);
    assert.deepEqual(canonical(f.calls[0].args), canonical([{ [field]: canonicalValue }, 'user']));
    if (!existing) {
      const saved = f.calls.find(c => c.name === 'user.save').args[0];
      check(Object.hasOwn(saved, field) && saved[field] === canonicalValue && !Object.hasOwn(saved, other), 'single-contact-save');
      assert.deepEqual(Object.keys(saved).sort(), [field, 'userType', 'createdSource', 'otpVerified'].sort());
    }
    check(f.generated.target === field && f.generated.targetValue === canonicalValue && f.generated.userId === S.id, 'otp-send-destination');
    const sentCall = f.calls.at(-1); check(field === 'phone' ? sentCall.args[0].to === canonicalValue : JSON.stringify(sentCall.args[0].to) === JSON.stringify([canonicalValue]), 'provider-intent-destination');
  }
  const before = f.calls.length; const code = f.generated?.otp || S.otp;
  const verified = await invoke(f, 'verify', { ...data, otp: code });
  check(!verified.error && verified.result?.message === 'OTP verified successfully', 'verify-success');
  const verifyCalls = f.calls.slice(before); check(verifyCalls.map(c => c.name).join() === 'user.lookup,otp.verify,user.update,wallet.get,notification.customer', 'verify-call-order');
  assert.deepEqual(canonical(verifyCalls[0].args), canonical([{ [field]: canonicalValue }, 'user']));
  assert.deepEqual(canonical(verifyCalls[1].args), canonical([{ userId: S.id, otp: code, target: field, targetValue: canonicalValue }]));
  assert.deepEqual(canonical(verifyCalls[2].args), canonical([{ _id: S.id }, { otpVerified: true, isVerified: true }]));
  check(verifyCalls[3].args[0] === S.id && verifyCalls[4].args[0] === S.id && f.counters.signs === 1, 'customer-post-proof-effects');
  loader.verifyToken(verified.result.accessToken, verified.result.userData, 'user'); check(verified.result.userData[field] === canonicalValue, 'returned-contact'); f.assertPlanned(); return f;
}
async function current(loader, v) {
  const f = fixture(loader, { row: rowFor('user', { [v.field]: v.absent ? undefined : v.field === 'phone' ? S.otherPhone : ' Changed@Example.COM ' }) });
  const out = await invoke(f, 'verify', { ...request(v.field), otp: S.otp });
  if (v.absent) { check(out.error?.code === 'OTP_UNAVAILABLE', 'missing-current-contact'); exactly(f, ['user.lookup']); check(f.counters.signs === 0, 'missing-current-no-sign'); }
  else { check(!out.error, 'current-row-success'); const call = f.calls.find(c => c.name === 'otp.verify'); check(call.args[0].targetValue === (v.field === 'phone' ? S.otherPhone : S.otherEmail), 'current-row-not-caller'); loader.verifyToken(out.result.accessToken, out.result.userData, 'user'); }
  f.assertPlanned();
}
async function failure(loader, v) {
  const f = fixture(loader, { row: v.failure === 'not-found' ? null : rowFor(), proofError: true });
  const out = await invoke(f, 'verify', { ...request(), otp: S.otp });
  check(out.error?.code === (v.failure === 'not-found' ? 'USER_NOT_FOUND' : 'SYNTHETIC_PROOF_REJECTED'), 'proof-error-propagation');
  exactly(f, v.failure === 'not-found' ? ['user.lookup'] : ['user.lookup', 'otp.verify']); check(f.counters.signs === 0, 'proof-failure-no-sign'); f.assertPlanned();
}
async function staffTrace(loader, v) {
  const traces = [];
  for (const method of ['send', 'verify']) {
    const f = fixture(loader, { row: v.state === 'missing' ? null : rowFor(v.role, { isActive: v.state !== 'inactive' }) });
    const data = { userType: v.role, ...(v.shape !== 'email' ? { phone: S.phone } : {}), ...(v.shape !== 'phone' ? { email: S.email } : {}), ...(method === 'verify' ? { otp: S.otp } : {}) };
    const out = await invoke(f, method, data);
    if (out.result?.accessToken) loader.verifyToken(out.result.accessToken, out.result.userData, v.role);
    if (v.state === 'active') check(!out.error, 'staff-positive');
    if (v.state === 'inactive') check(out.error?.code === v.role.toUpperCase() + '_INACTIVE' && f.counters.signs === 0, 'staff-inactive');
    if (v.state === 'missing') check(method === 'verify' ? out.error?.code === 'USER_NOT_FOUND' : ['specialist', 'pharmacy'].includes(v.role) ? !out.error && names(f).includes(v.role + '.save') : out.error?.code === v.role.toUpperCase() + '_NOT_FOUND', 'staff-missing-signup');
    // Validate generated code/template/token before replacing nondeterministic fields for comparison.
    const normalize = value => typeof value === 'string' && f.generated?.otp ? value.split(f.generated.otp).join('<otp>') : value;
    function safe(value) { if (Array.isArray(value)) return value.map(safe); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, safe(x)])); return normalize(value); }
    traces.push(canonical({ calls: safe(f.calls), counters: f.counters, error: out.error ? { code: out.error.code, status: out.error.status } : null,
      response: out.result ? { message: out.result.message, ...(out.result.userData ? { userData: out.result.userData } : {}) } : null })); f.assertPlanned();
  }
  return traces;
}
function helper(loader, v) {
  const select = loader.validation.selectCustomerLoginContact; let data = request(); let verify = false; let invalid = false;
  if (v.variant === 'email') data = request('email', ' Customer@Example.COM ');
  if (v.variant === 'undefined') data.email = undefined;
  if (v.variant === 'dual') { data.email = S.email; invalid = true; }
  if (v.variant === 'neither') { data = {}; invalid = true; }
  if (v.variant === 'null') { data = null; invalid = true; }
  if (v.variant === 'array') { data = []; invalid = true; }
  if (v.variant === 'otp-bad') { data.otp = 123456; verify = true; invalid = true; }
  if (v.variant === 'unknown') data.ignored = 'harmless';
  if (invalid) assert.throws(() => select(data, verify), e => e.status === 400 && e.code === 'VALIDATION_ERROR');
  else { const selected = select(data, verify); check(selected.target === (v.variant === 'email' ? 'email' : 'phone') && selected.targetValue === (v.variant === 'email' ? S.email : S.phone), 'helper-positive'); }
  check(!loader.validation.sendOTPSchema.validate({ phone: S.phone, email: S.email }).error && !loader.validation.verifyOTPSchema.validate({ phone: S.phone, email: S.email, otp: S.otp }).error, 'legacy-schema-unchanged');
}
async function caseRun(loader, v, old) {
  if (['signup', 'existing', 'undefined'].includes(v.kind)) return positive(loader, v);
  if (v.kind === 'deny' || v.kind === 'deny-otp') return denied(loader, v);
  if (v.kind === 'current') return current(loader, v);
  if (v.kind === 'failure') return failure(loader, v);
  if (v.kind === 'helper') return helper(loader, v);
  if (v.kind === 'staff') assert.deepEqual(await staffTrace(loader, v), await staffTrace(old, v));
}
export async function runEnrollmentScenario() {
  const nominal = phaseLoader('nominal'); const old = phaseLoader('OLD'); const passed = [];
  for (const vector of plan.vectors) {
    try { await caseRun(nominal, vector, old); } catch { throw new Error('ENROLLMENT_CASE_FAILED:' + vector.id); }
    passed.push(vector.id);
  }
  const controls = [];
  for (const control of plan.controls.concat(plan.oldControl)) {
    const loader = phaseLoader(control.id); const vector = plan.vectors.find(v => v.id === control.case);
    let error; try { await caseRun(loader, vector, old); } catch (e) { error = e; }
    check(error?.predicate === (control.id === 'NC4' ? 'single-contact-save' : 'zero-effects'), 'behavioral-control:' + control.id);
    if (control.id !== 'NC4') check(error.effectCalls > 0, 'control-reached-concrete-effects');
    const restored = phaseLoader('nominal');
    await caseRun(restored, vector, old); await caseRun(restored, plan.vectors[0], old); controls.push({ id: control.id, target: control.case, predicate: error.predicate, detected: true, restored: true });
  }
  // Baseline counterfactual uses genuinely defined A+B, rather than inferring BSON persistence from undefined.
  const counterfactual = fixture(old); const dual = { userType: 'user', phone: S.phone, email: S.email };
  const send = await invoke(counterfactual, 'send', dual); check(!send.error && counterfactual.row.phone === S.phone && counterfactual.row.email === S.email, 'old-two-valued-save');
  check(counterfactual.generated.target === 'phone' && counterfactual.generated.targetValue === S.phone, 'old-one-destination');
  const verified = await invoke(counterfactual, 'verify', { userType: 'user', phone: S.phone, otp: counterfactual.generated.otp });
  check(!verified.error && verified.result.userData.email === S.email, 'old-unproved-alias-claims'); old.verifyToken(verified.result.accessToken, verified.result.userData, 'user'); counterfactual.assertPlanned();
  const restoredLoader = phaseLoader('nominal'); const restoredCaseIds = [];
  for (const vector of plan.vectors) {
    try { await caseRun(restoredLoader, vector, old); } catch { throw new Error('ENROLLMENT_CASE_FAILED:' + vector.id + '.restored'); }
    restoredCaseIds.push(vector.id);
  }
  // Reject forbidden linker edges independently of source behavior. No real fs/network import occurs.
  check(!Object.values(emitted.phases.nominal.edges).some(edges => Object.values(edges).some(id => ['fs','net','http','mongoose'].includes(id))), 'closed-domain-graph');
  return { schema: 'SD-ENROLLMENT-SERVICE-RESULT-1', planSha256: hash(readFileSync(new URL('ports-plan.json', import.meta.url))),
    emittedSha256: hash(readFileSync(new URL('emitted-modules.json', import.meta.url))), runtimeSha256: hash(readFileSync(new URL('runtime-modules.json', import.meta.url))),
    caseIds: passed, restoredCaseIds, passed: passed.length, failed: 0, skipped: 0, controls, baselineTwoAliasDataflowObserved: true,
    database: 'NOT_ADMITTED', providers: 'RECORDING_ONLY', http: 'NOT_RUN', typecheck: 'NOT_CLAIMED' };
}
