# Codex workers and Ruflo installation

10 November 2026. Requested by the owner to reduce serial work and remove manual technical-review prompt relay. Follow [the development workflow](PARALLEL_DEVELOPMENT_WORKFLOW.md) for assignments and direct independent reviews.

## Installed profile

Ruflo **3.75.0**, including exact CLI 3.75.0, is installed outside the app under `~/.codex/runtimes/ruflo/3.75.0`. npm lifecycle scripts and optional dependencies were omitted. The lockfile is retained. The Codex skill-installer copied the upstream swarm skill from commit `4184c5cc24f27d5831f871e6d7160e2a9322cbbb`; its original text is preserved under `~/.codex/skills/ruflo/references/`, and the main skill is adapted to native Codex workers and the pinned MCP profile.

Codex registration `ruflo` uses absolute Node/CLI paths and a separate working/state directory, `~/.codex/ruflo-state/swasthadisha`. Only 13 local status, team and task tools are enabled. Semantic memory, external-model execution, arbitrary commands and deployment tools are outside this profile. Daemon auto-start is disabled. No project initializer, hooks or auto-fix script was run. Existing Codex settings and ECC installation are preserved; the configuration backup is recorded in [installation evidence](../../../output/qa/tooling/ruflo-2026-11-10/installation.json).

The installed skill is available on the next Codex turn. A client that has not loaded the MCP registration may need a session reload. Native workers and direct reviews already work independently of Ruflo.

## Measured verification

**PASS:** two clean-environment stdio processes initialized; all 13 enabled tool names exist; five tool calls verified status, task creation, persistence across restart, completion and readback at 100 percent. Both smoke-owned processes exited zero on stdin EOF and were independently absent. Preexisting Codex-host MCP processes were left untouched. [Report and full protocol evidence](../../../output/qa/tooling/ruflo-2026-11-10/VERIFICATION.md).

Team/mailbox behavior and host filtering were inspected, not executed. The server advertises a broader registry; Codex's enabled-tools list is the host exposure restriction. Environment settings are not a network sandbox. No provider credentials, app imports, model/memory execution or project initialization were used in verification; the configured model-cache directory was not created.

## Capacity and current blockers

The current session permits four agents total: one lead and up to three actual native workers. Ruflo team registration retains metadata and returns a plan; it does not create native workers or add capacity. Task records can store native ownership in descriptions/results; team members are not automatically assignable task-agent IDs.

The application diagnostic preflight is separately **BLOCKED_BEFORE_LAUNCH** because the recorded Docker daemon is unreachable. No container was created and no app test started in that preflight. Current [M0 progress](M0_A_PROGRESS.md), C2 retained-server facts and domain/release gates remain authoritative. Tool installation does not establish M0 acceptance or 100 RPS performance.
