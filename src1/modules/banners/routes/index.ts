import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin } from '@/modules/middleware/auth';
import { BannerController } from '@/modules/banners/controller';
import {
  createBannerSchema,
  updateBannerSchema,
  bannerQuerySchema,
  idParamSchema,
  bannerTypeParamSchema,
} from '@/modules/banners/validation';

const bannerRouter = Router();

const bannerController = new BannerController();

// Create banner
bannerRouter.post(
  '/',
  requireAdmin,
  validate(createBannerSchema, 'body'),
  catchAsync(bannerController.create)
);

// Get all banners (with optional query params)
// Query params:
//   - bannerType: Filter by banner type ('home', 'promotional', 'category', etc.)
//   - target: Filter by target entity type ('wellnessPackage', 'specialist', 'category', 'partner', etc.)
//   - targetId: Filter by specific target entity ID (e.g., wellnessPackageId, specialistId)
//   - isActive: Filter by active status ('true' or 'false')
//   - page: Page number for pagination
//   - limit: Items per page
// Example: ?bannerType=home&target=wellnessPackage&targetId=6988310b8e6f65fbb238bcc9&isActive=true&page=1&limit=10
bannerRouter.get(
  '/',
  validate(bannerQuerySchema, 'query'),
  catchAsync(bannerController.getAll)
);

// Get active banners only (filtered by date range)
// Returns banners that are: isActive=true AND within startDate/endDate range (if dates are set)
bannerRouter.get(
  '/active',
  catchAsync(bannerController.getActiveBanners)
);

// Get banners by banner type
// Returns banners filtered by bannerType (e.g., 'home', 'promotional', 'category', etc.)
// Example: /api/v1/banners/type/home
bannerRouter.get(
  '/type/:bannerType',
  validate(bannerTypeParamSchema, 'params'),
  catchAsync(bannerController.getByBannerType)
);

// Get banners by target entity type
// Params:
//   - target: Entity type ('wellnessPackage', 'specialist', 'category', 'partner', etc.)
// Query params:
//   - targetId: Optional - specific entity ID to filter by
// Example: /api/v1/banners/target/wellnessPackage?targetId=6988310b8e6f65fbb238bcc9
// This returns banners where target='wellnessPackage' and optionally targetId matches
bannerRouter.get(
  '/target/:target',
  validate(bannerQuerySchema, 'query'),
  catchAsync(bannerController.getByTarget)
);

// Get banners by corporate ID
// Example: /api/v1/banners/corporate/6988310b8e6f65fbb238bcc9
bannerRouter.get(
  '/corporate/:id',
  validate(idParamSchema, 'params'),
  catchAsync(bannerController.getByCorporateId)
);

// Get banner by ID
bannerRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(bannerController.getById)
);

// Update banner
bannerRouter.put(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(updateBannerSchema, 'body'),
  catchAsync(bannerController.update)
);

// Delete banner
bannerRouter.delete(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(bannerController.delete)
);

export default bannerRouter;
