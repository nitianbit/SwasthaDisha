# HR booking read scope — draft source contract

**DRAFT ONLY. Root must choose/freeze the interface and obtain two nonauthor preimplementation reviews. This document authorizes no source change or runtime invocation.** Baseline supplied by Root: `17957201d54418f2dcae182626c642e9a0bdee60`, branch `m0/week2-hr-booking-scope-contract`. Exact inputs, actors, rows, 103 proposed HTTP trials and eight proposed actual-source sensitivity transforms are in [draft-inputs.json](draft-inputs.json). No application/runtime result is claimed.

## Problem and approved boundary

`BookingController.getAll:230` falls back from optional HR corporate to query corporate. `getByUserId:318` and `getUpcomingBookings:336` accept an absent HR corporate. Even bound HR can escape scope: `forUser=true` replaces the corporate predicate; ordinary `BookingService.getAll:1374` dispatches four selector shortcuts that discard that predicate. The three actual `bookingService.getAll` call sites are controller lines269/323/342. The fourth `getHRCorporateId` caller is `ensureHRCanAccessBooking`; leave that shared helper and all object/create/write paths unchanged.

Policy: [PA-19](../../../documentation/planning/PRINCIPAL_REVIEW_DISPOSITION.md), line60, requires server corporate authority with no request fallback to HR visibility; [M0 authority](../../../documentation/planning/M0_IMPLEMENTATION_APPROVAL.md), lines27/41/49, admits bounded current-path containment and established401/403 semantics. [The accepted users contract](../../../documentation/planning/implementation/USER_ROUTE_AUTHORITY_CONTRACT.md), lines35–49, already denies unbound HR and `forUser=true`. [TC-REV-002](../../../documentation/planning/qa/TEST_SCENARIOS.md), line214, covers corporate injection. This narrower read fix does not close that scenario or create corporate/clinical/finance policy.

Graph project `swasthadisha` points to the correct original repository but is stale at `bfb608ea`; exact current source governs. Graph traces plus literal reads establish all callers. No Git command was run to independently verify the Root-provided commit.

## Proposed two-file amendment; Root final choice pending

Only `src1/modules/bookings/controller/index.ts` and `src1/modules/bookings/services/index.ts` may change, plus explicitly owned QA. Preserve schemas, routes, repository, types, generated output and clients. The smallest preferred interface is:

```text
controller: private resolveHRBookingReadScope(req: AuthRequest): string | undefined
service:    getAll(queryParams: BookingQueryParams = {}, requiredCorporateId?: string)
```

The dedicated resolver runs as the first operation of only the three read handlers. For non-HR it returns undefined immediately and leaves the original call/body path unchanged. For exact HR, require a primitive 24-hex-character corporate string, without trimming, case normalization or coercion. Absent/null/empty/malformed claims fail403 `HR_CORPORATE_REQUIRED`, message `HR account must be linked to a corporate`, before booking access. This is a proposed strict representation check, not proof of current membership. Login copies optional HR corporate from its stored record; malformed signed-claim trials are verifier-boundary canaries, not claims that ordinary login issues those values.

For HR, query corporate must be absent or strictly equal to that valid string. Query `forUser` may be absent, false or `'false'`; true, `'true'` and other present values fail403 `FORBIDDEN`, message `HR can only access bookings from their own corporate`. Preserve these messages without IDs/values. `AuthRequest` declares optional string corporate, but JWT verification performs no runtime claim-shape validation. The guard must check actual values, never trust that declaration/cast.

Existing LIST/UPCOMING query Joi declares `forUser` as `Joi.string().valid('true','false')`, and middleware replaces the query with returned `value`; the source specifies no boolean coercion rule. Handle boolean true as well as string true defensively. Those routes retain Joi400 before the resolver. USER has only parameter Joi, so malformed authority query selectors there receive the proposed403. Unknown unrelated USER query fields retain their existing unused behavior. Do not install a new query schema.

Only exact HR handlers pass the validated scalar. Never derive trusted service scope from a query corporate/forUser field. The service takes a separate scoped branch using `requiredCorporateId !== undefined`, fresh query objects and mandatory corporate predicates before actual database reads. No post-read-only filtering, new membership lookup or input mutation.

## Preserve selector behavior while intersecting corporate

Root prefers preserving existing ordinary selector priority and semantics. In the trusted scoped branch, call real `findAll` exactly once using the same selected filter and sort, plus corporate:

| Ordinary selector priority | Retained filter besides corporate | Retained sort |
| --- | --- | --- |
| `userId` | userId; other filters still ignored | bookingDate−1, createdAt−1 |
| else `dependentId` | dependentId; other filters still ignored | bookingDate−1, createdAt−1 |
| else `wellnessPackageId` | wellnessPackageId, literal bookingType=package | bookingDate−1 |
| else `specialistId` | specialistId, literal bookingType=consultation | bookingDate−1 |
| else general | existing general getAll filter, with corporate forced and forUser unable to replace it | existing requested/default general sort |

Skip the four unscoped repository shortcut calls only on this trusted path. Keep the original non-HR method body/call behavior exact. Scope must also survive an empty result and all combinations of lower-priority selectors.

Paginated reads retain one real `findWithPagination` delegation with a fresh query copy forcing corporate and `forUser:false`; the existing find+count pair is the entire read budget. Preserve its current combined-selector behavior, lack of implicit consultation/package filters, date predicates and existing omission of pharmacyId. No repository repair is included.

The alternative of applying every general filter/sort to ordinary HR shortcuts would change selector precedence, implicit booking types and sort behavior. It is **not selected**. Root may choose that alternative only through an explicit amended contract/data/review before authoring. No new clinical sharing policy is inferred.

HR upcoming retains the current pending/confirmed post-filter and `bookingDateFrom` argument. Ordinary getAll currently ignores date bounds, so an old pending row deliberately remains in its expected results. This source slice does not fix upcoming dates. Authorized lists with no matching corporate records remain200 with empty data, including total0 for pagination; no new404 or existence lookup.

## Finite draft evidence

The JSON freezes 103 proposed nominal HTTP trials in six groups: 36 malformed/absent principal denials; 15 selector denials/route-validation differences; 12 authentication/validation precedence cases; 24 scoped-list cases; 8 USER/UPCOMING cases; 8 non-HR compatibility cases. Ten synthetic read-set rows distinguish own/other/no corporate, four shortcut families, explicit/implicit booking type, pagination, priority, sorting and current date/filter limitations. Row descriptors are not a model seed/runtime admission.

Every request must preserve all owned state, with zero booking/other-model writes and zero provider/queue/file/timer effects. Denials have zero booking reads; ordinary success uses one real read; pagination uses the existing find+count pair. Existing `errorHandler` logs exactly once per HTTP error; no additional logger/provider port is introduced. Assert full response envelope, row IDs/order, scope, pagination, read/effect counts and unchanged snapshots. A200 alone is insufficient. Exact Joi message expectations and complete model constructors require a later admitted fixture freeze.

Eight proposed actual-source variants have 18 finite references: remove corporate denial, remove forUser denial, remove conflicting-corporate denial, disconnect USER scope, remove both UPCOMING scope sinks, delete ordinary corporate predicate, delete paginated corporate predicate, and restore unscoped ordinary shortcuts. Removing only UPCOMING's extra service argument is behaviorally redundant and does not count. Each eventual variant must run actual fresh amended source with the same nominal predicate failing fixed `HR_BOOKING_SCOPE_RESULT_MISMATCH`, independently prove its predicted unsafe outcome, then run fresh nominal same-trial and complete allowed-counterpart restoration. Freeze exact source anchors/hashes after actual source exists; none is executable/approved now. No fake comparator, extracted domain implementation or precomputed pass counts.

Source verification must reject the baseline, bind exact two-file transformation and unchanged bytes/modes, validate all three scope sinks and four shortcut families, and reject privilege/format/boolean/pagination regressions. Scope checking must survive commits: exact non-QA production union plus explicit owned QA directories, not assumptions that draft files remain untracked. Two nonauthor source implementation reviews precede integration. Runtime requires separate pre-import closure, fixture, emission/artifact review, exact one-run approval, measured result/cleanup and postreviews.

## Profile pin conflict and remaining gates

**Do not integrate this future source amendment into the active profile candidate yet.** The current specialist fixture binds excluded `BookingService` SHA `f239aa5a35b56c96b483a7ed009ef0e2a9e8b5ec2cd43d796fc72c6d853c6508` through inputs/source binding. First accept the actual specialist 90 milestone; Root then explicitly freezes/reviews its source-pin, artifact and admission refresh. This draft changes no current profile input, section hash, source binding or artifact. It adds no runtime root/model/package/child permission or filesystem/network grant.

Current admin-panel source permits HR `/bookings`; its service uses paginated list, unpaginated export, USER and UPCOMING URLs with optional corporate selection. Pinned client source supports these request shapes, not a deployed-build or client-runtime acceptance claim. Unbound HR and forbidden selectors intentionally change to explicit errors; valid scoped envelopes remain.

Current membership/revocation and 30-day token snapshots remain unresolved; no membership DB lookup or HR _id redesign is included. Create-body corporate injection, external bookings, wider actor/object reads, clinical visibility, benefit/payment/contact/recovery decisions, root build/start/C2/deployment and full TC-REV-002/Week2/M0/release acceptance remain outside scope. Preserve the original six staged changes and eleven handover files; Root owns Git. No source, runtime, package, model, auth or external operation was performed.
