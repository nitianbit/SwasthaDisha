import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { EXPRESS_VIEW_POLICY: policy, EXPRESS_VIEW_POLICY_SHA256: policyHash, createExpressViewGuard } = require('./disabled-express-template.cjs');
// Native Module/cache fixtures exercise the guard only. They do not execute Express.
function fixture(t) {
  const root = '/__sd_view_unit_' + randomUUID(), viewPath = root + '/' + policy.parent, entryPath = root + '/' + policy.entryParent;
  const cache = Module._cache, entry = new Module(entryPath); entry.filename = entryPath; cache[entryPath] = entry;
  const denial = Error('UNIT_EXPECTED_DENIAL'); let denied = 0, forwarded = 0, view;
  const guard = createExpressViewGuard(root, { [policy.parent]: policy.parentSha256, [policy.entryParent]: policy.entryParentSha256 }, () => { denied++; throw denial; });
  const exportFunction = function View() {};
  t.after(() => { Module._cache = cache; delete cache[entryPath]; delete cache[viewPath]; });
  function initialize({ requests = [...policy.initialLiteralRequests], loaded = true, outgoingError, incomingError, directResolve = false } = {}) {
    return guard.load('./view', entry, () => {
      guard.resolve('./view', entry);
      if (incomingError) throw incomingError;
      view = new Module(viewPath); view.filename = viewPath; cache[viewPath] = view;
      if (directResolve) guard.resolve('debug', view);
      for (const request of requests) guard.load(request, view, () => {
        guard.resolve(request, view); forwarded++; if (outgoingError) throw outgoingError; return {};
      });
      view.exports = exportFunction; view.loaded = loaded; return view.exports;
    });
  }
  return { root, cache, viewPath, entry, guard, initialize, exportFunction, denial, get view() { return view; }, get denied() { return denied; }, get forwarded() { return forwarded; } };
}
const denied = (f, action) => { const before = f.denied; assert.throws(action, error => error === f.denial); assert.equal(f.denied, before + 1); };
const permanentlyClosed = f => { const before = f.forwarded; denied(f, () => f.guard.assertSealed()); denied(f, () => f.initialize()); assert.equal(f.forwarded, before); };

test('one immutable canonical policy and no mutable guard control API', t => {
  const sorted = Object.fromEntries(Object.keys(policy).sort().map(key => [key, policy[key]]));
  assert.equal(createHash('sha256').update(JSON.stringify(sorted)).digest('hex'), policyHash);
  assert.ok(Object.isFrozen(policy)); for (const key of ['functionParameters', 'initialLiteralRequests', 'initialRequestCounts']) assert.ok(Object.isFrozen(policy[key]));
  const f = fixture(t); assert.deepEqual(Object.keys(f.guard), ['load', 'resolve', 'assertSealed']); assert.ok(Object.isFrozen(f.guard));
});
test('one ordered initialization seals the final exports function, distinct from initial Module.exports', t => {
  const f = fixture(t); assert.equal(f.initialize(), f.exportFunction); assert.equal(f.forwarded, 3); assert.equal(f.guard.assertSealed(), f.exportFunction);
});
for (const request of ['fs', 'node:fs', 'debug', 'path']) test('intact SEALED load and resolve deny before forwarding and retain readiness: ' + request, t => {
  const f = fixture(t); f.initialize(); const before = f.forwarded;
  denied(f, () => f.guard.load(request, f.view, () => { throw Error('FORBIDDEN_FORWARD'); })); assert.equal(f.guard.assertSealed(), f.exportFunction);
  denied(f, () => f.guard.resolve(request, f.view)); assert.equal(f.guard.assertSealed(), f.exportFunction); assert.equal(f.forwarded, before);
});
test('unrelated caught optional error retains exact identity and does not poison the guard', t => {
  const f = fixture(t); f.initialize(); const sentinel = Object.assign(Error('optional'), { code: 'MODULE_NOT_FOUND' });
  assert.throws(() => f.guard.load('optional', f.entry, () => { throw sentinel; }), error => error === sentinel); assert.equal(f.guard.assertSealed(), f.exportFunction);
});
for (const [name, options] of [ ['order', { requests: ['path', 'debug', 'fs'] }], ['duplicate', { requests: ['debug', 'debug', 'fs'] }],
  ['missing', { requests: ['debug', 'path'] }], ['extra', { requests: ['debug', 'path', 'fs', 'debug'] }],
  ['loaded false at completion', { loaded: false }], ['direct resolution without outgoing frame', { directResolve: true }] ]) test('initialization failure is irreversible: ' + name, t => {
  const f = fixture(t); denied(f, () => f.initialize(options)); permanentlyClosed(f);
});
for (const key of ['incomingError', 'outgoingError']) test('native initialization forward error retains identity and leaves FAILED: ' + key, t => {
  const f = fixture(t), sentinel = Error('ORIGINAL_NATIVE_ERROR'); assert.throws(() => f.initialize({ [key]: sentinel }), error => error === sentinel); permanentlyClosed(f);
});
test('readiness before initialization cannot later be repaired', t => { const f = fixture(t); denied(f, () => f.guard.assertSealed()); permanentlyClosed(f); });
test('a second incoming initializer cannot reopen a sealed window', t => { const f = fixture(t); f.initialize(); denied(f, () => f.initialize()); permanentlyClosed(f); });
for (const field of ['filename', 'id', 'loaded', 'exports']) test('accessor on genuine Module is denied without invocation and restoration cannot recover: ' + field, t => {
  const f = fixture(t); f.initialize(); const descriptor = Object.getOwnPropertyDescriptor(f.view, field); let getters = 0;
  Object.defineProperty(f.view, field, { configurable: true, enumerable: descriptor.enumerable, get() { getters++; throw Error('GETTER_INVOKED'); } });
  try { denied(f, () => f.guard.load('fs', f.view, () => {})); assert.equal(getters, 0); }
  finally { Object.defineProperty(f.view, field, descriptor); }
  permanentlyClosed(f);
});
for (const field of ['filename', 'id', 'loaded', 'exports']) test('changed genuine Module data irreversibly fails: ' + field, t => {
  const f = fixture(t); f.initialize(); const before = f.view[field]; f.view[field] = field === 'loaded' ? false : field === 'exports' ? function replacement() {} : '/changed';
  denied(f, () => f.guard.assertSealed()); f.view[field] = before; permanentlyClosed(f);
});
test('fake native Module with target filename cannot replace the captured identity', t => {
  const f = fixture(t); f.initialize(); const fake = new Module(f.viewPath); fake.filename = f.viewPath; fake.loaded = true; fake.exports = f.exportFunction;
  denied(f, () => f.guard.load('fs', fake, () => {})); permanentlyClosed(f);
});
test('proxy parent does not invoke observable traps', t => {
  const f = fixture(t); f.initialize(); let traps = 0; const parent = new Proxy(f.view, { get() { traps++; }, getPrototypeOf() { traps++; }, getOwnPropertyDescriptor() { traps++; } });
  denied(f, () => f.guard.load('fs', parent, () => {})); assert.equal(traps, 0); permanentlyClosed(f);
});
for (const mutation of ['getter', 'replace', 'delete', 'cache-proxy']) test('cache integrity fails closed without recovery: ' + mutation, t => {
  const f = fixture(t); f.initialize(); const descriptor = Object.getOwnPropertyDescriptor(f.cache, f.viewPath); let traps = 0;
  try {
    if (mutation === 'getter') Object.defineProperty(f.cache, f.viewPath, { configurable: true, get() { traps++; return f.view; } });
    if (mutation === 'replace') f.cache[f.viewPath] = new Module(f.viewPath);
    if (mutation === 'delete') delete f.cache[f.viewPath];
    if (mutation === 'cache-proxy') Module._cache = new Proxy(f.cache, { getOwnPropertyDescriptor() { traps++; } });
    denied(f, () => f.guard.assertSealed()); assert.equal(traps, 0);
  } finally { Module._cache = f.cache; Object.defineProperty(f.cache, f.viewPath, descriptor); }
  permanentlyClosed(f);
});
test('changed native Module prototype remains failed after external restoration', t => {
  const f = fixture(t); f.initialize(); const prototype = Object.getPrototypeOf(f.view); Object.setPrototypeOf(f.view, {});
  denied(f, () => f.guard.assertSealed()); Object.setPrototypeOf(f.view, prototype); permanentlyClosed(f);
});
// The separately reviewed stager supplies four owned, inert template directories.
// These calls traverse real prepared-source admission and fail before workspace/executor allocation.
for (const role of ['auth', 'private', 'contact', 'refill']) test('actual prepared-source boundary confines helper to intended roles: ' + role, async () => {
  const data = JSON.parse(readFileSync(new URL('./disabled-express-source-admission.json', import.meta.url)));
  assert.equal(data.schema, 'SD-DISABLED-EXPRESS-SOURCE-UNIT-FIXTURES-1'); assert.equal(data.roles.length, 4);
  const platform = await import('./platform.mjs');
  const create = { auth: platform.createApiRuntimeFixture, private: platform.createPrivateDocumentRuntimeFixture,
    contact: platform.createCustomerContactRuntimeFixture, refill: platform.createPharmacyRefillRuntimeFixture }[role];
  // All inert descriptors are structurally valid and name the same exact helper source.
  // Contact/refill pass that source gate then reject the intentionally empty domain case plan.
  assert.throws(() => create({ endpoint: platform.PROFILE.endpoint }), role === 'auth' || role === 'private'
    ? /Current production source differs from template/ : /Incomplete API case plan/);
});
