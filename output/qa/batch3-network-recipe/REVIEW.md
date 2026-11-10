# One network-admission run: review and executed evidence

10 November 2026. Candidate: clean detached `eba7e5c82e3ff63af9e9a958fbd100733e1fc439`. Preparation/evidence branch: `m0/batch3-network-recipe`. Internal Codex `/root/batch2_network_check` authored the operator/packet and archived evidence; `/root` performed the single reviewed invocation. The author does not approve their own work.

These are internal technical decisions, separate from the original external Review A/B, named-owner acceptance and deployment/release authority. Earlier failures remain preserved. Frozen preparation documents retain their historical NOT_RUN wording; the newer executed result is recorded here and in [verification.json](verification.json).

## Review amendment and exact one-run decisions

The earlier operator was `7ca93c239835023a8be1ad32c8ea1e0ccabb85e6773ae694858269ea966b39ef`, with review input `79d420c2e555b741259d2fd0c3b58a55509ca7dbbf43601e337852093673b3dd`. Standards approved that earlier packet, but Spec returned **REQUEST_CHANGES**: assigning launcher count 1 before saving/opening streams/subprocess creation could falsely record a real invocation after a pre-spawn failure. No run occurred on that candidate.

The amendment separates persistent `attempt_claimed` from launcher count. Count stays 0 through saves and stream opens, becomes UNKNOWN around process creation/completion, and becomes 1 only after `subprocess.run` returns. Any postclaim exception is UNRESOLVED/review-required; the claim is retained, and the outer error handler preserves known accounting state. AST/source-order checks passed without executing the operator. Candidate, image, endpoint, engine, grants and allowed actions were unchanged.

The final run decisions bind:

| Input | SHA-256 |
| --- | --- |
| Operator | `8586e6ad4a3482aa033b5d98a3c9da3eae3c81324824df163ea13bb7b4092651` |
| Source manifest | `6d71e8c47f46bc941751515f15e0d3c802be6863d7192d61ad3966d6730dc804` |
| Review input | `7ac9f41b4fd75334a68836bfd8f051d1e16a86ea01647c7fbb5044ff06fdf7c8` |
| Contract | `e5f2897a5361080956c5b3be37e405134c91ddb7836dc3c58ac4f1673523c141` |

| Direct nonauthor reviewer | Exact amended decision |
| --- | --- |
| `/root/batch2_security_check` | **APPROVE_ONE_FIXED_NO_DB_RUN** |
| `/root/outbound_spec_review` | **APPROVE_ONE_FIXED_NO_DB_RUN** |

The coordinating root obtained those actual explicit decisions before execution and retained them in the [one-run approval receipt](execution-1/one-run-approval.json), SHA-256 `60f3c632bea45168205b4e86722beb315c8f46e8d51a97870e6b88be6bb17084`. The synthetic receipt is trusted coordinator bookkeeping; it is not an external approval or authority to select another target. Preparation-quality approval alone was insufficient.

## Measured result and consumed scope

**PASS for the fixed no-DB scenario.** One launcher invocation completed at 20:57:08–20:57:11 IST on 10 November (raw UTC timestamps retained). `attempt_claimed` is true and `launcher_invocations` is 1. The [persistent claim](execution-1/attempt-claim.json) remains retained; this one-run approval is **consumed**, with no retry or further invocation authorized.

- All 34 source/evidence mappings matched the clean detached candidate before image checks, immediately before launch and after launch.
- The exact cached image and recorded Linux engine matched. The operator performed no pull, daemon startup, target/grant change or separate cleanup mutation.
- Actual bootstrap admission and filesystem/process permission canaries passed. The unchanged production search-escaping helper's literal-search assertion and the unknown-port-operation rejection passed.
- Seven distinct provider-port requests were `recorded` with `effect:false`. `databaseMode` remains `not-admitted`; this is no payment, message, provider SDK or database acceptance.
- The admitted observation contains one loopback device, one regular control file and nine admin-down devices. The frozen ENETUNREACH-only classifier returned true. Its raw successful canary exception is not separately emitted, and no independent route table, namespace provenance, local kernel configuration or IPv6-route proof is claimed.
- Early acknowledgement, stdout and operator result agree on container `47e37d5f35ba588bf38cc1df4988d6075c72b960efbcf5e5f226e969f0265d6b` and workspace `/private/tmp/sd-app-isolation-6Q3YI8`. The launcher acknowledged cleanup. Independent retained readback confirms the same engine, that exact container absent, that exact workspace absent and zero purpose labels before/after.

## Archive integrity and post-execution review

[archive-manifest.json](archive-manifest.json), SHA-256 `b64ce47ef4a005386db65e47b3fd98b92d0a80f45bff47edc914ab86594379b0`, freezes 22 regular raw JSON/TXT files and two synthetic approval/claim files, plus the verification summary. Each archive file is byte-identical to its source. The operator owner marker and the Docker auth-config directory were excluded. No source/workspace contents, credentials or operational files were copied. All five frozen preparation files remain unchanged.

The primary source result hashes are:

| Raw artifact | SHA-256 |
| --- | --- |
| `operator-result.json` | `95117a73da1eda185e65df2af2e425893c4c7f7f2b2e5ae0743cde34371a3dc9` |
| `launcher.stdout.txt` | `b132cf33a79947134fd19ac80ea44c60f717c619a68b4f0d56f2c621499f35b4` |
| `launcher.stderr.txt` | `35223ddbe04e8a90341c15053b8dd0ea770083a2106b73ebe03c77659caabf7e` |

| Post-execution nonauthor reviewer | Decision |
| --- | --- |
| `/root/batch2_security_check` | **ACCEPT_BOUNDED_RUNTIME_EVIDENCE**; no material findings |
| `/root/outbound_spec_review` | **ACCEPT_BOUNDED_RUNTIME_EVIDENCE**; no material findings |

Both reviewers independently verified the raw hashes, actual approval/claim, one completed launcher, all 34 clean source pins and recomputed six-file bundle/network summary, seven recorded/effect:false receipts, same-engine exact-container missing response with empty-array stdout, zero labels and exact workspace absence. Both retain the canary/route/namespace/IPv6 limitations and the full-C3/API/DB/provider/M0/release gates; the run approval is consumed.

The archival author only read/hashed retained files and wrote this assigned evidence directory. No operator, Node, Docker/socket, launcher, helper or application code was invoked while archiving. These actual post-execution decisions preceded the local evidence commit. REVIEW.md records subsequent decisions outside the immutable archive manifest.

| Completion boundary | Result |
| --- | --- |
| Exact reviewed no-DB synthetic/helper run | PASS, one invocation; cleanup proved |
| Archive and frozen-packet preservation | Byte-identical; hashes verified |
| Full C3, app/DB/provider integration, M0 and release | Remain open; no domain scenario status changes |
| Further execution | No authorization remains from the consumed run |
