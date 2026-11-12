# Exact offline authority-harness check recipe — NOT RUN

This is an inert two-runtime campaign proposal. Two actual independent exact recipe/source decisions from Root Standards and lab Spec are required before one campaign. It does not admit any real authority entry/compiler/domain evaluation or Docker action. Preserve frozen `SOURCE_FREEZE.json` and its listed files unchanged.

The existing foundation gate stages exactly eleven regular files and runs four fixed test entries: foundation preflight, fake Mongo fixture, fake application controller and shared bundle/network tests. The twelve-file entire runner/import/staging closure is hash-bound in `OFFLINE_CHECK_PLAN.json` (runner plus eleven). Child Node gets filesystem permissions only for its owned workspace; no process/worker/addon grant. The initial runner legitimately spawns only its fixed test child. Node permission model alone is not network isolation: here zero network follows the fixed reviewed dependency-free source/import closure and fake executors. No scenario/bootstrap, compiler bytes, `src1`, MongoDB driver, Express/SDK/provider or real Docker executor is staged/evaluated. No extra flag, package install, root test/staging change or probe is included.

Both existing runtime files were read as metadata/bytes during preparation, not executed: Node22 regular/nlink1/uid501/mode0500/113002944B; Node24 regular/nlink1/uid501/mode0755/121306800B. Exact paths/hashes are in the plan; missing/drift stops before process allocation. A separate `--version` process is unnecessary: exact reviewed bytes and actual gate TAP bind the run.

The source adds26 test registrations: two fixed-profile bundle tests; one synthetic authority lifecycle; twelve corrupt-evidence cases; one setup-fallback case; ten malformed-synthetic-input cases. The historical baseline324 plus26 yields planned350 per runtime. Counts are a prospective data-derived expectation, not a reported result. Existing negative coverage includes no executor/default transport, source/metadata/link/drift, profile/engine/mount/limits, ownership/cleanup, environment and semantic egress canary decisions. Fake authority acceptance uses explicit simulated result objects; it cannot establish any emitted-domain or real-adapter behavior. Current new-entry/real-adapter stderr paths remain source reviewed only.

Each gate gets a fresh owned scratch beneath a fresh retained capture area, clean env containing only TMPDIR, exact cwd and argv. This is the existing gate's supported TMPDIR parent mechanism; the child creates its own exact NODE_ENV/TZ/TMPDIR/workspace/run-ID environment. Capture is bounded to1MiB stdout and64KiB stderr per gate; its existing child bound is30seconds, fixed outer limit45seconds. Overflow/timeout kills only the new owned process group, retains bounded prefixes with explicit incomplete/count provenance, and fails the campaign. Success requires full actual TAP350/350, zero fail/cancel/skip/TODO, unchanged hashes and empty exact owned scratch after runner cleanup. Failed/unknown ownership retains evidence and leftovers; no broad deletion, retry or cleanup claim. The capture parent remains intentionally for evidence.

Run this exact inline program only after the two recorded votes, using pinned Python3.14.7 SHA87d4df53fd91304be5bac391fb204643c36b7df2023c04a0953bcbc7d4fdf634. No launch or test occurred in preparing it:

```sh
env -i /opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/bin/python3.14 -I -S -B - <<'PY_OFFLINE'
import hashlib, json, os, pathlib, re, selectors, signal, stat, subprocess, tempfile, time
root = pathlib.Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/authority-pure-runtime')
plan = json.loads((root / 'output/qa/authority-pure-runtime/OFFLINE_CHECK_PLAN.json').read_text())
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def require(value, message):
    if not value: raise RuntimeError(message)
def identity(path):
    s = path.lstat()
    require(not stat.S_ISLNK(s.st_mode), 'Symbolic link denied')
    return (s.st_dev, s.st_ino, s.st_uid, s.st_mode, 0 if stat.S_ISDIR(s.st_mode) else s.st_nlink)
def regular(path, expected):
    s = path.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == os.getuid(), 'Regular owned input required')
    require(digest(path) == expected, 'Input hash changed: ' + str(path))
regular(root / 'output/qa/authority-pure-runtime/OFFLINE_CHECK_PLAN.json', '31db9f7ed0687aa5126d83fee468979fd70f0b58862d61fecc1b6efb9a98576d')
regular(root / 'output/qa/authority-pure-runtime/SOURCE_FREEZE.json', plan['sourceFreezeSha256'])
freeze = json.loads((root / 'output/qa/authority-pure-runtime/SOURCE_FREEZE.json').read_text())
def sources():
    for name, expected in plan['closure'].items(): regular(root / name, expected)
    for name, row in freeze['source'].items(): regular(root / name, row['sha256'])
sources()
for _, path, expected in plan['runtimes']: regular(pathlib.Path(path), expected)
area = pathlib.Path(tempfile.mkdtemp(prefix='sd-authority-offline-', dir='/private/tmp'))
area_id = identity(area)
print(json.dumps({'allocated':str(area),'mode':'OFFLINE_FAKE_ONLY','noTestsYet':True}), flush=True)
results = []; failure = None
try:
    for label, node, expected in plan['runtimes']:
        require(identity(area) == area_id, 'Capture area identity changed')
        sources(); regular(pathlib.Path(node), expected)
        scratch = area / (label + '-scratch'); scratch.mkdir(mode=0o700); scratch_id = identity(scratch)
        captures = {}; totals = {'stdout':0,'stderr':0}; truncated = False; problem = None; proc = None
        limits = {'stdout':1024*1024,'stderr':64*1024}; deadline = time.monotonic() + 45
        try:
            for stream in limits:
                path = area / (label + ('.tap' if stream == 'stdout' else '.stderr.txt'))
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                captures[stream] = (os.fdopen(fd, 'wb'), identity(path))
            proc = subprocess.Popen([node, 'test/foundation/run.mjs'], cwd=root,
                env={'TMPDIR':str(scratch)}, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, start_new_session=True)
            selector = selectors.DefaultSelector()
            selector.register(proc.stdout, selectors.EVENT_READ, 'stdout'); selector.register(proc.stderr, selectors.EVENT_READ, 'stderr')
            killed_at = None
            while selector.get_map():
                if problem is None and time.monotonic() >= deadline: problem = 'OUTER_TIMEOUT_45S'
                if problem is not None and killed_at is None:
                    require(os.getpgid(proc.pid) == proc.pid, 'Owned process group changed')
                    os.killpg(proc.pid, signal.SIGKILL); killed_at = time.monotonic()
                if killed_at is not None and time.monotonic() - killed_at >= 5:
                    raise RuntimeError('PIPE_DRAIN_UNRESOLVED_AFTER_KILL')
                for key, _ in selector.select(0.1):
                    block = os.read(key.fd, 4096)
                    if not block:
                        selector.unregister(key.fileobj); key.fileobj.close(); continue
                    stream = key.data; prior = totals[stream]; totals[stream] += len(block)
                    retained = block[:max(0, limits[stream] - prior)]
                    if retained: captures[stream][0].write(retained)
                    if totals[stream] > limits[stream]:
                        truncated = True
                        if problem is None: problem = stream.upper() + '_OVERFLOW'
            selector.close(); status = proc.wait(timeout=5)
        finally:
            # Owned group only; no broad process lookup, directory scan or resource adoption.
            if proc is not None and proc.poll() is None:
                require(os.getpgid(proc.pid) == proc.pid, 'Owned process group changed during cleanup')
                os.killpg(proc.pid, signal.SIGKILL); proc.wait(timeout=5)
            for handle, _ in captures.values(): handle.close()
        require(identity(area) == area_id and identity(scratch) == scratch_id, 'Capture ownership changed')
        captured = {}
        for stream, suffix in [('stdout','.tap'),('stderr','.stderr.txt')]:
            path = area / (label + suffix)
            require(identity(path) == captures[stream][1], 'Capture file replaced')
            captured[stream] = {'path':str(path),'sha256':digest(path),'retainedBytes':path.stat().st_size,
                'observedBytesAtLeast':totals[stream],'complete':not truncated and problem is None}
        leftovers = sorted(x.name for x in scratch.iterdir())
        tap = (area / (label + '.tap')).read_text()
        counts = {key:int(re.search(r'^# ' + key + r' (\d+)$', tap, re.M).group(1))
            for key in ['tests','pass','fail','cancelled','skipped','todo'] if re.search(r'^# ' + key + r' (\d+)$', tap, re.M)}
        row = {'runtime':label,'argv':[node,'test/foundation/run.mjs'],'env':{'TMPDIR':str(scratch)},
            'returnCode':status,'problem':problem,'truncated':truncated,'captures':captured,'counts':counts,
            'ownedScratchEmpty':not leftovers,'leftoverNames':leftovers}
        results.append(row); sources(); regular(pathlib.Path(node), expected)
        require(problem is None and status == 0 and not leftovers and counts ==
            {'tests':350,'pass':350,'fail':0,'cancelled':0,'skipped':0,'todo':0}, 'Offline gate failed or incomplete')
except BaseException as exc:
    failure = {'type':type(exc).__name__,'message':str(exc)[:2048]}
finally:
    require(identity(area) == area_id, 'Capture ownership lost; result not overwritten')
    result = {'status':'OFFLINE_FAKE_PASS' if failure is None and len(results)==2 else 'OFFLINE_FAILED_OR_UNRESOLVED',
        'results':results,'failure':failure,'noAuthorityCompilerOrProductionEvaluation':True,
        'noDockerDatabaseProviderOrNetworkCall':True,'areaRetained':str(area)}
    path = area / 'result.json'
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as handle:
        json.dump(result, handle, indent=2); handle.write('\n')
    print(json.dumps({'result':str(path),'sha256':digest(path),'status':result['status']}), flush=True)
if failure is not None: raise SystemExit(1)
PY_OFFLINE
```
