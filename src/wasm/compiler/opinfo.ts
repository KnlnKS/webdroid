// Predicates over DEX opcodes shared by the passes.

export const isInvoke = (op: number) => (op >= 0x6e && op <= 0x78 && op !== 0x73) || (op >= 0xfa && op <= 0xfd);
export const isInstanceInvoke = (op: number) => isInvoke(op) && op !== 0x71 && op !== 0x77 && op < 0xfc;

/** ops that cannot throw: no handler edge is needed for them */
export const NO_THROW = new Uint8Array(256);
for (const [lo, hi] of [[0x00, 0x19], [0x28, 0x2a], [0x2d, 0x3d], [0x7b, 0xe2]] as const) for (let o = lo; o <= hi; o++) NO_THROW[o] = 1;
for (const o of [0x93, 0x94, 0x9e, 0x9f, 0xb3, 0xb4, 0xbe, 0xbf, 0xd3, 0xd4, 0xdb, 0xdc]) NO_THROW[o] = 0; // int/long div, rem
