import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { AppError } from '@/modules/common/types';
import type { IInvoice, IInvoiceEvent } from '@/modules/partners/types';

const execFileAsync = promisify(execFile);

const esc = (v: unknown) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const rupees = (minor: number) =>
  `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Business dates are India dates (the same clock the financial year and numbering use). */
export const indiaDate = (d: Date | string) => {
  const ist = new Date(new Date(d).getTime() + 330 * 60_000).toISOString();
  return `${ist.slice(8, 10)}-${ist.slice(5, 7)}-${ist.slice(0, 4)}`;
};

const TITLES = { tax_invoice: 'Tax Invoice', bill_of_supply: 'Bill of Supply', commercial_invoice: 'Invoice' } as const;

/** Status of the bill after the given events (events are in lifecycle order). */
export function statusAfter(events: IInvoiceEvent[]): { label: string; detail?: string } {
  let label = 'Unpaid';
  let detail: string | undefined;
  for (const e of events) {
    if (e.kind === 'payment') {
      label = 'Paid';
      detail = `${e.mode?.toUpperCase()}${e.reference ? ` · Ref ${e.reference}` : ''} · ${indiaDate(e.at)}`;
    } else if (e.kind === 'cancellation') {
      label = 'Cancelled';
      detail = `${e.reason ?? ''} · ${indiaDate(e.at)}`;
    }
  }
  return { label, detail };
}

/** Self-contained HTML of the immutable invoice plus the given events; every value is escaped. */
export function renderInvoiceHtml(inv: IInvoice, events: IInvoiceEvent[]): string {
  const showTax = inv.documentKind === 'tax_invoice';
  const status = statusAfter(events);
  const rows = inv.items.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}${l.sac ? ` <small>SAC ${esc(l.sac)}</small>` : ''}${l.hsn ? ` <small>HSN ${esc(l.hsn)}</small>` : ''}</td>
    <td class="n">${l.qty}</td><td class="n">${rupees(l.unitPriceMinor)}</td><td class="n">${rupees(l.discountMinor)}</td>
    ${showTax ? `<td class="n">${l.gstRate}%</td>` : ''}<td class="n">${rupees(l.amountMinor)}</td></tr>`).join('');
  const t = inv.totals;
  const taxRows = showTax
    ? (t.igstMinor > 0
      ? `<tr><td>IGST</td><td class="n">${rupees(t.igstMinor)}</td></tr>`
      : `<tr><td>CGST</td><td class="n">${rupees(t.cgstMinor)}</td></tr><tr><td>SGST</td><td class="n">${rupees(t.sgstMinor)}</td></tr>`)
    : '';
  const s = inv.supplier;
  const c = inv.customer;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.serial)}</title><style>
body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:24px}h1{font-size:18px;margin:0 0 4px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:5px;text-align:left;vertical-align:top}
td.n,th.n{text-align:right}.grid{display:flex;justify-content:space-between;margin:12px 0}.status{font-weight:bold}
small{color:#555}.note{margin-top:12px;color:#444}</style></head><body>
<h1>${TITLES[inv.documentKind]}</h1>
<div class="grid"><div><strong>${esc(s.name)}</strong>${s.legalName ? `<br>${esc(s.legalName)}` : ''}<br>${esc(s.address)}
${s.gstin ? `<br>GSTIN: ${esc(s.gstin)}` : ''}${s.pan ? `<br>PAN: ${esc(s.pan)}` : ''}<br>State code: ${esc(s.placeOfSupply)}</div>
<div><strong>No.</strong> ${esc(inv.serial)}<br><strong>Date</strong> ${indiaDate(inv.issuedAt)}
<br><span class="status">${esc(status.label)}</span>${status.detail ? `<br><small>${esc(status.detail)}</small>` : ''}</div></div>
<div><strong>Billed to:</strong> ${esc(c.name)}${c.age !== undefined ? `, ${esc(c.age)}` : ''}${c.gender ? ` ${esc(c.gender)}` : ''}
${c.gstin ? `<br>GSTIN: ${esc(c.gstin)}` : ''}${c.placeOfSupply ? `<br>Place of supply: ${esc(c.placeOfSupply)}` : ''}</div>
<table style="margin-top:12px"><thead><tr><th>#</th><th>Item</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Discount</th>
${showTax ? '<th class="n">GST</th>' : ''}<th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<table style="margin-top:8px;width:40%;margin-left:auto"><tbody>
<tr><td>Taxable value</td><td class="n">${rupees(t.taxableMinor)}</td></tr>${taxRows}
<tr><td><strong>Total</strong></td><td class="n"><strong>${rupees(t.totalMinor)}</strong></td></tr></tbody></table>
${inv.documentKind === 'bill_of_supply' && s.gstin ? '<p class="note">Composition taxable person / exempt supply — tax not chargeable.</p>' : ''}
${inv.documentKind === 'commercial_invoice' ? '<p class="note">Supplier not registered under GST.</p>' : ''}
</body></html>`;
}

/** PDF bytes via wkhtmltopdf (same renderer as prescriptions). Nothing is stored; temp files are removed. */
export async function renderInvoicePdf(inv: IInvoice, events: IInvoiceEvent[]): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sd-invoice-'));
  const html = path.join(dir, 'invoice.html');
  const pdf = path.join(dir, 'invoice.pdf');
  try {
    await writeFile(html, renderInvoiceHtml(inv, events), 'utf8');
    try {
      await execFileAsync(process.env.WKHTMLTOPDF_BINARY || 'wkhtmltopdf', ['--quiet', '--disable-javascript', '--disable-local-file-access', '--allow', dir, html, pdf]);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        throw new AppError({ status: 503, code: 'PDF_RENDERER_UNAVAILABLE', message: 'PDF rendering is not available on this server' });
      }
      throw new AppError({ status: 500, code: 'INVOICE_PDF_FAILED', message: 'Could not render the invoice PDF' });
    }
    return await readFile(pdf);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
