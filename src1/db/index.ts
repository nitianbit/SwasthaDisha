import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';
import logger from '@/services/logger';

export const connectDB = async (): Promise<typeof mongoose | null> => {
  let conn: typeof mongoose | null = null;

  // In production, collections and indexes must be created by the deploy-time
  // sync script (npm run sync-indexes), never lazily inside request handlers —
  // lazy creation races when multiple instances start against the same DB.
  const autoSetup = CONFIG.NODE_ENV !== 'production';
  mongoose.set('autoCreate', autoSetup);
  mongoose.set('autoIndex', autoSetup);

  try {
    conn = await mongoose.connect(CONFIG.MONGODB_URL);
    console.log(`MongoDB connected: ${conn.connection.host}`);
    logger.info(`MongoDB connected: ${conn.connection.host}`);
    
    // Handle connection events
    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error:', err);
      console.error('MongoDB connection error:', err);
    });
    
    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
      console.warn('MongoDB disconnected');
    });
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
      await mongoose.connection.close();
      logger.info('MongoDB connection closed through app termination');
      console.log('MongoDB connection closed through app termination');
      process.exit(0);
    });
    
  } catch (error: any) {
    logger.error(`Error while connecting MongoDB: ${error.message}`, error);
    console.error(`Error while connecting MongoDB: ${error.message}`);
    process.exit(1);
  }
  
  return conn;
};

export default connectDB;
