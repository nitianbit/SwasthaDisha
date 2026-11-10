'use strict';
// Evaluated only by the fully admitted container bootstrap. Never print fixtures,
// responses, OTPs, tokens, keys, database rows or assertion operands.
const http = require('node:http');
const crypto = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runScenario(ctx) {
  const { mongoose, need } = ctx;
  const model = name => mongoose.model(name);
  const uid = () => new mongoose.Types.ObjectId().toString();
  const id = row => String(row._id);
  const cases = []; const sensitivity = [];
  const record = name => { need(!cases.some(row => row.id === name), 'DUPLICATE_CASE'); cases.push({ id: name, status: 'PASS' }); };
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
  const providerState = () => ['email', 'sms', 'push', 'unexpected', 'excluded', 'jwtIssued', 'dbWrites'].map(k => ctx.counters[k]);
  async function snapshot(includeOTP = true) {
    const names = ['User', 'Admin', 'HR', 'Wallet', 'WalletTransaction', 'Notification', ...(includeOTP ? ['OTP'] : [])];
    const rows = await Promise.all(names.map(name => model(name).find({}).sort({ _id: 1 }).lean().exec()));
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  async function deny(method, route, token, body, statuses, code, expectedCode) {
    const before = await snapshot(); const effects = providerState();
    const response = await request(method, route, token, body);
    need(statuses.includes(response.status) && !response.body?.data?.token, code + '_STATUS');
    const expected = expectedCode || ({ 400: 'VALIDATION_ERROR', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'WALLET_NOT_FOUND', 422: 'FORBIDDEN_FIELD' })[response.status];
    need(response.body.code === expected, code + '_ERROR_CODE');
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
    return { row, code, contact: { [target]: user[target] } };
  }
  async function rejectChallenge(user, options, caseId, statuses) {
    const c = await challenge(user, options); const before = await snapshot(false); const effects = providerState();
    const result = await request('POST', '/auth/user/verify', undefined, { ...c.contact, otp: options.wrong ? '000000' : c.code });
    need(statuses.includes(result.status) && !result.body?.data?.token, caseId + '_STATUS');
    const expected = result.status === 404 ? 'OTP_NOT_FOUND' : options.verified ? 'OTP_ALREADY_VERIFIED' : 'OTP_EXPIRED';
    need(result.body.code === expected, caseId + '_ERROR_CODE');
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
    const tokens = ctx.counters.jwtIssued; const notifications = await model('Notification').countDocuments({ userId: id(user), type: 'login' });
    const wallets = await model('Wallet').countDocuments({ userId: id(user) });
    let results;
    try { results = await Promise.all([1, 2].map(() => request('POST', '/auth/user/verify', undefined, { ...c.contact, otp: c.code }))); }
    finally { proto.exec = original; clearTimeout(timeout); }
    need(arrivals === 2, 'OVERLAP_NOT_ESTABLISHED');
    const successes = results.filter(r => r.status === 200 && typeof r.body?.data?.token === 'string').length;
    const expected = mutant ? 2 : 1;
    need(successes === expected && ctx.counters.jwtIssued - tokens === expected, 'OVERLAP_ISSUANCE_COUNT');
    if (!mutant) need(results.filter(r => r.status === 400 && r.body.code === 'OTP_UNAVAILABLE').length === 1, 'OVERLAP_LOSER_DENIAL');
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
      need(response.status === 404 && response.body.code === 'OTP_NOT_FOUND', 'TARGET_BINDING_STATUS');
      need(await snapshot(false) === before && JSON.stringify(providerState()) === JSON.stringify(effects), 'TARGET_BINDING_SIDE_EFFECTS');
      need((await model('OTP').findById(c.row._id).lean().exec()).isVerified === false, 'TARGET_BINDING_PROOF');
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
    need(delayed && response.status === 400 && response.body.code === 'OTP_EXPIRED', 'INFLIGHT_EXPIRY_STATUS');
    need(await snapshot(false) === state && ctx.counters.jwtIssued === jwtCount
      && ctx.counters.email + ctx.counters.sms + ctx.counters.push === sentCount, 'INFLIGHT_EXPIRY_SIDE_EFFECTS');
    const proof = await model('OTP').findById(expiring.row._id).lean().exec();
    need(!proof || proof.isVerified === true, 'INFLIGHT_EXPIRY_CONSUMED');
  } finally { proto.exec = original; }
  await model('OTP').deleteOne({ _id: expiring.row._id });
  record('OTP_INFLIGHT_EXPIRY_DENIED');

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
    try {
      const unexpectedBefore = ctx.counters.unexpected; const excludedBefore = ctx.counters.excluded;
      await ctx.nextPhase({ [alias]: ctx.plan.mutants[name].file }); await probe();
      need(ctx.counters.unexpected === unexpectedBefore && ctx.counters.excluded === excludedBefore, 'SENSITIVITY_UNDECLARED_EFFECT');
      sensitivity.push({ id: name, detected: true });
    }
    finally { await ctx.nextPhase({}); }
  }
  // Prove fresh nominal classes restore the two owner boundaries after mutants.
  await deny('GET', '/users/' + id(b), alpha.token, undefined, [403], 'RESTORED_USER_OWNER');
  await deny('GET', '/wallet/' + id(bw), alpha.token, undefined, [403], 'RESTORED_WALLET_OWNER');
  need(ctx.counters.unexpected === 0 && ctx.counters.excluded === 0, 'UNDECLARED_CAPABILITY_EFFECT');
  return { cases, sensitivity, failed: 0, skipped: 0, providerSummary: {
    email: nominalCounters.email, sms: nominalCounters.sms, push: nominalCounters.push, logger: nominalCounters.logger,
    payments: 0, calendar: 0, storage: 0, queue: 0, deniedCapabilities: nominalCounters.excluded, unexpected: nominalCounters.unexpected,
  } };
}

module.exports = { runScenario };
