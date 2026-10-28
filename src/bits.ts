/** the set bits of a 32-bit value */
export const popcount = (n: number): number => {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return ((n + (n >>> 4) & 0xf0f0f0f) * 0x1010101) >>> 24;
};
