# Parallel foundation slice

10 November 2026. Branch `m0/parallel-foundation`, baseline `bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7`. This lane owns only its diagnostic recipe/evidence and any separately reviewed foundation follow-up. Other workers own OTP and authority worktrees; the original checkout's six staged Ruflo files and handover archive remain untouched.

## Bounded preparation

The owner clarified that the existing diagnostic approval remains unconsumed at `41539ca749c8a9dbf49ecf43bcca00749eccfe3c`. The lead created an independent clean detached worktree at `/private/tmp/swasthadisha-parallel-p1qom53w/diagnostic-41539` so the reviewed source remains exact while this feature branch carries preparation/evidence.

The historical operator is preserved. The [relocated copy](../../../output/qa/parallel-foundation/relocated-operator.py) differs only in its fixed source root, its assertion of detached rather than the former branch identity, and a mandatory SHA-256 check of the exact host Node binary before executing that binary. [Exact relocation diff](../../../output/qa/parallel-foundation/relocation.diff) and [pre-execution inventory/invocation](../../../output/qa/parallel-foundation/pre-execution.json) are retained. All 103 source/evidence/historical mappings and the original frozen patch were verified against the detached source without application evaluation or Docker access.

The same recorded local socket/engine, cached-only Node image, blank owned Docker configuration, strict interface assertion, fixed six-file no-DB scenario, resource limits and ownership-aware cleanup remain unchanged. No image pull, daemon startup, engine substitution, new filesystem/network grant, guard relaxation or automatic retry is authorized. Any post-create failure requires direct review before another invocation. Printed IDs never supply cleanup authority.

## Direct review and measured execution

The lead `/root` independently verified clean detached `41539ca`, the manifest and all 103 mappings, exact three-amendment relocation, actual pinned host-Node hash and invocation. It approved **one relocated diagnostic invocation**, bound to recipe SHA-256 `deee1489299263190016f2d8119b3fa7189c7cd0d6df199a8ab849ccb3b0dcf3`. This is internal Codex technical review under the existing owner-approved scope, not a new external/human or deployment approval.

The exact recorded command ran once. The recorded engine and cached image passed; source freezes passed before and after launch. **Result: FAIL at the unchanged strict interface guard, bootstrap line 30.** This is a real executed diagnostic, replacing neither the historical smoke failure nor the historical BLOCKED_BEFORE_LAUNCH attempts. The single diagnostic approval is now consumed. No retry occurred.

The matching-run diagnostic was 1,207 bytes. It measured `bonding_masters` as a regular file, with per-device attribute reads unavailable as `ENOTDIR`; the additional device entries reported `operstate: down` with recorded flags/type values; only `lo` appeared in the assigned-address result (`127.0.0.1` and `::1`). These sampled facts do not establish route state, network-namespace provenance or general safety of unaddressed devices. No harmlessness/admission conclusion or interface-name allowlist follows.

Cleanup was independently confirmed on the same recorded engine: exact created container `0da7634fb06a04356bb2e7ec2c79755bd1c5e64921b07106102fb385cd76f8b1` absent, its workspace `/private/tmp/sd-app-isolation-TLILOm` absent, and zero purpose-labelled containers before/after. No recovery, broad prune, image pull, daemon startup, engine change or guard/grant modification occurred. [Measured summary and artifact hashes](../../../output/qa/parallel-foundation/verification.json) and [exact execution streams/readbacks](../../../output/qa/parallel-foundation/execution-1/operator-result.json) are retained; the owned blank Docker config and private ownership marker were not copied into Git.

Post-interface permission/HTTP assertions, dynamic recording ports, scenario/helper imports, seven receipts and successful-exit/no-OOM acceptance were not reached. Complete application/DB/SDK/provider admission, C2 adoption, domain scenarios, M0/release and 100 RPS acceptance remain open. The selected 115-scenario outcomes are unchanged.

The next gate is independent review of this measured failure and a concrete network-observation/admission contract before any further invocation or source/grant/guard change. The new metadata can inform that review; it does not supply permission to silently weaken the strict guard.
