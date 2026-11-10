# Network admission rule contract

**10 November 2026. Contract only.** Branch `m0/foundation-network-admission`, base `9ea963f`. Authorizes no source, grant, guard, Docker change or invocation.

## 1. Measured failure

The `41539ca` diagnostic failed the unchanged `['lo']` guard and was cleaned ([record](../../../output/qa/parallel-foundation/verification.json)): `lo` symlink, flags `0x9` (IFF_UP|IFF_LOOPBACK), type 772, operstate `unknown`; `bonding_masters` regular file, all attribute reads `ENOTDIR`; nine device symlinks with IFF_UP clear and operstate `down` (`erspan0`/`gretap0` `0x1002` BROADCAST|MULTICAST, type 1 Ethernet; others `0x80` NOARP, ARPHRD tunnel/tunnel6/SIT/IPGRE/IP6GRE 768/769/776/778/823). Addresses: `lo` only, internal `127.0.0.1`/`::1`.

This matches the bonding control file plus per-namespace fallback tunnels from loaded modules (`net.core.fb_tunnels_only_for_init_net` 0); no host-side names appeared. It does **not** establish routes, namespace identity, addresses on down devices (libuv lists only UP+RUNNING addressed interfaces) or later assertions.

## 2. Admission rule

Bootstrap always captures the existing `APP-NET-DIAG-1` record. A pure `evaluateNetworkAdmission(observation)` in `app-bundle.mjs` validates the full shape (exact keys/tag, at most 16 sorted unique valid names) and admits only if:

1. Exactly one entry is named `lo`: kind `symlink`, flags include IFF_UP and IFF_LOOPBACK, type 772, operstate `unknown` or `up`.
2. Every other entry is either a `file` whose `flags`, `operstate` and `type` are each `{unavailable: 'ENOTDIR'}` (a class control file, not a device), or a `symlink` with IFF_UP and IFF_LOOPBACK clear, type not 772 and operstate exactly `down`.
3. Addressed interfaces are exactly `lo`, with a non-empty unique subset of {`127.0.0.1`/IPv4, `::1`/IPv6}, all `internal: true`.

Parsing is strict: flags `^0x[0-9a-f]{1,8}$` (kernel `%#x`), type `^(0|[1-9][0-9]{0,4})$` and at most 65535, operstate one of the seven ABI strings. Any `unavailable` field, other kind, reader error or malformed record rejects. Only `lo` is named; no allowlist.

Deviations from the lead proposal: loopback operstate is checked (the kernel reports `down` for any non-running device); "file" requires the observed `ENOTDIR` reads; a second loopback is type 772 **or** the IFF_LOOPBACK bit; `::1` may be absent on IPv6-disabled kernels.

**Soundness.** A device that is not up cannot transmit (queueless transmit returns `-ENETDOWN`; queued devices hold a dropping qdisc). Raising links or changing addresses/routes needs CAP_NET_ADMIN; packet sockets need CAP_NET_RAW. `assertOwned` (`app-container.mjs:164-179`), before start and after exit, already requires NetworkMode `none` with only `none` networks, CapDrop containing `ALL`, empty CapAdd, not Privileged, exactly one SecurityOpt `no-new-privileges`, user `1000:1000`, no devices and no host PID/UTS/user namespace. No inspect addition is required (unchecked `HostConfig.Sysctls` cannot raise links or add routes). The rule shows only that nothing but `lo` can transmit, not a pristine namespace.

## 3. Route and namespace observation: not required

Option A, reading `/proc/self/net/route` and `ipv6_route`, adds a separately reviewed grant (changing Node `Cmd` and parent inspect) and a kernel-table parser whose IPv6 output carries local/reject entries on `lo`. Option B relies on the rule, absent CAP_NET_ADMIN/CAP_NET_RAW, NetworkMode `none` and the canary. Routes matter only through an up device; the only one admitted, `lo`, delivers back into the namespace. **Recommend B**: smaller, no grant. Residual risk: namespace provenance is inferred (sysfs and netlink views agree; no host interfaces), not measured; routes/addresses on down devices are unmeasured but cannot transmit; observation is point-in-time, with trusted daemon/host changes out of scope except the post-exit inspect. A later reviewed option: require the canary to fail with `ENETUNREACH`, measuring "no IPv4 route" without a grant.

## 4. Controller success evidence

Bootstrap success JSON replaces `networkInterfaces` with `networkAdmission`: `tag` (`APP-NET-ADMIT-1`), `observation` (the `APP-NET-DIAG-1` record, at most 8 KiB), `loopback` (`lo`), `controlFiles`, `downDevices` and `loopbackAddresses` (each sorted). The line-209 equality becomes: the parent recomputes `evaluateNetworkAdmission(networkAdmission.observation)` with its already-imported `app-bundle.mjs` and requires JSON equality with the reported object. On rejection, bootstrap writes the bounded `{...observation, runId}` stderr record once and throws; diagnostics are never success evidence.

## 5. Fixtures

Evaluator positive: **P1** exact measured record (`controlFiles` `[bonding_masters]`, nine `downDevices`, both addresses); **P2** `lo` only; **P3** `lo` operstate `up`, IPv4 only, plus `tunl0` flags `0x0`.

Evaluator negative: **N1** active `eth0` (`0x1003`, `up`, type 1, non-internal `172.17.0.2`); **N2** `lo` missing; **N3** `lo` down (`0x8`, `down`); **N4** `lo` without IFF_LOOPBACK or type 1; **N5** second loopback (`lo2` type 772; non-`lo` flags `0x88`); **N6** flags `9`, `0x`, `0xg1`, `0X9`, nine hex digits, `ERR_ACCESS_DENIED`; **N7** non-`lo` `0x80` with operstate `unknown`, `dormant`, `up`, `lowerlayerdown`, `notpresent`, `testing`, `DOWN`; **N8** inconsistency (non-`lo` `0x81` `down`; `lo` `0x9` `down`); **N9** kind `directory`, `other`, unavailable; **N10** file with readable or non-`ENOTDIR` attributes; **N11** type `772x`, `-1`, `70000`, unavailable; **N12** addressed non-loopback; **N13** `lo` with non-internal `10.1.2.3`, `127.0.0.2`, duplicate `::1`, empty set or unavailable addresses; **N14** 17 entries; **N15** each reader throws; **N16** wrong tag, unknown/missing key, unsorted or duplicate names.

Controller: **K1** P1 accepted; **K2** missing `networkAdmission`, or legacy `networkInterfaces` only; **K3** summary differs from recomputation; **K4** forged summary over N1. Bootstrap-block probe (own-checkout paths): **B1** P1 continues without a stderr record; **B2** N1 emits one tagged record of at most 8193 bytes then throws; **B3** `readdir` throws, no record; **B4** `['lo']` continues.

## 6. Unchanged and future work

Unchanged: image digest, six-file bundle, Node grants (reads `/workspace`, `/sys/class/net`; writes `/tmp`), mounts, network none, user, capabilities, limits, labels, early-ID record, 8 KiB/16 KiB bounds, HTTP canary, later permission assertions, ports/scenario/receipts, ownership-aware cleanup, no `/proc` reads or child tools.

A future single invocation needs a reviewed implementation commit with exact hashes for the six owned files and evidence; unit/probe passes on Node 22.23.4 and 24.19.0; fresh review and one-run approval bound to those hashes; the recorded socket/engine ID and cached pinned image (no pull) via an owned blank config; and A–D source/baseline/cleanup proof. Later assertions would then run for the first time; any post-create failure stops for review. Success admits only this no-DB scenario.

References (not fetched in this offline phase; reviewer to confirm): [if.h](https://github.com/torvalds/linux/blob/v6.12/include/uapi/linux/if.h), [if_arp.h](https://github.com/torvalds/linux/blob/v6.12/include/uapi/linux/if_arp.h), [net-sysfs.c](https://github.com/torvalds/linux/blob/v6.12/net/core/net-sysfs.c), [dev.c `__dev_queue_xmit`](https://github.com/torvalds/linux/blob/v6.12/net/core/dev.c), [sysfs-class-net](https://www.kernel.org/doc/Documentation/ABI/testing/sysfs-class-net), [fallback tunnels](https://docs.kernel.org/admin-guide/sysctl/net.html), [bonding](https://docs.kernel.org/networking/bonding.html), [capabilities(7)](https://man7.org/linux/man-pages/man7/capabilities.7.html), [libuv `uv__ifaddr_exclude`](https://github.com/nodejs/node/blob/v22.23.4/deps/uv/src/unix/linux.c), [Docker none](https://docs.docker.com/engine/network/drivers/none/).
