# First real application smoke: failure disposition

**10 November 2026. FAIL; exact resources cleaned. Review required before any retry.** Approved/executed commit `de1693ed80538099bab2874a3ea8254df5f62143`, branch `m0/f01-app-isolation`. No runtime code was changed after approval and the launcher was invoked once. [Received scope](APPROVAL.md); [measured summary](../../../qa/m0-a/app-isolation/activation-1/verification.json).

## What happened

1. Verified clean approved HEAD and all 71 revision-1 hashes before caching, immediately before launch and after launch. Logs lived outside the checkout during execution. Verified the unchanged helper hash and Node 22.23.4 host executable.
2. Through a newly owned blank Docker config, verified socket `unix:///Users/shubham/.docker/run/docker.sock` and engine `16ab25f6-88c7-4687-a431-b119b6ab9319`. Recorded zero application-purpose containers. Cached only committed `node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`; saved image ID/RepoDigests.
3. Ran the exact launcher once. It created a container and returned its early exact-ID/run/workspace record after parent admission. Bootstrap validated its initial environment/runtime/bundle checks, then failed at line 16: `readdirSync('/sys/class/net').sort()` was not exactly `['lo']`. Docker start returned nonzero with the Node assertion in captured stderr.
4. Ordinary controller cleanup acknowledged success. Independent same-engine/exact-ID inspection returned a specific missing-container response; the exact workspace was absent; purpose-label counts were zero before/after. No exceptional recovery, label-based removal or second invocation occurred.

Observed entries: `bonding_masters`, `erspan0`, `gre0`, `gretap0`, `ip6_vti0`, `ip6gre0`, `ip6tnl0`, `ip_vti0`, `lo`, `sit0`, `tunl0`.

The confirmed cause of the failed assertion is the extra directory entries. The reason this kernel exposes them, whether every entry is a device, and their operational/address/route state remain **unverified**. They are not proven harmless, inactive or externally reachable. The earlier review's interface concern is reproduced as an assertion failure; its suggested explanation is not yet a measured diagnosis.

## Evidence limits

- Parent mount/isolation checks passed on the successful controller path before start and removal. A full raw container inspect was not separately saved; do not present those checks as an independent inspect capture or general proof for other hosts. The bind-path mismatch did not occur on this invocation.
- Real bootstrap entered, but later filesystem/process/addon permission assertions and HTTP canary were not reached. Dynamic ports/scenario/helper imports and seven recording receipts are NOT_RUN. Exit-zero/no-OOM acceptance was not established.
- Cleanup is evidenced by both the controller acknowledgement and independent absence checks, not by labels alone. The cached public image remains; no image prune was authorized.
- Prior unit evidence remains 161 passes per runtime, 22 runner controls and 16 companion checks. These are historical unit results, not a replacement for the failed smoke. No tests were rerun for this documentation/evidence increment.

## Next review question

Determine the smallest safe diagnostic or network-admission amendment before a new runtime candidate is executed. Do not replace the assertion with an observed-name allowlist or remove it solely because `--network none` was requested.

Possible evidence sources require careful limits: [Docker's none driver](https://docs.docker.com/engine/network/drivers/none/) documents an isolated stack and a loopback example, but does not explain this measured sysfs listing. [Node 22.23.4 `os.networkInterfaces()`](https://github.com/nodejs/node/blob/v22.23.4/doc/api/os.md#osnetworkinterfaces) reports interfaces assigned an address, so its absence of a name alone cannot exclude an unaddressed device. [Linux process-network metadata](https://man7.org/linux/man-pages/man5/proc_pid_net.5.html) describes per-network-namespace information under `/proc/self/net`; reading new paths would require explicit permission/contract review. These are research leads, not an implemented repair or proof of this container's routes.

The reviewer should specify whether additional diagnostics are needed and the exact fail-closed invariant, parser fixtures and permission paths for a candidate. Preserve the target/image, fresh ownership, network none, read-only/non-root/capability/resource limits, source pin and no-DB/no-SDK scope. Required negatives must include unexpected active/addressed interfaces, missing/malformed evidence and any unaddressed/route case the chosen observation method can overlook. A concrete amended source/hash package must be reviewed before retry.

The attachment's nonblocking logging gap remains tracked: interruption during factory post-create checks can precede the early launcher record. Address in the next sandbox revision with a regression; do not infer permission to change the already-executed source or rerun. Retained-server C2 facts, root adoption, full backend/DB/SDK integration, financial/clinical/stock acceptance, full C3/M0 and 100 RPS remain separate.
