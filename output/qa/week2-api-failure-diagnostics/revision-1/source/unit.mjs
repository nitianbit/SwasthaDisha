import { mkdtempSync, mkdirSync, lstatSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

if (process.argv.length !== 2) throw Error('This fixed unit gate accepts no positional input');
if (process.execArgv.length || Object.hasOwn(process.env, 'NODE_OPTIONS') || Object.hasOwn(process.env, 'NODE_PATH')) {
  throw Error('Start this fixed unit gate without preload flags or overrides');
}
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) throw Error('Node 22.13+ permission support is required');
const files = new Map([
  ['test/api-runtime/platform.mjs', new URL('./platform.mjs', import.meta.url)],
  ['test/api-runtime/platform.test.mjs', new URL('./platform.test.mjs', import.meta.url)],
  ['test/api-runtime/profile.json', new URL('./profile.json', import.meta.url)],
  ['test/api-runtime/launch.mjs', new URL('./launch.mjs', import.meta.url)],
  ['test/api-runtime/launch.test.mjs', new URL('./launch.test.mjs', import.meta.url)],
  ['test/application/app-bundle.mjs', new URL('../application/app-bundle.mjs', import.meta.url)],
]);
const directory = mkdtempSync(join(tmpdir(), 'sd-api-platform-units-'));
const identity = lstatSync(directory); const runId = randomUUID();
const marker = join(directory, '.owner.json');
writeFileSync(marker, JSON.stringify({ runId }), { flag: 'wx', mode: 0o600 });
let result;
try {
  const hashes = {};
  for (const [name, source] of files) {
    const st = lstatSync(source);
    if (!st.isFile() || st.isSymbolicLink()) throw Error('Unit source must be regular');
    const bytes = readFileSync(source);
    hashes[name] = createHash('sha256').update(bytes).digest('hex');
    const parts = name.split('/'); parts.pop(); mkdirSync(join(directory, ...parts), { recursive: true });
    writeFileSync(join(directory, name), bytes, { flag: 'wx', mode: 0o444 });
  }
  const args = ['--permission', '--allow-fs-read=' + directory, '--allow-fs-write=' + directory,
    '--experimental-test-isolation=none', '--test', '--test-reporter=tap', 'test/api-runtime/platform.test.mjs', 'test/api-runtime/launch.test.mjs'];
  result = spawnSync(process.execPath, args, { cwd: directory, env: { TMPDIR: directory },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  const summary = (name) => [...(result.stdout || '').matchAll(new RegExp('^# ' + name + ' (\\d+)$', 'gm'))].at(-1)?.[1];
  const tests = Number(summary('tests'));
  if (result.error || result.signal || result.status !== 0 || tests !== 80
    || Number(summary('pass')) !== tests || ['fail', 'cancelled', 'skipped', 'todo'].some((name) => summary(name) !== '0')) {
    throw Error('API platform unit gate failed or required cases did not run');
  }
  process.stderr.write(JSON.stringify({ kind: 'OFFLINE_FAKE_TRANSPORT_ONLY', tests, sourceSha256: hashes,
    applicationImports: 0, DockerCalls: 0, databaseConnections: 0 }) + '\n');
} finally {
  const current = lstatSync(directory);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
    || JSON.parse(readFileSync(marker)).runId !== runId) throw Error('Unit workspace ownership lost; cleanup withheld');
  rmSync(directory, { recursive: true });
}
