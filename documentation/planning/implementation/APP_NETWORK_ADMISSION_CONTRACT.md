# Network admission rule contract

**10 November 2026. Amended after pre-review, containment review and Standards review.** Branch `m0/foundation-network-admission`, base `9ea963f`. Internal Claude reviews, each returned to the author for changes:
- the contract pre-review of `32fdf77` returned APPROVE WITH REQUIRED AMENDMENTS;
- the containment review of `a609a60` returned APPROVE WITH NITS, closed in `33cabbe`;
- the Standards review of `33cabbe` returned APPROVE WITH NITS, closed in this revision with test and documentation changes only. It authorizes offline implementation and the admitted unit gate only. It authorizes no Docker access, grant change or invocation.

## 1. Measured failure

The `41539ca` diagnostic failed the unchanged `['lo']` guard and was cleaned ([record](../../../output/qa/parallel-foundation/verification.json)):
- `lo`: symlink, flags `0x9`, type 772, operstate `unknown`.
- `bonding_masters`: regular file; all three attribute reads failed with `ENOTDIR`.
- Nine device symlinks, all with IFF_UP clear and operstate `down`. `erspan0`/`gretap0` had flags `0x1002`, type 1. The rest had `0x80`, types 768/769/776/778/823.
- Addresses: `lo` only, internal `127.0.0.1`/`::1`.

The record does **not** establish routes, namespace identity, addresses on down devices, or anything about the later, unreached assertions.

## 2. Superseded requirement

[`REVIEW.md` "Measured limits and next gate"](../../../output/qa/parallel-foundation/REVIEW.md) made two statements:
- the sample does not justify an observed-name or down-state allowlist;
- the next slice needs a route-observation contract with bounded new read paths.

This contract **supersedes the route-observation and new-read-path requirement**. Its fixture requirements are kept (section 8).

It also **supersedes the sentence that the evidence does not "justify an observed-name or down-state allowlist"**. The rule is not an allowlist of observed names or sampled states. It admits any admin-down non-loopback device semantically, and that admission rests on the justification below, not on the sample.

The justification is not the sampled names or states. It is:
1. the capability argument (section 5); and
2. a runtime consistency check: the egress canary must fail with `ENETUNREACH` (section 4).

The measured record is only the positive fixture P1. The rule names nothing except `lo`.

## 3. Admission rule

Bootstrap always attempts to capture the `APP-NET-DIAG-1` record. Each of the following throws without writing a record:
- port or `runId` validation;
- a failed or non-array listing;
- more than 16 names, or invalid names;
- an observation over 8192 bytes;
- a report line over 8192 bytes, or a failing report write. Either error replaces the admission rejection, and it has no `cause`.

`evaluateNetworkAdmission(observation)` validates the record's complete shape:
- exact keys and tag;
- 1–16 entries, with valid, strictly ascending names;
- each field is a string or an exact `{unavailable: CODE}`.

It **throws** `Network admission rejected: <fixed reason>` on every rejection. Otherwise it returns a deep-frozen summary. It admits only if all of the following hold:

1. **Loopback.** Exactly one entry is named `lo`. It is a `symlink` whose flags include IFF_UP (0x1) and IFF_LOOPBACK (0x8). Its type is 772 and its operstate is `unknown` or `up`.
2. **Other entries.** Each is one of:
   - a `file` whose three attributes are each `{unavailable: 'ENOTDIR'}`. This exemption applies to kind `file` only.
   - a `symlink` with IFF_UP and IFF_LOOPBACK clear, type not 772, and operstate exactly `down`.
3. **No volatile bits.** No entry has RUNNING (0x40), LOWER_UP (0x10000) or DORMANT (0x20000) set. Sysfs `flags` is expected not to carry these bits, so their presence fails closed.
4. **Addresses.** Exactly one addressed interface, `lo`. It must have `127.0.0.1`/IPv4/internal. `::1`/IPv6/internal is optional. No other address and no duplicates are allowed.

Parsing rules:
- Flags: `^0x(0|[1-9a-f][0-9a-f]{0,7})$`.
- Type: `^(0|[1-9][0-9]{0,4})$`, at most 65535.

Any other value, kind, unavailable field or reader error rejects.

## 4. Egress canary

`egressCanaryBlocked(settled)` takes a `Promise.allSettled` result for the canary fetch. It returns true only when the fetch was rejected and `reason.cause.code`, or a direct `reason.code`, is `ENETUNREACH`. Every other outcome fails and bootstrap throws:
- success;
- timeout or abort;
- refusal;
- any other code;
- a missing or malformed outcome.

Scope (lead decision): the IPv4 documentation address `192.0.2.1:8080` only. No grant is added.

Given the interface rule, `ENETUNREACH` at the next real run is consistent with no IPv4 route covering that address. It is **not independent proof**: an ICMP net-unreachable received during SYN_SENT can also produce it. IPv6 routing is not measured.

## 5. Soundness basis and residual risk

`assertOwned` (`app-container.mjs:164-178`) runs at lines 194, 198 (before start) and 202 (after exit). It requires:
- NetworkMode `none`;
- CapDrop `ALL`, no CapAdd, not Privileged;
- only `no-new-privileges`;
- user 1000 and no devices.

**Unverified kernel/libuv facts, recalled from memory (no source access in this session):**
- the IFF/ARPHRD constants;
- sysfs `flags` is `dev->flags` (kernel `%#x`, zero rendered as `0x0`);
- sysfs reports `down` for any device that is not running;
- a device that is not up cannot transmit;
- raising links and changing addresses or routes needs CAP_NET_ADMIN, and packet sockets need CAP_NET_RAW;
- the fallback-tunnel sysctl behaves as described;
- libuv lists only interfaces that are UP, RUNNING and addressed;
- `ENETUNREACH` on connect arises from a missing route, but may also come from a received ICMP net-unreachable.

**Observed at the next real run:** the canary's error code (consistent with, not proof of, no route), and every entry's kind, flags, operstate, type and addresses under the rule.

**Remaining assumptions after that run:**
- down devices cannot transmit or be raised;
- namespace provenance;
- IPv6 routes.

**Residuals:**
- Any admitted down device could have its other end outside the container: a veth peer, a macvlan/ipvlan parent, a tun/tap file-descriptor holder, or a tunnel underlay. Raising or using that path is host-only, under the trusted-host model.
- `HostConfig.Sysctls`, `Runtime` and `GroupAdd` stay unasserted.
- The observation is point-in-time.

## 6. Controller evidence

The bootstrap success JSON replaces `networkInterfaces` with `networkAdmission`. Its fields are `tag` (`APP-NET-ADMIT-1`), `observation`, `loopback` (`lo`), `controlFiles`, `downDevices` and `loopbackAddresses`; the lists are sorted.

The parent requires all of these:
- `networkInterfaces` is absent;
- `tag` and `loopback` have their exact values;
- `verifyNetworkAdmission`, which recomputes the summary from `observation`, returns true. It is false if the evaluator throws or the JSON differs.

On rejection, bootstrap writes the bounded `{...observation, runId}` stderr record once and then throws.

## 7. Implementation boundary

**Owned files:**
- `test/application/` `app-bundle.mjs`, `app-bundle.test.mjs`, `bootstrap.mjs`, `app-container.mjs`, `app-container.test.mjs`, `README.md`;
- the status lines of `C3_APP_ISOLATION_CONTRACT.md`;
- `output/qa/foundation-network-admission/`.

**Gate-covered pure functions in `app-bundle.mjs`:** `entryKind`, `captureNetworkDiagnostics`, `evaluateNetworkAdmission`, `verifyNetworkAdmission`, `admitNetwork` and `egressCanaryBlocked`.

**Bootstrap** only binds the `fs`, `os`, `fetch` and stderr ports. A hashed probe, `network-block-probe.mjs`, extracts that wiring and runs it with fakes, using its own checkout's paths. The unit-gate staging list is unchanged.

## 8. Fixtures

**Evaluator, positive:**
- **P1:** the embedded measured record. The probe matches its SHA-256 against `verification.json`.
- **P2:** `lo` only.
- **P3:** `lo` operstate `up`, IPv4 only, plus `tunl0` with flags `0x0`.

**Evaluator, negative:**
- **N1:** active `eth0` (`0x1003`, `up`, type 1, non-internal `172.17.0.2`).
- **N2:** `lo` missing while its address row remains, so only the loopback count can reject it.
- **N3:** `lo` down (`0x8`).
- **N4:** `lo` with `0x1`, or type 1, or kind `file`, or kind `directory`.
- **N5:** `lo2` with `0x0` and type 772; `dummy0` with `0x88`.
- **N6:** flags `9`, `0x`, `0xg1`, `0X9`, `0xA`, `0x09`, `0x123456789` or `ERR_ACCESS_DENIED`, applied on `lo` and on `tunl0`.
- **N7:** `tunl0` `0x80` with operstate `unknown`, `dormant`, `up`, `lowerlayerdown`, `notpresent`, `testing` or `DOWN`.
- **N8:** `lo` with operstate `dormant`, `testing`, `lowerlayerdown`, `down` or `notpresent`.
- **N9:** `tunl0` `0x81` with `down`; an unaddressed `eth0` with `0x1003` and `up`.
- **N10:** `tunl0` with `0xc0`, `0x10080` or `0x20080`; `lo` with `0x49`.
- **N11:** `tunl0` with kind `directory`, `other` or unavailable.
- **N12:** a file entry with readable flags, or all `ERR_ACCESS_DENIED`, or all `ENOENT`.
- **N13:** a symlink with all `ENOTDIR`, or all `ENOENT`.
- **N14:** type `772x`, `-1`, `70000`, `0772` or unavailable; `lo` with type `0772`.
- **N15:** `tunl0` addressed.
- **N16:** on `lo`: `10.1.2.3`, `127.0.0.2`, `fe80::1`, `::ffff:127.0.0.1`, swapped families, a duplicate `::1`, `::1` only, a non-internal `127.0.0.1`, addresses unavailable, no `lo` entry, an empty address list, a second addressed interface, or `127.0.0.1` reported on `tunl0` instead of `lo`.
- **N17:** 17 entries.
- **N18:** a malformed record: wrong tag, unknown or missing key, an extra entry key, unsorted or duplicate names, `null`, a numeric field, an unavailable object with an extra key, or a lowercase code.

**`admitNetwork`:**
- **A1:** the measured listing is admitted with no report.
- **A2:** N1 produces one tagged record of at most 8193 bytes with the matching `runId`, then throws.
- **A3:** `list` throws: no record, no reads.
- **A4:** 17 names: no record, no reads.
- **A5:** each reader throws: one record, then throws.
- **A6:** a missing `list`, `entryType`, `readText`, `addresses` or `report` port, or an invalid `runId`, throws before listing. Validation already ran before `list()`; no code change was needed.
- **A7:** `lo` only is admitted; an unsorted listing is sorted.

**`entryKind`:** all four kinds, with symlink taking precedence.

**Canary:**
- **E1–E2:** `ENETUNREACH` as `cause.code` or as a direct `code` returns true.
- **E3–E9:** these return false: success; `TimeoutError`; `AbortError`; `ECONNREFUSED`/`EHOSTUNREACH`/`ENETDOWN`/`ETIMEDOUT`; a null, primitive or absent reason; an unknown status; lowercase `enetunreach`.
- **E10–E11:** these also return false, which pins the fail-closed decision: `ENETUNREACH` only in the cause's message text, and a code nested in `cause.cause`.

**Controller:**
- **K1:** P1 is accepted.
- **K2:** `networkAdmission` missing, or the legacy field only.
- **K3:** a dropped or added name, changed addresses, or an extra summary key.
- **K4:** a forged summary over N1.
- **K5:** a summary consistent with the evaluator but over a rejected observation (`lo` dormant).
- **K6:** both `networkInterfaces` and `networkAdmission` present.
- **K7:** wrong `tag` or wrong `loopback`.

**Probe:**
- **B1:** the exact `verification.json` record continues.
- **B2:** N1 emits one record, then throws.
- **B3:** `readdirSync` throws: no record.
- **B4:** `['lo']` continues.
- **B5:** a down `tunl0` with an address row emits one record, then throws. This pins the `addresses` binding.
- **C1:** `ENETUNREACH` continues; exactly one fetch to `192.0.2.1:8080` with a signal.
- **C2–C4:** success, timeout and `ECONNREFUSED` each throw.

## 9. Unchanged and future work

**Unchanged:**
- image, six-file bundle, Node grants, mounts, network none, user, capabilities and limits;
- labels and the early-ID record;
- the 8 KiB and 16 KiB bounds;
- later permission assertions, ports, scenario and receipts;
- cleanup;
- no `/proc` reads and no child tools.

A future single invocation needs all of these:
- exact candidate hashes;
- gate and probe passes on Node 22.23.4 and 24.19.0;
- a fresh review and a one-run approval;
- the recorded socket/engine and cached pinned image, via an owned blank config;
- A–D source/baseline/cleanup proof.

Any post-create failure stops for review. Success admits only this no-DB scenario.

## References

All unverified in this session:
- [if.h](https://github.com/torvalds/linux/blob/v6.12/include/uapi/linux/if.h)
- [if_arp.h](https://github.com/torvalds/linux/blob/v6.12/include/uapi/linux/if_arp.h)
- [net-sysfs.c](https://github.com/torvalds/linux/blob/v6.12/net/core/net-sysfs.c)
- [dev.c](https://github.com/torvalds/linux/blob/v6.12/net/core/dev.c)
- [sysfs-class-net](https://www.kernel.org/doc/Documentation/ABI/testing/sysfs-class-net)
- [net sysctl](https://docs.kernel.org/admin-guide/sysctl/net.html)
- [capabilities(7)](https://man7.org/linux/man-pages/man7/capabilities.7.html)
- [libuv linux.c](https://github.com/nodejs/node/blob/v22.23.4/deps/uv/src/unix/linux.c)
- [Docker none](https://docs.docker.com/engine/network/drivers/none/)
