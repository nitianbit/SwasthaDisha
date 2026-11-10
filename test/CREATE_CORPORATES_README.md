# Create Corporates Script

This script creates a list of corporate records in the database.

## Usage

### Prerequisites

1. Make sure you have a valid authentication token
2. Ensure the server is running (default: `http://localhost:4030`)
3. Have the corporate logo image in `test/assets/corporate-7c205cc5-8be2-4ea9-86d6-70e5bf363632.png` (optional)

### Running the Script

#### Option 1: Using npm script with environment variable

```bash
AUTH_TOKEN=your_auth_token_here npm run create-corporates
```

#### Option 2: Using tsx directly

```bash
AUTH_TOKEN=your_auth_token_here tsx test/create-corporates.ts
```

#### Option 3: Set token in .env file

Add to your `.env` file:
```
AUTH_TOKEN=your_auth_token_here
```

Then run:
```bash
npm run create-corporates
```

### Getting an Auth Token

You can get an auth token by:

1. Running the test API script which logs in and creates a token:
   ```bash
   npm run test:api
   ```
   Look for the token in the output or check the `test/api-test-results.json` file.

2. Or manually logging in via the API:
   ```bash
   # Send OTP
   curl -X POST http://localhost:4030/api/v1/auth/send-otp \
     -H "Content-Type: application/json" \
     -d '{"phone": "9876543210"}'
   
   # Verify OTP (use the OTP received)
   curl -X POST http://localhost:4030/api/v1/auth/verify-otp \
     -H "Content-Type: application/json" \
     -d '{"phone": "9876543210", "otp": "123456"}'
   ```
   The verify-otp response will contain the token.

## What the Script Does

1. **Uploads Corporate Logo** (if available):
   - Uploads the corporate logo image from `test/assets/corporate-7c205cc5-8be2-4ea9-86d6-70e5bf363632.png`
   - Uses the uploaded URL for all corporate records

2. **Checks Existing Corporates**:
   - Fetches all existing corporates from the database
   - Displays the count

3. **Creates Corporate Records**:
   - Creates 8 predefined corporate records with diverse data:
     - Tech Corp (IT)
     - Finance Corp (Finance)
     - Healthcare Solutions (Healthcare)
     - Manufacturing Industries (Manufacturing)
     - Retail Enterprises (Retail)
     - Education Services (Education)
     - Real Estate Developers (Real Estate)
     - Logistics & Transport (Logistics)

4. **Displays Summary**:
   - Shows how many corporates were successfully created
   - Lists any failures
   - Shows the final total count of corporates in the database

## Customizing Corporate Data

Edit the `CORPORATES_DATA` array in `test/create-corporates.ts` to add, remove, or modify corporate records.

Each corporate object can include:
- `name` (required): Company name
- `companyName`: Full legal company name
- `email`: Contact email (will be auto-generated if not provided)
- `phone`: Contact phone (will be auto-generated if not provided)
- `contactPerson`: Primary contact person name
- `address`: Street address
- `city`: City name
- `state`: State name
- `pincode`: Postal code
- `country`: Country name
- `logoUrl`: Logo image URL (auto-filled from uploaded image)
- `website`: Company website URL
- `domain`: Company domain
- `industry`: Industry type
- `employeeCount`: Number of employees
- `description`: Company description
- `isActive`: Active status (default: true)
- `isVerified`: Verified status (default: true)

## Environment Variables

- `BASE_URL`: API base URL (default: `http://localhost:4030`)
- `AUTH_TOKEN`: Authentication token (required)
- `CORPORATE_IMAGE_PATH`: Path to corporate logo image (default: `test/assets/corporate-7c205cc5-8be2-4ea9-86d6-70e5bf363632.png`)

## Notes

- The script generates unique phone numbers and emails if not provided to avoid conflicts
- A small delay (500ms) is added between creations to avoid rate limiting
- The script will continue even if some corporates fail to create
- All corporates are created with `isActive: true` and `isVerified: true` by default
