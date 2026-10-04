# Plan: compile DEX to WebAssembly

Branch `knlnks/bytecode-wasm` (worktree `../webdroid-wasm`), from `knlnks/bytecode` at `5ad1d22a`.
Research only: no production code changed. Everything new is under `research/wasm/` and this file.
This is a report plus a staged plan for a different coding agent to execute.

## 0. How to read this

- **Measured** = I ran it (Chrome 153 on an M4 Pro, headless, single runs, other agents idle or lightly
  loaded; treat as indicative, rerun under the AGENTS.md measurement rules before relying on any number).
- **Reported** = a sub-agent counted or read it; scripts are in `research/wasm/`.
- **Inferred** = reasoning, not tested. Every inferred claim that a stage depends on has a gate in section 6.
- The earlier analysis (docs/decisions/0003, docs/dex-performance-architecture.md "Rejected") said a Java Wasm
  backend has "no eligible numeric bottleneck" and that Wasm would "add host crossings". Both assume Java
  objects stay JS objects and natives stay JS. Neither was measured. This plan does not inherit them.

Research artifacts:

| Path | Content |
|---|---|
| `research/wasm/micro/*.mjs` | microbenchmarks (alloc/GC, i64, dispatch, JSPI, compile, EH, interop, modules, tier-up) |
| `research/wasm/gc/` | Zig mark-sweep collector for a linear-memory heap, benchmark driver |
| `research/wasm/dexstats/REPORT.md` | opcode, type-inference, method-size, CFG, CHA statistics over 704k methods |
| `research/wasm/native-survey.md` | how the ~75k lines of TS touch Java values (counts per category and per file) |
| `research/wasm/runtime-inventory.md` | ~40 runtime facilities: JS mechanism, Wasm need, essential vs artefact |
| `research/wasm/platform-status.md` | Wasm feature status by browser (partly unverified, see section 5) |
| `research/wasm/j2w/` | DEX to Wasm-GC prototype compiler (incomplete, see section 4.4) |

## 1. Findings that drive the design

### 1.1 Execution speed (measured)

| Kernel | JS (current idioms) | Wasm GC | Linear memory |
|---|---|---|---|
| Binary tree build + walk, depth 18 x 20, engine GC | 73 ms | 33 ms | 27 ms (bump, **no GC**) |
| Same, with a 32 MB live tree kept | 73 ms | 33 ms | 97 ms (my naive mark-sweep, 7.5 ms per GC) |
| 64-bit xorshift | ~147 ms (BigInt, scaled from 1/10 run) | 41 ms | n/a |
| Virtual call, 2 receiver classes | 33 ms | 24 ms (`call_ref`) | not run |
| Pointer chase over a 1000-node list | 124 ms | 123 ms, with or without `ref.cast` per access | not run |
| Allocation churn, no live heap | 67 to 209 ms | 52 to 173 ms | not run |

- Wasm GC is 2.2x faster than JS on allocation-heavy graph code and 3.6x on `long` math. It is **not** faster on
  pointer chasing; a gain claim for Compose-like code is unproven until section 6 gate G1.
- `ref.cast` on every field access is invisible in the pointer-chase kernel.
- A simple non-generational mark-sweep in linear memory is about as fast as JS and 2 to 3x slower than V8's
  generational GC. Matching V8 needs a generational collector with write barriers. That is real engineering, not
  a given.
- Object size: 24 B (Wasm GC struct, 4 fields) vs 28 B (JS object).

### 1.2 Startup and tiering (measured)

- V8 compiles Wasm lazily. A 6.9 MB module with 20,000 functions: `new WebAssembly.Module` 3.7 ms,
  instantiate 0.4 ms, first execution of all 20,000 functions 79 ms (about 4 us per ~350 B function, Liftoff).
  Current launches spend 0.4 to 0.9 s compiling JS and run 120k to 215k cold calls, so Wasm's baseline compile is a
  plausible order-of-magnitude improvement on cold code **if** the platform and app code arrives as ready-made
  binaries (inferred; gate G3).
- Liftoff code ran 2.4x slower than TurboFan (509 ms vs 209 ms for the same loop, first vs second call).
  **There is no OSR**: a long-running loop inside one call stays in baseline code until the function is called
  again. My attempt to force optimized tier-up with a `compilationHints` custom section had no effect in Chrome 153
  (either unsupported or encoded wrongly; unresolved).
- 1,000 tiny modules (each a struct subtype + one function written into a shared imported table): compile +
  instantiate 21 ms total. Calls across modules through the shared table work (13 ns including a JS to Wasm entry).
- Structurally identical struct types **canonicalize to one type across modules**. Two Java classes with the same
  layout and supertype are the same Wasm type, so class identity must live in the object header, not in the Wasm type.
  Subtype casts across modules work.

### 1.3 Suspension (measured)

- JSPI: one `WebAssembly.Suspending` call that actually suspends and resumes costs 40 to 55 ns (a JS `await` is 62 ns).
  Suspension cost does not depend on stack depth. 2,000 concurrently suspended stacks of depth 200 all resumed in 3.3 ms.
- The current design saves 1,000 to 1,300 frames per Mihon tap and has resumable-body compilation; with JSPI all of that
  (SUSPENDED throw, `dfr`, resumable twin, continuation lists) disappears.
- Constraint confirmed: a JS frame between the `promising` entry and the `Suspending` call throws
  `SuspendError: trying to suspend JS frames`. Any native that can call back into Java and that Java can block under
  must itself be Wasm, or be an async function wrapped in `Suspending` (it then runs on the JS side of the boundary,
  which is the existing "driven generator" shape but without per-Java-frame cost).
- Recursion depth with trivial frames: 10,000 fine, 50,000 overflows, same on the main stack. JSPI does not make
  deep Java stacks worse than the current JS runtime; `StackOverflowError` must be synthesized from `RangeError`.
- Stack traces: `new Error().stack` costs 3 to 10 us at depth 5 to 150 for wasm frames (similar to today). Wasm
  throw/catch costs about the same as JS (154 ns vs 221 ns, depth 5).

### 1.4 Interop (measured)

- `WeakRef`, `WeakMap`, `FinalizationRegistry` work with Wasm GC struct references and finalizers fire. GC objects are
  opaque to JS (frozen, null prototype, no expandos). So `===`, Map keys and handle tables keep working; field access
  from TS needs generated accessors.
- `wasm:js-string` builtins work (`length`, `charCodeAt`, `equals`, `fromCharCodeArray`, `intoCharCodeArray`).
  A 54-char hash loop through the builtins is 95 ns vs 44 ns in JS, so keep String.hashCode cached or intrinsified.
- GC byte arrays copy to and from linear memory at about 0.27 ns/byte (4 GB/s) with a 1 to 2 ns call crossing.
  JS cannot view a GC array as a typed array. 190 natives take primitive arrays (reported).

### 1.5 Corpus facts (reported, `dexstats/REPORT.md`)

- Register typing is solved: 704,430 / 704,430 methods infer with no merge conflict; 99.5 to 99.9% are fully
  determined; the rest are `const` feeding a 32-bit `aget`/`aput` (resolved by array element type). 14.8 to 29.8% of
  vregs hold two kinds at different points, so the typing must be per live range, not per vreg. Splitting locals by
  kind costs +4% to +29% locals (mean 3.9 to 6.0 per method, p99 18 to 41, max 420).
- Methods are tiny: median 18 to 36 bytes, 29 to 48% have at most 4 instructions, p99 0.4 to 1.1 KiB, none over 64 KiB.
- 0 to 0.5% of methods fall back to the dispatch loop in the existing `Flow` structurer (Kotlin `invokeSuspend`,
  AIDL `onTransact`). Try ranges are flat (no nesting). 4 to 13.5% of methods have a try.
- Invoke mix: virtual 42 to 58%, interface 6 to 12%, static 16 to 27%, direct 15 to 26%. Class-hierarchy analysis
  finds one target for 82 to 90% of virtual sites (closed world assumption). 47 to 85% of interface sites have three
  or more implementations.
- Only 0.6 to 2.1% of code bytes are numeric-only leaf code. The numeric-kernel argument against Wasm was correct
  as far as it went; the case for Wasm here rests on object layout, `long`, startup, suspension and threading, not on kernels.

### 1.6 Host surface (reported, `native-survey.md`)

- 2,682 registered native entries (floor). 41% take only primitives, longs or handles and touch no object; 29% touch
  fields, call Java, retain objects or rely on identity.
- TS-declared field sites: 1,018 on 79 TS classes, 858 of them in 10 files. Bytecode-class field access through
  `getDeclared`/`setDeclared`/`declaredField`/`fieldOf`: 276 sites; untyped property access about 233; string-keyed
  element access up to 717 (upper bound).
- Java-call helpers: 1,301 sites (`vcall` 812, `newObj` 303, `scall` 138) funnelling through about 8 functions in
  `jentry.ts`; 18 hosted-service files hold 678 of them.
- 403 `driven(` generator natives, 854 `yield*`. This is the largest constraint (suspension), larger than layout.
- 128 files (17.9k lines) have zero coupling to Java object layout (HarfBuzz/sfnt/Skia glue, ciphers, DER, fs, zlib,
  sqlite, the ARM/A64 host layer).

### 1.7 Runtime inventory (reported, `runtime-inventory.md`)

Most JS dependence is an artefact of the design, not a requirement. Genuine new work for a Wasm VM: full register
typing (solved above), explicit null/bounds/zero checks (Wasm traps are not catchable by Wasm EH), class descriptors
and dispatch tables, a class-init protocol, JNI/reflection through descriptors, stack-trace symbolization, module
granularity for lazy linking. Things the JS runtime does wrongly today and a rewrite need not copy: no
`ArrayStoreException`, finalizers never run, `SoftReference` is strong, only one `invoke-custom` bootstrap, strings
compare by value.

## 2. Blockers examined: artefact of today's design, or genuine?

| Claimed blocker | Verdict | Why |
|---|---|---|
| "No suspension in Wasm" | **Artefact.** JSPI is available in Chrome (137+) and measured at ~50 ns per switch. | Needs the JS-frame rule above. Firefox/Safari status is reported but unverified. A CPS/unwind mode transcribed from today's design is the fallback. |
| "Java objects are JS objects, natives read fields directly" | **Artefact.** 41% of natives need no change; field access concentrates in 79 classes and 10 files; the rest funnels through ~8 helpers. | Needs a generated accessor layer and a lint. |
| "Dynamic class loading" | **Artefact.** | Module per class group, shared funcref table, cross-module struct subtyping works (measured). Shape-only Wasm types plus header identity. |
| "Crossings would dominate" | **Artefact.** | The crossing is 1 to 2 ns for scalars. The cost is JS-resident natives that pass strings and arrays; those move to builtins/copies or into Wasm. Gate G5. |
| "Needs a GC of our own" | **Choice.** | Wasm GC removes it. A linear-memory heap is the alternative and costs a GC (section 3). |
| "No OSR in Wasm" | **Genuine, mitigable.** | Back-edge counters already exist for preemption; use them as a voluntary re-entry into the tiered-up function (state transfer through the same frame record JSPI does not need, so this needs its own small mechanism) or outline hot loops. Gate G4. |
| "Wasm traps are uncatchable (NPE, AIOOBE, div)" | **Genuine, cheap.** | Emit explicit checks; V8 removes dominated duplicates (to verify in G1). |
| "Boot image impossible with Wasm GC" | **Partly genuine.** | No engine heap snapshot. A data-driven loader over a build-time image works (inferred). Linear memory would make it a memcpy. Gate G6. |
| "No shared-memory threads with Wasm GC" | **Genuine for Wasm GC** (shared-everything threads are Phase 1). | The project does not need it for Java: processes are already separate realms and Binder carries Parcels. Process-per-Worker (performance-plan item 1.2) is independent of this choice. Linear memory is the only route to threads within one process. |
| "JS strings vs Java strings" | **Design choice with a measured trade-off.** | See 3.4. |
| Safari/Firefox support | **Unverified.** | Platform agent could not confirm; see section 5 and gate G7. |

## 3. Target architecture (recommendation)

Decision: **Wasm GC for the Java heap, JSPI for blocking, ahead-of-time Wasm modules for platform code, a Wasm
interpreter as the cold tier and the deopt target.** Keep the linear-memory VM (section 3.7) as a documented
alternative with explicit triggers for switching.

### 3.1 Object model

- Header: `vt: (ref $VT)` (immutable), `hash: i32` (identity hash, lazily assigned; monitor word added when needed).
  `$VT` is an `i32` array holding class id, depth, a fixed display of ancestor ids, interface-method-table
  (selector, function index) pairs, a slow-path region, an implemented-interface list, and the virtual slots, all as
  function-table indices. This is what `research/wasm/j2w` implements.
- One Wasm struct type per distinct field layout, declared as a subtype of its superclass layout; classes with equal
  layouts share the type. Reference fields are typed `(ref null $Obj)`. Primitive kinds: `i32` (int, short, byte,
  char, boolean, float bits), `i64` (long, double bits).
- Arrays: wrapper struct (header + immutable data array) per element storage kind, so array classes, covariance
  checks, identity hash and `synchronized` work. Evaluate bare arrays for primitives in G5 if the extra load shows.
- Dispatch: CHA devirtualization to direct calls (82 to 90% of virtual sites per the corpus, closed world), vtable
  `call_indirect` otherwise, IMT-style hashing for interface calls. Open-world loading needs a guard or a
  re-link (see 3.3).
- Class identity and subtype tests use the header display, not Wasm `ref.test`. Revisit when custom descriptors
  ship (origin trial in Chrome 149 per the platform report, unverified).

### 3.2 Compiler

- Reuse the existing front end: `prepared.ts` decode and CFG, and `structure.ts` (`Flow`: dominators, loops,
  regions, labelled scopes). Its output maps one-to-one onto Wasm `block`/`loop`/`br`; handlers are separate regions
  entered through a `br_table` dispatcher. The prototype already does this.
- Replace constant typing with a live-range ("web") type inference (kinds I, F, R, J, D), as in
  `dexstats/infer.ts`. Allocate Wasm locals per (vreg, kind) or per web. Decide float handling in G1: floats as
  `f32`/`f64` locals (best code) vs bits in `i32`/`i64` (what the prototype does, simplest, costs reinterprets).
- Exceptions: one Java-throwable tag, `try_table` with a pc-range catch dispatcher for methods with tries, explicit
  null/bounds/divide/cast checks, `trunc_sat` for float to int, guard for `INT_MIN / -1`.
- Fuel/preemption check on back edges (suspend via a `Suspending` import when budget runs out). Reuse it as the
  tier-up trigger (G4).
- Emit binary directly with a small encoder (`research/wasm/j2w/wasmbin.ts`, `code.ts`); no binaryen at runtime.

### 3.3 Linking, tiering and code delivery

- Granularity: module per class group (or per jar chunk for the platform). Instances share one imported funcref table
  and imported globals. Vtables are data (`array.new_data` from a passive segment) holding table indices; slots start
  at per-signature lazy-link stubs.
- Platform code (all boot jars + `framework.jar`): compiled at build time to static `.wasm` assets split by package
  and served with long-lived caching so V8's streaming compile and code cache apply. Hot-method priority hints go in
  if G3 shows they work.
- App code: compiled at install time in workers (the `compileworker.ts` shape), cached in OPFS/Cache Storage.
  Dynamically loaded dex compiles into extra modules.
- Cold tier: a Wasm DEX interpreter (one module, precompiled, shared by all processes). It is also the deopt target
  for any frame that needs to be rebuilt (class redefinition, failed devirtualization guard, GC unwinding if the
  linear-memory design is ever chosen). With JSPI no frame saving is needed for suspension itself.
- Open-world soundness for devirtualization: record the CHA assumptions per module; loading a class that breaks one
  invalidates the module's affected functions (re-link to vtable stubs) before the class becomes visible.

### 3.4 Strings

Default: `java.lang.String` as a JS string (externref, held in a ref slot through `any.convert_extern`), through
`wasm:js-string`. Zero-copy to Canvas, resources, VFS and the proxy. Costs: no field-based hashing (cache the hash in
a side structure or intrinsify), virtual dispatch on `Object` receivers needs an `is string` branch, identity is by
value (already true today). Alternative: String as a struct over an `i16` array with a cached JS string. G5 decides;
the dispatch uniformity argument favors the struct, the boundary cost argument favors the JS string.

### 3.5 Natives and host boundary

- Define the boundary once as a typed ABI, generated from descriptors: scalars and handles pass as `i32`/`f64`/
  `i64`-as-pair or `f64` handle; strings as externref; byte arrays as (copy in, copy out) or as linear-memory
  regions owned by the native; object references as opaque externref. No host function sees a Java field.
- Field access from TS goes through generated accessors (exports per class and field), reached only through the
  existing `getDeclared`-style helpers, plus a lint that forbids property access on Java objects.
- Natives that call back into Java: either Wasm, or `async` TS wrapped in `Suspending`. Replace the 403 `driven`
  generators accordingly.
- Natives that mostly move bytes (bitmap conversion, parcel, zlib, regex, crypto, fs) are rewritten against copy-in
  and copy-out or move into Wasm (Zig) where the data already lives in linear memory.
- JNI: ARM/A64 core stays a separate instance on shared linear memory, JNI refs become handles into a table; the
  Java side exposes handle-in/handle-out entry points. Unifying VM and core in one instance via multi-memory is a
  later option, not a requirement.

### 3.6 Other parts to re-architect with this

1. **Process-per-Worker** (independent of the Wasm choice, enabled by Parcel-serialized Binder): moves non-presented
   process realms off the page thread. Needs enumerating the direct broker/font/file/guest-clock calls (history
   ~3275) and giving each a message or `SharedArrayBuffer` form. SAB needs cross-origin isolation, which the project
   does not use today; the cross-site WebView renderer on Pages would need CORP/COEP headers.
2. **Boot image** (section 6, G6): build-time run of framework initialization, serialized heap image + data-driven
   loader.
3. **Differential testing as the main correctness tool**: the JS tier stays as an oracle during migration; compare
   per-method results and per-step `run.json`.
4. **Tools**: `dis`, `jsrc`, `dbg`, `trace`, `stacklines.ts` need Wasm equivalents (name section, DEX pc side table).
5. **Optional later**: display-list command buffer in shared memory for an OffscreenCanvas render worker.

### 3.7 Alternative: linear-memory VM with its own GC

Pros: threads inside one process (SAB + Atomics, a real answer to "background threads share the page's one
thread"), heap snapshot as a memcpy, zero-copy arrays shared with natives and the ARM core, deterministic memory.
Cons measured or reported: no engine GC so we write one (the naive version is 2 to 3x slower than V8's, see 1.1);
roots need a shadow stack or an "unwind to safepoint" protocol; 4 GB cap on desktop and well under 1 GB on mobile;
cross-origin isolation required for threads; strings must be copied at every host boundary.
**Switch to it only if** G1 shows Wasm GC allocation/GC behaves worse than JS on the app workloads, **or** profiling
(plan step S1) shows background-thread contention is still the dominant hitch source after process-per-Worker.

## 4. Current state of the prototype

### 4.1 What exists (`research/wasm/j2w/`)

`wasmbin.ts` (binary module builder with GC rec/sub types, imports, tags, tables, passive data), `code.ts`
(instruction emitter), `program.ts` (class model, CHA helpers), `reach.ts` (RTA reachability), `consts.ts`,
`j2w.ts` (types, helpers, vtables, class init, module assembly), `method.ts` (per-method compile using `Flow`,
kind analysis, all opcode families except strings/MethodHandles/monitors), `intrinsics.ts`, `build.ts`, `dis.ts`,
`java/W.java` and `run.mjs`.

### 4.2 What it showed

On `W.java` compiled with javac + d8, the generated module for `fib`, `sieve`, `xorshift`, `swsum` and `floats`
produced the same results as the JDK. Module size 2.9 KB, compile 7.6 ms in Bun.

### 4.3 What is wrong or untested

- `mandel` returned 0 (expected 2196322.0) and `collatz` returned 2,864,133 (expected 307). I did not find the
  cause; the disassembly of `collatz` shows wide registers, `move` of int registers into pairs, `cmp-long`, `shr-long/2addr`
  and a loop with a `goto` back edge. Treat the compiler as unverified until these match.
- No workloads on AOSP library bytecode ran (ArrayList/HashMap etc. need strings, class objects, reflection-backed
  `Arrays.copyOf`, class init).
- No speed comparison against the production JS tier on real DEX was taken.

### 4.4 Do not trust

Any speed claim for the prototype. The only timing evidence in this document is the microbenchmark table in 1.1 to 1.4.

## 5. Unverified facts the executor must check first

From the platform report (training knowledge or secondary sources): Safari JSPI status (reported "27"), Firefox JSPI
version (conflicting), `wasm:js-string` in Safari, memory64 caps on mobile, V8 limits (128 KB max function body,
50k locals), custom descriptors status (reported origin trial in Chrome 149), shared-everything threads (Phase 1).
Also unverified: effect of compilation hints, sync-compile size limit on the main thread, code caching of Wasm
modules built at runtime, `call_indirect` vs `call_ref` cost at scale, TeaVM/J2CL/Hoot lessons.

## 6. Gates (run before the stage that depends on them)

| Gate | Question | Method | Pass condition |
|---|---|---|---|
| G1 | Is Wasm GC faster on real Java code than the JS tier? | Finish the prototype; run jbench workloads (listAddGet, listIter, mapInt, deque, sort, linkedList, treeMap, random, casts, jsonParse) on identical DEX in both tiers, `--jobs 1`, idle host, steady state and first call. Also test floats as bits vs `f32`/`f64`, explicit checks vs none. | Steady state at least 1.3x faster geometric mean and no workload more than 10% slower; first-call time not worse |
| G2 | Does correctness hold? | Per-method differential execution against the JS tier on framework.jar and Mihon/FitNotes, `fwtest`, conformance suites | zero unexplained diffs |
| G3 | Is cold start better? | Build platform modules ahead of time; time launch to first draw on FitNotes/Mihon/Calculator with `lat` cold and warm | at least 30% lower cold-call compile time; no gated tap above 150 ms |
| G4 | Does tier-up behave without OSR? | Loop kernels called once; measure baseline vs optimized; try back-edge re-entry and compilation hints | hot-loop methods reach optimized speed within 100 ms |
| G5 | Is the host boundary cheap enough? | Count crossings per tap from a profile; microbench strings (JS vs struct), byte arrays, accessors | crossings under 5% of a heavy tap |
| G6 | Boot image | Serialize the post-init framework heap; time the loader | loader under 50 ms for the boot heap (hypothesis), `clinit` time drops |
| G7 | Browser matrix | Run JSPI, GC, EH, tail calls, builtins probes in Firefox and WebKit builds in `~/Library/Caches/ms-playwright` | a documented support matrix; decide whether a non-JSPI mode is required |
| G8 | Linear-memory trigger | Only if G1 fails or S1 attributes hitches to same-process threads | decision recorded in docs/decisions/ |

## 7. Staged plan

Each stage lists deliverables and acceptance. A stage does not start until its gates pass. Keep the JS tier working
on every commit; the Wasm tier is selected per process with a flag (`?tier=wasm`) until the last stage.
Follow AGENTS.md verification at each stage (`typecheck`, `test`, `smoke` with zero method failures, `fwtest`,
`e2e`, `lat`).

### S0. Baseline and instrumentation
- Move the prototype's shared pieces into a real module location behind a flag; keep `research/wasm/` as history.
- Add counters to `lat`/`run.json`: host crossings per tap, wasm vs js time, module count, baseline-compiled functions.
- Record JS-tier baselines for jbench, `lat` (cold/warm), launch profiles and heap size per app.
- Fix the `mandel`/`collatz` mismatches and add a differential test harness (JS tier vs Wasm tier per method,
  random inputs, plus DEX-level fuzz on instruction sequences).
- **Accept:** G2 harness runs on `W.java` and the jbench classes with zero diffs.

### S1. Core compiler to a closed set
- Finish opcodes: strings (const-string, String ops via the chosen representation), class objects, monitors,
  `invoke-polymorphic`/`invoke-custom`, `filled-new-array`, `fill-array-data`, interface default methods, all array
  types and `ArrayStoreException`.
- Class init protocol with concurrent-init and cycle rules; `<clinit>` guards on static access and `new`.
- Exceptions: stack trace capture via the name section plus a code-offset to DEX-pc table; `StackOverflowError`
  from `RangeError`; OOM via a byte budget counter.
- Type inference from `dexstats/infer.ts` productized, with per-web locals.
- Run G1.
- **Accept:** jbench workloads on AOSP library bytecode run in Wasm with the same results as the JS tier; `smoke` on
  FitNotes reports zero method failures in Wasm mode.

### S2. Runtime on Wasm (single process, no suspension yet)
- Object/class model from 3.1 as the VM's own representation: loader, linker, vtable/IMT builders, reflection
  descriptors, `Class` objects, Unsafe/VarHandle as field-id based operations, Proxy through descriptor trampolines,
  identity hash and monitors in the header, weak/soft/phantom references through `WeakRef`/`FinalizationRegistry`.
- Generated accessor layer and ABI for natives (3.5); replace `getDeclared`-style helpers and `vcall` internals;
  add the lint against direct property access on Java objects.
- Convert natives in the order: primitive-only (1,014), reference-through (759), then the field-touching 711, starting
  with the ten files that hold 858 of the field sites.
- **Accept:** `fwtest`, `desccheck`, and the conformance suites (`guava`, `jsr166`, `ojluni-time`, harmony suites)
  match their baselines in Wasm mode.

### S3. Suspension and threads
- One `promising` stack per Java thread; blocking operations (monitor contention, `wait`, `park`, class-init waits,
  binder transactions, sleep, I/O) are `Suspending` imports; scheduler picks which thread resumes.
- Back-edge fuel checks and the "yield to the browser" rule from `yield.ts`; main-thread queue ownership and
  `onMain` rules preserved.
- Replace the 403 `driven` natives: Wasm, or async TS under `Suspending`.
- If G7 requires a no-JSPI mode, implement the unwind/resume transcription for that browser only.
- **Accept:** lifecycle order matches the reference AVD EventLog on gated flows; `lat` passes cold and warm;
  suspension counters per tap go to zero frame saves.

### S4. Tiers, linking and delivery
- Wasm DEX interpreter as the cold tier and deopt target; promotion by call count/back-edge count; module-per-class-group
  linker with shared table and lazy-link stubs; CHA guards and invalidation.
- Build-time AOT of boot jars and `framework.jar` into static assets with caching; install-time compile of app code in
  workers; persistence of the compiled form per APK hash.
- Back-edge re-entry for hot loops (G4).
- Boot image (G6) if the gate passes.
- **Accept:** G3 passes; launch-to-first-draw and cold-call counts improve against the S0 baseline on FitNotes, Mihon,
  Calculator M, Komikku; `e2e` quick gate green.

### S5. Process model and boundary clean-up
- Process-per-Worker with serialized Parcels; enumerate and convert the direct broker/font/file/clock accesses.
- Move byte-moving natives to copy-in/copy-out or into Wasm.
- JNI handle tables against the new object model; ARM/A64 core entry points through handles.
- **Accept:** `e2e --full --jobs 1`, `corpus`, and the cross-site WebView checks pass; p99 present interval at 4x
  throttle improves or holds.

### S6. Make Wasm the default, remove the JS tier
- Run the full matrix (`e2e --full`, `--live`, corpus, `lat --warm`, `conform` suites, fuzz differentials) with the
  Wasm tier as default; keep the JS tier one release as an oracle behind a flag, then delete it with
  `compiler.ts` emission, `tiering.ts`, `suspend.ts`, `cold.ts`, `codecache.ts` JS persistence.
- Update docs: AGENTS.md architecture section, PLAN.md, bytecode-first-plan.md, decisions record.
- **Accept:** no regression versus the S0 baselines on any gated metric; goldens unchanged.

### Conditional stage L: linear-memory VM
Only if G8 triggers. Reuse S1 (front end), S3 scheduling shape, S4 delivery; replace S2's object model with a
linear heap, add a generational collector with a write barrier and a safepoint protocol, and add worker threads.

## 8. Instructions to the executing agent

- Do not restate difficulty or duration; each stage is accepted by its gate, nothing else.
- Re-measure before trusting any number in section 1; those were single runs.
- Keep every Wasm-specific decision (floats as bits or typed, string representation, field-accessor ABI, hint
  encoding) behind a small interface so a gate result can flip it without a rewrite.
- When a gate fails, write the measurement and the mechanism in `docs/implementation-history.md` and either change
  the design in this file or take the alternative in 3.7; do not weaken the gate.
- Respect AGENTS.md: no app-specific substitutes, no fabricated success, unchanged bytecode, goldens unchanged,
  serialized timing runs.
