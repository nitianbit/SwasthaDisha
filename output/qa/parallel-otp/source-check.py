"""Verify the OTP generation amendment as source data; evaluate no TypeScript."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASELINE = 'bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7'
SOURCE = 'src1/modules/auth/services/index.ts'
IMPORT = b"import { randomInt } from 'node:crypto';\n"
OLD = b'Math.floor(100000 + Math.random() * 900000).toString()'
NEW = b'randomInt(100000, 1000000).toString()'


def git(*arguments):
    return subprocess.check_output(['git', *arguments], cwd=ROOT)


def expected_source():
    baseline = git('show', BASELINE + ':' + SOURCE)
    assert hashlib.sha256(baseline).hexdigest() == 'cfdc147df14c4bb9f9974d7211a8cabc3b3af5af2a4ec562a71c2bcaadbe03ad'
    assert baseline.count(OLD) == 3 and IMPORT not in baseline
    return baseline, IMPORT + baseline.replace(OLD, NEW)


def check(candidate, expected):
    assert candidate.count(IMPORT) == 1, 'Expected one named node:crypto import'
    assert b'Math.random' not in candidate, 'Non-cryptographic randomness remains'
    assert candidate.count(NEW) == 3, 'Expected three exact six-digit crypto generators'
    assert candidate == expected, 'Source differs from the minimal reviewed amendment'


def verify(negative_controls):
    baseline, expected = expected_source()
    if negative_controls:
        parts = expected.split(NEW)
        assert len(parts) == 4
        cases = [('original_source', baseline)]
        for selected in range(3):
            restored = parts[0]
            for index in range(3):
                restored += (OLD if index == selected else NEW) + parts[index + 1]
            cases.append(('original_generator_' + str(selected + 1), restored))
        cases += [
            ('incorrect_lower_bound', expected.replace(NEW, b'randomInt(0, 1000000).toString()', 1)),
            ('incorrect_upper_bound', expected.replace(NEW, b'randomInt(100000, 999999).toString()', 1)),
            ('missing_crypto_import', expected.removeprefix(IMPORT)),
            ('insecure_fallback', expected + b'\nconst fallback = Math.random;\n'),
            ('unrelated_edit', expected + b'\n// Unreviewed source change\n'),
        ]
        rejected = []
        for name, candidate in cases:
            try:
                check(candidate, expected)
            except AssertionError:
                rejected.append(name)
            else:
                raise AssertionError('Source-negative control was accepted: ' + name)
        return {'status': 'SOURCE_CONTROLS_REJECTED', 'controls': rejected, 'typescript_evaluations': 0}
    check((ROOT / SOURCE).read_bytes(), expected)
    changed = git('diff', '--name-only', BASELINE, '--', 'src1').decode().splitlines()
    assert changed == [SOURCE], 'Unexpected production source change'
    return {'status': 'SOURCE_ONLY_VERIFIED_RUNTIME_NOT_RUN', 'baseline': BASELINE,
            'source_sha256': hashlib.sha256(expected).hexdigest(), 'sites': 3,
            'typescript_evaluations': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--negative-controls', action='store_true')
    arguments = parser.parse_args()
    try:
        print(json.dumps(verify(arguments.negative_controls)))
    except AssertionError as failure:
        print(json.dumps({'status': 'REJECTED', 'reason': str(failure), 'typescript_evaluations': 0}))
        raise SystemExit(1)
