# Outbound guards: direct internal reviews

10 November 2026. Baseline `eba7e5c82e3ff63af9e9a958fbd100733e1fc439`; lead `/root` authored the contract, verifier and source. All decisions below are internal Codex technical decisions, separate from owner, security, clinical, finance, runtime and release approval.

## Contract pre-reviews

Both nonauthor reviewers inspected contract SHA-256 `83022403da91bd374a976c984e89303cceea80ed6e30c30c6f777fc19dcd98b2` and all six frozen source inputs before production edits.

| Reviewer | Decision | Findings/disposition |
| --- | --- | --- |
| `/root/batch2_security_check` | APPROVE_CONTRACT_SOURCE_ONLY | No material finding. Required scope enforcement includes untracked files; verifier checks all other files, including ignored/untracked files |
| `/root/batch2_network_check` | APPROVE_CONTRACT_SOURCE_ONLY | No material finding. Verified mount/middleware ordering, actual notification effects and provider-free callback; JWT and OAuth-lifecycle residuals retained |

## Source verification

The sanitized command is `env -i PATH=/usr/bin:/bin TMPDIR=/tmp /opt/homebrew/bin/python3 -I output/qa/batch3-outbound-guards/verify-source.py` from this worktree. Its actual pre-edit invocation returned 1 at the missing notification route transformation. After the reviewed route changes it returns 0, rejects the baseline and all 25 source-negative controls, and accepts only the exact two-file transformation. The [receipt](verification.json) records source, contract and verifier hashes. TypeScript stays source data; these controls do not measure Express dispatch, JWT behavior or actual zero-provider effects.

Production hashes: notification routes `d9fe35d82ebda24be5a1f9dd5dcd0d957dbe08bccc81969dac1eb2d834649d6b`; Meet routes `e8bfff4a492ed11a18f1735528bfa4886a338b878852cde9bcea2f5d5bdd71e4`. Verifier SHA-256 `e9b62d31ae86c7982f385cf4289b91172375fcd9ba4084d3585ff834fd13d5b6`.

## Implementation reviews

| Nonauthor reviewer | Assigned scope | Decision and evidence |
| --- | --- | --- |
| `/root/batch2_security_check` | Standards/security | **APPROVE_SOURCE_ONLY**. Independently verified the exact four candidate hashes above, source diff, middleware/mounts, whole-tree scope and callback preservation; reran the inspected Python command, reproducing baseline rejection and all 25 source controls; whitespace passes |
| `/root/outbound_spec_review` | Spec/compatibility | **APPROVE_SOURCE_ONLY**. Independently verified the same candidate hashes, route/validation ordering, barrel export, 401/403 error flow, unchanged callback and internal callers; reran the inspected source command with the same results; whitespace passes |

Neither reviewer authored these files. Both used the graph for discovery and the exact current worktree for authoritative source checks. No material implementation findings or amendments were requested. Both explicitly retain NOT_RUN HTTP/JWT/provider/callback/client acceptance under C3. Their approvals neither adopt a clinical/security policy nor authorize deployment or release. This final provenance addition changes no reviewed contract, verifier or production byte.
