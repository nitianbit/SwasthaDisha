import { Service } from 'typedi';
import { Model } from 'mongoose';
import CorporateModel from '@/modules/corporates/model';
import SpecialistModel from '@/modules/specialists/model';
import WellnessPackageModel from '@/modules/wellnessPackages/model';
import { ICorporate, CorporateQueryParams } from '@/modules/corporates/types';
import { ISpecialist } from '@/modules/specialists/types';
import { IWellnessPackage } from '@/modules/wellnessPackages/types';
import { BaseRepository } from '@/modules/common/repository';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class CorporateRepository extends BaseRepository<ICorporate> {
  constructor() {
    super(CorporateModel as Model<ICorporate>);
  }

  async findByIdWithModel(id: string) {
    return CorporateModel.findById(id);
  }

  async findByIndustry(industry: string): Promise<ICorporate[]> {
    return this.findAll(
      { industry, isActive: true },
      { sort: { name: 1 } }
    );
  }

  async findByCity(city: string): Promise<ICorporate[]> {
    return this.findAll(
      { city, isActive: true },
      { sort: { name: 1 } }
    );
  }

  async findByState(state: string): Promise<ICorporate[]> {
    return this.findAll(
      { state, isActive: true },
      { sort: { name: 1 } }
    );
  }

  async findByCountry(country: string): Promise<ICorporate[]> {
    return this.findAll(
      { country, isActive: true },
      { sort: { name: 1 } }
    );
  }

  async findVerifiedCorporates(): Promise<ICorporate[]> {
    return this.findAll(
      { isVerified: true, isActive: true },
      { sort: { name: 1 } }
    );
  }

  async searchCorporates(searchTerm: string): Promise<ICorporate[]> {
    return CorporateModel.find({
      $text: { $search: searchTerm },
      isActive: true,
    })
      .sort({ score: { $meta: 'textScore' } })
      .lean();
  }

  async findWithPagination(
    filter: CorporateQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: ICorporate[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const query: any = {};

    if (filter.name) {
      query.name = buildContainsRegex(filter.name);
    }

    if (filter.companyName) {
      query.companyName = buildContainsRegex(filter.companyName);
    }

    if (filter.email) {
      query.email = buildContainsRegex(filter.email);
    }

    if (filter.contactPerson) {
      query.contactPerson = buildContainsRegex(filter.contactPerson);
    }

    if (filter.industry) {
      query.industry = buildContainsRegex(filter.industry);
    }

    if (filter.city) {
      query.city = buildContainsRegex(filter.city);
    }

    if (filter.state) {
      query.state = buildContainsRegex(filter.state);
    }

    if (filter.country) {
      query.country = buildContainsRegex(filter.country);
    }

    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    }

    if (filter.isVerified !== undefined) {
      query.isVerified = filter.isVerified;
    }

    if (filter.search) {
      query.$text = { $search: filter.search };
    }

    const skip = (page - 1) * limit;
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.name = 1;
    }

    // If text search, add text score to sort
    if (filter.search) {
      sort.score = { $meta: 'textScore' };
    }

    const [data, total] = await Promise.all([
      CorporateModel.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      CorporateModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async addSpecialistId(corporateId: string, specialistId: string): Promise<ICorporate | null> {
    return CorporateModel.findByIdAndUpdate(
      corporateId,
      { $addToSet: { specialistIds: specialistId } },
      { new: true }
    ).lean();
  }

  async removeSpecialistId(corporateId: string, specialistId: string): Promise<ICorporate | null> {
    return CorporateModel.findByIdAndUpdate(
      corporateId,
      { $pull: { specialistIds: specialistId } },
      { new: true }
    ).lean();
  }

  async addWellnessPackageId(corporateId: string, packageId: string): Promise<ICorporate | null> {
    return CorporateModel.findByIdAndUpdate(
      corporateId,
      { $addToSet: { wellnessPackageIds: packageId } },
      { new: true }
    ).lean();
  }

  async removeWellnessPackageId(corporateId: string, packageId: string): Promise<ICorporate | null> {
    return CorporateModel.findByIdAndUpdate(
      corporateId,
      { $pull: { wellnessPackageIds: packageId } },
      { new: true }
    ).lean();
  }

  async findSpecialists(specialistIds: string[]): Promise<ISpecialist[]> {
    return SpecialistModel.find({ _id: { $in: specialistIds } }).lean();
  }

  async findWellnessPackages(packageIds: string[]): Promise<IWellnessPackage[]> {
    return WellnessPackageModel.find({ _id: { $in: packageIds } }).lean();
  }
}
