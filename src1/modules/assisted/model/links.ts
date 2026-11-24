import { Schema, model, Model } from 'mongoose';

/**
 * r12 (§24.6.1, §17.4): a lab's (later a doctor's) link to a patient account it booked for — the lab equivalent of the
 * pharmacy-customer link: consent recorded by the partner (`patient_agreed`) and the FIRST name it typed, never
 * overwritten by a later booking. Labs see only this typed name, or the account name masked (L15); never the real
 * account name. Written in the booking transaction.
 */
export interface IAssistedLink {
  _id?: string;
  bookerKind: 'lab' | 'doctor';
  bookerId: string;
  userId: string;
  typedName?: string;
  consent: 'patient_agreed';
  consentRecordedAt: Date;
  consentRecordedById: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const linkSchema = new Schema<IAssistedLink>(
  {
    bookerKind: { type: String, required: true, enum: ['lab', 'doctor'] },
    bookerId: { type: String, required: true },
    userId: { type: String, required: true },
    typedName: { type: String, trim: true },
    consent: { type: String, required: true, enum: ['patient_agreed'] },
    consentRecordedAt: { type: Date, required: true },
    consentRecordedById: { type: String, required: true },
  },
  { timestamps: true }
);

linkSchema.index({ bookerKind: 1, bookerId: 1, userId: 1 }, { unique: true });

export const AssistedLinkModel: Model<IAssistedLink> = model<IAssistedLink>('AssistedLink', linkSchema, 'assisted_links');
