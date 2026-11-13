# SwasthaDisha session handover — 10 November 2026

## Resume objective and owner instructions

Finish connecting the **existing local VS Code Claude Code and Codex extensions through Ruflo**, then continue bounded project development with parallel workers and direct independent reviews. The owner explicitly corrected the approach: “you use ruflo and connect with extension no remote needed.” The latest request is to prepare this handover for a new session; activation was stopped at that boundary.

Use local stdio/shared state, existing extensions and their ordinary accounts. A separate Claude CLI OAuth flow was started, then cancelled on the correction; it exited 130. Do not restart that flow or introduce hosted workers/API accounts as the assumed solution. Local coordination does not make either model run offline.

The owner authorizes parallel agents, explicit module/file ownership and direct technical reviews. **Do not ask the owner to carry review prompts between agents.** Inspect actual changes, fix findings, obtain review of amendments, and continue admitted work. Named clinical/finance/security/operational decisions and deployment/resource permissions retain their own owners. Internal Codex review is not an external Claude or human approval.

## Repository: use this checkout

- Active: `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha`.
- Remote: `https://github.com/nitianbit/SwasthaDisha.git`.
- Branch: `m0/f01-app-isolation`.
- HEAD: `5aecb5578869995063eabad5bc5a4c95c79f017b` — already pushed.
- Legacy reference: `/Users/shubham/Desktop/SwasthaDisha/ewa_backend`. Do not implement there. The previous session's environment cwd still pointed at that legacy path, so commands deliberately used the active checkout as workdir. Open the active checkout in the new session.
- Read [AGENTS.md](../../../AGENTS.md). For code discovery prefer graph project `swasthadisha`; use exact files/rg when the graph lacks new symbols. New `tools/agents` symbols were missing from the graph.

### Six staged, uncommitted changes — preserve them

| File | Change |
| --- | --- |
| `tools/agents/ruflo-local.mjs` | New self-contained local stdio adapter, 208 lines |
| `tools/agents/ruflo-local.test.mjs` | New stdlib policy/lifecycle tests, 243 lines |
| `documentation/planning/implementation/LOCAL_EXTENSION_COLLABORATION.md` | Local extension design, join procedure and actual limits |
| `documentation/planning/implementation/AGENT_TOOLING.md` | Pointer to local extension workflow |
| `documentation/planning/implementation/PARALLEL_DEVELOPMENT_WORKFLOW.md` | Same pointer |
| `CLAUDE.md` | Pointer to shared Ruflo workflow |

The index and worktree matched for all six files at handover. There were no unstaged edits to those files. The handover document/archive were added afterward and deliberately remain **unstaged/uncommitted**, outside the frozen candidate. No application, package/lock, startup or foundation/application harness source changed in this increment. Do not reset, clean or overwrite these files.

Frozen six-file patch SHA-256: `00b2ad0daae9ac54adda82e8a7eb1450ca25340be4412ac76f226bfd6c45ff9a` against HEAD above. Runtime SHA: `57c226be79e9b832e6ee2b7122d387102b878f0ecaa7862a6fd65c4b64268b4d`. Test SHA: `ca37e313b992af1acce851e8f2b4f1bc13443715396d5c098c0b7a33047cfc3b`.

Full hashes, exact patch, test receipt and prepared integration recipe are in [the durable archive](handover/2026-11-10-local-extensions/review-input.json). Validate [artifact hashes](handover/2026-11-10-local-extensions/artifacts.sha256.json) before relying on them. Original `/private/tmp` files may disappear; use these copies. Private configuration backups are referenced, never copied into Git.

## What already works

1. **ECC 2.2.3** installed in Codex; 314 skill definitions were observed. Its plugin cache is under `~/.codex/plugins/cache/ecc/ecc/2.2.3`. Existing Codex settings were preserved.
2. **Ruflo/CLI 3.75.0** installed under `~/.codex/runtimes/ruflo/3.75.0`; exact package lock retained. npm lifecycle scripts and optional dependencies were omitted. No upstream init, hooks or auto-fix setup was run.
3. Codex MCP server **`ruflo`** is registered and enabled, currently calling the pinned CLI **directly**, not the new adapter. Node is `/Users/shubham/.nvm/versions/node/v24.19.0/bin/node`; args are `~/.codex/runtimes/ruflo/3.75.0/node_modules/@claude-flow/cli/bin/cli.js mcp start --transport stdio`. Actual cwd is `~/.codex/ruflo-state/swasthadisha`.
4. The original five-call, two-process Ruflo task persistence test passed: create, restart, read, complete, read completed100. Both test-owned processes exited. Evidence: [Ruflo verification](../../../output/qa/tooling/ruflo-2026-11-10/VERIFICATION.md). This did not test team/mailbox operations or real Claude.
5. Native Codex workers are genuinely callable in this session. `/root/codex_connection_check` independently read HEAD and workflow and returned a real handshake. The previous runtime allowed **four native agents total**, lead plus up to three workers; installing Ruflo does not increase that limit. Recheck the new runtime's limit.
6. Installed skill: `~/.codex/skills/ruflo/SKILL.md`; it was adapted for native execution and bounded local coordination. Original upstream skill remains in its references. [Current workflow](PARALLEL_DEVELOPMENT_WORKFLOW.md).

Ruflo exposes team/task metadata; `team_spawn` does **not** execute a model worker. Team members and task-assignment agent IDs use different stores; initially keep task records unassigned and put native ownership in descriptions/results.

## Adapter implementation and checks

The new adapter launches only the pinned local CLI using its own Node executable, fixes the actual child cwd to shared state, supplies a sanitized child environment, disables daemon auto-start, and keeps policy trust/model-cache paths in state. It forwards only initialize/ping/tool discovery/calls and selected notifications. Discovery and dispatch enforce the same 13 tools; only shallow, non-repairing health checks are allowed. Frames, pending requests and stderr are bounded. This is trusted local integration, not an OS sandbox.

Allowed names: `mcp_status`, `system_health`, `team_create`, `team_spawn`, `team_send`, `team_inbox`, `team_status`, `team_shutdown`, `task_create`, `task_status`, `task_list`, `task_update`, `task_complete`.

**14 tests PASS; zero failures/skips/TODOs/cancellations.** [TAP](handover/2026-11-10-local-extensions/adapter-unit.tap), [execution receipt](handover/2026-11-10-local-extensions/adapter-unit.json). The command used Node24 with `--experimental-test-isolation=none --test --test-reporter=tap` and an empty environment. Tests cover pure policy plus actual adapter main in newly owned synthetic HOME directories containing a fake Node CLI. They invoked no real Ruflo, model, backend, provider or Docker.

A reviewer found a real P2 lifecycle defect in the first draft: asynchronous stdout/stderr EPIPE could bypass owned-child cleanup. The worker amended it before activation. Two real-main regressions close one consumer pipe while leaving stdin open and require bounded failure plus exact fake-child absence; the fake ignores input EOF/output errors so parent crashes cannot look like successful cleanup. Original pipe errors are retained, and final diagnostic handling keeps its error listener on failed writes.

**Final independent approvals for this amended six-file candidate were not completed before interruption.** Standards review was preliminary with no material findings. Spec review confirmed the original P2, then awaited final hashes/test evidence and final inspection. Do not treat the earlier tooling commit's approvals as approval of this adapter.

Agent identities from this session: `/root/local_ruflo_adapter` authored only the two tool files; `/root/claude_connection_research` researched official support and preliminary Standards; `/root/codex_connection_check` performed preliminary Spec. Cross-session agents may not be resumable; new independent reviewers can use the archived exact inputs. Source is stable; no need to rebuild it from scratch.

## What is NOT connected or executed yet

- Claude's user MCP configuration currently lists `codebase-memory-mcp` only. **Ruflo has not been added to Claude.**
- Codex still uses its original direct Ruflo CLI profile. The new adapter has not been installed outside the checkout or activated in either client.
- No real adapter/Ruflo integration smoke, two-client mailbox roundtrip or genuine Claude-extension ACK has run.
- Shared state contains **no teams**, and `extension-link.json` does not exist at handover.
- No live Claude model/reviewer was called. A separate sanitized CLI auth status reported not logged in, but that alone does not establish the GUI extension's current account state. No credentials were read/displayed; no password/code should be requested in chat.

Claude Code extension is installed at `~/.vscode/extensions/anthropic.claude-code-2.1.319-darwin-arm64`. Its bundled binary is `resources/native-binary/claude`; a standalone `claude` command is not on PATH. Config-only MCP commands can use this binary without installing another CLI.

Local config backup: `~/.codex/backups/local-extension-link-20261110-083908/{codex-config.toml,claude-config.json}`. Codex config SHA at handover: `11a416f541286f77cead9227901850d910b07909a57e65ea50abe38c15657a8c`. Preserve current unrelated settings and sign-ins; they can change independently after this snapshot.

## Exact next actions

1. Verify current branch/HEAD/status and the six-file inventory; preserve the staged work and handover archive. Read the applicable skill and workflow.
2. Obtain **direct independent Standards and Spec reviews** of the final frozen source and 14-test evidence. Close material findings, rerun only affected checks and refresh hashes if amended. No user prompt relay is needed. Review the prepared smoke recipe before running it.
3. After review, install the self-contained adapter into a content-addressed local path such as `~/.codex/ruflo-state/swasthadisha/adapters/<source-sha>/ruflo-local.mjs`. Verify the installed hash. Point both clients at the same absolute Node and installed adapter, keeping the same shared state. This avoids branch switches deleting a global launch target.
4. Update Codex's existing `ruflo` profile and register the same local server with Claude using the official `mcp add-json` configuration command. Claude had no user-scoped `ruflo` collision at handover; preserve all other configuration. Do not enable blanket project-server or hook approval. Record sanitized public profiles and verified backups, never credentials.
5. Inspect/adapt [the prepared smoke](handover/2026-11-10-local-extensions/prepared-local-extension-smoke.py), which is **NOT_RUN**. It reads the live Codex profile, expects the adapter's 13-tool discovery, tests an unlisted-call denial, exercises a mailbox roundtrip between two direct MCP clients, then creates `swasthadisha-local` with `codex-lead`/`claude-reviewer` metadata and queues a unique challenge. It writes private `extension-link.json` as PENDING_CLAUDE_EXTENSION_ACK. It is not an actual Claude-model test. Check for partial artifacts/teams/link before retrying an interrupted invocation; do not blindly overwrite or duplicate mutations. Verify only owned process cleanup, leaving host-managed MCP servers alone.
6. Open the existing Claude extension with a local join message prefilled using the documented `vscode://anthropic.claude-code/open?prompt=<URL-encoded-text>` handler. It **prefills and does not submit**. One initial Send in Claude is required; retain normal extension trust/account/tool controls. Ask that session only to read its named Ruflo inbox and send the exact challenge ACK to `codex-lead`, with no code changes/tests/approvals. Record a live Claude connection only after its actual reply. A mailbox does not wake an inactive extension; queued requests wait until its active agent reads them. Do not imply full unattended cross-extension dispatch exists.
7. Archive real results and review provenance, update current docs, commit the coherent reviewed change and push the current development branch. Include this handover appropriately; do not accidentally commit private backup/config credentials.
8. Continue the next ready development slice below. Ask the owner only for genuinely missing owner-controlled decisions/actions, while progressing unrelated admitted work.

## Backend development state after connection work

SwasthaDisha/Jansetu is a pre-launch healthcare platform. The architecture remains a modular monolith around existing Express/TypeScript/TypeDI/Mongoose backend modules. Architecture/planning acceptance is not implementation or pilot acceptance. This checkout does not contain all finished business dashboards.

Agreed product scope: pharmacy app plus counter sales; retail/wholesale pricing; doctor own/app/walk-in bookings and payment; third-party lab API adapters **and a panel when a lab has no API**; hospital **OPD and billing first**, deeper HMS later; vendor workspaces; private in-house billing/inventory across these businesses. Counter sales require connectivity first; disconnected sync is a later stage. Basic-phone funded doctor access and ABHA/ABDM were requested for later phases; read their actual architecture/roadmap contracts before implementation. Target remains **100 RPS**, not yet demonstrated.

Start with [M0 progress](M0_A_PROGRESS.md), [M0 implementation scope](../M0_IMPLEMENTATION_APPROVAL.md), [C2 compatibility](C2_COMPATIBILITY_REVIEW.md), the schema/API contract sections in [system design](../SYSTEM_DESIGN.md), [roadmap](../ROADMAP.md), [capability matrix](../CAPABILITY_MATRIX.md) and the active scenario/finding registers. Resolve a missing/renamed document through the planning index instead of inventing its contents. The main shareable PDF remains `output/pdf/Jansetu_Cross_Checked_Roadmap.pdf`; source documents carry later execution/status addenda.

### Foundation and Docker admission

Dependency-free foundation harness work and an owned MongoDB transaction fixture have earlier recorded evidence; the current application-isolation increment remains incomplete. Historical offline evidence includes 185 unit passes on each Node22.23.4/24.19.0, with separate controls/companions. The selected 115-scenario register remains **0 PASS, 1 FAIL, 1 BLOCKED, 110 NOT_RUN, 3 DEFERRED**. The new 14 MCP tests do not change those statuses.

The first real application smoke at `de1693ed80538099bab2874a3ea8254df5f62143` failed its exact sysfs interface listing guard. It observed `bonding_masters`, `erspan0`, `gre0`, `gretap0`, `ip6_vti0`, `ip6gre0`, `ip6tnl0`, `ip_vti0`, `lo`, `sit0`, `tunl0`; activity/address/route semantics were not measured. Its exact container/workspace cleanup was independently verified. No helper/scenario or seven-effect-false receipt success was established.

The diagnostics-only candidate at `41539ca749c8a9dbf49ecf43bcca00749eccfe3c` adds bounded metadata before the unchanged strict guard and early synchronous create-ID recording. Its revision-2 manifest is `54b7192be002ee191447547684fcfbbcfff4cc635c95316c4e1ed163350e9e0b`; frozen patch is `efa341314e0c7787651b7b65722dd5a5ab3ebda3bde9b7826ddeab457feca3a3`. [Contract](APP_NETWORK_DIAGNOSTIC_CONTRACT.md), [review inputs](../../../output/review/app-isolation/revision-2/review-input.json).

Direct internal reviewers approved one diagnostic invocation at those exact sources. Two later preflights created **zero containers and invoked zero launchers**: first the temporary host Node was missing; after exact official binary restoration the recorded daemon was unreachable. One Docker info read failed. Result is **BLOCKED_BEFORE_LAUNCH**, separate from the historical executed smoke FAIL. [Recorded internal decision and disposition](../../../output/review/app-isolation/diagnostic-preflight-2026-11-10/INTERNAL_REVIEW.md), [evidence](../../../output/qa/m0-a/app-isolation/diagnostic-preflight-2026-11-10/verification.json).

Recorded profile: socket `unix:///Users/shubham/.docker/run/docker.sock`; engine `16ab25f6-88c7-4687-a431-b119b6ab9319`; cached-only image `node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`. Host Node was `/private/tmp/m0-node22/node`, version22.23.4, binary SHA `2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0`; the temp file may disappear.

**Do not execute an old operator as-is after HEAD/docs changed.** Refresh actual candidate hashes/source freeze and obtain direct review for its exact invocation. The recorded engine must be available; no daemon startup, engine change, new pull, relaxed grants/interface rule or automatic retry is covered by that old decision. A post-create failure needs fresh review before another attempt. App imports/DB/SDK integration remain unadmitted; never run the legacy pharmacy destructive integration suite against an ambient database.

### C2 and remaining F01 work

Owner-reported target is pre-launch, Node22, Mumbai and `pm2 start server`. They chose **retain the existing MongoDB server**, with DevOps to supply facts. Hosting, server version and topology remain unknown. See [baseline request](DEVOPS_BASELINE_REQUEST.md). Do not silently select/purchase a fresh Atlas target. Retained-server facts and compatibility review precede root dependency, lock, runtime pin, build/start and PM2 adoption. Node24 above is the local agent tooling runtime, not a change to the application target.

F01 still needs the agreed dependency/runtime decisions, clean install, type-check, build, compiled application start, a real default assertion-running gate and complete application/DB/provider pre-import admission. Later authority, money/ledger, inventory, report and clinical slices need their bounded actor/field/state/unit/index/provider contracts and appropriate owners. Full C3, M0 acceptance, pilot/release and measured100RPS remain open.

## Supporting documentation

- [Local extension workflow](LOCAL_EXTENSION_COLLABORATION.md) — draft source included in frozen candidate.
- [Official Claude extension MCP configuration](https://code.claude.com/docs/en/vs-code#connect-to-external-tools-with-mcp) and [URI limitation](https://code.claude.com/docs/en/vs-code#launch-a-vs-code-tab-from-other-tools).
- [Claude MCP trust/scopes](https://code.claude.com/docs/en/mcp#project-server-approvals-and-workspace-trust).
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp). Use native workers here; do not introduce the deprecated Codex MCP-server path as a new integration.

No application deployment, production migration, real payment/message/call, account purchase or M0-completion declaration was performed or authorized by this handover.
