import { Service } from 'typedi';
import { AppError } from '@/modules/common/types';
import { AdminRepository } from '@/modules/admin/repository';
import { IAdmin, AdminQueryParams, UpdateAdminProfileRequest } from '@/modules/admin/types';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class AdminService {
  constructor(private adminRepository: AdminRepository) {}

  private async findAdminOrThrow(id: string): Promise<IAdmin> {
    const user = await this.adminRepository.findById(id);
    if (!user) {
      throw new AppError({
        status: 404,
        code: 'ADMIN_NOT_FOUND',
        message: 'Admin not found',
      });
    }
    return user;
  }

  async getProfile(adminId: string): Promise<IAdmin> {
    return this.findAdminOrThrow(adminId);
  }

  async updateProfile(adminId: string, data: UpdateAdminProfileRequest): Promise<IAdmin> {
    await this.findAdminOrThrow(adminId);

    const updateData: any = {
      ...data,
      userType: 'admin',
    };

    const updated = await this.adminRepository.update({ _id: adminId }, updateData);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update admin profile',
      });
    }

    return updated;
  }

  async getById(id: string): Promise<IAdmin> {
    return this.findAdminOrThrow(id);
  }

  async getAll(queryParams: AdminQueryParams = {}): Promise<{
    data: IAdmin[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    const filter: any = {
      userType: 'admin',
    };

    if (queryParams.isActive !== undefined) {
      filter.isActive = queryParams.isActive;
    }

    if (queryParams.search) {
      filter.$or = [
        { name: buildContainsRegex(queryParams.search) },
        { email: buildContainsRegex(queryParams.search) },
        { phone: buildContainsRegex(queryParams.search) },
        { employeeId: buildContainsRegex(queryParams.search) },
      ];
    }

    const sort: any = {};
    if (queryParams.sortBy) {
      sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1;
    }

    if (queryParams.page && queryParams.limit) {
      const skip = (queryParams.page - 1) * queryParams.limit;
      const [data, total] = await Promise.all([
        this.adminRepository.findAll(filter, {
          skip,
          limit: queryParams.limit,
          sort,
        }),
        this.adminRepository.findMany(filter).countDocuments(),
      ]);

      return {
        data,
        total,
        page: queryParams.page,
        totalPages: Math.ceil(total / queryParams.limit),
      };
    }

    const data = await this.adminRepository.findAll(filter, { sort });
    return { data };
  }
}
