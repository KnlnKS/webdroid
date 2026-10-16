// Do WebAssembly.compile and compileStreaming report the same offsets in a stack trace (the position of a call in a function)?
import { ModuleBuilder, T } from "../../../src/wasm/compiler/wasmbin.ts";
import { Code } from "../../../src/wasm/compiler/code.ts";
import { chromium } from "playwright";
const mb = new ModuleBuilder(), h = mb.importFunc("h", "f", mb.addFuncType([], []));
for (let i = 0; i < 300; i++) { const body = new Code(0); for (let k = 0; k < i % 17; k++) body.i32(1).drop(); mb.export("g" + i, "func", mb.addFunc(mb.addFuncType([], []), body.call(h).finish(), "fn" + i)); }
const bytes = [...mb.build()];
const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await b.newPage(); await p.goto("about:blank");
console.log(JSON.stringify(await p.evaluate(async (bytes) => {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/wasm" })), r: Record<string, string[]> = {};
  for (const [n, mk] of [["compile", () => WebAssembly.compile(new Uint8Array(bytes))], ["streaming", () => WebAssembly.compileStreaming(fetch(url))]] as const) {
    const stacks: string[] = [];
    const i = await WebAssembly.instantiate(await (mk as () => Promise<WebAssembly.Module>)(), { h: { f: () => stacks.push((new Error().stack ?? "").split("\n").filter((l) => l.includes("wasm")).join(" | ")) } });
    for (const k of [0, 17, 150, 299]) (i.exports as any)['g' + k](); r[n] = stacks;
  }
  return r;
}, bytes), null, 1)); await b.close();
