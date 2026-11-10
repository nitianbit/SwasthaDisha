# Update Images Script

This script uploads images and updates all existing specialists, wellness packages, banners, corporates, and partners with the new image URLs.

**Execution gate:** this effectful development utility is not part of the admitted foundation tests. The examples below are reference instructions for a disposable, explicitly approved fixture after the [C2/C3 entry gates](../documentation/planning/M0_START_APPROVAL_STATUS.md) are satisfied. It has not been run during repository migration.

## Prerequisites

1. Make sure your backend server is running
2. You need an authentication token

## Development fixture token

After the execution gates are satisfied, obtain a development-only token from the approved fixture authentication flow and provide it as `DEV_AUTH_TOKEN`. The utility fails before making requests if that variable is missing. Keep tokens out of source, committed result files and logs. The legacy API test script is not an approved way to bypass fixture admission.

## Running the Script

### Option 1: Using Environment Variable

```bash
DEV_AUTH_TOKEN=your_token_here npm run update-images
```

### Option 2: Export Environment Variable First

```bash
export DEV_AUTH_TOKEN=your_token_here
npm run update-images
```

### Option 3: Set BASE_URL if Different

```bash
BASE_URL=http://localhost:4030 DEV_AUTH_TOKEN=your_token_here npm run update-images
```

## What the Script Does

1. **Uploads Images**: Uploads six images to the server:
   - Specialist image → `test/assets/specialist-fd6fd7d9-85ae-49ff-86fa-ad5269185d9c.png`
   - Package image → `test/assets/package1-eb1aeba9-a4e2-4682-ac36-97c00b93e355.png`
   - Banner image → `test/assets/banner-e185cd78-4636-4533-b0cb-cb4590e570a3.png`
   - Corporate image → `test/assets/corporate-7c205cc5-8be2-4ea9-86d6-70e5bf363632.png`
   - Partners image → `test/assets/partners-dc98b66b-d8b7-4356-a62f-5cd1c882b7ee.png`
   - Health Tips image → `test/assets/health-tips-9470bfcb-56da-4965-b521-82b442ccfbe9.png`

2. **Fetches All Records**: Gets all existing:
   - Specialists
   - Wellness Packages
   - Banners
   - Corporates
   - Partners
   - Health Tips

3. **Updates Records**: Updates each record with the appropriate image URL:
   - All specialists get the specialist image
   - All wellness packages get the package image
   - All banners get the banner image
   - All corporates get the corporate image
   - All partners get the partners image
   - All health tips get the health tips image

## Custom Image Paths

If your images are in a different location, you can set environment variables:

```bash
SPECIALIST_IMAGE_PATH=/path/to/specialist.png \
PACKAGE_IMAGE_PATH=/path/to/package.png \
BANNER_IMAGE_PATH=/path/to/banner.png \
CORPORATE_IMAGE_PATH=/path/to/corporate.png \
PARTNERS_IMAGE_PATH=/path/to/partners.png \
HEALTH_TIPS_IMAGE_PATH=/path/to/health-tips.png \
DEV_AUTH_TOKEN=your_token \
npm run update-images
```

## Example Output

```
🚀 Starting image update process...

📤 Step 1: Uploading images...

📤 Uploading specialists image...
✅ Uploaded specialists image: /api/static/specialists/1740945050-specialist.png
📤 Uploading packages image...
✅ Uploaded packages image: /api/static/packages/1740945051-package.png
📤 Uploading banners image...
✅ Uploaded banners image: /api/static/banners/1740945052-banner.png

📋 Step 2: Fetching existing records...

📋 Fetching all specialists...
✅ Found 5 specialists
📋 Fetching all wellness packages...
✅ Found 10 wellness packages
📋 Fetching all banners...
✅ Found 3 banners

🔄 Step 3: Updating records...

📝 Updating 5 specialists...
  Updating specialist 507f1f77bcf86cd799439011...
  ✅ Updated specialist 507f1f77bcf86cd799439011
  ...
✅ All specialists updated

📝 Updating 10 wellness packages...
  ...
✅ All wellness packages updated

📝 Updating 3 banners...
  ...
✅ All banners updated

🎉 Image update process completed successfully!

Summary:
- Specialists updated: 5
- Wellness packages updated: 10
- Banners updated: 3
- Corporates updated: 2
- Partners updated: 3
- Health tips updated: 4
```

## Troubleshooting

### Error: Set DEV_AUTH_TOKEN before running the image update utility
- Make sure you've set the DEV_AUTH_TOKEN environment variable
- Obtain a development-only token through the approved fixture authentication flow

### Error: Image not found
- Make sure the images are in the `test/assets/` folder
- Or set custom paths using environment variables (SPECIALIST_IMAGE_PATH, PACKAGE_IMAGE_PATH, BANNER_IMAGE_PATH, CORPORATE_IMAGE_PATH)

### Error: Network error
- Make sure your backend server is running
- Check that BASE_URL is correct (default: http://localhost:4030)

### Error: Unauthorized (401)
- Your auth token may have expired
- Obtain a new development-only token through the approved fixture authentication flow
