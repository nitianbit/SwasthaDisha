import { Service } from 'typedi';
import { SpecialistRepository } from '@/modules/specialists/repository';
import {
  ISpecialist,
  CreateSpecialistRequest,
  UpdateSpecialistRequest,
  SpecialistQueryParams,
  ISpecialistConsultationStats,
  ISpecialistConsultationStatsQuery,
} from '@/modules/specialists/types';
import { CorporateRepository } from '@/modules/corporates/repository';
import { AppError } from '@/modules/common/types';
import { BookingRepository } from '@/modules/bookings/repository';

@Service()
export class SpecialistService {
  constructor(
    private specialistRepository: SpecialistRepository,
    private corporateRepository: CorporateRepository,
    private bookingRepository: BookingRepository
  ) {}

  private applyUserFacingVisibility(
    filter: SpecialistQueryParams = {}
  ): SpecialistQueryParams {
    return {
      ...filter,
      isActive: true,
      isVerified: true,
    };
  }

  async create(
    data: CreateSpecialistRequest,
    corporateId?: string
  ): Promise<ISpecialist> {
    
    if (corporateId) {
      const corporate = await this.corporateRepository.findById(corporateId);
      if (!corporate) {
        throw new AppError({
          status: 404,
          code: 'CORPORATE_NOT_FOUND',
          message: 'Corporate not found',
        });
      }
    }

    // Validate email uniqueness if provided
    if (data.email) {
      const existing = await this.specialistRepository.findOne({
        email: data.email,
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'A specialist with this email already exists',
        });
      }
    }

    // Validate phone uniqueness if provided
    if (data.phone) {
      const existing = await this.specialistRepository.findOne({
        phone: data.phone,
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'PHONE_ALREADY_EXISTS',
          message: 'A specialist with this phone already exists',
        });
      }
    }

    // If consultation is free, set fee to 0
    if (data.isConsultationFree) {
      data.consultationFee = 0;
    }

    const specialist = await this.specialistRepository.save(data);

    if (corporateId && specialist._id) {
      await this.corporateRepository.addSpecialistId(corporateId, specialist._id);
    }

    return specialist;
  }

  async getById(id: string): Promise<ISpecialist> {
    const specialist = await this.specialistRepository.findById(id);

    if (!specialist) {
      throw new AppError({
        status: 404,
        code: 'SPECIALIST_NOT_FOUND',
        message: 'Specialist not found',
      });
    }

    return specialist;
  }

  async getConsultationStats(
    specialistId: string,
    query: ISpecialistConsultationStatsQuery = {}
  ): Promise<ISpecialistConsultationStats> {
    await this.getById(specialistId);
    return this.bookingRepository.getConsultationStatsBySpecialistId(
      specialistId,
      query
    );
  }

  async getAll(
    queryParams: SpecialistQueryParams = {},
    requester?: { userType: string; corporateId?: string }
  ): Promise<{
    data: ISpecialist[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    const isAdminRequester = requester?.userType === 'admin';
    const effectiveQueryParams = isAdminRequester
      ? queryParams
      : this.applyUserFacingVisibility(queryParams);

    // For admin with forUser=true: return only specialists not assigned to any corporate
    if (isAdminRequester && effectiveQueryParams.forUser) {
      const corporates = await this.corporateRepository.findAll({}, {});
      const assignedIdsSet = new Set<string>();
      for (const corporate of corporates) {
        (corporate.specialistIds || []).forEach((id) => {
          if (id) {
            assignedIdsSet.add(String(id));
          }
        });
      }

      // If nothing is assigned, fall through to normal logic (all specialists are "free")
      if (assignedIdsSet.size > 0) {
        const freeFilter = this.specialistRepository.buildFilterFromParams(
          effectiveQueryParams
        );
        freeFilter._id = { $nin: Array.from(assignedIdsSet) };

        const sort =
          this.specialistRepository.buildSortFromParams(effectiveQueryParams);

        if (effectiveQueryParams.page && effectiveQueryParams.limit) {
          const skip =
            (effectiveQueryParams.page - 1) * effectiveQueryParams.limit;
          const query = this.specialistRepository.findMany(freeFilter);
          if (effectiveQueryParams.search) {
            query.select({ score: { $meta: 'textScore' } } as any);
          }
          const [data, total] = await Promise.all([
            query
              .sort(sort)
              .skip(skip)
              .limit(effectiveQueryParams.limit)
              .lean(),
            this.specialistRepository.findMany(freeFilter).countDocuments(),
          ]);

          return {
            data,
            total,
            page: effectiveQueryParams.page,
            totalPages: Math.ceil(total / effectiveQueryParams.limit),
          };
        }

        const query = this.specialistRepository.findMany(freeFilter);
        if (effectiveQueryParams.search) {
          query.select({ score: { $meta: 'textScore' } } as any);
        }
        const data = await query.sort(sort).lean();
        return { data };
      }
    }

    if (
      requester &&
      requester.userType !== 'admin' &&
      requester.corporateId
    ) {
      const corporate = await this.corporateRepository.findById(
        requester.corporateId
      );
      const specialistIds = corporate?.specialistIds || [];

      if (specialistIds.length === 0) {
        return queryParams.page && queryParams.limit
          ? { data: [], total: 0, page: queryParams.page, totalPages: 0 }
          : { data: [] };
      }

      const corporateFilter = this.specialistRepository.buildFilterFromParams(
        effectiveQueryParams
      );
      corporateFilter._id = { $in: specialistIds };

      const sort =
        this.specialistRepository.buildSortFromParams(effectiveQueryParams);

      if (effectiveQueryParams.page && effectiveQueryParams.limit) {
        const skip =
          (effectiveQueryParams.page - 1) * effectiveQueryParams.limit;
        const query = this.specialistRepository.findMany(corporateFilter);
        if (effectiveQueryParams.search) {
          query.select({ score: { $meta: 'textScore' } } as any);
        }
        const [data, total] = await Promise.all([
          query
            .sort(sort)
            .skip(skip)
            .limit(effectiveQueryParams.limit)
            .lean(),
          this.specialistRepository.findMany(corporateFilter).countDocuments(),
        ]);

        return {
          data,
          total,
          page: effectiveQueryParams.page,
          totalPages: Math.ceil(total / effectiveQueryParams.limit),
        };
      }

      const query = this.specialistRepository.findMany(corporateFilter);
      if (effectiveQueryParams.search) {
        query.select({ score: { $meta: 'textScore' } } as any);
      }
      const data = await query.sort(sort).lean();
      return { data };
    }

    // If pagination params are provided, use pagination
    if (effectiveQueryParams.page && effectiveQueryParams.limit) {
      return this.specialistRepository.findWithPagination(
        effectiveQueryParams,
        effectiveQueryParams.page,
        effectiveQueryParams.limit
      );
    }

    // Otherwise return all matching records
    const filter =
      this.specialistRepository.buildFilterFromParams(effectiveQueryParams);
    const sort =
      this.specialistRepository.buildSortFromParams(effectiveQueryParams);

    let data: ISpecialist[];

    if (effectiveQueryParams.search) {
      const searchFilter =
        this.specialistRepository.buildFilterFromParams(effectiveQueryParams);
      delete searchFilter.$text;
      data = await this.specialistRepository.searchSpecialists(
        effectiveQueryParams.search,
        searchFilter
      );
    } else {
      data = await this.specialistRepository.findAll(filter, { sort });
    }

    return { data };
  }

  async update(
    id: string,
    data: UpdateSpecialistRequest
  ): Promise<ISpecialist> {
    const specialist = await this.specialistRepository.findById(id);

    if (!specialist) {
      throw new AppError({
        status: 404,
        code: 'SPECIALIST_NOT_FOUND',
        message: 'Specialist not found',
      });
    }

    // Validate email uniqueness if being updated
    if (data.email && data.email !== specialist.email) {
      const existing = await this.specialistRepository.findOne({
        email: data.email,
        _id: { $ne: id },
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'A specialist with this email already exists',
        });
      }
    }

    // Validate phone uniqueness if being updated
    if (data.phone && data.phone !== specialist.phone) {
      const existing = await this.specialistRepository.findOne({
        phone: data.phone,
        _id: { $ne: id },
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'PHONE_ALREADY_EXISTS',
          message: 'A specialist with this phone already exists',
        });
      }
    }

    // If consultation is free, set fee to 0
    if (data.isConsultationFree) {
      data.consultationFee = 0;
    }

    const updated = await this.specialistRepository.update({ _id: id }, data);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update specialist',
      });
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    const specialist = await this.specialistRepository.findById(id);

    if (!specialist) {
      throw new AppError({
        status: 404,
        code: 'SPECIALIST_NOT_FOUND',
        message: 'Specialist not found',
      });
    }

    await this.specialistRepository.delete({ _id: id });
  }

  async getBySpecialization(specialization: string): Promise<ISpecialist[]> {
    return this.specialistRepository.findBySpecialization(specialization);
  }

  async getVerifiedSpecialists(): Promise<ISpecialist[]> {
    return this.specialistRepository.findVerifiedSpecialists();
  }

  async getByCity(city: string): Promise<ISpecialist[]> {
    return this.specialistRepository.findByCity(city);
  }

  async getByState(state: string): Promise<ISpecialist[]> {
    return this.specialistRepository.findByState(state);
  }
}
