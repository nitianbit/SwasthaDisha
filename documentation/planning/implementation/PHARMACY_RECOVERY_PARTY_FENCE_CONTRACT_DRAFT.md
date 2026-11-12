# Pharmacy recovery party fence — preimplementation contract draft

12 November 2026. Author internal Codex `/root/booking_write_contract`. PREPARATION ONLY. Baseline focus HEAD `6543dc9bd7220db43f1de780e2c6ac455dcf0f1e` (accepted R8 capture); production source is unchanged from prepared HEAD `dbe1cc2d972876876c422cf7af1b194037542575` and R8 snapshot `258ec457c3bda0b95eea9e8838507e09ae08ef30`. Root Standards and independent payment-agent Spec decisions on exact final bytes are required before isolated source implementation. The author cannot supply either decision. No source, compiler, application, database, provider, model or test execution is authorized here.

## Accepted problem and bounded repair

Genuine R8 finding R8-F2-1 is an OPEN activation gate. An owning pharmacy can change the customer of an otherwise editable order after recovery intake. The retained marker then binds a different customer: the original customer loses access, the new customer receives503, and an owning-pharmacy worklist page containing it fails closed. The unchanged generic update also copies all three party fields from its pre-read into every update payload, allowing a stale notes-only command to overwrite a concurrent party change.

Root selects a narrow existing-writer repair: presence of a party command (`customerId`, `buyerPharmacyId`, `orderType`) is locked after any recovery marker exists; final party writes atomically require marker absence; every final generic update is scoped to the mandatory owning pharmacy and scalar stored identity. Omitted party fields must never be copied back. A customer-preimage predicate alone cannot fence intake because intake changes the marker, not the customer. No marker repair/deletion/rebinding, new cancellation, clinical or financial policy is introduced.

Graph discovery used project `swasthadisha`; its indexed update lines785–977 are stale. Exact current service update lines870–1090, transaction helper246–267, lean BaseRepository and customer ensureLinked145–169 control this contract. SYSTEM_DESIGN AR-26 and existing Rx-commerce restrictions remain; commercial customer association is not patient consent, funded-payer identity or refund authority. Existing recovery intake/worklist contracts are amended only by this writer fence; their source/DTO/digests stay unchanged.

## Source ownership and existing boundary

Future production edit: **only** `src1/modules/pharmacyOrders/services/index.ts`, necessary `Types` import plus `update` method changes. Reuse existing `BaseRepository.update(query,data,{new:true,session})`; no repository/model/type/router/Joi/auth, shared transaction helper, inventory/payment/customer-link implementation or index change. No raw request filter/options, generic framework, version field, collection, provider operation or new dependency.

PUT `/api/v1/pharmacy-orders/:id` keeps authenticate → requireOperationalPharmacy → existing idParam Joi → existing update-body Joi → controller/service. Admin, user and buyer-pharmacy roles gain no bypass; existing operational checks retain their precedence/effects. HTTP malformed ID/body remains existing400 VALIDATION_ERROR before the service. Successful response remains200 `{success:true,message:'Order updated',data:updatedOrder}` with the existing full-order shape. No new privacy/full-order-read claim.

## Exact validation and error order

For direct `update(id,pharmacyId,data)` calls, add a primitive string24hex ID guard before the first query: accept `[0-9a-fA-F]{24}` without trim/coercion and return400 `VALIDATION_ERROR` / `Invalid pharmacy order ID` otherwise. This changes malformed direct calls from model-dependent casting/lookup to bounded rejection; route-admitted ID behavior, including uppercase casting, is retained. Do not use undefined/object selectors or an ObjectId constructor before validating this mandatory argument.

Then preserve this order:

1. Exactly one existing `orderRepo.findById(id)`. No row:404 `ORDER_NOT_FOUND` / `Order not found`.
2. Owning scope: require primitive string24hex pharmacyId and retain existing exact `String(order.pharmacyId) === pharmacyId` comparison; otherwise403 `FORBIDDEN` / `Access denied`. No trim, lowercase normalization, optional scope, administrator or customer fallback. Thus the old uppercase-owner comparison behavior is retained; a malformed supplied owner never reaches a final selector. This pre-read is not a new scalar-storage proof.
3. Existing terminal status branch:400 `ORDER_TERMINAL` / `Cannot update a completed/cancelled order`.
4. Determine party-command presence by `Object.prototype.hasOwnProperty.call(data,key)` for each exact three-key set. Any own key counts, even unchanged echoes, null or explicit undefined in a direct call. Inherited names do not count as supplied commands. Determine marker presence by the same own-property test on the lean pre-read order. Own null, undefined, malformed and unknown-version markers all count; no receipt validator, truthiness, digest or customer comparison can unlock them. If both presences are true:409 `ORDER_RECOVERY_PARTY_LOCKED` / `Order party details are locked after a recovery request`.
5. Continue the existing financial-field detection and `ORDER_FINANCIALS_LOCKED`409 unchanged. For a party command with a marker, new party409 precedes this old financial409; notes/nonparty commands still receive their existing errors.
6. All existing commerce/Rx/catalogue, recurring, validateOrderParty, linked-reference, ensureLinkedOrderAllowed, pricing/discount/prescription and ensureLinked ordering remains. The new marker denial precedes all these calls, session allocation and inventory effects. No early full-order Rx check is added to notes-only updates.

The typed/Joi body contract is retained; this slice does not add a generic direct-call body/descriptor normalizer or redefine malformed nonparty payload behavior.

## Payload and atomic final predicate

Continue calculating nextCustomerId/nextBuyerPharmacyId/nextOrderType for the existing validations, pricing, linkage and recurring logic. Build the update payload from the existing supplied data but **include each party field only when that exact key is own-supplied**. For an own-supplied field retain its existing computed next-value semantics. Omitted customerId, buyerPharmacyId and orderType must be absent from the final payload, even on notes-only or items-only updates; never synthesize an unset/default or echo the snapshot. Existing repricing/totals/item-allocation payload additions remain unchanged. No recoveryRequest field is added to the request schema or writable payload.

Construct one internal literal filter from validated scalar arguments, using actual `Types.ObjectId` values after validation:

```ts
{
  _id: new Types.ObjectId(id),
  pharmacyId: { $eq: new Types.ObjectId(pharmacyId) },
  $expr: { $and: [
    { $eq: [{ $type: '$_id' }, 'objectId'] },
    { $eq: [{ $type: '$pharmacyId' }, 'objectId'] },
  ] },
  // Add exactly when an own party command is present:
  recoveryRequest: { $exists: false },
}
```

For nonparty commands omit only the marker predicate; owner/scalar predicates remain mandatory. No `$in`, omitted/undefined owner, request filter spread, upsert, ownerless retry or read-then-unscoped fallback. Literal ObjectId equality plus the expression prevents a dirty owner array from matching as membership. The pre-read String comparison can still admit a dirty single-element owner array; this slice promises the final-write fence, not zero earlier effects for dirty storage.

Inside the **existing** `runOrderInventoryTransaction` callback, keep reservation-release/re-reservation or legacy delta sequencing, await exactly one `orderRepo.update(filter,updatePayload,{new:true,session})`, and check its result **before returning from that callback**. A null/missing result throws409 `ORDER_UPDATE_CONFLICT` / `Order changed before the update could be completed`. The old after-callback500 `UPDATE_FAILED` / `Failed to update order` branch is replaced by this in-callback conflict. Do not return null normally and check it after withTransaction: inventory could commit first. Driver/database errors propagate unchanged; no catch-as-success, manual retry/read, secondary update or compensation is added. Normal driver withTransaction callback retries remain existing behavior, not a promise of one physical database attempt.

On callback success preserve subsequent recurring subscription synchronization and returned order behavior. On final conflict no subscription synchronization is reached. Existing transaction helper, startSession/endSession/finally and other callers are byte-preserved; its broader retry/commit-observation weaknesses are not repaired or certified here.

## Effects, races and retained uncertainty

A marker visible at pre-read plus a party command gives the new409 after one order read and before catalogue/link/session/inventory/subscription effects. An absent marker at pre-read is not admission to overwrite a later marker: the final marker-absence predicate must still hold atomically. If intake commits first, the party mutation cannot commit against that marker. If party reassignment commits first, the old customer's existing scoped intake must fail/retry according to its own snapshot/ownership contract; a later request by the current customer binds the current association. Actual MongoDB/driver behavior remains unproved.

A nonparty command remains eligible after marker creation subject to all existing gates. A stale notes-only command must never restore old customer/buyer/orderType values after a competing party writer; it may still use old snapshot values for existing validations and subscription decisions. Concurrent party-versus-party, items/pricing/status/payment/reference/custody/revocation races and stale catalogue facts remain open: there is no universal version/CAS fence. This contract does not freeze all notes or add blanket recovery locking to nonparty fields.

`customerService.ensureLinked` runs **outside** the inventory callback. A valid new-customer link may be saved before a later marker/owner conflict, driver error or transaction abort; no link removal or rollback is introduced. Same-session stock/order rollback is an intended consequence of throwing inside the callback and needs real evidence. No whole-operation atomicity, zero-effect conflict, exactly-once inventory or repaired customer-link consent is claimed. Existing inconsistent markers remain fail-closed and need separately authorized accountable recovery; do not delete/re-key them.

## Required focused evidence before activation

Preparation/source reviews may use bounded data/source inspection only. Future complete pre-import C3 must admit actual route/service/Mongoose/session/inventory dependencies and measure these cases; no legacy integration execution follows from this document:

- Existing auth/operational/Joi precedence; direct invalid-ID no-query400; missing404 before owner403; foreign/malformed scope403 before terminal/marker; terminal400 before new409; own marker + each party key (including same-value echo) new409 before old financial/Rx errors and zero downstream-call counters.
- Absent marker permits existing valid customer/buyer/orderType edits. Own null/malformed/undefined marker locks; no inherited/truthy shortcut. Existing nonparty/notes behavior remains useful, and final nonparty predicate contains no marker-absence condition.
- Independently inspect actual final filter and payload: mandatory literal pharmacy and scalar ObjectId guards on all writes; marker absence only on own-party commands; omitted party keys absent on notes/items-only payloads; no ownerless fallback. Dirty array/string/null/missing stored pharmacy owners cannot produce a successful final mutation; clean owned row succeeds. Measure any earlier permitted effects honestly.
- Race barrier after pre-read: intake wins before party final write →409 and marker/customer unchanged; party wins before old-customer intake → existing scoped denial/retry behavior, never a mismatched new marker. Include unchanged party echo as a command. Existing marker receipt/digests and closed worklist DTO remain exact; unrelated pages stay available. Do not repair an already inconsistent row during the test.
- Stale notes race: pre-read customer A; another permitted writer reassigns to B; original notes-only final write preserves B and its orderType/buyer fields. Repeat with marker creation, items-only payload and omitted optional party fields. Assert payload keys and resulting state, not just response status.
- Force the final update miss after both existing batch reservation and legacy-delta branches:409 must originate within the callback; order/stock transactional changes roll back under the same real session. Record actual session identities, abort/commit/retry behavior. Assert no post-conflict subscription call. Also force database errors and preserve their identity.
- New customer link counter on a late final conflict: link may persist outside the transaction while stock/order do not commit. This expected residual must be retained, not asserted zero or cleaned by a new side effect. Later accountable link/consent policy remains separate.
- Actual-source controls removing owner/scalar/marker predicate, using marker truthiness, echoing omitted party fields, or moving null-result detection outside the callback must fail their intended behavioral assertion. Hash rejection/source regex alone is not race or rollback proof.

No current type/HTTP/Joi/driver/transaction/race/rollback/provider result. Existing Rx gate/pricing/cancel/status/markPaid/payment/timeout/intake/list/worklist source is preserved apart from this exact update method boundary; F1 HIGH, F5-1 MEDIUM, capacity/index, protected clinical/finance/privacy/security/named-owner, C2/C3/client/module/M0/release gates remain open. Final cross-module integration and corporate/HR/hospital expansion remain deferred. Original six staged files and handover archive remain protected; no source merge, push or deployment is admitted.

## Exact preparation pins

These are selected static inputs, not an executable dependency closure. Rebind before implementation; preserve R8 capture/source and other workers' bytes. Future source freeze must prove only the service import/update delta and byte identity of every other service method plus the following other inputs.

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `src1/modules/pharmacyOrders/services/index.ts` | 46313 | `83ca486a250403a777f0548ec57c98bd1e99e154b6f2034754ddc9aedbc3f35e` |
| `src1/modules/pharmacyOrders/repository/index.ts` | 16516 | `df77e35abeb00913d6353e0bf76a3651b3a1b78b6e669548439472347c4b084f` |
| `src1/modules/pharmacyOrders/model/index.ts` | 7068 | `f054a220020c66a83c49ea8658bd0d002cb3a9fd28c9b7771b0584c53471ac14` |
| `src1/modules/pharmacyOrders/types/index.ts` | 6604 | `6f3c1171b5ab154bc566ec7dcedaf3da4cd614d1bb7402fa5534b7a5e575e423` |
| `src1/modules/pharmacyOrders/routes/index.ts` | 2244 | `cfb13044228699be2fa37ce9635dcaf9f5874e3fe2ce02eeb846407be0e088fe` |
| `src1/modules/pharmacyOrders/controller/index.ts` | 5386 | `e1cca25dc7c45fd2048f014c6b47191cda1044eca8b8f4cf5c9f061c3d2a3446` |
| `src1/modules/pharmacyOrders/validation/index.ts` | 5083 | `70381b52ca88dc35782850f662423ee423dbaebe67122641c1219fdee8f84402` |
| `src1/modules/common/repository/BaseRepository.ts` | 2494 | `14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a` |
| `src1/modules/pharmacyCustomers/services/index.ts` | 5248 | `ab1cc1893fc2c8e3c369120ae6f5d9393c30a0ecb1a7f59d0c6ca80165e8e386` |
| `src1/modules/pharmacyInventory/services/index.ts` | 22959 | `98fa27296ef0fdd1066dff2d548de7d3db025504e724432770fe2e49d2907894` |
| `src1/modules/pharmacyInventory/repository/index.ts` | 33797 | `cee64fd2464b5d5ac6081531a63f9a176e5fc481f33c3a4d6def99a26d97b261` |
| `src1/modules/pharmacyOrders/prescriptionCommerce.ts` | 3078 | `8e6db5fc64d5a5b2fec6437660fb0d308c24d3e1c0aec2ae95efdc2f73fe0058` |
| `src1/modules/middleware/auth.ts` | 8706 | `db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2` |
| `documentation/planning/implementation/PHARMACY_CANCELLATION_RECOVERY_CONTRACT_DRAFT.md` | 21510 | `e43bb8170b644cdc93ceeae9d8f66e8abb739f1cb35079e1076147aa88b4e910` |
| `documentation/planning/implementation/PHARMACY_RECOVERY_WORKLIST_CONTRACT_DRAFT.md` | 10581 | `0d5e215e4376987e7b5d33114d243685cb5c1ee3302e69ceef4dc167cd7b8b86` |
| `output/qa/customer-pharmacy-lab-claude-review/revision-8/operator/CLAUDE_REVIEW_8.md` | 34333 | `5eaf50279e150016781dde05c27c1ee2520f8a724f65360febbce2a0b1c44188` |
| `output/qa/customer-pharmacy-lab-claude-review/revision-8/operator/FINDING_DISPOSITIONS_8.md` | 3447 | `ff88b0e0eaae87909f8b143687456041a7415b687869dcf64e85a983c2074f8d` |
