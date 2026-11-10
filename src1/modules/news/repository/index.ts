import { Service } from 'typedi';
import { Model } from 'mongoose';
import NewsModel from '@/modules/news/model';
import { BaseRepository } from '@/modules/common/repository';
import { INews, NewsQueryParams } from '@/modules/news/types';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class NewsRepository extends BaseRepository<INews> {
  constructor() {
    super(NewsModel as Model<INews>);
  }

  async findWithPagination(
    filter: NewsQueryParams = {},
    page: number = 1,
    limit: number = 10
  ): Promise<{ data: INews[]; total: number; page: number; totalPages: number }> {
    const query: any = {};

    if (filter.title) {
      query.title = buildContainsRegex(filter.title);
    }

    if (filter.description) {
      query.description = buildContainsRegex(filter.description);
    }

    if (filter.publishedAt) {
      query.publishedAt = filter.publishedAt;
    }

    const skip = (page - 1) * limit;
    const sort: any = {};

    if (filter.sortBy) {
      sort[filter.sortBy] = filter.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.publishedAt = -1;
      sort.createdAt = -1;
    }

    const [data, total] = await Promise.all([
      this.findAll(query, { skip, limit, sort }),
      NewsModel.countDocuments(query),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}
