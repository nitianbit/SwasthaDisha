import { Service } from 'typedi';
import { NewsRepository } from '@/modules/news/repository';
import {
  INews,
  CreateNewsRequest,
  UpdateNewsRequest,
  NewsQueryParams,
} from '@/modules/news/types';
import { AppError } from '@/modules/common/types';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class NewsService {
  constructor(private newsRepository: NewsRepository) {}

  async create(data: CreateNewsRequest): Promise<INews> {
    return this.newsRepository.save(data);
  }

  async getById(id: string): Promise<INews> {
    const news = await this.newsRepository.findById(id);

    if (!news) {
      throw new AppError({
        status: 404,
        code: 'NEWS_NOT_FOUND',
        message: 'News not found',
      });
    }

    return news;
  }

  async getAll(queryParams: NewsQueryParams = {}): Promise<{
    data: INews[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    if (queryParams.page && queryParams.limit) {
      return this.newsRepository.findWithPagination(
        queryParams,
        queryParams.page,
        queryParams.limit
      );
    }

    const filter: any = {};

    if (queryParams.title) {
      filter.title = buildContainsRegex(queryParams.title);
    }

    if (queryParams.description) {
      filter.description = buildContainsRegex(queryParams.description);
    }

    if (queryParams.publishedAt) {
      filter.publishedAt = queryParams.publishedAt;
    }

    const sort: any = {};
    if (queryParams.sortBy) {
      sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.publishedAt = -1;
      sort.createdAt = -1;
    }

    const data = await this.newsRepository.findAll(filter, { sort });
    return { data };
  }

  async update(id: string, data: UpdateNewsRequest): Promise<INews> {
    const existing = await this.newsRepository.findById(id);

    if (!existing) {
      throw new AppError({
        status: 404,
        code: 'NEWS_NOT_FOUND',
        message: 'News not found',
      });
    }

    const updated = await this.newsRepository.update({ _id: id }, data);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update news',
      });
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.newsRepository.findById(id);

    if (!existing) {
      throw new AppError({
        status: 404,
        code: 'NEWS_NOT_FOUND',
        message: 'News not found',
      });
    }

    await this.newsRepository.delete({ _id: id });
  }
}
