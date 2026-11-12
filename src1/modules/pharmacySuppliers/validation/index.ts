import Joi from 'joi';
import { AppError } from '@/modules/common/types';
import { SUPPLIER_FIELDS, SUPPLIER_TEXT_LIMITS, SupplierCommand, SupplierFields, SupplierListQuery } from '@/modules/pharmacySuppliers/types';

export const supplierUnavailable = () => new AppError({
  status: 503, code: 'SUPPLIER_MASTER_UNAVAILABLE', message: 'Supplier master is unavailable',
});
export const supplierConflict = () => new AppError({ status: 409, code: 'SUPPLIER_CONFLICT', message: 'Supplier changed' });
const invalidRequest = () => new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid supplier request' });
const invalidQuery = () => new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid supplier query' });
export const isSupplierId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{24}$/.test(value);
export function assertSupplierScope(value: unknown): asserts value is string {
  if (!isSupplierId(value)) throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
}
export function assertSupplierId(value: unknown): asserts value is string {
  if (!isSupplierId(value)) throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid supplier ID' });
}
export function assertSupplierBody(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalidRequest();
}
const fieldsSchema = Joi.object({
  displayName: Joi.string().trim().min(1).max(SUPPLIER_TEXT_LIMITS.displayName).required(),
  contactName: Joi.string().trim().min(1).max(SUPPLIER_TEXT_LIMITS.contactName).allow(null).required(),
  phone: Joi.string().trim().min(1).max(SUPPLIER_TEXT_LIMITS.phone).pattern(/^[+0-9(). -]+$/).allow(null).required(),
  email: Joi.string().trim().email({ tlds: { allow: false } }).max(SUPPLIER_TEXT_LIMITS.email).allow(null).required(),
  address: Joi.string().trim().min(1).max(SUPPLIER_TEXT_LIMITS.address).allow(null).required(),
}).unknown(false);
const patchSchema = fieldsSchema.fork([...SUPPLIER_FIELDS], field => field.optional()).min(1);
const options = { convert: false, stripUnknown: false, abortEarly: false };
export function validStoredSupplierFields(value: unknown): value is SupplierFields {
  return !fieldsSchema.validate(value, options).error;
}
export function normalizeSupplierCommand(kind: 'create', body: Record<string, unknown>): Extract<SupplierCommand, { kind: 'create' }>;
export function normalizeSupplierCommand(kind: 'update', body: Record<string, unknown>): Extract<SupplierCommand, { kind: 'update' }>;
export function normalizeSupplierCommand(kind: 'archive', body: Record<string, unknown>): Extract<SupplierCommand, { kind: 'archive' }>;
export function normalizeSupplierCommand(kind: SupplierCommand['kind'], body: Record<string, unknown>): SupplierCommand {
  const allowed: readonly string[] = kind === 'create' ? SUPPLIER_FIELDS
    : kind === 'update' ? [...SUPPLIER_FIELDS, 'expectedRevision'] : ['expectedRevision'];
  const keys = Reflect.ownKeys(body);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) {
    throw new AppError({ status: 422, code: 'FORBIDDEN_FIELD', message: 'One or more fields cannot be changed through this endpoint' });
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(body, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw invalidRequest();
  }
  for (const key of keys) {
    if (Object.getOwnPropertyDescriptor(body, key)!.value === undefined) throw invalidRequest();
  }
  const fields: Record<string, unknown> = {};
  if (kind !== 'archive') {
    for (const key of SUPPLIER_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(body, key);
      if (!descriptor && kind === 'update') continue;
      if (!descriptor) { fields[key] = key === 'displayName' ? undefined : null; continue; }
      const value = descriptor.value;
      if (value === null) fields[key] = null;
      else if (typeof value === 'string') {
        const normalized = value.trim();
        fields[key] = key !== 'displayName' && normalized.length === 0 ? null : normalized;
      } else throw invalidRequest();
    }
    if ((kind === 'create' ? fieldsSchema : patchSchema).validate(fields, options).error) throw invalidRequest();
  }
  if (kind === 'create') return { kind, fields: fields as unknown as SupplierFields };
  const expectedRevision = Object.getOwnPropertyDescriptor(body, 'expectedRevision')?.value;
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw invalidRequest();
  return kind === 'archive' ? { kind, expectedRevision } : { kind, fields: fields as Partial<SupplierFields>, expectedRevision };
}
export const supplierListQuerySchema = Joi.object({
  state: Joi.string().valid('active', 'archived', 'all').optional(),
  page: Joi.number().integer().min(1).max(1000).optional(),
  limit: Joi.number().integer().min(1).max(50).optional(),
  pharmacyId: Joi.forbidden(),
});
export function normalizeSupplierQuery(value: unknown): SupplierListQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalidQuery();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !['state', 'page', 'limit'].includes(key) ||
      !descriptor.enumerable || !('value' in descriptor)) throw invalidQuery();
  }
  const state = Object.getOwnPropertyDescriptor(value, 'state')?.value;
  const page = Object.getOwnPropertyDescriptor(value, 'page')?.value;
  const limit = Object.getOwnPropertyDescriptor(value, 'limit')?.value;
  const query = { state: state === undefined ? 'active' : state, page: page === undefined ? 1 : page, limit: limit === undefined ? 20 : limit };
  if (supplierListQuerySchema.validate(query, options).error) throw invalidQuery();
  return query as SupplierListQuery;
}
