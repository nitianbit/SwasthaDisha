import { Schema, model, Model } from 'mongoose';

export type ConsultMode = 'chat' | 'call' | 'video' | 'in-person';
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** A working window: whole slots of `slotMinutes` are generated inside it, for these modes, optionally at a clinic branch. */
export interface IScheduleWindow { start: string; end: string; modes: ConsultMode[]; branchId?: string }

/** §5: the doctor's weekly template and leave days, expanded into ordinary Slot documents for a rolling 30 days. */
export interface IDoctorScheduleTemplate {
  _id?: string;
  doctorId: string;
  slotMinutes: number;
  days: Partial<Record<Weekday, IScheduleWindow[]>>;
  /** India-time dates YYYYMMDD on which no slot is offered (existing bookings keep their slots). */
  leaveDates: string[];
  isActive: boolean;
  updatedAt?: Date;
}

const windowSchema = new Schema<IScheduleWindow>(
  {
    start: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    end: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    modes: { type: [{ type: String, enum: ['chat', 'call', 'video', 'in-person'] }], required: true },
    branchId: { type: String },
  },
  { _id: false }
);

const templateSchema = new Schema<IDoctorScheduleTemplate>(
  {
    doctorId: { type: String, required: true },
    slotMinutes: { type: Number, required: true, min: 5, max: 240 },
    days: {
      mon: [windowSchema], tue: [windowSchema], wed: [windowSchema], thu: [windowSchema],
      fri: [windowSchema], sat: [windowSchema], sun: [windowSchema],
    },
    leaveDates: { type: [String], default: [] },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true }
);
templateSchema.index({ doctorId: 1 }, { unique: true });

export const DoctorScheduleTemplateModel: Model<IDoctorScheduleTemplate> = model<IDoctorScheduleTemplate>(
  'DoctorScheduleTemplate', templateSchema, 'doctor_schedule_templates'
);
