"""Read TypeScript as inert text. This is NOT a compiler or behavior test.

No application extraction, imports, transpilation, evaluation or side effects.
The frozen named source predicates detect their own specified source changes;
they cannot establish control flow, type correctness or runtime semantics.
"""
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
QA = ROOT / 'output/qa/week2-index-readiness-source'
SOURCE = ROOT / 'src1/modules/common/utils/indexReadiness.ts'

# These source-presence predicates are frozen before the implementation exists.
ANCHORS = {
    'parameterized_unknown_api': 'export function evaluateIndexReadiness(manifest: unknown, observations: unknown): IndexReadinessResult',
    'fresh_frozen_result': 'return Object.freeze({ ready: code === "READY", code, collectionOrdinal, indexOrdinal });',
    'descriptor_inspection': 'Object.getOwnPropertyDescriptor(frame.source, key)',
    'plain_object_prototypes': 'prototype !== Object.prototype && prototype !== null',
    'ordinary_array_prototype': 'prototype !== Array.prototype',
    'own_keys_inspection': 'Reflect.ownKeys(value)',
    'accessor_denial': '!Object.prototype.hasOwnProperty.call(descriptor, "value")',
    'active_cycle_denial': 'active.has(value)',
    'node_bound': 'budget.nodes > 8192',
    'string_bound': 'budget.strings > 65536',
    'collection_bound': 'data.length > 13',
    'explicit_bound': 'entry.indexes.length > 8',
    'explicit_total_bound': 'total > 104',
    'observed_collection_bound': 'listing.indexes.length > 64',
    'observed_total_bound': 'total > 256',
    'key_bounds': 'value.length > 16',
    'key_direction': 'entry[1] !== 1 && entry[1] !== -1',
    'field_pattern': '/^[A-Za-z_][A-Za-z0-9_.]*$/',
    'partial_depth': 'depth > 6',
    'ttl_range': 'value >= 0 && value <= 2147483647',
    'explicit_id_denial': 'isIdKey(key)',
    'duplicate_key_denial': 'keys.some((previous) => sameKey(previous, key))',
    'duplicate_name_denial': 'names.has(spec.name)',
    'ordered_key_matching': 'left[index][0] === entry[0] && left[index][1] === entry[1]',
    'opaque_marker_context': '(frame.context === "row" || frame.context === "spec")',
    'opaque_marker_presence': 'key === "indexBuildInfo" || key === "buildUUID"',
    'simple_collation_only': 'value.locale === "simple"',
    'partial_presence_equality': 'requirement.partialPresent !== observed.partialPresent',
    'partial_structural_equality': 'equalJson(requirement.partial, observed.partial)',
    'ttl_presence_equality': 'requirement.ttl !== observed.ttl',
    'unique_equality': 'requirement.unique !== observed.unique',
    'sparse_equality': 'requirement.sparse !== observed.sparse',
    'required_visibility': 'observed.hidden',
    'id_name_exception': 'spec.name === "_id_" && isIdKey(key)',
    'failed_status_refusal': 'listing.status === "FAILED"',
    'incomplete_status_refusal': 'listing.status === "INCOMPLETE"',
    'exact_build_mode': 'listing.mode !== "MONGODB_8_INCLUDE_INDEX_BUILD_INFO"',
    'unsupported_refusal': 'listing.unsupported',
    'building_refusal': 'listing.building',
    'implicit_id_first': 'indexOrdinal = 0; indexOrdinal <= requirements.indexes.length',
    'fixed_exception_mapping': 'return makeResult("INPUT_INVALID");',
}
CODES = [
    'READY', 'MANIFEST_INVALID', 'OBSERVATIONS_INVALID', 'OBSERVATION_FAILED',
    'OBSERVATION_INCOMPLETE', 'OBSERVATION_UNSUPPORTED', 'OBSERVATION_UNREADY',
    'REQUIRED_INDEX_UNSATISFIED', 'INPUT_INVALID',
]
FORBIDDEN = {
    'imports_or_dynamic_code': r'\b(?:import|require|eval)\b|\bnew\s+Function\b',
    'host_effect_globals': r'\b(?:process|globalThis|console|fetch|XMLHttpRequest|WebSocket|setTimeout|setInterval|setImmediate|CONFIG|mongoose)\b',
    'time_or_random': r'\bDate\b|Math\.random|\bcrypto\b',
    'unsafe_types_or_suppressions': r'\bany\b|@ts-(?:ignore|nocheck)|Object\.hasOwn|\.at\(',
    'input_mutation_sorting': r'\.(?:sort|reverse|splice|shift|unshift|pop)\(',
    'serialization_before_admission': r'JSON\.(?:parse|stringify)',
    'top_level_mutable_state': r'^(?:export\s+)?(?:const|let|var)\s',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inspect(source):
    # Only the author's inert source text is inspected; this is not a TS parser.
    checks = {name: anchor in source for name, anchor in ANCHORS.items()}
    checks.update({name: re.search(pattern, source, re.M) is None for name, pattern in FORBIDDEN.items()})
    checks['closed_result_codes'] = all('"' + code + '"' in source for code in CODES)
    checks['only_function_runtime_export'] = re.findall(r'^export function (\w+)', source, re.M) == ['evaluateIndexReadiness']
    checks['no_default_export'] = 'export default' not in source
    checks['fixed_result_fields'] = 'readonly ready: boolean;' in source and 'readonly code: IndexReadinessCode;' in source and 'readonly collectionOrdinal: number | null;' in source and 'readonly indexOrdinal: number | null;' in source
    return checks


def main():
    baseline = json.loads((QA / 'scope-baseline.json').read_text())
    preservation = all((ROOT / path).is_file() and sha((ROOT / path).read_bytes()) == digest for path, digest in baseline['tracked'].items())
    original = Path(baseline['originalCheckout'])
    protected = all((original / path).is_file() and sha((original / path).read_bytes()) == digest for path, digest in baseline['protectedOriginal'].items())
    # Read-only Git inspection is needed to compare the six staged bytes exactly.
    staged = subprocess.run(['git', '-C', str(original), 'diff', '--cached', '--binary', '--full-index'], check=True, capture_output=True).stdout
    original_staged = sha(staged) == baseline['originalStagedPatchSha256']
    present = SOURCE.is_file() and not SOURCE.is_symlink()
    source = SOURCE.read_text() if present else ''
    checks = inspect(source)
    checks.update(source_present_regular=present, all_existing_tracked_bytes_preserved=preservation, original_handover_and_staged_files_preserved=protected, original_staged_patch_preserved=original_staged)
    negatives = []
    if all(checks.values()):
        for name, anchor in ANCHORS.items():
            weakened = source.replace(anchor, 'SOURCE_CONTROL_REMOVED', 1)
            negatives.append({'name': name, 'anchorOccurrences': source.count(anchor), 'rejectedBySamePredicate': not inspect(weakened)[name], 'scope': 'IN_MEMORY_TEXT_ONLY_NOT_TS_EXECUTION'})
        for name, pattern in FORBIDDEN.items():
            injection = {
                'imports_or_dynamic_code': '\nimport "forbidden";\n',
                'host_effect_globals': '\nprocess.exit();\n',
                'time_or_random': '\nDate.now();\n',
                'unsafe_types_or_suppressions': '\ntype Unsafe = any;\n',
                'input_mutation_sorting': '\nmanifest.sort();\n',
                'serialization_before_admission': '\nJSON.stringify(manifest);\n',
                'top_level_mutable_state': '\nlet shared = 1;\n',
            }[name]
            negatives.append({'name': name, 'rejectedBySamePredicate': not inspect(source + injection)[name], 'scope': 'IN_MEMORY_TEXT_ONLY_NOT_TS_EXECUTION'})
        stub = 'export function evaluateIndexReadiness(manifest: unknown, observations: unknown) { return { ready: true }; }'
        negatives.append({'name': 'always_ready_stub', 'rejectedBySamePredicate': not all(inspect(stub).values()), 'scope': 'IN_MEMORY_TEXT_ONLY_NOT_TS_EXECUTION'})
    result = {
        'schema': 'SD-INDEX-READINESS-SOURCE-DATA-1',
        'scope': 'TEXT_AND_BYTE_INTEGRITY_ONLY',
        'sourceSha256': sha(source.encode()) if present else None,
        'verifierSha256': sha(Path(__file__).read_bytes()),
        'checks': checks, 'sourceControls': negatives,
        'passed': all(checks.values()) and all(row['rejectedBySamePredicate'] for row in negatives),
        'applicationBehavior': 'NOT_RUN', 'typeCheck': 'NOT_RUN',
        'applicationImports': 0, 'compilerExecutions': 0, 'databaseCommands': 0,
        'DockerCalls': 0, 'providerCalls': 0,
        'limits': 'Source anchors are necessary textual evidence, not a parser, proof of control flow, functional behavior, type correctness, acquisition completeness or activation.',
    }
    print(json.dumps(result, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
