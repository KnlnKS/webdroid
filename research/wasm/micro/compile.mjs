import { wat, inChrome } from "./lib.mjs";
const gen = (N, R) => {
  let s = `(module (memory 1) (table ${N} funcref) (type $t (func (param i32 i32) (result i32)))\n`;
  const fns = [];
  for (let i = 0; i < N; i++) {
    let b = "";
    for (let k = 0; k < R; k++) b += `(local.set $a (i32.add (i32.mul (local.get $a) (i32.const ${k+3})) (i32.load offset=${(k%8)*4} (local.get $p))))\n (if (i32.gt_s (local.get $a) (i32.const ${k*7})) (then (i32.store offset=${(k%4)*4} (local.get $p) (local.get $a))))\n`;
    s += `(func $f${i} (param $p i32) (param $a i32) (result i32) ${b} (local.get $a))\n`; fns.push(`$f${i}`);
  }
  s += `(elem (i32.const 0) func ${fns.join(" ")})
 (func (export "go") (param $x i32) (param $lim i32) (result i32) (local $i i32) (local $s i32)
   (block $d (loop $l (br_if $d (i32.ge_u (local.get $i) (local.get $lim)))
     (local.set $s (i32.add (local.get $s) (call_indirect (type $t) (i32.const 0) (local.get $x) (local.get $i))))
     (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l))) (local.get $s)))`;
  return s;
};
const out = {};
for (const [N, R] of [[2000, 12], [20000, 12]]) {
  const bytes = wat(gen(N, R));
  out[`N${N}`] = await inChrome(async ({ bytes, N }) => {
    const u = new Uint8Array(bytes), o = { size: u.length };
    let t = performance.now(); const m = new WebAssembly.Module(u); o.syncCompile_ms = +(performance.now() - t).toFixed(1);
    t = performance.now(); const i = new WebAssembly.Instance(m); o.instantiate_ms = +(performance.now() - t).toFixed(1);
    t = performance.now(); i.exports.go(1, 10); o.call10_ms = +(performance.now() - t).toFixed(2);
    t = performance.now(); i.exports.go(1, N); o.callAll_first_ms = +(performance.now() - t).toFixed(1);
    t = performance.now(); i.exports.go(1, N); o.callAll_second_ms = +(performance.now() - t).toFixed(2);
    t = performance.now(); for (let k = 0; k < 50; k++) i.exports.go(1, N); o.callAll_after50_ms = +((performance.now() - t) / 50).toFixed(3);
    return o;
  }, { bytes: [...bytes], N });
}
console.log(JSON.stringify(out, null, 1));
