import { Service } from 'typedi';
import * as XLSX from 'xlsx';
import { promises as fs } from 'fs';
import { ClientSession, Model, startSession } from 'mongoose';
import InventoryImportModel from '@/modules/pharmacyInventoryImports/model';
import {
  InventoryAdjustmentRepository,
  InventoryItemRepository,
} from '@/modules/pharmacyInventory/repository';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import {
  IInventoryImport,
  ImportRowResult,
  ImportMode,
  ImportStatus,
  ImportCommitError,
} from '@/modules/pharmacyInventoryImports/types';
import { AppError } from '@/modules/common/types';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import { BaseRepository } from '@/modules/common/repository';
import { IMedicine } from '@/modules/pharmacyMedicines/types';
import { buildMedicineNameKey } from '@/modules/pharmacyMedicines/services/nameKeyMigration';
import logger from '@/services/logger';

@Service()
class InventoryImportRepository extends BaseRepository<IInventoryImport> {
  constructor() {
    super(InventoryImportModel as Model<IInventoryImport>);
  }

  async findByPharmacy(pharmacyId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      InventoryImportModel.find({ pharmacyId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      InventoryImportModel.countDocuments({ pharmacyId }),
    ]);
    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }
}

/**
 * Q15: column headers are matched case-insensitively and without surrounding spaces ("Batch Number ", "BATCH NUMBER"
 * and "batch number" are one column; the first non-empty value wins if a sheet repeats one).
 */
export function normalizeHeaders(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = String(k).trim().toLowerCase();
    if (!(key in out) || out[key] === '' || out[key] === undefined || out[key] === null) out[key] = v;
  }
  return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * Q15 re-review: a numeric cell typed with grouping commas — international ("1,000,000") or Indian ("10,00,000") — is
 * read without them; any other value is returned unchanged (and parsed as before).
 */
/**
 * A price or percentage cell as a number. A plain number stays as it is; text must be a plain decimal ("12", "12.50",
 * "-3") once grouping commas are removed, otherwise NaN, so "1,5" (a decimal comma) or "12 rs" is refused rather than
 * read as 1 or 12 the way parseFloat would. An empty cell is 0, as before.
 */
export function decimalOf(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return value;
  const t = String(ungrouped(value)).trim();
  if (t === '') return 0;
  return /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : NaN;
}

export function ungrouped(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return /^-?(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d+)?$/.test(t) ? t.replace(/,/g, '') : value;
}

/**
 * Q15 review: the first sheet as rows of raw values with normalized headers. CSV/text files are read with `raw: true`,
 * so every value stays the text that was typed (the library would otherwise turn "12-05-2027" into a US month-first
 * date). In a spreadsheet, ONLY a real date cell (a number with a date format) is a date: it becomes "YYYY-MM-DD" from
 * the library's date code of its serial, which involves no time zone. A plain number stays a number.
 */
export function readSheetRows(filePath: string): Record<string, any>[] {
  const workbook = XLSX.readFile(filePath, { raw: true, cellDates: false, cellNF: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  // Q15 re-review: a workbook on the 1904 date system counts its serials from 1904-01-01 (1462 days after the 1900 base).
  const offset = workbook.Workbook?.WBProps?.date1904 ? 1462 : 0;
  for (const [addr, cell] of Object.entries(sheet ?? {})) {
    if (addr.startsWith('!') || !cell || typeof cell !== 'object') continue;
    const c = cell as XLSX.CellObject;
    if (c.t === 'n' && typeof c.v === 'number' && typeof c.z === 'string' && XLSX.SSF.is_date(c.z)) {
      const serial = Math.floor(c.v) + offset;
      const d = serial >= 1 ? XLSX.SSF.parse_date_code(serial) : null;
      Object.assign(c, { t: 's', v: d && d.y && d.m && d.d ? `${pad(d.y, 4)}-${pad(d.m)}-${pad(d.d)}` : `#date-cell:${c.v}`, w: undefined, z: undefined });
    } else if (c.t === 'd') {
      Object.assign(c, { t: 's', v: `#date-cell:${String(c.v)}`, w: undefined }); // not produced with cellDates: false
    }
  }
  return XLSX.utils.sheet_to_json<Record<string, any>>(sheet!, { defval: '', raw: true }).map(normalizeHeaders);
}

/** Q15 review: the expiry forms an import accepts (shown to pharmacies in the error). */
export const EXPIRY_FORMS = 'YYYYMMDD, YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, or MM/YYYY / MM-YYYY (the last day of that month)';

/**
 * Q15 review: the expiry as YYYYMMDD, or '' when the value is not one of the accepted forms (the row is then refused):
 *  - text `YYYYMMDD`, `YYYY-MM-DD` (also what a spreadsheet date cell becomes in readSheetRows);
 *  - text `DD-MM-YYYY` / `DD/MM/YYYY`, always day first (Indian order);
 *  - text `MM/YYYY` / `MM-YYYY` as printed on packs ("EXP 12/2027"): the LAST day of that month;
 *  - a number only when it is an 8-digit YYYYMMDD (a spreadsheet cell typed as 20271231).
 * Any other number (an Excel serial without a date format, 202712, 122027, …), Date object or form is refused.
 * Calendar validity is checked afterwards (isValidYyyymmdd).
 */
export function expiryOf(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 10_000_000 && value <= 99_999_999 ? String(value) : '';
  }
  if (typeof value !== 'string') return '';
  const t = value.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{4})(\d{2})(\d{2})$/)) || (m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return `${m[1]}${m[2]}${m[3]}`;
  if ((m = t.match(/^(\d{1,2})([-/])(\d{1,2})\2(\d{4})$/))) return `${m[4]}${pad(Number(m[3]))}${pad(Number(m[1]))}`;
  if ((m = t.match(/^(\d{1,2})[-/](\d{4})$/))) {
    const month = Number(m[1]);
    const year = Number(m[2]);
    if (month < 1 || month > 12) return '';
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of the next month
    return `${pad(year, 4)}${pad(month)}${pad(last)}`;
  }
  return '';
}

function isValidYyyymmdd(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateRow(input: Record<string, any>, index: number): ImportRowResult {
  const row = normalizeHeaders(input); // keys are lower-case and trimmed (parseSheet already does this)
  const errors: string[] = [];
  const name = String(row['medicine name'] || row['name'] || '').trim();
  if (!name) errors.push('medicine name is required');

  const quantityToAdd = Number(
    ungrouped(row['quantity to add'] ?? row['quantitytoadd'] ?? row['available quantity'] ?? row['availableqty'] ?? 0) as number
  );
  if (!Number.isInteger(quantityToAdd) || quantityToAdd < 0) {
    errors.push('quantity to add must be a whole number >= 0');
  }

  const retailPrice = decimalOf(row['retail price'] || row['retailprice']);
  const wholesalePrice = decimalOf(row['wholesale price'] || row['wholesaleprice']);
  const purchasePrice = decimalOf(row['purchase price']);
  const mrp = decimalOf(row['mrp']);
  const gstPercent = decimalOf(row['gst percent']);
  if (!Number.isFinite(retailPrice) || retailPrice < 0) errors.push('retail price must be >= 0');
  if (!Number.isFinite(wholesalePrice) || wholesalePrice < 0) errors.push('wholesale price must be >= 0');
  if (!Number.isFinite(purchasePrice) || purchasePrice < 0) errors.push('purchase price must be >= 0');
  if (!Number.isFinite(mrp) || mrp < 0) errors.push('mrp must be >= 0');
  if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 100) {
    errors.push('gst percent must be between 0 and 100');
  }

  const batchNumber = String(row['batch number'] || row['batchnumber'] || '').trim().toUpperCase();
  const expiryRaw = row['expiry date'] || row['expirydate'] || '';
  const expiryDate = expiryOf(expiryRaw);
  if (quantityToAdd > 0 && !batchNumber) errors.push('batch number is required when quantity is added');
  // Q15 review: an expiry that was given must be readable, with or without stock added.
  if ((quantityToAdd > 0 || String(expiryRaw).trim() !== '') && !isValidYyyymmdd(expiryDate)) {
    errors.push(`expiry date must be a valid date: ${EXPIRY_FORMS}`);
  }
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (isValidYyyymmdd(expiryDate) && expiryDate < today) {
    errors.push('expired stock cannot be imported');
  }

  return {
    rowIndex: index + 2, // 1-based + header row
    medicineName: name,
    status: errors.length > 0 ? 'error' : 'valid',
    errors: errors.length > 0 ? errors : undefined,
    data: errors.length === 0
      ? { name, quantityToAdd, retailPrice, wholesalePrice,
          genericName: String(row['generic name'] || '').trim(),
          brandName: String(row['brand name'] || '').trim(),
          batchNumber,
          expiryDate,
          purchasePrice,
          mrp,
          gstPercent,
          hsnCode: String(row['hsn code'] || row['hsncode'] || '').trim(),
          rackLocation: String(row['rack location'] || '').trim(),
          prescriptionRequired: String(row['prescription required'] || '').toLowerCase() === 'yes',
          isActive: String(row['active status'] || 'yes').toLowerCase() !== 'no',
        }
      : undefined,
  };
}

function normalizeMedicineName(name: string): string {
  return name.trim();
}

@Service()
export class InventoryImportService {
  private importRepo: InventoryImportRepository;

  constructor(
    private inventoryItemRepo: InventoryItemRepository,
    private medicineRepo: MedicineRepository,
    private adjustmentRepo: InventoryAdjustmentRepository
  ) {
    this.importRepo = new InventoryImportRepository();
  }

  private async findOrCreateMedicine(
    rowData: Record<string, any>,
    session?: ClientSession
  ): Promise<IMedicine> {
    const name = normalizeMedicineName(String(rowData.name || ''));
    const nameKey = buildMedicineNameKey(name);
    const existing = await this.medicineRepo.findByNormalizedName(name, session);
    if (existing.length > 1) {
      throw new AppError({
        status: 409,
        code: 'MEDICINE_DUPLICATE_DATA',
        message: `Multiple medicines already exist with normalized name: ${name}. Resolve duplicates before import.`,
      });
    }
    if (existing.length === 1) {
      return existing[0];
    }

    try {
      return await this.medicineRepo.save({
        name,
        nameKey,
        genericName: rowData.genericName || undefined,
        brandName: rowData.brandName || undefined,
        prescriptionRequired: rowData.prescriptionRequired,
        hsnCode: rowData.hsnCode || undefined,
        gstPercent: Number.isFinite(rowData.gstPercent) ? rowData.gstPercent : 0,
        isActive: rowData.isActive,
      }, { session });
    } catch (_error) {
      const fallback = await this.medicineRepo.findByNormalizedName(name, session);
      if (fallback.length > 1) {
        throw new AppError({
          status: 409,
          code: 'MEDICINE_DUPLICATE_DATA',
          message: `Multiple medicines already exist with normalized name: ${name}. Resolve duplicates before import.`,
        });
      }
      if (!fallback[0]) {
        throw new AppError({
          status: 500,
          code: 'MEDICINE_CREATE_FAILED',
          message: `Failed to create or find medicine: ${name}`,
        });
      }
      return fallback[0];
    }
  }

  private async enrichPreviewRow(
    previewRow: ImportRowResult
  ): Promise<ImportRowResult> {
    if (previewRow.status === 'error' || !previewRow.data?.name) {
      return previewRow;
    }

    const matches = await this.medicineRepo.findByNormalizedName(previewRow.data.name);

    if (matches.length > 1) {
      return {
        ...previewRow,
        status: 'error',
        errors: [
          ...(previewRow.errors ?? []),
          'Multiple medicines matched this name. Please correct the medicine name before import.',
        ],
        data: {
          ...previewRow.data,
          medicineMatchStatus: 'duplicate',
        },
      };
    }

    if (matches.length === 1) {
      return {
        ...previewRow,
        data: {
          ...previewRow.data,
          medicineId: String(matches[0]._id),
          medicineMatchStatus: 'matched',
          matchedMedicineName: matches[0].name,
        },
      };
    }

    return {
      ...previewRow,
      data: {
        ...previewRow.data,
        medicineMatchStatus: 'not_found',
      },
    };
  }

  async preview(
    pharmacyId: string,
    uploadedBy: string,
    uploadedByRole: string,
    fileName: string,
    filePath: string,
    importMode: ImportMode = 'upsert'
  ): Promise<IInventoryImport> {
    let rows: Record<string, any>[];
    try {
      rows = readSheetRows(filePath);
    } catch (e) {
      await fs.unlink(filePath).catch(() => undefined);
      throw new AppError({ status: 400, code: 'PARSE_FAILED', message: 'Could not parse the uploaded file' });
    }

    // Q15 review: whatever fails after parsing (a medicine lookup, the record save), the upload is not left behind.
    try {
      const previewRows = await Promise.all(
        rows.map(async (row, i) => this.enrichPreviewRow(validateRow(row, i)))
      );
      const validRows = previewRows.filter((r) => r.status === 'valid').length;
      const errorRows = previewRows.filter((r) => r.status === 'error').length;

      return await this.importRepo.save({
        pharmacyId,
        uploadedBy,
        uploadedByRole,
        fileName,
        filePath,
        importMode,
        status: 'previewed',
        totalRows: rows.length,
        validRows,
        errorRows,
        previewRows,
      });
    } catch (error) {
      await fs.unlink(filePath).catch(() => undefined);
      throw error;
    }
  }

  async commit(importId: string, pharmacyId: string, retryFailedOnly = false): Promise<IInventoryImport> {
    const importRecord = await this.importRepo.findById(importId);
    if (!importRecord) {
      throw new AppError({ status: 404, code: 'IMPORT_NOT_FOUND', message: 'Import record not found' });
    }
    if (String(importRecord.pharmacyId) !== pharmacyId) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    const staleCommitting =
      retryFailedOnly &&
      importRecord.status === 'committing' &&
      Boolean(importRecord.updatedAt) &&
      new Date(importRecord.updatedAt!).getTime() < Date.now() - 15 * 60 * 1000;
    const allowedStatuses: ImportStatus[] = retryFailedOnly
      ? ['failed', 'partially_committed']
      : ['previewed'];
    if (staleCommitting) allowedStatuses.push('committing');
    if (!allowedStatuses.includes(importRecord.status)) {
      throw new AppError({
        status: 409,
        code: 'IMPORT_NOT_RETRYABLE',
        message: retryFailedOnly
          ? 'Only failed or partially committed imports can be retried'
          : 'Import is already committed or currently being processed',
      });
    }

    const claimed = await this.importRepo.update(
      { _id: importId, status: { $in: allowedStatuses } as any },
      { status: 'committing' }
    );
    if (!claimed) {
      throw new AppError({
        status: 409,
        code: 'IMPORT_ALREADY_PROCESSING',
        message: 'This import is already being processed',
      });
    }

    const previewRows: ImportRowResult[] = (importRecord.previewRows ?? []).map(
      (row) => ({ ...(row as unknown as ImportRowResult) })
    );
    const rowsToCommit = previewRows.filter((row) => {
      if (!retryFailedOnly) return row.status === 'valid';
      return row.status === 'failed' || (staleCommitting && row.status === 'valid');
    });
    const commitErrors: ImportCommitError[] = [];

    for (const row of rowsToCommit) {
      if (!row.data) continue;
      try {
        const outcome = await this.applyRowToInventory(
          importId,
          pharmacyId,
          importRecord,
          row
        );
        row.status = outcome;
        row.errors = undefined;
      } catch (error) {
        row.status = 'failed';
        const commitError: ImportCommitError = {
          rowIndex: row.rowIndex,
          medicineName: row.medicineName,
          error: error instanceof Error ? error.message : 'Unknown error while committing row',
          code: error instanceof AppError ? String(error.code || 'IMPORT_ROW_FAILED') : 'IMPORT_ROW_FAILED',
          retryable: !(error instanceof AppError && error.status && error.status >= 400 && error.status < 500),
        };
        row.errors = [commitError.error];
        commitErrors.push(commitError);
      }
    }

    const committedRows = previewRows.filter((row) => row.status === 'committed').length;
    const skippedRows = previewRows.filter((row) => row.status === 'skipped').length;
    const validationErrorRows = previewRows.filter((row) => row.status === 'error').length;
    const failedRows = previewRows.filter((row) => row.status === 'failed').length;
    const unresolvedRows = validationErrorRows + failedRows;
    const status: ImportStatus =
      unresolvedRows === 0
        ? 'committed'
        : committedRows + skippedRows === 0
          ? 'failed'
          : 'partially_committed';

    let updated = await this.importRepo.update(
      { _id: importId },
      {
        status,
        committedRows,
        failedRows: unresolvedRows,
        commitErrors,
        previewRows,
        committedAt: new Date(),
      }
    );

    const sourceDeleted = await this.deleteSourceFile(importRecord.filePath);
    if (sourceDeleted) {
      updated = await this.importRepo.update(
        { _id: importId },
        { sourceFileDeletedAt: new Date() }
      ) || updated;
    }

    return updated!;
  }

  private async deleteSourceFile(filePath: string): Promise<boolean> {
    try {
      await fs.unlink(filePath);
      return true;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return true;
      logger.error('Failed to clean up pharmacy inventory import file', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  // Each row's stock change and adjustment ledger entry commit together.
  // The unique source row key also prevents a retry from adding quantity twice.
  private async applyRowToInventory(
    importId: string,
    pharmacyId: string,
    importRecord: IInventoryImport,
    row: ImportRowResult
  ): Promise<'committed' | 'skipped'> {
    const existingAdjustment = await this.adjustmentRepo.findOne({
      pharmacyId,
      sourceType: 'inventory_import',
      sourceId: importId,
      sourceRowIndex: row.rowIndex,
    });
    if (existingAdjustment) return 'committed';

    const rowData = row.data!;
    const session = await startSession();
    try {
      let outcome: 'committed' | 'skipped' = 'committed';
      await session.withTransaction(async () => {
        const medicine = rowData.medicineId
          ? await this.medicineRepo.findById(rowData.medicineId, session)
          : await this.findOrCreateMedicine(rowData, session);
        if (!medicine?._id) {
          throw new AppError({
            status: 404,
            code: 'MEDICINE_NOT_FOUND',
            message: `Medicine not found for row ${row.rowIndex}`,
          });
        }
        const medicineId = String(medicine._id);
        const existingInventory = await this.inventoryItemRepo.findByPharmacyAndMedicine(
          pharmacyId,
          medicineId,
          session
        );
        if (
          (importRecord.importMode === 'create_only' && existingInventory) ||
          (importRecord.importMode === 'update_only' && !existingInventory)
        ) {
          outcome = 'skipped';
          return;
        }

        const quantityToAdd = Number(rowData.quantityToAdd || 0);
        if (quantityToAdd === 0) {
          await this.inventoryItemRepo.atomicUpsertItem(
            pharmacyId,
            medicineId,
            0,
            {
              retailPrice: rowData.retailPrice,
              wholesalePrice: rowData.wholesalePrice,
              purchasePrice: rowData.purchasePrice,
              rackLocation: rowData.rackLocation || undefined,
              isActive: rowData.isActive,
            },
            session
          );
          return;
        }

        const adjusted = await this.inventoryItemRepo.adjustBatchStock(
          pharmacyId,
          medicineId,
          {
            batchNumber: rowData.batchNumber,
            expiryDate: rowData.expiryDate,
            quantityDelta: quantityToAdd,
            purchasePrice: rowData.purchasePrice,
            mrp: rowData.mrp,
            retailPrice: rowData.retailPrice,
            wholesalePrice: rowData.wholesalePrice,
            rackLocation: rowData.rackLocation || undefined,
          },
          session
        );
        if (!adjusted) {
          throw new AppError({
            status: 409,
            code: 'INVENTORY_ROW_CONFLICT',
            message: `Inventory could not be adjusted for row ${row.rowIndex}`,
          });
        }

        await this.adjustmentRepo.save(
          {
            pharmacyId,
            medicineId,
            inventoryItemId: String(adjusted.item._id),
            adjustmentType: 'add',
            quantity: quantityToAdd,
            batchId: adjusted.batchId,
            batchNumber: rowData.batchNumber,
            expiryDate: rowData.expiryDate,
            availableQtyBefore: adjusted.availableQtyBefore,
            availableQtyAfter: adjusted.availableQtyAfter,
            sourceType: 'inventory_import',
            sourceId: importId,
            sourceRowIndex: row.rowIndex,
            reason: 'purchase',
            adjustedBy: String(importRecord.uploadedBy),
            adjustedByRole: importRecord.uploadedByRole,
          },
          { session }
        );
      });
      return outcome;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const adjustment = await this.adjustmentRepo.findOne({
          pharmacyId,
          sourceType: 'inventory_import',
          sourceId: importId,
          sourceRowIndex: row.rowIndex,
        });
        if (adjustment) return 'committed';
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async retry(importId: string, pharmacyId: string): Promise<IInventoryImport> {
    return this.commit(importId, pharmacyId, true);
  }

  async buildFailedRowsWorkbook(importId: string, pharmacyId: string): Promise<Buffer> {
    const record = await this.getImportById(importId, pharmacyId);
    const rows = (record.previewRows || [])
      .filter((row) => row.status === 'error' || row.status === 'failed')
      .map((row) => ({
        'row number': row.rowIndex,
        'medicine name': row.medicineName || '',
        ...(row.data || {}),
        error: (row.errors || []).join('; '),
      }));
    if (!rows.length) {
      throw new AppError({
        status: 404,
        code: 'NO_FAILED_IMPORT_ROWS',
        message: 'This import has no failed rows',
      });
    }
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Failed rows');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  async cleanupExpiredSourceFiles(retentionDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const records = await InventoryImportModel.find({
      sourceFileDeletedAt: { $exists: false },
      createdAt: { $lt: cutoff },
    })
      .select('_id filePath')
      .limit(500)
      .lean();

    let cleaned = 0;
    for (const record of records) {
      if (await this.deleteSourceFile(record.filePath)) {
        await this.importRepo.update(
          { _id: record._id },
          { sourceFileDeletedAt: new Date() }
        );
        cleaned += 1;
      }
    }
    return cleaned;
  }

  async getImports(pharmacyId: string, page = 1, limit = 20) {
    return this.importRepo.findByPharmacy(pharmacyId, page, limit);
  }

  async getImportById(id: string, pharmacyId: string): Promise<IInventoryImport> {
    const record = await this.importRepo.findById(id);
    if (!record) {
      throw new AppError({ status: 404, code: 'IMPORT_NOT_FOUND', message: 'Import record not found' });
    }
    if (String(record.pharmacyId) !== pharmacyId) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    return record;
  }
}
