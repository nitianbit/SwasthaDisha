/** Labs: test | package (with visit modes). Q10 clinics: consultation | procedure | package | other (no visit modes). */
export type CatalogueItemKind = 'test' | 'package' | 'consultation' | 'procedure' | 'other';

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
  /** r42: absent = taxable; a clinic's 0% consultation is exempt by default (SAC 9993). */
  taxTreatment?: 'taxable' | 'exempt';
  visitModes: ('home' | 'lab')[];
  reportTatHours?: number;
  isActive: boolean;
  adminDisabled: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  createRequestKey?: string;
  createRequestHash?: string;
}
