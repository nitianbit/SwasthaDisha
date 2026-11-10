import { randomUUID } from 'node:crypto';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const owned = new WeakMap();
const markerName = '.foundation-owner.json';
const stagedFiles = new Set([markerName, 'preflight.mjs', 'preflight.test.mjs', 'mongo-fixture.mjs', 'mongo-fixture.test.mjs', 'app-container.mjs', 'app-container.test.mjs', 'app-bundle.mjs', 'app-bundle.test.mjs', 'app-ports.mjs', 'app-image.json', 'app-runtime.json', 'scratch']);

/** Owns a new filesystem fixture; this never admits a database or provider. */
export function createWorkspace(parent = tmpdir()) {
  const directory = realpathSync(mkdtempSync(join(parent, 'swasthadisha-foundation-')));
  const runId = randomUUID();
  mkdirSync(join(directory, 'scratch'), { mode: 0o700 });
  writeFileSync(join(directory, markerName), JSON.stringify({ runId }), { mode: 0o600, flag: 'wx' });
  const { dev, ino } = lstatSync(directory);
  const workspace = Object.freeze({ directory, runId });
  owned.set(workspace, { directory, runId, dev, ino, closed: false });
  return workspace;
}

function assertOwnership(workspace) {
  const record = owned.get(workspace);
  if (!record || record.closed) throw new Error('Foundation workspace is not owned by this runner');
  const stat = lstatSync(record.directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()
      || stat.dev !== record.dev || stat.ino !== record.ino
      || realpathSync(record.directory) !== record.directory) {
    throw new Error('Foundation workspace identity changed');
  }
  const marker = join(record.directory, markerName);
  const markerStat = lstatSync(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()
      || JSON.parse(readFileSync(marker, 'utf8')).runId !== record.runId) {
    throw new Error('Foundation workspace ownership marker changed');
  }
  return record;
}

function assertCleanTree(directory, topLevel = true) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())
        || entry.name === '.env' || entry.name.startsWith('.env.')
        || (topLevel && !stagedFiles.has(entry.name))) {
      throw new Error('Foundation workspace contains an unapproved file');
    }
    if (entry.isDirectory()) assertCleanTree(join(directory, entry.name), false);
  }
}

export function childEnvironment(workspace) {
  const { directory, runId } = assertOwnership(workspace);
  return Object.freeze({
    NODE_ENV: 'test',
    TZ: 'UTC',
    TMPDIR: join(directory, 'scratch'),
    FOUNDATION_WORKSPACE: directory,
    FOUNDATION_RUN_ID: runId,
  });
}

/** Call before spawning the fixed foundation test entry, never after imports. */
export function assertLaunch(workspace, { cwd, env }) {
  const record = assertOwnership(workspace);
  assertCleanTree(record.directory);
  const expected = childEnvironment(workspace);
  if (cwd !== record.directory
      || Object.keys(env).length !== Object.keys(expected).length
      || Object.keys(env).some((key) => !Object.hasOwn(expected, key))
      || Object.entries(expected).some(([key, value]) => env[key] !== value)) {
    throw new Error('Foundation launch must use its exact isolated directory and environment');
  }
}

export function disposeWorkspace(workspace) {
  const existing = owned.get(workspace);
  if (existing?.closed) return;
  const record = assertOwnership(workspace);
  // Refuse cleanup after ownership loss; never follow a substituted resource.
  rmSync(record.directory, { recursive: true, force: false });
  record.closed = true;
}
