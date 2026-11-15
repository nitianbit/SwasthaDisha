import { Schema, model, Model } from 'mongoose';

/**
 * Q7: a partner sign-in that proved the phone (OTP) for a person with several memberships gets a short-lived ticket to
 * choose one. Each ticket is usable once (claimed by deleting this row) and expires on its own (TTL).
 */
export interface IPartnerSelectionTicket { _id?: string; jti: string; phone: string; expiresAt: Date }

const ticketSchema = new Schema<IPartnerSelectionTicket>(
  {
    jti: { type: String, required: true },
    phone: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);
ticketSchema.index({ jti: 1 }, { unique: true });
ticketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PartnerSelectionTicketModel: Model<IPartnerSelectionTicket> = model<IPartnerSelectionTicket>(
  'PartnerSelectionTicket', ticketSchema, 'partner_selection_tickets'
);
