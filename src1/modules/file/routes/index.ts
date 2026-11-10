import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { FileController } from '../controller';

const fileRouter = Router();

const fileController = new FileController();

// Simple file fetch API - pass URL as query parameter
// GET /api/v1/file/fetch?url=/api/v1/file/static/bookings/12345/document.pdf
// GET /api/v1/file/fetch?url=bookings/12345/document.pdf
fileRouter.get(
  '/fetch',
  catchAsync(fileController.fetchFile)
);

// Upload files - Generic file upload API
// POST /api/v1/file/upload
// Body: multipart/form-data with files field
// Optional: module and recordId in form data for organizing files
// Returns: Array of file URLs that can be used in booking create/update
fileRouter.post(
  '/upload',
  catchAsync(fileController.uploadFiles)
);

// Upload files for a specific module (alternative endpoint)
// POST /api/v1/file/upload/:module
fileRouter.post(
  '/upload/:module',
  catchAsync(fileController.uploadFiles)
);

// Serve static files
// GET /api/v1/file/static/:module/:recordId/:fileName
fileRouter.get(
  '/static/*',
  catchAsync(fileController.serveFile)
);

export default fileRouter;
