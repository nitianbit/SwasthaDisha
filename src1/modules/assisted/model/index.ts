import { Schema, model, Model } from 'mongoose';

/**
 * Assisted booking (§6.1): audit of assisted actions by pharmacies and doctors (partner members use PartnerAuditEvent),
 * written in the action's own transaction. Ids and codes only: no names, phones or clinical text.
 * Phase 0 writes `rx_order.created` (a medicine order made from a booking's prescription).
 */
export interface IAssistedAuditEvent {
  at: Date;
  actorKind: 'pharmacy' | 'doctor';
  actorId: string;
  orgKind: 'pharmacy' | 'lab' | 'doctor';
  orgId: string;
  action: 'rx_order.created';
  bookingId?: string;
  orderId?: string;
  requestKey?: string;
  detail?: Record<string, unknown>;
}

const auditSchema = new Schema<IAssistedAuditEvent>({
  at: { type: Date, required: true },
  actorKind: { type: String, required: true, enum: ['pharmacy', 'doctor'] },
  actorId: { type: String, required: true },
  orgKind: { type: String, required: true, enum: ['pharmacy', 'lab', 'doctor'] },
  orgId: { type: String, required: true },
  action: { type: String, required: true, enum: ['rx_order.created'] },
  bookingId: { type: String },
  orderId: { type: String },
  requestKey: { type: String },
  detail: { type: Schema.Types.Mixed },
}, { versionKey: false, strict: 'throw' });
auditSchema.index({ orgKind: 1, orgId: 1, at: -1 });
auditSchema.index({ bookingId: 1, at: -1 });

export const AssistedAuditEventModel: Model<IAssistedAuditEvent> = model<IAssistedAuditEvent>(
  'AssistedAuditEvent', auditSchema, 'assisted_audit_events');

export default AssistedAuditEventModel;
