export interface CustomError extends Error {
  status?: number;
  code?: number | string;
  saveInDB?: boolean;
}

export interface AppErrorArgs {
  status?: number;
  code?: number | string;
  message: string;
  saveInDB?: boolean;
}

export class AppError extends Error implements CustomError {
  status?: number;
  code?: number | string;
  saveInDB?: boolean;

  constructor(args: AppErrorArgs) {
    super(args.message);
    this.status = args.status ?? 500;
    this.code = args.code;
    this.saveInDB = args.saveInDB ?? false;
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}
