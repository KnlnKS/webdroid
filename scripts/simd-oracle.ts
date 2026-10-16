// Run the A64 SIMD&FP test instructions on this machine's own AArch64 core and write what it
// produced to src/native/fixtures/a64simd.bin.gz, which a64simd.oracle.test.ts compares the
// emitter against. Needs an arm64 Mac with clang (the instructions are assembled for
// aarch64-linux to get their words, then embedded as .inst in a Mach-O stub). Running the test
// needs nothing but the fixture.
//
//   bun scripts/simd-oracle.ts
import { INSTRUCTIONS, CASES, INPUT_BYTES, inputs } from "../src/native/a64simd.oracle.cases.ts";
import { $ } from "bun";

if (process.arch !== "arm64") { console.error("the oracle is this machine's arm64 core; this is " + process.arch); process.exit(1); }
const dir = "scripts/simd-oracle/build";
await $`mkdir -p ${dir}`;

// assemble every instruction: one word each, in order
const asm = INSTRUCTIONS.join("\n") + "\n";
await Bun.write(`${dir}/insns.s`, asm);
await $`clang -target aarch64-linux-gnu -march=armv8.5-a+dotprod -x assembler -c ${dir}/insns.s -o ${dir}/insns.o`;
const dis = await $`llvm-objdump -d ${dir}/insns.o`.text();
const words = [...dis.matchAll(/^\s*[0-9a-f]+:\s+([0-9a-f]{8})\s/gm)].map((m) => parseInt(m[1], 16) >>> 0);
if (words.length !== INSTRUCTIONS.length) throw new Error(`assembled ${words.length} words for ${INSTRUCTIONS.length} instructions`);

// one stub per word: load v0-v3, x2-x5 and NZCV from *x0, run it, store them to *x1
let stubs = ".text\n";
for (let i = 0; i < words.length; i++) {
  stubs += `.globl _t${i}\n.p2align 2\n_t${i}:\n  ld1 {v0.16b, v1.16b, v2.16b, v3.16b}, [x0]\n  ldp x2, x3, [x0, #64]\n  ldp x4, x5, [x0, #80]\n  ldr x9, [x0, #96]\n  msr nzcv, x9\n  .inst 0x${words[i].toString(16)}\n  st1 {v0.16b, v1.16b, v2.16b, v3.16b}, [x1]\n  stp x2, x3, [x1, #64]\n  stp x4, x5, [x1, #80]\n  mrs x9, nzcv\n  str x9, [x1, #96]\n  ret\n`;
}
stubs += ".data\n.globl _stubs\n.p2align 3\n_stubs:\n" + words.map((_, i) => `  .quad _t${i}`).join("\n") + "\n";
await Bun.write(`${dir}/stubs.s`, stubs);
const main = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef void (*stub_t)(const unsigned char*, unsigned char*);
extern stub_t stubs[];
int main(int argc, char** argv) {
  int n = atoi(argv[1]), cases = atoi(argv[2]);
  unsigned char* in = malloc(cases * ${INPUT_BYTES});
  if (fread(in, 1, cases * ${INPUT_BYTES}, stdin) != (size_t)(cases * ${INPUT_BYTES})) return 2;
  unsigned char out[${INPUT_BYTES}];
  __asm__ volatile("msr fpcr, xzr");
  for (int i = 0; i < n; i++) for (int k = 0; k < cases; k++) { memset(out, 0, sizeof out); stubs[i](in + k * ${INPUT_BYTES}, out); fwrite(out, 1, sizeof out, stdout); }
  return 0;
}
`;
await Bun.write(`${dir}/main.c`, main);
await $`clang -O0 -arch arm64 ${dir}/stubs.s ${dir}/main.c -o ${dir}/oracle`;

const inBuf = new Uint8Array(CASES * INPUT_BYTES);
for (let k = 0; k < CASES; k++) inBuf.set(inputs(k), k * INPUT_BYTES);
const proc = Bun.spawn([`${dir}/oracle`, String(words.length), String(CASES)], { stdin: inBuf, stdout: "pipe" });
const outBuf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
if (outBuf.length !== words.length * CASES * INPUT_BYTES) throw new Error(`oracle wrote ${outBuf.length} bytes`);

// fixture: "A64O", u32 count, u32 cases, the words, the outputs
const fx = new Uint8Array(12 + words.length * 4 + outBuf.length);
const dv = new DataView(fx.buffer);
fx.set([0x41, 0x36, 0x34, 0x4f]); dv.setUint32(4, words.length, true); dv.setUint32(8, CASES, true);
for (let i = 0; i < words.length; i++) dv.setUint32(12 + i * 4, words[i], true);
fx.set(outBuf, 12 + words.length * 4);
const gz = Bun.gzipSync(fx);
await Bun.write("src/native/fixtures/a64simd.bin.gz", gz);
console.log(`${words.length} instructions x ${CASES} cases -> src/native/fixtures/a64simd.bin.gz (${(gz.length / 1024).toFixed(0)} KB)`);
