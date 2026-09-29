# Bytecode-first plan: run AOSP's Java, own the boundaries

This file defines webdroid's target architecture, the migration to it, the required
performance program, the verification program and the development process. Read it with
[AGENTS.md](../AGENTS.md) (working rules) and [PLAN.md](../PLAN.md) (current app status). Where
this file and older plans disagree about direction, this file wins; AGENTS.md rules still apply.
Where the work stands, and how to resume it, is in [§9](#9-progress-and-handoff).

## 0. Hard requirements

1. **Tap latency ≤ 150 ms.** Measured from the host input event that completes the gesture
   (`pointerup` for a tap, key up for a key) to the first presented browser frame showing the
   app's response, excluding time the app spends waiting on network I/O. It applies to every
   gated tap, including the first tap on a screen after launch or navigation. The measurement
   conditions are in §4.8. A change that pushes any gated tap above 150 ms is not complete.
   Every technique in §4 is required, not optional.
2. **Unchanged bytecode.** App and bundled library bytecode run unchanged (AGENTS.md).
3. **Software draw path and goldens.** Preserve the software draw path. Keep visual goldens
   unchanged unless reference updates are explicitly requested.
4. **One Android build everywhere.** API 35, the build in `vendor/aosp/build.txt`
   (`sdk_gphone64_arm64` `AE3A.240806.043`). This one build supplies:
   - the framework and boot jars, and framework-res;
   - ICU and tz data;
   - the advertised SDK level;
   - the fuzz oracle and the e2e goldens.

## 1. Why this direction

The development loop has been: get a new APK, find its missing APIs, implement them until
the app works, repeat. That loop does not end, because webdroid hand-writes Android's whole
Java userspace in TypeScript. Measured on 2026-09-27:

**The hand-written surface keeps growing and is driven by apps:**
- About 72k lines (4.2 MB) of TS across `src/android` and `src/jvm/natives`.
- 23,521 method-table entries across 2,195 classes. That covers 27% of public API-35 methods,
  and public API is only 28% of `framework.jar`.
- 1,870 of those entries are placeholders (`stubs()`/`noops()`) that return fabricated
  values and leave no telemetry.
- The unique method descriptors grew 4.8k → 9.4k across the recorded history with no
  flattening.
- 59% of commits touch the API layer. 23% add missing API and 27% fix behaviour of API that
  already existed.
- At least 75% of API additions were triggered by an app failure; at most 3% came from a tool.

**The hand-written code approximates AOSP rather than transcribing it:**
- `HashMap`, `LinkedHashMap`, `ConcurrentHashMap`, `WeakHashMap`, `IdentityHashMap`,
  `Hashtable`, `EnumMap` and `ArrayMap` share one JS-`Map` implementation
  (`src/jvm/natives/jutil.ts:1141`). All of them iterate in insertion order, and `WeakHashMap`
  is not weak.
- `ArrayList`, `LinkedList`, `Vector`, `Stack` and `ArrayDeque` share one class that declares
  both `Deque` and `RandomAccess` (`jutil.ts:692`).
- Line breaking is greedy splitting on spaces, where AOSP uses minikin.
- `ViewGroup` keeps a single touch target.

**Failure mechanisms mostly come from reimplementation, and they repeat:**
- About 70–80% of the ~165 failure mechanisms recorded in the implementation history deviate
  from a documented or reference contract. Checking against the contract finds them without
  any app.
- The same root causes were rediscovered across apps. The worst one: TS calls its own helper
  where AOSP calls an overridable method. It produced about 40 fix commits after it was first
  flagged.

**AOSP's own surface is closed and small at the native boundary:**
- Across `framework.jar` and the boot jars: 314,242 methods, 282,194 with bytecode bodies,
  5,381 native.
- Of the platform methods apps call directly, 84–86% have bytecode bodies and about 2% are
  native.
- A static upper bound of 1,300–1,900 natives is reachable per app.
- `View`, `ViewGroup`, `TextView`, `Resources` and `StaticLayout` declare zero natives.

**The compiler already handles AOSP bytecode:**
- `bun run smoke` compiles all 32,713 `framework.jar` classes (9.2 s) and all six boot jars
  (about 8,100 classes, about 2.7 s) with 0 method failures.

**The two measurements taken so far are positive:**
- **Graphics cut.** With Paint, Canvas, Matrix, Path, Typeface and Bitmap served from
  `framework.jar`, FitNotes scored 43.33% vs 43.07% and rendered 39/39 steps. Existing
  delegates cover 295 of those classes' 363 natives.
- **`java.time` cut.** Served headless from `core-oj.jar`, it passed 6 of 8 probes after adding
  one native (`VM.getNanoTimeAdjustment`). The two remaining failures were not `java.time`
  logic:
  - partial TS specs (`ULocale`, `Locale`, a `MissingResourceException` constructor) hid the
    complete AOSP classes;
  - the ICU data file was absent.

**The existing tools detect absence, not wrongness:**
- The API fuzzer covers 63 methods, about 0.14% of the API.
- E2E content difference on a passing FitNotes flow ranges 7–67% per step, and the tree diff
  sits at 100%.
- `audit` has about 40% false positives.
- The one tool that works cheaply is `scripts/simd-oracle.ts`. It records real-hardware
  answers once into a checked-in fixture and replays them in `bun test`. It found 37 bugs on
  its first run.

## 2. Target architecture

```text
App DEX (unchanged)
  └─► AOSP Java bytecode: framework.jar, every BOOTCLASSPATH jar of the reference build
      (core-oj, core-libart, core-icu4j, okhttp, bouncycastle, apache-xml, conscrypt,
       framework-connectivity, framework-mediaprovider, framework-statsd, framework-sdkextensions,
       framework-permission-s, framework-adservices, ...)
        ├─► JNI natives ............ TS / wasm (graphics, text, POSIX, input, surfaces, resources)
        ├─► Binder / AIDL .......... system services implemented in TS (IActivityManager,
        │                            IWindowSession, IPackageManager, ...)
        └─► VM built-ins ........... TS (String, Object, Class, Thread, Throwable, reflection,
                                     java.lang.invoke, Unsafe, VMRuntime)
Browser: Canvas2D / WebGL, OPFS / IndexedDB, CORS proxy + TCP relay, workers
```

**Rules:**
- **Bytecode by default.** Invert `src/jvm/provenance.ts`: every class comes from AOSP
  bytecode unless it is on the TS allowlist. The allowlist contains only:
  - VM built-ins;
  - boundary implementations;
  - intrinsics that meet §4.7.
- **The three boundaries are enumerable.** Each has a generated inventory (declared, reached
  by the corpus, implemented, placeholder) and a status report. "Done" for a boundary area
  means every reached entry is implemented and verified.
- **The fix for a missing API** is the native, service method or VM built-in that AOSP's body
  needs. It is not a TS reimplementation of the Java method.
- **No fabricated success.**
  - A boundary entry that cannot be supported throws or returns the error AOSP documents for
    an unsupported capability.
  - It never returns an invented value.
  - Persistent state keeps its canonical owners (AGENTS.md).

## 3. Migration stages

Stages run in order. Each stage's acceptance includes:
- `bun run typecheck`, `bun run test`, `bun run smoke` with zero method failures on affected
  APKs, `bun run e2e`, and the latency gate (§4.8);
- conformance baselines (§5.1) for the affected packages, not below the previous baseline;
- `run.json` inspection per AGENTS.md.

Use `?bytecode=` / `WEBDROID_BYTECODE=` to A/B every flip against the same bundle.

### Stage A: foundations

1. **Implement `invoke-polymorphic` and `invoke-custom` in both tiers.** `invoke-polymorphic`
   currently falls through to `unsupported` at `src/jvm/compiler.ts:673`. core-oj has 425
   `invoke-polymorphic` sites (VarHandle and MethodHandle in `java.util.concurrent` and
   atomics). Cover them with `scripts/opscan.ts` and unit fixtures.
2. **Vendor the full boot classpath from the reference build.** Extend `scripts/gen-framework.ts`
   to pull:
   - every jar on the reference AVD's `BOOTCLASSPATH`;
   - `/system/etc/preloaded-classes`;
   - the ICU data file (`/apex/com.android.i18n/etc/icu/icudt*.dat`);
   - tzdata (`/apex/com.android.tzdata/etc/tz/tzdata`).

   Record provenance in `vendor/aosp/build.txt`. Keep gen-framework's resource-id pairing
   check.
3. **Load the AOSP jars as the fallback class path, always.**
   - A class with no TS spec resolves to AOSP's class.
   - Auto-stubbing applies only when no jar defines the class.
   - App dex stays ahead of platform dex for app-owned classes, as today.
4. **Method-level fallthrough.** When a TS spec lacks a method and AOSP has a body, run AOSP's
   body, provided every field it reads or writes on the receiver's class chain exists on the
   TS object. Otherwise record `unsafe-fallthrough <method> <fields>` in `rt.missing`. This
   removes the "partial TS class hides a complete AOSP class" failure seen in the
   `java.time` cut.
5. **Missing field reads throw.** A missing-field read on a TS-spec object throws in dev and
   test builds and is recorded. It no longer reads `undefined` silently (`src/jvm/runtime.ts`
   field lookup).
6. **Advertise SDK 35.** Change `src/shell/config.ts` from `sdk: 33`, and move the fuzz oracle
   setup (`scripts/fuzz/setup-oracle.sh`, README) to API 35.
7. **Use only the paired resource table.** Framework code uses the paired
   `vendor/aosp/framework-res.apk`. The relinked `vendor/framework-res.apk` has only 53.5% of
   internal ids right.
8. **Build the performance infrastructure (§4) before any flip that puts platform bytecode on
   a tap path:**
   - the build-time AOT pipeline;
   - code delivery through the service worker;
   - the boot image;
   - install-time compilation of app code;
   - the latency gate.

### Stage B: libcore on bytecode

Flip in this order, measuring each flip:

1. `java/time/`, `java/text/`.
2. ICU: `android/icu/`, `com/android/icu/`, `libcore/icu/`, `java/util/Locale`.
3. XML: `javax/xml/`, `org/w3c/`, `org/xml/`, `org/apache/`.
4. `java/util/` collections and utilities. Guava testlib gates this flip (§5.1).
5. `java/util/concurrent/`, which needs Stage A.1.
6. Regex: `java/util/regex/` over `com/android/icu/util/regex/PatternNative` and
   `MatcherNative`. Implement those natives on the existing engine in
   `src/jvm/natives/jregex.ts`.
7. `java/io/`, `java/nio/`, `java/net/`, `java/util/zip/`, `javax/net/`, `java/security/`,
   `javax/crypto/` and conscrypt, over these natives:
   - `libcore/io/Linux` (134 declared): map them onto `src/shell/vfs.ts`, the relay
     (`src/shell/relay.ts`) and the proxy;
   - NIO and zip natives;
   - conscrypt's native boundary.

**Stays in TS:** `java/lang/String`, `Object`, `Class`, `Thread`, `Throwable`,
`java/lang/reflect/*`, `java/lang/invoke/*`, the `Unsafe` classes, `dalvik/system/VMRuntime`
and the other ART-internal natives. Everything else becomes bytecode, and a TS intrinsic
stays only if it meets §4.7.

**Acceptance:** libcore, jtreg subset, Guava testlib and JSR-166 pass counts for each flipped
package are at or above the TS baseline, and `perf-browser` shows no regression.

### Stage C: resources, graphics and text on bytecode

1. **Resources.** `android/content/res/` over the AssetManager, XmlBlock, StringBlock and
   ApkAssets natives.
2. **Graphics.** `android/graphics/` over the existing delegates in `src/android/delegates.ts`:
   - complete every native reached by the corpus (`bun run fwtest`, `bun run fwscan`);
   - include Bitmap, BitmapFactory, ImageDecoder, Shader, ColorFilter and PathEffect.
3. **Text.** `android/text/` and `android/graphics/text/` over the minikin boundary:
   LineBreaker, MeasuredText, TextRunShaper, Font and FontFamily (66 natives, reached by every
   app sampled).
   - Implement them with HarfBuzz shaping and ICU line breaking compiled to wasm, or with the
     shared Canvas2D metrics behind the same natives.
   - Results must match `bun run textcmp` and the text goldens.
4. **Rendering.** Force the software path. RenderNode and RecordingCanvas natives record
   display lists that replay on the existing Canvas2D renderer. `HardwareRenderer` stays
   disabled.

**Acceptance:** 100% of reached natives implemented for the flipped prefixes, graphics fuzz
differences not increased, `textcmp` passing, and e2e goldens.

### Stage D: view stack, windows, input and system services

1. **Flip one self-contained group together:**
   - `android/view/`, `android/widget/`, `android/animation/`, `android/transition/`;
   - `android/app/` (ActivityThread, Activity, Instrumentation, ContextImpl, LoadedApk);
   - `android/content/` (framework side);
   - `android/os/` (Handler, Looper, MessageQueue);
   - `com/android/internal/policy/` (PhoneWindow, DecorView).
2. **Implement these natives:**
   - **`MessageQueue`** (6): `nativePollOnce` becomes a suspension on the process main queue,
     integrated with the browser event loop; `nativeWake` resumes it.
   - **`DisplayEventReceiver`:** vsync from the host-display pacing that already exists.
   - **`InputChannel` / `InputEventReceiver`:** browser pointer and key events become
     `MotionEvent` and `KeyEvent` through AOSP's input stage chain.
   - **`Surface` / `SurfaceControl`:** `lockCanvas`/`unlockCanvasAndPost` onto the page canvas.
     `ViewRootImpl` draws through `drawSoftware`.
3. **Implement system services as AIDL servers in TS** behind Binder transactions, using the
   existing Parcel broker (`src/android/binder.ts`, `src/android/parcel.ts`).
   - Generate the inventory from `framework.jar`'s `Stub.Proxy` classes intersected with
     corpus reachability. About 180 interfaces and 784 methods are reached from
     `ActivityThread`.
   - The shell modules become the service implementations and keep canonical ownership of
     their state: `src/shell/activities.ts`, `activitytasks.ts`, `packages.ts`, `alarms.ts`,
     `accounts.ts`, `pendingintents.ts`, `processes.ts`, `systembars.ts`, `device.ts`.
4. **Re-home TS references to TS view objects.** `bun run audit <apk> --framework --cut
   <prefixes>` lists them; FitNotes has 4,659 for view, widget and graphics. Shell code
   reaches views through Java calls, or AOSP APIs such as the accessibility node tree, and
   never through TS fields.

**Acceptance:**
- every e2e flow and corpus APK reaches at least its previous depth;
- the lifecycle and boundary trace differential (§5.3) is clean on the gated flows;
- the latency gate passes.

### Stage E: native userspace

1. **Controlled comparison of HLE libc against the device's bionic.** Today's HLE libc lives
   in `src/native/libc.ts`, `stdio.ts`, `pthread.ts` and `net.ts`. The alternative is to run
   the reference build's bionic (`libc.so`, `libm.so`, `libdl.so`, `libc++.so`, `libz.so`,
   `liblog.so`) as guest code over a Linux syscall layer, keeping host intrinsics for
   `memcpy`, `memmove`, `memset` and the `str*` family.
   - Compare on Cut the Rope, Among Us, TikTok, YouTube and Genshin.
   - Measure `nativeRequired`, faults, frame rate and tap latency.
   - Adopt the variant that wins on correctness without breaking §0.1.
2. **Where a real implementation beats a TS one behind JNI,** use AOSP native libraries
   compiled to wasm (HarfBuzz, minikin, Skia via the existing `canvaskit-wasm` dependency).
3. **HLE stays for:** GPU (EGL/GLES to WebGL), audio, media codecs and DRM.

### Stage F: remove superseded TS

- Delete TS specs for every flipped package once its acceptance holds (AGENTS.md: remove
  abandoned code).
- Hand-written size in `src/android` and `src/jvm/natives` falls with each flip.
- Report that size as a metric (§7).

## 4. Performance program (required)

**Invariant:** on a tap path, none of the following may happen unless app semantics force it:
- interpreting, or compiling;
- decoding DEX, or parsing resources;
- running a class initializer for the first time;
- fetching code or data over the network.

On a launch with persisted code and profile, gated taps spend 0 ms in compilation, DEX
decoding, resource-table parsing and code fetching.

**Current state** (driver measurements on a loaded host, up → first change; not gate
conditions):

| App | Action | Latency |
|---|---|---|
| Tubi | Explore | 150–650 ms |
| Tubi | Skip | 440–700 ms |
| Snapseed | First Tune open | 198–342 ms |
| McDonald's | First open | 241–510 ms |
| Yelp | Skip | 446 ms |

The measured cause is cold interpretation plus compilation: Tubi spends 116–199 ms
interpreting and 47–93 ms compiling after a tap.

### 4.1 Build-time AOT compilation of platform code

- **Compile at build time.** `scripts/build-prod.ts` and the dev server compile `framework.jar`
  and every boot and Mainline jar to JS: the fast body and the resumable body of every method.
  Suspension on a tap path must not trigger a compile.
- **Emit real script or module files, not `new Function` strings.** V8's persistent code cache
  never covers `new Function`/`eval`, and every compiled body today installs through
  `new Function` (`src/jvm/compiler.ts:55`, `:136`; `src/jvm/cold.ts:43`).
  - Name files by content hash.
  - Group them by package, and by co-use from profiles.
- **Precompute link metadata** so the runtime never decodes platform DEX:
  - class hierarchy, vtables and itables;
  - mangled names;
  - field layouts and constructor field initialisers;
  - constant-typing results.

### 4.2 Code delivery and caching

- **Serve all compiled code through a service worker** and store it in Cache Storage. Extend
  the existing `webview-worker.js`, or add a dedicated worker. Chrome produces code cache for
  scripts the service worker stores, so repeat loads skip parsing and compilation.
- **Load before the first frame:** the boot image (§4.3) and every chunk the launch profile
  names.
- **After the first frame,** prefetch the remaining platform chunks into Cache Storage from a
  worker, in priority order from the corpus census (§6).
- **A tap never waits on a code fetch.** If a needed chunk is absent, the latency report names
  it and the prefetch order is fixed.

### 4.3 Boot image (preinitialized platform state)

- **Preinitialize classes at build time.** Run static initializers for the classes in the
  reference build's `preloaded-classes` whose initialization does not depend on device, app or
  time state, and emit the resulting static state as generated JS, the equivalent of ART's
  boot image.
  - Classes whose `<clinit>` reads device or app state are listed, and initialize at runtime.
- **Pre-parse `framework-res.apk` at build time** into load-ready binary tables:
  - the `resources.arsc` tables;
  - resolved attribute sets for the default themes (`Theme.DeviceDefault` and `Theme.Material`,
    light and dark, at the shipped densities);
  - framework layouts inflated at startup.
- **Precompute font data:** font tables and shared text-metric data for the bundled fonts.

### 4.4 Install-time compilation of app code

- **Compile in a worker when an APK is opened.** Its DEX compiles to JS keyed by APK hash and
  is persisted to Cache Storage and OPFS behind the service worker. Launches after the first
  run app code from cached scripts, with no compilation.
- **Use the APK's own baseline profile** (`assets/dexopt/baseline.prof` and `.profm`; present in
  Mihon, TikTok, NewPipe, Thunderbird and AntennaPod) to order compilation and preload:
  startup classes first, then hot methods.
- **Record a per-APK runtime profile:**
  - hot methods;
  - tap-handler closures;
  - initialized classes;
  - chunks used.

  Merge it into the persisted compile set and preload list. This is a change of conditions
  from the rejected experiment in `docs/dex-performance-architecture.md`, which persisted only
  the promotion list and still compiled at launch; measure it under this pipeline.
- **On a first launch before compilation completes,** the worker compiles ahead of the main
  thread in profile order. Methods in the profile go straight to the fast body, skipping the cold
  tier.

### 4.5 Anticipation

- **Idle-time preparation.** When a process's main queue is idle, enumerate on-screen views
  that are clickable, long-clickable or focusable, together with their handlers:
  `OnClickListener`, `onTouchEvent` overrides, Compose pointer-input lambdas, and
  `ItemTouchHelper`/`RecyclerView` item handlers. Then:
  - compile and link each handler's static call closure (RTA from the handler method);
  - initialize the classes in that closure whose initialization has no side effects outside
    the class (platform classes proven safe at build time; app classes only when the compiler
    proves `<clinit>` is side-effect-free).

  Java class-initialization order is observable, so never run other initializers early.
- **Pointer-down preparation.** On `pointerdown`, hit-test to the target view and prepare its
  handler closure before `pointerup`.
- **Warm likely next screens.** For activities and fragments reachable from visible handlers,
  prefetch and compile their code and parse their layouts and resources in idle time, with no
  Java-observable effects.

### 4.6 Execution cost on the main thread

- **Profiled methods run the hot tier from their first call.** The cold tier only serves
  methods with no profile.
- **Input preempts queued work.** Input events preempt queued main jobs, and background
  realms, compilation and prefetch run in workers or yield to input.
- **Throwables.** Measure throw cost on gated taps.
  - Stack capture stays raw and is symbolized on demand. `captureStack` in
    `src/jvm/natives/jlang.ts` creates a 64-frame JS `Error` per throwable.
  - Where throws appear in tap breakdowns, omit capture for throwables the compiler proves
    are caught without their trace being read.
- **Stable object shapes.** Generated constructors initialize every field in declaration
  order, and no properties are added after construction.
- **Frame work** (measure, layout, draw, display-list replay and present) fits the host
  display frame. Only dirty regions redraw, and there is no synchronous GPU readback on the
  presentation path.
- **Measured TS intrinsics (§4.7) cover `long`-heavy hot paths** where BigInt dominates, such
  as `Random` and `java.time` arithmetic.

### 4.7 TS intrinsics

A TS implementation of a Java method outside the boundaries is allowed only when both hold:
1. it is a VM built-in, or it measurably reduces a gated tap or frame time;
2. it is differentially tested in-process against the AOSP body it replaces: same inputs give
   the same results, exceptions and side effects, over generated inputs and the conformance
   suites. `bun run textcmp` is the model.

**Candidates:**
- `StringBuilder` and `String` operations;
- `System.arraycopy` and `Arrays.*`;
- `Math` and `StrictMath`;
- boxed-primitive parsing and formatting;
- `Character` classification;
- charset codecs;
- `HashMap` and `ArrayList` core operations, if measurement justifies them.

Every intrinsic is listed in the provenance allowlist along with its measurement.

### 4.8 Latency gate

- **Bring the harness into the repo.** Move `webdroid-shots/new/lat/raw.ts` (a raw-CDP
  harness; Playwright's `Runtime.enable` makes each Java exception about 5× dearer) and its
  scenarios into the repo, for example as `scripts/lat/`, with a command in `package.json`.
- **Scenarios** cover, for each app:
  - the first and warm tap on each gated screen;
  - Back;
  - tab switches;
  - list item opens.

  Apps: FitNotes, Calculator M, Mihon, Harmonic, Snapseed, Tubi, Yelp, Walmart, McDonald's
  and the e2e apps. Run them with and without persisted code and profile.
- **Conditions:**
  - a dedicated runner with no competing load;
  - headless Chrome;
  - `--jobs 1`;
  - hardware GPU for GL apps;
  - no tracing;
  - fixed geometry and SDK 35.
- **Per-tap report:** total latency and a breakdown into input dispatch, interpretation,
  compilation, class initialization, resource parsing, code fetch, Java execution, layout,
  draw and present.
- **Gate:** every gated tap ≤ 150 ms. A failing tap blocks merge.
- **Reported alongside:** launch to first frame, and frame rate.

## 5. Verification program

### 5.1 Conformance suites, headless in Bun

- **Command.** Add `bun run conform <suite> [filter]`. It builds the suites to DEX with `d8`
  and runs them through a JUnit runner inside the runtime, with no browser.
- **Suites:**
  - libcore tests from the same AOSP build (`libcore/luni`, `libcore/ojluni` tests);
  - an OpenJDK jtreg subset for `java.util`, `java.time` and `java.text`;
  - Guava testlib's generated Collection and Map suites for every `java.util` collection;
  - the JSR-166 TCK;
  - CTS modules: Util, Text, Graphics, Widget, View, Content and Os. Run the subsets that need
    no Activity before Stage D, and everything through the real `Instrumentation` after it.
- **Baselines.** Check pass/fail results into the repo per test; a regression fails
  `bun run test`.
- **Run the suites against the current TS implementation first.** The failing tests are the
  backlog of known-wrong behaviour, enumerated without any app.

### 5.2 Recorded device fixtures

Generalize `scripts/simd-oracle.ts`: record API-35 reference answers once into checked-in
fixtures under `tests/fixtures/oracle/` and replay them in `bun test`.

- **Findings become fixtures.** Every fuzz, explorer or trace-differential finding is saved as
  a fixture, so findings do not vanish with worktrees.
- **API fuzz** records its oracle results as fixtures instead of `fuzz-results/`.
- **ARM32** gets an independent reference (AArch32-capable hardware or QEMU user mode),
  recorded like `src/native/fixtures/a64simd.bin.gz`. Today the JIT is checked only against
  the interpreter.

### 5.3 Boundary trace differential against the device

- **Trace both sides.** Record calls from app and library dex into the platform:
  - in webdroid at dispatch;
  - on the reference AVD through a JVMTI agent (`am attach-agent` on a debuggable build) or
    Frida.

  Each record holds the method, arguments, return value or exception, thread and Java stack.
- **Deterministic inputs:**
  - the same APK and scripted input;
  - `testClock=controlled`;
  - network recorded and replayed at the relay and HTTP proxy (the relay already terminates
    TLS);
  - fixed locale, time zone, geometry and SDK 35.
- **Normalize** identity hashes, addresses and timestamps. Compare per thread and allow
  reordering across threads.
- **Output:** the first divergence with its context. Add `bun run tracediff <apk> <flow>`.
- **Seed the fuzzers from these traces.** Argument distributions and receiver states from
  real apps replace hand-picked value pools.

### 5.4 UI structure comparison

- Compare view trees (class, bounds, text, visibility, enabled, checked, focused) against
  `uiautomator` dumps from the reference AVD, and gate on them.
- Fix tree-diff normalization first: it currently reports 100% on most FitNotes steps.
- Pixel difference remains a secondary report.

### 5.5 Telemetry for silent failures

- Record each placeholder hit with its caller, as `newPlaceholders` in `run.json`.
- Record caught Throwables with Java frames, as `caughtThrowables`, linked to the preceding
  missing-API, unsafe-fallthrough or placeholder event.
- Bring the out-of-repo tools into `scripts/` as supported tools:
  `webdroid-shots/new/drive.ts`, `tools/throws-hook.js`, `throws-read.js`,
  `trace-methods.js`, `profdiff` and the heap and CPU profile helpers.

### 5.6 Static checks in `bun run test`

- **Descriptor check.** Every registered TS descriptor outside `webdroid/*` must exist in the
  AOSP jars with the same name, parameters and return type.
- **Override-bypass lint.** When AOSP's body for a TS-specified method invokes a virtual or
  interface method on `this`, the TS body must dispatch virtually too.
- **Invented-value lint.** Values from `PackageManager`, `Build`, `Settings` and
  `SystemProperties` must come from device configuration or paired resources, never from
  literals.
- **`audit` false positives.** Remove them: compiler intrinsics such as `String.<init>`, and
  interface methods implemented by native subclasses.

## 6. Process

- **Continuous corpus.** On every merge to `main`, run a headless boot and scripted flows over
  `apks/` and an expanded corpus (the F-Droid index, plus Play apps the user supplies). Feed
  results into a failure-signature database. Each row is an APK hash × a signature:
  - missing API or native;
  - unsafe fallthrough;
  - placeholder hit;
  - exception type plus top frames;
  - native fault library plus offset;
  - latency violation.

  Cluster signatures across apps and rank them by the number of apps affected.
- **Census.** Static API, native and AIDL usage over the expanded corpus, weighted by app
  count, orders boundary work and chunk prefetch.
- **Assign work** by signature cluster, boundary area, service interface or conformance suite,
  not by app. Give each shared mechanism one owner.
- **CI:**
  - typecheck;
  - test, including conformance baselines, fixtures and static checks;
  - smoke;
  - quick e2e;
  - the latency gate on its dedicated runner.

  Parallel agent work never shares a host with the latency gate.
- **Record of behaviour.** Tests, fixtures and the signature database are the record of
  behaviour. `docs/implementation-history.md` keeps decisions, rejected experiments and
  measurements only. Strategic changes get a decision record under `docs/decisions/`; the
  earlier move away from this direction had none.
- **Broken links.** Fix the links in `PLAN.md` and `docs/implementation-history.md` that point
  to deleted docs: `corpus-plan-v1.md`, `corpus-plan-v2.md`, `docs/compatibility-corpus.md`,
  `docs/apk-coverage-2026-09-24.md` and `original-apk-coverage-2026-09-24.md`.

## 7. Metrics

- Maximum latency per gated tap: ≤ 150 ms, hard.
- Share of fixes originating from a suite, fixture, static check or trace differential rather
  than an app failure.
- Conformance pass counts per suite.
- Boundary completeness: natives reached vs implemented, and AIDL methods reached vs
  implemented.
- Corpus boot-clean and flow-completion rates, and signature counts.
- Hand-written TS size in `src/android` and `src/jvm/natives`.
- Time from a new APK to its first-divergence report.

## 8. Stop doing

- **Writing a TS reimplementation of a Java method** to fix a missing API. Implement the
  boundary entry AOSP's body needs, or rely on fallthrough.
- **Returning constants** to satisfy a query.
- **Hand-adding fuzz recipes** with hand-picked value pools.
- **Assigning one agent per app.**
- **Treating e2e content-difference percentages as a quality signal.**

## 9. Progress and handoff

Last updated 2026-09-28. The branch is `knlnks/bytecode` in `/Users/kunalan/Projects/webdroid`. Each
commit message states what it measured. The implementation history (the 2026-09-27 and
2026-09-28 Stage A/B entries) records failure mechanisms.

### Standing constraints from the user

- Nothing app-specific. Performance is the top priority. Keep commits focused, and add tests
  only for core behavior and comments only where essential.
- Never test with anything in `apks/new/`, Genshin, Clash Royale or Clash of Clans. For live
  flows use `--live --test harmonic,lichess,reddit,tiktok,youtube,chatgpt`.
- Downloads are pre-approved.

### Environment

- `JAVA_HOME=/opt/homebrew/opt/openjdk@21`. The Android SDK is at
  `/opt/homebrew/share/android-commandlinetools`, which `scripts/android-sdk.ts` finds.
- Reference AVD: `webdroid_api35_ref`. Boot it headless with
  `$SDK/emulator/emulator -avd webdroid_api35_ref -no-window -no-snapshot -no-boot-anim -no-audio`.
  `bun run gen-framework` needs it running. gen-framework pulls:
  - the boot jars, and records their device paths (`BOOT_JAR_PATHS`);
  - every file under `/apex/com.android.{i18n,tzdata}/etc` into `vendor/aosp/apex/`
    (`PLATFORM_DATA`);
  - the Monet colors;
  - the `OsConstants` values, by running `scripts/DumpOsConstants.java` under `app_process`,
    into `src/android/os-constants.ts`.
- Dev server: `PORT=4217 bun run server.ts` from this worktree. Restart it after changing
  `server.ts` or vendor files; a stale server once served 404s and made flows fail.
- Baseline worktree `/Users/kunalan/Projects/webdroid-base` is at the old commit 31c9f8d9. For an
  A/B at HEAD, use `git worktree add ../x HEAD`, symlink `vendor/{aosp,microg}` and `apks`, run
  `bun install`, then start the server on another port. Never `git stash -u` while a server
  runs from this tree.

### Gates

Run all of these before committing a flip:
- `bun run typecheck`;
- `bun run test` (1,376 pass);
- `WEBDROID_URL=http://localhost:4217 bun run e2e` twice (7/7);
- the live set above;
- `bun run conform guava|jsr166|ojluni-time`. Baselines are 38,088, 2,538 and 27,514; jsr166
  takes about 5 minutes and ojluni-time about 2.5;
- `bun run lat` cold and `--warm`;
- `bun run smoke apks/FitNotes.apk` (0 method failures).

To A/B a flip without deleting code, set `WEBDROID_BYTECODE=<prefixes>` for e2e and conform
(`--bytecode`), and `--query bytecode=<prefixes>` for lat.

Known flakes, which are not regressions:
- TikTok `swipe-again` wedges under parallel load and passes alone.
- YouTube `video-open` passes about 2 times in 5, with or without changes.
- Komikku's restore step rarely throws a DOM "file not found" error; it was not shown to be new.
- Komikku's step after "Get started" occasionally settles on pixels mid-transition, so the next tap
  misses (2 of 14 parallel runs after the logging flip, 0 of 24 before; step times match).
- Resy times out.
- `TCKInstant` has one test whose name embeds `Instant.now()`.
- Cold Mihon `light` in `lat` sits around 150 ms and fails the 150 ms gate about 2 times in 7;
  warm passes. See the latency section below.

### Done in Stage B

These classes now run from AOSP bytecode, with their TS code deleted:
- **java.time, java.text, ICU, java.util date classes, java.sql, android.text.format.** This
  covers `android/icu`, `com/android/icu`, `libcore/icu`, and java.util's TimeZone, Calendar,
  GregorianCalendar, Date and Currency. It removed about 4,400 lines. ojluni-time went from
  16,698 to 26,163 passes. The pieces it needed:
  - libcore's ICU4C natives answered by ICU4J (`src/jvm/natives/jicu.ts`);
  - `libcore.io.Linux` natives: the old `android.system.Os` TS bodies plus open and fstat, in
    `src/android/os.ts`; android.system.Os itself is now libcore's;
  - `libcore.io.Memory` and the i18n `Memory` natives (`jmemory.ts`);
  - OsConstants from the device;
  - boot-jar resources: jars mounted at their device paths, `rt.bootResources`, and
    `ClassLoader.findResource`;
  - the `/apex` ICU and tz files mounted in every realm (`src/shell/apex.ts`). The production
    worker serves byte ranges of split files;
  - `zygoteInit()` (`src/android/delegates.ts`, after `linkNatives`): RuntimeHooks' time-zone
    supplier reads `persist.sys.timezone`, which `device.timezone` (the host zone) answers, and
    java.util.logging is reset onto AndroidConfig's AndroidHandler, as RuntimeInit.commonInit does.
- **java.io.File (B.7 cut 2).** libcore's File over `java/io/UnixFileSystem` natives and Linux
  access/remove/rename (`src/android/os.ts`), with VFS modification times. TS reads a File with
  `pathOf` and makes one with `newFile` (`jio.ts`). The TS java.nio.file layer stays and answers
  `FileSystems.getDefault()` for `File.toPath`.
- **java.util.logging.** libcore's Logger/LogManager reach logcat through AndroidHandler. The flip
  needed `Reference.refersTo0`, `VMStack.getThreadStackTrace` (LogRecord.inferCaller) and the
  ResourceBundle loader/Control overloads, and removed the TS Permission specs, whose empty-name
  check Android's stubs lack.
- **java.util.Locale.** libcore's Locale starts from `user.locale` (`device.locale`). TS reads a
  Locale through its Java API (`localeTag`, `localeDirection`, `defaultLocale` in `jvalues.ts`);
  LocaleList keeps its Locales' tags for synchronous readers. The "3x suite time" was
  TestZoneTextPrinterParser's full workload, not a hang.
- **XML** (`javax/xml`, `org/w3c`, `org/xml`). DOM is libcore's KXmlParser and transforms are
  xalan. SAX is ExpatParser over new expat natives (`jexpat.ts`, an incremental tokenizer).
  The Apache HTTP classes stay TS: they are the optional `org.apache.http.legacy` library, not
  boot class path.
- **java.util.regex.** libcore's Pattern and Matcher run over PatternNative/MatcherNative,
  implemented on the JS RegExp translation (`jregex.ts`). `.`, `^` and `$` use ICU's line
  terminators and UNIX_LINES. hitEnd/requireEnd follow ICU's RegexMatcher, including flags
  kept across find() calls. They are computed only when read, by derived patterns that consume
  a sentinel appended to the input.
- **ThreadLocalRandom.** It needed Thread fields reached through Unsafe offsets, and `Random`
  implementing `RandomGenerator`.
- **java.util.concurrent synchronizers and queues (B.5).** Locks, AQS, LockSupport, the latches,
  barriers and semaphores, CompletableFuture, the skip-list collections, ConcurrentLinkedDeque and
  every blocking queue but LinkedBlockingQueue run from libcore over Unsafe park/unpark (`jsync.ts`).
  ConcurrentHashMap, the atomics, CopyOnWriteArrayList, ConcurrentLinkedQueue, the executors
  (`mkExecutor` serves `android/os.ts` and `intentservice.ts`), FutureTask, LinkedBlockingQueue
  and TimeUnit stay TS; the whole-package cut cost a 191 ms cold Mihon tap.

Fixes that apply to every mode:
- Fallthrough ordering. A platform body that cannot run on a TS class yields to the spec's
  interface default (`Runtime.interfaceDefault`). A spec whose JS class does not extend its
  declared superclass's inherits that superclass's methods first; the fix was Properties.put.
- Service callbacks name the main thread (`runningservices.ts`). This fixed Komikku's
  "handleLifecycleEvent must be called on the main thread", which failed 3 of 5 gates at HEAD
  before it.
- `NativeAllocationRegistry` frees through a `FinalizationRegistry`. Graphics handles previously
  leaked forever.
- Compiled bodies are named functions (`frameName`/`frameOf` in `abi.ts`), and persisted bodies
  drop their sourceURL. Warm starts had misattributed every persisted frame, which broke
  caller-sensitive APIs.
- Exception superclasses are fixed: AIOOBE/SIOOBE, NumberFormatException, SocketTimeoutException.
- Promotion compiles within a 4 ms per 50 ms budget, with the rest deferred to idle. Cold Mihon
  `light` improved from 0/6 to 5/7 under 150 ms.
- Properties has its defaults chain, with Hashtable as its superclass.
- Settings `get*ForUser`.

### Override-bypass lint (§5.6)

`bun run bypass` lists TS spec methods whose AOSP body calls an overridable method on `this`
that neither the TS method nor the module helpers it names reach, limited to methods a corpus
app overrides (`tests/fixtures/app-overrides.json`, rebuilt with `--corpus`). `bun run test`
fails on findings outside `tests/fixtures/bypass-baseline.json`. The backlog went from 786 to
302 on 2026-09-28. What remains is mostly deliberate: guards for features not modelled
(accessibility, fading edges, state save), per-line Layout hot paths, socket state checks the
lazy SSL handoff cannot pass, and dispatch the lint cannot see (a method name in a variable, a
precomputed mangled key). Rerun `--write-baseline` after fixes so the backlog shrinks.

### Next steps, in plan order

1. **B.7 io/nio/net**, in cuts. A read-only inventory (2026-09-28) found:
   - **Blockers.** `isBytecode` matches prefixes, so `java/io/File` also cuts FileInputStream and
     the rest; single classes need an exact-match form. About 60 TS sites read TS layout
     (`mkFile`/`.path`, `JFileDescriptor.fd`, about 20 TS subclasses of TS streams). The largest
     blocker is `JBuffer`: about 55 uses across GL, media, fonts and JNI read its DataView.
   - **Done:** cut 2 (File). **Skipped for now:** cut 1 (zip codecs): the TS Inflater encodes okio's
     getRemaining semantics, and AOSP's Inflater needs natives that report consumed input exactly,
     which fflate's push API does not expose; there is no line or speed gain to pay for that risk.
   - **Cut order.** (1) zip codecs (CRC32, Adler32, Inflater, Deflater and their streams; 26
     natives over fflate; ZipFile stays TS). (2) File (12 UnixFileSystem natives over `vfs`).
     (3) FileDescriptor and the file streams over Linux read/write/pread/pwrite (`stdio.ts` needs
     Uint8Array `java*` wrappers for write, pread, pwrite and truncate). (4) the rest of java/io,
     ObjectStreams last. (5) NIO channels, after deciding whether Buffers stay a TS boundary
     (§4.7), together with a lazily paged `mmap` (the ICU file). (6) java/nio/file, then ZipFile.
     (7) java.net value classes (URI blocks the cookie classes: AOSP's cookie store needs
     `URI.compareTo`). (8) sockets over `native/net.ts`.
   - **Stays TS as boundaries.** HttpURLConnection over the fetch proxy, TLS at the relay, asset
     streams (`streamOfSource`), and probably the Buffers and charset codecs.
   - Add an ojluni io/zip conformance suite before cut 3.
2. **B.4 collections.** Performance does not rule it out: 20,000 mixed String/Integer keys through
   HashMap put/get, ArrayList add/get and an entrySet walk took 12.3 ms from libcore against 11.3 ms
   in TS at steady state (Bun), and 29.9 against 15.4 ms on the first, cold run. The blocker is TS
   code built on the TS objects: `newArrayList` (83 sites in 28 files; a bytecode ArrayList needs
   class init and a constructor that can suspend), `toJsArray` (42, already Java-call based),
   `mkIter` (12) and about 130 direct `.a`/`.m` reads, mostly in jstream, jjson, worksource, sqlite
   and pm. Serialization comes with it: 25 TS specs carry `serialization:` metadata because AOSP's
   ObjectStreamClass would reflect over fields TS objects lack, so ObjectInput/OutputStream can
   only flip after the collections.
3. **§4 performance.**
   - **First launch.** Cold Mihon's first theme switch is about 90 ms of real recomposition plus
     cold-tier cost, and libcore's first-use code (the Locale flip's LanguageTag parse adds about
     20 ms to the cold `dark` tap). Platform bodies are about 14% of Mihon's persisted code today,
     so a build-time platform image (§4.1) pays more as the view stack moves to bytecode.
     Resumable-body compilation (about 11 ms) happens on suspension. Two experiments were
     rejected: starting leaf methods cold, and a 50 ms yield gap over layout (see the history).
   - **Persisted code.** Warm launches load 49 MB of emitted JS for Mihon (63 MB more for
     microG). Suspension checks are 23% of those bytes, and 60% of bodies are single-block
     methods that still carry the full dispatch loop, so a leaner emitter shrinks both import and
     compile time.
   - Keep org.json in TS as an intrinsic candidate: libcore's is 2.3x slower on a 237 KB
     document. That needs a differential test (§4.7).
4. **Memory.** An app that formats dates reads the whole 28 MB ICU file into the JS heap, because
   `FileChannel.map` copies it (`jio.ts`). A lazily paged mapping would match the device's mmap.
5. **Known limits.**
   - `SystemClock.currentGnssTimeClock` reads fail with an NPE (no location service hosted).
   - TS `eraseThreadLocals` does not clear the TS locals.
   - Regex: `\G` is unsupported, possessive quantifiers are greedy, `\b` uses JS's ASCII word
     set, DOTALL `.` does not take CRLF as one character, and anchoring bounds are ignored.
     hitEnd misses a backreference cut short by the end and ICU's reads at a lookbehind's
     limit. Patterns whose derived forms do not compile (atomic groups with captures or
     lookaheads) fall back to "the match reached the end".
   - The expat natives skip external entities.

### Tools and pitfalls learned

- Scratch probes: load platform jars with `loadPlatformJar(bytes, i)` and call
  `rt.linkNatives()` before use. The conform runner links all natives eagerly, but the browser
  links lazily, so a TS object created with `new` before its class links has no methods. Use
  `rt.make`, or link at module end, as jreflect does for Method, Constructor and Field.
- `CONFORM_DEBUG=<regex> bun scripts/conform/run.ts <suite> --one <class> [test]` prints the
  first matching throwable's trace.
- `rt.jx` maps JS errors to Java ones. When a trace is unhelpful, wrap `rt.jx` in a scratch
  script to see the original JS stack.
- `bun scripts/dis.ts <jar> <class> [method]` disassembles.
- Inventories: list the registrations by prefix from `rt.natives`, and wrap `rt.register` to
  record the registering file.
- `git commit` takes the whole index. Anything already `git rm`'d is included, so commit
  deletions with the change they belong to.

