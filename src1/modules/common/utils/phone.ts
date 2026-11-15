/**
 * Q2 §6a: one canonical form for customer mobile numbers — ten digits. "+91 98765 43210", "919876543210" and
 * "09876543210" all become "9876543210". Anything else is not a recognisable mobile number (null).
 */
export function canonicalMobile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.replace(/[\s-]/g, '');
  if (p.startsWith('+91')) p = p.slice(3);
  else if (p.startsWith('91') && p.length === 12) p = p.slice(2);
  else if (p.startsWith('0') && p.length === 11) p = p.slice(1);
  return /^[0-9]{10}$/.test(p) ? p : null;
}

/**
 * Mongoose setter for stored customer phones: every writer through the model (create, save, updates) and every query
 * filter on the path stores/looks up the canonical form, so no path can re-introduce "+91…" next to the ten-digit key.
 * A value that is not a recognisable mobile number is kept as given (trimmed); null/undefined stay as they are.
 */
export function canonicalPhoneSetter(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  return canonicalMobile(v) ?? v.trim();
}
