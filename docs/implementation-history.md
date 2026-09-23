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
