# Meet administrative HTTP evidence extension

11 November 2026. DRAFT_FOR_TWO_PREIMPLEMENTATION_REVIEWS. No source edit or
execution authority follows from this draft. The existing outbound containment
contract remains authoritative. This extends the focused HTTP fixture only;
internal booking orchestration and OAuth account/state-session acceptance remain
separate work.

## Baseline and ownership

Production discovery is pinned at integration `7517a23`; the five actual Meet
files are recorded in source-inputs.json. The new fixture depends on the reviewed
JWT configuration producer/consumer at `0a6da87051dc6eae8c2415c4ea3ce09ded414662`.
Its actual runtime result is separately reviewed before integrating this work.
The graph is stale at bfb608e; current file pins govern. Before writers begin,
root integrates the accepted JWT candidate into this branch and records that
exact baseline and hashes in a separate freeze without silently changing these
requirements. Every existing60 nominal/17 sensitivity ID and its body, thirteen
models/correctness indexes, package roots/lock and parent execution profile stays.

Root owns this contract, ports-manifest.json, branch composition and Git metadata.
A shared worker owns bootstrap.cjs/bootstrap-unit.cjs plus its own QA directory.
A separate scenario worker owns scenario.cjs/compile.cjs/scenario README plus its
own QA directory. Writers are not alone in the codebase and must preserve others'
edits. No production, package/lock, parent launcher/platform/profile, network
helper or root runtime/build/CI source is assigned. Two actual nonauthor Standards
and Spec contract decisions must precede implementation; two source decisions,
exact preparation/artifact decisions and two one-run decisions precede runtime.

## Actual module and route boundary

Mount the actual `@/modules/meet/routes` router directly at `/api/v1/meet` with
NO mount-wide authentication. Its public callback must stay reachable. Add only
that ninth root; compile actual routes/controller/validation/singular service/types.
Do not replace the Meet service, CONFIG, validators or native provider payload
builders. Existing logger recording remains. No Google package or SDK is added.

The singular service has Booking/Slot/Specialist/UserRepository references in type
annotations. Conservative TypeScript discovery is not emitted runtime evidence.
Preserve genuine emitted literal-require traversal and exact model/source set
reconciliation. If actual emitted reachability needs any new model, package or
capability, stop and amend/review this contract before admission. No import of the
unrelated bookings/services/MeetingService.ts or booking scheduler is authorized.

## Recording fetch and synthetic configuration

Keep the genuine native-fetch ENETUNREACH canary before installing a recording
global fetch. Install the closed recording port after complete admission and the
canary, before the first CONFIG/Meet import, and keep existing native socket/TLS/
DNS guards. Never call the saved native fetch from that port. Existing fixture
HTTP uses its admitted loopback transport. No network permission changes.

Use fixture-only GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
GOOGLE_OAUTH_REDIRECT_URI, GOOGLE_OAUTH_REFRESH_TOKEN, GOOGLE_CALENDAR_ID and
GOOGLE_MEET_TIMEZONE values set after admission and before CONFIG. No inherited
Google value, service-account setting/file, real token/key, hostname or account is
read. Fix redirect `https://fixture.example.com/oauth/callback`, calendar
`fixture-calendar@example.com`, timezone `Asia/Kolkata`; all emails use example.com.
The existing configuration matrix must retain these added fixture values unchanged
and still prove its exact existing108+18 fresh-load/zero-effect predicates.

The recording port admits exactly these service-generated POST intents, only
against an explicitly queued in-memory expected request. All method, URL, header,
body and response comparisons use finite synthetic fields:

1. `https://oauth2.googleapis.com/token`, sole Content-Type
   application/x-www-form-urlencoded, actual URLSearchParams containing exactly
   code/client_id/client_secret/redirect_uri/grant_type=authorization_code, OR
   client_id/client_secret/refresh_token/grant_type=refresh_token. Compare exact
   key sets, values and no duplicates. Preserve actual URLSearchParams generation.
2. `https://www.googleapis.com/calendar/v3/calendars/fixture-calendar%40example.com/events?conferenceDataVersion=1&sendUpdates=all`,
   sole synthetic Bearer and application/json headers, actual JSON event body
   with exact summary/description/start/end/attendees/conferenceData structure.
   No event update/delete, JWT-bearer grant, service-account or other URL admitted.

Bound each queued input/body/record to8KiB, at most256 records per phase. Every
unknown request, duplicate/unqueued call or malformed response contract latches
unexpected and throws a fixed fixture error, even if application code catches it.
In-memory replies implement only the used `ok` and bounded async `text()` surface
with exact synthetic OAuth token/event objects; no fetch/Response dependency is
needed. Clear only completed expected queues between phases; nonempty queue on
phase end is failure. Restore the held original fetch on final cleanup without
using it. Never print requests, tokens, rows or assertion operands.

Append no public output field. Existing providerSummary.calendar now counts ALL
admitted Google OAuth/calendar recording intents (not just event creations).
Private records distinguish token and event requests. Successful nominal exchange
has1 intent, refresh1, event creation2; total nominal calendar=4. Every rejection
or callback/authorization-URL request has0. Negative-phase counters are asserted
separately and excluded from the nominal summary. All other provider-summary keys
retain their current meaning. Record this counter meaning in ports/runtime plan.

The shared interface is a phase-local recorder exposing read-only `meetRequests`
and an `expectMeetRequests(expected)` function on scenario context; requests are
copied as frozen finite data, and the actual service must consume each expectation
once in order. `counters.calendar` is maintained by the recorder, never supplied
by a scenario result literal. Shared pure tests must cover actual normalization,
unknown/duplicate/count/size/order denial, zero delegation, latch behavior,
phase reset/final restoration and a denied call caught by a fake domain caller.

## Sixteen appended nominal groups

Append exactly these ordered IDs after the existing60, yielding76. A group is a
bounded matrix of actual HTTP calls, not a count of raw requests:

| ID | Exact request/assertions |
| --- | --- |
| MEET_URL_AUTHORITY | GET /google-oauth/url matrix below |
| MEET_EXCHANGE_AUTHORITY | POST /google-oauth/exchange matrix below |
| MEET_REFRESH_AUTHORITY | POST /google-oauth/refresh matrix below |
| MEET_CREATE_AUTHORITY | POST /google-meet/oauth matrix below |
| MEET_URL_ADMIN_VALIDATION | Admin state array rejects400 VALIDATION_ERROR |
| MEET_EXCHANGE_ADMIN_VALIDATION | Admin empty code rejects400 VALIDATION_ERROR |
| MEET_REFRESH_ADMIN_VALIDATION | Admin refreshToken array rejects400 VALIDATION_ERROR |
| MEET_CREATE_ADMIN_VALIDATION | Admin invalid patient/specialist emails reject400 VALIDATION_ERROR |
| MEET_URL_ADMIN_SUCCESS | Admin200, exact success/message/data and OAuth URL fields/state |
| MEET_EXCHANGE_ADMIN_SUCCESS | Admin200, one exact code-grant intent and exact synthetic token response |
| MEET_REFRESH_ADMIN_SUCCESS | Admin200, one exact refresh intent and exact synthetic accessTokenPreview |
| MEET_CREATE_ADMIN_SUCCESS | Admin200, refresh then event intent, exact event/joinUrl/meetingCode result |
| MEET_CALLBACK_VALID_CODE_PUBLIC | Anonymous200 with fixed code/state/scope and exact current message/data |
| MEET_CALLBACK_PROVIDER_ERROR_PUBLIC | Anonymous400 success:false with error/state and exact current message |
| MEET_CALLBACK_MISSING_CODE_PUBLIC | Anonymous400 success:false with state/scope and exact current message |
| MEET_CALLBACK_INVALID_QUERY_PUBLIC | Anonymous array code rejects400 VALIDATION_ERROR |

For every protected-route authority group use valid AND malformed inputs for
anonymous, invalid-signature, expired, ordinary user, HR, specialist and pharmacy
tokens. Credentials use existing actual JWT library/owned key; expected failures
are401 UNAUTHORIZED ('Authorization token is required'),401 INVALID_TOKEN
('Invalid token'),401 TOKEN_EXPIRED ('Token has expired'), and403 FORBIDDEN
('Admin access is required') for authenticated nonadmins, BEFORE validation or
provider. The current middleware authenticates a valid signature and requireAdmin
checks userType; it does not validate current account state or admin _id. This
fixture does not invent missing-principal denial or repair that separate policy.
Same-shaped valid inputs as the succeeding admin calls prevent false denial from
bad requests. Assert exact existing error envelope, zero DB reads/writes/JWT/
email/SMS/push/Google effects and exactly one actual recording error log. For
callbacks/controller400 use the actual success:false envelope and zero logs.
Validation denials retain actual validation message/envelope and one error log.

Admin URL specifies fixed state; parse actual returned URL and assert origin/path,
client_id, redirect_uri, response_type=code, calendar scope, access_type=offline,
prompt=consent, include_granted_scopes=true, state and no extra parameters. Admin
exchange supplies fixed code and explicit fixed redirect; refresh supplies an
explicit fixed refresh token. Meet request supplies patient/specialist@example.com,
dateYyyymmdd=20300115, startTime='10:00 AM', durationMinutes=30 and fixed summary.
Expected start/end strings are2030-01-15T10:00:00/10:30:00 with Asia/Kolkata,
description='Created from test OAuth endpoint', ordered two attendees and
hangoutsMeet solution. requestId must match actual meet-<milliseconds> form and a
captured before/after clock bound; do not freeze/replace Date or payload builders.
Assert exact response event and synthetic Google Meet URL/code mapping. All
fixture tokens/IDs stay in memory. No default-tomorrow timezone acceptance claimed.

Snapshot all13 actual collections around every selected request, excluding the
measurement snapshot's own reads from action counts. Require exact unchanged
state and zero per-collection action reads/writes. Admin successes also issue no
JWT, user/notification row, email/SMS/push or other provider intent; only the four
explicitly queued Google requests advance. Preserve existing identity lifecycle
and proof cleanup; no new setup database mutation is necessary for Meet.

## Four actual-source sensitivity variants

Append exactly these IDs after the existing17, yielding21. Emit each from pinned
actual Meet router TypeScript, record original/transformed hashes and exact change:

| ID | Mutation and required discrimination |
| --- | --- |
| MEET_AUTHENTICATION_REMOVED | Remove authenticate from all four protected registrations; the SAME anonymous authority predicate must fail for each actual route, proving the exact alternate response and zero unintended provider/DB effects |
| MEET_ADMIN_GUARD_REMOVED | Remove requireAdmin from all four; SAME ordinary-user valid-input403 predicate fails on each, with actual200 and exact queued URL/token/event behavior; assert no DB/JWT/other effects |
| MEET_GUARDS_AFTER_VALIDATION | Move both guards after validation on all four; SAME anonymous/nonadmin malformed-input401/403 predicates fail with exact400 VALIDATION_ERROR on every route |
| MEET_CALLBACK_GATED | Add authenticate and requireAdmin to callback before validator; SAME anonymous valid/missing/provider-error callback predicates fail with401 and zero Google/DB effects |

An arbitrary exception, setup failure or mismatched intended request is not a
detected variant. Use the same nominal check functions for nominal, mutation and
fresh nominal-restoration phases. Inspect concrete unsafe status/body/intents for
each promised operation. Close owned HTTP handles before each phase/cache reset;
clear only completed recording requests, no cleanup/import racing in-flight calls.
Reuse existing fresh TypeDI/router/config/model lifecycle and all source guards.
Every phase must restore the nominal predicate before recording detected:true.

## Retained stages and limits

Before implementation, freeze exact source/fixture input hashes and401/403/error
predicates, and obtain two independent contract decisions. Source-only/pure checks
must not import CONFIG/domain/driver or invoke providers/Docker. Root stages a
coherent candidate after both nonauthor source approvals, then uses a NEW clean
detached checkout and fresh two-reviewer exact-lock preparation receipt. No new
resolution/install/build is implied now. Genuine emitted AST/model/metadata audit
and every file/source/mutation/diagnostic hash precede artifact acceptance and a
separate exact one-run pair of decisions. Preserve semantic diagnostics honestly;
no clean typecheck or whole-server start claim.

Any actual run retains owned cached Node22.23.4/Mongoose9.12/Mongo8.0.34 profile2,
fixed64MB test index threshold, strict network/canary/import/collection/permission
guards, existing two captured-ID lifecycle/limits/grants and safe failure protocol.
No new connection, endpoint, image pull, container, provider, secret, filesystem
grant or automatic retry. Preserve every prior attempt/receipt/review. Any failure
stops pending independent review; two postreviews and fresh exact cleanup evidence
precede claiming bounded76/21 acceptance.

Even a passing run proves selected administrative HTTP boundaries and recording
intents only. Internal booking callers, real consent/token validity/invitation
delivery, OAuth state/session security, root install/type/build/compiled start/CI,
retained-server C2 facts, supported clients, broader clinical/money/recovery/owner
acceptance, original115 scenario outcomes, full M0/Week2, production/100RPS/release
remain open. Original six staged files and all eleven handover files stay exact.
