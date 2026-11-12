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
import { assertBundle, ENROLLMENT_ROLE, verifyEnrollmentResult, AUTHORITY_COMPILER_SHA, AUTHORITY_INPUTS, AUTHORITY_ROLE, AUTHORITY_SOURCE_HASHES, AUTHORITY_VECTORS_SHA, makeManifest, NETWORK_ADMISSION_TAG, PORT_OPERATIONS, ROLE, requireThat, sha256, sourceNames, verifyAuthorityResult, verifyNetworkAdmission } from './app-bundle.mjs';

const overrides = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
  'MONGODB_URL', 'PHARMACY_TEST_MONGODB_URI', 'DATABASE_URL', 'PAYMENT_SECRET', 'NODE_OPTIONS', 'NODE_PATH'];
const nodeArgs = ['--permission', '--allow-fs-read=/workspace', '--allow-fs-read=/sys/class/net', '--allow-fs-write=/tmp', '/workspace/bootstrap.mjs'];
const tmpfsOptions = 'rw,noexec,nosuid,size=67108864,mode=1777';

function enrollmentSources() {
  const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
  const regular = (location, limit = 16 * 1024 * 1024) => {
    const stat = lstatSync(location);
    requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < limit, 'Enrollment regular source');
    return readFileSync(location, 'utf8');
  };
  const descriptorPath = '/private/tmp/sd-customer-enrollment-build.json';
  const descriptorStat = lstatSync(descriptorPath);
  requireThat(descriptorStat.uid === process.getuid() && (descriptorStat.mode & 0o777) === 0o600, 'Enrollment descriptor owner/mode');
  const descriptor = JSON.parse(regular(descriptorPath));
  requireThat(descriptor.schema === 'SD-ENROLLMENT-BUILD-1' && descriptor.sourceRoot === root && descriptor.mode === 'install-emit'
    && /^\/private\/tmp\/sd-customer-enrollment-build-[a-f0-9-]{36}$/.test(descriptor.path), 'Enrollment owned artifact path');
  const directory = lstatSync(descriptor.path);
  requireThat(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid()
    && (directory.mode & 0o777) === 0o700 && directory.dev === descriptor.dev && directory.ino === descriptor.ino, 'Enrollment artifact ownership');
  const marker = JSON.parse(regular(join(descriptor.path, '.owner.json')));
  requireThat(marker.schema === 'SD-ENROLLMENT-OWNED-BUILD-1' && ['path', 'dev', 'ino', 'sourceRoot', 'sourceCommit', 'mode', 'inputs']
    .every(key => JSON.stringify(marker[key]) === JSON.stringify(descriptor[key])), 'Enrollment build marker');
  requireThat(descriptor.inputs && Object.keys(descriptor.inputs).length > 0 && Object.entries(descriptor.inputs).every(([name, digest]) =>
    !name.startsWith('/') && !name.split('/').includes('..') && sha256(regular(join(root, name))) === digest), 'Enrollment source inputs changed');
  const sources = {};
  for (const name of sourceNames(ENROLLMENT_ROLE)) {
    if (name === 'package.json') sources[name] = '{"type":"module"}\n';
    else if (['emitted-modules.json', 'runtime-modules.json'].includes(name)) {
      sources[name] = regular(join(descriptor.path, 'output', name), 8 * 1024 * 1024);
      requireThat(sha256(sources[name]) === descriptor.artifacts[name], 'Enrollment emitted artifact drift');
    } else if (['scenario.mjs', 'ports-plan.json'].includes(name)) sources[name] = regular(join(root, 'test/customer-enrollment-runtime', name));
    else sources[name] = regular(join(root, 'test/application', name));
  }
  requireThat(sha256(regular(join(descriptor.path, 'output/emission-report.json'))) === descriptor.artifacts['emission-report.json'], 'Enrollment emission report drift');
  return sources;
}

function reviewedSources(role) {
  if (role === ENROLLMENT_ROLE) return enrollmentSources();
  const sources = {};
  for (const name of sourceNames(role)) {
    if (name === 'package.json') { sources[name] = '{"type":"module"}\n'; continue; }
    const authoritySource = Object.keys(AUTHORITY_INPUTS).find((id) => AUTHORITY_INPUTS[id] === name);
    const location = name === 'typescript.cjs'
      ? new URL('file:///Users/shubham/.codex/runtimes/ruflo/3.75.0/node_modules/typescript/lib/typescript.js')
      : name === 'authority-vectors.json'
        ? new URL('../../output/qa/business-staff-authority/SERIALIZATION_VECTORS.json', import.meta.url)
        : authoritySource ? new URL('../../' + authoritySource, import.meta.url)
          : name === 'queryUtils.ts' ? new URL('../../src1/modules/common/utils/queryUtils.ts', import.meta.url)
            : new URL(name, import.meta.url);
    const stat = lstatSync(location);
    requireThat(stat.isFile() && !stat.isSymbolicLink() && (role !== AUTHORITY_ROLE || stat.nlink === 1), 'Harness source must be a regular file');
    if (role === AUTHORITY_ROLE) {
      requireThat(stat.size < (name === 'typescript.cjs' ? 10 * 1024 * 1024 : 128 * 1024), 'Authority source size changed');
      if (name === 'typescript.cjs') requireThat(stat.uid === 501 && (stat.mode & 0o777) === 0o644 && stat.size === 9112572,
        'Authority compiler metadata changed');
    }
    sources[name] = readFileSync(location, 'utf8');
    if (role === AUTHORITY_ROLE) {
      const expected = name === 'typescript.cjs' ? AUTHORITY_COMPILER_SHA
        : name === 'authority-vectors.json' ? AUTHORITY_VECTORS_SHA : AUTHORITY_SOURCE_HASHES[authoritySource];
      if (expected) requireThat(sha256(sources[name]) === expected, 'Authority source/tool pin changed');
    }
  }
  return sources;
}

function realDocker(endpoint, configuration, role) {
  const socket = fileURLToPath(new URL(endpoint.replace(/^unix:/, 'file:')));
  requireThat(statSync(realpathSync(socket)).isSocket(), 'Docker endpoint is not a local Unix socket');
  return (args) => {
    const result = spawnSync('/usr/local/bin/docker', ['--config', configuration, '--host', endpoint, ...args], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, encoding: 'utf8', timeout: 20_000, maxBuffer: 512 * 1024,
    });
    const commandSucceeded = !result.error && !result.signal && result.status === 0;
    const message = `Docker ${args[0]} failed: ${(result.stderr || result.error?.message || result.stdout || result.signal || result.status).toString().slice(0, 16 * 1024)}`;
    if (role === AUTHORITY_ROLE && args[0] === 'start') {
      const commandFailure = commandSucceeded ? undefined : new Error(message);
      try {
        const diagnostics = Buffer.from(result.stderr ?? '', 'utf8');
        if (diagnostics.length >= 32 * 1024) {
          const prefix = diagnostics.subarray(0, 30 * 1024);
          requireThat(writeSync(2, prefix) === prefix.length, 'Authority overflow prefix write was incomplete');
          const detail = '\n' + JSON.stringify({ tag: 'AUTHORITY_STDERR_OVERFLOW', observedBytes: diagnostics.length,
            retainedPrefixBytes: prefix.length, complete: false }) + '\n';
          requireThat(writeSync(2, detail) === Buffer.byteLength(detail), 'Authority overflow diagnostic write was incomplete');
          throw new Error('Authority child stderr exceeded limit: ' + diagnostics.length + ' observed bytes');
        }
        if (diagnostics.length) requireThat(writeSync(2, diagnostics) === diagnostics.length, 'Authority child stderr write was incomplete');
      } catch (recordingError) {
        if (commandFailure) throw new AggregateError([commandFailure, recordingError], 'Authority command and diagnostic recording failed');
        throw recordingError;
      }
      if (commandFailure) throw commandFailure;
    } else requireThat(commandSucceeded, message);
    return result.stdout.trim();
  };
}

/** Test seams are trusted transports/text fixtures, not resource-ownership claims. */
export function createApplicationFixture(input, seams = {}) { return createFixture(input, seams, ROLE); }
export function createAuthorityFixture(input, seams = {}) { return createFixture(input, seams, AUTHORITY_ROLE); }
export function createEnrollmentFixture(input, seams = {}) { return createFixture(input, seams, ENROLLMENT_ROLE); }

function createFixture(input, seams, role) {
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
  if (simulated && role === AUTHORITY_ROLE) {
    const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value));
    requireThat(Object.hasOwn(testSeams, 'bundle') && plain(testSeams.bundle)
      && Object.hasOwn(testSeams, 'authorityExpectation') && plain(testSeams.authorityExpectation),
    'Authority test seams require explicit synthetic bundle and expectation');
    const expected = testSeams.authorityExpectation;
    requireThat(Object.keys(expected).sort().join(',') === 'compilerSha256,sourceHashes'
      && plain(expected.sourceHashes)
      && Object.keys(expected.sourceHashes).sort().join(',') === Object.keys(AUTHORITY_INPUTS).sort().join(',')
      && Object.values(expected.sourceHashes).every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
      && typeof expected.compilerSha256 === 'string' && /^[a-f0-9]{64}$/.test(expected.compilerSha256),
    'Authority synthetic expectation must contain exact source and compiler hashes');
  }
  const authorityExpectation = role === AUTHORITY_ROLE ? Object.freeze({
    sourceHashes: Object.freeze({ ...(simulated ? testSeams.authorityExpectation.sourceHashes : AUTHORITY_SOURCE_HASHES) }),
    compilerSha256: simulated ? testSeams.authorityExpectation.compilerSha256 : AUTHORITY_COMPILER_SHA,
  }) : undefined;
  if (role === ENROLLMENT_ROLE && simulated) requireThat(Object.hasOwn(testSeams, 'bundle')
    && testSeams.bundle !== null && typeof testSeams.bundle === 'object' && !Array.isArray(testSeams.bundle), 'Enrollment fake requires explicit bundle');
  const selectedSources = role === AUTHORITY_ROLE
    ? (simulated ? testSeams.bundle : reviewedSources(role))
    : ((simulated ? testSeams.bundle : undefined) ?? reviewedSources(role));
  const sources = Object.freeze({ ...selectedSources });
  const enrollmentPlan = role === ENROLLMENT_ROLE ? JSON.parse(sources['ports-plan.json']) : undefined;
  const enrollmentExpectation = role === ENROLLMENT_ROLE ? Object.freeze({
    caseIds: enrollmentPlan.vectors.map(row => row.id), controls: enrollmentPlan.controls.concat(enrollmentPlan.oldControl),
    planSha256: sha256(sources['ports-plan.json']), emittedSha256: sha256(sources['emitted-modules.json']), runtimeSha256: sha256(sources['runtime-modules.json']),
  }) : undefined;

  const runId = randomUUID();
  const manifest = makeManifest(runId, sources, role);
  if (role === AUTHORITY_ROLE) {
    requireThat(Object.keys(authorityExpectation.sourceHashes).sort().join(',') === Object.keys(AUTHORITY_INPUTS).sort().join(',')
      && Object.entries(AUTHORITY_INPUTS).every(([id, name]) => authorityExpectation.sourceHashes[id] === manifest.files[name])
      && authorityExpectation.compilerSha256 === manifest.files['typescript.cjs'], 'Authority expectation differs from staged sources');
  }
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
    const execute = simulated ? testSeams.executor : realDocker(request.endpoint, configDirectory, role);
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
      && (role !== ENROLLMENT_ROLE || images[0].Architecture === 'arm64')
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
      'APP_ROLE=' + role, 'APP_MANIFEST_SHA=' + manifestSha];
    assertWorkspace();
    assertBundle(bundle, { runId, manifestSha, role });
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
      if (checkSources) assertBundle(bundle, { runId, manifestSha, role });
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
        requireThat(result.runId === runId && result.role === role && result.manifestSha === manifestSha
          && result.admissionPassed === true && result.egressBlocked === true
          && result.filesystemCanariesPassed === true && result.databaseMode === 'not-admitted'
          && !Object.hasOwn(result, 'networkInterfaces')
          && result.networkAdmission?.tag === NETWORK_ADMISSION_TAG && result.networkAdmission.loopback === 'lo'
          && verifyNetworkAdmission(result.networkAdmission),
        'Application admission evidence mismatched');
        if (role === ENROLLMENT_ROLE) {
          requireThat(Object.keys(result).sort().join(',') === ['admissionPassed', 'enrollment', 'databaseMode', 'egressBlocked',
            'filesystemCanariesPassed', 'manifestSha', 'networkAdmission', 'role', 'runId'].sort().join(',')
            && Buffer.byteLength(output) < 16 * 1024 && verifyEnrollmentResult(result.enrollment, enrollmentExpectation), 'Enrollment evidence mismatched');
          phase = 'finished'; return Object.freeze({ ...result, enrollment: Object.freeze(result.enrollment) });
        }
        if (role === AUTHORITY_ROLE) {
          requireThat(Object.keys(result).sort().join(',') === ['admissionPassed', 'authority', 'databaseMode', 'egressBlocked',
            'filesystemCanariesPassed', 'manifestSha', 'networkAdmission', 'role', 'runId'].sort().join(',')
            && Buffer.byteLength(output) < 16 * 1024 && verifyAuthorityResult(result.authority, authorityExpectation),
          'Authority scenario evidence mismatched');
          phase = 'finished';
          return Object.freeze({ ...result, authority: Object.freeze(result.authority) });
        }
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
