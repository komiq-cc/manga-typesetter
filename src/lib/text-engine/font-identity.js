// A compact fingerprint of the bytes the engine actually owns. FNV-1a 128,
// computed in four uint32 limbs: no full copy and no per-byte BigInt work.
// This names a source; it is not a cryptographic collision guarantee.
export function fontBytesHash(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let a = 0x6295c58d, b = 0x62b82175, c = 0x07bb0142, d = 0x6c62272e;
  const word = 0x100000000;
  for (const byte of bytes) {
    a = (a ^ byte) >>> 0;
    // The prime is 2^88 + 315. Products/carries stay exactly representable
    // as JS integers, and every limb is reduced to uint32 before the next.
    let n = a * 315;
    const na = n >>> 0;
    n = b * 315 + Math.floor(n / word);
    const nb = n >>> 0;
    n = c * 315 + Math.floor(n / word);
    const nc = (n >>> 0) + ((a << 24) >>> 0);
    n = d * 315 + Math.floor(n / word);
    d = ((n >>> 0) + (a >>> 8) + ((b << 24) >>> 0) + Math.floor(nc / word)) >>> 0;
    a = na;
    b = nb;
    c = nc >>> 0;
  }
  return [d, c, b, a].map((v) => v.toString(16).padStart(8, '0')).join('');
}
