#!/usr/bin/env python3
"""Read source bytes/JSON/Git only; never parse/evaluate application or JS code."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[3]
BASE = 'ed7e1e4a455114784cbb836156fffc85c276f0d6'
SCENARIO = 'test/api-runtime/scenario/scenario.cjs'
README = 'test/api-runtime/scenario/README.md'
QA = 'output/qa/week2-profile-warning-scenario/'
OTHER = {'test/api-runtime/scenario/bootstrap.cjs', 'test/api-runtime/scenario/bootstrap-unit.cjs'}
ROOT_DOCS = {'documentation/planning/implementation/M0_A_PROGRESS.md', 'documentation/planning/implementation/CONTINUATION_INSTRUCTIONS.md'}
PREFIXES = [QA, 'output/qa/week2-profile-warning-bootstrap/', 'output/qa/week2-profile-warning-contract/']
NEW = """    need(observed.effects.excluded === expected.providerDelta.deniedCapabilities
      && observed.effects.unexpected === 0 && observed.effects.excluded === 0, 'SPECIALIST_PROFILE_CAPABILITY_EFFECTS');
    need(['payments', 'storage', 'queue'].every(key => expected.providerDelta[key] === 0), 'SPECIALIST_PROFILE_DECLARED_PROVIDER_PLAN');
    assertProfileWarningBudget(observed, expected, need);"""
OLD = """    need(observed.effects.excluded === expected.providerDelta.deniedCapabilities && observed.effects.console === 0
      && ['payments', 'storage', 'queue'].every(key => expected.providerDelta[key] === 0)
      && observed.effects.unexpected === 0 && observed.effects.excluded === 0, 'SPECIALIST_PROFILE_EXCLUDED_EFFECTS');"""
EXPORT_OLD = 'module.exports = { runScenario, requireConfigurationEvidence, requireIndexEvidence };'
EXPORT_NEW = 'module.exports = { runScenario, requireConfigurationEvidence, requireIndexEvidence, assertProfileWarningBudget };'

def sha(value):
    return hashlib.sha256(value).hexdigest()

def segment(value, before, after):
    start = value.find(before)
    end = value.find(after, start)
    return value[start:end] if start >= 0 and end >= 0 else None

def inverse(source):
    start = source.find('// Pure fixture accounting;')
    end = source.find('async function runScenario(ctx) {', start)
    if start < 0 or end < 0 or source.count(NEW) != 1 or source.count(EXPORT_NEW) != 1:
        return None
    return (source[:start] + source[end:]).replace(NEW, OLD).replace(EXPORT_NEW, EXPORT_OLD)

def checks(source, baseline):
    effect = segment(source, '  function assertProfileEffects(', '  function assertProfileState(') or ''
    helper = segment(source, 'function assertProfileWarningBudget(', 'async function runScenario(ctx) {') or ''
    prior_effect = segment(baseline, '  function assertProfileEffects(', '  function assertProfileState(') or ''
    return {
        'actual_export_present': EXPORT_NEW in source and 'function assertProfileWarningBudget(observed, expected, need)' in helper,
        'actual_http_calls_same_helper': effect.count('assertProfileWarningBudget(observed, expected, need);') == 1,
        'full_other_scenario_bytes_preserved': inverse(source) == baseline,
        'prior_read_write_jwt_provider_order_preserved': effect.split('    need(observed.effects.excluded')[0] == prior_effect.split('    need(observed.effects.excluded')[0],
        'capability_latch_fixed_code': "observed.effects.unexpected === 0 && observed.effects.excluded === 0, 'SPECIALIST_PROFILE_CAPABILITY_EFFECTS'" in effect,
        'declared_provider_plan_fixed_code': "['payments', 'storage', 'queue'].every(key => expected.providerDelta[key] === 0), 'SPECIALIST_PROFILE_DECLARED_PROVIDER_PLAN'" in effect,
        'private_attempt_checks_preserved': "observed.attempts[key] === expected.privatePortalAttemptDelta[key]" in effect and "observed.attempts[key] === 0" in effect,
        'expected_writes_exact_zero_or_one': "Number.isSafeInteger(expectedWrites) && (expectedWrites === 0 || expectedWrites === 1)" in helper,
        'actual_expected_write_db_agreement': "actualDbWrites === actualWrites && expectedDbWrites === expectedWrites" in helper and "actualDbWrites === expectedDbWrites" in helper,
        'known_count_safe_and_exact': "Number.isSafeInteger(known) && known >= 0" in helper and "known === actualWrites && known === expectedWrites" in helper,
        'unknown_console_safe_residual_zero': "Number.isSafeInteger(totalConsole) && totalConsole >= 0" in helper and "totalConsole - known === 0, 'SPECIALIST_PROFILE_UNKNOWN_CONSOLE'" in helper,
        'no_default_missing_known_count': 'const known = observed?.effects?.mongooseNewAfterWarnings;' in helper,
        'no_new_public_counter': "mongooseNewAfterWarnings" not in source[source.find('  return { cases, sensitivity,'):],
        'private_counter_uses_existing_generic_delta': "effects: delta(countersAfter, countersBefore)" in source,
        'warning_check_between_prior_provider_and_private': 0 <= effect.find("'SPECIALIST_PROFILE_PROVIDER_EFFECTS'") < effect.find('assertProfileWarningBudget(observed, expected, need);') < effect.find("'SPECIALIST_PROFILE_PRIVATE_EFFECTS'"),
        'status_read_failure_codes_preserved': "'SPECIALIST_PROFILE_STATUS'" in source and "'SPECIALIST_PROFILE_ACTION_READS'" in source,
    }

source = (ROOT / SCENARIO).read_text()
baseline = subprocess.check_output(['git', 'show', BASE + ':' + SCENARIO], cwd=ROOT).decode()
results = checks(source, baseline)
controls = [
    ('ACTUAL_HTTP_BUDGET_CALL_REMOVED', 'assertProfileWarningBudget(observed, expected, need);', ''),
    ('CAPABILITY_DENIAL_REMOVED', "observed.effects.unexpected === 0 && observed.effects.excluded === 0, 'SPECIALIST_PROFILE_CAPABILITY_EFFECTS'", "true, 'SPECIALIST_PROFILE_CAPABILITY_EFFECTS'"),
    ('DECLARED_PROVIDER_PLAN_REMOVED', "['payments', 'storage', 'queue'].every(key => expected.providerDelta[key] === 0)", 'true'),
    ('PRIVATE_ATTEMPT_CHECK_REMOVED', 'observed.attempts[key] === expected.privatePortalAttemptDelta[key]', 'true'),
]
sensitivities = []
for name, before, after in controls:
    assert source.count(before) == 1, name
    weakened = checks(source.replace(before, after), baseline)
    sensitivities.append({'id': name, 'rejected': not all(weakened.values()), 'failedChecks': [key for key, value in weakened.items() if not value]})
contract = json.loads((ROOT / 'output/qa/week2-profile-warning-contract/inputs.json').read_text())
pins = {p: sha((ROOT / p).read_bytes()) == digest for p, digest in contract['repositoryFiles'].items() if p not in {SCENARIO, README} | OTHER}
artifact = json.loads((ROOT / 'output/qa/week2-api-preparation/emission-12/runtime-template.json').read_text())
production = {p: sha((ROOT / p).read_bytes()) == digest for p, digest in artifact['sourceFiles'].items() if p.startswith('src1/')}
changed = set(subprocess.check_output(['git', 'diff', '--name-only', BASE], cwd=ROOT, text=True).splitlines())
untracked = set(subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard'], cwd=ROOT, text=True).splitlines())
unknown = sorted(p for p in changed | untracked if p not in {SCENARIO, README} | OTHER | ROOT_DOCS and not any(p.startswith(prefix) for prefix in PREFIXES))
modes = all((ROOT / p).is_file() and not (ROOT / p).is_symlink() and (ROOT / p).stat().st_nlink == 1 and (ROOT / p).stat().st_mode & 0o777 == 0o644 for p in [SCENARIO, README])
unit = json.loads((ROOT / QA / 'unit.json').read_text())
passed = all(results.values()) and all(pins.values()) and all(production.values()) and len(production) == 97 and not unknown and {SCENARIO, README}.issubset(changed) and modes and all(row['rejected'] for row in sensitivities) and unit['failed'] == 0 and len(unit['weakenedVariants']) == 4
report = {'schema': 'SD-PROFILE-WARNING-SCENARIO-SOURCE-1', 'status': 'PASS' if passed else 'FAIL', 'baseline': BASE,
          'checks': results, 'checkCount': len(results), 'sourceDataControls': sensitivities,
          'unchangedContractPins': pins, 'unchangedProductionSources': production,
          'scope': {'ownedFilesChanged': {SCENARIO, README}.issubset(changed), 'unexpectedPaths': unknown,
                    'closedOtherSourceAllowance': sorted(OTHER), 'qaPrefixes': PREFIXES, 'regular644SingleLinkFiles': modes},
          'actualPureFixtureUnitFixedCases': unit['nominalFixedCases'], 'actualPureFixtureWeakenedVariants': len(unit['weakenedVariants']),
          'limits': 'Source-byte/JSON audit only; actual pure fixture export unit is separate. No application/Mongoose/TS/compiler/HTTP/DB proof. Other lane content separately reviewed.'}
print(json.dumps(report, indent=2))
sys.exit(0 if passed else 1)
