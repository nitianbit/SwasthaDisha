import { Schema, model, Model } from 'mongoose';
import { IBanner } from '@/modules/banners/types';

const bannerSchema = new Schema<IBanner>(
  {
    title: {
      type: String,
      required: false,
      trim: true,
      index: true,
    }, // Banner title/heading displayed to users (optional)
    description: {
      type: String,
      trim: true,
    }, // Optional description text for the banner
    imageUrl: {
      type: String,
      required: true,
      trim: true,
    }, // Required: URL of the banner image (must be a valid URI). This is the main visual content of the banner.
    linkUrl: {
      type: String,
      trim: true,
    }, // Optional: URL where clicking the banner redirects. Can be deep link to app screen, external URL, or internal route.
    bannerType: {
      type: String,
      enum: ['home', 'promotional', 'category', 'wellnessPackage', 'specialist','surgery','second-opinion'],
      trim: true,
      index: true,
    }, // Type/category of banner: 'home' (homepage banner), 'promotional' (promotional offers), 'category' (category-specific), 'wellnessPackage' (wellness package banner), 'specialist' (specialist banner), etc.
    startDate: {
      type: String,
      match: /^\d{8}$/, // YYYYMMDD format
      index: true,
    }, // Optional: Date when banner should start appearing (YYYYMMDD format). If not set, banner shows immediately if active.
    endDate: {
      type: String,
      match: /^\d{8}$/, // YYYYMMDD format
      index: true,
    }, // Optional: Date when banner should stop appearing (YYYYMMDD format). If not set, banner shows indefinitely until manually deactivated.
    target: {
      type: String,
      trim: true,
      index: true,
    }, // Optional: Entity type this banner is associated with. Examples: 'wellnessPackage' (banner for a specific wellness package), 'specialist' (banner for a specific specialist), 'category' (banner for a category), 'partner' (banner for a partner), etc. Used to link banner to specific entities.
    targetId: {
      type: String,
      trim: true,
      index: true,
    }, // Optional: The specific ID of the target entity. If target='wellnessPackage', then targetId should be the wellnessPackageId. If target='specialist', then targetId should be the specialistId. Used together with 'target' to create a link between banner and specific entities. Example: target='wellnessPackage', targetId='6988310b8e6f65fbb238bcc9'
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    }, // Whether the banner is currently active. Inactive banners won't appear even if within date range. Default: true
    order: {
      type: Number,
      default: 0,
    }, // Display order/priority. Lower numbers appear first. Used for sorting banners when multiple banners are displayed. Default: 0
    corporateId: {
      type: String,
      index: true,
    }, // Corporate ID if banner is specific to a corporate
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
bannerSchema.index({ bannerType: 1, isActive: 1 });
bannerSchema.index({ target: 1, targetId: 1 });
bannerSchema.index({ startDate: 1, endDate: 1 });
bannerSchema.index({ order: 1 });
bannerSchema.index({ isActive: 1, order: 1 });
bannerSchema.index({ corporateId: 1, isActive: 1 }); // Index for corporate-based queries

const BannerModel: Model<IBanner> = model<IBanner>('Banner', bannerSchema);

export default BannerModel;
