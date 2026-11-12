import Joi from 'joi';
import { types } from 'util';
import { AppError } from '@/modules/common/types';
import { DueRefillCursor, DueRefillQuery, DueRefillRow } from '../types';

const subscriptionItemSchema = Joi.object({
  medicineId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  medicineName: Joi.string().trim().optional(),
  frequency: Joi.string().trim().optional(),
  intervalDays: Joi.number().integer().min(1).required(),
  nextRefillDate: Joi.string().pattern(/^\d{8}$/).optional(),
  reminderChannel: Joi.string().valid('sms', 'push', 'both', 'none').optional(),
});

export const createSubscriptionSchema = Joi.object({
  userId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  items: Joi.array().items(subscriptionItemSchema).min(1).required(),
});

export const updateSubscriptionSchema = Joi.object({
  intervalDays: Joi.number().integer().min(1).optional(),
  nextRefillDate: Joi.string().pattern(/^\d{8}$/).optional(),
  reminderChannel: Joi.string().valid('sms', 'push', 'both', 'none').optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

export const pauseSubscriptionSchema = Joi.object({
  pausedUntil: Joi.string().pattern(/^\d{8}$/).optional(),
});

export const idParamSchema = Joi.object({
  id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
});

const refillQueryError = () => new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid refill worklist query' });

/** A calendar label, with no host-timezone/current-date interpretation. */
export function isRefillCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6, 8));
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function requireRefillPharmacyScope(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{24}$/.test(value)) {
    throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
  }
  return value;
}

function refillData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw refillQueryError();
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) throw refillQueryError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw refillQueryError();
    out[key] = descriptor.value;
  }
  return out;
}

function refillCursorText(cursor: DueRefillCursor): string {
  return Buffer.from(JSON.stringify({ v: cursor.v, pharmacyId: cursor.pharmacyId, through: cursor.through,
    limit: cursor.limit, nextRefillDate: cursor.nextRefillDate, subscriptionId: cursor.subscriptionId }), 'utf8').toString('base64url');
}

export function parseDueRefillQuery(pharmacyId: string, raw: unknown): DueRefillQuery {
  requireRefillPharmacyScope(pharmacyId);
  const query = refillData(raw, ['through', 'limit', 'after']);
  if (!isRefillCalendarDate(query.through) || (query.limit !== undefined &&
    (typeof query.limit !== 'string' || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(query.limit)))) throw refillQueryError();
  const through = query.through, limit = query.limit === undefined ? 20 : Number(query.limit);
  let after: DueRefillCursor | undefined;
  if (query.after !== undefined) {
    if (typeof query.after !== 'string' || !/^[A-Za-z0-9_-]{1,384}$/.test(query.after)) throw refillQueryError();
    const bytes = Buffer.from(query.after, 'base64url');
    if (bytes.length > 288 || bytes.toString('base64url') !== query.after || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) throw refillQueryError();
    let decoded: unknown;
    try { decoded = JSON.parse(bytes.toString('utf8')); } catch { throw refillQueryError(); }
    const cursor = refillData(decoded, ['v', 'pharmacyId', 'through', 'limit', 'nextRefillDate', 'subscriptionId']);
    if (Object.keys(cursor).length !== 6 || cursor.v !== 1 || cursor.pharmacyId !== pharmacyId || cursor.through !== through ||
      cursor.limit !== limit || !isRefillCalendarDate(cursor.nextRefillDate) || cursor.nextRefillDate > through ||
      typeof cursor.subscriptionId !== 'string' || !/^[0-9a-f]{24}$/.test(cursor.subscriptionId)) throw refillQueryError();
    after = Object.freeze({ v: 1, pharmacyId, through, limit, nextRefillDate: cursor.nextRefillDate, subscriptionId: cursor.subscriptionId });
    // Fixed-order serialization also rejects duplicate keys and alternate JSON spelling/order.
    if (refillCursorText(after) !== query.after) throw refillQueryError();
  }
  return Object.freeze({ through, limit, ...(after ? { after } : {}) });
}

export function encodeDueRefillCursor(pharmacyId: string, query: DueRefillQuery, row: DueRefillRow): string {
  return refillCursorText({ v: 1, pharmacyId, through: query.through, limit: query.limit,
    nextRefillDate: row.nextRefillDate, subscriptionId: row.subscriptionId });
}
