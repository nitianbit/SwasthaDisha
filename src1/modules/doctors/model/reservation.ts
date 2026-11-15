import { Schema, model, Model } from 'mongoose';

export type ReservationKind = 'scheduled' | 'instant' | 'in_clinic';

/**
 * §5: one time interval a doctor is committed to. Every booking path (scheduled, instant, in-clinic) inserts one in the
 * same transaction as its booking, after bumping the doctor's DoctorScheduleGuard, so two overlapping commitments can
 * never both commit (the guard write makes concurrent admissions conflict; the overlap query runs on the snapshot).
 */
export interface IDoctorReservation {
  _id?: string;
  doctorId: string;
  kind: ReservationKind;
  /** The booking (or instant request) the interval belongs to. */
  refId: string;
  startTime: Date;
  endTime: Date;
  branchId?: string;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const reservationSchema = new Schema<IDoctorReservation>(
  {
    doctorId: { type: String, required: true },
    kind: { type: String, required: true, enum: ['scheduled', 'instant', 'in_clinic'] },
    refId: { type: String, required: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    branchId: { type: String },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true }
);

reservationSchema.index({ doctorId: 1, isActive: 1, startTime: 1, endTime: 1 });
reservationSchema.index({ refId: 1, kind: 1 }, { unique: true });

export const DoctorReservationModel: Model<IDoctorReservation> = model<IDoctorReservation>(
  'DoctorReservation', reservationSchema, 'doctor_reservations'
);

/** Per-doctor serialization point: every admission/change bumps `version` inside its transaction. */
export interface IDoctorScheduleGuard { _id?: string; doctorId: string; version: number }

const guardSchema = new Schema<IDoctorScheduleGuard>(
  {
    doctorId: { type: String, required: true },
    version: { type: Number, required: true, default: 0 },
  },
  { versionKey: false }
);
guardSchema.index({ doctorId: 1 }, { unique: true });

export const DoctorScheduleGuardModel: Model<IDoctorScheduleGuard> = model<IDoctorScheduleGuard>(
  'DoctorScheduleGuard', guardSchema, 'doctor_schedule_guards'
);
