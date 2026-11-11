#!/usr/bin/env python3
"""Read-only source, preservation and closed feature/composition scope audit."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASE = 'ed7e1e4a455114784cbb836156fffc85c276f0d6'
OWNED = {'test/api-runtime/scenario/bootstrap.cjs', 'test/api-runtime/scenario/bootstrap-unit.cjs'}
COMPANIONS = {
    'test/api-runtime/scenario/scenario.cjs': 'cbb1260c887a7a5dc664fec9a6b47c680e1d180f78b102716122596baaae6500',
    'test/api-runtime/scenario/README.md': 'c0eb92ef72994a62e7178bb0e565605d3413265a1fea5b1ca87d77bff0254d9f',
}
QA_PREFIXES = ('output/qa/week2-profile-warning-bootstrap/', 'output/qa/week2-profile-warning-scenario/',
               'output/qa/week2-profile-warning-contract/')
checks = []


def require(value, code):
    if not value:
        raise AssertionError(code)
    checks.append(code)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True)


def once(text, before, after):
    assert text.count(before) == 1, before[:70]
    return text.replace(before, after)


inputs = json.loads((ROOT / 'output/qa/week2-profile-warning-contract/inputs.json').read_text())
for name, expected in inputs['repositoryFiles'].items():
    if name not in OWNED and name not in COMPANIONS:
        require(sha(ROOT / name) == expected, 'PRESERVED_' + name)
for name, expected in inputs['publicArtifactFiles'].items():
    item = Path(inputs['publicArtifactRoot']) / name
    require(item.is_file() and not item.is_symlink() and item.stat().st_nlink == 1 and sha(item) == expected, 'PUBLIC_SOURCE_PIN_' + name)
require(sha(ROOT / 'output/qa/week2-profile-warning-contract/CONTRACT.md') == inputs['contractSha256'], 'APPROVED_WARNING_CONTRACT')

changed = set(git('diff', '--name-only', BASE, '--').splitlines())
untracked = set(git('ls-files', '--others', '--exclude-standard').splitlines())
non_qa = {name for name in changed if not name.startswith('output/qa/')}
require(non_qa in [OWNED, OWNED | set(COMPANIONS)], 'EXACT_TWO_OR_COMPOSED_FOUR_SOURCE_UNION')
require(all(not name.startswith('output/qa/') or name.startswith(QA_PREFIXES) for name in changed), 'EXPLICIT_CHANGED_QA_PREFIXES')
require(all(name.startswith(QA_PREFIXES) for name in untracked), 'EXPLICIT_NEW_QA_PREFIXES')
composed = non_qa == OWNED | set(COMPANIONS)
for name, expected in COMPANIONS.items():
    require(sha(ROOT / name) == (expected if composed else inputs['repositoryFiles'][name]), 'EXACT_COMPANION_' + name)
for name in OWNED:
    item = ROOT / name
    require(item.is_file() and not item.is_symlink() and item.stat().st_nlink == 1
            and item.stat().st_mode & 0o777 == 0o644, 'REGULAR_644_' + item.name)
require(all(not item.is_symlink() and (item.is_dir() or (item.is_file() and item.stat().st_nlink == 1))
            for item in (ROOT / QA_PREFIXES[0]).rglob('*')), 'REGULAR_ONLY_OWN_QA')

source = (ROOT / 'test/api-runtime/scenario/bootstrap.cjs').read_text()
old_source = git('show', BASE + ':test/api-runtime/scenario/bootstrap.cjs')
inverse = once(source, 'dbWrites: 0, calendar: 0, mongooseNewAfterWarnings: 0 };', 'dbWrites: 0, calendar: 0 };')
start = inverse.index('process.emitWarning = (...args) => recordCapturedWarning(args, counters);')
end = inverse.index('// Public literals only:', start)
inverse = inverse[:start] + 'process.emitWarning = () => { counters.console++; };\n\n' + inverse[end:]
inverse = once(inverse, '  recordCapturedWarning, capturedWarningCounts, INDEX_SOURCE_SHA,', '  INDEX_SOURCE_SHA,')
require(inverse == old_source, 'COMPLETE_BOOTSTRAP_INVERSE_BYTE_EXACT')
require("for (const name of ['log', 'info', 'debug', 'warn', 'error']) console[name] = () => { counters.console++; };" in source, 'CONSOLE_LOOP_BYTES_UNCHANGED')
require('const CONFIG_EFFECT_KEYS = Object.freeze(Object.keys(counters));' in source
        and "&& (name === 'console' || effects[name] === 0)" in source, 'PRIVATE_COUNTER_IN_STRICT_CONFIG_EFFECT_KEYS')

unit = (ROOT / 'test/api-runtime/scenario/bootstrap-unit.cjs').read_text()
old_unit = git('show', BASE + ':test/api-runtime/scenario/bootstrap-unit.cjs')
inverse = once(unit, '; let nativeWarningDelegates = 0;', ';')
inverse = once(inverse, "process.emitWarning = () => { nativeWarningDelegates++; throw new Error('OFFLINE_NATIVE_WARNING_FORBIDDEN'); };\n", '')
inverse = once(inverse, " && !(request === './scenario.cjs' && parent === module)", '')
inverse = once(inverse, 'const { recordCapturedWarning, capturedWarningCounts, validateAdmissionData,', 'const { validateAdmissionData,')
inverse = once(inverse, "const { assertProfileWarningBudget } = require('./scenario.cjs');\n", '')
inverse = once(inverse, "need(typeof recordCapturedWarning === 'function' && typeof assertProfileWarningBudget === 'function', 'WARNING_ACTUAL_FUNCTIONS_REQUIRED');\n", '')
inverse = once(inverse, "'jwtIssued', 'dbWrites', 'calendar', 'mongooseNewAfterWarnings'].map", "'jwtIssued', 'dbWrites', 'calendar'].map")
inverse = once(inverse, "for (const name of ['sms', 'push', 'console', 'unexpected', 'excluded', 'dbWrites', 'mongooseNewAfterWarnings'])", "for (const name of ['sms', 'push', 'console', 'unexpected', 'excluded', 'dbWrites'])")
inverse = once(inverse, 'const warningRows = [];\n', '')
inverse = once(inverse, 'let activeWarningCase = null;\n', '')
start = inverse.index('// Actual fixture classifier and budget seam only.')
end = inverse.index('// The loader and sentinels below run only against inert public metadata', start)
inverse = inverse[:start] + inverse[end:]
inverse = once(inverse, ' + profileRows.length + warningRows.length, recordingCases:', ' + profileRows.length, recordingCases:')
inverse = once(inverse, '    warningCases: warningRows.length, nativeWarningDelegates,\n', '')
inverse = once(inverse, 'warningUnits().then(profileUnits).then(meetUnits)', 'profileUnits().then(meetUnits)')
inverse = once(inverse, ', warningCase: activeWarningCase', '')
require(inverse == old_unit, 'COMPLETE_UNIT_INVERSE_BYTE_EXACT_RETAINS_587')
require("const { assertProfileWarningBudget } = require('./scenario.cjs');" in unit
        and "'WARNING_ACTUAL_FUNCTIONS_REQUIRED'" in unit, 'UNCONDITIONAL_ACTUAL_BUDGET_SEAM_NO_SKIP')
require('capturedWarningCounts()' in unit and 'WARNING_ACTUAL_EMIT_WRAPPER_NO_NATIVE_DELEGATE' in unit
        and 'WARNING_CONSOLE_METHOD_IS_UNKNOWN_' in unit, 'ACTUAL_WRAPPERS_AND_NO_NATIVE_DELEGATE_CONTROLS')
require('WARNING_COUNTER_MONOTONIC_THROUGH_ACTUAL_LOADER_PHASE_AND_CLEANUP' in unit, 'ACTUAL_FIXTURE_PHASE_NONRESET_CONTROL')

print(json.dumps({'schema': 'SD-WARNING-BOOTSTRAP-SOURCE-AUDIT-1', 'status': 'PASS',
                  'mode': 'COMPOSED_EXACT_FOUR' if composed else 'FEATURE_EXACT_TWO',
                  'checks': checks, 'count': len(checks), 'applicationEvaluations': 0,
                  'compilerExecutions': 0, 'authority': 'SOURCE_DATA_ONLY_NOT_RUNTIME_OR_REVIEW_APPROVAL'}, separators=(',', ':')))
