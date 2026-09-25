# Implementation history: durable findings

Retained through 2026-09-24. [PLAN.md](../PLAN.md) tracks current status;
[AGENTS.md](../AGENTS.md) owns working rules. Results describe their tested
revision, not necessarily the current tree. Git history preserves intermediate
runs and commit IDs removed here.

## Differential testing and evidence

The UI branch's quality review found two reproducible state/identity defects: a late
development package listing could reveal the selector after an app started, and full
capture fingerprints ignored `webdroidAction` changes. Package availability now derives
from session state, including late arrivals. Browser runners resolve action/wait overrides
once and fingerprint that execution plan; Android reference fingerprints exclude browser
overrides. Browser probes covered loading, recoverable failure, running and reload-required
failure. Existing harness tests cover execution fingerprints and geometry normalization.

Capture geometry now requires a status inset after legacy-manifest normalization. The
Android recorder measures the default display's API-33 inset source and compares dimensions
separately from explicit inset requirements. Immediate reads after `wm density` reproduced
a transient 36dp result: the density had changed to 320dpi while SystemUI still reported
its previous 72px bar. Waiting for the existing screenshot-settle condition before reading
metadata produced 24dp at both 1080×2160@480 and 720×1280@320 on the reference emulator.
No Android goldens were rewritten. Coverage geometry identities also retain the inset.

Verification passed typecheck, production build and five existing harness tests. Serialized
fast and full FitNotes/Calculator runs each completed all 47 steps with no timeout, wedge,
missing API, required native or runtime error; process diagnostics were available throughout.
Full fingerprints matched the captures and rejected modified browser actions. Full content
diffs remained 39.36% and 13.86%, respectively; these checks do not establish pixel parity.

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

The semantic UI journal now hashes visible text and coarse control positions: two Compose
screens with the same actionable nodes no longer share tried actions or replay
paths. A separate structural scroll-family key limits repeated swipes across
changing list content. This still cannot guarantee a stable replay when content
changes between launches, and the 256-state cap bounds feeds with unbounded
text variation. The v2 journal uses a new filename to preserve older evidence.
Android oracle episodes reset rotation before launch and restore the previous
system settings at close. The UI runner now makes exploration versus exact
replay an explicit mode. microG attestation opt-in is passed to provisioning at
boot rather than read at module import; default behavior remains unchanged.

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
  path. The open-source [SPIC v1.4.0 release APK](https://github.com/herzhenr/spic-android/releases/tag/v1.4.0) (`com.henrikherzig.playintegritychecker`,
  SHA-256 `a9b0036ed4b78b486fcd957fc7038d441cd6e896961ffb6b1bccfd7f03b3e471`)
  does call `IntegrityManager.requestIntegrityToken` with a locally generated
  nonce. It smoke-compiled with zero method failures. On the API-33 Google APIs
  emulator, pressing **Make Play Integrity Request** returned
  `CANNOT_BIND_TO_SERVICE (-9)`; that run is an error-path oracle, not a
  successful-token reference. Webdroid initially failed while attaching Compose:
  `AndroidUiFrameClock` read `MonotonicFrameClock.Key` from an interface default
  method before the interface was initialized. The compiler's self-static-field
  shortcut skipped that initialization, passing a null key to
  `ContinuationInterceptor.minusKey`. Initializing the interface on static-field
  access, inheriting defaults onto interface prototypes for `invoke-super`, and
  implementing the platform's non-null View inspection map, ComponentCallbacks2
  hierarchy and RenderNode position methods let the unchanged UI render and
  complete its request callback.

  With `?attestation=1`, microG's attestation setting is enabled through its
  bundled ProvisionService. Applying that setting globally made the unchanged
  ChatGPT fast flow stall at launch (9 failed checkpoints versus zero at the
  starting commit); leaving ordinary launches unprovisioned restored 24/24.
  Under the opt-in,
  the request traversed Play Core's Binder call, FakeStore IntegrityService and
  DroidGuard, downloaded a signed VM response from Google's anti-abuse endpoint,
  and posted to `play-fe.googleapis.com/fdfe/integrity`. DroidGuard's snapshot
  returned an empty byte array; the service reported no Google auth token, and
  Google's endpoint returned HTTP 500 with `DF-DFERH-01`. The app displayed
  `INTERNAL_ERROR (-100)`. Adding the manifest-backed `PackageInfo.sharedUserId`
  removed one missing-field diagnostic but did not change the empty DroidGuard
  result or server response. The remaining `ServiceManager` and
  `persistent_data_block` probes were caught by microG; their causal role in the
  empty result is unproved. No device token or verdict is synthesized. A Play
  Store-equipped Android oracle with a working SPIC request is needed to separate
  microG/server limitations from webdroid's DroidGuard environment. The frozen
  full matrix after these platform changes rendered 185/185 steps and averaged
  27.62% content difference on scored flows. Matched starting-commit runs
  reproduced Harmonic's ~98.5% strict pixel score and Flappy Bird's 27–30 fps
  slow-motion flags; those observations are not attributed to this change.
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

## Deployment transport and local package loading

The first Cloudflare Git build of `webdroid` completed from the private GitHub repository with Bun 1.4.0 and a checksum-pinned Linux Zig/Android SDK bootstrap. The hosted frontend loaded without console errors and its framework resource and font requests returned 200. FitNotes loaded from a local APK, rendered its first-run dialogs and reached its home screen. Deployed DNS and HTTP proxy requests returned 200, and the TCP WebSocket relay carried an HTTP request to `httpbin.org:80` and returned `HTTP/1.1 200 OK`. A second Git-connected Worker deployed the isolated WebView renderer with a binding to the main Worker's Durable Object namespace. A renderer `/webview-call` request returned through a WebSocket session opened on the main Worker, and Harmonic booted from a local APK and rendered a live article inside an iframe on the renderer hostname. These checks cover the observed paths, not arbitrary APK compatibility. The account had no Zero Trust organization; selecting Access during Worker creation did not protect the `workers.dev` URL. The free Zero Trust onboarding required a payment card and acceptance of billing terms. The production URL is public at the user's direction; preview URLs are disabled.

The first deployed Harmonic WebView run briefly rendered article HTML, then reached its offline page. Wrangler's esbuild had inserted `__name` calls into functions serialized by `toString()` for the frame injection, without defining that helper inside the frame. The frame logged `ReferenceError: __name is not defined`; the injection now defines the helper in its own scope. The second renderer hostname under the same `workers.dev` account subdomain still shared a Chromium site and event loop with the parent. Its synchronous `/webview-call` blocked the parent WebSocket reply and returned 504. Moving the renderer to `webdroid-renderer.pages.dev` gave the iframe a separate site. A deployed Pages Function returned through the main Worker's Durable Object session (HTTP 200), and Harmonic's article stayed rendered past the former timeout. The old Worker was disconnected from Git and has no active routes.

The first Pages Git build compiled and uploaded the complete 156 MB emulator output, though its functions only need the WebView/proxy modules. A Pages deployment with only `pages-renderer/index.html` and the shared Functions bundle served `/webview` and returned 410 for an absent bridge session. The first Git build with that output failed to bundle Functions because omitting the build command also omitted dependency installation (`eslint-scope` was unresolved). With `bun install --frozen-lockfile`, the same Git commit deployed successfully in 34 seconds; `/webview` returned 200, an absent bridge session returned 410, and a live callback returned through the main Worker's WebSocket session. Pages no longer rebuilds or uploads the main app a second time. The main Worker Git build of that commit also completed successfully. A later Pages route audit found its catchall also exposed the main Worker's unrelated TCP and DNS handlers. The renderer now forwards only WebView routes; `/dns` and `/tcp` returned 404 while Harmonic's article and the callback bridge still worked.

Cloudflare static assets omit `Content-Length` on local HEAD responses and may ignore a range probe. `RangeFile.open` now uses a range probe when HEAD lacks a length, then falls back to a resident file only when the asset server returns a full 200 response. This was needed for bundled font files. The system package blobs are stored as gzip files that Android expects decoded for entry reads but raw for archive span reconstruction. A Worker route serves them with `Content-Encoding: gzip` by default and raw for `?raw=1`; `encodeBody: "manual"` avoids compressing already compressed bytes again.

The prior WebView script transform imported the TypeScript compiler at server startup. Its Node filesystem probe fails in Workers at `__filename`, so the transform now uses Acorn and ESLint's scope analyzer. Existing WebView location, history and HTML tests pass against the replacement. The Worker asset build includes AOSP framework files only when `WEBDROID_INCLUDE_AOSP=1`, then chunks files above Cloudflare's per-file limit and streams them on demand.

The local package path reads browser `File` slices, preserves the established split merge and base precedence, and serves `/asset/` requests from the active install through the service worker, including the isolated renderer's message port. FitNotes APK and ChatGPT XAPK booted in a local Wrangler browser run, and a FitNotes asset was fetched through the service worker. The HTTP proxy, DNS endpoint and Durable Object callback bridge responded locally. The outbound TCP socket relay opened in local Wrangler, but a complete TCP response was not observed there; the environment intermittently reported `Network connection lost`. The later deployed-edge request to `httpbin.org:80` returned an HTTP 200 response.

The serialized 13-flow, 185-step full capture on the development server rendered every step. All emulated processes reported no required native code, layout/draw/GL errors or main-loop wedge; main-process ticks advanced. YouTube's `show-controls` step timed out settling, as it also did at the starting commit. Flappy Bird's ad WebView frame lacked harness diagnostics and logged the same `status` error in the starting checkout; the game process rendered all seven steps. The capture does not validate deployed Worker TCP behavior.

The deployment review found that lazy asset-pack splits overwrote base entries while resident splits kept first-wins precedence. Merge now applies first-wins to either storage mode, with an overlapping split fixture. Local asset requests now address the requesting service-worker client; a local Wrangler browser check fetched the same asset from the main page and an isolated renderer frame. Launches are serialized, with the prior asset session restored if boot fails. Bun and Worker bridges share the request/reply state machine and reject replies from another peer; local Worker and dev-server roundtrips passed. AOSP provenance assets are now an explicit build option instead of depending on ignored files present in the checkout.

## Production package launch and game probes

A local Wrangler production build now boots a selected APK/XAPK directly, hides display-size controls after boot, and serves the ReleaseFast native core as a 346,575-byte Wasm asset instead of a 462,159-byte base64 JavaScript chunk. Bun's `--production` already minified JavaScript; the build now spells out `--minify`. The favicon was reduced from 792,162 to 42,579 bytes at 256 px. These two asset changes remove about 0.86 MB from the distribution while preserving the native bytes and icon appearance at favicon size. The production loader was exercised in Chromium, including local FitNotes and the two requested games.

Among Us XAPK initially stopped on `NoSuchMethodError android.os.Handler$Callback.doFrame(long)`: its Unity bridge creates one proxy for `Handler.Callback` and `Choreographer.FrameCallback`. Production omits the optional AOSP declaration jar, and both interface markers lacked method declarations, so the proxy's fallback assigned `doFrame` to its first interface. Registering the two Android interface methods made the proxy's declaring classes unambiguous. The same local production run then reached the game's privacy prompt with 328 draws and 1,013 advancing shell ticks over 25 seconds, zero observed missing APIs or native requirements, and no uncaught exception. Repeated browser taps at the prompt did not advance it. A trace after lazy DEX method compilation confirmed both press and release reach `UnityPlayer.onTouchEvent`; the press also reached `injectEvent`. The visual stall cannot be attributed to a missing browser release. Play Core reported asset-pack error -5, and Unity logged three `fork` failures; gameplay is unverified.

Subway Surfers APK reached its Unity activity and drew four frames, but a Google account sign-in overlay appeared and Unity logged two EGL config errors. A Firebase background thread also reported a missing DataStore preferences file. Dismissing the overlay left page evaluation and screenshot capture unresponsive by about 21 seconds. The same wedge occurred with `?jit=0`, so it was not isolated to compiled native regions. With the overlay untouched, evaluation remained responsive at 22 seconds but ticks stayed at 72. The production startup observations for FitNotes, Calculator M, and Flappy Bird were 6, 2, and 317 draws after eight seconds with advancing ticks and no main-process missing API/native requirement; Flappy Bird still emitted ad WebView errors. These spot checks do not prove complete app flows or per-process diagnostic coverage.

The starting revision likewise wedged after dismissing Subway Surfers' Google overlay; its screenshot capture timed out after 30 seconds and Unity reported `Notification.EXTRA_TITLE` missing. The changed build supplies API-33 Notification extras for JNI lookups and `ActivityInfo.targetActivity` for package metadata. A diagnostic native instruction slice of 300 kept the page responsive and produced hundreds of frames, but the Unity loading screen remained at 4% after 40 seconds, with Firebase Installations token failures and optional API probes in its background process. A scheduler-yield experiment did not resolve normal-slice responsiveness and was reverted. Gameplay remains unverified; the observed freeze is not a new regression from this patch.

The changed checkout's serialized full development-server capture rendered all 185 steps across 13 flows in 1,023 seconds, with no main-loop wedge, required native code, or layout/draw/GL errors in the aggregate. YouTube had four settle timeouts. Harmonic's later screen stopped changing and Flappy Bird ran at about 26–29 fps; matched starting-revision runs showed the same symptoms. Empty telemetry on a step establishes observed-path coverage only, and the full capture does not validate game flows or Worker deployment.

After the final package metadata and notification changes, a serialized fast capture reached 9 of 13 flow checkpoints. ChatGPT, Lichess, and YouTube timed out or missed later live targets; Doodle Jump's title step fell below its retained frame-rate limit at 27.2 presented fps. A same-settings Doodle Jump run on the starting revision failed the same step at 26.7 presented fps. The full capture above passed before the final metadata fields; the fast result should not be reported as an all-pass regression gate.

Subway Surfers' post-sign-in wedge came from its Firebase MessageProcessingThread calling `inotify_init` and `inotify_add_watch`, then repeatedly reading descriptor zero after both native calls were absent. The descriptor implementation now delivers VFS write events through inotify, including raw syscall entry points; the same production build passed the earlier loading stall, the age and privacy prompts, and reached active gameplay. A fresh run showed 1,151 draws at the start screen and 1,557 draws after the score reached 43, with advancing ticks and no observed native requirement or native fault. `NotificationChannel` DND preference accessors cover a separate observed API miss. A Firebase background thread still terminates on a `FileNotFoundException` for its first-run `firebase_session_..._settings.preferences_pb` file, but this did not stop the observed run. The thrown type and missing file are consistent with the current `FileInputStream` behavior; whether Firebase should catch or create it remains unresolved. Fifteen optional Firebase/GMS class probes referenced modules not present in the APK; they are recorded by the diagnostic `missing` set even though no platform API implementation can supply those third-party modules. Ad SDK network errors were excluded by the task.

Among Us used `Fragment.startActivityForResult` for Google account sign-in; routing the result back to the calling fragment let Cancel and Continue return to the main menu. Native `getifaddrs` now exposes the loopback interface and `WifiManager` supplies multicast locks, removing observed Local Play failures. The game's Local Play path created a responsive lobby. The Skeld practice scene first faulted at an uncommitted 32 MiB native memory plane during Unity asset loading, with the same fault under `?jit=0`. Moving the general plane-pool boundary from 2.5 GiB to 2 GiB gave large contiguous mappings room in the otherwise unused lower virtual range. A fresh production run then rendered the practice map, player, and task list; holding the virtual joystick moved the player and changed the map view, without an observed native fault or missing API. This is one scene and one movement sample, not a full game or online multiplayer pass. Play Core still logged asset-delivery error -5 while the bundled XAPK asset pack loaded for practice; Google account authentication and remote asset delivery remain unverified.

The final local production build also rendered FitNotes' first-run dialog, Flappy Bird's title screen, and Calculator M's keypad after browser file upload. Their respective draw counts after eight seconds were 6, 323, and 2, with advancing ticks, no main-process missing API or native requirement, and no native fault. Among Us and Subway Surfers smoke compilation each reported zero method failures, and the 1,357-test suite passed. The standard E2E driver cannot validate this static production bundle because it boots samples by requesting `/apks/...` URLs; the bundle deliberately omits those files, and an attempted Resy run received HTTP 404 on its APK. These manual browser samples do not replace the development-server full E2E matrix.

The changes were pushed to `main` and deployed to the public Worker. A fresh browser file upload on that URL ran Subway Surfers past the age and privacy prompts, through the title screen, and into a run with score 43; 1,940 draws and advancing ticks were observed, with hidden resolution controls and no native fault or required native API. Another fresh browser upload ran Among Us through privacy, Google sign-in cancellation, the Google Play account error, and a subsequent temporary-account connection error. Dismissing those dialogs exposed Play and Practice; The Skeld loaded with a player and task list, reached 7,022 draws with advancing ticks, and joystick input shifted the map. No missing API or native fault was observed on that path. The live Epic Online Services request to `api.epicgames.dev` failed through the TCP relay with connect error 111 after synthetic DNS resolution; no online authentication or multiplayer success is claimed. The native macOS file chooser in the automated Chrome session kept its Open button disabled even for an HTML file, so an experiment removing the chooser's extension filter was reverted; browser file uploads through Playwright and drag/drop remained functional in the verified flows.

## 2026-09-24 — Package-first browser shell

The shell now leads with a keyboard-accessible package picker and drop area, with device presets and custom dimensions inside a disclosure. Responsive sizing measures the available stage and bezel rather than subtracting a fixed sidebar from the viewport. Narrow screens scroll and put a running device first. The empty screen is DOM content outside the framebuffer; navigation has consistent SVG icons, accessible names and 44px targets. Pointer-only press/disclosure feedback uses CSS transforms and opacity and respects reduced motion. There are no new dependencies or frame-loop hooks.

Markup moved to `index.html`, styles to `src/shell/ui.css`, and shell interactions, profile configuration and fitting to `src/shell/ui.ts`; `src/main.ts` is 169 lines shorter. Loading states use actual startup callbacks and preserve the selected filename. Error details are expandable, while optional/runtime diagnostics remain available separately. A retry retains the original package only before app runtime initialization; later failures and opening another app require a fresh page because the JVM's first-loaded class definitions survive in the current realm. Home removes development autostart, and applying settings clears a URL screen override so it cannot silently defeat the chosen profile.

Typechecking, the existing 1,357-test suite, production build and Worker deployment dry run passed. FitNotes, Calculator M, Flappy Bird and Among Us smoke compilation each reported zero method failures. A serialized full capture of FitNotes (39 steps), Calculator M (8) and Flappy Bird (7) rendered 54/54 steps with no settle timeouts or wedged main loop. FitNotes and Calculator M had clean process diagnostics. A matched capture against starting commit `8f1fb148`, using the same harness, inputs and screen profiles on a separate port, produced byte-identical PNGs for every FitNotes and Calculator M step (content differences against Android remained 39.34% and 13.83%). Flappy Bird reproduced the same `Cannot read properties of undefined (reading 'status')` browser error and unavailable auxiliary-frame diagnostics on both revisions; its main process had no missing API, required native API, layout, draw or GL error. These captures do not establish original Android performance or replace the full 13-flow matrix. Goldens were unchanged.

Browser checks covered 320px and 390px layouts, desktop rendering, keyboard file selection, reduced-motion emulation, custom-profile validation/reset, retry after an invalid ZIP, and fresh-session recovery after a damaged manifest. The local production Worker opened Among Us from its unchanged XAPK into its landscape privacy prompt, with advancing frames and no main-process missing or required native API; Unity logs still included language initialization and unimplemented process-fork errors. No agreement was accepted and no gameplay or online compatibility claim is made here. A temporary APKS container holding the unchanged FitNotes APK also rendered its first-run dialog. The Chrome DevTools MCP profile was already occupied and the Chrome browser connector was unavailable, so interactive checks used the in-app browser and its Chrome DevTools Protocol support. Native OS file dragging was not independently exercised; the picker and drop paths share package validation. The local Worker preview uses an isolated persistence directory after a rebuild hit a shared SQLite lock. This work has not been pushed or deployed.

The follow-up restores the original globe/Android logo in the header, hides the package selector after launch, and keeps runtime errors inside Diagnostics without an alert banner. Home restores the picker in a fresh session. The gesture indicator and its canvas cache were removed; Android navigation insets and window backgrounds retain their existing semantics. Back and Home remain the host navigation controls. Obsolete running-picker styles and button branches were deleted.

Follow-up verification passed typechecking, the production build, six existing window-context tests, and Calculator M smoke compilation with zero method failures. Its serialized eight-step full capture rendered every step with no timeout, wedge, or process diagnostic errors. Seven frames differ from the preceding capture only at the removed gesture indicator; the second digit-entry frame also differs at two content pixels. Android goldens are unchanged. The local production browser check confirmed the original logo, hidden running selector, and Home recovery. A temporary injected error reached Diagnostics without showing the notice; Home cleared that verification session. Chrome DevTools MCP remained unavailable because its profile was occupied, so browser verification used the in-app browser's CDP support. No deployment was performed.

### Centered upload and status-bar-free display

The shell uses a blue accent matching the original logo and a centered upload column. The phone appears only once launch succeeds; loading and recovery remain in that column. The unused empty-phone markup and styling were removed. Display fitting skips a hidden stage and runs when it becomes visible, preserving the canvas contents when framebuffer dimensions are unchanged.

The device profile now reserves zero status-bar height, and root insets report that bar as unavailable even when an app requests it. Clock, battery and Wi-Fi drawing and their caches were removed. Apps lay out into the released space through the existing shared device metrics; no APK-specific adjustment or image crop is involved.

Typechecking, production build, all 1,357 existing tests, and FitNotes smoke compilation passed with zero method failures. The serialized FitNotes/Calculator M capture rendered 47/47 steps without timeout, wedge, missing APIs, required native APIs, or process diagnostic errors. Calculator reached `7 + 7 = 14`. This is not a clean FitNotes semantic pass: the retained Android flow taps Create New Exercise at y=96, now the lower boundary of its [0,96] toolbar, and subsequent steps diverge. Clicking the visible toolbar button in a separate browser run opened the creation form. Android comparisons now include the intentional geometry change (FitNotes 57.67%, Calculator M 14.34% content difference); goldens and recorded coordinates were not changed. Desktop and 390px production checks verified the blue centered upload screen, hidden phone during loading/failure, successful phone reveal, removed status bar, no horizontal overflow, and Home recovery. Chrome DevTools MCP still reported an occupied profile; interactive verification used the in-app browser and CDP. Not pushed or deployed.

The FitNotes flow now supplies Webdroid capture actions at the observed field and toolbar centers. A shared optional `webdroidAction` applies to both browser capture modes; Android recording retains `action`, and live `fastAction` keeps precedence. Coverage fingerprints include browser actions while Android-reference fingerprints omit them. The existing fingerprint test covers that distinction; no new test file was added.

The full and quick FitNotes runs each completed all 39 actions with no coordinate fallback, timeout, wedge, missing API, required native API, or process diagnostic errors. Both final UI trees contain Barbell Curl sets 60×10 and 65×8 and the new Chest exercise Webdroid Press with sets 40×12 and 45×10. Typechecking and the existing coverage tests passed. The quick run still fails its retained visual gate (49.73% versus 22%); full mean content difference is 57.94%. These are functional capture results, not Android visual parity. Reference coordinates, crops, goldens and visual thresholds remain unchanged.

### Reference capture geometry after status-bar removal

The failing quick visual gate compared different app viewports: the Android reference reserved a 24dp status bar while the new browser default reserved none. A diagnostic alignment of FitNotes' content origin reduced the final checkpoint difference from 49.73% to 17.83%, identifying the offset rather than a new drawing failure. The fix matches layout geometry before rendering instead of shifting or rescaling screenshots. Reference profiles now carry a status-bar inset (24dp for the existing manifests), pass it through the browser URL and child processes, and record it in run.json. Full and quick scoring reject mismatched insets. The ordinary browser profile remains at zero and has no restored status icons. FitNotes field taps were measured in the reference profile; redundant toolbar overrides were removed. A core geometry test covers legacy reference profiles, explicit zero insets and mismatched comparisons.

The final serialized quick pass completed both flows: FitNotes 39 steps with a 17.83% home checkpoint difference against its unchanged 22% limit, and Calculator M 8 steps with 5.16% against its unchanged 10% limit. A preceding pass also passed both gates. The serialized full capture rendered 47/47 steps with no coordinate fallback, timeout, wedge, missing API, required native API, or process diagnostic errors, including child processes configured with the same inset. Its mean content differences remain 39.36% for FitNotes and 13.86% for Calculator M; passing the selected checkpoints does not establish pixel parity for every screen. Typechecking, production build and all 1,358 tests passed. A normal-profile local production upload rendered Calculator without the status bar. Goldens, masks, crops and thresholds were unchanged. Not pushed or deployed.

### Centered running device and direct dimensions

Successful launch now hides the session card and intro, leaving a centered device. Loading and failure details remain available before launch. Diagnostics occupy a fixed disclosure without shifting the device, and the running app name remains in the canvas accessible label. The profile selector and its conditional form logic were removed; width, height and density inputs are directly available with native validation, Apply and Reset.

The running stage uses the viewport height. Display fitting measures the actual bezel, safe-area padding and navigation height instead of reserving a fixed outer margin. Mobile portrait and short touch landscape layouts remove the bezel and fill the viewport while preserving the app framebuffer's aspect ratio. The WebView layer remains aligned with the scaled canvas, and Home/Back stay outside the app surface.

Typechecking and production build passed. The serialized quick FitNotes and Calculator M flows completed 47/47 steps and passed both retained visual checkpoints, with no coordinate fallback, timeout, wedge or process diagnostic errors. Production browser checks verified exact desktop centering at 1280×720, a 390×844 mobile frame with no page overflow, touch landscape at 844×390, and app-requested landscape resizing. Invalid width zero was rejected; applying 720×1280@320 persisted the dimensions and Reset restored the defaults. A temporary diagnostic error remained accessible without moving the phone or covering navigation; Home cleared that session. Viewport and touch emulation were restored. These are browser-emulated mobile checks, not physical-device safe-area measurements. No new tests or dependencies were added. Not pushed or deployed.

### Fifteen-app open-source compatibility corpus

The pinned APK list, hashes, first-launch diagnostics and feature-level limits are in [compatibility-corpus.md](compatibility-corpus.md). The first scan gave frames for thirteen apps and initially crashed Aegis and Thunderbird. Subsequent shared API and constructor fixes made all fifteen draw a frame. Optional `androidx.window` OEM extension and sidecar provider probes remain absent as they are on devices without those providers. Frame counts and missing-call lists only cover executed paths.

Aegis's selected Password radio button was painted checked from XML, while `RadioGroup.checkedId` stayed `-1`. Its `SecurityPickerSlide.isFinished()` checks `getCheckedRadioButtonId()`, so Next silently stopped. The group now discovers the initial checked child and synchronizes later radio changes. After password entry, its unchanged bytecode reached `Character.codePointAt(char[],int,int)`, `Charset.encode(CharBuffer)`, `ResourceBundle.Control` and `java.security.Permission`. The corresponding Java/Android behavior now lets its bundled zxcvbn and Bouncy Castle code derive the key. AOSP `core-oj.jar` confirmed the permission name field and resource-bundle control shape; the app's own DEX showed the call sequence. The transition into the main screen used a layout animation resource, now parsed and scheduled through shared animation and ViewGroup paths. A password-protected empty vault rendered with zero observed missing APIs or errors. Entry creation, persistence and animation timing against Android remain unverified.

Aegis entry creation then failed in the app's `ResultKt.clone(Serializable)` path. The native UUID and TreeSet classes lacked serialized forms. Their serial UIDs, field names and TreeSet custom stream sequence now match [AOSP UUID](https://android.googlesource.com/platform/libcore.git/+/master/ojluni/src/main/java/java/util/UUID.java) and [AOSP TreeSet](https://android.googlesource.com/platform/libcore/+/309f9df/ojluni/src/main/java/java/util/TreeSet.java). The clone also calls `ByteArrayOutputStream.toByteArray()` immediately after `ObjectOutputStream.writeObject()`; the stream now drains completed top-level objects without requiring an explicit flush. An AOSP `LayerDrawable` accepts null entries inside a non-null layer array; preserving that slot removed the subsequent layout failure. `ObjectAnimator.ofInt` now selects the integer setter without probing a floating setter that does not exist. A manually saved entry rendered a six-digit TOTP code with zero observed missing APIs or errors. A focused object-stream round trip and the existing suite cover the serialization change; reload persistence remains unverified.

AntennaPod's bundled Conscrypt JNI needed its native library and `FileDescriptor.descriptor`, rather than an emulated crypto result. Markor needed inherited `AppWidgetProvider.onReceive` dispatch. File Manager's background process called `System.getenv("PATH")`; a null answer led to a shell utility NPE, so the Android process environment is now exposed. Lichess still renders a blank Flutter surface after native `pthread` error 35. Organic Maps remains on its splash, and NewPipe video playback has not worked in the observed flow. Those are functional blockers despite cleaner startup diagnostics. Chrome DevTools MCP was unavailable because its shared Chrome profile was already occupied; repeatable browser checks used the local Playwright driver.

NewPipe's video action reached `PlayerService.onCreate`, which asked PackageManager for `android` and its signature. The framework resource APK's real manifest now supplies an implicit system package record in each process. Generated resource APKs are unsigned, so signature queries lazily read the public [Android 13 AOSP platform certificate](https://android.googlesource.com/platform/build/+/refs/heads/android13-release/target/product/security/platform.x509.pem); signed AOSP framework APKs supply their own certificate. Broker bootstrap excludes that implicit record because every process loads the same framework APK and the system path has no VFS copy. This moved the player service past its signature check. Its next block was `Notification.MediaStyle`, whose compact actions and media token are now stored in notification extras per [AOSP Notification](https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/app/Notification.java). The video UI then revealed missing progress-bar drawable initialization, the internal [AnimationScaleListDrawable](https://android.googlesource.com/platform/frameworks/base.git/+/master/core/java/com/android/internal/graphics/drawable/AnimationScaleListDrawable.java) used by framework progress resources, and level-based `<clip>` drawables. The cache serialization failure moved from the Webdroid-only unmodifiable list wrapper to `AtomicInteger`; both now use the [Android collection serialized form](https://android.googlesource.com/platform/libcore/+/5d9f6038f34163399b22320850317d25d084da06/ojluni/src/main/java/java/util/Collections.java) and [atomic serialized fields](https://android.googlesource.com/platform/libcore/+/68eaf98b48b3158a814eab069b676e7932580890/jdk/src/share/classes/java/util/concurrent/atomic/AtomicInteger.java). A repeat showed no cache serialization warning. The player service and controls start with no observed missing APIs or uncaught errors, but the video region stayed black with zero presented surface frames after 20 seconds. Audio playback remains unverified.

Markor's create action stopped at `Files.isWritable(Path)`, then at `ArrayAdapter.addAll(Collection)`, `ListPopupWindow`, `AdapterView.getOnItemSelectedListener`, and `ArrayAdapter.getPosition(Object)`. Its editor then needed `View.getVerticalScrollbarWidth()` and the `UpdateLayout` span marker. The shared API implementations let the unchanged app create and save a 36-byte Markdown document with zero observed missing calls or errors in that path. A reload initially showed an empty notebook even though `File.exists()` and `File.length()` proved the file existed before reload. The persistence broker watched only app-private roots, so `/sdcard/Documents/markor/Compat probe.md` and its directories were lost. It now persists shared `/sdcard` paths and restores them before package initialization while loading `/sdcard/Android/data/<package>` only for that package. The reloaded file browser found the document with its original 36-byte length. This is an observed path, not complete Markor feature coverage.

Reopening Markor's document then called `TextView.setTextKeepState`, which now delegates through the virtual two-argument `setText` and restores any selection within the new text's length. Preview drove Flexmark's `RepeatedCharSequence.toString()` into `StringBuilder.append(CharSequence, start, end)`: the native builder called `toString()` on the entire source, recursively re-entering the same method until stack overflow. Range append now reads `charAt` as AOSP does; a focused test uses a sequence whose `toString()` throws. Preview rendered after this fix. Its WebView `FindListener` type was absent; opening search then uncovered `AutoCompleteTextView.refreshAutoCompleteResults()` and a caught watcher exception. The watcher failed in appcompat `SearchView.updateCloseButton()` because `View.ENABLED_STATE_SET` resolved to undefined and reached `Drawable.setState`. Supplying the actual enabled state array removed that error. A subsequent `WebView.findAllAsync("Webdroid")` call used the rendered page's text and returned one match through the listener; Markor showed `1/1` with zero observed missing calls or errors. Browser preview and search were exercised on this one document only.

Fossify File Manager's new-folder and new-file actions created `/sdcard/Compatibility/notes.txt`; both remained visible after page reload. Its Glide thumbnail worker then attempted `MediaMetadataRetriever` for the empty file. The missing class caused an executor failure; after adding the Android API, the same path reports an invalid media source to Glide, allowing its ordinary fallback. The retriever uses the existing MP4 parser and WebCodecs decoder for supported MP4 tracks. The 4 KiB fixture reported a video and audio track, 32×32 dimensions, and produced a nonempty 32×32 frame in Chromium; a scaled-frame probe also runs. A copied MP4 appeared in File Manager after reload with no observed missing API. Other containers, embedded artwork and broader metadata keys remain unimplemented, so this does not establish general media-thumbnail support. A focused test covers MP4 metadata and rejection of nonmedia input.

Fossify Calendar's New Event form loaded `DatePickerDialog.OnDateSetListener` and `CalendarContract.Calendars`. Its DEX references only the five CalendarContract `CONTENT_URI` fields for calendars, events, attendees, reminders and colors; the local event path does not require a system calendar provider. The date picker follows the existing AlertDialog chrome, with month/day/year controls and the Android `onDateSet` callback. Tapping its month stepper changed September 24 to October 24 in the form without missing API reports. Saving a titled local event displayed the app's reminder warning. After dismissing it, a background notification path called `Context.grantUriPermission`; transient per-target URI grants now prevent that missing-method failure and participate in `checkUriPermission` for installed target packages. The event then appeared in the day view and survived a page reload. Calendar sync, recurrence, event editing/deletion and actual reminder delivery were not exercised. Calendar smoke compilation reported zero method failures; typechecking passed. The Chrome DevTools MCP profile was still occupied, so these browser checks used the local Playwright driver.

Fossify Gallery's empty landing screen was not just a lack of sample media. A real MP4 in `/sdcard/DCIM` appeared in its filesystem picker while `ContentResolver.query(content://media/external/file)` returned null; its startup queries requested `_data`, `date_modified`, `datetaken`, MIME, and SQL `LIKE` filters. The new MediaStore index reads shared VFS entries and uses the existing SQLite engine for projection, selection, bound arguments and sorting. It updates changed rows while retaining unchanged rows. After it was added, Gallery displayed DCIM with one media item, opened a grid and reached the video viewer. A generated PNG reached a photo viewer but first failed on `Window.setColorMode`, `Bitmap.getColorSpace`, then `BitmapRegionDecoder`. The window stores the requested mode while the sRGB display reports no wide-gamut support; bitmaps report the sRGB color space they actually use. Region decode crops and samples from one decoded bitmap. The PNG then appeared visibly in the viewer with no reported missing API or error. The short MP4 viewer also reached playback controls after ExoPlayer obtained a `MediaMetricsManager` playback session and assigned its ID to `AudioTrack`; reports are retained in a bounded in-memory session because no system metrics backend exists. The media index does not yet implement MediaStore mutations, persisted timestamps or all metadata columns; large image memory and actual video frame output need further checks. Gallery smoke compiled 7,480 classes with zero method failures, typechecking and all 1,362 tests passed. Chrome DevTools MCP remained unavailable due to its occupied profile; the browser checks used Playwright.

Feeder's Add feed search exposed a Moshi failure on `GoFeed`, even though `Class.isAnnotationPresent(kotlin.Metadata)` returned true. A direct `GoFeedAdapter` constructor reproduced it without network input. Its Kotlin factory reached Kotlin reflection, but `primaryConstructor` was null: the descriptor was a Java reflection descriptor because `kotlin.Metadata` arrays such as `mv` were plain JavaScript arrays. The bundled metadata reader checks `instanceof int[]`, so it discarded the version and fell back to Java constructors. Annotation element accessors and default values now return arrays using their declared Java type. Direct adapter construction succeeded; the focused annotation array test and Feeder smoke compilation passed, with zero method failures. Searching for `https://f-droid.org/feed` then reached `libgojni.so` and reported a null-address fault at `_cgo_topofstack+0x11bc` on `pthread-1`. It did not return feed results. This native fault remains under investigation; an empty missing-API report for this flow does not mean feed use works.

The next Feeder run resolved that first Go fault to `runtime.sigaltstack.abi0` deliberately dereferencing null after raw syscall 132 returned `ENOSYS`. Raw ARM64 calls for signal stacks, eventfd, epoll, dup3, scheduling, process limits and advice now reach their shared libc owners. Signal delivery builds an arm64 `siginfo`/`ucontext` and uses the registered alternate stack. A signed JavaScript alignment of a physical address above 2 GiB initially subtracted 4 GiB from the guest signal stack pointer; unsigned alignment fixed that. The common nested native call path also now translates the full guest stack address, including high planes. Go's `mincore` page-size probe had returned `ENOSYS`; the core now reports mapped page residency, and the probe succeeds. Descriptor close-on-exec flags belong to descriptor numbers rather than shared open-file descriptions; `dup3`, `pipe2`, `fcntl` and related constructors now agree on them. Feeder then reached XML parsing, which exposed missing `InputSource` getters and SAX marker interfaces. Focused native memory and descriptor tests passed, and Feeder still smoke-compiles 12,291 classes with zero method failures.

Feed search remains unusable: a Go pthread occasionally returns from `runtime.futexsleep` with both saved frame pointer and link register equal to `0x1`, then faults at that unmapped address. Repeated browser runs reproduced the fault with JIT enabled and disabled; current runs report no missing native syscalls. One run reached the XML error before this later native fault, so the ordering depends on thread scheduling. The native path can execute hundreds of millions of instructions while no feed result appears, which is a performance and liveness concern as well as a correctness blocker. The cause of the saved link-register overwrite has not been established; no app-specific bypass was added. Typechecking, the 1,366-test suite, focused native/SAX tests and Feeder smoke compilation passed. Chrome DevTools MCP remained blocked by its occupied shared profile, so the reproduction used the local Playwright driver.

Lichess's Flutter worker abort was traced through `pthread_join` rather than treated as a Flutter rendering failure. The app logged `os_thread_android.cc:162 pthread error:35`; a temporary native trace showed the joining thread's `pthread_self` equaled the handle it was joining. The emulator freed a joinable thread's `pthread_t` memory at exit while retaining its handle in the join table. A later pthread reused the allocation, and joining the old thread returned `EDEADLK` (35). Thread exit now releases execution resources but keeps that allocation until join or detach. A focused lifecycle test creates an exited joinable thread, starts another, checks their handles differ, then joins both. Typechecking, 1,367 tests and Lichess smoke compilation (3,300 classes, zero method failures) passed. A serialized 15-step full Lichess capture rendered all steps in 92.6 seconds: home, board editor, computer-game setup and a Stockfish level 1 game through e4, Nf3 and Ne5 with engine replies. Every step settled, and the final frame advanced GL rendering with no native fault, required native API, layout/draw/GL error or wedge. The run still reported the optional OEM `androidx.window.sidecar.SidecarProvider` probe and a Cronet DNS-configuration warning. This is a smoke flow without scored Android visual comparisons; online play, account and persistence were not exercised. Chrome DevTools MCP remained occupied, so the browser capture used the local Playwright driver.

Organic Maps first reached a welcome page offering a world overview download. Its downloader opened multiple writable Java `RandomAccessFile` handles and issued out-of-order 512 KiB HTTP range writes. Each handle kept the file snapshot from its open; writing or closing one published that stale whole-file buffer over ranges written by another. The downloaded WorldCoasts file had zero-filled gaps even though the browser received the range responses. Writable handles now refresh from the VFS before reads and writes, while close no longer republishes an obsolete snapshot. The completed World and WorldCoasts files matched the CDN's declared sizes and SHA-1 digests: 64,005,633 bytes / `2b6daa6fde002244650338537872eda2b02a29fe` and 8,354,683 bytes / `d48a44c039dc19c8407766be4177823ec1ed6ed5`. A focused two-handle test covers out-of-order writes. The app's place page also called the previously absent `View.setZ`, now applied as translation Z relative to elevation.

The downloaded maps still appeared black at first. After reload, native logs showed both maps loaded but there were zero EGL or GL host calls and zero presented frames. The app's `MapView` registered a SurfaceHolder callback whose bytecode passes `getSurfaceFrame()` to native `onSurfaceCreated`; Webdroid returned null for that frame and false for `isCreating()`. The holder now reports its current local 0,0,width,height frame and the creation state during callbacks, following [Android SurfaceHolder](https://developer.android.com/reference/android/view/SurfaceHolder). The next browser run entered the unchanged native renderer, made 159 EGL swaps and about 3,000 GL draws, and displayed the world overview with coastlines and labels. No Java/native missing calls, native fault or GL error appeared on that observed path. `arc4random_buf`, which the native library called once before the renderer started, now fills guest memory from WebCrypto; `arc4random` and uniform sampling use the same cryptographic source. A first-session screenshot showed a map shell and an automatic regional-download dialog; the reloaded screenshot showed the actual world map. Search opened and accepted `coffee` without missing API calls or a native fault, but its result area still displayed loading placeholders after four seconds. Typechecking, the 1,368-test suite and Organic Maps smoke compilation (7,135 classes, zero method failures) passed. Search results, region completion, navigation, routing, location and Android visual parity remain open. The Chrome DevTools MCP profile was still occupied; the browser checks used local Playwright.

Setting the browser location to Monaco exercised the smaller regional map path. Its 1,077,264-byte download matched the CDN's SHA-1 `3cd8bf68f497e5ec4243409afee7320ec4722af6`; the bundled `countries.json` expects the BLAKE3 prefix `Rw6Pc7ZQNsmk`, which a host digest and the unchanged native BLAKE3 routine both produced. Organic Maps nevertheless computed `eHif7Fbv10IT` and failed its integrity check with JIT on and off. The native `FileData` loop read sixteen full 64 KiB chunks, then requested the last 28,688 bytes. At that point the VFS entry had the complete bytes, but the already-open native file object had a data view ending after only 8,183 more bytes, despite reporting the complete logical length. `vfs.write` updated that object's length but skipped replacing its view when a longer subarray shared the same buffer and offset. It now replaces a shorter view. A focused open-file test covers that case. The repeat download passed the app's own integrity check, registered `Monaco.mwm`, and rendered Monaco's coastline, roads and labels with no observed missing Java/native APIs, fault or GL error. Searching for `Casino` then returned nearby places, including Casino de Monte Carlo, and drew map markers with no missing API report. Selecting that result raised the absent `Collections.rotate(List, int)` from the opening-hours formatter. Implementing it through the list iterator preserves backed sublist updates; a focused test covers negative rotation of a sublist. A subsequent run displayed the place detail sheet with its name, opening hours, Wikipedia text and route actions after the transition settled. Selecting Route to made the unchanged native router calculate a 615.017 m route with a 94.9992-second ETA; the map drew the blue path and offered Start. This path reported no further missing Java/native APIs or native fault. Navigation and broader map use remain open.

Start displayed Organic Maps' own route warning; Accept entered its navigation UI and started `NavigationService`. The service's `MediaPlayerWrapper` constructor first failed on `Context.createAttributionContext("media_playback")`, then `MediaPlayer.setAudioAttributes`. A tagged context now keeps its base context, resources and application identity while exposing its tag and attribution source, following [Android Context](https://developer.android.com/reference/android/content/Context). MediaPlayer retains validated audio attributes. Its bytecode later reads a raw resource via `AssetFileDescriptor`, calls `setDataSource(FileDescriptor, long, long)`, then `prepareAsync`; the old player had no descriptor source and incorrectly called `onPrepared` when the listener was registered. It now reads descriptor byte ranges, resets/revokes prior blob URLs and calls the listener on preparation, following [Android MediaPlayer](https://developer.android.com/reference/android/media/MediaPlayer). A standalone Chromium probe loaded and decoded a generated 22,094-byte WAV through the descriptor API and reported 0.25-second duration. A repeated Organic Maps route run reached the navigation UI with no observed missing Java/native calls or fault; actual guidance audio was not triggered or heard. Typechecking, all 1,371 tests and Organic Maps smoke compilation (7,135 classes, zero method failures) passed. The corpus handoff and unverified flows are in [corpus-plan-v2.md](../corpus-plan-v2.md).

NewPipe's Big Buck Bunny detail path exposed standard Android and Java gaps beyond the launch scan: a non-reference-counted `WifiLock.release()` incorrectly threw when already released, `ImageView.setImageAlpha`, `MediaDescription` and `MediaSession.QueueItem` were absent, and its bundled bytecode built a DASH manifest using DOM mutation and JAXP transformation. The lock now follows [AOSP WifiLock](https://android.googlesource.com/platform/packages/modules/Wifi/+/refs/heads/main/framework/java/android/net/wifi/WifiManager.java); image alpha uses the [AOSP ImageView](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/master/core/java/android/widget/ImageView.java) byte range. The DOM bridge creates and serializes real browser XML nodes, and accepts only empty external-access settings that its parser can honor. The first run after those changes decoded AVC and AAC but presented zero video frames: the codec had an offscreen fallback surface and ExoPlayer released video outputs with `render=false`. The visible `ExpandableSurfaceView` overrides `onLayout` without calling `super`; Webdroid had tied surface creation to the base method, so its holder never acquired a valid visible surface. Surface synchronization now follows frame changes independently of that override. A rerun configured the codec with a surface attached to the visible view, released 1,717 video outputs with `render=true`, and advanced presented frames from 327 to 1,662 over the observed playback interval. Two screenshots showed distinct Big Buck Bunny frames. The final observed path had no missing call or draw error, but an ExoPlayer timeline `IllegalStateException` appeared during startup, and audible output, downloads and background behavior remain unverified. Chrome DevTools MCP was still blocked by its occupied profile; local Playwright supplied the frame, codec and surface traces.

The same surface change let Fossify Gallery present four video frames from `tests/fixtures/media.mp4` after Play. The MP4 is 0.3 seconds long, so this proves a short H.264 output path only. Gallery showed the frame in its viewer with no missing API report, while video thumbnails still emitted decode warnings. A focused SurfaceView test covers a subclass that omits the base `onLayout`; NewPipe smoke compilation found zero method failures. The broader corpus is still shallow.

The serialized 13-flow visual matrix rendered every configured step after the surface change. YouTube's full capture reached video, pause/resume, fullscreen and Shorts, but reported five missing `CaptioningManager.CaptionStyle` color fields. The media module already defined those fields; `app.ts` imported media and then replaced its complete `CaptioningManager` and `CaptionStyle` registrations with partial duplicates. Removing the duplicates restored the [AOSP caption style](https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/view/accessibility/CaptioningManager.java) fields and default style. A targeted quick YouTube run reported none of those fields, though its live control checkpoints timed out. A repeat of the same 16-step full flow rendered video and controls again and reported only optional `androidx.window` provider probes. The full matrix's scored Android visual content mean was 27.42%; rendered steps and a clean API list do not imply visual parity.

NewPipe's remaining ExoPlayer `IllegalStateException` came from window UID comparison, not the decoder. A probe of `evaluateMediaItemTransitionReason` found one-window old and new timelines with the same period UID, while the native `android.util.Pair` bridge lacked value-based `equals`. Its timeline UIDs contain nested pairs. Implementing [AOSP Pair](https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/util/Pair.java) equality and hash semantics removed the repeated exception. The next execution reached `AbsSeekBar.setKeyProgressIncrement`, which was registered but unreachable because Webdroid's `SeekBar` JavaScript class skipped `AbsSeekBar` in its inheritance chain. Matching the Android superclass chain and retaining the positive key increment removed that missing call. A repeat of the same Big Buck Bunny path presented 1,665 frames, configured AVC against the visible surface, and reported no uncaught exception, missing API, layout error or draw error. The video path pushed 657,913 nonzero PCM frames through a running `AudioContext`; background audio also produced nonzero PCM, but audible listening was not verified.

The audio download reached the browser directory picker after `StructStatVfs` fields and `Os.statvfs` were supplied from the storage estimate. A real OPFS directory handle in the browser diagnostic isolated the picker gesture from document behavior. NewPipe's `DocumentFile.canWrite()` then exposed the missing `Context.checkCallingOrSelfUriPermission` delegate and the absence of result URI grants. The system picker now returns read/write and persistable flags with a prefix grant for trees; activity result delivery installs the grant before the callback. The download next reached `Intent.putExtra(String, char)` and `Service.stopForeground(int)`, both general Android APIs. Its `FileStreamSAF` constructs input and output streams from a document `ParcelFileDescriptor`; a byte-only descriptor could not be written, and separate temporary files for parallel opens caused range writes to overwrite each other. Document descriptors now share a seekable VFS backing per document id, use the shared cursor, and commit to the selected browser file on the final close. A three-thread Big Buck Bunny M4A run completed postprocessing, produced 10,266,521 bytes starting with an MP4 `ftyp` box, and reported no missing API. This establishes one download path, not other formats or audible playback.

Repeating the download across a page reload retained the same 10,266,521-byte file. `checkCallingOrSelfUriPermission` returned granted for its document URI, and ContentResolver read the `ftyp` header through the restored directory handle. The first reload also surfaced `PackageManager.hasSigningCertificate`; the delegate now compares installed APK certificate bytes or their SHA-256 digest according to the requested type, using the existing verified signing metadata. A second download/reload had no missing API before or after reload. The app's own download-list navigation and playback of the saved file have not yet been checked.

KeePassDX vault creation reached Blowfish key generation, digest/cipher output streams, RSA key parameter specs and XmlPull serialization. Its editor initially omitted the Title, Username and Password fields because `ViewGroup.addView(View)` sent null layout params into Material's three-argument override; generating default params before that virtual call let the fields render and accept input. A separate Room helper then tried to create an already-existing TEMP table because `SQLiteOpenHelper` instances shared a cached SQLite connection. Each helper now opens its own connection, preserving independent TEMP schemas. The navigation drawer repeatedly failed when Material called `InsetDrawable.getConstantState().newDrawable()`; the inset wrapper now returns a state only when its child does, and recreates the child through that state. These fixes removed the observed layout and TEMP-table errors.

A new KDBX3.1 vault was written to an OPFS-backed file handle supplied to the browser picker during the diagnostic. An entry titled `Webdroid Test` with username and password appeared in the group; saving grew the KDBX from 2,190 to 2,318 bytes. After a page reload the recent file appeared, but its `single-*:` URI could previously lose the file handle. Standalone picker handles now persist by document id in IndexedDB and are cleared by Webdroid reset. Reopening the file surfaced `View.requestFocusFromTouch`, `DigestInputStream` and `CipherInputStream`; their general implementations advanced unlock. The final reload/unlock displayed the same entry and username with no observed missing API or error, and the picked handle remained in IndexedDB. This proves one self-written, self-read KDBX path, not independent KDBX interoperability or other format versions. Synthetic `wd.tapText` calls do not provide browser user activation for the real picker, so the diagnostic used a real OPFS handle without modifying app code. During entry save, `EntryEditActivity.onPause` raised `Service not registered` from `unbindService`; the entry still persisted, but the service lifecycle cause remains unresolved. The app's notification-permission dialog reappeared on activity changes and had to be dismissed to reveal the saved entry.

### AntennaPod RSS subscription and stream setup

AntennaPod's direct RSS URL first failed inside OkHttp's TLS connection health check. The relay-backed SSL socket takes over a plain socket, but the old handoff marked the plain Java socket closed immediately; OkHttp then rejected the route. The wrapper now owns the plain socket until close while reusing only the TLS relay. The downloaded feed then exposed a `BufferedInputStream.markpos` field, `StringReader.mark/reset`, a real `CharBuffer.array()` backing, and `SAXParser.parse(InputSource, DefaultHandler)`. `readerText` had read inherited empty fields from an app Reader subclass instead of calling its virtual `read`; removing that shortcut let the parser consume the actual feed. Finally, RxJava disposed one Handler token and Webdroid cancelled every message on that Handler, including the feed completion callback. Token-specific cancellation restored the callback. The direct NASA feed rendered its title, author, episode list and Subscribe action, and the subscribed episode view opened with no observed missing API.

Feed artwork initially failed with `Not a Conscrypt trust manager: webdroid.X509TM`. OkHttp's bundled bytecode chooses its JVM path when `System.getProperty("java.vm.name")` differs from `Dalvik`; Webdroid had returned `webdroid`. Reporting Android's VM name selected OkHttp's Android path, and a repeat displayed the feed and episode images without that error. The preview header title also extended beyond its card because RelativeLayout measured a match-parent child to full parent width even when `layout_toEndOf` fixed its left edge. Filling only the remaining span kept it inside the card; a core layout test covers this rule. The description panel still has low contrast in the observed screenshot.

Opening an episode and tapping Stream exercised the media service. `AudioEffect.queryEffects()` now reports an empty installed-effects array, which means Webdroid does not advertise a loudness enhancer it cannot run. The service also needed broker-owned `PendingIntent` type queries, platform `MediaSession` routing and transport controls, `Bundle.getCharSequence` with a default, KeyEvent parceling, immutable `Bitmap.asShared()`, and notification extras merging. After these APIs, the app displayed its player with Pause and episode artwork and reported no missing calls in that observed path. Playback was not established: its position remained `00:00:00` after 23 seconds, and a diagnostic that recorded `AudioContext` construction in every process frame saw none. The next investigation should distinguish an unfetched media source from an ExoPlayer preparation, extractor or codec failure before adding delegates. Typechecking, all 1,384 tests and AntennaPod smoke compilation (12,065 classes, zero method failures) passed. Chrome DevTools MCP remained unavailable because the shared profile was occupied, so the local Playwright driver supplied the replay and screenshots.

The next playback probe showed that the media host delivered tens of megabytes, but Webdroid's decoder list did not expose `audio/mpeg`. The RSS enclosure declares that MIME type and Chromium's `AudioDecoder.isConfigSupported` accepts `mp3`; adding it let Media3 create an asynchronous audio codec adapter and a running `AudioContext`. Media3 then called `android.os.SharedMemory` while parceling session metadata. The new implementation maps shared bytes through direct ByteBuffers, supports protection narrowing and parcel round trips, following the [Android SharedMemory contract](https://developer.android.com/reference/android/os/SharedMemory). One focused test covers writable mapping, read-only protection and parcel restoration.

Even with audio output, the app's position display stayed at zero. Instrumenting its unchanged Media3 bytecode showed a one-second position observer and an advancing player position, but `getDuration()` returned `TIME_UNSET`; that app code skips position events until duration is positive. The upstream MP3 response had `Content-Length: 37184711`, but Webdroid's proxy had dropped it. Preserving the header alone was insufficient because Bun strips standard `Content-Length` from a streamed full response. The proxy now carries the upstream length in `x-wd-content-length` only for uncompressed, untransformed bodies, and Java URLConnection restores the standard header. On replay, Media3 reported a finite 1,537,436 ms duration; the UI reached `00:00:21` after 23 seconds. The Web Audio probe observed 989,310 scheduled PCM frames, 978,229 nonzero, and a running audio context. Tapping the midpoint of the full player's seek bar moved the clock to `00:12:56` after a further nine seconds. No missing API or uncaught error appeared in that final path. The full player screenshot still appears to cover its position and seek bar with the shownotes view despite their presence in the UI tree; this visual issue remains. Audible output, download, queue and persistence are unverified. Typechecking, all 1,385 tests and AntennaPod smoke compilation (12,065 classes, zero method failures) passed. Chrome DevTools MCP was still blocked by its occupied profile; Playwright supplied the repeatable browser probes.

AntennaPod's downloaded MP3 completed its WorkManager episode worker, but the post-download handler logged `Invalid media source` because `MediaMetadataRetriever` only passed sources to the MP4 parser. The retriever now recognizes MPEG Layer III frames, uses Xing/VBRI frame counts when present, estimates constant-bitrate duration otherwise, and extracts ID3v2 embedded artwork. A real 37,184,711-byte episode returned 1,537,437 ms, 192 kbps and a 284,273-byte PNG; the app then logged that same duration and switched the episode action to Play/Delete without its former media error. The download path also called `PendingIntent.getForegroundService`; foreground-service intent identity and type queries are now distinct from ordinary service intents. A replay reported no missing API. With subsequent proxy requests blocked, tapping Play advanced the visible clock from about 3 to 14 seconds through a running `AudioContext`, though this alone does not exclude bytes buffered by the previous stream. The MP3 test fixture consists of two real frames and adds one retriever test; typechecking, all 1,386 tests and AntennaPod smoke compilation (12,065 classes, zero method failures) passed. The proxy also omits response length headers from bodyless manual redirects. Chrome DevTools MCP again reported its occupied profile, so Playwright provided the app traces.

A second download/reload check blocked both `/proxy` HTTP requests and new `/tcp` relay WebSockets before reloading. The saved episode retained its position at `00:00:04`; tapping Play advanced it to `00:00:18` with a running `AudioContext` and no missing API. Media3 logged expected failures to refetch remote notification artwork under this deliberate network block, while audio playback continued. This establishes persisted local playback for the tested MP3. It does not establish audible hardware output or other audio formats.

### OpenTracks recording and track save

The initial track list stopped on `Stream.allMatch` and `SQLiteQueryBuilder`. The query builder now composes projections, trusted appended clauses and selections over the owning SQLite connection; `ContentValues.putAll` merges provider values. On Record, OpenTracks first called `bindService` with flags zero and then `startForegroundService`. The old implementation returned false before registering the binding, so its `onServiceConnected` callback never arrived. Pending bindings now connect when that service starts and unbind removes an unstarted registration. This let unchanged app bytecode enter `startNewTrack`.

Track insertion and subsequent reading exposed the `ContentResolver.notifyChange` observer path, `Instant.now(Clock)`, `Duration.ZERO`, `ZoneOffset.ofTotalSeconds`, and `SQLiteQueryBuilder.update`. Recording also used `Duration.plus`, `Instant.plus(TemporalAmount)`, `PendingIntent.getActivities`, `LogPrinter`, `Stream.iterator`, and `ViewGroup.getLayoutMode`. The new PendingIntent form retains the activity array and launches it in order, with the final intent as its identity and fill-in target. The browser replay reached a recording screen whose clock advanced and whose statistics rendered. The first tap on Stop left recording active because the app's tap listener displays a “hold to stop” hint; bytecode inspection found a separate long-click listener that stops the service and opens `TrackStoppedActivity`. A 1.3-second press opened that screen, and its Finish button returned to the track list with the saved item. Fixed San Francisco coordinates explain the zero distance; movement and point storage were not verified. The final record, long-press and Finish path reported no missing API, uncaught exception, layout or draw error. Inflater factory warnings remain. Typechecking, all 1,386 tests and OpenTracks smoke compilation (14,393 classes, zero method failures) passed. Chrome DevTools MCP still rejected access to its occupied shared profile; Playwright supplied the replay and screenshots.

A follow-up changed browser geolocation from 37.7749 to 37.7758 latitude during recording. After Finish and page reload, the saved track row displayed 327.73 ft with no missing call or runtime error. This establishes one persisted distance path; the individual track points and export format remain uninspected. The app's default name used `yyyy-MM-dd'T'HH:mmX`, and Webdroid's formatter had emitted a literal `X`. Offset pattern formatting now emits the current offset (`-07` in the replay); a repeated saved-track flow showed `2026-09-25T00:54-07` with no new error. Typechecking passed after this change.

Opening that saved item exposed `DateTimeFormatter.ofLocalizedDateTime(FormatStyle)` and the previously uninitialized `FormatStyle` enum; the detail page then rendered its localized date and track statistics. Share initially crashed OpenTracks' own ImportActivity because `Intent.createChooser` returned its raw `SEND_MULTIPLE` target. Choosers now preserve `EXTRA_INTENT` and route share content to a browser action. Reading the provider URI exercised `Stream.toArray(IntFunction)`, `ContentProvider.openPipeHelper`, `ZipOutputStream`, and `DateTimeFormatter.ISO_OFFSET_DATE_TIME`. The pipe helper calls the app's unchanged writer and returns its generated bytes; ZIP output uses streaming DEFLATE. In a full record/reload/open/share replay, Download yielded a 1,049-byte KMZ. `unzip -t` validated `doc.kml`, which contained `-122.4194 37.7749` and `-122.4194 37.7758` coordinates and ISO offset timestamps. The final path had no observed missing API or uncaught exception; inflater factory warnings remain. Native Web Share, the app's import path, settings and sensors are still unverified. Typechecking, all 1,387 tests and OpenTracks smoke compilation (14,393 classes, zero method failures) passed. Chrome DevTools MCP continued to reject the occupied shared profile, so Playwright drove the replay.

The settings Import all preference initially threw `ActivityNotFoundException` for an action-less explicit component. Its `targetPackage` was a string resource in the preference XML, but `Intent.parseIntent` had read the raw reference number. Resolving typed references with the supplied `Resources` launched the app's directory chooser. A browser diagnostic supplied a real OPFS directory handle containing the previously exported KMZ. The import worker then exercised `SAXParser.parse(InputStream, DefaultHandler)`, `DateTimeFormatter.ISO_DATE_TIME.parseBest` with `TemporalQuery`, `ContentResolver.bulkInsert`, `Stream.mapToLong`, and `Arrays.stream(long[])`/`LongStream.mapToObj`. These now route through the relevant platform implementations; the SAX reader also supplies a Locator before document events and reports -1 for source positions it cannot know. A replay reported “Files imported: 1” out of 1 with no missing API or uncaught error. Its Open Track action showed the imported 327.73 ft track and statistics; after reload, the track row still appeared with the same distance. The diagnostic verifies the document-provider and importer path with an OPFS-backed selection, not a physical browser picker gesture. Typechecking, all 1,387 tests and OpenTracks smoke compilation (14,393 classes, zero method failures) passed. Chrome DevTools MCP remained blocked by the occupied shared profile; Playwright supplied the replay.
