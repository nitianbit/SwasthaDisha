# Pharmacy API Reference

This document is the human-readable companion to [phramyx_postman_collection.json](/Users/shubhamgoyal/Desktop/ewa_backend/phramyx_postman_collection.json).

Base URL:

`{{baseUrl}} = http://localhost:5000`

Date/time formats:

- `YYYYMMDD` for dates like `20260730`
- `HH:mm` for 24-hour time like `18:30`

Mongo ID format:

- Any field ending in `Id` usually expects a 24-character Mongo ObjectId string

## Common Variables

| Variable | Type | Required | Notes |
| --- | --- | --- | --- |
| `baseUrl` | string | Yes | API base URL |
| `authToken` | string | Yes for authenticated APIs | User or pharmacy token depending on request |
| `adminToken` | string | Yes for admin APIs | Admin-only routes |
| `pharmacyId` | ObjectId string | Sometimes | Required in many admin/user pharmacy queries |
| `pharmacyUserId` | ObjectId string | No | Filled after pharmacy OTP verify |
| `userId` | ObjectId string | Sometimes | Customer/user ID |
| `medicineId` | ObjectId string | Sometimes | Medicine master catalog ID |
| `medicineId2` | ObjectId string | No | Extra sample medicine ID |
| `inventoryItemId` | ObjectId string | Sometimes | Internal pharmacy inventory row ID |
| `inventoryImportId` | ObjectId string | Sometimes | Import preview/commit ID |
| `pharmacyOrderId` | ObjectId string | Sometimes | Pharmacy order ID |
| `subscriptionId` | ObjectId string | Sometimes | Pharmacy subscription ID |
| `bookingId` | ObjectId string | Sometimes | Specialist consultation booking ID |
| `consultationId` | ObjectId string | Sometimes | Linked consultation ID |
| `diagnosticBookingId` | string | Sometimes | Linked diagnostic booking/reference |
| `paymentTransactionId` | ObjectId string | Sometimes | Payment transaction ID |
| `razorpayOrderId` | string | Sometimes | Razorpay order reference |
| `razorpayPaymentId` | string | Sometimes | Razorpay payment reference |
| `razorpaySignature` | string | Sometimes | Razorpay signature |

## Auth

### 1. Send Pharmacy OTP

`POST /api/v1/auth/pharmacy/send`

Auth:

- Public

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `phone` | string | Conditionally | 10 digits |
| `email` | string | Conditionally | Valid email |

Rules:

- at least one of `phone` or `email` is required
- if pharmacy does not exist, backend creates an unverified pharmacy profile

### 2. Verify Pharmacy OTP

`POST /api/v1/auth/pharmacy/verify`

Auth:

- Public

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `phone` | string | Conditionally | 10 digits |
| `email` | string | Conditionally | Valid email |
| `otp` | string | Yes | Exactly 6 digits |

Rules:

- at least one of `phone` or `email` is required
- returns token and pharmacy-linked user context

### 3. Get Auth Profile

`GET /api/v1/auth/profile`

Auth:

- Any authenticated user

## Pharmacies

### 1. List Pharmacies

`GET /api/v1/pharmacies`

Auth:

- Public or authenticated, depending on app flow

Query parameters:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | No | Exact/filter name |
| `city` | string | No | City filter |
| `state` | string | No | State filter |
| `pincode` | string | No | Any pincode string filter |
| `isVerified` | `'true' \| 'false'` | No | Verification filter |
| `isActive` | `'true' \| 'false'` | No | Active filter |
| `pickupAvailable` | `'true' \| 'false'` | No | Pickup support |
| `deliveryAvailable` | `'true' \| 'false'` | No | Delivery support |
| `search` | string | No | Search term |
| `page` | number | No | Min 1 |
| `limit` | number | No | 1 to 100 |
| `latitude` | number | No | Must come with longitude |
| `longitude` | number | No | Must come with latitude |
| `radiusKm` | number | No | 0.1 to 200 |
| `sortBy` | string | No | `name`, `city`, `state`, `createdAt`, `updatedAt` |
| `sortOrder` | string | No | `asc` or `desc` |

Rules:

- if `latitude` is sent, `longitude` must also be sent

### 2. Medicine Availability By Nearby Pharmacies

`GET /api/v1/pharmacies/medicine-availability`

Auth:

- Public or authenticated

Query parameters:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `medicineId` | ObjectId string | Yes | Medicine to search |
| `latitude` | number | No | Must come with longitude |
| `longitude` | number | No | Must come with latitude |
| `radiusKm` | number | No | 0.1 to 200 |
| `page` | number | No | Min 1 |
| `limit` | number | No | 1 to 100 |

Role response behavior:

- user sees retail-facing data
- pharmacy/admin can also see wholesale-facing data

### 3. Get Pharmacy By ID

`GET /api/v1/pharmacies/:id`

Auth:

- Restricted by backend access rules

Path parameters:

| Field | Type | Required |
| --- | --- | --- |
| `id` | ObjectId string | Yes |

### 4. Get My Pharmacy Profile

`GET /api/v1/pharmacies/me/profile`

Auth:

- Pharmacy only

### 5. Update My Pharmacy Profile

`PUT /api/v1/pharmacies/me/profile`

Auth:

- Pharmacy only

Body:

All fields below are optional, but at least one field must be provided.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | No | 1 to 200 chars |
| `nickname` | string | No | Max 100 |
| `ownerName` | string | No | Max 200 |
| `phone` | string | No | Exactly 10 digits |
| `email` | string | No | Valid email |
| `address` | string | No |  |
| `city` | string | No |  |
| `state` | string | No |  |
| `pincode` | string | No | Exactly 6 digits |
| `latitude` | number | No | -90 to 90 |
| `longitude` | number | No | -180 to 180 |
| `gstNumber` | string | No | Max 50 |
| `drugLicenseNumber` | string | No | Max 100 |
| `gstCertificateUrl` | string | No | URL/path string |
| `drugLicenseDocumentUrl` | string | No | URL/path string |
| `ownerIdProofUrl` | string | No | URL/path string |
| `shopFrontPhotoUrl` | string | No | URL/path string |
| `openingHours` | object | No | Per-day open/close/isClosed |
| `pickupAvailable` | boolean | No |  |
| `deliveryAvailable` | boolean | No |  |
| `profilePictureUrl` | string | No | URL/path string |

Note:

- self-update does not expose admin-only flags like `isVerified`, `isActive`, `walletEnabled`

### 6. Create Pharmacy

`POST /api/v1/pharmacies`

Auth:

- Admin or pharmacy

Body:

Same shape as profile, but required fields are:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | Yes | 1 to 200 chars |
| `phone` | string | Yes | Exactly 10 digits |

Optional admin-level extra fields:

- `isVerified`
- `isActive`
- `walletEnabled`

## Pharmacy Medicines

### 1. Create Medicine

`POST /api/v1/pharmacy-medicines`

Auth:

- Admin or pharmacy

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | Yes | 1 to 300 chars |
| `genericName` | string | No | Max 300 |
| `brandName` | string | No | Max 300 |
| `category` | string | No | Max 100 |
| `dosageForm` | enum | No | `tablet`, `capsule`, `syrup`, `injection`, `cream`, `ointment`, `drops`, `inhaler`, `patch`, `powder`, `solution`, `gel`, `other` |
| `strength` | string | No | Max 100 |
| `manufacturer` | string | No | Max 200 |
| `hsnCode` | string | No | Max 50 |
| `gstPercent` | number | No | 0 to 100 |
| `prescriptionRequired` | boolean | No |  |
| `isActive` | boolean | No |  |

### 2. List Medicines

`GET /api/v1/pharmacy-medicines`

Auth:

- Any authenticated user

Query parameters:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | No |  |
| `genericName` | string | No |  |
| `brandName` | string | No |  |
| `category` | string | No |  |
| `dosageForm` | enum | No | Same enum as create |
| `manufacturer` | string | No |  |
| `prescriptionRequired` | `'true' \| 'false'` | No |  |
| `isActive` | `'true' \| 'false'` | No |  |
| `search` | string | No |  |
| `page` | number | No | Min 1 |
| `limit` | number | No | 1 to 100 |
| `sortBy` | string | No | `name`, `genericName`, `category`, `manufacturer`, `createdAt` |
| `sortOrder` | string | No | `asc` or `desc` |

### 3. Nearby Medicines

`GET /api/v1/pharmacy-medicines/nearby`

Auth:

- Any authenticated user

Query parameters:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `latitude` | number | Yes |  |
| `longitude` | number | Yes |  |
| `radiusKm` | number | No | 0.1 to 200 |
| `search` | string | No |  |
| `page` | number | No | Min 1 |
| `limit` | number | No | 1 to 100 |

Use case:

- medicine discovery tab near the user
- then user can open pharmacy availability for a selected medicine

### 4. Get Medicine By ID

`GET /api/v1/pharmacy-medicines/:id`

### 5. Update Medicine

`PUT /api/v1/pharmacy-medicines/:id`

Auth:

- Admin or pharmacy

Body:

- any create-medicine field
- at least one field required

## Pharmacy Customers

### 1. Create Or Link Customer

`POST /api/v1/pharmacy-customers`

Auth:

- Pharmacy

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | Yes | 1 to 200 chars |
| `phone` | string | Yes | Exactly 10 digits |
| `age` | number | No | 0 to 150 |
| `diseaseNotes` | string | No | Max 1000 |
| `chronicCondition` | boolean | No |  |
| `recurringMedicine` | boolean | No |  |
| `recurringIntervalDays` | number | No | Min 1 |

### 2. List Pharmacy Customers

`GET /api/v1/pharmacy-customers`

Auth:

- Pharmacy

## Pharmacy Inventory

### 1. Upsert Inventory Items

`POST /api/v1/pharmacy-inventory`

Auth:

- Pharmacy

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `items` | array | Yes | At least 1 item |

Each `items[]` object:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `medicineId` | ObjectId string | Yes |  |
| `quantity` | integer | No | Cannot be 0, positive adds, negative reduces |
| `reorderThreshold` | integer | No | Min 0 |
| `rackLocation` | string | No | Max 100 |
| `purchasePrice` | number | No | Min 0 |
| `retailPrice` | number | No | Min 0 |
| `wholesalePrice` | number | No | Min 0 |
| `batchNumber` | string | No | Max 100 |
| `expiryDate` | string | No | `YYYYMMDD` |
| `reason` | enum | No | `purchase`, `return`, `damage`, `expiry`, `correction`, `transfer`, `other` |
| `notes` | string | No | Max 500 |

Behavior:

- one API handles create and update
- if inventory row exists, metadata and quantity can both be updated here

### 2. Get Inventory

`GET /api/v1/pharmacy-inventory`

Auth:

- Authenticated

Query parameters:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `pharmacyId` | ObjectId string | Role-based | user/admin commonly pass this |
| `medicineId` | ObjectId string | No | Filter by medicine |
| `isActive` | `'true' \| 'false'` | No |  |
| `lowStock` | `'true' \| 'false'` | No |  |
| `page` | number | No | Min 1 |
| `limit` | number | No | 1 to 100 |

Role behavior:

- admin: can inspect pharmacy inventory
- pharmacy: sees own internal inventory
- user: must use `pharmacyId` and gets sanitized item details only

User-safe response usually includes:

- medicine basics
- `availableQty`
- `retailPrice`
- `batchNumber`
- `expiryDate`
- `isActive`

### 3. Get Low Stock Inventory

`GET /api/v1/pharmacy-inventory/low-stock`

Auth:

- Admin or pharmacy

Query:

- same query shape as inventory list

### 4. Get Inventory Adjustment History

`GET /api/v1/pharmacy-inventory/adjustments`

Auth:

- Admin or pharmacy

Query:

- same query shape as inventory list

### 5. Manual Reserve Stock

`POST /api/v1/pharmacy-inventory/reserve`

Auth:

- Pharmacy

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `items` | array | Yes | At least 1 item |
| `reason` | string | No | Max 100 |
| `notes` | string | No | Max 500 |

Each `items[]` object:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `medicineId` | ObjectId string | Yes |  |
| `quantity` | integer | Yes | Min 1 |

Note:

- this is for pharmacy internal reserve only
- order lifecycle reserve/release is not exposed here

### 6. Manual Release Stock

`POST /api/v1/pharmacy-inventory/release`

Auth:

- Pharmacy

Body:

- same as reserve

### 7. Get Inventory Item By ID

`GET /api/v1/pharmacy-inventory/:id`

Auth:

- Admin or pharmacy

## Pharmacy Cart

### 1. Get Cart

`GET /api/v1/pharmacy-cart`

Auth:

- User or pharmacy

Behavior:

- user pricing uses retail price
- pharmacy pricing uses wholesale price when available, otherwise retail

### 2. Add Or Update Cart Item

`POST /api/v1/pharmacy-cart/items`

Auth:

- User or pharmacy

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `pharmacyId` | ObjectId string | Yes | Cart is bound to one pharmacy |
| `medicineId` | ObjectId string | Yes |  |
| `quantity` | integer | Yes | Cannot be 0 |

Behavior:

- positive quantity adds/increases
- negative quantity decreases
- if final quantity becomes 0 or less, item is removed
- if cart already belongs to another pharmacy, API returns a clear mismatch error

### 3. Remove Item From Cart

`DELETE /api/v1/pharmacy-cart/items/:medicineId`

Auth:

- User or pharmacy

### 4. Clear Cart

`DELETE /api/v1/pharmacy-cart`

Auth:

- User or pharmacy

## Pharmacy Orders

### 1. Create Pharmacy Order

`POST /api/v1/pharmacy-orders`

Auth:

- Pharmacy

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `orderType` | enum | Yes | `in_store`, `online` |
| `customerId` | ObjectId string | No | Customer order |
| `buyerPharmacyId` | ObjectId string | No | Pharmacy-to-pharmacy order |
| `items` | array | Yes | At least 1 item |
| `paymentMode` | enum | Yes | `online_payment`, `in_store_payment`, `cash_on_delivery` |
| `deliveryMode` | enum | No | `pickup` or `delivery` |
| `deliveryAddress` | string | Conditionally | Required if `deliveryMode=delivery` |
| `isWalkIn` | boolean | No |  |
| `prescriptionUrls` | string[] | No |  |
| `notes` | string | No | Max 1000 |
| `linkedConsultationId` | ObjectId string | No |  |
| `linkedDiagnosticOrderId` | string | No |  |

Each `items[]` object:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `medicineId` | ObjectId string | Yes |  |
| `medicineName` | string | No |  |
| `orderedQty` | integer | Yes | Min 1 |
| `unitPrice` | number | No | Usually backend-driven |
| `discount` | number | No | Min 0 |
| `freeQty` | integer | No | Min 0 |
| `recurring` | boolean | No |  |
| `subscriptionFrequency` | string | No |  |
| `subscriptionIntervalDays` | integer | Conditionally | Required if `recurring=true` |
| `subscriptionNextRefillDate` | string | No | `YYYYMMDD` |
| `subscriptionReminderChannel` | enum | No | `sms`, `push`, `both`, `none` |

### 2. Get Pharmacy Orders

`GET /api/v1/pharmacy-orders`

Auth:

- Authenticated, access filtered by backend role rules

Query parameters:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `pharmacyId` | ObjectId string | No |  |
| `customerId` | ObjectId string | No |  |
| `userId` | ObjectId string | No |  |
| `buyerPharmacyId` | ObjectId string | No |  |
| `orderType` | enum | No | `in_store`, `online` |
| `orderFor` | enum | No | `consultation`, `diagnostic` |
| `status` | enum | No | `placed`, `accepted`, `packed`, `ready_for_pickup`, `out_for_delivery`, `completed`, `abandoned`, `cancelled`, `rejected` |
| `paymentStatus` | enum | No | `pending`, `authorized`, `paid`, `failed`, `refunded`, `partially_paid` |
| `page` | number | No | Min 1 |
| `limit` | number | No | 1 to 100 |

### 3. Get Pharmacy Order By ID

`GET /api/v1/pharmacy-orders/:id`

### 4. Update Pharmacy Order

`PUT /api/v1/pharmacy-orders/:id`

Auth:

- Pharmacy

Body:

- any of create-order fields
- at least one field required
- if `deliveryMode=delivery`, `deliveryAddress` becomes required

### 5. Update Pharmacy Order Status

`POST /api/v1/pharmacy-orders/:id/status`

Auth:

- Pharmacy

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | enum | Yes | Same status enum as above |
| `notes` | string | No | Max 500 |

### 6. Cancel Pharmacy Order

`POST /api/v1/pharmacy-orders/:id/cancel`

Auth:

- Pharmacy

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `notes` | string | No | Max 500 |

### 7. Mark Order Paid

`POST /api/v1/pharmacy-orders/:id/mark-paid`

Auth:

- Operational route for pharmacy/admin-managed payment completion

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `paymentSource` | string | No | Max 100 |
| `paidDate` | string | No | `YYYYMMDD` |
| `paidTime` | string | No | `HH:mm` |
| `notes` | string | No | Max 500 |

## Pharmacy Subscriptions

### 1. Create Subscriptions

`POST /api/v1/pharmacy-subscriptions`

Auth:

- Pharmacy

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `userId` | ObjectId string | Yes |  |
| `items` | array | Yes | At least 1 item |

Each `items[]` object:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `medicineId` | ObjectId string | Yes |  |
| `medicineName` | string | No |  |
| `frequency` | string | No |  |
| `intervalDays` | integer | Yes | Min 1 |
| `nextRefillDate` | string | No | `YYYYMMDD` |
| `reminderChannel` | enum | No | `sms`, `push`, `both`, `none` |

### 2. List Subscriptions

`GET /api/v1/pharmacy-subscriptions`

### 3. Update Subscription

`PUT /api/v1/pharmacy-subscriptions/:id`

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `intervalDays` | integer | No | Min 1 |
| `nextRefillDate` | string | No | `YYYYMMDD` |
| `reminderChannel` | enum | No | `sms`, `push`, `both`, `none` |
| `isActive` | boolean | No |  |

Rules:

- at least one field required

### 4. Pause Subscription

`POST /api/v1/pharmacy-subscriptions/:id/pause`

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `pausedUntil` | string | No | `YYYYMMDD` |

### 5. Delete Subscription

`DELETE /api/v1/pharmacy-subscriptions/:id`

## Pharmacy Wallet

### 1. Get Wallet

`GET /api/v1/pharmacy-wallet`

Auth:

- Admin or pharmacy

### 2. Get Wallet Transactions

`GET /api/v1/pharmacy-wallet/transactions`

Auth:

- Admin or pharmacy

### 3. Top Up Wallet

`POST /api/v1/pharmacy-wallet/topup`

Auth:

- Admin

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `pharmacyId` | ObjectId string | No | Can be optional depending on admin context |
| `amount` | number | Yes | Min 1 |
| `notes` | string | No | Max 500 |

## Tracking

### 1. Patient Tracking Summary

`GET /api/v1/patient-tracking/:userId`

Auth:

- Pharmacy

### 2. Update Patient Tracking Summary

`PUT /api/v1/patient-tracking/:userId`

Auth:

- Pharmacy

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `diseaseNotes` | string | No | Max 1000 |
| `chronicCondition` | boolean | No |  |
| `recurringMedicine` | boolean | No |  |
| `recurringIntervalDays` | integer | No | Min 1 |
| `preferredFollowUpDate` | string | No | `YYYYMMDD` |
| `pharmacyNotes` | string | No | Max 1000 |

Rules:

- at least one field required

### 3. Pharmacy Tracking Summary

`GET /api/v1/pharmacy-tracking/summary`

Auth:

- Admin or pharmacy

### 4. Pharmacy Tracking Summary By Pharmacy

`GET /api/v1/pharmacy-tracking/summary/:pharmacyId`

Auth:

- Admin or pharmacy

## Related Pharmacy Booking APIs

These are not part of the core pharmacy module, but they are included in the Postman collection because pharmacies use them operationally.

### Specialist Consultation

- `POST /api/v1/bookings/specialist`
- `POST /api/v1/bookings/:bookingId/retry-payment`
- `GET /api/v1/bookings/:bookingId/payment-details`
- `POST /api/v1/bookings/:bookingId/cancel`
- `POST /api/v1/bookings/:bookingId/reschedule`

### Diagnostics

- `POST /api/v1/external-bookings/diagnostics/bookings`
- `POST /api/v1/external-bookings/diagnostics/bookings/:diagnosticBookingId/retry-payment`
- `POST /api/v1/external-bookings/diagnostics/bookings/:diagnosticBookingId/cancel`
- `POST /api/v1/external-bookings/diagnostics/bookings/:diagnosticBookingId/reschedule`
- `GET /api/v1/external-bookings/bookings/:diagnosticBookingId/payment-details`

### Shared Payment Verification

- `POST /api/v1/payments/verify`

## Recommended Use

For the cleanest workflow:

1. Use [phramyx_postman_collection.json](/Users/shubhamgoyal/Desktop/ewa_backend/phramyx_postman_collection.json) for importing and testing.
2. Use this markdown file for reading field rules quickly.
3. If you want public-style docs like Postman Documenter, publish the collection after adding examples and environment values.
