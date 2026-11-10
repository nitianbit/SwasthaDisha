import { Schema, model, Model } from 'mongoose';
import { IPharmacyCart } from '@/modules/pharmacyCart/types';

const pharmacyCartItemSchema = new Schema(
  {
    medicineId: {
      type: Schema.Types.ObjectId as any,
      ref: 'Medicine',
      required: true,
    },
    medicineName: { type: String, trim: true },
    brandName: { type: String, trim: true },
    genericName: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
    prescriptionRequired: { type: Boolean, default: false },
  },
  { _id: false }
);

const pharmacyCartSchema = new Schema<IPharmacyCart>(
  {
    actorId: {
      type: Schema.Types.ObjectId as any,
      required: true,
      index: true,
    },
    actorRole: {
      type: String,
      enum: ['user', 'pharmacy'],
      required: true,
      index: true,
    },
    pharmacyId: {
      type: Schema.Types.ObjectId as any,
      ref: 'Pharmacy',
      index: true,
    },
    items: {
      type: [pharmacyCartItemSchema],
      default: [],
    },
    subtotal: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
  },
  { timestamps: true }
);

pharmacyCartSchema.index({ actorId: 1, actorRole: 1 }, { unique: true });

const PharmacyCartModel: Model<IPharmacyCart> = model<IPharmacyCart>(
  'PharmacyCart',
  pharmacyCartSchema
);

export default PharmacyCartModel;
