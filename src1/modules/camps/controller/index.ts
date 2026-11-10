import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import formidable from 'formidable';
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';

import { CampService } from '@/modules/camps/services';
import { AppError } from '@/modules/common/types';
import {
  BulkPlaceCampOrderRequest,
  CampBulkUserRow,
  CampListQuery,
  PlaceCampOrderRequest,
} from '@/modules/camps/types';

const splitIds = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(String).map((item) => item.trim()).filter(Boolean);
    }
  } catch {
    // Fall back to comma-separated values.
  }

  return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
};

const toBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return undefined;
};

const normalizeHeader = (header: string): string =>
  header.toLowerCase().replace(/[^a-z0-9]/g, '');

const getCell = (row: Record<string, unknown>, aliases: string[]): string | undefined => {
  const normalizedAliases = aliases.map(normalizeHeader);
  for (const [key, value] of Object.entries(row)) {
    if (normalizedAliases.includes(normalizeHeader(key))) {
      const text = value === undefined || value === null ? '' : String(value).trim();
      return text || undefined;
    }
  }
  return undefined;
};

const mapRows = (rows: Record<string, unknown>[]): CampBulkUserRow[] =>
  rows
    .map((row, index) => ({
      rowNumber: index + 2,
      userId: getCell(row, ['userId', 'user_id']),
      uniqueId: getCell(row, ['uniqueId', 'unique_id']),
      referenceId: getCell(row, ['referenceId', 'reference_id']),
      name: getCell(row, ['name', 'patientName', 'patient_name']),
      mobile: getCell(row, ['mobile', 'phone', 'phoneNumber', 'phone_number']),
      gender: getCell(row, ['gender']),
      email: getCell(row, ['email']),
      dateOfBirth: getCell(row, ['dateOfBirth', 'date_of_birth', 'dob']),
      age: getCell(row, ['age']),
      altContact: getCell(row, ['altContact', 'alt_contact', 'alternatePhone']),
      mainUserUniqueId: getCell(row, ['mainUserUniqueId', 'main_user_unique_id']),
      relationship: getCell(row, ['relationship']),
    }))
    .filter((row) =>
      Boolean(
        row.userId ||
          row.uniqueId ||
          row.name ||
          row.mobile ||
          row.gender ||
          row.email ||
          row.dateOfBirth ||
          row.age
      )
    );

const parseCsv = (content: string): Record<string, unknown>[] => {
  const rows: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const nextChar = content[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      record.push(field);
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index += 1;
      record.push(field);
      rows.push(record);
      field = '';
      record = [];
      continue;
    }

    field += char;
  }

  if (field || record.length) {
    record.push(field);
    rows.push(record);
  }

  const [headers = [], ...body] = rows.filter((row) =>
    row.some((cell) => cell.trim())
  );
  return body.map((row) =>
    headers.reduce<Record<string, unknown>>((acc, header, index) => {
      acc[header.trim()] = row[index]?.trim() || '';
      return acc;
    }, {})
  );
};

export class CampController {
  private campService: CampService;

  constructor() {
    this.campService = Container.get(CampService);
  }

  getCamps = async (req: Request, res: Response, _next: NextFunction) => {
    const data = await this.campService.getCamps(req.query as CampListQuery);

    res.status(200).json({
      success: true,
      data,
    });
  };

  getCampDetails = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.campService.getCampDetails(req.params.campLsId);

    res.status(200).json({
      success: true,
      data,
    });
  };

  getCampSlots = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.campService.getCampSlots(req.params.campLsId);

    res.status(200).json({
      success: true,
      data,
    });
  };

  placeCampOrder = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const data = await this.campService.placeCampOrder(
      req.body as PlaceCampOrderRequest
    );

    res.status(201).json({
      success: true,
      message: 'Camp order placed successfully',
      data,
    });
  };

  bulkPlaceCampOrders = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const { fields, file } = await this.parseBulkUpload(req);
    const rows = this.parseBulkRows(file);

    if (!rows.length) {
      throw new AppError({
        status: 400,
        code: 'EMPTY_CAMP_UPLOAD',
        message: 'Uploaded file does not contain any user rows',
      });
    }

    const data: BulkPlaceCampOrderRequest = {
      campLsId: String(fields.campLsId || '').trim(),
      orderType: fields.orderType
        ? String(fields.orderType).trim()
        : 'CENTER_VISIT',
      appointment: String(fields.appointment || '').trim(),
      corporateId: fields.corporateId ? String(fields.corporateId).trim() : undefined,
      packageIds: splitIds(fields.packageIds),
      testIds: splitIds(fields.testIds),
      isVip: toBoolean(fields.isVip),
      labId: fields.labId ? String(fields.labId).trim() : undefined,
      pincode: fields.pincode ? String(fields.pincode).trim() : undefined,
      labName: fields.labName ? String(fields.labName).trim() : undefined,
      notes: fields.notes ? String(fields.notes).trim() : undefined,
      rows,
    };

    if (!data.campLsId || !data.appointment) {
      throw new AppError({
        status: 400,
        code: 'INVALID_CAMP_BULK_REQUEST',
        message: 'campLsId and appointment are required',
      });
    }

    const result = await this.campService.bulkPlaceCampOrders(data);

    res.status(200).json({
      success: true,
      message: 'Camp bulk booking completed',
      data: result,
    });
  };

  private parseBulkUpload(
    req: Request
  ): Promise<{ fields: Record<string, unknown>; file: formidable.File }> {
    return new Promise((resolve, reject) => {
      const form = formidable({
        maxFileSize: 10 * 1024 * 1024,
        keepExtensions: true,
        multiples: false,
      });

      form.parse(req, (error, rawFields, rawFiles) => {
        if (error) {
          reject(error);
          return;
        }

        const fields = Object.entries(rawFields).reduce<Record<string, unknown>>(
          (acc, [key, value]) => {
            acc[key] = Array.isArray(value) ? value[0] : value;
            return acc;
          },
          {}
        );

        const rawFile = rawFiles.file || rawFiles.files;
        const file = Array.isArray(rawFile) ? rawFile[0] : rawFile;

        if (!file) {
          reject(
            new AppError({
              status: 400,
              code: 'CAMP_UPLOAD_FILE_REQUIRED',
              message: 'Upload a CSV or XLSX file in the file field',
            })
          );
          return;
        }

        resolve({ fields, file });
      });
    });
  }

  private parseBulkRows(file: formidable.File): CampBulkUserRow[] {
    const extension = path.extname(file.originalFilename || file.filepath).toLowerCase();

    try {
      if (extension === '.csv') {
        const content = fs.readFileSync(file.filepath, 'utf8');
        return mapRows(parseCsv(content));
      }

      if (extension === '.xlsx' || extension === '.xls') {
        const workbook = XLSX.readFile(file.filepath);
        const firstSheet = workbook.SheetNames[0];
        const sheet = workbook.Sheets[firstSheet];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
          defval: '',
        });
        return mapRows(rows);
      }

      throw new AppError({
        status: 400,
        code: 'INVALID_CAMP_UPLOAD_TYPE',
        message: 'Only CSV, XLSX, and XLS files are supported',
      });
    } finally {
      try {
        fs.unlinkSync(file.filepath);
      } catch {
        // Ignore temp-file cleanup errors.
      }
    }
  }
}
