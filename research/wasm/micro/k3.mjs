import { wat, inChrome } from "./lib.mjs";
// linked list walk: precise field types vs uniform base type + ref.cast on each use (depth-4 hierarchy)
const mk = (cast) => wat(`(module
 (rec (type $O (sub (struct (field i32))))
 (type $P (sub $O (struct (field i32) (field i32))))
 (type $Q (sub $P (struct (field i32) (field i32) (field i32))))
 (type $N (sub $Q (struct (field i32) (field i32) (field i32) (field ${cast ? "(mut (ref null $O))" : "(mut (ref null $N))"} ) (field (mut i32))))))
 (func (export "build") (param $n i32) (result (ref null $N)) (local $h (ref null $N)) 
   (loop $l (local.set $h (struct.new $N (i32.const 0) (i32.const 0) (i32.const 0) (local.get $h) (local.get $n)))
     (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
   (local.get $h))
 (func (export "walk") (param $h (ref null $N)) (param $reps i32) (result i32) (local $s i32) (local $c (ref null $N))
   (loop $r (local.set $c (local.get $h))
     (block $done (loop $l (br_if $done (ref.is_null (local.get $c)))
       (local.set $s (i32.add (local.get $s) (struct.get $N 4 (local.get $c))))
       (local.set $c ${cast ? "(ref.cast (ref null $N) (struct.get $N 3 (local.get $c)))" : "(struct.get $N 3 (local.get $c))"})
       (br $l)))
     (br_if $r (local.tee $reps (i32.sub (local.get $reps) (i32.const 1)))))
   (local.get $s)))`);
const r = await inChrome(async ({ a, b }) => {
  const out = {}; const time = (f) => { f(); const t = []; for (let i = 0; i < 5; i++) { const x = performance.now(); f(); t.push(performance.now() - x); } t.sort((a,b)=>a-b); return +t[2].toFixed(1); };
  for (const [k, bytes] of [["precise", a], ["cast_each_use", b]]) {
    const e = (await WebAssembly.instantiate(new Uint8Array(bytes))).instance.exports;
    const h = e.build(1000);
    out[k + "_ms"] = time(() => e.walk(h, 100000));
  }
  class N { constructor(n, v) { this.next = n; this.v = v; } }
  let h = null; for (let i = 1000; i > 0; i--) h = new N(h, i);
  const jw = (h, reps) => { let s = 0; while (reps-- > 0) for (let c = h; c !== null; c = c.next) s += c.v; return s | 0; };
  out.js_ms = time(() => jw(h, 100000));
  return out;
}, { a: [...mk(false)], b: [...mk(true)] });
console.log(JSON.stringify(r));
