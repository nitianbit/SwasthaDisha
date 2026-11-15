import 'reflect-metadata';
import { rebindStored, withFiles } from '@/modules/file/access';
import { Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { PharmacyCartService } from '@/modules/pharmacyCart/services';
import { AuthRequest } from '@/modules/middleware/auth';
import {
  AddPharmacyCartItemRequest,
  CheckoutPharmacyCartRequest,
} from '@/modules/pharmacyCart/types';

export class PharmacyCartController {
  private pharmacyCartService: PharmacyCartService;

  constructor() {
    this.pharmacyCartService = Container.get(PharmacyCartService);
  }

  getCart = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const result = await this.pharmacyCartService.getCart(req.user);
    res.status(200).json({ success: true, data: result });
  };

  addItem = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const result = await this.pharmacyCartService.addItem(
      req.user || {},
      req.body as AddPharmacyCartItemRequest
    );
    res.status(200).json({
      success: true,
      message: 'Item added to cart',
      data: result,
    });
  };

  removeItem = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const result = await this.pharmacyCartService.removeItem(
      req.user || {},
      req.params.medicineId
    );
    res.status(200).json({
      success: true,
      message: 'Item removed from cart',
      data: result,
    });
  };

  clearCart = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    await this.pharmacyCartService.clearCart(req.user || {});
    res.status(200).json({
      success: true,
      message: 'Cart cleared successfully',
    });
  };

  checkout = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    // D1 + P9: only the customer's own uploads may be referenced, and they are bound to the created order so its
    // pharmacy can open them. A keyed replay re-binds the stored order's files (its first request may have died before
    // binding).
    const result = await withFiles(req.user, 'PharmacyOrder', req.body, undefined,
      () => this.pharmacyCartService.checkout(req.user || {}, req.body as CheckoutPharmacyCartRequest),
      (r) => (r as { order?: { _id?: unknown } }).order?._id);
    if ((result as { replayed?: boolean }).replayed) {
      await rebindStored(req.user, 'PharmacyOrder', (result as { order: { _id: unknown } }).order._id);
    }
    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      data: result,
    });
  };
}
