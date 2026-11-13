# Customer profile milestone contract — 13 November 2026

Owner resumed the bounded customer milestone. Source baseline: `m0/customer-pharmacy-lab-focus` at `9c8d1d8f6ecda8d0832f9294c4b1b7a6fdf7077c`. Functional reference: legacy `ewa_backend` local saved ref `origin/integration/perks-v2-combined` at `2347787e312721d89652913f9d36adf11a9be251`; legacy source is reference only, never executed or copied wholesale.

## Effective behavior

- Signed customers may update only their own profile. Admins retain profile editing. Existing HR corporate scoping remains; HR cannot add or replace personal phone/email.
- For a customer, an already stored phone/email stays unchanged. Discard attempted replacements before validating those fields, so other valid editable fields in the same request still save, even if the discarded contact input is malformed.
- A customer may add a missing personal phone/email. Admins may replace existing personal contacts. Validate and normalize an admitted contact, run current email availability and added phone availability checks, and do not infer OTP verification from input. Added/replaced personal email resets `isVerified`.
- A missing contact means absent, null or empty string. Atomic final missing-field predicates prevent two simultaneous self-additions from overwriting each other. A stale addition returns `409 CONTACT_ALREADY_SET`. Ignored contact-only self/HR updates are idempotent no-ops returning the current profile.
- Preserve current raw customer privilege-field rejection, ownership, schema validation and protected role/state fields. Keep current corporate behavior and all signup/login source unchanged.
- Only a signed principal explicitly passed by the controller establishes update mode. No body field or unrestricted default enables admin editing. Validate the effective update inside the service after contact filtering; retain route parameter validation.

## Evidence and limits

Meaningful focused checks will evaluate the actual whole service with a closed VM module loader and recording repository/corporate/Joi/AppError dependencies. They must cover mixed payloads, invalid ignored versus invalid missing contacts, self/admin/HR/foreign actors, duplicates, verification reset, final missing-field predicates and simulated stale writes. No application graph, database/provider/HTTP, compiler/install/start or operational configuration is admitted by this contract.

The current phone and personal email indexes are not unique. Prechecks establish observed duplicate rejection, not concurrent uniqueness across different accounts and all writers. Index/backfill/cutover, actual Mongo behavior, supported clients, session revocation and production release remain separate. Do not import the isolated full contact-change branch or claim it is complete.

## Ownership and reviews

Worker `/root/profile_owner` owns the user controller/routes/services/validation change and focused profile test source. Root owns shared integration/cancellation. Independent preimplementation Spec: Root accepts the above contract on 13 November 2026. Independent Standards: `/root/reviewer` APPROVE_IMPLEMENTATION_CONTRACT_ONLY on 13 November 2026 after inspecting the sole caller, current validation semantics and nonunique indexes. Production changes and test execution wait for their corresponding exact review.

## Actual focused result

One exact separately reviewed Node 24.19.0 permission-limited recording run completed exit 0: 29 whole-service nominal checks, 29 after restoration, seven whole-controller checks and four detected source controls. Raw output, invocation/tool/source hashes and limitations are in `output/qa/customer-milestone/profile/RUN_RECORD.json`. Root and independent nonauthor `/root/booking_owner` personally inspected the actual raw output and accepted this recording-VM scope only; their decisions are recorded in RUN_RECORD.json. Stderr retains the native experimental TypeScript stripping warning. No actual Joi/HTTP/MongoDB/client or cross-account uniqueness result follows.
