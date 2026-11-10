# Local extension transport runner review record

10 November 2026. Author `/root/local_claude_review_prep`, branch `m0/week2-local-review-link`, baseline `1b0a54144d514bd73f03a99724c8b0d02fcfa25a`. Scope: the new `tools/agents/ruflo-extension-smoke.py` and this QA directory. Existing adapter/tests, original six staged files, application source and eleven handover files are unchanged.

## Contract decisions

Both nonauthors reviewed contract SHA-256 `7ec844cde9bc08b9fa35322e05f625495b3657ff39fbdfda2e4a55b0400b1ca3` before implementation:

| Reviewer | Scope | Decision |
| --- | --- | --- |
| `/root` | Spec and stage boundaries | `APPROVE_CONTRACT_IMPLEMENTATION_ONLY` |
| `/root/backend_boot_path` | Standards and cleanup safety | `APPROVE_CONTRACT_IMPLEMENTATION_ONLY` |

Original adapter Spec and Standards approvals apply to its unchanged source hash and retained 14-pass evidence. The archived prepared recipe remains rejected for execution and is preserved intact. This runner replaces its unpinned launch, late permanent-state checks and incomplete child cleanup accounting.

## Implemented boundary and offline proof

The main entry admits the exact Node24/adapter/runtime hashes and two public profiles; no config writes or installation occur. It rejects existing/partial live link/team state before allocation, reserves setup exclusively, and revalidates before each process spawn. An explicit fake session factory is mandatory for tests; there is no default execution seam. The fake test entry disables all real subprocess creation/run/check-output ports. It imports no TypeScript/application code and contacts no Ruflo, model, Docker, database, socket or provider.

The tests cover profile/hash/symlink admission, exclusive and replaced reservations, framed protocol/correlation, exact server/capability/tool/denial checks, synthetic two-client mailbox behavior, unknown mutations/no retry, registered-handle cleanup after initialization failure, unacknowledged/reused/reparented child rejection, separate adapter/Ruflo absence proof, forced and broken-stdin cleanup failure, spawn uncertainty, original-failure retention and genuine-Claude-ACK separation. These are offline controller tests, not a real extension connection or independent model review.

The receipt and retained stdout/stderr bind the frozen implementation and exact admitted fake-only command. The preservation-only check separately read original files and used read-only Git to confirm the staged patch. No original byte changed. Runtime preparation, configuration activation, real smoke and model execution remain **NOT_RUN**.

## Revision 1 review and amendment

The first frozen runner (`b9d3d8db...`) and 31-test proof are retained under `revision-1/`. Root independently ran those tests and approved source scope, then correctly withdrew extension of that approval after the Standards reviewer identified an admission gap: extra Codex profile keys could forward `NODE_OPTIONS` or provider credentials before the adapter ran, despite the explicit `env` map being correct.

The amendment closes Codex's profile to its five required fields plus the two existing bounded numeric timeout controls. Forwarded-environment, alternate transport/URL, auth/header and unknown fields are rejected before allocation or spawn. Two new tests cover eight hostile extra-field variants and valid/invalid timeout values. The original adapter, contract and staged/archive bytes remain unchanged.

One minor reporting limitation remains explicit: an exclusive setup-lock collision at `run_smoke` entry reaches the conservative outer `UNRESOLVED_RUN_STATE` fallback with `clients_started:null`, even though that collision occurs before any child could start. It withholds PASS and makes no zero-process cleanup claim. Root deemed this a nonblocking precision issue; no process or mutation authority follows from that status.

## Amended direct implementation decisions

Both nonauthors inspected the full first candidate and exact amendment and independently ran the 33-test fake-only gate:

| Reviewer | Scope | Decision |
| --- | --- | --- |
| `/root` | Spec | `APPROVE_SOURCE_ONLY`, closed-profile finding resolved |
| `/root/backend_boot_path` | Standards | `APPROVE_SOURCE_ONLY`, closed-profile finding resolved |

These decisions bind runner SHA-256 `eab90961c8b09109c0fc236008139bc5604b1a81ce2ec5e68a970f67be3387e9`, tests `771782d009b64172f8fa16b18fa80ba385650d501fdee986956ae94732b5dc65`, recipe `5fd28239f1f482fdb2ee54c6512657509fc26453e2fc2423c8e680ee8f7ce8b6` and unchanged contract `7ec844cde9bc08b9fa35322e05f625495b3657ff39fbdfda2e4a55b0400b1ca3`. Neither reviewer authored this slice. No real subprocess port was available in those tests.

Source approval is distinct from later exact activation/invocation decisions; profile writes and real smoke remain unapproved until those stages are concretely reviewed. No account/new login/OAuth, hosted worker, model fallback, application/release or push approval is supplied. The lead independently checked the existing bundled CLI's ordinary `mcp add --help`, confirming the registration syntax without account or model invocation; that check itself changes no configuration.

## Later actual stages: 11 November 2026

The earlier NOT_RUN and approval-pending paragraphs record the state at source review. Later separately approved execution is recorded in [EXECUTION_STATUS.md](EXECUTION_STATUS.md), with byte-preserved safe artifacts under `activation-execution-1/` and `transport-execution-1/`. The historical source proposals, scripts, recipes and old handover are unchanged.

The lead executed activation once after actual Spec and Standards stage decisions. It succeeded with `ACTIVATED_PENDING_SEPARATE_TRANSPORT_REVIEW`; frozen adapter/profile pins matched and activation started zero Ruflo processes/model calls. The later Standards observation of six benign Claude cache/housekeeping JSON drifts is attributed in the execution status, with actor/cause unknown and no MCP/auth/trust/public-profile change. Private configuration and backups remain outside Git.

The lead then executed one separately approved local transport smoke. Its actual report is `LOCAL_TRANSPORT_PASS_PENDING_CLAUDE_ACK`, with two completed owned clients, successful synthetic roundtrip, ten acknowledged metadata actions, no first failure/unknown mutation/forced cleanup and both exact adapter/Ruflo child pairs absent. The live local team and pending challenge now exist; this record supplies no rerun authority.

Postexecution Spec reviewer `/root` issued **ACCEPT_BOUNDED_LOCAL_TRANSPORT_EVIDENCE** after reviewing actual protocol/report/link provenance, twenty correlated request/response pairs and two forbidden denials, then separately checking all four exact PIDs absent without signals. The runner's author checked archive hashes and original six/eleven preservation; that author check is distinct from independent acceptance. Actual Claude acknowledgement remains false and model requests remain zero. Existing GUI account/session, requested `claude-opus-5-5` per-session `max` and genuine model review remain unproven. No application/release or owner acceptance follows.

Postexecution Standards reviewer `/root/backend_boot_path` separately issued **ACCEPT_LOCAL_TRANSPORT_EVIDENCE**. It independently checked archive hashes and actual report/protocol/live-link byte copies, twenty correlated request/response pairs with two unlisted denials, ten acknowledged metadata actions, two started/completed clients and four distinct recorded adapter/direct-child identities. Recorded cleanups each had safe exit zero, separate process absences and no outer forced termination; frozen pins matched, the pending link remained and the setup lock was absent. Its own live process read was blocked (`Operation not permitted`), so this acceptance relies on the frozen runner and actual cleanup records rather than an independent OS absence observation. It performed no signals or state actions. Model requests and actual Claude acknowledgement stayed false. The lead's separate successful OS readback retains its own `/root` provenance.
