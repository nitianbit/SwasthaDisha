import { Service } from 'typedi';
import { Model, Types } from 'mongoose';
import { types } from 'util';
import { AppError } from '@/modules/common/types';
import { encodeDueRefillCursor, isRefillCalendarDate, requireRefillPharmacyScope } from '../validation';
import PharmacySubscriptionModel from '@/modules/pharmacySubscriptions/model';
import { IPharmacySubscription, SubscriptionQueryParams, DueRefillQuery, DueRefillRow, DueRefillPage, REFILL_REMINDER_CHANNELS, ReminderChannel } from '@/modules/pharmacySubscriptions/types';
import { BaseRepository } from '@/modules/common/repository';

const refillUnavailable = () => new AppError({ status: 503, code: 'REFILL_WORKLIST_UNAVAILABLE', message: 'Refill worklist is unavailable' });
const dueProjection = { _id: 1, pharmacyId: 1, isActive: 1, nextRefillDate: 1, intervalDays: 1, reminderChannel: 1, pausedUntil: 1 };

let refillObjectIdKey: symbol | undefined;
function refillObjectId(value: unknown): string {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Types.ObjectId.prototype) throw refillUnavailable();
  if (refillObjectIdKey === undefined) {
    // BSON4.7.2 keeps its bytes under one module-private Symbol; do not identify it by its description.
    const probe = new Types.ObjectId('000000000000000000000000');
    const symbols = Object.getOwnPropertySymbols(probe);
    if (symbols.length !== 1 || Reflect.ownKeys(probe).some(key => key !== symbols[0] && key !== '__id')) throw refillUnavailable();
    refillObjectIdKey = symbols[0];
  }
  const keys = Reflect.ownKeys(value);
  if (!keys.includes(refillObjectIdKey) || keys.some(key => key !== refillObjectIdKey && key !== '__id')) throw refillUnavailable();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw refillUnavailable();
  }
  const bytes = Object.getOwnPropertyDescriptor(value, refillObjectIdKey)!.value;
  if (!bytes || typeof bytes !== 'object' || types.isProxy(bytes) || !Buffer.isBuffer(bytes) || Object.getPrototypeOf(bytes) !== Buffer.prototype) throw refillUnavailable();
  const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
  if (Reflect.apply(byteLength, bytes, []) !== 12 || Reflect.ownKeys(bytes).length !== 12) throw refillUnavailable();
  const owned = Buffer.alloc(12);
  for (let i = 0; i < 12; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(bytes, String(i));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || !Number.isInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 255) throw refillUnavailable();
    owned[i] = descriptor.value;
  }
  const id = Reflect.apply(Buffer.prototype.toString, owned, ['hex']);
  const cache = Object.getOwnPropertyDescriptor(value, '__id');
  if (cache && cache.value !== id) throw refillUnavailable();
  return id;
}

function dueRefillRow(value: unknown, pharmacyId: string, through: string): DueRefillRow {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw refillUnavailable();
  const allowed = Object.keys(dueProjection), row: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw refillUnavailable();
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d) || !d.enumerable) throw refillUnavailable();
    row[key] = d.value;
  }
  const subscriptionId = refillObjectId(row._id);
  if (refillObjectId(row.pharmacyId) !== pharmacyId || row.isActive !== true || !isRefillCalendarDate(row.nextRefillDate) ||
    row.nextRefillDate > through || typeof row.intervalDays !== 'number' || !Number.isSafeInteger(row.intervalDays) || row.intervalDays < 1) throw refillUnavailable();
  const has = (key: string) => Object.prototype.hasOwnProperty.call(row, key);
  if ((has('reminderChannel') && (typeof row.reminderChannel !== 'string' || !(REFILL_REMINDER_CHANNELS as readonly string[]).includes(row.reminderChannel))) ||
    (has('pausedUntil') && !isRefillCalendarDate(row.pausedUntil))) throw refillUnavailable();
  return { subscriptionId, nextRefillDate: row.nextRefillDate, intervalDays: row.intervalDays,
    reminderChannel: has('reminderChannel') ? row.reminderChannel as ReminderChannel : null,
    pausedUntil: has('pausedUntil') ? row.pausedUntil as string : null, pauseEvaluation: 'not_evaluated' };
}

@Service()
export class PharmacySubscriptionRepository extends BaseRepository<IPharmacySubscription> {
  constructor() {
    super(PharmacySubscriptionModel as Model<IPharmacySubscription>);
  }

  /** Parsed immutable primitives only; one mandatory-owner read with no patient population. */
  async findDueRefills(pharmacyId: string, query: DueRefillQuery): Promise<DueRefillPage> {
    const scope = requireRefillPharmacyScope(pharmacyId);
    try {
      const filter = { pharmacyId: { $eq: new Types.ObjectId(scope) }, isActive: { $eq: true },
        nextRefillDate: { $lte: query.through }, $expr: { $and: [
          { $eq: [{ $type: '$_id' }, 'objectId'] }, { $eq: [{ $type: '$pharmacyId' }, 'objectId'] },
          { $eq: [{ $type: '$isActive' }, 'bool'] }, { $eq: [{ $type: '$nextRefillDate' }, 'string'] },
        ] }, ...(query.after ? { $or: [ { nextRefillDate: { $gt: query.after.nextRefillDate } },
          { nextRefillDate: { $eq: query.after.nextRefillDate }, _id: { $gt: new Types.ObjectId(query.after.subscriptionId) } } ] } : {}) };
      const rows = await PharmacySubscriptionModel.find(filter).select(dueProjection).collation({ locale: 'simple' })
        .sort({ nextRefillDate: 1, _id: 1 }).limit(query.limit + 1).maxTimeMS(2000).lean().exec();
      if (!Array.isArray(rows) || types.isProxy(rows) || Object.getPrototypeOf(rows) !== Array.prototype) throw refillUnavailable();
      const length = Object.getOwnPropertyDescriptor(rows, 'length');
      if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > query.limit + 1) throw refillUnavailable();
      const keys = Reflect.ownKeys(rows);
      if (keys.length !== length.value + 1 || keys[length.value] !== 'length') throw refillUnavailable();
      let previous: Pick<DueRefillRow, 'nextRefillDate' | 'subscriptionId'> | undefined = query.after;
      const mapped: DueRefillRow[] = [];
      for (let index = 0; index < length.value; index++) {
        const entry = Object.getOwnPropertyDescriptor(rows, String(index));
        if (keys[index] !== String(index) || !entry || !('value' in entry) || !entry.enumerable) throw refillUnavailable();
        const result = dueRefillRow(entry.value, scope, query.through);
        if (previous && (result.nextRefillDate < previous.nextRefillDate || (result.nextRefillDate === previous.nextRefillDate &&
          result.subscriptionId <= previous.subscriptionId))) throw refillUnavailable();
        previous = result;
        mapped.push(result);
      }
      const items = mapped.slice(0, query.limit);
      return { through: query.through, limit: query.limit, items,
        nextCursor: mapped.length > query.limit ? encodeDueRefillCursor(scope, query, items[items.length - 1]) : null };
    } catch { throw refillUnavailable(); }
  }

  async findWithPagination(
    filter: SubscriptionQueryParams,
    page = 1,
    limit = 20
  ): Promise<{ data: IPharmacySubscription[]; total: number; page: number; totalPages: number }> {
    const query: any = {};
    if (filter.pharmacyId) query.pharmacyId = filter.pharmacyId;
    if (filter.userId) query.userId = filter.userId;
    if (filter.medicineId) query.medicineId = filter.medicineId;
    if (filter.isActive !== undefined) query.isActive = filter.isActive;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      PharmacySubscriptionModel.find(query)
        .populate('medicineId', 'name genericName')
        .populate('userId', 'name phone')
        .sort({ nextRefillDate: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PharmacySubscriptionModel.countDocuments(query),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findBySourceOrderId(sourceOrderId: string): Promise<IPharmacySubscription[]> {
    return PharmacySubscriptionModel.find({ sourceOrderId }).lean();
  }
}
