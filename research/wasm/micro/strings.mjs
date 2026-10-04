// G5 micro-costs: the String operations the compiler emits, over a JS string through the wasm:js-string builtins (externref) and over a struct
// holding an i16 array. Usage: node strings.mjs [node|chrome]; prints ns per operation (the loop around it included).
import { wat, inChrome } from "./lib.mjs";
const S = "The quick brown fox jumps over the lazy dog, again and again", T = "The quick brown fox jumps over the lazy dog, again and again";
const loop = (name, params, body) => `(func (export "${name}") (param $s externref) (param $t externref) (param $a (ref $str)) (param $b (ref $str)) (param $reps i32) (result i32)
  (local $r i32) (local $i i32) (local $n i32) (local $acc i32) (local $h i32) (local $x (ref null $c)) (local $y (ref null $c))
  (loop $rl ${body} (br_if $rl (i32.lt_u (local.tee $r (i32.add (local.get $r) (i32.const 1))) (local.get $reps)))) (local.get $acc))`;
const inner = (n, body) => `(local.set $i (i32.const 0)) (block $d (loop $l (br_if $d (i32.ge_u (local.get $i) ${n})) ${body} (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))`;
const jsLen = "(call $len (local.get $s))", arrLen = "(array.len (struct.get $str 0 (local.get $a)))";
const text = `(module
 (type $c (array (mut i16)))
 (type $str (struct (field (ref $c)) (field (mut i32))))
 (import "wasm:js-string" "length" (func $len (param externref) (result i32)))
 (import "wasm:js-string" "charCodeAt" (func $cc (param externref i32) (result i32)))
 (import "wasm:js-string" "concat" (func $cat (param externref externref) (result (ref extern))))
 (import "wasm:js-string" "substring" (func $sub (param externref i32 i32) (result (ref extern))))
 (import "wasm:js-string" "equals" (func $eq (param externref externref) (result i32)))
 (import "wasm:js-string" "fromCharCodeArray" (func $fca (param (ref null $c) i32 i32) (result (ref extern))))
 (import "wasm:js-string" "intoCharCodeArray" (func $ica (param externref (ref null $c) i32) (result i32)))
 ;; charAt as the compiler emits it: a bounds test against the length, then the unit
 ${loop("js_chars", 0, inner(jsLen, "(local.set $acc (i32.add (local.get $acc) (if (result i32) (i32.lt_u (local.get $i) (call $len (local.get $s))) (then (call $cc (local.get $s) (local.get $i))) (else (i32.const -1)))))"))}
 ${loop("arr_chars", 0, inner(arrLen, "(local.set $acc (i32.add (local.get $acc) (if (result i32) (i32.lt_u (local.get $i) (array.len (struct.get $str 0 (local.get $a)))) (then (array.get_u $c (struct.get $str 0 (local.get $a)) (local.get $i))) (else (i32.const -1)))))"))}
 ${loop("js_hash", 0, `(local.set $h (i32.const 0)) ${inner(jsLen, "(local.set $h (i32.add (i32.mul (local.get $h) (i32.const 31)) (call $cc (local.get $s) (local.get $i))))")} (local.set $acc (i32.add (local.get $acc) (local.get $h)))`)}
 ${loop("arr_hash", 0, `(local.set $h (i32.const 0)) ${inner(arrLen, "(local.set $h (i32.add (i32.mul (local.get $h) (i32.const 31)) (array.get_u $c (struct.get $str 0 (local.get $a)) (local.get $i))))")} (local.set $acc (i32.add (local.get $acc) (local.get $h)))`)}
 ${loop("js_substr", 0, inner("(i32.const 50)", "(local.set $acc (i32.add (local.get $acc) (call $len (call $sub (local.get $s) (local.get $i) (i32.add (local.get $i) (i32.const 4))))))"))}
 ${loop("arr_substr", 0, inner("(i32.const 50)", `(local.set $x (array.new_default $c (i32.const 4))) (array.copy $c $c (local.get $x) (i32.const 0) (struct.get $str 0 (local.get $a)) (local.get $i) (i32.const 4))
   (local.set $acc (i32.add (local.get $acc) (array.len (struct.get $str 0 (struct.new $str (ref.as_non_null (local.get $x)) (i32.const 0))))))`))}
 ${loop("js_concat", 0, `(local.set $acc (i32.add (local.get $acc) (call $len (call $cat (local.get $s) (local.get $t)))))`)}
 ${loop("arr_concat", 0, `(local.set $x (array.new_default $c (i32.add ${arrLen} (array.len (struct.get $str 0 (local.get $b))))))
   (array.copy $c $c (local.get $x) (i32.const 0) (struct.get $str 0 (local.get $a)) (i32.const 0) ${arrLen})
   (array.copy $c $c (local.get $x) ${arrLen} (struct.get $str 0 (local.get $b)) (i32.const 0) (array.len (struct.get $str 0 (local.get $b))))
   (local.set $acc (i32.add (local.get $acc) (array.len (struct.get $str 0 (struct.new $str (ref.as_non_null (local.get $x)) (i32.const 0))))))`)}
 ${loop("js_equals", 0, `(local.set $acc (i32.add (local.get $acc) (call $eq (local.get $s) (local.get $t))))`)}
 ${loop("arr_equals", 0, `(local.set $x (struct.get $str 0 (local.get $a))) (local.set $y (struct.get $str 0 (local.get $b)))
   (if (i32.eq (array.len (local.get $x)) (array.len (local.get $y))) (then (local.set $h (i32.const 1)) ${inner("(array.len (local.get $x))", "(if (i32.ne (array.get_u $c (local.get $x) (local.get $i)) (array.get_u $c (local.get $y) (local.get $i))) (then (local.set $h (i32.const 0)) (br $d)))")} (local.set $acc (i32.add (local.get $acc) (local.get $h)))))`)}
 ;; crossing to the host and back
 ${loop("arr_tojs", 0, `(local.set $acc (i32.add (local.get $acc) (call $len (call $fca (struct.get $str 0 (local.get $a)) (i32.const 0) ${arrLen}))))`)}
 ${loop("js_tostruct", 0, `(local.set $x (array.new_default $c (call $len (local.get $s)))) (drop (call $ica (local.get $s) (local.get $x) (i32.const 0)))
   (local.set $acc (i32.add (local.get $acc) (array.len (struct.get $str 0 (struct.new $str (ref.as_non_null (local.get $x)) (i32.const 0))))))`)}
 (func (export "mk") (param externref) (result (ref $str)) (local $x (ref $c))
   (local.set $x (array.new_default $c (call $len (local.get 0)))) (drop (call $ica (local.get 0) (local.get $x) (i32.const 0))) (struct.new $str (local.get $x) (i32.const 0)))
)`;
const bytes = [...wat(text)];
const run = async ([bytes, S, T]) => {
  const { instance } = await WebAssembly.instantiate(new Uint8Array(bytes), {}, { builtins: ["js-string"] });
  const e = instance.exports, a = e.mk(S), b = e.mk(T), out = {};
  const reps = 20000;
  for (const name of Object.keys(e).filter((k) => /^(js|arr)_/.test(k))) {
    const per = /chars|hash/.test(name) ? S.length : /substr/.test(name) ? 50 : 1;
    for (let w = 0; w < 5; w++) e[name](S, T, a, b, reps / 10);
    const t = [];
    for (let k = 0; k < 7; k++) { const t0 = performance.now(); e[name](S, T, a, b, reps); t.push((performance.now() - t0) * 1e6 / (reps * per)); }
    t.sort((x, y) => x - y); out[name] = +t[3].toFixed(2);
  }
  return out;
};
const which = process.argv[2] ?? "node";
const res = which === "chrome" ? await inChrome(`async ([bytes,S,T]) => (${run})([bytes,S,T])`, [bytes, S, T]) : await run([bytes, S, T]);
const rows = Object.keys(res).filter((k) => k.startsWith("js_")).map((k) => [k.slice(3), res[k], res["arr_" + k.slice(3)]]);
console.log(which, "ns per char / call (string of", S.length, "chars)");
for (const [k, j, a] of rows) console.log(k.padEnd(8), "js", String(j).padStart(8), "array", String(a ?? "-").padStart(8));
for (const k of ["arr_tojs", "js_tostruct"]) console.log(k.padEnd(12), res[k]);
