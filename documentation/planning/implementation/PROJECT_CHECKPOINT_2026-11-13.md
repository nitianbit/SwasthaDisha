# Customer, pharmacy and lab — stopped checkpoint

13 November 2026, Asia/Kolkata. **Development is stopped at the owner's request.** This checkpoint saves existing work and prepares a review/handover; it does not authorize further implementation, tests, model calls, merges, pushes or deployment. No customer, pharmacy or lab module is accepted as complete.

Read this document before older progress notes. The original `SESSION_HANDOVER.md` and `START_NEXT_SESSION.txt` are preserved historical instructions from 10 November; their direction to continue automatically is superseded by this stop instruction. The user cleared the previous active goal. Resume development only after a fresh owner instruction.

## What is saved and where

The original checkout is `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha`, repository `nitianbit/SwasthaDisha`. Backend work was performed on separate local branches/worktrees; it has not been merged into the original checkout by this checkpoint. The sibling `ewa_backend` is a legacy reference.

| Checkout / branch | Saved checkpoint | Meaning |
| --- | --- | --- |
| Original checkout — `m0/f01-app-isolation` | `e9446528c90e70a5f7480c3f9ffa36405023f21c` plus the commit containing this document | Original six-file extension candidate and original handover are now committed, with their bytes preserved |
| `SwasthaDisha-worktrees/customer-pharmacy-lab` — `m0/customer-pharmacy-lab-focus` | `99e1191beabe977d44559af2231278f0a8b1249b` plus the documentation checkpoint | Integrated customer/pharmacy/lab source, existing reviewed evidence and remaining public diagnostic drafts |
| `SwasthaDisha-worktrees/customer-contact-proof` — `m0/customer-contact-proof` | `25f92bacc55b7e2261b095a3d391b81bee6f3b0d` | Full contact-change source remains isolated; accepted static dependency audit archived |
| `SwasthaDisha-worktrees/private-document-core` — `m0/private-document-core` | `73078cb94491010073dada401af12f26ec635e49` | Latest corrected private fixture preparation and both actual outcome reviews saved; generated descriptor archived |
| `SwasthaDisha-worktrees/pharmacy-pure-recovery` — `m0/pharmacy-pure-recovery` | `9bbc96058cf278943b58b8af81ad7f5c2e42ff1f` | Previously uncommitted driver-readiness draft preserved as unexecuted |

The machine inventory is `output/qa/checkpoint-2026-11-13/WORKTREE_INVENTORY.json` in the original checkout. It records every registered worktree and local branch head at collection. There were 29 existing worktrees and 86 missing historical temporary paths; missing paths do not imply their named branches disappeared. Twenty-one historical detached heads have explicit local retention tags under `checkpoint/2026-11-13/detached/`. No branch/worktree was pruned, reset or forcibly merged. Resolve the final documentation commit with `git log -1 -- documentation/planning/implementation/PROJECT_CHECKPOINT_2026-11-13.md`; the inventory cannot contain its own future enclosing commit hash.

The original staged patch was checked before committing: SHA-256 `00b2ad0daae9ac54adda82e8a7eb1450ca25340be4412ac76f226bfd6c45ff9a`, byte-identical to the original archive's `candidate.diff`. All eight archived members still match their unchanged manifest. The six files are committed now because the owner explicitly requested committing all work; they are no longer pending staged changes. Their individual hashes are retained in the checkpoint evidence. Nothing was pushed by this checkpoint; some older history was already pushed before this stop request.

## Implemented and reviewed source

This table describes delivered source increments, not passing complete business journeys. Evidence paths below are relative to the named branch, usually `m0/customer-pharmacy-lab-focus`. Use `git show branch:path` or that branch's worktree when a path is absent from the original checkout.

| Area | Source work saved | Verification and remaining limit |
| --- | --- | --- |
| Earlier security containment | Fixed-code OTP bypass/public OTP mutation containment, atomic bound OTP consumption, email secondary-recipient removal, users/wallet authority restrictions and JWT placeholder rejection; additional dependent/notification/Meet authority slices are retained in the earlier integration history | Preserve each recorded slice's actual evidence. Repository changes do not prove the deployed version, key quality, log review or past-exposure remediation |
| Customer booking and diagnostics | Signed owner scoping, notes-only customer booking updates, final owner/role write predicates, individual lab association/dependent containment and bounded local diagnostics/history reads | Source reviews exist. Actual HTTP/ODM/race/client acceptance remains incomplete; provider/sample/report truth is not invented |
| Customer enrollment | One proven destination per signup/send/verify; whole existing AuthService reused | Focused real service verification accepted, detailed below; full contact lifecycle is separate |
| Customer contact changes | Seven-writer/proof/credential-generation increment, contact metadata reader and focused fixture source | Full contact source `cf01caad` remains on the isolated contact branch. Real focused HTTP/MongoDB, uniqueness/backfill/all-writer cutover and client/recovery acceptance remain pending |
| Pharmacy prescription/funding containment | Shared prescription progress gates/CAS, prospective commerce restrictions and fetched-gateway captured-state requirement | These are containment increments. Qualified review/dispensing, paid-order recovery and complete money truth are still unfinished |
| Pharmacy operations | Customer recovery intake, pharmacy recovery worklist, stored-quality batch worklist, supplier master/CAS return projection and due-refill worklist/pause-date clearing | Source reviews exist. Real transactions/HTTP/query capacity, operational recovery, full purchasing/billing and dispatch remain pending |
| Shared staff authority | Existing pharmacy authority rules/read service with current evidence/provenance checks and actual complete-module pure verification | Injected read facts do not establish real DB/session/provisioning/clinical authority |
| Lab canonical authority | Canonical lab business and protected map/grant/revoke operator with explicit signed evidence/root/source bindings | Source reviewed, including genuine Claude R13 on its historical snapshot. Genuine protected-filesystem/crypto/native/transaction positives and S2-B operational assignment/scope are pending |
| Private documents | Shared private storage/access/versioning core and four later header/lifetime/multipart/clinical-kind corrections | Source reviewed, including genuine R12. No complete passing focused private HTTP/MongoDB campaign or production scanner/qualified release/client migration is established |
| Cursor protocol correction | `0141a77` removes invalid ordinary-getMore maxTimeMS fields from lab readiness/P7 fixture and regenerates the lab manifest; private fixture correction `2a913e4` also checks actual pagination method entry | Both independent source reviews exist for each new delta. This defect was missed by R13. New native pagination assertions have not run successfully; earlier native failure cause remains uncaptured |

The detailed older source catalogue is `CUSTOMER_PHARMACY_LAB_PROGRESS.md`; the current integrated board is `CUSTOMER_PHARMACY_LAB_DELIVERY_BOARD.md`. They contain historical paragraphs. This stopped checkpoint and exact raw records govern current-state claims.

## What has actually been verified

| Evidence | Actual accepted result | What it does not prove |
| --- | --- | --- |
| Enrollment focused service, `output/qa/customer-enrollment-focused/execution-1/OUTCOME_DECISIONS.json` on focus branch | 82 nominal cases and the same 82 after restoration; OLD plus four behavior controls detected; actual whole AuthService/Joi/JWT, 11 recording dependencies; two independent outcomes and exact resource cleanup | No HTTP/MongoDB/real OTP provider/full contact-change acceptance |
| Authority complete-module fixture, `output/qa/authority-pure-runtime/REAL_POST_DECISIONS.json` on focus branch | 84 actual pure cases, five mutants/restorations and complete module evaluations; two independent outcomes | Injected read facts, not real DB/index/provisioning/HTTP or clinical qualification |
| Pharmacy pure fixture, `output/qa/pharmacy-pure-fixture-recovery/POSTEXECUTION_DECISIONS.json` on focus branch | 438 pure checks and nine rejected weakened variants, with owned cleanup | Extracted VM/helper checks, not real MongoDB driver/business evidence |
| P7 shared lifecycle, `output/qa/pharmacy-refill-focused/shared/unit-1/OUTCOME_DECISIONS.json` on focus branch | 152 passing fake-protocol checks, independently accepted | No real P7 HTTP/ODM/catalogue/persistence result |
| Shared Express guard, `output/qa/shared-disabled-express-template/unit-3/OUTCOME_DECISIONS.json` on focus branch | 36 passing native-module/cache algorithm and actual source-admission unit cases; two outcomes and cleanup | No Express/application/DB execution. Earlier SPEC-reporter formal failure is preserved |
| Customer dependency audit, `output/qa/customer-contact-focused/preparation/package-audit-1/OUTCOME_DECISIONS.json` on contact branch | Static audit of 713 reachable files/2,201 edges, six runtime roots, two exact disabled sites and 12 ordered controls, no unresolved findings; two independent outcomes | No application or DB evaluation, new whole-source preparation or clean semantic typecheck; no automatic transfer to P7 |
| Private R9 preparation, `output/qa/private-document-focused/fixture/install-emit-6/OUTCOME_DECISIONS.json` on private branch | Scripts-disabled 112-package install and nine whole-source emission phases; 2,530 runtime files/40,852,207 bytes; both independent actual outcomes accepted | Preparation only. Nominal 193 semantic diagnostics remain: TRANSPILE_ONLY_NOT_TYPECHECKED. Corrected 24-group/eight-control application campaign NOT_RUN |
| Genuine Claude R13, `output/qa/customer-pharmacy-lab-claude-review/revision-13/operator/OUTCOME_DECISIONS_13.json` on focus branch | Actual `claude-opus-5-5`, one completed 1,394-frame session, three correlated Ruflo calls, exact ACK/review, terminal client/launcher 0 and independent process cleanup. Lab/P7/composition APPROVE_SOURCE_ONLY | Requested effort xhigh, effective effort UNPROVEN; native webview ACK false. No runtime/owner/release acceptance and no review of later source bytes |

Earlier foundation/Mongo smoke and fixed no-DB application/network results retain their exact historical scope and consumed approvals. They are not newly rerun or inherited application admission. Test counts above describe different scopes and must not be summed into module completion percentages.

## Latest failures and exact stopped boundaries

- **Customer contact:** earlier locked preparations failed first at package auditing and later at COMPUTED_REQUIRE after 17 emission phases. Their artifacts and 313 semantic diagnostics per phase remain retained. The finite Express compiler/runtime policy and consumer hooks now have source approvals, and the static dependency audit passed. No fresh post-audit locked install/emission proposal was completed before interruption. No actual contact HTTP/MongoDB campaign followed.
- **Private documents:** last application run R8 returned 1 in 4.173 seconds at API_SCENARIOS / PRIVATE_CATALOG_READY. Both independent outcomes accepted the failure record and verified the two exact containers/workspace absent. Native cause and complete domain-case progress remain unknown. R9 corrects a source-proven command defect; preparation succeeded, but the corrected application run never started.
- **Private descriptor:** the generated namespace descriptor SHA `3bec23a2bdde25628237c315d64fd01e66282e10c8964a31e5f52f49712d993e`, bound to old HEAD `1eade15`, was moved byte-exact into `install-emit-6/runtime-template.source-descriptor.archived.json`. Checkpoint HEAD is now different. Never edit/rebind that descriptor or reuse consumed approvals. Renew exact preparation/admission against a deliberate source freeze before any future run.
- **P7:** the first public-lock proposal has two exact metadata-stage votes at historical HEAD `2132553`. It never ran: no P7 lock/receipt/install/runtime descriptor was created. The checkpoint makes that old exact binding historical. New binding review precedes any future operation. Existing small catalogue does not force getMore; no continuation proof exists.
- **Lab S2-A:** the saved focused-verification proposal is an unapproved DATA draft, includes stale pre-0141 readiness/manifest hashes and proposes a new isolated filesystem role. Contract/interface/source/execution admission is still needed; it is not a ready executable recipe. No real root/key installation occurred.

The pending P7 proposal/votes and lab draft are saved under `output/qa/checkpoint-2026-11-13/pending-proposals/` on the focus branch. Older uncommitted diagnostic/semantic/driver-readiness drafts were committed with their original DRAFT/REQUEST_CHANGES status; committing them does not approve or execute them.

## Remaining module scope

Existing account/address/dependent, catalogue/cart/order, inventory and lab-discovery/provider primitives are reused. The remaining packets are not all greenfield work. Each packet still needs its defined useful behavior, focused positive/denial/race evidence, independent review and applicable owner acceptance.

| Packet | What remains | Completion evidence needed |
| --- | --- | --- |
| C1 contact/recovery | Finish destination-proven replacement, credential/session revocation and safe recovery; integrate isolated source after actual checks | Focused HTTP/DB positives, forbidden paths, races/rollback, migration/all-writer coverage and client cutover |
| C2 patient/caregiver | Permanent patient identity, no-phone assisted registration, authorized linkage/merge and versioned caregiver consent/withdrawal | Explicit actor/patient rules, positive/negative lifecycle checks and privacy/clinical acceptance |
| C3 customer lifecycle/support | Refund truth, retry/delete/retention effects and accountable support recovery | Financial-effect/fault/race checks and retained audit/owner rules |
| S1 private documents | Passing focused campaign, observed readiness, scanner and qualified release adapters, immutable corrected reports and legacy/client migration | Actual authorized bytes/version/audit behavior, failure/rollback checks and privacy/signatory acceptance |
| P1 prescriptions | Qualified review/reject/release and permitted dispensing | Current reviewer/credential/version rules, allowed and forbidden fulfilment and recovery |
| P2 money/recovery | Accountable paid cancellation/refunds, wallet/coupon/budget conservation and ambiguous-commit reconciliation | Provider facts, funded authority and replay/race/rollback/ledger evidence |
| P3 stock/returns/recalls | Batch return/quarantine/restock, recall operations and reservation/cancellation conservation | Native replica-set concurrency/rollback and exact units/movement evidence |
| P4 purchasing | Purchase orders, goods receipt, supplier invoice/payables and purchase returns | Stock-unit/source-budget contract and duplicate-effect/rollback checks |
| P5 counter billing | Invoice/receipt/credit, collections and shift reconciliation | Numbering/tax/entity/finance rules and truthful persisted totals |
| P6 wholesale/units | Buyer entitlement, pack/strip/unit conversion and versioned prices/overrides | Unit/rounding/conservation, channel denials and credit gates where enabled |
| P7 delivery/refill | Finish focused refill evidence, dispatch, pickup/delivery exceptions and low-stock handoff | Actual jobs/idempotency/persistence/index/capacity evidence |
| L1 provider events | Provider-specific authentication, durable duplicate/order fencing and safe effects | Supported actual provider contract and replay/order/refund checks; no invented universal HMAC |
| L2 lab panel/specimens | Canonical staff scope/assignments/worklist, sample collection/rejection/recollection and lifecycle propagation | Genuine provisioning/assigned HTTP positives, cross-lab/branch denials and specimen lineage |
| L3 lab reports | Upload/quarantine, qualified signatory release/correction, clinician review and critical-result acknowledgement | Immutable versions/provenance, current qualification and escalation evidence; upload alone cannot release |
| L4 lab billing/supplies | Walk-in/no-app private orders, invoices/receipts/balances and reagent receipt/use/waste/count | Shared identity/purchasing/billing units and reconciliation |
| S2 staff/client closure | Complete lab business/branch lifecycle, provisioning and actual supported-client compatibility | Real trust/custody/index/writer facts, operational scope and supported-client acceptance |

Source-only checks cannot close these packets. Known genuine-review findings **F1 HIGH**, **F5-1 MEDIUM** and **R10-F2-2** remain open, including stuck paid-prescription recovery, COD collection/custody recovery and query/index capacity. No complete feature-to-client/test/owner acceptance matrix has yet justified a module-completion percentage.

## Gates and deferrals retained

- Corporate, HR and hospital expansion and the final cross-module integration-testing campaign remain deferred. Focused checks remain required.
- Root dependency/runtime/lock/build/start/PM2 adoption remains under C2. Deployed entry point/revision, retained MongoDB version/topology and supported client builds are not established. The owner previously declined further environment details; do not repeatedly ask the same question.
- C3 pre-import resource/environment/network/provider/filesystem admission and exact ownership/cleanup still precede affected application execution. The old destructive legacy suites are not admitted.
- Real clinical qualification, pharmacy/signatory decisions, finance/provider truth, root/issuer/evidence custody, deployment/log review and release remain separate. Technical defaults cannot manufacture those facts. No live deployment or past-exposure remediation is claimed.
- Codebase Memory MCP remains disabled. Use direct file reads/rg. The local native-worker limit was lead plus three; one heavy install/compiler/application stage at a time was used for laptop memory. No further worker or stage is authorized while stopped.

## Time, effort and the next decision

The original target remains **eight weeks total**, not eight new weeks from this checkpoint. Prior unsupported five-to-ten-week remaining estimates are withdrawn. There is no verified engineer-hour ledger or complete feature throughput baseline, so neither a completion percentage nor a new finish date is asserted.

A disproportionate amount of recent effort went into pre-import isolation, source/fixture repairs, review capture and evidence packaging. These uncovered real defects, but they have not closed an equivalent number of complete business journeys. Future reporting should separate implementation, focused passing behavior, review and owner acceptance, and group work around usable feature milestones. Reuse accepted unchanged checks and avoid repeating historical discovery/reviews without a new reason.

If the owner later resumes, first review this checkpoint and choose concrete feature milestones. The immediate technical sequence is fresh C1 preparation/application evidence, separately refreshed private preparation/application evidence, P7 metadata/preparation/native evidence and a reviewed lab protected-writer fixture. Do not auto-execute that sequence from this document. Follow-on business packets above remain in scope; completing a harness is not a substitute for them.

## Preservation and limits of this checkpoint

All intended tracked/untracked project work in the existing worktrees is saved in local commits. `COMMIT_RECORD.json`, `PRESERVATION_VERIFICATION.json` and `WORKTREE_INVENTORY.json` are in the original checkout's checkpoint evidence directory. Original six/archive hashes and before/after branch heads can be independently checked. Temporary dependency bodies, machine configuration, account material, private approval/once files and raw private Claude thinking remain outside Git. Public descriptors/plans/hashes do not replace missing dependency bodies or reusable execution authority. Existing ignored local files are not erased or swept into commits.

No project test/model runner was found live during the read-only stop check. Two ordinary VS Code Claude clients were visible and were left alone; they are user-managed extension processes, not proof of an active project review. No cleanup/prune/kill of unrelated processes or Docker resources was performed. Documentation/archival verification used inert file/JSON/hash/Git operations only, plus process metadata; no application, compiler, package, provider or new model execution.

Use [the review prompt](REVIEW_PROMPT_2026-11-13.md) for a read-only independent assessment. Use [the handover prompt](HANDOVER_PROMPT_2026-11-13.md) in a new session. Both preserve the stopped state until a new owner instruction.
