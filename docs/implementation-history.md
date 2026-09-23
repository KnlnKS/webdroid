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

## TikTok native playback throughput — 2026-09-23

An isolated `codex/tiktok-playback` worktree starts at `756491fb`. A fresh TikTok-only baseline
rendered 13/13 steps in 202.0 seconds. Four process diagnostics were available at every step;
none showed a wedged loop, required native, layout error or draw error. Its nine missing-class
probes name optional app, Lynx, vendor and AppsFlyer code, not reached Android APIs.

A three-second live decoder trace counted millions of A64 interpreter exits for SQRSHRUN,
SRSHL, halving add/subtract, absolute difference, rounded shifts, pairwise add, lane MLA/MLS
and interleaved LD2. The JIT now emits general WebAssembly SIMD or lane code for those
operations, retaining destination aliasing, FPSR.Q saturation and zeroed upper halves. The
existing unsigned halfword shift path shares the signed/rounded implementation. A trial of
vector load/store emission slowed a fixed kernel by about 3%, so it was withdrawn. No APK or
bundled library bytecode changed.

Fixed guest kernels improved from about 67 to 7.5 ms per million four-instruction SQRSHRUN
loops and from about 96 to 35–40 ms per million four-instruction SRSHL loops. The complete
A64 SIMD and hardware-oracle check passed 558 tests with 18,253 assertions. TikTok smoke
compiled 462,058 classes with zero method failures. The final focused TikTok replay rendered
13/13 in 204.7 seconds with advancing processes and no new reached Android API gap, required
native, wedge, layout error or draw error.

That replay's feed and two later video steps reached about 8, 9.8 and 10.7 EGL frames/s;
their live media differ from baseline clips, so those values cannot establish a throughput
regression or improvement. A separate ten-second full-Chromium hardware profile reached
23.8 EGL frames/s on another clip and spent 5.19 seconds in native execution. Its hottest
native samples remain in ByteVC1; frequent WebGL `getError` calls also appear in the CPU
profile. Preserving GL error semantics rules out simply skipping those calls. Neither this
profile nor the fixed kernels establish original-rate playback on dense feed videos. No visual
goldens changed.

TikTok logs also report that `libstagefright.so` cannot be opened. The string originates in
TikTok's `libsysoptimizer.so` private MediaCodec hook, which looks for internal ACodec and
MediaCodec symbols. The failed optional hook is not evidence that TikTok's feed requested the
Android MediaCodec API or that fabricating this private library would accelerate playback.

The final serialized E2E matrix rendered 183/183 steps in 976.9 seconds. TikTok rendered
13/13 with four process snapshots at each step, no required native, wedge, settle timeout,
layout error or draw error, and the same nine optional missing classes as the starting run.
Its feed, resume and two later video steps measured 13.5, 13.9, 19.7 and 27.4 EGL frames/s
on different live clips; these are not a matched FPS comparison. No flow wedged or reported
a required native or layout error. YouTube retained its two known control settle timeouts
and recorded nine `Matrix.mapRect` draw errors, versus the earlier reported seven; whether
that count change is due to source timing or code requires a matched reproduction. The four
scored flows rendered all 75 steps; their mean content differences were FitNotes 39.80%,
Mihon app 42.12%, Harmonic 26.99% and Mihon onboarding 9.07%. No visual golden changed.

A later active-video interpreter trace counted about 544,000 vector FMLA and 147,000 ST2
fallbacks in 3.4 seconds inside `libttffmpeg.so`. The A64 JIT now widens f32 pairs to f64 for
the same multiply-add rounding used by the interpreter, then demotes to f32; it also interleaves
ST2 bytes with SIMD shuffles. A six-second trace after those changes found another 174,000
selected-lane vector FMLA fallbacks, now lowered through the shared FMLA emitter. Fixed guest
kernels improved from about 60 to 11 ms per four million vector FMLAs, 68 to 3.8 ms per four
million ST2 stores, and 56 to 10.5 ms per four million selected-lane FMLAs. The full A64 SIMD
and hardware oracle check passed 559 tests with 18,258 assertions. One new test covers the core
ST2 lane-order and writeback behavior at both vector widths.

The follow-up TikTok-only replay rendered 13/13 steps in 207 seconds. Feed, resume, and the two
video steps measured 16.4, 13.3, 19.0, and 16.6 EGL frames/s on live content. Every step had
advancing state, with no new reached Android API gap, required native, wedge, settle timeout,
layout error, or draw error; the same nine optional app/vendor classes were probed. Separate
full-Chromium clips reached 28.5 EGL frames/s and only 3.9–5.1 EGL frames/s. The latter spent
92–95% of wall time in guest native execution, with ByteVC1 still dominant. Source frame rates
and clip identity were unavailable for matched comparison, so original-rate playback remains
unverified and dense clips remain slow. A fixed four-million-operation RBIT loop already took
about 28 ms, so its remaining fallback does not explain the multi-second decoder cost and no
RBIT JIT change was kept.

The final serialized E2E matrix after the FMLA/ST2 changes rendered 183/183 steps in 966.2
seconds. All 13 TikTok steps had four process snapshots, no new reached platform gap, required
native, wedge, settle timeout, layout error or draw error, and the same nine optional probes.
This full run selected a denser clip than the focused replay: feed and resume measured 7.2 and
5.2 EGL frames/s, with 8.6 and 8.2 seconds charged to native execution in those steps. YouTube
retained its two known control settle timeouts and six `Matrix.mapRect` draw errors, versus nine
in the earlier full run. All other flows had zero wedge, settle timeout, layout error and draw
error. The four scored flows rendered all 75 steps; mean content differences were FitNotes
39.80%, Mihon app 42.64%, Harmonic 28.87%, and Mihon onboarding 9.07%. Harmonic's earlier
26.99% mean changed despite zero guest native execution in the final flow, so this native JIT
patch does not explain the difference. No visual golden changed.

BytePlus documents ByteVC1 as HEVC in its [Android encoding parameters](https://docs.byteplus.com/pt/docs/video-editor-sdk/150-android-encoding-and-composition-parameters),
but that label alone does not establish that TikTok's selected bitstream can enter the browser's
HEVC decoder. Chrome reported its 720p HEVC decoder as supported, smooth and power efficient.
Temporary diagnostic counters in all four TikTok process realms recorded no Java MediaCodecList
or `MediaCodecInfo.isHardwareAccelerated` call by the active feed. The counters were removed;
changing that capability flag would not address the observed native decoder path.

A later FFmpeg entry trace showed `mdl://` media handles rather than direct URLs. Reading this
bundled library's `AVFormatContext` and `AVStream` layout from its own instructions, the active
video stream reported codec ID 174 (`hevc` in the library's descriptor table) and average and
nominal rates of 30/1 fps. The audio stream reported AAC. A browser network capture saw only
proxy API/image requests; native relay traffic does not expose the media URL there. These
temporary probes were removed from source and no media implementation was substituted.

A three-second live JIT fallback sample found 24 `PMULL` sites in `libttcrypto.so`, each entered
about 933,000 times. The A64 JIT now computes both `PMULL` and `PMULL2` byte-lane carryless
products with Wasm SIMD. Its existing hardware oracle covers `PMULL`; a focused test covers
upper lanes with a destination alias. A fixed four-million-operation kernel fell from about
164 to 13 ms. TikTok smoke compiled 462,058 classes with zero method failures.

The follow-up TikTok replay rendered 13/13 steps in 194.7 seconds. Feed, resume, second video,
and third video presented at 28, 25, 29, and 25 EGL frames/s on live content. All steps had
advancing state, four process snapshots, no new Android API gap, required native, wedge,
settle timeout, layout error, or draw error; the same nine optional app/vendor class probes
remained. Two separate eight-second browser samples reached 17.1 and 25.3 EGL frames/s, showing
how much live clips vary. A later sample reached 22.3 EGL frames/s and remained concentrated
in the bundled ByteVC1 decoder. A post-change three-second fallback trace found about 57,000
active ByteVC1 `RBIT` fallbacks; the millions of HEIF color-conversion fallbacks had accumulated
during setup and did not advance in the measured video window. The remaining playback gap is
not explained by a similarly frequent unsupported decoder instruction. The 30 fps source rate
and 25–29 fps focused playback show that original-rate presentation is not yet consistent.

The final serialized E2E matrix for the PMULL change rendered 183/183 steps in 957.8 seconds.
TikTok rendered 13/13 with four process snapshots per step, no new reached platform API gap,
required native, wedge, settle timeout, layout error, or draw error, and the same nine optional
class probes. Its feed, resume, second video, and third video steps measured 23, 19, 31, and
21 EGL frames/s on another selection of live clips; the HEVC stream sampled separately reported
30/1 fps. YouTube retained its two known control settle timeouts and six `Matrix.mapRect` draw
errors, matching the previous full run. All other flows had zero wedge, settle timeout, layout
error, draw error, and required native. The four scored flows rendered all 75 steps; their mean
content differences were FitNotes 39.80%, Mihon app 41.94%, Harmonic 27.79%, and Mihon
onboarding 9.07%. The score changes on live content do not establish native playback effects.
No visual golden changed. The final A64 SIMD and hardware-oracle check passed 560 tests with
18,261 assertions, including the new PMULL2 alias case.

A later fixed ByteVC1-style loop with 11 widening-multiply/EXT operations and a changing
lane load ran 500,000 iterations in about 1.7–2.0 ms under the current JIT. This isolated
kernel omits the decoder's control flow and does not predict live frame rate. It initially gave
no evidence for caching vector writes across blocks. A narrower JIT change later cached SIMD
register reads within a block while writing every result through to memory. On the same fixed
kernel, the median fell from about 1.8 to 1.6 ms per 500,000 iterations. All 581 A64 and SIMD
oracle checks passed (18,450 assertions). The following TikTok-only replay rendered 13/13 steps
in 199.7 seconds, with no new platform API gap, required native, wedge, settle timeout, layout
error, or draw error. Its two video steps reached 6.5 and 20.1 EGL frames/s on different live
clips, so this does not establish an end-to-end FPS gain. A further experiment deferring vector
writes until block exit slowed the fixed loop to about 2.1 ms and was removed.

The bundled FFmpeg stream observed during the earlier probe identified HEVC video at 30/1 fps.
Tracing ByteVC1's frame-ready flag and picture-order counter during a separate live 20-second
sample counted 554 distinct decoded pictures versus 440 EGL swaps; counts include playback
looping and cannot alone identify a compositor fault. A 300,000-instruction slice budget
increased UI tick frequency but reduced native throughput on a different clip. A six-million
budget also failed to improve its separate live sample. A temporary adaptive EGL-swap delay
raised swaps but lowered sampled screen presentations; it was removed. A follow-up full removal
of the swap wait likewise showed no gain in an advancing 30-second clip (sampled EGL 7.1 versus
7.6 fps, screen presentations 8.7 versus 9.2 fps) and was removed. Repeatable source media is
still needed to attribute the remaining presentation gap.

A post-cache 12-second full-Chromium sample presented 293 EGL swaps and 274 completed screen
frames while spending 5.93 seconds in native execution. Native slice samples still cluster in
ByteVC1's widening SIMD arithmetic and lane loads. Chromium's CPU profile also shows repeated
`glGetError` driver calls, but skipping them would change GLES error behavior; no shortcut was
kept. Chrome DevTools MCP could not attach because its shared profile was already locked; the
existing CDP harness collected this profile instead.
Another eight-second playback probe observed 7,073 JNI `GetStringUTFChars` calls but 5,473
distinct values; only one value had substantial reuse. Caching returned string buffers would
add ownership and lifetime complexity for little measured benefit, so no JNI change was kept.
TikTok smoke compilation after the vector-read cache compiled 462,058 classes with zero method
failures. The final full E2E matrix remains pending because original-rate playback is not yet
consistent.
Two further generic JIT variants were tested against the same ByteVC1-style loop and removed.
Preserving vector-read locals across lane loads showed no repeatable gain over the committed
cache, and replacing the low-address high-word test with a 64-bit comparison was slightly
slower. Neither justified the added state or changed emission. Chrome DevTools MCP remained
locked to its existing profile; the CDP harness still supplied native and Chromium CPU samples.

A temporary native dispatcher probe identified `ByteVC1_send_packet` calls and captured 360
unchanged HEVC packets from one live TikTok clip. Starting at the packet with VPS/SPS/PPS and
an IDR frame, a headless harness drove the bundled decoder's `send_packet`/`get_frame` API:
83 packets yielded 71 frames at 576×1024 with no decoder warning. The first three production
JIT runs spent 776–785 ms in native execution; disabling JIT took 3913 ms on the same bytes.
The capture and harness are ignored local diagnostics, not shipped media or an app substitute.
Native worker scheduling varied between runs, so small timing differences need matched trials.

The fixed decoder workload rejected three further generic experiments. Keeping vector reads
across GPR instructions or updating cached vectors after lane loads yielded no repeatable gain;
the combined version's median native time was about 808 ms. Preloading read-only vector
operands for a whole JIT region preserved all 71 decoded frames but raised a representative
loop median from 1.74 to 1.82 ms and did not reliably improve the full decoder run. A deferred
vector-write cache also slowed that loop from about 1.6 to 2.1 ms. All were removed. Smaller
native slice budgets and bounded batches of waking guest threads sometimes shortened the
headless decoder run, but live TikTok samples did not show more EGL swaps; the three-million
instruction budget reached 317 swaps in a fresh 12-second sample. Different feed clips prevent
a causal FPS comparison. Those scheduling variants were removed. No additional required
Android API was observed. Chrome DevTools MCP still reported its shared profile locked; the
project's CDP harness supplied the live counters.

TikTok's Share → Copy link exposed a real `ClipboardManager` stub: writes vanished and reads
always returned empty. A broker-owned Parcel copy now shares clips between processes while
foreground UID rules guard reads; primary-clip listeners are delivered on each process's main
queue. The unchanged TikTok app copied a `vt.tiktok.com` URL and read it back through
`getPrimaryClip` with a timestamp. The URL resolved to a specific video ID, but a clean VIEW
intent replay showed a different feed creator after 30 seconds, so it did not provide a
matched playback fixture. A separate fixed ByteVC1 capture of 332 HEVC packets decoded 320
576×1024 frames with 2.49 billion guest instructions in 2.80 seconds native; the slower live
clip spent 8.65 billion guest instructions in 12 seconds while presenting 69 EGL frames.
The different clips and possible background decoder work prevent dividing these figures into
a reliable per-frame cost comparison. The framework delegate runner could not run in this
worktree because `vendor/aosp/framework.jar` was absent. Chrome DevTools MCP later attached,
but its trace session navigated away from the manually booted guest, so timed playback still
used the project's CDP harness.

The next serialized TikTok-only E2E replay rendered 13/13 steps. Its steady second- and
third-video steps presented 17.1 and 13.1 EGL frames/s, despite UI frame counters of 33 and
32 frames/s. Their source rates were not captured; a separate observed stream was 30 fps.
No layout/draw error or required native appeared. The only new missing class in the final
step was ByteDance's optional `MagpieBridge`; earlier optional vendor classes remained.
The full multi-app E2E matrix remains reserved for the final candidate.

Disassembly and a temporary return-site probe traced hot ByteVC1 call sites to NEON pixel
kernels with chains of 64-bit transposes. The A64 JIT now masks each 64-bit vector result's
upper half to zero, keeps the full result in a local vector register, and shares the store path
with 128-bit results. A fixed 24-instruction transpose loop dropped from about 5.68 to 3.25
ms per 500,000 iterations. All 560 A64 SIMD/oracle tests passed (18,261 assertions), and
the unchanged 332-packet ByteVC1 capture decoded 320 frames in each run. In three clean,
uncontended runs, candidate native time was 2,683–2,694 ms versus 2,707–2,792 ms baseline;
the medians were 2,691 and 2,752 ms. The gain is small at decoder scale.

A stray old decoder benchmark from the same worktree was found using almost a full CPU core
during one live candidate sample and a focused replay. It was stopped; those rates are only
functional checks. An uncontended 12.09-second full-Chromium candidate sample presented 167
EGL swaps (13.8/s), spent 6.20 seconds in guest native work, and had advancing ticks with no
required native or rendering error. Its active decoder was ByteVC2, unlike the fixed ByteVC1
capture, so this is not a matched speed comparison. A temporary probe during a later ByteVC2
clip resolved indirect calls to pixel kernels at library offsets 0x5b6c8 and 0x5c278. Both
use interleaved vector loads, lane copies, byte extraction and widening multiply/accumulate.
The diagnostic hook was removed. A separate ByteVC1 clip reached 30 EGL swaps/s, illustrating
the variation between live feed items; their source cadences were not captured.

The A64 JIT now uses one WebAssembly SIMD load/store for 128-bit guest vector transfers and
`v128.load64_zero` for 64-bit vector loads. The superseded scalar branches were removed. All
560 A64 SIMD/oracle checks passed. In an uncontended three-run comparison on the unchanged
332-packet ByteVC1 capture, median native time fell from 2,597 to 2,536 ms; a second candidate
group measured 2,553–2,579 ms. Each run decoded 320 frames. TikTok-only E2E rendered 13/13
steps with no required native or layout, draw or GLES error. A separate 12.14-second hardware
sample used a demanding ByteVC1 clip, presented 148 EGL swaps (12.2/s), and spent 10.43
seconds in guest native execution across 10.17 billion guest instructions. The clip's source
cadence was not captured.

The vector cache initially discarded a destination before every SIMD instruction, forcing
widening multiply-accumulate chains to reload their prior result from memory. Keeping that
cached value until an instruction writes the destination without updating the cache passed all
560 SIMD/oracle checks. Two paired fixed-decoder comparisons decoded the same 320 frames and
measured candidate medians of 2,554 and 2,545 ms against baseline medians of 2,665 and 2,671
ms. A short synthetic SIMD loop did not show the same gain, so the full decoder capture is the
better evidence for this change. The following TikTok-only replay rendered 13/13 steps, with
17.6 and 21.1 EGL swaps/s on different clips, four process diagnostics per video step, and no
required native or rendering error. Live source rates remain unknown; the final multi-app E2E
matrix is still pending.

Chrome DevTools inspected a fresh guest, but that session showed TikTok's unstable-network
screen and no video relay on its top-page network target. A separate browser relay probe found
that the native player sends TLS itself, leaving video headers encrypted at the WebSocket
boundary. Neither supplied a stable clip or source-frame timestamps. A shorter 64-bit vector
zeroing sequence was also tried and removed because paired decoder and kernel timings did not
show a reliable gain.

Doubling the per-region instruction cap from 320 to 640 preserved more straight-line native
decoder work in each compiled region. Two uncontended paired comparisons on the same 332
ByteVC1 packets decoded 320 frames each time. Candidate native medians were 2,459 and 2,424
ms, against 2,530 and 2,546 ms with the old cap; region counts fell from 1,240 to about 1,220.
The A64 SIMD, oracle and cache checks passed (573 tests), and the next TikTok-only replay
rendered 13/13 steps without a required native or rendering error. Its video steps presented
17.5 and 6.3 EGL swaps/s on different clips. The latter used 3.19 of 6.86 seconds in native
execution, so its low rate cannot be attributed solely to native CPU time. Source FPS was
not captured.

A full-Chromium hardware sample on another live ByteVC2 clip presented 134 EGL swaps in 12.05
seconds while spending 6.76 seconds in native execution. Its native profile reached bitstream
routines containing A64 `RBIT` and `REV`, which still fell back to the interpreter. The JIT now
lowers the full bit/byte reversal and leading-sign-count family for 32 and 64 bit registers.
Existing interpreter/JIT parity checks passed (25 A64 tests, 2,229 assertions). A fixed
one-million-iteration bit-reversal loop fell from roughly 27–30 to 16–18 ms. The captured
ByteVC1 decoder showed no reliable whole-decoder gain, and no fixed ByteVC2 capture was
available. A fresh TikTok-only replay rendered 13/13 steps, with 21.9 and 9.8 EGL swaps/s on
different clips, advancing main ticks, four available process diagnostics per video step,
and no required native, layout, draw or GLES error. The first feed step in that replay had no
EGL swaps, despite later videos playing. Original-rate playback remains unverified and the
final full E2E matrix is pending.

A 1,280-instruction region cap did not reduce the fixed decoder's 1,219 compiled-region count
further, and timing during that trial overlapped another checkout's heavy Chromium run; the
640 cap remains. The existing carry test's far branch was lengthened to exercise the new 640
instruction boundary and passed. A separate attempt to retain the SIMD saturated-narrow result
for its FPSR Q check and destination removed eight source lines and passed all 560 SIMD/oracle
checks, but paired fixed-decoder timings changed direction across groups under intermittent
host contention. The isolated narrow kernel showed no clear gain. That attempt was removed.

A later Chrome DevTools MCP guest reached the For You feed but displayed a loading frame with
zero EGL swaps. Its log reported HTTP 429 on a TikTok configuration request; the active native
profile was dominated by `libmetasec_ov.so`, not the decoder. A short DevTools performance trace
could not be exported because its result exceeded the tool's string limit. That browser session
therefore supplies no playback-rate evidence and was closed before further timing.

The A64 JIT now keeps cached vector values across vector memory stores and uses WebAssembly
lane stores directly for 8-, 16-, 32- and 64-bit lanes. Loads and interpreter fallbacks still
invalidate the cache. An existing broad SIMD/oracle matrix passed all 560 cases (18,261
assertions), and a focused cache parity case checks successive lane stores after different
vector writes. A repeated interleaved-store kernel improved from about 3.76 to 3.49 ms per
million iterations in one quiet comparison; a simple duplicate-and-lane-store loop was
effectively unchanged. The fixed ByteVC1 decoder decoded 320 frames in each paired run with
only a small, noisy aggregate timing difference. A fresh TikTok-only replay rendered 13/13
steps with four process diagnostics, advancing ticks and no required native, JIT, layout, draw
or GLES error. Its two active video steps presented 17.0 and 22.7 EGL swaps/s on different
live clips; their original frame rates remain unknown.

Native bionic and raw A64/ARM syscalls previously returned PID 4242 and thread IDs derived
from it, while Java and the process broker used PID 1000 or a child PID. The CPU state now
shares the Java process and thread identity; pthread handles, `getpid`, `gettid`, `tgkill`,
`capget` and `setsid` use the same guest-visible IDs. The native CPU's separate internal ID
still owns mutexes. Focused A64/ARM, procfs and memory checks passed 102 tests; a new A64
syscall check covers the guest-visible IDs. TikTok smoke compiled 462,058 classes with zero
method failures. The following TikTok-only replay rendered 13/13 steps in 195.6 seconds,
with four process diagnostics and no required native, wedge, settle timeout, layout, draw or
GLES error. Monitor probes moved from `/proc/4242` to the real guest `/proc/1000`, confirming
the corrected identity; the unimplemented per-process stat and smaps files still fail to open.
The two active video steps made 13.0 and 14.0 EGL swaps/s while native execution consumed
5.6/6.4 and 5.1/6.6 seconds respectively. Live clip differences prevent an FPS comparison.

Java's process UID also differed from bionic's hardcoded 10123 and the virtual file owner.
Native UID/GID and passwd metadata now use the package UID, and `/proc/<pid>/status` exposes
the known process identity and CPU affinity. It omits memory and CPU accounting fields that
this runtime cannot measure, so the separate stat/smaps probes remain unsupported. Focused
libc, stdio and procfs tests passed (13 cases). The following TikTok-only replay rendered
13/13 steps in 203.3 seconds with four process diagnostics, advancing main ticks and no
required native, wedge, settle timeout, layout, draw or GLES error. The monitor's prior
`/proc/1000/status` open errors disappeared; its stat/smaps probes remain unsupported. Two
active video steps presented 14.4 and 16.4 EGL swaps/s on different live clips while native
execution took 4.9/6.4 and 4.7/6.4 seconds. This is not evidence of an FPS improvement.

The libc wrapper and raw syscall had separate `sysinfo` writers. The former reported the
configured 2 GiB, wrote a 112-byte struct even for ARM32, and set `procs` to 64; the latter
reported 4 GiB with a 64-byte ARM32 struct. Both routes now share one ABI-aware writer using
the configured device RAM. A focused test verifies 32/64-bit RAM and struct bounds; 26 libc
and A64 checks pass. The following TikTok-only replay rendered 13/13 steps in 206.6 seconds,
with all four process diagnostics available, advancing ticks, and no required native, wedge,
settle timeout, layout, draw or GLES error. Its two active video steps presented 17.2 and
20.2 EGL swaps/s on different clips, with 4.1/6.5 and 4.7/6.5 seconds spent in guest native
execution. Their source cadences were not captured, so this does not prove original-rate
playback.

A temporary native entry trap captured 48 unchanged ByteVC2 packets (68 KiB) from one live
clip. A headless harness drove the bundled decoder's public API with those same packet bytes
and produced 42 frames at 576×1024, with no decoder error. After removing the trap, three
uncontended runs spent 829–1,044 ms in native execution and retired 228.4 million guest
instructions each. This relatively light clip does not reproduce the hardest live playback
case, but it now provides a fixed ByteVC2 correctness and timing fixture. The trap was removed
from production source; capture and harness remain ignored local diagnostics.

Live native samples attributed over 93% of their top execution sites to the bundled FFmpeg
or ByteVC2 decoder, depending on the feed clip. A temporary fallback counter observed 36.0
million JIT interpreter handoffs over 12 seconds on one ByteVC2 clip. Disassembly identified
repeated narrowing shifts, pairwise minima, widening pairwise sums, absolute differences, and
32-bit saturated adds/subtracts in the decoder's pixel loops. The A64 JIT now lowers those
operations generically, using a byte shuffle for byte-aligned plain narrowing shifts. A
hardware-oracle and core sweep passed 563 SIMD tests; focused checks cover the shift's two
destination halves and inactive-lane saturation/accumulation semantics. Temporary fallback
instrumentation was removed from the production core.

On the same captured 48-packet ByteVC2 input, fallback calls fell from 3.82 million to 0.35
million. In a quiet matched comparison, three uninstrumented decoder runs spent 823–840 ms at
the starting JIT and 760–768 ms with the new lowerings; each decoded all 42 frames and retired
228.4 million guest instructions. Runs made beside another CPU-heavy Chromium workload took
longer and were excluded from the timing comparison. A TikTok-only replay rendered 13/13 steps
in 200.4 seconds with no required native, wedge, settle timeout, layout, draw or GLES error.
Its active video steps presented 18.6 and 21.9 EGL swaps/s on two live clips while native execution
consumed 4.8 of roughly 5.5 seconds per step. The clips differ from earlier runs and their
source FPS is unknown; original-rate playback is therefore still unproved. A separate Chrome
DevTools browser reached the For You screen but remained on a loading spinner despite successful
CDN TLS handshakes and advancing guest ticks, so it supplied no video cadence evidence.

An earlier fixed ByteVC1 capture supplies 83 valid packets that decode 71 frames through the
bundled library. Replaying the preceding 277 captured packets from a fresh decoder reports
missing parameter sets and produces no additional frames, so the 360 packets cannot be timed
as one continuous valid clip. A temporary fallback counter found just 3,583 interpreter
handoffs during the 71-frame replay, compared with roughly 349 million guest instructions.
The dense ByteVC1 playback limit is therefore in compiled guest execution, not a large set
of missing SIMD JIT lowerings on this captured path. The counter was removed. A longer fixed
ByteVC1 replay of 332 packets decoded 320 frames in roughly 2.6 seconds native time and
retired 2.49 billion guest instructions. A temporary host timing probe measured about 19 ms
inside 177,942 host callbacks during one replay, so host callback bodies were not the decoder
bottleneck; the probe was removed. A raw HEVC stream assembled from those packets reports a
nominal 30 fps in its header, but has no presentation timestamps for a live FPS comparison.

The remaining fixed ByteVC2 fallbacks included rounded accumulating shifts and unsigned
saturating immediate shifts in pixel loops. The JIT now lowers both using WebAssembly SIMD,
including FPSR.Q updates and inactive-lane masking. Existing AArch64 hardware oracle cases
for `SRSRA`, `URSRA` and `UQSHL` pass; a focused test checks that inactive upper lanes do not
set Q. The 48-packet capture still decodes 42 frames and its interpreter handoffs fell from
354,125 to 258,461. Two three-run quiet groups measured candidate native times of 768–776 ms
against a baseline group of 769–785 ms. The small timing difference does not establish an
end-to-end playback gain. Later runs overlapped another CPU-heavy Chromium process and were
excluded from timing comparisons.

On a separate active ByteVC1 clip, a 12.01-second full-Chromium profile recorded 342 EGL
swaps (28.5/s), 1,284 software view-tree draws (107/s), 2.27 seconds drawing, and 5.15
seconds native execution. Chrome's `requestAnimationFrame` ran near 120 Hz although the
guest `Display` and `Display.Mode` both advertised 60 Hz. The virtual display now paces both
process realms at its reported 60 Hz and supplies the same interval to `Choreographer` and
the display deadline API. Synthetic 10-second rAF streams at 60, 75, 90, 120 and 144 Hz
each admitted 600 guest frames. A later 12.02-second ByteVC1 sample recorded 360 EGL swaps
(30.0/s), 357 software draws, 0.56 seconds drawing, and 4.83 seconds native execution.
These are different live clips, and the later sample overlapped another CPU-heavy browser;
the draw reduction is consistent with pacing, but the FPS difference is not a matched gain.
Chrome DevTools MCP reached the feed and briefly decoded frames after a tap; its trace then
landed on an idle page and did not provide a steady playback profile.

After frame pacing, TikTok-only E2E rendered 13/13 steps in 194.6 seconds without a required
native, newly reached Android API, settle timeout, wedge, layout, draw or GLES error. The
video steps presented 88 and 93 EGL swaps in 6.40 and 6.37 seconds; native work used 4.64
and 5.65 seconds. The clips were different from the browser profile. A diagnostic attempt to
capture live packet presentation timestamps failed because an old ignored hook script expected
a removed core watch API, so original frame cadence remains unknown.

The final serialized E2E matrix on this candidate rendered 183/183 steps in 960.4 seconds.
TikTok rendered 13/13 with four process diagnostics per step, advancing main ticks, no newly
reached platform API, required native, wedge, settle timeout, layout, draw or GLES error. Its
two steady video steps presented 111 EGL swaps in 6.36 seconds (17.4/s) and 121 in 6.48
seconds (18.7/s), while native execution used 4.76 and 4.88 seconds respectively. The nine
missing classes at TikTok launch remain optional app/vendor probes. All other flows rendered;
YouTube retained its two known control settle timeouts and six `Matrix.mapRect` draw errors.
No other flow reported a wedge, settle timeout, required native, layout, draw or GLES error.
The four scored flows had mean content differences of 39.80% FitNotes, 42.13% Mihon app,
31.31% Harmonic and 9.07% Mihon onboarding. Live content and unpaired clips limit score and
FPS comparisons. Visual goldens were not changed.

A further generic SIMD lowering compiles signed and unsigned widening across-lane sums and
32-bit `SQRSHL`, including saturation flags and inactive-lane behavior. On the same 48-packet
ByteVC2 input, the hundred most frequent interpreter handoff sites fell from 258,444 to
194,394 calls; all 42 frames still decoded. Quiet native timings changed from 769–776 ms to
762–766 ms, too little to establish a playback gain. A uniform-shift specialization was
rejected after it increased process CPU time. The updated TikTok-only replay rendered 13/13
steps with no newly reached platform gap, required native, wedge, settle timeout, or rendering
error. Its active video steps made 18.5 and 19.2 EGL swaps/s on different live clips.

A temporary dual-decoder hook then captured 503 ByteVC1 HEVC packets on one live clip while
recording EGL swaps. Its SPS VUI states 30/1 fps, and a steady 9.00-second interval contained
268 EGL swaps (29.8/s) with video packets arriving at roughly 30/s. This demonstrates
original-rate presentation for that observed segment, not for the denser clips that still
render below 30/s. The hook was removed after the capture; the packet data stays in the
ignored diagnostic directory. The full matrix must be repeated after the final candidate is
frozen.

The SIMD JIT had separate saturation checks and result writes that recomputed every narrowed
vector. Sharing the shifted value and narrowed result removes that duplicate work. The core
build shrank by 205 bytes in release mode and 224 in safe mode. All 566 SIMD and hardware
oracle cases passed. A fixed 332-packet ByteVC1 capture decoded all 320 frames in every
comparison; three baseline runs used 2.63–2.68 seconds native time, and three candidate runs
used 2.56–2.61 seconds. The TikTok-only browser run rendered 13/13 steps without new platform
API gaps, required natives, a wedge, or rendering errors. Its two video steps presented 133
EGL swaps in 6.39 seconds and 44 in 6.35 seconds on different live clips. The latter spent
2.8 seconds in native execution; its source rate and remaining idle time need diagnosis before
attributing the low EGL count to decoder throughput.

One later-feed 15-second diagnostic sample submitted 406 ByteVC1 packets and made 430 EGL
swaps, averaging 28.6 swaps/s; source timestamps were unavailable. A 30-second run swiped
through several live clips while capturing both counters. On two clips whose HEVC SPS VUI
reported 30/1 fps, steady five-and-a-half-second windows made 26.8 and 27.6 EGL swaps/s,
while their packet ingress averaged 32.3 and 33.3/s. Another clip made 20.5 EGL swaps/s and
received 22.7 packets/s, but its stream header was not captured. The first sample had native
execution for 5.8 of 15 seconds; the multi-clip sample had 13.2 of 30 seconds. Variable
packet arrival, swipes, and missing presentation timestamps prevent a firm distinction
between variable-rate sources, buffering, and decoder backpressure. All diagnostic hooks were
removed, and the clean core was rebuilt afterward.

The one-second bins narrow that limit: after each swipe, EGL output rose over roughly three
seconds; both 30-fps-header clips then reached 29–30 swaps/s while receiving about 30
packets/s. Averaging over a whole swipe window understates steady playback rate. This does
not establish that every TikTok source plays at its original cadence, since some low-rate
focused E2E clips lack matched source timing.

The final frozen-code matrix rendered 183/183 steps across 13 flows in 959.2 seconds. TikTok
rendered 13/13 with four available process diagnostics at every step, advancing guest ticks,
and no new Android API, required native, wedge, settle timeout, layout/draw error, or GLES
error. Its two live video steps presented 88 EGL swaps in 6.43 seconds (13.7/s) and 86 in
6.47 seconds (13.3/s), with 4.97 and 4.92 seconds spent in native execution. Their source
cadences were not captured, so these samples cannot be called original-rate playback. The
nine missing classes at launch remain optional app/vendor probes. Every other flow rendered;
YouTube retained its two control settle timeouts and eight `Matrix.mapRect` draw failures
versus six on the previous full run. Flappy Bird's child-process diagnostics were unavailable
at 12 steps. There were no wedges, required natives, or layout errors anywhere. Mean content
differences were 39.80% FitNotes, 42.45% Mihon app, 27.63% Harmonic, and 9.07% Mihon
onboarding. Live content and unmatched clips prevent causal FPS or score comparisons, and no
goldens changed.

A further ten-second TikTok decoder profile attributed 2.0 of 2.28 billion retired guest
instructions to four native `pthread` decoder workers, each doing 471–537 million instructions.
They currently share one JavaScript process realm and therefore execute serially. A separate
clip made about 237,000 host calls in ten seconds; temporary per-call timing attributed about
0.59 seconds to the sampled frequent host bodies, including 0.42 seconds in repeated SQLite
`stat`/`open` probes of one journal. Those calls are not enough to explain the roughly five
seconds of native execution per sample. The timing and path probes were removed.

The virtual device reports four CPUs through native `sysconf`, Android `Os.sysconf`, and
`/proc/cpuinfo`, but Java `Runtime.availableProcessors()` had reported the host browser's
hardware-concurrency count. It now uses the same device profile. A focused TikTok replay
rendered 13/13 without new platform gaps, native requirements, wedges, timeouts, or rendering
errors. Its first feed displayed a swipe tutorial until interaction; later live clips differed,
so their EGL counts cannot establish a playback gain. A fixed 320-frame ByteVC1 comparison
with a temporary one-core virtual profile retired the same 2.49 billion instructions and showed
no repeatable speedup versus four cores; that profile change was rejected. The Wasm core can
compile and instantiate with shared memory, and Bun can clone that memory to a worker, but the
current browser page is not cross-origin isolated. Parallel guest execution would also need
per-worker JIT tables and synchronization of host calls and core state; no such change is shipped.

A standalone Chromium page with COOP/COEP headers was cross-origin isolated. It cloned shared
`WebAssembly.Memory` into a worker, instantiated the shared-memory core there with a local
table, and observed a worker write in the page's buffer. This confirms the browser primitive,
not safe concurrent guest execution. The app server and runtime still use unshared memory.

The fixed 332-packet ByteVC1 capture decoded 320 frames and retired 2.49 billion guest
instructions at each JIT threshold. Three runs at the current 48-hit threshold took
2.66–2.69 seconds native time. At 16 hits, 86 extra regions compiled and the runs took
2.72–2.84 seconds. At 96 hits, 46 fewer regions compiled but the runs ranged from 2.63 to
2.78 seconds. Both threshold changes were rejected. A temporary mutex probe found about
85,000 state-2 unlocks, nearly all with queued waiters; bypassing their host wakeup would
break pthread behavior. The probes and experimental core edits were removed.

A ten-second full-Chromium TikTok profile showed 2,367 Wasm, 2,010 runtime JavaScript, and
1,258 guest-Java samples among 6,826 CPU samples. The runtime's `RandomAccessFile` growth
appeared in 106 samples: each extension had copied the entire prior file. The file now keeps
geometric capacity while its visible `Uint8Array`, VFS entry and file-channel size reflect only
the logical length. It updates mapped-buffer storage when reallocating. An explicit VFS
directory now avoids the descendant key scan. In three fixed 1 MiB, 1,024-write runs, the old
RAF path took 28.5–29.0 ms and the new path 1.00–1.03 ms. Existing file-channel and descriptor
tests passed (19 cases), TypeScript typecheck passed, and TikTok smoke compilation had zero
method failures. A fresh uncontended TikTok-only run rendered 13/13, with four available
process diagnostics per step, no new platform missing API, required native, wedge, settle
timeout, or layout/draw error. Two different live clips made 18.7 and 22.1 EGL swaps/s; their
source cadence was not captured, so original-rate playback remains unresolved.

A temporary core probe recorded decoder entry times without replacing guest decoder code.
During one 20-second ByteVC1 playback segment, 594 compressed packets reached the decoder,
414 EGL swaps occurred, and native execution used about 10.0 seconds. Four successive roughly
five-second windows recorded 130/43, 151/99, 142/123 and 139/124 packets/swaps. Thus the
initial fill accounts for much of the low whole-window average, while the later windows still
presented about 26 swaps/s against about 29 packets/s. These packets lack source presentation
timestamps and may not map one-to-one to frames; the comparison does not establish source FPS
or a decoder backlog. The temporary probe and its second JIT fallback range were removed, and
the ordinary release/safe core was rebuilt.

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
