import 'reflect-metadata';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import Joi from 'joi';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { AppError } from '@/modules/common/types';
import { requireOperationalPharmacy } from '@/modules/middleware/auth';
import { InventoryImportController } from '@/modules/pharmacyInventoryImports/controller';

const pharmacyInventoryImportRouter = Router();
const controller = new InventoryImportController();
const uploadDir = path.resolve(process.cwd(), 'uploads', 'inventory-imports');
fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

/** Q16c: refused uploads answer 400 with their own code (they were 500s). */
class UploadRefused extends AppError {}

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new UploadRefused({ status: 400, code: 'UNSUPPORTED_FILE_TYPE', message: 'Only .xlsx, .xls and .csv files can be imported' }));
    }
  },
});

/**
 * Q16c: the upload with its refusals as 400s: a wrong extension (UNSUPPORTED_FILE_TYPE), a file over 10 MB
 * (FILE_TOO_LARGE), a file sent in another field than `file` or more than one file (UNEXPECTED_FILE_FIELD), any other
 * malformed upload (UPLOAD_INVALID). Multer removes what it had written of a refused upload.
 */
function uploadImportFile(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (error: unknown) => {
    if (!error) return next();
    if (error instanceof UploadRefused) return next(error);
    if (error instanceof multer.MulterError) {
      const code = error.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE'
        : error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_FILE_COUNT' ? 'UNEXPECTED_FILE_FIELD'
        : 'UPLOAD_INVALID';
      const message = code === 'FILE_TOO_LARGE' ? 'The file is larger than 10 MB'
        : code === 'UNEXPECTED_FILE_FIELD' ? 'Send one file, in the form field "file"'
        : 'The upload could not be read';
      return next(new AppError({ status: 400, code, message }));
    }
    return next(new AppError({ status: 400, code: 'UPLOAD_INVALID', message: 'The upload could not be read' }));
  });
}

// Q16c: import ids are checked at the route (a malformed one was a 500 from the database cast).
const importId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required().messages({
  'string.pattern.base': 'Invalid import id', 'any.required': 'importId is required', 'string.base': 'Invalid import id',
});
const idParams = validate(Joi.object({ id: importId }), 'params');

// Step 1: Upload file and get preview with row-level validation
pharmacyInventoryImportRouter.post(
  '/preview',
  requireOperationalPharmacy,
  uploadImportFile,
  catchAsync(controller.preview)
);

// Step 2: Commit a previewed import
pharmacyInventoryImportRouter.post(
  '/commit',
  requireOperationalPharmacy,
  validate(Joi.object({ importId }), 'body'),
  catchAsync(controller.commit)
);

// Q16c: the sample file with the exact columns and how to fill them (before '/:id').
pharmacyInventoryImportRouter.get('/template', requireOperationalPharmacy, catchAsync(controller.template));

// List import history
pharmacyInventoryImportRouter.get('/', requireOperationalPharmacy, catchAsync(controller.list));

pharmacyInventoryImportRouter.post(
  '/:id/retry',
  requireOperationalPharmacy,
  idParams,
  catchAsync(controller.retry)
);

pharmacyInventoryImportRouter.get(
  '/:id/failed-rows/download',
  requireOperationalPharmacy,
  idParams,
  catchAsync(controller.downloadFailedRows)
);

// Get specific import record
pharmacyInventoryImportRouter.get('/:id', requireOperationalPharmacy, idParams, catchAsync(controller.getById));

export default pharmacyInventoryImportRouter;
