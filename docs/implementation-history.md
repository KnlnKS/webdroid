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

## Cut the Rope FPS follow-up — 2026-09-23

The isolated `codex/cut-the-rope-fps` worktree starts at `756491fb`. Full Chrome runs the
unchanged ARM32 XAPK at 1080×2160, 480 dpi through its splash and intro skip to the level-one
tutorial. The game draws, accepts a rope swipe, advances the puzzle and reports no uncaught
gameplay or rendering error. Smoke compilation covers 64,465 classes with zero method failures.

The reached `ShortcutManager.getPinnedShortcuts()` call now returns an empty list on this
device, whose launcher reports pinning unsupported. The game service uses manifest
`ApplicationInfo.category` and `FLAG_IS_GAME`; `GameManager.getGameMode()` reports standard mode
for games, and `GameState` retains the Android constructors, getters and Parcel layout. Before
`GameState`, Unity's state callback raised `NoClassDefFoundError`; after registration it runs
without that exception. Remaining `NativeActivity` class probing is optional in this path.
`VideoView`, `DialogFragment` and Parcelable errors appear in ad SDK paths, which this pass
does not implement.

A compiled Thumb entry reached during ITSTATE interpretation was reheated and requested for
JIT compilation repeatedly. Gating heat on an empty slot reduced one eight-second gameplay
window from 6,122 regions and 244 ms of JIT work to later windows of 78–737 regions and
3–18 ms. Matched gameplay FPS remained variable, so this is a compilation and memory fix,
not an independently proven FPS gain.

Steady level-one profiling showed roughly 500–650 million native guest instructions and
7.4–8.0 seconds in native execution per eight wall seconds. WebGL calls themselves consumed
under 2.5 ms in a five-second sample. A sustained native worker used about 170–215 million
guest instructions per eight seconds while UnityMain and AAudio also ran. Native pthreads
share one browser JavaScript thread, so the worker competed with frame production. A generic
cooperative cap now cools sustained budget-exhausting work while EGL frames are presented;
render-thread ancestors and real-time audio stay responsive, and pending signals end the wait.
On the same visible puzzle, alternating eight-second capped windows presented 37, 45 and 41
frames versus 32, 31 and 36 with the busy worker temporarily exempted: about 5.0 versus
4.0 frames/s. The original intro still stalls after early decoded samples and needs a tap to
skip; gameplay FPS remains low. The cap was checked by typecheck and owning CPU/AAudio tests.

The final serialized E2E matrix rendered 183/183 steps in 966.3 seconds with no main-loop
wedge, layout error, GL error or required native API. Every step has a screenshot and process
record. YouTube retained two control settle timeouts and eight instances of its existing
`Matrix.mapRect` draw failure; 12 Flappy Bird child snapshots were unavailable as in the
previous matrix. Its page-status error and Lichess's Flutter pthread fault also remain visible.
The matrix does not contain a Cut the Rope flow; the separate visible Chrome puzzle and swipe
above are the focused acceptance evidence. No visual golden was changed.

Further CPU profiling of the level-one tutorial in headless Chrome mapped the main Wasm
sample cluster to `arm.execThumb`; 1,069 of 5,386 samples were in that interpreter function.
Temporary dispatch counters showed that about 8.6 million of 8.7 million interpreted
dispatches in one eight-second window arrived with Thumb IT state active. A Unity helper
repeatedly executes three-instruction IT blocks, and the existing JIT only fused a few
single-instruction moves. The new generic path scans a complete IT block, executes it with
the existing ARM interpreter through one compiled-region call, checks its source-page epoch,
and resumes compiled code when the guest PC reaches the expected end. Branch, fault and
instruction-count exits retain their guest state; temporary counters were removed afterward.

Two fresh headless Chrome runs at the same geometry and tutorial timing, with diagnostic
counters and an eight-second CPU sample, presented 243 frames before and 266 after the change.
Interpreted dispatch fell from 8.7 million to 34 thousand, while guest instructions executed
rose from 1.56 to 1.77 billion in the window. This indicates higher guest throughput; the
headless FPS difference alone is not a stable visible-Chrome estimate. With counters removed,
another Cut run presented 221 frames in eight seconds and a rope swipe produced the three-star
level completion, with advancing ticks, no page exception, GL error or draw error. Its
unimplemented Cronet call was in an ad network thread and did not stop the game. The ARM and
CPU tests pass (94 tests), and typecheck includes both Wasm builds. A repeat on the exact
committed core also completed the level without page, GL or draw errors, presenting 159 frames
in eight seconds; this spread limits the FPS claim.

The final serialized E2E matrix after the IT-block change rendered all 183 steps in 966.7
seconds. All main process diagnostics reported `ok` and advanced ticks. There was no main-loop
wedge, layout error, GL error or required native call. YouTube retained two control settle
timeouts and six recorded `Matrix.mapRect` draw errors across process snapshots, versus eight
in the prior matrix. Its live content and other app/vendor missing APIs remain variable.
Twelve Flappy Bird auxiliary WebView snapshots were unavailable, as before; all seven screen
steps rendered. Lichess still reported Flutter pthread faults, and Flappy Bird retained its
page-status error. No visual golden was changed. Cut the Rope is absent from this matrix, so
the focused level completion above is its gameplay evidence.

A follow-up trace of the stalled intro found an active surface-free AVC decoder with seven raw
output buffers queued while Unity repeatedly polled for input and stopped dequeuing output.
Larger codec capacities and a compressed-input backlog did not restore playback; both trials
were removed. The observed non-ad `NativeActivity` lookup remains an optional class probe,
while WebView, Cronet and related errors arose in ad paths. No new required gameplay native
call was observed.

A fresh level-one CPU sample mapped a hot Unity decompression loop to a Thumb IT block with a
predicated post-index byte load, shift and move. The existing compiled IT path still called
the interpreter for each body instruction. A generic JIT path now lowers those simple complete
blocks directly and keeps conditional writeback, IT flags and precise load faults. A repeated
10-million-instruction microbenchmark fell from about 65–71 ms to 1.5–2.1 ms for this kernel.
The ARM interpreter/JIT parity test covers taken and skipped conditions plus a compiled null
load. Typecheck and 76 focused ARM tests pass, and the unchanged XAPK smoke-compiles 64,465
classes with zero method failures. A Cut run with this path reached level one and advanced
after a rope swipe without draw or GL errors. Its immediate post-transition ten-second window
presented 90 frames; a prior warmed clean run presented 122, so these windows do not establish
an end-to-end FPS change. Two attempts to capture a later warmed window stalled in startup or
screen readback, with ad WebView errors present. The isolated kernel gain is repeatable, but
the overall gameplay FPS effect is still unmeasured.

The final serialized E2E matrix on `86cf0f4` rendered 183/183 steps across 13 flows in
968.8 seconds. All available process snapshots reported `ok`, with advancing main ticks;
no main loop wedged, GL failure or required native call appeared. YouTube retained two
control settle timeouts and its `Matrix.mapRect` draw error, observed in 16 process snapshots
in this run; the count has varied with live content. Flappy Bird again lacked 12 auxiliary
snapshots and logged its page-status error while all seven steps rendered. Lichess retained
its Flutter pthread errors. No visual golden was changed.

The strict maintainability review found three overlapping Thumb IT body decoders, a permanent
render-lineage exemption for native CPU pacing, game metadata applied only to the current
package, and an unread `GameManager` state field. The JIT now uses one IT block decoder for
scan and emission, retaining interpreter fallback for unsupported bodies and adding direct
lowering for a multi-instruction block containing a wide move. The CPU scheduler timestamps
actual frame activity and expires a renderer's pacing exemption after 500 ms without a frame.
PackageManager's own and registered-package queries now use the same manifest-derived game
category and flag. `setGameState` still rejects null but no longer stores a value with no
observable reader. These changes are generic platform/runtime behavior; the game's bytecode
and assets are unchanged. They landed as `b2dbda3c`, `a61938e4` and `55e5d6ca`.

Typecheck, 76 focused ARM tests, 20 CPU/AAudio tests and the new package game-info contract
test pass. The original Cut XAPK smoke-compiles 64,465 classes with zero method failures. A
fresh headless Chrome Cut run at 1080×2160, 480 dpi reached visible level one and advanced
to the next tutorial after a rope swipe, without layout, draw or GL errors. Its warm 12-second
window presented 184 frames, with advancing native execution. This was one uncontrolled run,
so it does not establish an end-to-end FPS improvement over the prior JIT build.

The final serialized E2E gate rendered 183/183 steps across 13 flows in 958.6 seconds. No
main-loop wedge, required native call, layout error or GL error appeared. YouTube retained
two control settle timeouts and seven `Matrix.mapRect` draw errors; Flappy Bird again had 12
unavailable auxiliary snapshots while rendering all seven steps. Lichess's Flutter pthread
fault and Flappy Bird's page-status error remain. The Cut gameplay run above is the direct
game acceptance check because the matrix has no Cut flow. No visual golden was changed.
