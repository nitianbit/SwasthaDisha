import { Service } from 'typedi';
import { AppError } from '@/modules/common/types';
import { BlogCategoryRepository, BlogRepository } from '@/modules/blogs/repository';
import {
  BlogCategoryQueryParams,
  BlogQueryParams,
  CreateBlogCategoryRequest,
  CreateBlogRequest,
  IBlog,
  IBlogCategory,
  IBlogFaq,
  IBlogSection,
  PublicBlogQueryParams,
  UpdateBlogCategoryRequest,
  UpdateBlogRequest,
} from '@/modules/blogs/types';

const WORDS_PER_MINUTE = 200;

const slugify = (value: string, fallback: string) => {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);

  return slug || fallback;
};

const stripRichText = (value: string) =>
  value
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*`~_\-\[\]\(\)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

@Service()
export class BlogService {
  constructor(
    private blogRepository: BlogRepository,
    private blogCategoryRepository: BlogCategoryRepository
  ) {}

  private async ensureUniqueCategorySlug(slug: string, excludeId?: string) {
    const existing = await this.blogCategoryRepository.findOne(
      excludeId ? { slug, _id: { $ne: excludeId } } : { slug }
    );

    if (existing) {
      throw new AppError({
        status: 409,
        code: 'BLOG_CATEGORY_SLUG_EXISTS',
        message: 'Blog category slug already exists',
      });
    }
  }

  private async ensureUniqueBlogSlug(slug: string, excludeId?: string) {
    const existing = await this.blogRepository.findOne(
      excludeId ? { slug, _id: { $ne: excludeId } } : { slug }
    );

    if (existing) {
      throw new AppError({
        status: 409,
        code: 'BLOG_SLUG_EXISTS',
        message: 'Blog slug already exists',
      });
    }
  }

  private createStableItemId(prefix: string, index: number) {
    return `${prefix}-${Date.now()}-${index + 1}`;
  }

  private normalizeSections(
    sections: CreateBlogRequest['sections'] | UpdateBlogRequest['sections']
  ): IBlogSection[] {
    return (sections || [])
      .map((section, index) => ({
        id: section.id?.trim() || this.createStableItemId('section', index),
        heading: section.heading.trim(),
        slug: slugify(section.slug?.trim() || section.heading, `section-${index + 1}`),
        summary: section.summary?.trim() || undefined,
        body: section.body.trim(),
        image: section.image?.trim() || undefined,
        altText: section.altText?.trim() || undefined,
        sortOrder: section.sortOrder ?? index,
      }))
      .sort((left, right) => left.sortOrder - right.sortOrder);
  }

  private normalizeFaqs(faqs: CreateBlogRequest['faqs'] | UpdateBlogRequest['faqs']): IBlogFaq[] {
    return (faqs || [])
      .map((faq, index) => ({
        id: faq.id?.trim() || this.createStableItemId('faq', index),
        question: faq.question.trim(),
        answer: faq.answer.trim(),
        sortOrder: faq.sortOrder ?? index,
        isActive: faq.isActive ?? true,
      }))
      .sort((left, right) => left.sortOrder - right.sortOrder);
  }

  private calculateReadingMinutes(excerpt: string, sections: IBlogSection[]): number {
    const parts = [excerpt, ...sections.flatMap((section) => [section.summary || '', section.body])];
    const words = stripRichText(parts.join(' '))
      .split(/\s+/)
      .filter(Boolean).length;

    return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
  }

  async createCategory(data: CreateBlogCategoryRequest): Promise<IBlogCategory> {
    const slug = slugify(data.slug?.trim() || data.name, 'category');
    await this.ensureUniqueCategorySlug(slug);

    return this.blogCategoryRepository.save({
      name: data.name.trim(),
      slug,
      description: data.description?.trim() || undefined,
      isActive: data.isActive ?? true,
      sortOrder: data.sortOrder ?? 0,
    });
  }

  async getAllCategories(queryParams: BlogCategoryQueryParams = {}): Promise<IBlogCategory[]> {
    return this.blogCategoryRepository.findAllSorted(queryParams);
  }

  async getCategoryById(id: string): Promise<IBlogCategory> {
    const category = await this.blogCategoryRepository.findById(id);

    if (!category) {
      throw new AppError({
        status: 404,
        code: 'BLOG_CATEGORY_NOT_FOUND',
        message: 'Blog category not found',
      });
    }

    return category;
  }

  async updateCategory(id: string, data: UpdateBlogCategoryRequest): Promise<IBlogCategory> {
    const existing = await this.blogCategoryRepository.findById(id);

    if (!existing) {
      throw new AppError({
        status: 404,
        code: 'BLOG_CATEGORY_NOT_FOUND',
        message: 'Blog category not found',
      });
    }

    const slug = data.slug || data.name ? slugify(data.slug?.trim() || data.name || existing.name, 'category') : existing.slug;
    if (slug !== existing.slug) {
      await this.ensureUniqueCategorySlug(slug, id);
    }

    const updated = await this.blogCategoryRepository.update(
      { _id: id },
      {
        ...(data.name ? { name: data.name.trim() } : {}),
        ...(slug ? { slug } : {}),
        ...(data.description !== undefined ? { description: data.description?.trim() || undefined } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      }
    );

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'BLOG_CATEGORY_UPDATE_FAILED',
        message: 'Failed to update blog category',
      });
    }

    await this.blogRepository.updateMany({ categoryId: id }, {
      $set: {
        ...(data.name ? { categoryName: data.name.trim() } : {}),
      },
    });

    return updated;
  }

  async deleteCategory(id: string): Promise<void> {
    const category = await this.blogCategoryRepository.findById(id);

    if (!category) {
      throw new AppError({
        status: 404,
        code: 'BLOG_CATEGORY_NOT_FOUND',
        message: 'Blog category not found',
      });
    }

    const linkedBlog = await this.blogRepository.findOne({ categoryId: id });
    if (linkedBlog) {
      throw new AppError({
        status: 409,
        code: 'BLOG_CATEGORY_IN_USE',
        message: 'Cannot delete a category that is still assigned to blogs',
      });
    }

    await this.blogCategoryRepository.delete({ _id: id });
  }

  private async resolveCategory(categoryId: string): Promise<IBlogCategory> {
    const category = await this.blogCategoryRepository.findById(categoryId);

    if (!category) {
      throw new AppError({
        status: 400,
        code: 'BLOG_CATEGORY_NOT_FOUND',
        message: 'Selected blog category does not exist',
      });
    }

    return category;
  }

  private createNormalizedBlogPayload(
    data: CreateBlogRequest | UpdateBlogRequest,
    category: IBlogCategory,
    fallback?: IBlog
  ) {
    const title = data.title?.trim() || fallback?.title;
    const excerpt = data.excerpt?.trim() || fallback?.excerpt || '';
    const sections = data.sections ? this.normalizeSections(data.sections) : fallback?.sections || [];
    const payload = {
      ...(title ? { title } : {}),
      slug: slugify(data.slug?.trim() || title || fallback?.slug || 'blog', 'blog'),
      ...(excerpt ? { excerpt } : {}),
      ...(data.heroImage !== undefined ? { heroImage: data.heroImage.trim() } : fallback?.heroImage ? { heroImage: fallback.heroImage } : {}),
      ...(data.heroImageAlt !== undefined
        ? { heroImageAlt: data.heroImageAlt?.trim() || undefined }
        : fallback?.heroImageAlt
          ? { heroImageAlt: fallback.heroImageAlt }
          : {}),
      categoryId: category._id as string,
      categoryName: category.name,
      ...(data.status ? { status: data.status } : fallback?.status ? { status: fallback.status } : {}),
      tags:
        data.tags !== undefined
          ? data.tags.map((tag) => tag.trim()).filter(Boolean)
          : fallback?.tags || [],
      sections,
      faqs: data.faqs ? this.normalizeFaqs(data.faqs) : fallback?.faqs || [],
      ...(data.reviewedBy !== undefined
        ? { reviewedBy: data.reviewedBy?.trim() || undefined }
        : fallback?.reviewedBy
          ? { reviewedBy: fallback.reviewedBy }
          : {}),
      isFeatured: data.isFeatured ?? fallback?.isFeatured ?? false,
      ...(data.publishedAt !== undefined ? { publishedAt: data.publishedAt || undefined } : fallback?.publishedAt ? { publishedAt: fallback.publishedAt } : {}),
      ...(data.scheduledAt !== undefined ? { scheduledAt: data.scheduledAt || undefined } : fallback?.scheduledAt ? { scheduledAt: fallback.scheduledAt } : {}),
      ...(data.seo !== undefined
        ? {
            seo: {
              metaTitle: data.seo?.metaTitle?.trim() || undefined,
              metaDescription: data.seo?.metaDescription?.trim() || undefined,
              ogImage: data.seo?.ogImage?.trim() || undefined,
              ogImageAlt: data.seo?.ogImageAlt?.trim() || undefined,
              canonicalUrl: data.seo?.canonicalUrl?.trim() || undefined,
              noIndex: data.seo?.noIndex ?? false,
            },
          }
        : fallback?.seo
          ? { seo: fallback.seo }
          : {}),
      readingMinutes: this.calculateReadingMinutes(excerpt, sections),
    };

    return payload;
  }

  async createBlog(data: CreateBlogRequest): Promise<IBlog> {
    const category = await this.resolveCategory(data.categoryId);
    const payload = this.createNormalizedBlogPayload(data, category);
    await this.ensureUniqueBlogSlug(payload.slug);

    return this.blogRepository.save(payload);
  }

  async getBlogById(id: string): Promise<IBlog> {
    const blog = await this.blogRepository.findById(id);

    if (!blog) {
      throw new AppError({
        status: 404,
        code: 'BLOG_NOT_FOUND',
        message: 'Blog not found',
      });
    }

    return blog;
  }

  async getAllBlogs(queryParams: BlogQueryParams = {}): Promise<{
    data: IBlog[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    const filter = this.blogRepository.buildAdminFilter(queryParams);
    const sort: Record<string, 1 | -1> = {
      updatedAt: -1,
      createdAt: -1,
    };

    if (queryParams.page && queryParams.limit) {
      return this.blogRepository.findWithPagination(filter, queryParams.page, queryParams.limit, sort);
    }

    const data = await this.blogRepository.findAll(filter, { sort });
    return { data };
  }

  async updateBlog(id: string, data: UpdateBlogRequest): Promise<IBlog> {
    const existing = await this.getBlogById(id);
    const category = await this.resolveCategory(data.categoryId || existing.categoryId);
    const payload = this.createNormalizedBlogPayload(data, category, existing);

    if (payload.slug !== existing.slug) {
      await this.ensureUniqueBlogSlug(payload.slug, id);
    }

    const updated = await this.blogRepository.update({ _id: id }, payload);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'BLOG_UPDATE_FAILED',
        message: 'Failed to update blog',
      });
    }

    return updated;
  }

  async deleteBlog(id: string): Promise<void> {
    const existing = await this.blogRepository.findById(id);

    if (!existing) {
      throw new AppError({
        status: 404,
        code: 'BLOG_NOT_FOUND',
        message: 'Blog not found',
      });
    }

    await this.blogRepository.delete({ _id: id });
  }

  async getPublicBlogs(queryParams: PublicBlogQueryParams = {}): Promise<{
    data: IBlog[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    let categoryId: string | undefined;
    if (queryParams.categorySlug) {
      const category = await this.blogCategoryRepository.findOne({
        slug: queryParams.categorySlug,
        isActive: true,
      });
      categoryId = category?._id as string | undefined;

      if (!categoryId) {
        return {
          data: [],
          total: 0,
          page: queryParams.page || 1,
          totalPages: 1,
        };
      }
    }

    const filter = this.blogRepository.buildPublicFilter(queryParams, categoryId);
    const page = queryParams.page || 1;
    const limit = queryParams.limit || 12;
    return this.blogRepository.findWithPagination(filter, page, limit, {
      isFeatured: -1,
      publishedAt: -1,
      createdAt: -1,
    });
  }

  async getPublicBlogBySlug(slug: string): Promise<IBlog> {
    const filter = this.blogRepository.buildPublicFilter({}, undefined);
    const blog = await this.blogRepository.findOne({
      ...filter,
      slug,
    });

    if (!blog) {
      throw new AppError({
        status: 404,
        code: 'BLOG_NOT_FOUND',
        message: 'Blog not found',
      });
    }

    return blog;
  }
}
