import { Schema, model, Model } from 'mongoose';
import { IExternalCatalogItem } from '@/modules/externalCatalogItems/types';

const externalCatalogItemSchema = new Schema<IExternalCatalogItem>(
  {
    integration: {
      type: String,
      enum: ['labstack', 'healthians'],
      required: true,
      trim: true,
      index: true,
    },
    itemType: {
      type: String,
      enum: ['package', 'test'],
      required: true,
      trim: true,
      index: true,
    },
    externalItemId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      trim: true,
    },
    customPrice: {
      type: Number,
      min: 0,
    },
    image: {
      type: String,
      trim: true,
    },
    coverImage: {
      type: String,
      trim: true,
    },
    pinned: {
      type: Boolean,
      default: false,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

externalCatalogItemSchema.index(
  { integration: 1, itemType: 1, externalItemId: 1 },
  { unique: true }
);

const ExternalCatalogItemModel: Model<IExternalCatalogItem> =
  model<IExternalCatalogItem>('ExternalCatalogItem', externalCatalogItemSchema);

export default ExternalCatalogItemModel;
