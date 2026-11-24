import { randomInt } from 'node:crypto';

/**
 * Phase 3d (ASSISTED_BOOKING_DESIGN.md §25.7.2, DR10): the code printed with a doctor's recommended tests. 8
 * characters of the Crockford base32 alphabet (no I, L, O or U, which are misread aloud or on paper): 7 random
 * characters and one Luhn mod 32 check character, so a pharmacy or lab that types it wrong is told at once. Printed as
 * `ABCD-EFGH`.
 *
 * Luhn mod 32 catches every single wrong character and every swap of two neighbours except `0` ↔ `Z` (the values 0 and
 * 31: the mod-N form of decimal Luhn's 09 ↔ 90 blind spot).
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const N = ALPHABET.length;
const BODY = 7;
const SHAPE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Σ over the characters from the right, every second one doubled (digit sum in base N). */
function luhnSum(chars: string, doubleFirst: boolean): number {
  let sum = 0;
  let double = doubleFirst;
  for (let i = chars.length - 1; i >= 0; i--) {
    let v = ALPHABET.indexOf(chars[i]!) * (double ? 2 : 1);
    v = Math.floor(v / N) + (v % N);
    sum += v;
    double = !double;
  }
  return sum;
}

const checkCharOf = (body: string): string => ALPHABET[(N - (luhnSum(body, true) % N)) % N]!;

/** A new random code (crypto randomness). */
export function newRecommendationCode(): string {
  let body = '';
  for (let i = 0; i < BODY; i++) body += ALPHABET[randomInt(N)];
  return body + checkCharOf(body);
}

/**
 * The stored form of a typed code, or null when it is not one: upper-cased, spaces and hyphens removed, I and L read as
 * 1 and O as 0 (Crockford decoding), then the shape and the check character must hold.
 */
export function normalizeRecommendationCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 20) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return SHAPE.test(code) && luhnSum(code, false) % N === 0 ? code : null;
}

/** `ABCDEFGH` → `ABCD-EFGH` (how it is printed). */
export const formatRecommendationCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;
