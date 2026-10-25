// Compiling with the JS String builtins and String constants imported by their text, which the TypeScript lib does not declare.
type CompileOptions = { builtins: string[]; importedStringConstants: string };
type ModuleWithOptions = new (bytes: BufferSource, options: CompileOptions) => WebAssembly.Module;
type StreamWithOptions = (source: Promise<Response>, options: CompileOptions) => Promise<WebAssembly.Module>;

export const COMPILE_OPTIONS: CompileOptions = { builtins: ["js-string"], importedStringConstants: "#" };

export const compileModule = (bytes: Uint8Array): WebAssembly.Module => new (WebAssembly.Module as unknown as ModuleWithOptions)(bytes as BufferSource, COMPILE_OPTIONS);
export const compileStream = (source: Promise<Response>): Promise<WebAssembly.Module> => (WebAssembly.compileStreaming as unknown as StreamWithOptions)(source, COMPILE_OPTIONS);
export const compileBytes = (bytes: Uint8Array): Promise<WebAssembly.Module> => (WebAssembly.compile as unknown as (bytes: BufferSource, options: CompileOptions) => Promise<WebAssembly.Module>)(bytes as BufferSource, COMPILE_OPTIONS);

/** reads unsigned LEB128 numbers from `b` at `i` */
export class LebReader {
  readonly b: Uint8Array; i: number;
  constructor(b: Uint8Array, i = 0) { this.b = b; this.i = i; }
  u32(): number { let r = 0, s = 1, x: number; do { x = this.b[this.i++]; r += (x & 0x7f) * s; s *= 128; } while (x & 0x80); return r; }
}

// JSPI (stack switching for Wasm): a Suspending import may wait on a promise, a promising export runs on a stack of its own and answers one
type Jspi = { Suspending: new (fn: (...a: never[]) => unknown) => Function; promising: (f: Function) => Function };
/** the engine's JSPI, which the tier needs (node 24 enables it with --experimental-wasm-jspi) */
const jspiApi = (): Jspi => {
  if (!("Suspending" in WebAssembly)) throw new Error("the Wasm tier needs JSPI (WebAssembly.Suspending)");
  return WebAssembly as unknown as Jspi;
};
// The engine keeps a suspended stack, and all its frames reach, until its Promise settles, even after its page is gone (a reload keeps the
// renderer), so each pending wait stays settleable by endWaits.
const waits = new Set<(reason: unknown) => void>();
let ended: Error | undefined;
export const suspending = <F extends Function>(fn: F): F => new (jspiApi().Suspending)(((...a: never[]) => {
  if (ended) throw ended;
  const r = (fn as unknown as (...a: never[]) => unknown)(...a);
  if (!(r instanceof Promise)) return r;
  return new Promise((resolve, reject) => {
    waits.add(reject);
    r.then((v) => { waits.delete(reject); resolve(v); }, (e) => { waits.delete(reject); reject(e); });
  });
}) as never) as unknown as F;
/** the page is gone: every waiting stack resumes by throwing `reason`, as does any later wait. Java catches only its own tag and natives pass
 *  `reason` on unconverted, so the stacks unwind without running Java handlers */
export function endWaits(reason: Error): void {
  ended ??= reason;
  for (const reject of waits) reject(ended);
  waits.clear();
}
export const waitsEnded = (): boolean => ended !== undefined;
export const promising = (f: Function): Function => jspiApi().promising(f);
