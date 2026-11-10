# One fixed local activation candidate

Author `/root/local_claude_review_prep`; no global activation or real transport/model call has run. This candidate implements the already reviewed activation boundary of the local-link contract. `activate.py` is source for two independent reviews, not an approval receipt.

It is fixed to the lead-prepared private plan `/private/tmp/sd-local-ruflo-activation-0k4r5m8l/plan.json`, SHA-256 `7e1a9e0a846e106ff3944922cbcae39f6b05e3dc5c07316ed12bd6f835da02da`. That plan records privately verified backups and the Codex candidate; none of those configuration bytes enter Git or stdout. All private inputs require an owned real 0700 directory, owned regular single-link 0600 files, exact bytes/hashes and held identities.

The program requires fixed private `approval.json` with schema `SD-LOCAL-RUFLO-ACTIVATION-APPROVAL-1`, decision `APPROVE_ONE_LOCAL_RUFLO_ACTIVATION`, exact `planSha`, `programSha`, `sourceRoot`, `smokeSha` and exactly two actual distinct nonauthor `reviewers` with that same decision. Canonical `/root` is valid; the author is rejected. The lead creates that receipt only from actual received stage decisions. An exclusive `activation.claim.json` precedes global effects and remains after success/failure; no automatic retry or rollback exists.

Fixed invocation from this owned worktree after those direct stage approvals:

```sh
env -i PATH=/usr/bin:/bin TMPDIR=/private/tmp /opt/homebrew/bin/python3 -I -B output/qa/week2-local-review-link/activate.py
```

The observed macOS/Python launcher adds only `LC_CTYPE` and `__CF_USER_TEXT_ENCODING` to that outer environment. The program admits those locale metadata fields and forwards neither; its sole CLI child receives fresh fixed HOME and PATH.

Before changes, the program checks the original six staged files and eleven handover files, every fixed runtime/source pin, CLI bytes, live-link/team/setup absence, target-content-directory absence, both original config snapshots, private backup/candidate identities and the complete one-line Codex byte transformation. It opens the original configs without following links and retains their identities.

Before each subsequent file effect, it checks the expected phase of both configs, unchanged private input/backup bytes and identities, unchanged runtime/CLI/source pins, owned install-directory identities and link/team/setup absence. It exclusively installs cached frozen adapter bytes, writes only the one-line Codex candidate through the held original inode, then invokes exactly the installed bundled Claude `mcp add --scope user --transport stdio ruflo -- NODE ADAPTER` configuration command. It captures only exit status/output hashes, never CLI text. The resulting entire Claude JSON object must equal the original object with just the one `mcpServers.ruflo` addition. Final `read_fixed_inputs` validates both closed public profiles and all installed hashes.

Success means `ACTIVATED_PENDING_SEPARATE_TRANSPORT_REVIEW`. It requests no client reload/termination and starts no Ruflo/model worker. Any failure after claim is `UNRESOLVED_REVIEW_REQUIRED`, retaining private claim/report/backups and partial state. No config contents, credentials, provider account operation, auth flow, hidden IPC or blanket trust change is part of this program. A later real transport invocation and a genuine existing-client Claude Opus 5.5/max review retain their own gates and provenance requirements.

`test_activation.py` exercises only pure receipt/invocation/candidate validation. All real Popen/run/check-output ports are forbidden. Its 13 cases cover canonical lead identity, required bindings, author/duplicate/wrong-stage/extra-payload rejection, fixed invocation and platform locale fields, exact Ruflo args replacement and unrelated-byte/profile denial. They do not prove real configuration writes or installed-CLI behavior. The frozen proof is `activation-verification.json`; both direct source/stage decisions remain pending.
