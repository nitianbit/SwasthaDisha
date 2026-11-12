"""Inert preparation: run only after two exact nonauthor votes and Root receipt.

No selectors, environment overrides, command-line options, retries or resource deletion.
The manifest deliberately has no self-hash or future commit; the private receipt binds
both final byte hashes to the subsequently committed clean HEAD.
"""
import errno
import hashlib
import json
import os
import pathlib
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = pathlib.Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/authority-pure-runtime')
QA = ROOT / 'output/qa/authority-pure-runtime'
OPERATOR = QA / 'REAL_OPERATOR.py'
MANIFEST = QA / 'REAL_RUN_MANIFEST.json'
APPROVAL = QA / '.REAL_APPROVAL.json'
ONCE = QA / '.REAL_ONCE.json'
AUTHOR = '/root/authority_operator'
SCOPE = 'ONE_FIXED_AUTHORITY_PURE_RUN'
NODE = '/Users/shubham/.nvm/versions/node/v24.19.0/bin/node'
PYTHON = '/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/bin/python3.14'
DOCKER = '/Applications/Docker.app/Contents/Resources/bin/docker'
ALIAS = pathlib.Path('/usr/local/bin/docker')
SOCKET = pathlib.Path('/Users/shubham/.docker/run/docker.sock')
GIT = '/Library/Developer/CommandLineTools/usr/bin/git'
ENDPOINT = 'unix://' + str(SOCKET)
ENGINE = '16ab25f6-88c7-4687-a431-b119b6ab9319'
IMAGE = 'node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d'
ROLE = 'business-staff-authority-pure'
LAUNCH = [NODE, 'test/application/run-authority.mjs', ENDPOINT]
INFO = ['info', '--format', '[{{json .ID}},{{json .OSType}}]']
LABELS = ['ps', '--all', '--filter', 'label=swasthadisha.test.purpose=app-isolation', '--quiet', '--no-trunc']
HEX = r'[a-f0-9]{64}'
UUID = r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
GIT_ENV = {'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def closed(value, keys):
    return type(value) is dict and set(value) == set(keys)


def exact(value, expected):
    if type(value) is not type(expected):
        return False
    if type(value) is dict:
        return set(value) == set(expected) and all(exact(value[k], expected[k]) for k in value)
    if type(value) is list:
        return len(value) == len(expected) and all(exact(v, e) for v, e in zip(value, expected))
    return value == expected


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load(data):
    # Duplicate keys and non-JSON numbers cannot hide a contradictory receipt.
    def pairs(rows):
        result = {}
        for key, value in rows:
            require(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs,
                      parse_constant=lambda value: require(False, 'Nonfinite JSON number'))


def ident(path):
    s = path.lstat()
    return (s.st_dev, s.st_ino, s.st_uid, s.st_gid, s.st_mode,
            0 if stat.S_ISDIR(s.st_mode) else s.st_nlink)


def read_regular(path, expected=None, private=False):
    path = pathlib.Path(path)
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'Regular single-link input required: ' + str(path))
    if private:
        require(before.st_uid == 501 and stat.S_IMODE(before.st_mode) == 0o600, 'Private Root receipt required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        require((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino), 'Input replaced during open')
        chunks = []
        while block := os.read(fd, 65536):
            chunks.append(block)
        data = b''.join(chunks)
        after = os.fstat(fd)
        require((opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) ==
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns) and ident(path) ==
                (opened.st_dev, opened.st_ino, opened.st_uid, opened.st_gid, opened.st_mode, opened.st_nlink), 'Input changed during read')
    finally:
        os.close(fd)
    if expected is not None:
        actual = {'sha256': digest(data), 'bytes': len(data), 'kind': 'regular',
                  'uid': before.st_uid, 'gid': before.st_gid, 'mode': oct(stat.S_IMODE(before.st_mode)), 'nlink': before.st_nlink}
        require(actual == expected, 'Pinned input changed: ' + str(path))
    return data


def write_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        require(os.write(fd, data) == len(data), 'Incomplete exclusive file write')
        os.fsync(fd)
    finally:
        os.close(fd)
    return ident(path)


def encoded(value):
    return (json.dumps(value, indent=2, allow_nan=False) + '\n').encode()


def validate_receipt():
    require(sys.argv == [str(OPERATOR)] and pathlib.Path(sys.executable).resolve() == pathlib.Path(PYTHON), 'Fixed Python invocation only')
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode, 'Use env -i pinned Python -I -S -B')
    require(not os.environ, 'Empty parent environment required')
    raw = read_regular(APPROVAL, private=True)
    approval = load(raw)
    require(closed(approval, ['schema', 'scope', 'issuer', 'operatorAuthor', 'sourceAuthor', 'cwd', 'branch', 'approvedHead',
                             'operatorSha256', 'manifestSha256', 'sourceFreezeSha256', 'offlineResultSha256', 'votes']), 'Closed receipt schema required')
    require(approval['schema'] == 'SD-AUTHORITY-REAL-APPROVAL-1' and approval['scope'] == SCOPE and approval['issuer'] == '/root'
            and approval['operatorAuthor'] == AUTHOR and approval['sourceAuthor'] == '/root/claude_review_5_packet'
            and approval['cwd'] == str(ROOT) and approval['branch'] == 'm0/authority-pure-runtime'
            and re.fullmatch(r'[a-f0-9]{40}', approval['approvedHead']), 'Receipt fixed binding rejected')
    for key in ['operatorSha256', 'manifestSha256', 'sourceFreezeSha256', 'offlineResultSha256']:
        require(type(approval[key]) is str and re.fullmatch(HEX, approval[key]), 'Receipt hash malformed')
    require(digest(read_regular(OPERATOR)) == approval['operatorSha256'], 'Operator hash not approved')
    manifest_raw = read_regular(MANIFEST)
    require(digest(manifest_raw) == approval['manifestSha256'], 'Manifest hash not approved')
    manifest = load(manifest_raw)
    require(approval['sourceFreezeSha256'] == manifest['sourceFreezeSha256'] == '7df6a0ba88c5cf1e19cb79fdbcfe3cf1e4ec67175d6f4b0102b817c868d554dc'
            and approval['offlineResultSha256'] == manifest['offlineResultSha256'] == 'dfa34ddafc26100da6a82c07a0e48a1010d202e5d8c188cd49831d20a8e112cc', 'Source/offline binding rejected')
    require(type(approval['votes']) is list and len(approval['votes']) == 2, 'Two actual votes required')
    reviewers = set()
    for vote in approval['votes']:
        require(closed(vote, ['reviewer', 'role', 'decision', 'scope', 'approvedHead', 'operatorSha256', 'manifestSha256',
                             'sourceFreezeSha256', 'offlineResultSha256', 'findings']), 'Closed vote schema required')
        require(type(vote['reviewer']) is str and re.fullmatch(r'/root(?:/[a-z0-9_]+)*', vote['reviewer'])
                and vote['reviewer'] not in [AUTHOR, approval['sourceAuthor']] and vote['reviewer'] not in reviewers,
                'Distinct actual nonauthors required')
        reviewers.add(vote['reviewer'])
        require(vote['decision'] == 'APPROVE_SOURCE_AND_ONE_FIXED_AUTHORITY_PURE_RUN' and vote['findings'] == [], 'Unconditional exact vote required')
        for key in ['scope', 'approvedHead', 'operatorSha256', 'manifestSha256', 'sourceFreezeSha256', 'offlineResultSha256']:
            require(vote[key] == approval[key], 'Vote does not bind this exact candidate')
    require({v['role'] for v in approval['votes']} == {'Standards', 'Spec'}, 'Standards and Spec required')
    return approval, raw, manifest


class Capture:
    """Only the fixed sequence below calls this bounded stream recorder."""
    def __init__(self, approval, approval_raw, manifest):
        self.approval, self.approval_raw, self.manifest = approval, approval_raw, manifest
        self.area = pathlib.Path(tempfile.mkdtemp(prefix='sd-authority-real-', dir='/private/tmp'))
        os.chmod(self.area, 0o700)
        self.area_id = ident(self.area)
        self.files = {}
        self.marker = encoded({'runId': str(uuid.uuid4()), 'approvedHead': approval['approvedHead']})
        self.new('.operator-owner.json', self.marker)
        self.config = self.area / 'docker'
        self.config.mkdir(mode=0o700)
        self.config_id = ident(self.config)
        self.config_bytes = b'{"auths":{}}\n'
        self.config_file_id = write_new(self.config / 'config.json', self.config_bytes)
        self.report = {'status': 'IN_PROGRESS', 'approvedHead': approval['approvedHead'], 'operatorSha256': approval['operatorSha256'],
                       'manifestSha256': approval['manifestSha256'], 'areaRetained': str(self.area), 'launcherInvocations': 0,
                       'overallClaimConsumed': False, 'commands': [], 'firstProblem': None, 'secondaryProblems': [],
                       'cleanupErrors': [], 'resources': None, 'postchecks': {}, 'resultWritten': False}
        self.new('result.json', encoded(self.report))

    def new(self, name, data):
        require(ident(self.area) == self.area_id, 'Capture area lost before allocation')
        self.files[name] = write_new(self.area / name, data)

    def owned(self):
        require(ident(self.area) == self.area_id and ident(self.config) == self.config_id, 'Capture/config directory ownership lost')
        require(ident(self.area / '.operator-owner.json') == self.files['.operator-owner.json']
                and read_regular(self.area / '.operator-owner.json', private=True) == self.marker, 'Capture marker changed')
        require(ident(self.config / 'config.json') == self.config_file_id
                and read_regular(self.config / 'config.json', private=True) == self.config_bytes, 'Blank config changed')

    def save(self):
        self.owned()
        path = self.area / 'result.json'
        require(ident(path) == self.files['result.json'], 'Result identity lost')
        fd = os.open(path, os.O_WRONLY | os.O_NOFOLLOW)
        try:
            require(tuple([os.fstat(fd).st_dev, os.fstat(fd).st_ino]) == self.files['result.json'][:2], 'Result replaced during open')
            data = encoded(self.report)
            os.ftruncate(fd, 0)
            require(os.write(fd, data) == len(data), 'Result write incomplete')
            os.fsync(fd)
        finally:
            os.close(fd)

    def freeze(self):
        self.owned()
        require(read_regular(APPROVAL, private=True) == self.approval_raw, 'Private receipt changed')
        require(digest(read_regular(OPERATOR)) == self.approval['operatorSha256']
                and digest(read_regular(MANIFEST)) == self.approval['manifestSha256'], 'Operator/manifest drift')
        for name, expected in self.manifest['files'].items():
            read_regular(ROOT / name, expected)
        for path, expected in self.manifest['tools'].items():
            read_regular(path, expected)
        require(ident(ALIAS) == tuple(self.manifest['dockerAlias']['identity']) and ALIAS.is_symlink()
                and os.readlink(ALIAS) == DOCKER and ALIAS.lstat().st_uid == 0, 'Docker alias drift')
        require(ident(SOCKET) == tuple(self.manifest['socket']['identity']) and stat.S_ISSOCK(SOCKET.lstat().st_mode), 'Socket identity drift')

    def command(self, label, argv, env, cwd, seconds=20, caps=None, nonzero_ok=False, launcher=False):
        # Early attempted row survives capture allocation, Popen and every finalization failure.
        caps = {'stdout': 8192, 'stderr': 8192} if caps is None else caps
        row = {'label': label, 'argv': argv, 'env': env, 'cwd': str(cwd), 'attempted': True, 'processStarted': False,
               'pid': None, 'returnCode': None, 'executionLimitSeconds': seconds, 'cleanupLimitSeconds': 5,
               'firstProblem': None, 'secondaryProblems': [], 'cleanupErrors': [], 'captures': {
                   stream: {'path': str(self.area / (label + '.' + stream)), 'allocated': False, 'identity': None,
                            'observedBytesAtLeast': 0, 'retainedBytes': 0, 'limit': cap, 'eof': False, 'complete': False,
                            'ownershipVerified': False, 'sha256': None} for stream, cap in caps.items()}}
        self.report['commands'].append(row)
        proc = selector = None
        handles = {}
        cleanup_deadline = None
        killed = False
        stderr_pending = bytearray()
        def problem(code, exc=None):
            value = {'code': code, 'type': None if exc is None else type(exc).__name__, 'message': None if exc is None else str(exc)[:2048]}
            if row['firstProblem'] is None:
                row['firstProblem'] = value
            else:
                row['secondaryProblems'].append(value)
        def terminate():
            nonlocal killed
            if proc is not None and proc.poll() is None and not killed:
                require(os.getpgid(proc.pid) == proc.pid, 'Owned new process group lost')
                os.killpg(proc.pid, signal.SIGKILL)
                killed = True
        try:
            self.save()
            self.owned()
            for stream, capture in row['captures'].items():
                name = label + '.' + stream
                self.new(name, b'')
                capture['allocated'] = True
                capture['identity'] = self.files[name]
                fd = os.open(self.area / name, os.O_WRONLY | os.O_NOFOLLOW)
                handles[stream] = fd
                require(ident(self.area / name) == self.files[name] and (os.fstat(fd).st_dev, os.fstat(fd).st_ino) == self.files[name][:2], 'Capture replaced before open')
            self.save()
            if launcher:
                # All preparation is complete; consuming before the sole Node host Popen is deliberate.
                require(self.report['launcherInvocations'] == 0, 'Launcher already attempted')
                self.report['launcherInvocations'] = 1
                self.save()
            proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            row['processStarted'] = True
            row['pid'] = proc.pid
            self.save()
            selector = selectors.DefaultSelector()
            selector.register(proc.stdout, selectors.EVENT_READ, 'stdout')
            selector.register(proc.stderr, selectors.EVENT_READ, 'stderr')
            deadline = time.monotonic() + seconds
            while selector.get_map():
                if row['firstProblem'] is None and time.monotonic() >= deadline:
                    problem('EXECUTION_TIMEOUT')
                if row['firstProblem'] is not None and cleanup_deadline is None:
                    cleanup_deadline = time.monotonic() + 5
                if cleanup_deadline is not None:
                    terminate()
                    require(time.monotonic() < cleanup_deadline, 'Finite pipe cleanup expired')
                for key, _ in selector.select(0.05):
                    block = os.read(key.fd, 4096)
                    capture = row['captures'][key.data]
                    if not block:
                        capture['eof'] = True
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    capture['observedBytesAtLeast'] += len(block)
                    prefix = block[:max(0, capture['limit'] - capture['retainedBytes'])]
                    if capture['observedBytesAtLeast'] > capture['limit']:
                        problem(key.data.upper() + '_OVERFLOW') if row['firstProblem'] is None else None
                    if prefix:
                        self.owned()
                        name = label + '.' + key.data
                        require(ident(self.area / name) == self.files[name], 'Capture ownership changed before write')
                        n = os.write(handles[key.data], prefix)
                        capture['retainedBytes'] += n
                        require(n == len(prefix), 'Capture write incomplete')
                        if launcher and key.data == 'stderr':
                            stderr_pending.extend(prefix)
                            while b'\n' in stderr_pending:
                                line, _, rest = stderr_pending.partition(b'\n')
                                stderr_pending[:] = rest
                                try:
                                    early = load(line)
                                except (ValueError, RuntimeError):
                                    continue
                                if type(early) is dict and early.get('phase') == 'created':
                                    resource = resource_identity(line.decode('utf-8', errors='strict'))
                                    if self.report['resources'] is not None:
                                        self.report['resourceIdentityUnresolved'] = True
                                    require(self.report['resources'] is None, 'Contradictory/duplicate early identity')
                                    self.report['resources'] = resource
                                    self.save()
            # A child may close pipes before exiting. It still gets only its original execution deadline.
            if cleanup_deadline is None:
                try:
                    row['returnCode'] = proc.wait(timeout=max(0, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    problem('EXECUTION_TIMEOUT')
                    cleanup_deadline = time.monotonic() + 5
                    terminate()
            if row['returnCode'] is None:
                row['returnCode'] = proc.wait(timeout=max(0, cleanup_deadline - time.monotonic()))
            if row['returnCode'] != 0 and not nonzero_ok:
                problem('COMMAND_NONZERO_EXIT')
        except BaseException as exc:
            problem('COMMAND_EXCEPTION', exc)
        finally:
            if cleanup_deadline is None:
                cleanup_deadline = time.monotonic() + 5
            if proc is not None:
                try:
                    terminate()
                    row['returnCode'] = proc.wait(timeout=max(0, cleanup_deadline - time.monotonic()))
                except BaseException as exc:
                    row['cleanupErrors'].append({'code': 'PROCESS_CLEANUP_FAILED', 'type': type(exc).__name__, 'message': str(exc)[:2048]})
                for pipe in [proc.stdout, proc.stderr]:
                    try:
                        pipe.close()
                    except BaseException as exc:
                        row['cleanupErrors'].append({'code': 'PIPE_CLOSE_FAILED', 'type': type(exc).__name__})
            if selector is not None:
                try:
                    selector.close()
                except BaseException as exc:
                    row['cleanupErrors'].append({'code': 'SELECTOR_CLOSE_FAILED', 'type': type(exc).__name__})
            for fd in handles.values():
                try:
                    os.close(fd)
                except BaseException as exc:
                    row['cleanupErrors'].append({'code': 'CAPTURE_CLOSE_FAILED', 'type': type(exc).__name__})
            try:
                self.owned()
                for stream, capture in row['captures'].items():
                    if not capture['allocated']:
                        continue
                    name = label + '.' + stream
                    require(ident(self.area / name) == self.files[name], 'Capture identity lost; refusing read')
                    data = read_regular(self.area / name, private=True)
                    require(len(data) == capture['retainedBytes'] <= capture['limit'], 'Capture size changed')
                    capture['ownershipVerified'] = True
                    capture['sha256'] = digest(data)
                    capture['complete'] = capture['eof'] and capture['observedBytesAtLeast'] == len(data) and row['firstProblem'] is None and not row['cleanupErrors']
                self.save()
            except BaseException as exc:
                problem('OWNERSHIP_OR_FINALIZATION_UNRESOLVED', exc)
        return row

    def text(self, row, stream, partial=False):
        self.owned()
        capture = row['captures'][stream]
        require(capture['ownershipVerified'] and ident(pathlib.Path(capture['path'])) == tuple(capture['identity']), 'Unsafe capture read denied')
        data = read_regular(capture['path'], private=True)
        require(digest(data) == capture['sha256'], 'Capture changed after finalization')
        return data.decode('utf-8', errors='replace' if partial else 'strict')

    def complete(self, row):
        require(row['firstProblem'] is None and not row['cleanupErrors'] and all(c['complete'] for c in row['captures'].values()), 'Command evidence incomplete: ' + row['label'])

    def git_clean(self, phase):
        fixed = [([GIT, 'rev-parse', '--verify', 'HEAD'], self.approval['approvedHead'] + '\n'),
                 ([GIT, 'symbolic-ref', '--short', 'HEAD'], 'm0/authority-pure-runtime\n'),
                 ([GIT, '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
                   'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], '')]
        for index, (argv, expected) in enumerate(fixed):
            row = self.command(phase + '-git-' + str(index), argv, GIT_ENV, ROOT)
            self.complete(row)
            require(self.text(row, 'stdout') == expected, 'Exact clean committed candidate required')

    def docker(self, label, args, nonzero_ok=False):
        self.freeze()
        return self.command(label, [DOCKER, '--config', str(self.config), '--host', ENDPOINT] + args,
                            {'PATH': '/usr/local/bin:/usr/bin:/bin'}, self.area, nonzero_ok=nonzero_ok)

    def engine(self, label):
        row = self.docker(label, INFO)
        self.complete(row)
        require(load(self.text(row, 'stdout')) == [ENGINE, 'linux'], 'Same approved Linux engine required')

    def labels(self, label):
        row = self.docker(label, LABELS)
        self.complete(row)
        require(self.text(row, 'stdout').strip() == '', 'Existing purpose labels; no adoption or mutation')


def resource_identity(stderr):
    rows = []
    for line in stderr.splitlines():
        try:
            value = load(line)
        except (ValueError, RuntimeError):
            continue
        if type(value) is dict and value.get('phase') == 'created':
            require(closed(value, ['phase', 'id', 'runId', 'directory']) and re.fullmatch(HEX, value['id'])
                    and re.fullmatch(UUID, value['runId']) and re.fullmatch(r'/private/tmp/sd-app-isolation-[A-Za-z0-9_-]{6,32}', value['directory']), 'Malformed early created identity')
            rows.append(value)
    require(len(rows) == 1, 'Missing or contradictory early created identity; unresolved resource')
    return rows[0]


def network_proof(value):
    require(closed(value, ['tag', 'observation', 'loopback', 'controlFiles', 'downDevices', 'loopbackAddresses'])
            and value['tag'] == 'APP-NET-ADMIT-1' and value['loopback'] == 'lo', 'Network summary schema')
    observation = value['observation']
    require(closed(observation, ['tag', 'entries', 'addressedInterfaces']) and observation['tag'] == 'APP-NET-DIAG-1', 'Network observation schema')
    entries = observation['entries']
    require(type(entries) is list and 1 <= len(entries) <= 16, 'Network entries bounds')
    names = []
    controls, down = [], []
    for entry in entries:
        require(closed(entry, ['name', 'kind', 'flags', 'operstate', 'type']) and type(entry['name']) is str
                and re.fullmatch(r'(?!\.{1,2}$)[A-Za-z0-9_.-]{1,32}', entry['name']), 'Network entry schema')
        name = entry['name']
        names.append(name)
        if name != 'lo' and entry['kind'] == 'file':
            require(all(entry[f] == {'unavailable': 'ENOTDIR'} for f in ['flags', 'operstate', 'type']), 'Control file state')
            controls.append(name)
            continue
        require(entry['kind'] == 'symlink' and type(entry['flags']) is str and re.fullmatch(r'0x(0|[1-9a-f][0-9a-f]{0,7})', entry['flags'])
                and type(entry['type']) is str and re.fullmatch(r'(0|[1-9][0-9]{0,4})', entry['type']) and int(entry['type']) <= 65535, 'Device state malformed')
        flags = int(entry['flags'], 16)
        if name == 'lo':
            require(flags & 9 == 9 and flags & 0x30040 == 0 and entry['type'] == '772'
                    and entry['operstate'] in ['up', 'unknown'], 'Loopback state rejected')
        else:
            require(flags & 0x30049 == 0 and entry['type'] != '772' and entry['operstate'] == 'down', 'Nonloopback state rejected')
            down.append(name)
    require(names == sorted(set(names)) and names.count('lo') == 1, 'Network names/order rejected')
    addressed = observation['addressedInterfaces']
    require(type(addressed) is list and len(addressed) == 1 and closed(addressed[0], ['name', 'addresses']) and addressed[0]['name'] == 'lo', 'Addressed interfaces rejected')
    addresses = addressed[0]['addresses']
    require(type(addresses) is list and 1 <= len(addresses) <= 4, 'Address bounds')
    for row in addresses:
        require(closed(row, ['address', 'family', 'internal']) and row['address'] in ['127.0.0.1', '::1']
                and row['family'] == ('IPv4' if row['address'] == '127.0.0.1' else 'IPv6') and row['internal'] is True, 'Address rejected')
    ips = sorted(row['address'] for row in addresses)
    require(len(set(ips)) == len(ips) and '127.0.0.1' in ips and value['loopbackAddresses'] == ips
            and value['controlFiles'] == controls and value['downDevices'] == down, 'Network summary mismatch')


def authority_proof(result, stderr, resource, manifest):
    require(closed(result, ['runId', 'role', 'manifestSha', 'admissionPassed', 'egressBlocked', 'filesystemCanariesPassed',
                            'databaseMode', 'networkAdmission', 'authority', 'containerId', 'directory', 'image', 'cleanupAcknowledged']), 'Strict parent schema')
    require(result['runId'] == resource['runId'] and result['containerId'] == resource['id'] and result['directory'] == resource['directory']
            and result['image'] == IMAGE and result['role'] == ROLE and result['databaseMode'] == 'not-admitted'
            and all(result[k] is True for k in ['admissionPassed', 'egressBlocked', 'filesystemCanariesPassed', 'cleanupAcknowledged']), 'Parent identity/admission proof')
    bundle_files = {name: manifest['bundleHashes'][name] for name in sorted(manifest['bundleHashes'])}
    bundle = {'runId': resource['runId'], 'role': ROLE, 'files': bundle_files}
    require(result['manifestSha'] == digest(json.dumps(bundle, separators=(',', ':')).encode()), 'Actual bundle manifest hash mismatch')
    network_proof(result['networkAdmission'])
    a = result['authority']
    require(closed(a, ['schema', 'sourceHashes', 'compiler', 'emit', 'nominal', 'controls', 'evaluations', 'effects']) and a['schema'] == 'SD-AUTHORITY-PURE-1', 'Authority schema')
    require(a['sourceHashes'] == manifest['authoritySourceHashes'] and exact(a['compiler'], {
        'version': '5.9.3', 'sha256': manifest['compilerSha256'], 'loads': 1, 'requireAttempts': 0, 'sysAbsent': True}) and type(a['compiler']['loads']) is int and type(a['compiler']['requireAttempts']) is int, 'Source/compiler proof')
    require(exact(a['nominal'], {'caseIds': manifest['caseIds'], 'passed': 84, 'failed': 0, 'skipped': 0})
            and exact(a['controls'], [{'id': m['id'], 'target': m['target'], 'mutantDetected': True, 'restored': True} for m in manifest['controls']])
            and exact(a['evaluations'], {'graphs': 11, 'types': 11, 'rules': 11, 'service': 11, 'total': 33})
            and exact(a['effects'], {'database': 0, 'provider': 0, 'sourceWrites': 0, 'domainNativeImports': 0, 'boundaryProbeRejections': 2}), 'Authority exact accounting')
    emit = a['emit']
    require(closed(emit, ['optionsSha256', 'nominalHashes', 'mutantHashes', 'nominalCount', 'mutantCount'])
            and emit['optionsSha256'] == manifest['emitOptionsSha256'] and exact(emit['nominalCount'], 3) and exact(emit['mutantCount'], 5)
            and closed(emit['nominalHashes'], manifest['authoritySourceHashes']) and closed(emit['mutantHashes'], [m['id'] for m in manifest['controls']])
            and all(type(h) is str and re.fullmatch(HEX, h) for group in ['nominalHashes', 'mutantHashes'] for h in emit[group].values()), 'Emit proof schema')
    records = []
    for line in stderr.splitlines():
        try:
            value = load(line)
        except (ValueError, RuntimeError):
            continue
        if type(value) is dict and str(value.get('tag', '')).startswith('AUTHORITY_'):
            records.append(value)
    expected = [('AUTHORITY_EMIT', 'nominal', module) for module in manifest['authoritySourceHashes']]
    expected += [('AUTHORITY_LEAF', 'nominal', case) for case in manifest['caseIds']]
    for m in manifest['controls']:
        expected += [('AUTHORITY_EMIT', 'mutant', m['module']), ('AUTHORITY_LEAF', 'mutant', m['target']), ('AUTHORITY_LEAF', 'restoration', m['target'])]
    require(len(records) == len(expected) + 1, 'Missing/extra authority raw records')
    mutant_index = 0
    for row, (tag, phase, key) in zip(records[:-1], expected):
        require(row.get('tag') == tag and row.get('phase') == phase and row.get('id') == key, 'Raw evidence order/identity mismatch')
        if tag == 'AUTHORITY_EMIT':
            require(closed(row, ['tag', 'phase', 'id', 'sha256']), 'Emit record schema')
            if phase == 'nominal':
                require(row['sha256'] == emit['nominalHashes'][key], 'Nominal emit mismatch')
            else:
                m = manifest['controls'][mutant_index]
                mutant_index += 1
                require(row['sha256'] == emit['mutantHashes'][m['id']] and row['sha256'] != emit['nominalHashes'][key], 'Mutant emit mismatch')
        else:
            require(closed(row, ['tag', 'phase', 'id', 'completed', 'calls', 'order', 'expected']) and row['completed'] is (phase != 'mutant'), 'Leaf completion schema')
            planned = manifest['leafProofs'][key]
            require(exact(row['calls'], planned['calls']) and row['order'] == planned['order'] and exact(row['expected'], planned['expected']), 'Leaf C/R/F/order/decision mismatch: ' + key)
    phase = records[-1]
    require(closed(phase, ['tag', 'elapsedMs', 'nominalLeaves', 'controls', 'compilerLoads', 'emits', 'graphs', 'moduleEvaluations'])
            and phase['tag'] == 'AUTHORITY_PHASE' and type(phase['elapsedMs']) in [int, float] and 0 <= phase['elapsedMs'] < 10000
            and exact(phase['nominalLeaves'], 84) and exact(phase['controls'], 5) and exact(phase['compilerLoads'], 1)
            and exact(phase['emits'], {'nominal': 3, 'mutant': 5}) and exact(phase['graphs'], 11)
            and exact(phase['moduleEvaluations'], {module: 11 for module in manifest['authoritySourceHashes']}), 'Raw phase accounting mismatch')


def main():
    approval, approval_raw, manifest = validate_receipt()
    # Whole-file/tool checks precede every process. Git clean metadata is verified
    # by the three selected commands after the overall exclusive claim below.
    capture = Capture(approval, approval_raw, manifest)
    print(json.dumps({'areaRetained': str(capture.area), 'phase': 'allocated-no-process'}), flush=True)
    launched = None
    try:
        capture.freeze()
        claim = {'schema': 'SD-AUTHORITY-REAL-ONCE-1', 'approvedHead': approval['approvedHead'],
                 'operatorSha256': approval['operatorSha256'], 'manifestSha256': approval['manifestSha256'],
                 'approvalSha256': digest(approval_raw), 'area': str(capture.area), 'scope': SCOPE}
        write_new(ONCE, encoded(claim))
        capture.report['overallClaimConsumed'] = True
        capture.save()
        capture.git_clean('before-metadata')
        capture.engine('engine-before')
        capture.labels('labels-before')
        image_row = capture.docker('cached-image', ['image', 'inspect', IMAGE])
        capture.complete(image_row)
        images = load(capture.text(image_row, 'stdout'))
        require(type(images) is list and len(images) == 1, 'One cached image required')
        image = images[0]
        require(re.fullmatch('sha256:' + HEX, image['Id']) and image['Os'] == 'linux' and image['Architecture'] in ['amd64', 'arm64']
                and IMAGE in image['RepoDigests'] and not image['Config'].get('Volumes'), 'Pinned cached image rejected')
        entries = image['Config']['Env']
        require(type(entries) is list and all(type(e) is str and '=' in e for e in entries), 'Image env malformed')
        pairs = [e.split('=', 1) for e in entries]
        require(len(set(k for k, v in pairs)) == len(pairs) and {'PATH', 'NODE_VERSION'} <= {k for k, v in pairs}
                and all((k == 'PATH' and v == '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
                        or (k == 'NODE_VERSION' and v == '22.23.4') or (k == 'YARN_VERSION' and re.fullmatch(r'[0-9.]+', v)) for k, v in pairs), 'Image environment rejected')
        capture.report['cachedImage'] = {'Id': image['Id'], 'RepoDigests': image['RepoDigests'], 'Os': image['Os'], 'Architecture': image['Architecture']}
        capture.git_clean('before-launch')
        capture.freeze()
        launched = capture.command('launcher', LAUNCH, {}, ROOT, seconds=300,
                                   caps={'stdout': 16384, 'stderr': 32768}, launcher=True)
        # Even a failed/incomplete Node capture retains early exact identity and
        # permits only independent read-only afterchecks. No recovery deletion.
        if launched['firstProblem'] is not None:
            capture.report['firstProblem'] = launched['firstProblem']
        stderr = capture.text(launched, 'stderr', partial=True)
        try:
            observed = resource_identity(stderr)
            require(capture.report['resources'] == observed, 'Early identity did not match retained raw bytes')
        except BaseException:
            capture.report['resourceIdentityUnresolved'] = True
            raise
        capture.save()
    except BaseException as exc:
        problem = {'type': type(exc).__name__, 'message': str(exc)[:2048]}
        if capture.report['firstProblem'] is None:
            capture.report['firstProblem'] = problem
        else:
            capture.report['secondaryProblems'].append(problem)
    finally:
        if capture.report['launcherInvocations']:
            # Each aftercheck is attempted independently while local ownership is valid.
            checks = [('sameEngine', lambda: capture.engine('engine-after')),
                      ('zeroPurposeLabels', lambda: capture.labels('labels-after'))]
            resource = capture.report['resources']
            if resource is not None:
                def exact_absence():
                    row = capture.docker('exact-container-after', ['container', 'inspect', resource['id']], nonzero_ok=True)
                    capture.complete(row)
                    error = capture.text(row, 'stderr')
                    require(row['returnCode'] != 0 and re.search(r'No such (?:object|container):\s*' + resource['id'] + r'(?![a-f0-9])', error), 'Exact container absence not established')
                def workspace_absence():
                    capture.owned()
                    try:
                        pathlib.Path(resource['directory']).lstat()
                    except OSError as exc:
                        require(exc.errno == errno.ENOENT, 'Workspace absence unknown')
                    else:
                        raise RuntimeError('Acknowledged workspace remains')
                checks += [('exactContainerAbsent', exact_absence), ('workspaceENOENT', workspace_absence)]
            for label, check in checks:
                try:
                    check()
                    capture.report['postchecks'][label] = True
                except BaseException as exc:
                    capture.report['postchecks'][label] = False
                    capture.report['cleanupErrors'].append({'code': label, 'type': type(exc).__name__, 'message': str(exc)[:2048]})
        try:
            capture.freeze()
            if capture.report['overallClaimConsumed']:
                capture.git_clean('after')
        except BaseException as exc:
            capture.report['secondaryProblems'].append({'code': 'FINAL_SOURCE_OR_GIT_CHECK', 'type': type(exc).__name__, 'message': str(exc)[:2048]})
        try:
            if launched is not None:
                capture.complete(launched)
                require(launched['returnCode'] == 0, 'Launcher failed')
                authority_proof(load(capture.text(launched, 'stdout')), capture.text(launched, 'stderr'), capture.report['resources'], manifest)
                capture.report['authorityEvidenceVerified'] = True
        except BaseException as exc:
            if capture.report['firstProblem'] is None:
                capture.report['firstProblem'] = {'code': 'AUTHORITY_ACCEPTANCE_FAILED', 'type': type(exc).__name__, 'message': str(exc)[:2048]}
        cleanup = capture.report['postchecks'] == {'sameEngine': True, 'zeroPurposeLabels': True, 'exactContainerAbsent': True, 'workspaceENOENT': True}
        all_rows = all(row['firstProblem'] is None and not row['cleanupErrors'] for row in capture.report['commands'])
        if capture.report['launcherInvocations'] == 0:
            capture.report['status'] = 'BLOCKED_BEFORE_LAUNCH'
            if any(r['firstProblem'] and r['firstProblem']['code'] == 'OWNERSHIP_OR_FINALIZATION_UNRESOLVED' for r in capture.report['commands']):
                capture.report['status'] = 'UNRESOLVED'
        elif cleanup and capture.report['resources'] is not None and not capture.report.get('resourceIdentityUnresolved'):
            capture.report['status'] = 'PASS' if capture.report.get('authorityEvidenceVerified') and all_rows and capture.report['firstProblem'] is None and not capture.report['cleanupErrors'] and not capture.report['secondaryProblems'] else 'FAIL'
        else:
            capture.report['status'] = 'UNRESOLVED'
        capture.report['reviewRequiredBeforeAnyFurtherAttempt'] = True
        try:
            capture.report['resultWritten'] = True
            capture.save()
            print(json.dumps({'status': capture.report['status'], 'result': str(capture.area / 'result.json'),
                              'launcherInvocations': capture.report['launcherInvocations'], 'resources': capture.report['resources']}), flush=True)
        except BaseException as exc:
            capture.report['status'] = 'UNRESOLVED'
            capture.report['resultWritten'] = False
            capture.report['resultWriteError'] = {'type': type(exc).__name__, 'message': str(exc)[:2048]}
            print(json.dumps(capture.report), flush=True)
    return 0 if capture.report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
