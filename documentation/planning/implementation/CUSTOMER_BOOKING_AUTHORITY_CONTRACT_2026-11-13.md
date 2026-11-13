# Existing customer booking authority — 13 November 2026

Owner resumed the narrowed customer milestone and explicitly deferred BetaCura/hybrid work. Base is `9c8d1d8`; the legacy `2347787` branch is reference only. This contract permits source implementation, not application execution.

- All three ordinary create handlers require a signed actor before dependent lookup or booking service effects. Individual customer ownership and corporate association come from that actor. Explicit admin targets and existing pharmacy behavior remain.
- A supplied individual-customer dependent must be a 24-hex identifier and belong to the signed customer. Reject an explicitly inactive dependent before booking service effects. Missing legacy `isActive` remains compatible with the existing optional dependent field; this does not prove consent or clinical authority.
- Apply that same inactive-dependent rejection to the existing external-booking guard. External create/list handlers require a signed actor and have no missing-actor, body-owner or `test-user` fallback.
- Preserve existing scoped reads, diagnostics history/progress, notes-only generic writes, signed external corporate association, prior role checks and private-document core. No provider, finance, runtime, dependency or route changes.

Worker `/root/booking_owner` owns only `src1/modules/bookings/controller/index.ts` and `src1/modules/externalBookings/controller/index.ts`. Root owns all shared services and cancellation; profile owner owns user files. Others share the worktree and their changes must be preserved.

Preimplementation Standards: `/root` APPROVE_IMPLEMENTATION_CONTRACT_ONLY. Preimplementation Spec: `/root/profile_owner` APPROVE_IMPLEMENTATION_CONTRACT_ONLY after direct current-source inspection. Both decisions were received on 13 November 2026 before production edits.

Actual whole-controller recording-port checks need separate exact-source execution review. They must cover normal creation, signed owner/association selection, malformed/foreign/inactive dependents and no-actor denial before reads/effects. Recording fixtures do not prove HTTP/DB/client/provider behavior or close patient-consent races.
