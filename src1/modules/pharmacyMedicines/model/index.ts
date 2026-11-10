import { Schema, model, Model } from 'mongoose';
import { IMedicine } from '@/modules/pharmacyMedicines/types';
import { buildMedicineNameKey } from '@/modules/pharmacyMedicines/services/nameKeyMigration';

const medicineSchema = new Schema<IMedicine>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    nameKey: {
      type: String,
      trim: true,
      lowercase: true,
    },
    genericName: {
      type: String,
      trim: true,
      index: true,
    },
    brandName: {
      type: String,
      trim: true,
      index: true,
    },
    category: {
      type: String,
      trim: true,
      index: true,
    },
    imageUrl: {
      type: String,
      trim: true,
    },
    dosageForm: {
      type: String,
      enum: [
        'tablet', 'capsule', 'syrup', 'injection', 'cream',
        'ointment', 'drops', 'inhaler', 'patch', 'powder',
        'solution', 'gel', 'other',
      ],
      trim: true,
    },
    strength: {
      type: String,
      trim: true,
    },
    manufacturer: {
      type: String,
      trim: true,
      index: true,
    },
    hsnCode: {
      type: String,
      trim: true,
    },
    gstPercent: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    prescriptionRequired: {
      type: Boolean,
      default: false,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    archivedAt: { type: Date, index: true },
    archivedBy: { type: Schema.Types.ObjectId as any, ref: 'Admin' },
    archiveReason: { type: String, trim: true },
  },
  {
    timestamps: true,
  }
);

medicineSchema.pre('validate', function(next) {
  if (this.name) {
    this.name = this.name.trim();
    this.nameKey = buildMedicineNameKey(this.name);
  }
  next();
});

medicineSchema.index({ name: 'text', genericName: 'text', brandName: 'text', manufacturer: 'text' });
medicineSchema.index(
  { nameKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      nameKey: { $type: 'string', $gt: '' },
    },
  }
);
medicineSchema.index({ category: 1, isActive: 1 });
medicineSchema.index({ dosageForm: 1, isActive: 1 });

const MedicineModel: Model<IMedicine> = model<IMedicine>('Medicine', medicineSchema);

export default MedicineModel;
