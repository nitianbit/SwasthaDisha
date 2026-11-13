# Review prompt — stopped customer/pharmacy/lab checkpoint

Copy the block below into the intended reviewer. This file is a prompt, not a newly executed review or application approval.

```text
Perform an independent, read-only technical and delivery-status review of the saved SwasthaDisha checkpoint. Do not implement, run application/tests/compilers/packages, install dependencies, contact providers, deploy, push, merge, change configuration, read secrets/patient data or resume development. The owner stopped all development and asked for a proper status record and review/handover prompts.

If this is executed using the existing local Claude route, the requested reviewer is Claude Opus 5.5 with xhigh/extra-high, not max, at the highest supported requested effort consistent with xhigh. Report the actual model/session/route and observed effort separately from requested settings. Do not claim an extension-webview acknowledgement from a CLI capture. Do not initiate a new model call merely to review this prompt.

Repository: /Users/shubham/Desktop/SwasthaDisha/SwasthaDisha (nitianbit/SwasthaDisha). ewa_backend is legacy only. Codebase Memory MCP is disabled; use direct reads/rg and inert Git/hash inspection. Branches are saved separately; do not review only the old original checkout and conclude newer source is absent.

Read in this order:
1. documentation/planning/implementation/PROJECT_CHECKPOINT_2026-11-13.md in the original checkout.
2. output/qa/checkpoint-2026-11-13/{WORKTREE_INVENTORY.json,COMMIT_RECORD.json,PRESERVATION_VERIFICATION.json} there. Resolve the commit containing the status document with git log; its enclosing commit cannot self-identify in its own inventory.
3. AGENTS.md, REPOSITORY_TRANSITION.md, PARALLEL_DEVELOPMENT_WORKFLOW.md, C2 conditions/compatibility packet, foundation README and C3 fixture contract. Older automatic-continue instructions are superseded by the stop request.
4. On m0/customer-pharmacy-lab-focus: CUSTOMER_PHARMACY_LAB_DELIVERY_BOARD.md, CUSTOMER_PHARMACY_LAB_PROGRESS.md, CUSTOMER_PHARMACY_LAB_PLAN.md, the actual design/roadmap/capability sections and the exact source/review records cited below.

Source locations:
- Integration worktree: /Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab; source/QA checkpoint99e1191 plus documentation checkpoint.
- Full contact source: sibling customer-contact-proof, branch m0/customer-contact-proof, HEAD25f92bacc55b7e2261b095a3d391b81bee6f3b0d.
- Private fixture: sibling private-document-core, branch m0/private-document-core, checkpoint73078cb94491010073dada401af12f26ec635e49.
- Pure pharmacy recovery/readiness draft: sibling pharmacy-pure-recovery, checkpoint9bbc96058cf278943b58b8af81ad7f5c2e42ff1f.
- Original six-file tooling/handover checkpointe9446528c90e70a5f7480c3f9ffa36405023f21c; source was preserved exactly, now committed by explicit owner instruction.
Use the inventory/current refs to freeze actual review heads. git show branch:path can read files without switching or merging. Keep original and subsequent snapshots distinct.

Review these questions against actual source and raw evidence:
A. Does the status document accurately distinguish implemented source, actual passing focused behavior, fake/static checks, independent source review, owner acceptance and module completion? Identify omissions, stale claims or unsupported percentages/time forecasts. Preserve original eight-week TOTAL target; do not invent a replacement remaining duration.
B. Is the complete original individual-customer/pharmacy/lab scope represented, including patient/caregiver identity, recovery, prescriptions, finance, stock/returns/recalls, purchasing, counter/wholesale billing, dispatch, API/panel lab operations, specimens, private reports/critical acknowledgement and supplies? Corporate/HR/hospital expansion and final cross-module campaign remain deferred; focused checks are not deferred.
C. Inspect the actual security/correctness changes and their composition: OTP/proof/session/contact writers, ownership/protected fields, money and prescription recovery, supplier/refill queries, private-document authorization/lifetime/versioning, and protected lab provisioning. Check legitimate positive paths as well as denials. Flag permanently closed features presented as delivered, duplicate rules, unnecessary abstractions, races, ambiguous commits and unproven authority.
D. Check these exact bounded evidence records without converting their scope into broad acceptance:
   - focus: output/qa/customer-enrollment-focused/execution-1/OUTCOME_DECISIONS.json (82nominal+82restored, recording dependencies).
   - focus: output/qa/authority-pure-runtime/REAL_POST_DECISIONS.json (84 complete-module pure cases, injected facts).
   - focus: output/qa/pharmacy-pure-fixture-recovery/POSTEXECUTION_DECISIONS.json (438 pure checks).
   - focus: output/qa/pharmacy-refill-focused/shared/unit-1/OUTCOME_DECISIONS.json (152 fake-protocol checks).
   - focus: output/qa/shared-disabled-express-template/unit-3/OUTCOME_DECISIONS.json (36 unit/source-admission checks; prior reporter failure preserved).
   - contact: output/qa/customer-contact-focused/preparation/package-audit-1/OUTCOME_DECISIONS.json (713files/2201edges/12controls, static only).
   - private: output/qa/private-document-focused/fixture/install-emit-6/OUTCOME_DECISIONS.json and actual outputs (112packages/2530files, nine phases, semantic diagnostics retained, preparation only).
   - private: fixture/runtime-4 raw failed R8 result/outcomes. API_SCENARIOS/PRIVATE_CATALOG_READY is an active substep, not a native cause or complete case count.
E. Verify the ordinary-getMore fix and source-manifest composition independently. focus source0141a77 and reviews891385f change two fields plus one manifest entry/aggregate; private source2a913e4 has separately approved initiating limits and a forwarding command-entry observer. Native pagination is unverified. The lab manifest aggregate is1888d52bcf2eb92ce7a726733e2fedc0682996354b57bfbc9b4922e4ed14cc4f; no actual protected-root installation is established. Do not silently authorize one.
F. Inspect genuine Claude R13 review/capture/outcomes on focus under output/qa/customer-pharmacy-lab-claude-review/revision-13. Actual modelclaude-opus-5-5, requestedxhigh/effectiveUNPROVEN, source snapshot2c09f09, three correlated calls, historical source-only verdicts. R13 missed the later-found getMore defect. Keep F1HIGH, F5-1MEDIUM, R10-F2-2 and eight R13 nonblocking notes open unless actual new evidence closes a specific item.
G. Verify preservation: original six hashes and archive manifest, original full-index patch00b2ad0daae9ac54adda82e8a7eb1450ca25340be4412ac76f226bfd6c45ff9a, saved branch heads, explicit detached retention tags, no unintended application changes in checkpoint commits and no private data committed. Missing temporary checkouts are not automatically lost Git work.
H. Check execution safety after saving: the old private descriptor was archived byte-exact and remains bound to1eade15, not current HEAD; no manual rebind/reused approvals permitted. P7 metadata proposal/votes are historical at2132553 and operationNOT_RUN. Lab verification draft is unapproved/stale. C2/C3/application/provider/clinical/finance/owner/release gates remain. No new execution is approved by this review.

Return:
1. Highest-priority findings first: severity, exact branch/commit/file:line, concrete failing scenario, consequence and smallest justified correction. Separate source defects from missing evidence, externally controlled facts and documentation-only issues.
2. A compact customer/pharmacy/lab/shared matrix: implemented; actual verified behavior; pending implementation; missing verification/owner facts. Do not infer a completion percentage from test/commit/file counts.
3. Verdict separately for status accuracy, source correctness/composition, preservation, focused evidence and readiness to resume a named milestone. State APPROVE, REQUEST_CHANGES or NOT_PROVEN with scope. No module/release approval without full corresponding proof.
4. A short dependency-ordered next-milestone proposal using existing code and accepted unchanged checks. Flag unnecessary repeated infrastructure/review work; retain required gates. Do not execute the proposal.

Record reviewer identity, actual inspected heads/paths/hashes, execution performed (expected inert only) and limitations. Prior agent/model approval is evidence to inspect, not a substitute for independent analysis. Leave development stopped.
```
