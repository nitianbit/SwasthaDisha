# API Test Curl Commands

## Health Check (Simplest Test)
```bash
curl http://localhost:4030/health
```

Expected Response:
```json
{
  "success": true,
  "message": "Server is running",
  "timestamp": "2025-02-04T10:00:00.000Z"
}
```

## Auth - Send OTP
```bash
curl -X POST http://localhost:3000/api/v1/auth/patient/send \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "9876543210"
  }'
```

Expected Response:
```json
{
  "success": true,
  "message": "OTP sent successfully"
}
```

## Auth - Send OTP with Email
```bash
curl -X POST http://localhost:3000/api/v1/auth/patient/send \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com"
  }'
```

## Auth - Verify OTP
```bash
curl -X POST http://localhost:3000/api/v1/auth/patient/verify \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "9876543210",
    "otp": "123456"
  }'
```

## Health Tips - Get All
```bash
curl http://localhost:3000/api/v1/health-tips
```

## Health Tips - Get Active Tips
```bash
curl http://localhost:3000/api/v1/health-tips/active
```

## Wellness Packages - Get All
```bash
curl http://localhost:3000/api/v1/wellness-packages
```

## Wellness Packages - Get All (with filters)
```bash
curl "http://localhost:3000/api/v1/wellness-packages?isActive=true&isPopular=true&page=1&limit=10"
```

## Specialists - Get Verified Specialists
```bash
curl http://localhost:3000/api/v1/specialists/verified
```

## Corporates - Get All
```bash
curl http://localhost:3000/api/v1/corporates
```

## Partners - Get Verified Partners
```bash
curl http://localhost:3000/api/v1/partners/verified
```

## File Upload (multipart/form-data)
```bash
curl -X POST http://localhost:3000/api/v1/file/upload \
  -F "files=@/path/to/your/file.pdf" \
  -F "module=bookings" \
  -F "recordId=507f1f77bcf86cd799439011"
```

## Coupons - Setup
```bash
BASE_URL="http://localhost:4031/api/v1"
ADMIN_TOKEN="<YOUR_ADMIN_JWT_TOKEN>"
COUPON_CODE="WELCOME10"
```

## Coupons - Get Usage Summary By Code (Admin)
```bash
curl -X GET "$BASE_URL/coupons/usage/$COUPON_CODE?page=1&limit=20" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Expected Response:
```json
{
  "success": true,
  "data": {
    "couponCode": "WELCOME10",
    "totalUses": 8,
    "totalUsers": 3,
    "users": [
      {
        "userId": "665f2d7d8b8f2c0012345678",
        "usageCount": 4,
        "totalDiscountAmount": 400,
        "contexts": ["booking", "external_booking"],
        "firstUsedAt": "2026-05-01T10:00:00.000Z",
        "lastUsedAt": "2026-05-18T09:00:00.000Z"
      }
    ]
  },
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 3,
    "totalPages": 1
  }
}
```

## Addresses - Setup
```bash
BASE_URL="http://localhost:3000/api/v1"
TOKEN="<YOUR_JWT_TOKEN>"
USER_ID="<USER_ID>"
ADDRESS_ID="<ADDRESS_ID>"
```

## Addresses - Create
```bash
curl -X POST "$BASE_URL/addresses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "Flat 402, Green Residency, MG Road",
    "landmark": "Near City Mall",
    "city": "Bengaluru",
    "state": "Karnataka",
    "pincode": "560001",
    "country": "India",
    "type": "Home",
    "label": "Primary Home",
    "latitude": 12.9716,
    "longitude": 77.5946,
    "isDefault": true,
    "isActive": true
  }'
```

## Addresses - Create For Specific User (Admin)
```bash
curl -X POST "$BASE_URL/addresses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "'"$USER_ID"'",
    "address": "Office 1203, Business Park",
    "city": "Mumbai",
    "state": "Maharashtra",
    "pincode": "400001",
    "country": "India",
    "type": "Work"
  }'
```

## Addresses - Get All My Addresses
```bash
curl -X GET "$BASE_URL/addresses" \
  -H "Authorization: Bearer $TOKEN"
```

## Addresses - Get All For Specific User (Admin)
```bash
curl -X GET "$BASE_URL/addresses?userId=$USER_ID" \
  -H "Authorization: Bearer $TOKEN"
```

## Addresses - Filtered List
```bash
curl -X GET "$BASE_URL/addresses?type=Home&isDefault=true&isActive=true&page=1&limit=10&sortBy=createdAt&sortOrder=desc" \
  -H "Authorization: Bearer $TOKEN"
```

## Addresses - Get By ID
```bash
curl -X GET "$BASE_URL/addresses/$ADDRESS_ID" \
  -H "Authorization: Bearer $TOKEN"
```

## Addresses - Get By ID For Specific User (Admin)
```bash
curl -X GET "$BASE_URL/addresses/$ADDRESS_ID?userId=$USER_ID" \
  -H "Authorization: Bearer $TOKEN"
```

## Addresses - Update
```bash
curl -X PUT "$BASE_URL/addresses/$ADDRESS_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "Updated Home",
    "landmark": "Opposite Metro Station",
    "isDefault": true
  }'
```

## Addresses - Delete
```bash
curl -X DELETE "$BASE_URL/addresses/$ADDRESS_ID" \
  -H "Authorization: Bearer $TOKEN"
```

## Addresses - Delete For Specific User (Admin)
```bash
curl -X DELETE "$BASE_URL/addresses/$ADDRESS_ID?userId=$USER_ID" \
  -H "Authorization: Bearer $TOKEN"
```

## Notes:
- Replace `localhost:3000` with your actual server URL if different
- Replace `patient` with other user types: `admin`, `marketing`, `hr`, `doctor`, `hospital`, `lab`
- For POST requests, ensure `Content-Type: application/json` header is set
- For file uploads, use `multipart/form-data` (curl handles this automatically with `-F`)
