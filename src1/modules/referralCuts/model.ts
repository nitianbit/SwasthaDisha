import { Schema, model, Model } from 'mongoose';
import { REFERRAL_CATEGORIES, type BookerKind, type ReferralCategory } from '@/modules/assisted/types';

/**
 * r24 (§26.5.1): a booking partner's referral cut for one category — a percent of the line base (basis points) or a
 * fixed amount per line, with an optional per-line cap. Set by admins at partner setup; partners read it. Edits are
 * fenced by `version` and each one appends an event.
 */
export interface IReferralRule {
  _id?: string;
  bookerKind: BookerKind;
  bookerId: string;
  category: ReferralCategory;
  basis: 'percent' | 'fixed';
  percentBasisPoints?: number;
  fixedMinor?: number;
  capMinor?: number;
  isActive: boolean;
  version: number;
  updatedBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const ruleSchema = new Schema<IReferralRule>({
  bookerKind: { type: String, required: true, enum: ['pharmacy', 'lab', 'doctor'] },
  bookerId: { type: String, required: true },
  category: { type: String, required: true, enum: [...REFERRAL_CATEGORIES] },
  basis: { type: String, required: true, enum: ['percent', 'fixed'] },
  percentBasisPoints: { type: Number, min: 1, max: 5000 },
  fixedMinor: { type: Number, min: 1 },
  capMinor: { type: Number, min: 1 },
  isActive: { type: Boolean, required: true },
  version: { type: Number, required: true, min: 1 },
  updatedBy: { type: String, required: true },
}, { timestamps: true, strict: 'throw' });
ruleSchema.index({ bookerKind: 1, bookerId: 1, category: 1 }, { unique: true });

export const ReferralRuleModel: Model<IReferralRule> = model<IReferralRule>('ReferralRule', ruleSchema, 'referral_rules');

/** Append-only history: one row per rule version (ids and amounts only). */
export interface IReferralRuleEvent {
  ruleId: string;
  version: number;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  by: string;
  reason: string;
  at: Date;
}

const eventSchema = new Schema<IReferralRuleEvent>({
  ruleId: { type: String, required: true },
  version: { type: Number, required: true },
  before: { type: Schema.Types.Mixed, default: null },
  after: { type: Schema.Types.Mixed, required: true },
  by: { type: String, required: true },
  reason: { type: String, required: true },
  at: { type: Date, required: true },
}, { versionKey: false, strict: 'throw' });
eventSchema.index({ ruleId: 1, version: 1 }, { unique: true });

export const ReferralRuleEventModel: Model<IReferralRuleEvent> = model<IReferralRuleEvent>('ReferralRuleEvent', eventSchema, 'referral_rule_events');
