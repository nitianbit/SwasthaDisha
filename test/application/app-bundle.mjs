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

export function makeManifest(runId, sources) {
  requireThat(/^[a-f0-9-]{36}$/.test(runId), 'Invalid harness run identity');
  requireThat(Object.keys(sources).sort().join(',') === SOURCE_NAMES.join(','), 'Unexpected source bundle');
  const files = {};
  for (const name of SOURCE_NAMES) {
    requireThat(typeof sources[name] === 'string' && Buffer.byteLength(sources[name]) < 128 * 1024,
      'Bundle source must be bounded text');
    files[name] = sha256(sources[name]);
  }
  return Object.freeze({ runId, role: ROLE, files: Object.freeze(files) });
}

export function assertBundle(directory, expectation) {
  const expected = Object.freeze({ ...expectation });
  requireThat(Object.keys(expected).sort().join(',') === 'manifestSha,runId'
    && /^[a-f0-9]{64}$/.test(expected.manifestSha), 'Invalid bundle expectation');
  const directoryStat = lstatSync(directory);
  requireThat(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), 'Bundle directory changed');
  requireThat(readdirSync(directory).sort().join(',') === ['.admission.json', ...SOURCE_NAMES].join(','),
    'Bundle contains an unapproved file');
  for (const name of ['.admission.json', ...SOURCE_NAMES]) {
    const stat = lstatSync(join(directory, name));
    requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Bundle file identity changed');
  }
  const bytes = readFileSync(join(directory, '.admission.json'));
  requireThat(sha256(bytes) === expected.manifestSha, 'Bundle admission hash changed');
  const manifest = JSON.parse(bytes);
  requireThat(Object.keys(manifest).sort().join(',') === 'files,role,runId'
    && manifest.runId === expected.runId && manifest.role === ROLE
    && Object.keys(manifest.files).sort().join(',') === SOURCE_NAMES.join(','), 'Bundle admission identity changed');
  for (const name of SOURCE_NAMES) {
    requireThat(sha256(readFileSync(join(directory, name))) === manifest.files[name], 'Bundle source hash changed');
  }
  return Object.freeze({ ...manifest, files: Object.freeze(manifest.files) });
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
