import { Service } from 'typedi';
import { Model } from 'mongoose';
import { HRModel } from '@/modules/hr/model';
import { IHR, HRQueryParams } from '@/modules/hr/types';
import { BaseRepository } from '@/modules/common/repository';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class HRRepository extends BaseRepository<IHR> {
  constructor() {
    super(HRModel as Model<IHR>);
  }

  async findByEmployeeId(employeeId: string): Promise<IHR | null> {
    return this.findOne({ employeeId: employeeId.toUpperCase() });
  }

  async findByUserId(userId: string): Promise<IHR | null> {
    return this.findOne({ userId });
  }

  async findByPhoneOrEmail(phoneOrEmail: {
    phone?: string;
    email?: string;
  }): Promise<IHR | null> {
    const query: Record<string, string> = {};

    if (phoneOrEmail.phone?.trim()) {
      query.phone = phoneOrEmail.phone.trim();
    } else if (phoneOrEmail.email?.trim()) {
      query.email = phoneOrEmail.email.trim().toLowerCase();
    } else {
      return null;
    }

    return this.findOne(query);
  }

  async findByDepartment(department: string): Promise<IHR[]> {
    return this.findAll(
      { department, isActive: true },
      { sort: { firstName: 1, lastName: 1 } }
    );
  }

  async findByEmploymentStatus(status: string): Promise<IHR[]> {
    return this.findAll(
      { employmentStatus: status, isActive: true },
      { sort: { firstName: 1, lastName: 1 } }
    );
  }

  async findByCorporateId(corporateId: string): Promise<IHR[]> {
    return this.findAll(
      { corporateId, isActive: true },
      { sort: { firstName: 1, lastName: 1 } }
    );
  }

  async findByReportingManager(reportingManager: string): Promise<IHR[]> {
    return this.findAll(
      { reportingManager, isActive: true },
      { sort: { firstName: 1, lastName: 1 } }
    );
  }

  async searchEmployees(searchTerm: string): Promise<IHR[]> {
    return HRModel.find({
      $text: { $search: searchTerm },
      isActive: true,
    })
      .sort({ score: { $meta: 'textScore' } })
      .lean();
  }

  async findWithPagination(
    filter: HRQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: IHR[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query: any = {};

    if (filter.employeeId) {
      query.employeeId = buildContainsRegex(filter.employeeId.toUpperCase());
    }

    if (filter.firstName) {
      query.firstName = buildContainsRegex(filter.firstName);
    }

    if (filter.lastName) {
      query.lastName = buildContainsRegex(filter.lastName);
    }

    if (filter.email) {
      query.email = buildContainsRegex(filter.email);
    }

    if (filter.userId) {
      query.userId = filter.userId;
    }

    if (filter.department) {
      query.department = buildContainsRegex(filter.department);
    }

    if (filter.designation) {
      query.designation = buildContainsRegex(filter.designation);
    }

    if (filter.employmentType) {
      query.employmentType = filter.employmentType;
    }

    if (filter.employmentStatus) {
      query.employmentStatus = filter.employmentStatus;
    }

    if (filter.corporateId) {
      query.corporateId = filter.corporateId;
    }

    if (filter.reportingManager) {
      query.reportingManager = buildContainsRegex(filter.reportingManager.toUpperCase());
    }

    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    }

    if (filter.joiningDateFrom || filter.joiningDateTo) {
      query.joiningDate = {};
      if (filter.joiningDateFrom) {
        query.joiningDate.$gte = filter.joiningDateFrom;
      }
      if (filter.joiningDateTo) {
        query.joiningDate.$lte = filter.joiningDateTo;
      }
    }

    if (filter.search) {
      query.$text = { $search: filter.search };
    }

    const skip = (page - 1) * limit;
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.firstName = 1;
      sort.lastName = 1;
    }

    // If text search, add text score to sort
    if (filter.search) {
      sort.score = { $meta: 'textScore' };
    }

    const [data, total] = await Promise.all([
      HRModel.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      HRModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}
