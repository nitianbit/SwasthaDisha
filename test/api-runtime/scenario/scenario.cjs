'use strict';
// Evaluated only by the fully admitted container bootstrap. Never print fixtures,
// responses, OTPs, tokens, keys, database rows or assertion operands.
const http = require('node:http');
const crypto = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function requireConfigurationEvidence(evidence, need) {
  if (typeof need !== 'function') throw new Error('JWT_CONFIG_EVIDENCE_CHECKER_REQUIRED');
  const configurationCaseIds = ['JWT_CONFIG_UNSET_DENIED', 'JWT_CONFIG_BLANK_DENIED', 'JWT_CONFIG_PLACEHOLDERS_DENIED',
    'JWT_CONFIG_VALID_VALUE', 'JWT_CONFIG_PADDED_VALUE_UNCHANGED', 'JWT_CONFIG_NONPLACEHOLDER_VALUES'];
  const configurationSensitivityIds = ['JWT_CONFIG_PUBLISHED_FALLBACK', 'JWT_CONFIG_PRODUCTION_ONLY_GUARD', 'JWT_CONFIG_TRIMMED_RETURN'];
  function frozenData(value, names) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value) || Object.getOwnPropertySymbols(value).length !== 0
      || JSON.stringify(Object.getOwnPropertyNames(value).sort()) !== JSON.stringify(names.slice().sort())) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors).every(row => Object.hasOwn(row, 'value')) ? descriptors : null;
  }
  function configurationRows(rows, names, field, expected) {
    return Array.isArray(rows) && Object.isFrozen(rows) && Object.getOwnPropertySymbols(rows).length === 0
      && JSON.stringify(Object.getOwnPropertyNames(rows).sort()) === JSON.stringify([...names.map((_, i) => String(i)), 'length'].sort())
      && rows.length === names.length && names.every((name, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
        const values = frozenData(descriptor.value, ['id', field]);
        return values?.id.value === name && values[field].value === expected;
      });
  }
  const configuration = frozenData(evidence, ['cases', 'sensitivity']);
  need(configuration && configurationRows(configuration.cases.value, configurationCaseIds, 'status', 'PASS')
    && configurationRows(configuration.sensitivity.value, configurationSensitivityIds, 'detected', true), 'JWT_CONFIG_EVIDENCE');
  return evidence;
}

async function runScenario(ctx) {
  const { mongoose, need } = ctx;
  const model = name => mongoose.model(name);
  const uid = () => new mongoose.Types.ObjectId().toString();
  const id = row => String(row._id);
  const cases = []; const sensitivity = [];
  const completedProofs = new Map();
  const record = name => { need(!cases.some(row => row.id === name), 'DUPLICATE_CASE'); cases.push({ id: name, status: 'PASS' }); };
  const configuration = requireConfigurationEvidence(ctx.configurationEvidence, need);
  const request = (method, route, token, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: ctx.port, path: '/api/v1' + route,
      method, agent: false, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; if (data.length > 131072) req.destroy(new Error('RESPONSE_LIMIT')); });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { reject(new Error('RESPONSE_JSON')); } });
    });
    req.setTimeout(8000, () => req.destroy(new Error('HTTP_TIMEOUT')));
    req.once('error', reject); if (payload) req.write(payload); req.end();
  });
  function errorEnvelope(response, code) {
    need(response.body && Object.getPrototypeOf(response.body) === Object.prototype
      && JSON.stringify(Object.keys(response.body).sort()) === JSON.stringify(['code', 'error', 'message'])
      && response.body.error === response.status && typeof response.body.message === 'string'
      && response.body.code === code, 'ERROR_ENVELOPE');
  }
  const providerState = () => ['email', 'sms', 'push', 'calendar', 'unexpected', 'excluded', 'jwtIssued', 'dbWrites'].map(k => ctx.counters[k]);
  async function snapshot(includeOTP = true) {
    const names = ctx.ports.models.map(row => row.name).filter(name => includeOTP || name !== 'OTP');
    const rows = await Promise.all(names.map(name => model(name).find({}).sort({ _id: 1 }).lean().exec()));
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  async function deny(method, route, token, body, statuses, code, expectedCode) {
    const before = await snapshot(); const effects = providerState();
    const response = await request(method, route, token, body);
    need(statuses.includes(response.status) && !response.body?.data?.token, code + '_STATUS');
    const expected = expectedCode || ({ 400: 'VALIDATION_ERROR', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'WALLET_NOT_FOUND', 422: 'FORBIDDEN_FIELD' })[response.status];
    errorEnvelope(response, expected);
    need(await snapshot() === before, code + '_STATE');
    need(JSON.stringify(providerState()) === JSON.stringify(effects), code + '_EFFECTS');
    return response;
  }
  const actor = payload => ctx.originalSign(payload, ctx.key, { expiresIn: '5m' });
  const makeUser = data => model('User').create({ userType: 'user', name: 'Synthetic Fixture', ...data });
  async function login(contact, userType = 'user') {
    const deliveredBefore = ctx.deliveries.length;
    const sent = await request('POST', '/auth/' + userType + '/send', undefined, contact);
    need(sent.status === 200 && ctx.deliveries.length === deliveredBefore + 1, 'REAL_DELIVERY_REQUIRED');
    const delivery = ctx.deliveries[deliveredBefore];
    need(delivery.kind === (contact.phone ? 'sms' : 'email'), 'REAL_DELIVERY_CHANNEL');
    need(delivery.destination === (contact.phone ? '91' + contact.phone : contact.email.toLowerCase()), 'REAL_DELIVERY_DESTINATION');
    const result = await request('POST', '/auth/' + userType + '/verify', undefined, { ...contact, otp: delivery.code });
    need(result.status === 200 && typeof result.body?.data?.token === 'string', 'REAL_LOGIN_FAILED');
    return { token: result.body.data.token, user: result.body.data.user, code: delivery.code };
  }
  async function challenge(user, options = {}) {
    const target = options.target || (user.phone ? 'phone' : 'email');
    const code = String(crypto.randomInt(100000, 1000000));
    const row = await model('OTP').create({ userId: user._id, otp: code, target,
      ...(options.unbound ? {} : { targetValue: options.destination || user[target] }),
      expireAt: options.expireAt || new Date(Date.now() + 60000), isVerified: options.verified || false });
    completedProofs.set(id(row), String(user._id));
    return { row, code, contact: { [target]: user[target] } };
  }
  async function cleanCompletedProofs() {
    // Called only after all associated requests/schedulers completed. A TTL-
    // removed exact proof may already be absent; no assertion diff is ignored.
    for (const [proofId, ownerId] of completedProofs) {
      await model('OTP').deleteOne({ _id: proofId, userId: ownerId });
      completedProofs.delete(proofId);
    }
  }
  async function rejectChallenge(user, options, caseId, statuses) {
    const c = await challenge(user, options); const before = await snapshot(false); const effects = providerState();
    const result = await request('POST', '/auth/user/verify', undefined, { ...c.contact, otp: options.wrong ? '000000' : c.code });
    need(statuses.includes(result.status) && !result.body?.data?.token, caseId + '_STATUS');
    const expected = result.status === 404 ? 'OTP_NOT_FOUND' : options.verified ? 'OTP_ALREADY_VERIFIED' : 'OTP_EXPIRED';
    errorEnvelope(result, expected);
    need(await snapshot(false) === before && JSON.stringify(providerState()) === JSON.stringify(effects), caseId + '_SIDE_EFFECTS');
    const actual = await model('OTP').findById(c.row._id).lean().exec();
    need((options.expireAt && options.expireAt <= new Date() && !actual) || (actual && actual.isVerified === Boolean(options.verified)), caseId + '_PROOF_UNCHANGED');
    if (options.expireAt) await model('OTP').deleteOne({ _id: c.row._id });
    record(caseId);
  }

  // Deterministic scheduling wraps real Query.exec. It never supplies or changes
  // a DB result: both selected pending proofs really came from MongoDB.
  async function overlap(user, mutant = false) {
    const c = await challenge(user); const proto = mongoose.Query.prototype; const original = proto.exec;
    let arrivals = 0; let release; const ready = new Promise(resolve => { release = resolve; });
    const timeout = setTimeout(() => release(), 4000);
    proto.exec = async function (...args) {
      const result = await original.apply(this, args);
      if (this.model.modelName === 'OTP' && this.op === 'findOne' && this.getFilter().otp === c.code) {
        arrivals++; if (arrivals === 2) release(); await ready;
      }
      return result;
    };
    const writesBefore = { ...ctx.writeOps };
    const providersBefore = ['email', 'sms', 'push', 'unexpected', 'excluded'].map(name => ctx.counters[name]);
    const tokens = ctx.counters.jwtIssued; const notifications = await model('Notification').countDocuments({ userId: id(user), type: 'login' });
    const wallets = await model('Wallet').countDocuments({ userId: id(user) });
    let results;
    try { results = await Promise.all([1, 2].map(() => request('POST', '/auth/user/verify', undefined, { ...c.contact, otp: c.code }))); }
    finally { proto.exec = original; clearTimeout(timeout); }
    need(arrivals === 2, 'OVERLAP_NOT_ESTABLISHED');
    const successes = results.filter(r => r.status === 200 && typeof r.body?.data?.token === 'string').length;
    const expected = mutant ? 2 : 1;
    need(successes === expected && ctx.counters.jwtIssued - tokens === expected, 'OVERLAP_ISSUANCE_COUNT');
    if (!mutant) {
      const failures = results.filter(r => r.status === 400); need(failures.length === 1, 'OVERLAP_LOSER_DENIAL');
      errorEnvelope(failures[0], 'OTP_UNAVAILABLE');
    }
    need(JSON.stringify(['email', 'sms', 'push', 'unexpected', 'excluded'].map(name => ctx.counters[name]))
      === JSON.stringify(providersBefore), 'OVERLAP_PROVIDER_EFFECTS');
    for (const collection of Object.keys(writesBefore)) {
      const expectedWrites = collection === 'OTP' ? 2 : ['users', 'notifications'].includes(collection) ? expected : 0;
      need(ctx.writeOps[collection] - writesBefore[collection] === expectedWrites, 'OVERLAP_COLLECTION_WRITES');
    }
    need(await model('Notification').countDocuments({ userId: id(user), type: 'login' }) === notifications + expected, 'OVERLAP_NOTIFICATION_COUNT');
    need(await model('Wallet').countDocuments({ userId: id(user) }) === wallets && wallets === 1, 'OVERLAP_WALLET_UNCHANGED');
    const stored = await model('OTP').findById(c.row._id).lean().exec(); need(stored?.isVerified === true, 'OVERLAP_CONSUMED');
    return successes;
  }
  async function targetProbe(mutant = false) {
    const user = await makeUser({ email: 'target-' + uid() + '@example.com' });
    const c = await challenge(user, { target: 'email' }); const next = 'changed-' + uid() + '@example.com';
    await model('User').updateOne({ _id: user._id }, { $set: { email: next } });
    const before = await snapshot(false); const effects = providerState();
    const response = await request('POST', '/auth/user/verify', undefined, { email: next, otp: c.code });
    if (mutant) need(response.status === 200 && response.body?.data?.token, 'TARGET_MUTANT_NOT_DETECTED');
    else {
      need(response.status === 404, 'TARGET_BINDING_STATUS'); errorEnvelope(response, 'OTP_NOT_FOUND');
      need(await snapshot(false) === before && JSON.stringify(providerState()) === JSON.stringify(effects), 'TARGET_BINDING_SIDE_EFFECTS');
      need((await model('OTP').findById(c.row._id).lean().exec()).isVerified === false, 'TARGET_BINDING_PROOF');
    }
  }

  // Additional authority cases use actual HTTP and all admitted collections.
  // Observations are private so even intentional mutant results never escape.
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function authorityRows() {
    const entries = await Promise.all(ctx.ports.models.map(async spec => [spec.name,
      await model(spec.name).find({}).sort({ _id: 1 }).lean().exec()]));
    return Object.fromEntries(entries);
  }
  async function observe(method, route, token, body) {
    const before = await authorityRows(); const countersBefore = { ...ctx.counters };
    const readsBefore = { ...ctx.readOps }; const writesBefore = { ...ctx.writeOps }; const pushStart = ctx.pushes.length;
    const result = await request(method, route, token, body);
    const countersAfter = { ...ctx.counters }; const readsAfter = { ...ctx.readOps }; const writesAfter = { ...ctx.writeOps };
    const pushes = ctx.pushes.slice(pushStart);
    const after = await authorityRows();
    const delta = (next, prior) => Object.fromEntries(Object.keys(prior).map(key => [key, next[key] - prior[key]]));
    return { result, before, after, pushes, effects: delta(countersAfter, countersBefore),
      reads: delta(readsAfter, readsBefore), writes: delta(writesAfter, writesBefore) };
  }
  function unchangedOutside(observed, permitted = {}) {
    for (const spec of ctx.ports.models) {
      const ids = new Set(permitted[spec.name] || []);
      const retain = rows => rows.filter(row => !ids.has(id(row)));
      const digest = rows => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      need(digest(retain(observed.before[spec.name])) === digest(retain(observed.after[spec.name])), 'AUTHORITY_UNRELATED_STATE');
    }
  }
  function effects(observed, expectedWrites = {}, push = 0, logger = 0, calendar = 0) {
    for (const [collection, count] of Object.entries(observed.writes))
      need(count === (expectedWrites[collection] || 0), 'AUTHORITY_WRITE_COUNTS');
    need(observed.effects.dbWrites === Object.values(expectedWrites).reduce((sum, n) => sum + n, 0), 'AUTHORITY_TOTAL_WRITES');
    for (const key of ['email', 'sms', 'jwtIssued', 'unexpected', 'excluded']) need(observed.effects[key] === 0, 'AUTHORITY_EFFECTS');
    need(observed.effects.push === push && observed.pushes.length === push && observed.effects.logger === logger
      && observed.effects.calendar === calendar, 'AUTHORITY_RECORDING_COUNTS');
  }
  function assertDenied(observed, status, code, beforeLookup = false) {
    need(observed.result.status === status, 'AUTHORITY_DENIAL_STATUS'); errorEnvelope(observed.result, code);
    unchangedOutside(observed); effects(observed, {}, 0, 1);
    if (beforeLookup) need(Object.values(observed.reads).every(value => value === 0), 'AUTHORITY_PRELOOKUP_READS');
  }
  async function authorityDeny(method, route, token, body, status, code, beforeLookup = false) {
    const observed = await observe(method, route, token, body); assertDenied(observed, status, code, beforeLookup); return observed;
  }
  function assertSuccess(observed, status, permitted = {}, writes = {}, push = 0, logger = 0) {
    need(observed.result.status === status && observed.result.body?.success === true, 'AUTHORITY_SUCCESS_STATUS');
    unchangedOutside(observed, permitted); effects(observed, writes, push, logger);
  }
  async function readSuccess(route, token) {
    const observed = await observe('GET', route, token); assertSuccess(observed, 200); return observed.result.body;
  }
  function ownerRows(body, owner) {
    need(Array.isArray(body.data) && body.data.every(row => row.userId === owner), 'AUTHORITY_LIST_OWNER');
    return body.data;
  }
  function totalRows(body, total) { need(body.pagination?.total === total, 'AUTHORITY_LIST_TOTAL'); }
  function stored(observed, name, rowId) { return observed.after[name].find(row => id(row) === rowId); }
  function onlyFields(observed, name, rowId, fields) {
    const prior = observed.before[name].find(row => id(row) === rowId); const next = stored(observed, name, rowId);
    const retained = row => Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
    need(prior && next && same(retained(prior), retained(next)), 'AUTHORITY_UNINTENDED_FIELDS');
  }
  function inserted(observed, name, rowId) {
    need(!observed.before[name].some(row => id(row) === rowId) && stored(observed, name, rowId), 'AUTHORITY_INSERTED_ROW');
  }
  function assertPayloads(observed, expected) {
    const normalize = payload => ({ tokens: payload.tokens.slice().sort(), notification: payload.notification,
      ...(payload.data === undefined ? {} : { data: Object.fromEntries(Object.entries(payload.data).sort(([a], [b]) => a.localeCompare(b))) }) });
    let matches = false;
    try { matches = same(observed.pushes.map(normalize), expected.map(normalize)); } catch { /* Fixed code only. */ }
    if (!matches) { ctx.counters.unexpected++; need(false, 'AUTHORITY_PUSH_PAYLOAD'); }
  }
  const depBody = owner => ({ userId: owner, name: 'Synthetic ' + uid(), relationship: 'Friend' });
  const noteBody = owner => ({ userId: owner, type: 'general', title: 'Synthetic notice', message: 'Synthetic fixture only' });
  const seedDependent = (owner, data = {}) => model('Dependent').create({ ...depBody(owner), ...data });
  const seedNote = (owner, data = {}) => model('Notification').create({ ...noteBody(owner), isRead: false, ...data });
  async function createDependent(token, owner, data = {}) {
    const body = { ...depBody(owner), ...data }; const observed = await observe('POST', '/dependents', token, body);
    const rowId = observed.result.body?.data?._id;
    need(typeof rowId === 'string', 'DEPENDENT_CREATED_ID');
    assertSuccess(observed, 201, { Dependent: [rowId] }, { dependents: 1 });
    inserted(observed, 'Dependent', rowId);
    const row = stored(observed, 'Dependent', rowId);
    need(row?.userId === owner && row.name === body.name.trim() && row.relationship === body.relationship, 'DEPENDENT_CREATE_STATE');
    return row;
  }
  async function registerToken(token, owner, role = 'user') {
    const value = 'synthetic-fixture-' + uid();
    const observed = await observe('POST', '/fcm/token', token, { token: ' ' + value + ' ', platform: 'web', deviceId: ' synthetic-device ', userId: uid(), userType: 'admin' });
    const rowId = observed.result.body?.data?.token?._id;
    need(typeof rowId === 'string', 'FCM_CREATED_ID');
    assertSuccess(observed, 201, { FcmToken: [rowId] }, { fcmtokens: 1 });
    inserted(observed, 'FcmToken', rowId);
    const row = stored(observed, 'FcmToken', rowId);
    need(row?.token === value && row.userId === owner && row.userType === role && row.platform === 'web'
      && row.deviceId === 'synthetic-device' && row.isActive === true, 'FCM_TOKEN_OWNER_STATE');
    return value;
  }
  const testPush = tokens => ({ tokens, notification: { title: 'Booking Successful',
    body: 'Your booking has been confirmed successfully. We will confirm it shortly.' }, data: { type: 'test' } });
  const dependentRoutes = (owner, rowId) => [
    ['POST', '/dependents', depBody(owner)], ['GET', '/dependents'], ['GET', '/dependents/user/' + owner],
    ['GET', '/dependents/user/' + owner + '/active'], ['GET', '/dependents/' + rowId],
    ['PUT', '/dependents/' + rowId, { name: 'Edited synthetic' }], ['DELETE', '/dependents/' + rowId],
  ];
  const genericNoteRoutes = rowId => [['GET', '/notifications/' + rowId], ['PUT', '/notifications/' + rowId, { isRead: true }],
    ['PATCH', '/notifications/' + rowId + '/read'], ['DELETE', '/notifications/' + rowId]];
  const strictNoteRoutes = owner => [['GET', '/notifications/user/' + owner], ['GET', '/notifications/user/' + owner + '/unread'],
    ['GET', '/notifications/user/' + owner + '/unread-count'], ['PATCH', '/notifications/user/' + owner + '/read-all']];
  async function noteMutation(method, route, token, row, body) {
    const observed = await observe(method, route, token, body); const rowId = id(row);
    assertSuccess(observed, 200, { Notification: [rowId] }, { notifications: 1 });
    const changed = stored(observed, 'Notification', rowId);
    if (method === 'DELETE') need(!changed, 'NOTIFICATION_DELETED_STATE');
    else {
      onlyFields(observed, 'Notification', rowId, ['isRead', 'readAt', 'updatedAt']);
      need(changed?.userId === row.userId && changed.title === row.title && changed.message === row.message, 'NOTIFICATION_IMMUTABLE_FIELDS');
      need(changed.isRead === (body?.isRead ?? true), 'NOTIFICATION_READ_STATE');
      if (changed.isRead) need(changed.readAt instanceof Date, 'NOTIFICATION_READ_AT');
      return changed;
    }
  }
  async function runAuthorityNominal(adminToken) {
    const first = await login({ email: 'authority-a-' + uid() + '@example.com' });
    const second = await login({ email: 'authority-b-' + uid() + '@example.com' });
    const owner = first.user._id; const other = second.user._id;
    let row = await createDependent(first.token, owner);
    let body = await readSuccess('/dependents/' + id(row), first.token); need(body.data.userId === owner, 'DEPENDENT_OWN_ID');
    for (const suffix of ['', '?userId=' + owner, '?page=1&limit=10', '?userId=' + owner + '&page=1&limit=10']) {
      body = await readSuccess('/dependents' + suffix, first.token); ownerRows(body, owner);
      if (body.pagination) totalRows(body, 1);
    }
    for (const suffix of ['', '/active']) ownerRows(await readSuccess('/dependents/user/' + owner + suffix, first.token), owner);
    let observed = await observe('PUT', '/dependents/' + id(row) + '?userId=' + owner, first.token, { name: 'Edited owner fixture' });
    assertSuccess(observed, 200, { Dependent: [id(row)] }, { dependents: 1 });
    onlyFields(observed, 'Dependent', id(row), ['name', 'updatedAt']);
    need(stored(observed, 'Dependent', id(row))?.name === 'Edited owner fixture'
      && stored(observed, 'Dependent', id(row))?.userId === owner, 'DEPENDENT_UPDATE_STATE');
    observed = await observe('DELETE', '/dependents/' + id(row), first.token);
    assertSuccess(observed, 200, { Dependent: [id(row)] }, { dependents: 1 });
    need(!stored(observed, 'Dependent', id(row)), 'DEPENDENT_DELETE_STATE'); record('DEPENDENT_OWNER_CRUD_LIST');

    row = await createDependent(adminToken, other);
    await seedDependent(owner, { isActive: false });
    body = await readSuccess('/dependents', adminToken);
    need(body.data.some(item => item.userId === owner) && body.data.some(item => item.userId === other), 'DEPENDENT_ADMIN_GLOBAL');
    for (const suffix of ['', '&page=1&limit=10']) ownerRows(await readSuccess('/dependents?userId=' + other + suffix, adminToken), other);
    for (const suffix of ['', '/active']) ownerRows(await readSuccess('/dependents/user/' + other + suffix, adminToken), other);
    body = await readSuccess('/dependents/' + id(row), adminToken); need(body.data.userId === other, 'DEPENDENT_ADMIN_ID');
    observed = await observe('PUT', '/dependents/' + id(row) + '?userId=' + other, adminToken, { name: 'Admin edited synthetic' });
    assertSuccess(observed, 200, { Dependent: [id(row)] }, { dependents: 1 });
    onlyFields(observed, 'Dependent', id(row), ['name', 'updatedAt']);
    need(stored(observed, 'Dependent', id(row))?.name === 'Admin edited synthetic', 'DEPENDENT_ADMIN_UPDATE');
    observed = await observe('DELETE', '/dependents/' + id(row), adminToken);
    assertSuccess(observed, 200, { Dependent: [id(row)] }, { dependents: 1 }); need(!stored(observed, 'Dependent', id(row)), 'DEPENDENT_ADMIN_DELETE');
    record('DEPENDENT_ADMIN_ON_BEHALF');

    for (const role of ['hr', 'specialist', 'pharmacy', 'unknown', 'Admin']) {
      const roleId = uid(); const token = actor({ _id: roleId, userType: role }); const owned = await seedDependent(roleId);
      for (const [method, route, payload] of dependentRoutes(roleId, id(owned))) {
        await authorityDeny(method, route, token, payload, 403, 'FORBIDDEN', true);
        const malformedRoute = route.includes(id(owned)) ? route.replace(id(owned), 'bad-id') : route;
        await authorityDeny(method, malformedRoute, token, method === 'POST' || method === 'PUT' ? {} : undefined, 403, 'FORBIDDEN', true);
      }
    }
    for (const invalid of [undefined, '', ' ', 7, {}]) {
      const token = actor({ ...(invalid === undefined ? {} : { _id: invalid }), userType: 'user' });
      for (const [method, route, payload] of dependentRoutes(owner, uid())) await authorityDeny(method, route, token, payload, 401, 'UNAUTHORIZED', true);
    }
    await authorityDeny('GET', '/dependents', undefined, undefined, 401, 'UNAUTHORIZED', true);
    await authorityDeny('GET', '/dependents', 'not-a-jwt', undefined, 401, 'INVALID_TOKEN', true);
    record('DEPENDENT_ROLE_AND_PRINCIPAL_DENIALS');

    row = await seedDependent(owner); const foreign = await seedDependent(other);
    for (const [method, route, payload] of [['GET', '/dependents?userId=' + other],
      ...['GET', 'PUT', 'DELETE'].map(method => [method, '/dependents/' + id(row) + '?userId=' + other, method === 'PUT' ? { name: 'Denied' } : undefined]),
      ['GET', '/dependents/user/' + other], ['GET', '/dependents/user/' + other + '/active']])
      await authorityDeny(method, route, first.token, payload, 403, 'FORBIDDEN', true);
    await authorityDeny('POST', '/dependents', first.token, depBody(other), 422, 'FORBIDDEN_FIELD', true);
    record('DEPENDENT_OWNER_SELECTORS_DENIED');
    for (const suffix of ['', '?userId=' + owner]) for (const method of ['GET', 'PUT', 'DELETE'])
      await authorityDeny(method, '/dependents/' + id(foreign) + suffix, first.token, method === 'PUT' ? { name: 'Denied' } : undefined, 404, 'DEPENDENT_NOT_FOUND');
    await authorityDeny('GET', '/dependents/' + uid(), first.token, undefined, 404, 'DEPENDENT_NOT_FOUND');
    await authorityDeny('GET', '/dependents/bad-id', first.token, undefined, 400, 'VALIDATION_ERROR', true);
    record('DEPENDENT_HIDDEN_ID_DENIALS');
    for (const token of [first.token, adminToken]) for (const value of [owner, other, null, 7, {}, [], ''])
      await authorityDeny('PUT', '/dependents/' + id(row), token, { userId: value, name: 'Must not update' }, 422, 'FORBIDDEN_FIELD');
    for (const target of [id(foreign), uid()]) await authorityDeny('PUT', '/dependents/' + target, first.token,
      { userId: owner, name: 'Denied' }, 404, 'DEPENDENT_NOT_FOUND');
    await authorityDeny('PUT', '/dependents/' + id(row) + '?userId=' + other, first.token,
      { userId: owner, name: 'Denied' }, 403, 'FORBIDDEN', true); record('DEPENDENT_RAW_OWNER_FIELD_DENIALS');
    await authorityDeny('POST', '/dependents', first.token, { name: 'No owner', relationship: 'Friend' }, 400, 'VALIDATION_ERROR', true);
    await createDependent(first.token, owner, { relationship: 'Me' });
    await authorityDeny('POST', '/dependents', first.token, { ...depBody(owner), relationship: 'Me' }, 400, 'ME_DEPENDENT_EXISTS');
    const duplicate = await createDependent(first.token, owner, { name: 'Case Sensitive Fixture', relationship: 'Father' });
    await authorityDeny('POST', '/dependents', first.token, { ...depBody(owner), name: ' case sensitive fixture ', relationship: 'Father' }, 400, 'DEPENDENT_ALREADY_EXISTS');
    for (const relationship of ['wife', 'Wife', 'husband', 'Husband']) await createDependent(first.token, owner, { relationship });
    body = await readSuccess('/dependents?isActive=false', first.token);
    need(ownerRows(body, owner).every(item => item.isActive === true), 'DEPENDENT_LEGACY_ACTIVE_HELPER');
    body = await readSuccess('/dependents?isActive=false&page=1&limit=10', first.token);
    need(body.pagination.total === 1 && ownerRows(body, owner).every(item => item.isActive === false), 'DEPENDENT_PAGINATED_INACTIVE');
    need(duplicate.userId === owner, 'DEPENDENT_DUPLICATE_SETUP'); record('DEPENDENT_LEGACY_VALIDATION');

    let ownNote = await seedNote(owner); const otherNote = await seedNote(other);
    for (const suffix of ['', '?userId=' + owner]) ownerRows(await readSuccess('/notifications' + suffix, first.token), owner);
    body = await readSuccess('/notifications/' + id(ownNote), first.token); need(body.data.userId === owner, 'NOTIFICATION_OWN_ID');
    ownNote = await noteMutation('PUT', '/notifications/' + id(ownNote), first.token, ownNote, { isRead: true, userId: other, title: 'Ignored', message: 'Ignored' });
    const priorReadAt = ownNote.readAt;
    ownNote = await noteMutation('PUT', '/notifications/' + id(ownNote), first.token, ownNote, { isRead: false });
    need(same(ownNote.readAt, priorReadAt), 'NOTIFICATION_UNREAD_READAT_PRESERVED');
    ownNote = await noteMutation('PATCH', '/notifications/' + id(ownNote) + '/read', first.token, ownNote);
    ownNote = await noteMutation('PATCH', '/notifications/' + id(ownNote) + '/read', first.token, ownNote);
    await noteMutation('DELETE', '/notifications/' + id(ownNote), first.token, ownNote); record('NOTIFICATION_GENERIC_OWNER_FLOWS');
    body = await readSuccess('/notifications', adminToken);
    need(body.data.some(item => item.userId === owner) && body.data.some(item => item.userId === other), 'NOTIFICATION_ADMIN_GLOBAL');
    ownerRows(await readSuccess('/notifications?userId=' + other + '&page=1&limit=10', adminToken), other);
    ownNote = await seedNote(other); body = await readSuccess('/notifications/' + id(ownNote), adminToken);
    need(body.data.userId === other, 'NOTIFICATION_ADMIN_ID');
    ownNote = await noteMutation('PUT', '/notifications/' + id(ownNote), adminToken, ownNote, { isRead: false });
    ownNote = await noteMutation('PATCH', '/notifications/' + id(ownNote) + '/read', adminToken, ownNote);
    await noteMutation('DELETE', '/notifications/' + id(ownNote), adminToken, ownNote); record('NOTIFICATION_GENERIC_ADMIN_FLOWS');
    await authorityDeny('GET', '/notifications?userId=' + other, first.token, undefined, 403, 'FORBIDDEN', true);
    for (const [method, route, payload] of genericNoteRoutes(id(otherNote))) await authorityDeny(method, route, first.token, payload, 403, 'FORBIDDEN');
    await authorityDeny('GET', '/notifications/' + uid(), first.token, undefined, 404, 'NOTIFICATION_NOT_FOUND');
    await authorityDeny('GET', '/notifications/bad-id', first.token, undefined, 400, 'VALIDATION_ERROR', true);
    for (const invalid of [undefined, '', ' ', 7, {}]) {
      const token = actor({ ...(invalid === undefined ? {} : { _id: invalid }), userType: 'user' });
      await authorityDeny('GET', '/notifications', token, undefined, 401, 'UNAUTHORIZED', true);
      for (const [method, route, payload] of genericNoteRoutes(id(otherNote))) await authorityDeny(method, route, token, payload, 401, 'UNAUTHORIZED', true);
    }
    for (const role of ['hr', 'specialist', 'pharmacy', 'unknown', 'Admin']) {
      const roleId = uid(); const token = actor({ _id: roleId, userType: role, specialistId: other, pharmacyId: other });
      let roleNote = await seedNote(roleId);
      ownerRows(await readSuccess('/notifications', token), roleId);
      body = await readSuccess('/notifications/' + id(roleNote), token); need(body.data.userId === roleId, 'NOTIFICATION_ROLE_OWN');
      roleNote = await noteMutation('PUT', '/notifications/' + id(roleNote), token, roleNote, { isRead: true });
      roleNote = await noteMutation('PATCH', '/notifications/' + id(roleNote) + '/read', token, roleNote);
      await noteMutation('DELETE', '/notifications/' + id(roleNote), token, roleNote);
      await authorityDeny('GET', '/notifications?userId=' + other, token, undefined, 403, 'FORBIDDEN', true);
      for (const [method, route, payload] of genericNoteRoutes(id(otherNote))) await authorityDeny(method, route, token, payload, 403, 'FORBIDDEN');
    }
    record('NOTIFICATION_GENERIC_DENIALS');

    const pageOwner = uid(); const pageToken = actor({ _id: pageOwner, userType: 'user' });
    await seedNote(pageOwner, { referenceType: 'synthetic', referenceId: 'a' });
    await seedNote(pageOwner, { referenceType: 'synthetic', referenceId: 'b', isRead: true });
    await seedNote(other, { referenceType: 'synthetic', referenceId: 'a' });
    body = await readSuccess('/notifications?referenceId=a&page=1&limit=1', pageToken);
    need(ownerRows(body, pageOwner).length === 1 && body.pagination.totalPages === 1, 'NOTIFICATION_REFERENCE_TOTAL'); totalRows(body, 1);
    body = await readSuccess('/notifications?referenceId=a', pageToken); need(ownerRows(body, pageOwner).length === 2, 'NOTIFICATION_LEGACY_REFERENCE_FILTER');
    body = await readSuccess('/notifications?isRead=false&type=general&page=1&limit=1', pageToken);
    need(ownerRows(body, pageOwner).length === 1 && body.pagination.total === 1, 'NOTIFICATION_FILTER_TOTAL');
    body = await readSuccess('/notifications/user/' + pageOwner + '/unread-count', pageToken); need(body.data.count === 1, 'NOTIFICATION_OWN_COUNT');
    const capOwner = uid(); const capToken = actor({ _id: capOwner, userType: 'user' });
    const capRows = await model('Notification').insertMany(Array.from({ length: 1001 }, () => ({ ...noteBody(capOwner), isRead: false })));
    body = await readSuccess('/notifications/user/' + capOwner + '/unread-count', capToken); need(body.data.count === 1000, 'NOTIFICATION_COUNT_CAP');
    await model('Notification').deleteMany({ _id: { $in: capRows.map(item => item._id) }, userId: capOwner });
    need(await model('Notification').countDocuments({ _id: { $in: capRows.map(item => item._id) }, userId: capOwner }) === 0, 'NOTIFICATION_CAP_CLEANUP');
    record('NOTIFICATION_PAGINATION_AND_COUNTS');

    const strictOwner = uid(); const strictToken = actor({ _id: strictOwner, userType: 'user' });
    const strictRows = [await seedNote(strictOwner), await seedNote(strictOwner)];
    await seedNote(strictOwner, { isRead: true, readAt: new Date('2000-01-01T00:00:00.000Z') });
    for (const [method, route] of strictNoteRoutes(strictOwner)) {
      if (method === 'GET') {
        body = await readSuccess(route, strictToken);
        if (route.endsWith('unread-count')) need(body.data.count === 2, 'NOTIFICATION_STRICT_COUNT'); else ownerRows(body, strictOwner);
      } else {
        observed = await observe(method, route, strictToken);
        const unreadIds = observed.before.Notification.filter(item => item.userId === strictOwner && item.isRead === false).map(id);
        assertSuccess(observed, 200, { Notification: unreadIds }, { notifications: 1 });
        for (const rowId of unreadIds) onlyFields(observed, 'Notification', rowId, ['isRead', 'readAt', 'updatedAt']);
        need(strictRows.every(item => stored(observed, 'Notification', id(item))?.isRead === true), 'NOTIFICATION_STRICT_READ_ALL');
      }
      for (const token of [first.token, adminToken]) await authorityDeny(method, route, token, undefined, 403, 'FORBIDDEN', true);
    }
    record('NOTIFICATION_PRIOR_STRICT_OWN_PATHS');
    for (const alias of [false, true]) {
      const specialistId = uid(); const token = actor({ _id: alias ? uid() : specialistId, userType: 'specialist', ...(alias ? { specialistId } : {}) });
      const notes = [await seedNote(specialistId), await seedNote(specialistId)];
      await seedNote(specialistId, { isRead: true, readAt: new Date('2000-01-01T00:00:00.000Z') });
      for (const suffix of ['', '/unread', '/unread-count']) {
        body = await readSuccess('/notifications/specialist/me' + suffix, token);
        if (suffix.endsWith('count')) need(body.data.count === 2, 'NOTIFICATION_SPECIALIST_COUNT'); else ownerRows(body, specialistId);
      }
      for (const rowId of [id(otherNote), uid()]) await authorityDeny('PATCH', '/notifications/specialist/' + rowId + '/read', token, undefined, 404, 'NOTIFICATION_NOT_FOUND');
      await noteMutation('PATCH', '/notifications/specialist/' + id(notes[0]) + '/read', token, notes[0]);
      observed = await observe('PATCH', '/notifications/specialist/me/read-all', token);
      const unreadIds = observed.before.Notification.filter(item => item.userId === specialistId && item.isRead === false).map(id);
      assertSuccess(observed, 200, { Notification: unreadIds }, { notifications: 1 });
      for (const rowId of unreadIds) onlyFields(observed, 'Notification', rowId, ['isRead', 'readAt', 'updatedAt']);
      need(notes.every(item => stored(observed, 'Notification', id(item))?.isRead === true), 'NOTIFICATION_SPECIALIST_READ_ALL');
    }
    for (const [method, route] of [['GET', '/notifications/specialist/me'], ['GET', '/notifications/specialist/me/unread'],
      ['GET', '/notifications/specialist/me/unread-count'], ['PATCH', '/notifications/specialist/me/read-all'], ['PATCH', '/notifications/specialist/' + id(otherNote) + '/read']])
      await authorityDeny(method, route, first.token, undefined, 403, 'FORBIDDEN', true);
    record('NOTIFICATION_PRIOR_SPECIALIST_PATHS');

    const ownedToken = await registerToken(first.token, owner); await registerToken(second.token, other);
    const plainBody = { ...noteBody(owner), data: { fixture: 'single' }, referenceType: 'synthetic', referenceId: uid() };
    observed = await observe('POST', '/notifications', adminToken, plainBody);
    const plainId = observed.result.body?.data?._id; need(typeof plainId === 'string', 'NOTIFICATION_SEND_CREATED_ID');
    assertSuccess(observed, 201, { Notification: [plainId] }, { notifications: 1 });
    inserted(observed, 'Notification', plainId);
    const plainStored = stored(observed, 'Notification', plainId);
    need(plainStored?.userId === owner && plainStored.type === plainBody.type && plainStored.title === plainBody.title
      && plainStored.message === plainBody.message && same(plainStored.data, plainBody.data) && plainStored.isRead === false
      && plainStored.readAt === undefined && plainStored.referenceType === plainBody.referenceType
      && plainStored.referenceId === plainBody.referenceId && observed.result.body.data._id === id(plainStored), 'NOTIFICATION_SINGLE_CREATED');
    const sendBody = { userIds: [owner], type: 'general', title: 'Synthetic broadcast', message: 'Synthetic recorded message', data: { fixture: 'yes' } };
    observed = await observe('POST', '/notifications/send', adminToken, sendBody);
    const added = observed.after.Notification.filter(item => !observed.before.Notification.some(prior => id(prior) === id(item)));
    need(added.length === 1 && added[0].userId === owner && added[0].title === sendBody.title
      && added[0].message === sendBody.message && added[0].type === sendBody.type && same(added[0].data, sendBody.data)
      && added[0].isRead === false && added[0].readAt === undefined && observed.result.body?.data?.created === 1
      && same(observed.result.body.data.targetUserIds, [owner]), 'NOTIFICATION_BROADCAST_CREATED');
    assertSuccess(observed, 201, { Notification: added.map(id) }, { notifications: 1 }, 1, 1);
    assertPayloads(observed, [{ tokens: [ownedToken], notification: { title: sendBody.title, body: sendBody.message }, data: sendBody.data }]);
    for (const token of [first.token, actor({ _id: owner, userType: 'hr' }), actor({ _id: owner, userType: 'specialist' }), actor({ _id: owner, userType: 'pharmacy' })])
      for (const [route, payload] of [['/notifications', plainBody], ['/notifications/send', sendBody]])
        for (const value of [payload, {}]) await authorityDeny('POST', route, token, value, 403, 'FORBIDDEN', true);
    record('NOTIFICATION_PRIOR_ADMIN_SENDERS');
    observed = await observe('POST', '/fcm/test', adminToken, { userId: owner });
    assertSuccess(observed, 200, {}, {}, 1, 1); assertPayloads(observed, [testPush([ownedToken])]);
    observed = await observe('POST', '/fcm/test', adminToken, { userId: uid() }); assertSuccess(observed, 200);
    record('FCM_TEST_ADMIN_RECORDING');
    for (const role of ['user', 'hr', 'specialist', 'pharmacy', 'unknown', 'Admin']) for (const payload of [{ userId: owner }, {}])
      await authorityDeny('POST', '/fcm/test', actor({ _id: owner, userType: role }), payload, 403, 'FORBIDDEN', true);
    await authorityDeny('POST', '/fcm/test', undefined, { userId: owner }, 401, 'UNAUTHORIZED', true);
    await authorityDeny('POST', '/fcm/test', 'not-a-jwt', { userId: owner }, 401, 'INVALID_TOKEN', true);
    await authorityDeny('POST', '/fcm/test', adminToken, { userId: 'bad-id' }, 400, 'VALIDATION_ERROR', true);
    record('FCM_TEST_DENIALS');
    await registerToken(first.token, owner);
    const tokenSpecialist = uid(); await registerToken(actor({ _id: tokenSpecialist, userType: 'specialist' }), tokenSpecialist, 'specialist');
    await authorityDeny('POST', '/fcm/token', first.token, {}, 400, 'VALIDATION_ERROR', true);
    await authorityDeny('POST', '/fcm/token', undefined, { token: 'synthetic-invalid-' + uid() }, 401, 'UNAUTHORIZED', true);
    record('FCM_TOKEN_REGISTRATION_COMPAT');
  }
  function detectedFailure(predicate, expected) {
    let code; try { predicate(); } catch (error) { code = error.fixtureCode; }
    need(code === expected, 'AUTHORITY_SENSITIVITY_PREDICATE');
  }
  function denialProbe(observed, status, code, beforeLookup, mutant) {
    if (mutant) detectedFailure(() => assertDenied(observed, status, code, beforeLookup), 'AUTHORITY_DENIAL_STATUS');
    else assertDenied(observed, status, code, beforeLookup);
  }
  async function listProbe(ctxActors, collectionName, path, mutant) {
    if (collectionName === 'Dependent') { await seedDependent(ctxActors.owner); await seedDependent(ctxActors.other); }
    else { await seedNote(ctxActors.owner); await seedNote(ctxActors.other); }
    const total = await model(collectionName).countDocuments({ userId: ctxActors.owner });
    for (const suffix of ['', '?page=1&limit=100']) {
      const observed = await observe('GET', path + suffix, ctxActors.token); assertSuccess(observed, 200);
      if (mutant) {
        detectedFailure(() => ownerRows(observed.result.body, ctxActors.owner), 'AUTHORITY_LIST_OWNER');
        need(observed.result.body.data.some(item => item.userId === ctxActors.other), 'AUTHORITY_MUTANT_FOREIGN_ROW');
        if (suffix) {
          detectedFailure(() => totalRows(observed.result.body, total), 'AUTHORITY_LIST_TOTAL');
          const actualTotal = await model(collectionName).countDocuments({});
          need(observed.result.body.pagination.total === actualTotal, 'AUTHORITY_MUTANT_FOREIGN_TOTAL');
        }
      } else { ownerRows(observed.result.body, ctxActors.owner); if (suffix) totalRows(observed.result.body, total); }
    }
  }
  async function idProbe(ctxActors, name, mutant) {
    const routes = name === 'Dependent' ? ['GET', 'PUT', 'DELETE'] : ['GET', 'PUT', 'PATCH', 'DELETE'];
    for (const method of routes) {
      const row = name === 'Dependent' ? await seedDependent(ctxActors.other) : await seedNote(ctxActors.other);
      const route = (name === 'Dependent' ? '/dependents/' : '/notifications/') + id(row) + (method === 'PATCH' ? '/read' : '');
      const payload = method === 'PUT' ? name === 'Dependent' ? { name: 'Mutated synthetic name' } : { isRead: true } : undefined;
      const observed = await observe(method, route, ctxActors.token, payload);
      denialProbe(observed, name === 'Dependent' ? 404 : 403, name === 'Dependent' ? 'DEPENDENT_NOT_FOUND' : 'FORBIDDEN', false, mutant);
      if (mutant) {
        const writes = method === 'GET' ? {} : { [name === 'Dependent' ? 'dependents' : 'notifications']: 1 };
        assertSuccess(observed, 200, method === 'GET' ? {} : { [name]: [id(row)] }, writes);
        if (method === 'GET') need(observed.result.body.data.userId === ctxActors.other, 'AUTHORITY_MUTANT_ID_READ');
        else if (method === 'DELETE') need(!stored(observed, name, id(row)), 'AUTHORITY_MUTANT_ID_DELETE');
        else need(stored(observed, name, id(row))?.userId === ctxActors.other
          && (name === 'Dependent' ? stored(observed, name, id(row)).name === payload.name : stored(observed, name, id(row)).isRead === true), 'AUTHORITY_MUTANT_ID_WRITE');
      }
    }
  }
  async function cleanupSensitivityRows(before, owners) {
    const after = await authorityRows(); const permitted = {};
    const additions = [];
    for (const spec of ctx.ports.models) {
      const prior = new Set(before[spec.name].map(id));
      const added = after[spec.name].filter(row => !prior.has(id(row)));
      permitted[spec.name] = added.map(id);
      for (const row of added) {
        need(['User', 'OTP', 'Wallet', 'Notification', 'Dependent', 'FcmToken'].includes(spec.name)
          && (spec.name === 'User' ? owners.includes(id(row)) : owners.includes(String(row.userId))), 'AUTHORITY_SENSITIVITY_ROW_OWNERSHIP');
        additions.push([spec.name, row]);
      }
    }
    unchangedOutside({ before, after }, permitted);
    for (const [name, row] of additions) await model(name).deleteOne({ _id: row._id, ...(name === 'User' ? {} : { userId: row.userId }) });
    need(same(await authorityRows(), before), 'AUTHORITY_SENSITIVITY_CLEANUP');
  }
  async function runAuthoritySensitivity(adminToken) {
    const probes = [
      ['DEPENDENT_UNBOUND_CREATE_OWNER', '@/modules/dependents/controller', async (actors, mutant) => {
        const observed = await observe('POST', '/dependents', actors.token, depBody(actors.other));
        denialProbe(observed, 422, 'FORBIDDEN_FIELD', true, mutant);
        if (mutant) {
          const rowId = observed.result.body?.data?._id;
          assertSuccess(observed, 201, { Dependent: [rowId] }, { dependents: 1 });
          need(stored(observed, 'Dependent', rowId)?.userId === actors.other, 'DEPENDENT_MUTANT_CREATED_OWNER');
        }
      }],
      ['DEPENDENT_UNSCOPED_LIST', '@/modules/dependents/controller', (actors, mutant) => listProbe(actors, 'Dependent', '/dependents', mutant)],
      ['DEPENDENT_UNSCOPED_ID_CALLS', '@/modules/dependents/controller', (actors, mutant) => idProbe(actors, 'Dependent', mutant)],
      ['DEPENDENT_FORBIDDEN_ROLE_ADMISSION', '@/modules/dependents/controller', async (actors, mutant) => {
        const token = actor({ _id: actors.owner, userType: 'hr' });
        const row = await seedDependent(actors.owner);
        for (const [method, route, payload] of dependentRoutes(actors.owner, id(row))) {
          const observed = await observe(method, route, token, payload); denialProbe(observed, 403, 'FORBIDDEN', true, mutant);
          if (mutant) {
            const permitted = method === 'POST' ? { Dependent: [observed.result.body?.data?._id] }
              : ['PUT', 'DELETE'].includes(method) ? { Dependent: [id(row)] } : {};
            assertSuccess(observed, method === 'POST' ? 201 : 200, permitted, method === 'POST' || method === 'PUT' || method === 'DELETE' ? { dependents: 1 } : {});
          }
        }
        const malformed = await observe('POST', '/dependents', token, {}); denialProbe(malformed, 403, 'FORBIDDEN', true, mutant);
        if (mutant) assertDenied(malformed, 400, 'VALIDATION_ERROR', true);
      }],
      ['DEPENDENT_RAW_OWNER_STRIPPED', '@/modules/dependents/routes', async (actors, mutant) => {
        const row = await seedDependent(actors.owner); const payload = { userId: actors.other, name: 'Stripped-owner mutation' };
        const observed = await observe('PUT', '/dependents/' + id(row), actors.token, payload);
        denialProbe(observed, 422, 'FORBIDDEN_FIELD', false, mutant);
        if (mutant) {
          assertSuccess(observed, 200, { Dependent: [id(row)] }, { dependents: 1 });
          need(stored(observed, 'Dependent', id(row))?.name === payload.name
            && stored(observed, 'Dependent', id(row))?.userId === actors.owner, 'DEPENDENT_MUTANT_STRIPPED_OWNER');
        }
      }],
      ['NOTIFICATION_UNSCOPED_LIST', '@/modules/notification/controller', (actors, mutant) => listProbe(actors, 'Notification', '/notifications', mutant)],
      ['NOTIFICATION_ID_OWNER_GUARD_REMOVED', '@/modules/notification/controller', (actors, mutant) => idProbe(actors, 'Notification', mutant)],
      ['NOTIFICATION_PRIOR_STRICT_OWN_ADMIN_EXPANSION', '@/modules/notification/controller', async (actors, mutant) => {
        for (const [method, route] of strictNoteRoutes(actors.owner)) {
          await seedNote(actors.owner);
          const observed = await observe(method, route, adminToken); denialProbe(observed, 403, 'FORBIDDEN', true, mutant);
          if (mutant) {
            const unread = observed.before.Notification.filter(row => row.userId === actors.owner && row.isRead === false);
            assertSuccess(observed, 200, method === 'PATCH' ? { Notification: unread.map(id) } : {}, method === 'PATCH' ? { notifications: 1 } : {});
            if (method === 'PATCH') need(unread.every(row => stored(observed, 'Notification', id(row))?.isRead === true), 'NOTIFICATION_MUTANT_ADMIN_READ_ALL');
            else if (route.endsWith('unread-count')) need(observed.result.body.data.count >= 1, 'NOTIFICATION_MUTANT_ADMIN_COUNT');
            else ownerRows(observed.result.body, actors.owner);
          }
        }
      }],
      ['FCM_TEST_ADMIN_GUARD_REMOVED', '@/modules/fcm/routes', async (actors, mutant) => {
        const tokenValue = await registerToken(actors.otherToken, actors.other);
        const observed = await observe('POST', '/fcm/test', actors.token, { userId: actors.other });
        denialProbe(observed, 403, 'FORBIDDEN', true, mutant);
        if (mutant) { assertSuccess(observed, 200, {}, {}, 1, 1); assertPayloads(observed, [testPush([tokenValue])]); }
      }],
      ['FCM_TEST_ADMIN_GUARD_AFTER_VALIDATION', '@/modules/fcm/routes', async (actors, mutant) => {
        const observed = await observe('POST', '/fcm/test', actors.token, {});
        denialProbe(observed, 403, 'FORBIDDEN', true, mutant);
        if (mutant) assertDenied(observed, 400, 'VALIDATION_ERROR', true);
      }],
    ];
    for (const [name, alias, probe] of probes) {
      const before = await authorityRows(); let actors;
      need(ctx.plan.mutants[name]?.file, 'MISSING_SOURCE_MUTANT');
      // Failure propagates unchanged to owned HTTP/ODM/container teardown.
      // Never mutate fixture proofs or import a new phase in a failure finally.
      await ctx.nextPhase({ [alias]: ctx.plan.mutants[name].file });
      const first = await login({ email: 'sensitivity-a-' + uid() + '@example.com' });
      const second = await login({ email: 'sensitivity-b-' + uid() + '@example.com' });
      actors = { owner: first.user._id, other: second.user._id, token: first.token, otherToken: second.token };
      await probe(actors, true); await cleanCompletedProofs();
      need(ctx.counters.unexpected === 0 && ctx.counters.excluded === 0, 'SENSITIVITY_UNDECLARED_EFFECT');
      await ctx.nextPhase({}); await probe(actors, false);
      await cleanupSensitivityRows(before, [actors.owner, actors.other]);
      sensitivity.push({ id: name, detected: true });
    }
  }

  // Administrative Meet routes use their actual controller/service/fetch builders.
  // Only the admitted recording port produces synthetic provider responses.
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const equalMeet = (actual, expected) => same(canonical(actual), canonical(expected));
  function meetRoutes() {
    const env = ctx.ports.recordingMeet.environment;
    const payload = { summary: 'Fixture Google Meet', description: 'Created from test OAuth endpoint',
      start: { dateTime: '2030-01-15T10:00:00', timeZone: env.GOOGLE_MEET_TIMEZONE },
      end: { dateTime: '2030-01-15T10:30:00', timeZone: env.GOOGLE_MEET_TIMEZONE },
      attendees: [{ email: 'patient@example.com' }, { email: 'specialist@example.com' }] };
    return [
      { method: 'GET', path: '/google-oauth/url', suffix: '?state=fixture-meet-state', malformedSuffix: '?state=one&state=two',
        body: undefined, malformed: undefined, validation: '"state" must be a string', expected: [] },
      { method: 'POST', path: '/google-oauth/exchange', body: { code: 'fixture-authorization-code', redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI },
        malformed: { code: '' }, validation: 'code is required',
        expected: [{ kind: 'code', code: 'fixture-authorization-code', redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI }] },
      { method: 'POST', path: '/google-oauth/refresh', body: { refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN },
        malformed: { refreshToken: ['one', 'two'] }, validation: '"refreshToken" must be a string',
        expected: [{ kind: 'refresh', refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN }] },
      { method: 'POST', path: '/google-meet/oauth', body: { patientEmail: 'patient@example.com', specialistEmail: 'specialist@example.com',
        dateYyyymmdd: '20300115', startTime: '10:00 AM', durationMinutes: 30, summary: payload.summary },
        malformed: { patientEmail: 'invalid', specialistEmail: 'invalid' },
        validation: 'patientEmail must be a valid email, specialistEmail must be a valid email',
        expected: [{ kind: 'refresh', refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN }, { kind: 'event', payload }] },
    ];
  }
  function meetActors(userToken) {
    const signed = payload => actor({ _id: uid(), ...payload });
    return [
      { token: undefined, status: 401, code: 'UNAUTHORIZED', message: 'Authorization token is required' },
      { token: ctx.originalSign({ _id: uid(), userType: 'admin' }, crypto.randomBytes(32).toString('hex'), { expiresIn: '5m' }),
        status: 401, code: 'INVALID_TOKEN', message: 'Invalid token' },
      { token: ctx.originalSign({ _id: uid(), userType: 'admin' }, ctx.key, { expiresIn: -1 }),
        status: 401, code: 'TOKEN_EXPIRED', message: 'Token has expired' },
      ...[userToken, signed({ userType: 'hr' }), signed({ userType: 'specialist' }), signed({ userType: 'pharmacy' })]
        .map(token => ({ token, status: 403, code: 'FORBIDDEN', message: 'Admin access is required' })),
    ];
  }
  async function observeMeet(method, route, token, body, expected = []) {
    ctx.expectMeetRequests(expected);
    const offset = ctx.meetRequests.length; const clockBefore = Date.now();
    const observed = await observe(method, '/meet' + route, token, body);
    const clockAfter = Date.now(); const requests = ctx.meetRequests.slice(offset);
    ctx.expectMeetRequests([]); // Throws rather than discarding an unfinished expectation.
    return { ...observed, requests, clockBefore, clockAfter };
  }
  function assertMeetEffects(observed, count, logger) {
    unchangedOutside(observed); effects(observed, {}, 0, logger, count);
    need(Object.values(observed.reads).every(value => value === 0), 'MEET_DATABASE_READS');
    need(observed.requests.length === count, 'MEET_REQUEST_COUNT');
  }
  function assertMeetRequests(observed, expected) {
    const fixture = ctx.ports.recordingMeet; const env = fixture.environment;
    const records = expected.map((descriptor, index) => {
      if (descriptor.kind === 'code' || descriptor.kind === 'refresh') return { kind: descriptor.kind, method: 'POST', url: fixture.tokenUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: descriptor.kind === 'code'
          ? { code: descriptor.code, client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
            redirect_uri: descriptor.redirectUri, grant_type: 'authorization_code' }
          : { client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
            refresh_token: descriptor.refreshToken, grant_type: 'refresh_token' } };
      const actualId = observed.requests[index]?.body?.conferenceData?.createRequest?.requestId;
      if (!(typeof actualId === 'string' && /^meet-[0-9]+$/.test(actualId))) {
        ctx.counters.unexpected++; need(false, 'MEET_REQUEST_ID_SHAPE');
      }
      const timestamp = Number(actualId.slice(5));
      if (!(Number.isSafeInteger(timestamp) && timestamp >= observed.clockBefore && timestamp <= observed.clockAfter)) {
        ctx.counters.unexpected++; need(false, 'MEET_REQUEST_ID_WINDOW');
      }
      return { kind: 'event', method: 'POST', url: fixture.calendarUrl,
        headers: { Authorization: 'Bearer ' + fixture.oauthResponse.access_token, 'Content-Type': 'application/json' },
        body: { ...descriptor.payload, conferenceData: { createRequest: { requestId: actualId, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } };
    });
    if (!equalMeet(observed.requests, records)) {
      ctx.counters.unexpected++; need(false, 'MEET_REQUEST_FIELDS');
    }
  }
  function meetDenied(observed, expected) {
    need(observed.result.status === expected.status, 'MEET_AUTHORITY_STATUS'); errorEnvelope(observed.result, expected.code);
    need(observed.result.body.message === expected.message, 'MEET_AUTHORITY_MESSAGE');
    assertMeetEffects(observed, 0, 1); assertMeetRequests(observed, []);
  }
  function meetValidation(route) { return { status: 400, code: 'VALIDATION_ERROR', message: route.validation }; }
  function meetSuccess(observed, index) {
    const route = meetRoutes()[index]; const fixture = ctx.ports.recordingMeet;
    need(observed.result.status === 200, 'MEET_SUCCESS_STATUS');
    if (index === 0) {
      const data = observed.result.body?.data;
      need(data && typeof data.authorizationUrl === 'string', 'MEET_AUTHORIZATION_URL');
      const url = new URL(data.authorizationUrl);
      const pairs = [...url.searchParams]; const params = Object.fromEntries(pairs);
      need(url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth'
        && url.username === '' && url.password === '' && url.hash === '' && pairs.length === 8
        && equalMeet(params, { client_id: fixture.environment.GOOGLE_OAUTH_CLIENT_ID,
          redirect_uri: fixture.environment.GOOGLE_OAUTH_REDIRECT_URI, response_type: 'code',
          scope: 'https://www.googleapis.com/auth/calendar', access_type: 'offline', prompt: 'consent',
          include_granted_scopes: 'true', state: 'fixture-meet-state' }), 'MEET_AUTHORIZATION_FIELDS');
      need(equalMeet(observed.result.body, { success: true, message: 'Open authorizationUrl in browser and complete consent',
        data: { authorizationUrl: data.authorizationUrl, state: 'fixture-meet-state' } }), 'MEET_URL_REPLY');
    } else {
      const replies = [null,
        { success: true, message: 'Code exchanged. Save refresh_token to GOOGLE_OAUTH_REFRESH_TOKEN in .env and restart backend.', data: fixture.oauthResponse },
        { success: true, message: 'OAuth refresh token is valid', data: { accessTokenPreview: fixture.oauthResponse.access_token.slice(0, 20) + '...' } },
        { success: true, message: 'Google Meet event created using OAuth flow', data: { event: fixture.eventResponse,
          joinUrl: fixture.eventResponse.hangoutLink, meetingCode: fixture.eventResponse.conferenceData.conferenceId } },
      ];
      need(equalMeet(observed.result.body, replies[index]), 'MEET_PROVIDER_REPLY');
    }
    assertMeetEffects(observed, route.expected.length, 0); assertMeetRequests(observed, route.expected);
  }
  async function meetAuthority(index, caller, malformed = false, variant) {
    const route = meetRoutes()[index];
    const succeeds = variant === 'MEET_ADMIN_GUARD_REMOVED';
    const observed = await observeMeet(route.method, route.path + (malformed ? route.malformedSuffix || '' : route.suffix || ''),
      caller.token, malformed ? route.malformed : route.body, succeeds ? route.expected : []);
    if (!variant) { meetDenied(observed, caller); return; }
    detectedFailure(() => meetDenied(observed, caller), variant === 'MEET_AUTHENTICATION_REMOVED' ? 'MEET_AUTHORITY_MESSAGE' : 'MEET_AUTHORITY_STATUS');
    if (variant === 'MEET_AUTHENTICATION_REMOVED') meetDenied(observed, { status: 401, code: 'UNAUTHORIZED', message: 'Authentication is required' });
    else if (variant === 'MEET_ADMIN_GUARD_REMOVED') meetSuccess(observed, index);
    else meetDenied(observed, meetValidation(route));
  }
  function meetCallback(index) {
    const root = '/google-oauth/callback';
    return [
      { path: root + '?code=fixture-callback-code&state=fixture-meet-state&scope=fixture-calendar-scope', status: 200,
        body: { success: true, message: 'Google OAuth callback received. Use this code in POST /api/v1/meet/google-oauth/exchange.',
          data: { code: 'fixture-callback-code', state: 'fixture-meet-state', scope: 'fixture-calendar-scope' } } },
      { path: root + '?error=access_denied&state=fixture-meet-state', status: 400,
        body: { success: false, message: 'Google OAuth callback returned an error', data: { error: 'access_denied', state: 'fixture-meet-state' } } },
      { path: root + '?state=fixture-meet-state&scope=fixture-calendar-scope', status: 400,
        body: { success: false, message: 'No code found in callback query params', data: { state: 'fixture-meet-state', scope: 'fixture-calendar-scope' } } },
      { path: root + '?code=one&code=two', status: 400 },
    ][index];
  }
  function meetCallbackPredicate(observed, index) {
    const expected = meetCallback(index);
    need(observed.result.status === expected.status, 'MEET_CALLBACK_STATUS');
    if (index === 3) meetDenied(observed, { status: 400, code: 'VALIDATION_ERROR', message: '"code" must be a string' });
    else {
      need(equalMeet(observed.result.body, expected.body), 'MEET_CALLBACK_REPLY');
      assertMeetEffects(observed, 0, 0); assertMeetRequests(observed, []);
    }
  }
  async function exerciseMeetCallback(index, variant = false) {
    const observed = await observeMeet('GET', meetCallback(index).path);
    if (!variant) { meetCallbackPredicate(observed, index); return; }
    detectedFailure(() => meetCallbackPredicate(observed, index), 'MEET_CALLBACK_STATUS');
    meetDenied(observed, { status: 401, code: 'UNAUTHORIZED', message: 'Authorization token is required' });
  }
  async function runMeetNominal(adminToken, userToken) {
    const callers = meetActors(userToken); const calendarBefore = ctx.counters.calendar;
    need(calendarBefore === 0, 'MEET_PRIOR_GOOGLE_EFFECT');
    const authorityIds = ['MEET_URL_AUTHORITY', 'MEET_EXCHANGE_AUTHORITY', 'MEET_REFRESH_AUTHORITY', 'MEET_CREATE_AUTHORITY'];
    const validationIds = ['MEET_URL_ADMIN_VALIDATION', 'MEET_EXCHANGE_ADMIN_VALIDATION', 'MEET_REFRESH_ADMIN_VALIDATION', 'MEET_CREATE_ADMIN_VALIDATION'];
    const successIds = ['MEET_URL_ADMIN_SUCCESS', 'MEET_EXCHANGE_ADMIN_SUCCESS', 'MEET_REFRESH_ADMIN_SUCCESS', 'MEET_CREATE_ADMIN_SUCCESS'];
    for (let index = 0; index < 4; index++) {
      for (const caller of callers) for (const malformed of [false, true]) await meetAuthority(index, caller, malformed);
      record(authorityIds[index]);
    }
    for (let index = 0; index < 4; index++) {
      const route = meetRoutes()[index];
      const observed = await observeMeet(route.method, route.path + (route.malformedSuffix || ''), adminToken, route.malformed);
      meetDenied(observed, meetValidation(route)); record(validationIds[index]);
    }
    for (let index = 0; index < 4; index++) {
      const route = meetRoutes()[index];
      const observed = await observeMeet(route.method, route.path + (route.suffix || ''), adminToken, route.body, route.expected);
      meetSuccess(observed, index); record(successIds[index]);
    }
    const callbacks = ['MEET_CALLBACK_VALID_CODE_PUBLIC', 'MEET_CALLBACK_PROVIDER_ERROR_PUBLIC', 'MEET_CALLBACK_MISSING_CODE_PUBLIC', 'MEET_CALLBACK_INVALID_QUERY_PUBLIC'];
    for (let index = 0; index < 4; index++) { await exerciseMeetCallback(index); record(callbacks[index]); }
    need(ctx.counters.calendar - calendarBefore === 4, 'MEET_NOMINAL_GOOGLE_COUNT'); ctx.expectMeetRequests([]);
  }
  async function runMeetSensitivity(userToken) {
    const callers = meetActors(userToken);
    for (const variant of ['MEET_AUTHENTICATION_REMOVED', 'MEET_ADMIN_GUARD_REMOVED', 'MEET_GUARDS_AFTER_VALIDATION', 'MEET_CALLBACK_GATED']) {
      need(ctx.plan.mutants[variant]?.file, 'MISSING_SOURCE_MUTANT');
      await ctx.nextPhase({ '@/modules/meet/routes': ctx.plan.mutants[variant].file });
      const samples = variant === 'MEET_AUTHENTICATION_REMOVED' ? [callers[0]]
        : variant === 'MEET_ADMIN_GUARD_REMOVED' ? [callers[3]] : callers;
      if (variant === 'MEET_CALLBACK_GATED') for (let i = 0; i < 3; i++) await exerciseMeetCallback(i, true);
      else for (let index = 0; index < 4; index++) for (const caller of samples)
        for (const malformed of variant === 'MEET_AUTHENTICATION_REMOVED' ? [false, true] : [variant === 'MEET_GUARDS_AFTER_VALIDATION'])
          await meetAuthority(index, caller, malformed, variant);
      ctx.expectMeetRequests([]); await ctx.nextPhase({});
      if (variant === 'MEET_CALLBACK_GATED') for (let i = 0; i < 3; i++) await exerciseMeetCallback(i);
      else for (let index = 0; index < 4; index++) for (const caller of samples)
        for (const malformed of variant === 'MEET_AUTHENTICATION_REMOVED' ? [false, true] : [variant === 'MEET_GUARDS_AFTER_VALIDATION'])
          await meetAuthority(index, caller, malformed);
      ctx.expectMeetRequests([]);
      need(ctx.counters.unexpected === 0 && ctx.counters.excluded === 0, 'SENSITIVITY_UNDECLARED_EFFECT');
      sensitivity.push({ id: variant, detected: true });
    }
  }

  const alpha = await login({ phone: '9000000001' }); record('PHONE_LOGIN');
  const beta = await login({ email: 'beta@example.com' }); record('EMAIL_LOGIN');
  const a = await model('User').findById(alpha.user._id).lean().exec();
  const b = await model('User').findById(beta.user._id).lean().exec();
  const aw = await model('Wallet').findOne({ userId: id(a) }).lean().exec();
  const bw = await model('Wallet').findOne({ userId: id(b) }).lean().exec();
  need(a.otpVerified === true && a.isVerified === true && b.otpVerified === true && b.isVerified === true
    && aw.balance === 0 && bw.balance === 0 && ctx.counters.push === 0, 'LOGIN_PERSISTENCE');
  need(await model('Notification').countDocuments({ type: 'login', userId: { $in: [id(a), id(b)] } }) === 2, 'LOGIN_NOTIFICATIONS');
  record('LOGIN_SIDE_EFFECTS');
  for (const logged of [alpha, beta]) {
    const claims = ctx.jwt.verify(logged.token, ctx.key, { algorithms: ['HS256'] });
    need(claims._id === logged.user._id && claims.userType === 'user' && claims.exp - claims.iat === 30 * 86400, 'JWT_REAL_CLAIMS');
    let rejected = false; try { ctx.jwt.verify(logged.token, crypto.randomBytes(32).toString('hex')); } catch { rejected = true; }
    need(rejected, 'JWT_WRONG_KEY_ACCEPTED');
  }
  record('JWT_SIGNATURE_AND_CLAIMS');
  let response = await request('GET', '/auth/profile', alpha.token);
  need(response.status === 200 && response.body.data.user._id === id(a), 'PROFILE_OWNER'); record('OWN_PROFILE');
  response = await request('GET', '/users/' + id(a), alpha.token);
  need(response.status === 200 && response.body.data.user._id === id(a), 'USER_OWNER_READ'); record('OWN_USER_READ');
  response = await request('PUT', '/users/' + id(a), alpha.token, { name: 'Updated Synthetic Fixture' });
  need(response.status === 200 && (await model('User').findById(a._id).lean().exec()).name === 'Updated Synthetic Fixture', 'USER_OWNER_UPDATE'); record('OWN_USER_UPDATE');
  for (const [method, suffix, body, name] of [
    ['GET', '/' + id(b), undefined, 'OTHER_USER_READ_DENIED'],
    ['PUT', '/' + id(b), { phone: '9000000099', email: 'replacement@example.com' }, 'OTHER_USER_UPDATE_DENIED'],
    ['DELETE', '/' + id(b), undefined, 'OTHER_USER_DELETE_DENIED'], ['GET', '/', undefined, 'USER_LIST_DENIED'],
  ]) { await deny(method, '/users' + suffix, alpha.token, body, [403], name); record(name); }
  for (const [field, value] of Object.entries({ isActive: false, isVerified: false, isCorporateEmailVerified: true, corporateId: uid(), isCorporateUser: true }))
    await deny('PUT', '/users/' + id(a), alpha.token, { [field]: value }, [422], 'SELF_FIELD_' + field.toUpperCase());
  record('SELF_PRIVILEGE_FIELDS_DENIED');
  response = await request('GET', '/wallet/' + id(aw), alpha.token);
  need(response.status === 200 && response.body.data.userId === id(a), 'OWN_WALLET');
  response = await request('GET', '/wallet/user/' + id(a), alpha.token);
  need(response.status === 200 && response.body.data.userId === id(a), 'OWN_WALLET_BY_USER'); record('OWN_WALLET_READ');
  await deny('GET', '/wallet/' + id(bw), alpha.token, undefined, [403], 'WALLET_ID_OWNER'); record('OTHER_WALLET_ID_DENIED');
  await deny('GET', '/wallet/user/' + id(b), alpha.token, undefined, [403], 'WALLET_USER_OWNER'); record('OTHER_WALLET_USER_DENIED');
  const tx = await model('WalletTransaction').create({ userId: id(a), walletId: id(aw), transactionType: 'credit', amount: 1, balanceBefore: 0, balanceAfter: 1 });
  const btx = await model('WalletTransaction').create({ userId: id(b), walletId: id(bw), transactionType: 'credit', amount: 1, balanceBefore: 0, balanceAfter: 1 });
  response = await request('GET', '/wallet/transactions/' + id(tx), alpha.token);
  need(response.status === 200 && response.body.data.userId === id(a), 'TRANSACTION_OWNER');
  response = await request('GET', '/wallet/user/' + id(a) + '/transactions', alpha.token);
  need(response.status === 200 && Array.isArray(response.body.data) && response.body.data.some(row => row._id === id(tx)), 'TRANSACTION_OWNER_LIST'); record('OWN_TRANSACTION_READ');
  await deny('GET', '/wallet/transactions/' + id(btx), alpha.token, undefined, [403], 'TRANSACTION_OTHER'); record('OTHER_TRANSACTION_DENIED');
  const detached = await model('WalletTransaction').create({ userId: id(b), transactionType: 'credit', amount: 1, balanceBefore: 0, balanceAfter: 1 });
  await deny('GET', '/wallet/transactions/' + id(detached), alpha.token, undefined, [403], 'TRANSACTION_NO_WALLET_OWNER'); record('TRANSACTION_WITHOUT_WALLET_OWNER');
  for (const [method, route, body] of [['POST', '/wallet', { userId: id(b), initialBalance: 500 }],
    ['PUT', '/wallet/' + id(bw), { isActive: false }], ['POST', '/wallet/transactions', { userId: id(b), transactionType: 'credit', amount: 500 }],
    ['POST', '/wallet/transactions', { userId: id(b), transactionType: 'debit', amount: 1 }], ['GET', '/wallet', undefined]])
    await deny(method, route, alpha.token, body, [403], 'WALLET_ADMIN_ONLY');
  record('WALLET_MUTATIONS_DENIED');
  await deny('GET', '/users/' + id(a), undefined, undefined, [401], 'ANONYMOUS'); record('ANONYMOUS_DENIED');
  await deny('GET', '/users/' + id(a), ctx.originalSign({ _id: id(a), userType: 'user' }, crypto.randomBytes(32).toString('hex')), undefined, [401], 'WRONG_SIGNATURE', 'INVALID_TOKEN'); record('WRONG_KEY_DENIED');
  await deny('GET', '/users/' + id(a), ctx.originalSign({ _id: id(a), userType: 'user' }, ctx.key, { expiresIn: -1 }), undefined, [401], 'EXPIRED_JWT', 'TOKEN_EXPIRED'); record('EXPIRED_JWT_DENIED');
  await deny('GET', '/wallet/' + id(aw), actor({ userType: 'user' }), undefined, [401], 'MISSING_PRINCIPAL'); record('MISSING_PRINCIPAL_DENIED');
  await deny('GET', '/wallet/not-an-id', alpha.token, undefined, [400], 'MALFORMED_ID'); record('MALFORMED_WALLET_ID');
  await deny('GET', '/wallet/' + uid(), alpha.token, undefined, [404], 'ABSENT_WALLET'); record('ABSENT_WALLET');
  await model('Admin').create({ email: 'admin@example.com', isActive: true, userType: 'admin' });
  const admin = await login({ email: 'admin@example.com' }, 'admin');
  for (const route of ['/users/' + id(b), '/wallet/' + id(bw), '/wallet/transactions/' + id(btx)]) {
    response = await request('GET', route, admin.token); need(response.status === 200, 'ADMIN_POSITIVE_READ');
  }
  record('ADMIN_READS');
  const corp = uid(); const otherCorp = uid();
  const employee = await makeUser({ email: 'employee@example.com', corporateId: corp });
  const outsider = await makeUser({ email: 'outsider@example.com', corporateId: otherCorp });
  await model('HR').create({ employeeId: 'SYNTHETIC-HR-1', firstName: 'Synthetic', lastName: 'HR', email: 'hr@example.com', corporateId: corp, isActive: true });
  const hr = await login({ email: 'hr@example.com' }, 'hr');
  response = await request('GET', '/users/' + id(employee), hr.token); need(response.status === 200, 'HR_OWN_CORPORATE');
  await deny('GET', '/users/' + id(outsider), hr.token, undefined, [403], 'HR_OTHER_CORPORATE');
  await deny('GET', '/users?forUser=true', hr.token, undefined, [403], 'HR_SCOPE_ESCAPE');
  response = await request('GET', '/users?corporateId=' + otherCorp, hr.token);
  const listed = response.body?.data?.users; const list = Array.isArray(listed) ? listed : listed?.data;
  need(response.status === 200 && Array.isArray(list) && list.length >= 1 && list.every(row => row.corporateId === corp), 'HR_LIST_SCOPE'); record('HR_CORPORATE_SCOPE');
  await deny('GET', '/users/' + id(employee), actor({ _id: uid(), userType: 'hr' }), undefined, [403], 'HR_NO_CORPORATE', 'HR_CORPORATE_REQUIRED'); record('HR_WITHOUT_CORPORATE_DENIED');
  for (const role of ['specialist', 'pharmacy']) await deny('GET', '/users/' + id(a), actor({ _id: id(a), userType: role }), undefined, [403], 'ROLE_SCOPE');
  record('SPECIALIST_AND_PHARMACY_DENIED');
  await rejectChallenge(a, { wrong: true }, 'WRONG_OTP_DENIED', [404]);
  await rejectChallenge(a, { verified: true }, 'CONSUMED_OTP_DENIED', [400]);
  await rejectChallenge(a, { expireAt: new Date(Date.now() - 1) }, 'EXPIRED_OTP_DENIED', [400, 404]);
  await targetProbe(); record('TARGET_BINDING_DENIED');
  await rejectChallenge(a, { unbound: true }, 'UNBOUND_OTP_DENIED', [404]);
  await overlap(a); record('OTP_SINGLE_WINNER');

  const expiring = await challenge(a, { expireAt: new Date(Date.now() + 1200) });
  const proto = mongoose.Query.prototype; const original = proto.exec; let delayed = false;
  proto.exec = async function (...args) {
    const result = await original.apply(this, args);
    if (this.model.modelName === 'OTP' && this.op === 'findOneAndUpdate' && String(this.getFilter()._id) === id(expiring.row)) {
      delayed = true; await delay(Math.max(0, expiring.row.expireAt.getTime() - Date.now()) + 30);
    }
    return result;
  };
  const state = await snapshot(false); const jwtCount = ctx.counters.jwtIssued; const sentCount = ctx.counters.email + ctx.counters.sms + ctx.counters.push;
  try {
    response = await request('POST', '/auth/user/verify', undefined, { ...expiring.contact, otp: expiring.code });
    need(delayed && response.status === 400, 'INFLIGHT_EXPIRY_STATUS'); errorEnvelope(response, 'OTP_EXPIRED');
    need(await snapshot(false) === state && ctx.counters.jwtIssued === jwtCount
      && ctx.counters.email + ctx.counters.sms + ctx.counters.push === sentCount, 'INFLIGHT_EXPIRY_SIDE_EFFECTS');
    const proof = await model('OTP').findById(expiring.row._id).lean().exec();
    need(!proof || proof.isVerified === true, 'INFLIGHT_EXPIRY_CONSUMED');
  } finally { proto.exec = original; }
  await model('OTP').deleteOne({ _id: expiring.row._id });
  record('OTP_INFLIGHT_EXPIRY_DENIED');

  await cleanCompletedProofs();
  await runAuthorityNominal(admin.token);

  need(cases.length === 53 && same(cases.map(row => row.id), ctx.ports.requiredCaseIds.slice(0, 53)), 'JWT_CONFIG_PRIOR_CASE_SET');
  for (const row of configuration.cases) record(row.id);
  const currentKeyRead = await readSuccess('/users/' + id(a), alpha.token);
  need(currentKeyRead.data?.user?._id === id(a), 'JWT_CONFIG_CURRENT_KEY_OWNER');
  for (const published of ['your-secret-key', 'your-secret-key-change-in-production']) {
    // Explicit fixture tokens use the genuine library; neither value comes from
    // a real deployment/environment and no token or key is retained in output.
    const forged = ctx.originalSign({ _id: id(a), userType: 'user' }, published, { algorithm: 'HS256', expiresIn: '5m' });
    await authorityDeny('GET', '/users/' + id(a), forged, undefined, 401, 'INVALID_TOKEN', true);
  }
  record('JWT_PUBLISHED_FALLBACK_TOKEN_DENIED');

  need(cases.length === 60 && same(cases.map(row => row.id), ctx.ports.requiredCaseIds.slice(0, 60)), 'MEET_PRIOR_CASE_SET');
  await runMeetNominal(admin.token, alpha.token);

  // Separate negative phases use emitted variants of the actual frozen source.
  // Fresh production classes, TypeDI registrations and HTTP server each phase.
  const nominalCounters = { ...ctx.counters };
  const mutations = [
    ['OTP_UNCONDITIONAL_CONSUME', '@/modules/otp/repository', async () => { await overlap(a, true); }],
    ['OTP_LOGIN_TARGET_UNBOUND', '@/modules/auth/services', async () => { await targetProbe(true); }],
    ['USER_OTHER_READ', '@/modules/user/controller', async () => {
      const result = await request('GET', '/users/' + id(b), alpha.token); need(result.status === 200 && result.body.data.user._id === id(b), 'USER_MUTANT_NOT_DETECTED');
    }],
    ['WALLET_OTHER_READ', '@/modules/wallet/controller', async () => {
      const result = await request('GET', '/wallet/' + id(bw), alpha.token); need(result.status === 200 && result.body.data.userId === id(b), 'WALLET_MUTANT_NOT_DETECTED');
    }],
  ];
  for (const [name, alias, probe] of mutations) {
    need(ctx.plan.mutants[name]?.file, 'MISSING_SOURCE_MUTANT');
    const unexpectedBefore = ctx.counters.unexpected; const excludedBefore = ctx.counters.excluded;
    await ctx.nextPhase({ [alias]: ctx.plan.mutants[name].file }); await probe();
    await cleanCompletedProofs();
    need(ctx.counters.unexpected === unexpectedBefore && ctx.counters.excluded === excludedBefore, 'SENSITIVITY_UNDECLARED_EFFECT');
    await ctx.nextPhase({}); sensitivity.push({ id: name, detected: true });
  }
  await runAuthoritySensitivity(admin.token);
  need(sensitivity.length === 14 && same(sensitivity.map(row => row.id), ctx.ports.requiredSensitivityIds.slice(0, 14)), 'JWT_CONFIG_PRIOR_SENSITIVITY_SET');
  for (const row of configuration.sensitivity) sensitivity.push({ id: row.id, detected: true });
  need(sensitivity.length === 17 && same(sensitivity.map(row => row.id), ctx.ports.requiredSensitivityIds.slice(0, 17)), 'MEET_PRIOR_SENSITIVITY_SET');
  await runMeetSensitivity(alpha.token);
  // Prove fresh nominal classes restore the two owner boundaries after mutants.
  await deny('GET', '/users/' + id(b), alpha.token, undefined, [403], 'RESTORED_USER_OWNER');
  await deny('GET', '/wallet/' + id(bw), alpha.token, undefined, [403], 'RESTORED_WALLET_OWNER');
  need(ctx.counters.unexpected === 0 && ctx.counters.excluded === 0, 'UNDECLARED_CAPABILITY_EFFECT');
  return { cases, sensitivity, failed: 0, skipped: 0, providerSummary: {
    email: nominalCounters.email, sms: nominalCounters.sms, push: nominalCounters.push, logger: nominalCounters.logger,
    payments: 0, calendar: nominalCounters.calendar, storage: 0, queue: 0, deniedCapabilities: nominalCounters.excluded, unexpected: nominalCounters.unexpected,
  } };
}

module.exports = { runScenario, requireConfigurationEvidence };
