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


/** Diagnostic evidence only; it never changes the strict bootstrap admission rule. */
export function captureNetworkDiagnostics(names, ports) {
  const validName = (name) => typeof name === 'string' && /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,32}$/.test(name);
  requireThat(Array.isArray(names) && names.length > 0 && names.length <= 16
    && names.every(validName) && new Set(names).size === names.length, 'Invalid diagnostic entry names');
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
    requireThat(rows.length <= 16 && rows.every(([name]) => validName(name)), 'Invalid address names');
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
