import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { CONFIG } from '@/config/config';

const execFileAsync = promisify(execFile);

/** The converter is stopped after this long (`PDF_CONVERTER_TIMEOUT_MS`, default 30 s) and the write fails. */
export const pdfConverterTimeoutMs = (): number => {
  const v = Number(process.env.PDF_CONVERTER_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 30_000;
};

/**
 * The one HTML → PDF step for server-written booking files (the doctor's prescription and, since assisted booking
 * phase 0, its dispensing copy): wkhtmltopdf (`WKHTMLTOPDF_BINARY`, default `wkhtmltopdf` on PATH) writes
 * `<UPLOAD_DIR>/bookings/<bookingId>/<fileName>`. Returns the stored `/api/static/...` URL. The HTML goes through a
 * temporary file of its own (random name: concurrent calls never share one) that is always removed. The converter is
 * killed after `pdfConverterTimeoutMs()`. Throws when the converter fails (the caller decides what that means).
 */
export async function writeBookingPdf(bookingId: string, fileName: string, html: string): Promise<string> {
  if (!/^[0-9a-f]{24}$/i.test(bookingId) || !/^[A-Za-z0-9_-]+\.pdf$/.test(fileName)) throw new Error('Invalid booking PDF name');
  const uploadDir = CONFIG.UPLOAD_DIR || path.join(process.cwd(), 'files');
  const bookingDir = path.join(uploadDir, 'bookings', bookingId);
  fs.mkdirSync(bookingDir, { recursive: true });
  const htmlPath = path.join(os.tmpdir(), `${fileName.replace(/\.pdf$/, '')}-${bookingId}-${randomBytes(8).toString('hex')}.html`);
  try {
    fs.writeFileSync(htmlPath, html, { encoding: 'utf8', flag: 'wx' });
    try {
      await execFileAsync(process.env.WKHTMLTOPDF_BINARY || 'wkhtmltopdf', [htmlPath, path.join(bookingDir, fileName)],
        { timeout: pdfConverterTimeoutMs(), killSignal: 'SIGKILL' });
    } catch (error) {
      try { fs.unlinkSync(path.join(bookingDir, fileName)); } catch { /* nothing written */ }
      throw error;
    }
    return `/api/static/bookings/${bookingId}/${fileName}`;
  } finally {
    try { fs.unlinkSync(htmlPath); } catch { /* ignore temp cleanup errors */ }
  }
}

/** Removes a booking PDF written by writeBookingPdf (a copy that lost a race); never anything outside that folder. */
export function removeBookingPdf(url: string): void {
  const m = /^\/api\/static\/(bookings\/[0-9a-f]{24}\/[A-Za-z0-9_-]+\.pdf)$/i.exec(url);
  if (!m) return;
  const uploadDir = CONFIG.UPLOAD_DIR || path.join(process.cwd(), 'files');
  try { fs.unlinkSync(path.join(uploadDir, m[1]!)); } catch { /* already gone */ }
}

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Phase 3d (§25.7.3, DR13, DR14): the box printed under "Tests advised" on the prescription PDF and on its dispensing
 * copy: the Jansetu brand and the recommended-tests code (`formatted`, e.g. `ABCD-EFGH`). Inline styles, so it reads the
 * same in both documents.
 */
export function recommendationBoxHtml(formatted: string): string {
  return `<div style="margin:12px 0 4px;padding:10px 12px;border:2px solid #0f766e;border-radius:8px;color:#134e4a;">
  <div style="font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">Jansetu</div>
  <div style="font-size:15px;margin-top:4px;">Recommended tests code: <strong style="font-size:18px;letter-spacing:0.08em;">${escapeHtml(formatted)}</strong></div>
  <div style="font-size:12px;margin-top:4px;">Show this code and your mobile number at a Jansetu pharmacy or lab to book these tests.</div>
</div>`;
}

/** YYYYMMDD → "November 22, 2026" (the value itself when it does not parse). */
export function formatDisplayDate(date: string): string {
  if (!date || date.length !== 8) return date || 'N/A';
  const value = new Date(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)));
  if (Number.isNaN(value.getTime())) return date;
  return value.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Whole years since a YYYYMMDD date of birth; null when there is none. */
export function ageFromDob(dateOfBirth?: string): number | null {
  if (!dateOfBirth || dateOfBirth.length !== 8) return null;
  const dob = new Date(Number(dateOfBirth.slice(0, 4)), Number(dateOfBirth.slice(4, 6)) - 1, Number(dateOfBirth.slice(6, 8)));
  if (Number.isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age -= 1;
  return age;
}

/** Whether a booking PDF URL written by writeBookingPdf is on disk (a stored copy whose file vanished is repaired). */
export function bookingPdfExists(url: unknown): boolean {
  const m = typeof url === 'string' ? /^\/api\/static\/(bookings\/[0-9a-f]{24}\/[A-Za-z0-9_-]+\.pdf)$/i.exec(url) : null;
  if (!m) return false;
  const uploadDir = CONFIG.UPLOAD_DIR || path.join(process.cwd(), 'files');
  return fs.existsSync(path.join(uploadDir, m[1]!));
}
