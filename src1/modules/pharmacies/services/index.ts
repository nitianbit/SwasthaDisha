import { Service } from 'typedi';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { UserRepository } from '@/modules/user/repository';
import {
  IPharmacy,
  CreatePharmacyRequest,
  UpdatePharmacyRequest,
  PharmacyQueryParams,
} from '@/modules/pharmacies/types';
import { AppError } from '@/modules/common/types';

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

  async create(
    data: CreatePharmacyRequest,
    requesterType?: string
  ): Promise<IPharmacy> {
    const sanitizedData = this.sanitizeCreatePayload(data, requesterType);

    const existingByPhone = await this.pharmacyRepository.findByPhone(
      sanitizedData.phone
    );
    if (existingByPhone) {
      throw new AppError({
        status: 400,
        code: 'PHONE_ALREADY_EXISTS',
        message: 'A pharmacy with this phone number already exists',
      });
    }

    if (sanitizedData.email) {
      const existingByEmail = await this.pharmacyRepository.findByEmail(
        sanitizedData.email
      );
      if (existingByEmail) {
        throw new AppError({
          status: 400,
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'A pharmacy with this email already exists',
        });
      }
    }

    return this.pharmacyRepository.save(sanitizedData);
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

  async update(id: string, data: UpdatePharmacyRequest): Promise<IPharmacy> {
    const pharmacy = await this.pharmacyRepository.findById(id);
    if (!pharmacy) {
      throw new AppError({
        status: 404,
        code: 'PHARMACY_NOT_FOUND',
        message: 'Pharmacy not found',
      });
    }

    if (data.phone && data.phone !== pharmacy.phone) {
      const existing = await this.pharmacyRepository.findOne({
        phone: data.phone,
        _id: { $ne: id },
      });
      if (existing) {
        throw new AppError({
          status: 400,
          code: 'PHONE_ALREADY_EXISTS',
          message: 'A pharmacy with this phone number already exists',
        });
      }
    }

    if (data.email && data.email !== pharmacy.email) {
      const existing = await this.pharmacyRepository.findOne({
        email: data.email.toLowerCase(),
        _id: { $ne: id },
      });
      if (existing) {
        throw new AppError({
          status: 400,
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'A pharmacy with this email already exists',
        });
      }
    }

    const updated = await this.pharmacyRepository.update({ _id: id }, data);
    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update pharmacy',
      });
    }
    return updated;
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
