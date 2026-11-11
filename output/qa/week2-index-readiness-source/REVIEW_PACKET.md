# Part-A source candidate for two independent reviews

Author: /root/index_readiness_library, owned branch m0/week2-index-readiness.
Baseline fd1c855b7405dd020cc7e7db1efa0f47d624af39 includes the two actual
SOURCE_IMPLEMENTATION_CONTRACT_ONLY decisions recorded in the root-owned
week2-index-readiness/PRE_REVIEW.md. Frozen contract/freeze are unchanged.

Only the new src1/modules/common/utils/indexReadiness.ts and this new QA tree
are authored. No existing tracked source, fixture, manifest, package, startup,
dependency or contract file changed. The library contains no selected application
schema policy, imports, initialization effects or activated callers. Descriptor-
only admission makes private copies, tracks active cycles and aggregate budgets,
then validates all structure/duplicates before deterministic manifest-order
comparison. Own-data build markers at wrapper/spec level are opaque. Output is
a new frozen exact four-field object with nine closed codes and safe ordinals.

Actual source/data evidence:

- Before source creation, verify_source.py was frozen at
  d3e7b8ae23bf451121a256ea10174c0ee23d8b72e06c38b673288eb400df3e08.
  The real absent baseline was rejected. All1,412 existing tracked-file hashes,
  seventeen original protected files (six staged plus eleven handover) and the
  original full-index staged patch passed their read-only preservation checks.
- Current source passes all56 original positive source/preservation predicates.
  The original frozen verifier reports47/49 text controls rejected and two
  survivors because it replaces the first of two duplicated generic anchors.
  The failed result and frozen original checker remain intact.
- The explicitly post-source verify_controls_companion.py adds contextual
  function-body checks. It rejects the exact same two original single-occurrence
  inputs, whose complete inert text is retained. It also adds two distinct
  reserved-field/narrow-exception text controls. This is source-presence
  sensitivity, not behavioral mutation evidence. The original explicit_id_denial
  variant removes a redundant guard: the broad reserved-_id guard still rejects
  that field. No semantic regression is inferred from that control. The first
  remove-all-only companion draft is retained for transparent provenance and
  is not the final gate.

Read CLARIFICATIONS.md and TEST_PLAN.md. The former records three direct lead
interpretations without rewriting the contract. The latter prepares future
behavioral groups only. The frozen verifier itself never changed after its
pre-source baseline. Scope checks compare bytes, not a source golden hash as
their only acceptance predicate. Final owned hashes and new-source diff are
recorded separately in candidate-freeze.json and source.diff.

Commands (Python source/data inspection only):

```sh
python3 output/qa/week2-index-readiness-source/verify_source.py
# Expected exit1 for the preserved two generic-anchor control survivors.
python3 output/qa/week2-index-readiness-source/verify_controls_companion.py
# Contextual source gate exit0; original failure remains separately recorded.
```

Application behavior, TypeScript parse/type correctness and functional readiness
remain NOT_RUN. No application/helper import, extraction, compilation,
transpilation or evaluation, DB/listIndexes/getMore/Docker/provider/client/root
build was executed. Text checks do not prove control flow, runtime immutability,
acquisition completeness, exact provider/DB effects or type correctness.
The later distinct complete-C3 extension and exact preparation/runtime decisions
are mandatory before actual helper evidence. This is not F13, M0, Week2,
production or release acceptance. Root retains integration/Git and obtaining
the two independent nonauthor source reviews.
