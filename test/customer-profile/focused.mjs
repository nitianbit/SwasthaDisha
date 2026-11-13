/** Whole service/controller policy checks with recording dependencies, never app/DB/HTTP/Joi integration. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('../../', import.meta.url);
const paths = {
  service: 'src1/modules/user/services/index.ts',
  controller: 'src1/modules/user/controller/index.ts',
  routes: 'src1/modules/user/routes/index.ts',
  validation: 'src1/modules/user/validation/index.ts',
};
const sources = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(new URL(path, root), 'utf8')]));
const forbiddenMatch = sources.validation.match(/export const PROFILE_SELF_FORBIDDEN_FIELDS = (\[[\s\S]*?\]) as const;/);
assert.ok(forbiddenMatch, 'read the actual shared forbidden fields');
const forbidden = JSON.parse(forbiddenMatch[1].replaceAll("'", '"').replace(/,\s*\]/, ']'));
assert.match(sources.validation, /email: Joi\.string\(\)\.trim\(\)\.lowercase\(\)\.email\(\)/);
assert.match(sources.validation.slice(sources.validation.indexOf('export const updateUserSchema')), /phone: Joi\.string\(\)\.pattern\(\/\^\[0-9\]\{10\}\$\/\)/);
assert.doesNotMatch(sources.routes, /validate\(updateUserSchema/);

const importAllowlist = {
  service: ['typedi', '@/modules/user/repository', '@/modules/corporates/repository', '@/modules/user/types', '@/modules/common/types', '@/modules/common/utils/queryUtils', '@/modules/user/validation'],
  controller: ['reflect-metadata', 'express', 'typedi', '@/modules/common/types', '@/modules/middleware/auth', '@/modules/user/services', '@/modules/user/types', '@/modules/user/validation'],
};
function compileWhole(source, kind, ports) {
  const imports = [];
  let body = source.replace(/^import [^\n]*;\n/gm, line => {
    const match = line.match(/(?:from\s+)?['"]([^'"]+)['"];\s*$/);
    assert.ok(match, 'only exact static single-line imports'); imports.push(match[1]); return '';
  });
  assert.deepEqual(imports, importAllowlist[kind], 'closed ordered import list');
  if (kind === 'service') {
    assert.equal(body.match(/^@Service\(\)\n/gm)?.length, 1);
    body = body.replace(/^@Service\(\)\n/m, '');
  }
  assert.doesNotMatch(body, /\b(?:import|require|process|eval)\s*\(|\bprocess\./);
  body = body.replace('export class ', 'class ');
  const className = kind === 'service' ? 'UserService' : 'UserController';
  const javascript = stripTypeScriptTypes(body, { mode: 'transform', sourceUrl: paths[kind] });
  const context = createContext({ ...ports }, { codeGeneration: { strings: false, wasm: false } });
  return new Script(javascript + '\n;globalThis.Subject = ' + className, { filename: paths[kind] }).runInContext(context, { timeout: 1000 });
}
class RecordingAppError extends Error {
  constructor(details) { super(details.message); Object.assign(this, details); }
}
const actor = { _id: 'user-1', userType: 'user' };
const base = { _id: 'user-1', userType: 'user', name: 'Ravi', phone: '9999999999', email: 'ravi@example.test', isVerified: true };
const editable = new Set(['email', 'phone', 'corporateEmail', 'userType', 'name', 'profilePictureUrl', 'dateOfBirth', 'gender', 'bloodGroup', 'height', 'weight', 'emergencyContact', 'address', 'latitude', 'longitude', 'city', 'state', 'pincode', 'country', 'corporateId', 'isCorporateUser', 'isActive', 'isVerified', 'isCorporateEmailVerified']);
function fixture(serviceSource = sources.service, row = base, overrides = {}) {
  const state = { row: { ...row }, writes: [], validations: [], reads: 0 };
  // This recording schema enforces only controls needed by policy cases. It is deliberately NOT Joi.
  const updateUserSchema = { validate(candidate, options) {
    state.validations.push({ candidate: structuredClone(candidate), options: { ...options } });
    const value = Object.fromEntries(Object.entries(candidate).filter(([key]) => editable.has(key)));
    if (typeof value.email === 'string') value.email = value.email.trim().toLowerCase();
    const invalid = (value.email !== undefined && (typeof value.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.email))) ||
      (value.phone !== undefined && (typeof value.phone !== 'string' || !/^\d{10}$/.test(value.phone))) ||
      (value.name !== undefined && typeof value.name !== 'string') || (value.userType !== undefined && value.userType !== 'user');
    return invalid ? { error: { details: [{ message: 'recorded schema rejection' }] } } : { value };
  } };
  const repo = {
    async get() { state.reads++; return { ...state.row }; },
    async findByPhone() { return overrides.duplicatePhone ? { _id: 'other' } : null; },
    async findByAnyEmail() { return overrides.duplicateEmail ? { _id: 'other' } : null; },
    async update(filter, data, options) {
      state.writes.push(structuredClone({ filter, data, options }));
      if (overrides.stale && (filter.phone || filter.email)) return null;
      state.row = { ...state.row, ...data }; return { ...state.row };
    },
  };
  const corporate = { async findById() { return null; }, async findOne() { return null; } };
  const UserService = compileWhole(serviceSource, 'service', {
    AppError: RecordingAppError, PROFILE_SELF_FORBIDDEN_FIELDS: forbidden,
    updateUserSchema, buildContainsRegex: () => { throw Error('unadmitted method'); },
  });
  const service = new UserService(repo, corporate);
  return { service, state, UserService };
}
const json = value => JSON.parse(JSON.stringify(value));
async function rejectsCode(promise, code) { await assert.rejects(promise, error => error.code === code); }
const cases = [];
function check(name, body) { cases.push({ name, body }); }
check('mixed profile edit retains both stored contacts', async source => {
  const f = fixture(source); const result = await f.service.update(base._id, { name: 'Ravi Kumar', phone: '8888888888', email: 'else@example.test' }, actor);
  assert.equal(result.name, 'Ravi Kumar'); assert.equal(result.phone, base.phone); assert.equal(result.email, base.email);
  assert.equal(f.state.validations[0].candidate.phone, undefined); assert.equal(f.state.validations[0].candidate.email, undefined);
});
check('malformed ignored contacts cannot block valid other edits', async source => {
  const f = fixture(source); const result = await f.service.update(base._id, { name: 'Changed', phone: { arbitrary: 1 }, email: null }, actor);
  assert.equal(result.name, 'Changed'); assert.equal(result.phone, base.phone); assert.equal(result.email, base.email);
});
check('missing email normalizes and remains unverified', async source => {
  const f = fixture(source, { ...base, email: undefined }); const result = await f.service.update(base._id, { email: '  NEW@EXAMPLE.TEST  ', name: 'Changed' }, actor);
  assert.equal(result.email, 'new@example.test'); assert.equal(result.isVerified, false); assert.equal(result.name, 'Changed');
  assert.deepEqual(json(f.state.writes[0].filter.email), { $in: [null, ''] });
});
check('missing phone normalizes supported Indian format', async source => {
  const f = fixture(source, { ...base, phone: undefined }); const result = await f.service.update(base._id, { phone: ' +91 88888 88888 ' }, actor);
  assert.equal(result.phone, '8888888888');
});
check('null and empty contacts may both be filled', async source => {
  const f = fixture(source, { ...base, phone: null, email: '' }); const result = await f.service.update(base._id, { phone: '08888888888', email: 'new@example.test' }, actor);
  assert.equal(result.phone, '8888888888'); assert.equal(result.email, 'new@example.test');
  const filter = json(f.state.writes[0].filter);
  assert.deepEqual(filter.phone, { $in: [null, ''] }); assert.deepEqual(filter.email, { $in: [null, ''] });
  assert.deepEqual(filter.$expr, { $and: ['phone', 'email'].map(field => ({ $in: [{ $type: '$' + field }, ['missing', 'null', 'string']] })) });
});
check('ignored contact-only self request is no-op', async source => {
  const f = fixture(source); const result = await f.service.update(base._id, { phone: '8888888888', email: 'other@example.test' }, actor);
  assert.equal(result.phone, base.phone); assert.equal(f.state.writes.length, 0);
});
check('admin replaces contacts after normalization', async source => {
  const f = fixture(source); const result = await f.service.update(base._id, { phone: '8888888888', email: 'NEW@EXAMPLE.TEST' }, { _id: 'admin-1', userType: 'admin' });
  assert.equal(result.phone, '8888888888'); assert.equal(result.email, 'new@example.test'); assert.equal(result.isVerified, false);
});
check('HR retains corporate profile edit but cannot alter contacts', async source => {
  const f = fixture(source, { ...base, corporateId: 'corp-1' }); const result = await f.service.update(base._id, { name: 'HR edit', phone: '8888888888', email: 'other@example.test' }, { _id: 'hr-1', userType: 'hr', corporateId: 'corp-1' });
  assert.equal(result.name, 'HR edit'); assert.equal(result.phone, base.phone); assert.equal(result.email, base.email);
  assert.equal(f.state.writes[0].filter.corporateId, 'corp-1');
});
check('HR cannot fill missing contacts', async source => {
  const f = fixture(source, { ...base, corporateId: 'corp-1', phone: null, email: null }); const result = await f.service.update(base._id, { phone: '8888888888', email: 'other@example.test' }, { _id: 'hr-1', userType: 'hr', corporateId: 'corp-1' });
  assert.equal(result.phone, null); assert.equal(result.email, null); assert.equal(f.state.writes.length, 0);
});
for (const [name, principal] of [
  ['foreign user', { _id: 'foreign', userType: 'user' }],
  ['pharmacy', { _id: 'pharmacy-1', userType: 'pharmacy' }],
  ['HR without corporate', { _id: 'hr-1', userType: 'hr' }],
]) check(name + ' is denied before repository reads', async source => {
  const f = fixture(source); await rejectsCode(f.service.update(base._id, { name: 'bad' }, principal), 'FORBIDDEN'); assert.equal(f.state.reads, 0); assert.equal(f.state.writes.length, 0);
});
check('missing signed actor denied before repository reads', async source => {
  const f = fixture(source); await rejectsCode(f.service.update(base._id, { name: 'bad' }), 'UNAUTHORIZED'); assert.equal(f.state.reads, 0);
});
check('foreign HR corporate denied', async source => {
  const f = fixture(source, { ...base, corporateId: 'corp-2' }); await rejectsCode(f.service.update(base._id, { name: 'bad' }, { _id: 'hr-1', userType: 'hr', corporateId: 'corp-1' }), 'FORBIDDEN'); assert.equal(f.state.writes.length, 0);
});
for (const field of forbidden) check('self privilege ' + field + ' rejected before read', async source => {
  const f = fixture(source); await rejectsCode(f.service.update(base._id, { name: 'bad', [field]: true }, actor), 'FORBIDDEN_FIELD'); assert.equal(f.state.reads, 0);
});
for (const [name, payload] of [['null', null], ['array', []], ['string', 'bad'], ['number', 3]]) check('service rejects ' + name + ' body', async source => {
  const f = fixture(source); await rejectsCode(f.service.update(base._id, payload, actor), 'VALIDATION_ERROR'); assert.equal(f.state.reads, 0);
});
for (const field of ['phone', 'email']) {
  check('invalid missing ' + field + ' is rejected', async source => {
    const f = fixture(source, { ...base, [field]: undefined }); await rejectsCode(f.service.update(base._id, { [field]: 'invalid' }, actor), 'VALIDATION_ERROR'); assert.equal(f.state.writes.length, 0);
  });
  check('observed duplicate ' + field + ' is rejected', async source => {
    const f = fixture(source, { ...base, [field]: undefined }, { [field === 'phone' ? 'duplicatePhone' : 'duplicateEmail']: true });
    await rejectsCode(f.service.update(base._id, { [field]: field === 'phone' ? '8888888888' : 'other@example.test' }, actor), field === 'phone' ? 'PHONE_ALREADY_IN_USE' : 'EMAIL_ALREADY_IN_USE'); assert.equal(f.state.writes.length, 0);
  });
  check('stale missing ' + field + ' cannot overwrite', async source => {
    const f = fixture(source, { ...base, [field]: undefined }, { stale: true }); await rejectsCode(f.service.update(base._id, { name: 'Changed', [field]: field === 'phone' ? '8888888888' : 'other@example.test' }, actor), 'CONTACT_ALREADY_SET');
  });
}
async function runSuite(source) {
  const passed = [], failures = [];
  for (const entry of cases) {
    try { await entry.body(source); passed.push(entry.name); }
    catch (error) { failures.push({ name: entry.name, error: String(error) }); }
  }
  return { passed, failures };
}
const nominal = await runSuite(sources.service);
assert.deepEqual(nominal.failures, [], JSON.stringify(nominal.failures));

// Evaluate the complete actual controller with the same service and recording DI/response.
const f = fixture();
const UserController = compileWhole(sources.controller, 'controller', {
  AppError: RecordingAppError, PROFILE_SELF_FORBIDDEN_FIELDS: forbidden, UserService: f.UserService,
  Container: { get(klass) { assert.equal(klass, f.UserService); return f.service; } },
});
const controller = new UserController();
let response;
const res = { status(code) { assert.equal(code, 200); return this; }, json(value) { response = value; } };
await controller.update({ user: actor, params: { id: base._id }, body: { name: 'Controller edit', phone: { ignored: true } } }, res, () => {});
assert.equal(response.data.user.name, 'Controller edit'); assert.equal(response.data.user.phone, base.phone);
for (const body of [null, [], 'bad', 3]) await rejectsCode(controller.update({ user: actor, params: { id: base._id }, body }, res, () => {}), 'VALIDATION_ERROR');
await rejectsCode(controller.update({ user: actor, params: { id: base._id }, body: { isActive: true } }, res, () => {}), 'FORBIDDEN_FIELD');
await rejectsCode(controller.update({ user: { ...actor, _id: 'foreign' }, params: { id: base._id }, body: { name: 'bad' } }, res, () => {}), 'FORBIDDEN');

const substitutions = [
  ['allow contact replacement', "if (actor.userType !== 'admin' && (!selfUpdate || !missingContact(user[field]))) delete candidate[field];", 'if (false) delete candidate[field];'],
  ['reject whole mixed update', 'const candidate: UpdateUserRequest = { ...input };', "if (selfUpdate && ('phone' in input || 'email' in input)) throw new AppError({ code: 'CONTACT_CHANGE_REQUIRED' });\n    const candidate: UpdateUserRequest = { ...input };"],
  ['validate before ignoring contacts', 'const candidate: UpdateUserRequest = { ...input };', "updateUserSchema.validate(input, { stripUnknown: true }).error && (() => { throw new AppError({ code: 'VALIDATION_ERROR' }); })();\n    const candidate: UpdateUserRequest = { ...input };"],
  ['remove missing-contact compare-and-set', "const additions = selfUpdate ? (['phone', 'email'] as const).filter(field => data[field] !== undefined) : [];", 'const additions: string[] = [];'],
];
const controls = [];
for (const [name, before, after] of substitutions) {
  assert.equal(sources.service.split(before).length, 2, 'exact one mutation site');
  const result = await runSuite(sources.service.replace(before, after));
  assert.ok(result.failures.length > 0, name + ' must be detected');
  controls.push({ name, failures: result.failures.map(item => item.name) });
}
const restored = await runSuite(sources.service);
assert.deepEqual(restored.failures, []);
console.log(JSON.stringify({ status: 'PASS', wholeServiceCases: nominal.passed.length, restoredCases: restored.passed.length, controllerCases: 7, cases: nominal.passed, controls,
  limits: ['Closed VM whole-service/controller policies with recording dependencies; stripped imports and service decorator', 'Joi is a recording stub; schema shape assertions are source-only', 'No HTTP/ODM/database/index/concurrent cross-account uniqueness/client/session/release proof'] }, null, 2));
