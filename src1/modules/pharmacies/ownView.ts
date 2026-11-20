import type { IPharmacy } from '@/modules/pharmacies/types';

/**
 * Q15: the admin create key (and the admin who made it) are not part of what a pharmacy sees of itself
 * (GET /pharmacies/me/profile, PUT /pharmacies/me/profile, GET /auth/profile).
 */
export const withoutCreateKey = <T extends Partial<IPharmacy>>(p: T): Omit<T, 'createdBy' | 'createRequestKey' | 'createRequestHash'> => {
  const { createdBy: _c, createRequestKey: _k, createRequestHash: _h, ...rest } = p;
  return rest;
};
