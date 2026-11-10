import { ClientSession, startSession } from 'mongoose';
import { Service } from 'typedi';
import {
  InventoryItemRepository,
  InventoryAdjustmentRepository,
  InventoryReservationRepository,
} from '@/modules/pharmacyInventory/repository';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import {
  IInventoryItem,
  IInventoryReservation,
  CreateInventoryItemRequest,
  CreateInventoryItemsRequest,
  InventoryQueryParams,
  PublicInventoryItemDto,
  PublicInventoryQueryParams,
  ManualInventoryReservationRequest,
  ReserveReleaseRequest,
  IInventoryBatchAllocation,
} from '@/modules/pharmacyInventory/types';
import { PharmacyMedicineAvailabilityDto } from '@/modules/pharmacies/types';
import { AppError } from '@/modules/common/types';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';

function isValidInventoryDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

@Service()
export class InventoryService {
  constructor(
    private inventoryItemRepo: InventoryItemRepository,
    private adjustmentRepo: InventoryAdjustmentRepository,
    private reservationRepo: InventoryReservationRepository,
    private pharmacyRepo: PharmacyRepository,
    private medicineRepo: MedicineRepository
  ) {}

  private normalizeReservationItems(
    items: Array<{ medicineId: string; quantity: number }>
  ): Array<{ medicineId: string; quantity: number }> {
    const merged = new Map<string, number>();
    for (const item of items) {
      merged.set(item.medicineId, (merged.get(item.medicineId) || 0) + item.quantity);
    }
    return Array.from(merged.entries()).map(([medicineId, quantity]) => ({
      medicineId,
      quantity,
    }));
  }

  private buildReservationClosePatch(
    reservation: IInventoryReservation,
    operation: 'released' | 'consumed',
    quantity: number
  ): Partial<IInventoryReservation> {
    const nextRemainingQty = reservation.remainingQty - quantity;
    return {
      remainingQty: nextRemainingQty,
      releasedQty:
        operation === 'released'
          ? (reservation.releasedQty || 0) + quantity
          : reservation.releasedQty || 0,
      consumedQty:
        operation === 'consumed'
          ? (reservation.consumedQty || 0) + quantity
          : reservation.consumedQty || 0,
      status: nextRemainingQty <= 0 ? 'closed' : 'active',
    };
  }

  private async applyReservationOperation(
    reservations: IInventoryReservation[],
    requestedItems: Array<{ medicineId: string; quantity: number }>,
    operation: 'released' | 'consumed'
  ): Promise<void> {
    const normalizedItems = this.normalizeReservationItems(requestedItems);

    for (const item of normalizedItems) {
      const matchingReservations = reservations.filter(
        (reservation) =>
          String(reservation.medicineId) === item.medicineId &&
          reservation.status === 'active' &&
          reservation.remainingQty > 0
      );
      const totalReserved = matchingReservations.reduce(
        (sum, reservation) => sum + reservation.remainingQty,
        0
      );

      if (totalReserved < item.quantity) {
        throw new AppError({
          status: 400,
          code: 'RESERVATION_NOT_FOUND',
          message: 'The requested reserved stock is no longer available',
        });
      }

      let pendingQty = item.quantity;
      for (const reservation of matchingReservations) {
        if (pendingQty <= 0) {
          break;
        }

        const consumeQty = Math.min(pendingQty, reservation.remainingQty);
        await this.reservationRepo.update(
          { _id: reservation._id },
          this.buildReservationClosePatch(reservation, operation, consumeQty)
        );
        reservation.remainingQty -= consumeQty;
        reservation.status = reservation.remainingQty <= 0 ? 'closed' : 'active';
        reservation.releasedQty =
          operation === 'released'
            ? (reservation.releasedQty || 0) + consumeQty
            : reservation.releasedQty || 0;
        reservation.consumedQty =
          operation === 'consumed'
            ? (reservation.consumedQty || 0) + consumeQty
            : reservation.consumedQty || 0;
        pendingQty -= consumeQty;
      }
    }
  }

  private async ensureMedicineExists(
    data: CreateInventoryItemRequest
  ): Promise<void> {
    const medicine = await this.medicineRepo.findById(data.medicineId);
    if (!medicine) {
      throw new AppError({ status: 404, code: 'MEDICINE_NOT_FOUND', message: 'Medicine not found' });
    }
  }

  private async saveItem(
    data: CreateInventoryItemRequest,
    session: ClientSession
  ): Promise<{
    item: IInventoryItem;
    batchId?: string;
    availableQtyBefore?: number;
    availableQtyAfter?: number;
  }> {
    await this.ensureMedicineExists(data);

    if (data.quantity !== undefined) {
      if (!data.batchNumber || !data.expiryDate) {
        throw new AppError({
          status: 400,
          code: 'BATCH_DETAILS_REQUIRED',
          message: 'batchNumber and expiryDate are required when quantity is provided',
        });
      }
      if (!isValidInventoryDate(data.expiryDate)) {
        throw new AppError({
          status: 400,
          code: 'INVALID_BATCH_EXPIRY_DATE',
          message: 'expiryDate must be a valid date in YYYYMMDD format',
        });
      }
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      if (data.quantity > 0 && data.expiryDate < today) {
        throw new AppError({
          status: 400,
          code: 'BATCH_ALREADY_EXPIRED',
          message: 'Expired stock cannot be added to available inventory',
        });
      }

      const adjusted = await this.inventoryItemRepo.adjustBatchStock(
        data.pharmacyId,
        data.medicineId,
        {
          batchNumber: data.batchNumber.trim().toUpperCase(),
          expiryDate: data.expiryDate,
          quantityDelta: data.quantity,
          purchasePrice: data.purchasePrice,
          mrp: data.mrp,
          retailPrice: data.retailPrice,
          wholesalePrice: data.wholesalePrice,
          reorderThreshold: data.reorderThreshold,
          rackLocation: data.rackLocation,
        },
        session
      );
      if (!adjusted) {
        throw new AppError({
          status: 400,
          code: 'INSUFFICIENT_BATCH_STOCK',
          message: 'The batch does not contain enough available stock for this adjustment',
        });
      }
      return adjusted;
    }

    const upsert = () =>
      this.inventoryItemRepo.atomicUpsertItem(data.pharmacyId, data.medicineId, data.quantity ?? 0, {
        reorderThreshold: data.reorderThreshold,
        rackLocation: data.rackLocation,
        purchasePrice: data.purchasePrice,
        retailPrice: data.retailPrice,
        wholesalePrice: data.wholesalePrice,
        batchNumber: data.batchNumber,
        expiryDate: data.expiryDate,
        isActive: true,
      }, session);

    try {
      return { item: await upsert() };
    } catch (error) {
      // Two concurrent upserts for a brand-new pair can both take the insert
      // path; the loser retries and lands on the update path.
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      return { item: await upsert() };
    }
  }

  async saveItems(
    data: CreateInventoryItemsRequest,
    adjustedBy?: string,
    adjustedByRole?: string
  ): Promise<IInventoryItem[]> {
    if (data.items.length === 0) {
      throw new AppError({
        status: 400,
        code: 'INVENTORY_ITEMS_REQUIRED',
        message: 'At least one inventory item is required',
      });
    }

    const { items } = data;
    const pharmacyId = items[0].pharmacyId;
    const pharmacy = await this.pharmacyRepo.findById(pharmacyId);
    if (!pharmacy) {
      throw new AppError({ status: 404, code: 'PHARMACY_NOT_FOUND', message: 'Pharmacy not found' });
    }

    const itemKeys = items.map((item) =>
      `${item.medicineId}:${item.batchNumber?.trim().toUpperCase() || ''}:${item.expiryDate || ''}`
    );
    const uniqueItemKeys = new Set(itemKeys);

    if (uniqueItemKeys.size !== itemKeys.length) {
      throw new AppError({
        status: 400,
        code: 'DUPLICATE_BATCH_ROWS',
        message: 'Duplicate medicine and batch combinations are not allowed in one request',
      });
    }

    for (const item of items) {
      if (item.pharmacyId !== pharmacyId) {
        throw new AppError({
          status: 400,
          code: 'PHARMACY_ID_MISMATCH',
          message: 'All inventory items in a bulk create request must belong to the same pharmacy',
        });
      }
    }

    const session = await startSession();
    try {
      const results: IInventoryItem[] = [];
      await session.withTransaction(async () => {
        for (const item of items) {
          const saved = await this.saveItem(item, session);
          const actualDelta = item.quantity ?? 0;
          if (actualDelta !== 0 && adjustedBy && adjustedByRole) {
            await this.adjustmentRepo.save(
              {
                pharmacyId: String(saved.item.pharmacyId),
                medicineId: String(saved.item.medicineId),
                inventoryItemId: String(saved.item._id),
                adjustmentType: actualDelta > 0 ? 'add' : 'remove',
                quantity: Math.abs(actualDelta),
                batchId: saved.batchId,
                batchNumber: item.batchNumber?.trim().toUpperCase(),
                expiryDate: item.expiryDate,
                availableQtyBefore: saved.availableQtyBefore,
                availableQtyAfter: saved.availableQtyAfter,
                sourceType: 'manual',
                reason: item.reason ?? 'correction',
                notes: item.notes,
                adjustedBy,
                adjustedByRole,
              },
              { session }
            );
          }
          results.push(saved.item);
        }
      });
      return results;
    } finally {
      await session.endSession();
    }
  }

  async getItem(id: string, pharmacyId?: string): Promise<IInventoryItem> {
    const item = await this.inventoryItemRepo.findById(id);
    if (!item) {
      throw new AppError({ status: 404, code: 'INVENTORY_ITEM_NOT_FOUND', message: 'Inventory item not found' });
    }
    if (pharmacyId && String(item.pharmacyId) !== pharmacyId) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    return item;
  }

  async getByPharmacy(
    params: InventoryQueryParams
  ): Promise<{ data: IInventoryItem[]; total: number; page: number; totalPages: number }> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    return this.inventoryItemRepo.findWithPagination(params, page, limit);
  }

  async findMedicineAvailability(
    params: {
      medicineId: string;
      latitude?: number;
      longitude?: number;
      radiusKm?: number;
      page?: number;
      limit?: number;
    },
    includeWholesalePrice: boolean
  ): Promise<{
    data: PharmacyMedicineAvailabilityDto[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    await this.ensureMedicineExists({
      pharmacyId: '',
      medicineId: params.medicineId,
    });

    return this.inventoryItemRepo.findMedicineAvailability(
      params,
      includeWholesalePrice
    );
  }

  async getPublicInventoryByPharmacy(
    params: PublicInventoryQueryParams,
    includeWholesalePrice: boolean
  ): Promise<{
    data: PublicInventoryItemDto[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    return this.inventoryItemRepo.findPublicInventoryByPharmacy(
      params,
      includeWholesalePrice
    );
  }

  async getInventoryByMedicine(pharmacyId: string, medicineId: string): Promise<IInventoryItem> {
    const item = await this.inventoryItemRepo.findByPharmacyAndMedicine(pharmacyId, medicineId);
    if (!item) {
      throw new AppError({
        status: 404,
        code: 'INVENTORY_ITEM_NOT_FOUND',
        message: 'Inventory item not found for this medicine',
      });
    }
    return item;
  }

  async reserveOrderStockBulk(
    pharmacyId: string,
    items: Array<{ medicineId: string; quantity: number }>,
    session: ClientSession
  ): Promise<Map<string, IInventoryBatchAllocation[]>> {
    const normalized = this.normalizeReservationItems(items);
    const allocations = new Map<string, IInventoryBatchAllocation[]>();

    for (const item of normalized) {
      const reserved = await this.inventoryItemRepo.reserveBatches(
        pharmacyId,
        item.medicineId,
        item.quantity,
        session
      );
      if (!reserved) {
        throw new AppError({
          status: 400,
          code: 'INSUFFICIENT_BATCH_STOCK',
          message: `Insufficient non-expired batch stock for medicine ${item.medicineId}`,
        });
      }
      allocations.set(item.medicineId, reserved.allocations);
    }

    return allocations;
  }

  async releaseOrderStockBulk(
    pharmacyId: string,
    items: Array<{ medicineId: string; batchAllocations?: IInventoryBatchAllocation[] }>,
    session: ClientSession
  ): Promise<void> {
    for (const item of items) {
      if (!item.batchAllocations?.length) continue;
      const released = await this.inventoryItemRepo.releaseBatchAllocations(
        pharmacyId,
        item.medicineId,
        item.batchAllocations,
        session
      );
      if (!released) {
        throw new AppError({
          status: 409,
          code: 'BATCH_RESERVATION_RELEASE_FAILED',
          message: `Reserved batch stock could not be released for medicine ${item.medicineId}`,
        });
      }
    }
  }

  async consumeOrderReservedStockBulk(
    pharmacyId: string,
    items: Array<{ medicineId: string; batchAllocations?: IInventoryBatchAllocation[] }>,
    session: ClientSession
  ): Promise<void> {
    for (const item of items) {
      if (!item.batchAllocations?.length) continue;
      const consumed = await this.inventoryItemRepo.consumeBatchAllocations(
        pharmacyId,
        item.medicineId,
        item.batchAllocations,
        session
      );
      if (!consumed) {
        throw new AppError({
          status: 409,
          code: 'BATCH_RESERVATION_CONSUME_FAILED',
          message: `Reserved batch stock could not be consumed for medicine ${item.medicineId}`,
        });
      }
    }
  }

  async reserveStock(
    pharmacyId: string,
    medicineId: string,
    payload: ReserveReleaseRequest
  ): Promise<IInventoryItem> {
    const item = await this.inventoryItemRepo.atomicReserve(pharmacyId, medicineId, payload.quantity);
    if (!item) {
      throw new AppError({
        status: 400,
        code: 'INSUFFICIENT_STOCK',
        message: 'Insufficient available stock to reserve',
      });
    }
    return item;
  }

  async manualReserveStock(
    pharmacyId: string,
    payload: ManualInventoryReservationRequest,
    actor?: { userId?: string; userRole?: string }
  ): Promise<IInventoryItem[]> {
    const normalizedItems = this.normalizeReservationItems(payload.items);
    const results: IInventoryItem[] = [];

    try {
      for (const item of normalizedItems) {
        const reserved = await this.reserveStock(pharmacyId, item.medicineId, {
          quantity: item.quantity,
        });
        results.push(reserved);
      }

      await this.reservationRepo.insertMany(
        normalizedItems.map((item) => ({
          pharmacyId,
          medicineId: item.medicineId,
          reservationType: 'manual',
          quantity: item.quantity,
          remainingQty: item.quantity,
          consumedQty: 0,
          releasedQty: 0,
          reason: payload.reason,
          notes: payload.notes,
          createdBy: actor?.userId,
          createdByRole: actor?.userRole,
          status: 'active',
        }))
      );

      return results;
    } catch (error) {
      for (let index = results.length - 1; index >= 0; index -= 1) {
        const reservedItem = results[index];
        const original = normalizedItems[index];
        await this.releaseStock(pharmacyId, String(reservedItem.medicineId), {
          quantity: original.quantity,
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  async reserveStockBulk(
    pharmacyId: string,
    items: Array<{ medicineId: string; quantity: number }>
  ): Promise<IInventoryItem[]> {
    return this.manualReserveStock(pharmacyId, { items });
  }

  async releaseStock(
    pharmacyId: string,
    medicineId: string,
    payload: ReserveReleaseRequest
  ): Promise<IInventoryItem> {
    const item = await this.inventoryItemRepo.atomicRelease(pharmacyId, medicineId, payload.quantity);
    if (!item) {
      throw new AppError({
        status: 400,
        code: 'RELEASE_FAILED',
        message: 'Cannot release more than reserved quantity',
      });
    }
    return item;
  }

  async manualReleaseStock(
    pharmacyId: string,
    payload: ManualInventoryReservationRequest
  ): Promise<IInventoryItem[]> {
    const normalizedItems = this.normalizeReservationItems(payload.items);
    const medicineIds = normalizedItems.map((item) => item.medicineId);
    const activeReservations = await this.reservationRepo.findActiveManualByMedicineIds(
      pharmacyId,
      medicineIds
    );
    const results: IInventoryItem[] = [];

    try {
      for (const item of normalizedItems) {
        const released = await this.releaseStock(pharmacyId, item.medicineId, {
          quantity: item.quantity,
        });
        results.push(released);
      }

      await this.applyReservationOperation(activeReservations, normalizedItems, 'released');

      return results;
    } catch (error) {
      for (let index = results.length - 1; index >= 0; index -= 1) {
        const releasedItem = results[index];
        const original = normalizedItems[index];
        await this.reserveStock(pharmacyId, String(releasedItem.medicineId), {
          quantity: original.quantity,
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  async releaseStockBulk(
    pharmacyId: string,
    items: Array<{ medicineId: string; quantity: number }>
  ): Promise<IInventoryItem[]> {
    return this.manualReleaseStock(pharmacyId, { items });
  }

  async deductStock(
    pharmacyId: string,
    medicineId: string,
    qty: number
  ): Promise<IInventoryItem> {
    const item = await this.inventoryItemRepo.atomicDeduct(pharmacyId, medicineId, qty);
    if (!item) {
      throw new AppError({
        status: 400,
        code: 'DEDUCT_FAILED',
        message: 'Cannot deduct more than reserved quantity',
      });
    }
    return item;
  }

  async deductReservedStockBulk(
    pharmacyId: string,
    items: Array<{ medicineId: string; quantity: number }>
  ): Promise<IInventoryItem[]> {
    const results: IInventoryItem[] = [];

    try {
      for (const item of items) {
        const deducted = await this.deductStock(pharmacyId, item.medicineId, item.quantity);
        results.push(deducted);
      }

      return results;
    } catch (error) {
      for (let index = results.length - 1; index >= 0; index -= 1) {
        const deductedItem = results[index];
        const original = items[index];
        await this.reserveStock(pharmacyId, String(deductedItem.medicineId), {
          quantity: original.quantity,
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  async returnStock(
    pharmacyId: string,
    medicineId: string,
    qty: number,
    session?: ClientSession
  ): Promise<IInventoryItem> {
    const item = await this.inventoryItemRepo.atomicReturn(pharmacyId, medicineId, qty, session);
    if (!item) {
      throw new AppError({ status: 404, code: 'INVENTORY_ITEM_NOT_FOUND', message: 'Inventory item not found' });
    }
    return item;
  }

  async consumeAvailableStock(
    pharmacyId: string,
    medicineId: string,
    qty: number,
    session?: ClientSession
  ): Promise<IInventoryItem> {
    const item = await this.inventoryItemRepo.atomicConsumeAvailable(pharmacyId, medicineId, qty, session);
    if (!item) {
      throw new AppError({
        status: 400,
        code: 'INSUFFICIENT_STOCK',
        message: 'Insufficient available stock to deduct',
      });
    }
    return item;
  }

  async consumeAvailableStockBulk(
    pharmacyId: string,
    items: Array<{ medicineId: string; quantity: number }>,
    session?: ClientSession
  ): Promise<IInventoryItem[]> {
    const results: IInventoryItem[] = [];

    try {
      for (const item of items) {
        const deducted = await this.consumeAvailableStock(pharmacyId, item.medicineId, item.quantity, session);
        results.push(deducted);
      }

      return results;
    } catch (error) {
      for (let index = results.length - 1; index >= 0; index -= 1) {
        const deductedItem = results[index];
        const original = items[index];
        await this.returnStock(pharmacyId, String(deductedItem.medicineId), original.quantity, session).catch(
          () => undefined
        );
      }
      throw error;
    }
  }

  async returnStockBulk(
    pharmacyId: string,
    items: Array<{ medicineId: string; quantity: number }>,
    session?: ClientSession
  ): Promise<IInventoryItem[]> {
    const results: IInventoryItem[] = [];

    try {
      for (const item of items) {
        const returned = await this.returnStock(pharmacyId, item.medicineId, item.quantity, session);
        results.push(returned);
      }

      return results;
    } catch (error) {
      for (let index = results.length - 1; index >= 0; index -= 1) {
        const returnedItem = results[index];
        const original = items[index];
        await this.consumeAvailableStock(
          pharmacyId,
          String(returnedItem.medicineId),
          original.quantity,
          session
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  async getLowStock(pharmacyId: string, page: number = 1, limit: number = 20) {
    return this.inventoryItemRepo.findWithPagination(
      { pharmacyId, lowStock: true, isActive: true },
      page,
      limit
    );
  }

  async getAdjustmentHistory(pharmacyId: string, page: number = 1, limit: number = 20) {
    return this.adjustmentRepo.findByPharmacy(pharmacyId, page, limit);
  }
}
