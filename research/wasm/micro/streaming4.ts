import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const file = process.argv[2], bytes = [...readFileSync(file)];
const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await b.newPage(); await p.goto("about:blank");
console.log(JSON.stringify(await p.evaluate(async (bytes) => {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/wasm" })), o = { builtins: ["js-string"], importedStringConstants: "#" }, r: Record<string, unknown> = {};
  for (const [n, mk] of [["compile", () => WebAssembly.compile(new Uint8Array(bytes), o)], ["streaming", () => WebAssembly.compileStreaming(fetch(url), o)]] as const) {
    const m = await (mk as () => Promise<WebAssembly.Module>)();
    r[n] = { custom: WebAssembly.Module.customSections(m, "name").map((s) => s.byteLength), imports: WebAssembly.Module.imports(m).length, exports: WebAssembly.Module.exports(m).length };
  }
  return r;
}, bytes))); await b.close();
