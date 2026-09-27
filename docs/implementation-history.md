# Implementation history: durable findings

Updated 2026-09-25. [PLAN.md](../PLAN.md) tracks current status and
[AGENTS.md](../AGENTS.md) owns working rules. Results below describe observed
revisions and paths, not a guarantee for the current tree. Git history retains
intermediate runs. The [original APK audit](original-apk-coverage-2026-09-24.md)
and [15-app handoff](../corpus-plan-v2.md) record per-app evidence and next work.

## Evidence and harness

- A drawn frame, empty missing-call list or passing fast step covers only the
  observed path. Inspect every relevant process's `run.json`, `newMissing`,
  `newErrors`, `nativeRequired`, draw/layout/GL errors, advancing `wd.ticks` and
  completed presentation. Child diagnostics may arrive after the first frame;
  label unavailable snapshots instead of treating them as clean.
- The quick E2E gate (`bun run e2e`) runs the seven flows reproducible from
  local inputs; `--live` adds the seven network-dependent flows, which mixed
  upstream variance into every earlier pass/fail (Lichess readiness and Resy
  search timed out in the baseline all-flow run). Frame-rate thresholds are
  reported, not gated: under unrelated load Flappy Bird's `--jobs 1` title fell
  below 25/s with correct behavior. Use the serialized full lane for pixels and
  diagnostics and `perf-browser` for rates. Guest instructions, EGL swaps,
  decoded frames and browser presentations measure different work. Live content
  and tracing can change timing. `settleDelayMs` bounds work rather than forcing sleep.
- Test determinism findings: `mem_init` freed image pages without clearing them,
  so a reserve after an A32/A64 switch returned stale bytes (exposed only by
  randomized unit order). `readProcesses` waited two seconds per step for `wd` in
  frames that can never define it. Android-visible animation, drawing and
  scroller time read `performance.now` while `ValueAnimator` and `SystemClock`
  read guest time; unifying them on `uptimeMillis` made three identical FitNotes
  quick runs produce identical UI trees and images. The controlled clock still
  advances to due timers while `drive` waits on real work, so virtual time moved
  per step depends on host speed: CalculatorM's `=` ripple fade differs by up to
  17/255 between runs. Making it host-independent needs the main queue to
  distinguish runnable jobs from jobs parked on guest timers. Moving Mihon's
  Compose flows to the controlled clock after that unification still left the
  app-flow launch waiting for presentations that never arrived; they stay pinned.
- Komikku's flow, added at `c0b3684c`, reached every step and wrote its backup
  there; at `9ccf288c` onboarding stays on its first page and launch reports
  missing `OffsetDateTime.now(ZoneId)` and DOM methods. Bisection marks merge
  `20f5ba1a` (both parents pass), so the break comes from combining the corpus
  and main branches. The flow is itself timing-sensitive around the storage
  step: single runs of passing commits occasionally failed.
- Full capture fingerprints include browser action overrides and reference
  geometry; Android reference fingerprints exclude browser-only overrides.
  Reject stale or mismatched captures. Android recording stages a complete
  reference before replacing a golden. FitNotes' apparent regression after
  removing the browser status bar was an unmatched 24dp reference inset;
  matching viewport geometry resolved the selected visual gate without
  changing goldens. The Android recorder must wait for density and SystemUI
  insets to settle before reading metadata.
- The UI explorer journals semantic screens, attempted actions and diagnostics
  by APK hash. A structural scroll key bounds repeated swipes, but changing
  content can still defeat replay and its 256-state cap. Compose hosts can
  expose a single combined node, leaving generic actions unable to reach
  visible controls; a manual or positional flow remains necessary. The corpus
  report ranks diagnostics from child processes as well as the foreground app.
- API-33 differential probes at 1080×2160, 480 dpi found 0/1,000 differences
  in seven API recipes and 0/100 graphics differences on each of two small
  seeds. All 38 minimized graphics cases and 42 color-glyph probes passed.
  Larger 1,000-case graphics seeds still have 58 and 74 differences, including
  matrix/clip state, glyph coverage and Porter-Duff edges. Small-seed success
  does not establish graphics parity. See the [fuzz guide](../scripts/fuzz/README.md)
  for replay and failure bundles.

## JVM, DEX and process ownership

- Main-thread identity does not imply main-queue ownership. Boot, providers,
  application and activity attachment run in ordered jobs; `inMainJob()` marks
  ownership. Awaited callbacks can interleave bytecode. Restore the initiating
  Java thread after JNI, callbacks and class initialization: lost identity once
  let two Java threads share one native CPU and corrupted Cronet. Class init
  waits for concurrent initialization while allowing valid reentry and cycles;
  inherited static lookup must not rerun a superclass initializer.
- Numeric DEX constants need reaching definitions across CFG and exception
  edges to distinguish floating values from null receivers. Constructor
  lookup must not inherit a superclass constructor. Preserve defining-loader
  identity, descriptor-qualified static names, Java overrides and suspension
  during reentrant callbacks. `String.valueOf(Object)` must box the primitive
  representation before virtual `toString`; otherwise Feeder OPML wrote an
  incorrect value.
- Compiled methods, cold handlers and framework natives run synchronously and
  return a Promise only when a callee actually waits. Previously every
  non-leaf method was an `async` function and most natives awaited `vcall`, so
  each call allocated a Promise and every `HashMap.get` with a custom key, sort,
  wrapper iterator, text layout and View draw suspended the whole Java stack.
  Suspended frames join one continuation list per pending operation, so an
  N-deep stack wakes in one microtask. The installed hot body omits resumption
  (built on first suspension), which keeps it within V8's inlining budget.
  [DEX performance architecture](dex-performance-architecture.md) records the
  model, diagnostics and rejected designs. At 4x CPU throttle Mihon reader
  scrolling went from 27 to about 44 presented frames/s, with input handling
  per swipe falling from 158 to about 65 ms. Earlier measured steps: smaller
  CFG preparation, reaching-definition set sharing, and direct cold operands.
- Generator natives must receive every argument: a wrapper specialized on the
  generator's `length` stops at a defaulted parameter and silently dropped the
  caller Runtime that caller-sensitive natives (System.load) are passed.
  A generator native whose only yield is its tail returns that call directly;
  a void native's final `yield X` must stay, or it would return X's value.
- Remaining suspensions in Compose apps are mostly legitimate: coroutine
  worker parks, contended monitors and background SQLite/Firebase work. Probe
  them by counting natives that return Promises before converting more code;
  the counts, not async syntax, identify what suspends callers.
- Measurement pitfalls: a V8 CPU profile's first sample carries the gap since
  `Profiler.start` and inflated `(program)` to 15%; the true async overhead was
  about 4% of busy time after the conversion (11% before). A forced full GC
  immediately before a measured window deoptimized about 360 functions. On this
  M4 Pro, native GL games reached 60 frames/s with a hardware GPU even at 4x
  throttle; their lower SwiftShader rates measured software raster.
- Launch: pure-JS SHA-256 of a whole APK for `PackageManager.requestChecksums`
  cost about 800 ms of YouTube's launch (now native for inputs over 1 MiB);
  inflating DEX entries with `DecompressionStream` and typing constants only
  where a float reads them cut Mihon's navigation-to-first-draw from 1.77 to
  1.57 s. Dispatching pointer events on arrival rather than at the next
  animation frame cut Calculator tap-to-present p50 from about 70 to 55 ms.
- YouTube full-lane frame rates depend on live content: a baseline run whose
  tap landed on a sponsored result never opened the video and reported idle
  60 fps ticks. Check that playback produced GL frames before comparing.
- `DexLink.s` reuses immutable DEX strings; paged method/field caches avoid
  untouched ranges. Replacing them wholesale with Maps regressed TikTok
  startup. APK/XAPK loading preserves split precedence, distinct DEX entries,
  signatures and ABI selection. Lazy and resident asset-pack splits both use
  first-wins precedence, and range caches stay bounded. Eager expansion of a
  large asset pack once exceeded V8 heap. DEX v41 offsets are container-relative.
- Processes own separate JVMs and native memory. IPC transports serialized
  Parcels and handles, never Java objects; replies must reach callers waiting
  on main queues. Coverage probes are selected before method generation and
  propagate to child realms; disabled methods contain no probe branch.

## Java, storage and framework semantics

- Collection views remain live. Copying `subList` or map views broke Compose
  anchor deletion and Glide ownership. Virtual `List.sort`, `retainAll`,
  iterator removal and comparison callbacks can suspend; revalidate a list's
  structural revision afterward. CopyOnWrite iterators remain snapshots.
  `RandomAccess` affects TikTok's choice of removal path. `ArrayAdapter` must
  retain its live backing list.
- `sql.js` export closes and reopens a connection, destroying TEMP objects.
  Snapshot backing files after transactions using a nonblocking PASSIVE WAL
  checkpoint, while separate SQLiteOpenHelper instances keep independent
  connections and TEMP schemas. Shared private files use IndexedDB when
  base64 localStorage quotas are too small. The vendor SQLite build binds
  genuine int64 values; unsafe numeric rows reread as BigInt. Rounded IDs
  cannot be recovered. Restore private, external and document-handle state
  before startup consumers run; disposable cache files need not persist.
- Shared file writes must refresh open RandomAccessFile views: Organic Maps'
  parallel range downloads initially overwrote each other, and an extended
  VFS file left a native handle's byte view shorter than its logical length.
  The latter made a byte-perfect Monaco download fail BLAKE3 verification.
  Browser document descriptors share a seekable backing by document ID; final
  close commits to the selected file. Tree grants and single-file picker
  handles persist with their owning documents across reload.
- Resource IDs, themes, overlays and density drive widget geometry. AOSP
  framework jar and resources must come from the same build; relinking shifted
  internal IDs. Keep provenance cuts in `src/jvm/provenance.ts`. Measurement
  invalidation follows the parent chain; requests raised during layout replay
  after flags clear. `SurfaceView` surface synchronization follows frame changes
  even when an app override omits `super.onLayout`: this enabled NewPipe's
  visible video and Fossify Gallery's short fixture.
- Java virtual dispatch controls View/Drawable drawing, text measurement and
  InputConnection. A handled long press must suppress the following click;
  this fixed Aegis selection. `ViewGroup.addView(View)` creates default layout
  parameters before calling the app's three-argument override; otherwise
  KeePassDX's editor omitted fields. Back targets the topmost window. Report
  draw failures and recover the frame loop instead of retrying every frame.
- Canvas2D remains the normal software draw path. Record RenderNode commands,
  but read nested node/video contents at replay and present completed offscreen
  bitmaps atomically. Graphics oracle repairs include float32 matrix behavior,
  reversed paths, device-space clips, non-AA masks, `SRC_IN` coverage, alpha
  boundaries, ligatures and API-33 COLRv1 emoji. A direct ClipBox replacement
  and an axis-aligned clip shortcut regressed retained cases and were removed.
- CharSequence and shared Paint metrics govern text. Replacement spans stay
  indivisible in wrapping. Browser input routes through InputConnection and
  actual Editable methods; wheel input needs timestamped drag/inertia events.
  Touch dispatch goes through Activity, Window and decor so Unity receives
  fallback `Activity.onTouchEvent` calls.
- WebView proxying retains method, form body, user agent and isolated cookies
  across redirects. POST form navigation does not call
  `shouldOverrideUrlLoading`; missing form interception once sent Amazon's
  cart POST directly to a blocked iframe. Same-document fragments send history
  and finish notifications without fabricated full-document callbacks. Static
  `Location` virtualization fixes microG OAuth hostname use; dynamic names,
  generated code and service workers remain outside that transformation.
  WebView bitmap capture uses DOM rasterization for simple preview documents;
  external media and complex CSS need separate validation.
- The account store owns identities and credentials across processes.
  Visibility grants account identity, not password/token access; password
  changes invalidate cached tokens. PendingIntent and alarm identity belong
  to the broker, preserving creator UID and wall/elapsed timing. A five-minute
  alarm recovered microG MCS after a killed process, but immediate sticky
  service behavior and indefinite uptime remain unproved.

## Native CPU, media and transport

- The Zig Wasm core executes ARM32/A64. Interpreter and JIT must agree on
  registers, memory, flags, faults and callback order. Compare `?jit=0`, then
  narrow with `__wdJit` or `core.jit_fallback(lo, hi)`. Writes to executed
  pages invalidate decoded instructions and regions; install regions only
  against the source-page epoch. A region discovery budget once let a branch
  enter with stale carry and broke Lichess P-384 TLS only under JIT.
- A signal handler's ucontext is loaded back inside `Cpu.call`, before the
  interrupted frame or another signal can run. Loading it after the call
  returned let a frame whose host call had completed meanwhile run a slice,
  then lose its registers, sp and pc to the signal-time snapshot. Boehm GC's
  suspend/restart signals (30/24) hit this constantly in Unity, crashing Among
  Us at random native sites; `?jit=0` was too slow (about 4M instr/s) to
  compare, and a tripwire on nested frames found it.
- JIT regions branch forward with a direct `br` to the later block's nested
  label; only backward transfers use the dispatch loop and check the budget.
  Region code keeps x registers in locals but reloads and spills them at every
  entry and exit; in Among Us Skeld practice that is about 13.8M entries/s at
  26 guest instructions each, and a region never spans a guest page, so calls
  to other pages always exit. A `fallback` spills, runs one instruction in the
  interpreter and reloads: counting them by word found FMOD's Vorbis loop and
  Unity at 774k/s (FP compares with zero, 64-bit lane SCVTF, FCVTN/FCVTN2
  whose emitter an `opcode >= 22` branch shadowed, CLREX, exclusive pairs,
  UMULH). Compiling those left 71k/s of scalar SIMD forms. About a third of
  guest instructions access memory, and 37% of those take the plane
  translation for mappings above 4 GiB (Unity and Boehm heaps).
- Rejected JIT experiments: treating flags as dead at A64 call/return exits
  (AAPCS64) changed no saturated frame rate beyond noise and breaks the tests'
  interpreter-equality contract at `ret`; routing scalar FP through the
  cached v128 locals measured within the ±5% noise of the game benchmark.
- Host calls exit `run_slice`; preserve guest frames, signal masks and
  callbacks. Joinable pthread handles remain allocated until join/detach:
  freeing one at thread exit let another thread reuse its address and made
  Lichess report `EDEADLK`. ARM64 signal context includes `fault_address`;
  futex and yield completion must defer queued signals until the parked syscall
  returns. Feeder later reached feeds and articles, but an intermittent Go
  `gcWriteBarrier` fault needs a longer stress run.
- Loader ABI is fixed per process. APS2/RELR relocations run before init arrays.
  Use unsigned addresses above 2 GiB, full-width `size_t`, bounded libc scans
  and open-file-description semantics for duplicate descriptors. Native
  bulk copy now uses Zig `@memmove` while callers retain address translation
  and executed-page invalidation; paired Chromium 4 KiB libc calls improved
  about 12×, not an app-wide speed claim.
- Cut the Rope exposed Thumb SIMD operand ordering, IT, wide branch and VFP
  faults. A clean visible level-one sample presented 434 frames in 12.05 s
  (36.0/s) and a rope swipe advanced the tutorial. Its AVC/AAC intro decodes
  real samples but stays black or fills output queues; a larger queue did not
  solve it. AAudio outputs real 24 kHz mono float PCM. Later gameplay rate,
  player/backend records and the intro handoff remain unverified.
- TikTok runs bundled ByteVC and EGL code. Fixed HEVC packets decoded 71
  frames in 776–785 ms of native JIT work versus 3,913 ms without JIT;
  fixed packets do not prove live playback rate. Bounding WebGL pixel views
  by unpack extent cut measured `getError` work from 718/772 ms to 4/8 ms
  in matched session phases. One 30-fps live segment presented about 29.7
  browser frames/s in its final seconds, but presentations include UI redraws;
  dense clips, original-rate playback and 150 ms action response remain open.
- Native TLS verifies real chains against pinned AOSP roots. Java Socket TLS
  terminates at the relay and cannot claim the guest's pinned chain. Wrapped
  SSL sockets keep the raw Java socket logically open until wrapper closure;
  closing it immediately made Amazon and AntennaPod's OkHttp reject healthy
  routes. Native remote UDP now reaches an Among Us public lobby through the
  Bun relay; the deployed Worker lacks a UDP endpoint and no full match was
  observed. The TCP relay handles partial writes and caps queued bytes.
- A proxy response's upstream `Content-Length` may be stripped by Bun's
  streamed response. Carry verified untransformed length separately and
  restore the Java URLConnection header; this let AntennaPod Media3 determine
  duration and advance its clock. Indexed URLConnection headers start with
  named fields while named lookup retains the null-key status line: Google
  Maps' bundled Chromium previously stopped at index zero and missed map
  response `Content-Type`.

## App investigations and remaining limits

- **Genshin Impact 7.1 (XAPK, ARM64 Unity 2017.4 IL2CPP):** reaches the logo,
  the Home scene and the login page context: it downloads the global dispatch
  and SDK configuration, runs SDK init/login and renders the Celestia login
  scene at full surface size. Causes found on the way: its allocator's 4 GiB +
  8 MiB read/write `mmap` failed and it built a heap at address 0 over thread
  stacks (now overcommitted, committed on touch); 32 MiB pool units exhausted
  the pool with 16 KiB/1 MiB mappings; missing `FromReflectedField`, array
  `getSuperclass` and ART's `ClassNotFoundException` for malformed array names
  made Unity's reflection fail asset lookups; `Os.chmod` absence surfaced as a
  Chromium fatal in `libtelemetry` (it treats any pending exception as fatal);
  `allocateDirect` buffers lacked ART's accessible array. The GC-finalizer
  deadlock was the sigreturn race fixed for Among Us. Open: first frames take
  about a minute and the scene runs far below 60 fps (unprofiled); Unity logs
  "custom render path shader needs N passes" every frame (compare the emulator);
  the ~30 GB resource download, account login and gameplay are unexercised; the
  guest's 4 GiB wasm address space is below the game's device RAM. The API-33
  emulator runs the same XAPK as an oracle (`webdroid_genshin` AVD, 4 GiB).

- **Play Integrity:** SPIC v1.4.0 renders unchanged Compose UI and reaches
  microG FakeStore, DroidGuard and Google's endpoint with `?attestation=1`.
  DroidGuard supplied zero bytes, microG had no Google auth token, and the
  endpoint returned HTTP 500 (`DF-DFERH-01`); SPIC showed
  `INTERNAL_ERROR (-100)`. Enabling attestation for all apps regressed the
  matched ChatGPT startup, so it remains opt-in. The API-33 Google APIs oracle
  lacks Play Store and returned `CANNOT_BIND_TO_SERVICE (-9)`. A licensed
  Play Store oracle with a successful request is needed; no verdict is invented.
- **Google Maps:** Indexed headers restored map payload reading and vector
  geometry; a pan advanced GL draws, and a route retry reached turn-by-turn
  preview after a first-attempt error. Earlier blank captures with completed
  tile bodies and unread `/glm/mmap` streams were real but describe an older
  state. Zoom, active guidance, backup and the first-attempt error remain open.
  `Geocoder` has no backend and returns no address. GmsClient's MapLibre map
  and permission-granted fused-location callback are separate positive controls.
- **YouTube:** Playback-path `AnimatorSet.clone`, `View.setZ` and image alpha
  implementations removed observed method faults. A mapped ELF image had
  been incorrectly rejected by `mprotect`, causing V8 ENOMEM. Targeted flows
  passed after repair, but an intermittent JIT-enabled branch into unmapped
  zero code near `0x10004d20` recurred. Page flags alone do not prove it was
  once mapped; tracing changed the reproduction. A range bisection or causal
  memory-lifetime trace is still needed.
- **Original game paths:** Among Us completed a live online Airship match
  through the Bun UDP relay: lobby, impostor role, movement, victory screen,
  XP, beans and EOS stat ingestion. Practice meetings, voting and chat through
  Unity's input overlay work. A first Skeld match start instead ended with
  "Reached timeout while loading game client" and a disconnect: the host
  waits a bounded time for clients to load the map, and a cold Skeld load
  takes about 6.4 s here. Unity rendered at 375×188: `eglQuerySurface`
  ignored `ANativeWindow_setBuffersGeometry`, so Unity fell back to a blit,
  and `ANativeWindow_getWidth` returned the geometry it had just set where
  Android answers the consumer's default size, applying the DPI scale twice.
  It now renders at 900×450, as the API-33 emulator does at 1080×2160@480.
  The game sets `vSyncCount = 0` and `targetFrameRate = 30` unconditionally
  (libil2cpp +0x2149dcc) and presents every 33.35 ms on the emulator; webdroid
  holds 30/s with about 30% idle in Skeld practice and 10% in a 15-player
  Airship lobby. Raising the target to 60 in memory, as a capacity probe only,
  gave 49–51/s in practice and 60/s in a small lobby. FMOD's stream thread
  decodes about 740 Vorbis packets/s in practice (~15 looping ambient streams,
  volumes set 441 times/s), about as many guest instructions as UnityMain;
  whether the device virtualizes those voices is unverified. Subway Surfers reached an active deployed run after
  implementing inotify for Firebase's watcher path; background Firebase
  initialization still throws. Doodle Jump's warmed title presented about
  40/s on SwiftShader and 60/s on Apple M4 Pro at matching geometry. The
  software-renderer motion gate remains open.
- **Open-source corpus:** NewPipe's visible AVC frames, nonzero PCM, seek,
  pause and persisted browser download are observed; audible output and opening
  the saved file from its own UI remain open. AntennaPod streamed, sought and
  played its downloaded MP3 after reload with network blocked; audible output
  and player layout remain open. OpenTracks saved a moving track, exported a
  valid KMZ with both coordinates and reimported it. KeePassDX persisted an
  edited KDBX3.1 entry across reload, without independent-format validation.
  Feeder loaded, saved and reloaded articles and exchanged OPML, but native
  stress remains. Markor's simple preview exported text and JPEG; PDF reached
  browser `print()` without a verified saved PDF. The [handoff](../corpus-plan-v2.md)
  lists every pinned app and its remaining feature paths.

## Deployment and measured cleanup

- The public Worker boots user-selected local APK/XAPK/APKS files. The WebView
  renderer runs on a separate Pages site because a second `workers.dev`
  hostname remained same-site in Chromium and blocked synchronous callbacks.
  Pages serves only WebView routes. Worker assets handle absent HEAD lengths,
  range probes and raw gzip system blobs. [Deployment setup](deployment.md)
  records hostnames and policy. Deployment checks do not validate arbitrary
  APKs or the Bun-only UDP path.
- Package-first UI keeps loading/recovery outside the framebuffer; Home
  starts a fresh session because loaded JVM class definitions survive a failed
  boot. Status-bar-free default geometry differs intentionally from reference
  captures, which carry their own inset. A 54-step FitNotes/Calculator/Flappy
  subset rendered after the shell change; matched starting-commit FitNotes and
  Calculator PNGs were identical. Flappy's auxiliary diagnostics failure
  reproduced on the starting commit. No Android goldens changed.
- Measured component cleanup retained UTF-16 conversion, stale-ancestor
  layout invalidation and async UI-tree capture under paired CPU/pixel gates.
  General dialog teardown and unconditional layout replay lacked Android
  evidence and were withdrawn. Other measured changes narrowed base64
  encoding allocations (5–6× in matched 64 KiB/1 MiB browser cases), skipped
  reading unrelated APK signature entries, and reduced selected Forge bundle
  size; these are component and bundle measurements, not whole-app gains.
  Fuzz scripts share native registration, SDK discovery and campaign session
  owners. Candidate code splitting follows ownership or a reproduced defect,
  not file size alone.
- The split production bundle shares chunks between `index.html` and
  `process.html`, so its module order under import cycles can differ from the
  unsplit dev server. A top-level `class JService extends JContextWrapper` in
  `runningservices.ts` (imported by `context.ts`) hit the TDZ only in
  production and left Open APK unwired. Top-level uses of cyclic imports must
  be removed rather than ordered: `JMessage` now lives beside `JHandler` in
  `os.ts`, so `messenger.ts` (which extends `JBinder` at top level) left the
  os → messenger → binder → parcel → os cycle, and `getPackageInstaller`
  (read by `pm.ts` method tables) is a hoisted function declaration.
  `tests/import-cycles.test.ts` rejects load-time reads of cyclic
  class/const/let bindings. Verify shell changes against `build:prod` served
  by `wrangler dev`, not only `server.ts`.
