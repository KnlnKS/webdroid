# Wasm platform status

Engine support for what the Wasm tier uses. Dated rows and sections were measured on this host (availability and
limits, not speed). Recheck the secondary sources before relying on them.

Reproduce from `research/wasm` after `pnpm install`:
- `node probe.mjs <chrome|chromium|webkit> [--flags=a,b] [--nolimits]`: the matrix, as JSON
- `DEBUG=pw:browser node probe-tiering.mjs hints [chrome|chromium|node]` reads V8's `--trace-wasm-compilation-times`;
  `node probe-tiering.mjs cache [chrome|chromium] [http,sw,cache]` takes `MB`, `HOT`, `OPTIONS=0`, `HEADED=1` and `JS_FLAGS`.

## Measured matrix (2026-10-04; JSPI rows 2026-10-07)

Builds: Chrome 153.0.8010.53, Playwright Chromium 151.0.7922.34, Playwright WebKit 2359 (Safari 26.5 UA, JSC). Firefox:
not measured. Playwright's Firefox 153 Nightly (firefox-1538) does not start here. Juggler never connects, and a headless
launch reports `sandbox_extension_issue_file_to_process ... Operation not permitted`.

| Fact | Chrome 153, Chromium 151 | WebKit 2359 |
|---|---|---|
| GC; exnref EH (`try_table`, `catch_all_ref`); legacy EH; `return_call`; extended const | yes | yes |
| Multi-memory; memory64; relaxed SIMD | yes | no |
| `wasm:js-string` builtins (`builtins:["js-string"]`) | yes | yes |
| JSPI suspend and resume through Wasm, also after a same-module tail call | yes | yes |
| JSPI after a cross-module `return_call_ref` | yes | no: `JSPI stack scan failed: unrecognized type of Wasm frame: RestoreFrameMode` |
| JSPI suspending through a JS frame | `SuspendError: trying to suspend JS frames` | "JavaScript frames found between WebAssembly.Suspending and ..." |
| `Atomics.waitAsync` | yes | yes |
| SharedArrayBuffer | only when cross-origin isolated (`about:blank` is not) | same |
| Custom descriptors | Chrome only with `--js-flags=--experimental-wasm-custom-descriptors` (rec group of `0x4d idx` then `0x4c idx` structs); Chromium not run | no |
| Compilation hints | not parsed (below) | n/a |
| Max function body | 7,654,000 B valid, 7,654,321 B invalid | same |
| Max locals per function | 50,000 valid, 50,001 invalid | same |
| Sync `new WebAssembly.Module` on the main thread | rejects 8 MiB or more ("disallowed on the main thread, if the buffer size is larger than 8M"); 4 MB, and async `compile` of 9 MB, work | no limit up to 16 MB |
| Code cache | optimized code returns from an HTTP response or a Service Worker's Cache Storage, not from `cache.match` (below) | n/a |

These runs corrected two earlier claims: the function body limit is about 7.65 MB in V8 and JSC, not 128 KB, and
Chrome's main-thread sync-compile limit is 8 MiB, not 4 KB. The 50,000-locals figure stands. WasmFX was not probed.

**JSPI with tail calls (2026-10-07).** A 64-case control varied caller and callee arity (0, 1, 4, 16) and instance
identity. Chromium passed all 64; in WebKit exactly the 16 cross-instance tail cases failed. Separate feature support
did not establish the composition. The failure stopped guarded FitNotes startup on WebKit, where a ClassLoader
constructor deoptimized into cold resume. Ordinary startup rendered, covering only the observed paths. The guarded
tier was removed on 2026-10-13, and the compiler emits no tail calls now.

## JSPI under node (2026-10-04, node 24.19 / V8 13.6, M4 Pro)

Node needs `--experimental-wasm-jspi` (package.json scripts start through `scripts/node`, which passes it). Chrome 153 has JSPI on by default.

| Fact | Result |
|---|---|
| Plain import called from Wasm | 4 ns |
| Suspending import answering a number | 52 ns. It still suspends and microtasks run, in this order: caller continues, queued microtask, import returns |
| Suspending import, async function answering at once | 46 ns |
| 1,000 stacks suspended in one import: start / resume | 2.5 ms / 0.5 ms |
| Recursion depth, trivial frame | main stack 15,500; `promising` stack 16,500 (same limit); `--stack-size` scales both |
| Stack-overflow RangeError under `try_table catch_all` | not caught on either stack; escapes to the caller |
| `WebAssembly.promising(f)(x)` + await vs a plain call | 1.4 µs vs 0.9 µs |
| Suspending import on a non-`promising` stack | `SuspendError: trying to suspend without WebAssembly.promising`, even for a plain value |

## Compilation hints (2026-10-04)

- Encoding: a `compilationHints` section before the code section, one byte per function. Bits 0-1 are the strategy
  (1 lazy, 2 eager, 3 lazy baseline then eager top tier). Bits 2-3 and 4-5 are the baseline and top tiers
  (1 baseline, 2 optimized).
- Chrome 153 and Chromium 151 ignore it, with or without `--experimental-wasm-compilation-hints`. The trace is
  identical for every value and a wrong count is accepted. `metadata.code.compilation_priority` is inert too.
- Node 24.19 with that flag runs the same bytes as specified. `0x2a` compiles with TurboFan before instantiation,
  `0x26` runs Liftoff then TurboFan, `0x06` Liftoff eagerly, and a wrong count is a CompileError.
- With `--wasm-dynamic-tiering` off, V8 tiers every function up eagerly. Pages cannot set that switch.

## Code cache

- **2026-10-19**, `MB=8 node probe-tiering.mjs cache chrome`: an 8 MB module compiled with the tier's options, lazy
  compilation and dynamic tiering, eight hot functions tiered up, then 8 s idle; a fresh browser per launch on one
  profile. A later launch's first call ran at optimized speed (2.2–2.6 ms, against 3.7–4.4 ms in Liftoff):
  - from an `immutable` HTTP response from launch 2, on the page and in a Worker;
  - from a Service Worker answering out of Cache Storage from launch 3 (launch 2 is the first to read that entry);
  - never from `compileStreaming` of a `cache.match` response.
  Headed runs and dropping the compile options changed nothing. With one hot function nothing was cached until
  `--wasm-caching-threshold` was lowered: V8 caches a module once it holds 1 KB of new optimized code and has compiled
  nothing for 2 s (`--wasm-caching-timeout-ms`), or at once at 1 MB.
- The earlier "not observed" runs (2026-10-04, 10-11) compiled eagerly or from bytes.

## Engines without JSPI

Without JSPI, Java does not run, so Firefox and Safari releases before JSPI are unsupported. Rejected substitutes:
asyncify or a CPS transform, which brings back the resumable-body cost that JSPI removes, and Java threads across
Workers, since Wasm GC objects cannot be shared between them.

## Secondary sources (recheck)

- JSPI: Phase 4. Chrome 137+, Safari 27. Firefox: 139+ per v8.dev/blog/jspi, 153 (2026-07-21) per another source.
  A claimed ~1 µs per suspending call; node measured ~50 ns.
- Safari: GC and tail calls in 18.2, exnref EH in 18.4.
- memory64: Chrome 133, Firefox 134, not in Safari. Caps are 4 GB on Chrome desktop and 2 GB on Firefox, and mobile
  Chrome gets about 500-700 MB. It costs 10% to over 100% in speed (v8.dev/blog/4gb-wasm-memory).
- Custom descriptors (Phase 3; Java, Kotlin, Dart): an origin trial in Chrome 149, not shipped.
- WasmFX is Phase 3 and behind a flag in V8. Shared-everything threads are Phase 1.
- V8 `wasm-limits.h`: 1,000,000 types, functions and globals; 1 GiB module; 100,000 imports and exports.

To check: branch hinting; `call_ref`, `ref.cast` and boundary costs; instance limits; Firefox.
