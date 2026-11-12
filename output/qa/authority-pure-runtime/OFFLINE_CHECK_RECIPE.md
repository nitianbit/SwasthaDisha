# Exact offline authority-harness check recipe — revision2, NOT RUN

This is an inert two-runtime campaign proposal. Revision1 was REQUEST_CHANGES by actual Root Standards and lab Spec review; exact old recipe/plan and decision provenance are preserved under `offline-review-1/`. No campaign ran or approval was consumed. Revision2 changes only capture failure/evidence handling and needs two fresh exact decisions. Two actual independent exact recipe/source decisions from Root Standards and lab Spec are required before one campaign. It does not admit any real authority entry/compiler/domain evaluation or Docker action. Preserve frozen `SOURCE_FREEZE.json` and its listed files unchanged.

The existing foundation gate stages exactly eleven regular files and runs four fixed test entries: foundation preflight, fake Mongo fixture, fake application controller and shared bundle/network tests. The twelve-file entire runner/import/staging closure is hash-bound in `OFFLINE_CHECK_PLAN.json` (runner plus eleven). Child Node gets filesystem permissions only for its owned workspace; no process/worker/addon grant. The initial runner legitimately spawns only its fixed test child. Node permission model alone is not network isolation: here zero network follows the fixed reviewed dependency-free source/import closure and fake executors. No scenario/bootstrap, compiler bytes, `src1`, MongoDB driver, Express/SDK/provider or real Docker executor is staged/evaluated. No extra flag, package install, root test/staging change or probe is included.

Both existing runtime files were read as metadata/bytes during preparation, not executed: Node22 regular/nlink1/uid501/mode0500/113002944B; Node24 regular/nlink1/uid501/mode0755/121306800B. Exact paths/hashes are in the plan; missing/drift stops before process allocation. A separate `--version` process is unnecessary: exact reviewed bytes and actual gate TAP bind the run.

The source adds26 test registrations: two fixed-profile bundle tests; one synthetic authority lifecycle; twelve corrupt-evidence cases; one setup-fallback case; ten malformed-synthetic-input cases. The historical baseline324 plus26 yields planned350 per runtime. Counts are a prospective data-derived expectation, not a reported result. Existing negative coverage includes no executor/default transport, source/metadata/link/drift, profile/engine/mount/limits, ownership/cleanup, environment and semantic egress canary decisions. Fake authority acceptance uses explicit simulated result objects; it cannot establish any emitted-domain or real-adapter behavior. Current new-entry/real-adapter stderr paths remain source reviewed only.

Each gate gets a fresh owned scratch beneath a fresh retained capture area, clean env containing only TMPDIR, exact cwd and argv. This is the existing gate's supported TMPDIR parent mechanism; the child creates its own exact NODE_ENV/TZ/TMPDIR/workspace/run-ID environment. Capture is bounded to1MiB stdout and64KiB stderr per gate; its existing child bound is30seconds, fixed outer execution limit45seconds plus one finite5second drain/wait/cleanup phase. Overflow/timeout kills only the new owned process group, retains bounded prefixes with explicit incomplete/count provenance, and fails the campaign. Success requires full actual TAP350/350, zero fail/cancel/skip/TODO, unchanged hashes and empty exact owned scratch after runner cleanup. Every attempted runtime gets an early row before scratch/output/process operations. Timeout/overflow/exception latches the first problem; cleanup failures append separately. The row retains capture paths, observed/retained bytes, incomplete flags, PID/start/exit state and owned readbacks even when Popen/drain/wait/cleanup fails. Failed/unknown ownership retains evidence and leftovers; no broad deletion, retry or cleanup claim. Area/path identity loss forbids unsafe path reads/result writes and reports UNRESOLVED with the in-memory row. The capture parent remains intentionally for evidence.

Run this exact inline program only after the two recorded votes, using pinned Python3.14.7 SHA87d4df53fd91304be5bac391fb204643c36b7df2023c04a0953bcbc7d4fdf634. No launch or test occurred in preparing it:

```sh
env -i /opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/bin/python3.14 -I -S -B - <<'PY_OFFLINE'
import hashlib, json, os, pathlib, re, selectors, signal, stat, subprocess, tempfile, time
root = pathlib.Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/authority-pure-runtime')
plan_path = root / 'output/qa/authority-pure-runtime/OFFLINE_CHECK_PLAN.json'
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
regular(plan_path, '31db9f7ed0687aa5126d83fee468979fd70f0b58862d61fecc1b6efb9a98576d')
plan = json.loads(plan_path.read_text())
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
results = []; campaign_failure = None; area_lost = False
for label, node, expected in plan['runtimes']:
    # Record the attempt before any per-runtime scratch/output/process operation.
    scratch = area / (label + '-scratch')
    limits = {'stdout':1024*1024,'stderr':64*1024}
    paths = {s:area / (label + ('.tap' if s == 'stdout' else '.stderr.txt')) for s in limits}
    row = {'runtime':label,'argv':[node,'test/foundation/run.mjs'],'env':{'TMPDIR':str(scratch)},
        'attempted':True,'processStarted':False,'pid':None,'returnCode':None,'firstProblem':None,
        'cleanupErrors':[],'observationErrors':[],'secondaryProblems':[],'truncated':False,'counts':{},'ownedScratchEmpty':None,
        'leftoverNames':None,'captures':{s:{'path':str(p),'allocated':False,'sha256':None,
            'retainedBytes':0,'observedBytesAtLeast':0,'complete':False,'ownershipVerified':False} for s,p in paths.items()}}
    results.append(row)
    proc = None; selector = None; handles = {}; capture_ids = {}; scratch_id = None
    eof = set(); killed = False; cleanup_deadline = None; started = time.monotonic()
    def latch(code, exc=None):
        if row['firstProblem'] is None:
            row['firstProblem'] = {'code':code,'type':None if exc is None else type(exc).__name__,
                'message':None if exc is None else str(exc)[:2048]}
    def cleanup_error(code, exc):
        row['cleanupErrors'].append({'code':code,'type':type(exc).__name__,'message':str(exc)[:2048]})
    try:
        require(identity(area) == area_id, 'Capture area identity changed')
        sources(); regular(pathlib.Path(node), expected)
        scratch.mkdir(mode=0o700); scratch_id = identity(scratch)
        for stream, path in paths.items():
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            handles[stream] = os.fdopen(fd, 'wb', buffering=0); capture_ids[stream] = identity(path)
            row['captures'][stream]['allocated'] = True
        proc = subprocess.Popen(row['argv'], cwd=root, env=row['env'], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        row['processStarted'] = True; row['pid'] = proc.pid
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ, 'stdout'); selector.register(proc.stderr, selectors.EVENT_READ, 'stderr')
        deadline = time.monotonic() + 45
        while selector.get_map():
            if row['firstProblem'] is None and time.monotonic() >= deadline: latch('OUTER_TIMEOUT_45S')
            if row['firstProblem'] is not None and cleanup_deadline is None: cleanup_deadline = time.monotonic() + 5
            if row['firstProblem'] is not None and not killed:
                require(os.getpgid(proc.pid) == proc.pid, 'Owned process group changed')
                os.killpg(proc.pid, signal.SIGKILL); killed = True
            if cleanup_deadline is not None and time.monotonic() >= cleanup_deadline:
                raise RuntimeError('PIPE_DRAIN_UNRESOLVED_AFTER_KILL')
            for key, _ in selector.select(0.1):
                block = os.read(key.fd, 4096)
                if not block:
                    eof.add(key.data); selector.unregister(key.fileobj); key.fileobj.close(); continue
                stream = key.data; capture = row['captures'][stream]; prior = capture['observedBytesAtLeast']
                capture['observedBytesAtLeast'] += len(block)
                retained = block[:max(0, limits[stream] - prior)]
                if capture['observedBytesAtLeast'] > limits[stream]:
                    row['truncated'] = True; latch(stream.upper() + '_OVERFLOW')
                if retained:
                    require(identity(area) == area_id and identity(paths[stream]) == capture_ids[stream], 'Capture ownership changed before write')
                    written = handles[stream].write(retained); capture['retainedBytes'] += written
                    require(written == len(retained), 'Capture write incomplete')
        if cleanup_deadline is None: cleanup_deadline = time.monotonic() + 5
        try:
            row['returnCode'] = proc.wait(timeout=max(0, cleanup_deadline - time.monotonic()))
        except BaseException as exc:
            latch('WAIT_FAILED', exc); raise
        if row['returnCode'] != 0: latch('COMMAND_NONZERO_EXIT')
    except BaseException as exc:
        if row['firstProblem'] is None: latch('EXECUTION_EXCEPTION', exc)
        else: row['secondaryProblems'].append({'code':'EXCEPTION_AFTER_FIRST_PROBLEM','type':type(exc).__name__,'message':str(exc)[:2048]})
    finally:
        if cleanup_deadline is None: cleanup_deadline = time.monotonic() + 5
        if proc is not None:
            try:
                if proc.poll() is None:
                    if not killed:
                        require(os.getpgid(proc.pid) == proc.pid, 'Owned process group changed during cleanup')
                        os.killpg(proc.pid, signal.SIGKILL); killed = True
                    row['returnCode'] = proc.wait(timeout=max(0, cleanup_deadline - time.monotonic()))
                else: row['returnCode'] = proc.returncode
            except BaseException as exc: cleanup_error('PROCESS_CLEANUP_FAILED', exc)
        if selector is not None:
            try: selector.close()
            except BaseException as exc: cleanup_error('SELECTOR_CLOSE_FAILED', exc)
        if proc is not None:
            for pipe in [proc.stdout, proc.stderr]:
                try: pipe.close()
                except BaseException as exc: cleanup_error('PIPE_CLOSE_FAILED', exc)
        for handle in handles.values():
            try: handle.close()
            except BaseException as exc: cleanup_error('CAPTURE_CLOSE_FAILED', exc)
        # Always finalize the early attempt row. Lost identity forbids path reads or result writes.
        try:
            require(identity(area) == area_id, 'Capture area ownership lost')
        except BaseException as exc:
            area_lost = True; latch('AREA_OWNERSHIP_LOST', exc)
            row['observationErrors'].append({'code':'AREA_OWNERSHIP_LOST','type':type(exc).__name__})
        if not area_lost:
            for stream, path in paths.items():
                capture = row['captures'][stream]
                if not capture['allocated']: continue
                try:
                    require(identity(area) == area_id and identity(path) == capture_ids[stream], 'Capture file ownership lost')
                    capture['ownershipVerified'] = True; capture['retainedBytes'] = path.stat().st_size
                    require(capture['retainedBytes'] <= limits[stream], 'Capture size bound exceeded')
                    capture['sha256'] = digest(path)
                    capture['complete'] = stream in eof and not row['truncated'] and row['firstProblem'] is None and not row['cleanupErrors']
                except BaseException as exc:
                    latch('CAPTURE_OBSERVATION_FAILED', exc)
                    row['observationErrors'].append({'code':stream.upper() + '_OWNERSHIP_OR_METADATA_LOST','type':type(exc).__name__})
            try:
                require(identity(area) == area_id and scratch_id is not None and identity(scratch) == scratch_id, 'Scratch ownership unknown or lost')
                leftovers = sorted(x.name for x in scratch.iterdir())
                row['leftoverNames'] = leftovers; row['ownedScratchEmpty'] = not leftovers
            except BaseException as exc:
                latch('SCRATCH_OBSERVATION_FAILED', exc)
                row['observationErrors'].append({'code':'SCRATCH_OWNERSHIP_UNKNOWN_OR_LOST','type':type(exc).__name__})
            try:
                if row['captures']['stdout']['ownershipVerified']:
                    require(identity(area) == area_id and identity(paths['stdout']) == capture_ids['stdout'], 'TAP capture ownership lost')
                    tap = paths['stdout'].read_text()
                    row['counts'] = {key:int(re.search(r'^# ' + key + r' (\d+)$', tap, re.M).group(1))
                        for key in ['tests','pass','fail','cancelled','skipped','todo'] if re.search(r'^# ' + key + r' (\d+)$', tap, re.M)}
                sources(); regular(pathlib.Path(node), expected)
            except BaseException as exc:
                latch('POSTCHECK_FAILED', exc)
                row['observationErrors'].append({'code':'POSTCHECK_FAILED','type':type(exc).__name__})
        row['elapsedSeconds'] = time.monotonic() - started
        row['passed'] = row['firstProblem'] is None and not row['cleanupErrors'] and not row['observationErrors'] and row['returnCode'] == 0 and row['ownedScratchEmpty'] is True and all(c['complete'] for c in row['captures'].values()) and row['counts'] == {'tests':350,'pass':350,'fail':0,'cancelled':0,'skipped':0,'todo':0}
        if not row['passed']:
            latch('OFFLINE_GATE_FAILED_OR_INCOMPLETE')
            campaign_failure = {'runtime':label,'firstProblem':row['firstProblem'],'cleanupErrors':row['cleanupErrors']}
    if campaign_failure is not None: break
result = {'status':'OFFLINE_FAKE_PASS' if campaign_failure is None and len(results)==2 else 'OFFLINE_FAILED_OR_UNRESOLVED',
    'results':results,'failure':campaign_failure,'noAuthorityCompilerOrProductionEvaluation':True,
    'noDockerDatabaseProviderOrNetworkCall':True,'areaRetained':str(area),'resultWritten':False}
try:
    require(not area_lost and identity(area) == area_id, 'Area ownership lost; refusing result write')
    path = area / 'result.json'
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as handle:
        result['resultWritten'] = True; json.dump(result, handle, indent=2); handle.write('\n')
    print(json.dumps({'result':str(path),'sha256':digest(path),'status':result['status']}), flush=True)
except BaseException as exc:
    result['status'] = 'UNRESOLVED'; result['resultWritten'] = False
    result['resultWriteError'] = {'type':type(exc).__name__,'message':str(exc)[:2048]}
    print(json.dumps(result), flush=True)
if result['status'] != 'OFFLINE_FAKE_PASS': raise SystemExit(1)
PY_OFFLINE
```
