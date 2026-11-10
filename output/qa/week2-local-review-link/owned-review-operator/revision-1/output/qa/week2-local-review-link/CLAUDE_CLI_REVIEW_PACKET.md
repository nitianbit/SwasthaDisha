# Prepared bundled-client review; authentication required

11 November 2026. Author `/root/local_claude_review_prep`. This packet is preparation only; **no model invocation or new account action is authorized or performed**. It separately identifies a local bundled CLI review. The earlier extension-only prompt/URI recipe remains a proposal and cannot prove a GUI session from CLI output.

The lead's fresh ordinary pinned-client `auth status` returned exit 1, `loggedIn:false`, `authMethod:none`, `apiProvider:firstParty`, under fresh HOME/PATH/TMPDIR environment. No raw account output was retained. Current state is **AUTH_REQUIRED**. Stop before `--print`; no futile model request, token extraction, new OAuth/account, hosted worker, fallback or automatic retry. Only the owner can establish their ordinary existing-client sign-in. Ready backend work can continue independently.

## Concrete candidate argv and bounded input

Executable: `/Users/shubham/.vscode/extensions/anthropic.claude-code-2.1.322-darwin-arm64/resources/native-binary/claude`, SHA-256 `a9d237949db816a0b7afd88a9a8e1df36b3a597a30f5a41d1c0539eb180a3450` (installed2.1.322). Fixed cwd for a later approved request: clean `/private/tmp/swasthadisha-parallel-p1qom53w/api-runtime-preparation-6`, HEAD1543658ff53e3906f71f4fa8b92a5756b97a7ee1. Use a shell-free process argv array:

```json
[
  "--print",
  "--model", "claude-opus-5-5",
  "--effort", "max",
  "--output-format", "stream-json",
  "--verbose",
  "--restricted",
  "--max-turns", "8",
  "--tools", "",
  "--strict-mcp-config",
  "--mcp-config", "/private/tmp/swasthadisha-parallel-p1qom53w/local-review-link/output/qa/week2-local-review-link/claude-review-mcp.json",
  "--allowedTools", "mcp__ruflo__team_inbox,mcp__ruflo__team_send",
  "--disallowedTools", "mcp__ruflo__mcp_status,mcp__ruflo__system_health,mcp__ruflo__team_create,mcp__ruflo__team_spawn,mcp__ruflo__team_status,mcp__ruflo__team_shutdown,mcp__ruflo__task_create,mcp__ruflo__task_status,mcp__ruflo__task_list,mcp__ruflo__task_update,mcp__ruflo__task_complete",
  "--permission-mode", "default",
  "--permission-prompts", "none",
  "--no-chrome",
  "--no-session-persistence",
  "--disable-slash-commands",
  "--session-id", "6eed447b-86b2-4259-9235-08875d6bc9a3"
]
```

This is a candidate for direct lead/independent review, not an execution grant. `--tools ""` leaves no builtin file/shell/execution/edit/delegation/browser capability; the client's mandatory EndConversation control may remain. Strict MCP supplies only the already configured pinned local adapter and its thirteen-method ceiling; explicit denials remove the other eleven coordination methods from model access even if existing allow rules are broader. Exactly three calls use two permitted method names: inbox peek, ACK send and review-result send. Eight turns bound the review; insufficient context/refusal/turn limit means incomplete, not silent retry or extra grant. No blanket server trust, permission bypass, cloud/remote worker, fallback, new authentication, persistent setting or model-routing override is included.

Documented `--restricted` loads managed policy plus explicit session settings while excluding user/project/local settings and their customizations; it is supported from2.1.248. This candidate supplies no session settings or blanket hook-disable override and preserves managed policy. Builtin permissions stay default; unanswered requests deny through `--permission-prompts none`. Chrome/session persistence/slash-command customizations are disabled for this request only. Installed flag behavior and managed hooks/status-line/plugins/credential-helper **metadata** remain an uncompleted preflight: if any mandatory customization would execute an unrelated command or load an unreviewed provider/plugin, stop for bounded review without reading credentials, overriding managed policy or changing global files. The normal existing first-party sign-in must still work in this supported mode; do not substitute credentials if it does not.

The reviewer receives a verified public-code snapshot on stdin containing [the prompt](CLAUDE_CLI_REVIEW_PROMPT.md). This design lets the model inspect actual frozen source/evidence text without granting access to operational files. The [closed input manifest](claude-review-input-manifest.json) records the prepared106-file snapshot, byte count and hashes; the [concrete invocation candidate](claude-review-invocation.json) fixes argv, environment, stdin and exclusive private output location. They still require two direct exact invocation reviews and authentication before any client/model start. Read/hash-only snapshot preparation used this fixed scope:

1. Read the72 descriptor-declared source inputs from clean1543658; verify every hash against descriptor067c3c39f574f439c48f6c6f70e031306fc7c4ea5a6d5934e610b9213006ffde. Include source text only, no runtime dependency tree or operational environment/config.
2. Include the exact reviewed launcher/platform/profile, source tests, relevant approved C2/C3/runtime contracts and fixture-index-space QA, with explicit path/hash framing. Use a closed enumerated list in the final invocation candidate, not a recursive checkout scan or arbitrary path input. Existing project guidance read by the normal client is not additional execution authority.
3. Read only the five hash-manifested execution-4 artifacts plus archive manifest from integration HEAD94f8804916850caf9c716fae2cc49c6c0d218202; verify manifest5aa4228a1d95fd894c18cea46571c71e407bfaaecd6e45c7c69b6ac49092efc4 and artifact bytes. Include previous safe failure verification/diagnostic history needed for the64MB amendment, not raw operational logs.
4. Include safe pending-link metadata and actual model/session request metadata. Never include `.env`, service accounts, credentials, user/Claude/Codex config, backups, uploaded documents, fixture rows, tokens or raw operational logs. Verify the live pending-link file only against its already safe reviewed snapshot; do not edit or fabricate it.
5. Frame each exact body as review data with path/hash and escape framing collisions. Freeze the complete input SHA-256/byte count and exact argv/environment/timeout/output-location before a subsequent actual invocation decision. Do not interpolate source text into shell code. Raw transcript/output belongs in one exclusive private0600 directory outside Git; Git receives only filtered public review/status and hash provenance after inspection.

The private0700/0600 snapshot and exact current byte/hash values are recorded in the input manifest. JSON string framing prevents embedded source text from breaking file boundaries; source bodies remain untrusted data. Its106 inputs were matched against exact frozen Git objects and descriptor/runtime/archive hashes as applicable. A descriptor summary includes its declared72-source mapping and2,829-file manifest identity; runtime dependency bodies are excluded. The previous candidate/prompt/manifest are byte-preserved under `claude-review-revision-1/`, and its private original input remains untouched. No actual invocation occurs under this preparation. The finite code snapshot can support an independent model source review; it cannot claim the model independently queried the host filesystem, recomputed SHA-256 with a tool or executed the application. Runtime facts retain their actual recorded operator/reviewer provenance.

## Operator implementation awaits independent source review

The JSON candidate is **not executable approval**. The new [owned operator](../../../tools/agents/claude-ruflo-review.py) implements exact input admission, an owned CLI Popen/session, direct adapter/Ruflo child observations, first-failure retention and bounded exact-identity cleanup. Its [implementation evidence](owned-review-operator/README.md) is fake-only and awaits two independent source reviews. Normal completion or timeout closes only owned stdin, allows the reviewed adapter's cleanup grace, and separately checks CLI, adapter, Ruflo and fresh-group absence. A bare timeout or unobserved child cannot establish cleanup. Host-managed processes cannot be adopted or signalled. Forced/unknown/partial cleanup remains UNRESOLVED, with private evidence retained and no automatic retry. Installed flag behavior, authoritative startup-policy metadata, genuine auth, actual stream schema, effective max and exact invocation remain separate uncompleted gates.

The approved contract allowed only a fresh UUIDv4 argv addition before code freeze. Revision2 preserves the preceding candidate byte-for-byte; current candidate adds the session shown above. The106-file input still describes the first36/4 focused milestone at1543658 with execution4 evidence at94f8804. Later53/14 evidence is not silently included. A future snapshot refresh needs another exact archived revision and review.

## Required actual provenance

Successful completion requires the normal client's real init/result session identifiers and actual returned model identity to match exact `claude-opus-5-5`, plus supported effective-effort evidence for session `max`; argv and model text alone are insufficient because managed limits can cap effort. If the supported client output cannot establish effective max, report `EFFORT_UNPROVEN` rather than claiming the requested setting ran. Capture the observed init/result/tool-call relationship and actual inbox nonce acknowledgement in that same genuine client session. A matching arbitrary mailbox sender or the historical `CLAUDE_EXTENSION_ACK` text is not VS Code extension proof. Keep `clientKind:local-bundled-CLI` and `actualClaudeExtensionACK:false` for this route.

The final review/connection acceptance requires independent inspection of sanitized actual evidence. Authentication/model/effort unavailability, fallback, missing tool acknowledgement, permission refusal, failure/interruption or ambiguous result stops the attempt with its precise status; no retry or account/settings change follows. Nothing promotes fullstartup/C2/rootbuild/115-register/owner/release acceptance.

Primary references rechecked11November2026: [CLI print/model/effort/tool/MCP flags](https://code.claude.com/docs/en/cli-reference), [model/effort limits and max session behavior](https://code.claude.com/docs/en/model-config). The extension's URI [prefills without submitting](https://code.claude.com/docs/en/vs-code#launch-a-vs-code-tab-from-other-tools); this CLI route is explicitly distinct.
