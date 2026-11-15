export type CatalogueItemKind = 'test' | 'package';

export interface ICatalogueItem {
  _id?: string;
  partnerId: string;
  kind: CatalogueItemKind;
  name: string;
  code?: string;
  description?: string;
  preparation?: string;
  sampleType?: string;
  includes?: string[];
  priceMinor: number;
  mrpMinor?: number;
  gstRate: 0 | 5 | 12 | 18 | 28;
  sac?: string;
  visitModes: ('home' | 'lab')[];
  reportTatHours?: number;
  isActive: boolean;
  adminDisabled: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}
