import { randomUUID } from 'node:crypto';
import { statSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const dockerOverrides = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'];
const tmpfs = Object.freeze({
  '/data/db': 'rw,noexec,nosuid,size=536870912,mode=1777',
  '/data/configdb': 'rw,noexec,nosuid,size=16777216,mode=1777',
  '/tmp': 'rw,noexec,nosuid,size=67108864,mode=1777',
});

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function validateRequest(request) {
  requireThat(request && Object.keys(request).sort().join(',') === 'endpoint,image', 'Only endpoint and image are accepted');
  requireThat(typeof request.endpoint === 'string' && /^unix:\/\/\/[^\0?#]+\.sock$/.test(request.endpoint), 'An explicit local Unix Docker socket is required');
  requireThat(typeof request.image === 'string' && /^mongo@sha256:[a-f0-9]{64}$/.test(request.image), 'A digest-pinned mongo image is required');
  requireThat(!dockerOverrides.some((key) => Object.hasOwn(process.env, key)), 'Ambient Docker overrides are forbidden');
}

function dockerExecutor(endpoint) {
  const socket = fileURLToPath(new URL(endpoint.replace(/^unix:/, 'file:')));
  requireThat(statSync(realpathSync(socket)).isSocket(), 'Docker endpoint is not a local Unix socket');
  return (args) => {
    const result = spawnSync('/usr/local/bin/docker', ['--host', endpoint, ...args], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024,
    });
    requireThat(!result.error && !result.signal && result.status === 0,
      `Docker ${args[0]} failed: ${(result.stderr || result.error?.message || result.stdout || result.signal || result.status).toString().trim().slice(0, 2000)}`);
    return result.stdout.trim();
  };
}

/** The optional executor is a trusted test transport, never an ownership claim. */
export function createMongoFixture(request, executor) {
  request = Object.freeze({ ...request });
  validateRequest(request);
  const execute = executor ?? dockerExecutor(request.endpoint);
  const engine = () => {
    const info = JSON.parse(execute(['info', '--format', '[{{json .ID}},{{json .OSType}}]']));
    requireThat(Array.isArray(info) && typeof info[0] === 'string' && info[0] && info[1] === 'linux', 'A known Linux Docker daemon is required');
    return info[0];
  };
  const daemonId = engine();
  const runId = randomUUID();
  const name = `sd-mongo-${runId}`;
  const replicaSet = `sd_rs_${runId.replaceAll('-', '')}`;
  const database = `sd_test_${runId.replaceAll('-', '')}`;
  const command = ['--replSet', replicaSet, '--bind_ip', 'localhost', '--port', '27017', '--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false'];
  const args = ['create', '--pull=never', '--name', name,
    '--label', `swasthadisha.test.run=${runId}`, '--label', 'swasthadisha.test.purpose=mongo-fixture',
    '--network', 'none', '--read-only', '--user', '65534:65534', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--memory', '1073741824', '--cpus', '1', '--pids-limit', '128',
    '--env', 'MONGOSH_DISABLE_TELEMETRY=1', '--env', 'XDG_CONFIG_HOME=/tmp/mongosh',
    '--entrypoint', 'mongod'];
  for (const [destination, options] of Object.entries(tmpfs)) args.push('--tmpfs', `${destination}:${options}`);
  args.push(request.image, ...command);
  let id;
  try {
    id = execute(args).trim();
  } catch {
    throw new Error(`Fixture create not acknowledged; possible stopped test resource ${name}; no resource was adopted or removed`);
  }
  requireThat(/^[a-f0-9]{64}$/.test(id), `Fixture create returned no trusted ID; inspect the generated name ${name} separately`);
  let disposed = false;
  let phase = 'created';

  function assertOwned() {
    requireThat(!disposed, 'Fixture is already disposed');
    requireThat(engine() === daemonId, 'Docker daemon identity changed');
    const rows = JSON.parse(execute(['inspect', id]));
    requireThat(Array.isArray(rows) && rows.length === 1, 'Fixture inspection is ambiguous');
    const item = rows[0];
    const config = item.Config ?? {};
    const host = item.HostConfig ?? {};
    requireThat(item.Id === id && item.Name === '/' + name
      && config.Labels?.['swasthadisha.test.run'] === runId
      && config.Labels?.['swasthadisha.test.purpose'] === 'mongo-fixture', 'Fixture ownership changed');
    requireThat(config.Image === request.image && config.User === '65534:65534'
      && JSON.stringify(config.Entrypoint) === JSON.stringify(['mongod'])
      && JSON.stringify(config.Cmd) === JSON.stringify(command), 'Fixture executable configuration changed');
    requireThat(host.NetworkMode === 'none' && !host.PublishAllPorts && !host.Privileged
      && host.ReadonlyRootfs === true && !host.PidMode && !host.UTSMode
      && ['', 'private'].includes(host.IpcMode ?? '')
      && !(host.CapAdd?.length) && !(host.Devices?.length) && !(host.DeviceRequests?.length)
      && !(host.Binds?.length) && !(host.Mounts?.length) && !(host.VolumesFrom?.length)
      && Object.keys(host.PortBindings ?? {}).length === 0
      && Object.values(item.NetworkSettings?.Ports ?? {}).every((value) => value === null), 'Fixture isolation changed');
    requireThat(host.Memory === 1073741824 && host.NanoCpus === 1_000_000_000 && host.PidsLimit === 128
      && host.CapDrop?.includes('ALL') && host.SecurityOpt?.some((value) => ['no-new-privileges', 'no-new-privileges=true'].includes(value)), 'Fixture resource/security limits changed');
    requireThat(Object.keys(host.Tmpfs ?? {}).length === Object.keys(tmpfs).length
      && Object.entries(tmpfs).every(([key, value]) => host.Tmpfs[key] === value)
      && (item.Mounts ?? []).every((mount) => mount.Type === 'tmpfs' && Object.hasOwn(tmpfs, mount.Destination)), 'Fixture storage configuration changed');
  }

  function shell(script) {
    assertOwned();
    return execute(['exec', id, 'mongosh', '--norc', '--quiet',
      'mongodb://localhost:27017/admin?directConnection=true', '--eval', script]);
  }

  const fixture = Object.freeze({
    id, runId, database, replicaSet,
    async start() {
      assertOwned();
      requireThat(phase === 'created', 'Fixture start was already attempted');
      phase = 'starting';
      execute(['start', id]);
      const deadline = Date.now() + 30_000;
      let initialized = false;
      while (Date.now() < deadline) {
        try {
          if (!initialized) {
            shell(`
              try {
                const result=rs.initiate({_id:${JSON.stringify(replicaSet)},members:[{_id:0,host:'localhost:27017'}]});
                if(result.ok!==1 && result.codeName!=='AlreadyInitialized') throw new Error('Replica-set initialization failed');
              } catch(error) { if(error.codeName!=='AlreadyInitialized') throw error; }
            `);
            initialized = true;
          }
          const result = JSON.parse(shell('print(JSON.stringify(db.hello()));'));
          if (result.isWritablePrimary && result.setName === replicaSet) {
            phase = 'ready';
            return;
          }
        } catch (error) {
          // Ownership drift must not be hidden by readiness retries.
          assertOwned();
          if (Date.now() >= deadline) throw error;
        }
        await delay(250);
      }
      throw new Error('Disposable replica set did not become ready');
    },
    probeTransactions() {
      requireThat(phase === 'ready', 'Fixture must be ready before a transaction probe');
      const result = JSON.parse(shell(`
        const target=db.getSiblingDB(${JSON.stringify(database)});
        target.createCollection('effects');
        const session=db.getMongo().startSession();
        const effects=session.getDatabase(${JSON.stringify(database)}).effects;
        session.startTransaction(); effects.insertOne({_id:'aborted',value:1}); session.abortTransaction();
        const aborted=target.effects.countDocuments({_id:'aborted'});
        session.startTransaction(); effects.insertOne({_id:'committed',value:1}); session.commitTransaction();
        const committed=target.effects.countDocuments({_id:'committed'}); session.endSession();
        print(JSON.stringify({database:${JSON.stringify(database)},replicaSet:${JSON.stringify(replicaSet)},version:db.version(),committed,aborted}));
      `));
      requireThat(result.database === database && result.replicaSet === replicaSet
        && result.committed === 1 && result.aborted === 0, 'Transaction probe returned mismatched evidence');
      return Object.freeze(result);
    },
    dispose() {
      if (disposed) return;
      assertOwned();
      execute(['rm', '--force', '--volumes', id]);
      disposed = true;
    },
  });
  try {
    assertOwned();
  } catch (cause) {
    throw new Error(`Fixture admission failed; cleanup withheld for created ID ${id}`, { cause });
  }
  return fixture;
}
