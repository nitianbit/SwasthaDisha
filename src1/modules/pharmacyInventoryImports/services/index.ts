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
import { assertDeliverySupplier, DeliverySupplier, isHexId, suppliersOf } from '@/modules/pharmacyInventory/deliverySupplier';
import { istTodayYyyymmdd, istYear } from '@/modules/pharmacyInventory/businessDate';

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
 * Q16c: the column headers the importer reads, in template order (matched case-insensitively, see normalizeHeaders).
 * Older aliases are still read: name, quantitytoadd, available quantity, availableqty, retailprice, wholesaleprice,
 * batchnumber, expirydate, hsncode.
 */
export const IMPORT_COLUMNS = [
  'medicine name', 'quantity to add', 'batch number', 'expiry date', 'mrp', 'retail price', 'wholesale price',
  'purchase price', 'gst percent', 'hsn code', 'prescription required', 'generic name', 'brand name', 'rack location',
  'active status', 'supplier',
] as const;
const NAME_HEADERS = ['medicine name', 'name'];

/** Q16c: most stock one import row may add. */
export const MAX_QUANTITY_PER_ROW = 1_000_000;
/** Q16c: the latest expiry year accepted is the current IST year plus this. */
export const MAX_EXPIRY_YEARS_AHEAD = 15;

/** Q16c: an empty cell ("not given"). */
const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** Q16c: the first of the given columns that is not blank (a typed 0 counts; `||` used to skip it). */
function cellOf(row: Record<string, any>, ...keys: string[]): unknown {
  for (const key of keys) if (!isBlank(row[key])) return row[key];
  return undefined;
}

/**
 * A price or percentage cell as a number. A plain number stays as it is; text must be a plain decimal ("12", "12.50",
 * "-3") once grouping commas are removed, otherwise NaN, so "1,5" (a decimal comma) or "12 rs" is refused rather than
 * read as 1 or 12 the way parseFloat would. Q16c: an empty cell is `undefined` — "not given", the stored value is kept —
 * never 0 (that set prices to ₹0). Booleans and other types are NaN.
 */
export function decimalOf(value: unknown): number | undefined {
  if (isBlank(value)) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const t = String(ungrouped(value)).trim();
  return /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/** Q16c: GST percent: a number ("18"), text with a percent sign ("18%"), or a percent cell (0.18 shown as 18%). */
export function gstPercentOf(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (m) return Number(m[1]);
  }
  return decimalOf(value);
}

/**
 * Q16c: the quantity to add: a whole number cell, or text of digits only (grouping commas allowed). "1e3", "0x10",
 * "+5", "5.0" as text, booleans and anything else are NaN (refused). An empty cell is 0.
 */
export function quantityOf(value: unknown): number {
  if (isBlank(value)) return 0;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const t = String(ungrouped(value)).trim();
  return /^\d+$/.test(t) ? Number(t) : NaN;
}

/**
 * Q15 re-review: a numeric cell typed with grouping commas — international ("1,000,000") or Indian ("10,00,000") — is
 * read without them; any other value is returned unchanged (and parsed as before).
 */
export function ungrouped(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return /^-?(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d+)?$/.test(t) ? t.replace(/,/g, '') : value;
}

/** Q16c: a number format's date/time tokens, without its quoted text, escapes, [colour/locale] parts and fill/pad marks. */
function formatTokens(z: string): string {
  return z.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '').replace(/[_*]./g, '').toLowerCase();
}

/** Q16c: a date format that shows only month and year ("mmm-yy", "mm/yyyy", "mmmm yyyy"): no day, no time. */
export function isMonthYearFormat(z: unknown): boolean {
  if (typeof z !== 'string') return false;
  const t = formatTokens(z);
  return t.includes('y') && t.includes('m') && !/[dhs]/.test(t);
}

/** Q16c: a number format that shows a percentage ("0%", "0.00%"). */
function isPercentFormat(z: unknown): boolean {
  return typeof z === 'string' && formatTokens(z).includes('%');
}

/** The last day of a month (day 0 of the next one). */
const lastDayOf = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** "YYYY-MM-DD" for a calendar date; for a month-year format, the last day of that month (as "EXP 12/2027" is read). */
function calendarText(y: number, m: number, d: number, monthYearOnly: boolean): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(monthYearOnly ? lastDayOf(y, m) : d)}`;
}

/**
 * Q16c: the raw text of the first sheet's ISO date cells (`t="d"`, e.g. `<v>2027-12-31T00:00:00</v>`) of an .xlsx, by
 * cell address. The library turns such a cell into a date number, converting any time-zone offset written in it; the
 * calendar date is read from this text instead, with no conversion. Empty when the file is not an .xlsx.
 */
function isoDateCellTexts(workbook: XLSX.WorkBook): Map<string, string> {
  const out = new Map<string, string>();
  const files = (workbook as unknown as { files?: Record<string, { content?: unknown }> }).files;
  if (!files) return out;
  const text = (name: string): string => {
    const entry = files[name] ?? files[`/${name}`];
    return entry?.content ? Buffer.from(entry.content as Uint8Array).toString('utf8') : '';
  };
  const sheetTag = text('xl/workbook.xml').match(/<(?:\w+:)?sheet\b[^>]*>/)?.[0] ?? '';
  const relId = sheetTag.match(/\b(?:\w+:)?id="([^"]+)"/)?.[1];
  if (!relId) return out;
  const rel = text('xl/_rels/workbook.xml.rels').match(new RegExp(`<Relationship\\b[^>]*\\bId="${relId.replace(/[^\w-]/g, '')}"[^>]*>`))?.[0] ?? '';
  const target = rel.match(/\bTarget="([^"]+)"/)?.[1];
  if (!target) return out;
  const xml = text(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  for (const m of xml.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
    const attrs = m[1];
    if (!/\bt="d"/.test(attrs)) continue;
    const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
    const v = (m[2] ?? '').match(/<(?:\w+:)?v>([^<]*)<\/(?:\w+:)?v>/)?.[1];
    if (ref && v !== undefined) out.set(ref, v.trim());
  }
  return out;
}

/**
 * Q15 review: the first sheet as rows of raw values with normalized headers. CSV/text files are read with `raw: true`,
 * so every value stays the text that was typed (the library would otherwise turn "12-05-2027" into a US month-first
 * date). In a spreadsheet, ONLY a real date cell is a date: it becomes "YYYY-MM-DD", with no time zone involved:
 *  - a number with a date format: from the library's date code of its serial (1904 workbooks on their base);
 *  - Q16c: an ISO date cell (`t="d"`): the calendar date written in the cell, as typed (no offset conversion);
 *  - Q16c: a date format with month and year only ("mmm-yy", "mm/yyyy"): the LAST day of that month, as for text.
 * Q16c: a number with a percent format becomes text "18%" (a GST cell 0.18 shown as 18%); other columns refuse it.
 * A plain number stays a number.
 */
export function readSheetRows(filePath: string): Record<string, any>[] {
  const workbook = XLSX.readFile(filePath, { raw: true, cellDates: false, cellNF: true, bookFiles: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  // Q15 re-review: a workbook on the 1904 date system counts its serials from 1904-01-01 (1462 days after the 1900 base).
  const offset = workbook.Workbook?.WBProps?.date1904 ? 1462 : 0;
  const isoTexts = isoDateCellTexts(workbook);
  for (const [addr, cell] of Object.entries(sheet ?? {})) {
    if (addr.startsWith('!') || !cell || typeof cell !== 'object') continue;
    const c = cell as XLSX.CellObject;
    const monthYear = isMonthYearFormat(c.z);
    const iso = isoTexts.get(addr);
    if (iso !== undefined) {
      const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/);
      Object.assign(c, { t: 's', v: m ? calendarText(+m[1], +m[2], +m[3], monthYear) : `#date-cell:${iso}`, w: undefined, z: undefined });
    } else if (c.t === 'n' && typeof c.v === 'number' && typeof c.z === 'string' && XLSX.SSF.is_date(c.z)) {
      const serial = Math.floor(c.v) + offset;
      const d = serial >= 1 ? XLSX.SSF.parse_date_code(serial) : null;
      Object.assign(c, { t: 's', v: d && d.y && d.m && d.d ? calendarText(d.y, d.m, d.d, monthYear) : `#date-cell:${c.v}`, w: undefined, z: undefined });
    } else if (c.t === 'n' && typeof c.v === 'number' && isPercentFormat(c.z)) {
      Object.assign(c, { t: 's', v: `${Math.round(c.v * 100 * 1e6) / 1e6}%`, w: undefined, z: undefined });
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
    return `${pad(year, 4)}${pad(month)}${pad(lastDayOf(year, month))}`;
  }
  return '';
}

/**
 * Q16c: how a text slash date `A/B/YYYY` reads. Dates are read day first; `month_first` when it is valid ONLY as
 * month first (12/31/2027), `ambiguous` when both orders give different valid dates (05/06/2027), else null.
 */
export function slashDateOrder(value: unknown): 'month_first' | 'ambiguous' | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a >= 1 && a <= 12 && b > 12 && b <= 31) return 'month_first';
  if (a >= 1 && a <= 12 && b >= 1 && b <= 12 && a !== b) return 'ambiguous';
  return null;
}

function isValidYyyymmdd(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Q16c: yes/no cells: yes, y, true, 1 / no, n, false, 0 (any case); empty gives `fallback`; anything else null. */
function yesNoOf(value: unknown, fallback: boolean): boolean | null {
  if (isBlank(value)) return fallback;
  const t = String(value).trim().toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(t)) return true;
  if (['no', 'n', 'false', '0'].includes(t)) return false;
  return null;
}

/** Q16c: the accepted expiry forms, for pharmacies (template notes; the web shows the same). */
export const EXPIRY_RULES = 'Expiry date: write the day first. Accepted: DD-MM-YYYY (31-12-2027), DD/MM/YYYY (31/12/2027), ' +
  'YYYY-MM-DD (2027-12-31), YYYYMMDD (20271231), MM/YYYY or MM-YYYY as printed on packs (12/2027 = 31-12-2027, the last ' +
  'day of that month), or a spreadsheet date cell. A month-first date (12/31/2027) is refused, and so is every date ' +
  'like 05/06/2027 in a file that has one. Two-digit years and month names are refused.';

/** Q16c: the "how to fill" notes of the import template. */
export const TEMPLATE_HOW_TO_FILL = [
  'Keep the column names in the first row as they are. One row per medicine batch. Delete the example row.',
  'Medicine name: required. A name not yet in the catalogue creates a new medicine.',
  `Quantity to add: a whole number from 0 to ${MAX_QUANTITY_PER_ROW} (0 only updates prices and details).`,
  'Batch number: required when quantity is added.',
  EXPIRY_RULES,
  `The expiry must not be in the past nor more than ${MAX_EXPIRY_YEARS_AHEAD} years away.`,
  'MRP, retail, wholesale and purchase price: leave a price empty to keep the current one. A medicine with no retail price is not shown to customers until it has one.',
  'GST percent: 0 to 100, written 18, 18% or as a percent cell.',
  'Prescription required: yes or no. Left empty, a new medicine needs a prescription.',
  'Supplier (optional): the name of one of your suppliers as on your supplier list, or its id. Recorded for rows that add stock.',
  'Active status: yes or no (empty means yes).',
];

/** Q16c: the template's example row (its name says to delete it). */
export const TEMPLATE_EXAMPLE_MARK = '(example - delete this row)';

/** Q16c: a row whose medicine name starts with "#" is a comment (the CSV template's notes) and is not imported. */
export function isCommentRow(row: Record<string, any>): boolean {
  return String(cellOf(row, ...NAME_HEADERS) ?? '').trim().startsWith('#');
}

function validateRow(input: Record<string, any>, index: number): ImportRowResult & { expiryRaw: unknown } {
  const row = normalizeHeaders(input); // keys are lower-case and trimmed (parseSheet already does this)
  const errors: string[] = [];
  const name = String(cellOf(row, ...NAME_HEADERS) ?? '').trim();
  if (!name) errors.push('medicine name is required');
  if (name.toLowerCase().includes(TEMPLATE_EXAMPLE_MARK)) errors.push("this is the template's example row; delete it");

  const quantityToAdd = quantityOf(cellOf(row, 'quantity to add', 'quantitytoadd', 'available quantity', 'availableqty'));
  if (!Number.isSafeInteger(quantityToAdd) || quantityToAdd < 0 || quantityToAdd > MAX_QUANTITY_PER_ROW) {
    errors.push(`quantity to add must be a whole number from 0 to ${MAX_QUANTITY_PER_ROW.toLocaleString('en-IN')}`);
  }

  // Q16c: an empty price cell is "not given" (undefined): the stored price is kept.
  const retailPrice = decimalOf(cellOf(row, 'retail price', 'retailprice'));
  const wholesalePrice = decimalOf(cellOf(row, 'wholesale price', 'wholesaleprice'));
  const purchasePrice = decimalOf(cellOf(row, 'purchase price'));
  const mrp = decimalOf(cellOf(row, 'mrp'));
  const gstPercent = gstPercentOf(cellOf(row, 'gst percent'));
  const badPrice = (v: number | undefined) => v !== undefined && (!Number.isFinite(v) || v < 0);
  if (badPrice(retailPrice)) errors.push('retail price must be >= 0');
  if (badPrice(wholesalePrice)) errors.push('wholesale price must be >= 0');
  if (badPrice(purchasePrice)) errors.push('purchase price must be >= 0');
  if (badPrice(mrp)) errors.push('mrp must be >= 0');
  if (gstPercent !== undefined && (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 100)) {
    errors.push('gst percent must be between 0 and 100 (for example 18, 18% or a percent cell)');
  }

  const batchNumber = String(cellOf(row, 'batch number', 'batchnumber') ?? '').trim().toUpperCase();
  const expiryRaw = cellOf(row, 'expiry date', 'expirydate') ?? '';
  const expiryDate = expiryOf(expiryRaw);
  if (quantityToAdd > 0 && !batchNumber) errors.push('batch number is required when quantity is added');
  // Q15 review: an expiry that was given must be readable, with or without stock added.
  if ((quantityToAdd > 0 || String(expiryRaw).trim() !== '') && !isValidYyyymmdd(expiryDate)) {
    errors.push(slashDateOrder(expiryRaw) === 'month_first'
      ? `expiry date ${String(expiryRaw).trim()} is written month first; dates are read day first: write it as DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD`
      : `expiry date must be a valid date: ${EXPIRY_FORMS}`);
  }
  const today = istTodayYyyymmdd();
  if (isValidYyyymmdd(expiryDate) && expiryDate < today) {
    errors.push('expired stock cannot be imported');
  }
  if (isValidYyyymmdd(expiryDate) && Number(expiryDate.slice(0, 4)) > istYear() + MAX_EXPIRY_YEARS_AHEAD) {
    errors.push(`expiry date must be within ${MAX_EXPIRY_YEARS_AHEAD} years`);
  }

  // Q16c (owner decision): a medicine the import creates needs a prescription unless the file says "no".
  const prescriptionRequired = yesNoOf(cellOf(row, 'prescription required'), true);
  if (prescriptionRequired === null) errors.push('prescription required must be yes or no');
  const supplier = String(cellOf(row, 'supplier') ?? '').trim();

  return {
    rowIndex: index + 2, // 1-based + header row
    medicineName: name,
    status: errors.length > 0 ? 'error' : 'valid',
    errors: errors.length > 0 ? errors : undefined,
    expiryRaw,
    data: errors.length === 0
      ? { name, quantityToAdd, retailPrice, wholesalePrice,
          genericName: String(cellOf(row, 'generic name') ?? '').trim(),
          brandName: String(cellOf(row, 'brand name') ?? '').trim(),
          batchNumber,
          expiryDate,
          purchasePrice,
          mrp,
          gstPercent,
          hsnCode: String(cellOf(row, 'hsn code', 'hsncode') ?? '').trim(),
          rackLocation: String(cellOf(row, 'rack location') ?? '').trim(),
          prescriptionRequired: prescriptionRequired as boolean,
          isActive: String(cellOf(row, 'active status') ?? 'yes').toLowerCase() !== 'no',
          ...(supplier ? { supplier } : {}),
        }
      : undefined,
  };
}

/**
 * Q16c: rows of one file, validated. Dates are read day first; when another row of the same file can only be a
 * month-first date (12/31/2027), the file was written month first, so every ambiguous slash date in it (05/06/2027) is
 * refused rather than read as 5 June.
 */
export function validateRows(rows: Record<string, any>[]): ImportRowResult[] {
  const checked = rows.map((row, i) => ({ row, i })).filter(({ row }) => !isCommentRow(row))
    .map(({ row, i }) => validateRow(row, i));
  const evidence = checked.find((r) => slashDateOrder(r.expiryRaw) === 'month_first');
  return checked.map(({ expiryRaw, ...r }) => {
    if (!evidence || slashDateOrder(expiryRaw) !== 'ambiguous') return r;
    const message = `this file writes dates month first (row ${evidence.rowIndex}: ${String(evidence.expiryRaw).trim()}), ` +
      `so ${String(expiryRaw).trim()} cannot be read safely; write it as DD-MM-YYYY or YYYY-MM-DD`;
    return { ...r, status: 'error', errors: [...(r.errors ?? []), message], data: undefined };
  });
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

  /**
   * Q16c: the supplier named on a row ("supplier" column: the supplier's name as on the pharmacy's list, any case, or
   * its id) and the one chosen for the whole file must agree; it must be one of the pharmacy's own active suppliers.
   */
  private resolveRowSupplier(row: ImportRowResult, suppliers: DeliverySupplier[], fileSupplier?: DeliverySupplier): ImportRowResult {
    if (row.status !== 'valid' || !row.data) return row;
    const { supplier: named, ...data } = row.data as Record<string, any>;
    const fail = (message: string): ImportRowResult => ({ ...row, status: 'error', errors: [...(row.errors ?? []), message], data: undefined });
    let chosen = fileSupplier;
    if (named) {
      const key = String(named).trim().replace(/\s+/g, ' ').toLowerCase();
      const matches = isHexId(named)
        ? suppliers.filter((s) => s.supplierId === String(named).toLowerCase())
        : suppliers.filter((s) => s.displayName.trim().replace(/\s+/g, ' ').toLowerCase() === key);
      const active = matches.filter((s) => s.state === 'active');
      if (!matches.length) return fail(`supplier "${named}" is not one of your suppliers`);
      if (!active.length) return fail(`supplier "${named}" is archived`);
      if (active.length > 1) return fail(`more than one of your suppliers is named "${named}"; write the supplier id instead`);
      if (fileSupplier && active[0].supplierId !== fileSupplier.supplierId) {
        return fail(`supplier "${named}" differs from the supplier chosen for this file (${fileSupplier.displayName})`);
      }
      chosen = active[0];
    }
    return { ...row, data: { ...data, ...(chosen ? { supplierId: chosen.supplierId, supplierName: chosen.displayName } : {}) } };
  }

  async preview(
    pharmacyId: string,
    uploadedBy: string,
    uploadedByRole: string,
    fileName: string,
    filePath: string,
    importMode: ImportMode = 'upsert',
    supplierId?: string
  ): Promise<IInventoryImport> {
    let rows: Record<string, any>[];
    let fileSupplier: DeliverySupplier | undefined;
    try {
      // Q16c: one supplier for the whole file (optional): the pharmacy's own, active supplier.
      if (supplierId !== undefined) fileSupplier = await assertDeliverySupplier(pharmacyId, supplierId);
      try {
        rows = readSheetRows(filePath);
      } catch (e) {
        throw new AppError({ status: 400, code: 'PARSE_FAILED', message: 'Could not parse the uploaded file' });
      }
      // Q16c: an empty sheet, or a file that is not a stock sheet (junk with an allowed extension), is refused.
      if (!rows.some((row) => !isCommentRow(row))) {
        throw new AppError({ status: 400, code: 'IMPORT_FILE_EMPTY', message: 'The file has no rows to import (the first sheet is empty)' });
      }
      if (!NAME_HEADERS.some((h) => h in rows[0])) {
        throw new AppError({ status: 400, code: 'IMPORT_COLUMNS_MISSING',
          message: `The first row must hold the column names, including "medicine name". Columns read: ${IMPORT_COLUMNS.join(', ')}` });
      }
    } catch (error) {
      await fs.unlink(filePath).catch(() => undefined);
      throw error;
    }

    // Q15 review: whatever fails after parsing (a medicine lookup, the record save), the upload is not left behind.
    try {
      const suppliers = await suppliersOf(pharmacyId);
      const previewRows = await Promise.all(
        validateRows(rows).map(async (row) => this.enrichPreviewRow(this.resolveRowSupplier(row, suppliers, fileSupplier)))
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
        ...(fileSupplier ? { supplierId: fileSupplier.supplierId } : {}),
        status: 'previewed',
        totalRows: previewRows.length,
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

    // Q16c: taking over a stale 'committing' import is a compare-and-set on the updatedAt that was judged stale (the
    // claim itself moves updatedAt), so two retries arriving together cannot both take it over.
    const claimFilter: Record<string, unknown> = staleCommitting
      ? { _id: importId, status: 'committing', updatedAt: importRecord.updatedAt }
      : { _id: importId, status: { $in: allowedStatuses.filter((s) => s !== 'committing') } };
    const claimed = await this.importRepo.update(claimFilter as any, { status: 'committing' });
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
        // Q16c: the delivery's supplier is checked again when the stock is added (it may have been archived since).
        const supplier = quantityToAdd > 0 && rowData.supplierId
          ? await assertDeliverySupplier(pharmacyId, rowData.supplierId, session)
          : undefined;
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
            ...(supplier ? { supplierId: supplier.supplierId } : {}),
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

  /**
   * Q16c: the import template: the columns exactly as the importer reads them, one example row (expiry written
   * 31-12-2027, day first) and how to fill it — a second sheet in the .xlsx, "#" comment rows in the .csv (rows whose
   * medicine name starts with "#" are not imported).
   */
  buildTemplate(format: 'xlsx' | 'csv'): { body: Buffer; contentType: string; fileName: string } {
    const example: Record<(typeof IMPORT_COLUMNS)[number], string | number> = {
      'medicine name': `Paracetamol 500 mg tablet ${TEMPLATE_EXAMPLE_MARK}`, 'quantity to add': 100, 'batch number': 'PCM2412',
      'expiry date': '31-12-2027', mrp: 30, 'retail price': 28, 'wholesale price': 25, 'purchase price': 20, 'gst percent': 12,
      'hsn code': '3004', 'prescription required': 'no', 'generic name': 'Paracetamol', 'brand name': 'Example brand',
      'rack location': 'A-3', 'active status': 'yes', supplier: '',
    };
    const notes = TEMPLATE_HOW_TO_FILL;
    if (format === 'csv') {
      const cell = (v: unknown) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const lines = [IMPORT_COLUMNS.join(','), IMPORT_COLUMNS.map((c) => cell(example[c])).join(','),
        ...notes.map((n) => cell(`# ${n}`))];
      return { body: Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8'), contentType: 'text/csv; charset=utf-8', fileName: 'inventory-import-template.csv' };
    }
    const workbook = XLSX.utils.book_new();
    const stock = XLSX.utils.aoa_to_sheet([[...IMPORT_COLUMNS], IMPORT_COLUMNS.map((c) => example[c])]);
    stock['!cols'] = IMPORT_COLUMNS.map((c) => ({ wch: Math.max(12, c.length + 2) }));
    stock['!cols'][0] = { wch: 50 };
    XLSX.utils.book_append_sheet(workbook, stock, 'Stock'); // the importer reads the first sheet only
    const howTo = XLSX.utils.aoa_to_sheet([['How to fill the stock sheet'], ...notes.map((n) => [n])]);
    howTo['!cols'] = [{ wch: 140 }];
    XLSX.utils.book_append_sheet(workbook, howTo, 'How to fill');
    return {
      body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: 'inventory-import-template.xlsx',
    };
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
