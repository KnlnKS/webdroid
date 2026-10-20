// Predicates over DEX opcodes shared by the passes.

export const isInvoke = (op: number) => (op >= 0x6e && op <= 0x78 && op !== 0x73) || (op >= 0xfa && op <= 0xfd);
/** iget and iput: quickened forms never compile */
export const isFieldAccess = (op: number) => op >= 0x52 && op <= 0x5f;
export const isInstanceInvoke = (op: number) => isInvoke(op) && op !== 0x71 && op !== 0x77 && op < 0xfc;
/** the bits of a narrow constant, const/4 to const/high16 (0x12-0x15) */
export const narrowBits = (op: number, b: number): number => op === 0x15 ? b << 16 : b;
/** the bits of a wide constant, const-wide/16 to const-wide/high16 (0x16-0x19) */
export const wideBits = (op: number, b: number, wide: bigint): bigint => op === 0x18 ? wide : op === 0x19 ? BigInt(b) << 48n : BigInt(b);
