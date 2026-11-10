import { Service } from 'typedi';
import { WellnessPackageRepository } from '@/modules/wellnessPackages/repository';
import {
  IWellnessPackage,
  CreateWellnessPackageRequest,
  UpdateWellnessPackageRequest,
  WellnessPackageQueryParams,
} from '@/modules/wellnessPackages/types';
import { CorporateRepository } from '@/modules/corporates/repository';
import { AppError } from '@/modules/common/types';

@Service()
export class WellnessPackageService {
  constructor(
    private wellnessPackageRepository: WellnessPackageRepository,
    private corporateRepository: CorporateRepository
  ) {}

  private async getWithFilterAndPagination(
    baseFilter: any,
    queryParams: WellnessPackageQueryParams
  ): Promise<{
    data: IWellnessPackage[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    const filter = {
      ...baseFilter,
      ...this.wellnessPackageRepository.buildFilterFromParams(queryParams),
    };
    const sort = this.wellnessPackageRepository.buildSortFromParams(queryParams);

    if (queryParams.page && queryParams.limit) {
      const skip = (queryParams.page - 1) * queryParams.limit;
      const query = this.wellnessPackageRepository.findMany(filter);
      if (queryParams.search) {
        query.select({ score: { $meta: 'textScore' } } as any);
      }

      const [data, total] = await Promise.all([
        query.sort(sort).skip(skip).limit(queryParams.limit).lean(),
        this.wellnessPackageRepository.findMany(filter).countDocuments(),
      ]);

      return {
        data,
        total,
        page: queryParams.page,
        totalPages: Math.ceil(total / queryParams.limit),
      };
    }

    const query = this.wellnessPackageRepository.findMany(filter);
    if (queryParams.search) {
      query.select({ score: { $meta: 'textScore' } } as any);
    }
    const data = await query.sort(sort).lean();
    return { data };
  }

  async create(
    data: CreateWellnessPackageRequest,
    corporateId?: string
  ): Promise<IWellnessPackage> {
    
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

    // Validate that discountedPrice is less than or equal to originalPrice
    if (data.discountedPrice > data.originalPrice) {
      throw new AppError({
        status: 400,
        code: 'INVALID_PRICE',
        message: 'Discounted price cannot be greater than original price',
      });
    }

    // Calculate totalTestsCount from testsIncluded if not provided
    if (!data.totalTestsCount && data.testsIncluded) {
      data.totalTestsCount = data.testsIncluded.reduce(
        (sum, category) => sum + category.categoryTestsCount,
        0
      );
    }

    // If order is not provided, set it to the max order + 1
    if (data.order === undefined) {
      const maxOrderPackage = await this.wellnessPackageRepository.findAll(
        {},
        { sort: { order: -1 }, limit: 1 }
      );
      data.order =
        maxOrderPackage.length > 0
          ? (maxOrderPackage[0].order || 0) + 1
          : 1;
    }

    const wellnessPackage = await this.wellnessPackageRepository.save(data);

    if (corporateId && wellnessPackage._id) {
      await this.corporateRepository.addWellnessPackageId(
        corporateId,
        wellnessPackage._id
      );
    }

    return wellnessPackage;
  }

  async getById(id: string): Promise<IWellnessPackage> {
    const package_ = await this.wellnessPackageRepository.findById(id);

    if (!package_) {
      throw new AppError({
        status: 404,
        code: 'WELLNESS_PACKAGE_NOT_FOUND',
        message: 'Wellness package not found',
      });
    }

    return package_;
  }

  async getAll(
    queryParams: WellnessPackageQueryParams = {},
    requester?: { userType: string; corporateId?: string }
  ): Promise<{
    data: IWellnessPackage[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    // For admin with forUser=true: return only packages not assigned to any corporate
    if (requester && requester.userType === 'admin' && queryParams.forUser) {
      const corporates = await this.corporateRepository.findAll({}, {});
      const assignedIdsSet = new Set<string>();
      for (const corporate of corporates) {
        (corporate.wellnessPackageIds || []).forEach((id) => {
          if (id) {
            assignedIdsSet.add(String(id));
          }
        });
      }

      // If nothing is assigned, fall through to normal logic (all packages are "free")
      if (assignedIdsSet.size > 0) {
        const baseFilter: any = {
          _id: { $nin: Array.from(assignedIdsSet) },
        };
        return this.getWithFilterAndPagination(baseFilter, queryParams);
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
      const packageIds = corporate?.wellnessPackageIds || [];

      if (packageIds.length === 0) {
        return queryParams.page && queryParams.limit
          ? { data: [], total: 0, page: queryParams.page, totalPages: 0 }
          : { data: [] };
      }

      const baseFilter: any = {
        _id: { $in: packageIds },
      };

      return this.getWithFilterAndPagination(baseFilter, queryParams);
    }

    // If pagination params are provided, use pagination
    if (queryParams.page && queryParams.limit) {
      return this.wellnessPackageRepository.findWithPagination(
        queryParams,
        queryParams.page,
        queryParams.limit
      );
    }

    // Otherwise return all matching records
    const filter = this.wellnessPackageRepository.buildFilterFromParams(
      queryParams
    );
    const sort = this.wellnessPackageRepository.buildSortFromParams(queryParams);

    let data: IWellnessPackage[];

    if (queryParams.search) {
      data = await this.wellnessPackageRepository.searchPackages(
        queryParams.search
      );
    } else {
      data = await this.wellnessPackageRepository.findAll(filter, { sort });
    }

    return { data };
  }

  async update(
    id: string,
    data: UpdateWellnessPackageRequest
  ): Promise<IWellnessPackage> {
    const package_ = await this.wellnessPackageRepository.findById(id);

    if (!package_) {
      throw new AppError({
        status: 404,
        code: 'WELLNESS_PACKAGE_NOT_FOUND',
        message: 'Wellness package not found',
      });
    }

    // Validate prices if both are being updated
    if (
      data.discountedPrice !== undefined &&
      data.originalPrice !== undefined &&
      data.discountedPrice > data.originalPrice
    ) {
      throw new AppError({
        status: 400,
        code: 'INVALID_PRICE',
        message: 'Discounted price cannot be greater than original price',
      });
    }

    // Validate prices if only one is being updated
    if (data.discountedPrice !== undefined && !data.originalPrice) {
      if (data.discountedPrice > (package_.originalPrice || 0)) {
        throw new AppError({
          status: 400,
          code: 'INVALID_PRICE',
          message: 'Discounted price cannot be greater than original price',
        });
      }
    }

    if (data.originalPrice !== undefined && !data.discountedPrice) {
      if ((package_.discountedPrice || 0) > data.originalPrice) {
        throw new AppError({
          status: 400,
          code: 'INVALID_PRICE',
          message: 'Discounted price cannot be greater than original price',
        });
      }
    }

    // Recalculate totalTestsCount if testsIncluded is updated
    if (data.testsIncluded && !data.totalTestsCount) {
      data.totalTestsCount = data.testsIncluded.reduce(
        (sum, category) => sum + category.categoryTestsCount,
        0
      );
    }

    const updated = await this.wellnessPackageRepository.update(
      { _id: id },
      data
    );

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update wellness package',
      });
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    const package_ = await this.wellnessPackageRepository.findById(id);

    if (!package_) {
      throw new AppError({
        status: 404,
        code: 'WELLNESS_PACKAGE_NOT_FOUND',
        message: 'Wellness package not found',
      });
    }

    await this.wellnessPackageRepository.delete({ _id: id });
  }

}
