// Feature and limit probes. Usage: node probe.mjs <chrome|chromium|webkit>  (Playwright Firefox does not start on this host) [--flags=a,b]
// Prints one JSON object. Feature checks run inside the page; modules are assembled by binaryen or by hand.
import binaryen from "binaryen";
import { chromium, webkit } from "playwright";
const [name, ...rest] = process.argv.slice(2);
const flags = (rest.find(a => a.startsWith("--flags=")) || "").slice(8).split(",").filter(Boolean);
const F = binaryen.Features;
const asm = t => { const m = binaryen.parseText(t); m.setFeatures(F.All & ~(F.Strings | F.CompactImports | F.StackSwitching | F.SharedEverything | F.FP16 | F.CustomPageSizes | F.WideArithmetic | F.RelaxedAtomics | F.AcquireReleaseAtomics)); const b = [...m.emitBinary()]; m.dispose(); return b; };
const bytes = {
  jspi: asm(`(module (import "h" "s" (func $s (param i32) (result i32))) (import "h" "j" (func $j (param i32) (result i32))) (func (export "a") (param i32) (result i32) (call $s (local.get 0)))
 (func (export "b") (param i32) (result i32) (call $j (local.get 0))))`),
  gc: asm(`(module (type $s (struct (field i32))) (func (export "f") (result i32) (struct.get $s 0 (struct.new $s (i32.const 1)))))`),
  exnref: asm(`(module (tag $t) (func (export "f") (result i32) (block $h (result exnref) (try_table (catch_all_ref $h) (throw $t)) (return (i32.const 0))) (drop) (i32.const 1)))`),
  legacyEh: [0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,13,3,1,0,0,10,9,1,7,0,6,64,7,0,11,11], // try/catch (0x06,0x07)
  tail: asm(`(module (func $a (param i32) (result i32) (return_call $b (local.get 0))) (func $b (param i32) (result i32) (local.get 0)))`),
  multiMem: asm(`(module (memory $a 1) (memory $b 1) (func (drop (i32.load $b (i32.const 0)))))`),
  mem64: asm(`(module (memory i64 1) (func (drop (i64.load (i64.const 0)))))`),
  relaxedSimd: asm(`(module (func (result v128) (i8x16.relaxed_swizzle (v128.const i32x4 0 0 0 0) (v128.const i32x4 0 0 0 0))))`),
  extConst: asm(`(module (global i32 (i32.add (i32.const 1) (i32.const 2))))`),
  // js-string builtins: imports from "wasm:js-string" are validated against builtin signatures
  jsStr: asm(`(module (import "wasm:js-string" "length" (func $l (param externref) (result i32))) (func (export "f") (param externref) (result i32) (call $l (local.get 0))))`),
  // custom descriptors: two prefixes (0x4c/0x4d) in both orders; encoding from the proposal text, unverified
  cd1: [0,97,115,109,1,0,0,0,1,11,1,78,2,76,1,95,0,77,0,95,0],
  cd2: [0,97,115,109,1,0,0,0,1,11,1,78,2,77,1,95,0,76,0,95,0],
};
const featureFn = async bytes => {
  const out = { ua: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer };
  const valid = b => { try { return WebAssembly.validate(new Uint8Array(b)); } catch (e) { return "err " + e.message; } };
  for (const k of ["gc", "exnref", "legacyEh", "tail", "multiMem", "mem64", "relaxedSimd", "extConst", "cd1", "cd2"]) out[k] = valid(bytes[k]);
  out.atomicsWaitAsync = typeof Atomics.waitAsync; out.JSPI = typeof WebAssembly.Suspending + "/" + typeof WebAssembly.promising;
  out.ehJsApi = typeof WebAssembly.Tag + "/" + typeof WebAssembly.Exception + "/" + typeof WebAssembly.JSTag;
  try { const m = await WebAssembly.instantiate(new Uint8Array(bytes.jsStr), {}, { builtins: ["js-string"] }); out.jsStringBuiltins = m.instance.exports.f("abcd"); }
  catch (e) { out.jsStringBuiltins = "err " + e.message.slice(0, 80); }
  try { out.jsStringBuiltinsNoOpt = valid(bytes.jsStr); } catch {}
  // JSPI behaviour: suspend through a pure wasm stack, and through a JS frame
  if (out.JSPI === "function/function") {
    const w = new Uint8Array(bytes.jspi);
    let inst; const imp = { h: { s: new WebAssembly.Suspending(async x => { await 0; return x + 1; }), j: x => inst.exports.a(x) } };
    inst = (await WebAssembly.instantiate(w, imp)).instance;
    try { out.jspiSuspend = await WebAssembly.promising(inst.exports.a)(1); } catch (e) { out.jspiSuspend = "err " + e.message; }
    try { out.jspiThroughJsFrame = "ok " + await WebAssembly.promising(inst.exports.b)(1); } catch (e) { out.jspiThroughJsFrame = "err " + e.message.slice(0, 60); }
  }
  return out;
};
const limitFn = async () => {
  const leb = n => { const o = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; o.push(b); } while (n); return o; };
  const sec = (id, body) => [id, ...leb(body.length), ...body];
  // module of `funcs` functions, each with `locals` i32 locals and `nops` nop bytes
  const mod = (funcs, nops, locals = 0) => {
    const body = [...(locals ? [1, ...leb(locals), 0x7f] : [0]), ...new Array(nops).fill(0x01), 0x0b];
    const fn = [...leb(body.length), ...body];
    const code = [...leb(funcs)]; const fb = new Uint8Array(1); // assemble below
    const parts = [new Uint8Array([0,97,115,109,1,0,0,0, ...sec(1, [1,0x60,0,0]), ...sec(3, [...leb(funcs), ...new Array(funcs).fill(0)])])];
    const cs = [...leb(funcs)]; const csz = cs.length + funcs * fn.length;
    const hdr = new Uint8Array([10, ...leb(csz), ...cs]);
    const out = new Uint8Array(parts[0].length + hdr.length + funcs * fn.length);
    out.set(parts[0]); out.set(hdr, parts[0].length);
    const f = new Uint8Array(fn); for (let i = 0; i < funcs; i++) out.set(f, parts[0].length + hdr.length + i * fn.length);
    return out;
  };
  const ok = (b, how = "sync") => { try { if (how === "sync") new WebAssembly.Module(b); else WebAssembly.validate(b) || (() => { throw new Error("invalid"); })(); return true; } catch (e) { return e.message.slice(0, 90); } };
  const o = { bodyBytes: {}, locals: {}, syncMain: {} };
  for (const n of [1 << 16, 1 << 17, (1 << 17) + 64, 1 << 20, 7_000_000, 7_654_000, 7654321, 8_000_000]) { const b = mod(1, n); o.bodyBytes[n] = (() => { try { return WebAssembly.validate(b) ? "valid" : "invalid"; } catch (e) { return e.message.slice(0, 80); } })(); }
  for (const n of [50000, 50001]) { const b = mod(1, 0, n); o.locals[n] = (() => { try { return WebAssembly.validate(b) ? "valid" : "invalid"; } catch (e) { return e.message.slice(0, 80); } })(); }
  for (const mb of [0.004, 0.005, 1, 4, 8, 9, 16]) { const total = mb * 1048576; const per = 1 << 14; const b = mod(Math.ceil(total / per), per); o.syncMain[mb + "MB(" + b.length + ")"] = ok(b); }
  o.asyncMain9MB = await WebAssembly.compile(mod(600, 1 << 14)).then(() => "ok", e => e.message.slice(0, 80));
  return o;
};
const run = async (page) => {
  const r = await page.evaluate(featureFn, bytes);
  if (!rest.includes("--nolimits")) Object.assign(r, await page.evaluate(limitFn));
  return r;
};
const browser = await { chrome: () => chromium.launch({ channel: "chrome", headless: true, args: flags.length ? [`--js-flags=${flags.join(" ")}`] : [] }),
  chromium: () => chromium.launch({ headless: true, args: flags.length ? [`--js-flags=${flags.join(" ")}`] : [] }),
  webkit: () => webkit.launch({ headless: true }) }[name]();
const p = await browser.newPage(); await p.goto("about:blank");
console.log(JSON.stringify(await run(p), null, 1));
await browser.close();
