#!/usr/bin/env python3
"""Source bytes/JSON only. Never import, parse or execute JS/TS/application code."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
BASE = '1355bd9af2c9d8d5170527c8c0fc565de997b6fe'
QA = 'output/qa/week2-specialist-profile-scenario/'
COMPILER = 'test/api-runtime/scenario/compile.cjs'
SCENARIO = 'test/api-runtime/scenario/scenario.cjs'
README = 'test/api-runtime/scenario/README.md'
SECTION = '887792c1e2851fe3dfd37d93b3a1870da3adaed7fe41a4fd5e50bb62ea5c7212'
OWNED = {COMPILER, SCENARIO, README}
OTHER_LANE = {'test/api-runtime/scenario/bootstrap.cjs', 'test/api-runtime/scenario/bootstrap-unit.cjs'}
ROOT_DOCS = {'documentation/planning/implementation/M0_A_PROGRESS.md', 'documentation/planning/implementation/CONTINUATION_INSTRUCTIONS.md'}
QA_PREFIXES = [QA, 'output/qa/week2-specialist-profile-bootstrap/', 'output/qa/week2-specialist-profile-runtime/']

def sha(data):
    return hashlib.sha256(data).hexdigest()

def base_file(path):
    return subprocess.check_output(['git', 'show', BASE + ':' + path], cwd=ROOT).decode()


def old_scenario(candidate):
    constant = "const PROFILE_SECTION_SHA = '" + SECTION + "';\n"
    candidate = candidate.replace(constant, '', 1)
    begin = candidate.find('  const profileQueryExec = mongoose.Query.prototype.exec;\n')
    end = candidate.find("  const record = name =>", begin)
    if begin < 0 or end < 0:
        return None
    candidate = candidate[:begin] + candidate[end:]
    begin = candidate.find('  // Frozen private HTTP matrix;')
    end = candidate.find("  const alpha = await login({ phone: '9000000001' });", begin)
    if begin < 0 or end < 0:
        return None
    candidate = candidate[:begin] + candidate[end:]
    for begin_marker, end_marker in [
        ("  need(cases.length === 83 &&", '  // Separate negative phases'),
        ("  need(sensitivity.length === 27 &&", "  need(ctx.counters.unexpected === 0 && ctx.counters.excluded === 0, 'UNDECLARED_CAPABILITY_EFFECT');")]:
        begin = candidate.find(begin_marker)
        end = candidate.find(end_marker, begin)
        if begin < 0 or end < 0:
            return None
        if begin_marker.startswith('  need(cases'):
            # Preserve the two original blank lines before the old phase comment.
            candidate = candidate[:begin] + '\n' + candidate[end:]
        else:
            candidate = candidate[:begin] + candidate[end:]
    return candidate


def between(text, before, after):
    start = text.find(before)
    end = text.find(after, start)
    return text[start:end] if start >= 0 and end >= 0 else None


def checks(compiler, scenario, prior_compiler, prior_scenario):
    binding = "const PROFILE_SECTION_SHA = '" + SECTION + "';"
    old_mutant_begin = "  mutate('OTP_UNCONDITIONAL_CONSUME'"
    return {
        'compiler_binding_before_source_traversal': binding in compiler and compiler.find('const profile = profileData(ports)') < compiler.find('const tracked = new Set(inputPlan.trackedSources)'),
        'compiler_section_verification': "sha(Buffer.from(JSON.stringify(profile))) === PROFILE_SECTION_SHA" in compiler,
        'compiler_static_separate_no_queue': "for (const audit of profile.staticAuditInputs)" in compiler and "const staticAudit = [];" in compiler and "staticAudit.push({" in compiler,
        'compiler_static_source_pin': "sha(bytes) === audit.sourceSha256" in compiler and "stat.nlink === 1" in compiler,
        'compiler_static_exact_output_pin': "sha(fs.readFileSync(path.join(runtimeRoot, audit.compiled))) === audit.compiledSha256" in compiler,
        'compiler_parent_bound_builtins': "relative === PROFILE_SOURCE && sources[relative] === PROFILE_SOURCE_SHA" in compiler,
        'compiler_exact_mutation': "const changed = once(text, variant.before, variant.after);" in compiler and "sha(Buffer.from(changed)) === variant.predictedTransformedSourceSha256" in compiler,
        'compiler_old_type_and_model_controls_preserved': between(compiler, '// These programs run only', 'function compile(') == between(prior_compiler, '// These programs run only', 'function compile('),
        'compiler_old_27_variants_preserved': between(compiler, old_mutant_begin, '  for (const variant of profile.sourceMutations)') == between(prior_compiler, old_mutant_begin, "  requireThat(JSON.stringify(Object.keys(mutants))"),
        'compiler_old_broad_host_program_preserved': between(compiler, '  // Retain focused semantic diagnostics', '  const plan = {') == between(prior_compiler, '  // Retain focused semantic diagnostics', '  const plan = {'),
        'compiler_transpile_only_no_adoption': "status: 'TRANSPILE_ONLY_NOT_TYPECHECKED'" in compiler and "fullBuild: false" in compiler and "runtimeRoot: false" in compiler,
        'scenario_binding': binding in scenario and "update(JSON.stringify(profile)).digest('hex') === PROFILE_SECTION_SHA" in scenario,
        'scenario_old_83_27_code_preserved': old_scenario(scenario) == prior_scenario,
        'scenario_real_http_observation': "const result = await request(trial.method, route.slice('/api/v1'.length), token, trial.body);" in scenario,
        'scenario_13_collection_snapshot': "const before = await authorityRows(); const countersBefore" in scenario and "const after = await authorityRows();" in scenario,
        'scenario_exact_reads': "observed.reads[key] === expected.readOpsDelta[key]" in scenario,
        'scenario_exact_writes': "observed.writes[key] === expected.writeOpsDelta[key]" in scenario and "observed.effects.dbWrites === expected.dbWritesDelta" in scenario,
        'scenario_provider_jwt_private': "observed.effects.jwtIssued === expected.jwtIssuedDelta" in scenario and "observed.attempts[key] === expected.privatePortalAttemptDelta[key]" in scenario and "const value = ctx.profileAttempts;" in scenario,
        'scenario_exact_state_fields': "profileSame(keep(observed.before[spec.name]), keep(observed.after[spec.name]))" in scenario and "profileSame(preserved(prior), preserved(next))" in scenario,
        'scenario_actual_updated_timestamp': "next.updatedAt.getTime() >= observed.started" in scenario and "next.updatedAt.getTime() <= observed.ended" in scenario,
        'scenario_exact_reply': "profileSame(observed.result.body.data, row)" in scenario and "observed.result.body.message === expected.message" in scenario,
        'scenario_query_hook_restored': "mongoose.Query.prototype.exec === profileQueryExec" in scenario,
        'scenario_completed_proof_cleanup': "await cleanCompletedProofs();\n    need(completedProofs.size === 0" in scenario,
        'scenario_verified_full_horizon': "proof.isVerified === true && proof.expireAt instanceof Date" in scenario and "proof.expireAt.getTime() > checkpoint + 180000" in scenario,
        'scenario_both_append_boundaries': scenario.count('    await profileAppendBoundary();') == 2,
        'scenario_nonempty_nominal_complete': "for (const trial of profile.trials)" in scenario and "seen.size === 93 && success === 6 && errors === 87" in scenario,
        'scenario_actual_logger_delta': "ctx.counters.logger - loggerBefore === 87" in scenario,
        'scenario_unsafe_before_same_nominal': scenario.find('assertProfileUnsafe(observed, trial, fixture, reference);') < scenario.find('try { assertProfileObservation(observed, trial, fixture); }'),
        'scenario_only_exact_detection': "descriptor.value !== reference.unsafe.expectedNominalFailureCode" in scenario and "need(detected, 'SPECIALIST_PROFILE_PRECISE_DETECTION')" in scenario,
        'scenario_fresh_phase_unwind': "}, [() => ctx.nextPhase({})]);" in scenario,
        'scenario_two_actual_restorations': "for (const restored of [trial, positive])" in scenario and "references === 11 && restorations === 22" in scenario,
        'scenario_first_error_cleanup': "for (const cleanup of cleanups)" in scenario and "if (!failed) { failed = true; primary = error; }" in scenario and "if (failed) throw primary;" in scenario,
        'scenario_exact_owned_id_cleanup': "deleteOne({ _id: fixture.ids[key] })" in scenario and "'SPECIALIST_A', 'SPECIALIST_B'" in scenario,
        'scenario_old_prefixes_and_final_sets': "cases.length === 83" in scenario and "cases.length === 90" in scenario and "sensitivity.length === 27" in scenario and "sensitivity.length === 33" in scenario,
    }


def run():
    prior_compiler = base_file(COMPILER)
    prior_scenario = base_file(SCENARIO)
    compiler = (ROOT / COMPILER).read_text()
    scenario = (ROOT / SCENARIO).read_text()
    rows = checks(compiler, scenario, prior_compiler, prior_scenario)
    baseline = checks(prior_compiler, prior_scenario, prior_compiler, prior_scenario)
    controls = [
        ('COMPILER_SECTION_PIN_REMOVED', 'compiler', "sha(Buffer.from(JSON.stringify(profile))) === PROFILE_SECTION_SHA", 'true'),
        ('COMPILER_STATIC_OUTPUT_PIN_REMOVED', 'compiler', "sha(fs.readFileSync(path.join(runtimeRoot, audit.compiled))) === audit.compiledSha256", 'true'),
        ('COMPILER_NEW_BUILTIN_PARENT_REMOVED', 'compiler', "relative === PROFILE_SOURCE && sources[relative] === PROFILE_SOURCE_SHA", 'true'),
        ('COMPILER_MUTANT_PIN_REMOVED', 'compiler', "sha(Buffer.from(changed)) === variant.predictedTransformedSourceSha256", 'true'),
        ('HTTP_REPLACED_BY_EMPTY_OBSERVATION', 'scenario', "await request(trial.method, route.slice('/api/v1'.length), token, trial.body)", '{}'),
        ('ACTION_READ_CHECK_REMOVED', 'scenario', "observed.reads[key] === expected.readOpsDelta[key]", 'true'),
        ('ACTION_WRITE_CHECK_REMOVED', 'scenario', "observed.writes[key] === expected.writeOpsDelta[key]", 'true'),
        ('WHOLE_STATE_CHECK_REMOVED', 'scenario', "profileSame(keep(observed.before[spec.name]), keep(observed.after[spec.name]))", 'true'),
        ('PRIVATE_ATTEMPT_SOURCE_REMOVED', 'scenario', 'const value = ctx.profileAttempts;', 'const value = {};'),
        ('VERIFIED_PROOF_CHECK_REMOVED', 'scenario', 'proof.isVerified === true && proof.expireAt instanceof Date', 'proof.expireAt instanceof Date'),
        ('PROOF_HORIZON_REMOVED', 'scenario', 'proof.expireAt.getTime() > checkpoint + 180000', 'true'),
        ('NOMINAL_TRIALS_EMPTIED', 'scenario', 'for (const trial of profile.trials)', 'for (const trial of [])'),
        ('UNSAFE_PROOF_REMOVED', 'scenario', 'assertProfileUnsafe(observed, trial, fixture, reference);', ''),
        ('ARBITRARY_EXCEPTION_ACCEPTED', 'scenario', 'descriptor.value !== reference.unsafe.expectedNominalFailureCode', 'false'),
        ('RESTORATIONS_EMPTIED', 'scenario', 'for (const restored of [trial, positive])', 'for (const restored of [])'),
        ('FIRST_ERROR_OVERWRITTEN', 'scenario', 'if (!failed) { failed = true; primary = error; }', '{ failed = true; primary = error; }'),
        ('TARGET_TIMESTAMP_WINDOW_REMOVED', 'scenario', 'next.updatedAt.getTime() <= observed.ended', 'true'),
        ('RETURNED_STORED_ROW_CHECK_REMOVED', 'scenario', 'profileSame(observed.result.body.data, row)', 'true'),
    ]
    sensitivity = []
    for name, file, before, after in controls:
        text = compiler if file == 'compiler' else scenario
        if text.count(before) != 1:
            raise RuntimeError('CONTROL_SOURCE_ANCHOR')
        changed = text.replace(before, after)
        result = checks(changed if file == 'compiler' else compiler, changed if file == 'scenario' else scenario, prior_compiler, prior_scenario)
        sensitivity.append({'id': name, 'rejected': not all(result.values()), 'failedChecks': [key for key, passed in result.items() if not passed]})
    ports = json.loads((ROOT / 'test/api-runtime/scenario/ports-manifest.json').read_text())
    section = ports['specialistProfile']
    section_ok = sha(json.dumps(section, separators=(',', ':'), ensure_ascii=False).encode()) == SECTION
    immutable_paths = [
        'src1/modules/specialistPortal/services/index.ts', 'test/api-runtime/scenario/ports-manifest.json',
        'test/api-runtime/scenario/prepare.py', 'test/api-runtime/scenario/package-plan.json',
        'test/api-runtime/launch.mjs', 'test/api-runtime/platform.mjs', 'test/api-runtime/profile.json',
        'package.json', 'package-lock.json', 'tsconfig.json', 'server.js',
    ]
    unchanged = {}
    for relative in immutable_paths:
        unchanged[relative] = (ROOT / relative).read_bytes() == subprocess.check_output(['git', 'show', BASE + ':' + relative], cwd=ROOT)
    changed = set(subprocess.check_output(['git', 'diff', '--name-only', BASE], cwd=ROOT, text=True).splitlines())
    untracked = set(subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard'], cwd=ROOT, text=True).splitlines())
    all_changes = changed | untracked
    extras = [name for name in all_changes if name not in OWNED | OTHER_LANE | ROOT_DOCS and not any(name.startswith(prefix) for prefix in QA_PREFIXES)]
    scope = OWNED.issubset(changed) and not extras
    modes = all((ROOT / relative).is_file() and not (ROOT / relative).is_symlink() and (ROOT / relative).stat().st_nlink == 1
                and (ROOT / relative).stat().st_mode & 0o777 == 0o644 for relative in OWNED)
    result = {'schema': 'SD-PROFILE-SCENARIO-SOURCE-DATA-1', 'status': 'PASS' if all(rows.values()) and all(unchanged.values())
              and section_ok and scope and modes and not all(baseline.values()) and all(row['rejected'] for row in sensitivity) else 'FAIL',
              'baseline': BASE, 'checks': rows, 'checkCount': len(rows),
              'baselineRejected': not all(baseline.values()), 'baselineMissingChecks': [key for key, passed in baseline.items() if not passed],
              'sensitivity': sensitivity, 'unchangedCriticalInputs': unchanged, 'sectionHashMatches': section_ok,
              'scope': {'ownedThreeChanged': OWNED.issubset(changed), 'unexpectedPaths': sorted(extras), 'closedCompositionAllowance': sorted(OTHER_LANE | ROOT_DOCS),
                        'qaPrefixes': QA_PREFIXES, 'regular644SingleLinkFiles': modes},
              'limitations': 'SOURCE_BYTES_JSON_ONLY; does not parse JS/TS, import domain/Joi/compiler or execute HTTP/DB/providers; other lane content is separately reviewed by Root.'}
    print(json.dumps(result, indent=2))
    return 0 if result['status'] == 'PASS' else 1

if __name__ == '__main__':
    sys.exit(run())
