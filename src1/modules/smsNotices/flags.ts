/**
 * Phase 5 switches and settings (ASSISTED_BOOKING_DESIGN.md §27.5.6), read from the environment on every call and OFF
 * unless set to the exact string "true" (as assisted/flags.ts). The gateway account itself is the existing SMS_* config.
 */
const on = (name: string) => process.env[name] === 'true';
const text = (name: string) => String(process.env[name] ?? '').trim();
const int = (name: string, fallback: number, min: number, max: number) => {
  const v = Number(process.env[name]);
  return Number.isSafeInteger(v) && v >= min && v <= max ? v : fallback;
};

export const smsFlags = {
  /** SMS_NOTICES_ENABLED: the master switch of booking notices (not of sign-in codes). */
  enabled: () => on('SMS_NOTICES_ENABLED'),
  /** Per gateway call; at most a third of the drain's 60 s lease. */
  timeoutMs: () => int('SMS_SEND_TIMEOUT_MS', 5000, 1, 20_000),
  maxAttempts: () => int('SMS_NOTICE_MAX_ATTEMPTS', 3, 1, 10),
  fallbackLanguage: () => (/^[a-z]{2,3}$/.test(text('SMS_FALLBACK_LANGUAGE')) ? text('SMS_FALLBACK_LANGUAGE') : 'en'),
  /** SMS_UNICODE_PARAM as `name=value`; null when unset or malformed (non-Latin notices are then skipped). */
  unicodeParam: (): Record<string, string> | null => {
    const m = /^([A-Za-z0-9_]+)=(.+)$/.exec(text('SMS_UNICODE_PARAM'));
    return m ? { [m[1]!]: m[2]! } : null;
  },
  /** SMS_NOTICES_FROM: the DLT header of notices; empty = SMS_FROM. */
  noticesFrom: () => text('SMS_NOTICES_FROM'),
  /** SMS_JOIN_LINK_BASE_URL (https only): the fixed address part of the link templates (round 5d). */
  joinBase: () => (/^https:\/\/\S+$/.test(text('SMS_JOIN_LINK_BASE_URL')) ? text('SMS_JOIN_LINK_BASE_URL').replace(/\/+$/, '') : ''),
  /** r34 (§27.7): SMS_VISIT_REMINDER_MINUTES_BEFORE, the reminder's lead time (30–1440, default 120, SM14). */
  reminderMinutesBefore: () => int('SMS_VISIT_REMINDER_MINUTES_BEFORE', 120, 30, 1440),
  /** r34 (§27.8.1): JOIN_LINK_SECRET, at least 32 bytes; empty = no join links (the `_LINK` texts are not used, /j/ shows the page). */
  joinSecret: () => (Buffer.byteLength(text('JOIN_LINK_SECRET')) >= 32 ? text('JOIN_LINK_SECRET') : ''),
  /** r34 (§27.8.3): SMS_JOIN_RATE_PER_MINUTE, /j/ requests per IP and minute (default 30). */
  joinRatePerMinute: () => int('SMS_JOIN_RATE_PER_MINUTE', 30, 1, 10_000),
  /** SMS_<MSG>_<LANG>_ENABLED and SMS_<MSG>_<LANG>_TEMPLATE: the per-message, per-language switch and DLT id. */
  pair: (message: string, lang: string) => {
    const k = `SMS_${message}_${lang.toUpperCase()}`;
    return { enabled: on(`${k}_ENABLED`), templateId: text(`${k}_TEMPLATE`) };
  },
};
