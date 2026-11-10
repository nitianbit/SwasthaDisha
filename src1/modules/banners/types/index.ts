/**
 * Banner Module Types
 * 
 * Key Concepts:
 * 
 * 1. bannerType: Categorizes the banner by its purpose/placement
 *    Examples: 'home' (homepage banner), 'promotional' (promotional offers), 
 *              'category' (category-specific), 'wellnessPackage', 'specialist', etc.
 * 
 * 2. target + targetId: Links banner to specific entities in the system
 *    - target: The entity type (e.g., 'wellnessPackage', 'specialist', 'category', 'partner')
 *    - targetId: The specific ID of that entity
 *    
 *    Examples:
 *    - target='wellnessPackage', targetId='6988310b8e6f65fbb238bcc9' 
 *      → Banner for a specific wellness package
 *    - target='specialist', targetId='6988310b8e6f65fbb238bccd'
 *      → Banner for a specific specialist
 *    - target='category', targetId='diagnostics'
 *      → Banner for a specific category
 *    - target='partner', targetId='6988310b8e6f65fbb238bcea'
 *      → Banner for a specific partner
 * 
 * 3. Date Range (startDate/endDate): Controls when banner is visible
 *    - If startDate is set, banner only appears from that date onwards
 *    - If endDate is set, banner stops appearing after that date
 *    - If neither is set, banner shows indefinitely (if active)
 * 
 * 4. linkUrl: Where clicking the banner redirects
 *    - Can be deep link to app screen (e.g., 'ewa://wellnessPackage/123')
 *    - Can be external URL (e.g., 'https://example.com/promo')
 *    - Can be internal route (e.g., '/wellness-packages/123')
 */

export type BannerType = 'home' | 'promotional' | 'category' | 'wellnessPackage' | 'specialist' | 'surgery' |'second-opinion';

export interface IBanner {
  _id?: string;
  title?: string; // Banner title/heading
  description?: string; // Optional description text for the banner
  imageUrl: string; // Required: URL of the banner image (must be a valid URI)
  linkUrl?: string; // Optional: URL where clicking the banner redirects (e.g., deep link to app screen, external URL, etc.)
  bannerType?: BannerType; // Type/category of banner: 'home' (homepage banner), 'promotional' (promotional offers), 'category' (category-specific), 'wellnessPackage' (wellness package banner), 'specialist' (specialist banner), etc.
  startDate?: string; // YYYYMMDD format - Optional: Date when banner should start appearing. If not set, banner shows immediately (if active)
  endDate?: string; // YYYYMMDD format - Optional: Date when banner should stop appearing. If not set, banner shows indefinitely (until manually deactivated)
  target?: string; // Optional: Entity type this banner is associated with. Examples: 'wellnessPackage' (banner for a specific wellness package), 'specialist' (banner for a specific specialist), 'category' (banner for a category), 'partner' (banner for a partner), etc.
  targetId?: string; // Optional: The specific ID of the target entity. If target='wellnessPackage', then targetId should be the wellnessPackageId. If target='specialist', then targetId should be the specialistId. Used together with 'target' to link banner to specific entities.
  corporateId?: string; // Corporate ID if banner is specific to a corporate
  isActive?: boolean; // Whether the banner is currently active. Inactive banners won't appear even if within date range. Default: true
  order?: number; // Display order/priority. Lower numbers appear first. Used for sorting banners. Default: 0
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateBannerRequest {
  title?: string; // Banner title/heading
  description?: string; // Optional description text
  imageUrl: string; // Required: URL of the banner image (must be a valid URI)
  linkUrl?: string; // Optional: Redirect URL when banner is clicked
  bannerType?: BannerType; // Type: 'home', 'promotional', 'category', 'wellnessPackage', 'specialist', etc.
  startDate?: string; // YYYYMMDD format - Optional start date for banner visibility
  endDate?: string; // YYYYMMDD format - Optional end date for banner visibility
  target?: string; // Optional: Entity type ('wellnessPackage', 'specialist', 'category', 'partner', etc.)
  targetId?: string; // Optional: ID of the target entity (wellnessPackageId, specialistId, etc.)
  corporateId?: string; // Corporate ID if banner is specific to a corporate
  isActive?: boolean; // Whether banner is active. Default: true
  order?: number; // Display order (lower = appears first). If not provided, auto-assigned
}

export interface UpdateBannerRequest {
  title?: string; // Banner title/heading
  description?: string; // Description text
  imageUrl?: string; // URL of the banner image (must be a valid URI)
  linkUrl?: string; // Redirect URL when banner is clicked
  bannerType?: BannerType; // Type: 'home', 'promotional', 'category', 'wellnessPackage', 'specialist', etc.
  startDate?: string; // YYYYMMDD format - Start date for banner visibility
  endDate?: string; // YYYYMMDD format - End date for banner visibility
  target?: string; // Entity type ('wellnessPackage', 'specialist', 'category', 'partner', etc.)
  targetId?: string; // ID of the target entity (wellnessPackageId, specialistId, etc.)
  corporateId?: string; // Corporate ID if banner is specific to a corporate
  isActive?: boolean; // Whether banner is active
  order?: number; // Display order (lower = appears first)
}

export interface BannerQueryParams {
  title?: string; // Filter by partial banner title
  bannerType?: BannerType; // Filter by banner type ('home', 'promotional', etc.)
  target?: string; // Filter by target entity type ('wellnessPackage', 'specialist', etc.)
  targetId?: string; // Filter by specific target entity ID
  corporateId?: string; // Filter by corporate ID
  isActive?: boolean; // Filter by active status
  page?: number; // Page number for pagination (starts from 1)
  limit?: number; // Number of items per page (max 100)
  sortBy?: string; // Field to sort by: 'title', 'order', 'bannerType', 'createdAt', 'updatedAt'
  sortOrder?: 'asc' | 'desc'; // Sort direction
  forUser?: boolean; // When true (admin list), return only non-corporate banners
}
