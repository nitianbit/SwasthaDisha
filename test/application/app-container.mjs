import { randomUUID } from 'node:crypto';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import imageSpecification from './app-image.json' with { type: 'json' };
const image = Object.freeze({ ...imageSpecification });
import runtimeSpecification from './app-runtime.json' with { type: 'json' };
const localRuntime = Object.freeze({ ...runtimeSpecification });
import { assertBundle, makeManifest, PORT_OPERATIONS, ROLE, requireThat, sha256, SOURCE_NAMES } from './app-bundle.mjs';

const overrides = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
  'MONGODB_URL', 'PHARMACY_TEST_MONGODB_URI', 'DATABASE_URL', 'PAYMENT_SECRET', 'NODE_OPTIONS', 'NODE_PATH'];
const nodeArgs = ['--permission', '--allow-fs-read=/workspace', '--allow-fs-read=/sys/class/net', '--allow-fs-write=/tmp', '/workspace/bootstrap.mjs'];
const tmpfsOptions = 'rw,noexec,nosuid,size=67108864,mode=1777';

function reviewedSources() {
  const sources = {};
  for (const name of SOURCE_NAMES) {
    if (name === 'package.json') { sources[name] = '{"type":"module"}\n'; continue; }
    const location = name === 'queryUtils.ts'
      ? new URL('../../src1/modules/common/utils/queryUtils.ts', import.meta.url)
      : new URL(name, import.meta.url);
    const stat = lstatSync(location);
    requireThat(stat.isFile() && !stat.isSymbolicLink(), 'Harness source must be a regular file');
    sources[name] = readFileSync(location, 'utf8');
  }
  return sources;
}

function realDocker(endpoint, configuration) {
  const socket = fileURLToPath(new URL(endpoint.replace(/^unix:/, 'file:')));
  requireThat(statSync(realpathSync(socket)).isSocket(), 'Docker endpoint is not a local Unix socket');
  return (args) => {
    const result = spawnSync('/usr/local/bin/docker', ['--config', configuration, '--host', endpoint, ...args], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, encoding: 'utf8', timeout: 20_000, maxBuffer: 512 * 1024,
    });
    requireThat(!result.error && !result.signal && result.status === 0,
      `Docker ${args[0]} failed: ${(result.stderr || result.error?.message || result.stdout || result.signal || result.status).toString().slice(0, 16 * 1024)}`);
    return result.stdout.trim();
  };
}

/** Test seams are trusted transports/text fixtures, not resource-ownership claims. */
export function createApplicationFixture(input, seams = {}) {
  requireThat(seams !== null && typeof seams === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(seams)), 'Test seams must be a plain object');
  const simulated = Reflect.ownKeys(seams).length > 0;
  const testSeams = Object.freeze({ ...seams });
  requireThat(!simulated || (Object.hasOwn(testSeams, 'executor') && typeof testSeams.executor === 'function'),
    'Test seams require an explicit callable test executor');
  requireThat(!Object.hasOwn(testSeams, 'reportCreated') || typeof testSeams.reportCreated === 'function',
    'An explicit callable test reporter is required');
  const request = Object.freeze({ ...input });
  requireThat(Object.keys(request).join(',') === 'endpoint'
    && typeof request.endpoint === 'string' && /^unix:\/\/\/[^\0?#]+\.sock$/.test(request.endpoint),
  'Only an explicit local Unix Docker endpoint is accepted');
  requireThat(!overrides.some((name) => Object.hasOwn(process.env, name)), 'Ambient Docker overrides are forbidden');
  const profile = Object.freeze({ ...((simulated ? testSeams.profile : undefined) ?? localRuntime) });
  requireThat(request.endpoint === profile.endpoint && typeof profile.engineId === 'string' && profile.engineId,
    'Docker target is outside the reviewed local runtime profile');
  requireThat(/^node@sha256:[a-f0-9]{64}$/.test(image.image) && image.nodeVersion === '22.23.4', 'Invalid pinned runtime');
  const sources = Object.freeze({ ...((simulated ? testSeams.bundle : undefined) ?? reviewedSources()) });
  const runId = randomUUID();
  const manifest = makeManifest(runId, sources);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sd-app-isolation-')));
  const rootIdentity = lstatSync(directory);
  let bundleIdentity;
  let bundle;
  let id;
  let createAttempted = false;
  let disposed = false;
  let containerRemoved = false;
  let phase = 'created';
  const name = 'sd-app-' + runId;
  const marker = join(directory, '.owner.json');

  function assertWorkspace() {
    const stat = lstatSync(directory);
    requireThat(!disposed && stat.isDirectory() && !stat.isSymbolicLink()
      && stat.dev === rootIdentity.dev && stat.ino === rootIdentity.ino, 'Workspace identity changed');
    requireThat(!lstatSync(marker).isSymbolicLink()
      && JSON.parse(readFileSync(marker, 'utf8')).runId === runId, 'Workspace ownership changed');
    if (bundleIdentity) {
      const current = lstatSync(bundle);
      requireThat(current.isDirectory() && !current.isSymbolicLink()
        && current.dev === bundleIdentity.dev && current.ino === bundleIdentity.ino, 'Bundle directory identity changed');
    }
  }

  try {
    writeFileSync(marker, JSON.stringify({ runId }), { mode: 0o600, flag: 'wx' });
    bundle = join(directory, 'bundle');
    mkdirSync(bundle, { mode: 0o755 });
    bundleIdentity = lstatSync(bundle);
    requireThat(!/[,\r\n]/.test(bundle), 'Bundle path cannot be represented safely by Docker mount syntax');
    for (const [source, text] of Object.entries(sources)) writeFileSync(join(bundle, source), text, { mode: 0o444, flag: 'wx' });
    const manifestBytes = JSON.stringify(manifest);
    const manifestSha = sha256(manifestBytes);
    writeFileSync(join(bundle, '.admission.json'), manifestBytes, { mode: 0o444, flag: 'wx' });
    const configDirectory = join(directory, 'docker');
    mkdirSync(configDirectory, { mode: 0o700 });
    writeFileSync(join(configDirectory, 'config.json'), '{"auths":{}}\n', { mode: 0o600, flag: 'wx' });
    const execute = simulated ? testSeams.executor : realDocker(request.endpoint, configDirectory);
    const engine = () => {
      const row = JSON.parse(execute(['info', '--format', '[{{json .ID}},{{json .OSType}}]']));
      requireThat(Array.isArray(row) && typeof row[0] === 'string' && row[0] && row[1] === 'linux', 'Unknown Docker engine');
      return row[0];
    };
    const daemonId = engine();
    requireThat(daemonId === profile.engineId, 'Docker engine is outside the reviewed local runtime profile');
    const images = JSON.parse(execute(['image', 'inspect', image.image]));
    requireThat(images.length === 1 && /^sha256:[a-f0-9]{64}$/.test(images[0].Id)
      && images[0].Os === 'linux' && ['amd64', 'arm64'].includes(images[0].Architecture)
      && images[0].RepoDigests?.includes(image.image)
      && Object.keys(images[0].Config?.Volumes ?? {}).length === 0, 'Pinned Linux image is not cached or supported');
    const imageId = images[0].Id;
    const baseEnvironment = images[0].Config?.Env ?? [];
    requireThat(Array.isArray(baseEnvironment) && baseEnvironment.every((entry) =>
      typeof entry === 'string' && entry.indexOf('=') > 0), 'Unexpected runtime image environment');
    const imageEntries = baseEnvironment.map((entry) => {
      const separator = entry.indexOf('=');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    });
    const environmentKeys = imageEntries.map(([key]) => key);
    requireThat(environmentKeys.includes('PATH') && environmentKeys.includes('NODE_VERSION')
      && imageEntries.every(([key, value]) =>
        (key === 'PATH' && value === '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
        || (key === 'NODE_VERSION' && value === image.nodeVersion)
        || (key === 'YARN_VERSION' && /^[0-9.]+$/.test(value)))
      && new Set(environmentKeys).size === baseEnvironment.length, 'Unexpected runtime image environment');
    const environment = [...baseEnvironment, 'NODE_ENV=test', 'APP_RUN_ID=' + runId,
      'APP_ROLE=' + ROLE, 'APP_MANIFEST_SHA=' + manifestSha];
    assertWorkspace();
    assertBundle(bundle, { runId, manifestSha });
    const args = ['create', '--pull=never', '--name', name, '--network', 'none', '--read-only',
      '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '536870912', '--cpus', '1', '--pids-limit', '64', '--log-driver', 'none', '--no-healthcheck',
      '--workdir', '/workspace', '--entrypoint', 'node', '--tmpfs', '/tmp:' + tmpfsOptions,
      '--mount', `type=bind,source=${bundle},target=/workspace,readonly,bind-propagation=rprivate`,
      '--label', 'swasthadisha.test.purpose=app-isolation', '--label', 'swasthadisha.test.run=' + runId];
    for (const entry of environment) args.push('--env', entry);
    args.push(image.image, ...nodeArgs);
    createAttempted = true;
    id = execute(args).trim();
    requireThat(/^[a-f0-9]{64}$/.test(id), 'Create returned no trusted container ID');
    const created = Object.freeze({ phase: 'created', id, runId, directory });
    if (simulated) testSeams.reportCreated?.(created);
    else writeSync(2, JSON.stringify(created) + '\n');

    function assertOwned(checkSources = true) {
      assertWorkspace();
      if (checkSources) assertBundle(bundle, { runId, manifestSha });
      requireThat(engine() === daemonId, 'Docker engine identity changed');
      const rows = JSON.parse(execute(['inspect', id]));
      requireThat(rows.length === 1, 'Ambiguous container inspection');
      const item = rows[0]; const config = item.Config ?? {}; const host = item.HostConfig ?? {};
      requireThat(item.Id === id && item.Name === '/' + name && item.Image === imageId
        && config.Labels?.['swasthadisha.test.run'] === runId
        && config.Labels?.['swasthadisha.test.purpose'] === 'app-isolation', 'Container ownership changed');
      requireThat(config.Image === image.image && config.User === '1000:1000' && config.WorkingDir === '/workspace'
        && JSON.stringify(config.Entrypoint) === '["node"]' && JSON.stringify(config.Cmd) === JSON.stringify(nodeArgs)
        && JSON.stringify([...(config.Env ?? [])].sort()) === JSON.stringify([...environment].sort())
        && JSON.stringify(config.Healthcheck?.Test) === '["NONE"]', 'Executable/environment configuration changed');
      requireThat(host.NetworkMode === 'none' && !host.Privileged && host.ReadonlyRootfs === true
        && !host.PublishAllPorts && !host.PidMode && !host.UTSMode && !host.UsernsMode
        && ['', 'private'].includes(host.IpcMode ?? '') && ['', 'private'].includes(host.CgroupnsMode ?? '')
        && !(host.CapAdd?.length) && !(host.Devices?.length) && !(host.DeviceRequests?.length)
        && !(host.Binds?.length) && !(host.VolumesFrom?.length) && !(host.Links?.length)
        && Object.keys(host.PortBindings ?? {}).length === 0
        && Object.keys(item.NetworkSettings?.Networks ?? {}).every((key) => key === 'none')
        && Object.values(item.NetworkSettings?.Ports ?? {}).every((value) => value === null), 'Container isolation changed');
      requireThat(host.Memory === 536870912 && host.NanoCpus === 1_000_000_000 && host.PidsLimit === 64
        && host.CapDrop?.includes('ALL') && host.SecurityOpt?.length === 1
        && ['no-new-privileges', 'no-new-privileges=true'].includes(host.SecurityOpt[0])
        && host.LogConfig?.Type === 'none', 'Container limits changed');
      const declared = host.Mounts ?? [];
      requireThat(declared.length === 1 && declared[0].Type === 'bind' && declared[0].Source === bundle
        && declared[0].Target === '/workspace' && declared[0].ReadOnly === true
        && declared[0].BindOptions?.Propagation === 'rprivate'
        && JSON.stringify(host.Tmpfs) === JSON.stringify({ '/tmp': tmpfsOptions }), 'Declared storage changed');
      const mounts = item.Mounts ?? [];
      const binds = mounts.filter((mount) => mount.Type === 'bind');
      requireThat(binds.length === 1 && binds[0].Source === bundle && binds[0].Destination === '/workspace'
        && binds[0].RW === false && binds[0].Propagation === 'rprivate'
        && mounts.every((mount) => mount.Type === 'bind' || (mount.Type === 'tmpfs' && mount.Destination === '/tmp')),
      'Effective storage changed');
      return item;
    }

    assertOwned();
    return Object.freeze({
      id, runId, directory, image: image.image,
      run() {
        assertOwned();
        requireThat(phase === 'created', 'Application run was already attempted');
        phase = 'starting';
        const output = execute(['start', '--attach', id]);
        const item = assertOwned();
        requireThat(item.State?.Status === 'exited' && item.State.ExitCode === 0 && !item.State.OOMKilled,
          'Application fixture did not exit successfully');
        const result = JSON.parse(output);
        requireThat(result.runId === runId && result.role === ROLE && result.manifestSha === manifestSha
          && result.admissionPassed === true && result.egressBlocked === true
          && result.filesystemCanariesPassed === true && result.databaseMode === 'not-admitted'
          && JSON.stringify(result.networkInterfaces) === '["lo"]',
        'Application admission evidence mismatched');
        requireThat(Array.isArray(result.calls) && result.calls.length === Object.keys(PORT_OPERATIONS).length
          && new Set(result.calls.map((call) => call.port)).size === result.calls.length
          && result.calls.every((call) => Object.hasOwn(PORT_OPERATIONS, call.port)
            && call.operation === PORT_OPERATIONS[call.port] && call.effect === false && call.status === 'recorded')
          && result.scenario?.literalSearchPassed === true && result.scenario.unknownOperationRejected === true,
        'Application scenario evidence mismatched');
        phase = 'finished';
        return Object.freeze({ ...result, calls: Object.freeze(result.calls.map((call) => Object.freeze(call))),
          scenario: Object.freeze(result.scenario) });
      },
      dispose() {
        if (disposed) return;
        if (!containerRemoved) {
          assertOwned(false);
          execute(['rm', '--force', '--volumes', id]);
          containerRemoved = true;
        }
        assertWorkspace();
        rmSync(directory, { recursive: true, force: false });
        disposed = true;
      },
    });
  } catch (cause) {
    if (createAttempted) {
      throw new Error(`Application fixture unresolved; cleanup withheld for ${id ?? name}; workspace ${directory}`, { cause });
    }
    // Before create, this exact new workspace is the only allocated resource.
    let current;
    try { current = lstatSync(directory); } catch (cleanupError) {
      if (cleanupError.code === 'ENOENT') throw cause;
      throw new AggregateError([cause, cleanupError], `Pre-create cleanup failed; workspace ${directory}`);
    }
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) {
      throw new Error(`Pre-create cleanup withheld; workspace identity changed at ${directory}`, { cause });
    }
    try { rmSync(directory, { recursive: true, force: false }); } catch (cleanupError) {
      throw new AggregateError([cause, cleanupError], `Pre-create cleanup failed; workspace ${directory}`);
    }
    throw cause;
  }
}
