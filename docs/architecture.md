# Architecture

webdroid runs unchanged APKs in the browser: Android's own Java userspace runs from AOSP bytecode compiled to
WebAssembly, native libraries run on an ARM core compiled from Zig, and TypeScript implements only the boundaries
underneath. This file is the design and the decisions behind it. [PLAN.md](../PLAN.md) tracks status and open
work, [AGENTS.md](../AGENTS.md) the working rules, and the [implementation history](implementation-history.md)
the measurements, failure mechanisms and rejected experiments. Each source file's header comment holds the detail.

## Requirements

1. **Tap latency ≤ 150 ms** from the input event that completes the gesture (`pointerup`, key up) to the first
   presented frame showing the response, excluding the app's network waits. It applies to every gated tap,
   including the first tap on a screen. `pnpm lat` measures it; [performance.md](performance.md) gives the
   conditions.
2. **Unchanged bytecode.** App and bundled library bytecode run as shipped.
3. **The software draw path and the visual goldens are preserved.**
4. **One Android build everywhere:** API 35, `sdk_gphone64_arm64` `AE3A.240806.043` (`vendor/aosp/build.txt`). It
   supplies the framework and boot jars, framework-res, ICU and tz data, the fonts, the advertised SDK level and
   the e2e goldens. `pnpm gen-framework` pulls it from the reference AVD. AOSP bytecode needs
   its paired resources from the same build: a relinked framework-res had only 53.5% of internal ids right.

## Platform: AOSP bytecode over TypeScript boundaries

```text
App DEX (unchanged)
  └─► AOSP bytecode: framework.jar and every BOOTCLASSPATH jar of the reference build
        ├─► JNI natives ......... TS and Wasm: graphics, text, POSIX, input, surfaces, resources
        ├─► Binder / AIDL ....... system services in TS (IActivityManager, IWindowSession, IPackageManager, ...)
        └─► VM built-ins ........ TS: String, Object, Class, Thread, Throwable, reflection, java.lang.invoke,
                                  Unsafe, VMRuntime
Browser: Canvas2D / WebGL, OPFS / IndexedDB, CORS proxy and TCP relay, Workers
```

- **Bytecode by default.** `src/jvm/provenance.ts` is the one place that decides whether a class runs AOSP's
  bytecode or a TS spec. Elsewhere a spec implements natives only; `TS_SPECS` lists the only classes where it may
  stand in for bytecode bodies, each a boundary (HTTP over the fetch proxy, TLS at the relay, GL over WebGL, the
  WebView provider). `?bytecode=<prefixes>` (`WEBDROID_BYTECODE`) cuts more prefixes over for one load, to A/B a
  change against the same bundle.
- **A missing API is fixed at the boundary** with the native, service method or VM built-in that AOSP's body
  needs, never by reimplementing the Java method in TS or returning a constant to satisfy a query.
- **No fabricated success.** An entry that cannot be supported throws or returns the error AOSP documents for an
  unsupported capability. Persistent state keeps its canonical owners.
- **Intrinsics** (a TS or Wasm body for a Java method outside the boundaries) are allowed only when the method is
  a VM built-in or the intrinsic measurably reduces a gated tap or frame, and only when it is differentially
  tested against the AOSP body it replaces (`pnpm textcmp` is the model). They live in `link/intrinsics.ts`
  and `link/chars.ts` (bit conversions, `System.arraycopy`, identity hashes, stack capture, `Math` as Wasm
  instructions or direct host imports, a few `Character` predicates) and take precedence over registered natives
  for the same method, so a native registered under an intrinsic's key is unreachable.
- **Enforced by static checks** in `pnpm test`: `pnpm desccheck` holds every registered descriptor to one
  that AOSP declares, and a TS spec standing in for a bytecode body to `TS_SPECS`; `pnpm bypass` reports a TS
  method whose AOSP body dispatches to an overridable method on `this` that the TS body bypasses (only methods a
  corpus app overrides, from `tests/fixtures/app-overrides.json`).

The migration that established this (stages A–F, completed 2026-10-05) moved libcore, resources, graphics, text,
the view stack, windows, `android.content` and ActivityThread onto bytecode and deleted the superseded TS. Its
reason: the hand-written TS userspace grew with every app and approximated AOSP rather than transcribing it,
and 70–80% of recorded failure mechanisms were deviations from a documented contract. AOSP's own surface is
closed at the native boundary (5,381 of 314,242 platform methods are native; an app reaches 1,300–1,900).

## How Java runs: the Wasm tier

DEX bytecode is compiled to WebAssembly with GC types and JSPI.

| Layer | Where | Owns |
|---|---|---|
| Front end | `src/jvm/{dex,prepared,abi,opcodes}.ts` | DEX parsing, decoded instructions and each method's block graph (built once, in `prepareMethod`), opcode classes, field mangling |
| Compiler | `src/wasm/compiler/` | one Wasm module per unit of methods (`j2w.ts`, `method.ts`), structured regions and loops (`structure.ts`), web-based register typing (`infer.ts`), path facts, CHA, per-loader type views (`loadergraph.ts`), binary encoding |
| Linker and VM | `src/wasm/link/` | the `World` (`world.ts`): classes, table slots, lazy linking; strings, monitors, strands, reflection, method handles, Unsafe, loaders, AOT images |
| Host | `src/wasm/host/` | boot of a realm's World, host→Java entry, the native boundary and bridge, JNI, compile Workers, persisted app builds |
| Natives | `src/jvm/natives/`, `src/android/` | platform natives and host classes, registered through `rt` (`src/jvm/runtime.ts`) and assembled by `src/natives.ts` |

`src/jvm/tier.ts` loads the host by a dynamic import, so a page fetches the platform build while the rest starts.
Only `host` may import the runtime, natives and services (`tests/wasm-layers.test.ts`). `src/jvm/natives/jentry.ts`
is how host code calls Java.

**Objects and execution.**
- An object is a Wasm GC struct: an immutable vtable reference and a header word (identity hash and thin lock),
  then fields typed by layout. Arrays are wrapper structs over GC arrays. Class tests use the vtable's ancestor
  display. `java.lang.String` is a struct over an `i16` array with a cached hash and, once a host asked, its JS
  string (`link/strings.ts`).
- Calls between modules go through one shared funcref table, each storing its slot in `rt.callee` first. A
  method's slot starts as its signature's lazy-link stub, which compiles the method in `rt.callee` on first call;
  vtables hold slots. Class-hierarchy devirtualization is recorded per slot
  and undone when a later dex falsifies it; precompiled platform code relies on no such decision.
- A Java thread is a strand, a JSPI stack. Blocking operations (park, contended monitors, `Object.wait`, class
  initialization waits, waiting natives) are Suspending imports, so only a real wait suspends. Back edges charge
  fuel; a yield suspends only when another turn is due (`link/sched.ts`).
- Exceptions use one Java throwable tag; implicit checks are explicit code (`compiler/exc.ts`).

**The host boundary.**
- A native is registered once, by the module that owns its class (`rt.register` for host classes, `rt.registerJni`
  for functions); a second registration throws. Its Wasm import is derived from its descriptor (`host/natives.ts`),
  and it is a Suspending import only when its registration says it may wait (`driven`, async or `waits()`). Scalars pass as Wasm values, strings as externref,
  primitive arrays through linear-memory scratch, other references as opaque values that the bridge
  (`host/bridge.ts`) reaches only through generated accessors.
- A host class's Java object and its TS object are one object to both sides (`link/hostclass.ts`).
- JNI for guest ARM code uses the Wasm references themselves as JNI objects (`host/jni.ts` over
  `src/native/jnivm.ts`).

**Code delivery.**
- **Platform:** compiled at build time (`pnpm aot`, `scripts/wasm/aot-build.ts` over `link/aotbuild.ts`, which app builds share) into class-data ("D") and code
  ("C") modules under `vendor/wasm-aot/`, numbered so that they link into any World. The build is keyed by every
  file under `src/` and the AOT scripts. A page streams and compiles it in Workers (`host/aotload.ts`). A warm
  Worker of the page has the engine compile the build code launches ran before a process calls it
  (`host/warm-worker.ts` over `host/warmshim.ts`), and a spare process Worker stands ready for the next launch
  (`src/shell/process-host.ts`).
- **App:** after a first launch, a compile Worker builds the methods the app ran, ordered by the APK's own ART
  baseline profile (`src/jvm/baselineprof.ts`) and then their call closure (`src/jvm/reach.ts`), and persists the
  build (`host/appcode.ts`, `host/persist.ts`); the first process of an app to launch makes it. Bundled builds cover the gate apps
  (`vendor/wasm-aot/*/apps.json`). The build is refined once new demand reaches `REFINE_SHARE` (an eighth) of
  what it covers. A warm launch links the app's default namespace statically under a standard app loader.
- **On demand:** anything not in a build compiles through the lazy-link stubs, in batches; classes linked on
  demand get globals-only modules, and first-tier units share helpers in large modules. In a launch without a
  saved build, `World.ahead` compiles likely callees in the app thread's idle time.
- **Second tier:** hot methods are recompiled in a compile Worker under the same numbering and adopted only if the
  World has not renumbered meanwhile (`link/tiering.ts`; the Worker side is `link/unit.ts`). A slot's tier is one
  state in `Tiering`, which also invalidates and resets it.
- Compile Workers start in a sandboxed frame of the page (`host/compilehost.ts`), which Chrome's site isolation
  gives its own renderer, so they do not share the app's 4 GB pointer cage.

## Processes and system services

AOSP's ActivityThread, view stack, windows and `android.content` run from bytecode over system services
implemented in TS behind Binder (`src/android/binder.ts`, `parcel.ts`). The shell modules
(`src/shell/activitystack.ts`, `packages.ts`, `processes.ts`, `device.ts`, ...) are those services
and own their state.

Every app process runs in its own Worker with its own World, heap, statics and main queue; the page realm is
`system_server`. Processes exchange serialized Parcels and handles through the broker, never Java objects, and
replies must reach callers waiting on the main queue. `MessageQueue.nativePollOnce` is a suspension on the
process's main queue, `DisplayEventReceiver` takes vsync from the host display's pacing, browser pointer and key
events reach `MotionEvent`/`KeyEvent` through AOSP's input stages, and `ViewRootImpl` draws through
`drawSoftware` onto the page canvas.

A service whose state is the device's (notification, mount, audio, media_session, media_router, clipboard, alarm,
location, account, content, jobscheduler, shortcut, uri_grants: `SYSTEM_SERVICES` in `binder.ts`) is hosted once, in
system_server, and app processes reach it by Binder through the broker; a service that holds the process's own
state (activity, window, input_method) or answers from the device profile or a broker-owned store is hosted in
each process. Each is hosted with `hostService` by the module that owns it. A Worker reaches the broker through the domains of
`src/shell/broker-contract.ts` and never bundles `processes.ts`. Each realm reaches them through one `broker()`
(`src/shell/broker-access.ts`), which throws RemoteException before the realm connects and after its port
closes; a Worker reaches system_server's stores and services through it rather than answering from a local
copy, while the page and a realm that never connects hold them. Path operations and descriptors of another
realm's files go through one `pathOwner()` (`src/shell/file-path.ts`).

## Native code

ARM32 and A64 execute in `src/native/core/` (Zig compiled to Wasm), with an interpreter and a JIT whose results
must agree; `src/native/cpu.ts` drives asynchronous exits, and host calls exit `run_slice`. 64-bit processes run
the reference build's bionic as guest code (decision below). 32-bit processes keep the HLE libc, because the
reference build ships no 32-bit bionic. EGL/GLES (onto WebGL), audio, media codecs and DRM stay high-level
emulation. Networking goes through the dev server's or Worker's HTTP proxy, DNS lookup and TCP WebSocket relay.

## Rendering and text

RenderNode and RecordingCanvas natives record display lists that replay on a Canvas2D software renderer.
`HardwareRenderer`'s natives (`src/android/hwui.ts`) run hwui's RenderProxy: each frame replays the root
RenderNode's tree on Canvas2D into the window surface's next buffer and queues it, and render-thread animators
keep drawing on each vsync without the UI thread. Every draw goes through one paint bracket (`canvas.ts`), which
blends a mode Canvas2D cannot bound through the draw's coverage. Text measures on HarfBuzz over the reference fonts and draws with `fillText`;
Path ops use Skia through CanvasKit (decision below). Resources drive widget defaults, themes and geometry
(`src/shell/config.ts`).

## Verification tooling

- **Conformance:** `pnpm conform <suite>` runs Guava's collection testlib, the JSR-166 TCK and libcore's
  `java.time` and harmony/luni suites from the same AOSP build headless, against baselines in
  `tests/conformance/`.
- **Recorded device answers:** reference-AVD results checked into fixtures and replayed in `pnpm test`
  (`scripts/simd-oracle.ts` for SIMD, `pnpm textcmp` for text layout).
- **Flows:** `pnpm e2e` against device goldens ([tests/e2e/README.md](../tests/e2e/README.md)), `pnpm corpus`
  over the APK corpus, `pnpm fwtest` for framework delegates, `pnpm smoke` compiling an APK's every method.
- **Telemetry for silent failures:** `run.json` records `newMissing`, `newErrors`, `nativeRequired`,
  `newPlaceholders` and the Java callers of missing entries, from every process.
- Not built: a boundary-trace differential against the device (JVMTI or Frida on the reference AVD), which would
  report the first divergent platform call of a scripted flow.

Fixes should come from these tools more than from app failures. A content-difference percentage from e2e is a
diagnostic, not a quality signal.

## Decisions

### Heap: engine-managed Wasm GC (2026-10-05)

Objects stay Wasm GC structs. Research kernels favored engine GC over an experimental linear-memory mark-sweep
collector when objects are retained, and moving the heap would need a collector, barriers and root tracking.
Direct buffers already live in native linear memory. Benchmark losses recorded at the time (GC-array/native
copies, String allocation, locking and fuel checks, module loading and compiling) were never attributed to the
GC heap. Reconsider only if a measurement attributes a failed gate to GC layout or collection, and then compare
the linear-memory alternative on that workload with identical semantics and live-heap pressure.

### 64-bit native userspace: the reference build's bionic (2026-10-01)

Every arm64-v8a process runs the reference build's `libdl`, `libc`, `libm`, `libc++`, `liblog` and `libz` as
guest code over a Linux syscall layer (`src/native/syscall.ts` over `kernel.ts`, `fd.ts` and the file kinds), with `src/native/bionic.ts` doing the
dynamic linker's share of startup. The host keeps the core's memory and string primitives (`memcpy`, `memmove`,
`memset`, `memcmp`, `memchr`, `strlen`, `strnlen`, `strcmp`, `strncmp`, `__memcpy_chk`), the heap (through
bionic's malloc dispatch table), `clock_gettime` (served in the core as the vDSO serves it) and the HLE boundary
libraries.

- **Why:** formatting, parsing, locale, stdio, time zones, FORTIFY, fdsan, pthread and signal semantics, DNS
  through netd and logging through logd become exact. Correctness gates equalled the HLE libc's, live flows
  passed at least as often, Among Us's menu rose from 20.5–20.7 to 22.7–23.2 GL frames/s, and the comparison
  exposed kernel/VFS gaps the HLE had hidden (`/proc/self/task`, `/proc/self/maps`, stack guards, Top Byte
  Ignore, `mremap`, the property area), now fixed for both libcs.
- **Costs:** per call, bionic's formatting, mutexes and libm are slower than the HLE's core-served versions
  (snprintf 2.0–2.5 µs vs 0.78, mutex 68 ns vs 22, sin+exp 180 ns vs 37); no measured app showed it. Faster
  paths must be core performance on bionic's own code or differentially tested intrinsics justified by a frame or
  tap.
- **Unsupported:** a second process: fork, vfork and non-thread `clone` answer EAGAIN, exec ENOSYS and wait ECHILD,
  so `popen`, `system` and `Runtime.exec` fail. AF_UNIX sockets connect only within the process and to logd and
  netd. Offsets into bionic's private structures are this build's (`bionic.ts`); a
  new reference build must recheck them.

### Text on HarfBuzz over the reference fonts; paths on Skia (2026-10-01)

- **Fonts are the reference build's** `/system/fonts` (206 files) and `font_fallback.xml`, parsed by AOSP's
  SystemFonts. Glyphs load on first shape or draw; style, metrics, axes and coverage come from `/font-index.json`
  (`scripts/font-index.ts`), which apps receive as a serialized font map.
- **HarfBuzz is minikin's shaper for measurement:** Paint and MeasuredText advances, extents and bounds come from
  `shaping.ts` (itemization, LayoutSplitter pieces, HarfBuzz at minikin's 24.8 scale, Skia's hinted advances).
  minikin's own algorithms (itemization, line breaking, grapheme and word breaks) stay a TS port, which agrees with
  the device on every recorded case.
- **Canvas2D draws text with `fillText`,** each font registered as its own CSS face. Text into a bitmap in Roboto
  or the emoji face is CanvasKit's `drawGlyphs` of minikin's glyphs, rasterized by FreeType as on the device.
- **`Path.op` is SkPathOps and `Paint.getFillPath` is SkStroke** through CanvasKit, loaded lazily.
- **Why:** `textcmp` 72/72 device layouts with widths within 0.00 px; fast e2e content difference fell for
  calculatorm (2.97 → 1.17%) and fitnotes (13.94 → 3.06%); a cold 150-paragraph StaticLayout took 41–43 ms
  against 46–49 ms on `measureText`; `Path.op` matches the device's verbs and fill type exactly.
- **Rejected:** drawing glyph outlines as Path2D fills (16–20× slower than `fillText` for a screen of text); a
  glyph atlas with `drawImage` per glyph (14–44 ms a screen); relying on CSS for every axis (Chrome never applies
  `ital` from a variable font).
- **Limits:** Skia's advances are FreeType's rounding of HVAR deltas and hinted 26.6 values, and `fillText`
  positions glyphs by Chrome's unhinted advances, so a drawn run can drift a fraction of a pixel per glyph;
  CanvasKit 0.38's PathOps returns a conic arc as quads; each realm's `Typeface.<clinit>` still parses the legacy
  `fonts.xml`.

### Superseded

Decision 0003 (2026-10-02) kept Java objects in each process's JS realm and specialized the boundaries of the
DEX-to-JavaScript tier instead of replacing the VM. The Wasm tier replaced that VM, and the JS tier was deleted on
2026-10-13; its rejected experiments are in the history. The original records are in Git history under
`docs/decisions/`.
