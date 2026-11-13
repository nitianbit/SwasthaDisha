/** Actual whole AuthService, closed recording ports; no application imports or providers. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { Script, createContext } from 'node:vm';

const sourcePath = new URL('../../src1/modules/auth/services/index.ts', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');
const allowedImports = [
  'node:crypto', '@/config/config', '@/modules/auth/types', '@/modules/corporates/repository',
  '@/modules/common/types', '@/modules/auth/validation', '@/modules/otp/services',
  '@/modules/admin/repository', '@/modules/admin/types', '@/modules/hr/repository', '@/modules/hr/types',
  '@/modules/user/repository', '@/modules/user/types', '@/modules/specialists/repository',
  '@/modules/specialists/types', '@/modules/pharmacies/repository', '@/modules/pharmacies/types',
  '@/modules/wallet/services', '@/modules/notification/services', '@/modules/email/services',
  '@/modules/sms/services', 'jsonwebtoken', 'typedi',
];
class AppError extends Error {
  constructor(details) { super(details.message); Object.assign(this, details); }
}
const clone = value => JSON.parse(JSON.stringify(value));
const base = { _id: 'customer-1', userType: 'user', email: 'old@example.test', phone: '9999999999' };
function fixture(text = source, options = {}) {
  const imports = [];
  let body = text.replace(/^import[\s\S]*?;\n/gm, statement => {
    const found = statement.match(/(?:from\s+)?['"]([^'"]+)['"];\s*$/);
    assert.ok(found, 'only static imports admitted'); imports.push(found[1]); return '';
  });
  assert.deepEqual(imports, allowedImports);
  assert.equal(body.match(/^@Service\(\)\n/gm)?.length, 1);
  body = body.replace(/^@Service\(\)\n/m, '').replace('export class AuthService', 'class AuthService');
  assert.doesNotMatch(body, /\b(?:require|import|eval)\s*\(|\bprocess\./);
  const state = { row: { ...base, ...(options.row || {}) }, sends: [], created: [], verified: [], writes: [], tokens: 0 };
  if (options.absent) delete state.row.email;
  const repo = {
    async findById() { return options.notFound ? null : { ...state.row }; },
    async findByAnyEmail() { return options.duplicate ? { _id: 'other' } : null; },
    async update(filter, values) {
      state.writes.push(clone({ filter, values }));
      if (options.race) state.row.email = 'admin-changed@example.test';
      if (Object.hasOwn(filter, 'email')) {
        const observed = filter.email;
        const matches = observed && typeof observed === 'object'
          ? observed.$exists === false && !Object.hasOwn(state.row, 'email')
          : observed === state.row.email;
        if (!matches) return null;
      }
      if (filter.$expr && Array.isArray(state.row.email)) return null;
      state.row = { ...state.row, ...values }; return { ...state.row };
    },
  };
  const otp = {
    async createOTP(input) { state.created.push(clone(input)); return input; },
    async verifyOTP(input) {
      state.verified.push(clone(input));
      if (options.otpError) throw new AppError({ code: 'OTP_EXPIRED' });
      return { targetValue: Object.hasOwn(options, 'proof') ? options.proof : input.targetValue };
    },
  };
  const corporate = { async findById() { return null; }, async findOne() { return { _id: 'corp-1' }; } };
  const context = createContext({ AppError, randomInt: () => 123456,
    CONFIG: Object.freeze({ OTP_EXPIRY_MINUTES: 10, JWT_SECRET_KEY: 'synthetic-fixture-key' }),
    jwt: { sign() { state.tokens++; return 'synthetic-token'; } },
    selectCustomerLoginContact() { throw Error('signup/login is not admitted by this fixture'); },
  }, { codeGeneration: { strings: false, wasm: false } });
  const js = stripTypeScriptTypes(body, { mode: 'transform', sourceUrl: String(sourcePath) });
  const Subject = new Script(js + '\n;globalThis.Subject = AuthService;', { filename: 'AuthService.ts' }).runInContext(context, { timeout: 1000 });
  const unused = Object.freeze({});
  const service = new Subject(repo, unused, unused, unused, unused, corporate, otp, unused, unused,
    { async sendEmail(input) { state.sends.push(clone(input)); } }, unused);
  return { service, state };
}
async function denied(promise, code) { await assert.rejects(promise, error => error.code === code); }
const checks = [];
const check = (name, body) => checks.push({ name, body });
check('send replacement denied before OTP and provider', async text => {
  const f = fixture(text); await denied(f.service.sendEmailVerificationOTP(base._id, { email: 'new@example.test' }), 'EMAIL_CHANGE_ADMIN_ONLY');
  assert.equal(f.state.created.length, 0); assert.equal(f.state.sends.length, 0);
});
check('send same normalized email remains usable', async text => {
  const f = fixture(text); await f.service.sendEmailVerificationOTP(base._id, { email: ' OLD@EXAMPLE.TEST ' });
  assert.equal(f.state.created[0].targetValue, base.email); assert.equal(f.state.sends.length, 1);
});
check('send missing email remains usable', async text => {
  const f = fixture(text, { absent: true }); await f.service.sendEmailVerificationOTP(base._id, { email: 'new@example.test' });
  assert.equal(f.state.created[0].targetValue, 'new@example.test'); assert.equal(f.state.sends.length, 1);
});
check('verify explicit replacement denied before consumption', async text => {
  const f = fixture(text); await denied(f.service.verifyEmailVerificationOTP(base._id, { email: 'new@example.test', otp: '123456' }), 'EMAIL_CHANGE_ADMIN_ONLY');
  assert.equal(f.state.verified.length, 0); assert.equal(f.state.writes.length, 0);
});
check('omitted verify target binds current stored email', async text => {
  const f = fixture(text); const result = await f.service.verifyEmailVerificationOTP(base._id, { otp: '123456' });
  assert.equal(f.state.verified[0].targetValue, base.email); assert.equal(result.user.email, base.email); assert.equal(f.state.tokens, 1);
});
check('recorded differing proof cannot replace email', async text => {
  const f = fixture(text, { proof: 'different@example.test' }); await denied(f.service.verifyEmailVerificationOTP(base._id, { otp: '123456' }), 'EMAIL_CHANGE_ADMIN_ONLY');
  assert.equal(f.state.writes.length, 0); assert.equal(f.state.tokens, 0);
});
for (const missing of ['absent', null, '']) check('missing email verification positive: ' + String(missing), async text => {
  const f = fixture(text, missing === 'absent' ? { absent: true, proof: 'new@example.test' } : { row: { email: missing }, proof: 'new@example.test' });
  const result = await f.service.verifyEmailVerificationOTP(base._id, { email: 'new@example.test', otp: '123456' });
  assert.equal(result.user.email, 'new@example.test'); assert.equal(result.user.isVerified, true);
  assert.deepEqual(f.state.writes[0].filter.$expr, { $in: [{ $type: '$email' }, ['missing', 'null', 'string']] });
});
check('raw observed email retained in compare-and-set', async text => {
  const f = fixture(text, { row: { email: 'OLD@EXAMPLE.TEST' } });
  await f.service.verifyEmailVerificationOTP(base._id, { email: base.email, otp: '123456' });
  assert.equal(f.state.writes[0].filter.email, 'OLD@EXAMPLE.TEST');
});
check('concurrent admin change returns conflict without signing', async text => {
  const f = fixture(text, { race: true }); await denied(f.service.verifyEmailVerificationOTP(base._id, { email: base.email, otp: '123456' }), 'CONTACT_CHANGED');
  assert.equal(f.state.row.email, 'admin-changed@example.test'); assert.equal(f.state.tokens, 0);
});
check('concurrent first addition returns conflict without signing', async text => {
  const f = fixture(text, { absent: true, race: true, proof: 'new@example.test' });
  await denied(f.service.verifyEmailVerificationOTP(base._id, { email: 'new@example.test', otp: '123456' }), 'CONTACT_CHANGED'); assert.equal(f.state.tokens, 0);
});
check('missing proof target is rejected', async text => {
  const f = fixture(text, { absent: true, proof: undefined }); await denied(f.service.verifyEmailVerificationOTP(base._id, { otp: '123456' }), 'EMAIL_VERIFICATION_NOT_INITIATED'); assert.equal(f.state.writes.length, 0);
});
check('duplicate new contact denied after proof', async text => {
  const f = fixture(text, { absent: true, duplicate: true, proof: 'new@example.test' });
  await denied(f.service.verifyEmailVerificationOTP(base._id, { email: 'new@example.test', otp: '123456' }), 'EMAIL_ALREADY_IN_USE'); assert.equal(f.state.writes.length, 0);
});
check('expired proof cannot update or sign', async text => {
  const f = fixture(text, { otpError: true }); await denied(f.service.verifyEmailVerificationOTP(base._id, { email: base.email, otp: '123456' }), 'OTP_EXPIRED'); assert.equal(f.state.writes.length, 0); assert.equal(f.state.tokens, 0);
});
check('missing user cannot issue challenge', async text => {
  const f = fixture(text, { notFound: true }); await denied(f.service.sendEmailVerificationOTP(base._id, { email: base.email }), 'USER_NOT_FOUND'); assert.equal(f.state.created.length, 0);
});
async function run(text) {
  const passed = [], failed = [];
  for (const { name, body } of checks) {
    try { await body(text); passed.push(name); } catch (error) { failed.push({ name, message: String(error) }); }
  }
  return { passed, failed };
}
const nominal = await run(source);
assert.deepEqual(nominal.failed, [], JSON.stringify(nominal.failed));
const mutations = [
  ['remove admin-only replacement rule', 'if (current && current !== target) {', 'if (false) {'],
  ['trust differing consumed proof', 'this.assertPersonalEmailVerificationTarget(user.email, verifiedEmail);', '/* weakened proof target check */'],
  ['remove final contact compare-and-set', "email: user.email === undefined ? { $exists: false } : user.email,", '/* weakened final email predicate */'],
  ['leave omitted verification destination unbound', 'this.normalizeEmail(data.email) || this.normalizeEmail(user.email)', 'this.normalizeEmail(data.email)'],
];
const controls = [];
for (const [name, before, after] of mutations) {
  assert.equal(source.split(before).length, 2, 'one exact control site');
  const result = await run(source.replace(before, after));
  assert.ok(result.failed.length, name + ' must fail a behavioral assertion');
  controls.push({ name, detectedBy: result.failed.map(item => item.name) });
}
const restored = await run(source);
assert.deepEqual(restored.failed, []);
console.log(JSON.stringify({ status: 'PASS', nominalCases: nominal.passed.length, restoredCases: restored.passed.length,
  cases: nominal.passed, controls,
  limits: ['Actual whole AuthService in closed VM with stripped imports/decorator and recording repository/OTP/provider/JWT ports',
    'No actual OTP consumption, Joi/JWT, HTTP, MongoDB, provider, session revocation or client evidence', 'Signup/login and corporate-only methods are not executed'] }, null, 2));
