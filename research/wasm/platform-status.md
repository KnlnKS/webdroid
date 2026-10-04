# Wasm platform status for a DEX-to-Wasm design (as of 2026-10-04)

Evidence level: PARTIAL. Only the claims with a URL were checked this session. Items marked UNVERIFIED come from
training data and need a primary-source check before they drive a decision. Several fetches (webassembly.org/features,
which loads its table dynamically) returned no table data. Searches 11-13 were thin. Most sources below are secondary summaries.

## Verified (with sources)
- Wasm 3.0 includes GC, memory64, exception handling (exnref), tail calls, multi-memory:
  https://platform.uno/blog/the-state-of-webassembly-2025-2026/ , https://devnewsletter.com/p/state-of-webassembly-2026/
- Safari: GC and tail calls in 18.2; exnref EH in 18.4; Safari lacks memory64.
  https://heise.de/-10258626 , https://platform.uno/blog/state-of-webassembly-2024-2025/ , https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html
- wasm:js-string builtins: Chrome and Firefox (Safari status in that source unclear / UNVERIFIED).
- memory64: Chrome 133, Firefox 134, no Safari. Chrome desktop cap 4GB. Mobile Chrome ~500-700MB in practice. Firefox 2GB. Safari has no defined limit and kills the tab.
  64-bit mode costs 10% to over 100% in speed (bounds checks, no guard-page trick).
  https://v8.dev/blog/4gb-wasm-memory , https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html
- JSPI: Phase 4. Chrome 137+, Firefox shipped (v8.dev says 139+; one secondary source says Firefox 153 on 2026-07-21, so the Firefox version CONFLICTS and needs a check). Safari 27 added it.
  About 1 us overhead per suspending call. JS frames cannot be suspended; a suspension through a JS frame between the Wasm export and the Suspending import traps.
  https://v8.dev/blog/jspi , https://github.com/mdn/browser-compat-data/pull/30552 , https://daily.dev/posts/safari-27-brings-top-level-await-and-webassembly-jspi-to-all-browsers-ajkb9qiuh
- Stack switching (WasmFX): Phase 3. V8 has it behind --experimental-wasm-wasmfx. wasm_of_ocaml and Hoot are targeting it. No shipped browser support.
  https://github.com/WebAssembly/stack-switching , https://ocaml.org/backstage/2026-04-16-wasm-of-ocaml-what-changed-since-6-1
- Custom descriptors: Phase 3. Chrome 149 (2026-06-02) lists it as an ORIGIN TRIAL, not shipped. It targets Java, Kotlin and Dart. A secondary source says "shipped"; the primary release note says origin trial.
  https://developer.chrome.com/release-notes/149 , https://github.com/WebAssembly/custom-descriptors
- Shared-everything threads (shared GC structs): Phase 1. Not usable. https://github.com/WebAssembly/proposals
- V8 limits: 1,000,000 types, functions and globals; 1 GiB module; 128 KB max function body (kMaxWasmFunctionSize); 50,000 locals; 100,000 imports and exports.
  https://chromium.googlesource.com/v8/v8/+/master/src/wasm/wasm-limits.h
- CheerpJ 3: Wasm-hosted JVM with interpreter plus JIT, no AOT, unmodified OpenJDK. https://labs.leaningtech.com/blog/cheerpj-3-deep-dive
- Benchmarks (marketing-grade, not controlled): Dart/Flutter Wasm about 2x avg and 3x worst-case frame rendering vs JS; Kotlin/Wasm 60-80% smaller bundles than Kotlin/JS; virtual-call-heavy code can still favor JS thanks to speculative inlining.
  https://foresightmobile.com/blog/wasmgc-and-how-this-is-a-game-changer-for-dart-and-flutter , https://www.kmpship.app/blog/kotlin-wasm-and-compose-web-2025 , https://reintech.io/blog/webassembly-garbage-collection-wasmgc-complete-guide

## UNVERIFIED (training knowledge; check before relying)
- Chrome GC 119, EH exnref 137?, tail calls 112, multi-memory 120, relaxed SIMD 114, extended-const 114, JS string builtins 130, Firefox GC 120, Firefox tail calls 121.
- Rec groups with isorecursive canonicalization: types are canonicalized across modules, so equal structural rec groups interoperate. No runtime-defined subtypes beyond generating a new module per type set.
- Threads need cross-origin isolation (COOP same-origin plus COEP require-corp/credentialless) for SharedArrayBuffer. Iframes need allow="cross-origin-isolated" and cross-origin embedded resources need CORP/CORS. Atomics.waitAsync is in Chrome and Firefox; Safari UNVERIFIED. Atomics.wait is disallowed on the main thread.
- V8: Liftoff baseline then TurboFan tier-up via dynamic tiering and lazy compilation; compile on background threads; compileStreaming code caching in the HTTP cache; the old 4KB sync-compile limit on the main thread applies only to Chrome and may be lifted.
- Call_indirect on funcref tables has a signature check; call_ref avoids the table bounds check. ref.cast to a final type is cheap; cast to a non-final type walks the supertype array (constant time in V8).
- JS-Wasm call boundary ~ tens of ns after inlining.
- Published GC experience: Kotlin/Wasm, dart2wasm, J2CL/J2Wasm, TeaVM and wasm_of_ocaml all use WasmGC with the host collector. Dynamic class loading is the weak spot for all of them; only CheerpJ (a linear-memory JVM written in C++) and Blazor (interpreter) support it. Hoot uses stack switching for continuations.

## Assumptions that are false or outdated (verified items only)
| Assumption | 2026 reality | Source |
|---|---|---|
| Safari lacks GC/EH/tail calls | Safari 18.2/18.4 ship them | heise link above |
| JSPI is Chrome-only/experimental | Phase 4; Chrome, Firefox, Safari 27 | v8.dev/blog/jspi |
| memory64 gives 16 GB | Chrome 4GB cap, Firefox 2GB, mobile far less, Safari none | v8.dev/blog/4gb-wasm-memory |
| memory64 is free | 10% to 100%+ slowdown | spidermonkey.dev post |
| Stack switching is available | Phase 3, V8 flag only | stack-switching repo |
| Custom descriptors shipped | Origin trial in Chrome 149 | Chrome 149 notes |
| Wasm GC objects can be shared across workers | shared-everything is Phase 1 | proposals repo |
| Functions can be unlimited size | 128 KB body limit in V8 | wasm-limits.h |

## Blockers per design
- Wasm GC: no cross-worker object sharing (single-threaded Java only, or message-passing); no runtime-defined subtypes except by generating modules (feasible, per-class module cost UNMEASURED); no stack switching, so Java thread semantics and blocking calls must use JSPI (cannot cross JS frames) or CPS/state-machine transformation; itable and vtable dispatch cost until custom descriptors ship (origin trial only); GC heap control and memory pressure on iOS are opaque.
- Linear memory with own GC: gets threads over SharedArrayBuffer and cross-origin isolation; pays 4GB (desktop) and ~500-700MB (mobile) caps, own GC and write barriers, memory64 slowdown if >4GB; JIT module generation shares memory and tables fine; blocked on COOP/COEP deployment for third-party embedding and on stack switching for green threads (use real workers).
- Hybrid (GC for objects, linear memory for natives): inherits both; the ARM emulator core already uses linear memory. Genuine open item: threads still require shared linear memory, and shared GC objects do not exist, so Java objects stay per-worker.

## Not answered (needs follow-up)
Items 10 (branch hinting, call_ref perf), 11 (tiering thresholds, code cache), 12 (instantiation cost, instance limits), 13 (citations for TeaVM, J2CL, Blazor, Go, Hoot lessons) and the ref.cast and boundary-cost numbers were not verified. Do not cite their UNVERIFIED lines as fact.
