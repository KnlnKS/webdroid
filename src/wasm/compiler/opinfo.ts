// Predicates over DEX opcodes shared by the passes.

export const isInvoke = (op: number) => (op >= 0x6e && op <= 0x78 && op !== 0x73) || (op >= 0xfa && op <= 0xfd);
/** iget and iput: quickened forms never compile */
export const isFieldAccess = (op: number) => op >= 0x52 && op <= 0x5f;
export const isInstanceInvoke = (op: number) => isInvoke(op) && op !== 0x71 && op !== 0x77 && op < 0xfc;
