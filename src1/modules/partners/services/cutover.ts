import { CONFIG } from '@/config/config';

/**
 * Q3 §7a: every booking is settled by exactly one system. Bookings created at or after SETTLEMENT_CUTOVER_AT go to the
 * ledger; everything else (and everything while the date is unset or invalid) stays with the legacy monthly payouts.
 * Legacy payout queries select `settlementSystem != 'ledger'`; ledger earnings require `settlementSystem == 'ledger'`.
 *
 * Q16a: accepted forms (anything else is invalid: logged as an error at startup and treated as unset, i.e. legacy):
 *   - an ISO date-time with a zone, e.g. `2026-12-01T00:00:00+05:30` or `2026-11-30T18:30:00Z`;
 *   - an ISO date-time without a zone, e.g. `2026-12-01T09:30` or `2026-12-01T09:30:00` — read as India time (IST);
 *   - a date only, `2026-12-01` — midnight India time (IST) at the start of that day.
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;
const ZONED_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseSettlementCutover(raw: unknown): { at: Date | null; error?: string } {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { at: null };
  const v = String(raw).trim();
  let text: string | null = null;
  if (DATE_ONLY.test(v)) text = `${v}T00:00:00+05:30`;
  else if (LOCAL_DATE_TIME.test(v)) text = `${v}+05:30`;
  else if (ZONED_DATE_TIME.test(v)) text = v;
  const at = text ? new Date(text) : null;
  // A date that does not exist (e.g. 2026-02-30, also inside a date-time) is refused, never rolled over.
  const day = v.slice(0, 10);
  const realDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())
    && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
  const real = !!at && !Number.isNaN(at.getTime()) && realDay;
  if (!real) {
    return { at: null, error: `SETTLEMENT_CUTOVER_AT=${JSON.stringify(v)} is not a valid cutover (use 2026-12-01, 2026-12-01T09:30 (India time) or an ISO time with a zone); every booking stays with the legacy payouts until it is fixed` };
  }
  return { at: at! };
}

export function settlementCutoverAt(): Date | null {
  return parseSettlementCutover(CONFIG.SETTLEMENT_CUTOVER_AT).at;
}

/** Q16a: called once at startup — an invalid value is logged as an error (it would otherwise fail silently). */
export function checkSettlementCutoverConfig(log: { error: (m: string, meta?: unknown) => void; info: (m: string, meta?: unknown) => void }): Date | null {
  const r = parseSettlementCutover(CONFIG.SETTLEMENT_CUTOVER_AT);
  if (r.error) log.error(r.error);
  else if (r.at) log.info('Settlement cutover', { settlementCutoverAt: r.at.toISOString() });
  return r.at;
}

export function settlementSystemFor(createdAt: Date): 'legacy' | 'ledger' {
  const at = settlementCutoverAt();
  return at && createdAt.getTime() >= at.getTime() ? 'ledger' : 'legacy';
}
