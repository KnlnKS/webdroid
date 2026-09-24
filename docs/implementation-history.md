# Implementation history: durable findings

Retained through 2026-09-23. [PLAN.md](../PLAN.md) tracks current status;
[AGENTS.md](../AGENTS.md) owns working rules. Results describe their tested
revision, not necessarily the current tree. Git history preserves intermediate
runs and commit IDs removed here.

## Differential testing and evidence

The default `bun run e2e` fast lane runs all 183 actions across 13 flows. It uses
controlled Android time where behavior permits, state waits and lightweight
semantic evidence; native GL games keep real time. Two five-job all-action runs
passed in 61.2 and 61.9 seconds. Fast visual checkpoints cover eight flows;
other live steps check state or startup. ARM32 Flappy Bird and Doodle Jump
cannot run on the available API-33 ARM64 oracle, so they remain smoke and
motion checks. TikTok and ChatGPT trial launch goldens were discarded because
their Android and webdroid entry states differed and scores varied widely.

A quick pass is not Android visual parity. Parallel frame rates are
informational; use one job for FPS gates. Live missing APIs and errors remain
reported gaps even when the step passes. The full serialized lane retains
pixel captures and all diagnostics. Its 183-step run completed in 964.3 seconds
on the testing-redesign revision, with no wedge or required native. YouTube
retained two settle timeouts and six draw errors. Later integrated full runs
also completed all 183 steps; their YouTube draw counts varied with live
content. A seven-job full stress run caused Lichess native aborts and Resy
timeouts, so it did not establish a valid faster full matrix.

The fast lane first covered only launches, then gained every action. Its early
all-action runs exposed real Resy venue navigation and YouTube pause/resume
failures. Resy now asserts a venue resource and list after Back while closing
repeated offer sheets; YouTube's SAX and Matrix failures were repaired in
platform modules. Lichess's static home needed a 15-frame readiness gate:
20 frames could never arrive. Process diagnostics can initialize after a
child frame, so the harness waits briefly and labels unavailable snapshots
rather than treating them as clean.

Offline scoring requires the flow fingerprint, full capture mode and reference
geometry; a stale capture is rejected. Android recording stages a complete
reference before replacing a golden. The recorder's replacement path was not
exercised against an emulator in that pass. Full-flow definitions once
declared 738 seconds of wait horizons across 13 flows; settle time dominated.
A fast result uses observed state or a bounded sample, so its speed cannot
be compared to a partial launch-only run.

For all claims, inspect each relevant process's diagnostics, advancing
`wd.ticks`, completed presentation, layout/draw/GL errors and required
natives. Empty missing-API telemetry proves only observed-path coverage.
Compare ambiguous faults at matching code, screen, content and settings.
Measure performance in an uncontended visible browser with working rendering;
guest instructions, EGL swaps, framebuffer presentations and decoded video
frames are different counters. Readback and tracing can distort timing.
`settleDelayMs` bounds scheduled work rather than imposing a fixed sleep.

## API-33 differential fuzzing

The unchanged probe runs against an API-33 emulator at 1080×2160, 480 dpi.
An old AVD size/density override initially invalidated graphics comparisons;
setup now applies the active profile and the runner rejects mismatches.
State comparison tolerates only small documented float serialization deltas;
pixels and integer state remain exact.

A 1,000-case API campaign found zero differences, but it exercises seven
explicit recipes rather than the entire SDK. Graphics seeds `20260923` and
`20260924` each replay at 0/100 differences. All 38 retained minimized
findings and 42 focused color-glyph probes also pass. Larger 1,000-case
graphics seeds `20260925` and `20260926` still replay with 58 and 74
differences. The 100-case success does not establish graphics parity. The
larger cases include antialias/glyph coverage, matrix and clip state, and
Porter-Duff edges. The comparator separately reports tolerated float32
state deltas (7 and 14 in the small campaigns; 110 in one larger campaign).

Repairs use platform rules: Matrix skew and float32 transforms; inverse and
reversed Path geometry; device-space clip bounds and bitmap hairlines;
non-AA shape masks; Canvas `SRC_IN` coverage; RenderNode alpha boundaries;
ColorDrawable/Paint alpha; Roboto ligature and line wrapping; and the API-33
emoji font's COLRv1 clip records. The normal full-screen software draw path
remains Canvas2D. Small text bitmaps can use CanvasKit, capped at 250,000
pixels, with Canvas2D fallback if it fails. A direct ClipBox replacement
broke retained emoji cases and was reverted. An axis-aligned clip shortcut
fixed one case but introduced three in large replay and was reverted.
Exact matrix/raster state and arbitrary-transform emoji remain open.

The final small-campaign checks included typecheck, fuzz smoke, zero-failure
probe/FitNotes smoke compilation and focused Canvas/Paint/Path framework
delegates. The larger-campaign repair passed all 1,325 unit tests and replayed
every generated case, not just minimized failures, without adding a newly
failing case relative to either campaign's initial oracle result. No visual
golden changed. [Fuzz guide](../scripts/fuzz/README.md) documents replay and
bundle handling; [fuzz integration ledger](fuzz-integration.md) records the
separate staged audit repairs.

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
- **Play Integrity.** The bundled microG FakeStore APK declares exported classic
  and express IntegrityService bindings, and its bytecode contains the service
  implementations. `GmsClient.apk` has no Play Integrity dependency or request
  path, so no token request, Binder reply or server-verified verdict has been
  observed in webdroid. The existing service/Binder transport is a possible
  route for an unchanged client, not evidence that attestation works. A focused
  client probe should compare the real request's success or error with Android
  before any platform change. No device token or integrity verdict is synthesized.
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


## TikTok native playback and interaction

TikTok runs its bundled ByteVC1/ByteVC2 decoders and EGL path. An observed
FFmpeg stream identified HEVC at 30/1 fps, but feed clips and source rates
change between runs. The active feed did not call Java or NDK MediaCodec;
`libstagefright.so` lookup came from an optional private hook. Nine common
missing-class probes belonged to TikTok, Lynx, vendor and AppsFlyer code,
not required Android APIs. A reachability audit alone did not justify new
platform delegates.

A64 JIT work lowered reached SIMD saturation/narrowing, TBL/TBX, shifts,
FMLA, ST2, PMULL, vector memory and lane transfers. It preserved destination
aliasing, FPSR.Q, upper-half zeroing and interpreter parity. Local direct
calls now stay inside compiled source-page regions; a fixed 6.55-million-call
kernel fell from 34.4 to 22.7–22.8 ms. Fixed decoder capture was stronger
than live-feed timing: 83 unchanged HEVC packets decoded 71 frames with JIT
in 776–785 ms of native work versus 3913 ms without JIT. A second 332-packet
capture decoded 320 frames; later vector-cache and transfer changes gave
small repeated native-time gains on those same bytes. Fixed kernels and
packet captures do not prove live original-rate playback.

Guest-native execution and WebGL `getError` dominated dense live clips.
Skipping GL error queries would alter guest-visible semantics. Guest
`glTex(Sub)Image2D` had passed WebGL a typed view extending to the end of
roughly 4 GiB of memory. Bounding it by unpack alignment, row length,
image height and skips cut measured `getError` work from 718/772 ms to
4/8 ms in same-session phases; the live EGL rates varied with content.
Readback now shares the pixel extent calculation. EGL10 uses a canonical
display handle and rejects invalid displays; EGL11/EGL14 swap intervals
follow the advertised 0–1 range. TikTok did not request a swap interval
in the measured playback run, so that fix has no claimed FPS gain.

One matched 30-fps-header live segment made 268 EGL swaps in nine steady
seconds. Another clean visible Chrome window had final one-second browser
presentation bins of 27–31, averaging 29.7/s. Presentation counts can
include UI redraws, and dense clips still ran below 30 EGL swaps/s in
headless software rendering. Original-rate playback across clips and
150 ms visible action response remain open. A warmed swipe once took
1.95 seconds; keep input completion separate from frame opportunity.

Rejected experiments included native pacing exemptions, smaller/larger
slice budgets, adaptive/no EGL waits, deferred vector writes, preloaded
whole-region vectors and Wasm lane-load substitutions. Some helped fixed
kernels or single live clips but lacked matched end-to-end gain or hurt
other games. No scheduler shortcut remains. Clipboard copying did expose
a real stub: broker-owned serialized clips now cross processes with
foreground UID read checks and main-queue listeners. A copied TikTok URL
did not reopen a stable matching feed clip.

## Cut the Rope native and gameplay work

The unchanged ARM32 XAPK reaches early puzzles, audio, persistence and
resume; ARM64 is a distinct base APK and cannot validate ARM32 execution.
A tapped skip gets past the intro. NDK extraction/AVC/AAC decoding begins,
then the game's output queues fill or the image remains black; larger
queues did not repair it. The game uses AAudio for 24 kHz mono float PCM.
Player ID/backend records and later unlocked features are unvalidated;
a TCP connection alone is not proof of a player record. The AVD's test
interstitial blocked a matched later-level replay.

Reached platform behavior now covers game category/mode/state, pinning
support, selected libc ABI calls, SurfaceTexture transform and Intent's
Parcelable-array overload. Ad-path Cronet and WebView errors were
separate from gameplay. Thumb/JIT repairs cover IT blocks, wide branches,
register-list and indexed transfers, bitfields, VFP scalar memory and
related hot instructions. Compiled IT execution reduced interpreted
dispatch in one eight-second tutorial comparison from 8.7 million to
34 thousand; a later predicated-load kernel fell from 65–71 to 1.5–2.1 ms
per ten million instructions. Source-page epochs and precise faults
still guard compiled code. A generic native frame-aware scheduler improved
paired puzzle presentation from about 4 to 5 frames/s under sustained
background computation; render-thread exemptions now expire after
frame activity stops.

The clean visible Chrome level-one sample presented 434 frames in
12.05 seconds (36.0/s) with advancing ticks and no required gameplay API,
page exception or rendering error, exceeding the 15 FPS target.
A rope swipe advanced the tutorial. A matched headless starting revision
presented 25.3/s, and an intermediate JIT build 27.5/s, but startup timing,
renderer mode and later sample variation limit causal attribution.
The focused flow skipped the intro and Cut has no full-matrix flow.
The integrated 183-step matrix completed without a wedge, required
native, layout or GL error; YouTube's known settle/draw failures remained.
Cut smoke compilation covered 64,465 classes with zero method failures.
