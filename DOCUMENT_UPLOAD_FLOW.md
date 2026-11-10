# Document Upload Flow for Bookings

## Overview

This document explains how to upload documents (reports, prescriptions, etc.) to bookings. The flow uses a **generic file upload API** that returns URLs, which can then be passed in booking create/update requests.

## Architecture

### Components

1. **File Service** (`src1/modules/file/services/index.ts`)
   - Handles file uploads using `formidable`
   - Validates file types (JPG, PNG, PDF)
   - Validates file size (max 10MB)
   - Saves files to organized directory structure
   - Returns file URLs

2. **File Controller** (`src1/modules/file/controller/index.ts`)
   - Generic file upload endpoint
   - Returns URLs that can be used anywhere

3. **Booking Service** (`src1/modules/bookings/services/index.ts`)
   - Accepts document URLs in create/update requests
   - Stores documents in booking's documents array

## Recommended Flow

### Step 1: Upload Files (Get URLs)

**Upload files using the generic file upload API:**

```bash
POST /api/v1/file/upload
Content-Type: multipart/form-data

Form Data:
- files: [file1.pdf, file2.jpg] (multiple files)
- module: "bookings" (optional, for organizing files)
- recordId: "bookingId" (optional, for organizing files)
```

**Or use module-specific endpoint:**

```bash
POST /api/v1/file/upload/bookings
Content-Type: multipart/form-data

Form Data:
- files: [file1.pdf, file2.jpg]
- recordId: "bookingId" (optional)
```

**Response:**
```json
{
  "success": true,
  "message": "Files uploaded successfully",
  "data": {
    "files": [
      {
        "url": "/api/v1/file/static/bookings/timestamp-filename.pdf",
        "fileName": "timestamp-filename.pdf",
        "originalFileName": "report.pdf",
        "fileSize": 1024000,
        "mimeType": "application/pdf"
      },
      {
        "url": "/api/v1/file/static/bookings/timestamp-prescription.jpg",
        "fileName": "timestamp-prescription.jpg",
        "originalFileName": "prescription.jpg",
        "fileSize": 512000,
        "mimeType": "image/jpeg"
      }
    ]
  }
}
```

### Step 2: Use URLs in Booking Create/Update

**Option A: Create Booking with Documents**

```bash
POST /api/v1/bookings/wellness-package
Content-Type: application/json

{
  "userId": "user123",
  "wellnessPackageId": "package123",
  "bookingDate": "2025-07-12T00:00:00Z",
  "bookingTime": "9:00 AM",
  "serviceMode": "in-person",
  "documents": [
    {
      "type": "report",
      "url": "/api/v1/file/static/bookings/timestamp-filename.pdf",
      "fileName": "timestamp-filename.pdf"
    },
    {
      "type": "prescription",
      "url": "/api/v1/file/static/bookings/timestamp-prescription.jpg",
      "fileName": "timestamp-prescription.jpg"
    }
  ]
}
```

**Option B: Update Booking with Documents**

```bash
PUT /api/v1/bookings/:bookingId
Content-Type: application/json

{
  "documents": [
    {
      "type": "report",
      "url": "/api/v1/file/static/bookings/timestamp-filename.pdf",
      "fileName": "timestamp-filename.pdf"
    }
  ]
}
```

**Option C: Add Documents to Existing Booking**

```bash
# 1. Get current booking
GET /api/v1/bookings/:bookingId

# 2. Upload new files
POST /api/v1/file/upload/bookings
# Returns new file URLs

# 3. Update booking with existing + new documents
PUT /api/v1/bookings/:bookingId
{
  "documents": [
    ...existingDocuments,
    ...newDocuments
  ]
}
```

## API Endpoints

### File Upload Endpoints (Generic)

```
POST   /api/v1/file/upload                  - Upload files (generic)
POST   /api/v1/file/upload/:module          - Upload files for a module
GET    /api/v1/file/static/*                - Serve static files
```

**Note:** The file upload API returns URLs that can be used in any create/update operation, not just bookings.

## File Storage Structure

```
files/
├── bookings/
│   ├── bookingId1/
│   │   ├── timestamp-file1.pdf
│   │   └── timestamp-file2.jpg
│   └── bookingId2/
│       └── timestamp-file3.pdf
├── dependents/
│   └── dependentId1/
│       └── timestamp-photo.jpg
└── specialists/
    └── specialistId1/
        └── timestamp-certificate.pdf
```

## Document Types

Documents can be of three types:
- `report` - Medical reports
- `prescription` - Prescriptions
- `other` - Other documents

The system auto-detects the type based on:
1. File name (if contains "prescription" or "report")
2. MIME type (PDF defaults to "report")
3. Falls back to "other"

## File Validation

- **Allowed Types**: JPG, PNG, PDF
- **Max File Size**: 10MB per file
- **Multiple Files**: Supported (upload multiple files in one request)

## Example: Complete Flow

### Frontend Implementation Example

```typescript
// Step 1: Upload files first (get URLs)
const formData = new FormData();
formData.append('files', reportFile);
formData.append('files', prescriptionFile);
formData.append('module', 'bookings'); // Optional: for organizing files

const uploadResponse = await fetch('/api/v1/file/upload', {
  method: 'POST',
  body: formData,
});

const { data } = await uploadResponse.json();

// Step 2: Map to document format
const documents = data.files.map(file => ({
  type: file.originalFileName.toLowerCase().includes('prescription') 
    ? 'prescription' 
    : file.originalFileName.toLowerCase().includes('report')
    ? 'report'
    : 'other',
  url: file.url,
  fileName: file.fileName,
}));

// Step 3: Create booking with document URLs
const bookingResponse = await fetch('/api/v1/bookings/wellness-package', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: 'user123',
    wellnessPackageId: 'package123',
    bookingDate: '2025-07-12T00:00:00Z',
    bookingTime: '9:00 AM',
    serviceMode: 'in-person',
    documents, // Use uploaded document URLs
  }),
});
```

### Upload Documents After Booking Creation

```typescript
// Step 1: Create booking (without documents)
const booking = await createBooking({ ...bookingData });

// Step 2: Upload files
const formData = new FormData();
formData.append('files', reportFile);
formData.append('files', prescriptionFile);
formData.append('module', 'bookings');
formData.append('recordId', booking._id); // Organize by booking ID

const uploadRes = await fetch('/api/v1/file/upload', {
  method: 'POST',
  body: formData,
});

const { data } = await uploadRes.json();

// Step 3: Map to documents and update booking
const newDocuments = data.files.map(file => ({
  type: file.originalFileName.toLowerCase().includes('prescription') 
    ? 'prescription' 
    : 'report',
  url: file.url,
  fileName: file.fileName,
}));

// Get existing documents and merge
const existingBooking = await getBooking(booking._id);
const allDocuments = [
  ...(existingBooking.documents || []),
  ...newDocuments,
];

// Update booking with all documents
await updateBooking(booking._id, { documents: allDocuments });
```

## Delete Documents

To remove a document from a booking:

```bash
# 1. Get current booking
GET /api/v1/bookings/:bookingId

# 2. Update booking without the document
PUT /api/v1/bookings/:bookingId
{
  "documents": [
    // All documents except the one to delete
  ]
}
```

**Note:** The file will remain in storage. If you want to delete the physical file, you can implement a separate cleanup job or add a file deletion endpoint.

## Best Practices

1. **Upload files first, then create booking** - This ensures files are available before booking creation
2. **Use bookingId in file upload** - When uploading after booking creation, the system organizes files by bookingId
3. **Validate file types on frontend** - Check file types before upload to provide better UX
4. **Handle upload errors** - Implement retry logic for failed uploads
5. **Clean up unused files** - If booking creation fails after file upload, consider cleanup

## Environment Variables

Add to your `.env`:
```
UPLOAD_DIR=./files
```

## Notes

- Files are stored locally in the `files/` directory
- File URLs are relative paths that need to be served via the static file endpoint
- For production, consider using cloud storage (S3, Cloudinary, etc.) instead of local storage
- The file service can be extended to support cloud storage providers
