// Does WebAssembly.compileStreaming honour the compile options (js-string builtins, imported string constants) as WebAssembly.compile does?
import { wat, inChrome } from "./lib.mjs";
const bytes = [...wat(`(module
 (import "wasm:js-string" "length" (func $len (param externref) (result i32)))
 (import "#" "hello" (global $h (ref extern)))
 (func (export "f") (result i32) (call $len (global.get $h))))`)];
const run = async ([bytes]) => {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/wasm" }));
  const opts = { builtins: ["js-string"], importedStringConstants: "#" }, out = {};
  const run = async (name, mk) => { try { const m = await mk(); const i = await WebAssembly.instantiate(m, {}); out[name] = i.exports.f(); } catch (e) { out[name] = "error: " + String(e).slice(0, 160); } };
  await run("compile", async () => WebAssembly.compile(new Uint8Array(bytes), opts));
  await run("compileStreaming", async () => WebAssembly.compileStreaming(fetch(url), opts));
  await run("compileStreaming-no-options", async () => WebAssembly.compileStreaming(fetch(url)));
  await run("instantiateStreaming", async () => (await WebAssembly.instantiateStreaming(fetch(url), {}, opts)).module);
  return out;
};
console.log(JSON.stringify(await inChrome(`async ([b]) => (${run})([b])`, [bytes])));
