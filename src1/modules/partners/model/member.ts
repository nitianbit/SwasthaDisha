import { Schema, model, Model } from 'mongoose';
import { IMember, ALL_PERMISSIONS } from '@/modules/partners/types';

const memberSchema = new Schema<IMember>(
  {
    partnerId: {
      type: String,
      required: true,
      index: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Optional sign-in email (OTP by email, like the phone). Stored and queried lower-cased and trimmed.
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    // Q16b: token generation (auth/tokenVersion.ts; written only by it). Never selected, so no answer shows it.
    authVersion: { type: Number, select: false },
    role: {
      type: String,
      required: true,
      enum: ['owner', 'staff'],
    },
    permissions: [{
      type: String,
      enum: ALL_PERMISSIONS as unknown as string[],
    }],
    branchIds: [{ type: String }],
    doctorId: {
      type: String,
      sparse: true,
    },
    // Q6: the branches the doctor consented to consult at (from the accepted invitation; empty = all). Kept apart from
    // branchIds (workspace access), so linking an existing staff record never widens or narrows clinical authority.
    doctorBranchIds: { type: [String], default: undefined },
    professional: {
      kind: { type: String, enum: ['pathologist', 'pharmacist', 'doctor'] },
      registrationNumber: { type: String, trim: true },
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    invitedBy: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

memberSchema.index({ partnerId: 1, isActive: 1 });
memberSchema.index(
  { phone: 1, partnerId: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);
// An email signs in to at most one active membership per partner (as the phone); removed members keep theirs without
// blocking it. Found by email across partners at sign-in.
memberSchema.index(
  { email: 1, partnerId: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' }, isActive: true } }
);
memberSchema.index({ partnerId: 1, role: 1, isActive: 1 });
// Q6: a doctor is linked to a clinic at most once (active), and found by doctor across clinics.
memberSchema.index({ partnerId: 1, doctorId: 1 }, { unique: true, partialFilterExpression: { isActive: true, doctorId: { $type: 'string' } } });
memberSchema.index({ doctorId: 1, isActive: 1 }, { partialFilterExpression: { doctorId: { $type: 'string' } } });

const MemberModel: Model<IMember> = model<IMember>('PartnerMember', memberSchema, 'partner_members');

export default MemberModel;
