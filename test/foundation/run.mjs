import assert from 'node:assert/strict';
import { copyFileSync, lstatSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertLaunch, childEnvironment, createWorkspace, disposeWorkspace } from './preflight.mjs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  throw new Error('Foundation tests require Node 22.13+ for filesystem permissions');
}
if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.execArgv.length) {
  throw new Error('Start the foundation runner with a clean environment and no Node preload flags');
}
if (process.argv.length !== 2) throw new Error('The foundation runner accepts no resource overrides');

const workspace = createWorkspace();
const entries = ['preflight.test.mjs', 'mongo-fixture.test.mjs'];
try {
  // Stage only reviewed dependency-free tests; no application, .env or key files.
  for (const file of ['preflight.mjs', 'preflight.test.mjs', 'mongo-fixture.mjs', 'mongo-fixture.test.mjs']) {
    const source = fileURLToPath(new URL(file, import.meta.url));
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Foundation source must be a regular file');
    copyFileSync(source, join(workspace.directory, file));
  }
  const launch = { cwd: workspace.directory, env: childEnvironment(workspace) };
  const linkProbe = join(workspace.directory, 'scratch', 'link-probe');
  symlinkSync(join(workspace.directory, '.foundation-owner.json'), linkProbe);
  assert.throws(() => assertLaunch(workspace, launch), /unapproved file/);
  unlinkSync(linkProbe);
  assertLaunch(workspace, launch);
  const child = spawnSync(process.execPath, [
    '--permission',
    `--allow-fs-read=${workspace.directory}`,
    `--allow-fs-write=${workspace.directory}`,
    '--test', '--experimental-test-isolation=none', '--test-reporter=tap',
    ...entries,
  ], { ...launch, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  process.stdout.write(child.stdout ?? '');
  process.stderr.write(child.stderr ?? '');
  const summary = child.stdout ?? '';
  const tests = Number(/^# tests (\d+)$/m.exec(summary)?.[1] ?? 0);
  const passes = Number(/^# pass (\d+)$/m.exec(summary)?.[1] ?? 0);
  const skipped = /^# skipped 0$/m.test(summary);
  const failures = /^# fail 0$/m.test(summary);
  const complete = /^# cancelled 0$/m.test(summary) && /^# todo 0$/m.test(summary);
  // TAP counts empty entries as passed files; reject each required file fallback.
  const emptyEntry = summary.split('\n').some((line) => {
    if (!line.startsWith('# Subtest: ')) return false;
    const name = line.slice('# Subtest: '.length).replaceAll('\\', '/');
    return entries.some((entry) => name === entry || name.endsWith('/' + entry));
  });
  if (child.error || child.signal || child.status !== 0 || tests < 2
      || emptyEntry || passes !== tests || !skipped || !failures || !complete) {
    process.exitCode = 1;
    process.stderr.write('Foundation gate failed or did not execute a complete non-skipped test run.\n');
  }
} finally {
  disposeWorkspace(workspace);
}
