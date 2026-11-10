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
