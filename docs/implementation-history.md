# Implementation history: durable findings

Retained through 2026-09-22. [PLAN.md](../PLAN.md) owns active work and
[AGENTS.md](../AGENTS.md) owns working rules. This file keeps failure mechanisms,
measured tradeoffs and unresolved limits. Git history contains the run-by-run
captures and commit IDs removed from this summary. Historical results describe
their tested revision, not necessarily current status.

## Evidence and measurement

- Run real APK and bundled library bytecode. A rendered screen or empty missing-API
  set proves only the observed path. Inspect each process's diagnostics, advancing
  `wd.ticks`, frames, layout/draw errors and required natives. Auxiliary WebView
  frames may be unavailable to the harness; label that separately.
- Compare ambiguous faults with the starting revision under matching inputs and
  settings. Live content, app state, coordinate fallbacks and different browser
  processes change scores and timings. Keep goldens fixed unless explicitly updated.
- For performance, use fresh visible browsers, one capture at a time, `--jobs 1`,
  no expensive tracing and working rendering. CPU, guest instructions, frames,
  action completion and screenshot readback measure different things. A wedged or
  throttled guest can appear cheaper. Microbenchmarks do not establish app speed.
- `settleDelayMs` bounds scheduled work rather than imposing a fixed sleep. The
  harness pins `Date` for deterministic flows and uses live clocks for network
  flows; Playwright's page clock conflicted with guest timer wrappers. SwiftShader
  readback can take seconds, so time the sampled frame separately.
- The full serialized E2E matrix and task acceptance gates remain in
  [PLAN.md](../PLAN.md). See the [harness guide](../tests/e2e/README.md) for
  capture commands. Historical YouTube control timeouts and Matrix draw errors,
  Lichess pthread faults, and Flappy Bird page-status errors need matching-baseline
  assessment, not silent waivers.

## API-33 fuzz compatibility — 2026-09-23

Branch `codex/fuzzer-compatibility` starts at `756491fb`. The unchanged signed probe
(`8e8cc2f9` SHA-256 prefix) ran on API-33 emulator-5554, fingerprint
`google/sdk_gphone64_arm64/emu64a:13/TE1A.240213.009/12342917:userdebug/dev-keys`.
The AVD retained an old 720×1280, 320 dpi override even after its config was rewritten;
initial density and clip comparisons were invalid. Oracle setup now applies the active
1080×2160, 480 dpi profile and the runner rejects mismatched geometry. Webdroid's
probe URL uses that same profile. The harness now tolerates only small float serialization
differences in Matrix, path-bound and RenderNode state; pixels and integer state remain exact.

The matched-profile 20-case graphics campaign at seed `1592594996` retained 19 failures
after the first Matrix skew repair. The final candidate retains six: two center-pixel
differences under compound transforms, one rotated `clipRect` bound, and three small
pixel differences. The clip tracker keeps a conservative device-space rectangle, so
a rotated clip may still report a larger bound than Android. Minimized bundles are in
`fuzz-results/graphics-final/` in this worktree. A 1,000-case API campaign with the same
seed has zero differences. These counts cover generated paths, not arbitrary graphics
or APK behavior.

The fixes add Matrix skew through the existing affine operations; restore Paint's 12 px
default and zero text size; preserve API-33 alpha conversion; ignore nonpositive circle
radii; include circle radii in Path bounds; normalize reversed rectangle, oval, arc and
round-rectangle bounds; and retain distinct horizontal and vertical corner radii.
Canvas clipping now tracks rectangular bounds across save/restore and shares one bounds
implementation with the AOSP native delegate. Chrome needs an off-canvas clip path for
empty or singular-transform clips; a zero-size Canvas2D path leaves its clip unchanged.

Verification: typecheck, all 1,325 unit tests, deterministic fuzz smoke, zero method
failures compiling the probe APK, and focused framework exercises pass. The API-35
framework cut reports 204/222 declared graphics natives registered; its exercised paths
report no new missing delegate. The 39-step FitNotes fast lane passes with all process
diagnostics `ok`, no new missing APIs/errors/native requirements or timeouts, and main
ticks advancing from 13 to 1001. Its 12.2-second wall time is a functional check, not a
controlled baseline performance comparison. The serialized six-flow fast lane completed
all steps but passed 5/6 flows: Doodle Jump missed its 30 fps gameplay gate once at
29 fps, and its full-evidence rerun recorded 28–30 fps at several checkpoints. With
one flow at a time and the same screen profile, the starting `756491fb` revision passed
at 31 fps and the candidate passed at 37 fps on an isolated repeat. This does not
reproduce a performance regression, but a single pair does not explain the variability.
The full serialized E2E matrix and a matched CPU microbenchmark were not run for this
pass. Goldens were not changed.

Follow-up on the six retained graphics cases: the same 20-case seed now has zero
differences, as does a fresh 1,000-case API run. The causes were inverse Path fill
types being discarded, non-AA clip bounds rounding outward instead of to the
nearest device pixel, reversed arc bounds being normalized like oval bounds,
zero-width stroked round rectangles being dropped, Canvas2D `source-in` clearing
outside a filled rectangle, and bitmap hairline coverage under compound transforms.
The bitmap hairline path follows Android Skia's 26.6 endpoint and 16.16 slope
stepping for plain non-AA rectangle strokes. The inverse nonzero Path uses the
existing flattened path boolean operation, so curved edges remain approximate.
Other blend shapes and filtered hairlines retain the general Canvas2D path.

The follow-up passed typecheck, all 1,325 unit tests, graphics fuzz smoke, 33/33
Canvas and 43/43 Path framework native registration checks, and serialized
FitNotes/Calculator M fast E2E flows. A paired visible-browser comparison for
software bitmap contexts (`willReadFrequently`) passed both flows with either
setting: 15.4 seconds for the new setting and 15.6 for the old one. This small
sample establishes no app-level speedup. No goldens changed.

A fresh API-33 sweep at seed `20260923` found 36 graphics differences in 100
generated cases. The harness retained its maximum of 20 distinct minimized
fingerprints and replayed each twice. These are not 20 proven independent causes:
fingerprints include command sequences, and the run stopped retaining after 20.
Minimized bundles are in `fuzz-results/graphics-next-20260923/` in this worktree.
The clearest cases are a cubic Path combined with a circle whose filled region
differs across roughly 30% of pixels (`-11` bundle), and translation after a
singular skew that Android retains in its Canvas matrix but Webdroid loses
(`-10` bundle). Other retained cases involve Path fill and center pixels,
non-AA lines, text and View text rendering, Drawable alpha/compositing, and
degenerate arcs or round rectangles. Pixel differences range from sub-percent
edge coverage to substantial shape changes; each needs cause-level diagnosis
before a platform change. The matching fresh 1,000-case API run had zero
differences, but its generator exercises only seven API recipes.

## JVM, DEX and process ownership

- Main-thread identity is not main-queue ownership. Boot, providers, application
  and activity attachment require ordered main jobs; `inMainJob()` establishes
  ownership. An await can interleave check-then-act bytecode. Native monitors
  retain recursion and release/reacquire around wait. Restore initiating Java
  thread identity after suspending callbacks, JNI and class initialization: a lost
  identity once made two Java threads share one native CPU and corrupted Cronet.
- Class initialization waits for concurrent initialization while allowing valid
  reentry and cycles. Run only a class's own initializer; inherited JS static
  lookup once reran a superclass initializer and changed a coroutine sentinel.
  Reflective/static reads initialize the declaring class lazily.
- Numeric DEX constants need reaching definitions through CFG merges and exception
  edges to distinguish floating literals from null receivers. Moves propagate
  types; Java float-to-int conversion saturates where specified. Constructor
  lookup must not inherit a superclass constructor. Preserve defining-loader
  identity and descriptor qualification for colliding static member names.
- Cold methods use shared instruction handlers; hot methods can promote while
  captured entries follow the promotion cell. Generated specialized async source
  has a shared 32 MiB admission limit; denied methods remain cold. Reddit's feed
  exhausted earlier per-method/template caches: fewer JS references did not make
  V8 reclaim executable code soon enough. Detailed benchmarks and OSR rules are
  in [DEX performance architecture](dex-performance-architecture.md).
- Method preparation skips the numeric-constant CFG when opcodes 0x12–0x19 are
  absent and skips successor construction for single-block methods. FitNotes had
  14,909/22,259 methods without those constants; paired cold compilation measured
  390 to 342 ms total median, with zero method failures. This is compiler
  throughput, not browser interaction. A FitNotes profile found almost no eligible
  hot numeric work, so a Java Wasm tier or parallel JVM workers lacks an app-level
  case. Objects, callbacks, fuel yields and process ordering need explicit design.
- `DexLink.s` reuses the immutable DEX string cache. A 128-entry paged cache
  retains indexed method/field lookup without allocating untouched ranges;
  wholesale `Map` replacements regressed TikTok startup. Class locations pack DEX ordinal and
  class index while preserving first-definition precedence. Paired startups
  reduced foreground post-GC heap in TikTok and Mihon without establishing a
  launch speedup. One full TikTok cold smoke exceeded 5 GB and was stopped;
  a browser launch is not an equivalent gate.
- Processes have separate JVMs and native memory. IPC transports serialized
  Parcels and handles, never Java objects; replies must reach callers parked on
  their main queues. JNI lookup and registration preserve the defining loader.

## Collections, storage and package loading

- Collection views stay live. Copying `subList` or map views broke Compose anchor
  deletion and Glide resource ownership. Virtual `List.sort`, `retainAll`, iterator
  removal and callback suspension must reach Java overrides. Async sorted searches
  revalidate structural revisions after comparison. CopyOnWrite iterators remain
  snapshots; its `RandomAccess` marker matters because TikTok chooses indexed
  removal when it is present.
- The shared account store owns identities, authenticator visibility and
  credentials. Visibility grants account identity, not password/token access;
  password changes invalidate cached tokens. A synthetic account fixture tested
  persistence but did not prove Google sign-in. Authenticator Binder requests
  still need reached-path verification.
- `sql.js` `Database.export` closes/reopens the connection and destroys TEMP
  state. Snapshot backing files after transactions, with a nonblocking PASSIVE
  WAL checkpoint; defer while readers/raw transactions prevent completion.
  Native SQLite connections keep their own TEMP tables while sharing the file.
  Later, a Statsig database exceeded localStorage's base64 quota, so binary
  snapshots moved to the shared IndexedDB private-file owner. Migrate old data
  only after the new write commits. A six-MiB value plus live TEMP table/trigger
  survived reload in the focused test.
- Upstream sql.js treated BigInt as TEXT and unsafe Number as DOUBLE. The
  reproducible vendor build exposes `sqlite3_bind_int64`; ordinary safe-number
  reads stay fast and unsafe rows are reread as BigInt. Rounded IDs cannot be
  recovered. Restore package private state before startup reads it: losing
  microG's Firebase installation JSON regenerated its FCM identity. App-owned
  external files persist; disposable cache files do not.
- APK/XAPK loading preserves split precedence, distinct DEX entries, ABI,
  signatures and lazy asset inflation. Eager `Object.entries` on a large asset
  pack exceeded V8 heap. Keep range caches bounded. DEX v41 offsets are
  container-relative; quickened opcodes can be walked but not compiled normally.

## UI, framework and WebView

- Layout invalidation follows the parent chain, with actual measure work gating
  layout. Requests raised mid-layout replay after flags clear; attachment can
  require a subtree remeasure despite unchanged specs. Global dirtiness cannot
  replace AndroidViewHolder's parent invalidation. Back targets the top window.
- Java overrides control `View.draw`, `Drawable.draw`, `requestLayout`,
  `InputConnection` and child/layout-parameter conversion. Await virtual
  drawable geometry and text measurement. Report draw failures while letting
  the frame loop recover; automatic retry made 60-fps exception storms.
- Resources, contexts, overlays and density determine widget geometry. Do not
  fabricate IDs or app-name rules. AOSP framework jar and resources must come
  from one build: relinking shifted thousands of internal IDs. Keep provenance
  cuts in `src/jvm/provenance.ts`, including TS objects passed into Java code,
  and preserve the software draw path.
- RenderNodes record commands but nested nodes and video surfaces read current
  contents at replay. Present completed offscreen bitmaps atomically; direct
  visible drawing exposed half-painted frames at bytecode yields. Cached shader
  tiles removed repeated allocations while preserving recorded uniforms.
- Text uses Java CharSequence and shared Paint metrics. Spans retain callbacks;
  replacement spans are indivisible during wrapping and paragraph line heights
  affect measurement. Kerning changes prefix advances. The Android emoji font
  pair, fractional metrics and paragraph-span routing improved ChatGPT rows;
  Latin rasterization and some keyboard/system-bar differences remain.
- Browser input goes through InputConnection and real Editable methods. Wheel
  events need a queued drag stream with timestamps and inertia; `ACTION_SCROLL`
  alone did not reach pagers. Dispatch touch through Activity, Window and decor
  so Unity receives fallback `Activity.onTouchEvent` calls.
- The WebView proxy preserves method/body and user agent through redirects,
  with isolated cookies. Script-visible cookies exclude HttpOnly values.
  Same-document fragments send visited-history and page-finished notifications
  without invented full-document start/commit callbacks. Static `Location`
  virtualization repaired microG's OAuth hostname while retaining the browser's
  real security origin. Dynamic computed names, generated code and reflection
  remain outside that transformation; it is not complete proxy transparency.
  Proxy scripts cannot register as service workers.

## Native CPU, ABI and media

- The Zig Wasm core owns ARM32/A64 execution. Interpreter and JIT must agree on
  registers, memory, flags, exceptions and callback order. Compare `?jit=0`,
  then narrow with `__wdJit` or `core.jit_fallback(lo, hi)`. JIT fallbacks spill
  every local they reload; partial flag writers settle preserved flags.
- Install regions only against source-page epochs; writes to executed ARM32
  words invalidate decoded operations and regions. Region discovery treats
  blocks left unscanned by its instruction budget as exits. Otherwise a
  flag-setting branch can enter without settling carry: this broke Lichess's
  P-384 TLS handshake only under JIT. A region-shape fixture and real socket
  replay verified the repair; an isolated function oracle had missed it.
- Host calls exit `run_slice`; guest frames, signal masks, callbacks and
  destructors stay ordered. Releasing a signal frame's call depth before its
  mask let new pthreads inherit a temporary handler mask. ARM32 signal entry
  clears Thumb IT after saving registers. Read `BLX lr`'s target before writing
  LR in both tiers. Wide Thumb fallbacks declare flag dependencies.
- Loader ABI is fixed per process. An opposite-width library lookup fails
  before changing CPU/JNI mode. Android packed APS2 and standard/Android RELR
  tags relocate constructors before init-array collection; missing these
  formats initially stopped Google Maps. ARM32 pointer arguments consume one
  register; an earlier BigInt comparator bridge consumed two.
- Use unsigned native addresses above 2 GiB and full-width `size_t` checks.
  Reclaim TLS/errno/JNI allocations with thread stacks. Preserve open-file
  description semantics for `dup2`; routing by fd number lost Stockfish's
  redirected UCI replies. Bound libc scans; one `memchr` scanned 4 GiB.
- Cut the Rope exposed SIMD/Thumb gaps. VEXT's operand order was reversed by
  an overlapping variable-shift decode predicate, producing infinite Unity
  bounds and corrupt tutorial graphics. Scalar VFP and common wide Thumb
  arithmetic/transfers later used shared JIT owners. Isolated loops improved
  sharply, but visible game samples stayed under 2 GL FPS. A smaller adaptive
  slice budget raised shell ticks while lowering guest rendering and was removed.
- Java Socket TLS is relay-terminated and cannot claim a real pinned chain;
  native Dart TLS verifies real chains against pinned AOSP roots. Socket
  timeout must not consume future bytes. Unknown native services, ioctls and
  relocations fail honestly.
- Cut the Rope's intro extractor reads the unchanged MP4 through
  `AMediaExtractor_setDataSourceCustom`; AVC/AAC decode returns real samples.
  Heap-backed `AMediaFormat_getBuffer` once returned success with null storage
  and now uses promotable direct storage. Chrome consumes about 0.4 seconds of
  the 7.133-second intro before queues fill and Unity stops dequeuing; a larger
  queue reached only about 1.0 seconds. A tap skips it. The stall and black
  video remain unresolved. WebCodecs queues stay bounded; Surface/TextureView
  lifecycle is independent of decoded-frame counts.
- The game's FMOD build selects AAudio, not OpenSL ES. Real 24 kHz mono float
  PCM uses the existing audio scheduler; mute changes output to silence.
  Capture and synchronous AAudio writes remain unsupported.

## App investigations and open limits

- **microG and Resy.** Genuine microG/Companion run as scoped system packages.
  The SDK's sign-in flow returned `authentication: true` in Android and webdroid,
  including after reload. Real FCM checkin, registration, receipt and upstream
  acknowledgement were observed. A five-minute alarm recovered MCS after a
  killed process; this proves delayed recovery, not immediate sticky-service
  semantics or indefinite uptime. PendingIntent/alarm ownership moved to the
  broker, retaining creator UID, filter identity and wall/elapsed timing.
  Resy's embedded Firebase configuration returned HTTP 400 on both platforms;
  the test project's successful receipt does not repair Resy's configuration.
- **Google Maps.** After loader, Parcel, callback, graphics and ABI fixes, the
  unchanged APK rendered real tiles, directions and successive maneuvers.
  ARM64 floating arguments after v0-v7 belong on stack slots, not integer
  registers; fixing that restored native map matrices. Exact screenshot parity
  remains open: reference API 35 cutout/insets differ from webdroid's API 33,
  and text, shadows, vector clipping and selector transitions still differ.
- **ChatGPT.** Guest conversation, settings, attachments, Plugins and reachable
  email/phone forms rendered. Empty camera topology sends no invented callbacks;
  overlays receive their own insets. A forward-only app InputStream falsely
  reported `markSupported=true`, so SVG detection consumed `<s` without valid
  reset; fixing the base stream restored the Study icon. A frozen full matrix
  rendered 183/183 steps, including ChatGPT 24/24, without a required native.
  Authenticated uploads/voice, Visualize's remote icon, general multi-window
  bar arbitration and full visual parity remain unvalidated.
- **TikTok.** Guest consent/feed render; original-rate playback and 150 ms
  actions remain unmet. ByteVC2 A64 `LD2` lane transfers and unsigned-halfword
  `USHL` use shared SIMD JIT paths; fixed kernels agree with the interpreter and
  run faster alone. Live clips select different codecs, so this does not prove
  FPS improvement. The final 183-step matrix rendered TikTok 13/13 with four
  process diagnostics per step, 4.7-8.4 EGL frames/s on active video and a
  1.95 s swipe action. A transient consent timeout with a competing Chrome
  video did not recur on unchanged code; contention is plausible but unproven.
- **Cut the Rope.** The original ARM32 XAPK progressed through early levels,
  audio, persistence and resume; clean Chrome restored level 3 and completed its
  first puzzle. The ARM64 variant shares publisher/version/signature but has a
  different base APK, so it cannot validate ARM32 execution. The AVD's test ad
  blocked a matched later-level replay. Intro playback, startup/render speed,
  Player ID/backend record and later features remain open. TCP connection alone
  does not prove Unity received a player record. The integration matrix rendered
  183/183 steps without a wedge or required native; it did not replay the intro.
- **Lichess and Reddit.** Lichess browsing, offline Stockfish play and native
  TLS were observed, including a stable socket after the region-exit flag fix.
  Later baseline-matched Flutter pthread faults remain visible. Reddit's
  authenticated smoke reached feed, post, comment and composer without
  submitting votes or posts; changing video pixels and nonzero PCM were
  verified separately. This is not complete account-flow coverage.

## Other retained records

- [Performance audit](performance-audit-2026-09.md): paired component measures
  and rejected broad optimizations.
- [Fuzz integration ledger](fuzz-integration.md): fixed baseline, CPU gate,
  retained UTF-16/layout/capture changes and withdrawn experiments.
- [Fuzz code-quality audit](code-quality-audit-2026-09.md) and
  [fuzz harness guide](../scripts/fuzz/README.md): ownership findings and
  runnable differential campaigns.
- [DEX performance architecture](dex-performance-architecture.md): cold/hot
  tiers, OSR, code admission and detailed comparisons.

## TikTok playback and interaction follow-up — 2026-09-22

Fresh full-Chrome profiling reached TikTok's unchanged ByteVC1 and ByteVC2 libraries. ByteVC1's
hottest fallback loops use saturating byte/halfword add, signed-to-unsigned narrowing and rounded
saturating narrowing. ByteVC2's table-based prediction loop uses one- to four-register TBL/TBX.
The A64 JIT now lowers those operations to WebAssembly SIMD and preserves FPSR.Q exactly by
detecting saturation before the sticky flag update. The existing hardware-captured SIMD oracle
covers signed/unsigned saturation, lower/upper narrowing and every implemented table width; the
31 directly affected oracle cases pass with 1,025 assertions. No decoder or APK bytes are changed.

The same session exposed reachable platform gaps before video startup. XmlBlock and its parser
now reuse the resource parser implementation over the binary-XML document; JobInfo and content
URI triggers use the API-33 parcel layout; Debug.MemoryInfo exposes swappable-PSS fields; and the
ImageReader callback interface, MediaDrm byte-array property failure and View.mContext field are
present. Bionic FTS now owns a pre/post-order VFS traversal with child links, sorting, skipping
and balanced storage. The observed platform/API missing set is empty after a fresh launch; nine
remaining probes name optional TikTok, Lynx, vendor and AppsFlyer classes rather than Android APIs.

The view guard no longer allocates an async wrapper for every synchronous virtual draw/measure
call. On an animated Java feed this changed a ten-second sample from 115 presentations with
43.6 ms mean draw time to 596 presentations with 9.3 ms mean draw time. This is a live-content
comparison, not a controlled video-FPS result. Pointer streams retain DOWN and UP while
coalescing queued MOVE events; event timestamps are captured at browser arrival, and native
execution temporarily uses shorter slices after input. A warm timed swipe charged about 249 ms
of total emulator dispatch work; earlier warm three-event sampling charged 82 ms. The requested
universal 150 ms action bound is therefore not established.

Full-Chrome video frames visibly advance with either native JIT enabled or `jit=0`. Some live
YV12 items in both tiers show duplicated green imagery, so the symptom is not attributed to the
new emitter paths; varying remote content prevents a matched pixel conclusion. Syscalls 220
(clone) and 260 (wait4) remain explicit unsupported process-creation boundaries rather than
fabricated success. Surface-frame telemetry now counts every canonical presenter, although this
session's native-window route still did not increment that counter and is not reported as FPS.

The final serialized E2E matrix passed in 1,036.7 seconds. TikTok rendered all 13 steps,
including background resume and two video swipes, with no wedged main loop, settle timeout,
layout/draw error or required native. Its video steps recorded 32–80 canonical surface frames
and 5–16 presented FPS, superseding the earlier interactive session's counter limitation but
confirming that decode throughput remains the dominant constraint. Across all 13 flows, 183
steps completed with no wedge or layout error; the two settle timeouts and seven draw errors
were confined to YouTube's existing smoke-only path.

## TikTok performance integration into main

The branch was merged onto `54e48012`. The resource-parser conflict retains main's SAX
entry point and the branch's native XmlBlock parser; the AOSP XmlBlock delegate remains
available through framework provenance. Main's compact history was kept. A pointer backlog
could replace one tap's UP with the next tap's DOWN; queued input now retains gesture
boundaries and coalesces only consecutive MOVE events, with a focused regression test.

The combined revision passes typecheck, 1,323 unit tests (27,573 assertions), the TikTok
and FitNotes smoke compilers with zero method failures, all eight runnable framework
exercises (295/363 declared natives), and FitNotes text comparison (6/6). TikTok's full
smoke compilation reached 462,058 classes and used over 13 GiB of resident memory; a
single successful run is enough evidence, not a cheap repeatable check.

The serialized E2E matrix completes 183/183 steps in 952.4 seconds. TikTok completes
13/13 with four available process snapshots per step, advancing foreground ticks,
no native requirement, draw/layout error, settle timeout or wedge. The two video samples
present about 14 and 18 surface frames/s; different live clips prevent a controlled
throughput comparison with the branch's 5–16 frames/s samples. Across the matrix there
are no wedges, layout errors or native requirements. YouTube retains two control settle
timeouts and seven Matrix draw errors; 12 Flappy child snapshots remain unavailable.
The corpus renders 20/21 APKs. Amazon crashes before drawing both here and on the exact
pre-merge `54e48012` revision under an isolated replay, so that failure is not attributed
to this integration.

## TikTok video playback follow-up — 2026-09-23

An isolated `codex/tiktok-video-playback` worktree starts at `9a038ff3`. A fresh TikTok-only
headless baseline rendered 13/13 steps; its active feed, resume and two video steps recorded
about 8–12 EGL frames/s. In full Chromium with the Apple GPU, one live clip reached 27.2 EGL
frames/s for ten seconds. The guest feed bypassed both Java MediaCodec and NDK AMediaCodec:
Chrome DevTools and host-call traces show TikTok's unchanged ByteVC1 decoder doing the work,
with EGL presenting its output. Different clips have very different decode costs, so these
samples do not establish a matched FPS improvement.

TikTok's APK also bundles a small HEVC welcome video. MediaExtractor now recognizes `hvcC`
tracks and exposes their Annex B parameter sets and codec string; MediaCodec advertises HEVC
when WebCodecs supports it and handles IRAP key frames. A local full-Chromium check decoded
all 122 samples of that bundled 20-fps asset with their original timestamps and no errors.
This fills a general Android media path but does not accelerate TikTok's ByteVC1 feed.

The A64 JIT now transfers individual vector lanes with scalar memory operations and lowers
widening integer multiplication directly to WebAssembly SIMD extended multiply. A repeatable
20-million-iteration guest lane loop took about 13.4 ms after warmup, versus 13.8 ms before;
the widening multiply loop was effectively unchanged at about 14 ms. The release and safe core
builds shrank by 216 and 214 bytes respectively. The final emitter passed 557 existing A64 SIMD
and hardware oracle tests (18,249 assertions); no new unit tests or visual golden changes were
needed. A focused TikTok capture rendered 13/13 with four process snapshots per step, no new
Android API gaps, required natives, layout/draw errors or wedges. Its two video steps recorded
23.6 and 18.6 EGL frames/s. A separate dense live clip managed only about 6 EGL frames/s and
spent 8.8 of ten seconds in guest native execution. Original-rate playback therefore remains
unresolved for demanding feed videos.

The final serialized E2E matrix rendered 183/183 steps in 958.0 seconds with no wedged main
loop or layout error. TikTok again rendered 13/13 with four available process diagnostics per
step, advancing ticks, zero required natives and no draw error; the two video steps recorded
8.2 and 9.1 EGL frames/s on different live clips. YouTube retained its two previously observed
control settle timeouts and Matrix draw failure. No visual golden was changed. The varying
TikTok FPS confirms that an original-rate playback claim needs a fixed input video and a
substantially faster generic native execution path.

## Fuzzer compatibility follow-up — 2026-09-23

An API 33 fuzzer campaign at 1080×2160 and 480 dpi found no API difference in 1,000
generated cases, but 36 graphics differences in 100 cases with seed `20260923`.
Twenty graphics failures were retained and minimized. The six retained failures from the
preceding graphics campaign were also kept as regression inputs. All oracle comparisons
used unchanged generated commands against Android and browser implementations.

Path circles and ovals now begin separate contours. ColorDrawable uses Android's alpha
modulation, while Paint keeps its API 33 observable narrowed alpha separate from the
opaque raster alpha used for out-of-range `setAlpha` input. TextView bounds clip its
own text and zero-sized child drawing. Canvas preserves translation after singular
transforms, rounds rotation through float32 radians, and tracks rectangular clip
intersections in device space. Bitmap hairlines use the existing pixel raster helper;
reversed full-sweep arcs, empty ovals and zero-extent round rectangles follow the
oracle. The bundled regular Roboto face now matches the API 33 emulator's static face.
These changes use platform geometry and state rather than APK names or command sequences.

All six preceding retained graphics cases and 18 of the 20 new retained cases replay
without a difference. The original 100-case graphics campaign has 20 differences
after the fixes, down from 36. Most residual cases differ in antialiased edge or glyph
coverage. The two remaining minimized cases isolate a small `drawText` glyph and a
one-pixel-high, full-sweep arc; Android Skia and Chrome Canvas2D assign different pixel
coverage. One original case differs at the center by a single alpha-1 pixel on a
transformed stroked path. These are real output differences, not treated as passing
operations. Matching every coverage value would require a general Skia-compatible
raster path; shape-specific pixel substitutions would compromise arbitrary-APK behavior.

The final candidate passes typecheck, the 1,325-test suite (27,577 assertions), fuzzer
smoke, and all declared Canvas, Paint and Path framework delegates (33/33, 86/86 and
43/43). FitNotes and Calculator M fast E2E flows pass 39/39 and 8/8 steps. All these
checks, plus retained and original campaign replays, ran after the final code edits.

## Fuzzer renderer completion — 2026-09-23

The follow-up kept the API 33 oracle and generated commands fixed. The original graphics
seed `20260923` had 20 differences after the preceding repairs. A fresh 100-case seed
`20260924` found 12 more, including antialiased text, inverse paths, non-antialiased
shapes, rotated clip bounds and color emoji under skew. Both full seeds now replay with
0/100 differences. All 38 minimized findings from the two seeds and preceding campaign
replay with no difference. The earlier 1,000-case API seed still had no differences;
these changes do not add API delegates. No APK bytes or visual goldens changed.

Small software bitmaps now use pixel-center coverage for non-antialiased fills and a
four-by-four coverage grid for one-pixel-high antialiased ellipses. Fill-and-stroke joins
are composed as one binary mask when antialiasing is disabled. Inverse winding fills
and positive-width inverse strokes render from their complements; zero-width inverse
strokes stay on the source contour. Hairline paths draw in device space, and rotated
clip bounds scan pixel centers. Pixel-aligned ordinary rectangles bypass the sampling
path. These cases were compared against Android with the same transforms and Paint state.

CanvasKit 0.38 renders eligible default Roboto text in small bitmaps. Android's static
Roboto face, ligatures, malformed surrogate replacement and white-glyph coverage were
matched from direct oracle probes. TextView line-fit decisions use rounded measured
widths, preserving the unrounded width for layout. Noto Color Emoji uses the same font
file as the API 33 emulator (matching SHA-256). Its COLRv1 clip records are read from
the font; transform-dependent clipping accounts for the remaining color-layer edge
differences. This is an empirical raster correction, not a claim of byte-identical
Skia output for every matrix or font. Forty-two targeted emoji probes covering seven
glyphs at sizes 12 and 24 and several skew matrices have no reported difference;
separate rocket probes at sizes 8–32 also pass. The normal
full-screen software draw path remains Canvas2D; CanvasKit text is capped at 250,000
bitmap pixels and starts loading alongside the APK and fonts.

Typecheck, FitNotes and fuzz-probe smoke compilation pass with zero method failures.
Canvas, Paint and Path have 33/33, 86/86 and 43/43 declared native coverage in the
focused framework check. FitNotes text comparison passes 6/6 paragraphs. The serialized
FitNotes and Calculator M runs render 39/39 and 8/8 steps, with no newly missing API,
runtime error, required native, layout error or draw error. FitNotes still has a 39.34%
content pixel difference against its app golden; the fuzzer result does not establish
whole-app visual parity. The existing browser test's Paint-style assertion now checks
visible fill/stroke behavior instead of demanding Chrome's exact glyph raster.

## Fuzzer renderer code-quality review — 2026-09-23

CanvasKit loading now falls back to Canvas2D if the optional renderer fails, so an
asset or Wasm failure cannot abort APK boot. Canvas and TextView now share the same
Paint eligibility check for bitmap text. Typecheck, 14 focused text/fuzz tests and
the deterministic fuzz smoke pass after these changes.

The saved 20-case zero-difference graphics campaign has eight matrix-state differences
if float-backed arrays are compared by exact float32 value. They occur under Android
Skia versus Canvas2D transform arithmetic while the saved pixels match. The current
relative tolerance of `2e-6` classifies them as equivalent; the zero-difference claim
uses that comparison rule. Exact matrix-state parity remains unproven.

The renderer still spreads bitmap-specific Paint checks and offscreen compositing
across `graphics.ts`, which adds 396 lines and removes 54 on this branch and now has
2,782 lines. The CanvasKit text path reads, uploads and composites the full bitmap for
each draw. The color-glyph clip and light-text coverage corrections are empirical. These are
maintainability, performance and arbitrary-transform compatibility limits for a
subsequent renderer consolidation, not evidence of differences in the retained
campaigns.
