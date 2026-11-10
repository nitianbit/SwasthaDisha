import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assertLaunch, childEnvironment, createWorkspace, disposeWorkspace } from './preflight.mjs';

// Only the fixed staged entry may register tests. No app modules are imported.
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.cwd(), process.env.FOUNDATION_WORKSPACE);
assert.ok(process.permission);
assert.equal(process.permission.has('fs.read', dirname(process.cwd())), false);
const runtimeEnvironmentKeys = new Set(['NODE_TEST_WORKER_ID']);
if (process.platform === 'darwin') runtimeEnvironmentKeys.add('__CF_USER_TEXT_ENCODING');
assert.deepEqual(Object.keys(process.env).filter((key) => !runtimeEnvironmentKeys.has(key)).sort(), [
  'FOUNDATION_RUN_ID', 'FOUNDATION_WORKSPACE', 'NODE_ENV', 'TMPDIR', 'TZ',
].sort());

function fixture(t) {
  const workspace = createWorkspace();
  t.after(() => disposeWorkspace(workspace));
  return { workspace, launch: { cwd: workspace.directory, env: childEnvironment(workspace) } };
}

function deniedBeforeEffects(workspace, launch, pattern) {
  let imports = 0;
  let connections = 0;
  assert.throws(() => {
    assertLaunch(workspace, launch);
    imports += 1;
    connections += 1;
  }, pattern);
  assert.equal(imports, 0);
  assert.equal(connections, 0);
}

test('a runner-created workspace admits the exact clean unit-test launch', (t) => {
  const { workspace, launch } = fixture(t);
  assert.doesNotThrow(() => assertLaunch(workspace, launch));
  assert.equal(Object.isFrozen(workspace), true);
  assert.equal(Object.isFrozen(launch.env), true);
  assert.equal(launch.env.TMPDIR, join(workspace.directory, 'scratch'));
});

test('a copied marker and matching directory do not confer ownership', (t) => {
  const { workspace, launch } = fixture(t);
  deniedBeforeEffects({ ...workspace }, launch, /not owned/);
});

test('unknown resource identity cannot authorize a launch', () => {
  deniedBeforeEffects({ directory: '/latest', runId: 'forged' }, { cwd: '/latest', env: {} }, /not owned/);
});

for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'MONGODB_URL', 'PHARMACY_TEST_MONGODB_URI', 'PAYMENT_SECRET']) {
  test(`inherited ${key} is refused before imports or connectors`, (t) => {
    const { workspace, launch } = fixture(t);
    deniedBeforeEffects(workspace, { ...launch, env: { ...launch.env, [key]: 'synthetic-canary' } }, /exact isolated/);
  });
}

test('a database named latest is not admitted as a disposable resource', (t) => {
  const { workspace, launch } = fixture(t);
  deniedBeforeEffects(workspace, {
    ...launch, env: { ...launch.env, PHARMACY_TEST_MONGODB_URI: 'mongodb://shared.invalid/latest' },
  }, /exact isolated/);
});

test('incorrect working directory or test identity is refused', (t) => {
  const { workspace, launch } = fixture(t);
  deniedBeforeEffects(workspace, { ...launch, cwd: dirname(workspace.directory) }, /exact isolated/);
  deniedBeforeEffects(workspace, { ...launch, env: { ...launch.env, FOUNDATION_RUN_ID: 'different-run' } }, /exact isolated/);
});

test('missing environment fields are refused', (t) => {
  const { workspace, launch } = fixture(t);
  const { NODE_ENV, ...env } = launch.env;
  deniedBeforeEffects(workspace, { ...launch, env }, /exact isolated/);
});

test('an operational .env file is refused, including nested files', (t) => {
  const { workspace, launch } = fixture(t);
  for (const path of [join(workspace.directory, '.env'), join(launch.env.TMPDIR, '.env.local')]) {
    writeFileSync(path, 'SYNTHETIC=1');
    deniedBeforeEffects(workspace, launch, /unapproved file/);
    rmSync(path);
  }
});

test('unexpected staged application files are refused', (t) => {
  const { workspace, launch } = fixture(t);
  writeFileSync(join(workspace.directory, 'server.js'), '// synthetic');
  deniedBeforeEffects(workspace, launch, /unapproved file/);
});

test('the test child cannot create symlinks to escape its filesystem permissions', (t) => {
  const { workspace, launch } = fixture(t);
  assert.throws(() => symlinkSync(
    join(workspace.directory, '.foundation-owner.json'), join(launch.env.TMPDIR, 'linked'),
  ), { code: 'ERR_ACCESS_DENIED' });
});

test('changed ownership refuses both execution and cleanup', () => {
  const workspace = createWorkspace();
  const launch = { cwd: workspace.directory, env: childEnvironment(workspace) };
  const marker = join(workspace.directory, '.foundation-owner.json');
  const original = readFileSync(marker);
  try {
    writeFileSync(marker, JSON.stringify({ runId: 'forged' }));
    deniedBeforeEffects(workspace, launch, /ownership marker/);
    assert.throws(() => disposeWorkspace(workspace), /ownership marker/);
    assert.equal(existsSync(workspace.directory), true);
  } finally {
    writeFileSync(marker, original);
    disposeWorkspace(workspace);
  }
});

test('a replacement directory with a copied marker is not the owned resource', () => {
  const workspace = createWorkspace();
  const launch = { cwd: workspace.directory, env: childEnvironment(workspace) };
  const saved = workspace.directory + '-saved';
  renameSync(workspace.directory, saved);
  try {
    mkdirSync(workspace.directory, { mode: 0o700 });
    writeFileSync(join(workspace.directory, '.foundation-owner.json'), JSON.stringify({ runId: workspace.runId }));
    deniedBeforeEffects(workspace, launch, /identity changed/);
    assert.throws(() => disposeWorkspace(workspace), /identity changed/);
    assert.equal(existsSync(saved), true);
  } finally {
    rmSync(workspace.directory, { recursive: true });
    renameSync(saved, workspace.directory);
    disposeWorkspace(workspace);
  }
});

test('cleanup affects only the owned workspace and is idempotent', () => {
  const first = createWorkspace();
  const second = createWorkspace();
  try {
    disposeWorkspace(first);
    assert.equal(existsSync(first.directory), false);
    assert.equal(existsSync(second.directory), true);
    assert.doesNotThrow(() => disposeWorkspace(first));
    assert.throws(() => childEnvironment(first), /not owned/);
  } finally {
    disposeWorkspace(second);
  }
});

test('the test child cannot read parent files or spawn another process', () => {
  assert.throws(() => readFileSync(join(dirname(process.cwd()), 'synthetic-outside')), { code: 'ERR_ACCESS_DENIED' });
  assert.throws(() => spawnSync(process.execPath, ['--version']), { code: 'ERR_ACCESS_DENIED' });
});
