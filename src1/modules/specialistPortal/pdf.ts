import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { CONFIG } from '@/config/config';

const execFileAsync = promisify(execFile);

/**
 * The one HTML → PDF step for server-written booking files (the doctor's prescription and, since assisted booking
 * phase 0, its dispensing copy): wkhtmltopdf (`WKHTMLTOPDF_BINARY`, default `wkhtmltopdf` on PATH) writes
 * `<UPLOAD_DIR>/bookings/<bookingId>/<fileName>`. Returns the stored `/api/static/...` URL. The HTML goes through a
 * temporary file that is always removed. Throws when the converter fails (the caller decides what that means).
 */
export async function writeBookingPdf(bookingId: string, fileName: string, html: string): Promise<string> {
  if (!/^[0-9a-f]{24}$/i.test(bookingId) || !/^[A-Za-z0-9_-]+\.pdf$/.test(fileName)) throw new Error('Invalid booking PDF name');
  const uploadDir = CONFIG.UPLOAD_DIR || path.join(process.cwd(), 'files');
  const bookingDir = path.join(uploadDir, 'bookings', bookingId);
  fs.mkdirSync(bookingDir, { recursive: true });
  const htmlPath = path.join(os.tmpdir(), `${fileName.replace(/\.pdf$/, '')}-${bookingId}-${Date.now()}.html`);
  try {
    fs.writeFileSync(htmlPath, html, 'utf8');
    await execFileAsync(process.env.WKHTMLTOPDF_BINARY || 'wkhtmltopdf', [htmlPath, path.join(bookingDir, fileName)]);
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
