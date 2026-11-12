# Shared business staff authority — initial implementation contract

12 November 2026. Draft for two independent nonauthor Spec and Standards reviews before source edits. Baseline authority sources are bound below at focus df8fd4ef00cb9d45d081ce760d15cef84a880c4e; unrelated later edits do not change these bindings. Root owns integration. This contract follows SYSTEM_DESIGN sections 4–6, the domain glossary and the delegated pharmacy policy. It introduces one reusable authority boundary for pharmacy and lab staff, not a new login, general RBAC engine, organization migration or clinical workflow.

## Outcome and exact initial slice

Implement one usable internal resolver that turns an authenticated individual plus a requested business/branch/capability into a current, narrowly scoped BusinessScope, or denies. Implement its persistence shapes, restricted read adapter and framework-free eligibility rules. Valid synthetic facts must produce the expected scope; missing/invalid facts must deny. The initial source slice exposes no HTTP route, grant/verification writer, bootstrap command, index migration, clinical command, protected-data reader or payment/stock effect. It does not silently enable existing routes or promote existing business/admin tokens.

New production files only:

| File under src1/modules/organizations | Responsibility |
| --- | --- |
| types/index.ts | Closed capability/purpose and record types; readonly authority facts, lookup and scope; narrow read-port interface. No Express/Mongoose/typedi dependency. |
| rules.ts | Pure validation/evaluation of supplied facts and server time, including all cross-record/proof/version checks below; no database, environment, configuration, provider or logger access. |
| model/index.ts | Four explicitly named Mongoose schemas/models below, with strict fields and index declarations; no startup index creation/synchronization or data seeding. |
| repository/index.ts | The sole Mongo authority adapter and the explicit narrow projection adapters for existing User and Pharmacy facts. No inheritance from unscoped BaseRepository; no arbitrary caller filter/update/model exposure. |
| services/index.ts | Constructor-injected read port; validate caller context, obtain current facts within the caller's transaction, invoke the one rule evaluator and mint/freeze the internal scope. No default permissive port or singleton environment switch. |

No root dependency/lock/build/start, existing auth/user/pharmacy/admin source or routes change. Source QA may contain exact diff/hashes and review records. Meaningful pure-rule/port tests may be added to a separately reviewed focused test entry; do not add a redundant lexical-test framework, copy production controllers or run application imports under this contract.

## Identity and scope

- Reuse existing personal User._id, authenticated by the existing signature-verifying middleware, with userType exactly user. The resolver takes only an internal authenticated-principal projection, not a body/header token decoder. Reload the User by exact ID; require stored userType=user and isActive=true. Missing/false/unknown state denies. User.isVerified/otpVerified and linkedPharmacyId never establish professional or staff authority.
- A pharmacy token identifies a business, not a person. Reject pharmacy/admin/hr/specialist tokens for this resolver, including an admin with self-edited permissions. An individual may have customer and staff roles, but each invocation explicitly uses purpose=staff; do not union patient/dependent/caregiver rights or infer consent.
- Canonical organizationId is a new organization record ID. Initial mapping kind is pharmacy or lab; legacy business IDs remain separate references. Do not copy pharmacyId/corporateId into organizationId or invent an organization for an API provider. Branch IDs are explicit embedded organization branches; no implicit branch, wildcard, omitted branch or all-branches capability.
- Input contains exactly requested organizationId, branchId and one supported capability. Initial closed capabilities are pharmacy.prescription.review and lab.report.release. The first requires profession=pharmacist; the second requires profession=lab_signatory. A capability grants only the named action in this scope, never finance, catalogue, stock quality, exports, contact changes or professional verification.
- All IDs must be canonical lowercase 24-hex strings, with no coercion from objects, whitespace or numbers. Versions are positive safe integers; digests are lowercase 64-hex SHA-256. Arrays are bounded (at most 100 branches/grants), have unique keys and no unknown capability/branch/profession values. Reject malformed stored records as well as malformed input; Mongoose casting is not the validator.

The initial real business adapter supports only pharmacy. It reloads exact Pharmacy._id from the canonical organization mapping and requires isActive=true, isVerified=true and absent archivedAt. It checks that the protected mapping's source-field fingerprint still matches the current license number/document reference; business verification alone is insufficient. A changed or absent fingerprint denies even if the legacy verified flag remains true. The fingerprint detects changed fields, not overwritten remote URL bytes; immutable verification evidence is separately required. Lab always denies with AUTHORITY_MAPPING_UNAVAILABLE until its actual canonical business/branch adapter is separately contracted and reviewed. Lab types and capability use the same resolver; no fake lab ID or permissive placeholder adapter.

## Minimal persisted authority records

Use these four collections only. They contain authority/provenance references, not patient records, prescription/report content, credentials, document URLs or authentication secrets. IDs are immutable; createdAt/updatedAt are UTC. No public generic CRUD or direct model access outside the approved adapter. Every current record has schemaVersion=1 and positive revision, incremented by future protected writers; unknown versions deny.

| Collection | Required fields and invariant |
| --- | --- |
| business_authority_organizations | _id, kind, sourceBusinessId, state=active/suspended/revoked, revision, sourceFingerprint, mappingDecisionId, bounded branches[{branchId,state,revision}]. Exactly one organization per kind+sourceBusinessId, each branch belongs to that organization. No source/mapping/branch replacement through a profile update. |
| business_staff_memberships | _id, organizationId, actorId, state=active/suspended/revoked, revision, validFrom, expiresAt, and bounded grants[{branchId,capability,grantDecisionId}]. Exactly one current membership per organization+actor, retaining revoked rows. A grant is branch-specific and names a protected decision; capability arrays alone are not provenance. |
| business_professional_eligibility | _id, organizationId, actorId, profession, state=verified/suspended/revoked, revision, validFrom, expiresAt, verificationDecisionId, evidenceVersionId and evidenceSha256. One current record per organization+actor+profession. This is current verified eligibility, not a copied user/business flag; the referenced professional decision supplies the permitted branch/capability scope. History is retained in immutable decision records. |
| business_authority_decisions | _id, organizationId, operationId, decisionKind=business_mapped/membership_granted/professional_verified, subjectActorId where relevant, decidingActorId, decidedAt, authorityGeneration, schemaVersion=1, payloadSha256, exact payload and immutable evidence references. No update/delete methods. Payloads bind the exact relevant organization/source fingerprint, branch/grant, subject, record revision, profession and credential evidence versions/validity. Unknown kinds or mismatches deny. |

The resolver checks mapping, grant and professional decisions against the current records, not just that a decision ID exists. A grant/verification decidingActorId must differ from its subjectActorId. Membership-grant and professional-verification are distinct decision kinds; neither implies the other. A decision records the authority and evidence at decision time; a later verifier-role change does not silently rewrite history. Revoking current eligibility/membership or invalidating evidence blocks current use.

Decision authenticity originates in the separately protected grant/bootstrap path, not a client-supplied document or database label. A read-only readiness port supplies the accepted authorityGeneration and verified index/provenance readiness from trusted composition; it is not request input, an environment boolean or an editable Admin field. It defaults closed. All three decisions must match that accepted generation. Initial source supplies no way to activate it or fabricate records. No existing app/admin/profile writer may mint these records. Threats from privileged database tampering and restore rollback require the existing security/restore controls; schema immutability alone is not advertised as cryptographic or operational authenticity.

Use a fixed schema-versioned array serialization for each decision kind before SHA-256: explicit ordered field names/values, canonical IDs, integer revisions/epoch-millisecond times, sorted unique branch/capability entries and exact evidence digests. Do not hash arbitrary object iteration order, omit absent-vs-null distinctions or accept a submitted digest without recomputing it. The exact serialization vectors form part of the implementation review. Stored payload and recomputed digest must match the referenced current record snapshot. No remote evidence fetch occurs during resolution.

## Scoped reads and current-fact consistency

The read port exposes only readiness(), loadFacts(lookup, transaction, now) and no generic query, write or list operation. lookup contains the authenticated actorId plus exact organizationId, branchId and capability. The resolver validates these before any persistence access. Each production call requires an explicit caller-owned ClientSession in an active snapshot transaction; no session-less fallback, nested transaction, unrelated session, cache, provider call or automatic retry. Missing/invalid session/readiness denies before authority reads. The adapter never starts/commits/ends the caller's transaction. It projects only required authority fields and returns plain immutable data to rules.

Exact Mongo query restrictions:

1. User: {_id: actorId, userType: 'user', isActive: true}; project ID/type/active only. This is an individual identity lookup, not a private patient/profile fetch.
2. Organization: {_id: organizationId, state: 'active', branches: {$elemMatch: {branchId, state: 'active'}}}; require exactly one matching embedded branch. A legacy business ID is read only after this mapping succeeds.
3. Pharmacy business: {_id: sourceBusinessId, isActive: true, isVerified: true, archivedAt: {$exists: false}}; project only ID/status and fingerprint source fields. Any present archivedAt, even malformed/null, denies under this strict new boundary. Unsupported kind denies before querying another business collection.
4. Membership: {organizationId, actorId, state: 'active', validFrom: {$lte: now}, expiresAt: {$gt: now}, grants: {$elemMatch: {branchId, capability}}}. Enforce one current row and one matching grant; ambiguity denies.
5. Professional eligibility: {organizationId, actorId, profession: requiredProfession, state: 'verified', validFrom: {$lte: now}, expiresAt: {$gt: now}}. Enforce one row and matching branch/capability in the verification decision.
6. Each decision: {_id: referencedDecisionId, organizationId, decisionKind: expectedKind, authorityGeneration: acceptedGeneration}; grant and professional decisions additionally require subjectActorId=actorId. Compare the full binding/digest in rules. Do not merge an externally supplied filter or use $or to relax these predicates.

Authority construction is the explicitly narrow bootstrap query boundary preceding a verified BusinessScope; it may inspect only the requesting person's authority in the exact requested organization. It is not a generic exception allowing other modules to read unscoped business or patient records. No list/count/aggregate/export/file/job surface is added in this slice. Future private business repositories must require the minted scope and compose restrictive ownership/branch predicates on every operation.

Capture one finite server time from an injected trusted clock per resolution, never a request timestamp; pass that exact value to loadFacts and rules. Require validFrom <= now < expiresAt for membership and professional eligibility, with finite dates and valid intervals. Require mapping/grant/verification decisions not in the future. Scope expiresAt is the earlier membership/eligibility expiry. Every invocation reloads facts in its transaction; no JWT role cache or cross-request reuse. Database errors, missing/duplicate rows, malformed facts, unknown evidence and readiness failure reject; no catch returns an allow result.

A successful result is a deeply frozen, internally minted BusinessScope containing actorId, organizationId, exactly one branchId, purpose=staff, capability, kind/sourceBusinessId, organization/branch/membership/eligibility revisions, exact decision/evidence references, checkedAt and expiresAt. Minting uses a module-private runtime identity check (for example, a WeakSet) rather than trusting a caller-shaped object or TypeScript brand alone. Do not include patient details, license contents, bearer tokens or unnecessary profile data. This is a reusable internal authority result, not a new session/JWT or proof of patient consent.

## Revocation, sensitive commands and audit boundary

The initial resolver establishes eligibility at its transaction snapshot. It does not promise that a later mutation or delivery is safe merely because a scope object exists. No sensitive command is activated in this slice. Before a prescription/report/financial/stock writer consumes this interface, its separate contract must resolve/revalidate in the command transaction, compare current subject/resource/document versions and perform a genuine shared write/CAS fence against concurrent authority revocation. Reading the same old snapshot twice is insufficient. Every grant/revoke and subject/business disable path participating in that contract must conflict on the same fences; until that is implemented and race-tested, sensitive command activation stays closed. Delayed jobs must resolve current authority afresh and preserve the initiator; a captured scope is not a durable grant.

Protected decision interfaces are data contracts here, not an approval/rejection endpoint. A future clinical writer binds the individual, scope and authority revisions to immutable patient/document/item/order versions, reason and decision time. It must distinguish imported/unverified evidence from finalized clinical authorship and enforce current patient/purpose authorization separately. This contract makes no prescription decision and releases no report. Finance/recovery permissions and stock-quality release require their own closed capabilities and contracts; do not reuse pharmacy.prescription.review for them.

No audit sink is invented or falsely claimed operational in this slice. The resolver returns a redacted decision reference set for the future protected command audit. It must not log raw tokens, credential documents, patient data or arbitrary record bodies. Public adapters added later must map missing authentication to 401, denied/hidden authority to one uniform 403 AUTHORITY_DENIED without tenant-existence details, and temporary readiness/mapping infrastructure failure to a generic unavailable response. Internally preserve typed denial categories for focused checks. An existing route is never silently changed by this work.

## Bootstrap, activation and indexes

The initial slice has no provisioning escape hatch. The readiness port defaults closed, records are not auto-created on login, and no existing admin/business/self-profile capability is trusted. A later independently reviewed local protected bootstrap/grant command must establish the first real organization mapping and branch, independently verify the individual and professional evidence, preserve a protected operation/evidence record, prove the issuer's authority without circular self-granting, and install/verify the required indexes through the create-only readiness process. It must distinguish developer-created synthetic fixtures from real grants and must not derive production authority from test data. Real professional verification and individual clinical decisions remain human workflow facts; no additional product-policy naming question is needed to develop this boundary.

Declared correctness indexes:

- Organization unique {kind:1, sourceBusinessId:1}.
- Membership unique {organizationId:1, actorId:1}, across every state; revoked rows are not deleted to permit a second conflicting current membership.
- Eligibility unique {organizationId:1, actorId:1, profession:1}, across every state.
- Decision unique {organizationId:1, operationId:1}; same operation with a different payload is a conflict, not a new decision. _id uniqueness also applies.

Do not rely on a schema declaration as proof of installed uniqueness. Readiness must verify exact keys/options, conflict-free data and supported transaction topology before real activation; no destructive syncIndexes/drop or background migration is admitted. Branch/grant uniqueness is explicit validation and future write-CAS responsibility, not a purported Mongo multikey uniqueness guarantee. No live records or users are provisioned by this contract.

## Verification and acceptance

Initial source-only acceptance requires two independent nonauthor implementation reviews, exact source/composition bindings, no unintended imports/wiring and explicit NOT_RUN runtime/index status. Pure-rule and read-port checks must exercise behavior, not merely match source strings. Execution needs a separately frozen launcher/source closure under current C3 rules; this document does not itself admit importing Mongoose, Node, the app or providers.

Required focused cases before claiming resolver runtime acceptance:

- Valid pharmacy person, active exact organization/branch, matching current grant/credential/evidence/generation and business fingerprint produces exactly one frozen scoped result; injected time boundaries are deterministic.
- Missing principal, each non-person token kind, inactive/missing User, malformed/castable IDs, missing/wrong purpose, unknown capability and altered requested actor fail before unauthorized reads.
- Two businesses and two branches reject cross-organization records, another subject's membership/credential/decision, mismatched decision kinds/revisions/digests/evidence and forged caller-shaped scope objects.
- Missing/false/unknown readiness, wrong generation, missing index proof, unsupported lab mapping, absent/changed source fingerprint and changed license fields deny; no fallback to legacy isVerified/Admin.permissions exists.
- Missing/duplicate/ambiguous membership/credential/grant/branch, suspended/revoked state, expired/future/invalid dates, future decisions, self-grant/self-verification and unknown schema/revision all deny.
- Adapter recording tests assert the actual restrictive predicates/projections and the exact same supplied transaction for every read; no unscoped lookup, arbitrary FilterQuery merge, provider access, writes or nested session occurs. Read/clock failures propagate, and returned objects cannot be mutated into a broader scope.
- Separately admitted replica-set/index checks prove installed constraints and snapshot consistency; later command checks prove revoke/disable vs approval races through real shared fences, replay/conflicting payload handling and protected audit atomicity. No future command is enabled based on pure or source-only passes.

Corporate, HR and hospital expansion and the final cross-module integration campaign remain deferred. C2 dependency/runtime/start conditions, C3 pre-import admission, focused clinical/financial/security evidence and application/release gates remain. This slice does not resolve F1; it supplies the shared authority prerequisite for its approval/recovery implementation.

## Source bindings used for this contract

| Existing input | SHA-256 |
| --- | --- |
| GLOSSARY.md | 88b19e2eab9aaeb19a0bb889e4f54b6dcf80953b90d65f31b87c4ef8b3bb671f |
| documentation/planning/SYSTEM_DESIGN.md | cbd899f6fb442b13db28c389143b529b90da364165dc17291cc829814810bc84 |
| documentation/planning/implementation/PHARMACY_DELEGATED_POLICY_DECISIONS.md | 3882d1dc976342376ed6729fc877fa80e15b79f225a37b10933c1d3681333f6f |
| src1/modules/middleware/auth.ts | db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2 |
| src1/modules/user/model/index.ts | 8ab08c867008d9788fd2105b6ac840794fcd5d8b2c518de500119aa2536cf5c4 |
| src1/modules/user/types/index.ts | 91d4b48e4749d113733f471d64093c7269dffcf13bf48577c8dbc2edce7d5b71 |
| src1/modules/user/repository/index.ts | e730c52b26fbc773bcf92673190b68fe00c91162cb97f37eac1570cbbb85c4e1 |
| src1/modules/pharmacies/model/index.ts | beda95d89a9773a8d5851dd923c363c83123a573f7391836dec69b13e5cfa177 |
| src1/modules/pharmacies/types/index.ts | e43d4c6e5af5ebc9a21e3a35d41e475e92ab7509961cdafe6bfc3043af0b24f0 |
| src1/modules/pharmacies/repository/index.ts | f3e1110b139c8158d1c846db7778a45f8ba9f5ce225f4468384f2d070d3718db |

Existing source discovery uses the swasthadisha graph indexed at original bfb608e, then exact current reads; the two authority/money explorers' baseline remains the broader verified discovery record. No new implementation, package/import execution, real grant, index or operational authority is asserted by these hashes.
