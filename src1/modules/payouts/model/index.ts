import { model, Model, Schema } from 'mongoose';
import {
  IPayoutBilling,
  IPayoutDisbursal,
  IPayoutSummary,
} from '@/modules/payouts/types';

const payoutBillingSchema = new Schema<IPayoutBilling>(
  {
    specialistId: {
      type: String,
      required: true,
      index: true,
    },
    month: {
      type: Number,
      required: true,
      index: true,
    },
    totalAppointments: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    totalPatients: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    totalUniquePatients: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    totalFollowUpAppointments: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    total: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    paid: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    due: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ['Unpaid', 'Partially Paid', 'Paid'],
      required: true,
      default: 'Unpaid',
      index: true,
    },
    invoiceUrl: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

payoutBillingSchema.index({ specialistId: 1, month: 1 }, { unique: true });

const payoutDisbursalSchema = new Schema<IPayoutDisbursal>(
  {
    billingIds: {
      type: [Schema.Types.ObjectId],
      ref: 'PayoutBilling',
      default: [],
      index: true,
    } as any,
    specialistId: {
      type: String,
      required: true,
      index: true,
    },
    disbursalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    disbursalDate: {
      type: Number,
      required: true,
      index: true,
    },
    extraDetails: {
      type: Schema.Types.Mixed,
      default: {},
    },
    receiptUrl: {
      type: String,
      trim: true,
    },
    createdByAdminId: {
      type: String,
      trim: true,
      index: true,
    },
  },
  { timestamps: true }
);

const payoutSummarySchema = new Schema<IPayoutSummary>(
  {
    specialistId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    total: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    paid: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    due: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    lastDisbursalDate: {
      type: Number,
      index: true,
    },
  },
  { timestamps: true }
);

export const PayoutBillingModel: Model<IPayoutBilling> = model<IPayoutBilling>(
  'PayoutBilling',
  payoutBillingSchema
);

export const PayoutDisbursalModel: Model<IPayoutDisbursal> =
  model<IPayoutDisbursal>('PayoutDisbursal', payoutDisbursalSchema);

export const PayoutSummaryModel: Model<IPayoutSummary> = model<IPayoutSummary>(
  'PayoutSummary',
  payoutSummarySchema
);
