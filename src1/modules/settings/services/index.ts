import { Service } from 'typedi';
import { ISettings } from '../types';
import { CONFIG } from '@/config/config';

/**
 * Settings Service
 * Provides access to application configuration/settings
 * Can be injected into other services using Typedi
 */
@Service()
export class SettingsService {
  /**
   * Get the full settings object
   */
  getSettings(): ISettings {
    return CONFIG as ISettings;
  }

  /**
   * Get server port
   */
  getPort(): number {
    return CONFIG.PORT;
  }

  /**
   * Get node environment
   */
  getNodeEnv(): string {
    return CONFIG.NODE_ENV;
  }

  /**
   * Get base URL for generating full URLs
   */
  getBaseUrl(): string {
    return CONFIG.BASE_URL;
  }

  /**
   * Get MongoDB connection URL
   */
  getMongoDbUrl(): string {
    return CONFIG.MONGODB_URL;
  }

  /**
   * Get JWT secret key
   */
  getJwtSecretKey(): string {
    return CONFIG.JWT_SECRET_KEY;
  }

  /**
   * Get email configuration
   */
  getEmailConfig(): { email?: string; password?: string; smtp2goApiKey?: string } {
    return {
      email: CONFIG.EMAIL,
      password: CONFIG.EMAIL_PASSWORD,
      smtp2goApiKey: CONFIG.SMTP2GO_API_KEY,
    };
  }

  getSmsConfig(): {
    baseUrl?: string;
    username?: string;
    password?: string;
    from?: string;
    templateId?: string;
    peId?: string;
    cookie?: string;
  } {
    return {
      baseUrl: CONFIG.SMS_API_BASE_URL,
      username: CONFIG.SMS_USERNAME,
      password: CONFIG.SMS_PASSWORD,
      from: CONFIG.SMS_FROM,
      templateId: CONFIG.SMS_TEMPLATE_ID,
      peId: CONFIG.SMS_PE_ID,
      cookie: CONFIG.SMS_COOKIE,
    };
  }

  /**
   * Get Firebase configuration
   */
  getFirebaseConfig(): {
    projectId?: string;
    privateKey?: string;
    clientEmail?: string;
  } {
    return {
      projectId: CONFIG.FIREBASE_PROJECT_ID,
      privateKey: CONFIG.FIREBASE_PRIVATE_KEY,
      clientEmail: CONFIG.FIREBASE_CLIENT_EMAIL,
    };
  }

  /**
   * Get file upload directory
   */
  getUploadDir(): string {
    return CONFIG.UPLOAD_DIR;
  }

  /**
   * Get maximum file size in bytes
   */
  getMaxFileSize(): number {
    return CONFIG.MAX_FILE_SIZE;
  }

  /**
   * Get OTP expiry time in minutes
   */
  getOtpExpiryMinutes(): number {
    return CONFIG.OTP_EXPIRY_MINUTES;
  }

  /**
   * Get CORS origin
   */
  getCorsOrigin(): string {
    return CONFIG.CORS_ORIGIN;
  }

  /**
   * Check if running in production
   */
  isProduction(): boolean {
    return CONFIG.NODE_ENV === 'production';
  }

  /**
   * Check if running in development
   */
  isDevelopment(): boolean {
    return CONFIG.NODE_ENV === 'development';
  }
}
