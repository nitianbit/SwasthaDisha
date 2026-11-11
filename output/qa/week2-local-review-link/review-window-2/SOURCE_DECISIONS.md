# Independent source decisions, 11 November 2026

Both nonauthor reviewers inspected the complete frozen candidate directly and
returned **APPROVE_SOURCE_ONLY**, with no material remaining finding. These are
internal Codex reviews, not Claude, owner, security or release approvals.

| Axis | Actual reviewer | Decision |
| --- | --- | --- |
| Standards | `/root/index_standards_fresh` | APPROVE_SOURCE_ONLY |
| Spec | `/root/index_spec_fresh` | APPROVE_SOURCE_ONLY |

Baseline: `52b70b2e26890d057334dd696523c19458411e53`.
Source freeze: `7c4d346b2d65bbacc5dfaa18359a6350bf1a456a86a44ec790f946020016767a`.
Operator: `6369bad213c0c72475fc5d05247599b41ddbb589e82d46ec39f9601a59c3f5f9`.
Tests: `cf850ff0251aa1b8c761a2621d120a8b3daa97043cfe96b637cfd1bf4b06f094`.
Corrected amendment: `5b67a3e5582d094cd2579850e1060673f999a539574f5323dd7842ef5a1c5ddd`.

Each reviewer independently reproduced all 95 hard-fake tests and all four
weakened-source controls, with two syntax checks and exact packet/archive/pin
verification. Standards verified 40 frozen files, 16 prior archive entries,
141 body hashes, 96 descriptor sources, 117 source Git objects and 19 evidence
Git objects. Spec independently verified the same target bindings and preserved
private-input copies without rewriting the packet-verification receipt. Root
subsequently verified all 40 frozen file hashes and the original staged patch
and eleven protected handover files. No actual CLI/auth/model probe, application,
TypeScript/compiler, database or Docker execution was part of these source reviews.

The local monotonic deadline is now 3600 seconds. EOF grace remains nine seconds;
eight turns, three mailbox calls, finite output/ownership/cleanup limits and once
claims remain unchanged. The refreshed packet covers only accepted 76/21 evidence
at source `c2dbac3`, descriptor `185fb708`, evidence `638f44d`; it excludes later
unexecuted index work. Its byte size does not establish token/context admission.

The SDK's documented init-effort field applies to Remote Control and is omitted
from local application init. Local non-null effort is therefore refused and
effective effort remains **UNPROVEN**. Requested max, actual review receipt and
effective-mode certification are separate facts. No alternate transport or
fabricated GUI acknowledgement was introduced.

Frozen README, source-freeze and verification files retain their original
pre-review PENDING labels intentionally; this later record supplies the actual
decisions without changing reviewed bytes. Normal authentication, authoritative
client/policy/schema/context admission and two exact actual-stage decisions
remain outstanding. The owner chose backend continuation and sign-in later;
no authentication polling or model request follows from this approval.
