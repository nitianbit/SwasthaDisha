# Pharmacy Module Issues And Solutions

This review covers the pharmacy-facing code paths under `src1/modules/pharmacy*`, `src1/modules/pharmacies`, and the connected payment/order flows. The main theme is that several code paths are meant to "just add or update an object", but they use first-write or multi-step patterns that can behave like duplicate creation under concurrency or first-time collection/index initialization.

## 1. Wallet read was creating wallet data

**Status:** Fixed in this working tree.

**Where**

- `src1/modules/pharmacyWallet/controller/index.ts`
- `src1/modules/pharmacyWallet/services/index.ts`
- `src1/modules/pharmacyWallet/repository/index.ts`
- `src1/modules/pharmacyWallet/model/index.ts`

**Problem**

Earlier, `GET /api/v1/pharmacy-wallet` created a wallet for pharmacy users when the wallet did not exist. That means a simple read could trigger the first write to the `pharmacywallets` collection. If the collection or index was being initialized at the same time, it could surface as a "cannot create collection / already exists" style error.

The old create flow was also `findByPharmacy()` followed by `save()`, which can race if two requests hit the same pharmacy wallet at the same time.

**Solution Applied**

- `GET /pharmacy-wallet` now reads only and passes `createIfMissing = false`.
- `getOrCreateWallet()` now uses a single atomic `findOneAndUpdate(..., { upsert: true })`.
- Wallet schemas now set `autoCreate: false` so Mongoose does not eagerly issue collection creation during model initialization.

**Recommended Follow-Up**

Add an explicit startup/admin migration command for indexes/collections instead of relying on Mongoose first-use behavior in request flow.

## 2. Cart first add can race and cause duplicate create/lost update

**Status:** Not fixed yet. Needs code change.

**Where**

- `src1/modules/pharmacyCart/services/index.ts`
- `src1/modules/pharmacyCart/repository/index.ts`
- `src1/modules/pharmacyCart/model/index.ts`

**Problem**

`addItem()` does:

1. Find existing cart by `{ actorId, actorRole }`.
2. Build the next `items` array in memory.
3. If no cart exists, call `save()`.

The model has a unique index on `{ actorId, actorRole }`. If two `addItem` requests arrive together for the same user/pharmacy and no cart exists yet, both can see no cart and both can try to insert. One request can fail with a duplicate-key error. Under some first-use conditions, Mongoose/Mongo can also surface collection/index creation errors.

There is also a lost-update risk: two quick adds to different medicines can each read the same old cart, build separate item arrays, and the last write wins.

**Solution**

Replace the `find -> save/update` flow with an atomic update strategy. Best options:

- Use a Mongo transaction for `find + validate + update` and retry duplicate key races.
- Or use one repository method that performs `findOneAndUpdate` with `{ upsert: true, new: true }`, then recomputes based on latest state.
- For item quantity changes, prefer a pipeline update or retry loop so the service always reads the latest cart before writing.

**Suggested Repository Method**

```ts
async upsertCart(
  actorId: string,
  actorRole: PharmacyCartActorRole,
  data: Pick<IPharmacyCart, 'pharmacyId' | 'items' | 'subtotal'>
): Promise<IPharmacyCart> {
  return PharmacyCartModel.findOneAndUpdate(
    { actorId, actorRole },
    {
      $set: data,
      $setOnInsert: { actorId, actorRole },
    },
    { new: true, upsert: true }
  ).lean();
}
```

For strongest correctness, wrap the read/compute/write in a transaction or add a retry around duplicate key error `11000`.

## 3. Inventory save has the same find-then-save race

**Status:** Not fixed yet. Needs code change.

**Where**

- `src1/modules/pharmacyInventory/services/index.ts`
- `src1/modules/pharmacyInventory/repository/index.ts`
- `src1/modules/pharmacyInventory/model/index.ts`

**Problem**

`saveItem()` checks for an existing inventory item by `{ pharmacyId, medicineId }`. If none exists, it inserts. The model has a unique index on the same pair.

Parallel requests for the same pharmacy and medicine can both see no record and both attempt insert. One can fail with duplicate key. This is the same pattern as cart and wallet.

There is also a quantity issue: for existing inventory, the code computes `nextAvailableQty = existing.availableQty + quantityDelta` in application memory. Two concurrent updates can overwrite each other instead of safely incrementing.

**Solution**

Use atomic `findOneAndUpdate` with `$inc` for quantity and `$setOnInsert` for first creation.

Recommended behavior:

- On create/upsert: `{ pharmacyId, medicineId }` as the filter.
- `$inc: { availableQty: quantityDelta }` for quantity changes.
- `$set` for price, rack, batch, threshold, expiry, and `isActive`.
- `$setOnInsert` for `reservedQty: 0`, `freeQty: 0`, `pharmacyId`, `medicineId`.
- Use `{ upsert: true, new: true }`.

This makes "add inventory object" behave as one DB operation instead of a read followed by a separate write.

## 4. Inventory import silently hides row failures

**Status:** Not fixed yet. Needs code change.

**Where**

- `src1/modules/pharmacyInventoryImports/services/index.ts`

**Problem**

During `commit()`, each row is processed inside `try/catch`, but caught errors are ignored. The import is still marked `committed`, and only `committedRows` is stored.

This means duplicate key errors, validation failures, or collection/index problems can be hidden from the API response. The user sees an import committed while some rows were not actually inserted/updated.

**Solution**

Track row failures and persist them on the import record.

Recommended behavior:

- Add `failedRows` and `commitErrors` to the import result/model.
- Do not mark as fully `committed` if failures occurred.
- Use statuses like `committed`, `partially_committed`, and `failed`.
- Replace the row-level find-then-save inventory logic with the same atomic inventory upsert from Issue 3.

## 5. Pharmacy order creation writes order before stock/payment side effects

**Status:** Partially handled with manual rollback, but still risky.

**Where**

- `src1/modules/pharmacyOrders/services/index.ts`

**Problem**

Order creation currently:

1. Saves the pharmacy order.
2. Consumes inventory.
3. Creates a payment record or Razorpay order.
4. Updates the order with payment data.
5. Attempts manual rollback if later steps fail.

The manual rollback is useful, but it is not as reliable as a transaction for DB-only work. If inventory consumption succeeds and cleanup fails, the system can be left with incorrect stock or an orphaned order.

External payment provider calls cannot be inside a Mongo transaction, but order creation plus inventory mutation can be.

**Solution**

Split the flow:

- Use a Mongo transaction for internal DB work: create order and consume inventory together.
- Commit DB transaction.
- Create Razorpay/payment order after DB commit.
- If external payment creation fails, mark the order `payment_failed` or `abandoned_pending_payment_setup` and release inventory in a compensating transaction.

This makes failures visible and recoverable rather than relying only on best-effort deletes.

## 6. Wallet consultation payment can debit wallet before booking update succeeds

**Status:** Not fixed yet. Needs transaction/compensation.

**Where**

- `src1/modules/pharmacyWallet/services/index.ts`

**Problem**

`payConsultation()`:

1. Checks booking and wallet balance.
2. Debits wallet atomically.
3. Creates wallet transaction.
4. Updates booking payment status.

If booking update fails after the wallet debit and transaction insert, the service throws `CONSULTATION_PAYMENT_SYNC_FAILED`, but the wallet remains debited.

**Solution**

Wrap wallet debit, transaction insert, and booking update in a Mongo transaction where possible.

If a transaction is not available in the deployment environment, add compensation:

- If booking update fails, credit the wallet back.
- Insert a refund/adjustment transaction.
- Return an error that clearly says the payment was reversed.

Also consider using a conditional booking update:

```ts
{ _id: consultationId, paymentStatus: { $ne: 'paid' } }
```

That prevents two concurrent payment calls from marking the same consultation paid twice.

## 7. Auto collection/index creation should not happen in request paths

**Status:** Partially fixed for wallet and cart only.

**Where**

- Most pharmacy models still rely on default Mongoose `autoCreate`/`autoIndex` behavior.

**Problem**

When the first request touches a model, Mongoose may create the collection and build indexes. In local/dev this is convenient, but in production-like environments it can cause intermittent startup/request failures, especially when multiple app instances start at the same time.

**Solution**

Use one deliberate strategy:

- Disable `autoCreate` and `autoIndex` in production.
- Run a migration/index setup command separately during deploy.
- Keep request handlers focused on business writes only.

Recommended config:

```ts
mongoose.set('autoCreate', CONFIG.NODE_ENV !== 'production');
mongoose.set('autoIndex', CONFIG.NODE_ENV !== 'production');
```

Then add a controlled script for index creation if needed.

## 8. Duplicate-key errors are not normalized into clean API responses

**Status:** Not fixed yet.

**Where**

- Shared error handling
- Cart, wallet, inventory, medicines, pharmacy customers, pharmacies

**Problem**

Several pharmacy models have unique indexes:

- Cart: `{ actorId, actorRole }`
- Wallet: `{ pharmacyId }`
- Inventory: `{ pharmacyId, medicineId }`
- Customers: `{ pharmacyId, userId }`
- Medicines: `{ nameKey }`
- Pharmacies: `phone`

When Mongo throws duplicate key error `11000`, the API may expose a generic 500 depending on where it is thrown.

**Solution**

Add duplicate-key handling in the global error handler or repository layer:

- Detect `err.code === 11000`.
- Return `409 Conflict`.
- Include a stable app code like `DUPLICATE_RESOURCE`.
- For known indexes, return a friendlier message: "Cart already exists, retrying is safe" or "Medicine already exists".

For high-traffic paths, combine this with atomic upsert/retry instead of just formatting the error.

## Recommended Fix Order

1. Finish cart atomic upsert/retry. This is closest to the current user-facing cart issue.
2. Convert inventory save/import commit to atomic upserts.
3. Add duplicate-key normalization in the global error handler.
4. Move collection/index creation to startup/migration strategy instead of request path.
5. Add transactions/compensation for wallet consultation payment and pharmacy order create/payment setup.

## Verification Checklist

- Run `npm run type-check`.
- Test two parallel `POST /api/v1/pharmacy-cart/items` requests for a new cart.
- Test two parallel inventory adds for the same `{ pharmacyId, medicineId }`.
- Test inventory import with one duplicate/invalid row and confirm the API reports partial failure.
- Test wallet consultation payment failure path and confirm the wallet is not left debited.
- Restart two API instances against the same DB and confirm no request path attempts collection/index creation.
