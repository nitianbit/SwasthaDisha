export type PharmacyCartActorRole = 'user' | 'pharmacy';

export interface IPharmacyCartItem {
  medicineId: string;
  medicineName?: string;
  brandName?: string;
  genericName?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  prescriptionRequired?: boolean;
}

export interface IPharmacyCart {
  _id?: string;
  actorId: string;
  actorRole: PharmacyCartActorRole;
  pharmacyId?: string;
  items: IPharmacyCartItem[];
  subtotal: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AddPharmacyCartItemRequest {
  pharmacyId: string;
  medicineId: string;
  quantity: number;
}

export interface PharmacyCartResponse {
  pharmacyId?: string;
  pharmacyName?: string;
  actorRole: PharmacyCartActorRole;
  items: IPharmacyCartItem[];
  subtotal: number;
  requiresPrescription?: boolean;
  prescriptionMedicines?: Array<{ medicineId: string; name?: string }>;
}

export interface CheckoutPharmacyCartRequest {
  paymentMode: 'online_payment' | 'in_store_payment' | 'cash_on_delivery';
  deliveryMode?: 'pickup' | 'delivery';
  deliveryAddress?: string;
  prescriptionUrls?: string[];
  notes?: string;
}
