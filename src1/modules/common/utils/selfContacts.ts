/**
 * Owner decision (Q14 review N7/N8): an account's sign-in contacts (mobile number, email; a customer's corporate email)
 * are never set or changed by the account holder's own profile edit — an unproven address could take someone else's
 * sign-in. Released apps may send contacts together with other fields, so the save is not refused: the contacts are left
 * out, the rest is saved, and the answer names what was left out (`ignoredContacts`). Sending the stored value again
 * (any supported spelling) is not "ignored"; absent, null, empty or malformed values are dropped silently, as before.
 * Admin edits are the support path and are unchanged.
 */
export type ContactField = 'email' | 'corporateEmail' | 'phone';

export const SELF_CONTACT_MESSAGE = {
  customer: "Contact details weren't changed: add an email from your profile with a code; your mobile number can't be changed here.",
  staff: "Contact details weren't changed here; ask the Jansetu team to update them.",
} as const;

/** The spellings the profile forms accept for one number: spaces, +91 and leading zeros are not a different number. */
export const tidyPhone = (p: string) => p.trim().replace(/\s+/g, '').replace(/^\+91/, '').replace(/^0+(?=\d{10}$)/, '');
const tidyEmail = (e: string) => e.trim().toLowerCase();

/** The body without the contact fields, and those it tried to change (a non-empty value differing from the stored one). */
export function withoutSelfContacts<T extends Record<string, unknown>>(body: T, stored: Partial<Record<ContactField, unknown>>,
  fields: readonly ContactField[]): { rest: Partial<T>; ignoredContacts: ContactField[] } {
  const rest: Record<string, unknown> = { ...body };
  const ignoredContacts: ContactField[] = [];
  for (const field of fields) {
    const sent = rest[field];
    delete rest[field];
    if (typeof sent !== 'string' || !sent.trim()) continue;
    const tidy = field === 'phone' ? tidyPhone : tidyEmail;
    const current = typeof stored[field] === 'string' ? tidy(stored[field] as string) : '';
    if (tidy(sent) !== current) ignoredContacts.push(field);
  }
  return { rest: rest as Partial<T>, ignoredContacts };
}
