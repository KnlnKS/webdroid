// The Wasm tier's entry (src/jvm/tier.ts loads it under ?tier=wasm). Bytecode cannot run here yet: the framework's blocking natives need S3.
export function bootWasmTier(): never {
  throw new Error("?tier=wasm: the Wasm tier cannot run the framework yet");
}
