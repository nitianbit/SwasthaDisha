"""Verify the second parallel batch's merged composition as source data only.

Reads files and Git objects. Never imports or evaluates TypeScript, application
modules, Docker, databases or providers. Run with a sanitized environment, e.g.
env -i PATH=/usr/bin:/bin TMPDIR=/tmp /opt/homebrew/bin/python3 -I <this file>
"""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASELINE = '9ea963f1f7b51aadedcfa7fc9918eb39a2fd737d'

# Final reviewed heads of each lane (two nonauthor reviews plus confirmed amendments).
LANES = {
    'user-route-authority': 'ea0710c405749dbc60cff2e1045fa87c68ef5789',
    'wallet-mutation-authority': '8409858a9e471812cba2aaa99d1004c8a22ee6e4',
    'foundation-network-admission': 'baaf071babae538d2bf9096e980b8e0155c9af82',
    'jwt-secret-fail-closed': '843bdb056ba3c481464ce8cd926ca28ab7ca0f33',
}

# Reviewed production and harness bytes.
REVIEWED_CODE = {
    'src1/modules/user/controller/index.ts': '25aef90efe3e5142011789dd48d55452d5b1fef9f2e56d70c355e7606e191d74',
    'src1/modules/wallet/routes/index.ts': '5ce3fc7bdd72140348df94787b0c4e47a19190ada5137a2971be84cbe584197c',
    'src1/config/config.ts': 'e879b0f9c635283d7c9a271128605c6d8583995356e30f5f1c318d23270d09f6',
    'test/application/app-bundle.mjs': '47f5ca1beec0f81a3715628c9c968df882198bfa9cc1a22f17f1eb2c619e72c2',
    'test/application/bootstrap.mjs': '23851a078af2b2311f17289378556a8871bea3e3cbcd67dede448b525f974c8c',
    'test/application/app-container.mjs': 'e0833fa33da450eb39c76a826d54c02deffdef4ec374a1ea7fcc8fac1cbbacfa',
    'test/application/app-container.test.mjs': '584e60d4b25895669c8d119a229ac181cfd7c9bd602e17481a0999bf2c67101b',
    'test/application/app-bundle.test.mjs': '4aeb825dec2b768b0964a74a2d04a4931fd640c153f3606d5cd12ec981e510df',
}

PRODUCTION_UNION = {
    'src1/modules/user/controller/index.ts',
    'src1/modules/wallet/routes/index.ts',
    'src1/config/config.ts',
}

PROTECTED = [
    'package.json', 'package-lock.json', 'server.js', 'tsconfig.json', '.env.example',
    'documentation/planning/qa/EXECUTION_REGISTER.csv',
    'test/foundation/run.mjs', 'test/foundation/preflight.mjs', 'test/foundation/preflight.test.mjs',
    'test/foundation/mongo-fixture.mjs', 'test/foundation/mongo-fixture.test.mjs',
    'test/application/app-ports.mjs', 'test/application/scenario.mjs', 'test/application/run.mjs',
    'test/application/app-image.json', 'test/application/app-runtime.json',
    'src1/modules/middleware/auth.ts', 'src1/modules/common/middleware/validation.ts',
    'src1/index.ts', 'src1/routes/index.ts',
]

# Integration-owned records the lead may add or edit; no lane touches them.
INTEGRATION_OWNED = {
    'documentation/planning/implementation/M0_A_PROGRESS.md',
    'documentation/planning/implementation/PARALLEL_WORKSTREAMS.md',
    'output/qa/parallel-integration-2/verify-source.py',
    'output/qa/parallel-integration-2/verification.json',
    'output/qa/parallel-integration-2/REVIEW.md',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args, cwd=ROOT):
    return subprocess.check_output(['git', *args], cwd=cwd)


def changed(base, head):
    return set(git('diff', '--name-only', base, head).decode().splitlines())


def verify():
    lane_files = {}
    owner = {}
    for lane, head in LANES.items():
        subprocess.run(['git', 'merge-base', '--is-ancestor', head, 'HEAD'], cwd=ROOT, check=True)
        files = changed(BASELINE, head)
        for name in files:
            assert name not in owner, 'File changed by two lanes: ' + name
            owner[name] = lane
            assert (ROOT / name).read_bytes() == git('show', head + ':' + name), \
                'Merged file differs from reviewed lane head: ' + name
        lane_files[lane] = len(files)
    for name, digest in REVIEWED_CODE.items():
        assert sha((ROOT / name).read_bytes()) == digest, 'Reviewed code hash changed: ' + name
    all_changed = changed(BASELINE, 'HEAD')
    unexplained = all_changed - set(owner) - INTEGRATION_OWNED
    assert not unexplained, 'Unexplained change: ' + ', '.join(sorted(unexplained))
    src1 = {n for n in all_changed if n.startswith('src1/')}
    assert src1 == PRODUCTION_UNION, 'Production union differs: ' + ', '.join(sorted(src1))
    for name in PROTECTED:
        assert (ROOT / name).read_bytes() == git('show', BASELINE + ':' + name), 'Protected file changed: ' + name
    untracked = git('status', '--porcelain', '--untracked-files=all').decode().splitlines()
    assert not [line for line in untracked if not line.startswith('?? output/qa/parallel-integration-2/')], \
        'Unexpected working-tree change'
    original = Path(git('rev-parse', '--git-common-dir').decode().strip()).parent
    receipt = json.loads((original / 'output/qa/m0-b/otp-containment-2026-11-10/source-verification.json').read_text())
    for name, digest in receipt['preserved_handover_sha256'].items():
        assert sha((original / name).read_bytes()) == digest, 'Original handover changed: ' + name
    assert sha(git('diff', '--cached', '--binary', '--full-index', cwd=original)) == receipt['staged_patch_sha256'], \
        'Original staged patch changed'
    return {
        'status': 'SOURCE_COMPOSITION_VERIFIED_RUNTIME_NOT_ADMITTED',
        'baseline': BASELINE,
        'lane_heads': LANES,
        'lane_file_counts': lane_files,
        'production_union': sorted(PRODUCTION_UNION),
        'reviewed_code_sha256': REVIEWED_CODE,
        'protected_files_unchanged': len(PROTECTED),
        'original_staged_patch_preserved': receipt['staged_patch_sha256'],
        'original_handover_files_preserved': len(receipt['preserved_handover_sha256']),
        'TypeScript_evaluations': 0,
        'Docker_calls': 0,
    }


if __name__ == '__main__':
    print(json.dumps(verify(), indent=2))
