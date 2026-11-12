# Lab booking create log minimization — draft

12 November 2026. **DRAFT ONLY; two independent nonauthor Spec/Standards decisions required before source edits.** Author: internal Codex `/root/customer_booking_writer`. Root owns integration/Git. No source or telemetry access/cleanup is authorized here.

## Baseline and design requirement

Focus worktree `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab`, branch `m0/customer-pharmacy-lab-focus`; observed HEAD `2f27b59c183892b5418dfd8751d23890b9022c63`. External controller SHA-256: `3a45d9694b50da0e1cebf90ffd94e8b2921130c784530bde844d49e16b4418b3`, including the reviewed/integrated dependent-owner guard. Preserve all customer/lab/Rx/pure/R4 source and evidence, private captured material, and the original staged files/archive. This task reads no private captured thinking or operational logs.

[SYSTEM_DESIGN.md:572](../SYSTEM_DESIGN.md) requires minimal identifiers/status context, redaction of medical content/secrets and distinct protected audit records. [TC-OPS-007](../qa/TEST_SCENARIOS.md), line182, requires actor/purpose/outcome audit without PHI/secrets in generic telemetry. The [published R4 review](../../../output/qa/customer-pharmacy-lab-claude-review/operator/CLAUDE_REVIEW_4.md) identified raw/normalized logging in the older controller snapshot. The same properties remain in the integrated current source, verified directly; R4 is not relabeled as review of the later dependent guard.

Proposed scope is **only `src1/modules/externalBookings/controller/index.ts`**, exactly four metadata property deletions across two existing info events. No helper/redaction framework, logger configuration, audit store, DTO, actor/dependent guard, provider, response, business rule or error change.

## Exact source and telemetry classification

MCP symbol search returned no matching logger symbol in the stale graph; exact durable files were read. Current create routes (`externalBookings/routes/index.ts:100–110`, mounted with authenticate at `src1/routes/index.ts:101`) run body Joi before catchAsync/controller.

| Handler/event | Current source | Metadata |
| --- | --- | --- |
| createBooking: `[ExternalBooking] frontend consultation booking payload received` | Controller441–446 | userId, integration:data.integration, frontendPayload:req.body, normalizedPayload:data |
| createDiagnosticsBooking: `[ExternalBooking] frontend diagnostics booking payload received` | Controller520–525 | Same four properties |

These are literal `logger.info(message, metadata)` calls to `src1/services/logger/index.ts`, whose inspected configuration is Winston level info, JSON format, Console and File(`combined.log`) transports. No protected audit API, purpose/outcome schema, immutable store or privileged audit access is invoked by these two calls. They occur before the create-service result, so they are receipt diagnostics rather than a successful clinical/financial outcome record. Their resolved userId can identify an admin-selected booking owner; it is not necessarily the acting admin's ID.

The design distinguishes protected clinical-access/privilege audit from application/debug logs and does not require these complete bodies in generic telemetry. Removing the payload properties therefore preserves the existing receipt events without substituting for any required protected audit. This conclusion is limited to the inspected source/design; external observability forwarding and audit consumers are not inventoried here.

`req.body` at this point is Joi-validated/sanitized, **not raw HTTP bytes**. Validation strips unknown top-level fields but admits patient/contact/address/demographic fields, clinical free text and `meta: Joi.object().unknown(true)` in both create schemas. It is not privacy redaction. The normalized DTO additionally incorporates account-profile defaults. Passing either entire object into generic metadata can carry sensitive content; no actual patient payload, secret, file delivery or historical log content was accessed to establish operational exposure.

## Exact minimum amendment

At both events remove only:

```ts
      frontendPayload: req.body,
      normalizedPayload: data,
```

Retain each `logger.info` call, its exact message and location, and precisely the existing metadata:

```ts
      userId,
      integration: data.integration,
```

Do not rename, hash, stringify, truncate, nest, spread, copy or relocate either full object into another metadata key, another severity, console output or a replacement event. Do not add a wrapper, allowlist module, new dependency, new metadata field, redaction pass or global logger change. Intended removal is four lines; every other controller byte must remain unchanged.

The dependent-owner guard remains the first awaited statement in both creates (currently386/464). Actor401, local malformed/foreign/missing dependent404, the one existing scoped lookup, and error propagation/order are unchanged. A denial still precedes UserModel reads, DTO normalization, these receipt events and create-service dispatch. Neither event is moved ahead of that guard or made to execute in a catch/finally. Current metadata minimization must not become a reason to weaken ownership checks.

Signed account/admin owner resolution, post-spread corporate association, patient and alias normalization, service arguments, provider/payment/coupon/wallet paths, 201 response/messages and all route/Joi/error behavior retain their source. The clinical DTO still contains fields needed by its existing business path; this contract removes them only from the two metadata objects.

## Explicit privacy and operational limits

Retained userId is linkable account context; integration also reveals routing context. Their necessity, purpose, access, cardinality and retention need privacy/security/operations review. Preserving them for this minimum source amendment does not declare them anonymous or approved for every sink. No retention duration, deletion rule, audit exemption or complete telemetry policy is invented.

Other current sources remain a separate privacy backlog: Labstack logs consultation/diagnostics payloads (`bookings/services/labstack/index.ts:405`,`:729`); Healthians does likewise (`healthians/index.ts:334`,`:870`). ExternalBookingService/finalization also log operational/error context. Shared showError can include provider response data or whole errors, and errorHandler logs err.message. This four-property change does not certify those paths, suppress all sensitive logs, replace protected audit, or close TC-OPS-007.

Source removal affects future execution of the amended code only. It does not prove deployment, actual sink delivery, historical exposure or erasure. Existing console/file collectors, combined.log, backups/exports, access, retention/legal holds and any incident response require separately authorized privacy/security/operations work. No operational log read, export, deletion or patient notification follows from this contract. Preserve earlier records and source evidence; do not clear logs as part of the implementation.

## Review and focused verification

Obtain two actual independent nonauthor contract decisions on this exact hash, then explicit Root source authorization. After implementation archive before/after/hash and prove exactly the four approved deletions, unchanged event messages/remaining metadata, byte-identical guard/handlers otherwise and pinned shared sources. Meaningful lexical controls can restore each forbidden property, rename/spread a whole body into either target metadata object, delete an event, alter an identifier or move logging before the guard. They remain source assertions, not executed confidentiality tests.

No new runtime harness is requested by this draft. Actual focused logging/HTTP behavior remains NOT_RUN until complete current C3 pre-import admission, including the dependent-service constructor closure, logger transports/file permissions, provider/queue/network recording and exact dependencies/configuration. A scoped recorder must distinguish **these two event messages** from unchanged downstream logs. Do not claim a canary absent from every log when those other payload paths remain. Event metadata should contain only the preserved keys/values; automatic logger level/message fields are outside that metadata object. Confirm body/DTO/service calls and accepted/error responses remain unchanged, and dependent-denied requests do not emit either receipt event while existing middleware error logging stays separately bounded.

No app import/execution, Node, compiler/parser, tests, DB, provider, network, model/auth call or Git mutation was performed for this draft. Root C2, privacy/audit/retention decisions and focused C3 gates remain. Final cross-module integration is DEFERRED_BY_OWNER; no clinical/privacy/client/module/M0/deployment/release or historical-exposure conclusion is supplied. Author stops writes at this draft for independent reviews.

## Source/design bindings (SHA-256)

Exact source/design/public review context read and hashed; not a complete log inventory or C3 closure. Reconcile drift before implementation without silently refreshing pins.

| Path | SHA-256 |
| --- | --- |
| `src1/modules/externalBookings/controller/index.ts` | `3a45d9694b50da0e1cebf90ffd94e8b2921130c784530bde844d49e16b4418b3` |
| `src1/modules/externalBookings/services/index.ts` | `4a13a02cca31c0d4833937643e362b78096f4135933a59ed3372577635a24f83` |
| `src1/modules/externalBookings/routes/index.ts` | `c85d540083d25d7c00bf1fc969e20bccbea09b33d915fb9cac9b19e73ae67b06` |
| `src1/modules/externalBookings/validation/index.ts` | `49c3aa3449e61655d9a34b6a201de9874e83003df8737b5aa5dfdab09bd6dcc6` |
| `src1/modules/externalBookings/types/index.ts` | `a9306564c5ce3572d15eaaa589831df12db483ce56a181af2a3c484f2d3656cf` |
| `src1/services/logger/index.ts` | `21bffce52030c060eef9dab156ced8225686001d2f6cd7d6655177b69025ac35` |
| `src1/modules/common/utils/asyncHandler.ts` | `59fe49db58678ef81242a654f7457f74b067b2583a3f8dc70918b61f50228bd9` |
| `src1/modules/middleware/errorHandler.ts` | `1e06885f2c5b8df8ed186dba28cd975aaf4f4d5233a2daa277e6b7f7b15fad51` |
| `src1/modules/common/middleware/validation.ts` | `8be55cee7485531491ff095ed1d9f36af443987690f22d04dd67ef9318a0a5ef` |
| `src1/modules/middleware/auth.ts` | `db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2` |
| `src1/routes/index.ts` | `50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056` |
| `src1/modules/dependents/services/index.ts` | `adc2f3cf156bfa807bf125904ecd83c8f84dee38a072c7b78d1e90c8822cc044` |
| `src1/modules/bookings/services/labstack/index.ts` | `2d9a55e9692d15a0a15253754d1234738bbe24b41adc1762a6727350f41f379a` |
| `src1/modules/bookings/services/healthians/index.ts` | `ee685f9ec37185a0bfcf5ce1f21614734b9ece8d55f982cf893922c9765bd8da` |
| `src1/modules/externalBookings/services/externalBookingPaymentFinalize.ts` | `1480f9885624363e842c4b3b38ad0e136756bd1a39e81b75138c972222a1416a` |
| `documentation/planning/implementation/LAB_DEPENDENT_OWNERSHIP_CONTRACT_DRAFT.md` | `8bfccbdd4baaf64a59e0c2d6a6d019b03cba38c18aa7d23a4845ba9ad3aa3d97` |
| `documentation/planning/SYSTEM_DESIGN.md` | `cbd899f6fb442b13db28c389143b529b90da364165dc17291cc829814810bc84` |
| `documentation/planning/qa/TEST_SCENARIOS.md` | `bd8c6e8952a8c1cc2f2c2063a4d7a79000dc5566b966a6650d49d60ff841f09e` |
| `output/qa/customer-pharmacy-lab-claude-review/operator/CLAUDE_REVIEW_4.md` | `4f75b41dd0342d91259764b678f488b4001e1127c29da1a699d2f086b8fd0170` |
