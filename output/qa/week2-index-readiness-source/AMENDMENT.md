# TDZ amendment after independent review

The first candidate6597c1a0/freeze691c62da had one actual Standards
APPROVE_SOURCE_ONLY from /root/index_standards_fresh and one actual Spec
REQUEST_CHANGES from /root/index_spec_fresh. Both were fresh native sessions;
the earlier failed model/client turns receive no review credit.

Spec identified a temporal-dead-zone defect: the inner const requirements alias
shadowed the parsed manifest in the same loop block before its first read, so
all structurally valid comparisons would be caught as INPUT_INVALID. This was
static source reasoning, not executed TypeScript. The two text gates do not
detect binding semantics and never proved behavior. The defect was not active
in production: the new helper has no caller and has not been imported/executed.

Root removed that redundant inner alias and used requirementsForCollection
for the two direct index accesses. amendment.diff records only that small change.
All original source/QA/freeze/checker/failure/control bytes are preserved under
revision-1 with an exact archive manifest. The pre-source verifier remains
unchanged; no test is reshaped to claim this rename proves runtime correctness.
The future admitted actual READY/collection-refusal tests are still mandatory.

This amended candidate requires confirmations from BOTH independent reviewers.
No helper evaluation/compiler/typecheck/DB/Docker/provider/client or source
activation follows from this fix; behavior/type correctness remain NOT_RUN.


After the correct alias removal, the unchanged old source checker reports55/56
positive predicates and does not generate controls, because implicit_id_first
hardcoded the old variable name. The unchanged original companion consequently
fails its all-positive prerequisite. That actual post-fix failure is recorded;
the original47/49 run still describes the preserved initial source, not this one.

Root added explicitly post-review verify_amendment.py. It keeps the original
checker/companion bytes, requires exactly that one expected old anchor mismatch,
updates only its loop-binding anchor, retains contextual checks for both original
survivors, verifies their original saved bytes against archived source6597, and
repeats all49 source-control kinds against the amended source. Two prior extra
context controls and one reintroduced-shadow-alias control give52 textual
sensitivities. All57 positive/preservation checks pass. This is NOT TypeScript
scope analysis or behavior; independent amended source reviews and actual future
READY/refusal cases remain mandatory. No assertion is dropped to claim success.
