# Selected-index readiness: read-only preparation

11 November 2026, integrationbac46d306a5f989c1eafcab5c40d4ce6fdd06e1d.
Native explorer /root/backend_boot_path inspected actual startup/index sources,
graph symbols/callers and governing F13 design. It changed no file and executed
no application/compiler/package/database/Docker/client. Graph atbfb608e is stale;
actual source pins in source-inputs.json govern. This is discovery, not a reviewed
slice contract, implementation or execution authority.

connectDB disables autoCreate/autoIndex only inproduction and checks no index
readiness. src1/index.ts asynchronously starts connect/backfill/schedulers and
listens separately. /health is unconditional200. src1/scripts/syncIndexes.ts
imports all models, reads CONFIG/connects, creates collections and calls destructive
model.syncIndexes(), executes immediately and acknowledges dropped indexes. Do
not import/reuse that script for read-only readiness. No existing listIndexes
comparison was found in src1/tests.

SYSTEM_DESIGN section13 requires separate create-only migration/conflict/duplicate
preflight and read-only required-index readiness, blocking affected writers on
absence/mismatch; no destructive startup reconciliation. ROADMAP F13 additionally
requires wallet-effect and pharmacy+medicine uniqueness, outside the selected
fixture scope. Workflow requires a frozen bounded contract/two independent
reviews before implementation; root adoption still needs C2 and actual application
or extracted-method execution still needs complete pre-import C3 admission.

A smallest concrete next contract can implement a dependency-free pure predicate
comparing a supplied selected manifest with supplied per-collection index
observations. It performs NO connection/model/config/file discovery, mutation,
data scan, repair, index creation/drop, startup/writer/health activation or target
adoption. Freeze key order/direction, unique/sparse/TTL/partial/collation semantics,
allowed server metadata, harmless extra-index behavior, malformed/duplicate/
failed/incomplete observations, bounded shapes and safe refusal codes. No financial,
clinical or new-index policy is selected. This may be prepared now independently
of withheld server facts; source implementation still waits its two reviews.
Actual app-source import/evaluation is not silently recategorized as a source
check: plan its tests inside a separately reviewed complete owned C3 extension,
or establish an explicitly reviewed no-effect admission before any pure import.
A read-only source-data checker is not behavioral predicate proof.

The current thirteen-model fixture manifest selects eight explicit indexes plus
Mongo default_id: users.corporateEmail unique+sparse; hrs.employeeId unique;
pharmacies.phone unique; OTP.expireAt TTL0; wallets.userId unique;
wallettransactions ordered four-field unique partial pharmacy_order-refund key;
notifications.idempotencyKey unique/string partial; fcmtokens.token unique.
Five other admitted collections have only selected default_id requirements.
User.referralCode unique+sparse exists in its schema but is not selected here.
PharmacyInventory pharmacyId+medicineId uniqueness is outside the13 admitted
models. The wallet partial index covers only pharmacy-order refunds. Do not claim
selected-manifest observation as all production-index/wallet/stock/F13 readiness.

Meaningful predicate tests: complete positive observation; independently remove
every required index; wrong ordered key/direction; uniqueness/sparse/TTL/partial/
collation drift; wrong collection/case; incomplete/failed listings; malformed or
duplicate inputs; harmless extras unchanged; immutable inputs; zero native or
mutation effects; weakened actual predicates rejected. A later admitted adapter
may ONLY listIndexes against the derived owned namespace and compare actual
metadata before fixture writers, preserving every prior API group/variant and
profile/grant. Missing/mismatched observations must refuse. Whether negative
observations are derived copies or actual absent metadata must be labeled
honestly; no destructive index test is implied. New actual invocation requires
fresh exact preparation/artifact/two-reviewer receipt, not a consumed60/17 recipe.

Full F13 requires its complete approved production manifests, duplicate/conflict
resolution, affected-writer/readiness integration and applicable C2/data-owner/
startup/runtime acceptance. Those are separate from this candidate library.
