import winston from 'winston';

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

export const showError = (err: any) => {
  if (err?.response?.data) {
    logger.log(
      'error',
      `Error for URL: ${err?.config?.url}`,
      { data: err?.response?.data }
    );
  } else if (err?.code === 'ECONNREFUSED') {
    logger.log(
      'error',
      `ECONNREFUSED for URL: ${err?.config?.url}`
    );
  } else if (err?.code === 'ECONNABORTED' || err?.message?.includes('timeout')) {
    logger.log(
      'error',
      `TIMEOUT for URL: ${err?.config?.url}`
    );
  } else {
    logger.log('error', 'An unknown error occurred', { error: err });
  }
};

export default logger;
