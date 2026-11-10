# Meet runtime evidence: preparation notes

Read-only discovery at `7517a23`; no implementation or invocation authority.
This preserves the native explorer's findings for a later bounded contract after
the JWT configuration fixture interfaces settle. Existing source guard approval
is in `output/qa/batch3-outbound-guards/CONTRACT.md`. Current five source files are
pinned in source-inputs.json. The graph is stale at canonical bfb608e, so actual
integrated source governs. Root's route read confirms these exact registrations:

| Relative route | Existing authority |
| --- | --- |
| GET /google-oauth/callback | Public, then callback query validator |
| GET /google-oauth/url | authenticate, requireAdmin, validator |
| POST /google-oauth/exchange | authenticate, requireAdmin, validator |
| POST /google-oauth/refresh | authenticate, requireAdmin, validator |
| POST /google-meet/oauth | authenticate, requireAdmin, validator |

A future focused mount must import the actual router directly at /api/v1/meet,
without a mount-wide JWT guard that would block the public browser callback.

The service is singular meet/service/index.ts and exports functions. It uses
native global fetch, not a Google SDK. Do not replace its service/helpers or add
Google packages. The minimum declared recording seam is global fetch installed
AFTER the real ENETUNREACH canary and BEFORE any Meet import. Two exact POST URL
families suffice for the selected routes: the Google token URL with exact owned
synthetic authorization-code/refresh-token URLSearchParams; and the fixed encoded
synthetic calendar events URL with conferenceDataVersion=1 and sendUpdates=all,
synthetic bearer and the actual generated event JSON. Bound private captures and
provider-shaped in-memory replies; latch every unknown URL/method/header/body,
including a failure caught by application code. Do not delegate to native fetch.

Only five Meet files are literal additions. Booking/Slot/Specialist/UserRepository
references in the service are type annotations; their actual emitted requires
must be checked before expanding models. A conservative source walk can include
unreachable type dependencies. Do not invent Booking/Slot admission or import
unrelated bookings/services/MeetingService.ts. Preserve the real emitted AST model
reconciliation, current thirteen model/index entries and existing package lock;
report any actual closure discrepancy before another stage.

Use ephemeral fixture-only Google client ID/secret/redirect/refresh/calendar/timezone
values before first CONFIG load, without service-account fields/files or actual
account material. Explicit fixed date/time/duration and example.com attendees
avoid tomorrow/default timing. Assert actual OAuth URL parameters/state, exact
forms, generated event times/timezone/attendees/summary/request-ID shape and
synthetic join-URL/code mapping. Recording intents are not consent, real token
validity, invitation delivery, CSRF-session or internal booking acceptance.

All existing collections and JWT/email/SMS/push/read/write effects must remain
unchanged for these route calls; only explicitly expected recording-fetch counts
may advance. Freeze how the existing calendar provider-counter key counts token
and calendar intents before implementation; its current constant-zero report
cannot be left unchanged while claiming observed provider requests.

Protected-route anonymous/invalid/expired-token denials and each nonadmin role
must precede validation/provider work. Exact admin malformed requests retain
current validator errors. Public callback without a code returns its controller's
400 success:false envelope with zero recording requests; it is distinct from the
strict AppError envelope. Full existing slice coverage also requires valid-code,
provider-error and invalid-query callback cases under explicit bounded recording
replies. Do not call a single missing-code reachability case full OAuth coverage.
Real source guard-removal/order/callback-gating variants must fail the same HTTP
predicates, with fresh nominal restoration and separately accounted effects.

Before implementation: freeze concrete case/mutation IDs, request/reply/error/
state/counter/closure contracts and writer ownership; obtain two independent
pre-reviews. Then source reviews, fresh exact locked preparation/emitted closure,
actual artifact review and two single-run decisions precede any App/DB execution.
Root dependency/startup C2 facts, OAuth/account/clinical/booking owners, production,
100 RPS and full M0/Week 2 remain separate. No new package, grant, model, provider
operation or configuration activation is authorized by these preparation notes.
