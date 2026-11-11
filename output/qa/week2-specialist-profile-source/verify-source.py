#!/usr/bin/env python3
"""Read TypeScript as UTF-8 bytes only; never import/evaluate/transpile it."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
BASE = 'b33a9daac01628a48043e85764819a5f855431ed'
TARGET = 'src1/modules/specialistPortal/services/index.ts'
CONTRACT = 'output/qa/week2-specialist-profile/CONTRACT.md'
CONTRACT_SHA = '2a49c33b6b7b93d50be5c6c04f5ec863a8d5848ab6d5120a61870b695b8ccc39'
FREEZE = 'output/qa/week2-specialist-profile/contract-freeze.json'
FREEZE_SHA = 'b20a62c41e1697c592b39a2e02a68059c35641a985134c05cec094f5cd96b740'
BASE_SOURCE_SHA = 'f5d90a49987bcc312b7b4acd614ba6833e5551b601f17ff5097d4d1ef9351ed4'
OLD = """  async updateProfile(
    specialistId: string,
    body: UpdateSpecialistRequest
  ): Promise<ISpecialist> {
    return this.specialistService.update(specialistId, body);
  }
"""
NEW = """  async updateProfile(
    specialistId: string,
    body: UpdateSpecialistRequest
  ): Promise<ISpecialist> {
    if (
      body !== null &&
      typeof body === 'object' &&
      ['isVerified', 'isActive', 'rating'].some((field) =>
        Object.prototype.hasOwnProperty.call(body, field)
      )
    ) {
      await this.specialistService.getById(specialistId);
      throw new AppError({
        status: 422,
        code: 'FORBIDDEN_FIELD',
        message: 'Specialist profile contains fields that cannot be updated',
      });
    }

    return this.specialistService.update(specialistId, body);
  }
"""


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def require(ok, label):
    if not ok:
        raise AssertionError(label)


def source_policy(text, baseline):
    errors = []
    if text.count(NEW) != 1:
        errors.append('EXACT_SELF_COMMAND_GUARD_MISSING_OR_AMENDED')
    if text.replace(NEW, OLD) != baseline:
        errors.append('OUTSIDE_GUARD_BYTES_CHANGED')
    return errors


def scope_policy(changes):
    return changes == [] or changes == [TARGET]


def main():
    require(sys.argv[1:] in ([], ['--baseline']), 'FIXED_INVOCATION')
    baseline_bytes = git('show', BASE + ':' + TARGET)
    require(sha(baseline_bytes) == BASE_SOURCE_SHA, 'BASELINE_SOURCE_PIN')
    baseline = baseline_bytes.decode('utf8')
    require(baseline.count(OLD) == 1, 'UNIQUE_OLD_SELF_COMMAND')
    candidate = baseline.replace(OLD, NEW)
    require(not source_policy(candidate, baseline), 'DECLARED_CANDIDATE_REJECTED')
    require(source_policy(baseline, baseline), 'UNMODIFIED_BASELINE_ACCEPTED')
    require(sha((ROOT / CONTRACT).read_bytes()) == CONTRACT_SHA, 'CONTRACT_PIN')
    require(sha((ROOT / FREEZE).read_bytes()) == FREEZE_SHA, 'FREEZE_PIN')
    frozen = json.loads((ROOT / FREEZE).read_text())
    for path, expected in frozen['files'].items():
        require(sha(git('show', BASE + ':' + path)) == expected if path.startswith('src1/') or path.startswith('test/') else True, 'BASELINE_PIN:' + path)
        if path != TARGET:
            require(sha((ROOT / path).read_bytes()) == expected, 'UNCHANGED_PIN:' + path)
    changes = git('diff', '--name-only', BASE, '--').decode().splitlines()
    require(scope_policy(changes), 'WHOLE_TRACKED_TREE_SCOPE')
    diffraw = git('diff', '--raw', BASE, '--', TARGET).decode()
    require(not diffraw or diffraw.startswith(':100644 100644 '), 'SOURCE_MODE_CHANGE')
    current = (ROOT / TARGET).read_bytes()
    require((ROOT / TARGET).is_file() and not (ROOT / TARGET).is_symlink(), 'REGULAR_SOURCE')
    current_errors = source_policy(current.decode('utf8'), baseline)
    if sys.argv[1:] == ['--baseline']:
        require(current == baseline_bytes and changes == [], 'ACTUAL_BASELINE_ALREADY_CHANGED')
        print(json.dumps({'schema': 'SD-SPECIALIST-SOURCE-BASELINE-1', 'baseline': BASE,
            'sourceSha256': sha(current), 'verifierSha256': sha(Path(__file__).read_bytes()),
            'actualBaselineRejected': bool(current_errors), 'candidateAccepted': not current_errors,
            'sourceDataOnly': True, 'applicationEvaluations': 0}, indent=2))
        return 0
    controls = []
    def reject(label, before, after):
        require(candidate.count(before) == 1, 'CONTROL_ANCHOR:' + label)
        altered = candidate.replace(before, after)
        require(source_policy(altered, baseline), 'SOURCE_CONTROL_SURVIVED:' + label)
        controls.append(label)
    for field in ['isVerified', 'isActive', 'rating']:
        reject('OMIT_' + field, "'" + field + "'", "'unprotected'" )
    reject('TRUTHINESS_FALSE_ZERO_UNDEFINED', 'Object.prototype.hasOwnProperty.call(body, field)', 'Boolean(body[field])')
    reject('INHERITED_PROPERTY_AS_OWN', 'Object.prototype.hasOwnProperty.call(body, field)', 'field in body')
    reject('OWN_METHOD_SHADOWING', 'Object.prototype.hasOwnProperty.call(body, field)', 'body.hasOwnProperty(field)')
    reject('NULL_BECOMES_NEW_ERROR', '      body !== null &&\n', '')
    reject('NONOBJECT_BECOMES_NEW_ERROR', "      typeof body === 'object' &&\n", '')
    reject('ONLY_ALL_FIELDS_DENIED', "].some((field) =>", "].every((field) =>")
    reject('SKIP_EXISTENCE_404', '      await this.specialistService.getById(specialistId);\n', '')
    reject('UNAWAITED_LOOKUP', '      await this.specialistService.getById(specialistId);', '      this.specialistService.getById(specialistId);')
    reject('WRONG_OBJECT_LOOKUP', '      await this.specialistService.getById(specialistId);', "      await this.specialistService.getById('other');")
    reject('WRONG_DENIAL_STATUS', '        status: 422,', '        status: 403,')
    reject('WRONG_DENIAL_CODE', "        code: 'FORBIDDEN_FIELD',", "        code: 'VALIDATION_ERROR',")
    reject('RAW_VALUE_ERROR_LEAK', "        message: 'Specialist profile contains fields that cannot be updated',", '        message: JSON.stringify(body),')
    reject('DENIAL_NOT_THROWN', '      await this.specialistService.getById(specialistId);\n      throw new AppError({', '      await this.specialistService.getById(specialistId);\n      new AppError({')
    reject('PREMATURE_WRITE', '      await this.specialistService.getById(specialistId);', '      await this.specialistService.update(specialistId, body);\n      await this.specialistService.getById(specialistId);')
    reject('SILENT_FIELD_DELETION', '      await this.specialistService.getById(specialistId);', '      delete body.isVerified;\n      await this.specialistService.getById(specialistId);')
    reject('EXTRA_ALLOWED_PATH_READ', '    return this.specialistService.update(specialistId, body);\n  }\n\n  async createSlot(', '    await this.specialistService.getById(specialistId);\n    return this.specialistService.update(specialistId, body);\n  }\n\n  async createSlot(')
    reject('CHANGED_ALLOWED_DELEGATION', '    return this.specialistService.update(specialistId, body);\n  }\n\n  async createSlot(', '    return this.specialistService.update(specialistId, {});\n  }\n\n  async createSlot(')
    # Reorder only text: forbidden throw would run before the awaited lookup.
    lookup = '      await this.specialistService.getById(specialistId);\n'
    altered = candidate.replace(lookup, '', 1)
    close = "        message: 'Specialist profile contains fields that cannot be updated',\n      });"
    require(altered.count(close) == 1, 'REORDER_CONTROL_ANCHOR')
    altered = altered.replace(close, close + '\n' + lookup.rstrip('\n'))
    require(source_policy(altered, baseline), 'LOOKUP_AFTER_THROW_SURVIVED')
    controls.append('LOOKUP_AFTER_THROW')
    scope_controls = [TARGET, 'src1/modules/specialists/validation/index.ts'], [TARGET, 'src1/modules/specialists/services/index.ts'], [TARGET, 'package.json'], [TARGET, 'test/api-runtime/scenario/bootstrap.cjs']
    for changed in scope_controls:
        require(not scope_policy(changed), 'SCOPE_CONTROL_SURVIVED')
    print(json.dumps({'schema': 'SD-SPECIALIST-SOURCE-CHECK-1', 'baseline': BASE,
        'contractSha256': CONTRACT_SHA, 'baselineRejected': True, 'currentCandidateAccepted': not current_errors,
        'candidateSha256': sha(candidate.encode()), 'currentSha256': sha(current),
        'verifierSha256': sha(Path(__file__).read_bytes()), 'sourceControlsRejected': len(controls),
        'sourceControls': controls, 'scopeControlsRejected': len(scope_controls),
        'frozenInputPinsChecked': len(frozen['files']), 'trackedDiffScope': changes,
        'sourcePolicyErrors': current_errors, 'sourceDataOnly': True,
        'applicationEvaluations': 0, 'joiEvaluations': 0, 'compilerExecutions': 0,
        'databaseCommands': 0, 'providerCalls': 0, 'runtimeStatus': 'NOT_RUN'}, indent=2))
    return 0 if not current_errors else 1


if __name__ == '__main__':
    raise SystemExit(main())
