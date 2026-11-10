import { Service } from 'typedi';
import { Model } from 'mongoose';
import SpecialistModel from '@/modules/specialists/model';
import {
  ISpecialist,
  SpecialistQueryParams,
} from '@/modules/specialists/types';
import { BaseRepository } from '@/modules/common/repository';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class SpecialistRepository extends BaseRepository<ISpecialist> {
  constructor() {
    super(SpecialistModel as Model<ISpecialist>);
  }

  buildFilterFromParams(filter: SpecialistQueryParams = {}): any {
    const query: any = {};

    if (filter.name) {
      query.name = buildContainsRegex(filter.name);
    }

    if (filter.email) {
      query.email = buildContainsRegex(filter.email);
    }

    if (filter.specialization) {
      query.specialization = buildContainsRegex(filter.specialization);
    }

    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    }

    if (filter.isVerified !== undefined) {
      query.isVerified = filter.isVerified;
    }

    if (filter.minRating !== undefined || filter.maxRating !== undefined) {
      query.rating = {};
      if (filter.minRating !== undefined) {
        query.rating.$gte = filter.minRating;
      }
      if (filter.maxRating !== undefined) {
        query.rating.$lte = filter.maxRating;
      }
    }

    if (filter.minExperience !== undefined || filter.maxExperience !== undefined) {
      query.experienceYears = {};
      if (filter.minExperience !== undefined) {
        query.experienceYears.$gte = filter.minExperience;
      }
      if (filter.maxExperience !== undefined) {
        query.experienceYears.$lte = filter.maxExperience;
      }
    }

    if (filter.language) {
      query.languages = { $in: [filter.language] };
    }

    if (filter.city) {
      query.city = buildContainsRegex(filter.city);
    }

    if (filter.state) {
      query.state = buildContainsRegex(filter.state);
    }

    if (filter.search) {
      query.$text = { $search: filter.search };
    }

    return query;
  }

  buildSortFromParams(filter: SpecialistQueryParams = {}): any {
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.rating = -1;
      sort.experienceYears = -1;
    }

    // If text search, add text score to sort
    if (filter.search) {
      sort.score = { $meta: 'textScore' };
    }

    return sort;
  }

  async findByIdWithModel(id: string) {
    return SpecialistModel.findById(id);
  }

  async findByPhoneOrEmail(phoneOrEmail: {
    phone?: string;
    email?: string;
  }): Promise<ISpecialist | null> {
    const query: any = {};
    if (phoneOrEmail.phone?.trim()) {
      query.phone = phoneOrEmail.phone.trim();
    } else if (phoneOrEmail.email?.trim()) {
      query.email = phoneOrEmail.email.trim().toLowerCase();
    } else {
      return null;
    }
    return this.findOne(query);
  }

  async findBySpecialization(specialization: string): Promise<ISpecialist[]> {
    return this.findAll(
      { specialization, isActive: true },
      { sort: { rating: -1, experienceYears: -1 } }
    );
  }

  async findVerifiedSpecialists(): Promise<ISpecialist[]> {
    return this.findAll(
      { isVerified: true, isActive: true },
      { sort: { rating: -1, experienceYears: -1 } }
    );
  }

  async findByCity(city: string): Promise<ISpecialist[]> {
    return this.findAll(
      { city, isActive: true },
      { sort: { rating: -1 } }
    );
  }

  async findByState(state: string): Promise<ISpecialist[]> {
    return this.findAll(
      { state, isActive: true },
      { sort: { rating: -1 } }
    );
  }

  async searchSpecialists(
    searchTerm: string,
    extraFilter: Record<string, any> = {}
  ): Promise<ISpecialist[]> {
    return SpecialistModel.find({
      $text: { $search: searchTerm },
      ...extraFilter,
    })
      .sort({ score: { $meta: 'textScore' } })
      .lean();
  }

  async findWithPagination(
    filter: SpecialistQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: ISpecialist[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query = this.buildFilterFromParams(filter);
    const skip = (page - 1) * limit;
    const sort = this.buildSortFromParams(filter);

    const [data, total] = await Promise.all([
      SpecialistModel.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      SpecialistModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}
