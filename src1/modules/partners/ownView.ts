import type { IPartner } from '@/modules/partners/types';

/**
 * Q16b: what a partner's own people see of their partner (GET/PUT /partner-workspace/me, GET /auth/profile): not the
 * admin's create key and who made it, and not which admin verified it. Admin answers (/partner-workspace/admin/...)
 * keep the full record.
 */
export function partnerOwnView<T extends Partial<IPartner>>(p: T): Omit<T, 'createdBy' | 'createRequestKey' | 'createRequestHash'> {
  const { createdBy: _c, createRequestKey: _k, createRequestHash: _h, ...rest } = p;
  if (rest.verification && typeof rest.verification === 'object') {
    const { verifiedBy: _v, stateBeforeSuspension: _s, ...shown } = rest.verification;
    (rest as Partial<IPartner>).verification = shown as IPartner['verification'];
  }
  return rest;
}
