import { model, Schema } from 'mongoose';

/**
 * D4: one web login (a refresh "family"). Refresh tokens are `sid.gen.HMAC(server key, sid.gen)`: nothing secret is
 * stored; `gen` is the only generation accepted, and any correctly signed older generation is proof of reuse for the
 * family's whole lifetime.
 */
export interface AuthSession {
  _id: string;
  audience: 'customer' | 'workspace' | 'native_customer' | 'native_workspace';
  userType: string;
  userId: string;
  /** Time of the OTP login; never changed by refresh. */
  authTime: Date;
  absoluteExpiresAt: Date;
  idleExpiresAt: Date;
  gen: number;
  /** Customer credential generation at login: "sign out everywhere" (authVersion moves on) ends the session. */
  authVersion?: number;
  revokedAt?: Date;
  revokeReason?: string;
  createdAt: Date;
  lastRefreshAt?: Date;
}

const sessionSchema = new Schema<AuthSession>({
  _id: { type: String, required: true },
  audience: { type: String, enum: ['customer', 'workspace', 'native_customer', 'native_workspace'], required: true, immutable: true },
  userType: { type: String, required: true, immutable: true },
  userId: { type: String, required: true, immutable: true },
  authTime: { type: Date, required: true, immutable: true },
  absoluteExpiresAt: { type: Date, required: true, immutable: true },
  idleExpiresAt: { type: Date, required: true },
  gen: { type: Number, required: true, min: 1 },
  authVersion: { type: Number },
  revokedAt: { type: Date },
  revokeReason: { type: String },
  createdAt: { type: Date, required: true, immutable: true },
  lastRefreshAt: { type: Date },
}, { collection: 'auth_sessions', versionKey: false, strict: 'throw', autoIndex: false, autoCreate: false });

sessionSchema.index({ userId: 1, userType: 1, revokedAt: 1 });
// Rows are kept 30 days past their absolute expiry (audit, reuse detection), then removed.
sessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const AuthSessionModel = model<AuthSession>('AuthSession', sessionSchema);
