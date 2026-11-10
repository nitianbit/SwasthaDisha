# Pharmacy hardening implementation

This change keeps existing pharmacy APIs compatible and adds only the endpoints/fields needed for checkout, batches, import recovery, and monitoring.

## Inventory and medicine safety

- Inventory remains one document per `pharmacyId + medicineId`.
- Batches are embedded in `inventory.batches`; top-level quantities and prices remain available for existing clients.
- Adding inventory is additive. `quantity: 50` means add 50 units to the supplied batch.
- New stock requires `batchNumber` and a valid, non-expired `expiryDate` (`YYYYMMDD`).
- Order allocation is FEFO; `receivedAt` and batch `_id` provide FIFO/stable tie-breaking for equal expiry dates.
- Depleted batches are retained with `status: depleted` and omitted from sellable availability.
- Expired, recalled, or quarantined batches cannot be allocated or consumed.
- Batch pricing stores purchase price, MRP, retail price, and wholesale price while retaining top-level prices for compatibility.
- Prescription-required medicines require at least one `prescriptionUrl`. Orders store `prescriptionStatus: pending` for a future AI/LLM approval workflow; no approval API is exposed yet.

Internal inventory responses include batches only with `?includeBatches=true`. Public/user inventory never exposes embedded batch records and reports only sellable, non-expired stock.

## Order and checkout contract

`POST /api/v1/pharmacy-cart/checkout`

The cart is resolved from the authenticated actor; no `cartId` is accepted.

```json
{
  "paymentMode": "online_payment",
  "deliveryMode": "delivery",
  "deliveryAddress": "Delivery address",
  "prescriptionUrls": ["uploaded-file-url"],
  "notes": "Optional"
}
```

Checkout reloads inventory prices. If a price changed it returns `409 CART_PRICE_CHANGED`, refreshes the cart, and asks the client to review and retry. Stock is reserved by batch in the same transaction that creates the order. A concurrently changed cart is not deleted.

Financial/item edits are allowed only while an order is `placed`, payment is `pending`, and no payment transaction has been initiated. Status changes follow the explicit transition map. Cancellation/rejection/abandonment releases the exact batch allocations; completion consumes them.

Order and payment records store paise fields alongside existing rupee fields. Medicine HSN/GST values and inclusive-tax calculations are snapshotted on each order item.

## Excel imports

Preferred quantity column: `quantity to add` (legacy `available quantity` remains accepted as an additive alias).

- Each valid row commits its batch adjustment and adjustment-ledger record in one transaction.
- Successful rows are never replayed by retry.
- `POST /api/v1/pharmacy-inventory-imports/:id/retry` retries failed rows (and safely resumes imports stuck for at least 15 minutes).
- `GET /api/v1/pharmacy-inventory-imports/:id/failed-rows/download` returns an XLSX containing invalid/failed rows and their exact errors.
- Corrected rows are uploaded as a new import; retry does not accept a replacement file.
- Source uploads are removed after commit. Uncommitted uploads are retained for seven days, then cleaned daily.

## Operations

- `POST /api/v1/pharmacy-wallet/topup` keeps admin manual credits transactional (`Idempotency-Key` recommended). When called by a verified pharmacy, it initiates Razorpay payment and credits the pharmacy wallet transactionally only after `/api/v1/payments/verify` succeeds.
- Pharmacy-order late-payment refunds credit the user wallet and create the refund ledger entry transactionally and idempotently.
- Notifications use unique queue/event keys and persisted idempotency keys; FCM delivery state is retained.
- `GET /api/v1/dashboard/pharmacy-operations-health` (admin) reports failed/stuck pharmacy payments, imports, notifications, jobs, and file cleanup.
- Nearby pharmacy and medicine searches use great-circle distance before pagination.
- Pharmacy customer search matches customer name, phone, email, and pharmacy notes in one database query before pagination.
- Pharmacy and medicine deletes now archive/deactivate instead of physically deleting.

## Legacy batch migration (run last)

Dry run:

```bash
npm run migrate:pharmacy-inventory-batches
```

Commit after reviewing unresolved rows:

```bash
npm run migrate:pharmacy-inventory-batches -- --commit
```

The migration is idempotent and converts only legacy inventory with a valid existing batch number and expiry date. It never invents safety-critical batch/expiry data; unresolved rows are reported for correction.

## Verification

```bash
npm run type-check
npm run test:pharmacy
```

Set `PHARMACY_TEST_MONGODB_URI` to a dedicated replica-set database whose name contains `test` to run the stock/payment/import transaction-race tests. Without it, the integration tests are safely skipped.
