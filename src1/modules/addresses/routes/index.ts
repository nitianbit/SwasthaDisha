import 'reflect-metadata';
import { Router } from 'express';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { AddressController } from '@/modules/addresses/controller';
import {
  createAddressSchema,
  updateAddressSchema,
  addressQuerySchema,
  idParamSchema,
} from '@/modules/addresses/validation';

const addressRouter = Router();

const addressController = new AddressController();

addressRouter.post(
  '/',
  validate(createAddressSchema, 'body'),
  catchAsync(addressController.create)
);

addressRouter.get(
  '/',
  validate(addressQuerySchema, 'query'),
  catchAsync(addressController.getAll)
);

addressRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(addressQuerySchema, 'query'),
  catchAsync(addressController.getById)
);

addressRouter.put(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateAddressSchema, 'body'),
  validate(addressQuerySchema, 'query'),
  catchAsync(addressController.update)
);

addressRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(addressQuerySchema, 'query'),
  catchAsync(addressController.delete)
);

export default addressRouter;
