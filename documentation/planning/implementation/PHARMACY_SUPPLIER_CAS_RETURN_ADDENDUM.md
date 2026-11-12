# Supplier CAS result projection — R10-F2-1

Root authors this narrow amendment to the approved supplier master contract c47d541e60747f262e6828b912b2016c61c1e2b2f5a4dfcffc1f4bee8b4157b7. Current repository SHA-256 is8834a635fcc5835a26c6f423e4a2deffc433435ea11549f51c9368de7f7537c8. Two independent nonauthor implementation-only decisions precede the change; two source decisions precede merge. Genuine Opus R10 identified the issue as LOW R10-F2-1.

Only src1/modules/pharmacySuppliers/repository/index.ts changes. In BOTH existing active update/archive findOneAndUpdate option objects, retain new:true, upsert:false, runValidators:true and add projection:supplierProjection, maxTimeMS:2000. Reuse the existing projection object; introduce no helper, DTO/schema/API/actor/filter/update/revision/replay change. Every byte outside those two option additions remains unchanged.

The pre-read already projects the supported fifteen fields. An unrelated raw stored extension currently survives the update, then makes exact-shape DTO validation reject the unprojected result after the write. Return projection consistently excludes that extension while leaving it untouched in storage. Malformed projected required fields still fail existing validation. Final CAS misses and valid archive replay retain existing behavior.

This adds a server execution budget, not cancellation or exactly-once mutation. Timeout/lost-response outcomes can remain ambiguous; no automatic retry or claim of zero committed writes follows. No read capacity/index improvement is claimed; R10-F2-2 remains open. Focused verification must cover real ODM/driver projection behavior, both mutations with a stored extension, exact DTO, malformed supported fields, stale CAS, stable archived replay and timeout ambiguity under a separately owned fixture. Static source comparison alone is not those results.

Only source implementation is proposed. No compiler/app/model/fixture/DB/provider invocation, dependency/start edit, production adoption, client/finance/owner acceptance, deployment or release is admitted. Preserve original staged six, handover, all other branches and prior R10 review evidence.
