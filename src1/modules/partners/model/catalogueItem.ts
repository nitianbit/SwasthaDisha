import { Schema, model, Model } from 'mongoose';
import { ICatalogueItem } from '@/modules/partners/types';

const catalogueItemSchema = new Schema<ICatalogueItem>(
  {
    partnerId: { type: String, required: true, index: true },
    kind: { type: String, required: true, enum: ['test', 'package', 'consultation', 'procedure', 'other'] },
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true },
    description: { type: String, trim: true },
    preparation: { type: String, trim: true },
    sampleType: { type: String, trim: true },
    includes: [{ type: String }],
    priceMinor: { type: Number, required: true, min: 0 },
    mrpMinor: { type: Number, min: 0 },
    gstRate: { type: Number, required: true, enum: [0, 5, 12, 18, 28] },
    sac: { type: String, trim: true },
    taxTreatment: { type: String, enum: ['taxable', 'exempt'] },
    visitModes: [{ type: String, enum: ['home', 'lab'] }],
    reportTatHours: { type: Number, min: 0 },
    isActive: { type: Boolean, default: true },
    adminDisabled: { type: Boolean, default: false },
    // Q10: exactly-once creation per partner + request key.
    createRequestKey: { type: String },
    createRequestHash: { type: String },
  },
  { timestamps: true }
);

catalogueItemSchema.index({ partnerId: 1, isActive: 1 });
catalogueItemSchema.index({ partnerId: 1, kind: 1, isActive: 1 });
catalogueItemSchema.index({ partnerId: 1, createRequestKey: 1 }, { unique: true, partialFilterExpression: { createRequestKey: { $type: 'string' } } });

const CatalogueItemModel: Model<ICatalogueItem> = model<ICatalogueItem>('PartnerCatalogueItem', catalogueItemSchema, 'partner_catalogue_items');

export default CatalogueItemModel;
