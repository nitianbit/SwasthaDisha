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
