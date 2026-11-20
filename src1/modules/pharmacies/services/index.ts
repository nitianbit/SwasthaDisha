import { Service } from 'typedi';
import mongoose, { ClientSession } from 'mongoose';
import PharmacyModel from '@/modules/pharmacies/model';
import { claimRequestKey, abandonRequestKey } from '@/modules/requestKeys';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { assertUniqueIndex, KeyAlreadyUsed } from '@/modules/common/utils/requiredIndex';
import { ContactField, withoutSelfContacts } from '@/modules/common/utils/selfContacts';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { UserRepository } from '@/modules/user/repository';
import {
  IPharmacy,
  CreatePharmacyRequest,
  UpdatePharmacyRequest,
  PharmacyQueryParams,
} from '@/modules/pharmacies/types';
import { AppError } from '@/modules/common/types';

/** Q15: the admission scope of admin pharmacy-create keys (claimed with the pharmacy; abandon makes a key unusable). */
export const pharmacyCreateScope = (adminId: string) => `pharmacy_create:${String(adminId).toLowerCase()}`;

/** Q15: optional fields an admin edit may clear with null or "" (the phone and name are required). */
const CLEARABLE_FIELDS = new Set(['nickname', 'ownerName', 'email', 'address', 'city', 'state', 'pincode', 'latitude', 'longitude', 'gstNumber',
  'drugLicenseNumber', 'gstCertificateUrl', 'drugLicenseDocumentUrl', 'ownerIdProofUrl', 'shopFrontPhotoUrl', 'profilePictureUrl']);
const recordChanged = () => new AppError({ status: 409, code: 'RECORD_CHANGED', message: 'Someone else changed this pharmacy meanwhile; reload and review' });
const phoneTaken = () => new AppError({ status: 400, code: 'PHONE_ALREADY_EXISTS', message: 'A pharmacy with this phone number already exists' });
/**
 * Q15 review: a unique-index refusal that a concurrent write won. The phone keeps its 400; the email (index
 * `email_unique_1`) answers 409 like the check before the write.
 */
/** Q15 re-review: a taken email is a conflict (409), from the check before the write and from the index alike. */
const emailTaken = () => new AppError({ status: 409, code: 'EMAIL_ALREADY_EXISTS', message: 'A pharmacy with this email already exists' });
function duplicateError(e: any): unknown {
  if (e instanceof KeyAlreadyUsed) return new AppError({ status: 409, code: 'REQUEST_KEY_REUSED', message: 'This request key was already used' });
  if (e?.code !== 11000) return e;
  if (e?.keyPattern?.phone) return phoneTaken();
  if (e?.keyPattern?.email) return emailTaken();
  return e;
}

async function inTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

@Service()
export class PharmacyService {
  constructor(
    private pharmacyRepository: PharmacyRepository,
    private userRepository: UserRepository
  ) {}

  private sanitizeCreatePayload(
    data: CreatePharmacyRequest,
    requesterType?: string
  ): CreatePharmacyRequest {
    if (requesterType !== 'pharmacy') {
      return {
        ...data,
        email: data.email?.toLowerCase(),
      };
    }

    return {
      ...data,
      email: data.email?.toLowerCase(),
      isVerified: false,
      walletEnabled: false,
      isActive: true,
    };
  }

  private applyUserFacingVisibility(
    filter: PharmacyQueryParams = {}
  ): PharmacyQueryParams {
    return {
      ...filter,
      isActive: true,
      isVerified: true,
    };
  }

  /**
   * Admin create. Q15: with `requestKey`, exactly once per (admin, key): the key is claimed in the create transaction
   * (scope `pharmacy_create:<admin>`), a repeat with the same content answers with the pharmacy it made (`replayed`),
   * other content under the key is refused (409 REQUEST_KEY_REUSED) and an abandoned key 409 REQUEST_ABANDONED.
   */
  async create(
    data: CreatePharmacyRequest,
    requesterType?: string,
    createdBy?: string
  ): Promise<IPharmacy & { replayed?: boolean }> {
    const { requestKey, ...content } = data;
    const sanitizedData = this.sanitizeCreatePayload(content as CreatePharmacyRequest, requesterType);
    const keyed = !!(requestKey && createdBy);
    const requestHash = keyed ? requestHashOf(sanitizedData) : undefined;
    const replay = async (): Promise<(IPharmacy & { replayed: true }) | null> => {
      if (!keyed) return null;
      const prior = await PharmacyModel.findOne({ createdBy: { $eq: createdBy }, createRequestKey: { $eq: requestKey } }).lean() as IPharmacy | null;
      if (!prior) return null;
      if (prior.createRequestHash !== requestHash) {
        throw new AppError({ status: 409, code: 'REQUEST_KEY_REUSED', message: 'This request key was already used for a different pharmacy' });
      }
      return { ...prior, replayed: true };
    };
    if (keyed) {
      // Q15 review: exactly-once rests on the unique (admin, key) index; without it, refuse (503) rather than risk two.
      await assertUniqueIndex(PharmacyModel, { createdBy: 1, createRequestKey: 1 });
    }
    const prior = await replay();
    if (prior) return prior;
    // Q15 review: a refusal for a taken phone or email is given only after the key is looked up again (a concurrent
    // identical create under this key may have just made the pharmacy that holds them).
    const refuse = async (error: AppError) => {
      const raced = await replay();
      if (raced) return raced;
      throw error;
    };

    if (await this.pharmacyRepository.findByPhone(sanitizedData.phone)) return refuse(phoneTaken());
    if (sanitizedData.email && await this.pharmacyRepository.findByEmail(sanitizedData.email)) {
      return refuse(emailTaken());
    }

    try {
      if (!keyed) return await this.pharmacyRepository.save(sanitizedData);
      return await inTransaction(async (session) => {
        // Looked up again inside every attempt: a concurrent same-key create that committed is answered as a replay.
        if (await PharmacyModel.exists({ createdBy: { $eq: createdBy }, createRequestKey: { $eq: requestKey } }).session(session)) {
          throw new KeyAlreadyUsed();
        }
        await claimRequestKey(pharmacyCreateScope(createdBy!), requestKey!, session);
        const [made] = await PharmacyModel.create([{ ...sanitizedData, createdBy, createRequestKey: requestKey, createRequestHash: requestHash }], { session });
        return made.toObject() as IPharmacy;
      });
    } catch (e: any) {
      if (!(e instanceof KeyAlreadyUsed) && e?.code !== 11000) throw e;
      // A concurrent identical create under the same key won: answer with it (other content is refused there).
      const raced = await replay();
      if (raced) return raced;
      throw duplicateError(e);
    }
  }

  /** Q15: the pharmacy an admin's create key made (that admin's keys only); null when none. */
  async findCreatedByKey(adminId: string, key: string): Promise<IPharmacy | null> {
    return PharmacyModel.findOne({ createdBy: { $eq: String(adminId) }, createRequestKey: { $eq: key } }).lean() as unknown as Promise<IPharmacy | null>;
  }

  /** Q15: give up a lost create: abandoned (it can never be made) or used (here is the pharmacy). */
  async abandonCreateKey(adminId: string, key: string): Promise<{ state: 'abandoned' | 'used'; pharmacy?: IPharmacy | null }> {
    const made = await this.findCreatedByKey(adminId, key);
    if (made) return { state: 'used', pharmacy: made };
    const state = await abandonRequestKey(pharmacyCreateScope(adminId), key);
    return state === 'abandoned' ? { state } : { state, pharmacy: await this.findCreatedByKey(adminId, key) };
  }

  async getById(id: string): Promise<IPharmacy> {
    const pharmacy = await this.pharmacyRepository.findById(id);
    if (!pharmacy) {
      throw new AppError({
        status: 404,
        code: 'PHARMACY_NOT_FOUND',
        message: 'Pharmacy not found',
      });
    }
    return pharmacy;
  }

  async getAccessibleById(
    id: string,
    requester?: { userType?: string; _id?: string; pharmacyId?: string }
  ): Promise<IPharmacy> {
    const pharmacy = await this.getById(id);

    const assertPubliclyVisibleTarget = () => {
      if (!pharmacy.isVerified || !pharmacy.isActive) {
        throw new AppError({
          status: 404,
          code: 'PHARMACY_NOT_FOUND',
          message: 'Pharmacy not found',
        });
      }
    };

    if (requester?.userType === 'admin') {
      return pharmacy;
    }

    if (requester?.userType === 'pharmacy') {
      const requesterPharmacyId = requester.pharmacyId || requester._id;
      if (requesterPharmacyId === id) {
        return pharmacy;
      }

      const requesterPharmacy = await this.getById(requesterPharmacyId || '');
      if (!requesterPharmacy.isVerified) {
        throw new AppError({
          status: 403,
          code: 'FORBIDDEN',
          message: 'Only verified pharmacies can access pharmacy details',
        });
      }
      assertPubliclyVisibleTarget();
      return pharmacy;
    }

    if (requester?.userType === 'user' && requester._id) {
      const user = await this.userRepository.findById(requester._id);
      if (!user?.isVerified) {
        throw new AppError({
          status: 403,
          code: 'FORBIDDEN',
          message: 'Only verified users can access pharmacy details',
        });
      }
      assertPubliclyVisibleTarget();
      return pharmacy;
    }

    throw new AppError({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Access denied',
    });
  }

  async getAll(
    queryParams: PharmacyQueryParams = {},
    requesterType?: string
  ): Promise<{
    data: IPharmacy[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    const effectiveParams =
      requesterType === 'admin'
        ? queryParams
        : this.applyUserFacingVisibility(queryParams);

    if (
      effectiveParams.latitude !== undefined &&
      effectiveParams.longitude !== undefined
    ) {
      return this.pharmacyRepository.findNearby(effectiveParams);
    }

    if (effectiveParams.page && effectiveParams.limit) {
      return this.pharmacyRepository.findWithPagination(
        effectiveParams,
        effectiveParams.page,
        effectiveParams.limit
      );
    }

    const filter = this.pharmacyRepository.buildFilterFromParams(effectiveParams);
    const sort = this.pharmacyRepository.buildSortFromParams(effectiveParams);
    const data = await this.pharmacyRepository.findAll(filter, { sort });
    return { data };
  }

  /**
   * The pharmacy's own profile edit (Q14 review N7). The sign-in contacts (mobile number, email) are never set or
   * changed here — an unproven address could take someone else's sign-in; the Jansetu team changes them (admin
   * edit). They are left out, the rest is saved, and `ignoredContacts` names those that differed from the stored ones.
   */
  async updateOwnProfile(id: string, data: UpdatePharmacyRequest): Promise<{ pharmacy: IPharmacy; ignoredContacts: ContactField[] }> {
    const current = await this.getById(id);
    const { rest, ignoredContacts } = withoutSelfContacts(data as Record<string, unknown>, current as unknown as Record<string, unknown>, ['phone', 'email']);
    if (Object.keys(rest).length === 0) return { pharmacy: current, ignoredContacts };
    return { pharmacy: await this.update(id, rest as UpdatePharmacyRequest), ignoredContacts };
  }

  /**
   * Edit (the admin path; the pharmacy's own edit comes through updateOwnProfile without contacts). Q15:
   * - `expectedUpdatedAt` fences a stale view (409 RECORD_CHANGED), also on the write itself;
   * - an optional field sent as null or "" is removed (the phone and name stay required);
   * - a changed phone, or a changed or removed previous email (the sign-in contacts), ends the pharmacy's web and app
   *   sessions in the same transaction (a first email ends nothing). Legacy 30-day bearer tokens carry no session and
   *   end only when the pharmacy is archived or deactivated (the operational check refuses them then);
   * - phone and email stay unique among pharmacies.
   */
  async update(id: string, data: UpdatePharmacyRequest): Promise<IPharmacy> {
    const { expectedUpdatedAt, ...fields } = data;
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      if (v === null || v === '') {
        if (CLEARABLE_FIELDS.has(k)) unset[k] = 1;
        continue;
      }
      set[k] = k === 'email' ? String(v).trim().toLowerCase() : v;
    }
    // Q15 review: the location is one pair: clearing either coordinate clears both; clearing one while setting the
    // other is refused.
    if (unset.latitude || unset.longitude) {
      if (set.latitude !== undefined || set.longitude !== undefined) {
        throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'latitude and longitude are cleared together' });
      }
      unset.latitude = 1;
      unset.longitude = 1;
    }
    try {
      return await inTransaction(async (session) => {
        const pharmacy = await PharmacyModel.findById(id).session(session).lean() as IPharmacy | null;
        if (!pharmacy) {
          throw new AppError({ status: 404, code: 'PHARMACY_NOT_FOUND', message: 'Pharmacy not found' });
        }
        if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null &&
            new Date(pharmacy.updatedAt as Date).getTime() !== new Date(expectedUpdatedAt).getTime()) {
          throw recordChanged();
        }
        if (typeof set.phone === 'string' && set.phone !== pharmacy.phone &&
            await PharmacyModel.exists({ phone: set.phone, _id: { $ne: id } }).session(session)) {
          throw phoneTaken();
        }
        if (typeof set.email === 'string' && set.email !== pharmacy.email &&
            await PharmacyModel.exists({ email: set.email, _id: { $ne: id } }).session(session)) {
          throw emailTaken();
        }
        if (!Object.keys(set).length && !Object.keys(unset).length) return pharmacy;
        const updated = await PharmacyModel.findOneAndUpdate({ _id: id, updatedAt: pharmacy.updatedAt },
          { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
          { new: true, session, runValidators: true }).lean() as IPharmacy | null;
        if (!updated) throw recordChanged();
        const phoneChanged = updated.phone !== pharmacy.phone;
        // Q15 review: the same address in other letter case is no change of the sign-in email.
        const emailChanged = !!pharmacy.email && String(updated.email ?? '').toLowerCase() !== String(pharmacy.email).toLowerCase();
        if (phoneChanged || emailChanged) {
          const { revokeAllSessions } = await import('@/modules/auth/sessions');
          await revokeAllSessions('pharmacy', String(pharmacy._id), phoneChanged ? 'sign_in_phone_changed' : 'sign_in_email_changed', session);
        }
        return updated;
      });
    } catch (e: any) {
      throw duplicateError(e);
    }
  }

  async delete(id: string, archivedBy?: string, archiveReason?: string): Promise<void> {
    const pharmacy = await this.pharmacyRepository.findById(id);
    if (!pharmacy) {
      throw new AppError({
        status: 404,
        code: 'PHARMACY_NOT_FOUND',
        message: 'Pharmacy not found',
      });
    }
    await this.pharmacyRepository.update(
      { _id: id },
      { isActive: false, archivedAt: new Date(), archivedBy, archiveReason }
    );
  }
}
