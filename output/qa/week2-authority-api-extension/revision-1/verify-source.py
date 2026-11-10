"""Read-only source/data gate. Does not evaluate JS/TS, packages or application code."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASELINE = '94f8804916850caf9c716fae2cc49c6c0d218202'
CONTRACT_SHA = '23f37d31fe77565ce7d5d04689b777d5f539dd079d787b26ca6346e5e42c4f90'
PREFIX = 'test/api-runtime/scenario/'
FILES = [PREFIX + name for name in ['scenario.cjs', 'compile.cjs', 'README.md']]


def require(ok, code):
    if not ok:
        raise ValueError(code)


def git(*args):
    return subprocess.check_output(['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false', *args],
                                   cwd=ROOT, env={'PATH': '/usr/bin:/bin', 'TMPDIR': '/private/tmp'}, text=True)


contract = (ROOT / 'output/qa/week2-authority-api-extension/CONTRACT.md').read_text()
require(hashlib.sha256(contract.encode()).hexdigest() == CONTRACT_SHA, 'CONTRACT_BYTES')
append = json.loads(re.findall(r'```json\n(.*?)\n```', contract, re.S)[-1])
old = {path: git('show', BASELINE + ':' + path) for path in FILES}
old_ports = json.loads(git('show', BASELINE + ':' + PREFIX + 'ports-manifest.json'))
expected_cases = old_ports['requiredCaseIds'] + append['appendRequiredCaseIds']
expected_mutants = old_ports['requiredSensitivityIds'] + append['appendRequiredSensitivityIds']
require(len(expected_cases) == 53 and len(expected_mutants) == 14, 'CONTRACT_ID_COUNTS')
old_main = old[FILES[0]].split('  const alpha =', 1)[1].split('  // Separate negative phases', 1)[0]
old_mutants = old[FILES[0]].split('  const mutations =', 1)[1].split('  for (const [name, alias, probe] of mutations)', 1)[0]
old_compiler_mutants = old[FILES[1]].split("  mutate('OTP_UNCONDITIONAL_CONSUME'", 1)[1].split('  // Retain focused semantic', 1)[0]
old_compiler_tail = old[FILES[1]].split('  // Retain focused semantic', 1)[1]


def inspect(texts):
    scenario, compiler, readme = [texts[path] for path in FILES]
    require(old_main in scenario and old_mutants in scenario, 'CORE_36_AND_FOUR_PRESERVATION')
    for name in ['overlap', 'targetProbe', 'rejectChallenge']:
        start = old[FILES[0]].index('  async function ' + name + '(')
        end = old[FILES[0]].index('\n  }', start) + 4
        require(old[FILES[0]][start:end] in scenario, 'CORE_PREDICATE_PRESERVATION')
    require(old_compiler_mutants in compiler and old_compiler_tail in compiler, 'CORE_MUTANTS_DIAGNOSTICS_PRESERVATION')
    dynamic = {'OTHER_USER_READ_DENIED', 'OTHER_USER_UPDATE_DENIED', 'OTHER_USER_DELETE_DENIED', 'USER_LIST_DENIED',
               'WRONG_OTP_DENIED', 'CONSUMED_OTP_DENIED', 'EXPIRED_OTP_DENIED', 'UNBOUND_OTP_DENIED'}
    records = re.findall(r"record\('([A-Z_]+)'\)", scenario)
    require(len(records) == len(set(records)) and set(records) | dynamic == set(expected_cases), 'EXACT_CASE_DECLARATIONS')
    declared_mutants = re.findall(r"  mutate\('([A-Z_]+)'", compiler)
    require(declared_mutants == expected_mutants, 'EXACT_MUTANT_DECLARATIONS')
    require(all("['" + name + "', '@/" in scenario for name in expected_mutants), 'MUTANT_HTTP_PROBES')
    markers = [
        "ctx.ports.models.map(row => row.name).filter(name => includeOTP || name !== 'OTP')",
        'completedProofs.set(id(row), String(user._id));',
        "await model('OTP').deleteOne({ _id: proofId, userId: ownerId });",
        "record('OTP_INFLIGHT_EXPIRY_DENIED');\n\n  await cleanCompletedProofs();\n  await runAuthorityNominal(admin.token);",
        "finally { await cleanCompletedProofs(); await ctx.nextPhase({}); }",
        'const before = await authorityRows(); const countersBefore = { ...ctx.counters };',
        'const readsBefore = { ...ctx.readOps }; const writesBefore = { ...ctx.writeOps };',
        'const after = await authorityRows();',
        "'AUTHORITY_UNRELATED_STATE'", "'AUTHORITY_UNINTENDED_FIELDS'", "'AUTHORITY_WRITE_COUNTS'",
        "need(observed.result.status === status, 'AUTHORITY_DENIAL_STATUS'); errorEnvelope(observed.result, code);",
        'unchangedOutside(observed); effects(observed, {}, 0, 1);',
        "if (beforeLookup) need(Object.values(observed.reads).every(value => value === 0), 'AUTHORITY_PRELOOKUP_READS');",
        'observed.effects.logger === logger',
        "ctx.counters.unexpected++; need(false, 'AUTHORITY_PUSH_PAYLOAD');",
        "detectedFailure(() => assertDenied(observed, status, code, beforeLookup), 'AUTHORITY_DENIAL_STATUS')",
        "detectedFailure(() => totalRows(observed.result.body, total), 'AUTHORITY_LIST_TOTAL')",
        "const routes = name === 'Dependent' ? ['GET', 'PUT', 'DELETE'] : ['GET', 'PUT', 'PATCH', 'DELETE'];",
        "await ctx.nextPhase({}); await probe(actors, false);",
        'await cleanupSensitivityRows(before, [actors.owner, actors.other]);',
        "await model(name).deleteOne({ _id: row._id, ...(name === 'User' ? {} : { userId: row.userId }) })",
        "need(same(await authorityRows(), before), 'AUTHORITY_SENSITIVITY_CLEANUP');",
    ]
    require(all(marker in scenario for marker in markers), 'AUTHORITY_SOURCE_BOUNDARIES')
    require(scenario.index('await runAuthorityNominal(admin.token);') < scenario.index('const nominalCounters =')
            < scenario.index('await runAuthoritySensitivity(admin.token);'), 'NOMINAL_COUNTER_ORDER')
    require('declarations.length === 13 && ports.models.length === 13' in compiler
            and "expectRejected('OMITTED_DEPENDENT'" in compiler
            and "requireThat(Object.hasOwn(sources, relative), 'MUTANT_SOURCE_NOT_ADMITTED');" in compiler
            and "JSON.stringify(Object.keys(mutants)) === JSON.stringify(ports.requiredSensitivityIds)" in compiler,
            'COMPILER_ADMISSION_AND_MODEL_CONTROLS')
    require('53 nominal IDs/14 sensitivity IDs and13 models' in readme and 'NOT_RUN' in readme, 'README_STATUS')
    require('status: \'SKIP\'' not in scenario and 'skipped: 0' in scenario, 'NO_SKIP')


def rejected(texts):
    try:
        inspect(texts)
    except ValueError:
        return True
    return False


candidate = {path: (ROOT / path).read_text() for path in FILES}
require(rejected(old), 'BASELINE_MUST_REJECT')
inspect(candidate)
controls = [
    (FILES[0], "ctx.ports.models.map(row => row.name).filter(name => includeOTP || name !== 'OTP')", "['User']"),
    (FILES[0], 'completedProofs.set(id(row), String(user._id));', ''),
    (FILES[0], "await model('OTP').deleteOne({ _id: proofId, userId: ownerId });", "await model('OTP').deleteOne({ _id: proofId });"),
    (FILES[0], "  await cleanCompletedProofs();\n  await runAuthorityNominal(admin.token);", '  await runAuthorityNominal(admin.token);'),
    (FILES[0], 'const readsBefore = { ...ctx.readOps };', 'const readsBefore = {};'),
    (FILES[0], "need(digest(retain(observed.before[spec.name])) === digest(retain(observed.after[spec.name])), 'AUTHORITY_UNRELATED_STATE');", ""),
    (FILES[0], "need(prior && next && same(retained(prior), retained(next)), 'AUTHORITY_UNINTENDED_FIELDS');", ""),
    (FILES[0], 'unchangedOutside(observed); effects(observed, {}, 0, 1);', ''),
    (FILES[0], "if (beforeLookup) need(Object.values(observed.reads).every(value => value === 0), 'AUTHORITY_PRELOOKUP_READS');", ''),
    (FILES[0], 'observed.effects.logger === logger', 'true'),
    (FILES[0], "ctx.counters.unexpected++; need(false, 'AUTHORITY_PUSH_PAYLOAD');", "need(false, 'AUTHORITY_PUSH_PAYLOAD');"),
    (FILES[0], "await ctx.nextPhase({}); await probe(actors, false);", 'await ctx.nextPhase({});'),
    (FILES[0], 'await cleanupSensitivityRows(before, [actors.owner, actors.other]);', ''),
    (FILES[1], 'declarations.length === 13 && ports.models.length === 13', 'declarations.length === 12 && ports.models.length === 12'),
    (FILES[1], "expectRejected('OMITTED_DEPENDENT', ports.models.filter(row => row.name !== 'Dependent'));", ""),
    (FILES[1], "requireThat(Object.hasOwn(sources, relative), 'MUTANT_SOURCE_NOT_ADMITTED');", ''),
    (FILES[1], 'JSON.stringify(Object.keys(mutants)) === JSON.stringify(ports.requiredSensitivityIds)', 'true'),
]
for path, before, after in controls:
    require(before in candidate[path], 'CONTROL_SHAPE')
    changed = dict(candidate); changed[path] = changed[path].replace(before, after, 1)
    require(rejected(changed), 'SOURCE_CONTROL_SURVIVED')
require(not git('diff', BASELINE, '--', 'src1', 'package.json', 'package-lock.json'), 'PRODUCTION_DEPENDENCIES_UNCHANGED')
changed = set(git('diff', '--name-only', 'HEAD').splitlines())
require(changed.issubset(set(FILES)), 'OWNED_DIFF_SCOPE')
print(json.dumps({'schema': 'SD-AUTHORITY-EXTENSION-SOURCE-CHECK-1', 'baseline': BASELINE,
                  'baselineRejected': True, 'sourceNegativeControlsRejected': len(controls),
                  'oldNominalCasesPreserved': 36, 'oldSensitivityProbesPreserved': 4,
                  'declaredNominalIds': len(expected_cases), 'declaredSensitivityIds': len(expected_mutants),
                  'candidateHashes': {path: hashlib.sha256(text.encode()).hexdigest() for path, text in candidate.items()},
                  'contractSha': CONTRACT_SHA, 'runtime': 'NOT_RUN', 'compiler': 'NOT_RUN',
                  'applicationEvaluations': 0, 'databaseCalls': 0, 'providerCalls': 0}, indent=2))
