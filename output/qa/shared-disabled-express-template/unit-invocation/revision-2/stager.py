"""One reviewed offline shared-helper unit run. Default invocation has no effects."""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import stat
import subprocess
import sys
import time
import uuid

ROOT = Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab')
SELF = Path('/private/tmp/sd-disabled-express-unit-stager-r2.py')
PROPOSAL = Path('/private/tmp/sd-disabled-express-unit-proposal-r2.json')
RECEIPT = Path('/private/tmp/sd-disabled-express-unit-approval.json')
PYTHON = Path('/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/bin/python3.14')
PYTHON_SHA = '87d4df53fd91304be5bac391fb204643c36b7df2023c04a0953bcbc7d4fdf634'
NODE = Path('/Users/shubham/.nvm/versions/node/v24.19.0/bin/node')
NODE_SHA = '27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1'
AUTHOR = '/root/lab_remaining_audit'
DECISION = 'APPROVE_ONE_FIXED_DISABLED_EXPRESS_HELPER_UNIT_RUN'
EXPECTED_TESTS = 36
EXPECTED_TEST_NAMES = [
  "one immutable canonical policy and no mutable guard control API",
  "one ordered initialization seals the final exports function, distinct from initial Module.exports",
  "intact SEALED load and resolve deny before forwarding and retain readiness: fs",
  "intact SEALED load and resolve deny before forwarding and retain readiness: node:fs",
  "intact SEALED load and resolve deny before forwarding and retain readiness: debug",
  "intact SEALED load and resolve deny before forwarding and retain readiness: path",
  "unrelated caught optional error retains exact identity and does not poison the guard",
  "initialization failure is irreversible: order",
  "initialization failure is irreversible: duplicate",
  "initialization failure is irreversible: missing",
  "initialization failure is irreversible: extra",
  "initialization failure is irreversible: loaded false at completion",
  "initialization failure is irreversible: direct resolution without outgoing frame",
  "native initialization forward error retains identity and leaves FAILED: incomingError",
  "native initialization forward error retains identity and leaves FAILED: outgoingError",
  "readiness before initialization cannot later be repaired",
  "a second incoming initializer cannot reopen a sealed window",
  "accessor on genuine Module is denied without invocation and restoration cannot recover: filename",
  "accessor on genuine Module is denied without invocation and restoration cannot recover: id",
  "accessor on genuine Module is denied without invocation and restoration cannot recover: loaded",
  "accessor on genuine Module is denied without invocation and restoration cannot recover: exports",
  "changed genuine Module data irreversibly fails: filename",
  "changed genuine Module data irreversibly fails: id",
  "changed genuine Module data irreversibly fails: loaded",
  "changed genuine Module data irreversibly fails: exports",
  "fake native Module with target filename cannot replace the captured identity",
  "proxy parent does not invoke observable traps",
  "cache integrity fails closed without recovery: getter",
  "cache integrity fails closed without recovery: replace",
  "cache integrity fails closed without recovery: delete",
  "cache integrity fails closed without recovery: cache-proxy",
  "changed native Module prototype remains failed after external restoration",
  "actual prepared-source boundary confines helper to intended roles: auth",
  "actual prepared-source boundary confines helper to intended roles: private",
  "actual prepared-source boundary confines helper to intended roles: contact",
  "actual prepared-source boundary confines helper to intended roles: refill"
]
CLAIMED = None
SOURCE_PINS = {'test/api-runtime/disabled-express-template.cjs': '52772defe90437b827fb74e39f10dd20afe6abe4ad8534ddd9a76d76c4c9b779', 'test/api-runtime/disabled-express-template.test.mjs': 'f0ec1cde80b48687fbc3853ab4b3d36420bb2af0281158291d05a51db1cf293d', 'test/api-runtime/platform.mjs': '3decce77cdc98038713818a79f49742df9ef8ff58803e931ae1a44c1ffd1e76c', 'test/api-runtime/profile.json': 'bb310dd4909678d239a37975b7326960ffce1fb9b788bbe41beb65c7bcfdad54', 'test/api-runtime/private-documents/profile.json': 'f21a759901d705f1e950fc8c194d988757ada73d22cba65b139cbae06fbcd197', 'test/api-runtime/customer-contact/profile.json': '8901145dbb08ee98e489c9241db8e32cc90f6485aa3f154c7aea73be8f2f5075', 'test/api-runtime/pharmacy-refill/profile.json': '15e8b72e9e3ab4f359df4f90f33f0582a20129ac2723064e800263ac1ced2ae2', 'test/application/app-bundle.mjs': '63a5e15779fd942b9ff9e1c3ccaa45d4d347387f196555e2a1b8998477c7ecfc'}
CONTEXT_PINS = {
    str(ROOT / 'output/qa/shared-disabled-express-template/INTERFACE.json'): '0dea3a043efea2e284246bc29d5ecc5a4abb116d70f614f958c210d8ba5f2952',
    str(ROOT / 'output/qa/shared-disabled-express-template/source-candidate/SOURCE_CANDIDATE.json'): '853e1dc480fc0e80056f07c0a7e72dce05a85c7600b79d6bbbc05373483a4f68',
    '/private/tmp/sd-disabled-express-shared-source-STANDARDS.json': '3d0515518cfddff9736bc6002e7da338fee17feecd667cf81358eaa28fd24a0d',
    '/private/tmp/sd-disabled-express-shared-source-SPEC.json': 'c3adf631616baa32801442aeb9087bab4443d99cb34a5fdb8757bea58cdc837b',
}
ROLES = [
    ('auth', 'scenario', 'sd-auth-api-build-unit-', 'SD-AUTH-API-'),
    ('private', 'private-documents', 'sd-private-document-build-unit-', 'SD-PRIVATE-DOCUMENT-API-'),
    ('contact', 'customer-contact', 'sd-customer-contact-build-unit-', 'SD-CUSTOMER-CONTACT-API-'),
    ('refill', 'pharmacy-refill', 'sd-pharmacy-refill-build-unit-', 'SD-PHARMACY-REFILL-API-'),
]

class Stop(Exception):
    pass

def need(ok, code):
    if not ok:
        raise Stop(code)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def regular(path, cap=268435456, private=False, hash_only=False):
    path = Path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= cap, 'INPUT_SHAPE')
        if private:
            need(s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o600, 'INPUT_PRIVATE')
        chunks = []
        digest = hashlib.sha256()
        total = 0
        while True:
            b = os.read(fd, min(65536, cap + 1 - total))
            if not b:
                break
            if hash_only:
                digest.update(b)
            else:
                chunks.append(b)
            total += len(b)
            need(total <= cap, 'INPUT_SIZE')
        after = os.fstat(fd)
        named = path.lstat()
        need((s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns) ==
             (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
             and (named.st_dev, named.st_ino) == (s.st_dev, s.st_ino), 'INPUT_DRIFT')
        return digest.hexdigest() if hash_only else b''.join(chunks)
    finally:
        os.close(fd)

def exclusive(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())

def encoded(value):
    return (json.dumps(value, indent=2) + '\n').encode()

def git(*args):
    return subprocess.check_output(['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false', *args],
                                   cwd=ROOT, env={'PATH': '/usr/bin:/bin'}, timeout=10)

def inputs_current():
    need(all(sha(regular(ROOT / p)) == h for p, h in SOURCE_PINS.items()), 'SOURCE_DRIFT')
    need(all(sha(regular(p)) == h for p, h in CONTEXT_PINS.items()), 'CONTEXT_DRIFT')
    need(regular(NODE, hash_only=True) == NODE_SHA and regular(PYTHON, hash_only=True) == PYTHON_SHA, 'TOOL_DRIFT')

def main():
    global CLAIMED
    if sys.argv[1:] != ['--run']:
        return {'status': 'NOT_RUN', 'reason': 'EXACT_REVIEWED_RECEIPT_REQUIRED'}, 0
    need(sys.flags.isolated == 1 and sys.flags.no_site == 1 and sys.flags.dont_write_bytecode == 1
         and sys.dont_write_bytecode is True and os.path.samefile(sys.executable, PYTHON)
         and sys.implementation.name == 'cpython' and tuple(sys.version_info[:3]) == (3, 14, 7), 'PYTHON_PROFILE')
    need(set(os.environ) <= {'PATH', 'TMPDIR', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING'}
         and os.environ.get('PATH') == '/usr/bin:/bin' and os.environ.get('TMPDIR') == '/private/tmp'
         and os.environ.get('__CF_USER_TEXT_ENCODING') in (None, '0x' + format(os.getuid(), 'X') + ':0x0:0x0'), 'ENVIRONMENT')
    inputs_current()
    proposal_sha = sha(regular(PROPOSAL, 65536))
    source_commit = git('rev-parse', 'HEAD').decode().strip()
    need(re.fullmatch('[a-f0-9]{40}', source_commit) is not None
         and git('diff', '--name-only', 'HEAD', '--', *SOURCE_PINS) == b''
         and set(git('ls-files', '--', *SOURCE_PINS).decode().splitlines()) == set(SOURCE_PINS), 'COMMITTED_SOURCES')
    receipt_bytes = regular(RECEIPT, 65536, private=True)
    approval = json.loads(receipt_bytes)
    expected = {'schema': 'SD-DISABLED-EXPRESS-UNIT-APPROVAL-1', 'decision': DECISION,
                'stagerSha256': sha(regular(SELF, 65536)), 'proposalSha256': proposal_sha,
                'sourceRoot': str(ROOT), 'sourceCommit': source_commit, 'sourcePins': SOURCE_PINS,
                'contextPins': CONTEXT_PINS, 'nodeSha256': NODE_SHA, 'pythonSha256': PYTHON_SHA,
                'expectedTests': EXPECTED_TESTS}
    need(set(approval) == set(expected) | {'nonce', 'reviewers'}
         and all(approval.get(k) == v for k, v in expected.items()), 'RECEIPT_BINDING')
    nonce = approval['nonce']
    need(isinstance(nonce, str) and re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', nonce), 'NONCE')
    reviewers = approval['reviewers']
    need(isinstance(reviewers, list) and len(reviewers) == 2 and len({r.get('agent') for r in reviewers}) == 2
         and {r.get('agent') for r in reviewers} == {'/root', '/root/customer_remaining_audit'}
         and all(set(r) == {'agent', 'decision'} and r['decision'] == DECISION and r['agent'] != AUTHOR for r in reviewers), 'REVIEWERS')
    once = Path('/private/tmp/sd-disabled-express-unit-' + nonce + '.once')
    exclusive(once, encoded({'nonce': nonce, 'receiptSha256': sha(receipt_bytes), 'decision': DECISION}))
    CLAIMED = str(once)
    run_id = str(uuid.uuid4())
    capture = Path('/private/tmp/sd-disabled-express-unit-execution-' + run_id)
    capture.mkdir(mode=0o700)
    exclusive(capture / '.owner.json', encoded({'runId': run_id, 'purpose': 'PRESERVED_UNIT_EVIDENCE'}))
    areas = []
    cleanup = []
    first = None
    child = None
    exit_code = None
    counters = {'stdout': 0, 'stderr': 0}
    tap = bytearray()
    source = None
    def owned(path, marker):
        st = path.lstat()
        need(stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o700
             and (st.st_dev, st.st_ino) == (marker['dev'], marker['ino'])
             and json.loads(regular(path / '.owner.json', 65536, private=True)) == marker, 'OWNERSHIP')
    def area(prefix):
        path = Path('/private/tmp/' + prefix + run_id)
        path.mkdir(mode=0o700)
        st = path.lstat()
        marker = {'runId': run_id, 'path': str(path), 'dev': st.st_dev, 'ino': st.st_ino, 'purpose': 'DISABLED_EXPRESS_UNIT_ONLY'}
        areas.append((path, marker))
        exclusive(path / '.owner.json', encoded(marker))
        return path
    def stage_file(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        exclusive(path, data)
    try:
        source = area('sd-disabled-express-unit-source-')
        staged = {}
        for relative, h in SOURCE_PINS.items():
            data = regular(ROOT / relative)
            need(sha(data) == h, 'SOURCE_DRIFT')
            stage_file(source / relative, data)
            staged[relative] = h
        helper_name = 'test/api-runtime/disabled-express-template.cjs'
        marker_roles = []
        for role, namespace, prefix, schema in ROLES:
            parent = area(prefix)
            runtime = parent / 'runtime'
            runtime.mkdir(mode=0o700)
            profile_name = 'test/api-runtime/' + ('profile.json' if role == 'auth' else namespace + '/profile.json')
            profile = json.loads(regular(source / profile_name))
            content = {'bootstrap.cjs': b'// INERT OWNED UNIT TEMPLATE. NEVER EXECUTED.\n',
                       'runtime-plan.json': encoded({'schema': schema + 'PLAN-1', 'role': profile['role'],
                                                     'requiredCaseIds': [], 'requiredSensitivityIds': [], 'providerCounterKeys': []}),
                       'ports-manifest.json': b'{}\n', 'package-lock.json': b'{}\n',
                       'disabled-express-template.cjs': regular(source / helper_name)}
            for name, data in content.items():
                stage_file(runtime / name, data)
            descriptor = {'schema': schema + 'TEMPLATE-1', 'sourceCommit': source_commit,
                          'files': {name: sha(data) for name, data in content.items()},
                          'sourceFiles': {helper_name: SOURCE_PINS[helper_name]}, 'directory': str(runtime),
                          'lockSha': sha(content['package-lock.json']), 'portsSha': sha(content['ports-manifest.json']),
                          'packageVersions': {'mongoose': profile['mongooseVersion'], 'typescript': profile['compilerVersion']}}
            stage_file(source / ('test/api-runtime/' + namespace + '/runtime-template.json'), encoded(descriptor))
            marker_roles.append({'role': role, 'runtime': str(runtime), 'sourceHelperSha256': SOURCE_PINS[helper_name], 'descriptor': descriptor})
        stage_file(source / 'test/api-runtime/disabled-express-source-admission.json', encoded({'schema': 'SD-DISABLED-EXPRESS-SOURCE-UNIT-FIXTURES-1', 'roles': marker_roles}))
        for path, marker in areas:
            owned(path, marker)
        inputs_current()
        argv = [str(NODE), '--permission', '--allow-fs-read=' + str(source)]
        argv.extend('--allow-fs-read=' + str(path / 'runtime') for path, marker in areas[1:])
        argv.append(str(source / 'test/api-runtime/disabled-express-template.test.mjs'))
        exclusive(capture / 'INVOCATION.json', encoded({'sourceCommit': source_commit, 'sourcePins': SOURCE_PINS,
                  'stagerSha256': expected['stagerSha256'], 'proposalSha256': proposal_sha, 'receiptSha256': sha(receipt_bytes),
                  'once': str(once), 'runId': run_id, 'argv': argv, 'environment': {'PATH': '/usr/bin:/bin', 'TMPDIR': str(source)},
                  'areas': [marker for path, marker in areas], 'roles': marker_roles, 'stagedSourceHashes': staged}))
        with (capture / 'stdout.tap').open('xb') as out, (capture / 'stderr.txt').open('xb') as err:
            os.chmod(capture / 'stdout.tap', 0o600); os.chmod(capture / 'stderr.txt', 0o600)
            child = subprocess.Popen(argv, cwd=source, env={'PATH': '/usr/bin:/bin', 'TMPDIR': str(source)},
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     close_fds=True, start_new_session=True)
            started = time.monotonic()
            selector = selectors.DefaultSelector()
            for name in counters:
                pipe = getattr(child, name)
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, selectors.EVENT_READ, name)
            try:
                while selector.get_map():
                    need(time.monotonic() - started < 30, 'UNIT_TIMEOUT')
                    for key, _ in selector.select(0.05):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        name = key.data
                        limit = 1048576 if name == 'stdout' else 65536
                        keep = max(0, limit - counters[name]); (out if name == 'stdout' else err).write(chunk[:keep])
                        if name == 'stdout':
                            tap.extend(chunk[:keep])
                        counters[name] += len(chunk)
                        need(counters[name] <= limit, 'UNIT_OUTPUT_BOUND')
                exit_code = child.wait(timeout=max(0.1, 30 - (time.monotonic() - started)))
            finally:
                selector.close()
        need(exit_code == 0, 'UNIT_EXIT')
        text = tap.decode('utf8')
        rows = re.findall(r'^ok ([0-9]+) - (.+)$', text, re.M)
        need(len(rows) == EXPECTED_TESTS and [int(i) for i, name in rows] == list(range(1, EXPECTED_TESTS + 1))
             and len({name for i, name in rows}) == EXPECTED_TESTS and [name for i, name in rows] == EXPECTED_TEST_NAMES
             and '\nnot ok ' not in '\n' + text
             and not re.search(r'\b(?:SKIP|TODO)\b', text), 'TAP_CASES')
        for name, value in [('tests', 36), ('suites', 0), ('pass', 36), ('fail', 0), ('cancelled', 0), ('skipped', 0), ('todo', 0)]:
            need(re.search(r'^# ' + name + r' ' + str(value) + r'$', text, re.M), 'TAP_SUMMARY')
        need(re.search(r'^1\.\.36$', text, re.M), 'TAP_PLAN')
        inputs_current()
    except BaseException as error:
        first = str(error) if isinstance(error, Stop) else 'STAGER_FAILURE'
    finally:
        if child is not None:
            try:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        child.kill(); child.wait(timeout=2)
                exit_code = child.returncode
            except BaseException:
                first = first or 'CHILD_CLEANUP_UNVERIFIED'
            finally:
                for pipe in (child.stdout, child.stderr):
                    if pipe:
                        pipe.close()
        for path, marker in reversed(areas):
            if child is not None and child.returncode is None:
                cleanup.append({'path': str(path), 'absent': False, 'reason': 'CHILD_CLEANUP_UNVERIFIED'})
                first = first or 'CHILD_CLEANUP_UNVERIFIED'
                continue
            try:
                owned(path, marker)
                need(all(not p.is_symlink() for p in path.rglob('*')), 'CLEANUP_LINK')
                shutil.rmtree(path)
                need(not path.exists(), 'CLEANUP_REMAINS')
                cleanup.append({'path': str(path), 'dev': marker['dev'], 'ino': marker['ino'], 'absent': True})
            except BaseException:
                cleanup.append({'path': str(path), 'absent': False})
                first = first or 'CLEANUP_UNVERIFIED'
    result = {'schema': 'SD-DISABLED-EXPRESS-UNIT-RESULT-1',
              'status': 'PASS_PENDING_INDEPENDENT_OUTCOME_REVIEW' if first is None else 'FAILED_OR_UNRESOLVED',
              'firstFailure': first, 'runId': run_id, 'sourceCommit': source_commit, 'exitCode': exit_code,
              'expectedTests': EXPECTED_TESTS, 'outputBytes': counters, 'cleanup': cleanup,
              'childPid': child.pid if child is not None else None, 'childReaped': child is not None and child.returncode is not None,
              'once': str(once), 'receiptSha256': sha(receipt_bytes), 'stagerSha256': expected['stagerSha256'],
              'proposalSha256': proposal_sha, 'nodeSha256': NODE_SHA, 'pythonSha256': PYTHON_SHA,
              'unitSourcePins': SOURCE_PINS, 'noApplicationOrDBInvocation': True}
    exclusive(capture / 'RESULT.json', encoded(result))
    return {'status': result['status'], 'capture': str(capture), 'firstFailure': first}, 0 if first is None else 1

if __name__ == '__main__':
    try:
        output, code = main()
    except BaseException as error:
        output, code = {'status': 'POST_CLAIM_FAILED' if CLAIMED else 'PREFLIGHT_FAILED', 'once': CLAIMED,
                        'firstFailure': str(error) if isinstance(error, Stop) else 'STAGER_FAILURE'}, 1
    print(json.dumps(output))
    sys.exit(code)
