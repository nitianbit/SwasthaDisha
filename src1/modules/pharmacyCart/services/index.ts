import { Service } from 'typedi';
import { AppError } from '@/modules/common/types';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { PharmacyCartRepository } from '@/modules/pharmacyCart/repository';
import {
  AddPharmacyCartItemRequest,
  IPharmacyCart,
  IPharmacyCartItem,
  PharmacyCartActorRole,
  PharmacyCartResponse,
  CheckoutPharmacyCartRequest,
} from '@/modules/pharmacyCart/types';
import { InventoryService } from '@/modules/pharmacyInventory/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';

@Service()
export class PharmacyCartService {
  constructor(
    private cartRepository: PharmacyCartRepository,
    private inventoryService: InventoryService,
    private pharmacyRepository: PharmacyRepository,
    private medicineRepository: MedicineRepository,
    private orderService: PharmacyOrderService
  ) {}

  private assertSupportedActor(
    user?: { _id?: string; userType?: string; pharmacyId?: string }
  ): { actorId: string; actorRole: PharmacyCartActorRole; pharmacyId?: string } {
    if (!user?._id || !user.userType) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (user.userType !== 'user' && user.userType !== 'pharmacy') {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Only users and pharmacies can manage cart',
      });
    }

    return {
      actorId: user._id,
      actorRole: user.userType,
      pharmacyId: user.pharmacyId,
    };
  }

  private async ensureTargetPharmacyAccessible(
    pharmacyId: string,
    actor: { actorRole: PharmacyCartActorRole; pharmacyId?: string }
  ): Promise<{ _id?: string; name: string }> {
    const pharmacy = await this.pharmacyRepository.findById(pharmacyId);
    if (!pharmacy) {
      throw new AppError({
        status: 404,
        code: 'PHARMACY_NOT_FOUND',
        message: 'Pharmacy not found',
      });
    }

    if (actor.actorRole === 'user') {
      if (!pharmacy.isActive || !pharmacy.isVerified || pharmacy.archivedAt) {
        throw new AppError({
          status: 404,
          code: 'PHARMACY_NOT_FOUND',
          message: 'Pharmacy not found',
        });
      }
      return pharmacy;
    }

    const requesterPharmacyId = actor.pharmacyId;
    const isOwnPharmacy = requesterPharmacyId === pharmacyId;
    if (!isOwnPharmacy && (!pharmacy.isActive || !pharmacy.isVerified || pharmacy.archivedAt)) {
      throw new AppError({
        status: 404,
        code: 'PHARMACY_NOT_FOUND',
        message: 'Pharmacy not found',
      });
    }

    if (requesterPharmacyId) {
      const requesterPharmacy = await this.pharmacyRepository.findById(requesterPharmacyId);
      if (
        !requesterPharmacy?.isVerified ||
        !requesterPharmacy.isActive ||
        requesterPharmacy.archivedAt
      ) {
        throw new AppError({
          status: 403,
          code: 'FORBIDDEN',
          message: 'Only verified pharmacies can add items to cart',
        });
      }
    }

    return pharmacy;
  }

  private async buildCartItem(
    actorRole: PharmacyCartActorRole,
    pharmacyId: string,
    medicineId: string,
    quantity: number
  ): Promise<IPharmacyCartItem> {
    const inventory = await this.inventoryService.getInventoryByMedicine(pharmacyId, medicineId);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const sellableAvailableQty = inventory.batches?.length
      ? inventory.batches.reduce(
          (total, batch) =>
            total + (batch.status === 'active' && batch.expiryDate >= today ? batch.availableQty : 0),
          0
        )
      : inventory.availableQty;
    if (!inventory.isActive || sellableAvailableQty <= 0) {
      throw new AppError({
        status: 400,
        code: 'MEDICINE_OUT_OF_STOCK',
        message: 'This medicine is currently out of stock',
      });
    }

    const medicine = await this.medicineRepository.findById(medicineId);
    if (!medicine) {
      throw new AppError({
        status: 404,
        code: 'MEDICINE_NOT_FOUND',
        message: 'Medicine not found',
      });
    }

    const unitPrice =
      actorRole === 'pharmacy'
        ? inventory.wholesalePrice ?? inventory.retailPrice ?? 0
        : inventory.retailPrice ?? 0;

    if (unitPrice <= 0) {
      throw new AppError({
        status: 400,
        code: 'MEDICINE_PRICE_NOT_AVAILABLE',
        message: 'This medicine price is not available right now',
      });
    }

    if (quantity > sellableAvailableQty) {
      throw new AppError({
        status: 400,
        code: 'INSUFFICIENT_STOCK',
        message: `Only ${sellableAvailableQty} units are available for this medicine`,
      });
    }

    return {
      medicineId,
      medicineName: medicine.name,
      brandName: medicine.brandName,
      genericName: medicine.genericName,
      quantity,
      unitPrice,
      lineTotal: unitPrice * quantity,
      prescriptionRequired: medicine.prescriptionRequired ?? false,
    };
  }

  private toResponse(
    cart: IPharmacyCart | null,
    pharmacyName?: string
  ): PharmacyCartResponse {
    return {
      pharmacyId: cart?.pharmacyId,
      pharmacyName,
      actorRole: cart?.actorRole || 'user',
      items: cart?.items || [],
      subtotal: cart?.subtotal || 0,
      requiresPrescription: Boolean(cart?.items.some((item) => item.prescriptionRequired)),
      prescriptionMedicines: (cart?.items || [])
        .filter((item) => item.prescriptionRequired)
        .map((item) => ({ medicineId: String(item.medicineId), name: item.medicineName })),
    };
  }

  async getCart(
    user?: { _id?: string; userType?: string; pharmacyId?: string }
  ): Promise<PharmacyCartResponse> {
    const actor = this.assertSupportedActor(user);
    const cart = await this.cartRepository.findByActor(actor.actorId, actor.actorRole);
    if (!cart) {
      return this.toResponse({
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        items: [],
        subtotal: 0,
      });
    }

    const pharmacy = cart.pharmacyId
      ? await this.pharmacyRepository.findById(cart.pharmacyId)
      : null;
    return this.toResponse(cart, pharmacy?.name);
  }

  async addItem(
    user: { _id?: string; userType?: string; pharmacyId?: string },
    payload: AddPharmacyCartItemRequest
  ): Promise<PharmacyCartResponse> {
    const actor = this.assertSupportedActor(user);
    const pharmacy = await this.ensureTargetPharmacyAccessible(payload.pharmacyId, actor);

    // Concurrent requests can race on first cart insert (unique actor index)
    // or overwrite each other's items. Re-read and retry on either conflict.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.tryAddItem(actor, payload, pharmacy.name);
        if (result) {
          return result;
        }
      } catch (error) {
        if (!isDuplicateKeyError(error) || attempt === MAX_ATTEMPTS) {
          throw error;
        }
      }
    }

    throw new AppError({
      status: 409,
      code: 'CART_CONFLICT',
      message: 'Cart was updated by another request. Please try again.',
    });
  }

  private async tryAddItem(
    actor: { actorId: string; actorRole: PharmacyCartActorRole },
    payload: AddPharmacyCartItemRequest,
    pharmacyName?: string
  ): Promise<PharmacyCartResponse | null> {
    const existingCart = await this.cartRepository.findByActor(actor.actorId, actor.actorRole);

    if (existingCart?.pharmacyId && String(existingCart.pharmacyId) !== payload.pharmacyId) {
      throw new AppError({
        status: 409,
        code: 'CART_PHARMACY_MISMATCH',
        message: 'Your cart contains items from another pharmacy. Clear cart to add this item.',
      });
    }

    const existingItem = existingCart?.items.find(
      (item) => String(item.medicineId) === payload.medicineId
    );
    const requestedQty = (existingItem?.quantity || 0) + payload.quantity;

    const nextItems = existingCart?.items
      ? existingCart.items.filter((item) => String(item.medicineId) !== payload.medicineId)
      : [];

    if (payload.quantity < 0 && !existingItem) {
      throw new AppError({
        status: 404,
        code: 'CART_ITEM_NOT_FOUND',
        message: 'Medicine not found in cart',
      });
    }

    if (requestedQty > 0) {
      const nextItem = await this.buildCartItem(
        actor.actorRole,
        payload.pharmacyId,
        payload.medicineId,
        requestedQty
      );
      nextItems.push(nextItem);
    }

    if (nextItems.length === 0) {
      if (existingCart?._id) {
        await this.cartRepository.delete({ _id: existingCart._id });
      }
      return this.toResponse({
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        items: [],
        subtotal: 0,
      });
    }

    nextItems.sort((a, b) => (a.medicineName || '').localeCompare(b.medicineName || ''));
    const subtotal = nextItems.reduce((sum, item) => sum + item.lineTotal, 0);

    // Existing cart: optimistic-concurrency write; null means another request
    // changed the cart since we read it. New cart: plain insert; a concurrent
    // first insert surfaces as a duplicate-key error. Both trigger a retry.
    const savedCart = existingCart
      ? await this.cartRepository.updateIfUnchanged(existingCart, {
          pharmacyId: payload.pharmacyId,
          items: nextItems,
          subtotal,
        })
      : await this.cartRepository.save({
          actorId: actor.actorId,
          actorRole: actor.actorRole,
          pharmacyId: payload.pharmacyId,
          items: nextItems,
          subtotal,
        });

    if (!savedCart) {
      return null;
    }

    return this.toResponse(savedCart, pharmacyName);
  }

  async removeItem(
    user: { _id?: string; userType?: string; pharmacyId?: string },
    medicineId: string
  ): Promise<PharmacyCartResponse> {
    const actor = this.assertSupportedActor(user);
    const cart = await this.cartRepository.findByActor(actor.actorId, actor.actorRole);
    if (!cart) {
      return this.toResponse({
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        items: [],
        subtotal: 0,
      });
    }

    const nextItems = cart.items.filter((item) => String(item.medicineId) !== medicineId);
    if (nextItems.length === cart.items.length) {
      throw new AppError({
        status: 404,
        code: 'CART_ITEM_NOT_FOUND',
        message: 'Medicine not found in cart',
      });
    }

    if (nextItems.length === 0) {
      await this.cartRepository.delete({ _id: cart._id });
      return this.toResponse({
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        items: [],
        subtotal: 0,
      });
    }

    const subtotal = nextItems.reduce((sum, item) => sum + item.lineTotal, 0);
    const updatedCart = await this.cartRepository.update(
      { _id: cart._id },
      { items: nextItems, subtotal }
    );

    if (!updatedCart) {
      throw new AppError({
        status: 500,
        code: 'CART_SAVE_FAILED',
        message: 'Failed to update cart',
      });
    }

    const pharmacy = cart.pharmacyId
      ? await this.pharmacyRepository.findById(cart.pharmacyId)
      : null;
    return this.toResponse(updatedCart, pharmacy?.name);
  }

  async clearCart(
    user: { _id?: string; userType?: string; pharmacyId?: string }
  ): Promise<void> {
    const actor = this.assertSupportedActor(user);
    await this.cartRepository.delete({ actorId: actor.actorId, actorRole: actor.actorRole });
  }

  async checkout(
    user: { _id?: string; userType?: string; pharmacyId?: string },
    payload: CheckoutPharmacyCartRequest
  ) {
    const actor = this.assertSupportedActor(user);
    const cart = await this.cartRepository.findByActor(actor.actorId, actor.actorRole);
    if (!cart?.pharmacyId || !cart.items.length) {
      throw new AppError({ status: 400, code: 'CART_EMPTY', message: 'Cart is empty' });
    }

    const sellerPharmacyId = String(cart.pharmacyId);
    await this.ensureTargetPharmacyAccessible(sellerPharmacyId, actor);

    if (actor.actorRole === 'pharmacy') {
      if (!actor.pharmacyId) {
        throw new AppError({
          status: 403,
          code: 'PHARMACY_PROFILE_REQUIRED',
          message: 'A pharmacy profile is required to checkout',
        });
      }
      if (actor.pharmacyId === sellerPharmacyId) {
        throw new AppError({
          status: 400,
          code: 'SELF_PURCHASE_NOT_ALLOWED',
          message: 'A pharmacy cannot place a wholesale order with itself',
        });
      }
    }

    const refreshedItems: IPharmacyCartItem[] = [];
    let priceChanged = false;
    for (const item of cart.items) {
      const refreshed = await this.buildCartItem(
        actor.actorRole,
        sellerPharmacyId,
        String(item.medicineId),
        item.quantity
      );
      refreshedItems.push(refreshed);
      if (Math.round(refreshed.unitPrice * 100) !== Math.round(item.unitPrice * 100)) {
        priceChanged = true;
      }
    }

    if (priceChanged) {
      const subtotal = refreshedItems.reduce((sum, item) => sum + item.lineTotal, 0);
      await this.cartRepository.updateIfUnchanged(cart, {
        pharmacyId: sellerPharmacyId,
        items: refreshedItems,
        subtotal,
      });
      throw new AppError({
        status: 409,
        code: 'CART_PRICE_CHANGED',
        message: 'One or more medicine prices changed. The cart has been refreshed; review it and checkout again.',
      });
    }

    const result = await this.orderService.create(
      sellerPharmacyId,
      {
        orderType: 'online',
        customerId: actor.actorRole === 'user' ? actor.actorId : undefined,
        buyerPharmacyId: actor.actorRole === 'pharmacy' ? actor.pharmacyId : undefined,
        items: refreshedItems.map((item) => ({
          medicineId: String(item.medicineId),
          orderedQty: item.quantity,
        })),
        paymentMode: payload.paymentMode,
        deliveryMode: payload.deliveryMode,
        deliveryAddress: payload.deliveryAddress,
        prescriptionUrls: payload.prescriptionUrls,
        notes: payload.notes,
      },
      actor.actorId,
      actor.actorRole,
      { allowPriceOverride: false }
    );

    // Avoid deleting items added by another request while checkout was running.
    await this.cartRepository.deleteIfUnchanged(cart);
    return result;
  }
}
