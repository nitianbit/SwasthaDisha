import { smsFlags } from '@/modules/smsNotices/flags';

/**
 * Phase 5 message texts (ASSISTED_BOOKING_DESIGN.md §10.2, §10.6, §27.5.5). Each text is, byte for byte, the text
 * registered on the DLT portal, except that every `{#var#}` is written here with its name (`{#name#}`), so each language
 * keeps its own word order. `<JOIN_BASE>` is fixed text: the configured SMS_JOIN_LINK_BASE_URL.
 *
 * A language is listed only once its registered text is final (the first wave adds hi, as, bn and or when registered).
 */
export const SMS_MESSAGES = ['BOOKED', 'BOOKED_LINK', 'RX_READY', 'REPORT_READY', 'REMINDER', 'REMINDER_LINK', 'CANCELLED_MOVED', 'RECORDS_CODE'] as const;
export type SmsMessage = typeof SMS_MESSAGES[number];
/** The first wave (owner): English, Hindi, Assamese, Bengali, Odia. */
export const FIRST_WAVE = ['en', 'hi', 'as', 'bn', 'or'] as const;

const TEXTS: Record<string, Partial<Record<SmsMessage, string>>> = {
  en: {
    BOOKED: "Jansetu: {#name#}'s {#service#} is booked for {#date#} at {#time#} via {#place#}. Ref {#ref#}. Sign in to the Jansetu app with this number for details.",
    BOOKED_LINK: "Jansetu: {#name#}'s {#service#} is booked for {#date#} at {#time#} via {#place#}. Ref {#ref#}. Join the video call at <JOIN_BASE>/{#token#} at the booked time.",
    RX_READY: 'Jansetu: the prescription for {#name#} from the consultation on {#date#} is ready. Sign in to the Jansetu app with this number, or ask {#place#}.',
    REPORT_READY: 'Jansetu: the lab report for {#name#} from {#date#} ({#place#}) is ready. Sign in to the Jansetu app with this number to see it.',
    REMINDER: "Jansetu reminder: {#name#}'s {#service#} on {#date#} at {#time#}, {#place#}.",
    REMINDER_LINK: "Jansetu reminder: {#name#}'s {#service#} on {#date#} at {#time#}, {#place#}. Join: <JOIN_BASE>/{#token#}",
    CANCELLED_MOVED: "Jansetu: {#name#}'s {#service#} has been {#what#}. Sign in to the Jansetu app with this number for details.",
    RECORDS_CODE: "Jansetu: {#code#} is the code to let your doctor see {#name#}'s past health records. Share it only with the doctor treating you. Valid 10 minutes.",
  },
};

/**
 * r31 (§27.5.5): the fixed words a notice puts into its variables, in the language of the text chosen (a language
 * without its own words uses English, as its texts do). `service` is keyed by the booking's mode.
 */
export interface SmsWords {
  service: { video: string; call: string; 'in-person': string; lab: string; home: string };
  cancelled: string;
  movedTo: string;
  movedOff: string;
  familyMember: string;
  /** r34 (§27.6.3): the reminder's `place` for a video consultation on the patient's phone, a clinic visit, a home collection. */
  jansetuApp: string;
  theClinic: string;
  home: string;
}
const WORDS: Record<string, SmsWords> = {
  en: {
    service: { video: 'video consultation', call: 'phone consultation', 'in-person': 'clinic consultation', lab: 'lab test', home: 'home sample collection' },
    cancelled: 'cancelled', movedTo: 'moved to', movedOff: 'moved to another number', familyMember: 'your family member',
    jansetuApp: 'Jansetu app', theClinic: 'the clinic', home: 'home',
  },
};
export const wordsFor = (lang: string): SmsWords => WORDS[lang] ?? WORDS.en!;

const VAR = /\{#([a-z]+)#\}/g;
const JOIN = '<JOIN_BASE>';

/** The text to register on DLT for a message and language (null: no final text in the repo). */
export function dltText(message: SmsMessage, lang: string): string | null {
  const t = TEXTS[lang]?.[message];
  if (!t) return null;
  return t.replace(VAR, '{#var#}').replace(JOIN, smsFlags.joinBase() || JOIN);
}

/** The variable names of a message, in that language's order. */
export const varsOf = (message: SmsMessage, lang: string): string[] => [...(TEXTS[lang]?.[message] ?? '').matchAll(VAR)].map((m) => m[1]!);

/** A value as DLT accepts it: one line, single spaces, at most 30 characters. */
const fit = (v: string) => v.replace(/\s+/g, ' ').trim().slice(0, 30).trim();

export interface SendableTemplate { message: SmsMessage; lang: string; templateId: string }

/** Switched on (unless `anySwitch`: the admin test send), with a DLT id, a final text and (links) the join address. */
export function sendable(message: SmsMessage, lang: string, anySwitch = false): SendableTemplate | null {
  const text = TEXTS[lang]?.[message];
  const { enabled, templateId } = smsFlags.pair(message, lang);
  if (!text || !(enabled || anySwitch) || !templateId || (text.includes(JOIN) && !smsFlags.joinBase())) return null;
  return { message, lang, templateId };
}

/**
 * The first sendable template: the patient's language before the link (§27.5.5, SM6) — each message of `preferred` in
 * `lang`, then each in the fallback language.
 */
export function chooseTemplate(preferred: SmsMessage[], lang: string): SendableTemplate | null {
  for (const l of [...new Set([lang, smsFlags.fallbackLanguage()])]) {
    for (const m of preferred) {
      const t = sendable(m, l);
      if (t) return t;
    }
  }
  return null;
}

/** The text to send; null when a variable is missing (a programming error: the row is skipped). */
export function render(t: SendableTemplate, values: Record<string, string>): string | null {
  const text = TEXTS[t.lang]![t.message]!;
  if (varsOf(t.message, t.lang).some((v) => !fit(String(values[v] ?? '')))) return null;
  return text.replace(JOIN, smsFlags.joinBase()).replace(VAR, (_, v: string) => fit(String(values[v])));
}

/** GSM 7-bit basic set (and its extension table); anything else needs the gateway's Unicode flag. */
const GSM = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
export const needsUnicode = (text: string) => !GSM.test(text);
