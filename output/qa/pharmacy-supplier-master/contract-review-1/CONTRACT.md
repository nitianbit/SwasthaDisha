# Pharmacy supplier contact master — bounded contract draft

12 November 2026. Author internal Codex `/root/payment_ctor_contract`. DRAFT_ONLY. Baseline `dbe1cc2d972876876c422cf7af1b194037542575`, focus `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab`. Two actual independent NONAUTHOR contract decisions precede source assignment; two fresh exact source decisions follow. Root selects technical/product details; business/user acceptance is unproved. No source/schema/index/route edit, commit or execution. Preserve other workers, unselected drafts, original staged six/archive and R8 selected live pins.

## Original scope and actual reuse finding

CAPABILITY_MATRIX B06 explicitly records supplier/PO/GRN/vendor-invoice chain Missing; ROADMAP U2 requires supplier accounts → purchase order → GRN → supplier invoice and purchase returns. BUSINESS_OPERATIONS pharmacy rows require supplier/purchase/receive; its proposed procurement boundary owns those references. SYSTEM_DESIGN receive-purchase boundary separates receipt/stock effects from supplier payment/account export.

Graph-first Supplier/PurchaseOrder/GRN search returned no nodes; known index identifies originalbfb608e. Current module-path and supplier/vendor/purchase-order/GRN literal checks found no supplier master/model/service. Vendor hits belong to Healthians/coupon targeting, not procurement. Existing inventory purchasePrice and purchase adjustment reason are not supplier accounts or receipt provenance. Do not repurpose pharmacyCustomers (patient-linked records), global Pharmacy profiles, inventory adjustments or a provider vendor ID.

Select a useful prerequisite only: the owning pharmacy's local supplier contact/reference metadata, with create/list/versioned-edit/archive. It is not a verified supplier legal identity, KYC/licence/GST status, buying eligibility, trade credit, payable, invoice, GRN or stock movement. No clinical qualification, funding or provider fact is needed for contact storage. Actual purchasing/receiving remains separately contracted; B06 stays incomplete.

## Concrete API and source boundary

Propose one narrow `pharmacySuppliers` module (types/model/repository/services/controller/routes/validation index.ts) plus one authenticated central mount `/api/v1/pharmacy-suppliers`; no generic ERP/framework or duplicate organization registry. This is the existing pharmacy-owned M0 adapter for future procurement references, explicitly not an activated organization/branch/staff BusinessScope. Later procurement must reference this stable local ID and separately verify the actual counterparty; no phone/email/name-based automatic organization merge or ownership inference.

All four routes use existing authenticate then requireOperationalPharmacy, preserving exact role/active/verified/archive errors and no admin bypass. Controller forwards only guard-resolved pharmacyId and signed actor `_id`, never body/query owner fallback. Direct service/repository methods require primitive lowercase24hex pharmacy scope; writes additionally require canonical signed actor ID. Invalid required scope gives403 FORBIDDEN / Access denied before supplier access. Canonical actor IDs record signed-subject provenance, not an individually qualified pharmacist. Existing guard fallback/token freshness and unwired staff-membership limitations remain explicit.

| Route | Input and result |
| --- | --- |
| GET `/` | Query state=active/archived/all (default active), page1..1000(default1), limit1..50(default20);200 closed list/page. No search/export/owner selector. |
| POST `/` | Required displayName, optional contactName/phone/email/address only;201 new DTO, server state active/revision1. |
| PATCH `/:id` | expectedRevision plus at least one mutable metadata field;200 updated DTO. Archived records409. |
| POST `/:id/archive` | expectedRevision only;200 archived DTO; already archived returns that stored DTO without another revision/time change. No restore/hard delete. |

New IDs are canonical lowercase24hex; malformed route/direct ID400 VALIDATION_ERROR / Invalid supplier ID. Reuse AppError and existing guard/validation patterns; no changes to existing pharmacy/patient/stock/payment routes.

## Minimal stored fields and input rules

One explicit `pharmacy_suppliers` collection/model PharmacySupplier: schemaVersion1, immutable server pharmacyId ObjectId, displayName, nullable contactName/phone/email/address, state active|archived, positive safe-integer revision, immutable createdByActorId and current updatedByActorId (signed strings), server createdAt/updatedAt and nullable archivedAt Dates. Schema strict throw, timestamps true, autoCreate/autoIndex false; no custom/unique index, migration/backfill, global dedup or collection-creation action in this slice. Duplicate contacts are allowed; no uniqueness/idempotent-create promise. A lost create response may require later user reconciliation, never a claimed exactly-once supplier identity.

Selected field policy: primitive text only; displayName trim1..120 UTF-16 units. Optional contactName<=120, phone<=32, email<=254, address<=500; create omission/null/trimmed-empty becomes null, PATCH omission preserves and null/trimmed-empty clears. DisplayName cannot clear. Phone uses `[+0-9(). -]` characters only; email uses existing Joi email syntax validation with TLD checking disabled, not delivery verification. Address/contact text remains unverified business input. No patient/clinical notes, documents, bank/payment account, balance/credit/terms/tax/licence/verification fields.

Do not silently strip write authority fields. After the pharmacy action guard, reject nonplain bodies400; on edit/archive perform one combined owned lookup before forbidden-field422. Check every own key (symbols/non-enumerables/accessors included): only route-specific keys above; unexpected keys422 FORBIDDEN_FIELD / One or more fields cannot be changed through this endpoint. Known content/empty-edit/revision errors400 VALIDATION_ERROR / Invalid supplier request. Normalize/validate only after the allowlist, with no raw body spread/coercion. List query can use dedicated Joi after guard (pharmacyId forbidden); common stripUnknown stays, while direct repository query is closed/plain/own-data only. No promise all raw unknown list keys reject.

## Restrictive reads and writes

Use a narrow scoped repository, not inherited optional-scope BaseRepository or caller FilterQuery/options. ID reads combine actual validated ObjectId `_id` and pharmacyId plus scalar-objectId expression checks; missing/foreign404 SUPPLIER_NOT_FOUND / Supplier not found. Return no foreign existence detail. Validate required stored identity/schema/revision/state/text/Date fields before DTO; malformed included records503 SUPPLIER_MASTER_UNAVAILABLE / Supplier master is unavailable, no repair/coercion/raw error echo.

Create inserts one explicit literal document under the supplied scope/actor. Edit writes only supplied normalized metadata plus server actor/time, increments revision once, and predicates `_id,pharmacyId,state:active,revision:expectedRevision` with scalar owner/state guards, new:true/upsert:false/runValidators:true. Expected revision must be safe1..MAX_SAFE_INTEGER-1. CAS miss409 SUPPLIER_CONFLICT / Supplier changed; no retry, ownerless fallback or effect replay. Archive uses the same fence, sets archived/time and increments once; immutable ID/owner survive. No other document/collection/provider effect. Existing pre-read is not an atomic revocation/ownership fence; the final predicate protects only this supplier write. Latest revision/actor metadata is not a claimed immutable edit-history audit; later purchasing references need their own immutable snapshots/audit.

List one owner/scalar aggregate, exact scalar selected state filter (all means active+archived), explicit DTO projection and one same-stream count/page facet, `_id:1` order, timeout2000ms/no disk spill. Safe count and exact page length; beyond-end empty pages retain total. No lookup into patients, stock, wallets or organizations. No index/capacity claim; growth/explain/performance needs separate admitted evidence.

DTO exactly supplierId,displayName,contactName,phone,email,address,state,revision,createdAt,updatedAt,archivedAt and constant verificationState=not_evaluated; timestamps ISO, optional contacts null, no owner/actor/raw fields. Successful responses Cache-Control private,no-store; compact JSON measured/sent below512KiB, list max50. Conservative row budget8192*50+1024=410624<524288 covers six-byte escaping of bounded text plus fixed fields. No UI or counterparty acceptance is proven by these chosen limits.

## Required focused evidence and retained gates

Later checks need separate full C3: two-pharmacy read/write/count isolation and forged selectors; all guard/body/query/error order; raw forbidden financial/owner/verification fields; text/null/Unicode bounds; CAS/lost-update/archive replay/concurrent ownership; stable ID and no hard delete; malformed stored rows/facets; exact DTO/header/body limits; unchanged stock/patient/payment/provider collections and recorded zero effects. Defect controls must detect owner/scalar/CAS removal, raw spread, hidden field stripping or financial/stock wiring. No Node/compiler/app/SDK/Docker/DB/provider/model/test execution now, and no source-only result supplies runtime acceptance.

C2/fullC3, supported clients, business/staff mapping, purchasing/counterparty and finance-owner decisions, clinical/stock receipt and module/M0/release gates remain. Final integration DEFERRED_BY_OWNER. Corporate/HR/hospital expansion stays deferred; supplier B2B purchasing remains within the pharmacy's original scope, with PO/GRN/invoice/payables still missing. Root may review these concrete field/API choices without a new owner questionnaire; no human qualification, tax/KYC/credit/funding fact is fabricated.

## Exact selected pins

Preparation provenance only, not an executable closure. Recheck before assignment without silently refreshing votes.

| Path | SHA-256 |
| --- | --- |
| documentation/planning/SYSTEM_DESIGN.md | cbd899f6fb442b13db28c389143b529b90da364165dc17291cc829814810bc84 |
| documentation/planning/CAPABILITY_MATRIX.md | 05ab06d569b8dad2a690ac434922738bd20ce15d9484b60e4bf55e62e14e7fea |
| documentation/planning/ROADMAP.md | 6a5b2e5bfdb42d16021cb28f83531389977d535d9743ae8908ab75ceeabd37cf |
| documentation/planning/BUSINESS_OPERATIONS.md | 154371613be782bf5b31b7d0ae43a360a51b5f972dd66391041d8bc996cd6e5e |
| src1/modules/middleware/auth.ts | db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2 |
| src1/modules/pharmacies/model/index.ts | beda95d89a9773a8d5851dd923c363c83123a573f7391836dec69b13e5cfa177 |
| src1/modules/pharmacyInventory/model/index.ts | 098fc86bc14e553b60a81fdb7bf33ebacb8c44f799a2cb665420ea5debe52313 |
| src1/modules/pharmacyInventory/validation/index.ts | f1679413efcd27621a362eda7277a3d0db3edceb8d30fc2c542c075bef8dec53 |
| src1/modules/pharmacyCustomers/model/index.ts | ffccd5f52425e71fa92ec1677bd91c0d300f7e1ac653950a9b595969d87c3fbd |
| src1/modules/pharmacyCustomers/repository/index.ts | 459e70335eddb24607336b1659d769e17b7d639518b6560b34236f4c8f450322 |
| src1/modules/common/repository/BaseRepository.ts | 14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a |
| src1/modules/common/middleware/validation.ts | 8be55cee7485531491ff095ed1d9f36af443987690f22d04dd67ef9318a0a5ef |
| src1/routes/index.ts | 50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056 |
