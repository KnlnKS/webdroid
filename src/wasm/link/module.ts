// Compiling with the JS String builtins and String constants imported by their text, which the TypeScript lib does not declare.
export type CompileOptions = { builtins: string[]; importedStringConstants: string };
type ModuleWithOptions = new (bytes: BufferSource, options: CompileOptions) => WebAssembly.Module;
type StreamWithOptions = (source: Promise<Response>, options: CompileOptions) => Promise<WebAssembly.Module>;

export const COMPILE_OPTIONS: CompileOptions = { builtins: ["js-string"], importedStringConstants: "#" };

export const compileModule = (bytes: Uint8Array): WebAssembly.Module => new (WebAssembly.Module as unknown as ModuleWithOptions)(bytes as BufferSource, COMPILE_OPTIONS);
export const compileStream = (source: Promise<Response>): Promise<WebAssembly.Module> => (WebAssembly.compileStreaming as unknown as StreamWithOptions)(source, COMPILE_OPTIONS);
export const compileBytes = (bytes: Uint8Array): Promise<WebAssembly.Module> => (WebAssembly.compile as unknown as (bytes: BufferSource, options: CompileOptions) => Promise<WebAssembly.Module>)(bytes as BufferSource, COMPILE_OPTIONS);

// JSPI (stack switching for Wasm): a Suspending import may wait on a promise, a promising export runs on a stack of its own and answers one
type Jspi = { Suspending: new (fn: (...a: never[]) => unknown) => Function; promising: (f: Function) => Function };
const jspiApi = (): Jspi | undefined => (WebAssembly as unknown as Partial<Jspi>).Suspending ? (WebAssembly as unknown as Jspi) : undefined;
/** whether the engine has JSPI (node needs --experimental-wasm-jspi; Bun's JavaScriptCore has none) */
export const hasJspi = (): boolean => !!jspiApi();
export const suspending = <F extends Function>(fn: F): F => new (jspiApi()!.Suspending)(fn as never) as unknown as F;
export const promising = (f: Function): Function => jspiApi()!.promising(f);
