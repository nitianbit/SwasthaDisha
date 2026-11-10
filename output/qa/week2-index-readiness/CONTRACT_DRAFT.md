# Selected-index observation predicate: draft for lead review

11 November 2026. DRAFT_ONLY; no implementation or execution approval. Author:
`/root/auth_api_fixture_contract`. Current clean preparation branch starts at
008b35c4a84a4def2a368b7272f2059f944965a0; read-only discovery was recorded at
bac46d306a5f989c1eafcab5c40d4ce6fdd06e1d. Root must freeze the actual accepted
Meet baseline and final shared contract/interface before assigning writers.
Current accepted runtime is60/17 execution6. Meet76/21 source/preparation review
does not establish its actual runtime. No old receipt or result is reusable here.

## Purpose and boundary

Prepare one dependency-free pure exported comparison, provisionally
`evaluateIndexReadiness(manifest: unknown, observations: unknown): IndexReadinessResult`
in `src1/modules/common/utils/indexReadiness.ts` (NOT CREATED). It reads only the
supplied data and returns a safe fixed result. It has no imports or initialization
effects: no CONFIG, Mongoose/model, filesystem, process/env, logger, timers,
clock/randomness, network, provider, database, discovery, writes or callbacks.
No entrypoint, health check, writer admission, migration or existing caller is
changed. The parameterized comparator contains no copy of application index
policy; the later caller must pin the exact selected manifest described below.
An empty manifest cannot yield ready. This is a useful F13 seam, not F13 completion.

SYSTEM_DESIGN section13 distinguishes create-only/preflight jobs from read-only
required-index readiness and affected-writer refusal. ROADMAP F13 additionally
requires wallet effects across reference types and pharmacy+medicine uniqueness.
Those production manifests, duplicate/conflict resolution, creation/waiting,
writer integration and owner/runtime/deployment acceptance remain separate.
Never import/reuse syncIndexes.ts: it loads models/CONFIG, connects, creates and
can drop indexes. Existing startup/health behavior stays untouched.

Graph-first search/trace found connectDB and startup callers. Index status points
to canonical checkout bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7, not this worktree;
actual current bytes and draft-inputs.json govern. Arrow/top-level operations
were checked in source, not inferred absent from missing graph edges.

## Selected manifest and scope

The only planned C3 caller/tests supply the current thirteen-model selected
manifest: users, admins, hrs, corporates, specialists, pharmacies, OTP (case
sensitive), wallets, wallettransactions, notifications, fcmtokens,
wellnesspackages, dependents, in existing ports.models order. Every collection
requires one implicit completed `_id_` index with ordered key [["_id",1]].
Eight explicit requirements follow, retaining their existing scope exactly:

| Collection | Ordered key | Required options |
| --- | --- | --- |
| users | corporateEmail:1 | unique:true, sparse:true |
| hrs | employeeId:1 | unique:true |
| pharmacies | phone:1 | unique:true |
| OTP | expireAt:1 | expireAfterSeconds:0 |
| wallets | userId:1 | unique:true |
| wallettransactions | userId:1,transactionType:1,referenceType:1,referenceId:1 | unique:true; partial below |
| notifications | idempotencyKey:1 | unique:true; partial below |
| fcmtokens | token:1 | unique:true |

Wallet partial is exactly {transactionType:"refund",referenceType:"pharmacy_order",
referenceId:{$exists:true,$type:"string"}}. Notification partial is exactly
{idempotencyKey:{$exists:true,$type:"string"}}. This does not widen wallet refund
uniqueness. User.referralCode and performance/text indexes, pharmacy inventory
and all additional production requirements are outside selection. There are21
selected requirements (13 implicit+8 explicit); no claim of21 full F13 tests.

## API, input representation and limits (design choices)

Manifest is a dense nonempty array of exact data objects
`{collection: string, indexes: [{key: [[field, direction], ...], options: {...}}]}`.
It is an explicit supplied requirement set, not schema/model/file discovery.
Options has only unique, sparse, expireAfterSeconds, partialFilterExpression,
collation; all optional, with absent/false defaults specified below. No explicit
_id requirement is accepted: it is added internally once per collection.
Collection names are unique and case sensitive; duplicate ordered key vectors
within one collection are invalid even if options differ. No index-name policy
is introduced for non-_id requirements.

Observations is a dense array with exactly one listing per manifest collection,
in any order, and no foreign collection. Each listing has exactly
`{collection, status, mode, indexes}`. Status is COMPLETE, INCOMPLETE or FAILED;
mode must be MONGODB_8_INCLUDE_INDEX_BUILD_INFO. This mode is an attestation by
a separately reviewed adapter that requested build information and exhausted
all cursor batches; the pure function cannot prove acquisition. For FAILED or
INCOMPLETE listings indexes must be an empty array; never compare a partial
firstBatch as complete. No raw error/URI/cursor ID is accepted or returned.

For COMPLETE listings, indexes contains the build-info-mode reply rows: completed
row exactly `{spec: {...}}`; any own indexBuildInfo/buildUUID marker is unready,
including null/empty/false values. Bare specs, wrappers with unknown fields or
any unknown build mode are unsupported, never evidence of completion. Presence
of a build marker is determined by own data descriptors without invoking or
printing its value. Accessor markers remain malformed input. Required ready
spec fields are name and key; key is an ordered tuple array, projected from the
actual BSON key's field order. No sorting of keys. Spec optional fields are
unique, sparse, expireAfterSeconds, partialFilterExpression, collation, hidden,
v, ns, background. A future adapter preserves every supplied semantic field and
rejects unknown fields; it may not strip unknown metadata to manufacture ready.
Unknown storageEngine/text/wildcard/prepareUnique/clustered/other semantics are
unsupported in this narrow comparator, even on extra indexes.

Bounds: at most13 collections, at most8 explicit indexes per collection and
104 total explicit requirements, at most64 observed indexes per collection/256 total,
1..16 ordered key entries, bounded field/collection/name strings1..256 UTF-16
code units with no NUL, edge whitespace or prototype-control names. Key fields
follow [A-Za-z_][A-Za-z0-9_.]* and have no duplicate names. Directions are exact
numeric1/-1, never strings/booleans/text/hashed/wildcard keys. Partial JSON has
depth<=6; total input graph is capped at8192 data nodes/65536 string code units.
Implicit _id requirements are additional; the selected call remains8 explicit
plus13 implicit. No truncation/sampling on a bound violation. These are fixture/library limits,
not statements of MongoDB limits or expanded index policy.

Accept plain data objects with Object.prototype or null prototype and dense
ordinary arrays; reject cycles, symbols, accessors, extra array properties,
functions, undefined, nonfinite numbers and non-data native/BSON instances.
The sole opaque-value exception is an own data-property build marker: it makes
the listing unready without inspecting/coercing/traversing that value, so even a
native UUID/null/cyclic marker cannot be accepted or leak into the result.
Use descriptors, not value coercion/toJSON. No mutation, sorting/freezing input,
reference exposure or JSON stringify before shape admission. Repeated aliases
may be read without mutation; only active cycles are rejected. Inputs are trusted
admitted data, not hostile Proxy code: JS reflection cannot generally prove a
value is not a Proxy. A caught reflection exception produces only a fixed
invalid-input result; no guarantee of zero attacker Proxy-trap execution is made.

## Exact comparison semantics

- Collection identity is exact/case sensitive; manifest order supplies diagnostic
  ordinals, not observation order. Duplicate/missing/foreign listings are invalid.
- Every observed name is nonblank/bounded and unique within its collection.
  Duplicate exact ordered key vectors are conservatively invalid, even under
  distinct names/options. This refuses ambiguous same-key definitions rather
  than selecting whichever entry passes. It is not a MongoDB prohibition claim.
- Match key entries by field AND numeric direction AND order. Reversed compound
  order, missing/extra fields and changed direction cannot satisfy a requirement.
  Non-_id names may differ harmlessly. One valid completed unrelated index is
  ignored only after all its shape/metadata checks succeed.
- unique/sparse/hidden absent normalize to false, explicit booleans only; unique
  and sparse must equal requirement defaults/exact values. Required indexes
  must be visible (hidden absent/false); hidden:true cannot satisfy them. Hidden
  unrelated ready extras may be ignored. No planner/performance acceptance.
- The sole implicit-uniqueness exception is name `_id_` AND exact key [["_id",1]]:
  absent unique is treated as true; explicit false rejects. A renamed _id key,
  same name with another key or a non-_id key never gets that exception. Required
  _id also has sparse:false, hidden:false, no TTL/partial and simple collation.
- TTL absence differs from0. Present expireAfterSeconds must be an integer in
  design range0..2147483647 and equal exactly; NaN, strings, negative/fractional
  values and an unexpected TTL cannot satisfy a requirement.
- Absent partial differs from any present partial, including empty object. For
  present supported finite JSON, compare object keys without order, but preserve
  array order, scalar types/values and every operator/value. No query evaluation,
  string/number coercion, `$eq` expansion, `$and` reordering or `$type` alias
  normalization. Broader/narrower/structurally different filters fail closed.
  Logical-equivalence guessing is outside scope.
- Collation absent or exactly {locale:"simple"} normalize to simple; any other
  collation/extra collation fields are unsupported, not silently defaulted. The
  current selected manifest specifies no collation. Collection-default inference
  is not performed. This conservative rule may refuse real metadata; it cannot
  prove production collation compatibility without later readback evidence.
- Metadata v may be absent or exact integer1/2; ns may be an optional bounded
  string; background may be absent or boolean. They are ignored for semantic
  equality only. Namespace ownership is separately verified by the adapter.
  Unknown metadata/building rows anywhere refuse this observation, even if all
  selected keys also have apparently matching completed rows. Extra indexes are
  not automatically safe solely because they are not selected.

## Safe result and deterministic refusal

Return a fresh frozen exact object `{ready, code, collectionOrdinal, indexOrdinal}`.
Ordinals are zero-based positions in the admitted manifest; implicit _id has
indexOrdinal0 and explicit indexes1..n. When no valid position applies use null.
No input collection/index/key/option/error/string, exception stack or rejected
value appears in output. No logging/throw for expected invalid data. Internal
unexpected reflection/inspection errors map to INPUT_INVALID without cause.

Closed codes: READY, MANIFEST_INVALID, OBSERVATIONS_INVALID, OBSERVATION_FAILED,
OBSERVATION_INCOMPLETE, OBSERVATION_UNSUPPORTED, OBSERVATION_UNREADY,
REQUIRED_INDEX_UNSATISFIED, INPUT_INVALID. Only READY has ready:true and null
ordinals. Structural/limit/duplicate validation precedes matching: invalid
manifest first, invalid observations second; these two global structural results
use both ordinals:null. Unknown top-level/listing fields are structurally invalid;
unknown wrapper/spec semantic fields are unsupported metadata. Marker values
are opaque as above. Then iterate manifest collection
order: failed/incomplete status, unsupported mode/semantic metadata, building,
then selected requirements (_id first, explicit order). First refusal wins;
status/build/shape collection refusals use indexOrdinal:null. Missing or wrong
keys/options share REQUIRED_INDEX_UNSATISFIED; no unsafe unscoped lookup to give
more detail. Expected false results are not health/startup/writer enforcement.

## Source checks and future behavioral evidence

Before source implementation root freezes this contract/input pins and obtains
two actual independent nonauthor preimplementation decisions. Assign one author
the pure file and owned QA only; freeze a reviewed source-data verifier before
the source patch. Baseline absent/helper-unready source must be rejected.
Checks may read TypeScript as data, verify exact owned source scope/no imports/
effectful globals/export shape, preserve every existing source and weaken source
predicates as negative controls. Those checks prove transformation only. Do not
import/extract/transpile/evaluate the application helper on the host and call it
a harmless unit: full reviewed pre-import admission applies even to pure source.

A separately contracted C3 extension will later import the actual emitted helper
inside the already admitted child, with all ports/guards active, and collect
listIndexes only from the derived owned database's fixed13 collections. Use the
version-pinned includeIndexBuildInfo:true mode; exhaust getMore to cursor zero,
verify every cursor namespace/collection, bound batches/rows/bytes and refuse
errors/timeouts/unknown metadata. No sync/drop/repair/index changes or application
startup script is admitted. Observation precedes selected fixture writers; the
existing create-only fixture setup remains separately explicit and unchanged.
Root must review the exact new command/loader/stage/counter/case protocol before
this adapter is written or executed. No new command is granted by this draft.

Future evidence groups (not yet public API IDs/counts) are: actual complete
selected-manifest readback; independently remove each of21 selected requirements
from derived copies; ordered-key/collection identity drift; unique/sparse/TTL/
partial/collation drift; incomplete/failed/malformed/duplicate/building/unknown
observations; harmless names/extras/defaults/immutable inputs; zero effects and
safe bounded results. Each option changes independently, including TTL0 versus
absent and the narrow _id uniqueness exception; partial field order may reorder
but arrays/types/operators/values cannot. Include each missing collection, mode,
initial incomplete batch, getter (zero getter calls), cyclic/oversize input and
mutation attempts on both frozen and unfrozen input/result. Verify canonical
input snapshots remain unchanged on every return. Derived-copy negatives are
declared as such; they are not destructive actual absent-index experiments.

Use six actual emitted-source variants, only in manifested sensitivity phases:
accept missing requirement; sort key vectors; skip option equality; ignore partial
filter comparison; accept incomplete status; accept building/unsupported metadata.
Each must fail the identical concrete nominal predicate for the expected result,
then restore the actual nominal helper and repeat before detected:true. Variant
anchors/hashes and exact matrix/counts require the final implementation contract;
do not substitute fake expected-wrong services or count arbitrary exceptions.
Measure no connections/listens/provider/JWT/DB writes from the helper, no reader
advancement during pure comparison after acquisition, and exact permitted bounded
listIndexes/getMore acquisition separately. Do not count one row as full F13.

Fresh source/preparation/artifact and two exact single-run decisions plus actual
result/two postreviews and owned cleanup precede any new acceptance. Preserve all
old60/17 and accepted Meet groups/probes with explicit placement/counter deltas;
never consume an old recipe. Root C2 dependency/runtime/build/start and retained
server facts, clinical/finance/security owners, production migrations, complete
F13/M0/Week2,115-register/client/release/100RPS gates remain unchanged.

## Primary facts and unresolved implementation questions

MongoDB8 docs say listIndexes includes hidden/building indexes and may require
getMore; a complete listing requires cursor exhaustion. getIndexes examples omit
unique on `_id_`, and hidden is reported only when true. [listIndexes](https://www.mongodb.com/docs/v8.0/reference/command/listindexes/),
[getIndexes](https://www.mongodb.com/docs/v8.0/reference/method/db.collection.getindexes/).
The unique-index documentation identifies default _id uniqueness. [Unique indexes](https://www.mongodb.com/docs/v8.0/core/index-unique/).
The exact8.0.34 server IDL distinguishes completed `{spec}` from in-progress
`{spec,indexBuildInfo}` under includeIndexBuildInfo and marks that option unstable.
This supports a later fixture-only proposal, not the withheld production target.
[8.0.34 server IDL](https://github.com/mongodb/mongo/blob/r8.0.34/src/mongo/db/list_indexes.idl).
All normalizations, bounds, refusal ordering and extra-index restrictions above
are deliberate narrow comparator choices, not additional claimed server facts.

Lead questions before final freeze: accept parameterized comparator plus pinned
caller selection instead of duplicating thirteen-model policy in the library;
confirm conservative unsupported-collation/same-key/unknown-extra refusal; retain
strict structural partial equality unless actual admitted readback shows server
representation changes, then amend/review exact normalization before claiming
compatibility; freeze supported actual build-info wrapper projection in later
C3 contract. None requires a production/environment guess or implementation now.
