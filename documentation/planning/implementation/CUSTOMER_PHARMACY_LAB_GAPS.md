# Initial source readiness audit, 12 November 2026

Baseline:7df9121440813dec14cd4c57d347ee20982c3ec7. Three independent discovery workers, INTERNAL_CODEX_NATIVE provenance: `/root/focus_customer_audit`, `/root/focus_pharmacy_audit`, `/root/focus_lab_audit`. They wrote no source or evidence, executed no application/tests/packages/providers and made no network calls. The graph indexes originalbfb608e; it was navigation only. Findings were checked in the restored baseline's actual files. This is source discovery, not two implementation approvals or module acceptance. Paths are relative to the durable focus worktree.

## Customer

| Finding | Source and impact | Next boundary |
| --- | --- | --- |
| Booking detail/by-user reads use optional caller ownership | `src1/modules/bookings/controller/index.ts:231`,`:354`; service`:1233`. Other customers' booking identifiers are not mandatorily bound to signed customer ownership. List scoping does not establish detail scoping. | First ready contract: signed own-customer reads on detail/by-user endpoints; reject foreign owner parameters, preserve own404 and explicitly unchanged noncustomer semantics. Two contract reviews before edits; actual two-customer fixture before behavioral acceptance. |
| Generic booking writes allow privileged fields | Controller`:328`; validation`:366`; service`:1525`. Caller data can include payment, lifecycle and clinical fields. Fixing ownership alone is insufficient. | Separate actor/field/state contract; finance/clinical decisions remain explicit. |
| Contact updates lack destination proof | `user/validation/index.ts:68`; service`:115`; repository`:28`. Existing access containment does not close contact pre-hijacking or credential revocation. | Identity/contact-change/recovery contract. |
| Identity/consent/client completeness missing | `CAPABILITY_MATRIX.md:G02–G03`; transition record. Existing user/dependent/address code is reuse, not permanent patient/no-phone identity, caregiver consent or tested clients. `API_SCHEMAS.md` still describes obsolete OTP default123456. | Original-requirement mapping, verified contact/caregiver rules, source/client inventory and documentation reconciliation. |

Existing OTP consumption, own-user/dependent/address/notification and selected commerce paths must be reused, with their exact existing evidence retained. No claim that all customer functionality is missing.

## Pharmacy

| Finding | Source and impact | Next boundary |
| --- | --- | --- |
| Prescription approval absent from fulfilment gate | `src1/modules/pharmacyOrders/services/index.ts:462`,`:979`; model`:118`. Attachment presence/pending enum do not authorize dispensing. | Qualified prescription-review/dispensing command contract; TC-PHA-001/TC-REV-007 evidence. Do not invent approval policy. |
| Paid seller cancellation lacks tracked refund obligation/safe refusal | `pharmacyOrders/services/index.ts:1027`. Status/stock changes are not evidence of money recovery. | Explicit paid-cancel/refund contract and TC-REV-005; wallet credit remains distinct from gateway refund. |
| Aggregate/manual and batch/order stock writers differ | `pharmacyInventory/repository/index.ts:138`,`:749`; service`:469`,`:538`. Manual aggregate reserve and compensating writes do not prove per-lot quality/conservation or rollback. | Preserve old representations; contract all writer/session paths before stock race acceptance. |
| Existing narrow quality/restriction fixes await runtime proof | Medicine controller`:93`,service`:91`; inventory repository`:111`,`:208`. Source composition is reviewed, not ODM/session/HTTP acceptance. | Recover committed closed-fixture work and missing uncommitted corrections with provenance; finish bounded evidence without rerunning consumed recipes. |

Reuse profiles/catalogue/cart server-price validation, transactional order reservation, FEFO release/consumption and existing payment confirmation/recovery. Full original scope still requires direct/counter retail, approved wholesale, POS/receipts/shift close, purchases, returns/recalls and staff permissions; do not describe all as implemented.

## Labs

| Finding | Source and impact | Next boundary |
| --- | --- | --- |
| Unauthenticated callbacks can reach refund effects | `src1/routes/index.ts:102`; `webhooks/routes/index.ts:11`; service`:23`; `externalBookings/services/index.ts:3203`. Provider ID lookup is not integration-scoped; durable event/order fence not established. | Actual provider authentication/event/idempotency contract plus atomic money effects. No universal invented HMAC or live probe. |
| Clinical files public; corrected reports overwrite | Routes`:54`; `file/controller/index.ts:131`,`:180`; external service`:2923`,`:2984`,`:3033`. One-year public cache and stable filenames bypass metadata ownership checks and lose prior bytes. | Private document-access compatibility and immutable scoped versions; clinician/privacy/signatory release facts remain owner decisions. |
| Individual lab booking accepts untrusted association/dependent input | External controller`:376`,`:448`; service`:742`,`:1730`; validation`:191`. Body corporate association can affect coupon context; dependent ownership not established. | Small ready containment contract: remove nonadmin body-association fallback while retaining trusted actor/admin behavior. This prevents fabricated affiliation in individual checkout; it is not corporate expansion. Separate dependent/patient-authority contract. |
| Panel/sample/direct-business workflow incomplete | ROADMAP U4; CAPABILITY_MATRIX D05–D08. Provider status projections do not supply assigned lab staff/signatory, specimen/recollection lineage, direct billing or supply control. | API and panel journeys both required; eight existing LAB scenarios in `documentation/planning/qa/TEST_SCENARIOS.md:120` provide acceptance inputs. |

Reuse existing lab discovery, serviceability/slots, actor-bound create/list/cancel/report primitives and confirmation-pending recovery. Source facts do not establish provider integration, correct refund accounting, private report bytes or LAB acceptance.

## Immediate work order

1. Freeze small customer booking-read and individual-lab association-containment contracts independently, plus required provider/report/money decision packets. Root owns shared booking/payment/document interfaces; no colliding domain writers.
2. Recover the already committed pharmacy fixture sources; preserve prior failed source/runtime evidence, record missing uncommitted artifacts and review reconstruction. New artifact/runtime attempts need exact fresh gates.
3. Implement decision-free contracts after two actual independent decisions; collect admitted source and behavioral evidence separately. Keep clinical/payment policies blocked only where they are actually needed and advance unrelated ready work.
4. Build complete requirement-to-source/client/test/owner coverage for the three original-scope modules; the tables here are high-risk discovery, not an exhaustive completed coverage matrix or an eight-week commitment.
