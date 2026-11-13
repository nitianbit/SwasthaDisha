/** Whole actual controllers under closed recording ports; no application graph or HTTP/DB/provider imports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('../../', import.meta.url);
const paths = {
  ordinary: 'src1/modules/bookings/controller/index.ts',
  external: 'src1/modules/externalBookings/controller/index.ts',
};
const sources = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(new URL(path, root), 'utf8')]));
const imports = {
  ordinary: ['reflect-metadata', 'express', 'typedi', '@/modules/common/types', '@/modules/common/utils/dateUtils', '@/modules/bookings/services', '@/modules/dependents/services', '@/modules/middleware/auth', '@/modules/bookings/types'],
  external: ['reflect-metadata', 'express', 'typedi', '@/modules/middleware/auth', '@/modules/common/types', '@/modules/externalBookings/services', '@/modules/dependents/services', '@/modules/user/model', '@/modules/externalBookings/utils/helpers', '@/config/config', '@/services/logger', '@/modules/externalBookings/types'],
};
class AppError extends Error { constructor(details) { super(details.message); Object.assign(this, details); } }
const actor = { _id: '111111111111111111111111', userType: 'user' };
const dependentId = '222222222222222222222222';
const foreign = '333333333333333333333333';
const classNames = { ordinary: 'BookingController', external: 'ExternalBookingController' };
const createMethods = {
  ordinary: ['createBooking', 'createWellnessPackageBooking', 'createSpecialistBooking'],
  external: ['createBooking', 'createDiagnosticsBooking'],
};
const json = value => JSON.parse(JSON.stringify(value));
function fixture(kind, source, options = {}) {
  const events = [];
  class BookingService {}
  class ExternalBookingService {}
  class DependentService {}
  const calls = [];
  const service = Object.fromEntries(createMethods[kind].map(method => [method, async data => {
    events.push('create'); calls.push({ method, data: json(data) }); return { paymentRequired: false, booking: data };
  }]));
  service.getById = async (...args) => { events.push('detail'); calls.push({ method: 'getById', args: json(args) }); return { _id: 'booking', userId: actor._id }; };
  service.getAll = async (...args) => { events.push('list'); calls.push({ method: 'getAll', args: json(args) }); return { data: [] }; };
  service.listBookings = async (...args) => { events.push('list'); calls.push({ method: 'listBookings', args: json(args) }); return { data: [] }; };
  const dependent = { async getById(id, owner) {
    events.push('dependent');
    assert.equal(id, dependentId); assert.equal(owner, actor._id);
    if (options.foreign) throw new AppError({ status: 404, code: 'DEPENDENT_NOT_FOUND' });
    return { _id: id, userId: owner, ...(options.legacyActive ? {} : { isActive: !options.inactive }) };
  } };
  const ports = {
    AppError, BookingService, ExternalBookingService, DependentService,
    getTodayYyyymmdd: () => '20261113', CONFIG: { EXTERNAL_BOOKING_DEFAULT_INTEGRATION: 'labstack' },
    logger: { info() {} }, calculateAgeFromDob: () => '30', toLabstackGender: () => 'male',
    UserModel: { findById(id) {
      events.push('user-read'); assert.ok(typeof id === 'string');
      return { select() { return this; }, async lean() { return { name: 'Patient', email: 'patient@example.test', phone: '9999999999' }; } };
    } },
    Container: { get(klass) {
      if (klass === DependentService) return dependent;
      assert.equal(klass, kind === 'ordinary' ? BookingService : ExternalBookingService);
      return service;
    } },
  };
  const found = [];
  let body = source.replace(/^import\s[\s\S]*?;\n/gm, line => {
    const match = line.match(/(?:from\s+)?['"]([^'"]+)['"];\s*$/);
    assert.ok(match, 'exact static import'); found.push(match[1]); return '';
  });
  assert.deepEqual(found, imports[kind], 'closed ordered imports');
  assert.doesNotMatch(body, /\b(?:import|require|eval)\s*\(|\bprocess\./);
  assert.equal(body.split('export class ').length, 2);
  body = body.replace('export class ', 'class ');
  const script = stripTypeScriptTypes(body, { mode: 'transform', sourceUrl: paths[kind] });
  const context = createContext(ports, { codeGeneration: { strings: false, wasm: false } });
  const Controller = new Script(script + '\n;globalThis.Subject = ' + classNames[kind], { filename: paths[kind] }).runInContext(context, { timeout: 1000 });
  const controller = new Controller();
  const result = {};
  const res = { status(code) { result.code = code; return this; }, json(value) { result.body = json(value); } };
  return { controller, events, calls, result, res };
}
const cases = [];
const check = (name, body) => cases.push({ name, body });
const request = (user = actor, body = {}) => ({ user, body, query: {}, params: { id: 'booking' } });
async function rejectsCode(promise, code) { await assert.rejects(promise, error => error.code === code); }
for (const kind of ['ordinary', 'external']) {
  for (const method of createMethods[kind]) {
    check(kind + '/' + method + ' uses signed owner and ignores fabricated association', async variants => {
      const f = fixture(kind, variants[kind]);
      await f.controller[method](request(actor, { userId: foreign, corporateId: 'fabricated' }), f.res, () => {});
      assert.equal(f.result.code, 201); assert.equal(f.calls[0].data.userId, actor._id);
      assert.equal(f.calls[0].data.corporateId, undefined); assert.ok(!f.events.includes('dependent'));
    });
    check(kind + '/' + method + ' retains signed association and owned dependent', async variants => {
      const f = fixture(kind, variants[kind]);
      await f.controller[method](request({ ...actor, corporateId: 'signed' }, { dependentId, corporateId: 'fabricated' }), f.res, () => {});
      assert.equal(f.calls[0].data.corporateId, 'signed'); assert.equal(f.events[0], 'dependent');
      assert.equal(f.calls[0].data.dependentId, dependentId);
    });
    for (const [name, body, options] of [
      ['malformed', { dependentId: 'bad' }, {}], ['foreign', { dependentId }, { foreign: true }], ['inactive', { dependentId }, { inactive: true }],
    ]) check(kind + '/' + method + ' denies ' + name + ' dependent before user/service effects', async variants => {
      const f = fixture(kind, variants[kind], options);
      await rejectsCode(f.controller[method](request(actor, body), f.res, () => {}), 'DEPENDENT_NOT_FOUND');
      assert.ok(!f.events.includes('user-read')); assert.ok(!f.events.includes('create')); assert.equal(f.calls.length, 0);
    });
    check(kind + '/' + method + ' denies missing actor before every read/effect', async variants => {
      const f = fixture(kind, variants[kind]);
      await rejectsCode(f.controller[method](request(null, { userId: actor._id, dependentId }), f.res, () => {}), 'UNAUTHORIZED');
      assert.deepEqual(f.events, []);
    });
    check(kind + '/' + method + ' retains admin target and association', async variants => {
      const f = fixture(kind, variants[kind]);
      await f.controller[method](request({ _id: 'admin', userType: 'admin' }, { userId: foreign, corporateId: 'chosen' }), f.res, () => {});
      assert.equal(f.calls[0].data.userId, foreign); assert.equal(f.calls[0].data.corporateId, 'chosen');
    });
  }
}
for (const method of createMethods.ordinary) check('ordinary/' + method + ' retains pharmacy target', async variants => {
  const f = fixture('ordinary', variants.ordinary);
  await f.controller[method](request({ _id: 'staff', userType: 'pharmacy', pharmacyId: 'pharmacy', corporateId: 'signed' }, { userId: foreign }), f.res, () => {});
  assert.equal(f.calls[0].data.userId, foreign); assert.equal(f.calls[0].data.pharmacyId, 'pharmacy'); assert.equal(f.calls[0].data.corporateId, 'signed');
});
check('ordinary detail binds signed owner', async variants => {
  const f = fixture('ordinary', variants.ordinary);
  await f.controller.getById(request(), f.res, () => {});
  assert.deepEqual(f.calls[0].args, ['booking', actor._id]);
});
check('ordinary detail rejects foreign query before service', async variants => {
  const f = fixture('ordinary', variants.ordinary); const req = request(); req.query.userId = foreign;
  await rejectsCode(f.controller.getById(req, f.res, () => {}), 'FORBIDDEN'); assert.deepEqual(f.events, []);
});
check('ordinary list retains signed owner with requested status', async variants => {
  const f = fixture('ordinary', variants.ordinary); const req = request(); req.query = { userId: foreign, status: 'confirmed' };
  await f.controller.getAll(req, f.res, () => {});
  assert.equal(f.calls[0].args[0].userId, actor._id); assert.equal(f.calls[0].args[0].status, 'confirmed');
});
check('external list cannot replace signed owner from query', async variants => {
  const f = fixture('external', variants.external); const req = request(); req.query = { userId: foreign, status: 'confirmed' };
  await f.controller.listBookings(req, f.res, () => {});
  assert.equal(f.calls[0].args[0].userId, actor._id); assert.equal(f.calls[0].args[0].status, 'confirmed');
});
check('external list rejects missing actor before service', async variants => {
  const f = fixture('external', variants.external);
  await rejectsCode(f.controller.listBookings({ body: {}, query: { userId: actor._id }, params: {} }, f.res, () => {}), 'UNAUTHORIZED');
  assert.deepEqual(f.events, []);
});
check('external list retains admin target', async variants => {
  const f = fixture('external', variants.external); const req = request({ _id: 'admin', userType: 'admin' }); req.query.userId = foreign;
  await f.controller.listBookings(req, f.res, () => {}); assert.equal(f.calls[0].args[0].userId, foreign);
});
async function suite(variants) {
  const passed = [], failed = [];
  for (const entry of cases) {
    try { await entry.body(variants); passed.push(entry.name); }
    catch (error) { failed.push({ name: entry.name, error: String(error) }); }
  }
  return { passed, failed };
}
const nominal = await suite(sources);
assert.deepEqual(nominal.failed, [], JSON.stringify(nominal.failed));
const mutants = [
  ['ordinary', 'remove dependent guard', '    await this.assertCustomerDependentOwner(req);\n', ''],
  ['ordinary', 'restore fabricated association fallback', '          : req.user?.corporateId,', '          : req.user?.corporateId || req.body.corporateId,'],
  ['external', 'allow inactive dependent', 'if (dependent.isActive === false)', 'if (false)'],
  ['external', 'restore list missing-actor fallback', 'const actor = this.requireBookingActor(req);\n    const effectiveUserId', "const actor = req.user || { _id: req.query.userId, userType: 'user' };\n    const effectiveUserId"],
];
const controls = [];
for (const [kind, name, before, after] of mutants) {
  assert.ok(sources[kind].includes(before), 'mutation site exists');
  const changed = { ...sources, [kind]: sources[kind].replaceAll(before, after) };
  const result = await suite(changed);
  assert.ok(result.failed.length, name + ' must be detected');
  controls.push({ name, failures: result.failed.map(item => item.name) });
}
const restored = await suite(sources);
assert.deepEqual(restored.failed, []);
console.log(JSON.stringify({ status: 'PASS', wholeControllerCases: nominal.passed.length, restoredCases: restored.passed.length, cases: nominal.passed, controls,
  limits: ['Actual whole controllers transformed after exact import allowlist erasure with closed VM recording services/DI/UserModel/DependentService', 'No application graph, real Joi/HTTP/ODM/DB/provider/client checks; no dependent consent/activity TOCTOU proof', 'List checks prove forwarded predicates, not database evaluation of them'] }, null, 2));
