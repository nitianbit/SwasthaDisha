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
    if (existing) {
      // S3: a link with no consent record, or one now confirmed by the patient, records this call's answer.
      if (!existing.consent || (consent === 'patient_agreed' && existing.consent !== 'patient_agreed')) {
        const updated = await this.pharmacyCustomerRepo.update({ pharmacyId: data.pharmacyId, userId }, consentRecord);
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
    });

    return { customer, userId, isNewUser };
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

  async ensureLinked(
    pharmacyId: string,
    userId: string,
    createdById: string,
    createdByRole = 'pharmacy'
  ): Promise<void> {
    const user = await this.userRepo.findById(userId);
    if (!user || user.userType !== 'user') {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    const linked = await this.pharmacyCustomerRepo.isLinked(pharmacyId, userId);
    if (!linked) {
      await this.pharmacyCustomerRepo.save({
        pharmacyId,
        userId,
        createdById,
        createdByRole,
        // S3: linked by an order, without the patient's confirmation.
        consent: 'not_recorded',
        consentRecordedAt: new Date(),
        consentRecordedById: createdById,
      });
    }
  }
}
