"""Verify local composition as bytes/Git data; no application code is evaluated."""
import hashlib
import json
from pathlib import Path
import stat
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASE = 'eba7e5c82e3ff63af9e9a958fbd100733e1fc439'
ORIGINAL_HEAD = 'bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7'
STAGED_SHA = '00b2ad0daae9ac54adda82e8a7eb1450ca25340be4412ac76f226bfd6c45ff9a'
OWNED = 'output/qa/batch3-integration/'
SHARED = {'documentation/planning/implementation/M0_A_PROGRESS.md',
          'documentation/planning/implementation/PARALLEL_WORKSTREAMS.md'}
CODE = {
    'src1/modules/notification/routes/index.ts': 'd9fe35d82ebda24be5a1f9dd5dcd0d957dbe08bccc81969dac1eb2d834649d6b',
    'src1/modules/meet/routes/index.ts': 'e8bfff4a492ed11a18f1735528bfa4886a338b878852cde9bcea2f5d5bdd71e4',
    'src1/modules/wallet/controller/index.ts': '3b22b878fd8717b8b88620c2cb5ff3f00337f5d887beea86050fcd34d222264f',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args, cwd=ROOT):
    return subprocess.check_output(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', *args], cwd=cwd)


def paths(*args, cwd=ROOT):
    return git(*args, cwd=cwd).decode().splitlines()


def entry(rev, path):
    return git('ls-tree', rev, '--', path).decode().split('\t', 1)[0]


def verify():
    config = json.loads((ROOT / OWNED / 'lane-heads.json').read_text())
    assert config['baseline'] == BASE
    lanes = config['lanes']
    assert lanes['outbound'] == '2ea38267c361e6b3322459bcd22c2be1dc22e09c'
    assert lanes['wallet-reads'] == 'd3a1f82147c0b3346abab43e6e34d260171b0c25'
    assert set(lanes) <= {'outbound', 'wallet-reads', 'network-recipe'}
    owners = {}; counts = {}
    for lane, head in lanes.items():
        subprocess.run(['git', 'merge-base', '--is-ancestor', head, 'HEAD'], cwd=ROOT, check=True)
        changed = paths('diff', '--no-renames', '--name-only', BASE, head)
        if lane == 'network-recipe':
            assert all(path.startswith('output/qa/batch3-network-recipe/') for path in changed), 'Recipe lane exceeds preparation scope'
        counts[lane] = len(changed)
        for path in changed:
            assert path not in owners, 'Overlapping lane: ' + path
            owners[path] = lane
            assert entry('HEAD', path) == entry(head, path), 'Merged mode/content differs: ' + path
            assert (ROOT / path).read_bytes() == git('show', head + ':' + path), 'Worktree differs: ' + path
    changed = set(paths('diff', '--no-renames', '--name-only', BASE, '--'))
    untracked = set(paths('ls-files', '--others'))
    assert {p for p in changed if p.startswith('src1/')} == set(CODE), 'Production union differs'
    for path in changed | untracked:
        assert path in owners or path in SHARED or path.startswith(OWNED), 'Unexplained path: ' + path
    for path, expected in CODE.items():
        mode = (ROOT / path).lstat().st_mode
        assert stat.S_ISREG(mode) and not mode & 0o111, 'Source type/mode differs: ' + path
        assert sha((ROOT / path).read_bytes()) == expected, 'Reviewed source hash differs: ' + path
    # Because every changed path is explained above, all other tracked files,
    # including dependencies/start/harness/register, retain their baseline bytes.
    common = Path(git('rev-parse', '--git-common-dir').decode().strip())
    if not common.is_absolute():
        common = (ROOT / common).resolve()
    original = common.parent
    assert git('rev-parse', 'HEAD', cwd=original).decode().strip() == ORIGINAL_HEAD
    receipt_path = 'output/qa/m0-b/otp-containment-2026-11-10/source-verification.json'
    preserved = json.loads(git('show', ORIGINAL_HEAD + ':' + receipt_path))
    assert preserved['staged_patch_sha256'] == STAGED_SHA
    assert sha(git('diff', '--cached', '--binary', '--full-index', cwd=original)) == STAGED_SHA
    for path, expected in preserved['preserved_handover_sha256'].items():
        assert sha((original / path).read_bytes()) == expected, 'Handover differs: ' + path
    original_status = paths('status', '--porcelain', '--untracked-files=all', cwd=original)
    assert {row[3:] for row in original_status if row.startswith('?? ')} == set(preserved['preserved_handover_sha256'])
    tracked_status = [row for row in original_status if not row.startswith('?? ')]
    assert len(tracked_status) == 6 and all(row[1] == ' ' for row in tracked_status)
    return {'status': 'SOURCE_COMPOSITION_VERIFIED_DOMAIN_RUNTIME_NOT_ACCEPTED', 'baseline': BASE,
            'lane_heads': lanes, 'lane_file_counts': counts, 'production_sha256': CODE,
            'staged_patch_sha256': STAGED_SHA, 'preserved_handover_files': len(preserved['preserved_handover_sha256']),
            'unrelated_tracked_files_unchanged': True, 'TypeScript_evaluations': 0,
            'domain_runtime_scenarios': 'NOT_RUN', 'verifier_sha256': sha(Path(__file__).read_bytes())}


if __name__ == '__main__':
    print(json.dumps(verify(), indent=2))
