# Wallet ID reads: direct internal review provenance

10 November 2026. Baseline `eba7e5c82e3ff63af9e9a958fbd100733e1fc439`; branch `m0/batch3-wallet-reads`. Worker `/root/wallet_read_contract` authored the contract and implementation. Reviews are internal Codex technical reviews, not named-owner, external Review A/B, runtime, deployment or release acceptance.

## Contract pre-reviews

The lead directly obtained **APPROVE_CONTRACT_SOURCE_ONLY** from nonauthors `/root/batch2_security_check` and `/root/batch2_network_check` for frozen `CONTRACT.md` SHA-256 `1b87df138ddc5038a53678f316c947503630c020423e1d4bb571cd61b32ab727`, before production edits. The lead reported both reviewers verified the six frozen hashes and schema/types/service/lean/validation behavior. Their requested binding of repository/types/validation inputs is included in the retained source-data verifier.

## Implementation reviews

Pending two direct independent nonauthor Standards and Spec reviews of the frozen implementation and retained source evidence. No author self-approval is claimed.

## Verification limits

`verify-source.py` uses the Python standard library and read-only Git commands. Named text diagnostics explain rejected variants; exact baseline transformation, frozen input hashes and tracked/untracked scope are its binding gate. It never imports or evaluates TypeScript. Passing source controls establishes the reviewed source shape, not mounted runtime authorization, validation order, zero provider effects or client compatibility. Future runtime cases remain NOT_RUN under the frozen contract's C3 gates.

## Final implementation reviews

The earlier pending status above records the handoff state before these decisions. The lead directly obtained the following independent nonauthor implementation reviews of the exact frozen candidate:

| Internal Codex reviewer | Responsibility | Decision and evidence |
| --- | --- | --- |
| `/root/batch2_security_check` | Standards/security | **APPROVE_SOURCE_ONLY**. Inspected the full diff and source contracts, reran the sanitized retained Python gate, confirmed 22 rejected source controls, five rejected structural controls, all 13 pinned inputs and whitespace checks; no material findings |
| `/root/outbound_spec_review` | Spec | **APPROVE_SOURCE_ONLY**. Independently inspected the full diff and source/error/lookup/response ordering, reran the same sanitized gate, confirmed all controls and pins, and independently enumerated untracked paths as owned evidence only; no material findings |

Reviewed frozen SHA-256 values: controller `3b22b878fd8717b8b88620c2cb5ff3f00337f5d887beea86050fcd34d222264f`; contract `1b87df138ddc5038a53678f316c947503630c020423e1d4bb571cd61b32ab727`; verifier `786f7d2f292206eba66763877a684b176f41c6cc1eb9bd738c3e011fd9a273a5`; production patch `f0cf7d10621f8224e2c27b26fa38f99112970b57e302055bf73b932ffa78789f`. The 22 source controls include rejection of the unprotected baseline.

The lead reported both decisions directly to the author and authorized the local lane commit. Only this provenance record changed after the reviewed freeze; frozen production, contract, verifier, patch and receipts retain their bytes. The reviews establish source-only conformance. No TypeScript, extracted method, application, database, provider or Docker execution occurred. Runtime cases remain NOT_RUN; operational/security-owner, C2/C3, deployment and release gates remain unchanged. No push is authorized or performed by this local commit.

Whitespace verification covers production and owned evidence except the frozen `candidate.diff`: its four single-space blank-context markers (lines 16, 29, 43 and 60) are valid unified-diff syntax and retain their reviewed bytes. They are excluded from trailing-whitespace normalization; the patch hash remains binding.
