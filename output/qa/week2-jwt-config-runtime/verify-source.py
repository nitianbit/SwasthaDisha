"""Read-only preservation/manifest/transform-shape checks; never evaluate JS/TS/app."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASELINE = '7517a239b87559d923a2f46583173517ff4a1849'
CONTRACT_SHA = '4c7a4bae2f39e9afdeedc22c97babf684bd2077d31647196d714e5eda3d281f1'
QA = ROOT / 'output/qa/week2-jwt-config-runtime'
FILES = ['test/api-runtime/scenario/scenario.cjs', 'test/api-runtime/scenario/compile.cjs', 'test/api-runtime/scenario/README.md']


def require(ok, code):
    if not ok:
        raise ValueError(code)


def git(*args):
    return subprocess.check_output(['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false', *args],
                                   cwd=ROOT, env={'PATH': '/usr/bin:/bin', 'TMPDIR': '/private/tmp'}, text=True)


contract = (QA / 'CONTRACT.md').read_bytes()
require(hashlib.sha256(contract).hexdigest() == CONTRACT_SHA, 'FROZEN_CONTRACT')
text = contract.decode()
new_cases = re.findall(r'^\| (JWT_[A-Z_]+) \|', text.split('## 5.', 1)[0], re.M)
new_mutants = re.findall(r'^\| (JWT_[A-Z_]+) \|', text.split('## 5.', 1)[1].split('## 6.', 1)[0], re.M)
require(len(new_cases) == 7 and len(new_mutants) == 3, 'CONTRACT_ID_COUNTS')
baseline = {name: git('show', BASELINE + ':' + name) for name in FILES}
old_ports = json.loads(git('show', BASELINE + ':test/api-runtime/scenario/ports-manifest.json'))


def inspect(candidate):
    scenario, compiler, readme = [candidate[name] for name in FILES]
    require('function requireConfigurationEvidence(evidence, need)' in scenario
            and 'const configuration = requireConfigurationEvidence(ctx.configurationEvidence, need);' in scenario,
            'ACTUAL_EVIDENCE_PARSER_REQUIRED')
    cases = re.search(r'const configurationCaseIds = \[(.*?)\];', scenario, re.S)
    mutants = re.search(r'const configurationSensitivityIds = \[(.*?)\];', scenario, re.S)
    require(cases and re.findall(r"'([^']+)'", cases[1]) == new_cases[:6], 'CONFIGURATION_CASE_IDS')
    require(mutants and re.findall(r"'([^']+)'", mutants[1]) == new_mutants, 'CONFIGURATION_SENSITIVITY_IDS')
    prefix = baseline[FILES[0]].split('async function runScenario(ctx) {', 1)[0]
    require(scenario.startswith(prefix), 'UNCHANGED_BUILTIN_PREAMBLE')
    stripped = prefix + 'async function runScenario(ctx) {' + scenario.split('async function runScenario(ctx) {', 1)[1]
    stripped = stripped.replace('  const configuration = requireConfigurationEvidence(ctx.configurationEvidence, need);\n', '', 1)
    start = stripped.index('  need(cases.length === 53')
    end = stripped.index('  // Separate negative phases', start)
    inserted_http = stripped[start:end]
    require("for (const published of ['your-secret-key', 'your-secret-key-change-in-production'])" in inserted_http
            and "await authorityDeny('GET', '/users/' + id(a), forged, undefined, 401, 'INVALID_TOKEN', true);" in inserted_http
            and "await readSuccess('/users/' + id(a), alpha.token);" in inserted_http
            and "record('JWT_PUBLISHED_FALLBACK_TOKEN_DENIED');" in inserted_http,
            'GENUINE_HTTP_PUBLIC_KEY_PREDICATE')
    stripped = stripped[:start] + stripped[end:]
    start = stripped.index('  need(sensitivity.length === 14')
    end = stripped.index('  // Prove fresh nominal classes', start)
    require('for (const row of configuration.sensitivity) sensitivity.push({ id: row.id, detected: true });' in stripped[start:end],
            'CONFIGURATION_SENSITIVITY_APPEND')
    stripped = stripped[:start] + stripped[end:]
    stripped = stripped.replace('module.exports = { runScenario, requireConfigurationEvidence };', 'module.exports = { runScenario };', 1)
    require(stripped == baseline[FILES[0]], 'ALL_PRIOR_53_14_SCENARIO_BYTES')
    start = compiler.index("  const configSource = 'src1/config/config.ts';")
    end = compiler.index('  requireThat(JSON.stringify(Object.keys(mutants))', start)
    require(compiler[:start] + compiler[end:] == baseline[FILES[1]], 'ALL_PRIOR_COMPILER_AND_DIAGNOSTIC_BYTES')
    declarations = re.findall(r"  mutate\('([A-Z_]+)'", compiler)
    require(declarations == old_ports['requiredSensitivityIds'] + new_mutants, 'EXACT_17_SOURCE_VARIANTS')
    require('60 nominal IDs/17 sensitivity IDs' in readme and '108' in readme and 'NOT_RUN' in readme, 'README_SCOPE')


candidate = {name: (ROOT / name).read_text() for name in FILES}
rejected = False
try:
    inspect(baseline)
except (ValueError, AttributeError):
    rejected = True
require(rejected, 'ACTUAL_BASELINE_REJECTED')
inspect(candidate)
require(not git('diff', BASELINE, '--', 'src1', 'package.json', 'package-lock.json', 'test/api-runtime/profile.json',
                'test/api-runtime/platform.mjs', 'test/api-runtime/scenario/prepare.py'), 'PRODUCTION_PROFILE_PREPARATION_UNCHANGED')
changes = git('diff', '--name-only', 'HEAD').splitlines()
require(all(name in FILES or name.startswith('output/qa/week2-jwt-config-runtime/') for name in changes), 'OWNED_SCOPE')
source = (ROOT / 'src1/config/config.ts').read_text()
initializer = '  JWT_SECRET_KEY: requireJwtSecret(process.env.JWT_SECRET_KEY),'
require(source.count(initializer) == 1 and source.count('  return value;\n}') == 1, 'CONFIG_TRANSFORM_ANCHORS')
shapes = {
    new_mutants[0]: source.replace(initializer, "  JWT_SECRET_KEY: process.env.JWT_SECRET_KEY || 'your-secret-key',", 1),
    new_mutants[1]: source.replace(initializer, "  JWT_SECRET_KEY: process.env.NODE_ENV === 'production' ? requireJwtSecret(process.env.JWT_SECRET_KEY) : process.env.JWT_SECRET_KEY,", 1),
    new_mutants[2]: source.replace('  return value;\n}', '  return value.trim();\n}', 1),
}
print(json.dumps({'schema': 'SD-JWT-CONFIG-SOURCE-1', 'baseline': BASELINE, 'baselineRejected': True,
                  'priorNominalCasesPreserved': 53, 'priorSensitivityProbesPreserved': 14,
                  'declaredNominalIds': 60, 'declaredSensitivityIds': 17,
                  'contractSha': CONTRACT_SHA,
                  'files': {name: hashlib.sha256(value.encode()).hexdigest() for name, value in candidate.items()},
                  'predictedSourceMutants': {name: hashlib.sha256(value.encode()).hexdigest() for name, value in shapes.items()},
                  'predictionScope': 'TEXT_ANCHORS_ONLY_NOT_ACTUAL_COMPILER_OUTPUT',
                  'applicationEvaluations': 0, 'compilerExecutions': 0, 'actualConfigLoads': 0, 'runtime': 'NOT_RUN'}, indent=2))
