# EWA Healthcare API - Schema Definitions

This document contains JSON Schema definitions for all API endpoints, converted from Joi validation schemas.

## Authentication

For `/api/v1/auth/user/send` and `/api/v1/auth/user/verify`, provide exactly one of `phone` or `email`. For these customer paths, use `oneOf` instead of the generic `anyOf` below. Supplying both contacts returns HTTP400 `VALIDATION_ERROR` before an identity lookup or send. New customer enrollment stores only the selected destination; these login endpoints do not add a secondary contact. Other authentication roles retain the generic request shapes below.

Customer service calls treat an undefined alternate field as absent, validate without scalar coercion, and canonicalize the selected email to trimmed lowercase. VERIFY also validates the six-digit code before lookup. Existing HTTP parameter/body validation retains its earlier error precedence.

### Send OTP Request Schema
```json
{
  "type": "object",
  "properties": {
    "phone": {
      "type": "string",
      "pattern": "^[0-9]{10}$",
      "description": "Phone must be exactly 10 digits"
    },
    "email": {
      "type": "string",
      "format": "email",
      "description": "Email must be a valid email address"
    }
  },
  "anyOf": [
    { "required": ["phone"] },
    { "required": ["email"] }
  ],
  "additionalProperties": false
}
```

### Verify OTP Request Schema
```json
{
  "type": "object",
  "properties": {
    "phone": {
      "type": "string",
      "pattern": "^[0-9]{10}$",
      "description": "Phone must be exactly 10 digits"
    },
    "email": {
      "type": "string",
      "format": "email",
      "description": "Email must be a valid email address"
    },
    "otp": {
      "type": "string",
      "pattern": "^[0-9]{6}$",
      "description": "OTP must be exactly 6 digits. Use the generated code for the requested phone or email."
    }
  },
  "required": ["otp"],
  "anyOf": [
    { "required": ["phone"] },
    { "required": ["email"] }
  ],
  "additionalProperties": false
}
```

## Users

### Update User Request Schema
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "email": { "type": "string", "format": "email" },
    "phone": { "type": "string" },
    "userType": { "type": "string", "enum": ["user", "admin"] },
    "profilePictureUrl": { "type": "string", "format": "uri" },
    "dob": {
      "type": "string",
      "pattern": "^\\d{8}$",
      "description": "Date of birth must be in YYYYMMDD format"
    },
    "gender": { "type": "string", "enum": ["Male", "Female", "Other"] },
    "bloodGroup": {
      "type": "string",
      "enum": ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]
    },
    "height": { "type": "number", "minimum": 0, "maximum": 300 },
    "weight": { "type": "number", "minimum": 0, "maximum": 500 },
    "address": { "type": "string" },
    "city": { "type": "string" },
    "state": { "type": "string" },
    "pincode": { "type": "string" },
    "country": { "type": "string" },
    "department": { "type": "string" },
    "employeeId": { "type": "string" },
    "permissions": {
      "type": "array",
      "items": { "type": "string" }
    },
    "isActive": { "type": "boolean" },
    "isVerified": { "type": "boolean" },
    "emergencyContact": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "phone": { "type": "string" },
        "relationship": { "type": "string" }
      }
    }
  },
  "minProperties": 1,
  "additionalProperties": false
}
```

## Wellness Packages

### Create Wellness Package Request Schema
```json
{
  "type": "object",
  "required": ["name", "originalPrice", "discountedPrice", "testsIncluded"],
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "description": { "type": "string" },
    "bookingProcedure": { "type": "string" },
    "imageUrl": { "type": "string", "format": "uri" },
    "originalPrice": {
      "type": "number",
      "minimum": 0
    },
    "discountedPrice": {
      "type": "number",
      "minimum": 0
    },
    "totalTestsCount": {
      "type": "integer",
      "minimum": 0
    },
    "hasFreeDoctorConsultation": { "type": "boolean" },
    "testsIncluded": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["categoryName", "categoryTestsCount"],
        "properties": {
          "categoryName": { "type": "string", "minLength": 1 },
          "categoryTestsCount": {
            "type": "integer",
            "minimum": 0
          },
          "subTests": {
            "type": "array",
            "items": { "type": "string" },
            "default": []
          }
        }
      }
    },
    "category": { "type": "string" },
    "isActive": { "type": "boolean" },
    "isPopular": { "type": "boolean" },
    "order": {
      "type": "integer",
      "minimum": 0
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "discountedPrice": {},
          "originalPrice": {}
        }
      },
      "then": {
        "properties": {
          "discountedPrice": {
            "maximum": { "$data": "1/originalPrice" }
          }
        }
      }
    }
  ],
  "additionalProperties": false
}
```

## Specialists

### Create Specialist Request Schema
```json
{
  "type": "object",
  "required": ["name", "specialization"],
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "profilePictureUrl": { "type": "string", "format": "uri" },
    "rating": {
      "type": "number",
      "minimum": 0,
      "maximum": 5
    },
    "specialization": {
      "type": "string",
      "minLength": 1
    },
    "degree": { "type": "string" },
    "experienceYears": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100
    },
    "languages": {
      "type": "array",
      "items": { "type": "string" }
    },
    "bio": { "type": "string" },
    "consultationFee": {
      "type": "number",
      "minimum": 0
    },
    "isConsultationFree": { "type": "boolean" },
    "email": { "type": "string", "format": "email" },
    "phone": {
      "type": "string",
      "pattern": "^[0-9]{10}$",
      "description": "Phone must be exactly 10 digits"
    },
    "address": { "type": "string" },
    "city": { "type": "string" },
    "state": { "type": "string" },
    "pincode": { "type": "string" },
    "isActive": { "type": "boolean" },
    "isVerified": { "type": "boolean" }
  },
  "additionalProperties": false
}
```

## Bookings

### Create Specialist Booking Request Schema
```json
{
  "type": "object",
  "required": [
    "userId",
    "specialistId",
    "primaryConcern",
    "consultationMode",
    "bookingDate",
    "bookingTime"
  ],
  "properties": {
    "userId": {
      "type": "string",
      "minLength": 1
    },
    "dependentId": { "type": "string" },
    "specialistId": {
      "type": "string",
      "pattern": "^[0-9a-fA-F]{24}$",
      "description": "Invalid specialist ID format"
    },
    "primaryConcern": {
      "type": "string",
      "minLength": 1
    },
    "consultationMode": {
      "type": "string",
      "enum": ["chat", "call", "in-person"]
    },
    "bookingDate": {
      "type": "string",
      "pattern": "^\\d{8}$",
      "description": "Booking date must be in YYYYMMDD format (e.g., 20250215)"
    },
    "bookingTime": {
      "type": "string",
      "minLength": 1
    },
    "serviceAddress": {
      "type": "object",
      "properties": {
        "addressLine": {
          "type": "string",
          "minLength": 1
        },
        "city": {
          "type": "string",
          "minLength": 1
        },
        "pincode": {
          "type": "string",
          "minLength": 1
        },
        "state": { "type": "string" }
      },
      "required": ["addressLine", "city", "pincode"]
    },
    "documents": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["type", "url"],
        "properties": {
          "type": {
            "type": "string",
            "enum": ["report", "prescription", "other"]
          },
          "url": {
            "type": "string",
            "format": "uri"
          },
          "fileName": { "type": "string" }
        }
      }
    },
    "notes": { "type": "string" }
  },
  "additionalProperties": false
}
```

## Health Tips

### Create Health Tip Request Schema
```json
{
  "type": "object",
  "required": ["title", "description"],
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "description": {
      "type": "string",
      "minLength": 1
    },
    "shortDescription": {
      "type": "string",
      "maxLength": 500
    },
    "icon": { "type": "string" },
    "imageUrl": { "type": "string", "format": "uri" },
    "category": { "type": "string" },
    "isActive": { "type": "boolean" },
    "order": {
      "type": "integer",
      "minimum": 0
    }
  },
  "additionalProperties": false
}
```

## Dependents

### Create Dependent Request Schema
```json
{
  "type": "object",
  "required": ["userId", "name", "relationship"],
  "properties": {
    "userId": {
      "type": "string",
      "minLength": 1
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "relationship": {
      "type": "string",
      "enum": [
        "Me",
        "Father",
        "Mother",
        "Spouse",
        "Son",
        "Daughter",
        "Brother",
        "Sister",
        "Grandfather",
        "Grandmother",
        "Other"
      ]
    },
    "age": {
      "type": "integer",
      "minimum": 0,
      "maximum": 150
    },
    "gender": {
      "type": "string",
      "enum": ["Male", "Female", "Other"]
    },
    "phone": {
      "type": "string",
      "pattern": "^[0-9]{10}$",
      "description": "Phone must be exactly 10 digits"
    },
    "email": { "type": "string", "format": "email" },
    "dateOfBirth": {
      "type": "string",
      "pattern": "^\\d{8}$",
      "description": "Date of birth must be in YYYYMMDD format"
    },
    "bloodGroup": {
      "type": "string",
      "enum": ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]
    },
    "address": { "type": "string" },
    "isActive": { "type": "boolean" }
  },
  "additionalProperties": false
}
```

## Partners

### Create Partner Request Schema
```json
{
  "type": "object",
  "required": ["name"],
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "logoUrl": { "type": "string", "format": "uri" },
    "description": { "type": "string" },
    "website": { "type": "string", "format": "uri" },
    "email": { "type": "string", "format": "email" },
    "phone": {
      "type": "string",
      "pattern": "^[0-9]{10}$",
      "description": "Phone must be exactly 10 digits"
    },
    "address": { "type": "string" },
    "city": { "type": "string" },
    "state": { "type": "string" },
    "pincode": { "type": "string" },
    "partnerType": { "type": "string" },
    "isActive": { "type": "boolean" },
    "isVerified": { "type": "boolean" },
    "order": {
      "type": "integer",
      "minimum": 0
    }
  },
  "additionalProperties": false
}
```

## Corporates

### Create Corporate Request Schema
```json
{
  "type": "object",
  "required": ["name"],
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "companyName": {
      "type": "string",
      "maxLength": 200
    },
    "email": { "type": "string", "format": "email" },
    "phone": {
      "type": "string",
      "pattern": "^[0-9]{10}$",
      "description": "Phone must be exactly 10 digits"
    },
    "contactPerson": { "type": "string" },
    "address": { "type": "string" },
    "city": { "type": "string" },
    "state": { "type": "string" },
    "pincode": { "type": "string" },
    "country": { "type": "string" },
    "logoUrl": { "type": "string", "format": "uri" },
    "website": { "type": "string", "format": "uri" },
    "domain": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\\.[a-zA-Z]{2,}$",
      "description": "Domain must be a valid domain name (e.g., example.com)"
    },
    "industry": { "type": "string" },
    "employeeCount": {
      "type": "integer",
      "minimum": 0
    },
    "description": { "type": "string" },
    "isActive": { "type": "boolean" },
    "isVerified": { "type": "boolean" }
  },
  "additionalProperties": false
}
```

## Slots

### Create Slot Request Schema
```json
{
  "type": "object",
  "required": ["date", "startTime", "endTime"],
  "properties": {
    "specialistId": {
      "type": "string",
      "pattern": "^[0-9a-fA-F]{24}$",
      "description": "Invalid specialist ID format"
    },
    "wellnessPackageId": {
      "type": "string",
      "pattern": "^[0-9a-fA-F]{24}$",
      "description": "Invalid wellness package ID format"
    },
    "date": {
      "type": "string",
      "pattern": "^\\d{8}$",
      "description": "Date must be in YYYYMMDD format (e.g., 20250215)"
    },
    "startTime": {
      "type": "string",
      "minLength": 1
    },
    "endTime": {
      "type": "string",
      "minLength": 1
    },
    "duration": {
      "type": "integer",
      "minimum": 1,
      "description": "Duration in minutes"
    },
    "isAvailable": { "type": "boolean" },
    "maxBookings": {
      "type": "integer",
      "minimum": 1
    },
    "currentBookings": {
      "type": "integer",
      "minimum": 0
    },
    "slotType": {
      "type": "string",
      "enum": ["specialist", "wellnessPackage"]
    },
    "isRecurring": { "type": "boolean" },
    "recurringPattern": {
      "type": "string",
      "enum": ["daily", "weekly", "monthly"]
    },
    "isActive": { "type": "boolean" }
  },
  "oneOf": [
    { "required": ["specialistId"] },
    { "required": ["wellnessPackageId"] }
  ],
  "additionalProperties": false
}
```

## Common Response Schema

### Success Response Schema
```json
{
  "type": "object",
  "required": ["success"],
  "properties": {
    "success": { "type": "boolean" },
    "message": { "type": "string" },
    "data": { "type": "object" },
    "pagination": {
      "type": "object",
      "properties": {
        "page": { "type": "integer" },
        "limit": { "type": "integer" },
        "total": { "type": "integer" },
        "totalPages": { "type": "integer" }
      }
    }
  }
}
```

### Error Response Schema
```json
{
  "type": "object",
  "required": ["success"],
  "properties": {
    "success": { "type": "boolean", "const": false },
    "message": { "type": "string" },
    "errors": {
      "type": "array",
      "items": { "type": "string" }
    }
  }
}
```

## Notes

- All date fields use `YYYYMMDD` format (e.g., `20260209`)
- Phone numbers must be exactly 10 digits
- The current [login source](src1/modules/auth/services/index.ts) generates random six-digit OTPs; there is no fixed testing code. Verification binds the code to the selected account and its current phone/email destination. The [OTP service](src1/modules/otp/services/index.ts) checks stored expiry and the [OTP repository](src1/modules/otp/repository/index.ts) conditionally consumes an unverified challenge through a single [database update](src1/modules/common/repository/BaseRepository.ts).
- MongoDB ObjectId format: 24 hexadecimal characters
- All endpoints except `/health` and `/api/v1/auth/*/send` and `/api/v1/auth/*/verify` require Bearer token authentication
- Token is automatically saved from the "Verify OTP" response and used in subsequent requests


## Pharmacy refill due candidates (source milestone; runtime/activation pending)

`GET /api/v1/pharmacy-subscriptions/due?through=YYYYMMDD&limit=20&after=<cursor>` requires the existing authenticated operational-pharmacy guard. Scope comes only from its signed resolved pharmacyId. `through` is a required Gregorian calendar date (years0001–9999), not a guessed local/UTC today. Limit is canonical1..50, default20; only through/limit/after keys are accepted. No patient/filter/owner query input is allowed. Continue with the returned canonical cursor, same cutoff and same limit; cursors bind this pharmacy/date/limit and the last returned date/ID tuple.

Success200: `{success:true,data:{through,limit,items:[{subscriptionId,nextRefillDate,intervalDays,reminderChannel,pausedUntil,pauseEvaluation:"not_evaluated"}],nextCursor}}`. The nullable reminderChannel and pausedUntil preserve exact absence. Rows are stored-active candidates ordered by date then ID, not recipient/clinical/dispensing eligibility; pause dates are not automatically evaluated or resumed. No patient/medicine/contact/source-order data is returned. Every response reached by this route uses private,no-store; central authentication failures before the router remain outside its header middleware. Mutable dates can move rows between pages; the cursor is not a snapshot guarantee.

Malformed/extra query or mismatched cursor:400 VALIDATION_ERROR. Missing/invalid internal scope:403 FORBIDDEN. Invalid returned stored state or query/timeout failure:503 REFILL_WORKLIST_UNAVAILABLE; no partial page/raw error disclosure. Existing operational guard denial codes/order remain. Reads fetch at most limit+1 (maximum51), use simple collation/maxTimeMS2000 and no count/populate. Declared indexes do not establish installation, efficiency or capacity; actual focused HTTP/ODM/index evidence and staff/client/owner/C2/C3/release acceptance remain pending.

The existing `PUT /api/v1/pharmacy-subscriptions/:id` with `isActive:true` explicitly unsets the stored pausedUntil in that same update, including repeat resume and a simultaneous direct pause value. Other update/pause request shapes and existing404/403 behavior remain. No next-refill date, reminder dispatch, order, stock, payment or clinical authority is changed by resuming. Full reminder scheduling/dispatch remains separate.
