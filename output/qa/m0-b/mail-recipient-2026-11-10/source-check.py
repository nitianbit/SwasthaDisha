"""Read TypeScript as data; never import/evaluate it or invoke a provider."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[4]
BASELINE = '5aecb5578869995063eabad5bc5a4c95c79f017b'
SOURCE = 'src1/modules/email/services/index.ts'


def git(*arguments):
    return subprocess.check_output(['git', *arguments], cwd=ROOT)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(check_baseline):
    baseline = git('show', BASELINE + ':' + SOURCE)
    candidate = baseline if check_baseline else (ROOT / SOURCE).read_bytes()
    assert not re.search(rb'\b(?:cc|bcc)\s*:', candidate, re.I), 'Secondary-recipient property present'
    lines = baseline.splitlines(keepends=True)
    removed = [line for line in lines if re.fullmatch(rb'\s*cc: \[[^\r\n]+\],\r?\n', line)]
    assert len(removed) == 1, 'Expected exactly one baseline CC property'
    assert candidate == b''.join(line for line in lines if line != removed[0]), 'Unexpected source change'
    assert digest(baseline) == 'e77a0ae0da335e5f39adffab3aa9cef83201fb6f6eafe5c87f3a105bcf390261'
    assert digest(candidate) == '44049e2331f3cc9dbed9e8608f90bc9db1a0c9a2d7b43c9a8eee1e2d4c877afc'
    callers = {
        'src1/modules/auth/services/index.ts': [225, 472, 640],
        'src1/modules/bookings/services/index.ts': [100],
        'src1/modules/payment/services/index.ts': [302, 341],
        'src1/modules/externalBookings/services/index.ts': [157],
    }
    for name, locations in callers.items():
        current = (ROOT / name).read_bytes()
        assert current == git('show', BASELINE + ':' + name), 'Caller changed: ' + name
        assert [i for i, line in enumerate(current.decode().splitlines(), 1)
                if '.sendEmail(' in line] == locations, 'Call inventory changed: ' + name
    archive = ROOT / 'documentation/planning/implementation/handover/2026-11-10-local-extensions'
    for name, expected in json.loads((archive / 'artifacts.sha256.json').read_text()).items():
        assert digest((archive / name).read_bytes()) == expected, 'Archive changed: ' + name
    frozen = json.loads((archive / 'review-input.json').read_text())
    for name, expected in frozen['files_sha256'].items():
        assert digest((ROOT / name).read_bytes()) == expected, 'Staged source changed: ' + name
    patch = git('diff', '--cached', '--binary', '--full-index')
    assert patch == (archive / 'candidate.diff').read_bytes(), 'Staged patch changed'
    protected = ['package.json', 'package-lock.json', 'server.js', 'tsconfig.json',
                 'test/foundation/run.mjs', 'test/foundation/preflight.mjs',
                 'test/application/bootstrap.mjs', 'test/application/app-container.mjs']
    for name in protected:
        assert (ROOT / name).read_bytes() == git('show', BASELINE + ':' + name), 'Protected source changed: ' + name
    return {'status': 'SOURCE_ONLY_VERIFIED_RUNTIME_NOT_RUN', 'baseline': BASELINE,
            'candidate_sha256': digest(candidate), 'call_sites': 7,
            'staged_patch_sha256': digest(patch), 'typescript_evaluations': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-baseline', action='store_true', help='Expect rejection of the original recipient defect')
    options = parser.parse_args()
    try:
        print(json.dumps(verify(options.check_baseline)))
    except AssertionError as failure:
        print(json.dumps({'status': 'REJECTED', 'reason': str(failure), 'typescript_evaluations': 0}))
        raise SystemExit(1)
