"""Post-source correction of two duplicated-anchor TEXT controls only.

The original pre-source verifier remains unchanged, including its actual failure.
This script neither imports nor executes TypeScript or application code.
"""
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path


def main():
    qa = Path(__file__).resolve().parent
    frozen = qa / 'verify_source.py'
    assert hashlib.sha256(frozen.read_bytes()).hexdigest() == 'd3e7b8ae23bf451121a256ea10174c0ee23d8b72e06c38b673288eb400df3e08'
    execution = subprocess.run(['python3', str(frozen)], check=False, capture_output=True, text=True)
    assert execution.returncode == 1 and not execution.stderr
    original = json.loads(execution.stdout)
    assert all(original['checks'].values())
    spec = importlib.util.spec_from_file_location('source_text_predicates', frozen)
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    source = verifier.SOURCE.read_text()
    corrected = []
    for name in ['string_bound', 'explicit_id_denial']:
        anchor = verifier.ANCHORS[name]
        occurrences = source.count(anchor)
        assert occurrences > 1
        # Remove every occurrence of the same necessary text predicate. This is
        # still source-presence sensitivity, not semantic mutation execution.
        changed = source.replace(anchor, 'SOURCE_CONTROL_REMOVED')
        corrected.append({'name': name, 'anchorOccurrences': occurrences,
                          'rejectedBySamePredicate': not verifier.inspect(changed)[name],
                          'scope': 'IN_MEMORY_TEXT_ONLY_NOT_TS_EXECUTION'})
    untouched = [row for row in original['sourceControls'] if row['name'] not in ['string_bound', 'explicit_id_denial']]
    assert len(untouched) == 47 and all(row['rejectedBySamePredicate'] for row in untouched)
    print(json.dumps({
        'schema': 'SD-INDEX-SOURCE-CONTROL-CORRECTION-1',
        'stage': 'POST_SOURCE_COMPANION_NOT_PREIMPLEMENTATION_FROZEN',
        'originalVerifierUnchanged': True,
        'originalVerifierSha256': original['verifierSha256'],
        'sourceSha256': original['sourceSha256'],
        'positivePredicates': len(original['checks']),
        'positivePredicatesPassed': True,
        'originalUnchangedControlsRejected': 47,
        'correctedControls': corrected,
        'all49TextControlsRejectedWithCompanion': all(row['rejectedBySamePredicate'] for row in corrected),
        'passed': all(row['rejectedBySamePredicate'] for row in corrected),
        'applicationBehavior': 'NOT_RUN', 'typeCheck': 'NOT_RUN',
        'applicationImports': 0, 'compilerExecutions': 0, 'databaseCommands': 0,
        'DockerCalls': 0, 'providerCalls': 0,
        'limits': original['limits'],
    }, indent=2))


if __name__ == '__main__':
    main()
