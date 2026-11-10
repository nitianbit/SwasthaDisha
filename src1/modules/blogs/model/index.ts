import { model, Model, Schema } from 'mongoose';
import { IBlog, IBlogCategory } from '@/modules/blogs/types';

const blogCategorySchema = new Schema<IBlogCategory>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

blogCategorySchema.index({ isActive: 1, sortOrder: 1, name: 1 });

const blogSectionSchema = new Schema(
  {
    id: {
      type: String,
      required: true,
      trim: true,
    },
    heading: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    summary: {
      type: String,
      trim: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
    },
    image: {
      type: String,
      trim: true,
    },
    altText: {
      type: String,
      trim: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  {
    _id: false,
  }
);

const blogFaqSchema = new Schema(
  {
    id: {
      type: String,
      required: true,
      trim: true,
    },
    question: {
      type: String,
      required: true,
      trim: true,
    },
    answer: {
      type: String,
      required: true,
      trim: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    _id: false,
  }
);

const blogSeoSchema = new Schema(
  {
    metaTitle: {
      type: String,
      trim: true,
    },
    metaDescription: {
      type: String,
      trim: true,
    },
    ogImage: {
      type: String,
      trim: true,
    },
    ogImageAlt: {
      type: String,
      trim: true,
    },
    canonicalUrl: {
      type: String,
      trim: true,
    },
    noIndex: {
      type: Boolean,
      default: false,
    },
  },
  {
    _id: false,
  }
);

const blogSchema = new Schema<IBlog>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },
    excerpt: {
      type: String,
      required: true,
      trim: true,
    },
    heroImage: {
      type: String,
      required: true,
      trim: true,
    },
    heroImageAlt: {
      type: String,
      trim: true,
    },
    categoryId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    categoryName: {
      type: String,
      trim: true,
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['draft', 'scheduled', 'published', 'archived'],
      index: true,
    },
    tags: {
      type: [String],
      default: [],
    },
    sections: {
      type: [blogSectionSchema],
      default: [],
    },
    faqs: {
      type: [blogFaqSchema],
      default: [],
    },
    reviewedBy: {
      type: String,
      trim: true,
    },
    readingMinutes: {
      type: Number,
      required: true,
      default: 1,
    },
    isFeatured: {
      type: Boolean,
      default: false,
      index: true,
    },
    publishedAt: {
      type: Date,
      index: true,
    },
    scheduledAt: {
      type: Date,
      index: true,
    },
    seo: {
      type: blogSeoSchema,
      default: undefined,
    },
  },
  {
    timestamps: true,
  }
);

blogSchema.index({ status: 1, publishedAt: -1, createdAt: -1 });
blogSchema.index({ categoryId: 1, publishedAt: -1 });
blogSchema.index({ isFeatured: 1, publishedAt: -1 });
blogSchema.index({ title: 'text', excerpt: 'text', tags: 'text', categoryName: 'text' });

export const BlogCategoryModel: Model<IBlogCategory> = model<IBlogCategory>(
  'BlogCategory',
  blogCategorySchema
);

const BlogModel: Model<IBlog> = model<IBlog>('Blog', blogSchema);

export default BlogModel;
