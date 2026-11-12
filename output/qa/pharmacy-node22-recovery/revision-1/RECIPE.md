# Isolated Node22 tool reacquisition recipe

12 November 2026. **FROZEN_RECIPE_ONLY_AWAITING_TWO_CURRENT_DECISIONS.** No acquisition, extraction, installation or Node execution has occurred. Author: internal Codex `/root/pharmacy_recovery_readiness`; the author does not approve this recipe.

Purpose: recover only the historical Node22.23.4 darwin-arm64 tool needed for separately admitted focused pure checks. [C2 conditions](../../../../documentation/planning/M0_START_APPROVAL_STATUS.md) and the [compatibility packet](../../../../documentation/planning/implementation/C2_COMPATIBILITY_REVIEW.md) were read. This is isolated test tooling; intended deployment facts, root package/lock/runtime/build/start adoption and full C3 remain gated. Final integration campaign deferral does not waive focused checks.

## Exact inputs and current provenance

| Input | Fixed value |
| --- | --- |
| Release/platform | Node22.23.4 / darwin-arm64 |
| Metadata URL | `https://nodejs.org/download/release/v22.23.4/SHASUMS256.txt` |
| Archive URL | `https://nodejs.org/download/release/v22.23.4/node-v22.23.4-darwin-arm64.tar.gz` |
| Archive SHA-256 | `c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428` |
| Sole member eligible to write | `node-v22.23.4-darwin-arm64/bin/node` |
| Extracted binary SHA-256 | `2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0` |
| Canonical destination | `/private/tmp/m0-node22/node` in a newly owned `/private/tmp/m0-node22` directory |

The official [SHASUMS256 text](https://nodejs.org/download/release/v22.23.4/SHASUMS256.txt), line2 (zero-based), currently matches the exact archive filename/checksum. The official [English release entry](https://nodejs.org/en/blog/release/v22.23.4) lists the Apple Silicon archive and repeats that checksum; its link uses the official `/dist/` spelling. The official [release directory](https://nodejs.org/download/release/v22.23.4/) confirms the filename. `/dist/` metadata fetches failed in the browsing tool; the `/download/release/` metadata fetch succeeded. No binary URL was fetched. These are metadata-tool observations, not raw HTTP response captures or signature verification. The `.tar.xz` artifact has a different checksum and is outside this recipe.

The extracted binary digest remains historical provenance from `5abb1a9987eaa9cab2105cc6a50029692013f63d:output/qa/week2-inventory-preparation/recipe-3/readiness.json` and the recovered source-data archive. It is not a published per-member checksum or a fresh measurement. Current official metadata establishes the archive checksum. Both archive and member digests must match before publishing a recovered tool. Exact archive and member byte lengths are unknown; limits below are proposed policy caps, not observed sizes. `PRIMARY_METADATA.json` distinguishes these claims.

## One small fixed script plan

`SCRIPT_PLAN.md` defines the single future Python standard-library operator. No runnable acquisition operator is included or approved. Two current independent nonauthor recipe decisions must precede its implementation/activation; the resulting exact script bytes, interpreter/launcher, invocation, source bindings and output/cleanup paths must be reviewed before any download. No recipe decision can authorize unseen code or a Node invocation.

The operator has no CLI options, supplied URL/path, package manager, shell command, fallback tool, proxy, retry, alternate host, platform or version. An approved invocation performs only metadata/archive GET, bounded data verification/extraction and owned-file publication/cleanup. Its retained outcome is `TOOL_BYTES_RECOVERED_NOT_EXECUTED`, never a fixture PASS. No `node --version`, Mach-O execution, npm, compiler, app, Docker, database or provider invocation is included.

## Proposed bounds

| Boundary | Hard ceiling |
| --- | --- |
| Schemes/hosts/port | HTTPS only; exact `nodejs.org:443`; default TLS certificate/hostname verification required |
| Redirects | Zero; all3xx reject, including same-host redirects; no `/dist/` fallback |
| Metadata response | HTTP200 only; <=65536 body bytes; exactly one expected filename/checksum row |
| Archive response | HTTP200 only; <=67108864 compressed body bytes (64MiB); no HTTP content encoding except absent/identity |
| Gzip decompression | <=1073741824 total bytes (1GiB), including skipped members/padding; consume through gzip EOF/CRC |
| Selected member | One exact regular nonsparse member; >0 and <=268435456 bytes (256MiB); no link target |
| Tar traversal | <=65536 members; only the exact fixed member's bytes may be written; no extract/extractall or archive filenames as output paths |
| Read buffers | <=65536 bytes each; lengths/content-length are never trusted as enforcement |
| Time | Connect/read socket ceilings10s/5s; metadata30s, archive180s, extraction60s; process absolute300s plus <=10s owned cleanup |
| Retries | Zero; bound/hash/ownership/HTTP/TLS failure stops for review, no cap increase |

Future implementation must enforce DNS/handshake/body/decompression deadlines with a process-level deadline/watchdog, not only a socket timeout or between-read clock check. Record measured compressed/member lengths on success without retroactively changing bounds. If the official archive exceeds a cap, retain the failure and seek review; do not silently switch formats or limits.

## Gate and result

Before activation, reviewers must resolve exact Python/launcher bytes and the watchdog/cleanup implementation, check host platform via inert OS metadata (no Node), verify canonical destination absence using lstat and review existing-path/race refusal. Prior missing `/private/tmp/m0-node22` evidence does not establish its future absence. Root obtains two independent Standards/Spec recipe decisions and exact-source execution admission; all future evidence paths must be exclusive new paths.

The operator holds fresh staging and canonical directory/file device/inode/uid identities and directory descriptors privately. It neither adopts old directories nor removes arbitrary resources based on a marker/path/hash alone. Failure cleanup and later explicit tool retirement require the captured identities and a strict allowlist; ownership drift refuses deletion and records an exception. The canonical tool remains deliberately retained on success, with an explicit retention record, until separately retired. No root PATH/symlink, NVM profile or project configuration is changed.

The next action is current independent review of this frozen recipe. Acquisition remains NOT_RUN; binary identity, tool execution and pharmacy focused verification remain NOT_RUN. Missing uncommitted constructor/296/57 raw QA remains missing. No module, runtime, C2/C3, M0, release or deployment acceptance follows from tool recovery.
