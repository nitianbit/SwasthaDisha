# Inert matrix source contribution

Author `/root/index_matrix_fragment`, 11 November 2026. Assigned only this new QA
directory; bootstrap ownership and integration remain with
`/root/index_runtime_bootstrap`, and Root owns Git. No existing file was edited.

`run-index-matrix.fragment.txt` defines `runIndexMatrix(runtime)` for direct
integration into the admitted bootstrap, with no new runtime script/dependency.
Its runtime ports are `{manifest,observations,Long,UUID,loadHelper,runDenied}`.
`loadHelper(null|fixedId)` must return the actual freshly loaded comparator
function. Every actual comparison uses `runDenied(() => evaluate(M,O))`.

The fragment covers the frozen 172-trial table with 343 ordinary/frozen nominal
checkpoints, then 150 actual-source-variant comparisons and 300 fresh nominal
restoration comparisons for the six variants' 75 fixed references. Expected
results come only from the frozen table. The same nominal output assertion must
fail with `INDEX_RESULT_MISMATCH`; malformed results, unrelated errors and
operation attempts cannot count as detection. Actual unsafe READY and fresh
nominal same-trial denial plus complete-positive restoration are required.

Snapshots retain object/array identity, prototype, property order, descriptors,
aliases, cycles and extensibility without invoking getters. Fixture freezing
precedes the comparison snapshot. Opaque marker/native values retain identity
and are not traversed/frozen internally. The sole Proxy trial snapshots its
owned target and requires one reflection trap; ordinary/frozen accessor tests
require zero getter calls. Native UUID/invalid Long fixtures use nonenumerable
coercion canaries on the genuine instance; empty/cyclic marker values remain
unchanged. Result checks require a fresh frozen four-field plain object, closed
codes, bounded exact expected ordinals, no input references and strict-mode
mutation refusal.

Actual checks performed here: Node22 fixture-source syntax parsing only and a
Python text/data check matching all 172 constructor dispatches to the pinned
table (105 literal IDs plus 67 pattern IDs). These establish neither runtime
control flow nor actual comparator behavior. No fragment/matrix/application/
helper evaluation, TypeScript parsing/compiler, database/Docker/provider/auth
probe or Git write occurred. Integrated independent source review and later
complete-C3 execution remain mandatory. Current accepted backend evidence is
still 76/21; this fragment establishes no new 83/27 acceptance.
