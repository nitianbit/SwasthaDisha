"""Source-data/preservation proof only. Never import/evaluate JS/TS/app/compiler."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
QA = ROOT / 'output/qa/week2-index-scenario'
BASELINE = '427505327155e749bbddd5001a7be11bdf6a168c'
CONTRACT_SHA = '8d43ee0a67d10a5b627a66cf9dc49d0b30d8a16e8c38c62da2936330e0d5ce99'
PINS_SHA = 'd41c56e2d019117c612c7cae93580daa5d84a69ccf87b9eb8264093a9ddc7bf7'
PORTS_SHA = '08583e74231bb02151ae2c89537233b198e1241ac769d65c874ee5aa8f06b33b'
FILES = ['test/api-runtime/scenario/compile.cjs', 'test/api-runtime/scenario/scenario.cjs', 'test/api-runtime/scenario/README.md']


def require(ok, code):
    if not ok:
        raise ValueError(code)


def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


def git(*args):
    return subprocess.check_output(['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false', *args],
                                   cwd=ROOT, env={'PATH': '/usr/bin:/bin', 'TMPDIR': '/private/tmp'}, text=True)


frozen = ROOT / 'output/qa/week2-index-readiness-runtime'
require(sha((frozen / 'CONTRACT.md').read_bytes()) == CONTRACT_SHA, 'EXACT_CONTRACT')
require(sha((frozen / 'pin-intents.json').read_bytes()) == PINS_SHA, 'EXACT_INPUT_PINS')
pins = json.loads((frozen / 'pin-intents.json').read_text())
ports_bytes = (ROOT / 'test/api-runtime/scenario/ports-manifest.json').read_bytes()
require(sha(ports_bytes) == PORTS_SHA, 'ROOT_OWNED_PORTS')
ports = json.loads(ports_bytes)
old_ports = json.loads(git('show', BASELINE + ':test/api-runtime/scenario/ports-manifest.json'))
baseline = {name: git('show', BASELINE + ':' + name) for name in FILES}
source_name = pins['partASource']['path']
source = (ROOT / source_name).read_text()
require(sha(source) == pins['partASource']['sha'], 'ACCEPTED_SOURCE_050')
require(len(ports['requiredCaseIds']) == 83 and len(ports['requiredSensitivityIds']) == 27
        and ports['requiredCaseIds'][:76] == old_ports['requiredCaseIds']
        and ports['requiredSensitivityIds'][:21] == old_ports['requiredSensitivityIds'], 'EXACT_83_27_PREFIXES')
require(ports['models'] == old_ports['models'] and len(ports['models']) == 13
        and ports['roots'] == old_ports['roots'] + ['@/modules/common/utils/indexReadiness'], 'UNCHANGED_MODEL_SET_AND_ONE_PURE_ROOT')


def inspect(candidate):
    compiler, scenario, readme = [candidate[name] for name in FILES]
    start = compiler.index('// These programs run only during a separately approved install/emit invocation.')
    end = compiler.index('function assertModelDeclarations', start)
    type_code = compiler[start:end]
    library = re.search(r'const INDEX_TYPE_LIBRARY_HASHES = Object.freeze\((\{.*?\})\);', type_code, re.S)
    require(library and json.loads(library[1]) == pins['helperTypecheck']['frozenStandardLibraryFiles'], 'EXACT_45_TYPE_LIBRARIES')
    options = re.search(r'const INDEX_TYPE_OPTIONS = Object.freeze\((\{.*?\})\);', type_code, re.S)
    require(options, 'TYPE_OPTIONS_LITERAL')
    option_json = re.sub(r'\b([A-Za-z][A-Za-z0-9]*)\s*:', r'"\1":', options[1])
    option_json = re.sub(r"'([^'\\]*)'", lambda match: json.dumps(match[1]), option_json)
    require(json.loads(option_json) == pins['helperTypecheck']['options'], 'EXACT_STRICT_NO_AMBIENT_OPTIONS')
    for anchor in [
        "ts.version === '5.9.3' && sha(Buffer.from(nominalText)) === INDEX_HELPER_SHA",
        "sha(readRegular(path.join(libraryRoot, 'typescript.js'))) === INDEX_COMPILER_SHA",
        "sha(bytes) === expected", "texts.size === 45", "sha(Buffer.from(rejected)) === INDEX_TDZ_SHA",
        "strict: true", "noEmit: true", "noImplicitAny: true", "noImplicitThis: true", "noImplicitReturns: true",
        "noUnusedLocals: true", "noUnusedParameters: true", "skipLibCheck: false", "types: [], typeRoots: []",
        "fileExists: file => allowedTexts.has(path.resolve(file))",
        "readFile: file => allowedTexts.get(path.resolve(file))",
        "const data = host.readFile(file);", "return ts.createSourceFile(file, data, languageVersion, true);",
        "resolveModuleNames: names => names.map(() => undefined)",
        "const program = ts.createProgram([filename], compilerOptions, host);",
        "const actual = ts.getPreEmitDiagnostics(program).map(item => ({",
        "JSON.stringify(foundFiles) === JSON.stringify([...libraryIds, sourceId].sort())",
        "item.category === ts.DiagnosticCategory.Error && item.code === 2448",
        "item.sourceId === sourceId && item.start === referenceOffset && item.length === 'requirements'.length",
        "!programFailure && report.diagnostics.length === 0 && report.tdzControl.status === 'REJECTED'",
        "process.stdout.write(JSON.stringify({ schema: 'SD-SELECTED-INDEX-TYPECHECK-FAILURE-1', report }) + '\\n');",
        "throw new Error('INDEX_SELECTED_HELPER_TYPECHECK_FAILED');",
    ]:
        require(anchor in type_code, 'TYPECHECK_GUARD:' + sha(anchor)[:12])
    require('messageText' not in type_code and 'console.' not in type_code, 'SAFE_TYPE_DIAGNOSTIC_METADATA_ONLY')
    stripped_compiler = compiler[:start] + compiler[end:]
    call = "  requireThat(sources[INDEX_HELPER_SOURCE] === INDEX_HELPER_SHA, 'INDEX_SOURCE_PIN');\n  const indexTypecheck = selectedHelperTypecheck(sourceRoot, runtimeRoot,\n    fs.readFileSync(path.join(sourceRoot, INDEX_HELPER_SOURCE), 'utf8'));\n"
    require(stripped_compiler.count(call) == 1, 'ACTUAL_FUTURE_TYPECHECK_CALL'); stripped_compiler = stripped_compiler.replace(call, '', 1)
    start = stripped_compiler.index('  mutate("INDEX_MISSING_REQUIREMENT_ACCEPTED", INDEX_HELPER_SOURCE,')
    end = stripped_compiler.index('  requireThat(JSON.stringify(Object.keys(mutants))', start)
    mutations = stripped_compiler[start:end]
    rows = re.findall(r'  mutate\(("[A-Z_]+"), INDEX_HELPER_SOURCE, text => \{\n    const changed = once\(text, ("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*")\);\n    requireThat\(sha\(Buffer.from\(changed\)\) === ("[a-f0-9]{64}"), \'INDEX_MUTANT_SOURCE_HASH\'\);\n    return changed;\n  \}\);', mutations)
    expected = [(m['id'], m['before'], m['after'], m['predictedTransformedSourceSha']) for m in pins['sourceMutations']]
    require([tuple(json.loads(x) for x in row) for row in rows] == expected, 'EXACT_SIX_TRANSFORMS_AND_HASHES')
    stripped_compiler = stripped_compiler[:start] + stripped_compiler[end:]
    report = "fullBuild: false,\n      selectedHelperTypecheck: indexTypecheck"
    require(stripped_compiler.count(report) == 1, 'ISOLATED_REPORT_NO_OVERALL_TYPECHECK_CLAIM')
    stripped_compiler = stripped_compiler.replace(report, 'fullBuild: false', 1)
    require(stripped_compiler == baseline[FILES[0]], 'ALL_OLD_COMPILER_MODELS_21_VARIANTS_DIAGNOSTICS_PRESERVED')
    declarations = re.findall(r'  mutate\([\'"]([A-Z_]+)[\'"]', compiler)
    require(declarations == ports['requiredSensitivityIds'], 'EXACT_27_VARIANT_DECLARATIONS')

    start = scenario.index('// Parses fixture-produced evidence only; it never calls the application helper.')
    end = scenario.index('async function runScenario(ctx)', start)
    parser = scenario[start:end]
    for variable, ids in [('caseIds', ports['requiredCaseIds'][76:]), ('sensitivityIds', ports['requiredSensitivityIds'][21:])]:
        match = re.search(r'const ' + variable + r' = \[(.*?)\];', parser, re.S)
        require(match and re.findall(r"'([^']+)'", match[1]) == ids, 'EXACT_INDEX_EVIDENCE_IDS')
    for anchor in ["Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)",
                   "Object.getOwnPropertySymbols(value).length !== 0", "Object.getOwnPropertyNames(value).sort()",
                   "Object.values(descriptors).every(row => Object.hasOwn(row, 'value'))",
                   "Object.getPrototypeOf(value) === Array.prototype && Object.isFrozen(value)",
                   "Object.getOwnPropertyDescriptor(value, String(index))", "!Object.hasOwn(descriptor, 'value')",
                   "fields?.id.value === id && fields[field].value === expected",
                   "rows(fields.cases.value, caseIds, 'status', 'PASS')",
                   "rows(fields.sensitivity.value, sensitivityIds, 'detected', true)"]:
        require(anchor in parser, 'PARSER_GUARD:' + sha(anchor)[:12])
    stripped_scenario = scenario[:start] + scenario[end:]
    bind = '  const indexEvidence = requireIndexEvidence(ctx.indexEvidence, need);\n'
    require(stripped_scenario.count(bind) == 1 and stripped_scenario.index(bind) < stripped_scenario.index('  const request = ('), 'BEFORE_HTTP_VALIDATION')
    stripped_scenario = stripped_scenario.replace(bind, '', 1)
    nominal = "\n  need(cases.length === 76 && same(cases.map(row => row.id), ctx.ports.requiredCaseIds.slice(0, 76)), 'INDEX_PRIOR_CASE_SET');\n  for (const row of indexEvidence.cases) record(row.id);\n"
    negative = "  need(sensitivity.length === 21 && same(sensitivity.map(row => row.id), ctx.ports.requiredSensitivityIds.slice(0, 21)), 'INDEX_PRIOR_SENSITIVITY_SET');\n  for (const row of indexEvidence.sensitivity) sensitivity.push({ id: row.id, detected: true });\n"
    require(stripped_scenario.count(nominal) == 1 and stripped_scenario.count(negative) == 1, 'AFTER_76_21_PREFIX_CHECKPOINTS')
    stripped_scenario = stripped_scenario.replace(nominal, '', 1).replace(negative, '', 1)
    stripped_scenario = stripped_scenario.replace('module.exports = { runScenario, requireConfigurationEvidence, requireIndexEvidence };',
                                                  'module.exports = { runScenario, requireConfigurationEvidence };', 1)
    require(stripped_scenario == baseline[FILES[1]], 'ALL_76_21_SCENARIO_AND_COUNTER_BYTES_PRESERVED')
    require('83 nominal IDs/27' in readme and 'execution7' in readme and 'NOT_RUN' in readme
            and '1084' in readme and 'TS2448' in readme, 'HONEST_README_SCOPE')


candidate = {name: (ROOT / name).read_text() for name in FILES}
rejected = False
try:
    inspect(baseline)
except (ValueError, AttributeError):
    rejected = True
require(rejected, 'ACTUAL_BASELINE_REJECTED')
inspect(candidate)
require(not git('diff', BASELINE, '--', 'src1', 'package.json', 'package-lock.json', 'test/api-runtime/platform.mjs',
                'test/api-runtime/profile.json', 'test/api-runtime/scenario/prepare.py'), 'APPLICATION_DEPS_PROFILE_PREP_UNCHANGED')
require(all(name in FILES or name == 'test/api-runtime/scenario/ports-manifest.json'
            or name.startswith('output/qa/week2-index-scenario/') for name in git('diff', '--name-only', 'HEAD').splitlines()), 'OWNED_WORKTREE_SCOPE_ROOT_PORTS_EXCEPTION')
controls = [
    (0, 'strict: true', 'strict: false'), (0, 'noEmit: true', 'noEmit: false'),
    (0, 'noUnusedLocals: true', 'noUnusedLocals: false'), (0, 'types: [], typeRoots: []', "types: ['node'], typeRoots: []"),
    (0, 'sha(bytes) === expected', 'true'), (0, 'texts.size === 45', 'true'),
    (0, 'sha(Buffer.from(rejected)) === INDEX_TDZ_SHA', 'true'),
    (0, 'readFile: file => allowedTexts.get(path.resolve(file))', 'readFile: file => fs.readFileSync(file, \'utf8\')'),
    (0, 'const data = host.readFile(file);', 'const data = fs.readFileSync(file, \'utf8\');'),
    (0, 'const program = ts.createProgram([filename], compilerOptions, host);', 'const program = ts.createProgram([], compilerOptions, host);'),
    (0, 'JSON.stringify(foundFiles) === JSON.stringify([...libraryIds, sourceId].sort())', 'true'),
    (0, 'item.category === ts.DiagnosticCategory.Error && item.code === 2448', 'item.category === ts.DiagnosticCategory.Error'),
    (0, 'item.sourceId === sourceId && item.start === referenceOffset && item.length === \'requirements\'.length', 'true'),
    (0, 'report.diagnostics.length === 0', 'true'),
    (0, 'selectedHelperTypecheck: indexTypecheck', 'selectedHelperTypecheck: {}'),
    (0, pins['sourceMutations'][0]['predictedTransformedSourceSha'], '0' * 64),
    (0, 'declarations.length === 13', 'declarations.length >= 1'),
    (1, 'const indexEvidence = requireIndexEvidence(ctx.indexEvidence, need);', 'const indexEvidence = ctx.indexEvidence;'),
    (1, 'Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)\n', 'Object.getPrototypeOf(value) !== Object.prototype\n'),
    (1, 'Object.getPrototypeOf(value) === Array.prototype && Object.isFrozen(value)', 'Object.getPrototypeOf(value) === Array.prototype'),
    (1, "fields?.id.value === id && fields[field].value === expected", 'fields?.id.value === id'),
    (1, "rows(fields.sensitivity.value, sensitivityIds, 'detected', true)", 'true'),
    (1, "cases.length === 76 && same(cases.map(row => row.id), ctx.ports.requiredCaseIds.slice(0, 76))", 'true'),
    (1, "sensitivity.length === 21 && same(sensitivity.map(row => row.id), ctx.ports.requiredSensitivityIds.slice(0, 21))", 'true'),
]
for index, (file_index, before, after) in enumerate(controls):
    name = FILES[file_index]; require(before in candidate[name], 'SOURCE_CONTROL_ANCHOR')
    weakened = dict(candidate); weakened[name] = candidate[name].replace(before, after, 1)
    rejected = False
    try:
        inspect(weakened)
    except (ValueError, AttributeError):
        rejected = True
    require(rejected, 'SOURCE_CONTROL_SURVIVED:' + str(index))
for mutation in pins['sourceMutations']:
    require(source.count(mutation['before']) == 1 and sha(source.replace(mutation['before'], mutation['after'], 1)) == mutation['predictedTransformedSourceSha'], 'PREDICTED_SOURCE_HASH')
tdz = source
for operation in pins['helperTypecheck']['inverseOperations']:
    require(tdz.count(operation['before']) == 1, 'TDZ_INVERSE_ANCHOR'); tdz = tdz.replace(operation['before'], operation['after'], 1)
require(sha(tdz) == pins['helperTypecheck']['virtualTDZSha'], 'EXACT_TDZ_TEXT_RECONSTRUCTION')
print(json.dumps({'schema': 'SD-INDEX-SCENARIO-SOURCE-1', 'baseline': BASELINE, 'baselineRejected': True,
                  'negativeSourceControlsRejected': len(controls), 'priorNominalGroupsPreserved': 76, 'priorSensitivityPreserved': 21,
                  'declaredNominal': 83, 'declaredSensitivity': 27, 'typeLibraryMapFiles': 45,
                  'contractSha': CONTRACT_SHA, 'pinsSha': PINS_SHA, 'rootPortsSha': PORTS_SHA,
                  'files': {name: sha(value) for name, value in candidate.items()},
                  'helperSourceSha': sha(source), 'reconstructedTDZSha': sha(tdz),
                  'actualCompilerPrograms': 0, 'applicationHelperEvaluations': 0, 'runtime': 'NOT_RUN'}, indent=2))
