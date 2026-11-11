# Medicine PUT prescription restriction: bounded source contract

11 November 2026. ROOT CONTRACT CANDIDATE; two independent direct internal
technical implementation-only decisions required before source edit. No runtime
admission. Others share this repository; preserve all edits, six staged files,
eleven handover files, approvals, failures and prior results. Root owns Git,
integration, final contracts and evidence. No root dependency/runtime/build/start,
provider, deployment, secrets, live data or external account action.

Approved policy: documentation/planning/M0_IMPLEMENTATION_APPROVAL.md, current
command authority table catalogue/stock and stable422 migration rule;
documentation/planning/SYSTEM_DESIGN.md AR26 and AR27/31;
documentation/planning/PRINCIPAL_REVIEW_DISPOSITION.md Review-B PA07/PA09/PA20;
documentation/planning/qa/TEST_SCENARIOS.md TC-REV-006. Current actor/field policy
already exists; these slices enforce it without selecting new clinical release,
price, tax, units, race, idempotency, ownership or finance policy.

Only source-data checks (Python/JSON/source bytes/diffs) are admitted. No domain,
Joi, TS, extracted/copied application helper, parser/compiler, app/server, DB,
Docker, provider or model/auth execution. Baseline rejection before source edit,
exact whole-file transform/scope and meaningful weakened-source sensitivity
controls must be retained. Scope must survive commits: explicit exact non-QA
file union and owned QA paths, no precommit/untracked-file assumption. Never
claim source text controls prove behavior or types. Complete later C3 must cover
actual route/service/ODM/provider/model closure before real application tests.

After implementation, freeze exact source/QA/check commands and obtain independent
Standards and Spec nonauthor source reviews; fix material findings and have both
confirm final bytes. Commit coherent bounded result and update progress with
SOURCE_ONLY limitation. No mutation of the original115 register, false PASS,
whole M0/Week2/C2, supported-client, human owner, production or release claim.
The currently accepted83/27 fixture and pending specialist90/33 do not import
these modules; neither supplies clinical/catalogue/inventory runtime evidence.

## Exact source and trusted authority

Baseline1355bd9af2c9d8d5170527c8c0fc565de997b6fe. Own ONLY
src1/modules/pharmacyMedicines/controller/index.ts and
src1/modules/pharmacyMedicines/services/index.ts plus new
output/qa/week2-medicine-prescription-source/. No schema/router/model/type/client,
fixture, root/start or generated file changes. Existing controller imports
AuthRequest and service imports AppError already; add no import/dependency.

Change only controller update signature Request→AuthRequest and its update call
to pass optional third scalar req.user?.userType. Never use body/query/header/
params as authority. Keep data from req.body and response status/envelope exact.
Change only MedicineService.update signature to an optional third actorUserType?:
string and insert an own-field denial AFTER the existing findById/404 block and
BEFORE name normalization, uniqueness work, data mutation or repository.update.
No new lookup. Use null/non-object safe own-presence of prescriptionRequired,
not truthiness or value comparison. If that key is own and actorUserType is not
exact 'admin', throw AppError status422, code FORBIDDEN_FIELD, message
'Medicine prescription requirement cannot be updated by this actor'. Undefined/
unknown service actor cannot authorize a protected update. Admin may continue
existing prescriptionRequired updates. Ordinary two-argument and pharmacy
updates without this field retain exactly their previous path, reads, writes,
name normalization, duplicate checks, errors and response. Missing medicine
still404 MEDICINE_NOT_FOUND before denial; Joi-invalid HTTP body remains400
before service. Valid false/true, converted stringfalse/stringtrue, unchanged
values and protected+ordinary mixed fields are all presence-denied for pharmacy.
Own undefined is a direct-service SOURCE_ONLY case, not representable by JSON.
Inherited-key behavior is unchanged. No actor/body mutation or success filtering.

Actual only discovered update caller is MedicineController.update:93–95; legacy
MedicineService test construction covers delete, not update. No supported current
client evidence was found; release/client compatibility remains unproved.

Existing POST permits admin or operational pharmacy creation of master rows.
That broader catalogue-creation authority and other shared fields remain open;
this bounded PUT restriction does not claim full AR26 or prevent all possible
regulatory misuse. Internal imports/generation/create/delete/local offer/price
paths stay exact. Their future containment is a separate reviewed contract.

Required future real cases: pharmacy present-target key false/true/converted/
unchanged/mixed denial with one lookup, zero writes/normalization/provider/JWT;
absent target404 for valid key/ordinary payload; invalid known key400 beforelookup;
admin protected+ordinary success; ordinary pharmacy and internal two-arg success;
unknown/undefined direct actor protected denial; request-selected fake authority
never authorizes; all other rows/collections untouched and positive controls.
These are NOT_RUN until complete C3 admission. Source checker must distinguish
unforwarded or body-selected role, admin bypass missing, truthy/unchanged bypass,
lookup removed, guard after normalization/write, removed own-presence, and any
out-of-scope source change. No extracted business execution on host.
