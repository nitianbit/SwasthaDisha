# Local Ruflo extension link: revised activation and smoke contract

10 November 2026. Branch `m0/week2-local-review-link`; application baseline `1b0a54144d514bd73f03a99724c8b0d02fcfa25a`. **DRAFT FOR TWO DIRECT PRE-REVIEWS.** No installer/configuration change, real adapter/Ruflo smoke or Claude model call is authorized by this draft. The owner reauthorized local Ruflo coordination and requested a Claude Opus 5.5 review after the API milestone.

## Ownership and unchanged inputs

This slice owns only new `tools/agents/ruflo-extension-smoke.py` and `output/qa/week2-local-review-link/`. The old archived recipe is retained, not amended. Preserve the original checkout's six staged files, staged-patch SHA-256 `00b2ad0daae9ac54adda82e8a7eb1450ca25340be4412ac76f226bfd6c45ff9a`, and all eleven handover files byte-for-byte. No application, root dependency/startup, backend fixture, existing adapter or adapter-test source changes.

| Fixed input | SHA-256 / value |
| --- | --- |
| Original adapter `tools/agents/ruflo-local.mjs` | `57c226be79e9b832e6ee2b7122d387102b878f0ecaa7862a6fd65c4b64268b4d` |
| Original adapter tests | `ca37e313b992af1acce851e8f2b4f1bc13443715396d5c098c0b7a33047cfc3b` |
| `/Users/shubham/.nvm/versions/node/v24.19.0/bin/node` | `27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1` |
| Ruflo runtime-root `package-lock.json` | `8ac77ad0a7a64b698abe9566f12fc2d7bd583741bcf9167e5cc5cb6c7d19f646` |
| Ruflo CLI `package.json` | `a898ebf657810d9894d6505db55c11a94ca8b1766c08468552d41e4378beeaf0` |
| Ruflo CLI `bin/cli.js` | `5b65e02510e0d94174a557ce77c5a62c5e19093ec4d1d9b39ddfdfa93932a1f7` |

Runtime root is `/Users/shubham/.codex/runtimes/ruflo/3.75.0`; CLI package is its `node_modules/@claude-flow/cli`. Shared state is `/Users/shubham/.codex/ruflo-state/swasthadisha`. Installed adapter target is exactly `STATE/adapters/57c226be79e9b832e6ee2b7122d387102b878f0ecaa7862a6fd65c4b64268b4d/ruflo-local.mjs`. This is trusted local tooling, not an OS sandbox or proof against a compromised host. Node 24 is tooling only; no application runtime selection changes.

Retained adapter evidence records 14 passes, zero failures/skips/TODOs. `/root/local_claude_review_prep` independently approved adapter Spec/source scope; a separate Standards decision on those exact frozen inputs remains required before installation. That source review is not approval of the new runner or a real invocation.

## Separate activation stage, after reviews

The coordinating lead, not the smoke runner, installs the unchanged adapter into its content-addressed location and updates only the existing Codex `ruflo` profile and Claude's user-scoped `ruflo` server. Record verified private backups outside Git before mutation, preserve unrelated configuration/sign-ins, and re-read the resulting public profile fields. Use the existing bundled Claude configuration command for registration; do not create another login/OAuth flow, account, plugin, hook or provider connection. Existing `ruflo` collisions or changed input snapshots stop for reconciliation rather than force replacement.

Both profiles must select the fixed Node executable and one argument: the exact installed adapter. Codex retains shared-state `cwd`, the 13 enabled tool names and its existing seven coordination-only environment fields. Claude's new profile is `stdio` with the same command/argument; it needs no caller-selected working directory because the adapter fixes the child cwd. No blanket trust, bypass-permission or hook setting changes. Do not terminate host-managed MCP processes; a currently loaded Codex registration can remain old until its client reloads, and that limitation must be reported.

Smoke execution receives its own two direct decisions on the implemented runner, exact invocation, input hashes and effect scope. The new runner neither installs itself nor edits either configuration file. Its fixed invocation is an isolated standard-library Python command from the assigned worktree, with no positional arguments or caller-selected executable, target, state directory, team or command.

## Preflight and mutation ordering

Before allocating a smoke workspace or starting any child, the runner must validate every fixed input above as regular file bytes, the installed adapter path/hash, CLI version `3.75.0`, and both resulting public MCP profiles. Reject the old direct-CLI profile, unknown command/arguments, unexpected forwarded environment keys, or a non-exact enabled-tools set. Read only the required configuration sections; never print settings, tokens, account identity or credentials. The child environment is constructed explicitly with the real HOME, fixed PATH/state/cache fields and no provider credentials, preload flags or ambient environment inheritance.

Before any permanent team mutation, require absence of `STATE/extension-link.json` and the `swasthadisha-local` team directory, rejecting symlinks/partial existing artifacts as well. Repeat the checks immediately before the live-team phase and acquire an exclusive setup reservation. Do not overwrite, force-reopen or adopt an existing team/link. Existing `sd-week2-20261110` and all other teams remain untouched.

Allocate one new private evidence directory with held filesystem identity; record each owned adapter process immediately after successful spawn. Two direct adapter clients must initialize with the expected Ruflo identity/protocol, advertise exactly the 13 filtered tools, reject an unlisted call before forwarding, and complete a unique mailbox roundtrip between two metadata-only members of one newly created test team. Record create acknowledgement before later mutations. Shutdown only that acknowledged test team. A timeout or missing/ambiguous mutation response is unresolved; do not retry mutations or infer successful cleanup.

Only after transport acceptance, and within the lead-approved connection stage, reserve the live link exclusively, create the absent `swasthadisha-local` team without force, register only `codex-lead` and `claude-reviewer` metadata, and queue one unique connectivity challenge. Failure after reservation leaves explicit partial state for reconciliation. Link updates must remain bound to the originally reserved file identity; another process's replacement is never overwritten. No task/member registration starts a model worker.

The resulting status is **LOCAL_TRANSPORT_PASS_PENDING_CLAUDE_ACK**, with `actual_claude_extension_acknowledged:false`. Neither a synthetic roundtrip nor an arbitrary `from:"claude-reviewer"` field proves model execution. The runner never promotes the link to a genuine Claude connection or accepts a technical review.

## Bounded process ownership and cleanup

Each adapter is a fresh `Popen` handle in a private process session. Capture its PID and process identity. The Ruflo PID is accepted only from that new adapter's acknowledged `mcp_status` response, then checked against OS parent/group/start identity while the owned adapter remains identifiable. A PID supplied through a message, old report or host-managed server is not adopted.

Ordinary cleanup closes each owned stdin and allows more than the adapter's full five-second TERM plus two-second KILL window. If escalation is necessary, act only on the fresh owned process handle or the acknowledged, currently revalidated direct child; do not use name searches, broad kills or kill a shared host group. Preserve the first failure. Independently verify both the exact adapter and acknowledged Ruflo child absent, not merely the adapter return code. If identity or absence cannot be established, report **UNRESOLVED_PROCESS_CLEANUP**, preserve evidence and stop; never report transport PASS. A PID changing parent/group/start identity prevents escalation.

Do not hide partial resource state behind a cleanup exception. Prelaunch failure reports zero started adapters. Spawn uncertainty, timeouts, forced termination, unknown team mutation or an unverifiable child are explicit failures/unresolved outcomes. The execution report distinguishes requested/started/completed clients, exact child identities, metadata mutations and cleanup; a reserved attempt is not a model invocation.

## Required checks before real execution

Dependency-free tests use owned temporary fixtures and explicit fake configuration/process/transport ports; no default seam may fall back to real execution. Cover exact-profile/input acceptance, direct-CLI/wrong-hash/unexpected-env denial before spawning, existing link/team rejection before mutations, duplicate setup reservation, mutation timeout/ambiguous response, framed transport rejection, filtered discovery and unlisted dispatch, successful synthetic roundtrip, adapter/Ruflo-child exit accounting, stale/reused PID refusal, forced/unknown cleanup rejection and preservation of an original failure. Meaningful synthetic process tests may exercise the new cleanup boundary without real Ruflo/model/application access. Record those as synthetic evidence rather than real connection proof.

The real smoke requires the exact frozen runner and reviewed source manifest after both profile updates. It consumes its bounded approval; any partial-state/process failure is reviewed before another attempt. All original staged/archive preservation checks run after preparation/execution. No application/TypeScript import, Docker, DB, provider, secret access, deployment or push is part of this slice.

## Genuine Claude review stage and remaining limits

Only after the actual API milestone and a real connection does the lead request the review. Pin `claude-opus-5-5` and per-session `max`; verify actual model/effort and disclose or stop on fallback/caps rather than label a different run as the requested review. Do not persist invalid `effortLevel:"max"` settings. Current bundled-CLI auth status is unauthenticated; GUI account state remains unverified. No new account or separate authentication flow is introduced.

The supported VS Code URI pre-fills without submitting. Any necessary initial Send/account/tool action must happen through the existing client's ordinary controls; do not fake ACKs, extract credentials, call hidden extension IPC or bypass trust to remove that boundary. Ruflo cannot wake an inactive extension. These connection facts can remain blocked while independent backend development continues.

Official capability references: [model/effort configuration](https://code.claude.com/docs/en/model-config), [extension URI and MCP behavior](https://code.claude.com/docs/en/vs-code#launch-a-vs-code-tab-from-other-tools), [CLI configuration/status commands](https://code.claude.com/docs/en/cli-reference).
