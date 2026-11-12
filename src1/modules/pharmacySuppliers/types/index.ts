import { Types } from 'mongoose';

export const SUPPLIER_FIELDS = ['displayName', 'contactName', 'phone', 'email', 'address'] as const;
export const SUPPLIER_TEXT_LIMITS = { displayName: 120, contactName: 120, phone: 32, email: 254, address: 500 } as const;
export type SupplierState = 'active' | 'archived';
export interface SupplierFields {
  displayName: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
}
export interface IPharmacySupplier extends SupplierFields {
  _id: Types.ObjectId;
  schemaVersion: 1;
  pharmacyId: Types.ObjectId;
  state: SupplierState;
  revision: number;
  createdByActorId: string;
  updatedByActorId: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}
export interface SupplierDto extends SupplierFields {
  supplierId: string;
  state: SupplierState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  verificationState: 'not_evaluated';
}
export interface SupplierListQuery {
  state: SupplierState | 'all';
  page: number;
  limit: number;
}
export interface SupplierPage extends SupplierListQuery {
  data: SupplierDto[];
  total: number;
  totalPages: number;
}
export type SupplierCommand =
  | { kind: 'create'; fields: SupplierFields }
  | { kind: 'update'; fields: Partial<SupplierFields>; expectedRevision: number }
  | { kind: 'archive'; expectedRevision: number };
