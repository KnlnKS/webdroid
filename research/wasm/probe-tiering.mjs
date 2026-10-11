// Compilation-hint and code-cache probes (Chrome/Chromium only; instrumentation is V8's --trace-wasm-compilation-times,
// read from the browser's stdout via DEBUG=pw:browser). Usage: DEBUG=pw:browser node probe-tiering.mjs hints|cache [chrome|chromium|node]
import binaryen from "binaryen";
import { chromium } from "playwright";
import http from "node:http";
const [mode, chan = "chrome"] = process.argv.slice(2);
const F = binaryen.Features;
const asm = t => { const m = binaryen.parseText(t); m.setFeatures(F.All & ~(F.Strings | F.CompactImports | F.StackSwitching | F.SharedEverything | F.FP16 | F.CustomPageSizes | F.WideArithmetic | F.RelaxedAtomics | F.AcquireReleaseAtomics)); const b = [...m.emitBinary()]; m.dispose(); return b; };
const leb = n => { const o = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; o.push(b); } while (n); return o; };
const custom = (name, payload) => { const n = [...new TextEncoder().encode(name)]; const body = [...leb(n.length), ...n, ...payload]; return [0, ...leb(body.length), ...body]; };
// insert a custom section before the code section (id 10)
function splice(bytes, section) {
  let p = 8; while (p < bytes.length) { const id = bytes[p]; let v = 0, s = 0, q = p + 1, b; do { b = bytes[q++]; v |= (b & 127) << s; s += 7; } while (b & 128); if (id === 10) return [...bytes.slice(0, p), ...section, ...bytes.slice(p)]; p = q + v; }
}
const launch = flags => chromium.launch({ channel: chan === "chromium" ? undefined : "chrome", headless: true, args: [`--js-flags=${flags.join(" ")}`, "--enable-logging=stderr"] });

if (mode === "hints") {
  const base = asm(`(module (func $cold (export "cold") (param i32) (result i32) (local.get 0))
    (func $hot (export "hot") (param i32) (result i32) (local $i i32) (loop $l (local.set $i (i32.add (local.get $i) (i32.const 1))) (br_if $l (i32.lt_u (local.get $i) (local.get 0)))) (local.get $i)))`);
  // hint byte: bits 0-1 strategy (1 lazy, 2 eager, 3 lazy-baseline/eager-top), bits 2-3 baseline tier (1 baseline, 2 optimized), bits 4-5 top tier
  const hinted = (...bs) => splice(base, custom("compilationHints", [...leb(bs.length), ...bs]));
  const prio = splice(base, custom("metadata.code.compilation_priority", [1, 1, 1, 0, 1, 0])); // func 1, one annotation at offset 0, size 1, priority 0
  const prio2 = splice(base, custom("metadata.code.compilation_priority", [1, 1, 1, 0, 1, 5]));
  const bad = hinted(0x2a, 0x2a, 0x2a, 0x2a, 0x2a), badprio = splice(base, custom("metadata.code.compilation_priority", [1, 9, 1, 0, 1, 0]));
  const variants = { "malformed: 5 hints for 2 funcs": bad, "malformed priority (func 9)": badprio,  none: base, "eager,opt,opt (0x2a)": hinted(0x00, 0x2a), "eager,baseline,opt (0x26)": hinted(0x00, 0x26), "lazy-baseline/eager-top (0x23)": hinted(0x00, 0x23), "eager,baseline (0x06)": hinted(0x00, 0x06), "lazy (0x01)": hinted(0x01, 0x01), compilation_priority0: prio, compilation_priority5: prio2 };
  if (chan === "node") { // run as: node --experimental-wasm-compilation-hints --trace-wasm-compilation-times probe-tiering.mjs hints node
    for (const [k, bytes] of Object.entries(variants)) { console.log("### variant", k); try { const e = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes))).exports; console.log("### instantiated"); e.hot(10); console.log("### called"); } catch (e) { console.log("### error", e.message); } }
    process.exit(0);
  }
  for (const flagged of [false, true]) for (const [k, bytes] of Object.entries(variants)) {
    const fl = ["--trace-wasm-compilation-times"]; if (flagged) fl.push("--experimental-wasm-compilation-hints");
    const b = await launch(fl); const lines = []; // trace lines arrive through DEBUG=pw:browser on process stdout; captured by the parent via marker below
    const p = await b.newPage(); await p.goto("about:blank");
    console.log(`### flag=${flagged} variant=${k}`);
    const ok = await p.evaluate(async bs => { try { const e = (await WebAssembly.instantiate(new Uint8Array(bs))).instance.exports; e.hot(10); await new Promise(r => setTimeout(r, 400)); return "ran"; } catch (e) { return "err " + e.message.slice(0, 100); } }, bytes);
    console.log("### result", ok); await b.close();
  }
}

if (mode === "cache") {
  // 3000-function module. Each (method, run) is a fresh browser launch on a shared profile so V8's in-isolate native-module
  // cache cannot answer; only the on-disk code cache can make runs 2 and 3 faster. Methods: compileStreaming from the HTTP
  // response (immutable cache headers), from a Cache Storage response built from runtime bytes, from a blob URL, and
  // WebAssembly.compile(bytes) (never cached).
  const fns = []; for (let i = 0; i < +(process.env.FUNCS ?? 3000); i++) fns.push(`(func (export "f${i}") (param i32) (result i32) (local i32) ${"(local.set 1 (i32.add (local.get 1) (i32.mul (local.get 0) (i32.const 7))))".repeat(40)} (local.get 1))`);
  const big = new Uint8Array(asm(`(module ${fns.join("\n")})`));
  const srv = http.createServer((q, r) => {
    if (q.url === "/m.wasm") { r.writeHead(200, { "content-type": "application/wasm", "cache-control": "public, max-age=31536000, immutable" }); r.end(big); }
    else { r.writeHead(200, { "content-type": "text/html" }); r.end("<!doctype html>"); }
  }).listen(0);
  const url = `http://localhost:${srv.address().port}`;
  console.log("module bytes", big.length);
  for (const method of (process.argv[4] || "http,cacheStorage,blobUrl,compileBytes").split(",")) {
    const dir = (await import("node:fs")).mkdtempSync("/tmp/wdcache-");
    const times = [];
    for (let run = 1; run <= 3; run++) {
      const ctx = await chromium.launchPersistentContext(dir, { channel: chan === "chromium" ? undefined : "chrome", headless: true, args: ["--js-flags=--no-wasm-lazy-compilation --wasm-tiering-budget=2000 --trace-wasm-compilation-times"] });
      console.log("### launch", method, run); // with DEBUG=pw:browser, count the "Compiled function" lines after each marker
      const p = await ctx.newPage(); await p.goto(url + "/");
      times.push(await p.evaluate(async method => {
        const get = async () => new Uint8Array(await (await fetch("/m.wasm")).arrayBuffer());
        let mod, s;
        if (method === "http") { s = performance.now(); mod = await WebAssembly.compileStreaming(fetch("/m.wasm")); }
        else if (method === "cacheStorage") { const c = await caches.open("w"); if (!(await c.match("/rt.wasm"))) await c.put("/rt.wasm", new Response(await get(), { headers: { "content-type": "application/wasm" } })); s = performance.now(); mod = await WebAssembly.compileStreaming(await c.match("/rt.wasm")); }
        else if (method === "blobUrl") { const u = URL.createObjectURL(new Blob([await get()], { type: "application/wasm" })); s = performance.now(); mod = await WebAssembly.compileStreaming(fetch(u)); }
        else { const b = await get(); s = performance.now(); mod = await WebAssembly.compile(b); }
        const compileMs = +(performance.now() - s).toFixed(1);
        const i0 = performance.now(), e = (await WebAssembly.instantiate(mod)).exports, instMs = +(performance.now() - i0).toFixed(1); const t = performance.now();
        for (let k = 0; k < 3000; k++) for (let j = 0; j < 50; j++) e["f" + k](j);
        const runMs = +(performance.now() - t).toFixed(1);
        await new Promise(r => setTimeout(r, 3000)); // let tier-up finish so a cache entry can be written
        return { compileMs, instMs, runMs };
      }, method));
      await ctx.close();
    }
    console.log("###", method, JSON.stringify(times));
  }
  srv.close();
}
