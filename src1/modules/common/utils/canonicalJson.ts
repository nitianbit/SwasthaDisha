import { createHash } from 'crypto';

/** Stable JSON: sorted keys, no undefined/null, dates as ISO strings. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x === undefined || x === null) continue;
        out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/** The content hash a request key is bound to (key-order independent). */
export const requestHashOf = (content: unknown): string => createHash('sha256').update(canonicalJson(content)).digest('hex');
