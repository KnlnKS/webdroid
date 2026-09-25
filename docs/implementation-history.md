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
## Expanded APK corpus and shared Java semantics — 2026-09-24

The APK folder grew to 32 packages during the audit. A serialized boot corpus drew 30 frames; Aegis crashed before diagnostics and Thunderbird reached diagnostics without drawing. The full observed missing-entry inventory, including package-specific and optional probes, is in [the APK coverage audit](apk-coverage-2026-09-24.md). A drawn frame or empty missing set covers only the observed path.

Amazon initially exhausted V8 memory before the corpus could collect diagnostics. A V8 profile identified repeated Avro schema hashing. Its bytecode uses a thread-local `IdentityHashMap` as the cycle guard; Webdroid had registered that class as an ordinary value-equality map, so cyclic schemas recursed through `hashCode`. Reference-based keys and values let Amazon render sign-in and, after skipping it and allowing startup work to settle, its shopping shell. Shopping content and later actions remain unverified.

YouTube's five missing caption-style fields came from a second `CaptionStyle` registration in `app.ts` replacing the complete registration from `media.ts`. Removing the duplicate cleared those observations. Targeted corpus runs also confirmed two platform callback type registrations, the Java `String.join` iterable overload, localized date patterns, and the absent-fingerprint-hardware service response. The Fossify apps then advanced to a modern `ContentResolver.query` overload and other gaps. The Google Maps and three affected open-source APKs smoke-compiled with zero method failures.

Lichess remains intermittent: one targeted fast run reached all selected checkpoints but kept Dart pthread errors, while other runs timed out on launch. Temporary wrappers around Webdroid's pthread host return values did not report the corresponding errors; those wrappers were removed. The error may be in guest Bionic or a deeper concurrency path, but the current evidence does not isolate it. Chrome DevTools MCP was unavailable because its configured profile was in use; browser/CDP and the existing harness supplied the captures.

An isolated Aegis boot reproduced a V8 JavaScript out-of-memory crash before process diagnostics could be collected. Thunderbird initially reached a `Context.openOrCreateDatabase` NoSuchMethodError and drew no frame. Routing that API through the existing package database path let it render, with `DocumentBuilderFactory` next in the observed missing set. Its APK smoke-compiled with zero method failures.

A later V8 profile of Aegis's out-of-memory run spent 87.8% of samples in GC and repeatedly showed the three-argument `AutoCompleteTextView` constructor under AppCompat's tint wrapper. Webdroid's native constructor called the two-argument constructor with virtual `vcall` on `this`; an app subclass could dispatch back through its own constructor, allocating until OOM. Reusing the owning `textViewCtors` helper directly removed that cycle and five lines of custom constructor code. Aegis then drew its first frame in an isolated corpus run. Dropdown anchor/background APIs cleared the next startup exceptions. Its latest boot has zero process errors; `TileService.requestListeningState` reports the absent StatusBar service rather than silently claiming Quick Settings is available. Aegis smoke compilation had zero method failures.

The Fossify apps reached `ContentResolver.query(Uri, String[], Bundle, CancellationSignal)` with structured limit and sort-column arguments. The resolver now sends recognized SQL selection/sort arguments through its existing query path and applies sorting and limits to its own document cursors. Unknown Bundle keys remain explicit missing capabilities rather than being discarded. Browser USB enumeration returns no connected devices, and `MediaStore.canManageMedia` reports no ungranted special permission. Gallery then booted with zero observed missing entries and zero process errors. File Manager reached zero observed missing entries after its legacy `StaticLayout` constructor reused the shared layout calculation. Its independent background-thread null split and Glide image-load errors remain. A property-less `ValueAnimator` had also attempted to build a getter name from undefined; defaulting its start value to zero removed that uncaught TypeError. These are startup observations, not full app validation.

### Original 20 APKs after the scope change

The user narrowed active work to the 20 APKs that preceded the latest folder additions. A fresh serialized sweep drew all 20 frames with diagnostics. Google Maps reached zero observed boot-path missing entries after Android's optional performance-hint service was identified by class, `CursorWindow` gained typed rows and parcel reconstruction, and `FileBackupHelper` gained construction. The latter still lacks backup transport behavior; no backup operation was exercised. Maps smoke compilation reported zero method failures, and the focused CursorWindow round trip passed.

Amazon's boot sweep had previously recorded `unimplemented 0x0000f3ef` in its bundled ARM32 Weblab library. Disassembling the exact library offset identified Thumb `MRS APSR` followed by `MSR APSR_nzcvq`. The ARM core now transfers condition flags for those encodings; a direct instruction-sequence test passed, and a focused Amazon boot/ten-second native trace did not reproduce the fault. The fault's intermittent timing prevents treating this as full shopping-flow validation. Chrome DevTools MCP still could not attach because its configured profile was occupied; the existing headless browser harness supplied the runtime evidence.

ChatGPT's bundled NTP path actually sends a Java datagram during boot. `DatagramSocket` now handles local loopback packets, timeouts and closure; the Bun development server relays remote UDP datagrams through a WebSocket. A local UDP echo returned the original bytes and source endpoint, while a focused ChatGPT boot on that server no longer reported the Java class or UDP transport as missing. The Cloudflare Worker currently has outbound TCP sockets but no generic UDP socket API, so hosted remote UDP remains explicitly unsupported. A fast 24-step ChatGPT flow exposed `media_projection` and `device_policy` service requests beyond boot. The device-policy manager now reports no camera-disabling administrator on the fresh virtual device. Its initial Settings timeout came from a recorded tap below the visible navigation button; after correcting the flow coordinate, Settings, Language and About all completed their state checkpoints. The attachment path still shows a camera initialization error, consistent with the empty virtual camera topology. Neither these queries nor the UDP relay establish ChatGPT's authenticated media features.

YouTube's search flow returned home when its text locator tapped the bottom edge of a partially visible video result. A thumbnail tap opened the video and exposed a previously unobserved `AudioTrack.setLogSessionId` failure during playback. Android media metrics sessions now issue stable opaque IDs and accept bounded playback, bundle and editing reports; `AudioTrack` stores and returns its assigned log session ID. The existing `LogSessionId` class in `media.ts` remains the sole registration. A direct builder/session call and the 16-step fast YouTube flow passed, including pause, resume, fullscreen and Shorts, without further media metrics misses. The flow result does not establish sustained playback quality or authenticated use.

A later serialized 13-flow fast matrix reached 10 flows. YouTube's player opened and pause/resume worked, but bundled V8 logged `Failed to protect data memory at 0xffdf8000 +16384; error 12` at video open. At fullscreen the app main queue stopped draining in the layout phase with 242 jobs queued; the original process still advanced native instructions. A targeted traced repeat completed all 16 steps without reproducing the fault, so temporary view-level layout instrumentation was removed. Separately, the libc `mprotect` bridge had treated `PROT_EXEC` alone like `PROT_NONE`; it now commits any readable, writable or executable mapping. A targeted post-fix YouTube run again passed, but this does not establish that the intermittent V8 or layout fault is fixed. In the same matrix Lichess aborted with Dart pthread error 35 during launch and Doodle Jump's title averaged 44 shell frames/s below its retained 55 threshold.

### Native API and thread-handle follow-up

The original-20 boot sweep identified six ELF call sites: YouTube's `android_get_device_api_level`, `pthread_attr_setscope`, `pthread_attr_setguardsize` and `__pthread_cleanup_push`, plus Doodle Jump's `glMultiTexCoord4f` and `glClipPlanef`. The native requirement diagnostic now combines called ELF functions with Java native requirements across main and child processes. Android's no-camera profile queries report absence, while typed system-property accessors return their declared defaults for absent properties. Doodle's GLES1 clip-plane, multitexture-coordinate and point-size-array support follows its guest ABI and retains the software draw path. Targeted boot runs of YouTube and Doodle then reported zero native requirements; Doodle's six-step fast capture reported zero GL errors but retained its 44-frame/s title motion failure. The GLES additions did not fix that performance limit.

Lichess's fast flow exposed repeated Dart `pthread error: 35` and occasional `3`. A temporary host-return trace identified `pthread_join` as the source; its handle address sometimes equaled the caller's live handle and sometimes resolved to a deleted thread. `startThread` disposed the CPU and freed its `pthread_internal_t` allocation as soon as the routine exited, even while the pthread remained joinable. A later thread could reuse that address and overwrite the handle map. The allocation now survives exit and is released by join or detach. A focused test starts a second thread after the first exits, checks distinct handles and joins both; a 20-second Lichess boot reported no Dart pthread aborts, and its 15-step fast flow completed with no pthread or native requirement errors. The temporary trace was removed. Longer sessions and other apps still need validation.

Google Maps search, place details and photos responded while the actual map surface stayed blank. The process completed frames and requested map endpoints, but reported zero GL draw calls. Two `/glm/mmap` requests returned 200 and two failed. A matched run at the starting commit showed the same blank map, so this is an existing compatibility gap rather than a change introduced here. Typed `SystemProperties.getInt` removed one observed reflective exception but did not restore map drawing. Tile request outcomes and native renderer startup still need investigation before attributing the gap to a particular API.

A subsequent serialized boot sweep of the original 20 packages drew a frame in every app, collected process diagnostics in every app, and reported zero called native requirements. It recorded 29 distinct missing entries, mostly absent optional/vendor modules and Amazon private services. Reddit newly exposed four optional App Set, AppsFlyer and MIUI probes on this run; they do not by themselves establish a missing Android platform API. Full feature coverage remains open.

### ELF image protection and later fast matrix

The next serialized 13-flow fast matrix reached 9 flows. Lichess completed 15 steps without pthread aborts. Resy's venue-offer dismissal and back action timed out with a busy state, while ChatGPT's Settings/About targets intermittently vanished after an earlier complete run. Doodle's title motion remained below its retained gate. YouTube again logged V8 `Failed to protect data memory at 0xffdf8000 +16384; error 12` and wedged at video open. A temporary libc trace showed the exact `mprotect` returned ENOMEM. The address belongs to the reserved ELF image region; `commit_pages` had rejected every range above `module_bot` before checking whether its pages were mapped `IMAGE` pages. It now bounds the request by process memory size and checks the page states. A core test confirms an image page succeeds and the free page below it still fails. The temporary trace was removed.

Three targeted YouTube fast runs after the fix reached all 16 checkpoints without the V8 ENOMEM or queue stall. One nevertheless logged a separate native `undefined 0x00000000` fault at `0x10004d20` while opening the video, then continued through the flow. Its cause and relationship to the image protection change are unknown. Typechecking and all 1,368 tests passed; the complete matrix has not been rerun after this fix.

Chrome DevTools inspection of Maps after dismissing onboarding showed the blank map with 72 completed GL frames but zero GL draw calls. No GL host calls appeared in the native call summary. Two `/maps/vt/proto` responses had bodies and HTTP 200 status; the two `/glm/mmap` requests received HTTP 200 headers but later showed `ERR_ABORTED`. The earlier headless run showed the same blank surface at the starting commit. The app may be canceling those requests, or its Java/transport path may end them early; the current capture does not distinguish those causes.

Disabling native JIT for a Maps boot still produced no GL draws after onboarding. A JIT-disabled YouTube flow, however, surfaced two uncaught Android method misses while otherwise completing playback: `AnimatorSet.clone()Landroid/animation/AnimatorSet;` and `View.setZ(F)V`. Android's `AnimatorSet` clone owns cloned child animations, and `View.setZ` sets translation Z to the requested depth minus elevation. The animation delegate now clones its child graph and mutable keyframe arrays, while the view delegate updates translation Z and paints elevated siblings in depth order. Existing no-Z draw paths keep their original child array without sorting. Focused clone and draw-order checks passed; subsequent YouTube flows with and without JIT completed all 16 steps without those method errors, and the 39-step FitNotes flow reported no gaps. These targeted passes do not explain the intermittent native zero-instruction fault.

Resy's offer-dialog timeout was not stable across isolated runs. One fast capture retained three simultaneous offer windows after opening a venue; a later run instead timed out at the search result, created and dismissed two dialog instances normally, and returned to an unfiltered list after Back. Temporary show/dismiss logging was removed because it did not establish a framework lifecycle fault. GmsClient provided a useful control for maps: its unchanged microG/MapLibre path showed a visible world map and 252 GL draws in Chrome DevTools. It also returned availability and received-message counts. Its fused-location callback waited with browser geolocation permission at `prompt`; a separate Playwright run with permission and a supplied coordinate delivered the callback. Thus Google Maps' blank surface is narrower than a general GL or GMS map failure.

For Doodle Jump, a temporary fast path for synchronous cached file reads produced the same title motion failure and was reverted. The isolated perf harness then sampled the warmed title for 15 seconds at the same `1080x2160@480` geometry. SwiftShader presented 607 frames (40.45/s) with 25.3 million native instructions and 242 ms native execution; the Apple M4 Pro ANGLE Metal path presented 900 frames (59.98/s) with live ticks and no errors. This comparison attributes a material portion of the retained software-renderer shortfall to the browser's rendering backend, not to the small amount of guest CPU work in the warmed window. Startup decompression remains a separate cost.

### Main-queue callbacks and image opacity

Amazon's startup main-queue trace showed UI callbacks queuing behind an existing main job. Android's `Activity.runOnUiThread` runs a Runnable immediately when the caller is already on the UI thread, whereas Webdroid had always posted another job. The delegate now runs inline only when both Java's current thread is the main thread and Webdroid owns the main job; other callers still post. The inline-ordering check passed, as did the full 1,371-test suite and FitNotes' 39-step flow. A later Amazon page still spent time in queued jobs and showed a blank shopping view, so this semantics correction is not credited with fixing its startup.

One JIT-enabled YouTube fast run logged 487 gaps, dominated by repeated native jumps into zero-filled code at `0x10004d20`, despite reaching all 16 flow steps. The matching JIT-disabled flow logged no such fault. A later JIT-enabled replay did not reproduce it; while resuming playback, it instead reported an uncaught `ImageView.setImageAlpha(int)` missing method and timed out in the player. AOSP keeps image alpha separate from View alpha and reapplies it when the drawable changes. The ImageView delegate now does the same. A focused opacity-and-replacement check passed, the YouTube XAPK compiled with zero method failures, and the next 16-step playback replay completed without a new API error or native fault. This leaves the intermittent native jump unresolved.

The later Maps DevTools trace found an attached `SurfaceView` whose buffer was presented 74 times. Java GLES20 issued `glClear` and texture binds, but no draw call. Two map payloads transferred 128 KB and 527 KB, while later matching requests were aborted. A blank framebuffer with no draw means neither a general missing EGL surface nor a blanket network failure explains the symptom; tile decoding and renderer readiness remain open.

Mihon's generic UI explorer took eight actions and observed no missing entries, but its Compose content collapsed into one inaccessible text node and it remained on onboarding. Manual taps crossed setup using the existing origin-private storage path, reached the library, local source, browse tabs and data settings. Empty-library backup failed with the app's own `IllegalStateException: No library entries to back up`; no platform error was logged. Chrome's file picker APIs reject calls after transient user activation expires. The host already queued directory selection for the next real pointer press on `SecurityError`, while open/save pickers caught every rejection and returned cancellation. A shared retry now covers all three picker forms; the focused stale-gesture save test and typecheck passed. This does not validate backup with populated content.

### Native UDP game transport

Among Us could retrieve a live public game list through HTTP but disconnected when joining. A native host trace found an IPv4 datagram socket whose two Unity `sendto` calls returned `-1`; native sockets delivered UDP only inside the browser process even though Java datagrams and the Bun server already had a remote UDP relay. Native datagram sockets now lazily use that relay for nonlocal peers, filter incoming packets by a connected peer when set, queue bounded packets for `recvfrom`/poll and close the relay with the final socket reference. The same Chrome DevTools flow then returned byte counts from `sendto`, received UDP packets, and entered a public lobby with other players. Typecheck and Among Us smoke compilation passed with zero method failures. The lobby logged repeated Unity `NullReferenceException` messages with no stack trace; no full match was captured. Cloudflare's deployed Worker has no UDP endpoint, so this result applies to the Bun development server.

### Maps application night mode and map responses

A later Maps reload surfaced an uncaught `UiModeManager.setApplicationNightMode(int)` call in Activity startup and a following `onStart` null error. Android's service accepts modes 0–3, maps explicit yes/no to the package's night qualifier and clears its package override for automatic/custom mode. Webdroid now persists that package override, restores it before app initialization and applies normal configuration delivery when it changes. The next Maps boot reported no missing entry or uncaught activity error; smoke compilation found zero method failures. The map remained blank with no GL draw call, so the method fix is not credited with restoring it. Temporary Java HTTP stream instrumentation showed the bundled client requested two successful `/glm/mmap` input streams and then disconnected without reading either. Chrome's resource timing recorded complete transfers of about 128 KB and 527 KB. The instrumentation was removed; further work must determine why the client discards those responses before changing the transport.
