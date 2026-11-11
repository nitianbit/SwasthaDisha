# Specialist self-profile: proposed C3 HTTP extension

11 November 2026. **DRAFT FOR ROOT FINAL CHOICE AND TWO PREIMPLEMENTATION
REVIEWS; NO IMPLEMENTATION OR EXECUTION AUTHORITY.** Author
`/root/index_matrix_fragment`, coherent baseline13f2d5e supplied by Root.
Own only this file and `draft-inputs.json`; Root owns final interfaces and Git.
Others share the repository. Preserve their edits, original six staged changes,
eleven handover files, consumed approvals and every previous result/failure.

The source631a2bc6 guard has two actual independent source approvals. The corrected
compiler-library checkpoint at descriptor5d784043 has two preparation-only
acceptances. It did not import PortalService. Actual accepted API evidence remains
83/27 at ea2a39c; all90/33 counts below are proposed, not measured acceptance.

## Scope, finite cases and effect boundary

Append the actual specialists router as root11, preserving the old ten-root
prefix. Mount `/api/v1/specialists` with existing authenticate, retaining the
router's specialist/admin guards and Joi schemas. Exercise actual HTTP,
controller, PortalService, SpecialistService, SpecialistRepository and existing
SpecialistModel. No replacement of those business implementations, extracted
guard, copied validator or direct-service undefined test. JSON cannot transport
own undefined; its direct-service protection remains source-only evidence.

`draft-inputs.json` contains every concrete trial ID, actor/claim constructor,
body, path, expected status/code/message, all13 collection read/write deltas,
provider/JWT effects, state rule and six literal source transformations.

| Appended group | HTTP requests | Required outcome |
| --- | ---: | --- |
| SPECIALIST_PROFILE_DESCRIPTIVE_SUCCESS | 2 | Trimmed name/bio update through both incoming identity forms; exactly one target read/update |
| SPECIALIST_PROFILE_PROTECTED_DENIALS | 14 | All7 nonempty protected-key subsets, alone/mixed; existing target422 after one read |
| SPECIALIST_PROFILE_FALSE_ZERO_CONVERSIONS | 24 | Boolean false/"false", rating0/"0", combinations and unchanged values still422 |
| SPECIALIST_PROFILE_VALIDATION_PRECEDENCE | 22 | Eleven invalid object bodies, each existing/absent target; Joi400 before DB |
| SPECIALIST_PROFILE_NOT_FOUND_PRECEDENCE | 8 | Seven valid protected subsets and descriptive payload retain404 after one lookup |
| SPECIALIST_PROFILE_AUTHORITY | 18 | Nine actors × valid/malformed body retain401/403 before validation/DB |
| SPECIALIST_PROFILE_ADMIN_PATH_COMPAT | 5 | Three protected fields/all3 through existing admin PUT succeed; absent target404 |

Exact totals:93 nominal requests,6 successes/87 errors,7 new groups; six source
variants with11 fixed references. Prior83/27 becomes proposed90/33. Each actual
HTTP error retains exactly one existing error-handler logger call. Expected
nominal recording counters are email5/SMS1/push2/calendar4/logger437; other five
public counters remain0. Read actual counters and reconcile350+87; never emit a
precomputed summary or new provider key. Private class/execFile/fs attempts are
separately counted and must all stay0, including the rerun old83 cases.

Every case snapshots all13 manifested collections and action read/write counters.
Control reads, fresh synthetic row creation, exact reset and cleanup occur
outside its HTTP measurement window. Denials preserve all rows and fields;
successes change only the selected tracked specialist's declared fields and
actual generated updatedAt within request clock bounds. No extra uniqueness
query is allowed on protected-field denial, including mixed changed email/phone.
All other provider/JWT effects stay0. Setup/cleanup must never mask an assertion.

## Identity, validation and exact precedence

Fixture A/B/absent IDs are distinct and newly owned; absent is never inserted.
Initial profiles have isVerified:true, isActive:true, rating3.5. Protected subset
values false/false/4.25 differ from those stored values. Ordinary allowed success
changes only recognized name/bio; mixed protected payloads may also contain valid
recognized email/ten-digit phone to prove no contact uniqueness work occurs.

Actual authenticate verifies and retains the signed claims. requireSpecialist
then sets specialistId = specialistId || _id. Thus incoming {_id:B,specialistId:A}
selects A, and {_id:B} selects B after middleware normalization. These are two
incoming-claim selection tests, not two independent controller branches or proof
of auth-issuer/doctor-client compatibility. Both selected identities are bound
to the current private fixture; no caller-supplied target selector is added.

Missing bearer is401 UNAUTHORIZED, "Authorization token is required"; a foreign
signature is401 INVALID_TOKEN, "Invalid token"; expired is401 TOKEN_EXPIRED,
"Token has expired". User/admin/HR/pharmacy/unknown signed roles and specialist
without either ID are403 FORBIDDEN, "Specialist access is required". These are
the current source branches; there is no invented earlier userType enum policy.
Each authority trial runs valid and Joi-invalid bodies and proves zero DB access.

All three protected keys are recognized by the existing shared schema; name,
bio, email and phone are also recognized. Boolean false/"false" is distinct from
numeric boolean0, which remains400. Rating0/"0" is valid and must be422. The11
invalid bodies include numeric0 for both boolean fields, three null values,
rating bounds/type, empty name, empty object and valid rating mixed with invalid
name. Expected messages are literal public Joi/source expectations frozen in
JSON; differing actual behavior must stop for review, never adjust expectations
to make a run pass. Existing malformed400/absent404 precede the intended422.

## Complete import admission and explicit exclusions

Keep13 real models, eight explicit correctness indexes plus13 default_id indexes,
the same ten exact public packages/lock, profile/resources/permissions/limits,
network proof, recording transports and owned lifecycle. Add no dependency,
native child permission, filesystem grant, root entrypoint or operational target.

Eight new conservative source inputs are identified: specialists routes,
controller, validation, services; specialistPortal services/validation; slots
validation; bookings/utils/lifecycle. New effects are route registration and
new controller; Container.get of two services; @Service metadata/DI; eager
PortalService field initialization via promisify(execFile); Joi schema creation;
and a lifecycle helper definition. File/PDF/booking/slot/prescription operations
remain unadmitted. Text discovery predicts97TS/76 reachable modules with the
static audit preservation below; actual emission/model audit must prove counts.

Before the first affected domain import/constructor, register exact TypeDI
throw-only class exports for BookingRepository, BookingService, SlotRepository
and SlotService. JSON freezes every required method. Their constructors may
register/instantiate without IO; any method attempt latches excluded/unexpected
before a fixed throw, never delegates or returns business data. Keep genuine
SpecialistService/Repository/Model and existing user/notification dependencies.

Parent-scoped builtin stubs must intercept BEFORE real builtin resolution and
the eager constructor/promisify step. Permit only the manifested nominal Portal
compiled filename and its six exact manifested mutant filenames, bound to source
631 and the predicted variant hashes. Both child_process/node:child_process map
only to a throwing execFile function; native child loading outside those parents
retains existing denial. Both fs/node:fs map, only for those parents, to the exact
default import shape exposing mkdirSync/writeFileSync/unlinkSync throw-only
methods. These are the only three actual Portal fs uses, inside private PDF
generation. Other parents keep existing fs behavior/grants. No global fs stub,
native execFile pointer, subprocess, alternate API or fabricated successful file.
Recognize os as an existing Node builtin; no new package or grant follows.

The cut closure contains no upload middleware/Multer import. Do not infer this
from names alone: genuine emitted literal-import/model/closed-loader audit must
corroborate it. An unexpected eager SDK, model, upload initializer or import stops
preparation/admission rather than widening the closure automatically.

## Static inputs, compiler proof and index boundaries

The four prior Booking/Slot repository/model source files and their old compiled
hashes are frozen in JSON as **STATIC AUDIT INPUTS**, preserving conservative
outputs if exclusions otherwise remove them. They are not extra runtime roots,
model admissions or a way to bypass throwing aliases. Genuine emission must
preserve all89 old nominal outputs,27 old variants and2755 dependency files,
then prove actual13-model/five-control closure. Runtime may never import those
four audit outputs through a relative/absolute alternative to the exclusions.

Preserve the accepted compiler-only strict helper/TDZ report and all four broader
library-admission controls, exact compiler/library hashes/options and positive/
negative/restored outcomes. Retain old169 and all new semantic diagnostics with
raw reports and exact multiset delta; new excluded type resolution can change
counts. Never suppress them or claim a clean root/backend typecheck.
TRANSPILE_ONLY_NOT_TYPECHECKED/fullBuild:false remains authoritative.

Appending new IDs makes two current unbounded index slices unsafe. Change ONLY
their boundaries to REQUIRED_CASE_IDS.slice(76,83) and
REQUIRED_SENSITIVITY_IDS.slice(21,27), with a negative control for the old slices.
Keep all343 nominal,150 unsafe and300 restoration comparator checkpoints, index
acquisition/guards/caches and the seven/six private index evidence rows unchanged.
The new profile rows must not be absorbed into index evidence or its parser.

After all83 old nominal groups, append the93 actual profile requests/seven
groups, then capture nominal counters. After all27 old variants, append the six
profile variant rows. Assert exact old prefixes and full new ID sets/counts;
no group can pass from an empty, skipped or precomputed trial array.

Before both new append phases, all preceding race/expiry hooks and asynchronous
work must be terminal/restored. Run existing cleanup only for exact tracked,
already-completed owned challenge IDs and owner filters, then require its map
empty. Current short60s challenges are already cleared before old authority
nominal cases; later login proofs use600s defaults, while the whole child remains
bounded180s. Privately require remaining proof expiry horizon to exceed a full
180s from the append checkpoint, with genuine finite dates and isVerified:true,
without adopting or deleting them. Unexpected
near expiry or pending proof stops the fixture. New profiles create no OTPs.
Never extend expiry, change TTL/index behavior, delete active/sibling rows or
exclude OTP from the13-collection comparisons to hide time-driven deltas.

## Genuine source regressions and restoration

JSON freezes six unique literal source edits and predicted transformed text
hashes: remove each protected key; replace own-presence with truthiness; remove
the pre-denial existence lookup; perform actual update before denial. Eleven
reference trials are fixed: one per key removal, six raw/converted falsy singles,
one absent-lookup case and one premature-update mixed descriptive case.

For each reference, obtain a private actual observation before applying the SAME
fixed nominal predicate. Catch only its precise anticipated mismatch code.
Key/truthiness removals must show actual200/write1/changed protected field;
lookup removal actual422/read0 instead of404/read1; premature update actual422
but read2/write1/changed fields. All other collections/providers/capabilities
remain constrained. An arbitrary throw, malformed response or excluded-capability
attempt is never detection. Then load fresh nominal classes/server, repeat that
same trial/predicate and an allowed alias positive before detected:true. This
adds11 mutant plus22 restoration requests, separately excluded from nominal
public counters. Exact tracked row reset/cleanup is outside checkpoints and only
after unsafe behavior is asserted; preserve first failure on every unwind.

## Checks, ownership and acceptance stages

Root must finalize interfaces/file ownership and obtain two independent contract
reviews before fixture edits. Proposed writers split bootstrap/loader/stubs/pure
units from compiler/scenario/README; Root owns shared manifest/composition/Git.
Scope checkers must survive commits: exact non-QA change union and explicit owned
QA directories, with modes/content/unchanged pins, not a precommit untracked-file
assumption. Preserve the earlier source checker's failure honestly.

Builtins-only fake tests may check actual fixture loader parent scoping, both
aliases, sibling/mutant/hash rejection, zero real builtin resolution, throwing
stub methods, promisify construction/call boundaries, exact manifest/evidence
schema, fixed index slices and first-error restoration. These tests admit no
application/Joi/helper/TypeScript execution or fake business behavior proof.
Actual Joi conversions/statuses and database effects require the complete C3 run.

Then obtain two exact combined source/locked-emission decisions, fresh clean
preparation, actual closure/compiler/package/diagnostic artifact reviews, two
separate exact single-run decisions, one actual90/33 result, independent exact
cleanup and two postreviews. No consumed receipt reuse, automatic retry or
grant/limit relaxation. Keep all failures and record actual reviewer provenance.

No portal runtime has run for this draft. It does not accept fullF04/F15/F13,
M0/Week2, rootC2 install/type/build/start/CI, original115, clinician/finance/
security/client/owner, production/deployment,100RPS or release gates. Doctor
client compatibility, broader contact/tariff/document authority and clinical
eligibility remain separate; no hosted worker/model/auth action is introduced.
