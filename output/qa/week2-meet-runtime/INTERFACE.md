# Frozen Meet writer interface

This resolves finite fixture representation choices under the twice-approved
contract106a7500; it grants no extra source/effect/execution scope. Root owns
ports-manifest.json. Producers/consumers must preserve all existing60/17 bodies,
13models/indexes, dependency/parent/grant/network constraints.

ports.recordingMeet is the exact literal object committed here. Validate the
complete key/value structure during admission, including environment/reply/
limits/counter meaning, rather than accepting caller-selected URLs/settings.
Set only its six synthetic environment variables after complete admission and
canary, before the configuration matrix/Meet imports. No Google service-account
variable or real account value. Retain them unchanged through config restores.

The shared phase-local recording fetch/context exposes:

- ctx.expectMeetRequests(expected): enqueue one finite array only when the
  preceding expected queue is fully consumed; never replace pending work.
- ctx.meetRequests: read-only getter of frozen normalized captures for the current
  phase, returned as a frozen copy, no live mutable array exposure.
- ctx.counters.calendar: increments once for each admitted recorded request.
  Unknown requests latch unexpected and throw; never reach native fetch.

Expected request descriptors have exactly one of these shapes:

- {kind:'code',code:string,redirectUri:string}; expected fixed headers and client
  credentials come from ports.recordingMeet.environment, grant=authorization_code.
- {kind:'refresh',refreshToken:string}; fixed credentials, grant=refresh_token.
- {kind:'event',payload:{summary,description,start,end,attendees}}; payload excludes
  conferenceData. Recorder checks all five actual generated fields exactly, exact
  expected event key set, nested conferenceData/createRequest/solutionKey key sets,
  hangoutsMeet and /^meet-[0-9]+$/ actual requestId. Do not supply fabricated time.

Admission/shape checks require plain data properties, finite strings/JSON,
no accessors/symbols/extra keys/holes, no duplicate form keys,<=8192 UTF-8 bytes
per expected descriptor/request/reply/record and<=256 current-phase records.
Invalid queue entries also latch unexpected and fail. All expected descriptors
are deep-cloned/frozen before use. Enforce queue order, actual method/URL/headers/
URLSearchParams versus JSON body types and exact finite form/body comparisons.
The recorder returns the literal oauthResponse for both code/refresh and the
literal eventResponse for event via bounded in-memory ok/text, never native
fetch. Request records have exactly {kind,method,url,headers,body}: headers is a
normalized exact plain object and body is the actual decoded exact form object
or actual parsed event object, recursively frozen. The consumer independently
compares captured request fields and exact returned HTTP reply; it checks real
requestId milliseconds against Date.now before AND after the awaited HTTP call.

expectMeetRequests([]) establishes/checks no pending expectation. Before each
phase transition and before final success, assert all expectations consumed;
never clear unfinished work. A new phase owns a fresh recorder installed before
any new CONFIG/Meet import. Save the original fetch once after the genuine canary;
never capture a previous recording stub as the original. The outer owned cleanup
restores that held function once even on failure, preserving the first error and
owned HTTP/ODM cleanup. No phase transition can race in-flight requests. Shared
pure tests cover actual helpers with fake native port that always throws if used.

Scenario writer appends16groups after the existing60 and four sensitivity rows
after17. Existing configuration helper prefix checks must be adjusted only where
necessary to allow the appended IDs, keeping its six/three exact evidence set.
Keep original signatures/bodies and baseline comparison proof; any necessary
placement/counter plumbing delta is enumerated, not hidden as untouched bytes.
Read nominal calendar from captured nominal counters, replacing the old constant0.
Negative phases assert separately and restore the same concrete predicate on
fresh nominal classes before detected:true. Authentication removal keeps
requireAdmin: expect401 UNAUTHORIZED message 'Authentication is required', versus
nominal 'Authorization token is required'. Source actor/role policy stays exact.

Compiler writer discovers actual Meet root through the same genuine closure and
emitted AST audit, preserving77old TS/63old reachable/13model declarations and all
prior17mutants, and adds four router mutations with exact old-source pins. The
conservative source closure may be88files; only actual emission establishes the
reachable model/package boundary. Stop on any additional actual model/package/
capability; no workaround or permission expansion. No compiler/app execution is
part of source implementation checks.
