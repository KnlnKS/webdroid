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
  (the same bytes work as specified on Node 24 with the flag, so shipping Chrome ignores them; see "G4 hint result").
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
(instruction emitter), `program.ts` (class model, open-world `add`), `cha.ts` (class-hierarchy analysis over all loaded classes),
`reach.ts` (RTA reachability, now only a measuring tool), `consts.ts`, `lazy.ts` (the linker: class modules, lazy-link stubs, slots,
CHA invalidation, entry points), `j2w.ts` (per-module compile context: types, imports, local helpers, allocation), `method.ts`
(per-method compile using `Flow`, all opcode families except strings/MethodHandles/monitors), `infer.ts` (live-range web typing),
`exc.ts` (implicit exceptions, stack frames, heap limit), `cfg.ts`, `opinfo.ts`, `intrinsics.ts`, `build.ts`, `dis.ts`,
`java/W.java`, and the harnesses `oracle.ts` (the production JS tier as oracle), `cases.ts`, `diff.ts`, `libdiff.ts`, `jbench.ts`,
`lazytest.ts` + `trace.ts` (linker, exceptions, V8-only checks), `lazybench.ts` and `floatbench.ts` (measurements).

### 4.2 What it showed

On `W.java` compiled with javac + d8, the generated module for `fib`, `sieve`, `xorshift`, `swsum` and `floats`
produced the same results as the JDK. Module size 2.9 KB, compile 7.6 ms in Bun.

### 4.3 What is wrong or untested

Status after the S0 differential work (`research/wasm/j2w/`; the first two need javac, d8 and java on PATH):

| Harness | Subject | Oracles | Result |
|---|---|---|---|
| `diff.ts` | 30 static methods of `W.java`, 775 cases | JDK and the production JS tier | 775/775 agree. The earlier `mandel`/`collatz` mismatches are gone. 2 JS-tier results are explained: Bun's JSC words a negative typed-array length differently from V8, so `rt` maps `new int[-1]` to `InternalError` instead of `NegativeArraySizeException` (production runs V8; `runtime.ts` matches only V8's wording) |
| `libdiff.ts` | primitive-only statics of `java.lang.{Integer,Long,Short,Byte,Character,Boolean,Float,Double,Math,StrictMath}`, `Objects`, `Arrays`, FP16, compiled from the unchanged core-oj/core-libart dex | JS tier running the same bytecode | 322 candidates, 87 compile without a gap in their closure; 3,480 cases, 0 diffs. The rest are blocked by const-string (139), natives (74) or a closure over 1,000 methods (22) |
| `jbench.ts` | the 42 `scripts/jbench/Bench.java` workloads, each cut out as `static int w_<name>()` (generated, not copied) over all boot jars | JS tier | before lazy linking: one valid 6.9 MB module of 17,859 methods built in 23 s, every unsupported construct recorded as a gap. Now each workload runs on a fresh lazy `World` (cold): none runs to a result, every one stops at its first gap, after 22 to 50 methods compiled; 1,397 methods and 0.5 s over all 42 (`--survey` compiles the whole reach: 15,170 methods in 1.6 s) |

Bugs found and fixed by this work: ART's `java.lang.Object` declares `shadow$_klass_`/`shadow$_monitor_` fields, which
broke struct layout and invalidated every module built with real core-oj (they are now the object header);
`wasmbin` overflowed the stack on large modules; and unsupported constructs compiled to a silent trap
(`const-string`, `const-class`, `invoke-polymorphic`, array methods, calls with no instantiated implementor, natives).
Each now goes through `Compiler.gap`, which records it and calls `host.gap(id)`, so the harness reports the first gap
a run hits. Nothing is faked: a gap throws `UnsatisfiedLinkError`.

**S1 work list, from the 17,859 methods the jbench workloads reach** (counts are blocked methods; a method can appear
under several rows; `bun jbench.ts -v` lists them all):

| Missing feature | Blocked methods | First gap of | Needed for |
|---|---|---|---|
| Strings: `const-string` and string static initial values | 2,811 (+12 jumbo) | `Integer.<clinit>` (`Class.getPrimitiveClass("int")`) hits `listAddGet`, `listIter`, `listRemove`, `mapInt`, `deque`, `sort`, `linkedList`, `scanTokens`, `format`, `casts`, `ssb*`; `Bench.<clinit>` (KEYS) hits `mapStr`, `mapWalk`, `linkedMap`, `hashSet`, `treeMap`, `mix`, `parseFail*`, `zipOpen`, `spannedCopy`; `Float`/`Double.<clinit>` hit `b64java`, `jsonParse`, `jsonWrite`, `dtoa`; the workload body itself for `sha256`, `ecdsaVerify`, `certParse`, `smallAlloc`, `scanLines`, `strConcat`, `inetCached`, `linkify`; `StringBuffer.<clinit>` for `monitors` | every workload |
| Class objects: `const-class`, `Object.getClass` (reads the removed `shadow$_klass_`), `Class` methods | 340 const-class; 789 calls with no instantiated implementor, of which 374 on `Class` (`getName` 100, `getComponentType`, `getClassLoader`, `isAssignableFrom`, `newInstance`), then `reflect.Field/Constructor/Method` | `Unsafe.<clinit>` for `fbLoop`, `fbBulk`, `bbInts`, `dbInts`; `Base64$Encoder.<clinit>` for `b64android` | NIO buffers, `Arrays.copyOf(.., Class)`, `Enum.values()` via clone |
| Array methods: `clone()` (101 sites: enum `values()`, `ArrayList`, ICU) | 101 | | `listAddGet` family (`Arrays.copyOf`), enums |
| Natives with no intrinsic | 263: `libcore.io.Linux` 46, `jdk.internal.misc.Unsafe` 23 (+ `sun.misc.Unsafe` 11), `libcore.io.Memory` 14, `VMRuntime` 12, `Character` 12, ICU `MatcherNative` 11, `String` 11, `Math` 10, `Thread` 8, `FileDispatcherImpl` 8 | `AtomicLong.VMSupportsCS8()` for `random` | `random`, NIO, zip, files, crypto |
| `invoke-polymorphic` (VarHandle/MethodHandle) | 51 (+3 range): `ForkJoinPool` and `WorkQueue`, `AtomicInteger`, `AtomicLong`, `CountedCompleter` | | `AtomicInteger`/`AtomicLong` (`random`, `ConcurrentHashMap` users), executors |
| `invoke-super` to interface default methods (`unresolved direct`) | 31, all `java.time.chrono`/`temporal` | | `java.time` (format, zip entries) |
| Monitors | not a gap: `monitor-enter/exit` are null checks, valid only while a process has one Java thread | | `monitors`; revisit with S1 threads |
| Whole-program reach | a size problem, solved by lazy linking (4.5): `Locale.getDefault()`, `Object.toString()` or `Objects.checkIndex` alone reach 7,854 methods and 716 classes from core-oj+core-libart | | |

`casts` is the smallest case: 26 methods, blocked only by `Integer.<clinit>` (string plus the `getPrimitiveClass`
native and `const-class`), so it is the first jbench workload to turn green once strings and class objects exist.
Still untested: `invoke-custom` (no site reached), DEX-level fuzzing of instruction sequences, `framework.jar`
and app code through `diff`, `fwtest` and the conformance suites. There is no speed comparison against the JS tier on
real DEX (cold-start numbers can now be taken, see 4.5, but every jbench workload still stops at its first string or class-object gap).

### 4.5 S1 compiler architecture (2026-10-04, `knlnks/wasm-c`)

Measured in Bun (JavaScriptCore) and Node 24 (V8 13.6), M4 Pro, single runs, other agents running: indicative.

**Lazy linking** (`lazy.ts`). A `World` holds one funcref table. A class module is built the first time any code names the class: it defines
the vtable, init flag and static fields as exported globals and one lazy-link stub per method in a contiguous block of table slots.
A stub calls `host.link(slot)`, which compiles that method plus the small methods it calls (up to 8, 100 code units each: V8 inlines inside a
module, not through the table) into a unit module, instantiates it against the class modules it names, and replaces the slot. Every call across
modules is `call_indirect slot`; vtables and IMTs hold slots; unseen interface selectors are learned through `host.imtMiss`. Stubs are per
method (a per-signature stub cannot know which method it stands for without a store before every call). Each module is `Compiler.buildUnit(group)`
bytes; `World.classModule` returns the class module bytes, so a build-time mode can store both instead of instantiating on demand.

| Cold start, same entries | Closed-world build (before) | Lazy (after) |
|---|---|---|
| 322 primitive statics of the number classes, `lazybench.ts` | 8,127 methods, 2.8 MB, 4,139 ms | 494 methods (6.1%) in 357 modules plus 125 class modules, 0.5 MB, 61 ms compiler + 19 ms Module/Instance + 30 ms class links (V8) |
| jbench closed-world compile | 17,859 methods, 23-25 s | 15,170 methods, 1.6 s (`--survey`) |

The compiler itself is about 13x faster per method (0.5 to 1.4 ms to 0.07 to 0.12 ms) because the read-set fixpoint (two passes) is gone and the
analysis is one pass. `new WebAssembly.Module` + `Instance` of a unit cost about 35 us each in V8 (80 us in JavaScriptCore). Compiling every
method of core-oj + core-libart (37,340) takes 2.5 s, the 219,874 of framework.jar 15 s, with no inference failure; the only compile failures are
the 8 (framework) to 196 (Komikku) irreducible-CFG methods `Flow` already rejected.

**CHA under open-world loading.** `Cha` considers every concrete subtype the Program knows (not only instantiated ones, which is unsound once
classes load later). A virtual call with one target becomes `call_indirect` of that target's slot, and the unit records the decision per slot.
`World.addDexes` re-checks the recorded decisions against the new classes, puts the lazy-link stubs back for every method that relied on a
falsified one (and its compile group), and the next call recompiles against the new hierarchy (`lazytest.ts`: a subclass in a second dex flips
`Lz.call` from 11 to 12). Frames already executing keep their old code: closing that window needs the deopt target of S4.

**Exceptions** (`exc.ts`). The implicit exceptions are throwers in reserved table slots, compiled on first use: they allocate the ART class,
run its constructor and throw the one tag. Messages follow the JS tier and ART (`divide by zero`, `length=4; index=7`, `Ex$P cannot be cast to
Ex$Q`, `-5`, `Failed to allocate a N byte allocation with 536870912 free bytes`); the host computes them (`World.lastMessage`) but they are not
yet stored in `Throwable.detailMessage`: that needs the String representation. Stack traces: `Throwable.nativeFillInStackTrace` returns an
Object that keys a captured V8 `Error`; `World.stackTrace` maps each wasm frame back to a Java method by the name section and to a DEX pc by a
per-function table of call offsets (`Code.marks`, `Module.bodyOffsets`), then to a line by `DexFile.lineAt`. V8 reports the offset of the call
instruction, so the greatest mark at or before it is the frame's pc (verified under node: `Ex.c`, `Ex.b`, `Ex.a` at the pcs of their calls with
the source lines of the three methods). `nativeGetStackTrace` (building `StackTraceElement[]`) waits for strings. Allocation counts against an 8 MB window
(`rt.alloc` counts up to zero); the end of a window asks the host whether the real heap passed the 512 MB limit, and an array over the limit is an
OutOfMemoryError before it is allocated. **V8 does not let Wasm catch its stack-overflow RangeError** (`catch_all` catches a host-thrown
TypeError but not the overflow, Node 24): a Java handler for StackOverflowError cannot see it, so it becomes a `StackOverflowError` at the
edge of the Java world (`World.entry`). The JS tier converts at every catch site; closing this needs an explicit depth counter or another engine
mechanism, and apps that catch SOE mid-stack are rare.

**Typing and floats** (`infer.ts`). The kind analysis of `method.ts` is replaced by the web analysis of `dexstats/infer.ts`, now shared: every
used web gets its own local of its kind, a dead definition drops its value, an unreachable instruction compiles to `unreachable`. Results on
verified bytecode: 0 conflicts in 500,000+ methods compiled; `dexstats` output is unchanged apart from timings. **G1 sub-question, floats:**
f32/f64 locals are 30% faster than i32/i64 bits with a reinterpret around every operation under TurboFan (41 vs 58 ms for 30 M iterations of
a multiply-add chain) and equal under Liftoff (`floatbench.ts`); Wasm of mandel is 17% faster end to end. Decision: floats live in float
locals (`FLOAT_LOCALS` in `method.ts`, one flag), fields, arrays, parameters and results keep the bits ABI.

**V8 findings.** (1) A module without a start function gets a quarter of the inlining budget (`--trace-wasm-inlining`: `budget=min(128,700)`
against `min(320,7000)`), which halves `fib(32)` (9.7 vs 5.4 ms); unit modules carry an empty start function. (2) Cross-module calls cannot
inline, so small callees are grouped (without grouping `swsum` is 3x slower than the closed-world build; with it equal at 0.07 ms).

### 4.6 Natives and the host boundary (2026-10-04, `knlnks/wasm-d`)

**ABI.** A native keeps the production value model: Strings as JS strings, primitive arrays as typed arrays over scratch memory, long as bigint.
Every other reference (receiver, object, object array, a result that is an object) crosses as an opaque `externref` and meets the production
function through `bridge.ts`. The bridge never reads a Java object itself: array length and elements, and one getter and setter per field, are
generated Wasm (`World.hostFn`), and a field-reading `Proxy` per object lets a production native such as `Linux.close(fd)` run unchanged. A
Java method a native calls on an object (`vcall`) resolves to the implementation the object's class has and runs as Wasm. For the length of
the call an `Object` that is a primitive array is a copy that is written back; a host array becomes a Java array; an object the production
runtime made (`StructStat`, a `FileDescriptor`) is copied field by field; a throwable a native raises keeps its subclass fields (`ErrnoException`).
A `static ()V` native that fills in statics (`OsConstants.initConstants`) has them stored into the Wasm class. A native that answers a Promise is
a recorded gap, as is anything JavaScriptCore's stack cannot answer (the caller class: Bun runs `W` only, `libdiff` blocks and counts the rest).

**Natives landed** (Wasm unless noted): `Thread.currentThread` over a real main `Thread` (made as ART's `CreatePeer` does, `rt.thr` is the one
global a scheduler changes), `nativeGetStatus`, interrupt flag; `Reference` and `FinalizerReference` natives (a referent is held until cleared);
`Class.forName`, `getDeclaredClasses`, `VMClassLoader.findLoadedClass` and the boot class path entries; `Field.get/set*` with widening,
receiver, access (the caller from the V8 frame) and final checks; `libcore.io.Memory` peek/poke over the `byte[]` a direct buffer lives in
(`VMRuntime.addressOf` pins it, 50th bit of the address); every `Character` native (ASCII inline, the rest through ICU4J's `UCharacter` running as
Wasm over the ICU data the production natives map); `String.<init>(int,int,char[])`; production natives now reachable with object receivers
(`Linux`, `VMRuntime`, `Unix` file system, `FileChannelImpl`, zip, conscrypt). A mapped file's pages and the 64 KB digest path are asynchronous in
production; the harness makes the ICU data resident first and runs the digest's JS form.

**Results.** `diff.ts` 861/861 under node (the new `N.java` covers fields, `Class.forName`, direct buffers, the main thread, Unicode properties
and references against the JDK and the JS tier); `libdiff.ts` 409 methods, 16,360 cases, 0 diffs under node; `classdiff.ts` and `lazytest.ts`
pass under both. Under Bun `diff.ts` runs the 741 cases of `W`, `libdiff.ts` blocks 1,970 whose `System.<clinit>` needs the caller class.
`jbench.ts` under node: **40 of 42 workloads match the JS tier**; `inetCached` stops at `android_getaddrinfo` (the production native builds
`InetAddress` objects asynchronously). Fixed on the way: `findMethod` branched out of its own loop on the first parameter mismatch (an infinite
loop for a class with two constructors), and `node` exited while an unref'd yield port held a pending await (`nodeshim.mjs` is now the entry:
`node nodeshim.mjs bundle.mjs`).

**Production findings.** The JS tier's `Field` lacks the receiver, type and final checks (`getBoolean` of an int field answers a number) and
does not convert on widening reads and writes (`getLong` of an int field answers a number, `setByte` on a long field stores a number): `diff.ts`
compares those cases with the JDK alone. Natives that need a lock-step thread (`wait`, `sleep`, `park`, `holdsLock`, `nativeCreate`) stay gaps
for the scheduler; so do `Class.getSimpleNameNative`, the annotation natives and `getDeclaredConstructorsInternal`.

### 4.7 S1-F: generated-code performance and the G1 timing (2026-10-04, `knlnks/wasm-f`)

**Harness.** `bun g1.ts [workload ...] [--runs 5] [--reps 100] [--engines node,chrome] [--json out.json] [--ref earlier.json] [--v8-flags "..."]`
(`g1run.ts`, `g1platform.ts`, `g1fs.ts`). A workload is a `case` line of `scripts/jbench/Bench.java` or `research/wasm/j2w/java/G1.java`
(strings, arithmetic loops, field/array/virtual/interface/switch kernels, the G4 loop pair, same format); it joins the table as soon as its
Wasm result equals the JS tier's, so unblocking a workload is a change to the compiler or natives and nothing here. Every measurement is a fresh
engine: a node process or a new headless Chrome context (cross-origin isolated, so `performance.now()` has 5 us resolution instead of 100 us);
runs interleave JS and Wasm; `first` is the first call (linking, compiling, class initialisation; the JS tier's first call has no compile step of
its own), `steady` the median of the last half of 100 calls, `warm` calls 2 to 11. `--ref` takes the JS numbers from an earlier `--json` so a
compiler A/B measures Wasm only. `watdump.ts <workload> <method>` prints generated code. **The host was shared (load average 4 to 8 on 14
cores) for everything below; every table says so, spreads are 2 to 10%, and the authoritative run must be redone on an idle machine.**

@@TABLES@@

**What changed, in the order of measured effect** (steady geometric mean js/wasm over the 11 jbench workloads that match, V8 13.6, 3 to 5 runs
each, so +-5%; the starting point is `3702b732` plus the harness):

| Step | js/wasm |
|---|---|
| start | 0.84x |
| array stores check the element class in Wasm (`astore` asked the host, `host.info`, a Map lookup by class name, on every store into a typed array: 28% of `mapInt`); the element class and test kind sit in the array vtable (`ELEM`, `ELEM_KIND`) | 1.15x |
| constructors join their caller's unit (they were never grouped), 16 members | 1.28x |
| a thrower call is followed by `unreachable`, so V8 narrows the reference after `if (x == null) throw` (`mapWalk` 0.28 to 0.22 ms, `bbInts` 1.09 to 0.94, `random` 0.21 to 0.18) | 1.38x |
| class-initialisation guards skipped for classes already initialised when the unit is compiled and for the compiled method's own class chain (`World.entry` now initialises a static entry's class itself) | 1.44x |
| already-compiled small callees are copied into the caller's unit (unexported copy, `buildUnit(methods, copies)`), so a call is direct and inlinable wherever it is | 1.56x |
| null checks and guards dominated by an earlier one on every path are dropped (`facts.ts`, forward must-analysis, edges of `if-eqz`/`if-nez` refine it); field accesses that share a cast keep it in a local | 1.57x (TurboFan already narrowed; Liftoff-only `treeMap` -10%, `fieldLoop` -32%) |
| a virtual call tests the vtable slot against the one or two small implementations among the classes some compiled code allocates and calls them directly (`bbInts` 0.65 to 0.31 ms, `random` 0.17 to 0.11) | 1.83x |
| the Wasm-written intrinsics (String methods, `Math`) are copied in like other small callees; the classes a unit allocates count before its calls are planned (`virtualMono` 0.18 to 0.03 ms, `strChars` 0.53 to 0.29) | 1.90x |
| dense `switch` is a `br_table` (`switchDense` 0.136 to 0.075 ms); groups up to 24 | 2.0x |
| two tiers: a method is first compiled alone and counts calls and loop iterations (budget 5000); a hot one is recompiled with the callees that ran copied in, busiest first. Steady state is unchanged, first call 17% faster overall and 2x on the collection workloads (cold code no longer compiles its callees) | 2.0 to 2.1x |
| throwers, allocations, casts and instance tests are calls to small functions of the module: V8's inlining budget is a multiple of the root function's size and the callee limit is 500 bytes, so shorter sequences mean more inlining (`bbInts` 0.32 to 0.24, `mapStr`/`hashSet`/`mapWalk` -12%) | 2.1 to 2.2x |
| `astore` fast path in the caller for a value of exactly the component class (`refArray` 0.29 to 0.21 ms, parity with the JS tier) | |

**V8 findings.** (1) After `if (is_null x) { call thrower }` V8 does not narrow `x`; with `unreachable` after the call it does. (2) Inlining is the
whole game: `--no-wasm-inlining` is 3.6x slower on `bbInts` and 2x on `mapInt`; the default budget (`min(5 x root size, 7000)` nodes, callees up to 500
wire bytes, counts from Liftoff) is what limits `bbInts`: with `--wasm-inlining-budget=50000 --wasm-inlining-factor=10 --wasm-inlining-max-size=3000` it
runs in 0.16 ms (0.19 for the JS tier) against 0.24, which Chrome does not let us set. (3) `--wasm-inlining-call-indirect` changes nothing in
Chrome 153 on five workloads. (4) Repeated `ref.cast` of one value is free under TurboFan (46 vs 47 ms for 30 M iterations of six field reads) and 2x slower
per access in Liftoff, hence the shadow locals. (5) Default tiering beats `--no-liftoff` (`bbInts` 0.65 vs 0.75 ms): optimized code uses the call counts
collected in Liftoff. (6) **Chrome 153 and Chromium 151 do not inline the `wasm:js-string` builtins** (node's V8 13.6 does): a `charCodeAt` loop over a
58-character string costs 2.1 ms in Chrome from Wasm against 0.56 ms in node and 0.70 ms for the same loop in Chrome's JS; the same loop over an `i16`
array copied once with `intoCharCodeArray` costs 0.39 ms in both. In Chrome `charAt` (a `length` and a `charCodeAt` call) is the slow part of every string
workload there (`strChars` 0.45 vs 0.24 ms, `strIndex` 0.77 vs 0.19). Gate G5 (strings as structs over `i16` arrays) should weigh this.

**Rejected or neutral** (each measured, reverted unless noted). Larger groups (32 members, callees up to 200 code units): within 5% on steady
state, first call +10%. Dropping the allocation accounting (`alloc` word per allocation): 2% (noise). A fast path in `acmp` (reference compare): 1%.
Static types of reference webs (`types.ts`: one cast for `array-length` instead of testing five kinds, casts to a supertype dropped): `mapWalk` +9%
slower, the rest unchanged; the shorter code gave V8 a smaller inlining budget. An out-of-line `ensure` call in the class-init guard: nothing, `bbInts`
worse. Budget of 20, 200 or 1000 calls for the second tier: same steady state, first call 2x worse (the first call of a jbench workload already runs
thousands of iterations); 5000 and 20000 are equal, 5000 kept. Compile hints: ignored by Chrome (G4 hint result). Kept although neutral under TurboFan: the
dominated-check facts and the shadow cast locals (Liftoff gains above).

**G4 (tier-up without OSR).** A loop kernel in one long call stays in Liftoff for the whole activation. `loopOnce` (8 M iterations of an int mix, one call):
first call 47.7 ms node / 42.4 ms Chrome including about 25 ms of compile, against 8.2 ms for the same call once tiered up, i.e. about 3x per iteration in
baseline code; the JS tier needs 45 ms for it, so even baseline Wasm is faster than the JS tier's optimized code here. Re-entering the loop in chunks of
16384 iterations (`loopChunk`, the same work as outlined body calls) reaches optimized speed after about 12 ms: first call 38.2 ms node / 34.2 ms Chrome.
Ten times the work (`loopOnceBig`, 80 M): 214 ms in one activation (the next call 188 ms, still baseline in the new function), 112 ms chunked (83 ms
optimized), 441 ms in the JS tier. So the gate (optimized speed within 100 ms) holds for any loop that is re-entered (called from a loop or recursion), fails
only for one activation longer than about 100 ms, and there Wasm baseline is still about 2x ahead of the JS tier. The call counter that drives the second tier also
counts loop iterations, so the method is recompiled for its next call. Not built, since the gain is bounded to about 2x on a rare shape: an automatic
outlining of loops that run long in tier 1 (live-in/live-out webs through multi-value results plus an exit code for the loop's branch targets and handlers), or a
back-edge exit to a driver that re-enters the loop in the optimized function.

**For the owners of the natives and strings.** `Integer.toString`/`parseInt` (`parseInts`) go through the host `String.<init>([B)` factory (`decodeString`, a
linear-memory copy per call): 0.36 ms against 0.12 for the JS tier. `String.indexOf` loops over `charCodeAt`; the JS tier calls `String.prototype.indexOf` beyond 32 characters
(`strIndex` 0.36 vs 0.25 ms in node). `String.hashCode` is recomputed on every call (HashMap, 17% of `hashSet`).

### 4.4 Do not trust

Any speed claim for the prototype except those in 4.7, which are measured on a loaded host and carry their spreads. The remaining timing evidence is the microbenchmark table in 1.1 to 1.4.

## 5. Unverified facts the executor must check first

Resolved on 2026-10-04 with `research/wasm/probe.mjs` and `probe-tiering.mjs` (matrix and versions in
`research/wasm/platform-status.md`). Still open after that pass:

- Firefox is out of scope (decision 2026-10-04); no non-JSPI mode is built.
- Mobile memory64 caps, `call_indirect` vs `call_ref` cost at scale, TeaVM/J2CL/Hoot lessons (not probed).
- Code caching in headed Chrome (headless showed none, below).

Resolved: the V8 max function body is about 7.65 MB (not 128 KB) and 50,000 locals; the main-thread sync-compile limit
is 8 MiB in Chrome (none in the WebKit build); custom descriptors are flag-only in Chrome 153; JSPI, GC, exnref EH,
tail calls and `wasm:js-string` are present in Chrome 151/153 and the WebKit build; the WebKit build lacks memory64,
multi-memory and relaxed SIMD; runtime-built modules were not code-cached in headless Chrome.

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

### G7 result (2026-10-04, Chrome 153, Chromium 151, WebKit 2359; Firefox not measurable)

Supported on both measured engines: Wasm GC, exnref and legacy EH, tail calls, `wasm:js-string` builtins, JSPI
(including the rule that suspending through a JS frame throws). Chrome-only of the features probed: memory64,
multi-memory, relaxed SIMD. Do not use those on the default path. Custom descriptors are not shipped (flag-only).
**A non-JSPI mode is not required for Chrome or the WebKit build.** Firefox is out of scope, so no fallback is built. Details in `platform-status.md`.

### G4 hint result

Compilation hints do not work in shipping Chrome. The `compilationHints` section (and
`metadata.code.compilation_priority`) is ignored by Chrome 153 and Chromium 151, with and without
`--js-flags=--experimental-wasm-compilation-hints`: tiering is identical for every hint value and a section with the wrong
count is accepted. The encoding itself is right: Node 24 (V8 13.6) with the flag honours it (`0x2a` compiles the function
with TurboFan at module compile, before the first call; a wrong count is a CompileError). The G4 mechanisms to use in Chrome are
therefore back-edge re-entry (outlined loop bodies called repeatedly) or ahead-of-time choice of which functions get
eager optimization by other means; hints are not an option until V8 ships them. Gate G4 itself (kernels reaching optimized
speed within 100 ms) remains to be run with the S1 compiler.

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
  random inputs, plus DEX-level fuzz on instruction sequences). *Done except DEX-level fuzz: see 4.3.*
- **Accept:** G2 harness runs on `W.java` and the jbench classes with zero diffs. *Status: zero diffs on `W.java`
  (against the JDK and the JS tier) and on 87 compiled AOSP library statics; the 42 jbench workloads compile but every
  one stops at its first gap (strings, then class objects, per the 4.3 table), so they have no result to diff yet.
  The acceptance closes when the S1 string and class-object work lets `bun jbench.ts` report MATCH.*

### S1. Core compiler to a closed set
- Finish opcodes: strings (const-string, String ops via the chosen representation), class objects, monitors,
  `invoke-polymorphic`/`invoke-custom`, `filled-new-array`, `fill-array-data`, interface default methods, all array
  types and `ArrayStoreException`.
- Class init protocol with concurrent-init and cycle rules; `<clinit>` guards on static access and `new`.
- Exceptions: stack trace capture via the name section plus a code-offset to DEX-pc table; `StackOverflowError`
  from `RangeError`; OOM via a byte budget counter.
- Type inference from `dexstats/infer.ts` productized, with per-web locals. *Done (4.5).*
- Run G1 (the float sub-question is answered in 4.5; the Wasm GC speed gate needs the string and class-object work first).
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
