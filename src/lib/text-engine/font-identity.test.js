import { describe, expect, it } from 'vitest';
import { fontBytesHash } from './font-identity.js';

// A separate BigInt reference checks carries and multiplication over every
// byte value and long inputs. Production works in uint32 limbs for large fonts.
const reference = (bytes) => {
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  for (const byte of bytes) hash = BigInt.asUintN(128, (hash ^ BigInt(byte)) * 0x0000000001000000000000000000013bn);
  return hash.toString(16).padStart(32, '0');
};

describe('font source fingerprint', () => {
  it('matches FNV-1a128 over the exact bytes/view without keeping a copy', () => {
    for (const bytes of [new Uint8Array(), new TextEncoder().encode('font source'), Uint8Array.from({ length: 256 }, (_, i) => i), Uint8Array.from({ length: 10000 }, (_, i) => (i * 197 + 83) & 255)]) {
      expect(fontBytesHash(bytes)).toBe(reference(bytes));
      expect(fontBytesHash(bytes.buffer)).toBe(reference(bytes));
    }
    const whole = Uint8Array.from([1, 2, 3, 4, 5]);
    expect(fontBytesHash(whole.subarray(1, 4))).toBe(reference(Uint8Array.from([2, 3, 4])));
    const before = fontBytesHash(whole);
    whole[4] ^= 1;
    expect(fontBytesHash(whole)).not.toBe(before);
  });
});
