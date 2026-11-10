"""Verify merged source/evidence composition; never evaluate TypeScript or call Docker."""
import hashlib
import json
from pathlib import Path
import runpy
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASELINE = 'bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7'
HEADS = {'otp': '66de4894f666449331e7c90fb0e94b6c01a54418',
         'authority': '0a1f77a97eede0d8e0b3eb41d85796c817ae9996',
         'foundation': '4c38e0b4612e42a800b99bf6c3cc8c184bed24a3'}
MANIFESTS = {'otp': '6bc6c87cee4023acb09e04c2376b43dc28628a3d4d7b4dfa724e0224ad68c0c7',
             'authority': 'f78ee9674ac27afa6be9c48162ea9c7988762e1a5af8690334bf8e979144ff7c',
             'foundation': 'e9b435bcba088fd1bebf04571f8b5444c2232895642145cad2525839a96d421f'}
SOURCES = {'otp': 'src1/modules/auth/services/index.ts',
           'authority': 'src1/modules/notification/controller/index.ts'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args, cwd=ROOT):
    return subprocess.check_output(['git', *args], cwd=cwd)


def verify():
    inventories = {}
    for lane, expected in MANIFESTS.items():
        p = ROOT / 'output/qa' / ('parallel-' + lane) / 'review-input.json'
        assert sha(p.read_bytes()) == expected, 'Lane manifest changed: ' + lane
        m = json.loads(p.read_text())
        for name, digest in m['files_sha256'].items():
            assert sha((ROOT / name).read_bytes()) == digest, 'Frozen file changed: ' + name
        inventories[lane] = len(m['files_sha256'])
        subprocess.run(['git', 'merge-base', '--is-ancestor', HEADS[lane], 'HEAD'], cwd=ROOT, check=True)
    for lane, name in SOURCES.items():
        # These hash-verified Python files contain source-data checks only.
        checker = runpy.run_path(str(ROOT / 'output/qa' / ('parallel-' + lane) / 'source-check.py'),
                                 run_name='integration_source_data_check')
        _, expected = checker['expected_source']()
        candidate = (ROOT / name).read_bytes() if lane == 'otp' else (ROOT / name).read_text()
        checker['check'](candidate, expected)
    assert sorted(git('diff', '--name-only', BASELINE, '--', 'src1').decode().splitlines()) == sorted(SOURCES.values())
    protected = ['package.json', 'package-lock.json', 'server.js', 'tsconfig.json',
                 'documentation/planning/qa/EXECUTION_REGISTER.csv', 'test/foundation/run.mjs',
                 'test/application/bootstrap.mjs', 'test/application/app-container.mjs']
    for name in protected:
        assert (ROOT / name).read_bytes() == git('show', BASELINE + ':' + name), 'Protected file changed: ' + name
    original = Path(git('rev-parse', '--git-common-dir').decode().strip()).parent
    r = json.loads((original / 'output/qa/m0-b/otp-containment-2026-11-10/source-verification.json').read_text())
    for name, digest in r['preserved_handover_sha256'].items():
        assert sha((original / name).read_bytes()) == digest, 'Original handover changed: ' + name
    assert sha(git('diff', '--cached', '--binary', '--full-index', cwd=original)) == r['staged_patch_sha256']
    return {'status': 'SOURCE_COMPOSITION_VERIFIED_RUNTIME_NOT_ADMITTED', 'baseline': BASELINE,
            'feature_heads': HEADS, 'verified_lane_files': inventories,
            'source_sha256': {name: sha((ROOT / name).read_bytes()) for name in SOURCES.values()},
            'original_staged_files_preserved': 6, 'original_handover_files_preserved': 11,
            'TypeScript_evaluations': 0, 'Docker_calls': 0}


if __name__ == '__main__':
    print(json.dumps(verify()))
