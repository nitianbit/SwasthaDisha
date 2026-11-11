"""Post-source contextual TEXT checks for the original two surviving variants.

The frozen pre-source checker and failed result are retained. No TypeScript is
imported, compiled or executed. One original control removes a redundant guard;
its rejection establishes source structure only, not a behavior difference.
"""
import hashlib
import json
import re
import runpy
import subprocess
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def contextual(source):
    def body(start, end):
        match = re.search(r'function ' + start + r'\([\s\S]*?(?=\nfunction ' + end + r'\()', source)
        return match.group(0) if match else ''
    scalar = body('takeNode', 'initializeCopy')
    copy = body('copyData', 'boundedName')
    manifest = body('parseManifest', 'parseSpec')
    spec = body('parseSpec', 'supportedSpec')
    return {
        'string_bound': 'budget.strings > 65536' in scalar,
        'property_string_bound': 'budget.strings > 65536' in copy,
        'explicit_id_denial': 'key === null || isIdKey(key) || key.some((field) => field[0] === "_id")' in manifest,
        'reserved_id_field_denial': 'key.some((field) => field[0] === "_id")' in manifest,
        'id_name_and_key_exception': 'spec.name === "_id_" && isIdKey(key)' in spec,
    }


def main():
    qa = Path(__file__).resolve().parent
    frozen = qa / 'verify_source.py'
    assert sha(frozen.read_bytes()) == 'd3e7b8ae23bf451121a256ea10174c0ee23d8b72e06c38b673288eb400df3e08'
    execution = subprocess.run(['python3', str(frozen)], check=False, capture_output=True, text=True)
    assert execution.returncode == 1 and not execution.stderr
    original = json.loads(execution.stdout)
    assert all(original['checks'].values())
    verifier = runpy.run_path(str(frozen))
    source = verifier['SOURCE'].read_text()
    assert all(contextual(source).values())
    corrected = []
    for name in ['string_bound', 'explicit_id_denial']:
        anchor = verifier['ANCHORS'][name]
        changed = source.replace(anchor, 'SOURCE_CONTROL_REMOVED', 1)
        saved = qa / (name + '-original-single-occurrence.txt')
        assert saved.read_text() == changed
        corrected.append({
            'name': name, 'anchorOccurrences': source.count(anchor),
            'variantSha256': sha(changed.encode()), 'preservedVariant': saved.name,
            'originalSamePredicateRejected': not verifier['inspect'](changed)[name],
            'postSourceContextPredicateRejected': not contextual(changed)[name],
            'scope': 'IN_MEMORY_TEXT_ONLY_NOT_TS_EXECUTION',
            'semanticLimit': 'The broad reserved-_id field guard remains: this original single-occurrence change removes a redundant guard, not a demonstrated behavior defect.' if name == 'explicit_id_denial' else 'Separately checks the scalar-string budget guard in takeNode rather than the property-name guard in copyData.',
        })
    untouched = [row for row in original['sourceControls'] if row['name'] not in ['string_bound', 'explicit_id_denial']]
    assert len(untouched) == 47 and all(row['rejectedBySamePredicate'] for row in untouched)
    extras = []
    for name, anchor in [
        ('reserved_id_field_denial', 'key.some((field) => field[0] === "_id")'),
        ('id_name_and_key_exception', 'spec.name === "_id_" && isIdKey(key)'),
    ]:
        changed = source.replace(anchor, 'SOURCE_CONTROL_REMOVED', 1)
        extras.append({'name': name, 'rejectedByContextPredicate': not contextual(changed)[name], 'scope': 'IN_MEMORY_TEXT_ONLY_NOT_TS_EXECUTION'})
    passed = all(row['postSourceContextPredicateRejected'] for row in corrected) and all(row['rejectedByContextPredicate'] for row in extras)
    print(json.dumps({
        'schema': 'SD-INDEX-SOURCE-CONTROL-CONTEXT-2',
        'stage': 'POST_SOURCE_COMPANION_NOT_PREIMPLEMENTATION_FROZEN',
        'originalVerifierUnchanged': True,
        'originalVerifierSha256': original['verifierSha256'],
        'sourceSha256': original['sourceSha256'],
        'positivePredicates': len(original['checks']), 'positivePredicatesPassed': True,
        'contextualPositivePredicates': contextual(source),
        'originalUnchangedControlsRejected': 47,
        'originalSurvivingVariants': corrected, 'additionalContextControls': extras,
        'passed': passed,
        'applicationBehavior': 'NOT_RUN', 'typeCheck': 'NOT_RUN',
        'applicationImports': 0, 'compilerExecutions': 0, 'databaseCommands': 0,
        'DockerCalls': 0, 'providerCalls': 0, 'limits': original['limits'],
    }, indent=2))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
