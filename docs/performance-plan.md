# Performance plan: latency and frame rate from first principles

Branch `knlnks/bytecode-claude-performance`, started from `knlnks/bytecode` at `30915b39`.
This plan ranks the work that would most improve in-app latency (tap → presented frame)
and frame pacing for arbitrary APKs. It applies the [bytecode-first plan](bytecode-first-plan.md)
§4 and [decision 0003](decisions/0003-performance-boundaries.md) to measurements taken on
this branch, and records what this branch already changed.

**Measurement conditions.** M4 Pro host, headless Chrome 151, SwiftShader GL, `bun run lat`
and `scripts/perf-browser.ts`. Other checkouts were idle. Every number is a single run or a
pair of runs unless stated. Treat 10–30 ms differences in gated taps as noise.

## 1. Where the time goes

Everything an app does runs on the page's one JS thread: every Java thread of every process,
guest native threads, compilation, persistence, display-list replay, composition and the
browser's own work. A device spreads that work over 8 cores. The cost model follows from that:

| Cost | Evidence | Share |
|---|---|---|
| The app's own Java work in hot JS, at the emitted code's per-operation cost | On Mihon's warm theme taps (100–140 ms), 76–88 ms is hot entry-form Java, spread flat over Compose, coroutines and androidx.collection. A trivial `<init>` is 172 bytes of bytecode, so V8's inlining budget runs out about five constructors deep. | Dominant on warm heavy taps |
| Cold code: cold-tier interpretation, JS emission, `new Function` compilation, class linking and init | Mihon's warm taps still run 2.4–3.3k cold calls. Cold tier plus compile and link took 19–27 ms of the agent's samples, and 50–60 ms of one 158 ms sample. Launches run 120k–215k cold calls and spend 0.4–0.9 s compiling and 0.2–0.4 s in clinit. | Dominant on first taps of a screen and on launch |
| Suspension machinery | 1,000–1,300 frame saves (`dfr`) per Mihon tap, 9–12 main-thread fuel yields, and 5–12 ms compiling resumable bodies on first suspension | 10–20% of a heavy tap |
| Background threads sharing the thread | Under tracing, a theme tap is 100 ms of back-to-back `MessageChannel` thread turns. Firebase DataTransport ran a 107 ms cold stretch during a 4×-throttled scroll. | Main source of hitches |
| Frame production (record, replay, composite) | 0.25–0.37 ms of `drawMs` per frame while scrolling FitNotes and Mihon; 478–561 replayed ops per frame | Small |
| Text (measure, shape, draw) | Under 1% of every profiled window | Not a lever |
| Guest↔host crossings | 38 ns per call | Not a lever |

Steady-state scrolling already presents at the host's rate: Mihon's settings list presents at
p50 9.4 ms, unthrottled and at 4× throttle. What users notice is the tail: p90 17 ms and p99
75–200 ms at 4× throttle, where single tasks run for 100 ms. Every gated tap is under 150 ms.
The worst gated taps, Mihon's warm theme switches (92–158 ms), combine all three of the top costs.

Idle apps use about 2% of the thread (260–350 ms per 15 s), so idle polling is not a priority.

## 2. Done on this branch

| Commit | Change | Measured effect |
|---|---|---|
| `fb29e91c` | Persisted code builds Blobs from parts and encodes them in idle slices | The save's long task (~245 ms at 4× throttle, mid-scroll) becomes ~150 ms spread over idle periods |
| `76343eea` | RuntimeShader's WebGL surface is created at display size | Calculator ripple taps: drawMs 981 → 197 ms per 15 s; worst present interval 207–333 → 73 ms |
| `0ab7fe1a` | Arrays hash, print and compare by identity; `new String(StringBuilder)` reads the text | Correctness: every array hashed to 1 (one HashMap bin) and `a.equals(a)` was false |
| `c2385b03` | `Arrays.fill` is a §4.7 intrinsic, differentially tested | 8–28× on Compose ScatterMap/ScatterSet clears (micro) |
| `1a500de2` | A JNI call enters the guest without awaiting when the base frame is free | 0.70 → 0.60 µs per call at depth 0; one suspension of the Java stack per call instead of two |
| `8cc660bc` | `Thread.yield` uses the yield channel | Removes the 4 ms nested-`setTimeout` clamp per yield |
| `6da45056` | `Object.clone` of bytecode objects goes through the constructor | Clones keep the original's hidden class (V8 probe 28.8 → 17.7 ns) |
| `032c41c5` | Main-thread back-edge yields resume ahead of other threads; the 8 ms gap counts from the turn's start | Mihon warm theme taps, 4 alternating pairs: dark 112 → 100 ms, light 97 → 89 ms |
| `24509694` | Class-init and resolution caches test for a Promise only on a miss | jbench: smallAlloc −12%, mix −4%, treeMap −4% |
| `cfc4458a` | A long shift by a constant count compiles to a BigInt literal shift | V8 can lower it to int64. The JVM agent measured −65% on a long-math kernel and −22% on pack/unpack; java.time conformance unchanged |
| `8b12db19` | `jbench` passes `--js-base-64` to Node 24 | The tool failed on every workload |
| `0c3e17b5`…`80548932` | Dead code and duplicate helpers removed (orphaned bidi tables, 16 counters nothing wrote, handle/socket leftovers, hex/base64/UTF-8/modified-UTF-8/`be32` duplicates) | −342/+108 lines |

Gates on the tip:
- typecheck, and `bun run test` (1137 pass).
- FitNotes smoke: 0 method failures, and the same 199 missing references as the base.
- `bun run e2e`: 7/7.
- `bun run lat` passes cold and warm. In the last cold run, Mihon's warm theme taps took 91/85 ms;
  the base averaged 112/97 ms over 4 runs.
- `conform guava`: 0 regressions, with 7 more passes than its baseline.
- `conform ojluni-time` matches the base. Both trees show the same flaky `TestClock_System` and
  the same two classes that no longer run.

One experiment was rejected. Ending the main looper's turn while a composite is pending did not
shorten the composite lag (p90 ~11 ms on Mihon taps, before and after). The lag comes from work
inside the same message, not from the looper draining later messages. Item 2.4 keeps it as a
measurement item.

## 3. Ranked work

Each item lists its mechanism, its evidence, the expected gain and how to verify it.
"Fact" means measured or read in code; "hypothesis" means not yet measured in an app.

### Tier 1: largest expected effect on latency and hitches

**1.1 Remove cold code from the tap path (§4.4/§4.5 completion).**
- **Mechanism (fact):** a method runs 31 cold calls through pooled handlers before promotion,
  and each promotion emits JS and compiles it with `new Function` on the main thread. A screen's
  second tap still pays for methods that ran fewer than 32 times on the first.
- **Plan:**
  - Make the APK's persisted profile the promotion signal. A method called at all in an earlier
    launch is emitted hot by the compile worker at install or idle time, and installed before
    its first call.
  - Add per-tap "methods first reached" to `lat`'s breakdown, so the remaining cold work on each
    gated tap is named.
  - Compile the worker's hot bodies straight to Cache Storage scripts so V8's code cache covers
    them. This is the existing §4.1/§4.2 direction.
- **Earlier rejection:** persisting the promotion list was rejected because relaunch first draw
  stayed flat (dex-performance-architecture). This item targets taps, not first draw, and
  installs bodies the worker has already compiled, so it is a change of conditions as §4.4 notes.
- **Target:** zero cold calls on second taps, and under 500 on first taps after a warm launch.
- **Verify:** `bun run lat --warm`, cold-call counters per tap, and peak memory.

**1.2 Give background threads their own core where the platform allows it.**
- **Mechanism (fact):** all Java threads of a process share one JS realm, because they share
  objects. Process realms are same-origin iframes on the page's thread.
- **Hypothesis to measure:** for microG/GMS-backed apps, YouTube and TikTok, how much CPU per
  second do non-presented processes take during interaction? If it is significant, run each
  non-presented process realm in a dedicated Worker, with binder Parcels over `postMessage`.
  This is possible because broker IPC already carries serialized Parcels, not objects.
- **What blocks it:** realms reach the broker, fonts, file sources and the guest clock directly
  (history ~3275). The work is to enumerate those direct calls and give each a message or
  `SharedArrayBuffer` form.
- **Within a process,** parallelism needs a shared heap, which means Java objects in linear
  memory: a full VM rewrite that 0003 rejects. Instead, make background work yield well:
  - Item 2.1 below.
  - Scheduler priority: run the presented process's main-thread turns at `user-blocking`, and its
    other threads at `user-visible` or `background` while frames or input are active, through
    `scheduler.postTask`.
- **Verify:** p99 present interval at 4× throttle on Mihon and TikTok, plus `lat`.

**1.3 Split long tasks: a frame budget for every thread, not only the main looper.**
- **Done (`032c41c5`):** turn tracking lives in yield.ts, main-thread fuel yields resume through
  `wakeSoon`, and the dead `yieldGap` is gone.
- **Remaining mechanism (fact):** a background Java thread's slice is still bounded only by
  back-edge fuel (8 ms per turn), and native background threads by their instruction budget.
- **Plan:** have background threads yield when a vsync is due within 2 ms or input is pending
  (`navigator.scheduling.isInputPending` where available).
- **Verify:** the longest-task histogram from a CPU profile (the scratch tool `longtasks.ts`
  belongs in `scripts/lat/`), and p99 present interval.

**1.4 Make JNI calls synchronous end to end.**
- **Mechanism (fact):** `Cpu.call` → `enter` → `run` → `loop` are all `async`, so even after
  `1a500de2` every Java→native call returns a Promise. Every compiled Java frame above it
  saves itself and later resumes through its resumable body.
- **Plan:**
  - Run the first `runSlice` synchronously inside `enter`.
  - When it returns `SliceExit.Exit`, finish the frame without awaiting: the same `finally` work,
    and `resumeAs(caller)`.
  - Fall into the async loop only on Suspend, Signal or Budget.
- **Gain:** large for Flutter (`FlutterJNI` per vsync and per pointer), React Native, Unity and
  any app whose libraries are called per frame. It also cuts resumable-body compilation driven
  by these suspensions.
- **Risk:** thread ownership, signal pumping and nested-frame teardown ordering; `cpu.test.ts`
  and `jni.test.ts` cover these.
- **Verify:** `perf.asyncMethods` per frame on Lichess and a Unity title; `lat`.

**1.5 Make the emitted code smaller and cheaper per operation.**
- **Mechanism (fact):** in Compose's emitted source, post-call suspension checks are 19.4% of the
  text, function names 8.1% and the check-cast inline cache 7.3%. Those checks and the try/catch
  every frame keeps push hot methods past V8's 920-byte cumulative inlining budget.
- **Upper bounds (fact, jbench, unsafe variants):**
  - Removing every post-call check: chain −43%, mix −14%, ssbEdit −10%, treeMap −8%.
  - Removing try/catch from entry bodies without DEX tries: −4% to −7%, and exceptions
    propagate 52 ns cheaper per frame.
- **A textual swap does not work:** a `typeof`/`constructor` check helped one workload and
  regressed others by up to 24%.
- **Plan:**
  - A suspension protocol with no per-site test. Either unwind by exception or flag and save
    frames in the catch the frame already has, or use a shared "suspending" flag.
  - Classify natives first. Every native that can return a Promise must be known, so add a debug
    mode that runs both protocols and reports disagreements.
  - Drop entry-body try/catch once `jx` builds a NullPointerException's trace from the original
    `TypeError.stack`.
  - Smaller source also stretches the 24 MiB idle-install budget. Mihon exhausts it (25.2 MB)
    after its second tap and then compiles on the tap path (`bodyScript` 8–13 ms plus resumable
    bodies 5–12 ms). Budget by retained heap rather than source length.
- **Risk:** high. This is the JVM's core protocol. Gate on `conform`, the tier tests and `lat`.

**1.6 Constant-time type checks.**
- **Mechanism (fact):** instance-of and check-cast use a 2-entry site cache, then
  `R.iofc`/`R.ccc`/`iof`: a megamorphic `.constructor.$i` load and a `Set<string>` lookup
  (44 ns per cast in jbench). `kotlin/ResultKt.throwOnFailure` was the top self-time Java method
  on Mihon taps.
- **Plan:** set a marker property per implemented type on each prototype at link, GWT style
  (`v.$I$<type> === 1`). This took a plain-JS replica from 19 to 5 ns per check. Fall back to
  `iof` for primitives, arrays and forked class loaders.
- **Expected:** 2–4 ms per Mihon tap.

### Tier 2: frame pacing and per-frame cost

**2.1 Coalesce composition and duplicate draws.**
- **Mechanism (fact):** render-thread animators draw through `onNextVsync` before the main
  thread's `doFrame`. When both draw in one vsync, the tree replays twice and composites twice
  (Calculator: 291 draws for 126 main frames).
- **Plan:**
  - Skip the RT draw when the main thread's receiver is scheduled for that vsync.
  - Compose once per host frame.
- **Verify:** draws per presented frame, and `lat`.

**2.2 Remove synchronous GPU readbacks from frame paths.**
- **Mechanism (fact):** color-matrix and MODULATE layer filters run `getImageData`/`putImageData`
  per frame (`graphics.ts` `recolor`); so do non-normal blur mask filters and one-axis blur.
- **Plan:** run those passes as a shader over the layer on the existing WebGL2 context. Separately,
  GLES apps reach `gl.getError` after every non-`keepsClean` entry.
- **GL plan:**
  - Count GL syncs per kind (`perf.glSyncs`).
  - Extend `keepsClean` validation to draws, uniforms and state setters.
  - Shadow small element buffers so client-array indexed draws stop reading buffers back.
- **Verify:** Lichess and TikTok `getError` time; graphics fuzz differences unchanged.

**2.3 Damage-tracked redraw (plan §4.6).**
- **Mechanism (fact):** every frame resets and replays the whole root display list; buffer age is
  always 1. Gains are for small animations (spinners, ripples, the caret), not scrolling.
- **Prerequisite:** measure raster time on a hardware GPU first.

**2.4 Composite lag.**
- **Fact:** on Mihon taps, 5 of 16 composites start more than 2 ms after their `queueBuffer`
  (p90 ~11 ms). Ending the looper turn early did not help, so the delay is inside the drawing
  message.
- **Plan:** add a permanent `perf.presentLagMs` and find the code between `queueBuffer` and the
  end of that message.

**2.5 ARM JIT region entry and exit.**
- **Mechanism (fact):** ARM32 regions load and spill all 15 GPRs (`jit.zig` forces
  `used = written = 0x7fff`). A64 regions end at 4 KiB pages, so every BL/RET to another page
  spills and reloads.
- **Plan:** precise ARM32 register read/write sets (as A64's `rwOf`), then multi-page regions
  with per-page epochs.
- **Gain:** CPU-bound games (Cut the Rope, Among Us).
- **Verify:** `?jit=0` equality, `__wdJit` bisection, GL frames per second.

### Tier 3: allocation and per-op cost

These matter through GC (3% of busy time at 4× throttle) and through V8's inlining budget.

- **Packed longs (Compose).** Port the long-word fusions from `knlnks/bytecode-codex-performance`
  (`07da562b`, `267a2784`, `2a616449`): consumed shifts, masks and narrowings of BigInts compile
  to int32 word operations without allocating intermediate BigInts. 0003 measured packed
  Offset/Constraints at 5–8% of Mihon scrolling. Gate on `conform` and the JVM tier tests.
- **Identity hash.** `idHash` keeps a global WeakMap: 100–127 ns per first hash, 5–6 ns per
  lookup, and ephemeron work in every major GC. Compose hashes state objects per recorded read.
  Store the hash in the object's lazily added `$mon` slot (one hidden-class transition, already
  accepted for monitors).
- **Generator natives that usually finish synchronously.** `driven()` costs 15 ns per call against
  2 ns for a plain function. Fast-path `csChars` (`StringBuilder.append(CharSequence)`),
  `Field.get` and `Method.invoke` for String, builder and initialized-class cases.
- **Throwable capture.** Capture costs about 200 ns per captured frame at 64 frames. Count
  throws per gated tap first. If they matter, cap capture depth for throws the compiler cannot
  prove are discarded (a behaviour decision: fewer frames in `printStackTrace`).
- **Display-list recording.** Every op also executes on a 1×1 mirror context, including path
  construction and style sets. `getTransform()` allocates a `DOMMatrix` per translate, clip,
  restore and `quickReject`.
  - Keep a JS affine and a save stack in `NativeCanvas`, as SkCanvas does.
  - Make path ops record-only.
  - This removes the mirror's Proxy.
- **Binder.** An incoming transaction makes a fresh JThread, and each local call creates two
  parcels with Maps and copies them twice: about 25 allocations. Pool the `execTransact` pair and
  reuse an idle binder thread. Measured ≤0.5 ms per tap, so this is low priority.
- **Smaller JVM items (JVM report):**
  - Own-class static access in hot code still goes through `D.cl[k]??D.link` where `C` is in
    scope.
  - `const $ic` in a block pays a TDZ hole check on every access; pass it as a parameter.
  - `newMonitor` allocates its entrant and waiter lists eagerly.
  - The resumable form runs a tight loop 8× slower than the entry form, but costs only 1.6–4.6 ms
    per tap, so it is low priority.
- **StringBuilder over a rope.** `charAt` after `append` re-flattens: 50k interleaved operations
  cost 61 ms. Add a counter first; switch to a `Uint16Array` gap buffer only if apps hit it.

## 4. Zig/Wasm candidates

Wasm wins where contiguous numeric work dominates and crossings are few. The ARM core,
HarfBuzz and Skia already show this. Measured candidates:

| Candidate | Verdict | Why |
|---|---|---|
| ELF relocation (RELR/APS2) | **Yes**, or u32-pair TS | 600k RELR relocations: 21–30 ms with BigInt against 3 ms with u32 pairs; il2cpp and Flutter libraries |
| Bitmap lock/unlock pixel conversion (premultiply, 565/4444/F16) | **Yes** | A full-frame copy and convert per lock/unlock in `native/bitmap.ts`; contiguous; better still, keep locked pixels in guest memory |
| Layer color filters, blur and mask kernels | No | Remove the readback instead (§3, 2.2) |
| minikin line breaking, hyphenation, bidi | No | 7–25 µs per paragraph; crossings would add a marshalling boundary |
| SHA/AES, inflate, regex, charsets | No | WebCrypto, `DecompressionStream`, irregexp and TextDecoder already cover the hot cases |
| Display-list replay | No | 0.1–0.2 ms per frame ceiling; Canvas2D calls stay in JS |
| Java object code | No (0003) | Object dispatch and allocation; crossings would dominate |
| fdlibm | Maintainability only | Compiling the C would replace a 909-line hand port; StrictMath is not hot |

## 5. Measurement fixes needed first

- **Profile attribution:** V8 profiles attributed ~450 ms to `atLeast`'s width checks when the
  cost was one WebGL canvas resize. Use in-page timing to confirm before acting on self time in
  canvas code.
- **`perf.frameMs`** stays open across vsyncs that never draw, so Calculator reports about 100 ms
  "frames". Close the frame at the vsync that schedules no draw.
- **`perf.measureText`** counts only `paintAdvance`. Count every measurement native, or rename it.
- **Missing tools:** `lat` lacks a present-lag counter, a longest-task histogram and per-tap
  "first-reached methods". Put the scratch tools (`timeline.ts`, `wakes.ts`, `longtasks.ts`)
  under `scripts/lat/`.
- **Two disagreeing harnesses:** Playwright's headless shell and `--headless=new` CDP differed in
  where time showed up (tracing versus sampling). Use `lat`'s raw-CDP launch for timing.

## 6. Maintainability follow-ups (not done here)

- `CORE_LIBC` in `native/core.ts` repeats `libc.zig`'s `Fn` order by hand, and `TABLE_SIZE`
  duplicates `abi.zig`'s `JIT_SLOTS`. Export them from Zig or add a parity check.
- Bounds math exists in four forms: `deviceBounds`, `deviceRect`, `canvasLocalBounds` and inline
  corner math in `rendernode.ts`. Move one non-allocating helper into `matrix.ts`.
- Color strings are built in three places.
- Text helpers are duplicated: surrogate tests, `Math.fround` aliases, grapheme segmenters, and
  two control-character predicates.
- Shaping is cached for measurement but not layout (`shaping.ts` `layout()` against
  `measurePiece()`). Use one shaped-piece cache, as minikin's LayoutCache does.
- `skia.ts`'s emoji shear and `alpha ** 1.5` constants are fitted heuristics. Check their
  provenance against the AGENTS rule on invented substitutes.
- Two deflate libraries (fflate and pako). Keep pako, or use `DecompressionStream` on async paths.
- Low-value test candidates for the user to decide on: `tests/fuzz.test.ts` and
  `tests/e2e/types.test.ts` test harnesses, not the emulator; `tests/device-services.test.ts`
  could shrink to representatives.
