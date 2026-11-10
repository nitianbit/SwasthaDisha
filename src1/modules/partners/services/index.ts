import { Service } from 'typedi';
import { PartnerRepository } from '@/modules/partners/repository';
import {
  IPartner,
  CreatePartnerRequest,
  UpdatePartnerRequest,
  PartnerQueryParams,
} from '@/modules/partners/types';
import { AppError } from '@/modules/common/types';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class PartnerService {
  constructor(private partnerRepository: PartnerRepository) {}

  async create(data: CreatePartnerRequest): Promise<IPartner> {
    // Validate email uniqueness if provided
    if (data.email) {
      const existing = await this.partnerRepository.findOne({
        email: data.email,
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'A partner with this email already exists',
        });
      }
    }

    // Validate phone uniqueness if provided
    if (data.phone) {
      const existing = await this.partnerRepository.findOne({
        phone: data.phone,
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'PHONE_ALREADY_EXISTS',
          message: 'A partner with this phone already exists',
        });
      }
    }

    // If order is not provided, set it to the max order + 1
    if (data.order === undefined) {
      const maxOrderPartner = await this.partnerRepository.findAll(
        {},
        { sort: { order: -1 }, limit: 1 }
      );
      data.order =
        maxOrderPartner.length > 0
          ? (maxOrderPartner[0].order || 0) + 1
          : 1;
    }

    return this.partnerRepository.save(data);
  }

  async getById(id: string): Promise<IPartner> {
    const partner = await this.partnerRepository.findById(id);

    if (!partner) {
      throw new AppError({
        status: 404,
        code: 'PARTNER_NOT_FOUND',
        message: 'Partner not found',
      });
    }

    return partner;
  }

  async getAll(
    queryParams: PartnerQueryParams = {}
  ): Promise<{
    data: IPartner[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    // If pagination params are provided, use pagination
    if (queryParams.page && queryParams.limit) {
      return this.partnerRepository.findWithPagination(
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

    if (queryParams.email) {
      filter.email = buildContainsRegex(queryParams.email);
    }

    if (queryParams.partnerType) {
      filter.partnerType = buildContainsRegex(queryParams.partnerType);
    }

    if (queryParams.isActive !== undefined) {
      filter.isActive = queryParams.isActive;
    }

    if (queryParams.isVerified !== undefined) {
      filter.isVerified = queryParams.isVerified;
    }

    if (queryParams.city) {
      filter.city = buildContainsRegex(queryParams.city);
    }

    if (queryParams.state) {
      filter.state = buildContainsRegex(queryParams.state);
    }

    const sort: any = {};
    if (queryParams.sortBy) {
      sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.order = 1;
    }

    let data: IPartner[];

    if (queryParams.search) {
      data = await this.partnerRepository.searchPartners(queryParams.search);
    } else {
      data = await this.partnerRepository.findAll(filter, { sort });
    }

    return { data };
  }

  async update(
    id: string,
    data: UpdatePartnerRequest
  ): Promise<IPartner> {
    const partner = await this.partnerRepository.findById(id);

    if (!partner) {
      throw new AppError({
        status: 404,
        code: 'PARTNER_NOT_FOUND',
        message: 'Partner not found',
      });
    }

    // Validate email uniqueness if being updated
    if (data.email && data.email !== partner.email) {
      const existing = await this.partnerRepository.findOne({
        email: data.email,
        _id: { $ne: id },
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'A partner with this email already exists',
        });
      }
    }

    // Validate phone uniqueness if being updated
    if (data.phone && data.phone !== partner.phone) {
      const existing = await this.partnerRepository.findOne({
        phone: data.phone,
        _id: { $ne: id },
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'PHONE_ALREADY_EXISTS',
          message: 'A partner with this phone already exists',
        });
      }
    }

    const updated = await this.partnerRepository.update({ _id: id }, data);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update partner',
      });
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    const partner = await this.partnerRepository.findById(id);

    if (!partner) {
      throw new AppError({
        status: 404,
        code: 'PARTNER_NOT_FOUND',
        message: 'Partner not found',
      });
    }

    await this.partnerRepository.delete({ _id: id });
  }

  async getByPartnerType(partnerType: string): Promise<IPartner[]> {
    return this.partnerRepository.findByPartnerType(partnerType);
  }

  async getVerifiedPartners(): Promise<IPartner[]> {
    return this.partnerRepository.findVerifiedPartners();
  }

  async getByCity(city: string): Promise<IPartner[]> {
    return this.partnerRepository.findByCity(city);
  }

  async getByState(state: string): Promise<IPartner[]> {
    return this.partnerRepository.findByState(state);
  }
}
