"""Post-review source TEXT checks. Never parse or evaluate the TS helper.

The original verifier, its failed controls and its original companion remain
unchanged. This revision updates the single loop-binding anchor invalidated by
the actual TDZ fix and retains contextual checks for the original two survivors.
These checks prove source sensitivity only; behavioral/type evidence is NOT_RUN.
"""
from pathlib import Path
import hashlib
import json
import runpy
import subprocess
import sys


QA = Path(__file__).resolve().parent
ROOT = QA.parents[2]
SOURCE = ROOT / 'src1/modules/common/utils/indexReadiness.ts'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    frozen = QA / 'verify_source.py'
    companion = QA / 'verify_controls_companion.py'
    assert sha(frozen.read_bytes()) == 'd3e7b8ae23bf451121a256ea10174c0ee23d8b72e06c38b673288eb400df3e08'
    assert sha(companion.read_bytes()) == 'c5ed9adbe1c902a8249426dd3b6848050feda861cf13a19179ddb6a97ea68754'
    run = subprocess.run([sys.executable, '-I', '-B', str(frozen)],
                         capture_output=True, text=True, check=False)
    assert run.returncode == 1 and not run.stderr
    old_report = json.loads(run.stdout)
    assert {name for name, ok in old_report['checks'].items() if not ok} == {'implicit_id_first'}
    assert old_report['sourceControls'] == []
    original = runpy.run_path(str(frozen))
    contexts = runpy.run_path(str(companion))['contextual']
    source = SOURCE.read_text()
    anchors = dict(original['ANCHORS'])
    anchors['implicit_id_first'] = 'indexOrdinal = 0; indexOrdinal <= requirementsForCollection.indexes.length'

    def inspect(text):
        result = original['inspect'](text)
        result['implicit_id_first'] = anchors['implicit_id_first'] in text
        local = contexts(text)
        result['string_bound'] = local['string_bound']
        result['explicit_id_denial'] = local['explicit_id_denial']
        result['collection_binding_unshadowed'] = (
            'const requirements = requirementsForCollection;' not in text
            and text.count('const requirements = parseManifest(manifestCopy.value);') == 1
            and 'const requirementsForCollection = requirements[collectionOrdinal];' in text
            and ': requirementsForCollection.indexes[indexOrdinal - 1];' in text)
        return result

    checks = inspect(source)
    checks.update({key: value for key, value in old_report['checks'].items()
                   if key in {'source_present_regular', 'all_existing_tracked_bytes_preserved',
                              'original_handover_and_staged_files_preserved', 'original_staged_patch_preserved'}})
    assert all(checks.values()) and all(contexts(source).values())
    controls = []
    for name, anchor in anchors.items():
        assert anchor in source
        variant = source.replace(anchor, 'SOURCE_CONTROL_REMOVED', 1)
        controls.append({'name': name, 'rejectedBySamePredicate': not inspect(variant)[name]})
    injections = {
        'imports_or_dynamic_code': '\nimport "forbidden";\n',
        'host_effect_globals': '\nprocess.exit();\n',
        'time_or_random': '\nDate.now();\n',
        'unsafe_types_or_suppressions': '\ntype Unsafe = any;\n',
        'input_mutation_sorting': '\nmanifest.sort();\n',
        'serialization_before_admission': '\nJSON.stringify(manifest);\n',
        'top_level_mutable_state': '\nlet shared = 1;\n',
    }
    assert set(injections) == set(original['FORBIDDEN'])
    for name, injected in injections.items():
        controls.append({'name': name, 'rejectedBySamePredicate': not inspect(source + injected)[name]})
    stub = 'export function evaluateIndexReadiness(manifest: unknown, observations: unknown) { return { ready: true }; }'
    controls.append({'name': 'always_ready_stub', 'rejectedBySamePredicate': not all(inspect(stub).values())})
    assert len(controls) == 49 and all(row['rejectedBySamePredicate'] for row in controls)
    for name, anchor in [
        ('reserved_id_field_denial', 'key.some((field) => field[0] === "_id")'),
        ('id_name_and_key_exception', 'spec.name === "_id_" && isIdKey(key)'),
    ]:
        variant = source.replace(anchor, 'SOURCE_CONTROL_REMOVED', 1)
        controls.append({'name': name, 'rejectedBySamePredicate': not contexts(variant)[name]})
    shadow = source.replace('            const requirementsForCollection = requirements[collectionOrdinal];',
                            '            const requirementsForCollection = requirements[collectionOrdinal];\n'
                            '            const requirements = requirementsForCollection;', 1)
    controls.append({'name': 'collection_binding_unshadowed',
                     'rejectedBySamePredicate': not inspect(shadow)['collection_binding_unshadowed']})
    assert len(controls) == 52 and all(row['rejectedBySamePredicate'] for row in controls)
    archived = QA / 'revision-1'
    old_source = (archived / 'src1/modules/common/utils/indexReadiness.ts').read_text()
    assert sha(old_source.encode()) == '6597c1a03c54702d89042a29263da81399934e68e8fb6c46f91c638cbe954400'
    for name in ['string_bound', 'explicit_id_denial']:
        expected = old_source.replace(original['ANCHORS'][name], 'SOURCE_CONTROL_REMOVED', 1)
        assert (QA / (name + '-original-single-occurrence.txt')).read_text() == expected
        assert not contexts(expected)[name]
    print(json.dumps({
        'schema': 'SD-INDEX-AMENDED-SOURCE-TEXT-1',
        'stage': 'POST_REVIEW_NOT_PREIMPLEMENTATION_FROZEN',
        'sourceSha256': sha(source.encode()), 'checks': checks,
        'sourceControls': controls, 'sourceControlsRejected': len(controls),
        'preservedOriginalVerifierExit': 1,
        'preservedOriginalCurrentAnchorMismatch': ['implicit_id_first'],
        'preservedInitialSourceControls': '47/49; both original source6597 variants remain exact',
        'currentLoopAnchorExplicitlyUpdated': True, 'passed': True,
        'scope': 'TEXT_AND_BYTE_INTEGRITY_ONLY; redundant_id control is structural',
        'applicationBehavior': 'NOT_RUN', 'typeCheck': 'NOT_RUN',
        'applicationImports': 0, 'compilerExecutions': 0, 'databaseCommands': 0,
        'DockerCalls': 0, 'providerCalls': 0,
    }, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
