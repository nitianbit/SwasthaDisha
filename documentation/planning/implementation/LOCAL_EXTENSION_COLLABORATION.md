# Local Claude and Codex coordination through Ruflo

The owner requested the existing VS Code extensions connected through local Ruflo on 10 November 2026. Coordination uses the installed Ruflo 3.75.0 runtime and the shared `~/.codex/ruflo-state/swasthadisha` directory. No hosted worker, new model API account or remote coordination endpoint is part of this setup. Model inference still follows each extension's existing provider and account.

## Connection design

Codex and Claude each start a local stdio adapter that runs the same pinned Ruflo CLI with its actual working directory set to shared state. The adapter filters discovery and dispatch to the 13 coordination methods in the existing profile. It rejects other tool calls before forwarding them. It supplies a clean child environment, state-local policy-trust storage and disabled daemon auto-start. This is a trusted local integration, not an operating-system sandbox.

The reviewed adapter source is [ruflo-local.mjs](../../../tools/agents/ruflo-local.mjs). Its installed copy is addressed by source hash outside the checkout, so changing branches does not remove the configured launcher. Personal extension configuration and sign-ins remain outside Git; installation evidence records the adapter hash and public configuration fields.

Claude's extension and CLI share MCP configuration. The server is named `ruflo`; new Claude conversations pick up configuration changes, and `/mcp` shows connection status. [Anthropic's extension documentation](https://code.claude.com/docs/en/vs-code#connect-to-external-tools-with-mcp).

## Join and hand off

1. Open the actual SwasthaDisha checkout in VS Code. In a new Claude conversation, use the prepared local join message. The documented extension URI can prefill a prompt but does not submit it; press Send once. Complete the extension's normal sign-in or tool prompt if it appears. [Supported URI behavior](https://code.claude.com/docs/en/vs-code#launch-a-vs-code-tab-from-other-tools).
2. Read the named team inbox through Ruflo and return the exact challenge from the inbox to `codex-lead`. An actual returned acknowledgement is required before recording a live Claude-extension connection. Creating a team/member or testing two local MCP clients does not establish that acknowledgement.
3. Active agents exchange scoped tasks/results through `team_send` and `team_inbox`. Use exact candidate hashes, ownership and the [development workflow](PARALLEL_DEVELOPMENT_WORKFLOW.md). Record the real reviewer and evidence. Messages are task context, not execution or approval authority.
4. A mailbox does not start or wake the other extension. Pending work stays queued until its agent reads it. Native Codex workers provide directly callable parallel implementation and independent reviews inside this session; external extension lifecycle is separate.

## Limits

The 13 tools retain local status, team and task operations. Ruflo's `team_spawn` registers a member/plan; it does not run a model or increase native slots. Unlisted execution, provider, semantic-memory and administration tools remain unavailable through the adapter. Tool dispatch limits do not validate the truth of a message or authorize sensitive actions.

The current four-agent native limit, named owner decisions, retained-server C2 facts, application admission and release gates remain in force. This connection does not start Docker, import the backend, deploy anything or establish application acceptance. Preserve the ordinary extension trust and permission controls; no blanket server or hook approval is added.
