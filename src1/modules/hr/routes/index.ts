import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requireAdmin, requireAdminOrHR } from '@/modules/middleware/auth';
import { HRController } from '@/modules/hr/controller';
import {
  corporateIdParamSchema,
  createHRSchema,
  updateHRSchema,
  hrCorporateOverviewQuerySchema,
  hrQuerySchema,
  idParamSchema,
  employeeIdParamSchema,
} from '@/modules/hr/validation';

const hrRouter = Router();

const hrController = new HRController();

hrRouter.use(requireAdminOrHR);

// Create employee record
hrRouter.post(
  '/',
  requireAdmin,
  validate(createHRSchema, 'body'),
  catchAsync(hrController.create)
);

// Get all employees (with optional query params)
// Query params:
//   - employeeId: Filter by employee ID
//   - userId: Filter by user ID
//   - department: Filter by department
//   - designation: Filter by designation
//   - employmentType: Filter by employment type ('full-time', 'part-time', 'contract', 'intern')
//   - employmentStatus: Filter by employment status ('active', 'inactive', 'terminated', 'on-leave')
//   - corporateId: Filter by corporate ID
//   - reportingManager: Filter by reporting manager employee ID
//   - isActive: Filter by active status ('true' or 'false')
//   - joiningDateFrom: Filter by joining date from (YYYYMMDD)
//   - joiningDateTo: Filter by joining date to (YYYYMMDD)
//   - search: Search by name, email, employeeId
//   - page: Page number for pagination
//   - limit: Items per page
// Example: ?department=HR&employmentStatus=active&page=1&limit=10
hrRouter.get(
  '/',
  validate(hrQuerySchema, 'query'),
  catchAsync(hrController.getAll)
);

// Get employees by department
hrRouter.get(
  '/department/:department',
  catchAsync(hrController.getByDepartment)
);

// Get employees by employment status
hrRouter.get(
  '/status/:status',
  catchAsync(hrController.getByEmploymentStatus)
);

// Get employees by corporate ID
hrRouter.get(
  '/corporate/:corporateId/overview',
  validate(corporateIdParamSchema, 'params'),
  validate(hrCorporateOverviewQuerySchema, 'query'),
  catchAsync(hrController.getCorporateOverview)
);

hrRouter.get(
  '/corporate/:corporateId',
  validate(corporateIdParamSchema, 'params'),
  catchAsync(hrController.getByCorporateId)
);

// Get employees by reporting manager
hrRouter.get(
  '/manager/:reportingManager',
  catchAsync(hrController.getByReportingManager)
);

// Get employee by employee ID
hrRouter.get(
  '/employee/:employeeId',
  validate(employeeIdParamSchema, 'params'),
  catchAsync(hrController.getByEmployeeId)
);

// Get employee by ID
hrRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  catchAsync(hrController.getById)
);

// Update employee record
hrRouter.put(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(updateHRSchema, 'body'),
  catchAsync(hrController.update)
);

// Delete employee record
hrRouter.delete(
  '/:id',
  requireAdmin,
  validate(idParamSchema, 'params'),
  catchAsync(hrController.delete)
);

export default hrRouter;
