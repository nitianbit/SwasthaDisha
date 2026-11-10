import { Schema, model, Model } from 'mongoose';
import { IInventoryImport } from '@/modules/pharmacyInventoryImports/types';

const importRowSchema = new Schema(
  {
    rowIndex: { type: Number, required: true },
    medicineName: { type: String, trim: true },
    status: { type: String, enum: ['valid', 'error', 'skipped', 'committed', 'failed'], required: true },
    errors: { type: [String], default: [] },
    data: { type: Schema.Types.Mixed },
  },
  { _id: false, supressReservedKeysWarning: true } as any
);

const inventoryImportSchema = new Schema<IInventoryImport>(
  {
    pharmacyId: { type: Schema.Types.ObjectId as any, ref: 'Pharmacy', required: true, index: true },
    uploadedBy: { type: Schema.Types.ObjectId as any, ref: 'User', required: true },
    uploadedByRole: { type: String, required: true, trim: true },
    fileName: { type: String, required: true, trim: true },
    filePath: { type: String, required: true, trim: true },
    importMode: {
      type: String,
      enum: ['create_only', 'update_only', 'upsert'],
      default: 'upsert',
    },
    status: {
      type: String,
      enum: ['pending', 'previewed', 'committing', 'committed', 'partially_committed', 'failed'],
      default: 'pending',
      index: true,
    },
    totalRows: { type: Number, default: 0 },
    validRows: { type: Number, default: 0 },
    errorRows: { type: Number, default: 0 },
    committedRows: { type: Number, default: 0 },
    failedRows: { type: Number, default: 0 },
    commitErrors: {
      type: [
        new Schema(
          {
            rowIndex: { type: Number, required: true },
            medicineName: { type: String, trim: true },
            error: { type: String, required: true },
            code: { type: String, trim: true },
            retryable: { type: Boolean, default: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    previewRows: { type: [importRowSchema], default: [] },
    errorSummary: { type: String, trim: true },
    committedAt: { type: Date },
    sourceFileDeletedAt: { type: Date },
  },
  { timestamps: true }
);

inventoryImportSchema.index({ pharmacyId: 1, createdAt: -1 });

const InventoryImportModel: Model<IInventoryImport> = model<IInventoryImport>(
  'InventoryImport',
  inventoryImportSchema
);

export default InventoryImportModel;
