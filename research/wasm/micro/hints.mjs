import { wat, inChrome } from "./lib.mjs";
const base = wat(`(module
 (type $o (struct (field (mut (ref null $o))) (field (mut i32)) (field (mut i32)) (field (mut (ref null $o)))))
 (global $sink (mut (ref null $o)) (ref.null $o))
 (func (export "hot") (param $n i32) (result i32) (local $i i32) (local $t (ref null $o))
   (loop $l (local.set $t (struct.new $o (local.get $t) (local.get $i) (i32.const 0) (ref.null $o)))
     (if (i32.eqz (i32.and (local.get $i) (i32.const 255))) (then (global.set $sink (local.get $t)) (local.set $t (ref.null $o))))
     (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n)))) (local.get $i)))`);
// splice a compilationHints custom section before the code section (id 10)
function withHint(bytes, hintByte) {
  const u = [...bytes]; let p = 8, at = -1;
  const leb = (i) => { let v = 0, s = 0, b; do { b = u[i++]; v |= (b & 127) << s; s += 7; } while (b & 128); return [v, i]; };
  while (p < u.length) { const id = u[p]; const [len, q] = leb(p + 1); if (id === 10) { at = p; break; } p = q + len; }
  const name = [...new TextEncoder().encode("compilationHints")];
  const payload = [name.length, ...name, 1, hintByte];
  return new Uint8Array([...u.slice(0, at), 0, payload.length, ...payload, ...u.slice(at)]);
}
const variants = { none: [...base], eager_optimized: [...withHint(base, 0b00101010)], eager_baseline: [...withHint(base, 0b00000110)] };
const out = {};
for (const [k, bytes] of Object.entries(variants)) {
  out[k] = await inChrome(async ({ bytes }) => {
    const e = (await WebAssembly.instantiate(new Uint8Array(bytes))).instance.exports;
    await new Promise(r => setTimeout(r, 300));
    const t = performance.now(); e.hot(200_000_000); const first = performance.now() - t;
    const t2 = performance.now(); e.hot(200_000_000); const second = performance.now() - t2;
    return { first_ms: +first.toFixed(0), second_ms: +second.toFixed(0) };
  }, { bytes });
}
console.log(JSON.stringify(out));
