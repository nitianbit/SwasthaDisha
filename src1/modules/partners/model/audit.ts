import { Schema, model, Model } from 'mongoose';

export interface IPartnerAuditEvent {
  _id?: string;
  partnerId: string;
  actorKind: 'member' | 'admin';
  /** Member id, or the admin id for admin actions. */
  actorId: string;
  action: string;
  targetKind?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
  at: Date;
}

const auditSchema = new Schema<IPartnerAuditEvent>(
  {
    partnerId: { type: String, required: true },
    actorKind: { type: String, required: true, enum: ['member', 'admin'] },
    actorId: { type: String, required: true },
    action: { type: String, required: true },
    targetKind: { type: String },
    targetId: { type: String },
    detail: { type: Schema.Types.Mixed },
    at: { type: Date, required: true },
  },
  { versionKey: false }
);

auditSchema.index({ partnerId: 1, at: -1 });

const PartnerAuditEventModel: Model<IPartnerAuditEvent> = model<IPartnerAuditEvent>(
  'PartnerAuditEvent', auditSchema, 'partner_audit_events'
);

export default PartnerAuditEventModel;
