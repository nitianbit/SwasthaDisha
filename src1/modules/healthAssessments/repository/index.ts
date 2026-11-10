import { Service } from 'typedi';
import { Model } from 'mongoose';
import { BaseRepository } from '@/modules/common/repository';
import HealthAssessmentModel from '@/modules/healthAssessments/model';
import {
  IHealthAssessment,
  HealthAssessmentListQueryParams,
} from '@/modules/healthAssessments/types';

@Service()
export class HealthAssessmentRepository extends BaseRepository<IHealthAssessment> {
  constructor() {
    super(HealthAssessmentModel as Model<IHealthAssessment>);
  }

  async findByUserId(
    userId: string,
    filter: HealthAssessmentListQueryParams = {}
  ): Promise<{
    data: IHealthAssessment[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    const page = filter.page;
    const limit = filter.limit;

    if (page && limit) {
      const skip = (page - 1) * limit;
      const [data, total] = await Promise.all([
        this.findMany({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        this.findMany({ userId }).countDocuments(),
      ]);

      return {
        data,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      };
    }

    const data = await this.findAll({ userId }, { sort: { createdAt: -1 } });
    return { data };
  }
}
