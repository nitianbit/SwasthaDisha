"""Fixed pharmacy-refill public-lock/whole-module-emission producer; never import app code."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[3]
HERE = ROOT / 'test/api-runtime/pharmacy-refill'
# Reuse the existing preparation's guarded, standard-library-only metadata helpers.
spec = importlib.util.spec_from_file_location('sd_reviewed_public_lock_helpers', ROOT / 'test/api-runtime/scenario/prepare.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
require, sha, lock_rows, dependency = helpers.require, helpers.sha, helpers.lock_rows, helpers.resolved_dependency
RECEIPT = Path('/private/tmp/sd-pharmacy-refill-preparation-approval.json')
LOCK = Path('/private/tmp/sd-pharmacy-refill-resolved-lock.json')
AUTHOR = '/root/customer_remaining_audit'
OWN = ['README.md', 'profile.json', 'package-plan.json', 'ports-manifest.json', 'prepare.py', 'compile.cjs', 'bootstrap.cjs', 'scenario.cjs', 'launch.mjs', 'unit.mjs']
CONTEXT = ['test/api-runtime/profile.json', 'test/api-runtime/private-documents/profile.json', 'test/api-runtime/customer-contact/profile.json', 'test/api-runtime/launch.mjs', 'test/api-runtime/launch.test.mjs', 'test/api-runtime/platform.mjs', 'test/api-runtime/platform.test.mjs', 'test/api-runtime/unit.mjs', 'test/api-runtime/scenario/prepare.py', 'test/application/app-bundle.mjs', 'package-lock.json', 'output/qa/customer-enrollment-focused/TOOL_INPUTS.json', 'documentation/planning/implementation/PHARMACY_REFILL_FOCUSED_VERIFICATION_CONTRACT_DRAFT.md', 'output/qa/pharmacy-refill-focused/contract/SOURCE_INPUTS.json', 'output/qa/pharmacy-refill-focused/contract/DECISIONS.json', 'output/qa/pharmacy-refill-focused/contract/MAIN_CONTEXT_RECONCILIATION.json', 'output/qa/pharmacy-refill-focused/shared/INTERFACE.json']


def regular(path, cap=32 * 1024 * 1024):
    st = path.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_size <= cap, 'Nonregular or oversized producer input')
    return path.read_bytes()


def git(*args):
    return subprocess.check_output(['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false', *args],
                                   cwd=ROOT, env={'PATH': '/usr/bin:/bin'})


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in ['--resolve-lock', '--install-emit'] and sys.flags.isolated == 1
            and sys.flags.no_site == 1 and sys.flags.dont_write_bytecode == 1 and sys.dont_write_bytecode is True, 'Exact -I -B -S producer invocation')
    require(set(os.environ) <= {'PATH', 'TMPDIR', 'LANG', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING'}
            and os.environ.get('PATH') == '/usr/bin:/bin' and os.environ.get('TMPDIR') == '/private/tmp', 'Clean producer environment')
    require(os.environ.get('__CF_USER_TEXT_ENCODING') in [None, '0x' + format(os.getuid(), 'X') + ':0x0:0x0'], 'Public UID marker mismatch')
    profile = json.loads(regular(HERE / 'profile.json'))
    require(os.path.samefile(sys.executable, profile['pythonTool']) and sys.implementation.name == 'cpython'
            and '.'.join(str(x) for x in sys.version_info[:3]) == profile['pythonVersion']
            and sha(regular(Path(profile['pythonTool']))) == profile['pythonToolSha256'], 'Pinned producer Python drift')
    mode = sys.argv[1][2:]
    decision = 'APPROVE_PUBLIC_LOCK_RESOLUTION_ONLY' if mode == 'resolve-lock' else 'APPROVE_LOCKED_INSTALL_AND_EMIT_ONLY'
    ports = json.loads(regular(HERE / 'ports-manifest.json')); packages = json.loads(regular(HERE / 'package-plan.json'))['packages']
    selected = ['test/api-runtime/pharmacy-refill/' + name for name in OWN] + CONTEXT + list(ports['sourcePins'])
    hashes = {name: sha(regular(ROOT / name)) for name in selected}
    require(all(hashes[name] == digest for name, digest in ports['sourcePins'].items()), 'Selected source pins changed')
    require(git('diff', '--name-only', 'HEAD', '--', *selected) == b''
            and set(git('ls-files', '--', *selected).decode().splitlines()) == set(selected), 'Producer inputs must be committed and unchanged')
    commit = git('rev-parse', 'HEAD').decode().strip()
    receipt_meta = RECEIPT.lstat()
    require(receipt_meta.st_uid == os.getuid() and receipt_meta.st_mode & 0o777 == 0o600, 'Private producer receipt')
    receipt_bytes = regular(RECEIPT, 65536); approval = json.loads(receipt_bytes)
    expected = {'schema': 'SD-PHARMACY-REFILL-PREP-APPROVAL-1', 'decision': decision, 'sourceRoot': str(ROOT),
                'sourceCommit': commit, 'inputs': hashes, 'mode': mode}
    if mode == 'install-emit':
        require(LOCK.lstat().st_uid == os.getuid() and LOCK.lstat().st_mode & 0o777 == 0o600, 'Private resolved lock')
        expected['resolvedLockSha256'] = sha(regular(LOCK))
    require(set(approval) == set(expected) | {'nonce', 'reviewers'} and all(approval.get(k) == v for k, v in expected.items()), 'Exact producer receipt binding')
    require(re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', approval['nonce']), 'Producer nonce')
    reviewers = approval['reviewers']
    require(isinstance(reviewers, list) and len(reviewers) == 2 and len({row.get('agent') for row in reviewers}) == 2
            and all(set(row) == {'agent', 'decision'} and row['agent'] != AUTHOR and row['decision'] == decision
                    and re.fullmatch(r'/root(?:/[A-Za-z0-9_]+)*', row['agent']) for row in reviewers), 'Two actual nonauthor decisions')
    node, npm = Path(profile['nodeTool']), Path(profile['npmTool'])
    require(sha(regular(node, 128 * 1024 * 1024)) == profile['nodeToolSha256'] and sha(regular(npm)) == profile['npmToolSha256'], 'Producer Node/npm drift')
    inventory_bytes = regular(ROOT / profile['npmFiles']); require(sha(inventory_bytes) == profile['npmFilesSha256'], 'npm inventory pin')
    inventory = json.loads(inventory_bytes); tool_root = Path(inventory['root']); observed = {}
    for entry in sorted(tool_root.rglob('*')):
        require(not entry.is_symlink(), 'npm source link')
        if entry.is_file(): observed[str(entry.relative_to(tool_root))] = sha(regular(entry))
    require(observed == inventory['files'] and inventory['links'] == {} and npm == tool_root / 'bin/npm-cli.js', 'Whole npm source closure changed')
    once = Path('/private/tmp/sd-pharmacy-refill-' + mode + '-' + approval['nonce'] + '.once')
    with once.open('xb') as out:
        os.chmod(once, 0o600); out.write(json.dumps({'decision': decision, 'receiptSha256': sha(receipt_bytes)}).encode())
    area = Path('/private/tmp/sd-pharmacy-refill-build-' + str(uuid.uuid4())); area.mkdir(mode=0o700); identity = area.lstat()
    marker = {'schema': 'SD-PHARMACY-REFILL-BUILD-1', 'path': str(area), 'dev': identity.st_dev, 'ino': identity.st_ino,
              'uid': os.getuid(), 'sourceCommit': commit, 'inputs': hashes, 'mode': mode}
    (area / '.owner.json').write_text(json.dumps(marker)); os.chmod(area / '.owner.json', 0o600)
    for name in ['public', 'runtime', 'home', 'cache']:(area / name).mkdir(mode=0o700)
    project, runtime = area / 'public', area / 'runtime'
    for name in ['user.npmrc', 'global.npmrc']:(area / name).write_text('registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n')
    env = {'PATH': str(node.parent) + ':/usr/bin:/bin', 'HOME': str(area / 'home'), 'TMPDIR': str(area),
           'NPM_CONFIG_USERCONFIG': str(area / 'user.npmrc'), 'NPM_CONFIG_GLOBALCONFIG': str(area / 'global.npmrc'),
           'NPM_CONFIG_CACHE': str(area / 'cache'), 'NPM_CONFIG_IGNORE_SCRIPTS': 'true', 'NPM_CONFIG_REGISTRY': 'https://registry.npmjs.org/',
           'NPM_CONFIG_AUDIT': 'false', 'NPM_CONFIG_FUND': 'false'}
    manifest = {'name': 'sd-pharmacy-refill-fixture', 'version': '1.0.0', 'private': True, 'dependencies': packages}
    (project / 'package.json').write_text(json.dumps(manifest) + '\n')
    original = json.loads(regular(ROOT / 'package-lock.json')); retained = {}
    def retain(key):
        if key in retained:return
        row = original['packages'][key]; retained[key] = row
        for name in row.get('dependencies', {}):retain(dependency(original, key, name))
    for name in packages:retain('node_modules/' + name)
    seed = {'name': manifest['name'], 'version': '1.0.0', 'lockfileVersion': 3, 'requires': True, 'packages': {'': manifest, **retained}}
    lock_rows(seed); (project / 'package-lock.json').write_text(json.dumps(seed) + '\n')
    def owned():
        current = area.lstat()
        require(current.st_dev == identity.st_dev and current.st_ino == identity.st_ino and current.st_uid == os.getuid()
                and not area.is_symlink() and current.st_mode & 0o777 == 0o700 and json.loads(regular(area / '.owner.json')) == marker, 'Owned producer area changed')
    def execute(label, args, seconds=900):
        owned()
        with (area / (label + '.stdout.txt')).open('wb') as out, (area / (label + '.stderr.txt')).open('wb') as err:
            result = subprocess.run(args, cwd=project, env=env, stdout=out, stderr=err, timeout=seconds)
        require(result.returncode == 0, 'Producer failed; retain owned diagnostics')
    if mode == 'resolve-lock':
        require(not LOCK.exists(), 'Existing lock requires explicit disposition')
        execute('resolve', [str(node), str(npm), 'install', '--package-lock-only', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'])
        resolved_bytes = regular(project / 'package-lock.json')
    else:
        resolved_bytes = regular(LOCK); (project / 'package-lock.json').write_bytes(resolved_bytes)
    resolved = json.loads(resolved_bytes); lock_rows(resolved)
    require(resolved['packages']['']['dependencies'] == packages, 'Package root set changed')
    for name, version in packages.items():require(resolved['packages']['node_modules/' + name]['version'] == version, 'Package version changed')
    helpers.preserve_root_closures(original, resolved, list(packages))
    for name, version in json.loads(regular(HERE / 'package-plan.json'))['requiredNativeVersions'].items():
        require(resolved['packages'][dependency(resolved, 'node_modules/mongoose', name)]['version'] == version, 'Diagnostic native dependency drift')
    (area / 'resolved-lock.json').write_bytes(resolved_bytes)
    if mode == 'resolve-lock':
        owned()
        with LOCK.open('xb') as out:os.chmod(LOCK, 0o600); out.write(resolved_bytes)
        print(json.dumps({'status': 'LOCK_RESOLVED_INSTALL_NOT_RUN', 'workspace': str(area), 'sourceCommit': commit,
                          'lockSha256': sha(resolved_bytes), 'packages': len(resolved['packages']) - 1, 'applicationEvaluations': 0}))
        return
    require(not (HERE / 'runtime-template.json').exists(), 'Previous runtime template requires disposition')
    execute('install', [str(node), str(npm), 'ci', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'])
    require(sha(regular(project / 'package-lock.json')) == approval['resolvedLockSha256'], 'Install lock changed')
    shutil.copytree(project / 'node_modules', runtime / 'node_modules', symlinks=True)
    for links in list((runtime / 'node_modules').rglob('.bin')):
        require(links.is_dir() and not links.is_symlink(), 'Unexpected bin link directory'); shutil.rmtree(links)
    for entry in runtime.rglob('*'):
        require(not entry.is_symlink() and (entry.is_dir() or entry.is_file()), 'Runtime links/nonregular files')
        if entry.is_file():require(entry.suffix != '.node' and not entry.name.startswith('.env'), 'Runtime native/environment file')
    for name in ['bootstrap.cjs', 'scenario.cjs', 'ports-manifest.json']:(runtime / name).write_bytes(regular(HERE / name))
    (runtime / 'network-admission.mjs').write_bytes(regular(ROOT / 'test/application/app-bundle.mjs'))
    (runtime / 'package-lock.json').write_bytes(resolved_bytes)
    data = {'sourceCommit': commit, 'sources': {name: regular(ROOT / name).decode() for name in ports['sourcePins']},
            'ports': ports, 'lockSha': sha(resolved_bytes), 'portsSha': sha(regular(HERE / 'ports-manifest.json')), 'packageVersions': packages}
    (project / 'compiler-input.json').write_text(json.dumps(data)); (project / 'compile.cjs').write_bytes(regular(HERE / 'compile.cjs'))
    execute('compile', [str(node), '--permission', '--allow-fs-read=' + str(area), '--allow-fs-write=' + str(runtime),
                        str(project / 'compile.cjs'), str(project / 'compiler-input.json'), str(runtime)], 120)
    plan = json.loads(regular(runtime / 'runtime-plan.json'))
    # Shared platform accepts these exact producer files; receipt above additionally binds controller/operator/context.
    for name in ['bootstrap.cjs', 'scenario.cjs', 'ports-manifest.json', 'prepare.py', 'compile.cjs', 'package-plan.json', 'profile.json']:
        relative = 'test/api-runtime/pharmacy-refill/' + name; plan['sourceFiles'][relative] = hashes[relative]
    for name in ['test/application/app-bundle.mjs', 'package-lock.json']:plan['sourceFiles'][name] = hashes[name]
    (runtime / 'runtime-plan.json').write_text(json.dumps(plan) + '\n')
    files = {}; total = 0
    for entry in sorted(runtime.rglob('*')):
        require(not entry.is_symlink(), 'Runtime source link')
        if entry.is_file():
            data = regular(entry); total += len(data); files[str(entry.relative_to(runtime))] = sha(data)
    require(len(files) <= 20000 and total <= 256 * 1024 * 1024, 'Runtime file/byte bound')
    require(git('rev-parse', 'HEAD').decode().strip() == commit and all(sha(regular(ROOT / name)) == digest for name, digest in hashes.items()), 'Producer source changed')
    owned()
    descriptor = {'schema': 'SD-PHARMACY-REFILL-API-TEMPLATE-1', 'directory': str(runtime), 'files': files,
                  'sourceFiles': plan['sourceFiles'], 'sourceCommit': commit, 'packageVersions': packages,
                  'lockSha': sha(resolved_bytes), 'portsSha': sha(regular(HERE / 'ports-manifest.json'))}
    with (area / 'runtime-template.json').open('x') as out:out.write(json.dumps(descriptor, indent=2) + '\n')
    with (HERE / 'runtime-template.json').open('x') as out:out.write(json.dumps(descriptor, indent=2) + '\n')
    print(json.dumps({'status': 'PREPARED_NOT_EXECUTED', 'workspace': str(area), 'templateSha256': sha(regular(HERE / 'runtime-template.json')),
                      'sourceCommit': commit, 'files': len(files), 'bytes': total, 'applicationEvaluations': 0, 'DockerCalls': 0}))


if __name__ == '__main__':main()
