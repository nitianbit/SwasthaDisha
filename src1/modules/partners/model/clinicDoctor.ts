import { Schema, model, Model } from 'mongoose';

/**
 * Q14 (owner, 18 Nov 2026): clinics no longer invite doctors; an admin links a doctor directly after checking (an
 * 'accepted' row with via 'admin_link'). Pending invitations stay readable but can no longer be accepted.
 *
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
  /** Q14: how the link was made — a (retired) invitation the doctor accepted, or an admin's direct link. */
  via?: 'invite' | 'admin_link';
  /** Q14: the admin link's request key (per clinic) and content hash. */
  requestKey?: string;
  requestHash?: string;
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
    via: { type: String, enum: ['invite', 'admin_link'] },
    requestKey: { type: String },
    requestHash: { type: String },
  },
  { timestamps: true }
);

inviteSchema.index({ partnerId: 1, doctorId: 1 }, { unique: true, partialFilterExpression: { state: 'pending' } });
inviteSchema.index({ doctorId: 1, state: 1 });
inviteSchema.index({ partnerId: 1, state: 1, createdAt: -1 });
// Q14: an admin link happens once per (clinic, request key).
inviteSchema.index({ partnerId: 1, requestKey: 1 }, { unique: true, partialFilterExpression: { requestKey: { $type: 'string' } } });

export const ClinicDoctorInviteModel: Model<IClinicDoctorInvite> = model<IClinicDoctorInvite>(
  'ClinicDoctorInvite', inviteSchema, 'clinic_doctor_invites'
);
