/**
 * Settings Types
 */

export interface ISettings {
  // Server configuration
  PORT: number;
  NODE_ENV: string;
  BASE_URL: string;
  
  // Database configuration
  MONGODB_URL: string;
  
  // Authentication configuration
  JWT_SECRET_KEY: string;
  
  // Email configuration
  EMAIL?: string;
  EMAIL_PASSWORD?: string;
  SMTP2GO_API_KEY?: string;
  SMTP2GO_SENDER?: string;
  STORE_NAME?: string;
  STORE_SUPPORT_EMAIL?: string;
  STORE_SUPPORT_PHONE?: string;
  STORE_EMAIL_FOOTER_LOGO_URL?: string;
  REPORT_URL?: string;

  // SMS configuration
  SMS_API_BASE_URL?: string;
  SMS_USERNAME?: string;
  SMS_PASSWORD?: string;
  SMS_FROM?: string;
  SMS_TEMPLATE_ID?: string;
  SMS_PE_ID?: string;
  SMS_COOKIE?: string;
  
  // Firebase configuration
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_PRIVATE_KEY?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  
  // File upload configuration
  UPLOAD_DIR: string;
  MAX_FILE_SIZE: number;
  
  // OTP configuration
  OTP_EXPIRY_MINUTES: number;
  
  // CORS configuration
  CORS_ORIGIN: string;

  // Razorpay configuration
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;

  // Referral configuration
  REFERRAL_REWARD_AMOUNT: number;

  // LabStack configuration
  LABSTACK_BASE_URL?: string;
  LABSTACK_USER_ID?: string;
  LABSTACK_PASSWORD?: string;
  LABSTACK_API_KEY?: string;

  // Healthians configuration
  HEALTHIANS_BASE_URL?: string;
  HEALTHIANS_PARTNER_NAME?: string;
  HEALTHIANS_USERNAME?: string;
  HEALTHIANS_PASSWORD?: string;
  HEALTHIANS_CHECKSUM?: string;

  // External booking default integration
  EXTERNAL_BOOKING_DEFAULT_INTEGRATION?: 'labstack' | 'healthians';

  // Google Calendar / Meet configuration
  GOOGLE_CALENDAR_ID?: string;
  GOOGLE_MEET_TIMEZONE?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  GOOGLE_SERVICE_ACCOUNT_IMPERSONATED_USER?: string;
  GOOGLE_SERVICE_ACCOUNT_FILE?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  GOOGLE_OAUTH_REFRESH_TOKEN?: string;
  /** Fixed consultation price (INR) for external / Labstack doctor bookings. 0 or unset skips Razorpay and books immediately. */
  EXTERNAL_CONSULTATION_FIXED_PRICE?: number;
}

// Alias for backward compatibility
export type IConfig = ISettings;
