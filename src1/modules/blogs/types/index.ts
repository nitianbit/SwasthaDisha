export type BlogStatus = 'draft' | 'scheduled' | 'published' | 'archived';

export interface IBlogSection {
  id: string;
  heading: string;
  slug: string;
  summary?: string;
  body: string;
  image?: string;
  altText?: string;
  sortOrder: number;
}

export interface IBlogFaq {
  id: string;
  question: string;
  answer: string;
  sortOrder: number;
  isActive: boolean;
}

export interface IBlogSeo {
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: string;
  ogImageAlt?: string;
  canonicalUrl?: string;
  noIndex?: boolean;
}

export interface IBlogCategory {
  _id?: string;
  name: string;
  slug: string;
  description?: string;
  isActive: boolean;
  sortOrder: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IBlog {
  _id?: string;
  title: string;
  slug: string;
  excerpt: string;
  heroImage: string;
  heroImageAlt?: string;
  categoryId: string;
  categoryName?: string;
  status: BlogStatus;
  tags: string[];
  sections: IBlogSection[];
  faqs: IBlogFaq[];
  reviewedBy?: string;
  readingMinutes: number;
  isFeatured: boolean;
  publishedAt?: Date;
  scheduledAt?: Date;
  seo?: IBlogSeo;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateBlogCategoryRequest {
  name: string;
  slug?: string;
  description?: string;
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpdateBlogCategoryRequest {
  name?: string;
  slug?: string;
  description?: string;
  isActive?: boolean;
  sortOrder?: number;
}

export interface BlogCategoryQueryParams {
  search?: string;
  isActive?: boolean;
}

export interface CreateBlogRequest {
  title: string;
  slug?: string;
  excerpt: string;
  heroImage: string;
  heroImageAlt?: string;
  categoryId: string;
  status: BlogStatus;
  tags?: string[];
  sections: Array<{
    id?: string;
    heading: string;
    slug?: string;
    summary?: string;
    body: string;
    image?: string;
    altText?: string;
    sortOrder?: number;
  }>;
  faqs?: Array<{
    id?: string;
    question: string;
    answer: string;
    sortOrder?: number;
    isActive?: boolean;
  }>;
  reviewedBy?: string;
  isFeatured?: boolean;
  publishedAt?: Date;
  scheduledAt?: Date;
  seo?: IBlogSeo;
}

export interface UpdateBlogRequest {
  title?: string;
  slug?: string;
  excerpt?: string;
  heroImage?: string;
  heroImageAlt?: string;
  categoryId?: string;
  status?: BlogStatus;
  tags?: string[];
  sections?: Array<{
    id?: string;
    heading: string;
    slug?: string;
    summary?: string;
    body: string;
    image?: string;
    altText?: string;
    sortOrder?: number;
  }>;
  faqs?: Array<{
    id?: string;
    question: string;
    answer: string;
    sortOrder?: number;
    isActive?: boolean;
  }>;
  reviewedBy?: string;
  isFeatured?: boolean;
  publishedAt?: Date;
  scheduledAt?: Date;
  seo?: IBlogSeo;
}

export interface BlogQueryParams {
  search?: string;
  categoryId?: string;
  status?: BlogStatus;
  isFeatured?: boolean;
  page?: number;
  limit?: number;
}

export interface PublicBlogQueryParams {
  search?: string;
  categorySlug?: string;
  page?: number;
  limit?: number;
}
