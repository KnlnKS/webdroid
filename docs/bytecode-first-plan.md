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
  order, and no properties are added after construction, except an object's monitor (`$mon`),
  added on its first lock.
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

Last updated 2026-10-01. The branch is `knlnks/bytecode` in `/Users/kunalan/Projects/webdroid`
(not pushed); read "Latest handoff" first. The older handoffs below it are history: where they
list next steps for Stage B, this one supersedes them. Each commit message states what it
measured; the implementation history's 2026-09-30/2026-10-01 entries in "JVM, DEX and process
ownership" record each unit's findings.

### Latest handoff (2026-10-01): Stage B completion pass, start here

**Branches and machine state.** `knlnks/bytecode` and `main` are the only local branches; every
worktree this pass used is merged and removed (subagent commits were cherry-picked, so their
hashes differ from the agents' reports). One stash, `WIP on fuzz/api-audit`, predates this pass
and is not ours to drop. `../webdroid-gate` (a detached worktree used for A/B servers and conform
snapshots) was removed; recreate it with `git worktree add --detach ../webdroid-gate <commit>`
and symlink `vendor/aosp`, `vendor/microg`, `apks`, `conform-cache` and `node_modules` into it.
Run `bun install` after pulling (pako is a new dependency). A dev server may be on 4217.

**Stage B status.** At the start of this pass 277 TS specs implemented classes in libcore's
namespaces; 84 remain, and all but the items under "Left" are VM built-ins or declared boundaries.
Now from AOSP bytecode (each with its natives, intrinsics and tests):
- java.util's collections, Collections/Arrays/Objects, streams, Optional, Properties,
  ResourceBundle, ServiceLoader, BitSet, Timer, Base64 (and android.util's), UUID, StringJoiner,
  Random, Formatter, Scanner; java.io's ObjectStreams, BufferedReader, Externalizable;
  org.json; org.xmlpull through kXML (android.util.Xml included); android.util.ArrayMap,
  ContentValues, WorkSource, SearchRecentSuggestions, the android.database Observables and
  dalvik/android CloseGuard (these were TS copies built on the TS collections).
- java.util.concurrent entirely (atomics, executors, FutureTask, TimeUnit, CHM, COW, queues).
- java.net except the fetch-backed HttpURLConnection/okhttp handlers and TLS (SSLSocket and
  friends at the relay): addresses, sockets, datagrams, URLConnection's base.
- java.nio buffers, charsets (over NativeConverter/CharsetUtils natives), file channels;
  java.util.zip (over pako at the z_stream level) and ZipFile.
- java.math; java.security, javax.crypto, certificates and x500 over conscrypt's NativeCrypto
  natives and bouncycastle; AndroidKeyStore over a hosted keystore2 with a software KeyMint;
  network security config applied as handleBindApplication does.
- java.lang: exceptions, marker interfaces, annotations, StackTraceElement, the boxes, Number,
  Character (and UnicodeBlock/Script), Math, StrictMath (fdlibm port), Enum, ThreadLocal,
  ThreadGroup, UncaughtExceptionHandler; UNIXProcess fails exec as for a missing program.

Kept in TS on purpose: Object, Class, String, Thread, Throwable, ClassLoader, VMStack, VMRuntime,
java.lang.reflect/invoke, java.lang.ref, the Unsafes, dalvik's DexFile and class loaders,
NativeAllocationRegistry (VM built-ins); HttpURLConnection/okhttp handlers, javax.net.ssl and
conscrypt's SSLParametersImpl (TLS at the relay), javax.microedition.khronos (GL HLE)
(boundaries); StringBuilder and StringBuffer (§4.7: libcore's are 8-15x slower on appends; a
generated-operations test holds the TS ones to libcore's results).

**§4.7 intrinsics.** `rt.intrinsic(cls, { sig: (base) => fn })` (runtime.ts) installs a TS body
over a bytecode class's own fields in place of one method; `base` is the AOSP body, which the
intrinsic calls for every case it does not cover. Write them compiled with literal field names
(`compile` in jcoll.ts; a keyed load of a module binding stays megamorphic because the bundler
makes module consts mutable) and add a differential test to tests/intrinsics.test.ts (same
results, exceptions and receiver state as the AOSP body over generated inputs). They cover
ArrayList, its iterator, HashMap lookups, Arrays.copyOf, CHM bins, Random.next, the boxes, Math,
Enum, ThreadLocal, BigInteger, ByteBuffer and its views, and Matcher.usePattern.

**Gates on the final tree:** typecheck clean; `bun run test` 1,312 pass;
FitNotes smoke 0 method failures; fast e2e 7/7; conform (0 regressions; see Gates for the numbers).
Live flows were run by the security agent (harmonic, reddit, chatgpt, lichess, tiktok, resy,
youtube: no TLS/cleartext errors; Resy 2 and YouTube 1 timeouts, fewer than before) but not
after the java.lang flip. `bun run lat --warm` passes; **cold `bun run lat` fails on Mihon
`light`**: it is bimodal on this tree, 23-24 ms or 166-188 ms, failing 5 of 8 runs on a quiet host
(the previous handoff had it near 150 ms failing about 2 in 7). The interleaved A/B against
8c8796fb (before the java.lang commits) did not complete: that commit's server hung at startup in
the gate worktree. Earlier the same day, under agent load, the java.util flip's tree passed where
its parent failed twice (FitNotes' first tap 52-72 against 263-274 ms).

**Left for Stage B, in order:**
1. **Cold Mihon `light` latency.** A/B it against 8c8796fb (and a39d019c, before the security
   follow-up) under matching conditions (`bun run lat mihon`, interleaved, quiet host), then
   `bun run lat mihon --cpuprofile <file>` and `scripts/lat/profsum.ts <file> 40 until=<ms>` on a
   slow run. Suspects: first use of libcore's Formatter (40-90 ms cold in the harness), boxes or
   Math classes compiling on the tap, ZygoteInit.warmUpJcaProviders' classes, the class-constructor
   dictionary fix. The gate must pass before more flips land.
2. **System and Runtime from libcore** (unfinished; the java.lang agent was stopped mid-way and its
   uncommitted work discarded). Its approach: System's spec becomes `platformClinit` over libcore's
   class (its <clinit> builds the standard streams over descriptors 0-2; zygoteInit's
   redirectLogStreams stays), keep System's natives (arraycopy, time, identityHashCode, log,
   setIn0/Out0/Err0, properties through AndroidHardcodedSystemProperties and
   initUnchangeableSystemProperties: $JAVA_HOME unset, the default user agent from
   Build.VERSION.RELEASE/MODEL/ID, user.locale from persist.sys.locale); loadLibrary/load go
   through libcore's Runtime.nativeLoad with the calling class's loader (`dlopen` in jlang.ts takes
   a possibly async ABI chooser). Runtime's TS spec keeps only natives (maxMemory from HEAP_LIMIT,
   availableProcessors, nativeLoad, gc...).
3. **libcore/io/ClassPathURLStreamHandler** (jlang.ts): its TS constructor opens the JarFile
   unverified; ZipFile and ByteArrayInputStream are libcore's now, so libcore's constructor with
   JarVerifier can run. Check TikTok's v1-signed APK (2.2 MB MANIFEST.MF) for cost.
4. **Small remainders:** java.lang.reflect.Modifier (pure Java), the TS exception definitions
   InvocationTargetException/WrongMethodTypeException and the javax.net.ssl exceptions (defined
   with `defineException` in jlang.ts), the SSL interfaces in jnet.ts (HostnameVerifier,
   KeyManager, SSLSession, SSLContextSpi) where the TLS boundary does not need its own copy, and
   dalvik/annotation/Signature.
5. **The §2 allowlist.** Add to provenance.ts the libcore-namespace prefixes a TS spec may still
   implement, each tagged vm/boundary/intrinsic with its reason (the list above), and a test that
   fails when a registered spec in java/, javax/, jdk/, sun/, libcore/, dalvik/, org/json,
   org/xml, org/w3c, org/xmlpull, com/android/okhttp, com/android/org or android/icu is not on it
   (collect names by wrapping `rt.register` before importing src/natives.ts). org/apache/http is not
   boot class path and stays out of the check.
6. **Performance debts from the flips** (V8, `bun run jbench`, TS -> now): Scanner 2,000 ints 0.37
   -> 11 ms and its first use ~260 ms; ZipFile open+lookups ~2.5x; SHA-256 1 MB 0.61 -> 3.2 ms and
   ECDSA P-256 verify 78 -> 458 us (the TS copies used async WebCrypto; the JCA is synchronous);
   first certificate parse ~200 ms (class loading, per-byte PEM reads, throw capture); TreeMap
   0.26 -> 0.82 ms; org.json parse 2.0 -> 4.5 ms per 150 KB; String.format 0.83 -> 4.4 us;
   Double.toString 2.4x (FloatingDecimal, now device-exact); InetAddress.getByName of a cached host
   0.4 -> 7 us and every numeric-parse failure path (§4.6 throw cost: 64-frame capture per
   throwable). First use of libcore classes costs 10-50 ms per family cold; persisted code removes
   it on warm launches, a build-time platform image (§4.1) would remove it on first launches.
7. **Docs:** fold this handoff into "Done in Stage B" and delete the superseded Stage B items in
   "Next steps, in plan order" once 1-5 land, and refresh PLAN.md's first bullet.

**Known limits found this pass:** Java strings are JS strings, so `new String(s)` has no identity
of its own (IdentityHashMap2Test's equals case); a TS object created with `new` before its
bytecode superclass is compiled lacks inherited methods (use `rt.make`/`newObj`/`scall`); bun's
test runner spends tens of seconds formatting a failed expectation over a Java object (catch it and
print `rt.jx(e).msg`); multibyte legacy charsets are unsupported; keystore attestation answers
ATTESTATION_KEYS_NOT_PROVISIONED; CRL, HPKE, CMAC, scrypt and the TLS natives of conscrypt are not
implemented; sun.nio.ch socket channels are not implemented; loopback writes never block.

**How this pass worked (repeat it).** One coordinator plus parallel agents in `isolation:
"worktree"` worktrees, one package family each. Each agent read AGENTS.md, this plan and model
commits, reset its worktree onto `knlnks/bytecode`, symlinked the gitignored inputs (`vendor/aosp`,
`vendor/microg`, `apks`, `conform-cache`, `node_modules`; copied `vendor/sql.js/dist` and
`src/native/{core.wasm.ts,core.safe.wasm.ts,native-core.wasm}`), used its own server port, gated
each flip (typecheck, test, smoke, fast e2e, its conform suites) and never ran `lat` (the gate needs
a quiet host). The coordinator cherry-picked their commits, resolved conflicts (tests/intrinsics.test.ts
and the docs collide; keep both sides), re-gated, ran conform from a detached snapshot, and ran
`lat` only with agents idle. Rules the agents needed: never `pkill -f server.ts` or `bun test`
(it kills other worktrees' runs); `conform-cache` is shared, so never delete another suite's cache
(a suite whose test list changed needs its `conform-cache/<suite>` rebuilt once); never run `e2e
--live` without naming flows (it includes Genshin, which the user forbids).

### Previous handoff (2026-09-30, late night)

- **Branches.** `knlnks/bytecode` (working tree clean, not pushed) and `main` are the only local
  branches; the subagent worktrees this session used were merged by cherry-pick and removed.
  `../webdroid-gate` is still a detached worktree for A/B servers and conform. A dev server may be
  running on 4217 (`lsof -ti tcp:4217 | xargs kill` stops only it). The reference AVD
  `webdroid_api35_ref` may be booted (`adb devices`; `adb root` was used).
- **Gates on the final tree:** `npx tsc --noEmit -p tsconfig.json` clean; `bun run test` 1367
  pass (tests that only exercised TS copies of AOSP classes were removed); FitNotes smoke 0 method
  failures; fast e2e 7/7; live set 5/6 with TikTok's known main-loop wedge (alone it passed 5 of 7
  runs today, wedging at 05-09; compare against 1dbb93dd or earlier under matching load before
  treating it as a regression). Conform, `lat` and `textcmp` were not rerun this session: no
  libcore suite class and no text code changed, but the util/os/database flips (below) touch code
  apps run on taps, so run `bun run lat` and `lat --warm` first thing.
- **This session, in commit order** (details in the history entry and each commit):
  - D.3 services, each a TS subclass of its AIDL Stub hosted with `hostStub` (now in binder.ts) and
    AOSP's manager built in `AOSP_MANAGERS` (context.ts): battery (+ sticky BATTERY_CHANGED via
    `stickyBroadcasts` in broadcast.ts), appops (+ AttributionSource from bytecode), keyguard/trust
    (+ an empty INotificationManager Stub), usagestats, jobscheduler (JobService/JobServiceEngine/
    JobParameters/JobWorkItem from bytecode; job.ts is now IJobScheduler + IJobCallback), location
    (Location/LocationRequest/transports from bytecode; locationmanager.ts is ILocationManager),
    account (AccountManager, futures, AbstractAccountAuthenticator from bytecode; accounts.ts is
    IAccountManager with AMS-style authenticator sessions; the broker's authenticator protocol and
    authenticator.ts/accountfuture.ts/accountrequest.ts are gone), shortcut, locale,
    textservices, game (+ GameState), dropbox, restrictions, accessibility, auth/usb (+
    fingerprint built without a service).
  - Cross-cutting fixes the services exposed: `Parcel.obtain(IBinder)` (every generated Proxy
    calls it; remote AIDL calls were impossible before), `asSystem` in binder.ts (a hosted
    service's outgoing binder calls carry uid 1000, as @EnforcePermission checks expect),
    `ActivityThread.getSystemContext`, the `permission_enforcer` manager, `Binder(String)`,
    `Context.getMainThreadHandler`, `Log.println_native`, `bindAsSystem(..., action)`.
  - Pure framework classes whose TS copies had drifted now run from AOSP: UrlQuerySanitizer,
    JsonReader/JsonWriter, Pair/Range/Rational/Size/SizeF/LruCache/LogPrinter/FloatMath,
    AtomicFile/Base64OutputStream, ConditionVariable/CountDownTimer/ParcelUuid/StatFs/
    HandlerExecutor, PrintAttributes family/PrintJobInfo, BackupManager and helpers,
    Checksum/ApkChecksum/InstallSourceInfo/SessionParams, KeyGenParameterSpec/KeyProperties/
    NetworkSecurityPolicy (security.ts deleted), AudioAttributes/AudioFocusRequest (over the
    AVD's product strategies), CursorWrapper/SQLiteQueryBuilder/SQLiteOpenHelper/OpenParams/
    CharArrayBuffer/DataSetObserver. Platform fixes they needed: `String.format` %s prints a box's
    own toString; `FileDescriptor.sync` flushes the VFS; SQLiteDatabase gained openDatabase(File,
    OpenParams), createInMemory, deleteDatabase, reopenReadWrite, findEditTable, validateSql, and
    closes a helper's connection for real. LruCache from bytecode measured 4-13x faster than the TS
    copy headless.
- **Next, in order:**
  1. Verify tap latency (`bun run lat`, `--warm`) and rerun conform (`bun run conform guava`,
     `jsr166`, `ojluni-time`, ...) on this tree; then the TikTok A/B above if it keeps wedging.
  2. Continue the pure-class sweep. A scan of TS specs whose AOSP class has no natives (script
     idea: for each `rt.register({ name: "android/..." })`, look the class up in framework.jar with
     `scripts/lib.ts` `openDexes`, count native methods, and grep other TS for the class name) lists
     about 180 more. Left from this session's families: `UriMatcher`, `ContentUris`
     (net.ts), `SearchRecentSuggestions` (AOSP trims history with `cr.delete`; its test uses a
     fake resolver without delete), `UriPermission` (contentresolver.ts builds `JUriPermission`
     directly; re-home first), provider contract classes; media: `AudioFormat` (+ Builder; move
     `AudioTrack$Builder.build` onto Java getters), `PlaybackParams` (a fresh one's getSpeed throws
     on a device), `MediaMetadata`/`MediaDescription`/`PlaybackState` (+ builders), `QueueItem`,
     `RemoteUserInfo`, `AudioEffect$Descriptor`, `AudioTimestamp`, `EncoderProfiles`,
     `CryptoInfo$Pattern`, the empty callback bases. Leave view/widget/drawable/animation classes to
     Stage D, and keep measured hot paths (SparseArray, MeasureSpec, opengl Matrix) unless measured.
     Method that worked: headless probe before and after the deletion (`rt.linkNatives(); await
     loadLibcore(); await loadFrameworkJar();` from tests/java.ts, then newObj/vcall), every
     difference explained (nearly always the TS copy was wrong), tests of TS copies removed.
     Subagents in `isolation: "worktree"` worktrees start from `main`: tell them to reset onto
     `knlnks/bytecode` and to symlink `vendor/aosp`, `apks`, `node_modules` and copy
     `vendor/sql.js/dist` and `src/native/{core.wasm.ts,core.safe.wasm.ts,native-core.wasm}`; merge
     their commits by cherry-pick and delete their branches.
  3. D.3 remainder: wifi (framework-wifi.jar WifiManager over IWifiManager; ScanResult/WifiInfo/
     DhcpInfo/WifiLock in net.ts), nsd (jarjar'd connector classes and ConnectivityThread), and the
     device-model decisions: this device declares neither FEATURE_TELEPHONY nor
     FEATURE_DEVICE_ADMIN while framework-res is the AVD's (a voice-capable phone), so
     TelephonyManager and DevicePolicyManager from bytecode would answer from a mixed model; decide
     the features (and config_voice_capable) first. notification, display, input and window stay
     for Stage D.
  4. The older "Next, in plan order" list below (android.text's TextPaint/span model, text tap
     performance, B.7 cut 7 InetAddress/sockets, B.4 collections) still applies. Notes from this
     session: libcore Java has no socket or getaddrinfo natives yet (only `src/native/net.ts` for
     native code), so cut 7/8 is one large unit; persisted code for Mihon's first launch is 35.7 MB,
     19% of it suspension checks (`$t instanceof Promise){$r=N;break $d}`), and hot entries are
     already structured, so the plan's older "single-block bodies carry the dispatch loop" note is
     stale.
- **Tools this session:** `scratch-pageeval.ts` (repo root, excluded via `.git/info/exclude`;
  `APK=`, `INIT=` for an init script, `CONSOLE=1` for page errors) evaluates a JS body in a booted
  page against `WEBDROID_URL`. Device probes: javac from `/opt/homebrew/opt/openjdk@21`, d8 from
  `scripts/android-sdk.ts` `androidTool("d8")`, `adb push` then `CLASSPATH=... app_process / Main`
  (call `ActivityThread.systemMain()` first; `su 2000` for shell-uid answers). The AVD's
  services.jar (`adb pull /system/framework/services.jar`) disassembles with `scripts/dis.ts` and
  shows system-service failure paths.

### Handoff state (2026-09-30, night)

- **Branch `knlnks/bytecode`, working tree clean, not pushed** (the user asked for commits, not
  pushes). A dev server may be running on 4217 (`lsof -ti tcp:4217`); start one with
  `PORT=4217 bun run server.ts`. `/Users/kunalan/Projects/webdroid-gate` is a detached worktree (at
  6e60ef3e) for conform runs and A/B servers: `git -C ../webdroid-gate checkout --detach <commit>`,
  serve it with `PORT=4219 bun run server.ts` from there. Its `vendor/{aosp,microg}`, `apks` and
  `conform-cache` are symlinks. The reference AVD may still be booted (`adb devices`).
- **Last gates:** conform on 6e60ef3e at every baseline (TestTextParserWithLocale ran short under
  load and passes 21/21 alone). On the text commits (0284a2c9 to ce88626d): typecheck, `bun run test`,
  browser tests, FitNotes smoke, fast e2e 7/7, live set 6/6 (TikTok's 04-07 wedge under parallel load,
  then alone), `lat` cold twice and warm, textcmp 71/72 against the device. Conform was not rerun:
  the text commits touch no libcore suite's classes.
- **Done this session** (history: the two 2026-09-30 entries after the Typeface one):
  - The ChatGPT LifecycleRegistry regression: a destroyed service stays reachable until its
    context cleanup runs (343e6b8e).
  - Stage C.3's core: minikin's natives (`src/android/minikin.ts`: MeasuredText, the greedy and
    optimal LineBreakers, GraphemeBreak, Paint's text measurement) verified against the reference
    AVD (`bun run textcmp`, `--record` to refresh); Layout, StaticLayout, BoringLayout,
    DynamicLayout, TextUtils, LineBreakConfig, BidiFormatter, TextDirectionHeuristics and
    android.text.method now run from bytecode; the TS TextView lays out and draws through AOSP's
    StaticLayout, and links fire through LinkMovementMethod.
  - Stage D.3 started: system services hosted behind binder as TS subclasses of AOSP's generated
    Stubs (`src/android/services.ts`, `hostStub`/`hostedService` in binder.ts), with AOSP's
    managers from bytecode built as SystemServiceRegistry builds them (`AOSP_MANAGERS` in
    context.ts): activity and activity_task (ActivityManager, AppTask), audio (codec loudness
    only), window (animator scale, screen recording callbacks only), connectivity
    (ConnectivityManager, NetworkCallback over CALLBACK_* messages, NetworkUtils natives), power,
    thermalservice and deviceidle (PowerManager, WakeLock, PowerExemptionManager). Values come from
    probes of the reference AVD. A Stub method this process does not implement fails as "not a
    function" naming the AIDL method. Since then (history: "system services behind binder"):
    user, uimode, alarm, clipboard, vibrator, battery (with the sticky BATTERY_CHANGED), appops
    (with AttributionSource from bytecode), keyguard/trust, usagestats, jobscheduler (JobService
    and JobServiceEngine from bytecode), location and account (AbstractAccountAuthenticator from
    bytecode, sessions calling authenticators as system_server), shortcut, locale, textservices,
    game, dropbox, restrictions, accessibility, biometric/fingerprint/usb. Next: notification (the
    TS Notification stack, with Icon and RemoteViews, belongs to Stage D; the Stub is empty),
    device_policy and telephony (decide the device's FEATURE_DEVICE_ADMIN/FEATURE_TELEPHONY
    first), bluetooth/nfc (need `ActivityThread.initializeMainlineModules` and an absent-services
    set), wifi, nsd, display and input (Stage D);
    window and input_method stay with the TS view stack until Stage D's flip. Conform was not rerun
    for these commits (no libcore suite class changed).
- **Done 2026-09-30** (details in the history, latest entries of "JVM, DEX and process ownership"):
  - `android/content/res/` from AOSP (131efb48), and its cold-launch cost gone.
  - Platform overrides of Object's toString/equals/hashCode run on spec classes (a61f89c4).
  - Graphics (C.2) from AOSP, natives following Skia/hwui/minikin: Rect/RectF/Point/PointF/Insets
    keep only a layout; Color, ColorSpace, ColorMatrix, Matrix, the ColorFilters, Shaders,
    PorterDuff/BlendMode/Xfermode/TileMode, Path, PathMeasure, PathIterator, Region (a real SkRegion,
    `src/android/region.ts`), RegionIterator, Outline, NinePatch, Picture; Camera's and
    Interpolator's natives. Each has one TS bridge to its native state (`matrixOf`,
    `nativePathOf`, `colorFilterOf`, `ninePatchOf`, `clipToOutline`, ...), and fwtest exercises
    with values recorded on the reference AVD.
  - Text (C.3): the span classes, Annotation, LengthFilter, AllCaps (-578 lines); the fonts package;
    Typeface (system font map from `/system/etc/fonts.xml` and `font_fallback.xml`, written by
    `src/android/fonts.ts`); Character's properties from ICU through libcore's 24 `*Impl` natives.
  - Runtime: `platformClinit` (a spec class runs its platform `<clinit>`), `Class.getPrimitiveClass`,
    owned handles for classes that free native state in `finalize()` (`ownedHandle`,
    `Runtime.claimOnStore`), handle-slot reuse, lazy method stubs 70% smaller.
  - Boot and memory: the zygote phase (`startZygote` in `src/shell/device.ts`: framework-res, the
    platform indexed and linked, zygoteInit, the font map) starts with the page and overlaps the
    app's download, with the boot class path ahead of the app as PathClassLoader does; the link
    table is served (`scripts/link-table.ts`, `/link-table.json`, fingerprinted); a tab's realms
    share CanvasKit, the platform jars and framework-res (`src/shell/pageshared.ts`).
- **Next, in plan order:**
  1. The rest of android.text: TextPaint (the TS TextView and widget.ts construct `JTextPaint` and
     read its fields), then the span model (SpannableString, SpannedString, SpannableStringBuilder,
     Selection, the Editable behind EditText; `JSpanned.text/.spans` are read in textview.ts,
     textview-layout.ts's `mapChars`, ime.ts and `spannedString` callers). `bun run audit
     apks/FitNotes.apk --framework --cut android/text/` lists what is left.
  2. Text performance: Compose's text now runs AOSP's StaticLayout and Mihon's theme taps lost
     10-15 ms (warm light 75 -> 90 ms). Profile a warm Mihon `light` tap (`bun run lat mihon
     --warm --cpuprofile`) before optimizing; per-paragraph ICU boundary and advance caches exist.
  3. Stage C.2's remainder: Paint, Canvas and Bitmap (and Drawable), with Stage D (the view stack).
  4. Fidelity: serif/monospace and CJK faces are missing from the page (CJK layouts break 1 in 12
     test cases differently from the device); hyphenation needs the device's .hyb patterns.
- **Known limits (2026-09-30):** text hyphenation is unsupported (no patterns); glyph bounds are the
  advance box, so no run overhangs (useBoundsForWidth changes nothing); TextRunShaper and
  PositionedGlyphs are unimplemented; grapheme breaks use the browser's UAX #29 segmenter with
  minikin's tailorings around it. Font.getGlyphBounds throws and nGetBufferAddress is missing (the
  browser shapes text, so glyph ids are not addressable); variable-font axes do nothing (the page's
  Roboto files are static); Picture streams (createFromStream/writeToStream) are unimplemented;
  RuntimeShader.nativeUpdateShader (child shaders) is missing; Canvas2D gradients only clamp (tile
  modes REPEAT/MIRROR/DECAL ignored); perspective matrices apply only their affine part;
  `Paint.nGetFillPath` returns the source path; any finalize() other than a handle release does not
  run.
- **Measured and not built (see the history):** a platform code image pays little today (667 of
  5,112 bodies in a cold Calculator launch are platform code); precompiling a first launch from RTA
  reachability needs 8,000 methods for 78% recall; the native core's 256 MiB wasm memory per realm
  adds no steady-state GC. TikTok (5 realms) holds a 2.1-3.8 GB JS heap and spends ~30% of its main
  thread in GC; its wedges follow host load.
- **Lessons from this session's parallel agents** (put these in every agent prompt):
  - Stop only your own server (`lsof -ti tcp:<port> | xargs kill`); `pkill -f server.ts` kills every
    worktree's server.
  - Before `ln -s .../vendor/aosp vendor/aosp` in a worktree, check the target does not exist: into
    an existing symlinked directory it creates a nested link inside the real vendor directory
    (`vendor/aosp/aosp` is such a stale link from 2026-09-27, harmless).
  - `git commit -am` sweeps local diagnostics in: 28fd6e26 committed an e2e probe patch that traced
    every main-queue job (removed in 19534e7c); e2e timings between them are inflated.
  - Agents on different graphics classes conflict only in `delegates.ts` imports and
    `scripts/fwtest.ts`; merges resolved by taking both sides.
- **Open follow-ups.**
  - TikTok reaches `ActivityThread.installProvider` by reflection (unsafe fallthrough).
  - No system service is hosted behind binder (`binderServices` in `src/android/binder.ts` is empty),
    so Shizuku's `ServiceManager.getService("activity")` reports a gap in every Mihon and Komikku run;
    audio, window, activity_task, connectivity, webviewupdate and media_projection are missing
    (Stage D.3).
  - Resumable bodies keep the dispatch loop (only hot entries are structured).
  - The ObjectStreams stay TS until B.4. Byte-at-a-time calls into libcore's synchronized streams are
    1.8x-4.4x slower than the TS bodies were (monitor plus per-call cost). libcore's
    DeflaterOutputStreamTest times out: the TS executor's worker never reports `isAlive() == false`,
    which PipedInputStream waits for.
  - The TS TreeMap's `keySet()` seems not to be a SortedSet: guava's Maps suite fails to initialise
    (unconfirmed). TS HashSet iterates in insertion order (Charset alias sets differ from the device).
  - V8 does not inline small compiled non-leaf methods (§4 "Link metadata", "Throw cost" and the
    history's "where the per-call cost lies"); this blocks B.4 and will matter more in Stage C/D.
- **Process notes.**
  - Run conform from a worktree at a committed snapshot (`git worktree add --detach ../webdroid-gate
    HEAD`, symlink `vendor/{aosp,microg}`, `apks` and `conform-cache`, `bun install`): its runner
    spawns a process per class that imports `src/`, so edits during a run contaminate it. The first
    run in a new worktree builds sql.js; don't start two suites at once there.
  - Parallel agents' suites load the host; TikTok wedges and YouTube's video flake get more frequent.
    Rerun a failing live flow alone before judging it, and run `lat` on a quiet host.
  - Measure performance in V8, not Bun (JSC disagrees, e.g. a loop 52% slower in Bun, unchanged in
    V8): bundle a harness with `bun build --target=node` and run it under `node`. It needs a
    `setInterval` keep-alive (the yield channel is unref'd), and `--cpu-prof` needs an absolute
    `--cpu-prof-dir` and a process that is not ended with `process.exit`.
  - Headless scripts must run `zygoteInit()` (`src/android/delegates.ts`) after `rt.linkNatives()` to
    see `System.out`: since cut 4 it writes descriptor 1, which only zygoteInit routes to logcat.
    Anything reaching ICU (Character, text) needs the apex data mounted first, as
    `scripts/conform/run.ts` does with `mountPlatformData`; anything reaching Typeface needs the
    system fonts and a DOMParser (`loadSystemFonts` in `tests/java.ts`).
  - Browser memory: a heap snapshot through CDP (`HeapProfiler.takeHeapSnapshot`, streamed to a file)
    aggregated by node type and retainer path is what found the per-realm CanvasKit, jar and
    framework-res copies; `performance.memory.usedJSHeapSize` omits wasm memory.
  - Launch timing: `bun run lat <app> --cpuprofile <file>` and `scripts/lat/profsum.ts <file> 40
    until=<ms>`; bucket the profile by 100 ms to see idle waits (how the zygote phase was found).
  - Device evidence: compile a probe with javac + d8, `adb push` it, run it with
    `CLASSPATH=/data/local/tmp/x.dex app_process / Main`, and diff its output with the same probe run
    headless (the charset tables and UTF-32 behaviour came from this). gen-framework does this for
    OsConstants and the single-byte charsets, and runs `profman` as root for the boot image profile.

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
- `bun run test` (1,312 pass);
- `WEBDROID_URL=http://localhost:4217 bun run e2e` twice (7/7);
- the live set above, naming its flows;
- `bun run conform <suite>` for guava, jsr166, ojluni-time, luni-io, luni-net, luni-nio-file,
  luni-nio, luni-util and luni-security. Baselines (tests/conformance/*.json): 366,001, 3,135,
  30,603, 1,417, 780, 173, 2,712, 2,320 and 715. guava takes about 90 s, luni-util 2 min,
  ojluni-time 2 min, the rest under a minute. luni-io, luni-net, luni-nio, luni-util and
  luni-security are libcore's harmony and luni tests from LineageOS's Android 14 mirror (java.io
  and java.util.zip; java.net; java.nio buffers, charsets and file channels; java.util;
  java.security, javax.crypto and javax.security with bouncycastle's test jars);
- `bun run lat` cold and `--warm`;
- `bun run smoke apks/FitNotes.apk` (0 method failures);
- for a performance-sensitive flip, `bun run jbench [workload ...]` (V8) against the parent tree.

To A/B a flip without deleting code, set `WEBDROID_BYTECODE=<prefixes>` (`Class$` for one class and its inner classes) for e2e and conform
(`--bytecode`), and `--query bytecode=<prefixes>` for lat.

Known flakes, which are not regressions:
- TikTok `swipe-again` wedges under parallel load and passes alone.
- YouTube `video-open` passes about 2 times in 5, with or without changes.
- Komikku's restore step rarely throws a DOM "file not found" error; it was not shown to be new.
- Komikku's step after "Get started" occasionally settles on pixels mid-transition, so the next tap
  misses (2 of 14 parallel runs after the logging flip, 0 of 24 before; step times match).
- Resy times out.
- `TCKInstant` has one test whose name embeds `Instant.now()`.
- Under five suites at once, ojluni-time's TestZoneTextPrinterParser (86 s alone) exceeds the 240 s
  class timeout; rerun it alone.
- Cold Mihon `light` in `lat` is bimodal (about 24 or 166-188 ms) and failed 5 of 8 runs on the
  final tree of the 2026-10-01 pass; this is item 1 of the latest handoff, not an accepted flake.
- ojluni-time's TestTextParserWithLocale and TestZoneTextPrinterParser report "passing tests no
  longer ran" when test names embed the date; they pass alone.

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
  `pathOf` and makes one with `newFile` (`jio.ts`).
- **java.io file streams (B.7 cut 3).** libcore's FileDescriptor, FileInputStream,
  FileOutputStream and RandomAccessFile over the Linux read/write/pread/pwrite/fstat natives. TS
  reads a descriptor with `fdInt` and makes one with `mkFd` (`jio.ts`). FileChannel is libcore's
  since cut 5 (sun.nio.ch file natives in `jio.ts`). luni-io went from 974 to 1,012.
- **java.io streams (B.7 cut 4).** Writer and Reader and their subclasses, and InputStream,
  OutputStream and every stream class but the ObjectStreams, with java.util.zip's Checked streams and
  InflaterInputStream and java.security's Digest streams; BufferedReader stays TS. System.out/err/in
  come from System's `<clinit>` over descriptors 0 to 2, and zygoteInit redirects out and err to
  logcat through `RuntimeInit.redirectLogStreams` (AndroidPrintStream). TS stream subclasses
  re-parent onto libcore's classes (`filterIn`/`filterOut` reach the wrapped stream, `heldByteReads`/
  `heldByteWrites` serve TS streams holding bytes); `streamOf` makes a libcore ByteArrayInputStream,
  and a lazy asset is an `AssetManager$AssetInputStream`. It needed an object's monitor on the object
  (`$mon`, loaded at the compiled site) and constructors and private methods called through
  class-unique prototype names (V8 never inlined a `.call`). In V8, buffered, pushback, Data and
  Print streams run 1.1x to 3.8x faster than TS and bulk reads and writes match; byte-at-a-time
  ByteArrayInputStream.read(), BufferedOutputStream.write(int) and ByteArrayOutputStream.write(int)
  cost 4.2, 5.0 and 8.2 ns against 2.2, 2.4 and 1.9. luni-io went from 1,014 to 1,275 (one
  `toString("8859_2")` test lost: the TS stream ignored the charset).
- **java.nio.file (B.7 cut 6).** libcore's FileSystems, UnixPath, Files, the Unix provider, its
  (secure) directory streams, UnixChannelFactory and UnixCopyFile over `sun.nio.fs`'s
  UnixNativeDispatcher, LinuxNativeDispatcher and UnixCopyFile natives (`src/android/os.ts`); paths
  cross in native memory through `Unsafe.allocateMemory`/`putByte`. The VFS has no links,
  permission bits or extended attributes, and there is no `/proc/mounts`. FileChannelImpl (libcore's
  since cut 5) takes UnixChannelFactory's descriptor. The new `luni-nio-file` suite (libcore's
  java.nio.file tests without mockito and junitparams) went from 109 to 173 of 195.
- **android.text.Html.** AOSP's HtmlToSpannedConverter over TagSoup from ext.jar, so a TagHandler
  gets the real XMLReader. It needed getSpans to report zero-length marks at query edges. About
  260 µs per 2 KB comment against 60 µs in TS, and about 50 ms on the first call.
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
- **java.net leaf classes (B.7 cut 7a).** IDN (over ICU4J's IDNA, so toUnicode now decodes
  punycode), URLEncoder/URLDecoder, Proxy, ProxySelector and Authenticator. No TS code read their
  layout; no proxy system properties are set, so DefaultProxySelector answers NO_PROXY. luni-net went
  from 295 to 318. URLEncoder/URLDecoder cost 3.5 to 6.5 times the TS bodies (2 to 7 µs per query
  string in Bun, after trimming charset lookup, `String(char[])` and `Integer.parseInt`).
- **java.net.URI and the cookie model (B.7 cut 7b).** URI, URISyntaxException, HttpCookie,
  CookiePolicy, CookieManager, CookieStore and CookieHandler; `jcookies.ts` is gone. TS makes a URI
  with `newObj("java/net/URI", ...)` and reads it through its getters. HttpURLConnection asks
  `CookieHandler.getDefault()` per hop and escapes the URI as OkHttp's `HttpUrl.uri()` does.
  luni-net went from 338 to 472. `new URI(s)` costs 4.8 µs against 0.34 µs for the lazy TS regex,
  after `1L << n` became a table lookup in shl-long and short `String.indexOf(int)` stopped
  allocating (7.3 µs before them).
- **java.net.URL (B.7 cut 7c).** libcore's URL and URLStreamHandler, with the file: and jar:
  handlers from sun.net.www. http and https resolve, as on a device, to
  `com.android.okhttp.HttpHandler`/`HttpsHandler`, TS specs whose connections are the fetch-backed
  HttpURLConnection; it reads a URL through its getters. Class loader resources come from libcore's
  ClassPathURLStreamHandler, one per archive, over JarFile on the TS ZipFile. A TS spec declared over
  a bytecode superclass is now re-parented onto it at link. luni-net went from 476 to 537. In V8,
  `new URL(s)` costs 0.85 µs against 0.38, toString 0.12 against 0.06; getters and equals got
  faster. Limit: class path archives open unverified (JarVerifier's PKCS7 parse needs a bytecode
  ByteArrayInputStream).
- **java.nio's buffers and charset coders (B.7 cut 5).** Every Buffer class, Charset and the
  CharsetICU coders run from libcore; TS reads a buffer as NIOAccess does (`bufferBytes` in jnio.ts),
  direct buffers and non-movable byte arrays live in guest memory, read-only file mappings page
  outside it (jmemory.ts `Region`), and NativeConverter's natives run charset.ts's ICU-model
  converters, checked against a device probe. String's codecs stay TS over the same tables. The new
  `luni-nio` suite went from 926 to 2,616 of 2,815 (history entry, with the measured costs).

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
     blocker was `JBuffer` (about 55 uses across GL, media, fonts and JNI), gone with cut 5.
   - **Done:** cuts 1 (zip codecs, over pako's zlib), 2 (File), 3 (FileDescriptor and the file
     streams), 4 (java.io but the ObjectStreams), 5 (java.nio's buffers and charsets), 6
     (java.nio.file, then ZipFile and the Zip streams), 7a (java.net leaf classes), 7b (URI and
     cookies) and 7c (URL and its handlers); see the 2026-10-01 history entries. **Next in cut 7:**
     URLConnection's base (`getContentHandler`, the content handler statics) and
     InetAddress/InetSocketAddress, then sockets (cut 8). ByteArrayInputStream is libcore's now,
     which unblocks JarVerifier: ClassPathURLStreamHandler's TS constructor can go (check TikTok's
     v1-signed apk, whose MANIFEST.MF is 2.2 MB).
   - **Cut order.** (1) zip codecs (CRC32, Adler32, Inflater, Deflater and their streams; 26
     natives over fflate; ZipFile stays TS). (2) File (12 UnixFileSystem natives over `vfs`).
     (3) FileDescriptor and the file streams over Linux read/write/pread/pwrite (`stdio.ts` needs
     Uint8Array `java*` wrappers for write, pread, pwrite and truncate). (4) the rest of java/io,
     ObjectStreams last. (5) NIO channels, after deciding whether Buffers stay a TS boundary
     (§4.7); the paged mapping is done (item 4). (6) java/nio/file (done), then ZipFile (after 5).
     (7) java.net value classes (URI blocks the cookie classes: AOSP's cookie store needs
     `URI.compareTo`). (8) sockets over `native/net.ts`.
   - **Stays TS as boundaries.** HttpURLConnection over the fetch proxy, TLS at the relay, lazy asset
     streams (`AssetManager$AssetInputStream`) and String's own charset codecs (a VM built-in).
   - `luni-io` (1,275 of 1,541 after cut 4) is the conformance suite for java.io and java.util.zip.
   - Cut 3 limits. Unbuffered IO pays a syscall per call, as on a device: RandomAccessFile.readLine
     reads a byte at a time (about 30x the TS time), readInt 2.4x, 1-byte FileOutputStream writes
     8x; 8 KB and buffered patterns match. Streams nobody closes keep their descriptor, since no
     finalizer runs. Each write publishes to the VFS, and a disk-backed file posts one worker
     message per write.
2. **B.4 collections.** Measured in V8 on 2026-09-29, after structured hot entries (history entry):
   libcore wins the 20,000-key mix (2.63 against 2.98 ms steady) and is 2x to 6x faster on removal,
   ArrayDeque, TreeMap and Integer-keyed HashMap, but 1.4x to 2.5x slower on ArrayList get/add,
   String-keyed HashMap, LinkedHashMap, HashSet and small allocations, and first use costs 5 to
   16 ms more. Not flipped, and the refactor below is not started: the loss is about 2 ns per
   compiled frame (`ArrayList.get` is four), so the next step is cheaper leaf frames in the hot tier
   (§4.6), then remeasure the same workloads in V8. Two frame costs are fixed since (cut 4): V8 never
   inlined an invoke-direct target (constructors, private methods) called through `.call`, and every
   monitor enter/exit took a megamorphic lookup; invoke-super still calls through `.call`. With the
   cut guava's Maps suite runs (213,181 passes; TS fails its initialization) and jsr166 gains 72; the 9,469 guava
   regressions are TS consumers (reserialization, `Collections.reverse` on `l.a`). The blocker is TS
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
   - **Compile worker (done for first launches with a baseline profile).** Launches with persisted
     code skip it; apps without a profile still start cold. Open: resumable bodies (about 14 ms in a
     cold Mihon tap, built on suspension and OSR) could come from the worker too.
   - **Platform image (§4.1, §4.3), measured, not built.** FitNotes (no baseline profile) enters
     platform methods 535k times against 49k for its own on first launch, and platform code is
     about 3/4 of its cold-tier build and JS compile. gen-framework now dumps the device's ART
     boot image profile with profman (root) to `vendor/aosp/boot-image-profile.txt`: 32,506 hot
     methods, of which 18,993 are in classes served from bytecode today (22 MB emitted, 0.5 s in
     Bun) and 13,197 in TS-spec classes (the view stack). Build it as package chunks served like
     the compile worker's output, loaded after the first frame, once Stage C/D puts those classes
     on tap paths; the gated taps today spend little in platform bytecode.
   - **Link metadata (§4.1), in part.** Every realm links all 1,904 native specs at boot, and
     `fallThrough` stubs each of 23,542 AOSP methods the specs lack. Linking cannot be lazy (a
     virtual call on a TS object has no resolution hook), so the gaps are persisted per bundle in
     Cache Storage (`gapsOf`/`recordGaps` in codecache.ts) and replayed before platform indexing:
     192 -> 125 ms per realm in V8. The rest is the 23.5k stub closures and records; precomputing
     class hierarchy and field layouts is still open.
   - **Throw cost (§4.6), measured.** In V8 a Java throw caught one frame up costs 2.9 µs, 2.2 of
     them the 64-frame `new Error()` in `captureStack`; 30 frames deep it costs 9.6 µs, 5.8 without
     capture, because every handler-free frame catches and rethrows to convert JS errors (about
     170 ns a frame). Converting only at frames with handlers (taking an NPE's trace from the
     original TypeError) would remove that catch from most bodies, and about 25 bytes of bytecode
     each, but every TS boundary that inspects a caught value (166 catch sites) must then convert.
     Cut 6 made a missing-file check throw internally, as on a device (about 13 µs each).
   - **Persisted code.** Warm launches load 49 MB of emitted JS for Mihon (63 MB more for
     microG). Suspension checks are 23% of those bytes, and 60% of bodies are single-block
     methods that still carry the full dispatch loop, so a leaner emitter shrinks both import and
     compile time.
   - Keep org.json in TS as an intrinsic candidate: libcore's is 2.3x slower on a 237 KB
     document. That needs a differential test (§4.7).
4. **Memory.** Done: a READ_ONLY mapping of an immutable source loads 64 KB pages on first touch
   (`Paging` in `jnio.ts`), and the apex mount fetches the ICU file in 64 KB ranges. A date format
   holds 2.2 MB of ICU pages instead of 27.3 MB and fetches 2.8 MB in 44 requests; hot reads are
   unchanged. TS readers of a buffer's bytes call `resident(b)` first. Open: prefetching the pages
   a previous launch touched (each first touch is a round trip), and libcore's tzdata, which
   `Os.mmap` still reads whole into guest memory.
5. **Known limits.**
   - TS `eraseThreadLocals` does not clear the TS locals.
   - Regex: `\G` is unsupported, possessive quantifiers are greedy, `\b` uses JS's ASCII word
     set, DOTALL `.` does not take CRLF as one character, and anchoring bounds are ignored.
     hitEnd misses a backreference cut short by the end and ICU's reads at a lookbehind's
     limit. Patterns whose derived forms do not compile (atomic groups with captures or
     lookaheads) fall back to "the match reached the end".
   - The expat natives skip external entities.

### Stage C.1: resources (default since 131efb48)

Inventory taken 2026-09-29 (`fwscan`, `fwtest`, `audit apks/FitNotes.apk --framework --cut
android/content/res/`):
- **Declared natives: 97** in `android/content/res/`: AssetManager 55, XmlBlock 22, ApkAssets 12,
  StringBlock 5, ResourceTimer 2, ObbScanner 1. Configuration, Resources, ResourcesImpl, Theme,
  TypedArray and ColorStateList declare none. FitNotes reaches 67 of them statically (every
  AssetManager, XmlBlock and StringBlock native it can, and ApkAssets load, string block, open-xml,
  path and destroy).
- **Before this stage** 82 had delegates (`src/android/delegates.ts`), none for ApkAssets. They
  answered off one shared TS `Resources`: `nativeCreate` returned the app's, `nativeSetApkAssets`
  and `nativeSetConfiguration` were no-ops, every cookie was 0 and every density the device's, so
  `TypedArray` string reads (`getPooledStringForCookie(0, …)`) and XML-literal strings (which AOSP
  reports with cookie -1 and an index into the XML block's pool) could not work, and theme values
  lost their changing-configuration flags.
- **TS specs withheld by the cut: 11** (Resources, Resources$Theme, TypedArray, AssetManager,
  Configuration, ColorStateList, XmlBlock, XmlBlock$Parser, XmlResourceParser,
  AssetFileDescriptor, Resources$NotFoundException). The audit counts 349 references to their TS
  classes; outside `res.ts`/`resnative.ts` they are JTheme (8 files), JColorStateList (drawable,
  widget, textview, text, view, imageview), JResources (fonts, apphost), JConfiguration (context),
  JTypedArray (delegates, text), JXmlParser (inflate) and JAssetManager (fonts, context). The TS view
  stack reads resources below that line as well: `obtainStyled` (30 sites, 14 files),
  `JTheme.lookup` (27, 8), `themeOf`/`askTheme` (15), `loadDrawable*` (50, 17),
  `.jres` (115, 16) and `JResources.host` (59, 13).
- **Hot paths.** `obtainStyledAttributes` (`AttributeResolution::ApplyStyle`): every widget
  constructor, about 100 attributes for View's styleable. Theme attribute lookup
  (`Theme::GetAttribute` + `ResolveReference`). `getValue` (`nativeGetResourceValue`). Layout XML
  through XmlBlock (today the TS inflater parses AXML itself). String reads with spans
  (StringBlock styles).
- **Done (step 1): natives.** 94 of 97 have libandroidfw semantics over one AssetManager2
  (`res.ts` `Resources`, `JTheme`, `resolveAttributes`; natives in `assetmanager.ts`), which the TS
  stack uses too. Left: ObbScanner and ResourceTimer (unreached), resolution logging (answers ""),
  `nativeList` of the framework apk's assets (its archive is not listed) and fd-backed ApkAssets
  (served by path). `WEBDROID_BYTECODE=android/content/res/ bun run fwtest android/content/res/`
  runs AOSP's Resources end to end headless. Measurements are in the history entry.
- **Done (steps 2-5), the default since 131efb48:** apps boot through AOSP's ApkAssets, AssetManager and Resources
  (`src/android/resources.ts`), Contexts hold the Java Resources and Theme, and the system Resources
  get the device configuration and metrics at boot (as ActivityThread's
  `applyConfigurationToResources` does). The TS view stack reaches native state through bridges;
  preferences, view tags, text appearances and custom XML drawables get AOSP's parser.
- **Failure mechanisms found under the cut (browser only; headless view trees matched):**
  - Harmonic: a file resource (`@font/...`) resolved to a fresh reference each call, so `rvString`
    (which resolves until the value stops changing) recursed forever (f136d416).
  - TikTok "Recursive reference in drawable": Context's resource getters awaited between
    `getResources`, `getTheme` and the final call, so the call could resume on another Java thread; a
    background load pushed the id onto the main thread's `ThreadLocal` LookupStack. The getters now
    pin every call to the caller's thread (2ce12bbe).
  - `Resources.getSystem()` had 0x0 metrics and an empty Configuration (2ce12bbe).
  - Lichess blank screen: `SoundPool.load(AssetFileDescriptor)` read a TS-only field, returned 0 and
    never completed, and Flutter's sound plugin blocks Dart init on it. The visible symptom was Cronet
    never loading (4d5b9ac2). Lesson: diff the page's logcat between paths (headless Chrome console)
    to find where init diverges; a blank Flutter surface says nothing on its own.
- **Left:** ObbScanner, ResourceTimer, resolution logging, `nativeList` of the framework apk and fd-backed ApkAssets.

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

- A TS native that always returns a Promise (an `async` helper) suspends its Java caller on every
  call. In a loop this nests one promise per call, and every later Java exception then pays for
  V8's async stack capture over that chain (200 µs instead of 14 in the cut 6 measurement). Compare
  with `node --no-async-stack-traces`, and count suspensions with `configureJvm({ profile: true })`
  before the code compiles.
- A native that throws a bytecode exception class must see that class initialized, or the
  instance has no methods. `rt.make`/`rt.mkThrowable` only link it.
