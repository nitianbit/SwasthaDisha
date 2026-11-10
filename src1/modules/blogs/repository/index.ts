import { Service } from 'typedi';
import { FilterQuery, Model } from 'mongoose';
import { BaseRepository } from '@/modules/common/repository';
import BlogModel, { BlogCategoryModel } from '@/modules/blogs/model';
import {
  BlogCategoryQueryParams,
  BlogQueryParams,
  IBlog,
  IBlogCategory,
  PublicBlogQueryParams,
} from '@/modules/blogs/types';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class BlogRepository extends BaseRepository<IBlog> {
  constructor() {
    super(BlogModel as Model<IBlog>);
  }

  async findWithPagination(
    filter: FilterQuery<IBlog>,
    page: number,
    limit: number,
    sort: Record<string, 1 | -1>
  ): Promise<{ data: IBlog[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.findAll(filter, { skip, limit, sort }),
      BlogModel.countDocuments(filter),
    ]);

    return {
      data,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  buildAdminFilter(queryParams: BlogQueryParams): FilterQuery<IBlog> {
    const filter: FilterQuery<IBlog> = {};

    if (queryParams.search?.trim()) {
      const search = buildContainsRegex(queryParams.search.trim());
      filter.$or = [
        { title: search },
        { excerpt: search },
        { categoryName: search },
        { tags: search },
        { 'sections.heading': search },
      ];
    }

    if (queryParams.categoryId) {
      filter.categoryId = queryParams.categoryId;
    }

    if (queryParams.status) {
      filter.status = queryParams.status;
    }

    if (queryParams.isFeatured !== undefined) {
      filter.isFeatured = queryParams.isFeatured;
    }

    return filter;
  }

  buildPublicFilter(queryParams: PublicBlogQueryParams, categoryId?: string): FilterQuery<IBlog> {
    const filter: FilterQuery<IBlog> = {
      $or: [
        {
          status: 'published',
          publishedAt: { $lte: new Date() },
        },
        {
          status: 'scheduled',
          scheduledAt: { $lte: new Date() },
        },
      ],
    };

    if (queryParams.search?.trim()) {
      const search = buildContainsRegex(queryParams.search.trim());
      filter.$and = [
        {
          $or: [
            { title: search },
            { excerpt: search },
            { categoryName: search },
            { tags: search },
            { 'sections.heading': search },
          ],
        },
      ];
    }

    if (categoryId) {
      filter.categoryId = categoryId;
    }

    return filter;
  }
}

@Service()
export class BlogCategoryRepository extends BaseRepository<IBlogCategory> {
  constructor() {
    super(BlogCategoryModel as Model<IBlogCategory>);
  }

  async findAllSorted(queryParams: BlogCategoryQueryParams = {}): Promise<IBlogCategory[]> {
    const filter: FilterQuery<IBlogCategory> = {};

    if (queryParams.search?.trim()) {
      const search = buildContainsRegex(queryParams.search.trim());
      filter.$or = [{ name: search }, { slug: search }, { description: search }];
    }

    if (queryParams.isActive !== undefined) {
      filter.isActive = queryParams.isActive;
    }

    return this.findAll(filter, { sort: { sortOrder: 1, name: 1 } });
  }
}
