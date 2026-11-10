"""Inspect source as bytes/data only. Never evaluate application/TS/compiler code."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
QA = ROOT / 'output/qa/week2-meet-owned'
BASELINE = 'fda17dae36a19c74488779de90ce22ddbb6b1361'
ACCEPTED = 'bac46d306a5f989c1eafcab5c40d4ce6fdd06e1d'
CONTRACT_SHA = '106a7500049610f6b08f96165598e677a34cd544aeca14d7676bc3f50ffa4d3a'
INTERFACE_SHA = 'e407aaf502c7ccdaffd60fb299b8b3417c5d2cc518000b555e13d79054e5fede'
PORTS_SHA = '86d6b909c06387c52c8d62e3b99a10784d9612fb6fc63581faf6d3e96ee13a12'
FILES = ['test/api-runtime/scenario/scenario.cjs', 'test/api-runtime/scenario/compile.cjs', 'test/api-runtime/scenario/README.md']


def require(ok, code):
    if not ok:
        raise ValueError(code)


def git(*args):
    return subprocess.check_output(['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false', *args],
                                   cwd=ROOT, env={'PATH': '/usr/bin:/bin', 'TMPDIR': '/private/tmp'}, text=True)


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


fixed = ROOT / 'output/qa/week2-meet-runtime'
contract = (fixed / 'CONTRACT.md').read_text()
require(sha(contract) == CONTRACT_SHA and sha((fixed / 'INTERFACE.md').read_bytes()) == INTERFACE_SHA, 'FROZEN_REQUIREMENTS')
new_cases = re.findall(r'^\| (MEET_[A-Z_]+) \|', contract.split('## Four actual-source', 1)[0], re.M)
new_mutants = re.findall(r'^\| (MEET_[A-Z_]+) \|', contract.split('## Four actual-source', 1)[1], re.M)
require(len(new_cases) == 16 and len(new_mutants) == 4, 'CONTRACT_COUNTS')
ports_bytes = (ROOT / 'test/api-runtime/scenario/ports-manifest.json').read_bytes()
require(sha(ports_bytes) == PORTS_SHA, 'ROOT_OWNED_PORTS')
ports = json.loads(ports_bytes)
old_ports = json.loads(git('show', ACCEPTED + ':test/api-runtime/scenario/ports-manifest.json'))
require(ports['requiredCaseIds'] == old_ports['requiredCaseIds'] + new_cases
        and ports['requiredSensitivityIds'] == old_ports['requiredSensitivityIds'] + new_mutants, 'MANIFEST_EXACT_76_21')
require(ports['models'] == old_ports['models'] and len(ports['models']) == 13
        and ports['roots'] == old_ports['roots'] + ['@/modules/meet/routes'], 'OLD_MODELS_ROOTS_RETAINED')
baseline = {name: git('show', BASELINE + ':' + name) for name in FILES}


def unique(text, value, code):
    require(text.count(value) == 1, code)


def inspect(candidate):
    scenario, compiler, readme = [candidate[name] for name in FILES]
    start = scenario.index('  // Administrative Meet routes use their actual controller/service/fetch builders.')
    end = scenario.index("  const alpha = await login({ phone: '9000000001' });", start)
    block = scenario[start:end]
    # These assertions exercise actual HTTP via the original observe(), not an
    # expected-response replacement. Concrete source predicates remain reviewable.
    for anchor in [
        "const observed = await observe(method, '/meet' + route, token, body);",
        'const offset = ctx.meetRequests.length; const clockBefore = Date.now();',
        'const clockAfter = Date.now(); const requests = ctx.meetRequests.slice(offset);',
        'ctx.expectMeetRequests(expected);',
        'unchangedOutside(observed); effects(observed, {}, 0, logger, count);',
        "need(Object.values(observed.reads).every(value => value === 0), 'MEET_DATABASE_READS');",
        "need(observed.requests.length === count, 'MEET_REQUEST_COUNT');",
        "need(observed.result.body.message === expected.message, 'MEET_AUTHORITY_MESSAGE');",
        "need(observed.result.status === expected.status, 'MEET_AUTHORITY_STATUS'); errorEnvelope(observed.result, expected.code);",
        "timestamp >= observed.clockBefore && timestamp <= observed.clockAfter",
        "ctx.counters.unexpected++; need(false, 'MEET_REQUEST_ID_WINDOW');",
        "ctx.counters.unexpected++; need(false, 'MEET_REQUEST_ID_SHAPE');",
        "ctx.counters.unexpected++; need(false, 'MEET_REQUEST_FIELDS');",
        "headers: { Authorization: 'Bearer ' + fixture.oauthResponse.access_token, 'Content-Type': 'application/json' }",
        "grant_type: 'authorization_code'", "grant_type: 'refresh_token'",
        "conferenceSolutionKey: { type: 'hangoutsMeet' }",
        "pairs.length === 8", "response_type: 'code'", "include_granted_scopes: 'true'",
        "meetDenied(observed, { status: 401, code: 'UNAUTHORIZED', message: 'Authentication is required' });",
        "detectedFailure(() => meetDenied(observed, caller), variant === 'MEET_AUTHENTICATION_REMOVED' ? 'MEET_AUTHORITY_MESSAGE' : 'MEET_AUTHORITY_STATUS');",
        "detectedFailure(() => meetCallbackPredicate(observed, index), 'MEET_CALLBACK_STATUS');",
        "for (const caller of callers) for (const malformed of [false, true]) await meetAuthority(index, caller, malformed);",
        "need(ctx.counters.calendar - calendarBefore === 4, 'MEET_NOMINAL_GOOGLE_COUNT');",
        "ctx.expectMeetRequests([]); await ctx.nextPhase({});",
        'await meetAuthority(index, caller, malformed);',
        'sensitivity.push({ id: variant, detected: true });',
    ]:
        require(anchor in block, 'MEET_PREDICATE:' + sha(anchor)[:12])
    for role in ['hr', 'specialist', 'pharmacy']:
        require("signed({ userType: '" + role + "' })" in block, 'ALL_EXISTING_ACTORS')
    for marker in ['INVALID_TOKEN', 'TOKEN_EXPIRED', 'Admin access is required', 'Authorization token is required',
                   'fixture-callback-code', 'access_denied', 'MEET_CALLBACK_REPLY', 'MEET_URL_REPLY', 'MEET_PROVIDER_REPLY',
                   '2030-01-15T10:00:00', '2030-01-15T10:30:00', 'patientEmail must be a valid email, specialistEmail must be a valid email']:
        require(marker in block, 'EXACT_REPLY_OR_ACTOR')
    case_arrays = []
    for array in ['authorityIds', 'validationIds', 'successIds', 'callbacks']:
        match = re.search(r'const ' + array + r' = \[(.*?)\];', block, re.S)
        require(match, 'MEET_CASE_ARRAY')
        case_arrays.extend(re.findall(r"'(MEET_[A-Z_]+)'", match[1]))
    require(case_arrays == new_cases, 'ORDERED_NEW_CASES')
    variants = re.search(r'for \(const variant of \[(.*?)\]\)', block, re.S)
    require(variants and re.findall(r"'(MEET_[A-Z_]+)'", variants[1]) == new_mutants, 'ORDERED_NEW_VARIANTS')
    require(block.index('await ctx.nextPhase({});') < block.index('sensitivity.push({ id: variant, detected: true });')
            and 'finally' not in block and 'Date.now =' not in block, 'FRESH_RESTORE_NO_FAILURE_MUTATION_OR_CLOCK_STUB')
    stripped = scenario[:start] + scenario[end:]
    nominal = "  need(cases.length === 60 && same(cases.map(row => row.id), ctx.ports.requiredCaseIds.slice(0, 60)), 'MEET_PRIOR_CASE_SET');\n  await runMeetNominal(admin.token, alpha.token);\n\n"
    negative = "  need(sensitivity.length === 17 && same(sensitivity.map(row => row.id), ctx.ports.requiredSensitivityIds.slice(0, 17)), 'MEET_PRIOR_SENSITIVITY_SET');\n  await runMeetSensitivity(alpha.token);\n"
    unique(stripped, nominal, 'EXACT_APPEND_AFTER_60'); unique(stripped, negative, 'EXACT_APPEND_AFTER_17')
    stripped = stripped.replace(nominal, '', 1).replace(negative, '', 1)
    plumbing = [
        ("['email', 'sms', 'push', 'calendar', 'unexpected'", "['email', 'sms', 'push', 'unexpected'"),
        ('function effects(observed, expectedWrites = {}, push = 0, logger = 0, calendar = 0)', 'function effects(observed, expectedWrites = {}, push = 0, logger = 0)'),
        ("observed.effects.logger === logger\n      && observed.effects.calendar === calendar", 'observed.effects.logger === logger'),
        ('payments: 0, calendar: nominalCounters.calendar, storage: 0', 'payments: 0, calendar: 0, storage: 0'),
    ]
    for after, before in plumbing:
        unique(stripped, after, 'EXPLICIT_COUNTER_PLUMBING'); stripped = stripped.replace(after, before, 1)
    require(stripped == baseline[FILES[0]], 'ALL_PRIOR_60_17_BYTES_PRESERVED')
    start = compiler.index('  const meetSourcePins = {')
    end = compiler.index('  requireThat(JSON.stringify(Object.keys(mutants))', start)
    require(compiler[:start] + compiler[end:] == baseline[FILES[1]], 'ALL_PRIOR_COMPILER_AST_DIAGNOSTICS_PRESERVED')
    extension = compiler[start:end]
    declarations = re.findall(r"  mutate\('([A-Z_]+)'", compiler)
    require(declarations == ports['requiredSensitivityIds'], 'EXACT_21_SOURCE_VARIANTS')
    for anchor in ["requireThat(sources[source] === hash, 'MEET_SOURCE_PIN');", 'text = once(text, before, after);',
                   "mutate('MEET_CALLBACK_GATED', meetRoutes, text => once(text,", "'  authenticate,\\n  requireAdmin,\\n' + validation"]:
        require(anchor in extension, 'ACTUAL_PINNED_ROUTER_TRANSFORMATION')
    source_pins = json.loads((fixed / 'source-inputs.json').read_text())['sourcePins']
    require(len(source_pins) == 5, 'FIVE_MEET_SOURCE_INPUTS')
    declared_pins = dict(re.findall(r"'(src1/modules/meet/[^']+)': '([0-9a-f]{64})'", extension))
    require(declared_pins == source_pins, 'EXACT_FIVE_COMPILER_PINS')
    for name, hash_value in source_pins.items():
        require(sha((ROOT / name).read_bytes()) == hash_value, 'UNCHANGED_MEET_PRODUCTION_INPUT')
    for route, schema, area in [('/google-oauth/url', 'googleOAuthQuerySchema', 'query'), ('/google-oauth/exchange', 'googleOAuthExchangeSchema', 'body'),
                                ('/google-oauth/refresh', 'googleOAuthRefreshTestSchema', 'body'), ('/google-meet/oauth', 'testGoogleMeetSchema', 'body')]:
        require("['" + route + "', '" + schema + "', '" + area + "']" in extension, 'ALL_FOUR_REAL_MUTANT_REGISTRATIONS')
    require('for76 nominal IDs/21' in readme and 'NOT_RUN' in readme and 'nominal total4' in readme
            and 'execution6' in readme, 'DOCUMENTED_SCOPE')


candidate = {name: (ROOT / name).read_text() for name in FILES}
try:
    inspect(baseline)
    raise RuntimeError('BASELINE_ACCEPTED')
except (ValueError, AttributeError):
    pass
inspect(candidate)
require(not git('diff', BASELINE, '--', 'src1', 'package.json', 'package-lock.json', 'test/api-runtime/profile.json',
                'test/api-runtime/platform.mjs', 'test/api-runtime/scenario/prepare.py'), 'PRODUCTION_DEPS_PROFILE_PREP_UNCHANGED')
require(all(name in FILES or name.startswith('output/qa/week2-meet-owned/') for name in git('diff', '--name-only', 'HEAD').splitlines()), 'OWNED_WORKTREE_SCOPE')

# Deliberately weakened source variants, not executable domain mutants. Each
# must be rejected by a predicate/preservation/manifest guard above.
controls = [
    (0, 'await observe(method, \'/meet\' + route, token, body)', "await observe(method, '/wrong' + route, token, body)"),
    (0, 'unchangedOutside(observed); effects(observed, {}, 0, logger, count);', 'effects(observed, {}, 0, logger, count);'),
    (0, 'Object.values(observed.reads).every(value => value === 0)', 'true'),
    (0, 'observed.requests.length === count', 'true'),
    (0, 'observed.result.body.message === expected.message', 'true'),
    (0, 'observed.result.status === expected.status', 'true'),
    (0, 'timestamp >= observed.clockBefore && timestamp <= observed.clockAfter', 'true'),
    (0, "ctx.counters.unexpected++; need(false, 'MEET_REQUEST_ID_WINDOW');", "need(false, 'MEET_REQUEST_ID_WINDOW');"),
    (0, "ctx.counters.unexpected++; need(false, 'MEET_REQUEST_FIELDS');", "need(false, 'MEET_REQUEST_FIELDS');"),
    (0, "grant_type: 'authorization_code'", "grant_type: 'anything'"),
    (0, "grant_type: 'refresh_token'", "grant_type: 'anything'"),
    (0, "conferenceSolutionKey: { type: 'hangoutsMeet' }", "conferenceSolutionKey: { type: 'anything' }"),
    (0, 'pairs.length === 8', 'pairs.length >= 1'),
    (0, "message: 'Authentication is required'", "message: 'Authorization token is required'"),
    (0, 'for (const malformed of [false, true])', 'for (const malformed of [false])'),
    (0, "ctx.counters.calendar - calendarBefore === 4", 'true'),
    (0, 'ctx.expectMeetRequests([]); await ctx.nextPhase({});', 'ctx.expectMeetRequests([]);'),
    (0, "signed({ userType: 'hr' })", "signed({ userType: 'user' })"),
    (0, 'calendar: nominalCounters.calendar', 'calendar: 0'),
    (0, "const configurationCaseIds = ['JWT_CONFIG_UNSET_DENIED'", "const configurationCaseIds = ['JWT_CONFIG_BLANK_DENIED'"),
    (1, "sources[source] === hash", 'true'),
    (1, "text = once(text, before, after);", 'text = text;'),
    (1, "mutate('MEET_CALLBACK_GATED'", "mutate('MEET_CALLBACK_OTHER'"),
    (1, "'/google-oauth/refresh', 'googleOAuthRefreshTestSchema'", "'/google-oauth/other', 'googleOAuthRefreshTestSchema'"),
    (1, "declarations.length === 13", 'declarations.length >= 1'),
    (1, "OMITTED_DEPENDENT", 'OMITTED_UNKNOWN'),
]
for index, (file_index, before, after) in enumerate(controls):
    name = FILES[file_index]
    require(before in candidate[name], 'CONTROL_ANCHOR')
    variant = dict(candidate); variant[name] = candidate[name].replace(before, after, 1)
    rejected = False
    try:
        inspect(variant)
    except (ValueError, AttributeError):
        rejected = True
    require(rejected, 'SOURCE_CONTROL_SURVIVED:' + str(index))

route_source = (ROOT / 'src1/modules/meet/routes/index.ts').read_text()
shapes = {}
for variant in new_mutants:
    value = route_source
    if variant == 'MEET_CALLBACK_GATED':
        before = "  '/google-oauth/callback',\n  validate(googleOAuthCallbackQuerySchema, 'query'),"
        after = "  '/google-oauth/callback',\n  authenticate,\n  requireAdmin,\n  validate(googleOAuthCallbackQuerySchema, 'query'),"
        unique(value, before, 'CALLBACK_TRANSFORM'); value = value.replace(before, after, 1)
    else:
        for route, schema, area in [('/google-oauth/url', 'googleOAuthQuerySchema', 'query'), ('/google-oauth/exchange', 'googleOAuthExchangeSchema', 'body'),
                                    ('/google-oauth/refresh', 'googleOAuthRefreshTestSchema', 'body'), ('/google-meet/oauth', 'testGoogleMeetSchema', 'body')]:
            start = "  '" + route + "',\n"; validation = "  validate(" + schema + ", '" + area + "'),"
            before = start + '  authenticate,\n  requireAdmin,\n' + validation
            after = (start + '  requireAdmin,\n' + validation if variant == 'MEET_AUTHENTICATION_REMOVED' else
                     start + '  authenticate,\n' + validation if variant == 'MEET_ADMIN_GUARD_REMOVED' else start + validation + '\n  authenticate,\n  requireAdmin,')
            unique(value, before, 'PROTECTED_TRANSFORM'); value = value.replace(before, after, 1)
    shapes[variant] = sha(value)

print(json.dumps({'schema': 'SD-MEET-OWNED-SOURCE-1', 'baseline': BASELINE, 'baselineRejected': True,
                  'priorNominalCasesPreserved': 60, 'priorSensitivityProbesPreserved': 17,
                  'declaredNominalIds': 76, 'declaredSensitivityIds': 21, 'negativeSourceControlsRejected': len(controls),
                  'contractSha': CONTRACT_SHA, 'interfaceSha': INTERFACE_SHA, 'portsSha': PORTS_SHA,
                  'files': {name: sha(value) for name, value in candidate.items()},
                  'predictedSourceMutants': shapes, 'predictionScope': 'TEXT_ANCHORS_ONLY_NOT_COMPILER_OUTPUT',
                  'applicationEvaluations': 0, 'compilerExecutions': 0, 'actualMeetHttpRequests': 0, 'runtime': 'NOT_RUN'}, indent=2))
