import { Service } from 'typedi';
import { CorporateRepository } from '@/modules/corporates/repository';
import { BannerRepository } from '@/modules/banners/repository';
import { SpecialistRepository } from '@/modules/specialists/repository';
import {
  ICorporate,
  CreateCorporateRequest,
  UpdateCorporateRequest,
  CorporateQueryParams,
} from '@/modules/corporates/types';
import { IBanner } from '@/modules/banners/types';
import { ISpecialist } from '@/modules/specialists/types';
import { IWellnessPackage } from '@/modules/wellnessPackages/types';
import { AppError } from '@/modules/common/types';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class CorporateService {
  constructor(
    private corporateRepository: CorporateRepository,
    private bannerRepository: BannerRepository,
    private specialistRepository: SpecialistRepository
  ) {}

  private async getUnassignedSpecialistIds(): Promise<string[]> {
    const corporates = await this.corporateRepository.findAll({}, {});
    const assignedIds = new Set<string>();

    for (const corporate of corporates) {
      (corporate.specialistIds || []).forEach((id) => {
        if (id) {
          assignedIds.add(String(id));
        }
      });
    }

    const filter: Record<string, unknown> = assignedIds.size
      ? { _id: { $nin: Array.from(assignedIds) } }
      : {};
    const specialists = await this.specialistRepository.findAll(filter, {
      sort: { rating: -1, experienceYears: -1 },
    });

    return specialists
      .map((specialist) => specialist._id?.toString())
      .filter((id): id is string => Boolean(id));
  }

  private mergeIds(existing: string[] | undefined, next: string[]): string[] {
    return Array.from(
      new Set([...(existing || []), ...next].filter((id) => id?.trim()))
    );
  }

  private async cloneCommonBannersForCorporate(corporateId: string): Promise<void> {
    const commonBanners = await this.bannerRepository.findAll(
      { corporateId: { $exists: false } },
      { sort: { order: 1, createdAt: -1 } }
    );

    await Promise.all(
      commonBanners.map((banner) =>
        this.bannerRepository.save({
          ...this.toCorporateBannerPayload(banner),
          corporateId,
        })
      )
    );
  }

  private toCorporateBannerPayload(
    banner: IBanner
  ): Omit<IBanner, '_id' | 'createdAt' | 'updatedAt' | 'corporateId'> {
    return {
      title: banner.title,
      description: banner.description,
      imageUrl: banner.imageUrl,
      linkUrl: banner.linkUrl,
      bannerType: banner.bannerType,
      startDate: banner.startDate,
      endDate: banner.endDate,
      target: banner.target,
      targetId: banner.targetId,
      isActive: banner.isActive,
      order: banner.order,
    };
  }

  async create(data: CreateCorporateRequest): Promise<ICorporate> {
    // Validate email uniqueness if provided
    if (data.email) {
      const existing = await this.corporateRepository.findOne({
        email: data.email,
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'A corporate with this email already exists',
        });
      }
    }

    // Validate phone uniqueness if provided
    if (data.phone) {
      const existing = await this.corporateRepository.findOne({
        phone: data.phone,
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'PHONE_ALREADY_EXISTS',
          message: 'A corporate with this phone already exists',
        });
      }
    }

    // Validate domain uniqueness if provided
    if (data.domain) {
      const existing = await this.corporateRepository.findOne({
        domain: data.domain.toLowerCase(),
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'DOMAIN_ALREADY_EXISTS',
          message: 'A corporate with this domain already exists',
        });
      }
    }

    // Normalize domain to lowercase before saving
    if (data.domain) {
      data.domain = data.domain.toLowerCase();
    }

    const unassignedSpecialistIds = await this.getUnassignedSpecialistIds();
    data.specialistIds = this.mergeIds(data.specialistIds, unassignedSpecialistIds);

    const corporate = await this.corporateRepository.save(data);

    if (corporate._id) {
      await this.cloneCommonBannersForCorporate(corporate._id.toString());
    }

    return corporate;
  }

  async getById(id: string): Promise<ICorporate> {
    const corporate = await this.corporateRepository.findById(id);

    if (!corporate) {
      throw new AppError({
        status: 404,
        code: 'CORPORATE_NOT_FOUND',
        message: 'Corporate not found',
      });
    }

    return corporate;
  }

  async getAll(
    queryParams: CorporateQueryParams = {},
    requester?: { userType: string; corporateId?: string }
  ): Promise<{
    data: ICorporate[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    if (requester && requester.userType !== 'admin') {
      if (!requester.corporateId) {
        return queryParams.page && queryParams.limit
          ? { data: [], total: 0, page: queryParams.page, totalPages: 0 }
          : { data: [] };
      }

      const corporate = await this.corporateRepository.findById(requester.corporateId);
      if (!corporate) {
        return queryParams.page && queryParams.limit
          ? { data: [], total: 0, page: queryParams.page, totalPages: 0 }
          : { data: [] };
      }

      return queryParams.page && queryParams.limit
        ? { data: [corporate], total: 1, page: queryParams.page, totalPages: 1 }
        : { data: [corporate] };
    }

    // If pagination params are provided, use pagination
    if (queryParams.page && queryParams.limit) {
      return this.corporateRepository.findWithPagination(
        queryParams,
        queryParams.page,
        queryParams.limit
      );
    }

    // Otherwise return all matching records
    const filter: any = {};

    if (queryParams.name) {
      filter.name = buildContainsRegex(queryParams.name);
    }

    if (queryParams.companyName) {
      filter.companyName = buildContainsRegex(queryParams.companyName);
    }

    if (queryParams.email) {
      filter.email = buildContainsRegex(queryParams.email);
    }

    if (queryParams.contactPerson) {
      filter.contactPerson = buildContainsRegex(queryParams.contactPerson);
    }

    if (queryParams.industry) {
      filter.industry = buildContainsRegex(queryParams.industry);
    }

    if (queryParams.city) {
      filter.city = buildContainsRegex(queryParams.city);
    }

    if (queryParams.state) {
      filter.state = buildContainsRegex(queryParams.state);
    }

    if (queryParams.country) {
      filter.country = buildContainsRegex(queryParams.country);
    }

    if (queryParams.isActive !== undefined) {
      filter.isActive = queryParams.isActive;
    }

    if (queryParams.isVerified !== undefined) {
      filter.isVerified = queryParams.isVerified;
    }

    const sort: any = {};
    if (queryParams.sortBy) {
      sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.name = 1;
    }

    let data: ICorporate[];

    if (queryParams.search) {
      data = await this.corporateRepository.searchCorporates(
        queryParams.search
      );
    } else {
      data = await this.corporateRepository.findAll(filter, { sort });
    }

    return { data };
  }

  async update(
    id: string,
    data: UpdateCorporateRequest
  ): Promise<ICorporate> {
    const corporate = await this.corporateRepository.findById(id);

    if (!corporate) {
      throw new AppError({
        status: 404,
        code: 'CORPORATE_NOT_FOUND',
        message: 'Corporate not found',
      });
    }

    // Validate email uniqueness if being updated
    if (data.email && data.email !== corporate.email) {
      const existing = await this.corporateRepository.findOne({
        email: data.email,
        _id: { $ne: id },
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'A corporate with this email already exists',
        });
      }
    }

    // Validate phone uniqueness if being updated
    if (data.phone && data.phone !== corporate.phone) {
      const existing = await this.corporateRepository.findOne({
        phone: data.phone,
        _id: { $ne: id },
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'PHONE_ALREADY_EXISTS',
          message: 'A corporate with this phone already exists',
        });
      }
    }

    // Validate domain uniqueness if being updated
    if (data.domain && data.domain.toLowerCase() !== corporate.domain?.toLowerCase()) {
      const existing = await this.corporateRepository.findOne({
        domain: data.domain.toLowerCase(),
        _id: { $ne: id },
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'DOMAIN_ALREADY_EXISTS',
          message: 'A corporate with this domain already exists',
        });
      }
    }

    // Normalize domain to lowercase before saving
    if (data.domain) {
      data.domain = data.domain.toLowerCase();
    }

    const updated = await this.corporateRepository.update({ _id: id }, data);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update corporate',
      });
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    const corporate = await this.corporateRepository.findById(id);

    if (!corporate) {
      throw new AppError({
        status: 404,
        code: 'CORPORATE_NOT_FOUND',
        message: 'Corporate not found',
      });
    }

    await this.corporateRepository.delete({ _id: id });
  }

  async getByIndustry(industry: string): Promise<ICorporate[]> {
    return this.corporateRepository.findByIndustry(industry);
  }

  async getVerifiedCorporates(): Promise<ICorporate[]> {
    return this.corporateRepository.findVerifiedCorporates();
  }

  async getByCity(city: string): Promise<ICorporate[]> {
    return this.corporateRepository.findByCity(city);
  }

  async getByState(state: string): Promise<ICorporate[]> {
    return this.corporateRepository.findByState(state);
  }

  async getByCountry(country: string): Promise<ICorporate[]> {
    return this.corporateRepository.findByCountry(country);
  }

  async addSpecialist(corporateId: string, specialistId: string): Promise<ICorporate> {
    const corporate = await this.corporateRepository.findById(corporateId);

    if (!corporate) {
      throw new AppError({
        status: 404,
        code: 'CORPORATE_NOT_FOUND',
        message: 'Corporate not found',
      });
    }

    const updated = await this.corporateRepository.addSpecialistId(corporateId, specialistId);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to add specialist to corporate',
      });
    }

    return updated;
  }

  async removeSpecialist(corporateId: string, specialistId: string): Promise<ICorporate> {
    const corporate = await this.corporateRepository.findById(corporateId);

    if (!corporate) {
      throw new AppError({
        status: 404,
        code: 'CORPORATE_NOT_FOUND',
        message: 'Corporate not found',
      });
    }

    const updated = await this.corporateRepository.removeSpecialistId(corporateId, specialistId);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to remove specialist from corporate',
      });
    }

    return updated;
  }

  async getSpecialists(corporateId: string): Promise<ISpecialist[]> {
    const corporate = await this.corporateRepository.findById(corporateId);

    if (!corporate) {
      throw new AppError({
        status: 404,
        code: 'CORPORATE_NOT_FOUND',
        message: 'Corporate not found',
      });
    }

    return this.corporateRepository.findSpecialists(corporate.specialistIds || []);
  }

  async addWellnessPackage(corporateId: string, packageId: string): Promise<ICorporate> {
    const corporate = await this.corporateRepository.findById(corporateId);

    if (!corporate) {
      throw new AppError({
        status: 404,
        code: 'CORPORATE_NOT_FOUND',
        message: 'Corporate not found',
      });
    }

    const updated = await this.corporateRepository.addWellnessPackageId(corporateId, packageId);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to add wellness package to corporate',
      });
    }

    return updated;
  }

  async removeWellnessPackage(corporateId: string, packageId: string): Promise<ICorporate> {
    const corporate = await this.corporateRepository.findById(corporateId);

    if (!corporate) {
      throw new AppError({
        status: 404,
        code: 'CORPORATE_NOT_FOUND',
        message: 'Corporate not found',
      });
    }

    const updated = await this.corporateRepository.removeWellnessPackageId(corporateId, packageId);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to remove wellness package from corporate',
      });
    }

    return updated;
  }

  async getWellnessPackages(corporateId: string): Promise<IWellnessPackage[]> {
    const corporate = await this.corporateRepository.findById(corporateId);

    if (!corporate) {
      throw new AppError({
        status: 404,
        code: 'CORPORATE_NOT_FOUND',
        message: 'Corporate not found',
      });
    }

    return this.corporateRepository.findWellnessPackages(corporate.wellnessPackageIds || []);
  }
}
