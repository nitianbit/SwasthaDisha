import 'reflect-metadata';
import express, { Express } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

import { CONFIG } from '@/config/config';
import { connectDB } from '@/db';
import { configureRoutes } from '@/routes';
import { errorHandler } from '@/modules/middleware/errorHandler';
import '@/modules/queue/service/consumers';
import TaskQueue from '@/modules/queue/service/TaskQueue';
import { runExternalBookingPaymentTimeoutScheduler } from '@/modules/externalBookings/services/externalBookingPaymentTimeoutScheduler';
import { runPharmacyOrderTimeoutScheduler } from '@/modules/pharmacyOrders/services/pharmacyOrderTimeoutScheduler';
import { backfillMedicineNameKeys } from '@/modules/pharmacyMedicines/services/nameKeyMigration';
import { runInventoryImportCleanupScheduler } from '@/modules/pharmacyInventoryImports/services/inventoryImportCleanupScheduler';
import logger from '@/services/logger';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const app: Express = express();

// Middleware
const allowedOrigins = CONFIG.CORS_ORIGIN === '*'
  ? null  // null means allow all
  : CONFIG.CORS_ORIGIN.split(',').map((o) => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, server-to-server)
    if (!origin) return callback(null, true);
    if (!allowedOrigins) return callback(null, true); // wildcard — allow all
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Idempotency-Key'],
}));

// Handle preflight requests for all routes
app.options('*', cors());

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  next();
});

// Root endpoint
app.use('/', (_req, _res, next) => {
  console.log('Welcome to EWA Healthcare API Server!');
  next();
});

// Connect to database
connectDB()
  .then(() => {
    logger.info('Database connection established');
    return backfillMedicineNameKeys();
  })
  .then(() => {
    logger.info('Medicine nameKey backfill check completed');
    TaskQueue.runScheduler();
    logger.info('Task queue scheduler started');
    runExternalBookingPaymentTimeoutScheduler();
    logger.info('External booking payment-timeout scheduler started');
    runPharmacyOrderTimeoutScheduler();
    logger.info('Pharmacy order payment-timeout scheduler started');
    runInventoryImportCleanupScheduler();
    logger.info('Pharmacy inventory import cleanup scheduler started');
  })
  .catch((error) => {
    logger.error('Failed to connect to database:', error);
    process.exit(1);
  });

// Configure routes
configureRoutes(app);

// Global error handler (must be last)
app.use(errorHandler);

// Start server
const PORT = CONFIG.PORT;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 Environment: ${CONFIG.NODE_ENV}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  logger.info(`Server started on port ${PORT}`, {
    port: PORT,
    env: CONFIG.NODE_ENV,
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err: Error) => {
  logger.error('Unhandled Promise Rejection:', err);
  console.error('Unhandled Promise Rejection:', err);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err: Error) => {
  logger.error('Uncaught Exception:', err);
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

export default app;
