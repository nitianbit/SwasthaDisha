import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SOURCE_NAMES = Object.freeze([
  'app-bundle.mjs', 'app-ports.mjs', 'bootstrap.mjs', 'package.json', 'queryUtils.ts', 'scenario.mjs',
]);
export const PORT_OPERATIONS = Object.freeze({
  payments: 'create-order', sms: 'send', email: 'send', push: 'send',
  calendar: 'create-event', storage: 'put', queue: 'enqueue',
});
export const ROLE = 'synthetic-ports-only';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

export const AUTHORITY_ROLE = 'business-staff-authority-pure';
export const AUTHORITY_SOURCE_NAMES = Object.freeze([
  'app-bundle.mjs', 'authority-rules.ts', 'authority-scenario.mjs', 'authority-service.ts',
  'authority-types.ts', 'authority-vectors.json', 'bootstrap.mjs', 'package.json', 'typescript.cjs',
]);
export const AUTHORITY_COMPILER_SHA = '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675';
export const AUTHORITY_INPUTS = Object.freeze({
  'src1/modules/organizations/types/index.ts': 'authority-types.ts',
  'src1/modules/organizations/rules.ts': 'authority-rules.ts',
  'src1/modules/organizations/services/index.ts': 'authority-service.ts',
});
export const AUTHORITY_SOURCE_HASHES = Object.freeze({
  'src1/modules/organizations/types/index.ts': 'e873884e69db46d7de70d3120a5ac30809fe8dc526d118a4640463233c9633ff',
  'src1/modules/organizations/rules.ts': 'b404c00381b5bf642aa648105cefb353a97c7ea7283c680059c426b5e4307942',
  'src1/modules/organizations/services/index.ts': 'ccac5254a6e61c8cce4f14c58005cb39349689e3d0cbafc8ab551ca339397c73',
});
export const AUTHORITY_VECTORS_SHA = '9f2ab5e192c9eb4a1332680a77f0ed5d94eb28502af3fc9a426f68be350ea382';
export const AUTHORITY_EMIT_OPTIONS = Object.freeze({
  target: 7, module: 1, esModuleInterop: true, verbatimModuleSyntax: false,
  importHelpers: false, declaration: false, sourceMap: false,
});
export const AUTHORITY_CASE_GROUPS = Object.freeze(Object.fromEntries(
  Object.entries({
    "A01": ["only"],
    "A02": ["only"],
    "A03": ["bad-id", "business-login", "missing-purpose", "extra-key", "accessor"],
    "A04": ["bad-org-id", "unknown-capability", "extra-key"],
    "A05": ["null", "number", "string"],
    "A06": ["nan", "infinity", "negative", "unsafe", "out-of-range"],
    "A07": ["error", "undefined", "false"],
    "A08": ["false", "missing-flag", "false-flag", "bad-generation"],
    "A09": ["error", "undefined", "false"],
    "A10": ["error", "undefined", "false"],
    "A11": ["only"],
    "A12": ["inactive", "foreign-id"],
    "A13": ["membership-tenant", "eligibility-actor", "organization-id"],
    "A14": ["organization-suspended", "branch-revoked"],
    "A15": ["license-number", "license-document", "unverified"],
    "A16": ["only"],
    "A17": ["missing-member", "duplicate-member", "missing-proof"],
    "A18": ["schema", "zero-revision", "unsafe-revision"],
    "A19": ["validfrom-equal", "validfrom-future", "expiry-equal", "created-after-updated"],
    "A20": ["only"],
    "A21": ["fingerprint", "mapping", "grant", "verification"],
    "A22": ["object-keys", "array-order"],
    "A23": ["metadata-operation", "payload-fingerprint", "evidence"],
    "A24": ["only"],
    "A25": ["organization-revision", "membership-revision", "eligibility-revision"],
    "A26": ["self-grant", "self-verification", "evidence-version"],
    "A27": ["decision-id", "operation-id"],
    "A28": ["spread-clone", "json-clone", "prototype-clone", "raw-evaluator"],
    "A29": ["only"],
    "A30": ["only"],
    "A31": ["domain-fs", "compiler-fs"],
    "A32": ["facts-extra-key", "nested-accessor", "empty-branches", "over100-branches"],
  }).map(([key, values]) => [key, Object.freeze(values)]),
));
export const AUTHORITY_CASE_IDS = Object.freeze(Object.entries(AUTHORITY_CASE_GROUPS)
  .flatMap(([key, values]) => values.map((value) => key + '.' + value)));
export const AUTHORITY_CONTROLS = Object.freeze([
  ['M1', 'A19.expiry-equal'], ['M2', 'A23.metadata-operation'], ['M3', 'A13.membership-tenant'],
  ['M4', 'A25.membership-revision'], ['M5', 'A28.spread-clone'],
].map((row) => Object.freeze(row)));


export const ENROLLMENT_ROLE = 'customer-enrollment-service';
export const ENROLLMENT_SOURCE_NAMES = Object.freeze([
  'app-bundle.mjs', 'app-ports.mjs', 'bootstrap.mjs', 'emitted-modules.json', 'package.json',
  'ports-plan.json', 'runtime-modules.json', 'scenario.mjs',
]);
const enrollmentMap = name => ['emitted-modules.json', 'runtime-modules.json'].includes(name);
function sourceLimit(role, name) {
  return role === ENROLLMENT_ROLE && enrollmentMap(name) ? 8 * 1024 * 1024
    : role === AUTHORITY_ROLE && name === 'typescript.cjs' ? 10 * 1024 * 1024 : 128 * 1024;
}
export function verifyEnrollmentResult(value, expected) {
  try {
    requireThat(authorityKeys(value, ['schema', 'planSha256', 'emittedSha256', 'runtimeSha256', 'caseIds', 'restoredCaseIds',
      'passed', 'failed', 'skipped', 'controls', 'baselineTwoAliasDataflowObserved', 'database', 'providers', 'http', 'typecheck'])
      && value.schema === 'SD-ENROLLMENT-SERVICE-RESULT-1', 'Enrollment result schema');
    requireThat(['planSha256', 'emittedSha256', 'runtimeSha256'].every(key => hash(value[key]) && value[key] === expected[key]), 'Enrollment artifact binding');
    requireThat(JSON.stringify(value.caseIds) === JSON.stringify(expected.caseIds)
      && JSON.stringify(value.restoredCaseIds) === JSON.stringify(expected.caseIds)
      && value.passed === expected.caseIds.length && value.passed > 0 && value.failed === 0 && value.skipped === 0, 'Enrollment finite cases');
    requireThat(Array.isArray(value.controls) && value.controls.length === expected.controls.length
      && value.controls.every((row, i) => authorityKeys(row, ['id', 'target', 'predicate', 'detected', 'restored'])
        && row.id === expected.controls[i].id && row.target === expected.controls[i].case
        && row.predicate === (row.id === 'NC4' ? 'single-contact-save' : 'zero-effects')
        && row.detected === true && row.restored === true), 'Enrollment controls');
    requireThat(value.baselineTwoAliasDataflowObserved === true && value.database === 'NOT_ADMITTED'
      && value.providers === 'RECORDING_ONLY' && value.http === 'NOT_RUN' && value.typecheck === 'NOT_CLAIMED', 'Enrollment evidence scope');
    return true;
  } catch { return false; }
}

export function sourceNames(role) {
  requireThat(role === ROLE || role === AUTHORITY_ROLE || role === ENROLLMENT_ROLE, 'Unknown fixed application role');
  return role === ENROLLMENT_ROLE ? ENROLLMENT_SOURCE_NAMES : role === ROLE ? SOURCE_NAMES : AUTHORITY_SOURCE_NAMES;
}
export function makeManifest(runId, sources, role = ROLE) {
  const names = sourceNames(role);
  requireThat(/^[a-f0-9-]{36}$/.test(runId), 'Invalid harness run identity');
  requireThat(Object.keys(sources).sort().join(',') === names.join(','), 'Unexpected source bundle');
  const files = {}; let total = 0;
  for (const name of names) {
    const limit = sourceLimit(role, name);
    requireThat(typeof sources[name] === 'string' && Buffer.byteLength(sources[name]) < limit,
      'Bundle source must be bounded text');
    total += Buffer.byteLength(sources[name]); files[name] = sha256(sources[name]);
  }
  requireThat(![AUTHORITY_ROLE, ENROLLMENT_ROLE].includes(role) || total < 12 * 1024 * 1024, 'Authority bundle size exceeded');
  return Object.freeze({ runId, role, files: Object.freeze(files) });
}

export function assertBundle(directory, expectation) {
  const expected = Object.freeze({ ...expectation });
  const role = Object.hasOwn(expected, 'role') ? expected.role : ROLE; const names = sourceNames(role);
  requireThat(['manifestSha,runId', 'manifestSha,role,runId'].includes(Object.keys(expected).sort().join(','))
    && /^[a-f0-9]{64}$/.test(expected.manifestSha), 'Invalid bundle expectation');
  const directoryStat = lstatSync(directory);
  requireThat(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), 'Bundle directory changed');
  requireThat(readdirSync(directory).sort().join(',') === ['.admission.json', ...names].join(','),
    'Bundle contains an unapproved file');
  for (const name of ['.admission.json', ...names]) {
    const stat = lstatSync(join(directory, name));
    requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Bundle file identity changed');
    const limit = name === '.admission.json' ? 65536 : sourceLimit(role, name);
    requireThat(stat.size < limit, 'Bundle file size changed');
  }
  const bytes = readFileSync(join(directory, '.admission.json'));
  requireThat(sha256(bytes) === expected.manifestSha, 'Bundle admission hash changed');
  const manifest = JSON.parse(bytes);
  requireThat(Object.keys(manifest).sort().join(',') === 'files,role,runId'
    && manifest.runId === expected.runId && manifest.role === role
    && Object.keys(manifest.files).sort().join(',') === names.join(','), 'Bundle admission identity changed');
  let total = 0;
  for (const name of names) {
    const data = readFileSync(join(directory, name)); total += data.length;
    requireThat(sha256(data) === manifest.files[name], 'Bundle source hash changed');
  }
  requireThat(![AUTHORITY_ROLE, ENROLLMENT_ROLE].includes(role) || total < 12 * 1024 * 1024, 'Authority bundle size changed');
  return Object.freeze({ ...manifest, files: Object.freeze(manifest.files) });
}

const authorityKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function verifyAuthorityResult(value, expected = { sourceHashes: AUTHORITY_SOURCE_HASHES, compilerSha256: AUTHORITY_COMPILER_SHA }) {
  try {
    const ids = Object.keys(AUTHORITY_INPUTS);
    requireThat(authorityKeys(value, ['schema', 'sourceHashes', 'compiler', 'emit', 'nominal', 'controls', 'evaluations', 'effects'])
      && value.schema === 'SD-AUTHORITY-PURE-1', 'Authority result schema');
    requireThat(authorityKeys(value.sourceHashes, ids) && ids.every((id) => hash(value.sourceHashes[id]) && value.sourceHashes[id] === expected.sourceHashes[id]), 'Authority source proof');
    requireThat(authorityKeys(value.compiler, ['version', 'sha256', 'loads', 'requireAttempts', 'sysAbsent'])
      && value.compiler.version === '5.9.3' && hash(value.compiler.sha256) && value.compiler.sha256 === expected.compilerSha256
      && value.compiler.loads === 1 && value.compiler.requireAttempts === 0 && value.compiler.sysAbsent === true, 'Authority compiler proof');
    const emit = value.emit;
    requireThat(authorityKeys(emit, ['optionsSha256', 'nominalHashes', 'mutantHashes', 'nominalCount', 'mutantCount'])
      && emit.optionsSha256 === sha256(JSON.stringify(AUTHORITY_EMIT_OPTIONS)) && emit.nominalCount === 3 && emit.mutantCount === 5
      && authorityKeys(emit.nominalHashes, ids) && ids.every((id) => hash(emit.nominalHashes[id]))
      && authorityKeys(emit.mutantHashes, AUTHORITY_CONTROLS.map(([id]) => id))
      && AUTHORITY_CONTROLS.every(([id]) => hash(emit.mutantHashes[id]) && emit.mutantHashes[id] !== emit.nominalHashes[id === 'M5' ? 'src1/modules/organizations/services/index.ts' : 'src1/modules/organizations/rules.ts']), 'Authority emit proof');
    const nominal = value.nominal;
    requireThat(authorityKeys(nominal, ['caseIds', 'passed', 'failed', 'skipped'])
      && JSON.stringify(nominal.caseIds) === JSON.stringify(AUTHORITY_CASE_IDS)
      && nominal.passed === AUTHORITY_CASE_IDS.length && nominal.failed === 0 && nominal.skipped === 0, 'Authority nominal proof');
    requireThat(Array.isArray(value.controls) && value.controls.length === AUTHORITY_CONTROLS.length
      && value.controls.every((row, index) => authorityKeys(row, ['id', 'target', 'mutantDetected', 'restored'])
        && row.id === AUTHORITY_CONTROLS[index][0] && row.target === AUTHORITY_CONTROLS[index][1]
        && row.mutantDetected === true && row.restored === true), 'Authority sensitivity proof');
    requireThat(authorityKeys(value.evaluations, ['graphs', 'types', 'rules', 'service', 'total'])
      && value.evaluations.graphs === 11 && value.evaluations.types === 11 && value.evaluations.rules === 11
      && value.evaluations.service === 11 && value.evaluations.total === 33, 'Authority evaluation proof');
    requireThat(authorityKeys(value.effects, ['database', 'provider', 'sourceWrites', 'domainNativeImports', 'boundaryProbeRejections'])
      && ['database', 'provider', 'sourceWrites', 'domainNativeImports'].every((key) => value.effects[key] === 0)
      && value.effects.boundaryProbeRejections === 2, 'Authority effect proof');
    return true;
  } catch { return false; }
}


const validNetworkName = (name) => typeof name === 'string' && /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,32}$/.test(name);

/** Maps one lstat result to a diagnostic kind; symbolic links take precedence. */
export function entryKind(stat) {
  return stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
}

/** Bounded observation only; admission is decided by evaluateNetworkAdmission, never by this record alone. */
export function captureNetworkDiagnostics(names, ports) {
  requireThat(Array.isArray(names) && names.length > 0 && names.length <= 16
    && names.every(validNetworkName) && new Set(names).size === names.length, 'Invalid diagnostic entry names');
  const readers = Object.freeze({ ...ports });
  requireThat(['entryType', 'readText', 'addresses'].every((key) => typeof readers[key] === 'function'),
    'Explicit diagnostic readers are required');
  const observe = (operation) => {
    try { return operation(); } catch (error) {
      return { unavailable: typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'UNAVAILABLE' };
    }
  };
  const entries = names.map((name) => {
    const location = join('/sys/class/net', name);
    const result = { name, kind: observe(() => {
      const kind = readers.entryType(location);
      requireThat(['file', 'symlink', 'directory', 'other'].includes(kind), 'Invalid entry kind');
      return kind;
    }) };
    for (const field of ['flags', 'operstate', 'type']) result[field] = observe(() => {
      const text = readers.readText(join(location, field));
      requireThat(typeof text === 'string' && /^[A-Za-z0-9_x. -]{1,64}$/.test(text.trim()), 'Invalid metric text');
      return text.trim();
    });
    return result;
  });
  const addressedInterfaces = observe(() => {
    const snapshot = readers.addresses();
    requireThat(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot), 'Invalid address snapshot');
    const rows = Object.entries(snapshot);
    requireThat(rows.length <= 16 && rows.every(([name]) => validNetworkName(name)), 'Invalid address names');
    return rows.map(([name, addresses]) => {
      requireThat(Array.isArray(addresses) && addresses.length > 0 && addresses.length <= 4, 'Invalid address rows');
      return { name, addresses: addresses.map((row) => {
        requireThat(row && typeof row.address === 'string' && row.address.length <= 45
          && ['IPv4', 'IPv6'].includes(row.family) && typeof row.internal === 'boolean', 'Invalid address record');
        return { address: row.address, family: row.family, internal: row.internal };
      }) };
    });
  });
  const record = { tag: 'APP-NET-DIAG-1', entries, addressedInterfaces };
  requireThat(Buffer.byteLength(JSON.stringify(record)) <= 8192, 'Network diagnostic output limit exceeded');
  return Object.freeze(record);
}

export const NETWORK_ADMISSION_TAG = 'APP-NET-ADMIT-1';
const IFF_UP = 0x1;
const IFF_LOOPBACK = 0x8;
// RUNNING, LOWER_UP and DORMANT are not expected in sysfs flags; any of them fails closed.
const IFF_VOLATILE_STATE = 0x40 | 0x10000 | 0x20000;
const ARPHRD_LOOPBACK = 772;
const LOOPBACK_ADDRESSES = Object.freeze({ '127.0.0.1': 'IPv4', '::1': 'IPv6' });

function admit(condition, reason) {
  if (!condition) throw new Error('Network admission rejected: ' + reason);
}

const isPlainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hasExactKeys = (value, keys) => isPlainRecord(value) && Object.keys(value).sort().join(',') === keys.join(',');
const isUnavailable = (value) => hasExactKeys(value, ['unavailable'])
  && typeof value.unavailable === 'string' && /^[A-Z0-9_]{1,40}$/.test(value.unavailable);

function canonicalField(value) {
  admit((typeof value === 'string' && value.length > 0 && value.length <= 64) || isUnavailable(value), 'malformed observation');
  return typeof value === 'string' ? value : Object.freeze({ unavailable: value.unavailable });
}

function canonicalObservation(observation) {
  admit(hasExactKeys(observation, ['addressedInterfaces', 'entries', 'tag']) && observation.tag === 'APP-NET-DIAG-1'
    && Array.isArray(observation.entries) && observation.entries.length > 0 && observation.entries.length <= 16,
  'malformed observation');
  let previous;
  const entries = observation.entries.map((entry) => {
    admit(hasExactKeys(entry, ['flags', 'kind', 'name', 'operstate', 'type']) && validNetworkName(entry.name)
      && (previous === undefined || previous < entry.name), 'malformed observation');
    previous = entry.name;
    return Object.freeze({ name: entry.name, kind: canonicalField(entry.kind), flags: canonicalField(entry.flags),
      operstate: canonicalField(entry.operstate), type: canonicalField(entry.type) });
  });
  const reported = observation.addressedInterfaces;
  let addressedInterfaces;
  if (isUnavailable(reported)) addressedInterfaces = Object.freeze({ unavailable: reported.unavailable });
  else {
    admit(Array.isArray(reported) && reported.length <= 16, 'malformed observation');
    addressedInterfaces = Object.freeze(reported.map((row) => {
      admit(hasExactKeys(row, ['addresses', 'name']) && validNetworkName(row.name)
        && Array.isArray(row.addresses) && row.addresses.length > 0 && row.addresses.length <= 4, 'malformed observation');
      return Object.freeze({ name: row.name, addresses: Object.freeze(row.addresses.map((address) => {
        admit(hasExactKeys(address, ['address', 'family', 'internal']) && typeof address.address === 'string'
          && address.address.length <= 45 && ['IPv4', 'IPv6'].includes(address.family)
          && typeof address.internal === 'boolean', 'malformed observation');
        return Object.freeze({ address: address.address, family: address.family, internal: address.internal });
      })) });
    }));
  }
  return Object.freeze({ tag: 'APP-NET-DIAG-1', entries: Object.freeze(entries), addressedInterfaces });
}

const parseFlags = (value) => typeof value === 'string' && /^0x(0|[1-9a-f][0-9a-f]{0,7})$/.test(value)
  ? Number.parseInt(value.slice(2), 16) : undefined;
const parseType = (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,4})$/.test(value) && Number(value) <= 65535
  ? Number(value) : undefined;

/**
 * Fail-closed semantic admission over one bounded observation. Throws on every rejection and
 * returns only a deep-frozen summary. No interface name other than `lo` is referenced.
 */
export function evaluateNetworkAdmission(observation) {
  const record = canonicalObservation(observation);
  let loopbacks = 0;
  const controlFiles = [];
  const downDevices = [];
  for (const entry of record.entries) {
    if (entry.name === 'lo') {
      const flags = parseFlags(entry.flags);
      admit(entry.kind === 'symlink', 'loopback is not a device link');
      admit(flags !== undefined && (flags & (IFF_UP | IFF_LOOPBACK)) === (IFF_UP | IFF_LOOPBACK)
        && (flags & IFF_VOLATILE_STATE) === 0, 'loopback flags');
      admit(parseType(entry.type) === ARPHRD_LOOPBACK, 'loopback type');
      admit(['unknown', 'up'].includes(entry.operstate), 'loopback operstate');
      loopbacks++;
    } else if (entry.kind === 'file') {
      admit(['flags', 'operstate', 'type'].every((field) => entry[field]?.unavailable === 'ENOTDIR'), 'control file attributes');
      controlFiles.push(entry.name);
    } else if (entry.kind === 'symlink') {
      const flags = parseFlags(entry.flags);
      const type = parseType(entry.type);
      admit(flags !== undefined && (flags & (IFF_UP | IFF_LOOPBACK | IFF_VOLATILE_STATE)) === 0, 'non-loopback device flags');
      admit(type !== undefined && type !== ARPHRD_LOOPBACK, 'non-loopback device type');
      admit(entry.operstate === 'down', 'non-loopback device operstate');
      downDevices.push(entry.name);
    } else admit(false, 'entry kind');
  }
  admit(loopbacks === 1, 'loopback missing');
  const addressed = record.addressedInterfaces;
  admit(Array.isArray(addressed) && addressed.length === 1 && addressed[0].name === 'lo', 'addressed interfaces');
  const rows = addressed[0].addresses;
  admit(rows.every((row) => Object.hasOwn(LOOPBACK_ADDRESSES, row.address)
    && LOOPBACK_ADDRESSES[row.address] === row.family && row.internal === true), 'loopback addresses');
  const loopbackAddresses = rows.map((row) => row.address).sort();
  admit(new Set(loopbackAddresses).size === rows.length && loopbackAddresses.includes('127.0.0.1'), 'loopback addresses');
  return Object.freeze({
    tag: NETWORK_ADMISSION_TAG, observation: record, loopback: 'lo',
    controlFiles: Object.freeze(controlFiles), downDevices: Object.freeze(downDevices),
    loopbackAddresses: Object.freeze(loopbackAddresses),
  });
}

/** Parent-side check: true only when a fresh evaluation reproduces the reported summary exactly. */
export function verifyNetworkAdmission(reported) {
  try {
    if (!isPlainRecord(reported) || reported.tag !== NETWORK_ADMISSION_TAG || reported.loopback !== 'lo') return false;
    return JSON.stringify(evaluateNetworkAdmission(reported.observation)) === JSON.stringify(reported);
  } catch {
    return false;
  }
}

/** Bootstrap wiring target: observe, decide, and on rejection report the bounded record once before throwing. */
export function admitNetwork(ports, runId) {
  const readers = Object.freeze({ ...ports });
  requireThat(['list', 'entryType', 'readText', 'addresses', 'report'].every((key) => typeof readers[key] === 'function')
    && typeof runId === 'string' && /^[a-f0-9-]{36}$/.test(runId), 'Explicit network admission ports are required');
  const listed = readers.list();
  requireThat(Array.isArray(listed), 'Invalid diagnostic entry names');
  const observation = captureNetworkDiagnostics([...listed].sort(), readers);
  try {
    return evaluateNetworkAdmission(observation);
  } catch (rejection) {
    const line = JSON.stringify({ ...observation, runId });
    requireThat(Buffer.byteLength(line) <= 8192, 'Network diagnostic output limit exceeded');
    readers.report(line + '\n');
    throw rejection;
  }
}

/** Only a rejected canary whose cause (or direct) code is ENETUNREACH counts as measured blocking. */
export function egressCanaryBlocked(settled) {
  if (!isPlainRecord(settled) || settled.status !== 'rejected') return false;
  const reason = settled.reason;
  if (reason === null || (typeof reason !== 'object' && typeof reason !== 'function')) return false;
  return reason.cause?.code === 'ENETUNREACH' || reason.code === 'ENETUNREACH';
}
