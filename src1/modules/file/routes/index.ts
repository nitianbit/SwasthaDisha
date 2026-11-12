import 'reflect-metadata';
import { Router, Request, Response, NextFunction } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { FileController, applyPrivateDocumentHeaders } from '../controller';

/** Called at the existing file mount before authentication; other prefixes retain their policy. */
export function privateDocumentHeaders(req: Request, res: Response, next: NextFunction): void {
  if (/^\/(?:assets(?:\/|$)|clinical(?:\/|$))/i.test(req.path)) applyPrivateDocumentHeaders(res);
  next();
}

const fileRouter = Router();

const fileController = new FileController();

// New private document commands; the existing central mount authenticates first.
fileRouter.post('/assets/uploads', catchAsync(fileController.uploadPrivateAsset));
fileRouter.post('/clinical/:resourceKind/:resourceId/uploads', catchAsync(fileController.uploadClinicalAsset));
fileRouter.get('/assets/:assetId/versions', catchAsync(fileController.listAssetVersions));
fileRouter.get('/assets/:assetId/versions/:versionId/content', catchAsync(fileController.readAssetContent));
fileRouter.post('/assets/:assetId/revoke', catchAsync(fileController.revokePrivateAsset));

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
