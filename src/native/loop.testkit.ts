// The two-block loop that region tests and scripts/native-bench.ts run: `add r1, #3; b body` at `at`, then
// `body: subs r0, #1; bne at; bx lr` 12 bytes on. Encodings from clang for ARMv7.
import { mem } from "./mem.ts";

export const LOOP_BODY = 12;
export function placeLoop(at: number, thumb: boolean): void {
  if (thumb) for (const [off, half] of [[0, 0x3103], [2, 0xe003], [12, 0x3801], [14, 0xd1f7], [16, 0x4770]]) mem.st16(at + off, half);
  else for (const [off, word] of [[0, 0xe2811003], [4, 0xea000000], [12, 0xe2500001], [16, 0x1afffffa], [20, 0xe12fff1e]]) mem.st32(at + off, word);
}
