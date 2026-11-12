"""Receipt-gated public dependency preparation/emission. Never evaluate application modules."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import uuid
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / 'test/customer-enrollment-runtime'
QA = ROOT / 'output/qa/customer-enrollment-focused'
RECEIPT = Path('/private/tmp/sd-customer-enrollment-prepare-approval.json')
LOCK = Path('/private/tmp/sd-customer-enrollment-resolved-lock.json')
BUILD = Path('/private/tmp/sd-customer-enrollment-build.json')
AUTHOR = '/root/milestone_composition_r9'
OWN_FILES = ['README.md', 'profile.json', 'package-plan.json', 'prepare.py', 'emit.cjs', 'scenario.mjs', 'ports-plan.json', 'run.mjs']
CONTEXT = ['test/application/app-bundle.mjs', 'test/application/app-container.mjs', 'test/application/bootstrap.mjs',
           'test/application/app-ports.mjs', 'test/application/app-image.json', 'test/application/app-runtime.json',
           'documentation/planning/implementation/CUSTOMER_ENROLLMENT_FOCUSED_VERIFICATION_CONTRACT.md',
           'output/qa/customer-enrollment-focused/TOOL_INPUTS.json', 'package-lock.json']


def require(ok, why):
    if not ok:
        raise RuntimeError(why)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, limit=16 * 1024 * 1024):
    meta = path.lstat()
    require(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 and meta.st_size <= limit, 'Nonregular/oversized input')
    return path.read_bytes()


def git(*args):
    return subprocess.check_output(['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false', *args],
                                   cwd=ROOT, env={'PATH': '/usr/bin:/bin'})


def dependency(lock, parent, name):
    current = parent
    while current:
        candidate = current + '/node_modules/' + name
        if candidate in lock['packages']:
            return candidate
        current = current.rsplit('/node_modules/', 1)[0] if '/node_modules/' in current else ''
    candidate = 'node_modules/' + name
    require(candidate in lock['packages'], 'Unresolved locked dependency')
    return candidate


def lock_rows(lock):
    require(lock.get('lockfileVersion') == 3 and isinstance(lock.get('packages'), dict), 'Lock schema')
    for name, row in lock['packages'].items():
        if not name:
            continue
        require(re.fullmatch(r'node_modules/(?:[A-Za-z0-9_.@/-]+)', name) and '..' not in name.split('/'), 'Lock package path')
        parsed = urlparse(row.get('resolved', ''))
        require(parsed.scheme == 'https' and parsed.hostname == 'registry.npmjs.org' and not parsed.username
                and not parsed.password and not parsed.query and not parsed.fragment, 'Nonpublic lock URL')
        integrity = row.get('integrity', '')
        require(re.fullmatch(r'sha512-[A-Za-z0-9+/]+=*', integrity) and len(base64.b64decode(integrity[7:], validate=True)) == 64,
                'Missing SHA512 package integrity')
        require(not row.get('link') and not row.get('inBundle') and not row.get('optional'), 'Unsupported linked/optional package')


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in ['--resolve-lock', '--install-emit']
            and sys.flags.isolated == 1 and sys.flags.dont_write_bytecode == 1
            and sys.dont_write_bytecode is True and sys.flags.no_site == 1, 'Fixed isolated no-site/no-bytecode invocation')
    require(set(os.environ) <= {'PATH', 'TMPDIR', 'LANG', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING'}
            and os.environ.get('PATH') == '/usr/bin:/bin', 'Clean preparation environment')
    cf_marker = os.environ.get('__CF_USER_TEXT_ENCODING')
    require(cf_marker is None or cf_marker == '0x' + format(os.getuid(), 'X') + ':0x0:0x0', 'Unexpected public CoreFoundation marker')
    profile = json.loads(regular(HERE / 'profile.json'))
    python = Path(profile['pythonTool'])
    require(sha(regular(python, 128 * 1024 * 1024)) == profile['pythonToolSha256']
            and os.path.samefile(sys.executable, python)
            and sys.implementation.name == profile['pythonImplementation'] == 'cpython'
            and '.'.join(str(n) for n in sys.version_info[:3]) == profile['pythonVersion'] == '3.14.7', 'Preparation Python tool drift')
    mode = sys.argv[1][2:]
    decision = 'APPROVE_PUBLIC_LOCK_RESOLUTION_ONLY' if mode == 'resolve-lock' else 'APPROVE_LOCKED_INSTALL_AND_EMIT_ONLY'
    plan = json.loads(regular(HERE / 'ports-plan.json'))
    package_plan = json.loads(regular(HERE / 'package-plan.json'))
    packages = package_plan['packages']
    selected = [str(HERE.relative_to(ROOT) / n) for n in OWN_FILES] + CONTEXT + list(plan['sourcePins'])
    source_hashes = {n: sha(regular(ROOT / n)) for n in selected}
    require(all(source_hashes[n] == h for n, h in plan['sourcePins'].items()), 'Actual source changed')
    require(git('diff', '--name-only', 'HEAD', '--', *selected) == b'', 'Selected preparation inputs differ from committed candidate')
    require(set(git('ls-files', '--', *selected).decode().splitlines()) == set(selected), 'Untracked preparation input')
    commit = git('rev-parse', 'HEAD').decode().strip()
    receipt_stat = RECEIPT.lstat()
    require(receipt_stat.st_uid == os.getuid() and receipt_stat.st_mode & 0o777 == 0o600, 'Private approval mode/owner')
    approval = json.loads(regular(RECEIPT, 65536))
    expected = {'schema': 'SD-ENROLLMENT-PREP-APPROVAL-1', 'decision': decision, 'sourceRoot': str(ROOT), 'sourceCommit': commit,
                'inputs': source_hashes, 'mode': mode}
    if mode == 'install-emit':
        require(LOCK.lstat().st_uid == os.getuid() and not LOCK.lstat().st_mode & 0o077, 'Resolved lock mode/owner')
        expected['resolvedLockSha256'] = sha(regular(LOCK))
    require(set(approval) == set(expected) | {'nonce', 'reviewers'} and all(approval.get(k) == v for k, v in expected.items()), 'Approval binding')
    require(re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', approval['nonce']), 'Approval nonce')
    reviewers = approval['reviewers']
    require(isinstance(reviewers, list) and len(reviewers) == 2 and len({r.get('agent') for r in reviewers}) == 2
            and all(set(r) == {'agent', 'decision'} and r['decision'] == decision and r['agent'] != AUTHOR
                    and re.fullmatch(r'/root(?:/[A-Za-z0-9_]+)*', r['agent']) for r in reviewers), 'Two actual nonauthor reviews')
    node = Path(profile['nodeTool']); npm = Path(profile['npmTool'])
    require(sha(regular(node, 128 * 1024 * 1024)) == profile['nodeToolSha256'], 'Preparation Node tool drift')
    tool_bytes = regular(ROOT / profile['npmFiles'])
    require(sha(tool_bytes) == profile['npmFilesSha256'], 'npm inventory drift')
    tools = json.loads(tool_bytes); tool_root = Path(tools['root'])
    found = {}
    for p in sorted(tool_root.rglob('*')):
        require(not p.is_symlink(), 'npm tool symlink')
        if p.is_file():
            found[str(p.relative_to(tool_root))] = sha(regular(p))
    require(found == tools['files'] and tools['links'] == {} and npm == tool_root / 'bin/npm-cli.js', 'npm tool tree drift')
    # Consume once before ANY allocation/process/network operation. Failure never authorizes a retry.
    once = Path('/private/tmp/sd-customer-enrollment-' + mode + '-' + approval['nonce'] + '.once')
    with once.open('xb') as handle:
        os.chmod(once, 0o600); handle.write(json.dumps({'decision': decision, 'receiptSha256': sha(regular(RECEIPT))}).encode())
    area = Path('/private/tmp/sd-customer-enrollment-build-' + str(uuid.uuid4()))
    area.mkdir(mode=0o700); identity = area.stat()
    marker = {'schema': 'SD-ENROLLMENT-OWNED-BUILD-1', 'path': str(area), 'dev': identity.st_dev, 'ino': identity.st_ino,
              'sourceRoot': str(ROOT), 'sourceCommit': commit, 'inputs': source_hashes, 'mode': mode}
    (area / '.owner.json').write_text(json.dumps(marker)); os.chmod(area / '.owner.json', 0o600)
    project = area / 'public'; project.mkdir(mode=0o700)
    for name in ['home', 'cache', 'output']:
        (area / name).mkdir(mode=0o700)
    for name in ['user.npmrc', 'global.npmrc']:
        (area / name).write_text('registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n')
    env = {'PATH': str(node.parent) + ':/usr/bin:/bin', 'HOME': str(area / 'home'), 'TMPDIR': str(area),
           'NPM_CONFIG_USERCONFIG': str(area / 'user.npmrc'), 'NPM_CONFIG_GLOBALCONFIG': str(area / 'global.npmrc'),
           'NPM_CONFIG_CACHE': str(area / 'cache'), 'NPM_CONFIG_IGNORE_SCRIPTS': 'true',
           'NPM_CONFIG_REGISTRY': 'https://registry.npmjs.org/', 'NPM_CONFIG_AUDIT': 'false', 'NPM_CONFIG_FUND': 'false'}
    manifest = {'name': 'sd-customer-enrollment-fixture', 'version': '1.0.0', 'private': True, 'dependencies': packages}
    (project / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
    original = json.loads(regular(ROOT / 'package-lock.json'))
    retained = {}
    def retain(key):
        if key in retained:
            return
        row = original['packages'][key]; retained[key] = row
        for name in row.get('dependencies', {}):
            retain(dependency(original, key, name))
    for name in packages:
        retain('node_modules/' + name)
    seed = {'name': manifest['name'], 'version': manifest['version'], 'lockfileVersion': 3, 'requires': True,
            'packages': {'': manifest, **retained}}
    lock_rows(seed)
    (project / 'package-lock.json').write_text(json.dumps(seed, indent=2) + '\n')
    def owned():
        current = area.lstat()
        require(current.st_dev == identity.st_dev and current.st_ino == identity.st_ino and not area.is_symlink()
                and json.loads(regular(area / '.owner.json')) == marker, 'Owned build identity changed')
    def execute(label, args, cwd=project):
        owned()
        with (area / (label + '.stdout.txt')).open('wb') as out, (area / (label + '.stderr.txt')).open('wb') as err:
            result = subprocess.run(args, cwd=cwd, env=env, stdout=out, stderr=err, timeout=900)
        require(result.returncode == 0, 'Preparation failed; retain exact owned diagnostics at ' + str(area))
    if mode == 'resolve-lock':
        require(not LOCK.exists(), 'Previous lock retained; disposition required')
        execute('resolve', [str(node), str(npm), 'install', '--package-lock-only', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'])
        resolved_bytes = regular(project / 'package-lock.json')
    else:
        resolved_bytes = regular(LOCK); require(sha(resolved_bytes) == approval['resolvedLockSha256'], 'Resolved lock drift')
        (project / 'package-lock.json').write_bytes(resolved_bytes)
    resolved = json.loads(resolved_bytes); lock_rows(resolved)
    require(resolved['packages']['']['dependencies'] == packages and set(resolved['packages']) == {''} | set(retained), 'Exact locked package closure')
    for key, old in retained.items():
        new = resolved['packages'][key]
        require(all(new.get(field) == old.get(field) for field in ['version', 'integrity', 'dependencies']), 'Existing locked closure changed')
    if mode == 'resolve-lock':
        with LOCK.open('xb') as out:
            os.chmod(LOCK, 0o600); out.write(resolved_bytes)
        print(json.dumps({'schema': 'SD-ENROLLMENT-LOCK-RESULT-1', 'sourceCommit': commit, 'mode': mode,
                          'workspace': str(area), 'lockSha256': sha(resolved_bytes), 'packages': len(retained), 'applicationEvaluated': False}))
        return
    require(not BUILD.exists(), 'Previous build descriptor retained; disposition required')
    execute('install', [str(node), str(npm), 'ci', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'])
    installed = {}
    for p in sorted((project / 'node_modules').rglob('*')):
        if '.bin' in p.relative_to(project).parts:
            continue
        require(not p.is_symlink() and (p.is_dir() or p.is_file()), 'Unsupported dependency file')
        if p.is_file():
            require(p.suffix != '.node', 'Native addon forbidden'); installed[str(p.relative_to(project))] = sha(regular(p))
    for p in sorted((project / 'node_modules').rglob('.bin'), reverse=True):
        require(p.is_dir() and not p.is_symlink(), 'Unexpected bin directory'); shutil.rmtree(p)
    baseline = {name: git('show', plan['baseline'] + ':' + name).decode() for name in
                ['src1/modules/auth/services/index.ts', 'src1/modules/auth/validation/index.ts']}
    input_data = {'plan': plan, 'sources': {name: regular(ROOT / name).decode() for name in plan['sourcePins']}, 'baseline': baseline}
    (project / 'emit-input.json').write_text(json.dumps(input_data))
    (project / 'emit.cjs').write_bytes(regular(HERE / 'emit.cjs'))
    execute('emit', [str(node), str(project / 'emit.cjs'), str(project / 'emit-input.json'), str(area / 'output')])
    owned()
    artifact_names = ['emitted-modules.json', 'runtime-modules.json', 'emission-report.json']
    descriptor = {**marker, 'schema': 'SD-ENROLLMENT-BUILD-1', 'lockSha256': sha(resolved_bytes), 'installed': installed,
                  'artifacts': {name: sha(regular(area / 'output' / name)) for name in artifact_names}}
    with BUILD.open('xb') as out:
        os.chmod(BUILD, 0o600); out.write((json.dumps(descriptor, indent=2) + '\n').encode())
    print(json.dumps({'schema': 'SD-ENROLLMENT-EMIT-RESULT-1', 'sourceCommit': commit, 'workspace': str(area),
                      'descriptorSha256': sha(regular(BUILD)), 'applicationEvaluated': False, 'diagnosticsRequireReview': True}))


if __name__ == '__main__':
    main()
