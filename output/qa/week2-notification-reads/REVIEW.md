# Notification generic authority and FCM test sender: reviews

11 November 2026. Author `/root/auth_api_fixture_contract`, branch
`m0/week2-notification-reads`, baseline
`d91e1a3d37f2b229efc7fc2507d666ddc2576d99`.
Contract SHA-256 `f24cd44e9ae5a9734b255c426854f5a0cb8efb56b3c9be6f911a2a3435b2aeb1`.

Before production edits, two actual nonauthors approved that exact contract:

| Reviewer | Scope and decision |
| --- | --- |
| `/root` | Spec pre-review: **APPROVE_CONTRACT_IMPLEMENTATION_ONLY** after reading full contract and actual controller/model/auth/FCM routes. Confirmed five-generic-plus-test scope, existing strict-own/specialist/sender/token preservation and explicit state/error limits. |
| `/root/backend_boot_path` | Standards pre-review: **APPROVE_CONTRACT_SOURCE_ONLY**. Read all contract/current source, graph-first discovery with stale-index qualification, independently checked all 28 backend and five observed mobile hashes, and found no material issue. |

The lead's conditional two-file implementation assignment became effective after
the Standards decision. Current source changes are exactly NotificationController
and FCM routes; no notification route registration, service/repository/model/DTO,
caller, provider/parent/runtime source or observed client file changed.

The same inspected isolated Python verifier ran before editing the actual
unchanged production files and exited 1 with
EXACT_NOTIFICATION_AMENDMENT_REQUIRED. Its literal output remains
`baseline-rejection.json`. After implementation it returns 0, accepts the exact
two-file transformation, rejects the reconstructed baseline and all 26 source
variants, and matches 26 unchanged backend files plus baseline pins for the two
amended files. Mode and complete changed/untracked/ignored scope checks pass.
Production whitespace passes. Archived unified-diff blank-context marker bytes
are evidence and must not be normalized.

The controller adds canonical nonblank string principal checks, owner-bound general
listing and a stored-recipient authorization read before ID serialization/mutation.
Exact admin retains generic global scope. Reusing the unchanged strict-own helper
for nonadmin comparisons preserves its fixed safe errors; old four path handlers
and all five specialist handlers remain byte-identical. FCM/test gains only the
existing requireAdmin import and pre-validator guard; /token stays unchanged.

These are source transformation/scope controls, not actual HTTP/JWT/DB/effect or
client proof. No TypeScript/app/compiler/npm/client/DB/provider/Docker evaluation
occurred. The current fixture does not admit these routers/cases. Two separate
independent frozen implementation reviews are pending; full M0, clinical/product/
security-owner, deployment and release acceptance remain separate.

## Final independent implementation decisions

Both independent nonauthors approved the exact source freeze SHA-256
`e032da4f4484f81b4068ee9a0c0f468a81739e6e466edb584ab8b19e3cb64db0`,
including controller `e9b58d50978062ebe7a52b5a2259b9e862415e6e17fd69599ba8945d1f25934f`,
FCM routes `bfd18b39dd716a2f34dad8c287670789d56d313eff5879bdc70cf9820a7121c4`
and checker `4493e421bfe0ba34a19c19a5372dceaffe7554d2518234ee4334ad6c7af53ce5`.
No frozen source or artifact changed after these decisions.

| Reviewer | Actual decision and verification |
| --- | --- |
| `/root` | **APPROVE_SOURCE_ONLY**, independent Spec implementation review. Read the full actual two-file diff and inspected checker, independently ran the isolated source gate and production whitespace check. Confirmed baseline/26 variants rejected, 26 unchanged input pins, canonical owner/exact-admin semantics, all earlier secure paths/callers unchanged and explicit error/field/split-write limits. No material finding. |
| `/root/backend_boot_path` | **APPROVE_SOURCE_ONLY**, independent Standards review. Inspected the same actual diff, helper/DTO/state boundaries, all nine frozen artifacts and byte-identical full-index patch `89858009402f817965f7a0d0fc3dc3179c43fe0bd2908b3486b1342b654c0d85`. Independently reran the inspected sanitized Python checker: all 26 variants rejected, baseline and 26 unchanged pins/modes/scope pass; whitespace passes. No material finding. |

These are internal Codex source-only technical decisions. The actual pre-edit
rejection remains retained; checker reruns reject the reconstructed baseline.
Neither reviewer executed TypeScript, app, compiler, npm, client, DB, provider or
Docker code. Real notification/FCM HTTP/state/effect/client and reintroduced-source
sensitivity cases remain NOT_RUN, requiring the separately reviewed C3 extension.
No deployed protection, full M0, clinical/product/security-owner, capacity or
release acceptance is claimed. The lead handles local commit/integration; nothing
was pushed and no external message/provider action was performed.
