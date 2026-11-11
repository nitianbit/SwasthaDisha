# Final specialist self-profile containment contract

11 November 2026. Root-owned final choice at baseline
`b33a9daac01628a48043e85764819a5f855431ed`.
FROZEN_FOR_TWO_INDEPENDENT_PREIMPLEMENTATION_REVIEWS. The complete unchanged
draft below is adopted with these final clarifications; its draft labels retain
author provenance, not current finality. No source implementation is approved
by this header alone.

Root chooses exactly ONE production file, SpecialistPortalService.updateProfile.
One writer owns that file and new output/qa/week2-specialist-profile-source/ QA;
Root owns this contract, inputs, integration and Git. Preserve all other writers.
Use existing AppError with status422, code FORBIDDEN_FIELD and exact safe message
'Specialist profile contains fields that cannot be updated'. On protected own
fields, await existing getById once before throwing; no extra allowed-path read.
Guard null/nonobject values by preserving old delegation. Do not introduce a
prevalidation guard, independent schema fork, new import or admin exception.

The existing inherited BaseRepository.findById performs one model.findById(id)
followed by lean, with no populate; entry and implementation are pinned in the
final freeze. Runtime read/effect assertions still require later complete C3.
HTTP error paths preserve existing safe error-handler logging; zero forbidden
provider/JWT effects means no delivery/payment/calendar/storage/queue action,
not removal of that existing bounded error log. Direct service checks add no
logger. Do not claim a doctor-client test or production compatibility proof.

Only source-data checks and truthful source sensitivity controls are permitted
after both implementation approvals. Do not import/extract/transpile/parse or
evaluate application TypeScript, Joi or the service even through fake deps on
the host. Its broader portal/booking/slot/execFile/filesystem import closure stays
unadmitted. Later actual HTTP behavior requires a distinct full-C3 contract.
Accepted83/27 at ea2a39c remains historical, and no source-only status promotes
original115, fullF04/F15, M0/Week2, rootC2, named owners or release acceptance.

---

# Specialist self-profile: three protected fields (draft)

Status: DRAFT FOR LEAD CHOICE AND TWO INDEPENDENT PREIMPLEMENTATION REVIEWS.
Baseline b33a9daac01628a48043e85764819a5f855431ed; no source edits or execution.
Accepted execution8 remains 83/27 PASS, consumed; this draft adds no runtime admission.
Other writers share the repository. Preserve original six staged files, eleven
handover files, all prior evidence and unrelated source; no Git writes or push.

## Existing authority, read completely

- `documentation/planning/M0_IMPLEMENTATION_APPROVAL.md:43`: “No self-verification/activity privilege/rating/counter change”.
  Lines36–49 qualify concrete slice contracts and authorization before field422.
- `documentation/planning/PRINCIPAL_REVIEW_DISPOSITION.md:18`: “Self-verification/rating is not ordinary doctor profile or tariff authority.”
  Line59, Review-B:PA-18, explicitly identifies the shared schema and requires
  separating self-profile authority from admin verification/ratings; a private
  fee offer is not inherently forbidden. Line61 preserves401/403/404 versus422.
  Its complete35-finding disposition and linked CSV PA-18 mappings were read.
- `documentation/planning/SYSTEM_DESIGN.md:445` forbids generic verified/active
  privilege flags and ratings; `qa/TEST_SCENARIOS.md:215,233` require unchanged
  verification/rating, zero forbidden effects and valid descriptive self edits.
These are existing approved containment rules, not a new clinical/tariff decision.

## Actual path and current precedence

Central `src1/routes/index.ts:64` mounts `/api/v1/specialists` with authenticate.
`specialists/routes/index.ts:72–78` PUT `/me/profile` requiresSpecialist, validates
body, then invokes `SpecialistController.updateMyProfile`179–193. Existing selected
identity is `req.user.specialistId || req.user._id` (controller22–24); do not change
claim issuance, role rules, principal policy or introduce caller-selected IDs.
`specialistPortal/validation/index.ts:42` aliases the admin updateSpecialistSchema.
Its recognized keys include rating (number0..5 optional), isActive and isVerified
(optional booleans), with no defaults, strip, rename or custom rule on those keys.
Common validation13–36 uses `{abortEarly:false,stripUnknown:true}`, throws
400 VALIDATION_ERROR on invalid input, otherwise replaces req.body with value.
Thus valid recognized values/conversions retain own field presence, including
false and0; JSON cannot transport undefined. Invalid/null/out-of-range values
currently fail400 before any object lookup. Unknown fields are still stripped.
Pinned public Joi17.13.3 source (data-only inspection) confirms keys.js95–127
removes declared keys from unprocessed, retains defined converted values;
stripUnknown977–985 removes only remaining unknowns. boolean.js42–66 preserves
false conversion; number.js38–50 yields numeric0. common.js26 defaults convert
true and validator.js330–342 applies it. No valid declared key is made undefined
by these pinned three schemas. This is source reasoning, not executed Joi proof.
PortalService.updateProfile79–84 merely delegates. SpecialistService.update275–338
first finds the selected object, emits404 SPECIALIST_NOT_FOUND if absent, checks
changed email/phone uniqueness, applies existing free-fee behavior, then updates.
There is NO prevalidation existence lookup. SpecialistService.getById93–105 has
one repository lookup and the same404. Actual source confirms one portal-update
caller (the self controller), and two SpecialistService.update callers (portal
and admin controller116); missing arrow-method graph edges are not absence proof.

## Smallest proposed source change

Own production file ONLY `src1/modules/specialistPortal/services/index.ts`, plus
owned QA. Do not change router/controller/Joi/shared admin service/schema/types.
Inside updateProfile, before delegation, test `Object.prototype.hasOwnProperty`
for exact top-level `isVerified`, `isActive`, `rating`; never test truthiness or
compare requested value to current value. On null/nonobject input,
preserve existing delegation instead of adding unrelated validation/errors.
If any protected own field exists, await `this.specialistService.getById(id)`;
if it returns, throw422 AppError code FORBIDDEN_FIELD, fixed message
“Specialist profile contains fields that cannot be updated”. Do not return the
fetched row, mutate body/state, call update, or perform uniqueness/provider work.
Otherwise preserve the current delegate call verbatim; no extra successful read.
The guard also covers direct self-service calls with an own undefined value.
No admin exception inside the self command: existing requireSpecialist already
excludes admin; the separate admin PUT/:id path keeps its exact current behavior.
This is a three-key self-command field boundary; it does not close all F04/F15.

## Frozen error, state and compatibility boundaries

- Anonymous/invalid/expired JWT keeps current401 before validation/DB; signed
  forbidden role keeps403 before validation/DB. Preserve selected-identity logic.
- Malformed body or invalid protected value keeps400 VALIDATION_ERROR before DB,
  including missing-object trials. This intentional preservation is not a new
  promise that every raw forbidden property is422 before ordinary validation.
- Schema-valid protected field(s), alone or mixed with valid descriptive fields:
  selected object absent → existing404; present →422, even false/0/unchanged values.
  Exactly one object read, zero update/uniqueness/provider/JWT effects on this path.
- No protected fields: existing200 envelope/message/result, missing-object404,
  uniqueness errors and all current conversion/stripping/update behavior remain.
  Preserve permitted descriptive edits and existing tariff/contact/document and
  availability behavior byte-for-byte; no new approval of their broader safety.
Nested document.status, contact-change recovery, tariffs, clinician eligibility,
statistics, clinical authorship/retention and privileged admin commands remain
separate work. No new nested alias/unknown-field rule or global permission policy.

## Evidence, clients and next gates

Graph-first discovery used project swasthadisha; its correct canonical path is
indexed at stale bfb608ea, so current worktree bytes/pins govern. Actual text
corroborated the route/service chain and callers. No app/TS/helper was evaluated.
Observed mobile checkout db62e8a has only specialist discovery GETs in
`src/features/specialists/specialistApi.ts`; its auth profile writer targets users,
not this endpoint. Target files are clean/pinned. No doctor-dashboard client is
identified in this repository (REPOSITORY_REVIEW.md:26,41). The backend legacy
portal test uses singular `/specialist`, so it is not supported-client evidence.
Absence of a current doctor client is release compatibility uncertainty, not
invented success proof or an automatic permission stop for approved containment.
First retain inspected source-data baseline rejection, exact one-file candidate,
unchanged pins/modes/callers, and controls removing each key, truthiness false/0,
lookup/404 ordering, premature mutation/delegation and unintended admin edits.
These are source transformation checks only; no extracted/app TypeScript execution.
Future separately reviewed C3 HTTP evidence must prove allowed descriptive success,
all three own fields and combinations/conversions deny, malformed400/absent404,
role401/403 precedence, unchanged admin path, exact DB/provider/JWT effects and
same-predicate actual-source regression variants with fresh nominal restoration.
Portal imports BookingService/slots plus child_process.execFile/fs/os: this closure
is NOT admitted by the existing13-model fixture. No root start/import, package,
compiler, DB/Docker/provider/auth action is granted; no83/27 or115-case promotion.
Lead selected this one-file guard and preservation of malformed400; the fixed
422 code/message remains a concrete draft for final freeze. Two direct independent
contract reviews must approve the frozen contract before any source edits.
