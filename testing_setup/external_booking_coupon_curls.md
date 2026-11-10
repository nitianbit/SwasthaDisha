# External Booking Coupon Testing Curls

This document contains end-to-end curl examples and demo responses for:
- coupon creation
- coupon listing
- coupon preview validation
- external booking creation
- retry-payment with coupon
- payment verification
- cancellation/refund flow

## Example IDs Used
- External doctor provider id: `19`
- External diagnostics lab id: `23`
- External diagnostics package id: `LSP10065`

Important:
- In coupon APIs, `bookingId` means the target id for applicability matching
- In `retry-payment`, `:id` means the actual external booking document `_id`

## 1. Create External Specialist Coupon
```bash
curl --location 'http://localhost:4031/api/v1/coupons' \
  --header 'Authorization: Bearer <ADMIN_JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "code": "EXTDOC100",
    "title": "External Doctor Rs100 Off",
    "description": "Valid for one external doctor",
    "discountType": "fixed",
    "discountValue": 100,
    "minimumPurchaseAmount": 300,
    "eligibleFor": "external_specialist",
    "forUser": "all",
    "applicableTo": "specific",
    "applicableIds": ["19"],
    "startDate": "20260412",
    "endDate": "20270412",
    "usageLimitPerUser": 1,
    "totalUsageLimit": 100,
    "isActive": true
  }'
```

Demo response:
```json
{
  "success": true,
  "message": "Coupon created successfully",
  "data": {
    "_id": "6800c0011111111111111111",
    "code": "EXTDOC100",
    "title": "External Doctor Rs100 Off",
    "description": "Valid for one external doctor",
    "discountType": "fixed",
    "discountValue": 100,
    "minimumPurchaseAmount": 300,
    "eligibleFor": "external_specialist",
    "forUser": "all",
    "applicableTo": "specific",
    "applicableIds": ["19"],
    "applicablePackageIds": [],
    "startDate": "20260412",
    "endDate": "20270412",
    "usageLimitPerUser": 1,
    "totalUsageLimit": 100,
    "currentUsageCount": 0,
    "isActive": true
  }
}
```

## 2. Create External Diagnostics Coupon by Vendor/Lab
```bash
curl --location 'http://localhost:4031/api/v1/coupons' \
  --header 'Authorization: Bearer <ADMIN_JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "code": "EXTLAB200",
    "title": "External Lab Rs200 Off",
    "description": "Valid for lab 23",
    "discountType": "fixed",
    "discountValue": 200,
    "minimumPurchaseAmount": 500,
    "eligibleFor": "external_diagnostics",
    "forUser": "all",
    "applicableTo": "specific",
    "applicableIds": ["23"],
    "startDate": "20260412",
    "endDate": "20270412",
    "usageLimitPerUser": 1,
    "totalUsageLimit": 100,
    "isActive": true
  }'
```

Demo response:
```json
{
  "success": true,
  "message": "Coupon created successfully",
  "data": {
    "_id": "6800c0022222222222222222",
    "code": "EXTLAB200",
    "eligibleFor": "external_diagnostics",
    "applicableIds": ["23"],
    "applicablePackageIds": [],
    "currentUsageCount": 0
  }
}
```

## 3. Create External Diagnostics Coupon by Package
```bash
curl --location 'http://localhost:4031/api/v1/coupons' \
  --header 'Authorization: Bearer <ADMIN_JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "code": "PKG150",
    "title": "Package Rs150 Off",
    "description": "Valid for package LSP10065",
    "discountType": "fixed",
    "discountValue": 150,
    "minimumPurchaseAmount": 400,
    "eligibleFor": "external_diagnostics",
    "forUser": "all",
    "applicableTo": "specific",
    "applicablePackageIds": ["LSP10065"],
    "startDate": "20260412",
    "endDate": "20270412",
    "usageLimitPerUser": 1,
    "totalUsageLimit": 100,
    "isActive": true
  }'
```

Demo response:
```json
{
  "success": true,
  "message": "Coupon created successfully",
  "data": {
    "_id": "6800c0033333333333333333",
    "code": "PKG150",
    "eligibleFor": "external_diagnostics",
    "applicableIds": [],
    "applicablePackageIds": ["LSP10065"],
    "currentUsageCount": 0
  }
}
```

## 4. Create External Diagnostics Coupon for Vendor or Package
```bash
curl --location 'http://localhost:4031/api/v1/coupons' \
  --header 'Authorization: Bearer <ADMIN_JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "code": "EXTLABPKG250",
    "title": "Lab or Package Rs250 Off",
    "description": "Valid for lab 23 or package LSP10065",
    "discountType": "fixed",
    "discountValue": 250,
    "minimumPurchaseAmount": 500,
    "eligibleFor": "external_diagnostics",
    "forUser": "all",
    "applicableTo": "specific",
    "applicableIds": ["23"],
    "applicablePackageIds": ["LSP10065"],
    "startDate": "20260412",
    "endDate": "20270412",
    "usageLimitPerUser": 1,
    "totalUsageLimit": 100,
    "isActive": true
  }'
```

## 5. List Applicable Coupons for External Specialist
```bash
curl --location 'http://localhost:4031/api/v1/coupons/applicable?bookingType=external_specialist&bookingId=19' \
  --header 'Authorization: Bearer <USER_JWT>'
```

Demo response:
```json
{
  "success": true,
  "data": [
    {
      "code": "EXTDOC100",
      "eligibleFor": "external_specialist",
      "applicableIds": ["19"]
    }
  ]
}
```

## 6. List Applicable Coupons for External Diagnostics by Lab
```bash
curl --location 'http://localhost:4031/api/v1/coupons/applicable?bookingType=external_diagnostics&bookingId=23' \
  --header 'Authorization: Bearer <USER_JWT>'
```

Demo response:
```json
{
  "success": true,
  "data": [
    {
      "code": "EXTLAB200",
      "eligibleFor": "external_diagnostics",
      "applicableIds": ["23"]
    },
    {
      "code": "EXTLABPKG250",
      "eligibleFor": "external_diagnostics",
      "applicableIds": ["23"],
      "applicablePackageIds": ["LSP10065"]
    }
  ]
}
```

## 7. Preview Validate External Specialist Coupon
```bash
curl --location 'http://localhost:4031/api/v1/coupons/validate' \
  --header 'Authorization: Bearer <USER_JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "code": "EXTDOC100",
    "bookingType": "external_specialist",
    "bookingId": "19",
    "purchaseAmount": 499
  }'
```

Demo response:
```json
{
  "success": true,
  "message": "Coupon is valid",
  "data": {
    "isValid": true,
    "coupon": {
      "code": "EXTDOC100"
    },
    "discountAmount": 100,
    "finalAmount": 399
  }
}
```

## 8. Preview Validate External Diagnostics Coupon by Lab
```bash
curl --location 'http://localhost:4031/api/v1/coupons/validate' \
  --header 'Authorization: Bearer <USER_JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "code": "EXTLAB200",
    "bookingType": "external_diagnostics",
    "bookingId": "23",
    "purchaseAmount": 999
  }'
```

Demo response:
```json
{
  "success": true,
  "message": "Coupon is valid",
  "data": {
    "isValid": true,
    "coupon": {
      "code": "EXTLAB200"
    },
    "discountAmount": 200,
    "finalAmount": 799
  }
}
```

## 9. Preview Validate External Diagnostics Coupon by Package
```bash
curl --location 'http://localhost:4031/api/v1/coupons/validate' \
  --header 'Authorization: Bearer <USER_JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "code": "PKG150",
    "bookingType": "external_diagnostics",
    "bookingId": "23",
    "packageIds": ["LSP10065"],
    "purchaseAmount": 999
  }'
```

Demo response:
```json
{
  "success": true,
  "message": "Coupon is valid",
  "data": {
    "isValid": true,
    "coupon": {
      "code": "PKG150"
    },
    "discountAmount": 150,
    "finalAmount": 849
  }
}
```

## 10. Create External Specialist Booking
```bash
curl --location 'http://localhost:4031/api/v1/external-bookings/bookings' \
  --header 'Authorization: Bearer <USER_JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "integration": "labstack",
    "providerType": "DOCTOR",
    "appointmentType": "ONLINE",
    "externalProviderId": "19",
    "bookingDate": "20260413",
    "selectedSlotTime": "17:25",
    "patientName": "Test User",
    "patientEmail": "test.user@example.com",
    "patientPhone": "8570069845",
    "patientGender": "MALE",
    "patientDateOfBirth": "20010201",
    "patientAge": "25",
    "primaryConcern": "Headache",
    "consultationMode": "video",
    "address": "Shop St",
    "pincode": "600053",
    "city": "Chennai",
    "state": "Tamil Nadu"
  }'
```

Demo response:
```json
{
  "success": true,
  "message": "External booking created; complete payment to confirm with the provider",
  "data": {
    "booking": {
      "_id": "6800d001aaaaaaaaaaaaaaaa",
      "externalProviderId": "19",
      "price": 499,
      "paymentStatus": "pending",
      "status": "pending_payment"
    },
    "paymentRequired": true,
    "walletDeductedAmount": 0,
    "payment": {
      "paymentTransactionId": "6800d001bbbbbbbbbbbbbbbb",
      "razorpayOrderId": "order_123",
      "razorpayKeyId": "rzp_test_xxx",
      "amount": 499,
      "currency": "INR",
      "baseAmount": 499,
      "discountAmount": 0,
      "walletDeductedAmount": 0
    }
  }
}
```

## 11. Retry External Specialist Payment with Coupon
```bash
curl --location 'http://localhost:4031/api/v1/external-bookings/bookings/6800d001aaaaaaaaaaaaaaaa/retry-payment' \
  --header 'Authorization: Bearer <USER_JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "useWalletBalance": true,
    "couponCode": "EXTDOC100"
  }'
```

Demo response:
```json
{
  "success": true,
  "message": "External booking payment initiated successfully",
  "data": {
    "booking": {
      "_id": "6800d001aaaaaaaaaaaaaaaa",
      "price": 499,
      "paymentStatus": "pending",
      "status": "pending_payment"
    },
    "paymentRequired": true,
    "walletDeductedAmount": 50,
    "payment": {
      "paymentTransactionId": "6800d009cccccccccccccccc",
      "razorpayOrderId": "order_456",
      "razorpayKeyId": "rzp_test_xxx",
      "amount": 349,
      "currency": "INR",
      "baseAmount": 499,
      "discountAmount": 100,
      "couponCode": "EXTDOC100",
      "walletDeductedAmount": 50
    }
  }
}
```

Meaning:
- gross `499`
- discount `100`
- after coupon `399`
- wallet `50`
- Razorpay payable `349`

## 12. Create External Diagnostics Booking
```bash
curl --location 'http://localhost:4031/api/v1/external-bookings/diagnostics/bookings' \
  --header 'Authorization: Bearer <USER_JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "integration": "labstack",
    "orderType": "HOME_SAMPLE",
    "labId": "23",
    "packageIds": ["LSP10065"],
    "bookingDate": "20260413",
    "bookingTime": "14:00",
    "patientName": "Test User",
    "patientEmail": "test.user@example.com",
    "patientPhone": "8570069845",
    "address": "Shop St",
    "pincode": "600053",
    "city": "Chennai",
    "state": "Tamil Nadu"
  }'
```

Demo response:
```json
{
  "success": true,
  "message": "External diagnostics booking created; complete payment to confirm the order",
  "data": {
    "booking": {
      "_id": "6800e001dddddddddddddddd",
      "externalProviderId": "23",
      "price": 999,
      "paymentStatus": "pending",
      "status": "pending_payment",
      "meta": {
        "packageIds": ["LSP10065"],
        "labId": "23"
      }
    },
    "paymentRequired": true,
    "walletDeductedAmount": 0,
    "payment": {
      "paymentTransactionId": "6800e001eeeeeeeeeeeeeeee",
      "amount": 999,
      "baseAmount": 999,
      "discountAmount": 0
    }
  }
}
```

## 13. Retry External Diagnostics Payment with Package Coupon
```bash
curl --location 'http://localhost:4031/api/v1/external-bookings/diagnostics/bookings/6800e001dddddddddddddddd/retry-payment' \
  --header 'Authorization: Bearer <USER_JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "useWalletBalance": true,
    "couponCode": "PKG150"
  }'
```

Demo response:
```json
{
  "success": true,
  "message": "External diagnostics payment initiated successfully",
  "data": {
    "booking": {
      "_id": "6800e001dddddddddddddddd",
      "price": 999,
      "paymentStatus": "pending",
      "status": "pending_payment"
    },
    "paymentRequired": true,
    "walletDeductedAmount": 100,
    "payment": {
      "paymentTransactionId": "6800e009ffffffffffffffff",
      "razorpayOrderId": "order_789",
      "razorpayKeyId": "rzp_test_xxx",
      "amount": 749,
      "currency": "INR",
      "baseAmount": 999,
      "discountAmount": 150,
      "couponCode": "PKG150",
      "walletDeductedAmount": 100
    }
  }
}
```

## 14. Verify Payment
```bash
curl --location 'http://localhost:4031/api/v1/payments/verify' \
  --header 'Authorization: Bearer <USER_JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "paymentTransactionId": "6800e009ffffffffffffffff",
    "razorpayOrderId": "order_789",
    "razorpayPaymentId": "pay_123456",
    "razorpaySignature": "sig_123456",
    "module": "external-bookings"
  }'
```

Demo response:
```json
{
  "context": "external_booking",
  "paymentRecord": {
    "_id": "6800e009ffffffffffffffff",
    "status": "paid",
    "isProcessed": true,
    "couponCode": "PKG150",
    "discountAmount": 150,
    "finalAmount": 749
  },
  "entity": {
    "_id": "6800e001dddddddddddddddd",
    "externalBookingId": "1201",
    "paymentStatus": "paid",
    "status": "CREATED"
  }
}
```

## 15. Cancel External Booking and Test Coupon Reversal
```bash
curl --location 'http://localhost:4031/api/v1/external-bookings/diagnostics/bookings/6800e001dddddddddddddddd/cancel' \
  --header 'Authorization: Bearer <USER_JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "cancellationReason": "Testing refund and coupon reversal"
  }'
```

Demo response:
```json
{
  "success": true,
  "message": "External booking cancelled successfully",
  "data": {
    "_id": "6800e001dddddddddddddddd",
    "paymentStatus": "refunded",
    "status": "CANCELED",
    "meta": {
      "cancellationReason": "Testing refund and coupon reversal"
    }
  }
}
```

After this:
- payment record becomes `refunded`
- coupon usage count is decremented
- user should be able to use the coupon again if limits allow

## Recommended Testing Order
1. Create coupon
2. List applicable coupons
3. Validate coupon preview
4. Create external booking
5. Retry payment with coupon
6. Complete Razorpay payment
7. Verify payment
8. Cancel booking
9. Validate same coupon again
