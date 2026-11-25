/** RFC 4648 base32 (upper case, no padding): the assisted Ref (§5.1) and the SMS join link's MAC (§27.8.1). */
export const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The first `chars` base32 characters of `bytes` (5 bits each; `bytes` must hold at least 5 × chars + 8 bits). */
export function base32Prefix(bytes: Uint8Array, chars: number): string {
  let out = '';
  for (let i = 0; i < chars; i++) {
    const bit = i * 5;
    const two = (bytes[bit >> 3]! << 8) | bytes[(bit >> 3) + 1]!;
    out += BASE32_ALPHABET[(two >> (11 - (bit & 7))) & 31];
  }
  return out;
}
