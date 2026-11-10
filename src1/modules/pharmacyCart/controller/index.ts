import 'reflect-metadata';
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
    const result = await this.pharmacyCartService.checkout(
      req.user || {},
      req.body as CheckoutPharmacyCartRequest
    );
    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      data: result,
    });
  };
}
