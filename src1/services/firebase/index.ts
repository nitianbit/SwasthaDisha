import logger from '@/services/logger';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

let initialized = false;

const SERVICE_ACCOUNT_PATH = path.resolve(
  process.cwd(),
  'ewa-health-care-firebase-adminsdk-yega2-5c1d272ece.json'
);

const getFirebaseCredential = (): admin.ServiceAccount | null => {
  try {
    if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
      const serviceAccount = JSON.parse(
        fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8')
      );

      if (
        serviceAccount.project_id &&
        serviceAccount.client_email &&
        serviceAccount.private_key
      ) {
        return serviceAccount;
      }
    }
  } catch (error) {
    logger.error('Failed to read Firebase service account file', { error });
  }
  // If the service account file is missing or invalid, do not fall back to env vars.
  // Simply return null so Firebase messaging is treated as unavailable.
  return null;
};

const initFirebase = (): void => {
  if (initialized || admin.apps.length > 0) {
    initialized = true;
    return;
  }

  const credential = getFirebaseCredential();
  if (!credential) {
    return;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert(credential),
    });
    initialized = true;
  } catch (error) {
    logger.error('Failed to initialize Firebase', { error });
  }
};

export const getFirebaseMessaging = (): admin.messaging.Messaging | null => {
  initFirebase();
  if (admin.apps.length === 0) {
    return null;
  }
  return admin.messaging();
};
