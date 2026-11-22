import { NextFunction, Response } from 'express';
import mongoose, { Schema, model, Model, Types } from 'mongoose';
import SpecialistModel from '@/modules/specialists/model';
import { AppError } from '@/modules/common/types';
import { AuthRequest } from '@/modules/middleware/auth';
import logger from '@/services/logger';

/**
 * S5 review: an admin verification binds to what the admin reviewed, and is recorded.
 *
 * - Fence (optional, for panels that send it): on PUT /specialists/:id that turns isVerified to true, `expectedName`,
 *   `expectedRegistrationNumber` and/or `expectedUpdatedAt` must match the stored doctor, else 409
 *   SPECIALIST_CHANGED_SINCE_REVIEW (the admin reloads and reviews again). They are read before body validation and are
 *   never stored on the doctor.
 * - Audit: every verification (that update, or an admin create with isVerified true) writes one specialistverifications
 *   row before the write - who, when, and the name, registration number, degree and specialization being verified - and
 *   marks it applied or not applied once the request answers.
 */
export interface ISpecialistVerification {
  specialistId: string | null;
  verifiedBy: string;
  requestedAt: Date;
  outcome: 'pending' | 'applied' | 'not_applied';
  httpStatus?: number;
  name?: string;
  medicalRegistrationNumber?: string;
  degree?: string;
  specialization?: string;
  fenced: boolean;
}

const verificationSchema = new Schema<ISpecialistVerification>({
  specialistId: { type: String, default: null, index: true },
  verifiedBy: { type: String, required: true },
  requestedAt: { type: Date, required: true },
  outcome: { type: String, required: true, enum: ['pending', 'applied', 'not_applied'] },
  httpStatus: Number,
  name: String,
  medicalRegistrationNumber: String,
  degree: String,
  specialization: String,
  fenced: { type: Boolean, required: true },
}, { versionKey: false });

export const SpecialistVerificationModel: Model<ISpecialistVerification> =
  (mongoose.models.SpecialistVerification as Model<ISpecialistVerification>) || model<ISpecialistVerification>('SpecialistVerification', verificationSchema);

const FENCE_KEYS = ['expectedName', 'expectedRegistrationNumber', 'expectedUpdatedAt'] as const;
type Fence = Partial<Record<(typeof FENCE_KEYS)[number], string>>;
const norm = (v: unknown) => (v == null ? '' : String(v).trim());
const changed = () => new AppError({ status: 409, code: 'SPECIALIST_CHANGED_SINCE_REVIEW',
  message: "The doctor's profile changed since you reviewed it; reload it and review it again" });

/** Before body validation: takes the fence values out of the body (validation would strip them). */
export const takeVerificationFence = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const body = req.body as Record<string, unknown> | undefined;
  const fence: Fence = {};
  for (const k of FENCE_KEYS) {
    if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, k)) {
      if (typeof body[k] !== 'string') throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: `${k} must be a string` });
      fence[k] = body[k] as string;
      delete body[k];
    }
  }
  if (fence.expectedUpdatedAt !== undefined && Number.isNaN(new Date(fence.expectedUpdatedAt).getTime())) {
    throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'expectedUpdatedAt must be a date' });
  }
  res.locals.verificationFence = fence;
  next();
};

/** After body validation: for a verification, checks the fence and writes the audit row (finalized when the answer is sent). */
export const fenceAndRecordVerification = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  if (body?.isVerified !== true) { next(); return; }
  const id = req.params.id;
  const fence = (res.locals.verificationFence ?? {}) as Fence;
  let current: Record<string, any> | null = null;
  if (id) {
    current = Types.ObjectId.isValid(id) ? await SpecialistModel.findById(id).lean() as Record<string, any> | null : null;
    if (!current) { next(); return; } // the update answers 404
    if (current.isVerified === true) { next(); return; } // already verified: not a verification
    if (fence.expectedName !== undefined && norm(fence.expectedName) !== norm(current.name)) throw changed();
    if (fence.expectedRegistrationNumber !== undefined && norm(fence.expectedRegistrationNumber) !== norm(current.medicalRegistrationNumber)) throw changed();
    if (fence.expectedUpdatedAt !== undefined && new Date(fence.expectedUpdatedAt).getTime() !== new Date(current.updatedAt).getTime()) throw changed();
  }
  const value = (k: string) => {
    const v = Object.prototype.hasOwnProperty.call(body, k) ? body[k] : current?.[k];
    return v == null || v === '' ? undefined : String(v);
  };
  const row = await SpecialistVerificationModel.create({
    specialistId: id ? String(id).toLowerCase() : null, verifiedBy: String(req.user?._id ?? ''), requestedAt: new Date(), outcome: 'pending',
    name: value('name'), medicalRegistrationNumber: value('medicalRegistrationNumber'), degree: value('degree'),
    specialization: value('specialization'), fenced: Object.keys(fence).length > 0,
  });
  // The answer carries the created doctor's id for a create; the row is completed when the request has answered.
  const json = res.json.bind(res);
  let createdId: string | undefined;
  res.json = ((b: unknown) => { const d = (b as { data?: { _id?: unknown } } | null)?.data; if (d?._id) createdId = String(d._id); return json(b); }) as Response['json'];
  res.on('finish', () => {
    const applied = res.statusCode >= 200 && res.statusCode < 300;
    SpecialistVerificationModel.updateOne({ _id: row._id }, { $set: { outcome: applied ? 'applied' : 'not_applied', httpStatus: res.statusCode,
      ...(!id && createdId ? { specialistId: createdId.toLowerCase() } : {}) } })
      .catch((e) => logger.warn('S5: verification audit row not completed', { auditId: String(row._id), error: (e as Error).message }));
  });
  next();
};
