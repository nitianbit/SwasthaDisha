import { Schema, model, Model } from 'mongoose';

/**
 * Q6: a clinic asks a doctor to consult with it. The doctor's membership (and with it the clinic's authority over the
 * doctor's in-clinic windows and desk appointments) exists only after the doctor accepts in their own portal.
 */
export interface IClinicDoctorInvite {
  _id?: string;
  partnerId: string;
  doctorId: string;
  /** The branches the doctor will consult at (empty = every branch). */
  branchIds: string[];
  invitedBy: string;
  state: 'pending' | 'accepted' | 'declined' | 'revoked';
  respondedAt?: Date;
  memberId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const inviteSchema = new Schema<IClinicDoctorInvite>(
  {
    partnerId: { type: String, required: true },
    doctorId: { type: String, required: true },
    branchIds: { type: [String], default: [] },
    invitedBy: { type: String, required: true },
    state: { type: String, required: true, enum: ['pending', 'accepted', 'declined', 'revoked'], default: 'pending' },
    respondedAt: Date,
    memberId: String,
  },
  { timestamps: true }
);

inviteSchema.index({ partnerId: 1, doctorId: 1 }, { unique: true, partialFilterExpression: { state: 'pending' } });
inviteSchema.index({ doctorId: 1, state: 1 });
inviteSchema.index({ partnerId: 1, state: 1, createdAt: -1 });

export const ClinicDoctorInviteModel: Model<IClinicDoctorInvite> = model<IClinicDoctorInvite>(
  'ClinicDoctorInvite', inviteSchema, 'clinic_doctor_invites'
);
