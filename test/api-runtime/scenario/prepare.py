"""Public dependency preparation and TypeScript emit only; no app or Docker execution.

An exact two-reviewer private receipt is required before allocation or network use.
"""
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

ROOT = Path(__file__).resolve().parents[3]
HERE = ROOT / 'test/api-runtime/scenario'
NODE = Path('/private/tmp/m0-node22/node')
NODE_SHA = '2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0'
NPM = Path('/Users/shubham/.nvm/versions/node/v24.19.0/lib/node_modules/npm/bin/npm-cli.js')
NPM_SHA = '8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7'
APPROVAL = Path('/private/tmp/sd-auth-api-preparation-approval.json')
LOCK_APPROVAL = APPROVAL
EMIT_APPROVAL = Path('/private/tmp/sd-auth-api-emission-approval.json')
RESOLVED_LOCK = Path('/private/tmp/sd-auth-api-resolved-lock.json')
AUTHOR = '/root/auth_api_fixture_contract'
OTP_PINS = {
    'src1/modules/otp/repository/index.ts': '8d59e92cb0d019a2d777d9b794278f126714205dce774caee5cd6e96d14a6841',
    'src1/modules/otp/services/index.ts': 'cf59555cb618ace73e78e7fb35ca5ce780075ed30d5c3f7c633b1777b4b07971',
    'src1/modules/auth/services/index.ts': 'd59d5ea23df586fbbdb5b9c4615bcbe0b716f649bdc02f3738088f87b0fbae56',
}


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path):
    m = path.lstat()
    require(stat.S_ISREG(m.st_mode) and m.st_nlink == 1, 'Nonregular or linked input: ' + str(path))
    return path.read_bytes()


def git(*args):
    return subprocess.check_output(['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false', *args], cwd=ROOT,
                                   env={'PATH': '/usr/bin:/bin'})


def lock_rows(lock):
    for name, row in lock['packages'].items():
        if not name:
            continue
        parsed = urlparse(row.get('resolved', ''))
        require(parsed.scheme == 'https' and parsed.hostname == 'registry.npmjs.org'
                and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment,
                'Nonpublic registry lock entry: ' + name)
        integrity = row.get('integrity', '')
        require(re.fullmatch(r'sha512-[A-Za-z0-9+/]+=*', integrity), 'Missing integrity: ' + name)
        require(len(base64.b64decode(integrity[7:], validate=True)) == 64, 'Invalid SHA-512 integrity: ' + name)
        require(not row.get('link') and not row.get('inBundle'), 'Unsupported linked/bundled dependency')


def resolved_dependency(lock, parent, name):
    current = parent
    while current:
        candidate = current + '/node_modules/' + name
        if candidate in lock['packages']:
            return candidate
        current = current.rsplit('/node_modules/', 1)[0] if '/node_modules/' in current else ''
    candidate = 'node_modules/' + name
    require(candidate in lock['packages'], 'Unresolved locked dependency: ' + name)
    return candidate


def preserve_root_closures(original, candidate, roots):
    seen = set()
    def compare(old_path, new_path):
        if (old_path, new_path) in seen:
            return
        seen.add((old_path, new_path))
        old = original['packages'][old_path]; new = candidate['packages'][new_path]
        require(old.get('version') == new.get('version') and old.get('integrity') == new.get('integrity'),
                'Existing dependency closure drift: ' + old_path)
        require(old.get('dependencies', {}) == new.get('dependencies', {}), 'Existing dependency metadata drift')
        for name in old.get('dependencies', {}):
            compare(resolved_dependency(original, old_path, name), resolved_dependency(candidate, new_path, name))
    for name in roots:
        compare('node_modules/' + name, 'node_modules/' + name)


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in ['--resolve-lock', '--install-emit']
            and sys.flags.isolated and not os.environ.get('NODE_OPTIONS'), 'Use isolated fixed invocation')
    resolve_only = sys.argv[1] == '--resolve-lock'
    approval_path = LOCK_APPROVAL if resolve_only else EMIT_APPROVAL
    decision = 'APPROVE_PUBLIC_LOCK_RESOLUTION_ONLY' if resolve_only else 'APPROVE_LOCKED_INSTALL_AND_EMIT_ONLY'
    source_commit = git('rev-parse', 'HEAD').decode().strip()
    require(git('status', '--porcelain', '--untracked-files=all') == b'', 'Preparation source is not clean')
    for name, digest in OTP_PINS.items():
        require(sha(regular(ROOT / name)) == digest, 'Reviewed OTP fix absent or changed: ' + name)
    plan_bytes = regular(HERE / 'package-plan.json')
    packages = json.loads(plan_bytes)['packages']
    approval_meta = approval_path.lstat()
    require(approval_meta.st_uid == os.getuid() and not approval_meta.st_mode & 0o022, 'Unsafe preparation receipt')
    approval = json.loads(regular(approval_path))
    expected = {'schema': 'SD-AUTH-API-PREP-APPROVAL-1', 'decision': decision,
                'sourceRoot': str(ROOT), 'sourceCommit': source_commit,
                'prepareSha': sha(regular(HERE / 'prepare.py')),
                'compilerSha': sha(regular(HERE / 'compile.cjs')), 'packagePlanSha': sha(plan_bytes)}
    if not resolve_only:
        lock_meta = RESOLVED_LOCK.lstat()
        require(lock_meta.st_uid == os.getuid() and not lock_meta.st_mode & 0o022, 'Unsafe resolved lock')
        expected['resolvedLockSha'] = sha(regular(RESOLVED_LOCK))
    require(set(approval) == set(expected) | {'reviewers'} and all(approval[k] == v for k, v in expected.items()),
            'Receipt does not bind reviewed preparation/source')
    reviewers = approval['reviewers']
    require(isinstance(reviewers, list) and len(reviewers) == 2
            and len({r.get('agent') for r in reviewers}) == 2
            and all(set(r) == {'agent', 'decision'} and r['decision'] == decision and r['agent'] != AUTHOR
                    and re.fullmatch(r'/root/[A-Za-z0-9_/]+', r['agent']) for r in reviewers), 'Actual nonauthor decisions required')
    require(sha(regular(NODE)) == NODE_SHA and sha(regular(NPM)) == NPM_SHA, 'Unreviewed public preparation tools')
    area = Path('/private/tmp/sd-auth-api-build-' + str(uuid.uuid4()))
    area.mkdir(mode=0o700)
    identity = area.stat()
    marker = {'schema': 'SD-AUTH-API-BUILD-1', 'sourceCommit': source_commit, 'root': str(area)}
    (area / '.owner.json').write_text(json.dumps(marker) + '\n')
    project = area / 'public'; project.mkdir()
    runtime = area / 'runtime'; runtime.mkdir()
    home = area / 'home'; home.mkdir()
    cache = area / 'cache'; cache.mkdir()
    for name in ['user.npmrc', 'global.npmrc']:
        (area / name).write_text('registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n')
    env = {'PATH': str(NODE.parent) + ':/usr/bin:/bin', 'HOME': str(home), 'TMPDIR': str(area),
           'NPM_CONFIG_USERCONFIG': str(area / 'user.npmrc'), 'NPM_CONFIG_GLOBALCONFIG': str(area / 'global.npmrc'),
           'NPM_CONFIG_CACHE': str(cache), 'NPM_CONFIG_IGNORE_SCRIPTS': 'true',
           'NPM_CONFIG_REGISTRY': 'https://registry.npmjs.org/', 'NPM_CONFIG_AUDIT': 'false', 'NPM_CONFIG_FUND': 'false'}
    manifest = {'name': 'sd-owned-auth-api-fixture', 'version': '1.0.0', 'private': True, 'dependencies': packages}
    (project / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (project / '.npmrc').write_text('registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n')
    original_lock = json.loads(regular(ROOT / 'package-lock.json'))
    lock_rows(original_lock)
    lock = json.loads(json.dumps(original_lock)); lock['name'] = manifest['name']; lock['version'] = manifest['version']
    lock['packages'][''] = {key: manifest[key] for key in ['name', 'version', 'dependencies']}
    (project / 'package-lock.json').write_text(json.dumps(lock, indent=2) + '\n')

    def owned():
        now = area.stat()
        require((now.st_dev, now.st_ino) == (identity.st_dev, identity.st_ino)
                and json.loads(regular(area / '.owner.json')) == marker, 'Build workspace identity changed')

    def npm(label, args):
        owned()
        with (area / (label + '.stdout.txt')).open('wb') as out, (area / (label + '.stderr.txt')).open('wb') as err:
            result = subprocess.run([str(NODE), str(NPM), *args], cwd=project, env=env, stdout=out, stderr=err, timeout=900)
        require(result.returncode == 0, 'Public preparation failed at ' + label)

    if resolve_only:
        npm('lock', ['install', '--package-lock-only', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'])
        resolved_bytes = regular(project / 'package-lock.json')
    else:
        resolved_bytes = regular(RESOLVED_LOCK)
        require(sha(resolved_bytes) == approval['resolvedLockSha'], 'Approved resolved lock changed')
        (project / 'package-lock.json').write_bytes(resolved_bytes)
    resolved = json.loads(resolved_bytes); lock_rows(resolved)
    require(resolved['packages']['']['dependencies'] == packages, 'Resolved root dependency drift')
    for name, version in packages.items():
        require(resolved['packages']['node_modules/' + name]['version'] == version, 'Direct dependency drift: ' + name)
        if name not in ['mongoose', 'typescript']:
            old = original_lock['packages']['node_modules/' + name]
            new = resolved['packages']['node_modules/' + name]
            require(old['version'] == new['version'] and old['integrity'] == new['integrity'], 'Root-lock direct pin drift')
    preserve_root_closures(original_lock, resolved, [name for name in packages if name not in ['mongoose', 'typescript']])
    (area / 'resolved-lock.json').write_bytes(resolved_bytes)
    if resolve_only:
        require(git('rev-parse', 'HEAD').decode().strip() == source_commit
                and git('status', '--porcelain', '--untracked-files=all') == b'', 'Source changed during resolution')
        owned()
        with RESOLVED_LOCK.open('xb') as output:
            os.chmod(RESOLVED_LOCK, 0o600); output.write(resolved_bytes)
        (area / 'resolution-result.json').write_text(json.dumps({'status': 'LOCK_RESOLVED_INSTALL_NOT_RUN',
            'sourceCommit': source_commit, 'resolvedLockSha': sha(resolved_bytes), 'applicationEvaluations': 0,
            'DockerCalls': 0}, indent=2) + '\n')
        print(json.dumps({'status': 'LOCK_RESOLVED_INSTALL_NOT_RUN', 'directory': str(area), 'resolvedLockSha': sha(resolved_bytes)}))
        return
    npm('install', ['ci', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'])
    require(sha(regular(project / 'package-lock.json')) == approval['resolvedLockSha'], 'Install changed approved lock')
    shutil.copytree(project / 'node_modules', runtime / 'node_modules', symlinks=True)
    for links in list((runtime / 'node_modules').rglob('.bin')):
        require(links.is_dir() and not links.is_symlink(), 'Unexpected bin directory type')
        shutil.rmtree(links)
    for p in list((runtime / 'node_modules').rglob('*')):
        if p.is_symlink():
            raise RuntimeError('Unexpected package symlink: ' + str(p.relative_to(runtime)))
        if p.is_file() and (p.name.endswith('.node') or p.name.startswith('.env')):
            require(not p.name.endswith('.node'), 'Native addon in public dependency closure')
            p.unlink()  # Public example environment files are unnecessary runtime inputs.
    for name in ['bootstrap.cjs', 'scenario.cjs', 'ports-manifest.json']:
        (runtime / name).write_bytes(regular(HERE / name))
    (runtime / 'network-admission.mjs').write_bytes(regular(ROOT / 'test/application/app-bundle.mjs'))
    (runtime / 'package-lock.json').write_bytes(regular(project / 'package-lock.json'))
    lock_sha = sha(regular(runtime / 'package-lock.json'))
    ports_sha = sha(regular(runtime / 'ports-manifest.json'))
    compiler = project / 'compile.cjs'; compiler.write_bytes(regular(HERE / 'compile.cjs'))
    input_plan = {'sourceCommit': source_commit, 'packageVersions': packages, 'lockSha': lock_sha,
                  'portsSha': ports_sha, 'trackedSources': git('ls-files', 'src1').decode().splitlines()}
    (area / 'compiler-input.json').write_text(json.dumps(input_plan, indent=2) + '\n')
    compile_env = {'PATH': '/usr/bin:/bin', 'TMPDIR': str(area)}
    with (area / 'compiler.stdout.txt').open('wb') as out, (area / 'compiler.stderr.txt').open('wb') as err:
        result = subprocess.run([str(NODE), '--experimental-permission', '--allow-fs-read=' + str(area),
                                 '--allow-fs-read=' + str(ROOT / 'src1'), '--allow-fs-write=' + str(runtime),
                                 str(compiler), str(ROOT), str(runtime), str(area / 'compiler-input.json')],
                                cwd=project, env=compile_env, stdout=out, stderr=err, timeout=120)
    require(result.returncode == 0, 'Reviewed source transpilation failed; no application was evaluated')
    runtime_plan = json.loads(regular(runtime / 'runtime-plan.json'))
    for name in ['bootstrap.cjs', 'scenario.cjs', 'ports-manifest.json', 'prepare.py', 'compile.cjs', 'package-plan.json']:
        relative = 'test/api-runtime/scenario/' + name
        runtime_plan['sourceFiles'][relative] = sha(regular(ROOT / relative))
    for relative in ['test/application/app-bundle.mjs', 'package-lock.json']:
        runtime_plan['sourceFiles'][relative] = sha(regular(ROOT / relative))
    (runtime / 'runtime-plan.json').write_text(json.dumps(runtime_plan, indent=2) + '\n')
    files = {}; total = 0
    for p in sorted(runtime.rglob('*')):
        require(not p.is_symlink(), 'Runtime symlink')
        if p.is_file():
            data = regular(p); relative = p.relative_to(runtime).as_posix()
            require(not p.name.endswith('.node') and not p.name.startswith('.env'), 'Forbidden runtime input')
            files[relative] = sha(data); total += len(data)
    require(len(files) <= 20000 and total <= 256 * 1024 * 1024, 'Runtime template exceeds admitted bounds')
    require(git('rev-parse', 'HEAD').decode().strip() == source_commit
            and git('status', '--porcelain', '--untracked-files=all') == b'', 'Source changed during preparation')
    descriptor = {'schema': 'SD-AUTH-API-TEMPLATE-1', 'directory': str(runtime), 'files': files,
                  'sourceFiles': runtime_plan['sourceFiles'], 'sourceCommit': source_commit,
                  'packageVersions': packages, 'lockSha': lock_sha, 'portsSha': ports_sha}
    owned()
    with (area / 'runtime-template.json').open('x') as output:
        output.write(json.dumps(descriptor, indent=2) + '\n')
    destination = HERE / 'runtime-template.json'
    require(not destination.exists(), 'Existing template descriptor requires review; do not overwrite')
    with destination.open('x') as output:
        output.write(json.dumps(descriptor, indent=2) + '\n')
    (area / 'preparation-result.json').write_text(json.dumps({'status': 'PREPARED_NOT_EXECUTED', 'sourceCommit': source_commit,
        'templateSha': sha(regular(destination)), 'fileCount': len(files), 'bytes': total,
        'compilation': runtime_plan['compilation'], 'applicationEvaluations': 0, 'DockerCalls': 0}, indent=2) + '\n')
    print(json.dumps({'status': 'PREPARED_NOT_EXECUTED', 'directory': str(area), 'files': len(files), 'bytes': total}))


if __name__ == '__main__':
    main()
