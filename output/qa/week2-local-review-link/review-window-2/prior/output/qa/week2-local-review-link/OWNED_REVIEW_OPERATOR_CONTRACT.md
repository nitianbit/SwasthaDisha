# Bounded owned Claude/Ruflo review operator

11 November 2026. **DRAFT FOR TWO NONAUTHOR PRE-REVIEWS; CONTRACT ONLY.**
Author `/root/local_claude_review_prep`. No implementation, client/model start,
authentication flow or actual invocation is authorized by this document.
Current client status is AUTH_REQUIRED. The existing normal owner sign-in is a
separate prerequisite; backend work continues independently.

## Ownership and fixed purpose

After independent Spec `/root` and Standards `/root/backend_boot_path` contract
decisions and a lead assignment, proposed implementation ownership is exactly:

- `tools/agents/claude-ruflo-review.py`;
- `tools/agents/claude-ruflo-review.test.py`;
- `output/qa/week2-local-review-link/`.

Others share the repository. Do not change their source, shared runtime/fixture
interfaces, Git metadata, application code, original six staged files or eleven
handover files. The existing adapter/runtime/client remain unchanged. Root
handles Git and later exact stage decisions. No new model account, OAuth,
credential extraction, hosted worker, fallback or blanket trust/hook setting.

The operator makes one existing locally bundled Claude CLI review of the frozen
focused API source/evidence snapshot. It is **clientKind:local-bundled-CLI**.
Even a genuine returned historical `CLAUDE_EXTENSION_ACK` string cannot establish
a VS Code extension session. Keep actualClaudeExtensionACK false for this route.
No application/provider/DB/Docker execution or release acceptance is included.

## Exact inputs; no caller-selected path, command or environment

The future executable takes no positional input and runs only with isolated
Python (`-I -B`), a reviewed Python version and a closed ordinary host environment.
Reject preload/config/path overrides before any subprocess. Normal macOS-added
locale metadata may be explicitly listed in the frozen implementation; do not
inherit it into child environments. All real effects use one explicit runtime
port object; fake tests must supply closed fake ports, never fall through.

The initial candidate and source snapshot are already concrete:

| Input | SHA-256 |
| --- | --- |
| `claude-review-invocation.json` | `d8b7dde833e89d3c27ba6d0bfe1dc64ca339334e56b634edb1e57a1da11a65c4` |
| `claude-review-input-manifest.json` | `01257c8251664f4097206477a3ee6f64e6e4e560e15ee4fd704040397ca7f92f` |
| `CLAUDE_CLI_REVIEW_PROMPT.md` | `68fc88bbc798f1d31d826064bbcf32cabd13c164d9ee07e84350da63dfc45470` |
| `claude-review-mcp.json` | `a612d678b74998efe9b9d91c029d7f66731ff4fb8e5e096e41f07243369743b0` |
| private prepared stdin | `2be325a6f57728ec062d5a8ebc064d4def7dc67791504fe82479ce81a9141354` |
| bundled Claude2.1.322 binary | `a9d237949db816a0b7afd88a9a8e1df36b3a597a30f5a41d1c0539eb180a3450` |
| Node24.19.0 binary | `27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1` |
| original/installed adapter | `57c226be79e9b832e6ee2b7122d387102b878f0ecaa7862a6fd65c4b64268b4d` |
| Ruflo3.75.0 runtime lock | `8ac77ad0a7a64b698abe9566f12fc2d7bd583741bcf9167e5cc5cb6c7d19f646` |
| Ruflo CLI package | `a898ebf657810d9894d6505db55c11a94ca8b1766c08468552d41e4378beeaf0` |
| Ruflo CLI entry | `5b65e02510e0d94174a557ce77c5a62c5e19093ec4d1d9b39ddfdfa93932a1f7` |

Paths are the exact ones already in the candidate/manifest. The private stdin is
`/private/tmp/sd-claude-review-input-0yo81r5x/review-input.json`,1,035,167 bytes,
106 unique framed public-source/evidence inputs. Source checkout is clean
`/private/tmp/swasthadisha-parallel-p1qom53w/api-runtime-preparation-6` at
`1543658ff53e3906f71f4fa8b92a5756b97a7ee1`; evidence is frozen integration
`94f8804916850caf9c716fae2cc49c6c0d218202`. Descriptor is
`067c3c39f574f439c48f6c6f70e031306fc7c4ea5a6d5934e610b9213006ffde`.

Verify every admitted file's regular/single-link/no-symlink bytes, owner/private
mode where applicable, size, hash and held identity before allocation; recheck
before each native process start and before accepting final evidence. Verify all
106 snapshot bodies against their declared digests and closed manifest list;
snapshot framing must not let source text become operator instructions. Recheck
the public profile and original six/eleven preservation without reading private
configuration values or changing them. The pending link/team already exist:
require unchanged safe link metadata, never rerun setup or create/adopt members.

The full review argv/environment are the exact revised candidate, including
`--print --model claude-opus-5-5 --effort max`, stream-json/verbose, `--restricted`,
`--max-turns 8`, no builtin file/shell/edit/delegation/browser tools, strict pinned
MCP, exactly inbox/send allowed and the other eleven metadata methods denied,
default permission mode, unanswered permission prompts denied, no Chrome/session
persistence/slash customizations. Exactly three mailbox calls are in scope:
inbox peek, connectivity ACK send and substantive review-result send.

One prospective argv addition is a fresh UUIDv4 `--session-id`, bound in the final
receipt/candidate; no resume/continue/fork/remote/cloud flag. This requires a new
archived candidate revision before source freeze, not silent modification of the
current pinned candidate. Any other argv/path/data delta similarly needs exact
review. Child environment is exactly real HOME `/Users/shubham`, PATH
`/usr/bin:/bin`, TMPDIR `/private/tmp`; no ambient account/provider/preload values.

## Admission, supported client controls and actual authorization

The root supplies an owned private fixed-path approval receipt, after source
freeze, binding operator/tests/candidate/input/config/runtime/client hashes,
source/evidence identities, exact argv/environment, new session UUID, private
output directory held identity and the bounded provenance/cleanup protocol.
It carries two distinct actual nonauthor decisions, root and backend; this
operator's author cannot approve its own invocation. Missing, stale, unknown-key,
forged identity, partial or consumed receipts fail closed. A source review is
not an actual stage approval.

Before any review client start, admission must have current metadata-only proof
that the installed pinned CLI supports every selected flag and the selected
restricted mode preserves managed policy while excluding user/project/local
customizations. `--restricted` is documented from2.1.248; installed help/behavior
has not yet been independently checked for this candidate. Do not infer support
only from a newer webpage. Do not test capability by starting a model.

Managed hooks, status-line commands, plugins, credential helpers, automatic
provider/routing overrides, dynamic workflows and policy MCP additions must have
an authoritative supported metadata admission, bound to this invocation. Mere
absence of one local file is not proof that account-delivered policy is absent.
If the normal client cannot expose enough safe metadata, record
PREFLIGHT_BLOCKED. If mandatory policy would run an unrelated command/load an
unreviewed plugin/provider, stop; do not disable/override managed policy or read
secret settings values to force this task through. No blanket disableAllHooks or
new trust/global settings. Metadata proof may contain only presence/status/count,
public hashes and the exact safe controls needed, never command/config/account
values. This prerequisite remains incomplete, not silently certified by docs.

After all static admission, run only the fixed bundled executable's ordinary
`auth status`, with the fresh fixed HOME/PATH/TMPDIR, a15-second bound and64KiB
capture limit. Parse stdout in memory and immediately project only loggedIn,
authMethod and apiProvider; do not persist raw stdout or account identity.
Stderr is never printed; retain only safe status/hash if needed. Exit1 plus
loggedIn false/none -> AUTH_REQUIRED, zero review/model client starts. Malformed,
unknown or mismatched status -> AUTH_UNKNOWN, no review start. Only exit0 plus
normal existing authenticated first-party state can proceed. No auth login,
token/account helper, logout, browser, account switch or alternative credential.
The auth-status process itself has an owned Popen identity, finite exit/absence
check and conservative timeout handling; do not lose a preflight process.

AUTH_REQUIRED does not claim zero subprocesses: it records one possible owned
metadata-preflight process and zero review/model starts. It does not consume a
model claim or authorize automatic auth polling. The owner handles normal sign-in;
a later exact operator invocation needs fresh admission and permission.

Only after all admission succeeds reserve a persistent exclusive once claim,
keyed by source/template/input/session, before model/client allocation. Refuse
existing/partial claims and any reused session/output. Revalidate held private
0700 output directory ownership/identity/emptiness, then create0600 transcript,
stderr and closed state files exclusively. Bind every record to the claim. Keep
the claim after all outcomes; no automatic retry, rollback or mailbox recreation.
The final implementation must freeze the exact private receipt/claim/output
paths and schemas before actual-stage review; no arbitrary file arguments.

## Owned process selection and observations

Use one owned Popen for the exact pinned native CLI, with stdin/stdout/stderr
pipes and its own fresh session/process group. Capture pid, parent, group, start
identity and executable/argv equality through supported OS observations before
feeding the complete fixed input. Handle pipe writes/reads nonblockingly with a
monotonic1200-second total review deadline,8-turn client limit,8MiB stdout and
64KiB stderr caps. Limit exhaustion is failure, never silent truncation/PASS.

Observe only this Popen's direct descendants and fresh group metadata through
supported `/bin/ps` and `/usr/bin/pgrep` queries. First read pid/parent/group/start
metadata without arguments; inspect an argument vector only for a child already
linked to the held owned parent/group. Recheck identity before/after that read.
Never print/persist raw unknown-process args; no broad machine command dump.
At most one of each exact expected chain is admissible:

1. owned CLI: exact native executable plus frozen argv, parent is this operator,
   fresh private process group;
2. direct adapter child: exact pinned Node24 binary plus single content-addressed
   `ruflo-local.mjs`, parent is that CLI, same fresh group/start interval;
3. direct Ruflo child: same Node24 plus exact runtime `bin/cli.js mcp start
   --transport stdio`, parent is that adapter, same group/start interval.

The unchanged pinned adapter's source supplies this direct-child command and EOF
shutdown behavior. Do not require a disallowed model mcp_status call, inject MCP
messages into the client's private stdio, impersonate the client, attach hidden
IPC or create a second metadata client for a different PID. OS selection is
observation, not a model/account or full OS sandbox proof.

Observe the chain while alive; require exact CLI/adapter/Ruflo fingerprints before
accepting any successful review. Zero, multiple, stale, reparented, detached,
unexpected, unobserved or unverifiable child state is explicit UNKNOWN/
UNRESOLVED. No first matching process, name-only adoption or assumption that a
brief child never existed. A fresh group's empty readback is a supplementary
absence check, not permission to kill a group or proof about detached/unobserved
processes. Unknown state can withhold success even after useful model text.

## Completion, timeout, failure and cleanup

Preserve the first failure independently of cleanup. On every path close only
the owned CLI's stdin when safe, allowing normal client exit and EOF delivery to
its own MCP adapter. Keep pipes drained within their caps. Give the adapter at
least nine seconds after client transport closes, exceeding its complete5s TERM
plus2s KILL window. On a1200-second timeout/interruption/output failure, close the
owned input first, permit the same grace and use bounded escalation only after
fresh unchanged ownership fingerprints.

The operator may terminate its held live Popen. Any direct adapter or Ruflo
signal additionally requires the exact captured parent/group/start/executable
identity immediately before that signal. Never signal a reused/reparented PID,
an unknown child, existing host-managed client, process name or whole group.
Use bounded TERM then, only for still-proven exact owned identities, bounded KILL.
Record each signal and grace stage. Forced termination/timeout/interruption
cannot yield a successful review acceptance even if final absence is verified.

Independently prove all three exact PIDs absent using successful OS absence
semantics, CLI exit/pipe closure, fresh group empty and unchanged relevant input
pins. A changed/reused PID is not a successful absence receipt. Record separate
CLI, adapter and Ruflo outcomes; a parent exit does not prove child exit. Unknown
or failed absence/partial spawn/ambiguous ownership remains UNRESOLVED and no
further signals or retries follow. Retain private evidence for direct review.
Cleanup failure never replaces the primary failure or creates a success status.

## Provenance and output boundary

Raw client JSON/text/stderr remains only in the held0600 private output files;
do not log raw events, commands, account fields, source bodies or malformed data
to stdout/Git. Public output uses a closed schema/fixed literals with input/tool
hashes, requested/started/completed counts, safe auth status, actual session/model
identity, requested/effective effort separately, three correlated tool-call
outcomes, first-failure code and separate owned process cleanup records.

Accept only supported pinned-client init/result/tool-event schemas; bind the
session UUID throughout, actual returned model identity to exact
`claude-opus-5-5`, and the three tool calls/results to the genuine observed
session. Verify inbox sender/recipient/team/nonce against safe pending-link bytes,
then the acknowledged exact reply and separate substantive review-result send.
Do not promote an arbitrary mailbox sender or uncorrelated transcript. Unknown
schema, duplicate/out-of-order/wrong-session calls, missing ACK/review, fallback,
permission denial or more than the three allowed calls fails/incompletes review.
Do not forge ACK, modify link status or mark actualClaudeExtensionACK true.

Effective max requires genuine supported session metadata, not argv, self-report
or absence of a warning. The current stream protocol's effective-effort proof
has not yet been established. If it cannot be established, retain requested:max,
effective:UNPROVEN and a bounded incomplete/effort-unproven result; never claim
the requested configuration was fulfilled. Likewise retain actual model/session
unknowns rather than inferring them from the prompt. Model technical findings
remain distinct from client/effort/provenance acceptance.

A completed review may request changes; successful transport/configuration does
not imply code approval. The operator can record only
REVIEW_RECEIVED_PENDING_INDEPENDENT_ACCEPTANCE when all required provenance and
normal cleanup are proven, along with a safe declared review outcome. It cannot
promote whole Week2/M0, deployment/C2, fullstartup/rootbuild/typecheck, all115
register cases, clinical/finance/security/privacy-owner or release acceptance.
Human-readable findings enter Git only after separate private-transcript
inspection/sanitization and direct postreview. No automatic publication/push.

## Required fake-only proof and later gates

Before code, obtain two nonauthor contract decisions. After implementation,
freeze exact source/tests/recipe/input hashes and obtain independent Spec and
Standards source reviews. Unit entry disables all real subprocess, model, socket,
provider and actual state ports globally, and imports no application/client code.
Use owned temporary fixtures and mandatory fake runtime ports; no fake fallback.
Meaningful negatives must cover:

- wrong/extra argv/env/source/model/MCP/profile/input/hash/symlink/mode/inode and
  output/claim collision before review launch;
- logged-out/unknown auth, auth timeout/leaked metadata, missing authoritative
  flag/managed customization proof and preserved first preflight failure;
- exact chain success, missing/ambiguous/unknown/reused/reparented/detached child,
  stale identity before signal, parent-only exit and independent child absence;
- timeout, stdin/pipe/parse/output-limit failure, normal EOF grace, narrowly
  allowed TERM/KILL, forbidden group/name/host-managed kill and cleanup failure
  without losing the primary failure;
- wrong model/session/effective effort, capped/unproven max, fallback, malformed
  stream/result/inbox envelope, denied/duplicate/extra/unrelated mailbox calls,
  synthetic sender without session proof and no fake extension ACK;
- arbitrary secret-like strings in unexpected input/error/events never reaching
  public output; bounded private capture and honest partial/UNRESOLVED status;
- original six staged/patch and eleven handover preservation without mutation.

Only after both source reviews may root prepare a concrete actual invocation
receipt with fresh ordinary authenticated status, safe managed-policy admission,
final operator/argv/session/input/output/provenance bindings and two actual
nonauthor stage decisions. AUTH_REQUIRED currently prevents that stage. This
contract alone permits no native client/model/status invocation or private
configuration inspection. The original frozen candidate/archive/input and all
earlier actual backend/connection evidence remain intact.

Primary supported-control references: [CLI flags and restricted mode](https://code.claude.com/docs/en/cli-reference),
[model/effort limits](https://code.claude.com/docs/en/model-config).
