import { Request, Response } from 'express';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import PartnerOrgModel from '@/modules/partners/model';
import { actorOf as partnerActorOf } from '@/modules/partners/controller';
import { recordPartnerAudit } from '@/modules/partners/services';
import { auditIn } from '@/modules/assisted/support';
import { labAdmissible } from '@/modules/assisted/labBookings';
import { loadRecommendation } from '@/modules/testRecommendations/service';

/**
 * Phase 3d (§25.7.4): GET …/recommendations/:code?phone= for the three partners that book tests for a walk-in
 * patient. Each counts the load against its own organisation's hourly lookup limit and audits it (ids only).
 * Answers `{ success, data: { code, status, items: [{ index, name }] } }`; never cached.
 */
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const send = (res: Response, data: unknown) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).json({ success: true, data });
};

/** /api/v1/pharmacy-assisted/recommendations/:code (an operational pharmacy). */
export const pharmacyRecommendation = async (req: AuthRequest, res: Response) => {
  const pharmacyId = lower(req.user?.pharmacyId || req.user?._id);
  const actorId = lower(req.user?._id);
  send(res, await loadRecommendation(req.params.code, req.query.phone, { orgKey: `pharmacy:${pharmacyId}`,
    audit: (seen) => auditIn({ actorKind: 'pharmacy', actorId, orgKind: 'pharmacy', orgId: pharmacyId, action: 'recommendation.lookup', detail: seen }, null) }));
};

/** /api/v1/specialists/me/assisted/recommendations/:code (a verified, active doctor). */
export const doctorRecommendation = async (req: AuthRequest, res: Response) => {
  const doctorId = lower(req.user?.specialistId || req.user?._id);
  send(res, await loadRecommendation(req.params.code, req.query.phone, { orgKey: `doctor:${doctorId}`,
    audit: (seen) => auditIn({ actorKind: 'doctor', actorId: doctorId, orgKind: 'doctor', orgId: doctorId, action: 'recommendation.lookup', detail: seen }, null) }));
};

/**
 * /api/v1/partner-workspace/lab-desk/recommendations/:code (`bookings.manage`, the desk permission L13). Labs only, and
 * only an active, verified lab (members are refused earlier by their admission; this also holds for admins acting as
 * the owner).
 */
export const labDeskRecommendation = async (req: Request, res: Response) => {
  const actor = partnerActorOf(req);
  const partner = await PartnerOrgModel.findById(actor.partnerId).select({ kind: 1, isActive: 1, verification: 1 }).lean() as Record<string, any> | null;
  if (partner?.kind !== 'lab') throw new AppError({ status: 403, code: 'LAB_PARTNER_REQUIRED', message: 'The front desk is for labs' });
  if (!labAdmissible(partner)) throw new AppError({ status: 403, code: 'PARTNER_NOT_VERIFIED', message: 'Partner verification is required for this operation' });
  send(res, await loadRecommendation(req.params.code, req.query.phone, { orgKey: `lab:${lower(actor.partnerId)}`,
    audit: (seen) => recordPartnerAudit(actor, 'lab_desk.recommendation_lookup',
      seen.recommendationId ? { kind: 'test_recommendation', id: seen.recommendationId } : undefined, { found: seen.found }) }));
};
