import { Service } from 'typedi';
import { PharmacySubscriptionRepository } from '@/modules/pharmacySubscriptions/repository';
import { PharmacyCustomerService } from '@/modules/pharmacyCustomers/services';
import {
  IPharmacySubscription,
  CreateSubscriptionRequest,
  SubscriptionItemInput,
  SubscriptionOrderLinkage,
  UpdateSubscriptionRequest,
  SubscriptionQueryParams,
} from '@/modules/pharmacySubscriptions/types';
import { AppError } from '@/modules/common/types';
import { parseDueRefillQuery, requireRefillPharmacyScope } from '../validation';

@Service()
export class PharmacySubscriptionService {
  constructor(
    private repo: PharmacySubscriptionRepository,
    private customerService: PharmacyCustomerService
  ) {}

  private async createManyAtomic(
    pharmacyId: string,
    userId: string,
    items: SubscriptionItemInput[],
    createdById: string,
    linkage?: SubscriptionOrderLinkage
  ): Promise<IPharmacySubscription[]> {
    const created: IPharmacySubscription[] = [];

    try {
      for (const item of items) {
        const subscription = await this.createOne(pharmacyId, userId, item, createdById, linkage);
        created.push(subscription);
      }
      return created;
    } catch (error) {
      for (let index = created.length - 1; index >= 0; index -= 1) {
        await this.repo.delete({ _id: created[index]._id }).catch(() => undefined);
      }
      throw error;
    }
  }

  async create(
    pharmacyId: string,
    data: CreateSubscriptionRequest,
    createdById: string
  ): Promise<IPharmacySubscription[]> {
    // Enforce privacy: user must be linked to this pharmacy
    await this.customerService.assertLinked(pharmacyId, data.userId);

    return this.createManyAtomic(pharmacyId, data.userId, data.items, createdById);
  }

  async createManyForUser(
    pharmacyId: string,
    userId: string,
    items: SubscriptionItemInput[],
    createdById: string,
    linkage?: SubscriptionOrderLinkage
  ): Promise<IPharmacySubscription[]> {
    if (!items.length) {
      return [];
    }

    await this.customerService.assertLinked(pharmacyId, userId);
    return this.createManyAtomic(pharmacyId, userId, items, createdById, linkage);
  }

  async createManyForOrder(
    pharmacyId: string,
    userId: string,
    items: SubscriptionItemInput[],
    createdById: string,
    linkage: SubscriptionOrderLinkage
  ): Promise<IPharmacySubscription[]> {
    return this.createManyForUser(pharmacyId, userId, items, createdById, linkage);
  }

  async reconcileForOrder(
    pharmacyId: string,
    userId: string,
    sourceOrderId: string,
    sourceOrderStatus: string,
    items: SubscriptionItemInput[],
    createdById: string
  ): Promise<void> {
    await this.customerService.assertLinked(pharmacyId, userId);

    const existingSubscriptions = await this.repo.findBySourceOrderId(sourceOrderId);
    const nextItemsByMedicine = new Map(items.map((item) => [item.medicineId, item]));
    const existingByMedicine = new Map(
      existingSubscriptions.map((subscription) => [String(subscription.medicineId), subscription])
    );

    for (const subscription of existingSubscriptions) {
      const medicineId = String(subscription.medicineId);
      const nextItem = nextItemsByMedicine.get(medicineId);

      if (!nextItem) {
        await this.repo.update(
          { _id: subscription._id },
          {
            isActive: false,
            sourceOrderStatus,
            lastSyncStatus: 'synced',
            lastSyncError: undefined,
          }
        );
        continue;
      }

      await this.repo.update(
        { _id: subscription._id },
        {
          userId,
          medicineName: nextItem.medicineName,
          frequency: nextItem.frequency,
          intervalDays: nextItem.intervalDays,
          nextRefillDate: nextItem.nextRefillDate,
          reminderChannel: nextItem.reminderChannel ?? 'push',
          isActive: true,
          sourceOrderStatus,
          lastSyncStatus: 'synced',
          lastSyncError: undefined,
          createdById,
          createdByRole: 'pharmacy',
        }
      );
    }

    const newItems = items.filter((item) => !existingByMedicine.has(item.medicineId));
    if (newItems.length) {
      await this.createManyForOrder(pharmacyId, userId, newItems, createdById, {
        sourceOrderId,
        sourceOrderStatus,
        lastSyncStatus: 'synced',
      });
    }
  }

  private createOne(
    pharmacyId: string,
    userId: string,
    item: SubscriptionItemInput,
    createdById: string,
    linkage?: SubscriptionOrderLinkage
  ): Promise<IPharmacySubscription> {
    return this.repo.save({
      pharmacyId,
      userId,
      medicineId: item.medicineId,
      medicineName: item.medicineName,
      frequency: item.frequency,
      intervalDays: item.intervalDays,
      nextRefillDate: item.nextRefillDate,
      reminderChannel: item.reminderChannel ?? 'push',
      isActive: true,
      sourceOrderId: linkage?.sourceOrderId,
      sourceOrderStatus: linkage?.sourceOrderStatus,
      lastSyncStatus: linkage?.lastSyncStatus ?? 'synced',
      lastSyncError: linkage?.lastSyncError,
      createdById,
      createdByRole: 'pharmacy',
    });
  }

  async getDueRefills(pharmacyId: unknown, rawQuery: unknown) {
    const scope = requireRefillPharmacyScope(pharmacyId);
    return this.repo.findDueRefills(scope, parseDueRefillQuery(scope, rawQuery));
  }

  async getAll(filter: SubscriptionQueryParams) {
    return this.repo.findWithPagination(filter, filter.page ?? 1, filter.limit ?? 20);
  }

  async update(
    id: string,
    pharmacyId: string,
    data: UpdateSubscriptionRequest
  ): Promise<IPharmacySubscription> {
    const sub = await this.repo.findById(id);
    if (!sub) {
      throw new AppError({ status: 404, code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription not found' });
    }
    if (String(sub.pharmacyId) !== pharmacyId) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }

    const nextPayload: UpdateSubscriptionRequest = { ...data };
    if (data.isActive === true) {
      delete nextPayload.pausedUntil;
    }

    const updated = await this.repo.update({ _id: id }, data.isActive === true
      ? { $set: nextPayload, $unset: { pausedUntil: '' } }
      : nextPayload);
    if (!updated) {
      throw new AppError({ status: 500, code: 'UPDATE_FAILED', message: 'Failed to update subscription' });
    }
    return updated;
  }

  async pause(id: string, pharmacyId: string, pausedUntil?: string): Promise<IPharmacySubscription> {
    return this.update(id, pharmacyId, {
      isActive: false,
      pausedUntil,
    });
  }

  async syncOrderLinkage(
    sourceOrderId: string,
    sourceOrderStatus: string,
    syncStatus: 'pending' | 'synced' | 'failed' = 'synced',
    syncError?: string
  ): Promise<void> {
    await this.repo.updateMany(
      { sourceOrderId },
      {
        sourceOrderStatus,
        lastSyncStatus: syncStatus,
        lastSyncError: syncError,
      }
    );
  }

  async delete(id: string, pharmacyId: string): Promise<void> {
    const sub = await this.repo.findById(id);
    if (!sub) {
      throw new AppError({ status: 404, code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription not found' });
    }
    if (String(sub.pharmacyId) !== pharmacyId) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }

    await this.repo.delete({ _id: id });
  }
}
