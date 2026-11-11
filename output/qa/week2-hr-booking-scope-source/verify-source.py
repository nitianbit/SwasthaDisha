#!/usr/bin/env python3
"""Read-only literal source gate. Never parse, import or execute TypeScript."""
import argparse
import hashlib
import json
from pathlib import Path
import stat
import subprocess
import sys

QA = Path(__file__).resolve().parent
ROOT = QA.parents[2]
AMENDMENT = json.loads((QA / 'amendment.json').read_text())
DECLARATIONS = json.loads((QA / 'declarations.json').read_text())['checks']
PRODUCTION = tuple(AMENDMENT['files'])
OWN_QA = 'output/qa/week2-hr-booking-scope-source/'
CONTRACT_QA = ROOT / 'output/qa/week2-hr-booking-scope'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def bounds(text, region):
    if region == 'file':
        return 0, len(text)
    if region == 'resolver':
        return text.index('  private resolveHRBookingReadScope('), text.index('  private getHRCorporateId(')
    start = text.index('  async getAll(\n')
    end = text.index('  async update(\n', start)
    if region == 'getAll':
        return start, end
    if region == 'scoped':
        return text.index('    if (requiredCorporateId !== undefined) {', start), text.index('    if (queryParams.page && queryParams.limit) {', start)
    raise ValueError('Unknown source region')


def baseline_and_expected():
    original = {p: git('show', AMENDMENT['baseline'] + ':' + p).decode() for p in PRODUCTION}
    expected = dict(original)
    for p in PRODUCTION:
        if sha(original[p].encode()) != AMENDMENT['files'][p]['baselineSha256']:
            raise ValueError('BASELINE_PIN:' + p)
    for hunk in AMENDMENT['hunks']:
        text = expected[hunk['file']]
        if text.count(hunk['old']) != 1:
            raise ValueError('FORWARD_ANCHOR:' + hunk['id'])
        expected[hunk['file']] = text.replace(hunk['old'], hunk['new'], 1)
    for p in PRODUCTION:
        if sha(expected[p].encode()) != AMENDMENT['files'][p]['candidateSha256']:
            raise ValueError('CONSTRUCTION_PIN:' + p)
    return original, expected


def source_errors(source, original, expected):
    errors = []
    for p in PRODUCTION:
        if source[p] != expected[p]:
            errors.append('EXACT_SOURCE:' + p)
    reversed_source = dict(source)
    for hunk in reversed(AMENDMENT['hunks']):
        text = reversed_source[hunk['file']]
        if text.count(hunk['new']) != 1:
            errors.append('INVERSE_ANCHOR:' + hunk['id'])
            continue
        reversed_source[hunk['file']] = text.replace(hunk['new'], hunk['old'], 1)
    for p in PRODUCTION:
        if reversed_source[p] != original[p]:
            errors.append('FULL_FILE_INVERSE:' + p)
    for check in DECLARATIONS:
        try:
            a, b = bounds(source[check['file']], check['region'])
            passed = check['contains'] in source[check['file']][a:b]
        except ValueError:
            passed = False
        if not passed:
            errors.append('DECL:' + check['id'])
    return errors


def environment_errors():
    errors = []
    authority = AMENDMENT['authority']
    for name, key in [('CONTRACT.md', 'contract'), ('inputs.json', 'inputs'), ('contract-freeze.json', 'freeze'), ('PRE_REVIEW.md', 'preReview')]:
        if sha((CONTRACT_QA / name).read_bytes()) != authority[key]:
            errors.append('AUTHORITY_PIN:' + name)
    frozen = json.loads((CONTRACT_QA / 'contract-freeze.json').read_text())
    for p, expected_sha in frozen['files'].items():
        if p not in PRODUCTION and sha((ROOT / p).read_bytes()) != expected_sha:
            errors.append('DEPENDENCY_PIN:' + p)
    for p, expected_sha in frozen['clientFiles'].items():
        if sha((Path(frozen['clientRoot']) / p).read_bytes()) != expected_sha:
            errors.append('CLIENT_PIN:' + p)
    changed = set(filter(None, git('diff', '--name-only', '-z', AMENDMENT['baseline'], '--').decode().split('\0')))
    changed.update(filter(None, git('ls-files', '--others', '--exclude-standard', '-z').decode().split('\0')))
    non_qa = {p for p in changed if not p.startswith(OWN_QA)}
    if non_qa != set(PRODUCTION):
        errors.append('EXACT_NON_QA_CHANGE_UNION')
    for p in PRODUCTION:
        info = (ROOT / p).lstat()
        entry = git('ls-tree', AMENDMENT['baseline'], '--', p).decode().split()
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o644 or entry[0] != '100644':
            errors.append('SOURCE_MODE:' + p)
    return errors, sorted(changed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--controls', action='store_true')
    args = parser.parse_args()
    original, expected = baseline_and_expected()
    source = {p: (ROOT / p).read_text() for p in PRODUCTION}
    errors = source_errors(source, original, expected)
    env_errors, changed = environment_errors()
    errors.extend(env_errors)
    result = {'status': 'SOURCE_ONLY_PASS' if not errors else 'SOURCE_ONLY_FAIL', 'baseline': AMENDMENT['baseline'], 'sourceHashes': {p: sha(s.encode()) for p, s in source.items()}, 'errors': errors, 'declarations': len(DECLARATIONS), 'hunks': len(AMENDMENT['hunks']), 'gitVisibleChanges': changed, 'executedTypeScript': False, 'applicationEffects': 'NOT_EXECUTED_OR_MEASURED', 'futureHTTPTrials': '103_NOT_ADMITTED', 'futureRuntimeVariants': '8_NOT_ADMITTED', 'integration': 'HELD_FOR_SPECIALIST90_AND_ROOT_EXCLUDED_SOURCE_PROVENANCE_REVIEW'}
    if args.controls and not errors:
        controls = json.loads((QA / 'source-controls.json').read_text())['controls']
        results = []
        for control in controls:
            mutated = dict(source)
            a, b = bounds(mutated[control['file']], control['region'])
            region = mutated[control['file']][a:b]
            if region.count(control['old']) != 1:
                raise ValueError('CONTROL_ANCHOR:' + control['id'])
            region = region.replace(control['old'], control['new'], 1)
            mutated[control['file']] = mutated[control['file']][:a] + region + mutated[control['file']][b:]
            found = source_errors(mutated, original, expected)
            rejected = control['requiredFailure'] in found
            results.append({'id': control['id'], 'requiredFailure': control['requiredFailure'], 'rejected': rejected, 'mutatedSourceSha256': sha(mutated[control['file']].encode()), 'errors': found})
            if not rejected:
                errors.append('CONTROL_NOT_REJECTED:' + control['id'])
        result['sourceControls'] = results
        result['sourceControlsRejected'] = sum(x['rejected'] for x in results)
        result['status'] = 'SOURCE_ONLY_PASS' if not errors else 'SOURCE_ONLY_FAIL'
    print(json.dumps(result, indent=2))
    return 0 if not errors else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(json.dumps({'status': 'SOURCE_GATE_ERROR', 'category': type(error).__name__, 'detail': str(error)}))
        sys.exit(2)
