# System design v1.7 publication checks

Verified **9 November 2026**. This is a proposed revision incorporating eight supplied review passes, AR-01–AR-36, source-qualified principal-review dispositions and a bounded M0 implementation-start approval request. It is not an approval response, implemented remediation, M0 acceptance or live-pilot release.

## Baseline and supplied reviews

- Backend branch pharmyx-fixes and HEAD `9ca8b54606581f2158e760cad79aa7b845529184` remain unchanged in tracked/staged application files. No application/lock/config code was changed. Planning artifacts remain untracked in this checkout; they must be versioned for handoff, not mistaken for committed design history.
- Review A input SHA-256: `1dcadb2f9e970701146057472c6bd4bd458900ac651bd92018f9861cdcbcc6e9`. Review B: `9a9735a3212b33b0e6094be2898d5368a80f36ba90e5163de54979a5c506e29b`. All19 hashes in Review A's manifest matched the preserved pre-v1.7 sources/evidence. This validates the input baseline, not the review's conclusions or runtime claims.
- Review A reports staged independent assessment, not blind; Review B discloses earlier AR authorship and evaluator exposure. Their architecture verdicts differ in wording, but both retain the modular core and call detailed schemas partial and implementation evidence insufficient. Neither approves this v1.7 revision, M0 acceptance, pilot or production release.
- [Principal disposition](PRINCIPAL_REVIEW_DISPOSITION.md) retains distinct Review-A:PA-01–13 and Review-B:PA-01–22 identifiers and records accepted, qualified and reproduction-pending claims. [M0 approval packet](M0_IMPLEMENTATION_APPROVAL.md) is explicitly PENDING; [approval review prompt](M0_APPROVAL_REVIEW_PROMPT.md) requests a scope decision from the reviewers/user.

## Source and evidence boundary

Graph discovery/snippets and targeted code/config/test reads rechecked selected material paths: inventory adjustBatchStock status assignment; booking date/slot validation and independently supplied practitioner/date; generic booking writable fields; wallet routes/controller/validation; specialist self-profile alias/protected flags; request corporate fallback; catalogue and notification routes; redacted email CC configuration; existing external confirmation-pending branches; pharmacy verifier stub and expiry assertion. No credential values, patient rows, saved token payloads or archive contents were opened or printed for this pass. This was not a new function-by-function audit of all53 modules.

Known R01–R17 findings remain the static source baseline at unchanged HEAD. Newly reported sensitive artifacts, some release-race/log/upload assertions and live exposure/provider behavior require the labelled owner/reproduction checks. Do not turn a reported path into a reproduced exploit or confirmed incident. No provider account/dashboard, production indexes/balances/topology or full mobile build was inspected.

No install, compile, application test, DB connection, index sync/migration, server start, provider transaction, message/call, credential revocation, Git history rewrite or deployment occurred in this revision. The two historical local readiness commands remain: npm test FAIL/exit1 placeholder; npm run type-check BLOCKED/exit127 missing tsc. They were not rerun and do not become successful or new compiler-failure results because documents changed.

## Amendments and scope preservation

- **AR-26:** explicit actor/command writable fields, trusted catalogue versus local offer, server-derived authority and protected communications. Retain legitimate server-generated login, imported unverified documents and approved descriptive/offer edits; remove general privilege/money/clinical-state writes rather than indiscriminately removing valid workflows.
- **AR-27/AR-28:** quantity cannot clear quality restrictions; legacy pharmacy availableQty already excludes reservedQty. Validate authorized slot practitioner/date/resource and define physical interval/overlap authority before M2. Current binding/stock safety remains an existing-flow release gate.
- **AR-29/AR-30:** restore admission uses a protected generation outside the rollback domain plus independently current authority/re-verification. Epoch alone cannot make fresh tokens from stale restored roles/contacts safe. Classify recoverable cash/dispense/manual-refund/clinical effects; prove independent evidence/PITR or freeze explicit exceptions. Generic RPO and provider replay do not establish zero loss or reconstruct unobserved local actions.
- **AR-31/AR-32:** retain embedded active lots with measured bounds/eligible archival and resolvable original references. Applicable label/current-list price limits use tax-inclusive exact unit/lot evidence; customer repricing needs versioned confirmation. No current size breach, production bound, complete legal applicability or regulatory data catalogue is certified.
- **AR-33:** D1/D4 precede M1 common billing/settlement contract freeze, then M2/new funds posting. D2, reconciled openings and F14 P1/P2/P3 gates remain intact. No supplied unverified tax-section claim becomes an adopted rule.
- **AR-34–AR-36:** precise assertion/gate/severity and traceability updates; preserve existing confirmation-pending handling while adding scoped provider-intent recovery; benefit/redemption effects and any funded bonus have explicit source/budget policy. Neither all5xx-refund nor all-bonus-fraud blanket assertions were accepted.
- F15 is a bounded M0 closure task reusing existing F03/F04/F06/F11/F12 responsibilities. The backlog remains acyclic and M0 has no future-phase dependency. The complete original F14 row was preserved byte-for-byte. F14 remains separately sized after P1 and M1/M2, with a conditional staffed M4 pilot; optional ABDM, M7 disconnected sync and M8 advanced HMS/LIS are unchanged.

## QA and document checks

- **115 unique selected scenarios** with matching execution IDs, per-case gates and source/review mappings. Counts: **0 PASS,1 FAIL,1 BLOCKED,110 NOT_RUN,3 DEFERRED**. These are specification/execution bookkeeping; no new runtime or code-coverage percentage is claimed.
- All70 capability IDs retain original statuses **19 Existing,18 Partial,30 Missing,3 Unverified** and map to selected scenarios; all36 AR,17 R and35 distinct principal findings have candidate mappings with no dangling scenario IDs. A mapping is not exhaustive coverage or a passing test.
- Direct held-lot regression now applies+2/replay/-1 to a fresh5-unit restricted lot: physical6, unchanged hold, eligible0 and reserve1 denied without counter/movement changes. Low-stock, discovery, statistics, grievance, raw-parser, restore-authority/local-effect and pricing regressions are explicit. Stubs/narrow assertions retain restricted reuse labels.
- Per-case gates remove accidental M0 wording from later outbound subscriptions and service consumption. Safety-critical stock/clinical cases are P0 for the affected live workflow; archival remains P2/M3. Missing compiler remains BLOCKED.
-19 numbered design sections, SD01–SD10, six Mermaid source diagrams and two valid JSON examples remain. Native-vector PDF diagrams are renderings of those sources; no Mermaid compiler was run.
- Canonical nine-category workload plus total row matches PERFORMANCE_PLAN.md exactly and sums to100 aggregate incoming HTTP RPS. No benchmark or phone-concurrency trial was executed.
- All40 business glossary terms are present; all37 previous definitions retained. Technical restore/control-plane details remain in engineering documents. Markdown links, fences and table-column consistency checked; approval status/scope and first-slice exclusions checked.
- Public review prompt/architecture PDF exclude evaluator case IDs and scoring answers; both publication source manifests exclude evaluator archives. The new public test catalogue is openly a regression plan, not an unseen holdout. No scored model evaluation or independent approval of v1.7 occurred.

## PDF publication

Both final PDFs were rendered: **121 pages inspected in14 contact sheets**, with restore admission/recoverability, approval scope/first slice and cumulative F14/F15 backlog pages also inspected at full-page size. Cover/TOC, six diagrams, glossary groups, ADR amendments, review tables, approval tables, transitions and closing sections checked. No observed clipping/overlap/glyph defects; closing-limit sections are kept together. Character-bounds checks passed for **376,301 nonblank characters** across the final artifacts.

| Artifact | Pages | SHA-256 |
| --- | --- | --- |
| [Architecture, review and pending M0 approval](../../output/pdf/Jansetu_System_Design_and_Architecture.pdf) |54| `4003d1d5e9f77670e4d289ee462a88ac5028a42e620e83be1ea61d5db5d41dcc` |
| [Cross-checked roadmap and phone specification](../../output/pdf/Jansetu_Cross_Checked_Roadmap.pdf) |67| `00ef7783f94b73acaefb784d9def0b290c5d46756aefd05ef3d2b3f611f69d1c` |

The architecture source manifest includes SYSTEM_DESIGN, ARCHITECTURE_REVIEW_PROMPT, glossary, ADR, ARCHITECTURE_REVIEW and M0_IMPLEMENTATION_APPROVAL. Full principal disposition, the115-case catalogue and CSV registers remain editable companions; they are not silently represented as included or executed in the PDF.

## Primary references and remaining gates

Checked9 November2026: [MongoDB limits](https://www.mongodb.com/docs/manual/reference/limits/) confirms the16MiB document bound; [Ministry medicine-price explanation](https://www.pib.gov.in/PressReleasePage.aspx?PRID=1983964&lang=2&reg=3) describes inclusive MRP/lower label-price-list constraints. The current NPPA order-page fetch timed out; current amendments/SKU/channel/jurisdiction applicability need qualified owners. Earlier source checks of MongoDB transactions, Razorpay, OWASP/NIST, NRCeS and RBI remain the dated historical evidence recorded in prior reviews; no new broad compliance/clinical/provider certification is claimed.

Implementation-start approval, exact first-slice runtime/field/test contracts, current capture/provider/promotion evidence, owner credential/privacy response and per-module schemas remain gates. M0 acceptance additionally needs executable regressions and reconciliation; pilot requires staffed clinical/operations journeys, D9 restore proof, provider trials and measured released-endpoint load. No funds model/provider, live operational action or production approval was selected by this publication.

Historical v1.6 artifacts were46 architecture pages (`ce0723f79e2b263abaa16f7e97f62de2d1a5235ee0096686327133b97115eca2`) and67 roadmap pages (`a253f3bdee4322ce780f1a1a860786cafd517cd8ea1e2f539bf5b075fd2abd4a`). v1.5 artifacts were43 architecture pages (`1cd0f79eed0f4b5e694cc4910ca810bef92765ed32d423a873497cd097fcbc95`) and65 roadmap pages (`3054dde65a6742ecdeea256532516bb03e73c99f39f9a613df06a9afe7900e35`). Current hashes supersede these snapshots.

## Later approval status addendum, 9 November 2026

Both reviewers subsequently approved the bounded implementation start; [current ledger](M0_START_APPROVAL_STATUS.md) records Review A and Review B C1–C3. The owner subsequently confirmed pre-launch with no real patients/payments and reported `pm2 start server`, target Node 22 and Mumbai server location. The earlier obtain-approval-then-start request covers bounded local M0-A; the remaining C2 MongoDB target facts and build/PM2 entry reconciliation are pending; the urgent live-response branch of C1 is not currently applicable, and containment remains required before first live use. This later source/roadmap addendum does not alter the frozen v1.7 PDF hashes, visual-check results or historical test outcomes above; current approval/scheduling source text is newer than those PDF input snapshots. No application/dependency/harness/production edit or application check was performed merely to record the decisions.
