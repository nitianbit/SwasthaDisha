import { Schema, model, Model } from 'mongoose';

export type VisitMode = 'home' | 'lab';
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Why a slot is not bookable; null = open. Manual closures are never undone by template expansion. */
export type SlotClosure = null | 'holiday' | 'template' | 'manual';

/** §4: one logical slot per {branchId, visitMode, date, startTime}; booked is server-owned (seats taken by $inc). */
export interface IPartnerSlot {
  _id?: string;
  partnerId: string;
  branchId: string;
  visitMode: VisitMode;
  /** India-time calendar date YYYY-MM-DD */
  date: string;
  /** India-time HH:mm */
  startTime: string;
  endTime: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  booked: number;
  closed: SlotClosure;
  source: 'template' | 'manual';
  /** Q11: the request key of a manual slot (replay of a lost answer). */
  createRequestKey?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const slotSchema = new Schema<IPartnerSlot>(
  {
    partnerId: { type: String, required: true },
    branchId: { type: String, required: true },
    visitMode: { type: String, required: true, enum: ['home', 'lab'] },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    startTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    endTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    capacity: { type: Number, required: true, min: 0 },
    booked: { type: Number, required: true, min: 0, default: 0 },
    closed: { type: String, enum: [null, 'holiday', 'template', 'manual'], default: null },
    source: { type: String, required: true, enum: ['template', 'manual'] },
    createRequestKey: { type: String },
  },
  { timestamps: true }
);

slotSchema.index({ branchId: 1, visitMode: 1, date: 1, startTime: 1 }, { unique: true });
slotSchema.index({ branchId: 1, visitMode: 1, startsAt: 1 });

export const PartnerSlotModel: Model<IPartnerSlot> = model<IPartnerSlot>('PartnerSlot', slotSchema, 'partner_slots');

export interface ISlotWindow { start: string; end: string }

/** Weekly template per branch and visit mode; expanded into slots for a rolling window. */
export interface IPartnerSlotTemplate {
  _id?: string;
  partnerId: string;
  branchId: string;
  visitMode: VisitMode;
  slotMinutes: number;
  capacity: number;
  days: Partial<Record<Weekday, ISlotWindow[]>>;
  isActive: boolean;
  updatedAt?: Date;
}

const windowSchema = new Schema<ISlotWindow>(
  {
    start: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    end: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  },
  { _id: false }
);

const templateSchema = new Schema<IPartnerSlotTemplate>(
  {
    partnerId: { type: String, required: true },
    branchId: { type: String, required: true },
    visitMode: { type: String, required: true, enum: ['home', 'lab'] },
    slotMinutes: { type: Number, required: true, min: 5, max: 480 },
    capacity: { type: Number, required: true, min: 1, max: 500 },
    days: {
      mon: [windowSchema], tue: [windowSchema], wed: [windowSchema], thu: [windowSchema],
      fri: [windowSchema], sat: [windowSchema], sun: [windowSchema],
    },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true }
);

templateSchema.index({ branchId: 1, visitMode: 1 }, { unique: true });

export const PartnerSlotTemplateModel: Model<IPartnerSlotTemplate> = model<IPartnerSlotTemplate>(
  'PartnerSlotTemplate', templateSchema, 'partner_slot_templates'
);

/**
 * Serialization point for one generated schedule (`partner-slots:<branch>:<mode>`, `doctor-slots:<doctor>`). Every
 * expansion and every configuration change bumps it inside its own transaction, so two of them never commit
 * interleaved: the loser's transaction conflicts and is retried, re-reading the configuration that won.
 */
export interface IScheduleGuard { _id?: string; key: string; version: number }
const scheduleGuardSchema = new Schema<IScheduleGuard>(
  { key: { type: String, required: true }, version: { type: Number, required: true, default: 0 } },
  { versionKey: false }
);
scheduleGuardSchema.index({ key: 1 }, { unique: true });
export const ScheduleGuardModel: Model<IScheduleGuard> = model<IScheduleGuard>('ScheduleGuard', scheduleGuardSchema, 'schedule_guards');
