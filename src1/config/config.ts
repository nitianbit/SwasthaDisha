import dotenv from 'dotenv';
import path from 'path';
import { ISettings } from '@/modules/settings/types';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const JWT_SECRET_PLACEHOLDERS = ['your-secret-key', 'your-secret-key-change-in-production'];

function requireJwtSecret(value: string | undefined): string {
  if (
    value === undefined ||
    value.trim() === '' ||
    JWT_SECRET_PLACEHOLDERS.includes(value.trim())
  ) {
    throw new Error('JWT_SECRET_KEY must be set to a non-placeholder value');
  }
  return value;
}

/**
 * Application Configuration
 * Centralized configuration object containing all environment variables
 * and default values
 */
export const CONFIG: ISettings = {
  // Server configuration
  PORT: parseInt(process.env.PORT || '4031', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  BASE_URL: process.env.BASE_URL || 'http://localhost:4030',
  
  // Database configuration
  MONGODB_URL: process.env.MONGODB_URL || 'mongodb://localhost:27017/ewa-healthcare',
  
  // Authentication configuration
  JWT_SECRET_KEY: requireJwtSecret(process.env.JWT_SECRET_KEY),
  
  // Email configuration
  EMAIL: process.env.EMAIL,
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,
  SMTP2GO_API_KEY: process.env.SMTP2GO_API_KEY,
  SMTP2GO_SENDER: process.env.SMTP2GO_SENDER || process.env.EMAIL || 'support@myewacare.com',
  STORE_NAME: process.env.STORE_NAME || 'Myewacare',
  STORE_SUPPORT_EMAIL:
    process.env.STORE_SUPPORT_EMAIL ||
    process.env.SMTP2GO_SENDER ||
    process.env.EMAIL ||
    'support@myewacare.com',
  STORE_SUPPORT_PHONE: process.env.STORE_SUPPORT_PHONE || '+91 9686638384',
  STORE_EMAIL_FOOTER_LOGO_URL: process.env.STORE_EMAIL_FOOTER_LOGO_URL,
  REPORT_URL: process.env.REPORT_URL,

  // SMS configuration
  SMS_API_BASE_URL: process.env.SMS_API_BASE_URL,
  SMS_USERNAME: process.env.SMS_USERNAME,
  SMS_PASSWORD: process.env.SMS_PASSWORD,
  SMS_FROM: process.env.SMS_FROM,
  SMS_TEMPLATE_ID: process.env.SMS_TEMPLATE_ID,
  SMS_PE_ID: process.env.SMS_PE_ID,
  SMS_COOKIE: process.env.SMS_COOKIE,
  
  // Firebase configuration (if needed)
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
  FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
  
  // File upload configuration
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(process.cwd(), 'files'),
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE || '10485760', 10), // 10MB default
  
  // OTP configuration
  OTP_EXPIRY_MINUTES: parseInt(process.env.OTP_EXPIRY_MINUTES || '10', 10),
  
  // CORS configuration
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',

  // Razorpay configuration
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,

  // Referral configuration
  REFERRAL_REWARD_AMOUNT: parseInt(
    process.env.REFERRAL_REWARD_AMOUNT || '100',
    10
  ),

    // LabStack configuration
  LABSTACK_BASE_URL:process.env.LABSTACK_BASE_URL || 'https://integration.labstack.in',
  LABSTACK_USER_ID: process.env.LABSTACK_USER_ID,
  LABSTACK_PASSWORD: process.env.LABSTACK_PASSWORD,
  LABSTACK_API_KEY: process.env.LABSTACK_API_KEY,

  // Healthians configuration
  HEALTHIANS_BASE_URL: process.env.HEALTHIANS_BASE_URL || 'https://t25crm.healthians.co.in/api',
  HEALTHIANS_PARTNER_NAME: process.env.HEALTHIANS_PARTNER_NAME,
  HEALTHIANS_USERNAME: process.env.HEALTHIANS_USERNAME,
  HEALTHIANS_PASSWORD: process.env.HEALTHIANS_PASSWORD,
  HEALTHIANS_CHECKSUM: process.env.HEALTHIANS_CHECKSUM,
  EXTERNAL_BOOKING_DEFAULT_INTEGRATION:
    (process.env.EXTERNAL_BOOKING_DEFAULT_INTEGRATION as
      | 'labstack'
      | 'healthians'
      | undefined) || 'labstack',

  // Google Calendar / Meet configuration
  GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID,
  GOOGLE_MEET_TIMEZONE: process.env.GOOGLE_MEET_TIMEZONE || 'Asia/Kolkata',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  GOOGLE_SERVICE_ACCOUNT_IMPERSONATED_USER:
    process.env.GOOGLE_SERVICE_ACCOUNT_IMPERSONATED_USER,
  GOOGLE_SERVICE_ACCOUNT_FILE: process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
  GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
  GOOGLE_OAUTH_REFRESH_TOKEN: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  EXTERNAL_CONSULTATION_FIXED_PRICE: Number.parseFloat(process.env.EXTERNAL_CONSULTATION_FIXED_PRICE ?? '0') || 0,

};

// Validate required environment variables
const requiredEnvVars = ['MONGODB_URL'];

if (CONFIG.NODE_ENV === 'production') {
  requiredEnvVars.forEach((varName) => {
    if (!process.env[varName]) {
      console.error(`Missing required environment variable: ${varName}`);
      process.exit(1);
    }
  });
}
