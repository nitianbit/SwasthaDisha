import Joi from 'joi';

const imageSchema = Joi.string()
  .trim()
  .optional()
  .custom((value, helpers) => {
    if (!value) return value;
    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/')) {
      return value;
    }
    return helpers.error('string.custom', {
      message: 'Image must be a valid URI (http://, https://) or a relative path starting with /',
    });
  });

const objectIdSchema = Joi.string()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    'string.pattern.base': 'Invalid ID format',
  });

const dateSchema = Joi.date().iso();

const sectionSchema = Joi.object({
  id: Joi.string().trim().optional(),
  heading: Joi.string().trim().min(1).max(200).required(),
  slug: Joi.string().trim().min(1).max(120).optional(),
  summary: Joi.string().trim().allow('').optional(),
  body: Joi.string().trim().min(1).required(),
  image: imageSchema,
  altText: Joi.string().trim().max(300).allow('').optional(),
  sortOrder: Joi.number().integer().min(0).optional(),
});

const faqSchema = Joi.object({
  id: Joi.string().trim().optional(),
  question: Joi.string().trim().min(1).max(300).required(),
  answer: Joi.string().trim().min(1).required(),
  sortOrder: Joi.number().integer().min(0).optional(),
  isActive: Joi.boolean().optional(),
});

const seoSchema = Joi.object({
  metaTitle: Joi.string().trim().max(200).allow('').optional(),
  metaDescription: Joi.string().trim().max(320).allow('').optional(),
  ogImage: imageSchema,
  ogImageAlt: Joi.string().trim().max(300).allow('').optional(),
  canonicalUrl: Joi.string().trim().uri({ scheme: ['http', 'https'] }).allow('').optional(),
  noIndex: Joi.boolean().optional(),
}).optional();

export const createBlogCategorySchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  slug: Joi.string().trim().min(1).max(120).optional(),
  description: Joi.string().trim().max(500).allow('').optional(),
  isActive: Joi.boolean().optional(),
  sortOrder: Joi.number().integer().min(0).optional(),
});

export const updateBlogCategorySchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).optional(),
  slug: Joi.string().trim().min(1).max(120).optional(),
  description: Joi.string().trim().max(500).allow('').optional(),
  isActive: Joi.boolean().optional(),
  sortOrder: Joi.number().integer().min(0).optional(),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update',
  });

export const blogCategoryQuerySchema = Joi.object({
  search: Joi.string().trim().optional(),
  isActive: Joi.boolean().optional(),
});

export const createBlogSchema = Joi.object({
  title: Joi.string().trim().min(1).max(200).required(),
  slug: Joi.string().trim().min(1).max(120).optional(),
  excerpt: Joi.string().trim().min(1).max(600).required(),
  heroImage: imageSchema.required(),
  heroImageAlt: Joi.string().trim().max(300).allow('').optional(),
  categoryId: objectIdSchema.required(),
  status: Joi.string().valid('draft', 'scheduled', 'published', 'archived').required(),
  tags: Joi.array().items(Joi.string().trim().max(60)).optional(),
  sections: Joi.array().items(sectionSchema).min(1).required(),
  faqs: Joi.array().items(faqSchema).optional(),
  reviewedBy: Joi.string().trim().max(120).allow('').optional(),
  isFeatured: Joi.boolean().optional(),
  publishedAt: dateSchema.optional(),
  scheduledAt: dateSchema.optional(),
  seo: seoSchema,
});

export const updateBlogSchema = Joi.object({
  title: Joi.string().trim().min(1).max(200).optional(),
  slug: Joi.string().trim().min(1).max(120).optional(),
  excerpt: Joi.string().trim().min(1).max(600).optional(),
  heroImage: imageSchema,
  heroImageAlt: Joi.string().trim().max(300).allow('').optional(),
  categoryId: objectIdSchema.optional(),
  status: Joi.string().valid('draft', 'scheduled', 'published', 'archived').optional(),
  tags: Joi.array().items(Joi.string().trim().max(60)).optional(),
  sections: Joi.array().items(sectionSchema).min(1).optional(),
  faqs: Joi.array().items(faqSchema).optional(),
  reviewedBy: Joi.string().trim().max(120).allow('').optional(),
  isFeatured: Joi.boolean().optional(),
  publishedAt: dateSchema.allow(null).optional(),
  scheduledAt: dateSchema.allow(null).optional(),
  seo: seoSchema,
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update',
  });

export const blogQuerySchema = Joi.object({
  search: Joi.string().trim().optional(),
  categoryId: objectIdSchema.optional(),
  status: Joi.string().valid('draft', 'scheduled', 'published', 'archived').optional(),
  isFeatured: Joi.boolean().optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});

export const publicBlogQuerySchema = Joi.object({
  search: Joi.string().trim().optional(),
  categorySlug: Joi.string().trim().optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});

export const idParamSchema = Joi.object({
  id: objectIdSchema.required(),
});

export const categoryIdParamSchema = Joi.object({
  categoryId: objectIdSchema.required(),
});

export const slugParamSchema = Joi.object({
  slug: Joi.string().trim().min(1).required(),
});
