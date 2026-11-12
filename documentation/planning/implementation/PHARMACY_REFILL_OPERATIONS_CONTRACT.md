# Pharmacy refill operations: due-candidate worklist and pause clearing

13 November 2026. Author: internal Codex `/root/milestone_composition_r9`. DRAFT FOR TWO NONAUTHOR REVIEWS. Baseline `52052e25cdba4e6a658d176471d4e66164a53bbd`, isolated branch `m0/pharmacy-refill-operations`. This document admits no source implementation or executable command. Root owns integration; its author cannot approve this contract.

## Useful result and existing design

Deliver a bounded private list of the signed operational pharmacy's recorded refill candidates through an explicit calendar date, and make the existing resume operation actually remove its stored pause date. Reuse the subscription records, operational-pharmacy guard and existing update command. This advances delivery-board P7 and CAPABILITY_MATRIX A10/G08/SRC07 / ROADMAP S09 without implementing the later reminder dispatcher.

Current subscription routes expose create/list/update/pause/delete. The list accepts unchecked pagination, uses a generic populated projection, and has no due cutoff. `nextRefillDate`, interval, active flag, pause date and reminder preferences already exist. The update service explicitly tries to clear `pausedUntil` when `isActive === true`, but assigns `undefined`; pinned Mongoose6.13.8 removes that update entry rather than unsetting the stored field. The exact public-cache source evidence is recorded in this packet's SOURCE_BINDINGS.json. This is a source observation, not a native runtime result.

The new list is operator candidate metadata. It does not supply a recipient list, patient/caregiver identity, consent, prescription validity, current stock, clinical eligibility, cash/payment proof, send authority or permission to dispense. No notification, automatic resume, order, stock, payment, queue/job, provider or clock-dependent schedule effect occurs. Existing corporate/HR/hospital expansion and final cross-module integration remain deferred. Staff provisioning, supported-client and release acceptance remain separate.

## Exact ownership and reuse

Only these six existing module files plus API_SCHEMAS.md may change after two implementation-only decisions:

| Existing file under src1/modules/pharmacySubscriptions/ | Bounded responsibility |
| --- | --- |
| routes/index.ts | GET `/due`, private cache header, existing operational guard, existing catchAsync. Existing registrations stay unchanged. |
| controller/index.ts | One due handler forwarding only guard-resolved pharmacyId and original query to the service; serialize the fixed response. |
| services/index.ts | One getDueRefills operation using the shared parser and repository; the narrow resume payload correction below. |
| repository/index.ts | One purpose-specific, mandatory-owner bounded read; no optional-scope BaseRepository call or caller pipeline/filter. |
| validation/index.ts | One authoritative descriptor-safe due-query/cursor/calendar parser reused by the service. Existing Joi schemas stay byte-preserved. |
| types/index.ts | Closed query/cursor/row/page types and one immutable reminder-channel tuple shared by parser/row validation. |

Keep one calendar/cursor/query implementation, one repository query and one DTO mapping. No new production module/framework/library, constructor change, generic repository/control plane, model/index/central-mount/auth/dependency/start edit, copied existing controller or unrelated list/write cleanup. API_SCHEMAS documents only the new endpoint and precise resume behavior; existing public request/response shapes stay otherwise unchanged.

## Route, authority and response

Route: GET `/api/v1/pharmacy-subscriptions/due`. The existing central mount authenticates before this router. Add the route before existing parameter registrations. A route-local fixed header middleware sets `Cache-Control: private, no-store` before `requireOperationalPharmacy`, including its errors; the controller repeats that header for direct calls. Reuse the guard unchanged and run it before query parsing. No admin bypass or new individual staff qualification is inferred from this existing business-account read.

The controller uses only `req.user.pharmacyId` established by the guard, never query/body, actor `_id`, organization/corporate/branch or a caller filter. The service requires a primitive lowercase24-hex pharmacyId; missing, blank, nonstring or malformed scope returns403 `FORBIDDEN` / `Access denied` before parsing/query allocation. Existing middleware401, wrong-role403 and operational-business denials preserve their exact precedence and envelopes. Direct service input is not a separate authorization grant; its scoped primitive is an internal parameter.

Successful200 body is exactly:

```text
{ success: true, data: {
  through: "YYYYMMDD", limit: number,
  items: [{ subscriptionId, nextRefillDate, intervalDays,
            reminderChannel, pausedUntil, pauseEvaluation: "not_evaluated" }],
  nextCursor: string | null
} }
```

`subscriptionId` is lowercase24-hex. Dates are canonical calendar strings below. `intervalDays` is a positive safe integer. `reminderChannel` is exactly sms/push/both/none or null for exact field absence; null never silently becomes push. `pausedUntil` is a valid canonical date or null for exact absence. A present null/undefined/malformed optional field is not absence and fails closed. The list uses the stored active flag; it does not evaluate `pausedUntil` against today or auto-resume a paused record. An active legacy row carrying a valid pause date retains that date and the explicit not_evaluated label for operator review. An inactive row is excluded even if its pause date looks past due.

No user/customer/patient/dependent ID, name, phone/email, medicine ID/name/frequency, free text, source-order/creator IDs, error notes, raw document, internal update shape or populated object appears in this DTO. Subscription IDs refer to the owning pharmacy's existing operations; this endpoint adds no patient lookup or access relationship. No total/count of other records is returned. Unknown response fields are prohibited.

## Closed query, dates and cursor

Only `through`, `limit`, `after` query keys are admitted. `through` is REQUIRED. `limit` defaults20, or is a primitive canonical decimal string1..50 with no sign, spaces, leading zero, fraction, exponent or coercion. `after` is optional and otherwise a canonical bounded cursor. `page`, `pharmacyId`, actor/owner/filter/operator/field-selection inputs and every other key return400 `VALIDATION_ERROR` / `Invalid refill worklist query`. Arrays, nested objects, null, getters, proxies, symbols, nonenumerable properties, inherited custom-prototype records or repeated-key arrays fail the same safe error. Optional own undefined is permitted only as direct-call absence for limit/after; through must be a defined string. Validate raw query before any stripUnknown; do not change the shared validator. The service uses this same parser before repository dispatch, so direct calls cannot bypass it.

Every date is exactly eight ASCII digits, Gregorian year0001..9999, month01..12, valid day for that month/leap year; year0000 is invalid. Validate by exact components/UTC round-trip preserving years below100 (not Date.UTC's1900 offset). It is a calendar label, not a UTC instant, timezone conversion or days-supply inference. Never use the host local timezone, current date, an assumed Asia/Kolkata default or the existing rolling local-date helper to classify rows. `through` is a caller-selected operator cutoff; accepting a far future date grants no effects and cannot remove row bounds.

Sort ascending by `(nextRefillDate, _id)`. Use keyset continuation only, not skip or an offset. Cursor is unkeyed canonical base64url of a JSON object with this exact fixed key order/shape:

```text
{ v: 1, pharmacyId, through, limit, nextRefillDate, subscriptionId }
```

All fields bind to the current signed pharmacy, requested cutoff and parsed limit. The last tuple is the last RETURNED row, never the lookahead row. Cursor date must be valid and <=through; ID must be primitive lowercase24-hex. Encoded cursor maximum384ASCII bytes; decoded maximum288UTF8 bytes. Require base64url alphabet without padding, exact canonical re-encoding, exact six keys/types/order through canonical serialization, and no duplicate/extra JSON keys. Any malformed, noncanonical, wrong-owner/cutoff/limit cursor returns the same400 before a DB call. Cursor tampering can at most choose a later tuple in this same authorized slice; it does not authenticate authority. No signing secret/library is added. For a nondefault limit the continuation request must retain that limit. A caller may restart without a cursor.

The result is a bounded read of mutable records, not snapshot pagination or a total capacity claim. Concurrent date edits can move a record between pages. Stable tie-breaking prevents ambiguity for an unchanged tuple; no exactly-once traversal guarantee is asserted across concurrent writes.

## Mandatory-owner persistence and stored-data checks

One new repository read receives parsed immutable scope/query primitives; no public FilterQuery, select/populate/pipeline, sort or update argument. Build the filter internally with exact scalar ObjectId `pharmacyId`, exact boolean `isActive: true`, string `nextRefillDate <= through`, and after-cursor lexicographic tuple when supplied. Use actual Types.ObjectId construction only after string validation. Stored scalar `$expr` guards require `_id`/pharmacyId objectId, isActive bool and nextRefillDate string, preventing array-element equality from supplying ownership or a due tuple. A missing date is unscheduled and excluded; inactive/malformed authority/type records cannot become candidates. This is not a whole-collection data-cleanliness scan or coverage certificate.

Query is `.find` with fixed inclusion projection `_id,pharmacyId,isActive,nextRefillDate,intervalDays,reminderChannel,pausedUntil`, explicit `.collation({locale:'simple'})`, ascending date/id sort, `.limit(limit+1)`, `.maxTimeMS(2000)`, lean/exec. No populate, join, count, aggregate, skip, background fetch, provider or writes. Fetch at most51 rows. Validate and map EVERY fetched row, including lookahead, before returning any page/cursor. Trim to limit; only if the extra row exists return nextCursor, otherwise null. Empty returns items[]/null.

Returned raw row must be an owned plain data record, with only the seven projected names (optional channel/pause may be absent), no getters/proxy/symbols/nonenumerable extension. Require native Types.ObjectId scalar id/owner with canonical round-trip and exact owner; isActive === true; canonical date <=through and after tuple if applicable; positive safe integer interval; valid optional channel/pause as specified. Enforce strictly increasing date/id tuples and no duplicates; returned lookahead must also satisfy all invariants. Invalid projected state, unexpected raw fields/prototype, inconsistent count/order, DB/read/timeout failure maps to503 `REFILL_WORKLIST_UNAVAILABLE` / `Refill worklist is unavailable`, without raw exception/query/contact data in response/logger. Do not return a partial page, coerce bad state or silently filter a fetched malformed row. Driver-side excluded authority/type rows are not certified as valid or repaired. Use only the closed DTO, never the existing broad populated list sanitizer or raw query result.

The current model declares `{pharmacyId,userId}`, `{pharmacyId,isActive}`, `{nextRefillDate,isActive}`, and `{sourceOrderId,medicineId}` indexes; schema declarations do not establish installation. No exact owner+active+date+ID supporting index is declared, and no measured explain/load/capacity evidence exists. This contract authorizes no DDL/index migration/hint/production performance claim. maxTimeMS/row bounds are guards, not proof of efficient scanning or cancellation. Owned-fixture actual catalog/query/explain and owner-controlled deployment index/capacity review remain before activation at representative volume; a missing/inadequate index cannot be silently described as installed. A later create-only manifest change needs its own named contract/reviews. No root100RPS gate is closed by this read.

## Narrow resume correction

Retain the existing PUT `/:id`, request schema, operational guard, initial lookup and existing404 `SUBSCRIPTION_NOT_FOUND` versus403 foreign-owner behavior. Preserve update/pause/delete/create/reconciliation order, error envelopes and existing non-resume mutations; do not add a new resume route or change automatic pause-expiry policy. No source change is permitted to order linkage or generic BaseRepository.

Only when the existing direct/HTTP update has `isActive === true`, construct an explicit `$set` of its already admitted update fields excluding pausedUntil, plus `$unset: {pausedUntil: ''}` in the SAME existing repository update. Clear even a future/invalid old pause value; an explicit resume request is the existing authoritative intent to clear it. A direct caller's simultaneous pausedUntil value cannot override resume (the old code deliberately replaced it with undefined). No duplicate set/unset of the same path, caller Mongo operator or replacement document. Returned ordinary public subscription response retains its existing shape except cleared pausedUntil is absent. Resuming again is safe and remains active with pause absent. For isActive false/absent and ordinary interval/date/channel updates, preserve the current data forwarding/authorization semantics. Dedicated pause continues setting false and its admitted optional pause date. Do not silently set nextRefillDate, send a reminder or treat resume as receipt/clinical approval.

This is the explicit unset repair only. Existing subscription writer hardening, relationship/provisioning and broad list behavior are separate work; this source approval does not certify every subscription operation. No owner-controlled deployment/status fact is assumed.

## Focused acceptance and source sensitivity

After independent source review, prepare the smallest separately frozen existing fixture extension for actual service/router/repository/Mongoose behavior; no new framework or executable authority follows now. Required focused assertions:

- Existing operational guard: missing token401; user/admin/HR/specialist403; unverified/inactive pharmacy denied before query parse/dispatch; own positive and foreign owner/cursor denied without writes/provider attempts. Direct invalid scope fails before a query.
- Closed raw HTTP/direct queries: missing/invalid cutoff, invalid leap/day/year0000, overflow/coercion/extra scope/filter/array/duplicate keys, bounds1/20/50 and51/0, invalid cursor alphabet/size/noncanonical JSON/duplicates/crossowner/cutoff/limit. Getter/proxy/nonenumerable cases are direct-only and do not execute getters. Invalid commands produce zero repository dispatch.
- Real own/foreign/inactive/undated/tied-date records: exact date cutoff inclusion, two pages with stable ID ties, last RETURNED tuple cursor, lookahead, no count/populate, empty and last page. No patient/medicine/contact/creator/source-order data in responses, logs or evidence. Assert no-store on success and guarded400/403/503 errors.
- Actual projected raw malformed interval/date/optional channel/pause, array owner/date/active, unknown/getter data ports and inconsistent order: appropriate safe exclusion or503, never partial/foreign results. Bound row count and actual2000ms options; separately record actual installed indexes/query/capacity limits without claiming a load result.
- Resume a persisted paused subscription through actual HTTP and actual Mongoose: active true and pausedUntil really ABSENT in stored BSON and returned row, repeat resume, future pause, simultaneous direct pausedUntil, ordinary update preserving pause, dedicated pause behavior, foreign/missing ID precedence, no changes to date/channel/other subscriptions. Raw spies alone do not prove undefined-versus-unset persistence.
- Source controls must expose intended effects against the SAME assertions: remove owner/scalar fence; remove row bound; remove raw closed-query check; leak a populated patient field; restore undefined resume assignment. If redundant fences prevent the expected defect, freeze the minimal coordinated mutation and inverse under its exact source contract first. A hash mismatch/arbitrary crash is not detection. Record unexecuted checks NOT_RUN, never fabricate count/PASS evidence.

No application import, compiler, Node/npm/model/Docker/DB/HTTP/provider operation, root dependency/runtime/build/start change, live log/deployment, push or release is admitted. C2 existing-server facts, full pre-import C3, exact source+stage/run decisions, independent actual outcome/cleanup review, staff/client/privacy/owner/release gates remain. Genuine local Claude review of a later exact candidate is separate. Preserve other workers, original stagedsix/full-index patch and handover archive; Codebase Memory remains owner-disabled.

## Frozen input binding

All selected current inputs, exact baseline, Mongoose public-source provenance and untouched-original preservation are in `output/qa/pharmacy-refill-operations/CONTRACT_INPUTS.json`. Its maps are source-data bindings, not an executable import closure, installed-index observation, runtime success or implementation approval. Two actual independent nonauthor decisions on this document's exact SHA precede any production edit. Root assigns the source author only after that gate.
