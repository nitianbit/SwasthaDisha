'use strict';
// This file performs admission before requiring any package/domain module.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const ROOT = '/workspace';
const ROLE = 'auth-user-wallet-api';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => { const error = new Error(code); error.fixtureCode = code; throw error; };
const need = (ok, code) => { if (!ok) fail(code); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const stdout = process.stdout.write.bind(process.stdout);
let stage = 'ADMISSION';
const counters = { email: 0, sms: 0, push: 0, logger: 0, console: 0, unexpected: 0, excluded: 0, jwtIssued: 0, dbWrites: 0 };
for (const name of ['log', 'info', 'debug', 'warn', 'error']) console[name] = () => { counters.console++; };
process.emitWarning = () => { counters.console++; };

// Public literals only: no driver message, URI, path, row or validation fields.
const SETUP_FAILURE_CODES = Object.freeze({
  CONNECT: Object.freeze({
    PERMISSION: 'DB_CONNECT_PERMISSION', SELECTION: 'DB_CONNECT_SELECTION',
    NETWORK: 'DB_CONNECT_NETWORK', SERVER: 'DB_CONNECT_SERVER', TYPE_ERROR: 'DB_CONNECT_TYPE_ERROR',
    DUPLICATE_KEY: 'DB_CONNECT_DUPLICATE_KEY', NAMESPACE_EXISTS: 'DB_CONNECT_NAMESPACE_EXISTS',
    INDEX_CONFLICT: 'DB_CONNECT_INDEX_CONFLICT',
    OUT_OF_DISK_SPACE: 'DB_CONNECT_OUT_OF_DISK_SPACE', CANNOT_CREATE_INDEX: 'DB_CONNECT_CANNOT_CREATE_INDEX',
    INVALID_OPTIONS: 'DB_CONNECT_INVALID_OPTIONS', UNKNOWN: 'DB_CONNECT_UNKNOWN',
  }),
  HELLO: Object.freeze({
    PERMISSION: 'DB_HELLO_PERMISSION', SELECTION: 'DB_HELLO_SELECTION',
    NETWORK: 'DB_HELLO_NETWORK', SERVER: 'DB_HELLO_SERVER', TYPE_ERROR: 'DB_HELLO_TYPE_ERROR',
    DUPLICATE_KEY: 'DB_HELLO_DUPLICATE_KEY', NAMESPACE_EXISTS: 'DB_HELLO_NAMESPACE_EXISTS',
    INDEX_CONFLICT: 'DB_HELLO_INDEX_CONFLICT',
    OUT_OF_DISK_SPACE: 'DB_HELLO_OUT_OF_DISK_SPACE', CANNOT_CREATE_INDEX: 'DB_HELLO_CANNOT_CREATE_INDEX',
    INVALID_OPTIONS: 'DB_HELLO_INVALID_OPTIONS', UNKNOWN: 'DB_HELLO_UNKNOWN',
  }),
  COLLECTION_CREATE: Object.freeze({
    PERMISSION: 'DB_COLLECTION_CREATE_PERMISSION', SELECTION: 'DB_COLLECTION_CREATE_SELECTION',
    NETWORK: 'DB_COLLECTION_CREATE_NETWORK', SERVER: 'DB_COLLECTION_CREATE_SERVER', TYPE_ERROR: 'DB_COLLECTION_CREATE_TYPE_ERROR',
    DUPLICATE_KEY: 'DB_COLLECTION_CREATE_DUPLICATE_KEY', NAMESPACE_EXISTS: 'DB_COLLECTION_CREATE_NAMESPACE_EXISTS',
    INDEX_CONFLICT: 'DB_COLLECTION_CREATE_INDEX_CONFLICT',
    OUT_OF_DISK_SPACE: 'DB_COLLECTION_CREATE_OUT_OF_DISK_SPACE', CANNOT_CREATE_INDEX: 'DB_COLLECTION_CREATE_CANNOT_CREATE_INDEX',
    INVALID_OPTIONS: 'DB_COLLECTION_CREATE_INVALID_OPTIONS', UNKNOWN: 'DB_COLLECTION_CREATE_UNKNOWN',
  }),
  INDEX_CREATE: Object.freeze({
    PERMISSION: 'DB_INDEX_CREATE_PERMISSION', SELECTION: 'DB_INDEX_CREATE_SELECTION',
    NETWORK: 'DB_INDEX_CREATE_NETWORK', SERVER: 'DB_INDEX_CREATE_SERVER', TYPE_ERROR: 'DB_INDEX_CREATE_TYPE_ERROR',
    DUPLICATE_KEY: 'DB_INDEX_CREATE_DUPLICATE_KEY', NAMESPACE_EXISTS: 'DB_INDEX_CREATE_NAMESPACE_EXISTS',
    INDEX_CONFLICT: 'DB_INDEX_CREATE_INDEX_CONFLICT',
    OUT_OF_DISK_SPACE: 'DB_INDEX_CREATE_OUT_OF_DISK_SPACE', CANNOT_CREATE_INDEX: 'DB_INDEX_CREATE_CANNOT_CREATE_INDEX',
    INVALID_OPTIONS: 'DB_INDEX_CREATE_INVALID_OPTIONS', UNKNOWN: 'DB_INDEX_CREATE_UNKNOWN',
  }),
});
const SETUP_GUARD_CODES = new Set([
  'UNDECLARED_DATABASE_URI', 'EXTRA_DATABASE_CONNECTION', 'OTHER_DATABASE_NAME',
  'UNDECLARED_DRIVER_URI', 'OTHER_DRIVER_DATABASE', 'UNDECLARED_COLLECTION',
  'UNDECLARED_COLLECTION_CREATE', 'UNDECLARED_NETWORK_CONNECTION', 'TLS_NOT_ADMITTED',
  'DNS_NOT_ADMITTED', 'DENIED_BUILTIN', 'UNDECLARED_DOMAIN_MODULE', 'UNDECLARED_PACKAGE_OR_FILE',
]);
const SETUP_ERROR_NAMES = new Set([
  'MongoServerSelectionError', 'MongooseServerSelectionError', 'MongoNetworkError',
  'MongoNetworkTimeoutError', 'MongoServerError', 'MongoBulkWriteError',
  'MongoWriteConcernError', 'TypeError',
]);
const ownData = (value, key) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
};
function setupErrorName(value) {
  const own = ownData(value, 'name');
  if (SETUP_ERROR_NAMES.has(own)) return own;
  let prototype = value;
  for (let depth = 0; depth < 3; depth++) {
    try { prototype = Object.getPrototypeOf(prototype); } catch { return undefined; }
    if (!prototype) return undefined;
    const name = ownData(prototype, 'name');
    if (SETUP_ERROR_NAMES.has(name)) return name;
    const constructor = ownData(prototype, 'constructor');
    const constructorName = typeof constructor === 'function' ? ownData(constructor, 'name') : undefined;
    if (SETUP_ERROR_NAMES.has(constructorName)) return constructorName;
  }
  return undefined;
}
function setupFailure(error) {
  const chain = []; const seen = new Set(); let value = error;
  for (let depth = 0; depth < 3 && value !== null
    && ['object', 'function'].includes(typeof value) && !seen.has(value); depth++) {
    chain.push({ value, name: setupErrorName(value), code: ownData(value, 'code') });
    seen.add(value); value = ownData(value, 'cause');
  }
  for (const row of chain) {
    const guard = ownData(row.value, 'fixtureCode');
    if (SETUP_GUARD_CODES.has(guard)) return { guard };
  }
  if (chain.some(row => ['ERR_ACCESS_DENIED', 'EACCES', 'EPERM', 13, 18].includes(row.code))) return { category: 'PERMISSION' };
  if (chain.some(row => row.code === 11000)) return { category: 'DUPLICATE_KEY' };
  if (chain.some(row => row.code === 48)) return { category: 'NAMESPACE_EXISTS' };
  if (chain.some(row => [85, 86].includes(row.code))) return { category: 'INDEX_CONFLICT' };
  if (chain.some(row => row.code === 14031)) return { category: 'OUT_OF_DISK_SPACE' };
  if (chain.some(row => row.code === 67)) return { category: 'CANNOT_CREATE_INDEX' };
  if (chain.some(row => row.code === 72)) return { category: 'INVALID_OPTIONS' };
  if (chain.some(row => ['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
    'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(row.code)
    || ['MongoNetworkError', 'MongoNetworkTimeoutError'].includes(row.name))) return { category: 'NETWORK' };
  if (chain.some(row => ['MongoServerSelectionError', 'MongooseServerSelectionError'].includes(row.name))) return { category: 'SELECTION' };
  if (chain.some(row => [26, 50, 91, 10107, 11600, 11602].includes(row.code)
    || ['MongoServerError', 'MongoBulkWriteError', 'MongoWriteConcernError'].includes(row.name))) return { category: 'SERVER' };
  if (chain.some(row => row.name === 'TypeError')) return { category: 'TYPE_ERROR' };
  return { category: 'UNKNOWN' };
}
async function runSetupStep(step, action) {
  need(typeof step === 'string' && Object.hasOwn(SETUP_FAILURE_CODES, step) && typeof action === 'function', 'UNDECLARED_SETUP_STEP');
  try { return await action(); } catch (error) {
    const classification = setupFailure(error);
    const code = classification.guard || SETUP_FAILURE_CODES[step][classification.category];
    // Preserve the original thrown value only as a non-enumerable memory cause.
    // The existing seven-field output sees a fresh safe Error, no raw metadata.
    const wrapped = new Error(code, { cause: error }); wrapped.fixtureCode = code; throw wrapped;
  }
}

async function withOwnedCleanup(action, closeHTTP, disconnectODM) {
  need(typeof action === 'function' && typeof closeHTTP === 'function'
    && typeof disconnectODM === 'function', 'INVALID_OWNED_CLEANUP_PORTS');
  let result; let primary; let failed = false;
  try { result = await action(); } catch (error) { primary = error; failed = true; }
  const failures = [];
  for (const [step, close] of [['HTTP', closeHTTP], ['ODM', disconnectODM]]) {
    try { await close(); } catch (error) { failures.push(Object.freeze({ step, error })); }
  }
  function retainPrivately(error) {
    if (error !== null && ['object', 'function'].includes(typeof error) && failures.length) {
      try { Object.defineProperty(error, 'ownedCleanupFailures', { value: Object.freeze(failures) }); } catch {}
    }
    return error;
  }
  if (failed) throw retainPrivately(primary);
  if (failures.length) {
    const error = new Error('OWNED_HANDLE_CLEANUP_FAILED', { cause: failures[0].error });
    error.fixtureCode = 'OWNED_HANDLE_CLEANUP_FAILED'; throw retainPrivately(error);
  }
  return result;
}

function bytes(relative) {
  need(typeof relative === 'string' && relative !== '' && !relative.startsWith('/')
    && !relative.split('/').includes('..') && !relative.includes('\\'), 'BAD_RELATIVE_PATH');
  const p = path.join(ROOT, relative); const m = fs.lstatSync(p);
  need(m.isFile() && !m.isSymbolicLink() && m.nlink === 1, 'NONREGULAR_RUNTIME_FILE');
  return fs.readFileSync(p);
}

function validateAdmissionData(manifest, plan, ports, observed) {
  need(plain(manifest) && manifest.schema === 'SD-AUTH-API-RUN-1' && manifest.role === ROLE, 'RUN_MANIFEST_SCHEMA');
  need(/^[a-f0-9-]{36}$/.test(manifest.runId) && manifest.runId === observed.runId, 'RUN_ID');
  const nonce = manifest.runId.replaceAll('-', '');
  need(manifest.database === 'sd_api_' + nonce && manifest.replicaSet === 'sd_rs_' + nonce, 'DATABASE_IDENTITY');
  need(/^[a-f0-9]{64}$/.test(manifest.mongoId) && /^[a-f0-9]{64}$/.test(manifest.templateSha)
    && /^[a-f0-9]{40}$/.test(manifest.sourceCommit), 'RESOURCE_IDENTITY');
  need(plain(manifest.files) && Object.keys(manifest.files).length > 5 && Object.keys(manifest.files).length <= 20000
    && plain(observed.files), 'FILE_MANIFEST');
  need(JSON.stringify(Object.keys(observed.files).sort()) === JSON.stringify(Object.keys(manifest.files).sort()), 'RUNTIME_FILE_SET');
  let size = 0;
  for (const [name, data] of Object.entries(observed.files)) {
    need(Buffer.isBuffer(data) && /^[a-f0-9]{64}$/.test(manifest.files[name])
      && sha(data) === manifest.files[name], 'RUNTIME_FILE_HASH'); size += data.length;
  }
  need(size <= 256 * 1024 * 1024, 'RUNTIME_FILE_LIMIT');
  need(['bootstrap.cjs', 'scenario.cjs', 'network-admission.mjs', 'runtime-plan.json', 'ports-manifest.json', 'package-lock.json']
    .every(name => Buffer.isBuffer(observed.files[name])), 'MISSING_RUNTIME_INPUT');
  need(manifest.lockSha === sha(observed.files['package-lock.json'])
    && manifest.portsSha === sha(observed.files['ports-manifest.json']), 'LOCK_PORT_HASH');
  need(plan.schema === 'SD-AUTH-API-PLAN-1' && plan.role === ROLE && plan.sourceCommit === manifest.sourceCommit
    && plan.lockSha === manifest.lockSha && plan.portsSha === manifest.portsSha, 'PLAN_IDENTITY');
  need(plan.compilation.status === 'TRANSPILE_ONLY_NOT_TYPECHECKED' && plan.compilation.compiler === '5.9.3', 'COMPILATION_STATUS');
  need(ports.schema === 'SD-AUTH-API-PORTS-1' && ports.role === ROLE
    && JSON.stringify(plan.requiredCaseIds) === JSON.stringify(ports.requiredCaseIds)
    && JSON.stringify(plan.requiredSensitivityIds) === JSON.stringify(ports.requiredSensitivityIds)
    && JSON.stringify(plan.providerCounterKeys) === JSON.stringify(ports.providerCounterKeys)
    && JSON.stringify(plan.models) === JSON.stringify(ports.models), 'PORT_CONTRACT');
  need(Array.isArray(ports.requiredCaseIds) && ports.requiredCaseIds.length >= 20
    && new Set(ports.requiredCaseIds).size === ports.requiredCaseIds.length, 'CASE_SET');
  need(JSON.stringify(ports.recordingModules) === JSON.stringify(['@/services/logger', '@/services/firebase'])
    && JSON.stringify(ports.excludedCapabilities) === JSON.stringify({ '@/modules/payment/services': ['PaymentService'], '@/modules/coupon/services': ['CouponService'] })
    && ports.recordingAxios.email === 'https://api.smtp2go.com/v3/email/send'
    && ports.recordingAxios.sms === 'https://sms.fixture.invalid/send', 'RECORDING_PORT_MAP');
  need(plain(plan.modules) && plain(plan.mutants) && plain(plan.sourceFiles)
    && Object.keys(plan.sourceFiles).length > 0 && Object.values(plan.sourceFiles).every(value => /^[a-f0-9]{64}$/.test(value)), 'SOURCE_MANIFEST');
  for (const file of Object.values(plan.modules)) need(Object.hasOwn(manifest.files, file), 'UNDECLARED_COMPILED_SOURCE');
  for (const alias of ports.roots) need(Object.hasOwn(plan.modules, alias), 'MISSING_ROUTER_SOURCE');
  for (const mutant of Object.values(plan.mutants)) need(Object.hasOwn(manifest.files, mutant.file)
    && mutant.originalSha256 === plan.sourceFiles[mutant.source], 'UNDECLARED_MUTANT');
  need(Array.isArray(ports.models) && ports.models.length === 12
    && new Set(ports.models.map(row => row.name)).size === 12
    && new Set(ports.models.map(row => row.collection)).size === 12
    && ports.models.every(row => Object.hasOwn(plan.sourceFiles, row.source) && Array.isArray(row.indexes)), 'MODEL_MAP');
  return manifest;
}

function inspectManifest(manifest, plan, ports) {
  const observed = {}; let size = 0;
  function walk(directory, prefix = '') {
    for (const name of fs.readdirSync(directory)) {
      const relative = prefix + name; const p = path.join(directory, name); const m = fs.lstatSync(p);
      need(!m.isSymbolicLink(), 'RUNTIME_LINK');
      if (m.isDirectory()) walk(p, relative + '/');
      else {
        need(m.isFile() && m.nlink === 1 && !name.endsWith('.node') && !name.startsWith('.env'), 'RUNTIME_FILE_TYPE');
        if (relative === '.admission.json') continue;
        size += m.size; need(size <= 256 * 1024 * 1024 && Object.keys(observed).length < 20000, 'RUNTIME_FILE_LIMIT');
        observed[relative] = fs.readFileSync(p);
      }
    }
  }
  walk(ROOT);
  return validateAdmissionData(manifest, plan, ports, { runId: process.env.APP_RUN_ID, files: observed });
}

function closeNetwork() {
  const httpPorts = new Set();
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let value = args[0];
    if (Array.isArray(value)) value = value[0];
    const options = plain(value) ? value : { port: value, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    const host = options.host || 'localhost'; const port = Number(options.port);
    if (options.path || !['127.0.0.1', 'localhost', '::1'].includes(host)
      || !Number.isInteger(port) || !(port === 27017 || httpPorts.has(port))) {
      counters.unexpected++; fail('UNDECLARED_NETWORK_CONNECTION');
    }
    return original.apply(this, args);
  };
  tls.connect = () => { counters.unexpected++; fail('TLS_NOT_ADMITTED'); };
  const lookup = dns.lookup;
  dns.lookup = (host, ...args) => {
    need(['localhost', '127.0.0.1', '::1'].includes(host), 'DNS_NOT_ADMITTED');
    return lookup.call(dns, host, ...args);
  };
  for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveSrv', 'resolveTxt', 'reverse']) {
    dns[name] = () => { counters.unexpected++; fail('DNS_NOT_ADMITTED'); };
  }
  return httpPorts;
}

function installLoader(manifest, plan, ports) {
  const originalResolve = Module._resolveFilename;
  const originalLoad = Module._load;
  const builtins = new Set(Module.builtinModules.map(name => name.replace(/^node:/, '')));
  const deniedBuiltins = new Set(['child_process', 'worker_threads', 'vm', 'inspector', 'repl', 'module']);
  const optional = new Set(ports.optionalAbsentPackages);
  let substitutes = {}; let overrides = {};
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request.startsWith('@/')) {
      const relative = overrides[request] || plan.modules[request];
      need(relative && Object.hasOwn(manifest.files, relative), 'UNDECLARED_DOMAIN_MODULE');
      return path.join(ROOT, relative);
    }
    const builtin = request.replace(/^node:/, '');
    if (builtins.has(builtin)) {
      need(!deniedBuiltins.has(builtin), 'DENIED_BUILTIN');
      return originalResolve.call(this, request, parent, isMain, options);
    }
    if (optional.has(request)) { const error = new Error('Optional fixture package absent'); error.code = 'MODULE_NOT_FOUND'; throw error; }
    const filename = originalResolve.call(this, request, parent, isMain, options);
    const relative = path.relative(ROOT, filename).split(path.sep).join('/');
    need(!relative.startsWith('../') && Object.hasOwn(manifest.files, relative), 'UNDECLARED_PACKAGE_OR_FILE');
    return filename;
  };
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(substitutes, request)) return substitutes[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  return {
    phase(nextSubstitutes, nextOverrides = {}) {
      substitutes = nextSubstitutes; overrides = nextOverrides;
    },
    resetCompiled() {
      for (const filename of Object.keys(require.cache)) {
        if (filename.startsWith(ROOT + '/compiled/') && !filename.includes('/model/')) delete require.cache[filename];
      }
    },
    load: name => require(name),
  };
}

function recordingPorts(ports, typedi) {
  const deliveries = [];
  const logger = { info() { counters.logger++; }, error() { counters.logger++; }, warn() { counters.logger++; }, debug() { counters.logger++; } };
  class PaymentService { createOrder() { counters.excluded++; fail('PAYMENT_CAPABILITY_EXCLUDED'); } }
  class CouponService { validateWalletCoupon() { counters.excluded++; fail('COUPON_CAPABILITY_EXCLUDED'); } }
  typedi.Service()(PaymentService); typedi.Service()(CouponService);
  const substitutes = {
    '@/services/logger': { __esModule: true, default: logger, logger, showError() { counters.logger++; } },
    '@/services/firebase': { getFirebaseMessaging: () => ({ sendEachForMulticast: async () => { counters.push++; return { successCount: 0, failureCount: 0, responses: [] }; } }) },
    '@/modules/payment/services': { PaymentService }, '@/modules/coupon/services': { CouponService },
  };
  return { substitutes, deliveries,
    adapter: async config => {
      const method = (config.method || 'get').toLowerCase();
      let destination; let body;
      if (method === 'post' && config.url === ports.recordingAxios.email) {
        const data = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
        need(plain(data) && Array.isArray(data.to) && data.to.length === 1 && !data.cc && !data.bcc, 'EMAIL_ENVELOPE');
        destination = data.to[0]; body = data.text_body; counters.email++;
      } else if (method === 'get' && config.url === ports.recordingAxios.sms) {
        destination = config.params.to; body = config.params.text; counters.sms++;
      } else { counters.unexpected++; fail('UNDECLARED_AXIOS_REQUEST'); }
      need(typeof destination === 'string' && typeof body === 'string', 'DELIVERY_SHAPE');
      const codes = [...body.matchAll(/\b[0-9]{6}\b/g)].map(row => row[0]);
      need(codes.length === 1, 'DELIVERY_CODE_COUNT');
      deliveries.push({ destination, code: codes[0], kind: method === 'post' ? 'email' : 'sms' });
      return { data: { success: true, data: {} }, status: 200, statusText: 'OK', headers: {}, config };
    },
  };
}

async function main() {
  const allowed = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION', 'HOME', 'HOSTNAME', 'NODE_ENV', 'APP_RUN_ID', 'APP_ROLE', 'APP_MANIFEST_SHA']);
  need(Object.keys(process.env).every(key => allowed.has(key)) && process.env.NODE_ENV === 'test'
    && process.env.APP_ROLE === ROLE && process.cwd() === ROOT && process.version === 'v22.23.4'
    && process.platform === 'linux' && process.permission, 'UNADMITTED_ENVIRONMENT');
  need(!fs.existsSync(ROOT + '/.env'), 'ENV_FILE_NOT_ADMITTED');
  const admissionBytes = bytes('.admission.json');
  need(sha(admissionBytes) === process.env.APP_MANIFEST_SHA, 'ADMISSION_HASH');
  const plan = JSON.parse(bytes('runtime-plan.json')); const ports = JSON.parse(bytes('ports-manifest.json'));
  const manifest = inspectManifest(JSON.parse(admissionBytes), plan, ports);
  const { admitNetwork, entryKind, egressCanaryBlocked } = await import(pathToFileURL(ROOT + '/network-admission.mjs').href);
  const networkAdmission = admitNetwork({ list: () => fs.readdirSync('/sys/class/net'),
    entryType: p => entryKind(fs.lstatSync(p)), readText: p => fs.readFileSync(p, 'utf8'),
    addresses: os.networkInterfaces, report: () => fail('NETWORK_ADMISSION_FAILED') }, manifest.runId);
  for (const action of [() => fs.readFileSync('/etc/passwd'), () => fs.writeFileSync(ROOT + '/unexpected', 'fixture')]) {
    let denied = false; try { action(); } catch (error) { denied = error.code === 'ERR_ACCESS_DENIED'; }
    need(denied, 'FILESYSTEM_CANARY');
  }
  need(!process.permission.has('child') && !process.permission.has('worker') && !process.permission.has('addon'), 'PROCESS_GRANTS');
  fs.writeFileSync('/tmp/auth-api-permission-canary', 'synthetic');
  const [canary] = await Promise.allSettled([fetch('http://192.0.2.1:8080/', { signal: AbortSignal.timeout(1500) })]);
  need(egressCanaryBlocked(canary), 'EGRESS_CANARY');
  const httpPorts = closeNetwork();
  const loader = installLoader(manifest, plan, ports);
  // Synthetic settings are generated only after complete import/network/file admission.
  const key = crypto.randomBytes(32).toString('hex');
  const uri = 'mongodb://127.0.0.1:27017/' + manifest.database + '?replicaSet=' + manifest.replicaSet + '&directConnection=true';
  Object.assign(process.env, { JWT_SECRET_KEY: key, MONGODB_URL: uri, NODE_ENV: 'test',
    SMTP2GO_API_KEY: 'fixture-only', SMTP2GO_SENDER: 'fixture@example.com',
    SMS_API_BASE_URL: ports.recordingAxios.sms, SMS_USERNAME: 'fixture', SMS_PASSWORD: 'fixture', SMS_FROM: 'fixture' });
  require('reflect-metadata');
  const typedi = require('typedi'); const axios = require('axios'); const jwt = require('jsonwebtoken'); const mongoose = require('mongoose');
  const originalSign = jwt.sign; jwt.sign = (...args) => { counters.jwtIssued++; return originalSign(...args); };
  // Close the complete connection policy before any production module import.
  need(mongoose.modelNames().length === 0, 'PREEXISTING_DOMAIN_MODELS');
  mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
  const originalConnect = mongoose.connect.bind(mongoose);
  mongoose.connect = (candidate, options) => { need(candidate === uri && !options?.dbName, 'UNDECLARED_DATABASE_URI'); return originalConnect(candidate, options); };
  mongoose.createConnection = () => fail('EXTRA_DATABASE_CONNECTION');
  const openUri = mongoose.Connection.prototype.openUri;
  mongoose.Connection.prototype.openUri = function (candidate, options) {
    need(candidate === uri && (!options?.dbName || options.dbName === manifest.database), 'UNDECLARED_DATABASE_URI');
    return openUri.call(this, candidate, options);
  };
  mongoose.Connection.prototype.useDb = function (name) {
    need(name === manifest.database, 'OTHER_DATABASE_NAME'); return this;
  };
  const driverConnect = mongoose.mongo.MongoClient.prototype.connect;
  mongoose.mongo.MongoClient.prototype.connect = function (...args) {
    need(this.s?.url === uri, 'UNDECLARED_DRIVER_URI'); return driverConnect.apply(this, args);
  };
  const driverDb = mongoose.mongo.MongoClient.prototype.db;
  mongoose.mongo.MongoClient.prototype.db = function (name, options) {
    need((name || this.options?.dbName) === manifest.database, 'OTHER_DRIVER_DATABASE');
    return driverDb.call(this, name, options);
  };
  const collections = new Set(ports.models.map(row => row.collection));
  const driverCollection = mongoose.mongo.Db.prototype.collection;
  mongoose.mongo.Db.prototype.collection = function (name, options) {
    need(this.databaseName === manifest.database && collections.has(name), 'UNDECLARED_COLLECTION');
    return driverCollection.call(this, name, options);
  };
  const createCollection = mongoose.mongo.Db.prototype.createCollection;
  mongoose.mongo.Db.prototype.createCollection = function (name, options) {
    need(this.databaseName === manifest.database && collections.has(name), 'UNDECLARED_COLLECTION_CREATE');
    return createCollection.call(this, name, options);
  };
  const writeOps = Object.fromEntries([...collections].map(name => [name, 0]));
  let currentPorts; let server;
  function phase(overrides = {}) {
    if (server) fail('PHASE_SERVER_STILL_OPEN');
    typedi.Container.of().reset({ strategy: 'resetServices' });
    loader.resetCompiled(); currentPorts = recordingPorts(ports, typedi); loader.phase(currentPorts.substitutes, overrides);
    axios.defaults.adapter = currentPorts.adapter;
    const express = require('express'); const app = express(); app.use(express.json({ limit: '16kb' }));
    const authenticate = loader.load('@/modules/middleware/auth').authenticate;
    app.use('/api/v1/auth', loader.load('@/modules/auth/routes').default);
    app.use('/api/v1/users', authenticate, loader.load('@/modules/user/routes').default);
    app.use('/api/v1/wallet', authenticate, loader.load('@/modules/wallet/routes').default);
    app.use(loader.load('@/modules/middleware/errorHandler').errorHandler);
    return new Promise((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => { const port = server.address().port; httpPorts.add(port); resolve(port); });
      server.once('error', reject);
    });
  }
  const endPhase = async () => {
    if (!server) return;
    const active = server; const port = active.address().port; server = undefined;
    await new Promise((resolve, reject) => active.close(error => error ? reject(error) : resolve())); httpPorts.delete(port);
  };
  let port;
  const completed = await withOwnedCleanup(async () => {
    // Router imports register actual production models, still without any connection.
    stage = 'ROUTER_IMPORT'; port = await phase();
    need(JSON.stringify(mongoose.modelNames().sort()) === JSON.stringify(ports.models.map(row => row.name).sort()), 'UNDECLARED_REGISTERED_MODEL');
    for (const spec of ports.models) need(mongoose.model(spec.name).collection.collectionName === spec.collection
      && Object.hasOwn(plan.sourceFiles, spec.source), 'MODEL_COLLECTION_SOURCE');
    stage = 'OWNED_DATABASE_CONNECT';
    await runSetupStep('CONNECT', () => mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000, monitorCommands: true }));
    const hello = await runSetupStep('HELLO', () => mongoose.connection.db.admin().command({ hello: 1 }));
    need(hello.setName === manifest.replicaSet && mongoose.connection.name === manifest.database, 'OWNED_DATABASE_HANDSHAKE');
    need(JSON.stringify(mongoose.modelNames().sort()) === JSON.stringify(ports.models.map(row => row.name).sort()), 'UNDECLARED_REGISTERED_MODEL');
    for (const spec of ports.models) {
      const registered = mongoose.model(spec.name);
      need(registered.collection.collectionName === spec.collection && Object.hasOwn(plan.sourceFiles, spec.source), 'MODEL_COLLECTION_SOURCE');
      await runSetupStep('COLLECTION_CREATE', () => mongoose.connection.db.createCollection(spec.collection));
      for (const index of spec.indexes) await runSetupStep('INDEX_CREATE', () => mongoose.connection.db.collection(spec.collection).createIndex(index.key, index.options));
    }
    mongoose.connection.getClient().on('commandStarted', event => {
      if (event.databaseName === manifest.database && ['insert', 'update', 'findAndModify', 'delete'].includes(event.commandName)) {
        counters.dbWrites++;
        const collection = event.command[event.commandName];
        const count = event.commandName === 'insert' ? event.command.documents.length
          : event.commandName === 'update' ? event.command.updates.length : event.commandName === 'delete' ? event.command.deletes.length : 1;
        if (!Object.hasOwn(writeOps, collection)) counters.unexpected++;
        else writeOps[collection] += count;
      }
    });
    stage = 'API_SCENARIOS';
    const result = await require('./scenario.cjs').runScenario({ manifest, plan, ports, mongoose, jwt,
      key, originalSign, counters, writeOps, need, fail, load: loader.load,
      get deliveries() { return currentPorts.deliveries; },
      get port() { return port; },
      async nextPhase(overrides) { await endPhase(); port = await phase(overrides); },
    });
    need(result.failed === 0 && result.skipped === 0 && counters.unexpected === 0 && counters.excluded === 0, 'CASE_OR_EFFECT_FAILURE');
    need(JSON.stringify(result.cases.map(row => row.id).sort()) === JSON.stringify(ports.requiredCaseIds.slice().sort())
      && result.cases.every(row => row.status === 'PASS'), 'MISSING_REQUIRED_CASE');
    need(JSON.stringify(result.sensitivity.map(row => row.id).sort()) === JSON.stringify(ports.requiredSensitivityIds.slice().sort())
      && result.sensitivity.every(row => row.detected === true), 'MISSING_SENSITIVITY');
    need(JSON.stringify(Object.keys(result.providerSummary).sort()) === JSON.stringify(plan.providerCounterKeys.slice().sort())
      && Object.values(result.providerSummary).every(value => Number.isSafeInteger(value) && value >= 0)
      && result.providerSummary.unexpected === 0 && result.providerSummary.deniedCapabilities === 0, 'PROVIDER_COUNTER_SHAPE');
    return { schema: 'SD-AUTH-API-RESULT-1', runId: manifest.runId, role: ROLE,
      database: manifest.database, replicaSet: manifest.replicaSet, sourceCommit: manifest.sourceCommit,
      admissionPassed: true, networkAdmission, egressBlocked: true, filesystemCanariesPassed: true,
      cases: result.cases, sensitivity: result.sensitivity, failed: 0, skipped: 0,
      providerSummary: result.providerSummary, domainScope: 'FOCUSED_PRODUCTION_ROUTERS' };
  }, endPhase, () => mongoose.disconnect());
  stdout(JSON.stringify(completed) + '\n');
}

if (require.main === module) main().catch(error => {
  const fieldNames = error && error.errors ? Object.keys(error.errors).filter(name => /^[A-Za-z0-9_.]+$/.test(name)).slice(0, 20) : [];
  stdout(JSON.stringify({ schema: 'SD-AUTH-API-FAILURE-1', stage,
    code: typeof error.fixtureCode === 'string' ? error.fixtureCode : 'RUNTIME_FIXTURE_FAILED',
    errorType: typeof error.name === 'string' ? error.name : 'Error', fieldNames,
    failed: 1, skipped: 0 }) + '\n');
  process.exitCode = 1;
});
module.exports = { validateAdmissionData, inspectManifest, closeNetwork, installLoader, runSetupStep, SETUP_FAILURE_CODES, withOwnedCleanup };
