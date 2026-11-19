import { Schema, model, Model } from 'mongoose';

/**
 * Q7: a partner sign-in that proved the phone or email (OTP) for a person with several memberships gets a short-lived ticket to
 * choose one. Each ticket is usable once (claimed by deleting this row) and expires on its own (TTL).
 */
/** The proven identity is the phone or (sign-in by email) the lower-cased email: exactly one of them. */
export interface IPartnerSelectionTicket { _id?: string; jti: string; phone?: string; email?: string; expiresAt: Date }

const ticketSchema = new Schema<IPartnerSelectionTicket>(
  {
    jti: { type: String, required: true },
    phone: { type: String },
    email: { type: String },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);
ticketSchema.index({ jti: 1 }, { unique: true });
ticketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PartnerSelectionTicketModel: Model<IPartnerSelectionTicket> = model<IPartnerSelectionTicket>(
  'PartnerSelectionTicket', ticketSchema, 'partner_selection_tickets'
);
