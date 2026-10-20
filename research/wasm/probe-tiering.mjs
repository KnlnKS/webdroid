// Compilation-hint and code-cache probes (Chrome/Chromium only; the hints probe reads V8's --trace-wasm-compilation-times from the browser's stdout
// via DEBUG=pw:browser). Usage: DEBUG=pw:browser node probe-tiering.mjs hints [chrome|chromium|node]; node probe-tiering.mjs cache [chrome|chromium] [http,sw,cache]
import binaryen from "binaryen";
import { chromium } from "playwright";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // Whether a later launch starts with the optimized code an earlier one tiered up, under the production defaults (lazy compilation, dynamic tiering) and the
  // tier's compile options. Each run is a fresh browser on one profile, so only the on-disk code cache can answer. A hit shows as run 2's first call of `hot0`
  // taking run 1's optimized time; a miss as run 1's first (baseline) time. Sources: the HTTP response (immutable), a Service Worker answering from Cache
  // Storage, and `cache.match` directly; from the page and from a dedicated Worker. MB=<filler size>, OPTIONS=0 drops the compile options, HEADED=1, JS_FLAGS=<V8 flags>.
  const mb = +(process.env.MB ?? 8), withOptions = process.env.OPTIONS !== "0";
  const fn = (locals, body) => { const b = [...locals, ...body, 0x0b]; return [...leb(b.length), ...b]; };
  const section = (id, items) => { const b = [...leb(items.length), ...items.flat()]; return [id, ...leb(b.length), ...b]; };
  const str = (t) => { const b = [...new TextEncoder().encode(t)]; return [...leb(b.length), ...b]; };
  // hot<i>(n): n rounds of integer mixing, in HOT copies (V8 caches a module once it holds 1 KB of new optimized code); filler functions to reach the size
  const hot = fn([1, 1, 0x7f], [0x03, 0x40, 0x20, 1, 0x20, 1, 0x41, 7, 0x6c, 0x20, 0, 0x73, 0x6a, 0x21, 1, 0x20, 0, 0x41, 1, 0x6b, 0x22, 0, 0x0d, 0, 0x0b, 0x20, 1]);
  const filler = fn([0], Array(2000).fill([0x20, 0, 0x41, 7, 0x6c, 0x21, 0]).flat().concat([0x20, 0]));
  const nFill = Math.ceil(mb * 2 ** 20 / filler.length), nHot = +(process.env.HOT ?? 8);
  const imports = withOptions ? [[...str("wasm:js-string"), ...str("length"), 0, 1], [...str("#"), ...str("probe"), 3, 0x6f, 0]] : [];
  const big = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...section(1, [[0x60, 1, 0x7f, 1, 0x7f], [0x60, 1, 0x6f, 1, 0x7f]]), ...section(2, imports),
    ...section(3, Array(nHot + nFill).fill([0])), ...section(7, Array.from({ length: nHot }, (_, i) => [...str("hot" + i), 0, (imports.length ? 1 : 0) + i])),
    ...section(10, [...Array(nHot).fill(hot), ...Array(nFill).fill(filler)])]);
  const sw = `self.oninstall = () => self.skipWaiting(); self.onactivate = (e) => e.waitUntil(clients.claim());
self.onfetch = (e) => { if (!e.request.url.endsWith("/sw.wasm")) return; e.respondWith(caches.open("w").then(async (c) => (await c.match("/m.wasm")) ?? fetch("/m.wasm").then((r) => (c.put("/m.wasm", r.clone()), r)))); };`;
  const probe = `async function probe(source, options) {
  const s = performance.now();
  const response = source === "sw" ? fetch("/sw.wasm") : source === "cache" ? caches.open("w").then(async (c) => (await c.match("/m.wasm")) ?? (await c.put("/m.wasm", await fetch("/m.wasm")), c.match("/m.wasm"))) : fetch("/m.wasm");
  const mod = await (options ? WebAssembly.compileStreaming(response, options) : WebAssembly.compileStreaming(response)), compileMs = performance.now() - s;
  const e = (await WebAssembly.instantiate(mod, options ? {} : undefined)).exports, time = () => { const t = performance.now(); e.hot0(2e6); return +(performance.now() - t).toFixed(2); };
  const first = time(); for (let i = 0; i < 300; i++) for (const k in e) e[k](2e6);
  return { compileMs: +compileMs.toFixed(1), first, optimized: time() };
}
onmessage = async ({ data }) => postMessage(await probe(...data));`;
  const srv = http.createServer((q, r) => {
    const type = { "/m.wasm": "application/wasm", "/sw.js": "text/javascript", "/w.js": "text/javascript" }[q.url] ?? "text/html";
    r.writeHead(200, { "content-type": type, "cache-control": "public, max-age=31536000, immutable" });
    r.end(q.url === "/m.wasm" ? big : q.url === "/sw.js" ? sw : q.url === "/w.js" ? probe : `<!doctype html><script>${probe}</script>`);
  }).listen(0);
  const url = `http://localhost:${srv.address().port}`, options = withOptions ? { builtins: ["js-string"], importedStringConstants: "#" } : undefined;
  console.log(`module ${(big.length / 2 ** 20).toFixed(1)} MB, options ${withOptions}`);
  for (const source of (process.argv[4] || "http,sw,cache").split(",")) for (const where of ["page", "worker"]) {
    const dir = mkdtempSync(join(tmpdir(), "wdcache-")), runs = [];
    for (let run = 1; run <= 3; run++) {
      const ctx = await chromium.launchPersistentContext(dir, { channel: chan === "chromium" ? undefined : "chrome", headless: process.env.HEADED !== "1", args: process.env.JS_FLAGS ? [`--js-flags=${process.env.JS_FLAGS}`] : [] });
      const p = await ctx.newPage(); await p.goto(url + "/");
      if (source === "sw") await p.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true })); });
      runs.push(await p.evaluate(([source, where, options]) => where === "page" ? probe(source, options)
        : new Promise((resolve) => { const w = new Worker("/w.js"); w.onmessage = ({ data }) => resolve(data); w.postMessage([source, options]); }), [source, where, options]));
      // the engine writes its cache entry a few seconds after tier-up has quieted
      await p.waitForTimeout(8000);
      await ctx.close();
    }
    rmSync(dir, { recursive: true, force: true });
    console.log(`### ${source} ${where} ${runs.map((r) => `compile ${r.compileMs} first ${r.first} opt ${r.optimized}`).join(" | ")}`);
  }
  srv.close();
}
