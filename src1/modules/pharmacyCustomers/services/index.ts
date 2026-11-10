import { Service } from 'typedi';
import { PharmacyCustomerRepository } from '@/modules/pharmacyCustomers/repository';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { UserRepository } from '@/modules/user/repository';
import {
  IPharmacyCustomer,
  CreatePharmacyCustomerRequest,
  UpdatePharmacyCustomerNotesRequest,
  PharmacyCustomerQueryParams,
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
    } else if (!user.createdSource || user.createdSource !== 'pharmacy_app') {
      await this.userRepo.update(
        { _id: user._id },
        {
          ...(data.name && !user.name ? { name: data.name } : {}),
          ...(data.age !== undefined && user.age === undefined ? { age: data.age } : {}),
          linkedPharmacyId: data.pharmacyId,
        }
      );
    }

    const userId = String(user._id);

    // Upsert the pharmacy-customer relationship
    const existing = await this.pharmacyCustomerRepo.findByPharmacyAndUser(data.pharmacyId, userId);
    if (existing) {
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
      });
    }
  }
}
