import { ModuleBuilder, T, ref } from "../../../src/wasm/compiler/wasmbin.ts";
import { Code } from "../../../src/wasm/compiler/code.ts";
import { chromium } from "playwright";
const names = ["hello", "", "é", "日本語", "😀", "a".repeat(2000), "line\nbreak", "nul\0x", "tab\t", "\u0001", "x y", "#"];
const mb = new ModuleBuilder();
const len = mb.importFunc("wasm:js-string", "length", mb.addFuncType([T.externref], [T.i32]));
const gs = names.map((n) => mb.importGlobal("#", n, ref(-17), false));
names.forEach((n, i) => mb.export("f" + i, "func", mb.addFunc(mb.addFuncType([], [T.i32]), new Code(0).gget(gs[i]).call(len).finish())));
const bytes = [...mb.build()];
const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await b.newPage(); await p.goto("about:blank");
const out = await p.evaluate(async ([bytes, names]) => {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/wasm" })), o = { builtins: ["js-string"], importedStringConstants: "#" }, r: any = {};
  for (const [n, mk] of [["compile", () => WebAssembly.compile(new Uint8Array(bytes), o)], ["streaming", () => WebAssembly.compileStreaming(fetch(url), o)]] as const) {
    try { const i = await WebAssembly.instantiate(await (mk as any)(), {}); r[n] = names.map((s: string, k: number) => (i.exports as any)["f" + k]() === s.length ? "ok" : "BAD"); } catch (e) { r[n] = String(e).slice(0, 200); }
  }
  return r;
}, [bytes, names] as any);
console.log(JSON.stringify(out)); await b.close();
