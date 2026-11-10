import 'reflect-metadata';
import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { requireOperationalPharmacy } from '@/modules/middleware/auth';
import { InventoryImportController } from '@/modules/pharmacyInventoryImports/controller';

const pharmacyInventoryImportRouter = Router();
const controller = new InventoryImportController();
const uploadDir = path.resolve(process.cwd(), 'uploads', 'inventory-imports');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx, .xls, and .csv files are allowed'));
    }
  },
});

// Step 1: Upload file and get preview with row-level validation
pharmacyInventoryImportRouter.post(
  '/preview',
  requireOperationalPharmacy,
  upload.single('file'),
  catchAsync(controller.preview)
);

// Step 2: Commit a previewed import
pharmacyInventoryImportRouter.post(
  '/commit',
  requireOperationalPharmacy,
  catchAsync(controller.commit)
);

// List import history
pharmacyInventoryImportRouter.get('/', requireOperationalPharmacy, catchAsync(controller.list));

pharmacyInventoryImportRouter.post(
  '/:id/retry',
  requireOperationalPharmacy,
  catchAsync(controller.retry)
);

pharmacyInventoryImportRouter.get(
  '/:id/failed-rows/download',
  requireOperationalPharmacy,
  catchAsync(controller.downloadFailedRows)
);

// Get specific import record
pharmacyInventoryImportRouter.get('/:id', requireOperationalPharmacy, catchAsync(controller.getById));

export default pharmacyInventoryImportRouter;
