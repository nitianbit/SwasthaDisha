import { Service } from 'typedi';
import { PharmacyCustomerRepository } from '@/modules/pharmacyCustomers/repository';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { UserRepository } from '@/modules/user/repository';
import {
  IPharmacyCustomer,
  CreatePharmacyCustomerRequest,
  UpdatePharmacyCustomerNotesRequest,
  PharmacyCustomerQueryParams,
  PharmacyCustomerConsent,
} from '@/modules/pharmacyCustomers/types';
import { AppError } from '@/modules/common/types';

@Service()
export class PharmacyCustomerService {
  constructor(
    private pharmacyCustomerRepo: PharmacyCustomerRepository,
    private pharmacyRepo: PharmacyRepository,
    private userRepo: UserRepository
  ) {}

  async createCustomer(
    data: CreatePharmacyCustomerRequest,
    createdById: string,
    createdByRole: string
  ): Promise<{ customer: IPharmacyCustomer; userId: string; isNewUser: boolean }> {
    // S3: the partner confirms the patient agreed ("patient agreed" tick). An explicit `false` is refused; a missing
    // answer (the released pharmacy app sends none) is still accepted and recorded as 'not_recorded'.
    // 'patient_agreed' is the pharmacy's own tick: it never unlocks the account name (assisted/names.ts; only the
    // customer's own order, 'customer_order', does).
    if (data.consent === false) {
      throw new AppError({ status: 400, code: 'CONSENT_REQUIRED', message: 'The patient must agree before being linked to your pharmacy' });
    }
    const consent: PharmacyCustomerConsent = data.consent === true ? 'patient_agreed' : 'not_recorded';
    const consentRecord = { consent, consentRecordedAt: new Date(), consentRecordedById: createdById };

    const pharmacy = await this.pharmacyRepo.findById(data.pharmacyId);
    if (!pharmacy) {
      throw new AppError({ status: 404, code: 'PHARMACY_NOT_FOUND', message: 'Pharmacy not found' });
    }

    // Find or create user by phone (no OTP required)
    let user = await this.userRepo.findByPhone(data.phone, 'user');
    let isNewUser = false;

    if (!user) {
      user = await this.userRepo.save({
        phone: data.phone,
        name: data.name,
        age: data.age,
        userType: 'user',
        isVerified: false,
        isActive: true,
        createdSource: 'pharmacy_app',
        createdByRole,
        createdById,
        otpVerified: false,
        linkedPharmacyId: data.pharmacyId,
      });
      isNewUser = true;
    } else {
      if (!user.createdSource || user.createdSource !== 'pharmacy_app') {
        const fill = {
          ...(data.name && !user.name ? { name: data.name } : {}),
          ...(data.age !== undefined && user.age === undefined ? { age: data.age } : {}),
        };
        if (Object.keys(fill).length > 0) await this.userRepo.update({ _id: user._id }, fill);
      }
      // S3: an existing user's linkedPharmacyId is never replaced. It is set only while empty, and only for a user this
      // pharmacy account created.
      if (user.createdSource === 'pharmacy_app' && String(user.createdById ?? '') === String(createdById) && !user.linkedPharmacyId) {
        await this.userRepo.update(
          { _id: user._id, $or: [{ linkedPharmacyId: { $exists: false } }, { linkedPharmacyId: null }, { linkedPharmacyId: '' }] },
          { linkedPharmacyId: data.pharmacyId }
        );
      }
    }

    const userId = String(user._id);

    // Upsert the pharmacy-customer relationship
    const existing = await this.pharmacyCustomerRepo.findByPharmacyAndUser(data.pharmacyId, userId);
    // Assisted booking (§17.4): the name this pharmacy typed is kept on its link (the first one typed).
    const typedName = typeof data.name === 'string' && data.name.trim() ? data.name.trim().replace(/\s+/g, ' ') : undefined;
    if (existing) {
      const typedFill = typedName && !(typeof existing.typedName === 'string' && existing.typedName.trim()) ? { typedName } : {};
      // S3: a link with no consent record, or one now confirmed by the patient, records this call's answer. A link the
      // customer made by ordering (`customer_order`) keeps that record (the pharmacy's tick never replaces it).
      const recordConsent = !existing.consent || (consent === 'patient_agreed' && existing.consent === 'not_recorded');
      if (recordConsent || Object.keys(typedFill).length) {
        const consentFill = recordConsent ? consentRecord : {};
        const updated = await this.pharmacyCustomerRepo.update({ pharmacyId: data.pharmacyId, userId }, { ...consentFill, ...typedFill });
        return { customer: updated || existing, userId, isNewUser: false };
      }
      return { customer: existing, userId, isNewUser: false };
    }

    const customer = await this.pharmacyCustomerRepo.save({
      pharmacyId: data.pharmacyId,
      userId,
      diseaseNotes: data.diseaseNotes,
      chronicCondition: data.chronicCondition ?? false,
      recurringMedicine: data.recurringMedicine ?? false,
      recurringIntervalDays: data.recurringIntervalDays,
      createdByRole,
      createdById,
      ...consentRecord,
      ...(typedName ? { typedName } : {}),
    });

    return { customer, userId, isNewUser };
  }

  /**
   * Assisted booking (§17.4): the pharmacy edits the name it typed for a linked account holder (`id` = the link id or the
   * customer's user id). Audited. Another pharmacy's link, or none, is 404.
   */
  async setTypedName(pharmacyId: string, id: string, typedName: string, actorId: string): Promise<IPharmacyCustomer> {
    const notFound = () => new AppError({ status: 404, code: 'CUSTOMER_NOT_LINKED', message: 'This user is not linked to your pharmacy' });
    if (!/^[0-9a-fA-F]{24}$/.test(String(id)) || !/^[0-9a-fA-F]{24}$/.test(String(pharmacyId))) throw notFound();
    const name = String(typedName ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 200) throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'typedName must have 1 to 200 characters' });
    const { inTransaction } = await import('@/modules/partners/services');
    const { auditIn } = await import('@/modules/assisted/support');
    const PharmacyCustomerModel = (await import('@/modules/pharmacyCustomers/model')).default;
    const { Types } = await import('mongoose');
    return inTransaction(async (s) => {
      const pid = new Types.ObjectId(pharmacyId);
      const link = await PharmacyCustomerModel.findOneAndUpdate({ pharmacyId: pid, $or: [{ _id: new Types.ObjectId(id) }, { userId: new Types.ObjectId(id) }] },
        { $set: { typedName: name } }, { new: true, session: s }).lean() as IPharmacyCustomer | null;
      if (!link) throw notFound();
      await auditIn({ actorKind: 'pharmacy', actorId: String(actorId).toLowerCase(), orgKind: 'pharmacy', orgId: String(pharmacyId).toLowerCase(),
        action: 'customer.typed_name', detail: { linkId: String(link._id), userId: String(link.userId) } }, s);
      return link;
    });
  }

  async getCustomers(
    params: PharmacyCustomerQueryParams
  ): Promise<{ data: IPharmacyCustomer[]; total: number; page: number; totalPages: number }> {
    const pharmacy = await this.pharmacyRepo.findById(params.pharmacyId);
    if (!pharmacy) {
      throw new AppError({ status: 404, code: 'PHARMACY_NOT_FOUND', message: 'Pharmacy not found' });
    }
    return this.pharmacyCustomerRepo.findWithPagination(
      params,
      params.page ?? 1,
      params.limit ?? 20
    );
  }

  async updateNotes(
    pharmacyId: string,
    userId: string,
    data: UpdatePharmacyCustomerNotesRequest
  ): Promise<IPharmacyCustomer> {
    const existing = await this.pharmacyCustomerRepo.findByPharmacyAndUser(pharmacyId, userId);
    if (!existing) {
      throw new AppError({
        status: 404,
        code: 'CUSTOMER_NOT_LINKED',
        message: 'This user is not linked to your pharmacy',
      });
    }

    const updated = await this.pharmacyCustomerRepo.update(
      { pharmacyId, userId },
      data
    );
    if (!updated) {
      throw new AppError({ status: 500, code: 'UPDATE_FAILED', message: 'Failed to update notes' });
    }
    return updated;
  }

  async getLink(pharmacyId: string, userId: string): Promise<IPharmacyCustomer> {
    const existing = await this.pharmacyCustomerRepo.findByPharmacyAndUser(pharmacyId, userId);
    if (!existing) {
      throw new AppError({
        status: 404,
        code: 'CUSTOMER_NOT_LINKED',
        message: 'This user is not linked to your pharmacy',
      });
    }

    return existing;
  }

  async assertLinked(pharmacyId: string, userId: string): Promise<void> {
    const linked = await this.pharmacyCustomerRepo.isLinked(pharmacyId, userId);
    if (!linked) {
      throw new AppError({
        status: 403,
        code: 'NOT_LINKED',
        message: 'No relationship exists between this pharmacy and user',
      });
    }
  }

  /**
   * S3: an order for a customer needs a link. A pharmacy orders only for a customer already linked to it (403
   * CUSTOMER_NOT_LINKED otherwise; a link is made with the patient's consent through POST /pharmacy-customers). A
   * customer's own order links the pharmacy they chose, recorded as consent 'customer_order'. The user's
   * linkedPharmacyId is never touched here.
   */
  async ensureLinked(
    pharmacyId: string,
    userId: string,
    createdById: string,
    createdByRole = 'pharmacy'
  ): Promise<void> {
    const linked = await this.pharmacyCustomerRepo.isLinked(pharmacyId, userId);
    if (!linked && (createdByRole !== 'user' || String(userId) !== String(createdById))) {
      throw new AppError({ status: 403, code: 'CUSTOMER_NOT_LINKED', message: 'This customer is not linked to your pharmacy' });
    }

    const user = await this.userRepo.findById(userId);
    if (!user || user.userType !== 'user') {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    if (!linked) {
      await this.pharmacyCustomerRepo.save({
        pharmacyId,
        userId,
        createdById,
        createdByRole,
        consent: 'customer_order',
        consentRecordedAt: new Date(),
        consentRecordedById: createdById,
      });
    }
  }
}
