// Compiling with the JS String builtins and String constants imported by their text, which the TypeScript lib does not declare.
type CompileOptions = { builtins: string[]; importedStringConstants: string };
type ModuleWithOptions = new (bytes: BufferSource, options: CompileOptions) => WebAssembly.Module;
type StreamWithOptions = (source: Promise<Response>, options: CompileOptions) => Promise<WebAssembly.Module>;

const COMPILE_OPTIONS: CompileOptions = { builtins: ["js-string"], importedStringConstants: "#" };

export const compileModule = (bytes: Uint8Array): WebAssembly.Module => new (WebAssembly.Module as unknown as ModuleWithOptions)(bytes as BufferSource, COMPILE_OPTIONS);
export const compileStream = (source: Promise<Response>): Promise<WebAssembly.Module> => (WebAssembly.compileStreaming as unknown as StreamWithOptions)(source, COMPILE_OPTIONS);
