"""Exact revision-7 Claude review supervisor; default mode has no effects.

Owned-process identity/EOF patterns follow the historical claude-ruflo-review
operator, without importing its main, globals, profiles, receipts or parser.
Raw native output requires Root inspection; capture is never review approval.
"""
from dataclasses import asdict, dataclass
import hashlib
from datetime import datetime
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import time

ROOT = Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab')
QA = ROOT / 'output/qa/customer-pharmacy-lab-claude-review'
REV = QA / 'revision-7'
OWN = QA / 'operator'
AUTHOR = '/root'
FROZEN = '37db6d20ae109ec59ae962bac2f023d472165c28ce518c5c4c6ffcd6cf55a9e0'
PLAN = '762fe43794831a3f02b49b2b5ffd61f49796edaaa6f9f4957beea9a3c4c2c64b'
PUBLIC_OS_KEYS = ('USER', 'LOGNAME', 'SECURITYSESSIONID', '__CF_USER_TEXT_ENCODING')
MAX_STATE = 65536
CODES = frozenset('INPUT_REJECTED APPROVAL_REQUIRED APPROVAL_REJECTED SOURCE_DRIFT CLAIM_EXISTS OUTPUT_IDENTITY START_FAILED IDENTITY_UNKNOWN IDENTITY_CHANGED UNKNOWN_CHILD PROCESS_OBSERVATION PROCESS_OBSERVATION_TIMEOUT TIMEOUT STDOUT_LIMIT STDERR_LIMIT FRAME_LIMIT PARTIAL_FRAME PIPE_FAILURE INPUT_INCOMPLETE CHILD_EXIT CHILD_CHAIN_UNOBSERVED CLEANUP_UNRESOLVED INTERRUPTED INTERNAL_ERROR'.split())

class Stop(Exception):
    def __init__(self, code):
        self.code = code if code in CODES else 'INTERNAL_ERROR'
        super().__init__(self.code)

def need(ok, code='INPUT_REJECTED'):
    if not ok:
        raise Stop(code)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def regular(path, limit=2097152, private=False):
    path = Path(path)
    flags = os.O_RDONLY | os.O_NOFOLLOW
    fd = os.open(path, flags)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit)
        if private:
            need(before.st_uid == os.getuid() and stat.S_IMODE(before.st_mode) == 0o600)
        chunks, size = [], 0
        while size <= limit:
            chunk = os.read(fd, min(1048576, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        need(size <= limit)
        data = b''.join(chunks)
        after = os.fstat(fd)
        need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
             (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'SOURCE_DRIFT')
        need(path.stat(follow_symlinks=False).st_ino == before.st_ino, 'SOURCE_DRIFT')
        return data
    finally:
        os.close(fd)

def approval_check(receipt, expected):
    need(isinstance(receipt, dict) and set(receipt) == set(expected) | {'reviewers'}, 'APPROVAL_REJECTED')
    need(all(receipt[k] == v for k, v in expected.items()), 'APPROVAL_REJECTED')
    reviewers = receipt['reviewers']
    need(isinstance(reviewers, list) and len(reviewers) == 2, 'APPROVAL_REJECTED')
    need(all(isinstance(r, dict) and set(r) == {'agent', 'decision'} and
             isinstance(r['agent'], str) and r['agent'].startswith('/root/') and
             r['agent'] != AUTHOR and r['decision'] == 'APPROVE_ONE_EXACT_CURRENT_CLAUDE_REVIEW'
             for r in reviewers), 'APPROVAL_REJECTED')
    need(len({r['agent'] for r in reviewers}) == 2, 'APPROVAL_REJECTED')

def environment_check(environment, parent):
    """Only the reviewed seven keys; inspect no other parent values."""
    base = {'HOME': '/Users/shubham', 'PATH': '/usr/bin:/bin', 'TMPDIR': '/private/tmp'}
    need(isinstance(environment, dict) and set(environment) == set(base) | set(PUBLIC_OS_KEYS))
    need(all(environment[k] == v for k, v in base.items()))
    need(all(isinstance(environment[k], str) and environment[k] and
             environment[k] == parent.get(k) for k in PUBLIC_OS_KEYS))

def load():
    """No native process or provider is used in admission; missing receipt stops."""
    need((OWN / 'LIVE_APPROVAL_7.json').exists(), 'APPROVAL_REQUIRED')
    frozen = regular(REV / 'prepared-freeze.json')
    need(sha(frozen) == FROZEN, 'SOURCE_DRIFT')
    inputs = json.loads(frozen)['files']
    for name, digest in inputs.items():
        need('/' not in name and sha(regular(REV / name)) == digest, 'SOURCE_DRIFT')
    need(sha(regular(REV / 'OPERATOR_PLAN.md')) == PLAN, 'SOURCE_DRIFT')
    prior = json.loads(regular(REV / 'prior-seven.sha256.json'))
    for name, digest in prior.items():
        need('/' not in name and sha(regular(QA / name)) == digest, 'SOURCE_DRIFT')
    pre = json.loads(regular(OWN / 'PREIMPLEMENTATION_7.json'))
    need(pre['planSha256'] == PLAN and pre['preparedFreezeSha256'] == FROZEN and
         pre['rootAction'] == 'AUTHORIZE_COMPACT_SUPERVISOR_AND_OFFLINE_FAKE_CHECKS_ONLY')
    recipe_bytes = regular(REV / 'recipe.json')
    recipe = json.loads(recipe_bytes)
    environment_check(recipe['environmentCandidate'], os.environ)
    packet = regular(REV / 'packet.json')
    snapshot = json.loads(packet)
    need(sha(packet) == recipe['packetSha256'] and
         sha(regular(REV / 'manifest.json')) == recipe['manifestSha256'])
    need(recipe['requestedModel'] == 'claude-opus-5-5' and recipe['requestedEffort'] == 'xhigh' and
         recipe['timeoutSeconds'] == 3600 and recipe['maxTurns'] == 8 and
         recipe['clientKind'] == 'local-bundled-CLI' and not recipe['actualClaudeExtensionACK'])
    for item in snapshot['files']:
        for excerpt in item['excerpts']:
            need(sha(excerpt['content'].encode()) == excerpt['sha256'], 'SOURCE_DRIFT')
        if item['origin'] == 'git':
            relative = Path(item['path'])
            need(not relative.is_absolute() and '..' not in relative.parts)
            need(sha(regular(ROOT / relative)) == item['wholeFileSha256'], 'SOURCE_DRIFT')
    for path, digest in recipe['runtimePins'].items():
        need(sha(regular(path, limit=536870912)) == digest, 'SOURCE_DRIFT')
    challenge_bytes = regular(REV / 'challenge.json')
    challenge = json.loads(challenge_bytes)
    need(challenge['nonce'] not in packet.decode() and challenge['sessionId'] == recipe['sessionId'])
    expected = {'schema': 'SD-CURRENT-CLAUDE-LIVE-APPROVAL-7',
                'rootDecision': 'APPROVE_ONE_EXACT_CURRENT_CLAUDE_REVIEW',
                'supervisorSha256': sha(regular(OWN / 'supervisor.py')),
                'testsSha256': sha(regular(OWN / 'test_supervisor.py')),
                'preimplementationSha256': sha(regular(OWN / 'PREIMPLEMENTATION_7.json')),
                'preparedFreezeSha256': FROZEN, 'recipeSha256': sha(recipe_bytes),
                'challengeSha256': sha(challenge_bytes), 'sessionId': recipe['sessionId'],
                'packetSha256': recipe['packetSha256'],
                'ordinaryTrustedClientBoundaryAccepted': True,
                'challengeEnqueueAcknowledged': True,
                'existingMemberNamesVerified': True,
                'privateOutputGitExclusionsVerified': True,
                'argv': recipe['argvCandidate'], 'environment': recipe['environmentCandidate'],
                'cwd': recipe['cwd'], 'executable': recipe['executable'],
                'onceClaim': recipe['onceClaim'], 'privateOutputDirectory': recipe['privateOutputDirectory']}
    approval_bytes = regular(OWN / 'LIVE_APPROVAL_7.json', private=True)
    approval_check(json.loads(approval_bytes), expected)
    return {'recipe': recipe, 'packet': packet, 'approvalExpected': expected,
            'inputHashes': {str(REV / n): h for n, h in inputs.items()} |
                           {str(REV / 'prepared-freeze.json'): FROZEN} |
                           {str(OWN / 'supervisor.py'): expected['supervisorSha256'],
                            str(OWN / 'test_supervisor.py'): expected['testsSha256'],
                            str(OWN / 'PREIMPLEMENTATION_7.json'): expected['preimplementationSha256'],
                            str(OWN / 'LIVE_APPROVAL_7.json'): sha(approval_bytes)} |
                           {str(ROOT / f['path']): f['wholeFileSha256']
                            for f in snapshot['files'] if f['origin'] == 'git'} |
                           {str(QA / name): digest for name, digest in prior.items()}}

class PrivateFiles:
    """Exclusive once claim and held private output fds; never removes claims."""
    def __init__(self, recipe):
        self.recipe, self.directory, self.files = recipe, None, {}
        self.identities = {}
        self.claim_identity = None

    @staticmethod
    def identity(st):
        return st.st_dev, st.st_ino, st.st_uid, stat.S_IMODE(st.st_mode), st.st_nlink

    def reserve(self):
        r = self.recipe
        try:
            claim = os.open(r['onceClaim'], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            raise Stop('CLAIM_EXISTS') from None
        try:
            data = json.dumps({'sessionId': r['sessionId'], 'packetSha256': r['packetSha256'],
                               'claim': 'CONSUMED_BEFORE_CLIENT_ALLOCATION'}).encode()
            need(os.write(claim, data) == len(data), 'PIPE_FAILURE')
            os.fsync(claim)
            self.claim_identity = self.identity(os.fstat(claim))
        finally:
            os.close(claim)
        os.mkdir(r['privateOutputDirectory'], 0o700)
        self.directory = os.open(r['privateOutputDirectory'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.directory_identity = self.identity(os.fstat(self.directory))[:4]
        need(self.directory_identity[2:4] == (os.getuid(), 0o700), 'OUTPUT_IDENTITY')
        for name in ('transcript.stream-json', 'stderr.txt', 'state.json'):
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=self.directory)
            self.files[name] = fd
            self.identities[name] = self.identity(os.fstat(fd))
        self.check()

    def check(self):
        need(self.claim_identity == self.identity(os.stat(self.recipe['onceClaim'], follow_symlinks=False)), 'OUTPUT_IDENTITY')
        need(self.directory is not None and self.identity(os.fstat(self.directory))[:4] == self.directory_identity,
             'OUTPUT_IDENTITY')
        need(self.identity(os.stat(self.recipe['privateOutputDirectory'], follow_symlinks=False))[:4] ==
             self.directory_identity, 'OUTPUT_IDENTITY')
        for name, fd in self.files.items():
            need(self.identity(os.fstat(fd)) == self.identities[name] and
                 self.identity(os.stat(name, dir_fd=self.directory, follow_symlinks=False)) == self.identities[name] and
                 self.identities[name][2:] == (os.getuid(), 0o600, 1), 'OUTPUT_IDENTITY')

    def append(self, stream, data):
        self.check()
        fd = self.files['transcript.stream-json' if stream == 'stdout' else 'stderr.txt']
        while data:
            written = os.write(fd, data)
            need(written > 0, 'PIPE_FAILURE')
            data = data[written:]

    def finish(self, receipt):
        self.check()
        data = (json.dumps(receipt, sort_keys=True) + '\n').encode()
        need(len(data) <= MAX_STATE, 'OUTPUT_IDENTITY')
        fd = self.files['state.json']
        need(os.write(fd, data) == len(data), 'PIPE_FAILURE')
        for file_fd in self.files.values():
            os.fsync(file_fd)
        self.check()

    def close(self):
        for fd in self.files.values():
            os.close(fd)
        self.files.clear()
        if self.directory is not None:
            os.close(self.directory)
            self.directory = None

@dataclass(frozen=True)
class Identity:
    pid: int
    parent: int
    group: int
    started: str
    executable: str

class Native:
    """Effects exist only in explicit live main after fixed receipt admission."""
    now = staticmethod(time.monotonic)

    def command(self, argv, deadline):
        remaining = deadline - time.monotonic()
        budget = max(0, min(10, remaining))
        operation = ('IDENTITY' if argv[:2] == ['/bin/ps', '-p'] else
                     'FIXED_ARGUMENTS' if argv[:3] == ['/bin/ps', '-ww', '-p'] else
                     'DIRECT_CHILDREN' if argv[:2] == ['/usr/bin/pgrep', '-P'] else
                     'EXACT_GROUP' if argv[:2] == ['/usr/bin/pgrep', '-g'] else 'OTHER_FIXED_OPERATION')
        def retain_failure():
            if not hasattr(self, 'first_observation_failure'):
                self.first_observation_failure = {
                    'operation': operation, 'timeoutSeconds': budget,
                    'deadlineClassification': ('EXPIRED' if remaining <= 0 else
                                               'PHASE_REMAINDER' if remaining < 10 else 'PER_COMMAND_CAP')}
        if remaining <= 0:
            retain_failure()
            raise Stop('TIMEOUT')
        try:
            result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True,
                                    env={'PATH': '/usr/bin:/bin'}, timeout=budget, check=False)
        except subprocess.TimeoutExpired:
            retain_failure()
            raise Stop('PROCESS_OBSERVATION_TIMEOUT') from None
        need(len(result.stdout) <= 16384 and len(result.stderr) <= 16384, 'PROCESS_OBSERVATION')
        return result

    def identity(self, pid, deadline):
        r = self.command(['/bin/ps', '-p', str(pid), '-o', 'pid=,ppid=,pgid=,lstart=,comm='], deadline)
        if r.returncode == 1 and not r.stdout.strip():
            return None
        need(r.returncode == 0, 'PROCESS_OBSERVATION')
        parts = r.stdout.decode().strip().split(None, 8)
        need(len(parts) == 9 and int(parts[0]) == pid, 'IDENTITY_UNKNOWN')
        return Identity(pid, int(parts[1]), int(parts[2]), ' '.join(parts[3:8]), parts[8])

    def children(self, pid, deadline):
        r = self.command(['/usr/bin/pgrep', '-P', str(pid)], deadline)
        need(r.returncode in (0, 1), 'PROCESS_OBSERVATION')
        rows = r.stdout.decode().split()
        if hasattr(self, 'observer_diagnostic'):
            self.observer_diagnostic['candidateCount'] = len(rows)
        need(len(rows) <= 8 and all(v.isdecimal() for v in rows), 'UNKNOWN_CHILD')
        return [int(v) for v in rows]

    def observe(self, process, recipe, captured, deadline):
        self.observer_diagnostic = {'stage': 'cli', 'candidateCount': 0, 'matchCount': 0, 'children': []}
        cli = self.identity(process.pid, deadline)
        if cli is None:
            need(process.poll() is not None, 'IDENTITY_UNKNOWN')
            return
        need(cli.parent == os.getpid() and cli.group == process.pid and
             cli.executable in (recipe['executable'], Path(recipe['executable']).name), 'IDENTITY_UNKNOWN')
        need(captured['cli'] in (None, cli), 'IDENTITY_CHANGED')
        captured['cli'] = cli
        node, adapter, ruflo = list(recipe['runtimePins'])[1:4]
        parent = cli
        for kind, argv in [('adapter', [node, adapter]),
                           ('ruflo', [node, ruflo, 'mcp', 'start', '--transport', 'stdio'])]:
            diagnostic = {'stage': kind, 'candidateCount': 0, 'matchCount': 0, 'children': []}
            self.observer_diagnostic = diagnostic
            previous = captured[kind]
            if previous is not None:
                current = self.identity(previous.pid, deadline)
                need(current is None or current == previous, 'IDENTITY_CHANGED')
            pids = self.children(parent.pid, deadline)
            diagnostic['candidateCount'] = len(pids)
            need(len(pids) <= 8, 'UNKNOWN_CHILD')
            matches = []
            for pid in pids:
                child = self.identity(pid, deadline)
                if child is None:
                    diagnostic['children'].append({'pid': pid, 'classification': 'VANISHED'})
                    continue
                is_node = child.executable in (node, Path(node).name)
                item = {'pid': child.pid, 'parent': child.parent, 'group': child.group,
                        'started': child.started, 'classification': 'PINNED_NODE' if is_node else 'UNRELATED_EXECUTABLE'}
                diagnostic['children'].append(item)
                if not is_node or child.parent != parent.pid or child.group != cli.group:
                    continue
                if datetime.strptime(child.started, '%a %b %d %H:%M:%S %Y') < datetime.strptime(parent.started, '%a %b %d %H:%M:%S %Y'):
                    item['classification'] = 'STALE_START'
                    continue
                # Only candidate pinned Node children get an in-memory fixed
                # argv comparison. No unknown argv is retained or published.
                before = self.identity(pid, deadline)
                if before is None:
                    item['classification'] = 'VANISHED'
                    continue
                need(before == child, 'IDENTITY_CHANGED')
                result = self.command(['/bin/ps', '-ww', '-p', str(pid), '-o', 'args='], deadline)
                after = self.identity(pid, deadline)
                if after is None:
                    item['classification'] = 'VANISHED'
                    continue
                need(after == child, 'IDENTITY_CHANGED')
                if result.returncode != 0 or result.stdout.decode().strip() != ' '.join(argv):
                    item['classification'] = 'OTHER_NODE_VECTOR'
                    continue
                item['classification'] = 'EXACT_MATCH'
                matches.append(child)
                diagnostic['matchCount'] = len(matches)
            need(len(matches) <= 1, 'UNKNOWN_CHILD')
            if not matches:
                return  # Await the pinned chain; unrelated siblings are not adopted.
            child = matches[0]
            need(captured[kind] in (None, child), 'IDENTITY_CHANGED')
            captured[kind] = child
            parent = child

    @staticmethod
    def start(bundle):
        r = bundle['recipe']
        return subprocess.Popen([r['executable'], *r['argvCandidate']], cwd=r['cwd'],
                                env=r['environmentCandidate'], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False,
                                close_fds=True, start_new_session=True)

    @staticmethod
    def setup(process):
        selector = selectors.DefaultSelector()
        try:
            for name in ('stdin', 'stdout', 'stderr'):
                stream = getattr(process, name)
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_WRITE if name == 'stdin' else selectors.EVENT_READ, name)
            return selector
        except BaseException:
            selector.close()
            raise

    @staticmethod
    def events(selector, timeout):
        return [key.data for key, _ in selector.select(timeout)]

    @staticmethod
    def remove(selector, process, name):
        stream = getattr(process, name)
        try:
            selector.unregister(stream)
        except KeyError:
            pass
        stream.close()

    @staticmethod
    def close_input(process):
        if process.stdin and not process.stdin.closed:
            process.stdin.close()

    @staticmethod
    def read(process, name, size):
        return os.read(getattr(process, name).fileno(), size)

    @staticmethod
    def write(process, data):
        return os.write(process.stdin.fileno(), data)

    def absent(self, identity, deadline):
        current = self.identity(identity.pid, deadline)
        need(current is None or current == identity, 'IDENTITY_CHANGED')
        return current is None

    def group_empty(self, process, deadline):
        r = self.command(['/usr/bin/pgrep', '-g', str(process.pid)], deadline)
        need(r.returncode in (0, 1), 'PROCESS_OBSERVATION')
        return r.returncode == 1 and not r.stdout.strip()

    def signal_owned(self, process, kind, identity, sig, deadline):
        if identity is not None:
            need(self.identity(identity.pid, deadline) == identity, 'IDENTITY_CHANGED')
        if kind == 'cli':
            # Popen checks/reaps its own child before signaling; this remains a
            # held child handle even when the first OS observation failed.
            if process.poll() is None:
                process.send_signal(sig)
        else:
            need(identity is not None and identity.group == process.pid, 'IDENTITY_UNKNOWN')
            os.kill(identity.pid, sig)

    @staticmethod
    def revalidate(bundle):
        for path, digest in bundle['inputHashes'].items():
            need(sha(regular(path)) == digest, 'SOURCE_DRIFT')
        for path, digest in bundle['recipe']['runtimePins'].items():
            need(sha(regular(path, limit=536870912)) == digest, 'SOURCE_DRIFT')

class Pump:
    def __init__(self, bundle, ports, process, sink, selector):
        self.ports, self.process, self.sink, self.selector = ports, process, sink, selector
        self.payload, self.bounds = bundle['packet'], bundle['recipe']['bounds']
        self.offset, self.counts, self.open = 0, {'stdout': 0, 'stderr': 0}, {'stdin', 'stdout', 'stderr'}
        self.frame = 0

    def input_close(self):
        if 'stdin' in self.open:
            self.ports.remove(self.selector, self.process, 'stdin')
            self.open.remove('stdin')

    def step(self, write=True):
        for name in self.ports.events(self.selector, 0.05):
            if name not in self.open:
                continue
            try:
                if name == 'stdin':
                    if not write:
                        self.input_close()
                        continue
                    written = self.ports.write(self.process, self.payload[self.offset:self.offset + 65536])
                    need(0 < written <= len(self.payload) - self.offset, 'PIPE_FAILURE')
                    self.offset += written
                    if self.offset == len(self.payload):
                        self.input_close()
                else:
                    chunk = self.ports.read(self.process, name, 65536)
                    if not chunk:
                        self.ports.remove(self.selector, self.process, name)
                        self.open.remove(name)
                        if name == 'stdout':
                            need(self.frame == 0, 'PARTIAL_FRAME')
                        continue
                    maximum = self.bounds[name + 'Bytes']
                    remaining = max(0, maximum - self.counts[name])
                    self.sink.append(name, chunk[:remaining])
                    self.counts[name] += len(chunk)
                    need(self.counts[name] <= maximum, name.upper() + '_LIMIT')
                    if name == 'stdout':
                        pieces = chunk.split(b'\n')
                        for index, part in enumerate(pieces):
                            self.frame += len(part)
                            need(self.frame <= self.bounds['frameBytes'], 'FRAME_LIMIT')
                            if index < len(pieces) - 1:
                                self.frame = 0
            except BlockingIOError:
                continue


def run(bundle, ports, sink):
    """One explicit process port; fake tests cannot fall through to Native."""
    r = bundle['recipe']
    process = selector = pump = None
    captured = {'cli': None, 'adapter': None, 'ruflo': None}
    first, cleanup_errors, signals = None, [], []
    absent = {k: False for k in captured}
    group_empty, exit_code = False, None
    def failure(error):
        nonlocal first
        code = error.code if isinstance(error, Stop) else 'INTERNAL_ERROR'
        first = first or code
    def cleanup_error(error):
        code = error.code if isinstance(error, Stop) else 'INTERNAL_ERROR'
        if code not in cleanup_errors:
            cleanup_errors.append(code)
        failure(error)
    def drain():
        if pump:
            try:
                pump.step(write=False)
            except (Exception, KeyboardInterrupt) as error:
                cleanup_error(error)
    started = ports.now()
    try:
        sink.reserve()
        ports.revalidate(bundle)
        sink.check()
        process = ports.start(bundle)  # retained before any fallible observation
        ports.observe(process, r, captured, started + r['timeoutSeconds'])
        selector = ports.setup(process)
        pump = Pump(bundle, ports, process, sink, selector)
        next_observation = ports.now()
        while True:
            now = ports.now()
            need(now < started + r['timeoutSeconds'], 'TIMEOUT')
            if now >= next_observation:
                ports.observe(process, r, captured, started + r['timeoutSeconds'])
                next_observation = ports.now() + 1
            pump.step()
            exit_code = process.poll()
            if exit_code is not None and not pump.open:
                break
        need(pump.offset == len(bundle['packet']), 'INPUT_INCOMPLETE')
        need(exit_code == 0, 'CHILD_EXIT')
        need(all(captured.values()), 'CHILD_CHAIN_UNOBSERVED')
        ports.revalidate(bundle)
    except (Exception, KeyboardInterrupt) as error:
        failure(Stop('INTERRUPTED') if isinstance(error, KeyboardInterrupt) else error)
    finally:
        if process is not None:
            unsafe = set()
            def alive(kind, identity, deadline):
                if kind in unsafe:
                    return False
                try:
                    if kind == 'cli' and identity is None:
                        return process.poll() is None
                    return identity is not None and not ports.absent(identity, deadline)
                except Exception as error:
                    if isinstance(error, Stop) and error.code == 'IDENTITY_CHANGED':
                        unsafe.add(kind)
                    cleanup_error(error)
                    return None
            try:
                if pump:
                    pump.input_close()
                else:
                    ports.close_input(process)
            except Exception as error:
                cleanup_error(error)
            end = ports.now() + r['bounds']['eofGraceSeconds']
            while ports.now() < end:
                drain()
                if ports.now() >= end:
                    break
                live = [k for k, identity in captured.items() if alive(k, identity, end)]
                if process.poll() is not None and not live:
                    break
                if not pump:
                    ports.pause(0.05)
            for kind in ('cli', 'adapter', 'ruflo'):
                identity = captured[kind]
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    end = ports.now() + 2
                    observed_alive = alive(kind, identity, end)
                    if observed_alive is False:
                        break
                    if observed_alive is None:
                        continue  # Next existing phase has its own fresh budget.
                    try:
                        ports.signal_owned(process, kind, identity, sig, end)
                        signals.append({'kind': kind, 'signal': int(sig)})
                    except Exception as error:
                        if isinstance(error, Stop) and error.code == 'IDENTITY_CHANGED':
                            unsafe.add(kind)
                        cleanup_error(error)
                        continue
                    while ports.now() < end:
                        drain()
                        if ports.now() >= end:
                            break
                        if not alive(kind, identity, end):
                            break
                        if not pump:
                            ports.pause(0.05)
            end = ports.now() + 8
            exit_code = process.poll()
            for kind, identity in captured.items():
                try:
                    absent[kind] = identity is not None and ports.absent(identity, end)
                except Exception as error:
                    cleanup_error(error)
            try:
                group_empty = ports.group_empty(process, end)
            except Exception as error:
                cleanup_error(error)
        if selector is not None:
            try:
                selector.close()
            except Exception:
                cleanup_errors.append('PIPE_FAILURE')
        if process is not None:
            for stream in (process.stdin, process.stdout, process.stderr):
                try:
                    if stream:
                        stream.close()
                except Exception:
                    cleanup_errors.append('PIPE_FAILURE')
    clean = process is not None and all(absent.values()) and group_empty and not cleanup_errors and not signals and exit_code == 0
    if process is not None and not clean:
        first = first or 'CLEANUP_UNRESOLVED'
    receipt = {'schema': 'SD-CURRENT-CLAUDE-CAPTURE-1', 'firstFailure': first,
               'status': 'CAPTURED_PENDING_ROOT_STREAM_REVIEW' if first is None and clean else 'FAILED_OR_UNRESOLVED',
               'requestedModel': 'claude-opus-5-5', 'requestedEffort': 'xhigh',
               'effectiveModel': 'UNOBSERVED_PENDING_ROOT_INSPECTION', 'effectiveEffort': 'UNPROVEN',
               'actualClaudeExtensionACK': False, 'reviewAccepted': False,
               'sessionId': r['sessionId'], 'packetSha256': r['packetSha256'],
               'processStarted': process is not None, 'exitCode': exit_code,
               'inputBytesWritten': pump.offset if pump else 0,
               'outputBytes': pump.counts if pump else {'stdout': 0, 'stderr': 0},
               'identities': {k: asdict(v) if v else None for k, v in captured.items()},
               'observerDiagnostic': getattr(ports, 'observer_diagnostic', {}),
               'firstObservationFailure': getattr(ports, 'first_observation_failure', None),
               'absent': absent, 'groupEmpty': group_empty, 'signals': signals,
               'cleanupErrors': cleanup_errors, 'elapsedSeconds': round(ports.now() - started, 3)}
    try:
        sink.finish(receipt)
    except Exception as error:
        receipt['firstFailure'] = receipt['firstFailure'] or (error.code if isinstance(error, Stop) else 'OUTPUT_IDENTITY')
        receipt['status'] = 'FAILED_OR_UNRESOLVED'
    finally:
        try:
            sink.close()
        except Exception:
            receipt['firstFailure'] = receipt['firstFailure'] or 'OUTPUT_IDENTITY'
            receipt['status'] = 'FAILED_OR_UNRESOLVED'
    return receipt

# Binding sleep through the explicit native port keeps fake checks sleep-free.
Native.pause = staticmethod(time.sleep)

def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv != ['--live']:
        return {'status': 'NO_LIVE_START', 'reason': 'EXACT_LIVE_APPROVAL_REQUIRED', 'processStarted': False}
    try:
        bundle = load()
        def interrupted(_signal, _frame):
            raise Stop('INTERRUPTED')
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, interrupted)
        receipt = run(bundle, Native(), PrivateFiles(bundle['recipe']))
        return {k: receipt[k] for k in ('status', 'firstFailure', 'processStarted', 'effectiveEffort', 'reviewAccepted')}
    except (Exception, KeyboardInterrupt) as error:
        return {'status': 'NO_SUCCESS', 'firstFailure': error.code if isinstance(error, Stop) else 'INTERNAL_ERROR',
                'reviewAccepted': False}

if __name__ == '__main__':
    result = main()
    print(json.dumps(result, sort_keys=True))
    sys.exit(0 if result['status'] == 'CAPTURED_PENDING_ROOT_STREAM_REVIEW' else 1)
