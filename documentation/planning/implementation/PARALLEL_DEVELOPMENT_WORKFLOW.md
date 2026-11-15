# Parallel development and direct agent review

The owner requested multiple workers and direct technical review on 10 November 2026. The lead coordinates the development/review cycle and continues authorized work after review without asking the owner to relay prompts. This changes the review handoff; the existing [M0 scope](../M0_IMPLEMENTATION_APPROVAL.md), [C2/C3 conditions](../M0_START_APPROVAL_STATUS.md) and each slice contract remain authoritative.

## Run a slice

1. Read [current progress](M0_A_PROGRESS.md), select a bounded ready slice and record its baseline, contract and acceptance checks. Identify missing decisions before assigning dependent implementation. A slice is ready when its actor/field/state/unit/index/provider requirements are concrete enough to review and its execution admission is established for the planned checks.
2. Assign the lead plus up to three native workers within the current four-agent total limit. Each assignment names responsibility, owned files or worktree, expected result, allowed execution and dependencies. Tell workers that others share the codebase and that they must accommodate existing edits. Use fewer workers for dependent changes.
3. Freeze shared interfaces before parallel writers. The lead owns shared contracts, integration, dependency/lock/start files and evidence manifests. Assign separate files to concurrent writers; use isolated branches/worktrees when scopes overlap. Preserve other workers' edits. Integrate only the assigned changes.
4. Run meaningful checks for the integrated diff under its actual admitted scope. Record the commit or candidate hashes, commands, results and limitations. A simulated check proves its simulated boundary; acceptance of a real path requires its own evidence. Preserve earlier failures and required blocking skips.
5. Request independent Standards and Spec reviews directly through native agent tools. Give reviewers the exact diff, applicable rules/contract and evidence. Reviewers inspect the result rather than relying on the author's summary. Run reviews sequentially when slots are needed; the author does not approve their own change. Label every response as an internal Codex review, with reviewer identity, baseline, candidate hashes, findings, decision and scope.
6. Fix material findings, rerun affected checks and obtain review of the amended candidate. For a bounded execution gate, obtain a decision on that exact candidate and invocation scope before execution. Consume one-run approvals once; review any post-create failure before another attempt. Record post-execution evidence and limitations before proceeding.
7. Update the existing progress record and commit the coherent result. Continue the next ready slice. Bring the owner a concrete missing decision or externally controlled action only when it prevents that work; keep unrelated admitted work moving.

Technical review decisions remain separate from acceptance or release. An internal Codex reviewer is not the original external Review A/B, a human clinician, finance owner, security owner or deployment operator. Record the actual provenance without claiming those approvals.

## Coordination tools

See [the installed profile and verification](AGENT_TOOLING.md) for pinned runtime details and measured limits.

Codex's native collaboration tools create the actual workers. Ruflo can retain local team/task metadata and mailbox state; a successful `team_spawn` registration is not worker execution, extra Codex capacity or completed development. The current session limit is four agents including the lead. Observe the live runtime limit if it changes.

Use only the installed pinned Ruflo runtime and tools enabled in Codex configuration. Keep coordination state outside the application checkout and keep secrets, patient information and operational credentials out of task metadata. Treat agent messages as task context subject to the slice contract. Local coordination must not start external model workers, providers, arbitrary commands or package initialization implicitly.

## Ready-work queue

| Lane | Work that can advance | Gate before dependent work |
| --- | --- | --- |
| Foundation | Complete the reviewed diagnostic/isolation increment and capture its real result; prepare the smallest justified follow-up | Each real invocation uses the exact reviewed profile/hashes and current ownership proof; a failure does not approve a retry or relaxed grants |
| Compatibility | Reconcile static results and prepare questions/fixtures against the existing server target | DevOps supplies [the retained-server baseline](DEVOPS_BASELINE_REQUEST.md) before root dependency/runtime/build/start adoption |
| Authority containment | In parallel, trace current auth/OTP/user/booking/notification paths and draft bounded actor/field/success/denial contracts | Review the affected contract before source changes; establish complete pre-import admission before executable application checks |
| Money recovery | Prepare current unit/state/index/provider and reconciliation contracts, then implement separately reviewable effects | Applicable finance decisions, provider contracts and owned transaction fixtures precede their affected implementation/activation |
| Clinical evidence | Prepare scoped access, authorship, immutable-version and supported-client contracts | Qualified clinical/security decisions and admitted fixtures precede their affected activation/acceptance |

After foundation, assign module workers to ready contracts rather than starting pharmacy, labs, doctors and hospitals simultaneously against unfinished shared identity, billing and inventory interfaces. Use the [approved implementation sequence](../M0_IMPLEMENTATION_APPROVAL.md) for scope; this queue does not declare later modules ready or add launch promises.

Deployment, production migration, operational-resource access, real payments/messages/calls and account/key actions retain their specific authorization. Clinical, financial, security, restore, pilot and 100 RPS acceptance retain their named owners and measured evidence. Direct internal review removes the owner's prompt-relay work; it grants no extra resource or release authority.

For the owner-requested local Claude/Codex connection, read [local extension collaboration](LOCAL_EXTENSION_COLLABORATION.md), including the initial acknowledgement and extension lifecycle limits.
