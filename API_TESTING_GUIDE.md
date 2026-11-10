# API Testing Guide

## Prerequisites

1. **Start the Server First:**
   ```bash
   npm run dev:ts
   ```
   Wait for the server to start and show: `🚀 Server running on port 3000`

2. **Ensure MongoDB is Running:**
   - Make sure MongoDB is accessible at the URL specified in your `.env` file
   - Default: `mongodb://localhost:27017/ewa-healthcare`

## Running API Tests

### Option 1: Automated Test Script (Recommended)

Run the automated test script that tests all endpoints and saves results:

```bash
npm run test:api
```

This will:
- Test all API endpoints sequentially
- Save detailed results to `api-test-results.json`
- Show a summary of successes, errors, and skipped tests

### Option 2: Manual Testing with Curl

See `API_TEST_CURL.md` for individual curl commands.

## Test Results File

After running `npm run test:api`, results are saved to:
- **File:** `api-test-results.json`
- **Format:** JSON with detailed request/response data for each test

## Test Order (as executed by test script)

1. ✅ Health Check - `/health`
2. 🔐 Auth - Send OTP (Phone) - `/api/v1/auth/patient/send`
3. 🔐 Auth - Send OTP (Email) - `/api/v1/auth/patient/send`
4. 🔐 Auth - Verify OTP - `/api/v1/auth/patient/verify`
5. 💡 Health Tips - Get All
6. 💡 Health Tips - Get Active
7. 💡 Health Tips - Get by Category
8. 📦 Wellness Packages - Get All
9. 📦 Wellness Packages - Get All (Filtered)
10. 👥 Dependents - Get All
11. 👥 Dependents - Get by User ID
12. 👨‍⚕️ Specialists - Get All
13. 👨‍⚕️ Specialists - Get Verified
14. 👨‍⚕️ Specialists - Get by Specialization
15. 📅 Bookings - Get All
16. 📅 Bookings - Get Upcoming
17. 🤝 Partners - Get All
18. 🤝 Partners - Get Verified
19. 🤝 Partners - Get by Type
20. ⏰ Slots - Get All
21. ⏰ Slots - Get Available
22. 🏢 Corporates - Get All
23. 🏢 Corporates - Get Verified
24. 🏢 Corporates - Get by Industry
25. 📁 File Upload (skipped - requires form-data)

## Expected Test Results

### Should Succeed (200/201):
- Health Check
- GET endpoints (if database has data)
- Auth endpoints (if validation passes)

### May Fail (Expected):
- Verify OTP (without valid OTP)
- Get by ID endpoints (without valid IDs in database)
- Some GET endpoints (if database is empty)

## Troubleshooting

### All Tests Failing with Connection Errors:
- **Issue:** Server is not running
- **Solution:** Start server with `npm run dev:ts` in a separate terminal

### Database Connection Errors:
- **Issue:** MongoDB not accessible
- **Solution:** Check `.env` file has correct `MONGODB_URL`

### Validation Errors:
- **Issue:** Request data doesn't match schema
- **Solution:** Check the error response in `api-test-results.json` for details

## Viewing Test Results

```bash
# View results file
cat api-test-results.json | jq .

# Or open in your editor
code api-test-results.json
```

## Customizing Tests

Edit `test-api.js` to:
- Change `BASE_URL` (default: `http://localhost:3000`)
- Add more test cases
- Modify test data
- Add authentication tokens if needed
