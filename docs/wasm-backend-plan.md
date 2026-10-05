# Plan: compile DEX to WebAssembly

Branch `knlnks/bytecode-wasm` (worktree `../webdroid-wasm`), from `knlnks/bytecode` at `5ad1d22a`.
Research only when written: no production code changed. The prototype has since moved (work package P0): it was `research/wasm/j2w/`, it is now `src/wasm/{compiler,link,host}`
with its suites in `scripts/wasm/` (`bun run wasm <suite>`) and its Java fixtures in `tests/fixtures/wasm/java/`. Sections below keep the file names of their time; the map is in
[wasm-s2-breakdown.md](wasm-s2-breakdown.md) section 1.1 and `lazy.ts` is `link/world.ts`, `threads.ts` `link/sched.ts`, `handles.ts` `link/mhandles.ts`, `oracle.ts` split into
`host/nativesource.ts` and `scripts/wasm/oracle.ts`, `build.ts` `scripts/wasm/lib.ts`, `aotbuild.ts`/`aotstartup.ts` `scripts/wasm/aot-build.ts`/`aot-startup.ts`, `reach.ts` `scripts/wasm/reach.ts`
(its `mid` is `compiler/ids.ts`). `floatbench.ts`, `lazybench.ts` and the j2w `dis.ts` were deleted.
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
| `src/wasm/`, `scripts/wasm/` | DEX to Wasm-GC prototype compiler (incomplete, see section 4.4); was `research/wasm/j2w/` |

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
  function-table indices. This is what `src/wasm/compiler` implements.
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
- Emit binary directly with a small encoder (`src/wasm/compiler/wasmbin.ts`, `code.ts`); no binaryen at runtime.

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

`java.lang.String` is a struct over an `i16` array (G5, decided in 4.10): the Object header, the chars, the cached hash code and, once a
native has asked for it, the JS string. A String is then an Object like any other (a virtual call needs no test for it, `hashCode` is a
field), and character access is an array access instead of a call of a `wasm:js-string` builtin, which Chrome does not inline. A native sees
the JS string (made and cached on first use); a JS string a native answers is copied into an array once. Constants are Strings put in the
shared table by the host and interned with `String.intern`; identity is Java's (ART interns member names, which `Method.equals` compares by
identity, so the host makes those through `intern`). The JS-string representation measured worse on every string workload and was removed.

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

### 4.1 What exists (`src/wasm/`, then `research/wasm/j2w/`)

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

Status after the S0 differential work (the suites run as `bun run wasm <suite>`; the first two need javac, d8 and java on PATH):

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
Still untested: `framework.jar` and app code through `diff`, `fwtest` and the conformance suites (`invoke-custom` and control flow no javac emits are covered in 4.8). There is no speed comparison against the JS tier on
real DEX (cold-start numbers can now be taken, see 4.5, but every jbench workload still stops at its first string or class-object gap).

### 4.4b Differential coverage (S1-E, 2026-10-04, `knlnks/wasm-e`)

All three run from the repository root and re-execute themselves bundled under node (`undernode.ts`; V8 frames are needed for caller-sensitive natives):

- `bun run wasm jbench`: one fresh `World` per workload, table of Wasm result, JS-tier result and MATCH/DIFF/BLOCKED(first gap). On the merged tree: 41 MATCH, 0 DIFF, 1 BLOCKED (`inetCached`, `Linux.android_getaddrinfo` answers a Promise). The earlier "hang" of 11 workloads was the harness: the JS tier's yield port is unref'd, so node exited with the workload suspended.
- `bun run wasm fuzz [--seed N --methods N --depth N --debug --file F.java]`: random Java (int/long/float/double/narrow casts, arrays, 2-D arrays, fields, virtual/interface calls, instanceof/casts, labelled loops, switches, try/catch/finally, custom exceptions, synchronized, calls) compiled with javac and d8, run on Wasm, the JS tier and the JDK. 70 seeds x 3,600 cases: Wasm and the JDK never differ. It found two bugs, below.
- `bun run wasm sweep [jar|apk ...]`: compiles every method alone and groups failures by cause. framework.jar: 219,874 methods, 18 fail (15 `invoke-custom`, 3 `MethodHandle.invoke`). FitNotes 7 (calls into optional or newer platform APIs). Mihon 190 (171 irreducible flow, Kotlin coroutine state machines; 19 absent platform APIs). Zero unexplained.

Bugs found: (1) the class module exported static fields by name only, so a dex that declares one name with two types (R8 output) produced a duplicate export or an ill-typed global; they are now keyed by name and type. (2) Production JS tier, `src/jvm/prepared.ts`: a handler's reaching definitions came from the state at the end of every block in the try range, so an int constant assigned after the last throwing instruction (d8 shares the register with a float the handler reads) was typed float (`const 32` became 4.5e-44). Handler edges now carry the state before each instruction that can throw (`tests/float-handler.test.ts`; 20 of the fuzzer's failing methods, one cause). Also: `Flow` limits scope nesting to 256 for the JS parser; Wasm bodies are no longer limited (8 AIDL `onTransact`/`getDefaultTransactionName` methods compile). Both open items (irreducible flow, unresolved references) are closed in 4.8.

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
for the scheduler; `Class.getSimpleNameNative`, the annotation natives, `getDeclaredConstructorsInternal` and `android_getaddrinfo` are done in 4.8.

### 4.7 S1-F: generated-code performance and the G1 timing (2026-10-04, `knlnks/wasm-f`)

**Harness.** `bun run wasm g1 [workload ...] [--runs 5] [--reps 100] [--engines node,chrome] [--json out.json] [--ref earlier.json] [--v8-flags "..."]`
(`g1run.ts`, `g1platform.ts`, `g1fs.ts`). A workload is a `case` line of `scripts/jbench/Bench.java` or `tests/fixtures/wasm/java/G1.java`
(strings, arithmetic loops, field/array/virtual/interface/switch kernels, the G4 loop pair, same format); it joins the table as soon as its
Wasm result equals the JS tier's, so unblocking a workload is a change to the compiler or natives and nothing here. Every measurement is a fresh
engine: a node process or a new headless Chrome context (cross-origin isolated, so `performance.now()` has 5 us resolution instead of 100 us);
runs interleave JS and Wasm; `first` is the first call (linking, compiling, class initialisation; the JS tier's first call has no compile step of
its own), `steady` the median of the last half of 100 calls, `warm` calls 2 to 11. `--ref` takes the JS numbers from an earlier `--json` so a
compiler A/B measures Wasm only. `watdump.ts <workload> <method>` prints generated code. **The host was shared (load average 4 to 8 on 14
cores) for everything below; every table says so, spreads are 2 to 10%, and the authoritative run must be redone on an idle machine.**

**G1 tables** (merged with `knlnks/bytecode-wasm` at `4d783acc`; every workload whose Wasm result equals the JS tier's; two workloads stop early on a pre-existing OutOfMemoryError after about 14 calls: `scanTokens`, `scanLines`, their numbers are over the calls that completed; `inetCached` is still blocked by an Unsafe accessor). Wasm more than 10% slower in steady state (js/wasm), node: zipOpen 0.01, sha256 0.10, fbBulk 0.17, parseInts 0.18, strConcat 0.19, strBuild 0.29, strIndex 0.76, b64android 0.78, strSubstr 0.78, bbInts 0.79, switchSparse 0.85, strCompare 0.87, scanTokens 0.88, strChars 0.89, scanLines 0.89; Chrome adds jsonWrite 0.45, format 0.77, fbLoop 0.87 and has strIndex 0.25, strSubstr 0.44, strChars 0.56, strCompare 0.63 (builtins, see V8 findings). The first four and `fbBulk` are dominated by the natives bridge: `$copy:i8` copies the whole array element by element on every native call (66% of `zipOpen`, whose `initCEN` takes 49 ms over a 1000-entry directory where the JS tier uses a native ZipFile) and by the host String factories (`decodeString`); that is a change to the bridge (range copies), not to generated code. first-call times are not comparable with the JS tier's (it has no compile step, and node's JS tier caches).

**node v24.19.0 (V8 13.6.233.17-node.51)**, 3 runs x 100 reps, medians (min-max) in ms, load average 1.3-2.5 on 14 cores. Wasm warm = calls 2 to 11.

| workload | JS first | Wasm first | JS steady | Wasm steady | steady js/wasm | Wasm warm |
|---|---|---|---|---|---|---|
| sha256 | 70.6 | 563 | 0.411 | 3.9 (3.9-3.9) | 0.10x | 4.0 |
| ecdsaVerify | 68.2 | 580 | 0.344 | 0.332 (0.331-0.334) | 1.04x | 0.432 |
| certParse | 133 | 969 | 0.141 | 0.135 (0.134-0.139) | 1.04x | 0.235 |
| listAddGet | 21.7 | 13.4 | 0.081 | 0.037 (0.035-0.040) | 2.17x | 0.262 |
| listIter | 21.4 | 13.2 | 0.115 | 0.066 (0.066-0.066) | 1.74x | 0.220 |
| listRemove | 24.3 | 14.2 | 1.9 | 0.665 (0.665-0.668) | 2.86x | 0.751 |
| mapStr | 21.8 | 10.8 | 0.214 | 0.141 (0.140-0.142) | 1.52x | 0.329 |
| mapInt | 21.5 | 11.1 | 0.150 | 0.089 (0.088-0.089) | 1.69x | 0.312 |
| mapWalk | 23.5 | 13.8 | 0.295 | 0.136 (0.134-0.139) | 2.17x | 0.300 |
| linkedMap | 23.2 | 11.8 | 0.211 | 0.127 (0.125-0.127) | 1.67x | 0.361 |
| hashSet | 21.8 | 10.5 | 0.200 | 0.125 (0.122-0.125) | 1.60x | 0.249 |
| smallAlloc | 3.0 | 7.5 | 0.105 | 0.032 (0.031-0.033) | 3.32x | 0.251 |
| deque | 22.0 | 15.2 | 0.127 | 0.049 (0.046-0.049) | 2.60x | 0.179 |
| treeMap | 25.6 | 19.3 | 0.399 | 0.314 (0.314-0.314) | 1.27x | 0.545 |
| sort | 31.2 | 36.0 | 0.291 | 0.284 (0.284-0.295) | 1.03x | 0.926 |
| mix | 27.7 | 20.1 | 1.3 | 0.806 (0.787-0.810) | 1.58x | 1.0 |
| linkedList | 22.1 | 12.3 | 0.087 | 0.032 (0.032-0.032) | 2.67x | 0.175 |
| b64java | 29.4 | 27.8 | 0.832 | 0.831 (0.829-0.853) | 1.00x | 0.861 |
| b64android | 24.4 | 18.2 | 0.616 | 0.793 (0.769-0.815) | 0.78x | 0.729 |
| jsonParse | 50.0 | 134 | 3.3 | 2.4 (2.3-2.4) | 1.39x | 3.3 |
| jsonWrite | 62.7 | 173 | 7.5 | 7.6 (7.5-7.6) | 0.99x | 9.8 |
| scanTokens | 199 | 1122 | 9.3 | 10.6 (10.3-10.9) | 0.88x | 11.2 |
| scanLines | 183 | 1102 | 3.7 | 4.2 (4.2-4.5) | 0.89x | 6.9 |
| format | 49.7 | 135 | 2.3 | 1.6 (1.6-1.6) | 1.44x | 5.3 |
| dtoa | 26.8 | 31.9 | 1.3 | 0.403 (0.402-0.405) | 3.16x | 0.974 |
| parseFail | 12.1 | 18.3 | 7.4 | 2.8 (2.8-2.9) | 2.60x | 3.1 |
| parseFailMixed | 21.6 | 24.5 | 6.8 | 2.7 (2.7-2.7) | 2.52x | 3.6 |
| fbLoop | 22.2 | 24.0 | 0.132 | 0.138 (0.137-0.138) | 0.96x | 0.299 |
| fbBulk | 2.6 | 17.5 | 0.037 | 0.220 (0.219-0.220) | 0.17x | 0.224 |
| bbInts | 21.8 | 20.2 | 0.187 | 0.237 (0.234-0.237) | 0.79x | 0.272 |
| dbInts | 22.2 | 19.3 | 0.355 | 0.129 (0.129-0.130) | 2.75x | 0.254 |
| casts | 30.7 | 12.2 | 2.5 | 0.385 (0.381-0.398) | 6.49x | 0.420 |
| monitors | 20.6 | 11.0 | 0.244 | 0.093 (0.093-0.093) | 2.63x | 0.154 |
| random | 22.4 | 12.4 | 0.612 | 0.067 (0.067-0.084) | 9.11x | 0.114 |
| strConcat | 19.6 | 8.6 | 0.027 | 0.142 (0.141-0.144) | 0.19x | 0.436 |
| zipOpen | 147 | 492 | 0.466 | 60.3 (60.3-60.5) | 0.01x | 61.3 |
| ssbAppend | 33.4 | 37.0 | 0.332 | 0.179 (0.177-0.183) | 1.86x | 0.850 |
| ssbEdit | 32.0 | 35.1 | 0.333 | 0.104 (0.102-0.106) | 3.19x | 1.6 |
| ssbGetSpans | 33.3 | 38.4 | 0.871 | 0.638 (0.635-0.646) | 1.36x | 1.2 |
| spannedCopy | 9.0 | 19.0 | 0.242 | 0.168 (0.166-0.170) | 1.44x | 1.1 |
| linkify | 16.4 | 49.6 | 0.031 | 0.023 (0.022-0.023) | 1.36x | 0.033 |
| loopOnce | 39.3 | 23.5 | 38.2 | 7.1 (7.1-7.1) | 5.36x | 7.2 |
| loopChunk | 39.3 | 12.9 | 7.1 | 7.1 (7.1-7.1) | 1.00x | 7.2 |
| divLoop | 5.1 | 5.5 | 4.2 | 0.371 (0.371-0.371) | 11.24x | 0.390 |
| longDiv | 1.8 | 5.8 | 0.339 | 0.188 (0.188-0.188) | 1.80x | 0.199 |
| switchDense | 1.2 | 5.5 | 0.068 | 0.073 (0.070-0.073) | 0.93x | 0.069 |
| switchSparse | 1.3 | 5.4 | 0.068 | 0.081 (0.080-0.081) | 0.85x | 0.073 |
| refArray | 19.9 | 6.0 | 0.191 | 0.205 (0.204-0.208) | 0.93x | 0.206 |
| matrix | 22.4 | 7.8 | 0.198 | 0.066 (0.066-0.066) | 3.01x | 0.086 |
| sieve | 2.2 | 6.0 | 0.229 | 0.206 (0.196-0.214) | 1.12x | 0.218 |
| intLoop | 1.9 | 5.8 | 0.957 | 0.187 (0.187-0.189) | 5.13x | 0.194 |
| longLoop | 1.9 | 5.2 | 0.424 | 0.133 (0.133-0.133) | 3.18x | 0.136 |
| doubleLoop | 20.6 | 5.6 | 0.692 | 0.071 (0.071-0.071) | 9.80x | 0.072 |
| arraySum | 1.4 | 5.4 | 0.118 | 0.062 (0.059-0.064) | 1.91x | 0.063 |
| fieldLoop | 19.9 | 5.6 | 0.104 | 0.067 (0.065-0.069) | 1.55x | 0.070 |
| allocLoop | 20.3 | 6.2 | 0.160 | 0.012 (0.012-0.012) | 13.41x | 0.144 |
| virtualMono | 19.8 | 6.3 | 0.083 | 0.033 (0.033-0.033) | 2.54x | 0.033 |
| virtualBi | 20.5 | 8.3 | 0.544 | 0.124 (0.124-0.138) | 4.39x | 0.128 |
| interfaceBi | 20.3 | 8.1 | 0.552 | 0.235 (0.235-0.246) | 2.35x | 0.237 |
| linkedNodes | 20.5 | 6.9 | 0.255 | 0.046 (0.046-0.046) | 5.56x | 0.165 |
| strChars | 21.2 | 8.1 | 0.252 | 0.283 (0.281-0.285) | 0.89x | 0.285 |
| strEquals | 20.0 | 6.4 | 0.106 | 0.106 (0.103-0.107) | 0.99x | 0.357 |
| strIndex | 20.3 | 8.6 | 0.272 | 0.358 (0.349-0.359) | 0.76x | 0.498 |
| strBuild | 19.6 | 14.7 | 0.119 | 0.415 (0.411-0.417) | 0.29x | 0.615 |
| strSubstr | 21.9 | 8.2 | 0.300 | 0.384 (0.382-0.397) | 0.78x | 0.400 |
| strCompare | 19.9 | 5.6 | 0.034 | 0.039 (0.035-0.040) | 0.87x | 0.270 |
| parseInts | 19.8 | 12.0 | 0.067 | 0.382 (0.378-0.388) | 0.18x | 0.412 |
| exceptions | 23.5 | 7.3 | 3.1 | 1.4 (1.4-1.4) | 2.20x | 1.2 |

jbench: 41 workloads, geometric mean js/wasm: steady 1.28x, first call 0.78x

G1 extras: 27 workloads, geometric mean js/wasm: steady 1.83x, first call 1.46x


**Chrome 153.0.8010.53**, 3 runs x 100 reps, medians (min-max) in ms, load average 1.2-3.0 on 14 cores. Wasm warm = calls 2 to 11.

| workload | JS first | Wasm first | JS steady | Wasm steady | steady js/wasm | Wasm warm |
|---|---|---|---|---|---|---|
| sha256 | 40.1 | 505 | 0.465 | 4.1 (4.1-4.1) | 0.11x | 4.2 |
| ecdsaVerify | 40.6 | 525 | 0.290 | 0.285 (0.280-0.295) | 1.02x | 0.365 |
| certParse | 142 | 885 | 0.205 | 0.130 (0.125-0.130) | 1.58x | 0.240 |
| listAddGet | 3.1 | 16.6 | 0.080 | 0.035 (0.035-0.035) | 2.29x | 0.285 |
| listIter | 3.0 | 16.6 | 0.100 | 0.055 (0.055-0.055) | 1.82x | 0.240 |
| listRemove | 5.9 | 16.8 | 1.5 | 0.630 (0.630-0.630) | 2.40x | 0.710 |
| mapStr | 3.1 | 13.3 | 0.505 | 0.145 (0.140-0.145) | 3.48x | 0.345 |
| mapInt | 2.7 | 14.2 | 0.170 | 0.090 (0.090-0.090) | 1.89x | 0.335 |
| mapWalk | 4.1 | 16.6 | 0.365 | 0.135 (0.135-0.140) | 2.70x | 0.540 |
| linkedMap | 4.1 | 14.9 | 0.420 | 0.130 (0.130-0.130) | 3.23x | 0.375 |
| hashSet | 3.2 | 13.4 | 0.525 | 0.135 (0.130-0.135) | 3.89x | 0.280 |
| smallAlloc | 1.8 | 10.4 | 0.100 | 0.030 (0.030-0.030) | 3.33x | 0.305 |
| deque | 3.6 | 18.2 | 0.115 | 0.045 (0.045-0.070) | 2.56x | 0.215 |
| treeMap | 6.7 | 21.5 | 0.370 | 0.330 (0.330-0.330) | 1.12x | 0.590 |
| sort | 12.0 | 37.6 | 0.285 | 0.280 (0.280-0.285) | 1.02x | 1.0 |
| mix | 8.2 | 22.8 | 2.2 | 0.970 (0.895-0.975) | 2.22x | 1.2 |
| linkedList | 3.4 | 15.6 | 0.070 | 0.030 (0.030-0.030) | 2.33x | 0.195 |
| b64java | 12.7 | 31.7 | 0.950 | 0.850 (0.820-0.870) | 1.12x | 0.880 |
| b64android | 5.6 | 20.7 | 1.1 | 0.870 (0.840-0.880) | 1.24x | 0.865 |
| jsonParse | 34.2 | 102 | 3.1 | 2.9 (2.9-2.9) | 1.07x | 3.8 |
| jsonWrite | 44.5 | 141 | 7.3 | 16.0 (15.7-16.1) | 0.45x | 16.0 |
| scanTokens | 195 | 1049 | 13.9 | 12.6 (12.4-12.7) | 1.10x | 14.9 |
| scanLines | 154 | 1021 | 5.1 | 4.1 (3.8-4.2) | 1.25x | 5.2 |
| format | 38.8 | 103 | 2.5 | 3.2 (3.0-3.4) | 0.77x | 5.0 |
| dtoa | 10.4 | 34.2 | 3.2 | 0.445 (0.440-0.445) | 7.10x | 1.1 |
| parseFail | 16.6 | 20.8 | 11.8 | 3.0 (3.0-3.0) | 3.92x | 3.5 |
| parseFailMixed | 23.8 | 27.6 | 10.0 | 3.0 (2.9-3.0) | 3.38x | 4.1 |
| fbLoop | 3.9 | 25.7 | 0.130 | 0.150 (0.150-0.150) | 0.87x | 0.290 |
| fbBulk | 2.1 | 21.2 | 0.040 | 0.225 (0.225-0.230) | 0.18x | 0.230 |
| bbInts | 3.4 | 24.4 | 0.215 | 0.225 (0.220-0.230) | 0.96x | 0.360 |
| dbInts | 3.8 | 22.5 | 0.330 | 0.135 (0.135-0.135) | 2.44x | 0.250 |
| casts | 12.1 | 15.6 | 2.0 | 0.430 (0.420-0.435) | 4.66x | 0.455 |
| monitors | 2.4 | 13.9 | 0.215 | 0.100 (0.100-0.100) | 2.15x | 0.140 |
| random | 4.3 | 14.9 | 0.590 | 0.070 (0.070-0.070) | 8.43x | 0.205 |
| strConcat | 1.5 | 11.7 | 0.030 | 0.165 (0.165-0.170) | 0.18x | 0.420 |
| zipOpen | 122 | 457 | 0.625 | 60.0 (59.8-60.1) | 0.01x | 61.3 |
| ssbAppend | 15.3 | 42.8 | 0.285 | 0.155 (0.155-0.165) | 1.84x | 1.0 |
| ssbEdit | 14.7 | 39.8 | 0.250 | 0.100 (0.095-0.100) | 2.50x | 1.7 |
| ssbGetSpans | 13.5 | 43.1 | 0.800 | 0.615 (0.610-0.615) | 1.30x | 1.1 |
| spannedCopy | 7.7 | 22.6 | 0.190 | 0.150 (0.150-0.155) | 1.27x | 1.0 |
| linkify | 11.1 | 53.1 | 0.035 | 0.025 (0.025-0.025) | 1.40x | 0.035 |
| loopOnce | 40.1 | 27.6 | 38.3 | 7.4 (7.2-7.4) | 5.21x | 7.5 |
| loopChunk | 40.5 | 15.6 | 38.3 | 7.3 (7.1-7.4) | 5.24x | 7.5 |
| divLoop | 2.3 | 8.2 | 1.0 | 0.390 (0.370-0.395) | 2.64x | 0.390 |
| longDiv | 2.0 | 8.3 | 0.270 | 0.190 (0.190-0.190) | 1.42x | 0.210 |
| switchDense | 0.920 | 8.0 | 0.075 | 0.070 (0.070-0.075) | 1.07x | 0.075 |
| switchSparse | 0.880 | 8.2 | 0.070 | 0.080 (0.070-0.080) | 0.87x | 0.085 |
| refArray | 3.0 | 8.8 | 0.195 | 0.190 (0.190-0.190) | 1.03x | 0.200 |
| matrix | 4.0 | 10.5 | 0.250 | 0.070 (0.070-0.070) | 3.57x | 0.090 |
| sieve | 2.2 | 8.6 | 0.235 | 0.125 (0.120-0.145) | 1.88x | 0.140 |
| intLoop | 1.8 | 8.2 | 0.960 | 0.200 (0.190-0.205) | 4.80x | 0.215 |
| longLoop | 2.1 | 7.7 | 0.455 | 0.135 (0.135-0.135) | 3.37x | 0.155 |
| doubleLoop | 2.4 | 8.4 | 0.605 | 0.075 (0.075-0.080) | 8.07x | 0.080 |
| arraySum | 1.1 | 8.6 | 0.075 | 0.060 (0.060-0.060) | 1.25x | 0.065 |
| fieldLoop | 2.8 | 8.5 | 0.780 | 0.070 (0.070-0.070) | 11.14x | 0.070 |
| allocLoop | 2.2 | 8.8 | 0.150 | 0.035 (0.035-0.035) | 4.29x | 0.135 |
| virtualMono | 1.4 | 8.8 | 0.080 | 0.075 (0.075-0.075) | 1.07x | 0.075 |
| virtualBi | 2.1 | 10.8 | 0.485 | 0.125 (0.125-0.145) | 3.88x | 0.135 |
| interfaceBi | 2.3 | 10.7 | 0.480 | 0.250 (0.245-0.250) | 1.92x | 0.250 |
| linkedNodes | 2.2 | 9.9 | 0.230 | 0.065 (0.065-0.065) | 3.54x | 0.070 |
| strChars | 1.9 | 10.5 | 0.240 | 0.430 (0.405-0.430) | 0.56x | 0.445 |
| strEquals | 2.0 | 9.2 | 0.295 | 0.130 (0.125-0.140) | 2.27x | 0.365 |
| strIndex | 2.1 | 11.6 | 0.175 | 0.710 (0.705-0.715) | 0.25x | 0.815 |
| strBuild | 1.6 | 17.9 | 0.125 | 0.435 (0.430-0.435) | 0.29x | 0.660 |
| strSubstr | 3.5 | 10.8 | 0.250 | 0.570 (0.555-0.570) | 0.44x | 0.685 |
| strCompare | 1.5 | 8.1 | 0.025 | 0.040 (0.040-0.040) | 0.63x | 0.160 |
| parseInts | 1.5 | 14.8 | 0.065 | 0.335 (0.330-0.335) | 0.19x | 0.410 |
| exceptions | 4.7 | 9.9 | 2.4 | 1.6 (1.6-1.6) | 1.48x | 1.6 |

jbench: 41 workloads, geometric mean js/wasm: steady 1.39x, first call 0.24x

G1 extras: 27 workloads, geometric mean js/wasm: steady 1.67x, first call 0.25x



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

### 4.8 S1-I: the remaining correctness gaps (2026-10-04, `knlnks/wasm-i`)

Every method of framework.jar (219,874), FitNotes (22,259), Mihon (95,799), Komikku (131,785) and NewPipe (61,589) now compiles and validates: `sweep.ts` reports no failure of any
kind. A gap is a recorded unsupported capability, so what the sweep and the harnesses below count as gaps is the whole list of what Wasm cannot do yet: natives with no host
binding, String constructors `strings.ts` lacks, a lambda call site (below), a transformer method handle, a relay lookup. The harnesses run the same Java on Wasm, the production
JS tier and the JDK; a case the JS tier cannot answer (its method handle and VarHandle model is its own) is decided by the JDK alone.

**Irreducible flow.** `Flow` threw on a retreating edge whose target does not dominate its source (171 methods of Mihon, 8 of framework.jar: Kotlin `invokeSuspend` state
machines, d8 tail-merged invokes). It now reports the heads of such edges (`Irreducible`), and `structureAny` (`src/jvm/structure.ts`) retries with each head as an extra region
entry: every edge into a head is a dispatch of the existing `$disp` loop and `br_table`, so only the edges that close the cycle pay for it and the rest of the method keeps its
structured loops and blocks. The production JS tier keeps its own fallback. `fuzz.ts --irreducible` (`irfuzz.ts`) writes methods as random block graphs (conditional branches, `tableswitch`, handler
blocks over runs of the layout, a fuel local to end every cycle) in a version 50 class file, which d8 converts: about 30% of the generated methods are irreducible after d8
(91 of 328 for seed 1), 6 seeds x 3,600 cases against the JS tier and the JDK show no difference.

**Unresolved references.** `linkage.ts` resolves a use site as ClassLinker does and fails it the way ART does, when the site runs and with the prefix of the method still executed:
`NoClassDefFoundError: Failed resolution of: LFoo;` for `const-class`, `new-instance`, `check-cast`, `instance-of`, `new-array`, `filled-new-array`, a field or an invoke of an absent
class; `NoSuchMethodError: No virtual method gv()V in class LLkP; or its super classes (declaration of 'LkP' appears in <dex>)` and the static, direct, super and interface forms;
`NoSuchFieldError: No static field gsf of type I in class LLkP; or its superclasses (...)`; `IncompatibleClassChangeError` for a static call of an instance method and the reverse
("The method 'void LkP.sm2()' was expected to be of type static but instead was found to be of type virtual"), an invoke-interface of a class and an invoke-virtual of an
interface ("Found class LkI, but interface was expected"), and a field of the wrong staticness. The message formats are those of `class_linker.cc` and `common_throws.cc` as I know them; they are
not checked against a device, and the `NoClassDefFoundError` has no `ClassNotFoundException` cause. A site that failed because a class is absent is undone when a dex that defines the class is added
(`World.absent`, like the CHA assumptions); a missing member stays missing because a class's supertypes cannot change. A handler whose exception class is absent is skipped, as ART does. `linkdiff.ts`
checks 19 cases (error class against the JDK, message against ART's wording, the code before the site, the dex loaded later). In the sweeps, 3 methods of framework.jar, 19 of FitNotes (the
removed `org.apache.http`), 89 of Mihon, 94 of Komikku and 94 of NewPipe contain such a site: all name a newer platform API or a library the boot jars lack. Also: a call through an
interface no loaded class implements was compiled to `AbstractMethodError`; it is now a dispatch like any other, since a class made later (a proxy) may implement it, even in a frame that is already running. A CHA
decision that one class implements a method still binds the frames already running.

**invoke-custom and method handles.** d8 desugars lambdas, string concatenation and records unless run with `--no-desugaring`, and libcore cannot link what it leaves: `LambdaMetafactory.metafactory` is
`return null`, and `StringConcatFactory` and `SwitchBootstraps` are not in the boot jars. The framework's 15 invoke-custom sites are all `ObjectMethods.bootstrap` (records). `custom.ts` links
those at compile time from the call site item: the record class, the component names and the getter handles (field gets, and virtual, direct and interface getters, the virtual ones
through the reflection thunk so an override is called) become `toString` (a `StringBuilder`), `equals` and `hashCode` (31 * hash + hash, `Float.compare` for floats, `Objects.equals`).
AOSP's own `ObjectMethods` is a chain of combinators that needs transformers. A bootstrap class or method libcore lacks is the `NoClassDefFoundError` at the site (checked: string
concatenation); `LambdaMetafactory` is a recorded gap. `handles.ts` implements `MethodHandle.invoke` and `invokeExact` (framework: `RemoteViews`): the site boxes its arguments, the host checks the site's
type against the handle's (`invokeExact`: equal, else `WrongMethodTypeException`; `invoke`: asType's boxing, unboxing, widening and casts) and calls the method (static, virtual, direct,
super, interface) or field (get/set, instance/static) the handle names through the reflection thunks, without wrapping what it throws. A handle that is a transformer (`bindTo`,
`asType` of another shape, every combinator) runs Java over `EmulatedStackFrame`, which is not modelled: a recorded gap (`customdiff.ts` checks it). `customdiff.ts`: 375 cases, JDK-checked
(records of every component type, about two dozen handle shapes including errors, the hand-written class file whose getters are virtual and interface methods checked against the semantics of ObjectMethods). The JS tier
agrees on records and differs on handles (its model throws on field handles).

**Natives.** `Class.getSimpleNameNative`, `isRecord0`, `getDeclaringClass`, `getEnclosingClass`, `getEnclosingMethodNative`/`getEnclosingConstructorNative`, `isAnonymousClass`, `getDeclaredMethodsUnchecked`,
`getDeclaredConstructorsInternal`, `Method/Constructor.getExceptionTypes`, `compareMethodParametersInternal` and the annotation presence natives (`isDeclaredAnnotationPresent`,
`isAnnotationPresentNative`) come from the dex (`members.ts`); `getDeclaredAnnotation(s)`, `getAnnotationNative`, `getParameterAnnotationsNative`, `Method.getDefaultValue` and the `Signature` annotation
(generic types) build the annotation objects as ART does, through libcore's `AnnotationFactory` with members typed by the annotation method's return type (`annotations.ts`), which needs
`Proxy.generateProxy` (`proxy.ts`): a class made at run time (`World.addClass`) extending Proxy whose methods box their arguments into `Proxy.invoke(proxy, method, args)`, unbox as ART does and wrap
undeclared checked exceptions in `UndeclaredThrowableException`. `Linux.android_getaddrinfo` runs the production resolution (hosts file, numeric forms) and builds the `InetAddress[]` in Wasm with
`InetAddress.getByAddress`; a name the relay must look up is a recorded gap (it answers a Promise), and the error path throws `GaiException` (`UnknownHostException` on top). `Unsafe` get/put of any width on
any array are composed from the elements' bytes (`ArraysSupport.vectorizedMismatch` over `int[]` reads longs). VarHandles: static-field handles, receivers whose static type has no candidate
field (any class, `Object`), `getAndAdd` on byte, short and char variables narrows, byte/short/char/boolean element handles, and an array of another class than the handle's is a `ClassCastException`
(`Vh.java`: 323 cases against the JDK; `classdiff.ts` now builds its handles with `Lookup.findVarHandle` and `arrayElementVarHandle` instead of intrinsics). Two older bugs surfaced and are fixed: `reflect.ts` and
`classes.ts` compared annotation types as descriptors (`getDeclaredClasses` was always empty, `getModifiers` of a member class ignored `InnerClass`). `jbench.ts`: 42 of 42 MATCH (`inetCached` was the blocked one).

**Limits.** A transformer handle, a lambda call site, a name resolved by the relay and a native that needs a scheduler stay gaps. The CHA window for running frames (above) remains.
`invoke` and `invokeExact` box every argument and result. The ART message formats are unverified against a device.

### 4.10 S1-G: the host boundary, strings and the G1 steady state (2026-10-04, `knlnks/wasm-g`)

**G1 steady state, js/wasm geometric mean** (3 runs x 100 reps, load average 1.5 to 5 on 14 cores, so +-10% per workload; same harness, base `b77c6e02`
against this branch): jbench 42 workloads node 1.28x -> 1.76x, Chrome 1.38x -> 1.97x; G1 extras node 1.82x -> 2.38x, Chrome 1.66x -> 2.24x. The
geometric-mean half of the gate holds. The half "no workload more than 10% slower" does not: node `sha256` 0.11x, `fbBulk` 0.16x, `strConcat` 0.47x,
`strSubstr` 0.47x, `bbInts` 0.77x, `switchSparse` 0.83x, `fbLoop` 0.93x; Chrome `sha256` 0.12x, `fbBulk` 0.16x, `strConcat` 0.64x, `strSubstr` 0.46x,
`strBuild` 0.88x. Before (node/Chrome): `zipOpen` 0.01x/0.01x -> 1.21x/1.76x, `parseInts` 0.16x/0.18x -> 1.31x/1.20x, `strIndex` 0.63x/0.24x -> 2.09x/1.10x,
`strChars` 0.90x/0.53x -> 1.92x/1.61x, `jsonWrite` 0.95x/0.47x -> 1.90x/1.81x, `format` 1.43x/0.71x -> 2.03x/2.17x, `hashSet` 1.62x/4.12x -> 3.07x/8.0x.

**Why the rest fails.** `sha256`: the harness's digest of a 1 MB array is the JS form (3.4 ms of the 3.7), because a native cannot await `crypto.subtle`
(the JS tier does, 0.4 ms); it needs the suspension of S3, not a faster bridge. `fbBulk`: a `FloatBuffer.put` into a direct buffer is 16 K `array.set` into
a GC `byte[]`; there is no bulk operation between a GC array and anything else (`array.copy` is array to array, `array.init_data` reads a passive
segment), so about 0.25 ns per byte is the floor. `strSubstr` and `strConcat` allocate a struct and an array per String (a JS rope or slice is one
object): 7.5 ns per `substring`; the micro-measurement of the same two allocations is 2.2 ns, and removing the allocation accounting, an inlined
`sub` and a loop in place of `array.copy` each changed nothing, so the rest is the engine's inlining of the callers. `bbInts`, `switchSparse`, `fbLoop` are
code generation (4.7).

**Natives boundary** (`natives.ts`, `bridge.ts`). `$copy` copied a whole array element by element for each call (`zipOpen`: `initCEN` decodes each of 1000
entry names out of a 60 KB array, 66%, 60 ms). Natives whose contract is (array, offset, length) now copy that range (`RANGES`, 40 entries by class, name
and descriptor; text and pixel natives read a context around their range, so a descriptor-shape rule was wrong: `newStringFromUtf16Bytes` counts chars,
`CursorWindow.nativePutBlob` takes a row and a column), an `Object` argument reaches the native as just the range at offset 0 (`Bridge.offsetIn`), the loops
move two 32-bit words per iteration, and a call that reaches no array no longer reads the scratch top (`WebAssembly.Global.value` was 5% of `zipOpen`).
`zipOpen` 60.3 -> 0.65 ms. The Bridge also copied a primitive array three times; it now allocates the host array for the range only.

**OutOfMemoryError in `scanTokens`/`scanLines`.** Every `java.util.regex.Matcher` opens a native matcher through `NativeAllocationRegistry`, whose `sun.misc.Cleaner` never
ran: the `PhantomReference` held its referent strongly and the Cleaner list held the Cleaner, so 2,022 handles and 7 MB of matcher state stayed per call (heap 468 -> 525 MB
over 8 calls, measured with a handle count and a sampling heap profile that named `hitEndImpl`). `Cleaner.create` is now an intrinsic that makes the Cleaner without
its referent and registers the referent with a host `FinalizationRegistry` that runs `Cleaner.clean`; the harness yields to the event loop every 8 calls so
finalizers run. The limit also compared the whole JS heap (420 MB of it the engine's own program model) with ART's 512 MB; the World now takes the heap at construction as its
base. Either alone is not enough (the leak alone stops at 14 calls, the base alone at 100). `VMRuntime.addressOf` still pins every array it is asked about in
`pinned` and the `nm` table forever; direct buffers that are created and dropped leak through it, which no workload here shows.

**G5: strings as structs, adopted.** `StringRepr` has one implementation, `strings.ts`: `struct { vt, hash, chars: i16[], javaHash, jsString }`. Measured with the
same byte decoders (`strfactory.ts`) in both representations, 3 runs, steady js/wasm geometric mean over all 69 workloads: node JS-string 1.67x, struct 1.93x;
Chrome 1.74x, 2.06x. Per workload (node/Chrome, JS-string -> struct): `strIndex` 0.64/0.25 -> 1.98/1.06, `strChars` 0.92/0.57 -> 1.84/1.62, `strCompare` 0.85/0.75 -> 1.68/1.5,
`strEquals` 0.92/2.77 -> 1.92/6.1, `jsonWrite` 1.04/1.05 -> 1.86/1.85, `format` 1.60/1.83 -> 1.93/2.19, `jsonParse` 1.47/1.31 -> 2.29/1.88, `hashSet` 1.55/4.31 -> 2.71/8.0;
`strSubstr` 0.65/0.43 -> 0.52/0.44 and `scanLines`/`scanTokens` 1.12/1.08 -> 0.99/0.99 (node) are the losses. The micro-costs (`micro/strings.mjs`, ns, 60-char String,
node/Chrome): charAt 1.25/1.75 against 0.35/0.33 over an array, hash 0.74/1.5 against 0.57/0.58, 4-char substring 4.3/8.1 against 2.3/2.2, concat 9/5 against 19/20, equals of equal
Strings 4.3/5 against 31/35, and 25 ns to cross to the host and back. Hash codes are cached in the String, `String.intern` is a host table that also holds the constants,
ART's interned member names come from `intern` (`Method.equals` compares them by identity), and the String is a JS string only for natives
(`toHost` makes it once). `Integer.toString`/`Long.toString` write the chars directly and `parseInt(String)`/`parseLong(String)` take the plain decimal case and leave
the rest (radix, sign, overflow, exceptions) to the library method (`parseInts` 0.16x -> 1.31x node); `AbstractStringBuilder.putStringAt` is one pass instead of `coder()` and `getBytes`.
`String.indexOf` has no bulk operation to call over an array and loops over `array.get`.

**Rejected or neutral** (each measured, reverted). Allocation accounting dropped from `newCharsKnown`, `substring` written as one inlined function, and a char loop below 16
chars in place of `array.copy`: `strSubstr` 0.51 -> 0.50 to 0.52 each. The JS-string representation with its own Wasm byte decoders: lost to the struct everywhere (above).
Not built: a snapshot-and-compare copy-back to skip writing unchanged elements of a large array (`memory.copy` makes the snapshot cheap; useful for a native that only reads a large array, of which
`sha256` is the only measured case, and that one is bounded by the digest).
### 4.9 S4: ahead-of-time platform code and the cold profile (2026-10-04, `knlnks/wasm-h`)

**Where cold time went** (`g1.ts --phases`, node 24 and Chrome 153, shared host). A workload compiles 40 to 3,000 methods; per method the compiler spent 0.07 ms warm and 0.2 to 0.4 ms cold: emit 55%, infer 20%, encode 12%, flow and facts 10%; V8 `Module` + `Instance` of each unit 55 us; a class module (build + link) 0.2 ms. `sha256` (1,413 methods, 330 class modules): compile 275 ms, Module/Instance 72 ms, class modules 62 ms of a 565 ms first call (the rest is the natives bridge, `$copy:i8`). Process start (`processState`) compiles 411 methods and links 178 classes: about 330 ms. The jbench run compiled 35,992 methods in 7.2 s.

**Design** (`aot.ts`, `aotbuild.ts`, `aotstore.ts`, `aotstartup.ts`; `WEBDROID_AOT=<dir>` runs every harness over a build). `bun run aot --only <jars> [--d|--c class|outer|pkg|pkgN|all]` compiles the platform jars at build time through the same `Compiler.buildUnit` / `World.classModule`. Nothing in the generated code depends on what ran first: `World.seedPlatform` numbers the classes of the chosen dexes (ids, one block of table slots per class, `MethodInfo.index` is the offset in it) in definition order, and the index carries the rest (array and other extra ids, the slots reserved after them, selectors, gaps, link messages). The Program must start with the same dexes (a signature check; otherwise the build is not attached and everything compiles on demand). Class (D) modules hold the vtable, init word, statics, lazy-link stubs and `ensure` of a group of classes and import nothing from other modules; code (C) modules hold the methods of a group, install them in the table when instantiated, and import the D globals they name. Loading a C module first loads the D modules of the classes it touches (and their superclass closure), so a table slot it can call is never empty. String constants are imported (`importedStringConstants`), which removes the shared string table; first-tier counters are words of the scratch memory (no imported global per method); module headers and stack-trace maps are custom sections (`aot`, `aottrace`), so a `WebAssembly.Module` compiled ahead carries everything. Methods of a precompiled module call each other through the table, like on-demand units, so the second tier (still dynamic: `World.upgrade`) replaces them one at a time.

**Soundness.** A C module records its class-hierarchy decisions per method; at load, those about a class that gained concrete subtypes since the build (`World.late`) are checked and the methods that fail are put back to lazy-link stubs; later `addDexes`/`addClass` undo them through the ordinary assumption table. `World.holds` now asks only whether an added subtype has a different implementation. Sites that failed on a class missing at the build are undone the same way. A module whose natives are not bound in the World (other `Natives`) is not used; a method this World replaces by an intrinsic the build did not have (or the reverse) is put back too. `aottest.ts` checks both orders with `ArrayList.contains`/`indexOf`. Invalid code the compiler emits for a method (one found: `FinalizerReference.makeCircularListIfUnenqueued`, "expected 0 elements on the stack") is found by validating every module at build and leaves that method to the on-demand compiler.

**Numbers** (node 24.19 / Chrome 153.0, load average 2 to 7 on 14 cores, 3 runs x 30 reps, medians; geometric mean js/wasm over the 42 jbench workloads, first call: base 0.72 node / 0.25 Chrome, with AOT 0.84 / 0.32; steady state unchanged, 1.48 to 1.36 node and 1.51 to 1.44 Chrome within spread). Large first calls improve most (node ms, base to AOT): sha256 575 to 323, certParse 999 to 476, scanTokens 1165 to 531, jsonWrite 181 to 85, jsonParse 140 to 66, sort 37 to 18; small ones are at or below the JS tier in node (listAddGet 14 vs 21.5, deque, treeMap, casts, monitors), but below it only where the JS first call is 20 ms or more. In Chrome the JS tier's first call is 2 to 5 ms for most workloads against 6 to 13 ms for Wasm: the floor is instantiating the app unit, the first hot-loop upgrade (compiler cold, 3 to 4 ms) and V8's lazy compile of the functions that run; G1's "first call not worse" is not met there and is not met in node for the 20 workloads whose JS first call is under 10 ms. jbench compiles 4,368 methods instead of 35,992 (0.7 s instead of 7.2 s of compiler). Boot (`processState`) in node 198 ms (92 D, 20 C modules loaded, 11 MB) against about 330 ms; with the modules compiled ahead by `fetch` + `WebAssembly.compile` (`FetchStore`, `startup.json`) Chrome boot is 113 ms against 142 ms (29 ms of compiling off the main thread). `WebAssembly.compileStreaming` of the same bytes gave modules that fail (a NullPointerException in the platform's start): not understood, `FetchStore` compiles the fetched bytes.

**Asset sizes** (uncompressed, gzip -6 of the directory in brackets): core-oj, core-libart, okhttp, bouncycastle, apache-xml, conscrypt, core-icu4j: 8,534 classes, 66,101 methods, 279 + 279 modules, C 36.7 MB, D 7.2 MB, index 128 KB, build 4 s. The same plus framework.jar: 41,247 classes, 287,763 methods, 1,078 + 1,078 modules, 198 MB (44 MB gzip), index 935 KB, 31 s and 3.5 GB of memory to build; it attaches and passes jbench and aottest, process start 321 ms instead of 198. The largest module is 7.1 MB; Chrome refuses a synchronous compile above 8 MB on the main thread (a worker has no limit).

**Granularity** (node, 10 workloads, 3 runs; first-call geometric mean js/wasm and process start): D = C = package 1.08 (182 ms), package depth 3 1.06 (182 ms), outer class 0.99 (112 ms), one module for everything 0.99 (295 ms, and above Chrome's limit), class 0.55 (115 ms). Fewer larger modules win the first call (module count costs more than bytes: about 55 us per module against 3 ms per MB of validation), per class wins process start; package is the default.

**Cheap compiler wins.** LEB128 without BigInt, no `JSON.stringify` per local or function type, section assembly without per-byte pushes, `Cha.targets` answered from the implementations when a hierarchy is wide (it was 30 of the 36 ms of the first hot upgrade once the boot no longer warmed it; identical to the walk on 48,000 queries); jbench compile 7.2 to 5.2 s. Second-tier compiling is limited to 10 ms plus 30% of the time since the first request (a cold compiler made the first upgrades cost 3 to 4 ms each).

**Left.** The first-call floor in Chrome (tier-up while the compiler is cold; a worker for second-tier compiles); a profile-driven boot group (all classes the start touches in one D and one C module) instead of the package grouping; the ARM-side check of Chrome's `compileStreaming` failure; framework.jar chunking under the 8 MB main-thread limit by size instead of package; production persistence of the index and modules per build hash; G3 as defined (launch to first draw) needs the app-level harness.

**With the AOT platform code (4.9) merged** (`80b8f12f`..). H's modules import String constants as `externref` globals (`importedStringConstants`); with struct Strings a constant is
made on first use: a module-local function `$lit` takes the imported JS string, makes the String (`fromJs`), interns it through the host table (`String.intern` and the constants share it,
so interned-name identity holds across modules) and keeps it in a table of the module (a table, because an added global would shift the indices of the imports declared after it); the class
modules call the runtime function `strLit` for the static String values. The hash is a field of the String, so it is cached in AOT code as well. The `js-string` builtins stay: `fromCharCodeArray` and
`intoCharCodeArray` are the conversion to and from the JS string a native takes. `aot.ts` VERSION is 2. Build `aotbuild.ts` (4 jars, 218 + 218 modules, C 23.8 MB, D 4.6 MB) and the set (diff,
libdiff, classdiff, customdiff, linkdiff, lazytest, fuzz seeds, jbench, `aottest`) pass plain and over the build. Combined G1 (AOT build and `G1_PREFETCH=1`, 3 runs, load 2 to 6): jbench steady
node 1.25x -> 1.66x, Chrome 1.34x -> 1.90x; first call node 0.80x -> 0.95x, Chrome 0.33x -> 0.37x (all 69 workloads: first 0.92x -> 1.09x node, 0.34x -> 0.37x Chrome; steady 1.44x -> 1.90x, 1.51x -> 2.04x).
Still under 0.9 with AOT, node: `sha256`, `fbBulk`, `bbInts`, `strConcat` 0.46, `switchSparse`, `strBuild` 0.86, `strSubstr`; Chrome: `sha256`, `fbBulk`, `fbLoop`, `strConcat` 0.64, `strBuild` 0.88, `strSubstr`,
and `ecdsaVerify` 0.63 (0.28 ms JS tier, 0.46 ms Wasm; 1.00 in Chrome without the AOT build, in node with it, and with the AOT build before the struct String). Not the Cleaner, the ranges or the
harness's gc (each switched off alone); the JS profile of the two modes is the same BigInt code, the Wasm run has 100 ms more garbage collection in 1,500 calls. Unresolved.

**Two bugs found on the way.** `FinalizerReference.makeCircularListIfUnenqueued` (`refs.ts`) compiled to invalid Wasm because its `if` produced a value and was written without a block type; the Wasm validator rejects the
module, and `aotbuild.ts` leaves a method it cannot compile to the on-demand compiler, which then fails the same way at run time. The sweep now covers the jars the build compiles (the first six boot jars, 281,000
methods, no invalid module) with the options the engine uses (`COMPILE_OPTIONS`). `WebAssembly.compileStreaming` of the AOT modules made `Reflection.getCallerClass` answer the wrong class: a module compiled from a
streamed response names its frames by the response's URL (`at f (http://host/m?p=...:wasm-function[3]:0x176)`), not `wasm://wasm/<hash>`, and `javaFrames` only read the second form, so every frame of a streamed
module was skipped (node's `compileStreaming` and tiny modules in Chrome look identical, hence "works with fetch + compile"). Options and import object were identical (`micro/streaming.mjs`: the builtins and the imported
constants work through `compileStreaming` in Chrome 153). `FRAME` now accepts both and `aotstore.ts` streams again.

### 4.11 S1-J: the G1 first call and the residual steady losers (2026-10-04, `knlnks/wasm-j`)

**Where the first call went.** With the AOT platform (4.9) the first call of a small workload was still 6 to 13 ms in Chrome, and `--phases` showed why: 3 to 10 ms of it was the *second tier*. A loop that spends its budget (5,000) asks `World.upgrade`, which compiled the method and its small callees at once, with a cold compiler (about 0.5 ms per method; `UPGRADE_FREE_MS` allowed the first 10 ms for free). With upgrades switched off, `listAddGet` node first call went 14.7 -> 3.5 ms. The upgrade now waits until the program has been hot long enough to pay for it: a request is refused (and renewed after another budget) while `upgradeMs + expected cost > 0.3 x (time since the first request)`; the expected cost is 1 ms until a compile has been measured, then the mean. A loop that stays hot for about 3 ms upgrades as before; a first call that is short never pays. `lazytest` and `trace` ran their hot loop for 40,000 iterations and asserted an upgrade; they now call until one has happened.

**App compiled at build time.** `bun run aot --app <dex>` numbers and compiles an app dex after the platform's, as an install would (`AotRuntime.attach` already accepts a Program of the platform dexes plus more; the build records the app's dex signature, so a different app does not attach). In the harness, `bun aotbuild.ts --app $TMPDIR/g1/classes.dex` (the dex `g1.ts` builds; copy `startup.json` from a build without it, the boot does not touch the app). The first call of `intLoop` in Chrome 4.7 -> 2.4 ms (it compiled its method and a second unit on demand, 3 ms), `listAddGet` 6.1 -> 3.4, `hashSet` 4.9 -> 2.7. Every workload of the harness is in that one dex, so its C module is the size of a package of a real app.

**Sparse `switch` and the array peek/poke natives.** Keys that are not dense enough for `br_table` are searched in halves down to runs of three compares (`switchSparse` node 0.98 -> 1.09, Chrome 1.00 -> 1.21; `W.sparse9` joins `diff`). `Memory.peek/poke<Kind>Array` test the byte order once (two loops instead of an xor per byte), step a position instead of recomputing `i * w`, and byte kinds are one `array.copy`: `fbLoop` Chrome 0.84 -> 0.94..1.10, `fbBulk` unchanged.

**G1, js/wasm geometric mean** (3 runs x 100 reps, node 24.19 / Chrome 153.0, load average 2 to 4 on 14 cores: +-10% per workload, flagged noisy; the same harness at `9bc05263` in a second worktree is the base). jbench's 42 workloads (the gate), first call / steady:

| build | node first | node steady | Chrome first | Chrome steady |
|---|---|---|---|---|
| base: 4 jars (4.9 combined) | 1.01 | 1.67 | 0.38 | 1.88 |
| + deferred second tier, switch, memory | 1.35 | 1.64 | 0.52 | 1.76 |
| + app compiled at build time | 1.97 | 1.54 | 0.73 | 1.76 |
| 7 jars (core-oj, core-libart, okhttp, bouncycastle, apache-xml, conscrypt, core-icu4j) + app | 2.42 | 1.55 | 0.76 | 1.74 |

All 69 workloads, last three rows against base: node first 1.20 -> 1.45 -> 2.49 -> 3.03, steady 1.88 -> 1.89 -> 1.81 -> 1.80; Chrome first 0.38 -> 0.49 -> 0.77 -> 0.80, steady 2.03 -> 1.94 -> 1.96 -> 1.95. The steady geometric mean loses 5 to 8% because a workload that is 5 ms long in total (a hundred calls of 0.05 ms) now upgrades after about 60 of them, and Wasm's own tier-up (Liftoff to TurboFan) then starts later (`listAddGet` 0.03 -> 0.059 in one run, 0.030 in the next: the policy is time-based, so it moves with host load); it is within the gate's 1.3x. **First call passes in node and not in Chrome**: Chrome's JS tier takes 1 to 5 ms for the small workloads and Wasm 2 to 4 now (`hashSet` 2.7 against 3.0, `listAddGet` 3.4 against 3.2, `intLoop` 2.4 against 1.8), and the geometric mean is dragged below 1 by the 12 workloads that run platform code which the build does not hold or that V8 must compile (`sha256`, `ecdsaVerify`, `certParse`, `scanTokens`, `scanLines`, `zipOpen`: 0.25 to 0.64; `ssb*`, `spannedCopy`, `linkify`, `b64android`, `dtoa`, `dbInts`: 0.3 to 0.5, all `framework.jar` code). Building `framework.jar` too (204 MB, 1,079 modules) gave `ssbAppend` 39 -> 33 ms, `linkify` 42 -> 42, `b64android` 21 -> 25: the remaining cost there is V8 compiling and validating the multi-MB package modules (about 3 ms per MB), not our compiler; the page cannot hold that build (fetching 204 MB per context failed in Chrome).

**Still failing the steady half** ("no workload more than 10% slower", js/wasm, node/Chrome): `sha256` 0.11/0.12 (the harness's digest is the JS form; it needs S3's suspension), `fbBulk` 0.17/0.17, `strConcat` 0.48/0.4, `strSubstr` 0.47/0.6, `strBuild` 0.88/0.76, `bbInts` 0.66 to 0.77/0.5 to 0.95, `ecdsaVerify` Chrome 0.62, `fbLoop` Chrome 0.84 to 0.94.

**Rejected or not built** (each measured unless it says so).
- `fbBulk`: there is no bulk operation between linear memory and a GC array (`array.new_data`/`array.init_data` read passive data segments, `array.copy` is array to array), so a staging area in linear memory cannot beat the per-element `array.set`. With one byte-order test and a stepped position the 4,096-float `put` is still 0.2 ms, 1 ns per float, 0.25 ns per byte. The remaining route is a direct buffer in linear memory (a native allocator with the lifetime of the `NativeAllocationRegistry`), which also gives the natives views without a copy; not built.
- `strSubstr`/`strConcat`: sharing the parent's chars with offset and length fields would save the array allocation, but 4.10 measured the two allocations at 2.2 ns of the 7.5 ns and removing the accounting or the loop changed nothing; the best case is then about 0.8x, still under the gate, and it adds an offset to `charAt`, `equals`, `hash` and every native string conversion. A rope node flattened on first `charAt` is the same size of change for `strConcat`, whose cost is the byte-array `StringBuilder` of libcore (`putStringAt`, `getBytes`, the decoder in `toString`) against the JS tier's native builder. Not built.
- Upgrade cost estimated per method (0.4 or 0.2 ms times the group size) instead of 1 ms: `listAddGet` first call 3.6 -> 8.1 ms, nothing gained elsewhere. Thresholds of 0.5 ms or a share of 0.5 or 1: first call 3.5 -> 11 ms (the first compile of a group costs about 7 ms with a cold compiler).
- Compiling second-tier groups in a worker or at idle: not built. The group needs the World's class hierarchy and program model (hundreds of MB), and its install is synchronous; a copy in the worker would double the model. Deferring until the code has been hot recovers most of the first-call time without it.
- A profile-driven boot group (one D and one C module for what the start touches), engine warming and avoiding the re-instantiation of the app unit: not built; with the second tier deferred and the app in the build, the first call of the small workloads has no compile left (`call` phase: 0 methods, 0 ms), so there is nothing for them to remove, and boot (`processState`, 92 D and 20 C modules, 110 to 130 ms) is outside G1's first call.
- Chrome flags: none can be set from a page.

**Harness.** The page script of `g1.ts` had an extra brace since the streaming switch (4.9): every Chrome run timed out waiting for the page; fixed. Tests (`diff`, `libdiff`, `classdiff`, `customdiff`, `linkdiff`, `lazytest`, `aottest`, `fuzz` seeds 1 to 6, `jbench` 42 MATCH) pass plain and over a 4-jar build.

### 4.12 Track A: delivery of the platform build and the Program model (2026-10-04, `knlnks/wasm-ta`)

**A1, build and delivery.** `bun run aot` builds the libcore jars and `framework.jar` (41,247 classes, 287,769 methods, 1,085 C and 1,078 D modules, 204 MB, 55 s and no memory trouble under node) into `vendor/wasm-aot/<key>`,
where the key is a digest of the platform jars, `src/wasm/{compiler,link}`, the shared front end (`dex prepared structure opcodes abi`), the registered native keys, the build format and the options; the same key
names the build when it is made again (skipped). A group of classes (a package) is split into modules of an estimated 3 MiB (`--max-module`; the estimate is 14 bytes per dex code unit and 150 per method for code
modules, 52 per method for data modules, measured over the 7-jar build as within 0.5x to 1.5x), the largest module of the framework build is 3.4 MB, and a module over 7 MiB fails the build. `startup.json` lists the 188 files (28 MB) a
start of the process loads; `current.json` names the build and carries the digest of the sources it was made from, which the dev server compares with the sources now (a stale build is not offered) and `build-prod` refuses.
Cloudflare (docs read 2026-10-04: static assets 25 MiB per file, 20,000 files per version on the free plan, 100,000 paid; Workers Builds 8 GB of memory, 20 minutes) takes this build as it is: 2,163 files, `_headers` makes
`/aot/<key>/*` immutable and `current.json` revalidates; `bun run worker:check` reads 6,001 files. The build is made where `vendor/aosp` is, not by `build-prod`, and shipped when present.
**D1, the miss policy.** A page never fetches synchronously. `FetchStore` compiles the start's modules with `compileStreaming` (the fetch of the whole build failed in a page; 28 MB does not), and a module the store lacks is a
miss: the code is compiled on demand against the build's numbering (a seeded class that misses its D module is compiled with its reserved slots; a C module is used only with the D modules it was built against), and the
answer is kept, so a module that arrives later cannot define a class twice. `aottest` runs stores that lack every other module, every module, and modules that arrive late. A module compiled by the tab is a
`WebAssembly.Module` of the tab's realm, so `instanceof WebAssembly.Module` is false in a process frame (it failed in the probe), and `ArrayBuffer.isView` tells bytes from a module.
`bun run wasm boot-probe` (headless Chrome, `?tier=wasm`): the tab opens the build, starts the process (`processState`: 188 modules loaded, 0 missed, 0 synchronous requests, 200 ms to fetch and compile them off the main thread,
boot 250 to 330 ms of which our compiler 4 ms for 16 methods) and an iframe does it again with no request, a shared platform Program and its modules.
**A2, the Program.** `Program` keeps a `DexClass` per class that reads its header when asked and builds `FieldInfo`/`MethodInfo`/`byKey` when the first of them is used; the class-hierarchy index (`cha.ts`) works from headers and
method declarations (`DexFile.classHeader`, `declaredMethodCount`, `methodKey`), with the "classes that declare a concrete method of this key" index built on the first wide-hierarchy query. `new Program(dexes, base)` extends an
immutable base Program (the platform's), whose memos and class-hierarchy index are kept in the base (`Program.shared`) and so exist once per tab (`host/boot.ts` `platformProgram`). Node 24, `--expose-gc`, all 40 boot jars
(54,727 classes) and Mihon (21,905 classes): `new Program` 330 MB and 425 MB before; platform Program and index 24 MB (once per tab), the index of declared method keys 63 MB more on first use (once per tab), Mihon over it 12 MB per
process; touching five classes (2,222 methods) 1 MB.
Loaders: a loader is a namespace (`Loader`: parent, `defined`, its Java object); the default one holds the platform and the app (first definition wins, as before) and any other holds what its dex files define that its parent
does not (parent first, as BaseDexClassLoader), keyed `name@id`. A class has one key whatever loader defines it, so ids, class modules, statics and vtables are per defining loader without any other change, and the
platform keeps its build numbering. The dex files of a loader see the classes through it: `DexFile.resolveType` maps each descriptor it reads to the key its loader resolves, so the compiler, the linker and reflection read keys
from the dex and nothing else changes; `javaName` strips the suffix wherever Java sees a name (`Class.getName`, messages, stack traces). The DexFile natives of libcore's `BaseDexClassLoader` (`openDexFileNative`,
`defineClassNative`, `closeDexFile`, `isBackedByOatFile`, `verifyInBackgroundNative`) are Wasm over `World.opts.dexes(path)`; `Class.forName(name, init, loader)` and `VMClassLoader.findLoadedClass` resolve in the loader's scope,
`Class.classLoader` is the loader's object, and a loader that opens dex files the Program already holds stays in that namespace. Not done: `getClassNameList` (a gap), `DexFile.loadClass` defining in the cookie's loader instead of the
given one, the app's own PathClassLoader object as the default namespace's `getClassLoader` (classes of the default namespace still answer the boot loader), custom `ClassLoader` subclasses that define classes themselves.
`bun run wasm loaders`: two DexClassLoaders over dex files defining `Shared` (and `Boom`): distinct Class objects, statics, instances, array classes, signatures naming the loader's own class, exceptions thrown and caught inside
a loader and seen from outside, `Class.forName`, `loadClass`, `getClassLoader`, `instanceof`/casts across loaders and through the app's `Tag`.

### 4.14 B2: classes the host implements (2026-10-04, `knlnks/wasm-tb2`)

The registered specs (`rt.register`) outside the VM's own classes (`TS_SPECS` "vm:", and the "intrinsic:" ones, which stand in for bytecode for speed) are the **host classes**: 147 of the 194 specs, `webdroid/*` services and helpers, the WebView
provider, the TLS and HTTP boundary (`java/net/HttpURLConnection`, `javax/net/ssl/*`, `com/android/okhttp/Http{,s}Handler`) and the GL/EGL implementations; over the 40 boot jars all 147 are defined (124 classes of natives, 23 over dex classes). `World.addHostClass(spec)` (`link/hostclass.ts`; `nativeSource.hostSpecs()` lists them) makes each a Java class
once its superclass and interfaces exist (a spec waiting for one is retried as dexes arrive):
 - A spec whose class no dex defines becomes a class of natives (`World.addClass`): every method key a native with the spec's function behind its host import, the spec's `ifaces`, and the constructor Java finds when the spec declares none (`<init>()V` calling the superclass's), so `newObj`, a bytecode subclass's
   `super()` and `Class.newInstance` work on it.
 - A spec whose class a dex defines (the boundary) takes over the methods that class declares, in a class of the World's own Program layer that stands for it (methods copied at the same positions; their bodies are dropped, an abstract one becomes concrete, the AOT build's code for them is not used: `AotRuntime.override`); the platform's classes, which the Worlds of a tab share, are never changed (`Program.shadowing` makes the layer answer for implementations). A method the spec implements that a superclass declares (`connect()` of URLConnection,
   implemented for HttpURLConnection) cannot be added to the class without changing the numbering of its slots, so it is a native of a class of its own (`name$$host`) that the class's `byKey` resolves it in; `implFor`, `resolve`, `invoke-super` and the vtable find it there, reflection does not list it.

**Identity.** A Java object whose class chain reaches a host class has a host object (an instance of the spec's TS class) beside it; the natives of the spec take it as `this`, and every other place a native or a host call sees that Java object (arguments, results, fields, arrays, `vcall`
receivers, `classNameOf`) sees the same host object, never a facade. A host object that crosses to Java is the Java object it was made with, allocated when it first crosses (`Bridge.shellOf`). `self() === receiver` holds both ways, `equals`/`hashCode`/`HashSet`/`indexOf` in Java agree with `===` in TS (`hostclass`).
A Java object Java allocated (a bytecode subclass of a host class, `HttpURLConnectionImpl`) gets its host object at its first host call, which is its constructor.
**Lifetime.** The two are linked by two `WeakMap`s (Java object to host object, host object to Java object) and nothing else: each keeps the other alive exactly as long as it lives itself, an ephemeron cycle the collector frees when neither is reachable from elsewhere, and there is no table to leak from or to
clean (`hostclass` collects both ways under `--expose-gc`, and checks that a Java object that Java holds keeps its host object).
**Fields.** The host object reaches the fields of its Java object as properties: every instance field of the class's layout under its mangled name (so `declaredField`, `getDeclared`, and a spec such as HttpURLConnection reading `URLConnection.connected` by name work on a host object), and the fields `fields:` names under their
host property (HttpURLConnection's `method`, `responseCode`, ...). What the host object holds in such a property when it is made is stored into the field (a field Java wrote first keeps its value). A property of a class that has no Java field of that name stays an ordinary property. **Hooks.** `claimOnStore` is a store hook: a store into a long
field of a class with a `finalize()` calls `host.claim(owner, handle)` (`rt.claimHandle`), whose `FinalizationRegistry` frees the handle with the owner.
**Deviation from the breakdown (2.3):** no `$host` field. A field added to a platform class changes the struct type of its subclasses and so the layout the AOT build was compiled against, and a class made at run time needs the same table for the classes of the boundary, so one pair of weak tables serves both; the cost is a `WeakMap` get where `this` is bound.
**Not done:** `statics:`, `clinit` and `platformClinit` of a spec (no host class uses them: the boundary's constants come from the dex), `callerSensitive`, JS-prototype checks inside a spec (HttpURLConnection's `getResponseCode` asks whether `getInputStream` is overridden by comparing prototype properties, which a host object has none of),
methods of a spec that no supertype declares (Java cannot call them), and the CHA of a wide hierarchy for the methods in `name$$host` (the walk of a small one finds them).
`bun run wasm hostclass`: 26 cases on the JS tier and on a World (a `Counter` spec with interfaces, an alias, `self()`, a host-made object passed to Java and kept there, a Java-made subclass whose `twice()` virtual call from the host reaches the override, an `AbstractList` spec with a bytecode subclass calling `super.get`, an HttpURLConnection subclass whose Java and host sides read and write
each other's fields, and the exceptions each way), a host method that waits called from a bytecode subclass, and one that enters Java that blocks on a monitor (both Suspending natives: the host object is `this` through the wait), the lifetime checks and the handle claims. `aottest` checks that a host class's method replaces the build's code.
### 4.12 S3: strands, monitors and the waits (C1 and C2, 2026-10-04, `knlnks/wasm-tc`)

**Substrate** (`link/sched.ts`, `link/monitor.ts`, `host/suspend.ts`). A Java thread is a strand, a JSPI stack: `Strand.call(f)` runs a table function through `WebAssembly.promising`, `World.entryAsync` is the entry
that may block (a new strand of the main thread). Compiled code reaches the scheduler through two imports: `host.sync(op, obj, a)` answers at once, `host.block(op, obj, a, b)` is Suspending and answers a status the Wasm
side turns into the exception (`blockStatus`: InterruptedException, IllegalMonitorStateException, IllegalArgumentException for a timeout, and an IllegalStateException when the stack cannot suspend). There is no
scheduler loop: the strand that resumes is the one whose promise a waker resolved. `sid` (strand id), `thr` (the Thread) and `depth` are globals the running strand owns; a blocking call keeps them in locals and sets them
again after it (`emitSave`), and every Suspending wrapper puts them back to the host's top level when its function returns, so host code at the top level always sees strand 1 (the root, which cannot suspend).
Measured (platform-status.md): a Suspending import answering a plain value still suspends and costs 52 ns against 4 for a plain import, so only natives that can wait get one; `entryAsync` costs 1.4 us against 0.9 for `entry`.
Natives: async functions are Suspending only; generator natives (`$g`) and `MAY_SUSPEND` ones (conscrypt's `EVP_DigestFinal_ex`, which answers a Promise only for a message of 64 KB or more) have a plain import and a
Suspending one (`id#s`), and the stub calls the Suspending one on a strand's stack and the plain one at the top level. A plain import that answers a Promise is reported (`wasmNativeSuspended`, `suspendedNatives`),
a call the engine refuses to suspend (a JS frame between the strand's entry and the import) is counted (`wasmSuspendErrors`). The Bridge scope of a Suspending native is set aside while it waits (`hold`), and its arrays are
private copies written to the scratch region on resume (H2). The harness workaround for the digest is gone: `sha256` steady 3.8 ms -> 0.9 ms (JS tier 0.44), through `entryAsync`.
**Monitors.** The header word of every object is an i64: identity hash in the low half, the lock in the high half (0 free; strand id << 8 | count for a thin lock, count up to 255; INFLATED | index for a host
monitor). `monitor-enter/exit` are the module-local helpers `menter`/`mexit` (thin fast path), `menterSlow`/`mexitSlow` otherwise. Inflation happens on contention, a count past 255 and the first `wait`; an idle
monitor deflates. Ownership is by strand, a thread's root strand shares with its other strands (as the JS tier's `owns`), a lock whose owner strand has ended is free. `wait/notify/notifyAll`, `Thread.sleep(lock, ms, ns)`
(a timed wait on `Thread.lock`), `Thread.nativeCreate` (the body is a strand: `run`, `dispatchUncaughtException`, `exit`, peer cleared, joiners notified), `interrupt0`/`interrupted`, `holdsLock`, `Unsafe.park/unpark`
(both Unsafe classes), `Thread.getState` are intrinsics over those imports; the real libcore `Thread`, `LockSupport` and `java.util.concurrent` run unchanged.
**Class initialization.** The init word holds `strand << 2 | 1`; the same strand proceeds, another waits in `initWait` (Suspending; woken by `initWake` when the initializer finishes or fails), a request the initializer
waits on through classes or locks (`waitsOn`) proceeds with the statics as they are, as clinit.ts does.
**Fuel and depth.** A loop whose body calls, locks or reads a field counts its iterations in a local of its activation and every 4,096 yields (`yieldNow`: a macrotask once the turn has held the thread 8 ms, else a
microtask hop, so strands whose promises resolved run); the check is skipped for loops of arithmetic and array elements, where it cost 40 to 150% (the `call` in the loop is the cost, not the counter). Methods that
call something count their frame weight (4 + Wasm locals) in `depth` against `MAX_DEPTH` 56,000 (about half what node's stack holds: 8,700 frames of weight 11 or 2,030 of weight 53) and throw StackOverflowError themselves,
so a Java `catch (StackOverflowError)` works mid-stack on the host's stack and on strands'; an overflow that still reaches the engine is converted at the boundary as before. The depth is restored on return and at handlers.
**Results.** `bun run wasm threads`: 38 Java cases (monitors, wait/notify ping-pong, contention, sleep order, interrupts, join, uncaught handlers, thread states, park/unpark, ExecutorService, ConcurrentHashMap under
contention, CountDownLatch, ReentrantLock/Condition, BlockingQueue, Semaphore, FutureTask, ScheduledExecutor, CompletableFuture, 100 threads, class-init race, cycle, failure, a deadlock the JVM has) agree with the JDK;
the JS tier differs on the two stack-overflow cases (its handler throws an InternalError). Direct checks: async, generator and nested promising natives, 1,000 stacks suspended in a native (5 ms), a plain native answering
a Promise, a native waiting under a JS frame (SuspendError, counted), overflow on both kinds of stack. G1 node, steady ms base -> branch (JS tier): monitors 0.096 -> 0.162 (0.24), sha256 3.8 -> 0.9 (0.44), kernels
(intLoop, longLoop, doubleLoop, sieve, matrix, arraySum, fieldLoop) unchanged within noise, virtualMono 0.033 -> 0.074, allocLoop 0.012 -> 0.026, mapInt 0.087 -> 0.11, listAddGet 0.032 -> 0.045, random 0.069 -> 0.09
(loops with a call pay the fuel check; the i64 header costs allocation-heavy rows part of it). Load average 4 to 5, so +-10%.
**Open.** A native that calls Java through a plain call and expects it to block gets SuspendError (entry.ts must call through strands); the depth limit is conservative and Chrome's JSPI stack size is unmeasured;
`Thread.getState` of a thread blocked in `initWait`/`monitor enter` reports BLOCKED, `synchronized` on a `Class` or String works but `Thread.holdsLock(null)` is not checked; `Thread.priority`, `stop` and daemon exit
are not modelled; the AOT build key changes (header layout, imports).
### 4.13 Track A3: app compile off the main thread, and persisted app code (2026-10-04, `knlnks/wasm-ta3`)

**What the worker can and cannot share.** Compiled code names classes, selectors, table slots, gaps and link messages by number, and the numbers are whatever the World handed out in the order the program asked, so a unit
made by another World is the page's only if that World numbered the same things in the same order. Two mechanisms, one idea (`World.numbering/since/adopt/rollback`, `aot.ts` `Marks`/`Numbering`; the platform build's `tail`
log is now kept by every World):
- *Second-tier units.* The worker holds a compile-only World (`WorldOptions.compileOnly`: classes are numbered and linked by name, nothing is instantiated) over a copy of the app's dex files and the platform's, attached to the
  same platform index. The page sends the numbering it has done since the worker last heard (`sync`) with each job (`World.upgradeJob`: the group `group()` chose, the guarded-call plan, the classes initialized since); the
  worker numbers whatever its unit needs beyond that and returns it with the unit (`link/unit.ts`). `World.adoptUnit` takes the unit if no dex file was added since the job (`epoch`), its natives are bound and the page has
  numbered nothing since it sent the job (a unit that needed no new number is taken whatever the page did meanwhile); the numbering is then replayed in the page and the worker keeps its own, else the worker rolls its
  numbering back to the page's before the next job. A hot method keeps running its first-tier code until the unit arrives and does not ask again meanwhile (`pending`); a refused unit lets it ask again after another budget. The
  unit's `WebAssembly.Module` is compiled and validated in the worker and posted whole. A loader of its own, `addClass`, or repeated worker failures retire the worker and the page compiles inline as before.
- *App builds.* `link/apps.ts` compiles the methods an app is likely to run (the baseline profile's, the launch classes', the manifest's components', then `callClosure`, the selection `compileworker.ts` uses) into code modules
  `a<k>.wasm` of at most about 1 MiB (estimated) and records the numbering they rely on as an `AppIndex`. It continues the numbering of the World right after the platform build is attached, so it is used only by a World
  that numbered nothing since (`AotRuntime.extend`, called from the World's constructor with `WorldOptions.app`) and whose Program starts with the same dex files (a signature check; later dex files are allowed). Its modules load
  the way the platform's code modules do (`loadC`, one module on the first call of one of its methods), import the class globals they use by class id from whatever module the page made for the class
  (`World.classImports`), and record their class-hierarchy decisions in the same header; a decision about a class added after the build is checked at load against `World.late` without the app's own classes and the method
  is put back to a lazy-link stub if it fails, and later `addDexes` undo them through the ordinary assumption table.

**Persistence** (`host/persist.ts`, `host/appcode.ts`). The files of a build are kept in OPFS (Cache Storage where OPFS is unavailable) under a key of the app's dex files (`DexFile.id`), the platform build key and the build
format; an entry is listed once all its files are written, checked for size on load (a damaged one is removed), limited to 64 MiB, and the least recently used entries go when the total passes 256 MiB. `prepareApp` loads the
saved build and compiles its modules (asynchronously, before the World exists); without one, a worker of its own builds it while the launch goes on and the page keeps it for the next launch (nothing is attached
mid-launch: the numbering would no longer match). `bootWasmTier` is not wired to it: the tier's boot still makes the World from the first dex it is given, and where the app's dex files and the platform Program arrive is Track C3's.

**Tests.** `bun run wasm persist` (node, the protocol over a `MessageChannel`): the numbering handshake (a unit that numbered something is not taken after the page did, the worker follows the page after a refusal, a stale epoch is
refused), second-tier units adopted from the worker with the answers unchanged, the worker retired by a loader of its own, the app build attached with its answers equal, fewer methods compiled on demand, a CHA decision of the
build undone by a dex added later and by a dex present from the start behind the app's, builds that do not match (other dex files, base, format) not used, a missing module compiled on demand, and the store's limits,
eviction, damage and replacement. `aottest` is unchanged. `bun run wasm boot-probe` now also runs the Pst fixture in Chrome with a real Worker and OPFS: the first load has no saved build, a Worker builds and the page
keeps it, a hot loop's second tier comes from the Worker; the iframe, a second load of the same dex, finds the build (13 ms to read and compile it), attaches it, loads its module and compiles 22 methods on demand instead of 35. The probe
no longer runs under `?tier=wasm`: the merge of Tracks A and B left it failing there (the oracle's natives link JS-runtime classes, which the tier refuses) and the page runs the Wasm host libraries directly.

**Numbers** (node 24.19 on an idle M-series laptop; FitNotes, the Application, launcher and manifest components with the call closure, no baseline profile). Building the app: 3,492 methods in 2 modules, 0.68 s in the
worker (0.20 ms per method as one module per group) against 1.18 s for the main thread to compile the same methods as first calls do (0.34 ms per method: compiler 0.88 s, Module 0.17 s, Instance 0.10 s). Loading the saved build:
2 ms to read and compile its modules, 0.36 to 0.40 s from the first call to all of its 3,492 methods installed (60 ms of it Instance; the rest links the classes they use, which the on-demand path pays too and is in its 1.18 s). The main thread
no longer pays the compile on a launch with a saved build (about 3x less), nor on the first launch once the worker finishes. Second tier: the main thread's compile time for the hot methods of four jbench workloads, one call
at a time with the event loop turning in between, was 114 ms (sha256), 44 (jsonParse), 138 (scanTokens), 28 (mapStr) inline and 1, 3, 5, 1 ms adopting the worker's units (110 to 141 ms of worker time, no unit
refused); run times after the first call are the same within spread. A single long synchronous call gets nothing from the worker (its units arrive after the call; the inline path replaces the table entry for the next call
as well, not for the running frames).

**Not done / open.** The `lat` gate (FitNotes, Calculator M, Mihon cold and warm, no gated tap above 150 ms) needs the framework to boot under `?tier=wasm` (Track C3); nothing here is measured at a tap. Class modules (D) of the
app's classes are not persisted: the page makes them on first use (0.2 ms each), as for any class the platform build lacks. The build covers the launch's likely methods only; later runs do not add to it (the JS tier's code cache
does). A build is not attached to a World that has already numbered something, nor to loaders other than the default namespace; a DexClassLoader's dex files and a plugin's code compile on demand. The worker keeps a
second copy of the app's dex bytes and its own platform Program (about 24 MB plus the parse of the dex files it touches). The numbering handshake refuses a unit when the page numbered meanwhile; no unit was refused in the
runs above, but an app that links classes continuously while it is hot would see more refusals (they cost the worker's time only).

### 4.15 B3: JNI, arrays and buffers (2026-10-04, `knlnks/wasm-tb3`)

**Direct buffers in the core's memory.** A Wasm GC array cannot be seen from linear memory, so a `DirectByteBuffer` no longer owns a `byte[]`: `MemoryRef.<init>(int)` is an intrinsic (`link/memory.ts`) that takes a zeroed block of the native core's allocator (`host/guest.ts`, `GuestMemory`) at the address the guest knows, with `buffer == null`, freed by a `FinalizationRegistry` when the MemoryRef is collected. Java code, production natives (`bufferBytes`) and native code (`GetDirectBufferAddress`) read the same bytes with no copy. `libcore.io.Memory` reaches an address of the first 4 GiB (above the core's reserved low pages) through runtime functions over the core's memory (`link/guest.ts`: `gld8..64`, `gst8..64`, `gget_/gput_<i8|i16|i32|i64>` copying an array range to or from it in one loop, byte order applied on the way); other addresses (external mappings, higher planes) stay with the production natives. They are runtime functions (a table slot, 1.5 ns a call, measured) and not inline loads because the memory's type (shared or not) is then declared by a module made at run time, never by precompiled code, and multi-memory is not on the default path (G7). Deviation from ART: `hasArray()`/`array()` of a direct buffer answer false/throw (ART's has the non-movable array).
**The pin leak.** `VMRuntime.addressOf` pinned every byte[] in the `nm` table and a map, for good. Nothing pins any more (`nm` holds only the Method objects of proxy classes). `addressOf` of an array that is not a MemoryRef's is still the production handle, which for a Wasm array is a handle of the scoped copy (see Open). H2 enumeration: `mem.isGuest` is read by `VMRuntime.addressOf` and `gles3-pixels`; `nonMovableBytes` (guest-backed `Int8Array`) only by `newNonMovableArray(byte)`; `addressOf` is called by `MemoryRef` (replaced), `TypedArray.resize` (an int[]) and `PathIterator` (non-guest arrays: handles).
**JNI.** `native/jni.ts` keeps the tables and the marshalling and asks everything about classes, objects, fields, methods and arrays of `JniVm` (`native/jnivm.ts`): `jnijs.ts` is the JS tier's (moved, behaviour unchanged), `host/jni.ts` the Wasm tier's. A reference in a table is the tier's own: on the Wasm tier the Wasm reference. Fields and calls go through `Bridge.call/read/write` (generated Wasm, no facade), array regions through `gget_/gput_` straight to guest memory, so an array native code holds is the array Java mutates (`arrays are the Java arrays` in `jni.test.ts`). A native with guest code is a `javaValues` HostFn: the Wasm import passes every reference opaque (no String conversion, no array copy, no Bridge scope). A native with no implementation when its class is compiled (a JNI library registers its natives when loaded, after the class was compiled) is bound to a stand-in that finds `rt.jniFn` when called (`NativeSource.late`), so `RegisterNatives` after the class ran works. References: locals per Cpu in frames (freed with the native's frame, `DeleteLocalRef`, `PopLocalFrame`), globals in a free-listed table, weak globals as `WeakRef`s (a collected one is null; before they were strong globals), `GetObjectRefType` tells the three. Pinned `Get<Prim>ArrayElements` copies leave the table on Release (mode 0 and `JNI_ABORT`; `JNI_COMMIT` keeps it).
**Evidence.** `bun test src/native/jni.test.ts`: 24 pass on the JS tier; `WEBDROID_TIER=wasm`: 20 pass, 4 skipped (the JS tier's parked-Promise callbacks and a native that makes JNI calls of its own, which waits and so needs a strand to enter from: Track C3). The suite is on both ABIs: call families (virtual, nonvirtual, static, A/V forms), reflection round trip, fields of every type, strings, arrays, exceptions, references including weak collection, monitors, direct buffers, critical/fast ABI, natives taking and answering references, RegisterNatives after the class ran. `bun run wasm diff` gains `directBulk` (both byte orders, views, slices, direct to direct, heap to direct). Typecheck, `bun run test` (1167), `wasm all`, `smoke FitNotes` (0 failures), `fwtest` (identical to the base); `wasm sweep` of Cut the Rope's dex: 430,976 methods, 0 failures (JS tier `smoke` of the XAPK: 64,465 classes, 0 method failures); the `doodlejump` e2e flow (ARM32 JNI) reaches its checkpoints on the JS tier after the refactor.
**G1 (node 24 / Chrome 153, 5 runs x 100 reps, load average 11 to 20: indicative), js/wasm steady** `fbBulk` 0.19 / 0.17 -> 0.44 / 0.53 (0.225 -> 0.095 ms in node, 0.230 -> 0.075 in Chrome; a loop of array loads and 32-bit stores per float is the floor, there is no GC-array to memory bulk op), `fbLoop` 0.66 / 0.69 -> 0.63 / 0.52 (Chrome 0.240 -> 0.280 ms: each element is a 1.5 ns call where the pinned array was inline loads), `dbInts` 2.12 / 1.92 -> 2.13 / 1.75, `bbInts` (a heap buffer, unaffected) 0.59 / 0.58 -> 0.58 / 0.59.
**Handles of Java arrays.** `VMRuntime.addressOf` of an array that is not a direct buffer's (`TypedArray.mData`, `PathIterator`) is a `javaValues` host native answering `handle(array)` of the Java array itself; `deref` (android/handles.ts) gives a native the host form of such a handle (`handleViews`, a copy in a Bridge scope) and every non-raw native with a `long` parameter runs in a scope that stores the copy back on return (`jni.test.ts`, last test). A copy already made by an enclosing call that was passed the same array is the one `deref` returns.
**Open.** (1) A JNI native that waits (a callback that blocks, a nested JNI call that returns a Promise) is reported by the plain import and re-imported as Suspending (`wasmNativeSuspended`); entering it needs strands in `entry.ts` (C3). (3) `cpuFor(curThread)` is the JS tier's thread: a Wasm strand has no Cpu of its own yet. (4) `FindClass` ignores the calling library's loader (one namespace). (5) JNI `MonitorEnter` of a contended lock cannot wait.

### 4.15 C3: the framework on the Wasm tier (2026-10-04, `knlnks/wasm-tc3`)

**Entry.** Host code that enters Java (`vcall`, `scall`, `newObj`, `linkInit`, `callOn`, `after`) runs on a new strand of the thread that owns the turn (`callOn`'s thread, else the thread of the strand whose native is running, else main), with the
strand it entered from as `parent` (`monitor.ts owns`: same thread, so locks held are shared). The module of the call (`World.callFn`) records how it ended in globals and takes a token, so a call that never waited answers its value at once and a
call that did answers a Promise: the JS tier's contract, which the 759 `vcall` sites rely on. `sched.onThread` keeps `curThread` the JThread of the running strand (a resumed strand says so with `Sync.Resume`). `Looper.loop` is the main strand suspended in
`nativePollOnce` (a Suspending host native); `mainDbg.depth` is unchanged.
**Natives that answer a Promise.** Every native without arrays is a plain import; if it answers a Promise, its wrapper hands the Promise to `sched.pending`, sets the `rt.wait` global, and the call site (`Natives.call`) then calls a
Suspending `settle:*` import and takes the settled value in its place. This replaced classifying natives (the survey cannot tell `return transact(...)`): only natives with arrays still need to be known (`MAY_SUSPEND`, `webdroid/` services, the build's
`waiting.json`), because their views are scratch memory; a parked scope keeps its scratch (the call site and `Bridge.end` lower the top only if nothing is above it).
**Boot.** `bootWasmTier` opens the tab's build and platform Program (`openAot`, `platformProgram`) and makes a World over `new Program([], platform)`; the app's dexes join as they arrive and `opts.dexes` serves class loaders. Outside a page (the harnesses)
it keeps the old path.
**Results.** `WEBDROID_TIER=wasm`: Calculator M and FitNotes reach `Activity.onCreate`, `onStart`, `onResume` in a process frame and draw (the EventLog order matches the JS tier); the microG processes start. `lat` FitNotes: gate passes
(max tap 47 ms cold, 42 ms warm), launch to first frame 7.9 s against 1.8 s on the JS tier (G3 fails on launch time; warm is not faster because bootWasmTier is not yet wired to `prepareApp`). Mihon: scenario times out. Calculator M: the gated taps need `uiTree`,
which fails (below). The JS tier's quick gate is 7/7; Wasm: `fitnotes` ran its 39 steps with 11 failures, `doodlejump` wedged in `Application.onCreate`.
**First failing mechanisms (open).** (1) Compose's `uiTree` (Calculator M): a `ViewGroup` made with no attributes reads a layoutAnimation resource id from its TypedArray (`AssetManager.nativeApplyStyle` fills `mData` through `deref` of an `addressOf` handle; a stale or
shifted result). (2) `RuntimeError: illegal cast` in `Double.doubleValue` under an `$invoke` stub (reflection/MethodHandle boxing; FitNotes tab-graph). (3) `Runtime.link` guards left in JS-tier-only code: `rt.classFor` for `Notification$CallStyle`
(`fixNotification`), the toast layout `transient_notification` ("Error inflating class <unknown>"). (4) `RamLogger.Append`: "move-result without invoke at 58" (a compiler gap on app code, Doodle Jump). (5) `AttributionSource should be unparceled during a binder transaction`
for a receiver of a microG process (binder calling identity from a strand). (6) JNI natives that wait (4 `jni.test.ts` tests skip), a Cpu per strand, contended MonitorEnter from JNI, FindClass by the calling loader (B3's list) are not done. (7) The page's
`heapUsed` is tab-wide, so `heapLimit` is 2 GiB there. Mihon's timeout is not diagnosed.
**Fixed on the way** (all generic): suspending natives lost their array results when they completed without waiting (`give` ran only after a wait); `Bridge.invoke` scopes outliving the natives they reached handed a native the copy of an array an earlier one reached;
`put` wrote array results at an unaligned scratch address; a process frame read a page file whose lazy source answers the page realm's Promise (`instanceof Promise` in `fdReadAt`); `Rect` edge names were cached by `constructor`, which every facade shares;
`handles.ts` could not key a Wasm array; `pm.ts` cloned an ApplicationInfo as a JS object; `jcoll.ts` built ArrayLists as JS objects; the JS compile worker ran under `tier=wasm`; `VMRuntime.addressOf` took its receiver as the array.

### 4.15 V1: the conformance suites, fwtest and the descriptor check on the Wasm tier (2026-10-04, `knlnks/wasm-v1`)

**Commands.** `bun run wasm conform <suite|quick> [class-substring] [--test name] [--no-js] [--jobs n]`, `bun run wasm fwtest`, `bun run wasm desccheck`; `all` has `conform-quick` (one class of each of guava, ojluni-time,
luni-util, jsr166 and luni-io, 15 s) and `desccheck`; the full suites and `fwtest` are not in it (the suites take 25 minutes together).
**How.** `scripts/wasm/conform.ts` runs each class of a suite (the lists and the dex of `scripts/conform/prepare.ts`, which `run.ts` shares) in a process of its own on each tier: the Wasm one is `conformone.ts` under
node (a World over the suite's dex and the boot jars, `ConformRunner` entered with `entryAsync`, so JUnit and its threads run on strands), the JS one is `scripts/conform/run.ts --one`. Per suite it reports the
Wasm pass count beside the JS tier's and the baseline's, a **regression** (a baseline pass that does not pass on the Wasm tier and is not failing on the JS tier too), and a **divergence** (a test the two tiers answer
differently). A divergence is *pinned* in `tests/conformance/wasm-pins.json` (class regex, test regex, an optional regex on the reason the Wasm tier did not pass it, and the mechanism) or the run fails it as
*unexplained*; a pin that matches nothing is stale and fails too (flaky ones excepted). Classes get 600 s, then are killed. `fwtest` runs the exercises of `scripts/fwtest/*` (the same files as the JS tier's `bun run fwtest`, made
tier-neutral where they touched the JS object model) over a World with the same cuts; `tests/conformance/wasm-fwtest.json` pins the exercises that fail and why. `desccheck` holds the registered descriptors to the
checked-in baseline and every intrinsic's key (class, name, descriptor) to a method the platform class declares (it found seven `sun.misc.Unsafe` aliases that matched nothing).
**Fixes** (each found as the first failing mechanism of a suite, generic, no suite-specific code):
- `Thread.getContextClassLoader` was null on the main thread (testng's `Logger`, every `getResourceAsStream` through it): ART gives the main thread the system class loader (`sched.ts` `curThread`).
- `Method.invoke` unboxed arguments with the parameter's own wrapper (an `Integer` for a `long` parameter was an illegal cast), checked neither the argument count, the receiver nor a reference argument's type: `argp` widens as the
  language does, and the checks throw ART's `IllegalArgumentException`s (`iarg`, `iarity`, `recv`; `reflect.ts`, `exc.ts`).
- `Constructor.newInstanceFromSerialization` was a gap, so nothing deserialized through `ObjectInputStream`: allocate without a constructor, run the first non-serializable superclass's (`reflect.ts`).
- `sun.misc.Unsafe`'s accessors reached the production spec with a Wasm object (a `TypeError`): the intrinsics of `jdk.internal.misc.Unsafe` now also name `sun/misc/Unsafe`'s `Object` and `compareAndSwap` forms (`unsafe.ts`).
- A Suspending native that answered a value (not a Promise) never wrote its array arguments back: `MessageDigest` answered zeros, so every default `serialVersionUID` was 0 (`natives.ts`).
- An array passed to a native twice (`Matrix.mapPoints(src, dst)` with one array) was copied twice and the stale copy written back last: the second parameter shares the first's region (`natives.ts`).
- A throw out of a Suspending native left the strand's globals as the strand that ran meanwhile set them (`sid` the host's), so the next natives took the plain path and failed with "native suspended" and
  "blocking operation on a stack that cannot suspend": the call restores them in a `try_table` handler (`natives.ts`, `code.ts`).
- A Promise a plain import abandoned could reject later and end the process: it is caught (`natives.ts`). A JS error escaping a native is the throwable the JS tier makes of it (`rt.jx`: NullPointerException for a `TypeError`
  on null, OutOfMemoryError for a typed array too long), not a crash of the strand (`nativesource.ts`).
- `new String(StringBuffer)` and `(StringBuilder)` went to the JS tier's string builder (`.s` of a Wasm object); they call the final classes' `toString` (`strings.ts`). `System.setIn/setOut/setErr` stored into the JS tier's statics
  (`intrinsics.ts`). `ObjectStreamClass.hasStaticInitializer` asked the JS class model (`classes.ts`). `Unsafe.allocateInstance(String.class)` built a struct with four of the five fields (`j2w.ts`).
- The heap limit: `heapUsed` counts garbage the engine has not swept and handles only a finalizer frees, so a test that allocates a lot hit the 512 MB limit while its live data was small. A full heap now collects (where the host can: `collect`,
  node's `--expose-gc`), then gives the event loop two turns of the *timer* queue (a message-channel turn runs the engine's finalizers after the strand resumes, not before) before it is an `OutOfMemoryError` (`j2w.ts` `allocSlow`, `sched.ts`
  `Block.Yield` with a timer). The conformance children raise the limit to 3 GB: the runner's own 60 MB output is 120 MB of `char[]` here (Latin-1 on ART).
- `Thread.getState` of a thread that `join` had just woken answered RUNNABLE: the `alive` flag was cleared one microtask after the peer (`sched.ts`; JSR-166's `PhaserTest` and `RecursiveActionTest`).
- `android_getaddrinfo` of a name the relay must look up was a gap: the strand waits for the answer (`Block.Net`, `host/inet.ts` `wait`) and asks again (`link/inet.ts`).
- `jnet.ts` `headerMap` made its `HashMap` with `rt.make`, an object of the JS tier: it asks the entry (`newObj`), as for the JS tier it only skipped a constructor (cookies: 14 tests on both tiers).
- `graphics.ts` cached a Rect's field names by `r.constructor`, which every facade shares (`Object`): by class name.
- The list of natives that answer a Promise for some arguments (`suspend.ts` `MAY_SUSPEND`, the survey's flag C) grew by the 19 the suites reached (Linux `readBytes`, `preadBytes`, `poll`, `connect`, `recvfromBytes`, `getpwuid`, `FileDescriptor.sync`,
  `FileChannelImpl.map0`, `Memory.peekIntNative`, `AndroidCharacter.*`, `BitmapFactory.nativeDecodeByteArray`, ...): a plain import that answers a Promise on a strand still fails that call once and is Suspending in modules built
  after, so the list is what makes the first call work. The suites print the natives found (`CONFORM_DEBUG=1`).
- Harness: node's `process.exit` after a `stdout.write` cut a class's output at the pipe's 512 KiB (the first Wasm counts of the big classes were short by that), `nodeshim.mjs` gives `fetch` of `file:` URLs and `Bun.file().text/bytes`.
**Results** (`bun run wasm conform <suite>`, node 24, tests that ran on the Wasm tier; the JS tier's pass count is its run today, the baseline is `tests/conformance/<suite>.json`; a pinned divergence is a test the tiers answer
differently with its mechanism recorded; 0 regressions and 0 unexplained in every suite; the full set takes about 25 minutes with four classes at a time on each tier):

| suite | tests | Wasm pass | JS pass | baseline | pinned divergences |
|---|---|---|---|---|---|
| `guava` | 368,794 | 368,772 | 366,001 | 365,994 | 2,771 |
| `ojluni-time` | 24,479 | 24,473 | 30,598 | 30,603 | 6,125 |
| `jsr166` | 3,211 | 3,209 | 3,136 | 3,135 | 73 |
| `luni-util` | 2,586 | 2,347 | 2,325 | 2,320 | 22 |
| `luni-io` | 1,373 | 1,247 | 1,418 | 1,417 | 185 |
| `luni-nio` | 2,747 | 2,650 | 2,712 | 2,712 | 62 |
| `luni-nio-file` | 195 | 182 | 173 | 173 | 9 |
| `luni-net` | 892 | 813 | 812 | 798 | 1 |
| `luni-security` | 721 | 715 | 715 | 715 | 0 |
| total | 404,792 | 404,403 | 407,891 | 407,867 | 9,248 |

JSR-166 runs on strands (C1 and C2) and passes 3,209 of 3,211 (the two it fails fail on the JS tier too), 73 more than the JS tier's cooperative threads. The ojluni-time pass count is lower than the JS tier's for the two reasons below
(about 6,100 data-provider rows skipped, about 950 behind the nested-entry limit); the other suites' counts agree to within the pinned tests.
**Pinned divergences by mechanism** (the pin file has the details and the evidence of each):
- *The JS tier is wrong, the Wasm tier answers as AOSP's bytecode does* (about 3,000 tests): `toArray(T[])` without `ArrayStoreException` (ArrayDeque, LinkedList, the queues, the guava collections: 2,753 in guava alone); `replaceAll` on a
  `ConcurrentSkipListMap` submap (400); `CompletableFuture`'s asynchronous stages (`NoSuchMethodError` for `Thread.nextThreadNum`, 39); a Throwable's message or cause lost across serialization, and its golden stream (`nio.file` exceptions, `IOError`, `ZipError`,
  `InputMismatchException`, ...); a `String` made with `new String(s)` that is `s` (IdentityHashMap, TreeMap, `writeUnshared`) and `Integer` against `String` without `ClassCastException`; `Class.getMethod` finding a private `suite()`
  (124 tests of `OutputStreamTesterTest` and `WriterTesterTest` that JUnit does not run on AOSP); `values()` of an enum, a null thread name, a deserialized interface proxy, one NullPointerException of the JS tier's compiled code.
- *The Wasm tier runs AOSP's bytecode and the test cannot*: TestNG reads a data provider's `Iterator<Object[]>` type argument, which libcore leaves a `GenericArrayTypeImpl` (as on a device), so 6,100 rows of `TCKLocalTime`,
  `TCKLocalDateTime` and `TCKDateTimeFormatters` are skipped.
- *Owned by another package*: a TS native calls Java through a plain entry and the Java waits (ICU: `CaseMapperNative`, `String.toLowerCase`'s locale, `HttpURLConnection`; `SuspendError`, about 1,000 tests of `ojluni-time`, `CalendarTest`,
  `CurrencyTest`, `LocaleTest`, `StreamTokenizerTest`, `CertificateFactory3Test`): entries on strands, C3. Natives that read a direct buffer through the pinned array's address (`unmapped address 0x4000...`, 60 tests of `luni-nio`, `luni-nio-file`,
  CRC32 and Adler32): B3. A flaky pair (`TestClock_System`) fails on either tier in some runs.
When C3 or B3 lands these pins go stale and the run says so; delete them then.
**fwtest.** All 31 exercises pass over a World after merging B2, B3 and C3 (the pins for pinned-array addresses, host classes and nested entries were deleted); `tests/conformance/wasm-fwtest.json` is empty. Remaining pins in `wasm-pins.json`: the JS tier's own faults, TestNG data providers (libcore's `GenericArrayTypeImpl` is never resolved to a Class, which ART's bytecode does too, so about 6,100 rows are skipped on the Wasm tier), the flaky `TestClock_System`, and `FileTest`/`CharsetTest`, where repeated entries accumulate JSPI stacks until a `StackOverflowError` (upstream repro: `File.list()` about 1,000 times inside one entry, also on eeb222b3).
main looper running (C3), and four implement a Java interface with a host object or construct a host class with an argument (`ImageDecoder`, `SpannableStringBuilder`, `InputProbe`, the `DexFile` spec: B2). Declared natives with a host binding: 646 of 791, the
JS tier's own count. The exercises need host code that waits (a font file, a decode), so the harness enters Java on strands (`scripts/wasm/strandentry.ts`, outside natives only; Track C3's entry replaces it).
**Open.** The pinned divergences above; `desccheck` and `conform-quick` are in `all`, the full suites (25 minutes) and `fwtest` are not.

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

### G2 result for `fwtest` and the conformance suites (V1, 2026-10-04)

Nine conformance suites (404,112 tests on the Wasm tier) against their baselines and the JS tier: 0 regressions, 0 unexplained differences, 9,248 differences pinned with their mechanisms (about 3,000 where the JS tier is wrong, 6,100
where TestNG's data providers meet libcore's `GenericArrayTypeImpl`, about 1,000 behind C3's entries on strands, 60 behind B3's pinned-array addresses). `fwtest`: all 31 exercises pass, none pinned (B3, B2, C3), native coverage 646 of 791 as on the JS tier.
Details and the fixes it took: 4.15. The per-method differentials on framework.jar and the apps are 4.4b's (`sweep`, `libdiff`).

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
- Move the prototype's shared pieces into a real module location behind a flag (done in P0: `src/wasm`, `?tier=wasm`); keep `research/wasm/` as history.
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
  match their baselines in Wasm mode. *Status (V1, 4.15): the nine suites run on the Wasm tier with 0 regressions against their baselines and 0 unexplained differences from the JS tier (9,248 pinned, each with its mechanism);
  `desccheck` is clean; `fwtest` passes all 31 exercises; the pins attributed to B2, B3 and C3 were deleted after the merge.*

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
