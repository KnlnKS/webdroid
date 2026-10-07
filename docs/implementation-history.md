# Implementation history: durable findings

Updated 2026-09-27. [PLAN.md](../PLAN.md) tracks current status and
[AGENTS.md](../AGENTS.md) owns working rules. Results below describe observed
revisions and paths, not a guarantee for the current tree. Git history retains
intermediate runs. The original APK audit and 15-app handoff that recorded per-app evidence were
removed in 24cade3f; `git show 24cade3f^:<path>` reads them.

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
- Harness cost is not user cost. The driver's `latency` `up` includes `wd.tap`'s
  60 ms down/up hold, and a present hook that read pixels back synchronously
  delayed the next dispatch 100–300 ms per frame on SwiftShader (fixed in the
  driver by a downscaled `createImageBitmap`). Playwright's `Runtime.enable`
  makes every `new Error()` capture a detailed stack (~20 µs at depth versus
  ~4 µs without CDP); Snapseed's ~1,140 reflective NoSuchFieldExceptions per
  tool open cost ~65 ms only under the harness. Measure with real pointer
  events from the up (`plat`) or raw CDP, on the hardware GPU, on a quiet host.
- 2026-10-02, the serial `bun test` "hang" and the unit-suite prune. `bun test` without
  `--parallel` runs every file in one runtime. data.test.ts's `bootApp` ran bindApplication,
  whose `StrictMode.enableDeathOnNetwork` (targetSdk ≥ 11) armed the main thread that test bodies
  call Java from, so net.test.ts's `InetAddress.getByName` then threw NetworkOnMainThreadException.
  Bun prints a rejected non-Error value's own properties without honouring
  `nodejs.util.inspect.custom`; a JThrowable reaches its cold frames, DEX and class graph, so the
  failure printed 11 GB, which looked like a hang. `bootApp` now leaves the main thread's policy
  LAX. Unfixed limit: one Bun process holds one app, and `bootApp` returns the first file's
  Application to later files, so a serial run of every file still fails cases that need their
  own package (android-os's job service, notification's uid check), and prints such failures at
  length. Pruning (tests/ only): 37 files, 395 tests, 7,820 lines to 33, 298, 6,249,
  removing cases that only exercised libcore or framework bytecode since Stage F (the conformance
  suites cover libcore's) and folding legacy-api, security, java-concurrent, android-view and
  android-widget into the files owning their code. `bun run test` went from 10.6–12.1 s to
  6.3–8.7 s on a shared host: intrinsics.test.ts, the critical path, spent 8 s in
  `shiftRight(Integer.MIN_VALUE)`, which the BigInteger intrinsic delegates to an AOSP body that
  allocates a 256 MB magnitude per operand.

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
- Cold taps in large apps are mostly interpretation plus compilation (Tubi, in
  400 ms after a tap: interp 116–199 ms, compile 47–93 ms). Hot-promotion at
  8 or 16 calls instead of 32 did not help Snapseed or FitNotes and raised heap
  40–50 MB at launch; 16 looked better on Tubi tab switches but was within
  host-load noise. Re-run that A/B on a quiet host before changing it.
- Host timers take a signed 32-bit delay. Adjust's `ask_in` of 30 days wrapped
  and fired immediately, re-signing a request every ~300 ms (and producing
  most of the >600k `JNI:ExceptionOccurred` calls); guest delays are capped.
- A future cancelled by `shutdownNow` settles while its task still runs, so
  `awaitTermination` must use the executor's own count. Racing settled job
  promises spun 2.9M microtask iterations and ~2 GB of heap (Split SSE pool).
- All guest pthreads share the JS thread. Sustained background native work
  (ThreatMetrix hashing the 340 MB `base.apk`, Adjust `libsigner`) is held to
  about a quarter of it during the input window and while frames are presented;
  the UI thread and frame producers are exempt. Adjust `nSign`'s second call in
  Yelp spins >70 G instructions (calloc/free churn in flattened control flow)
  under both interpreter and JIT; its cause is not known.

- 2026-09-27, bytecode-first Stage A (docs/bytecode-first-plan.md). `invoke-polymorphic` and
  `invoke-custom` compile in both tiers: AOSP's 428 polymorphic sites are VarHandle access
  modes plus four `MethodHandle.invoke` calls, and its 15 call sites are record
  `ObjectMethods.bootstrap`; d8 keeps both only with `--no-desugaring`. Every class without a
  native spec or app definition now resolves through the reference build's boot jars and
  framework.jar (indexing 40,860 classes costs ~20 ms; all dex entries are stored). A native
  spec missing a platform method gets the platform body when every field it touches on native
  classes exists, else an `unsafe-fallthrough` report; reflection hides such bodies, because
  Room's reflective `SQLiteDatabase.getThreadSession` otherwise replaced its own fallback with
  a crash. Constructors and inherited virtual methods keep the prototype chain's answer: TS
  classes rely on an inherited no-op `<init>()V`. The fallback surfaced hidden-API paths that
  previously met a missing class: Shizuku's reflective `ServiceManager.getService` (flagged
  `unsupported`, so allowed on a device) now reaches a servicemanager context object that
  returns the documented null for services not hosted behind binder, reported as `[binder]`
  gaps; `SystemProperties` runs AOSP bytecode over the existing delegates. BOOT_COMPLETED
  resolved the paired framework-res manifest's system_server receivers, so broadcasts skip the
  `android` package. Live flows (TikTok, YouTube, Genshin) report further unsafe fallthroughs,
  binder services and natives (`UnixNativeDispatcher.init`, `AudioManager.getService`); TikTok's
  reply-side "Parcelable protocol requires CREATOR on android.content.Intent" was not reproduced
  outside its process. Advertising SDK 35 was measured and deferred: Calculator M's golden is
  API 33, and Mihon's dynamic-color tile needs the reference device's Monet overlay values,
  which differ from the paired framework-res defaults (for example `system_primary_container_light`).
  Komikku's backup/restore steps fail intermittently under five parallel jobs on the starting
  commit too ("handleLifecycleEvent must be called on the main thread").
- 2026-09-27 latency gate (`bun run lat`, raw CDP, pointerup to first changed frame): FitNotes'
  taps took 12-41 ms. Tubi's first skip, explore and home taps took 155-385 ms across runs, with
  12-70 ms compiling 280-960 classes and 22-146 ms in layout before the answering frame; under
  `?jvmProfile=1`, V8 compilation was about 45% of compile time, cold-handler building 35% and
  constant typing 17%.

- 2026-09-28, Stage A continued. The pulled core-oj differs from the one vendored before (Java 17
  APIs such as `ClassValue`, which needs `jdk.internal.misc.Unsafe` natives and ART's `ClassExt`).
  The reference device's Monet overlay replaces 140 framework-res `system_*` colors; without it,
  Mihon's dynamic-theme tile and Calculator M's keys drew the defaults at SDK 35. Advertising SDK 35
  exposed API 34/35 calls (`JobInfo.Builder.setTraceTag`, `UiModeManager.getContrast`,
  `createDeviceContext`, `setShareIdentityEnabled`, `LoudnessCodecController`) and a parcel bug:
  an `Account[]` was written as an object array, which AndroidX's typed `getParcelableArray` (used
  from API 34) rejected, so YouTube finished at launch. Persisting compiled bodies across launches
  brought Mihon's failing theme-switch tap from 180 ms to 75 ms and warm taps to near zero cold
  calls; rewriting a package's whole script every 15 s stalled YouTube, so saves append chunks
  from idle time. Registering the service worker at page start routed the shell's own
  `/proxy` requests through the WebView context lookup, which timed out; shell pages pass through.
  Under five or more parallel live flows, TikTok wedged and YouTube, ChatGPT and Komikku timed out
  intermittently; each passes alone, as on the starting commit.
- 2026-09-28, Stage B start. libcore's java.time tests run under TestNG (`conform ojluni-time`).
  Every class first failed in TestNG setup: Method/Constructor did not extend Executable, and the
  Package stub lacked libcore's fields. Building Package through the async `newObj` suspended a
  service's `onCreate`, and its continuation ran off the main thread, so Mihon's microG
  `ProvisionService` threw "handleLifecycleEvent must be called on the main thread". The TS
  Collectors lacked `CH_*`, so every factory it omitted failed as unsafe fallthrough; libcore's
  Collectors replaced it. Reflective calls did not widen `Integer` to `long`. With those fixes and
  ICU data mounted, passes rose from 0 to 15,763 of 24,367. Cutting `java/time/` to bytecode reached
  11,392 of 12,218 tests run: ICU's resource lookup falls through the TS `ULocale`, which lacks
  `localeID`. The java.time flip therefore waits on the ICU flip (plan step B.2). A 4217 server
  started before the `/vendor/aosp/icu` route existed served 404s, and Komikku then failed twice in
  the parallel gate. After a restart the gate passed repeatedly, with no ICU requests.
- 2026-09-28, Stage B flip of java.time, java.text, ICU, and java.util's TimeZone, Calendar,
  GregorianCalendar, Date and Currency, along with java.sql and android.text.format (103 TS classes,
  about 4,400 lines). libcore and core-icu4j now answer through natives: libcore.io.Linux (the old TS
  Os bodies, plus open and fstat), Memory, the ICU4C natives answered by ICU4J, OsConstants from the
  device's recorded values, and the boot jars' resources (calendars.properties, the Hijrah
  configuration). The default zone follows persist.sys.timezone through the RuntimeHooks supplier,
  as RuntimeInit installs it; without it, libcore falls back to GMT. ojluni-time rose from 16,698 to
  26,163 passes. java.util.Locale stays TS, because Paint, LocaleList, TextView and Configuration read
  its fields synchronously; flipping it too cost 3x the suite time. Loading the real zone took apps
  down paths that exposed two latent faults:
  - HashMap.computeIfAbsent's platform body could not run on the TS map. A body that cannot run now
    yields to the spec's interface default.
  - The TS Properties extends JMap, not the registered HashMap class, so its put was the platform's.
    A spec now inherits its declared superclass's methods before the platform's bodies.
  Service callbacks awaited in runningservices resumed under a worker's thread identity, which
  produced Komikku's "handleLifecycleEvent must be called on the main thread"; each call now names the
  main thread. Apps that format dates read the whole 28 MB ICU file into memory (FitNotes does), where
  a device maps it lazily. SystemClock.currentGnssTimeClock is libcore's, whose reads fail with an NPE
  while no location service is hosted.
- 2026-09-28, Stage B flip of java.util.concurrent's synchronizers and most of its queues:
  the locks, AQS, LockSupport, CountDownLatch, CyclicBarrier, Semaphore, CompletableFuture,
  the skip-list collections, ConcurrentLinkedDeque and the blocking queues other than
  LinkedBlockingQueue now run from libcore over the Unsafe park/unpark natives (about 1,000 TS
  lines removed). ConcurrentHashMap, the atomics, CopyOnWriteArrayList, ConcurrentLinkedQueue,
  the executors, FutureTask, LinkedBlockingQueue and TimeUnit stay TS: cutting the whole package
  raised JSR-166 further (2,916) but cost Mihon's cold dark tap 191 ms. JSR-166 rose from 1,448
  to 2,538 passes and Guava from 37,276 to 38,088. Warm Mihon `light` measured 111-119 ms with the
  cut against 120-128 ms in TS mode; the 18/20 ms TS samples taken earlier were the bimodal
  fast-frame case, not the norm. TreeMap had declared ConcurrentMap only because it shared a
  registration with ConcurrentSkipListMap.
- 2026-09-28, persisted code and launch. `bun run lat` now reports navigation to first frame.
  A warm Mihon launch reached it about 500 ms after a cold one (2.54-2.61 s against 2.05-2.11 s):
  its 48.7 MB of persisted bodies (23,840; microG's two processes add 63 MB) were preparsed at
  import and compiled again on the main thread at each method's first call (`bind`, 690 ms).
  Parenthesizing the factories compiled them with the module: main-thread compile at first frame
  fell from 515 to about 95 ms, but first frame did not move, because the launch then waited
  about 800 ms on the import and spent 330 ms finishing its compile. Serving the chunks through
  blob URLs instead of the service worker changed nothing, and a third launch (V8 code cache)
  helped little. Not awaiting the import matched cold first frame but ran startup cold (96k cold
  calls) and slowed the first taps. Saving bodies by the phase of their method's first call, and
  awaiting only the startup ones (12,400), brought warm first frame to about 2.1 s with warm taps
  unchanged. The phase must be the first call's, not the compile's: startup methods promoted after
  the first frame otherwise land in the later chunk and the next startup runs 12-17k cold calls.
  A pagehide save that awaited one write lost the second, and a reload inside 30 s saved nothing;
  both chunks are now written together, and the first save follows startup.
  Rejected: the frame loop's 50 ms back-edge yield gap (draw only) extended over insets and layout.
  Cold Mihon's slow `light` mode (a full recomposition, 15k cold calls, resumable bodies compiled
  as the deep measure stack suspends at each yield) moved from 144-159 to 141-148 ms over eight
  runs each, while `dark` gained 144 and 269 ms outliers against at most 83 ms: pointer events
  wait for the next yield.
- 2026-09-28, Stage B flip of java.util.Locale. The TS Locale invented values (three available
  locales, a 20-entry ISO-3 table, no extensions); libcore's now answers, starting from
  `user.locale`, which is persist.sys.locale (`device.locale`) as AndroidRuntime passes it. TS
  readers go through the Java API: a Locale's tag is `toLanguageTag()`, kept per object, and
  LocaleList carries its Locales' tags, so Configuration equality, layout direction and resource
  qualifiers stay synchronous. Configuration.locale is a public field apps assign, so the list is
  reconciled with it at the Java entry points (getLocales, equals, updateConfiguration,
  createConfigurationContext, the Resources constructor). ojluni-time rose from 26,163 to 27,514
  passes; TestUnicodeExtension from 41 to 500. Its "missing" names were collisions: the TS
  toString dropped `_#u-fw-fri`-style extensions. The earlier "3x suite time" was
  TestZoneTextPrinterParser doing its real workload over every available locale (117 s), not a
  hang. Cold Mihon `dark` rose from a median of 66 to 89 ms in an interleaved A/B (six runs each):
  AppCompat's createOverrideAppConfiguration parses a tag through libcore's LanguageTag for the
  first time (about 40 methods linked, prepared and run cold). Warm launches persist that code;
  cold `light` medians were equal (148.5 ms).
- 2026-09-28, background realms and the first tap. After the Locale flip, warm Mihon `dark` took
  253-342 ms in 4 of 5 runs (60-62 ms at the commit before; bisected in a worktree). The Locale code
  was not the cost (initDeviceLocales runs 4-9 ms): a microG process realm boots from about 2.2 to
  3.4 s, and the flip moved the main app's launch-idle point, where `lat` taps, into that boot.
  Realms are same-origin frames on the page's one thread, and the boot's `linkNatives` (100-215 ms)
  and platform-jar indexing (~45 ms) ran as single tasks. Slicing both, and yielding at
  `scheduler.postTask` background priority in realms that do not present, brought warm `dark` to
  61-83 ms and cold to 72-88 ms. The cold `dark` rise recorded for the Locale flip was mostly this
  collision, not libcore's LanguageTag parse. Two hypotheses tested first did not help: moving the
  first code save back, and leaving later code chunks lazily compiled.
- 2026-09-28, leaner emitted code. Registers a numeric constant cannot reach never hold 0 for null,
  so only constant carriers get `(vN===0?null:vN)`; suspension sites no longer store `$p` (the save
  point takes the tested `$t`/`$u`, or `$fu` when `$r` is 0); a one-block entry body with no branch
  has no dispatch loop. Mihon's eager source fell 6.0% and FitNotes' 7.1%. Suspension checks
  remain the largest pattern (22% of source), then `let` declarations (8%) and frame capture (4.6%).
  Rejected: promoting baseline-profile methods that already run cold (idle precompile skipped them,
  since their stub was gone), live ones first, with their resumable bodies. Mihon's profile names
  18,274 methods; idle precompile had reached 3,643 by the first tap and 13,373 by the second.
  Promotion cut the slow `light` tap's cold calls from 16.6k to 9.3k, but its time moved to
  resumable-body compiles as the now-hot frames suspended at yields, and building those in idle
  too left fewer promoted by the tap: slow `light` measured 151-162 ms against 147-150 at HEAD
  in an interleaved A/B.
- 2026-09-28, java.io.File from libcore (B.7 cut 2). The TS File returned the current time for
  lastModified, a constant for free space, and success for permission changes and for
  createNewFile under a missing directory. libcore's File runs over UnixFileSystem's natives on
  the VFS, which now records modification times. The first e2e run failed three flows: AndroidX
  ProfileInstaller creates `/data/misc/profiles/cur/0/<pkg>/primary.prof`, whose directory installd
  makes on a device, and the native threw ErrnoException where the JNI throws IOException, the one
  ProfileInstaller catches. libcore's UnixFileSystem also needs `java.home`, and `File.toPath` reaches
  `FileSystems.getDefault()`.
- 2026-09-28/29, java.io file streams from libcore (B.7 cut 3). The TS FileOutputStream held
  every write until close and created files where no directory existed; its descriptors named a
  path that consumers reopened lazily, so a stream over a RandomAccessFile's descriptor needed a
  special case. libcore's streams run over the Linux natives. A FileDescriptor made with `rt.make`
  alone has no `releaseLock`, so `release$` threw an NPE; `mkFd` runs `<init>()V` as
  jniCreateFileDescriptor does. libcore's FileChannelImpl cannot run on the TS FileChannel (no
  AbstractInterruptibleChannel state, NativeThreadSet or address-based dispatcher natives), so a TS
  FileChannelImpl answers `getChannel()` over the stream's descriptor; ICU's data mapping goes
  through it. openFileOutput now makes the files directory, as ContextImpl does. Writable provider
  descriptors had no file behind them, so a FileOutputStream over one failed; they get a backing
  file, and AutoCloseOutputStream writes a backed descriptor's file, since the last close used to
  send the stale backing bytes after the stream's own. Warm Bun timings through vcall, before and
  after: 8 KB reads and writes of 4 MB 1 ms both ways, buffered 1-byte writes of 4 MB 150 to 183 ms,
  unbuffered 1-byte writes of 256 KB 10 to 81 ms, RandomAccessFile readInt x100k 26 to 62 ms and
  readLine over 1 MB 5 to 155 ms (one read per byte, as on a device). luni-io went from 974 to
  1,012, mostly RandomAccessFile, FileInputStream and FileWriter tests.
- 2026-09-28, java.net.URI and the cookie model from libcore (B.7 cut 7b). The TS URI parsed
  lazily with a regex and never rejected input; its cookie store keyed cookies by strings, so it
  could not answer as InMemoryCookieStore does. HttpURLConnection now asks
  `CookieHandler.getDefault()` and builds each hop's URI through the Java constructor, escaping
  what WHATWG URL leaves in a path or query and RFC 2396 rejects (`|`, `{`, a bare `%`), as
  OkHttp's HttpUrl.uri() does; without that, a redirect to such a URL threw URISyntaxException.
  luni-net went from 338 to 472. Parsing measured 7.3 us per typical https URL against 0.34 us
  for the TS regex parse: libcore validates each character through `URI.match`, which shifted a
  BigInt `1L << c` per call. A table for `1L << n` in shl-long and a non-allocating short-string
  `String.indexOf(int)` brought it to 4.8 us (resolve 1.8 us against 0.19). The rest is the
  emitted dispatch loop around small methods and the nest-access trampoline in front of
  `match`, general emitter costs rather than URI's. indexOf(int) also truncated supplementary
  code points to their low half.
- 2026-09-29, java.net.URL from libcore (B.7 cut 7c). The TS URL parsed with WHATWG URL and
  answered openConnection/openStream itself, so libcore's handler resolution
  (`URL.createBuiltinHandler`) never ran. libcore's URL now resolves http and https to
  `com.android.okhttp.HttpHandler`/`HttpsHandler`, as a device does; those two are TS specs whose
  connections are the fetch-backed HttpURLConnection, which reads the URL through its getters and
  throws OkHttp's `Invalid host` UnknownHostException for an empty host at connect. file: and jar:
  are libcore's sun.net.www handlers. Findings: a TS spec declared over a bytecode superclass did
  not inherit its methods (its JS class extends JObj, and a native spec counts as initialized, so
  the super was never compiled); `link` now re-parents such a spec onto the bytecode class and
  compiles it, which also gives the TS BufferedReader Reader's own methods. Fallthrough prefers a
  method the prototype chain reaches, so a spec over a bytecode super must spell out an override
  its platform class declares (ClassPathURLStreamHandler.openConnection). Class loader resources
  now come from libcore's ClassPathURLStreamHandler, one per archive as DexPathList keeps them, so
  their URLs read `jar:file:/data/app/base.apk!/x` as on a device. That needed JarFile over the
  TS ZipFile: `ZipFile(File,int,boolean)`, `ZipEntry(ZipEntry)`, JarFileEntry from getEntry and
  entries (ZipFile.getZipEntry does this for a JarFile), `getManifestName` and
  `getManifestAndSignatureRelatedFiles`. A device opens class path archives with verify=true; for
  a v1-signed apk (TikTok's MANIFEST.MF is 2.2 MB) JarVerifier's PKCS7 parse runs
  sun.security.util.DerInputBuffer, a bytecode ByteArrayInputStream that reads the TS stream's
  missing `buf`/`count` and fails, so the class path handler's constructor stays TS and opens the
  archive unverified until that stream moves to libcore. An app-built jar: URL to a signed archive
  still verifies and fails the same way. luni-net went from 476 to 537 (URLTest 61 to 91, harmony
  URLTest 10 to 26, OldURLTest 18 to 26); luni-io 1,221. V8 (node) steady cost per call, tip
  against libcore: `new URL(s)` 0.38 to 0.85 us, relative 0.57 to 0.96, toString 0.064 to 0.117,
  openConnection 0.110 to 0.120, getters 0.108 to 0.012, hashCode+equals 0.27 to 0.05. The first
  2,000 constructions average 11.9 us against 1.35 while the parse runs cold.
- 2026-09-29, live-flow fixes. YouTube's MediaRouteButton failed its main-thread check in about
  half the runs because `curThread` was still `Binder:1000`: a resumed generator that suspended
  again (`driveStep`), `withCallingIdentity` and the WebView bridge kept their thread across an
  await, and `launchActivity` restored its caller's thread asynchronously. Each now releases the
  thread when its work suspends or scopes it to the synchronous call (0 failures in 9 runs). A
  lazily read native static pinned any write to its declaring class, so a subclass declaring a
  same-named static nulled the parent's: Region nulled `Rect.CREATOR` at every boot and a TikTok
  Intent subclass nulled `Intent.CREATOR`. WindowInsets reports each bar's frame clipped to the
  window as its bounding rect, as `InsetsSource.calculateBoundingRects` does for a bar without
  explicit rects. XML `<transition>` had inflated as its first layer, which YouTube casts to
  TransitionDrawable.
- 2026-09-28, java.util.logging from libcore. zygoteInit ran from platform-jar loading, before
  `linkNatives`; once its time-zone setup reached libcore logging, a TS-built HashMap view had no
  linked methods and every app failed to boot. It now runs after linking and also installs
  AndroidHandler, without which SimpleFormatter printed its `%1$tb` pattern raw. Komikku's e2e flow
  failed about 4 in 11 parallel runs: its storage step waited for "Selected folder:", which the
  unselected state already shows, so a late picker result left later taps a page behind. With the
  wait on the granted URI, 2 of 14 runs still settled on pixels mid-transition after "Get started"
  (HEAD 0 of 24); per-step times matched HEAD's, so no slowdown was found behind it.
- 2026-09-28, override bypasses. `bun run bypass` (plan §5.6) found 786 places where a TS method
  answered without the overridable method AOSP's body calls and a corpus app overrides; about 230
  were fixed that day. The most consequential: no view's onScrollChanged or onWindowFocusChanged
  ever ran; Activity.setTitle never reached onTitleChanged, so AppCompat toolbars missed titles;
  canScroll* returned a stubbed false; an app's own Drawable never received setColorFilter(int,
  Mode); Resources subclasses serving their own strings were skipped by getString. Two fixes had
  a cost to watch: Random first drew through a generator per call (2.3-3x slower for a plain
  Random), so a plain Random keeps its direct LCG and only a subclass overriding next(bits) takes
  the dispatching path; and per-frame paths (layout's setFrame, refreshDrawableState's invalidate,
  Drawable.setBounds) call an override only when the app declares one.
- 2026-09-28, android.text.Html from AOSP bytecode. The TS converter walked the browser's DOM and
  passed a null XMLReader to Html.TagHandler, so Harmonic (htmltextview) threw an NPE: its handler
  calls `getContentHandler()` and installs itself as the parser's ContentHandler to read
  attributes. Html, HtmlToSpannedConverter and TagSoup (ext.jar) now run unchanged. A differential
  over 29 inputs first showed every span of an element starting at offset 0 missing: the TS
  getSpans hid the converter's zero-length marks there. With that fixed, the remaining differences
  are AOSP's: html/body and `</img>` reach the TagHandler, unknown tags close where TagSoup's schema
  closes them, text-align makes AlignmentSpans, FROM_HTML_OPTION_USE_CSS_COLORS and `@color`
  references apply, script text is kept, sizes are floats, and toHtml emits markup (the TS one
  returned plain text) while escapeHtml leaves quotes alone. Headless Chromium, a 1.9 KB HN comment:
  TS 60 µs per call, bytecode 257 µs (4.2x); the first call costs about 50 ms (HTMLSchema's
  initializer about 17 ms of it). TagSoup's HTMLScanner.scan is a quarter of steady-state time.
- 2026-09-29, structured hot entries. The forward-only change (blocks in pc order, a branch
  breaking out of a labelled block that ends at its target) cut `new URI(s)` 24% in Bun, which
  showed the `for(;;){switch(pc)}` dispatch itself was costly: every register is live across one
  loop header, so V8 sees no natural loops. Hot entries now split into single-entry regions (the
  method entry, each handler, and blocks several of them reach; a block whose immediate dominator
  is the virtual root), each ordered as a topological order with loops contiguous (inner loops
  collapsed to their headers, lowest pc first). Back edges `continue` a labelled `for(;;)`,
  forward edges `break` a labelled block opened at the first breaking block and widened until all
  scopes nest, and only region-crossing edges set `pc` and continue the outer loop. A conditional
  whose taken edge is the next block is inverted. Yield checks moved from `target <= pc` to the
  flow's retreating edges: a rotated loop's back edge can point to a higher pc. Measure in V8,
  not Bun: in JSC the allocation-bound `small` loop ran 52% slower while V8 showed no change, and
  V8 showed an ArrayList add/get/iterate loop 4.5x faster (557 to 125 µs per 2,000). Per-site
  caches for hot invoke-direct targets and const-class, and own-class statics called on `C`, were
  within noise individually in both engines and were kept. 8 of 219,874 framework methods are
  irreducible and keep the dispatch loop; resumable bodies keep it too, since they re-enter
  mid-block.
- 2026-09-29, collection and java.io follow-ups recovered from the crash. An IdentityHashMap's
  `values().remove(x)` removed the first equal value, not the identical one. `StringBuilder.append(
  CharSequence)` took the async path for every argument, so each libcore `StringWriter.write`
  suspended (PrintWriter 2.2x slower than TS until fixed, then 6x faster). `CharBuffer.wrap` of a
  fresh `char[]` read its ArrayBuffer, which the engine copies on first access, and encode ran
  through a generator per call; OutputStreamWriter went from 9x to 1.5x the TS time, the rest being
  libcore's StreamEncoder call chain (the TS writer was UTF-8 only and held output until flush).
  DataOutputStream from libcore is 4.6x faster than TS, whose superclass was wrong. Not flipped:
  BufferedInput/OutputStream from libcore passes all 99 Buffered tests but is 1.13x slower on byte
  streams and 8x under the TS DataInputStream; PrintStream is blocked on `System.out`/`err`, which
  are TS console streams set at module load.
- 2026-09-29, B.4 collections measured in V8 after structured hot entries, not flipped. Node 24,
  one process per workload and side, 7 interleaved reps, medians; the cut is ArrayList, LinkedList,
  HashMap, LinkedHashMap, HashSet, LinkedHashSet, ArrayDeque, TreeMap, TreeSet and the Abstract*
  bases (`Class$` form). Steady ms per call (TS / libcore): the plan's 20,000 mixed-key mix 2.98 /
  2.63; ArrayList add+5x get of 2,000 0.075 / 0.189; iterate 0.063 / 0.093; remove(0)/remove(Object)/
  remove(last) 7.23 / 1.19; HashMap String keys 0.336 / 0.477, Integer keys 0.635 / 0.332; entrySet
  and keySet walks 0.436 / 0.310; LinkedHashMap 0.277 / 0.440; HashSet 0.172 / 0.329; ArrayDeque
  0.994 / 0.352; TreeMap 1.99 / 0.68; Collections.sort 1.60 / 1.54 (Integer), 2.35 / 2.54 (String,
  reversed comparator); LinkedList 0.093 / 0.110; 500 two-element ArrayList+HashMap allocations
  0.064 / 0.155. First use costs 5 to 16 ms more per workload (the mix 13.0 / 28.9 ms). libcore wins
  where the TS structures are wrong-shaped (splice removal, TreeMap as a sorted array, ArrayDeque as
  a JS array, a boxed key made into a `"I" + v` string per lookup), and loses 1.4x to 2.5x on the operations UI code does most:
  indexed get/add, String-keyed get, small allocations and HashSet's extra HashMap layer. The loss is
  frame count: a compiled frame costs about 2 ns in V8 (a 50,000-iteration array loop 3.8 ns per
  element, one extra call 5.9, a four-frame chain 11), and `ArrayList.get` is four frames
  (get, Objects.checkIndex, Preconditions.checkIndex, elementData). With the cut, guava runs its
  Maps suite (0 passes in TS: `initializationError`, a ClassCastException of MapKeySetGenerator to
  TestSortedSetGenerator in the suite builder) and totals 246,253 against 40,085, with 9,469
  regressions: 7,396 reserialization tests (TS ObjectStreams need the TS `serialization:` specs) and
  2,073 descending TreeSet views, where TS `Collections.reverse` reads `l.a`. jsr166 went from 2,544
  to 2,616 with no regressions. Both losses are TS consumers of TS layout, the refactor the plan
  names; neither is a libcore defect.
- 2026-09-29, paged file mappings. ICUBinary maps the whole 27.3 MB `icudt75l.dat` at class init,
  and `FileChannelImpl.map` copied it, so the first date format fetched and held all of it. Tracing
  DataView reads in V8 (a headless node bundle) showed a date format touches 165 4 KB pages
  (660 KB, 29 64 KB pages) over about 140,000 reads, the TOC's binary search plus a few `.res`
  items; formatting a date in all 853 locales touches 5.2 MB. A READ_ONLY mapping of an immutable
  source (a mount, not a writable or in-memory file) is now a table of 64 KB pages, each read from
  the file's own source on first touch (the descriptor may close first, as ICU's does). A
  MappedByteBuffer read of a missing page returns a Promise, so the Java caller suspends as a
  device thread blocks on a fault; missing pages of one access load in parallel. Slices and
  duplicates stay paged (and stay MappedByteBuffers, as on ART); a typed view loads its span and
  reads a contiguous copy, shared per range. TS code reading a buffer's bytes itself calls
  `resident(b)` first, which gives the buffer a contiguous copy; `ab` throws for a paged buffer, so
  a reader that misses the call fails loudly instead of reading zeros. A first attempt kept one
  full-size lazily zeroed ArrayBuffer with a residency bitmap, which keeps every existing reader
  working, but the process's footprint did not drop: libmalloc served the 28 MB calloc from its
  resident large-block cache and zeroed it (vmmap "Malloc Large" 115.6 MB in both), so savings
  would depend on the allocator. With the page table, `arrayBuffers` grows 4.5 MB for the date
  format instead of 28.5 MB (2.2 MB of pages, the rest view copies and other files), and Malloc
  Large stays at 74.9 MB. Reads stay as fast (copy, then paged): a mapped `getInt(I)` loop measured 11.2 and 12.0 ns
  and `getChar()` 12.0 and 8.6 ns, heap buffers unchanged, date formatting loops, resource
  lookups and the 853-locale sweep within noise. Explicit per-type read methods (no shared closure
  feedback) measured the same as the generated ones and were dropped. The apex mount fetches large
  files in 64 KB ranges: with a simulated fetch the first date format took 1.30 s against 1.56 s
  at 30 ms/200 Mbit, 1.64 against 4.95 s at 30 ms/50 Mbit, 3.7 against 12.1 s at 80 ms/20 Mbit and
  318 against 320 ms on a near-local link, fetching 2.8 MB in 44 requests; 256 KB ranges took
  20 requests and 5 MB for similar times, and serial 64 KB runs 1.72 s. The production worker sends
  no validators, so the whole file was fetched on every launch before. Unresolved: each fault is a
  round trip on a first touch, and no page profile prefetches the set a launch touched before;
  libcore's tzdata goes through `Os.mmap` into guest memory, still read whole.
- 2026-09-29, first-launch compile worker (§4.4). Precompiling Mihon's whole baseline profile
  synchronously at boot, as an experiment, cut the first-launch `light` tap from 147 to 124 ms
  (cold calls 15.7k to 2.5k) but moved the first frame from 2.2 to 3.3 s; the idle precompile had
  reached 3.6k of the 18,274 profile methods by the first tap. In V8 each profile method costs about
  40 µs to prepare and emit and 43 µs in `new Function`. A worker with its own runtime now emits
  the entries and the page imports them as modules, which V8 compiles off the main thread. Three
  placements were measured: importing in idle time after the first frame came too late (a
  launching page is not idle before its first taps; launch cold calls stayed at 125-157k); one
  import at a time throttled delivery; unthrottled concurrent imports finalized inside taps (in a
  145 ms first tap, 61.5 ms of `(program)` and 9 ms of `offerCode`; one `dark` tap hit 263 ms). At
  most three imports in flight, each waiting until 250 ms after the last input event, keep taps
  clear. A synthetic 3,000-body chunk blocked the main thread for at most 22 ms, so the remaining
  main-thread cost is V8's finalization, about 7-12 µs per body.
- 2026-09-29, UTF-32 and the charset table. Cut 4 made `Charset.forName` reject names it did not
  serve; TikTok's class init then failed on UTF-32BE. Probes on the reference device (app_process)
  gave the values the table holds. Android's UTF-32 is ICU's platform-endian converter: it encodes
  little-endian after FF FE 00 00 and decodes big-endian without a mark, unlike OpenJDK. The device
  lists 226 charsets (ICU converters); the TS boundary serves the 9 Unicode, ASCII and Latin-1 ones,
  and `availableCharsets()` still falls through to libcore's NativeConverter natives.
- 2026-09-29, java.nio.file from libcore (B.7 cut 6). The TS layer answered `FileSystems.getDefault()`,
  Paths and a few Path, Files and FileSystemProvider methods over the VFS. It had no directory
  streams, walk, relativize, toRealPath, link queries or attribute views. readAttributes reported
  zero times, Files.move ignored its options and isWritable answered existence. The corpus reaches
  far more: Paths.get in 21 apps, readAttributes in 19 (okio's NioSystemFileSystem, under OkHttp's
  and Coil's disk caches), readSymbolicLink in 17 and move in 17. libcore's classes now run over the
  natives of UnixNativeDispatcher, LinuxNativeDispatcher and UnixCopyFile (`os.ts`).
  - **Paths.** NativeBuffers copies each path into native memory with `Unsafe.allocateMemory` and
    `putByte`, now served from the process heap.
  - **Errors.** Failures throw `UnixException(errno)`. It is created without a stack, since its
    fillInStackTrace records none, and `init()` initializes the class, because the natives throw it
    synchronously.
  - **Capabilities.** `init()` reports SUPPORTS_OPENAT | SUPPORTS_FUTIMES, since bionic exports
    openat64, fstatat64, unlinkat, renameat, futimesat and fdopendir (NDK API 35 libc.so). Directory
    streams are therefore the secure kind, over dup'd directory descriptors. `javaFdStat` now names a
    directory descriptor's path.
  - **VFS limits.** symlink and link fail with EPERM, as the libc does, and readlink fails with
    EINVAL. chmod succeeds on an existing path. chown succeeds only to the app's own ids (EPERM
    otherwise). No extended attributes are listed, and fsetxattr fails with EOPNOTSUPP. Android's
    provider throws SecurityException from getFileStore itself, and getFileStores finds no
    `/proc/mounts`.
  - **rename.** rename(2) now fails with ENOENT or ENOTDIR when the target's parent is not a
    directory. Before, it created the path.

  Two costs showed up in V8.
  - **Suspension.** Channels' stream adapters wrapped every read and write in an `async` helper, so
    each Files.read and Files.write suspended its caller. A Java loop over such calls nests one
    promise per suspension, and V8's async stack capture walks that chain on every `new Error()`. One
    exception after 4,000 readAllBytes calls cost 200 µs instead of 14 (`node
    --no-async-stack-traces` confirmed it). The helper is synchronous now; on the tip the same
    effect made a throw-and-catch cost 110 µs after the earlier workloads, against 18 µs.
  - **Path normalization.** `vfs.norm` now returns an already-normal path unchanged. It had cost
    0.5 µs of a 4 µs readAllBytes. `fdInt` caches its field name.

  Measurement: V8 (node), tip against branch, 5 interleaved runs, median µs per operation, steady
  (cold):
  - readAllBytes of 4 KB: 1.03 against 5.27 (25.7 cold);
  - write of 4 KB: 6.14 against 4.91;
  - newBufferedReader over 100 lines: 31.0 against 25.3;
  - exists(file) + isDirectory + exists(missing): 1.89 against 16.8;
  - exists on a hit: 0.30 against 0.54;
  - Paths.get + resolve: 0.64 against 2.38;
  - File.toPath: 0.63 against 1.96;
  - Files.list of 25 entries: 31.1 on the branch;
  - Files.walk of 31 entries: 125 on the branch.

  Files.list and Files.walk failed on the tip. Exceptions stay the dominant cost of a
  miss: Files.exists on a missing path builds a NoSuchFileException with a stack (about 14 µs),
  where the TS layer answered without one. The new `luni-nio-file` conform suite (libcore's
  java.nio.file tests, without the mockito, junitparams and hidden-API classes) went from 109 to 173
  of 195. The remaining failures are permission bits, symbolic links, WatchService (the inotify
  natives are not wired) and IOException serialization. luni-io, luni-net and guava are unchanged.
- 2026-09-29, ZipFile measured against libcore's, not flipped. Withholding the TS
  `java/util/zip/Zip*` specs (`WEBDROID_BYTECODE`) fails first in ZipUtils' static initializer. It
  takes Unsafe offsets of ByteBuffer's `hb` and `offset`, which the TS ByteBuffer does not declare.
  InflaterInputStream, a TS stub without fields, has to move too, since ZipFile's inflating stream
  extends it. With both worked around in the harness only, libcore's ZipInputStream over the TS
  Inflater read FitNotes' 682 entries to the same bytes. It pushes back `getRemaining()` after each
  entry, so the codec boundary holds for containers. V8, Mihon's 67 MB apk on an async source
  (1,832 entries), TS against libcore:
  - ZipFile open: 420 against 179 µs (libcore hashes the CEN lazily);
  - JarFile reopen: 419 against 49 µs (libcore caches its Source per file);
  - getEntry: 0.28 against 0.85 µs;
  - entries(): 279 against 1,351 µs;
  - deflated manifest read: 102 against 117 µs;
  - stored resources.arsc read: 574 against 1,081 µs;
  - ZipInputStream over all of FitNotes' 4 MB: 34 against 140 ms (TS drains and inflates in one
    call).

  ZipFile stays TS until cut 5 settles the Buffers.
- 2026-09-29, rejected: per-site `$ic` caches for string constants, static calls and static fields.
  The dex-wide link tables are sparse `new Array(typeCount)`, so the hypothesis was dictionary-mode
  lookups behind the ~2 ns per compiled call the B.4 measurement found. V8 A/B showed ±10% both
  ways (`new URI` -5%), within noise. A synthetic 4-deep emitted call chain (try/catch, Promise
  checks, prologue) runs as fast as plain JS (about 3 ns), so the per-call cost lies elsewhere.
- 2026-09-29, where the per-call cost lies. `--trace-turbo-inlining` on a loop over libcore's
  `ArrayList.get` (15.9 ns per element against 7.3 for the TS list; a `long` accumulator is BigInt
  and swamps both) showed V8 declining to inline `get`: 281 bytes of bytecode for three Java
  statements, most of it suspension scaffolding, plus 486 bytes it had inlined itself, over the
  460-byte limit. Shortening the save point, prologue and catch took it to 217 bytes (kept), not
  enough. Rejected: proving call sites synchronous at runtime promotion (static and direct calls to
  `$sync` hot bodies, classes already initialized) so small methods compile as leaves. Error paths
  defeat it: `Preconditions.checkIndex` calls `outOfBoundsCheckIndex`, Kotlin's null checks call
  `throwParameterIsNullNPE`, and exception construction can never be proven. The suite moved
  within noise. Making it work needs a pending-exception protocol (a suspended throw unwinding
  through try-free leaves to the first frame with handlers, cold frames and TS boundaries), and
  persisted bodies would still run the conservative form.
- 2026-09-29, java.io's streams from libcore (B.7 cut 4 finished). InputStream, OutputStream, the
  ByteArray, Filter, Buffered, Data, Pushback, Sequence and Print streams, java.util.zip's Checked
  streams and InflaterInputStream, and java.security's Digest streams run from libcore; only the
  ObjectStreams stay TS (B.4). Findings: the TS InflaterInputStream was an empty stub whose reads
  returned -1 without reading, so `new InflaterInputStream(in)` never inflated; the TS
  `ByteArrayOutputStream.toString(String)` decoded UTF-8 whatever it was asked, and libcore's asks
  Charset.forName, so luni-io's `toString("8859_2")` test now fails (the charset boundary serves 9
  charsets); System had no `setOut0`/`setErr0`/`setIn0`, so `System.setOut` threw
  UnsatisfiedLinkError; ObjectInputStream's read methods read the underlying stream past the
  block-data framing. System.out/err/in are built as a device builds them: System's native spec
  has a `<clinit>` making the standard streams over descriptors 0 to 2 through the platform's
  `newPrintStream`, and zygoteInit runs `RuntimeInit.redirectLogStreams`, so out and err are
  AndroidPrintStreams writing lines through `Log.println` (INFO "System.out", WARN "System.err").
  Static reads are cached per site once a class is initialized, so the `<clinit>` costs nothing after
  it; it costs 12 ms cold in V8 but takes work out of zygoteInit (39.1 to 31.2 ms), net +4 ms. TS
  subclasses (sockets, the HTTP body and connection output, channels, local sockets, parcel
  descriptor streams, documents, Base64, Cipher, Deflater, GZIP and Zip streams, the ObjectStreams)
  re-parent onto libcore's classes and reach FilterInput/OutputStream's `in`/`out` through
  `filterIn`/`filterOut`; a lazy asset is an `AssetManager$AssetInputStream` over its entry, with
  mark and reset as on a device. The first measurement was far off: libcore's ByteArrayInputStream
  read() cost 14.5 ns a byte against 2.3 in TS, 12 ns of it the monitor of a synchronized method. A
  WeakMap lookup per enter and exit, and then a property load inside Monitors that every lock reaches
  (megamorphic), were both slow; the monitor is now `$mon` on the object, loaded at the compiled
  site (monomorphic) and handed to R.me/R.mx. Profiling the rest showed V8 never inlined an
  invoke-direct target: `$u.call(recv, ...)` records Function.prototype.call as the call target.
  Constructors and private methods are now also installed as `d<class hash>$<mangled>` on their
  class's prototype and called as methods (5 to 20% on these workloads; installing the names when a
  class's methods are installed, not at first resolution, kept cold boot level: adding them to a
  prototype whose objects exist cost zygoteInit 10%). invoke-super still calls through `.call`. V8
  (node 24), tip against the result, 7 interleaved process pairs, medians, first call and steady ms:
  ByteArrayInputStream.read() x1M 7.2/8.5 and 2.20/4.20; BufferedInputStream.read() x1M 31.3/15.8
  and 20.4/10.5; ByteArrayOutputStream.write(int) x1M 6.0/10.7 and 1.86/8.25; BufferedOutputStream
  .write(int) x1M 8.9/13.6 and 2.44/4.98; PushbackInputStream read/unread 41.9/19.9 and 34.9/13.2;
  4 KB and 700-byte bulk reads 0.52/0.50 and 700-byte buffered writes 1.18/1.12 (steady at 100
  calls); DataInputStream.readInt x200k over a buffer 18.1/30.1 and 14.1/12.7; mixed Data reads
  26.5/19.9 and 22.6/11.9; DataOutputStream 12.0/11.1; PrintStream print+println x50k 113/41.7 and
  108/28.8; System.out.println x20k (console stubbed) 8.3/1.1; readLine over InputStreamReader 5.8/5.6.
  Byte-at-a-time calls into synchronized streams stay slower: about 2 ns is the monitor (the TS
  bodies took no lock) and the rest is frame cost in the emitted body (try/catch dispatch, Promise
  checks), the §4.6 leaf-frame item. luni-io went from 1,223 to 1,275 (the one regression above);
  guava 40,085, luni-net 537, jsr166 2,544 and ojluni-time 27,514 unchanged. ojluni-time first lost
  13 tests: libcore's PrintStream.printf asks its Formatter for `locale()`, which the TS Formatter
  lacked. libcore's DeflaterOutputStreamTest now reaches its pipe
  read and times out at 240 s instead of failing at once: PipedInputStream waits for the writer
  thread to die, and the TS executor's worker never reports `isAlive() == false` after shutdown.
- 2026-09-29, resource natives as libandroidfw answers them (Stage C.1, first step). The delegates
  for AssetManager/XmlBlock/StringBlock answered off the app's one TS `Resources` with cookie 0,
  the device density and no ApkAssets, so AOSP's TypedArray could not read a string (it asks
  `ApkAssets[cookie - 1]`'s pool, or the XML block's pool for cookie -1). `res.ts`'s `Resources`
  is now AssetManager2 for both stacks: `getResource`/`resolveReference` carry the package, the
  ResTable_typeSpec flags (new in `arsc.ts`) and the selected density; bags are flattened with their
  parents, key-sorted (aapt2 stores a plural's "one" before its "other"), and fail when a parent is
  missing; `JTheme` is AOSP's Theme (a merged attribute map with force semantics, SetTo, Rebase),
  and `resolveAttributes` is AttributeResolution's ApplyStyle/ResolveAttrs/RetrieveAttributes in one
  pass, writing TypedArray's int layout or our own RVs. Behaviour that moved to AOSP's in the TS
  stack too: `Theme.obtainStyledAttributes(resId, attrs)` falls back to the theme (it is the style
  as defStyleRes), a defStyleAttr counts only when the theme holds a reference, and a theme
  application with force=false keeps existing attributes. `src/android/assetmanager.ts` holds the
  natives, with ApkAssets over the package registry (`packages`, by install path). Running AOSP's
  Resources needed four partial TS specs completed from the device: Environment's partition
  directories, `Build.VERSION.RESOURCES_SDK_INT`, ActivityInfo's `CONFIG_NATIVE_BITS` (read from its
  `<clinit>` payload) and DisplayMetrics' noncompat fields; plus `VMRuntime.addressOf` (a handle)
  and ImageDecoder.decodeDrawable. Under `WEBDROID_BYTECODE=android/content/res/`, `fwtest` now
  drives the Java classes end to end (ApkAssets, AssetManager.Builder with `getSystem()`, strings
  from both cookies, plurals through PluralRules, ApplyStyle, an XmlBlock walk with XML strings, a
  ColorStateList). V8 (Node, FitNotes' theme, median of 7 interleaved runs, 3,000 iterations after
  1,500 warm-up): styling every start tag of `activity_main` with View's and TextView's
  attributes 36.7 us at the base commit, 37.4 us with the new core in TS mode, 32.0 us through the
  bytecode path; six `Theme.resolveAttribute` 1.2 / 1.0 / 2.2 us; ten getString+getDimension pairs
  6.7 / 6.4 / 8.6 us. First calls cost more on bytecode (3.6 against 1.3 ms for the layout) and
  `AssetManager.getSystem()` takes about 35 ms once per process (OverlayConfig's partition scan).
  Before the theme memoised resolved values the TS path had regressed to 47 us.
- 2026-09-29/30, android.content.res from AOSP's bytecode (Stage C.1; f136d416, 33424e7e, 0c998fc6,
  2ce12bbe, 4d5b9ac2, f48221b3, merged as 131efb48). Apps boot through AOSP's ApkAssets,
  AssetManager and Resources (`src/android/resources.ts`), Contexts hold the Java Resources and
  Theme, and the TS specs for Resources, Theme, TypedArray, AssetManager, Configuration, XmlBlock,
  AssetFileDescriptor and ColorStateList are gone (about 1,050 lines). Headless view trees matched
  on 20 apks; every failure was browser-only. A file resource (`@font/...`) resolved to a fresh
  reference per call, so `rvString`, which resolves until the value stops changing, recursed
  forever (Harmonic). Context's resource getters awaited between `getResources`, `getTheme` and the
  final call and could resume on another Java thread, so a background load pushed its id onto the
  main thread's ThreadLocal LookupStack ("Recursive reference in drawable", TikTok); the getters now
  pin every call to the caller's thread. `Resources.getSystem()` had 0x0 metrics and an empty
  Configuration until the boot applied the device's, as `applyConfigurationToResources` does.
  `SoundPool.load(AssetFileDescriptor)` read a TS-only field and never completed, and Flutter's
  sound plugin blocks Dart init on it, so Lichess stayed blank; its visible symptom was Cronet never
  loading, found by diffing the page's logcat between the two paths. The cold-launch cost measured
  under the switch (Calculator 1.73 s against 1.35-1.5) did not survive those fixes: 5 interleaved
  `lat` pairs against 44da4521 give first frame 1,645 against 1,612 ms and idle 2,296 against 2,507;
  FitNotes and Mihon are level. Each realm still pays `AssetManager.getSystem()`'s OverlayConfig
  partition scan (about 27 ms in V8, mostly first-use code).
- 2026-09-30, platform Object overrides on spec classes. Fallthrough treated a method the prototype
  chain reached from java.lang.Object as implemented (and as the superclass's, kind 2), so 406
  platform overrides of toString, equals and hashCode on spec classes answered with Object's identity
  versions: ComponentName, Bundle, SpannableString, Location, Rect and so on. They now run the
  platform body, and one that reads fields its TS object lacks yields to Object's, as an interface
  default does; java.lang.Object itself is excluded (its own spec is JObj.prototype, and treating it
  as a subclass replaced its hashCode with core-oj's, which spun). One new failure followed:
  SQLiteProgram.toString calls getSql, which read an unmapped mSql (fixed by mapping the field).
  Conform unchanged on every suite.
- 2026-09-30, Stage C.2 first cuts. Rect, RectF, Point, PointF and Insets keep only their layout
  (fields and CREATOR/NONE, since a spec never runs its platform `<clinit>`), and AOSP's bodies run
  over it. RectF, PointF and Region needed JS classes of their own: as subclasses of JRect/JPoint,
  fallthrough found Rect's same-descriptor bodies on the chain and skipped RectF's (readFromParcel
  read ints, toString said "Rect("). Color and ColorSpace are AOSP's (Color's natives are Skia's
  SkRGBToHSV/SkHSVToColor in float; ColorSpace.Rgb's native instance holds its transfer function and
  XYZ matrix); the TS ColorSpace answered sRGB to everything, so color longs outside sRGB could not
  work. ColorMatrix is AOSP's; the TS ColorMatrixColorFilter reads its mArray. Matrix is AOSP's over
  the existing 3x3 natives, now following SkMatrix (quarter-turn snapping, mapRect/rectStaysRect,
  perspective mapVectors, mapRadius, near-singular invert, four-point setPolyToPoly) and writing in
  place, so TS state and a Java Matrix can share one array (`matrixOf`/`javaMatrix` in graphics.ts).
  TikTok's wedge rate looked worse after the geometry cut (8 of 23 runs against 1 of 17), but a later
  interleaved batch of the same two commits went 3/8 against 3/8: the flow's wedges follow host load.
- 2026-09-30, memory per realm. A heap snapshot of Calculator M after launch (3 realms) held 2.1 GB:
  1.65 GB of ArrayBuffer backing stores, of which the native core's 256 MiB wasm memory per realm
  (805 MB), CanvasKit's 128 MiB heap per realm and each realm's copies of the jars (76 MB) and
  framework-res (35 MB). Process realms now use the page's CanvasKit and view the page's jar and
  framework-res bytes (`pageShared`): JS heap 854 -> 635 MB, retained 2,115 -> 1,626 MB. Lazy method
  stubs carried a cell array, an $unsafe closure and a record whose getters were fresh closures (922
  bytes a stub in V8); records are now class instances and `$c` is allocated when a cache first holds
  the stub (274 bytes; linking the platform's 23,892 stubs: 60.1 -> 44.7 MB, 187 -> 176 ms). The wasm
  memory was left alone: V8 counts it as external memory, but a steady-state churn test showed the
  same GC count with or without it, and untouched pages are not resident. TikTok (5 realms) has a JS
  heap of 2.1-3.8 GB; its 360 MB of dex is already shared through packed archives, and the bulk is
  per-class and per-method state (the top realm links 42,569 classes). Allocation sampling over a
  TikTok run: 6.6 GB in 38 s, about half under cold execution and 2 GB in compilation.
- 2026-09-30, the zygote phase and platform-first precedence. A cold launch idled for about 200 ms
  on localhost while the page waited for the apk, fonts, provisioning and the display-rate probe, and
  only then indexed the boot class path and linked 1,904 native specs (about 150 ms), because the
  app's dex had to be indexed first so that an app's copy of a platform class would win. A device
  does the opposite (PathClassLoader asks the boot class loader first), so the platform is now
  indexed and linked when the page starts, overlapping the download; the app's dex follows, and the
  compile worker indexes in the same order. Cold `lat`, 4 interleaved rounds against 44da4521:
  first frame -150 to -220 ms on Calculator, FitNotes and Mihon.
- 2026-09-30, ColorFilters, Shaders and Path from AOSP (Stage C.2). The filters and shaders return
  handles to small descriptors (a 4x5 matrix, a colour and blend mode, a gradient/bitmap/compose/
  runtime recipe with its local matrix) that the Canvas2D renderer applies; the TS Paint reads a
  filter's instance when it is set and a shader's per shaded draw, so setLocalMatrix and uniform
  changes reach the next draw. Bitmaps and layers now honour a PorterDuff filter's mode (every mode
  had been SRC_IN) and radial gradients keep their focal circle. Path, PathMeasure and PathIterator
  run over natives ported from SkPath and SkContourMeasure, with the device's values recorded in
  fwtest (verbs, points, lengths, pos/tan, segments, generation ids, op outlines); the old natives
  returned placeholders for op, interpolate and approximate, ignored the clip op and lost the current
  point after relative moves, and clipOutPath did nothing. Arcs stay cubics where Skia keeps conics.
  Released handle slots are now reused, since recreated shaders and paths otherwise grew the table.
- 2026-09-30, measured and not built: precompiling a first launch from static reachability. Of the
  5,112 bodies a cold Calculator M launch persisted, 667 are platform code and 4,445 the app's, so a
  platform image (§4.1) pays little until the view stack is bytecode. For apps without a baseline
  profile, RTA from the launcher Activity (breadth-first discovery order, platform included so
  framework callbacks reach app overrides) reaches 20,117 app methods; covering 78% of the 3,830 app
  methods the launch ran takes its first 8,000 (37% precision), 49% at 4,000. The compile worker
  starts after the apk and the platform are loaded, so it could not deliver that ahead of a
  one-second first frame. The link table (5536ffbb) was the cheaper win: every realm of a first
  launch found its fallthrough gaps itself (93 ms of the cold Calculator launch).
- 2026-09-30, Character from ICU, and platform statics for spec classes. The TS Character answered
  classification with JS regexes and case mappings: isWhitespace and isSpaceChar were both `\s`
  (so NBSP was whitespace and tab a space char), getNumericValue parsed base 36, and isLowerCase
  compared case mappings. AOSP's Character now runs over libcore's 24 `*Impl` natives, each the ICU4C
  call java_lang_Character.cpp makes, answered by ICU4J's UCharacter (u_islower is general category
  Ll, so `ª` is not lower case on Android although it is on OpenJDK). A spec class can now run its
  platform `<clinit>` (`platformClinit`; Character needs TYPE and DIRECTIONALITY), which needed
  ART's `Class.getPrimitiveClass`. Conform unchanged.
- 2026-09-30, owned handles in place of finalizers. Region, RegionIterator, Interpolator, NinePatch,
  Camera, Picture and PathMeasure free their native state in `finalize()`. A JS finalizer cannot
  run it: FinalizationRegistry never hands back the object, and holding the fields finalize() reads
  keeps the object alive through any field that leads back to it (a Picture's recording canvas).
  What those finalizers free is a handle in a long field, so the creating natives return owned
  handles and a platform class declaring finalize() routes its long fields through a setter that
  makes the first object to store one its owner; the slot is released when the owner is collected,
  unless an explicit destroy freed or reused it first (401 of 401 released after GC headless).
- 2026-09-30, android.graphics.fonts from AOSP (Stage C.3). Font, FontFamily, FontStyle and
  FontVariationAxis run AOSP's bytecode over minikin's natives: a Font's pointer is a FontWrapper
  (one per Java Font, released by its registry) over a shared NativeFont (bytes, style, axes, path,
  locales, source id), and FontFamily.Builder's build registers the members as one CSS family, as
  the TS Typeface builders do; the TS Typeface reaches a Java FontFamily through `familyOf`. Two
  differences from the TS specs: CustomFallbackBuilder without a style is 400 upright (the specs
  took the first font's), and Typeface.nativeCreateFromArray now uses its families. Font.Builder
  over an AssetManager or Resources maps the asset through AssetFileDescriptor's stream, whose TS
  ParcelFileDescriptor.AutoCloseInputStream lacked FileInputStream's getFD and getChannel.
  Font.getGlyphBounds throws (glyph ids are not addressable: the browser shapes text), and
  nGetBufferAddress stays missing (no framework caller).
- 2026-09-30, Typeface from AOSP (Stage C.3). Typeface, Typeface.Builder and CustomFallbackBuilder
  run AOSP's bytecode; a Typeface's native_instance is hwui's Typeface (a minikin collection, the
  API style, the base weight and the drawn weight/slant) and the TS Paint reaches it through
  `typefaceOf`, cached per paint with the face minikin would draw from. The TS Typeface answered
  serif and monospace with the browser's generic families, gave `create(tf, 500, false)` and
  medium/light no face of their own, returned the old typeface from Paint.setTypeface, and gave a new
  Paint DEFAULT where AOSP has null. The system font map is AOSP's own: zygoteInit calls
  loadPreinstalledSystemFontMap over the page's fonts.xml and font_fallback.xml (sans-serif with the
  device's weight aliases, emoji fallbacks); families the page has no font for fall back to DEFAULT as
  Typeface.create does. System faces keep the CSS families the page registered (Roboto's four statics
  are now one CSS family, "Roboto", selected by exact weight) and the device's variable-Roboto metrics
  for every weight. The reference AVD's values for the constants, aliases, relative and exact weights
  and metrics are in fwtest: Android 15 keeps exact weights (`create(tf, 550, true)` is 2/550), clamped
  to 1..1000. Cost: the Typeface <clinit> resolves the locale's script through ICU's LikelySubtags,
  about 60 ms cold in a realm that had not loaded it (Calculator M boot 425 -> 510 ms; FitNotes and
  Mihon load it anyway, FitNotes +15 ms); the rest is 15 ms cold, 3 ms warm. Headless realms have no
  DOMParser for Xml.newPullParser, so tests parse fonts.xml with a minimal one (tests/java.ts).
- 2026-09-30, ChatGPT's "LifecycleOwner ... already garbage collected". It came from androidx's
  ServiceLifecycleDispatcher in the com.android.vending process: Service.onDestroy posts ON_STOP and
  ON_DESTROY runnables whose LifecycleRegistry holds the service weakly, and webdroid dropped its
  last reference to the service as onDestroy returned. ActivityThread.handleStopService keeps it
  reachable through ContextImpl.scheduleFinalCleanup's CLEAN_UP_CONTEXT message, queued behind what
  onDestroy posted; a main-queue job holding the instance now does the same. GC timing, not the
  Typeface cut: 3 of 6 live runs threw at 6e60ef3e, 0 of 8 with the fix.
- 2026-09-30, minikin and android.text's layouts from AOSP (Stage C.3). `src/android/minikin.ts` ports
  minikin at android-15.0.0_r1 with the reference build's text flags (letter_spacing_justification,
  phrase_strict_fallback, word_style_auto are enabled there; `aflags list` as root). Findings that
  decided the port, each checked against the device:
  - Advances come per LayoutSplitter piece (a word and its trailing space) with each cluster's
    advance on its first code unit; C0 controls advance 0 (the browser measures `\n` as a space);
    letter spacing is per non-control cluster, none for joining scripts, and half of it comes off a
    run's line edges, which TextLine marks with the hidden paint flags 0x2000/0x4000.
  - A paint without SUBPIXEL_TEXT or LINEAR_TEXT (TextView's, Paint()'s) measures whole-pixel glyph
    advances with fractional kerning, as Skia's hinted metrics do. Measuring subpixel widths put
    FitNotes-sized lines 1-2 px off and broke 13 of 72 device layouts; rounding fixed all but one.
  - Line breaks are ICU's line iterator (ICU4J bytecode over the reference ICU data) filtered as
    WordBreaker does: no break after a hyphen or soft hyphen (with hyphenation off, "well-known"
    does not break at its hyphen), none inside emoji ZWJ/modifier sequences, and URLs and email
    addresses broken by the Chicago Manual of Style rules.
  - The optimal breaker must compute in float: in doubles, desperate-break scores near 1e10 lose the
    ties minikin resolves, which changed 8 of 72 layouts.
  `bun run textcmp --record` runs scripts/TextLayoutProbe.java on the AVD (app_process needs
  ActivityThread.systemMain for LineBreakConfig's target-SDK check and
  Typeface.loadPreinstalledSystemFontMap). Fed the device's own advances headlessly the breakers
  reproduce 72/72 device layouts; in a page 71/72, widths within 1.03 px, the miss being the
  page's CJK fallback font. The TS Paint now carries its real flags and exposes mNativePaint and the
  compat-scaling fields, so AOSP's measureText (which rounds up), getTextWidths, breakText and
  getRunAdvance bodies run on it. Layout, StaticLayout, BoringLayout, DynamicLayout, TextUtils,
  LineBreakConfig, BidiFormatter, the text direction heuristics and android.text.method then moved to
  bytecode (text.ts 1,143 -> 452 lines; linebreak.ts and bidiformatter.ts deleted). The TS TextView
  builds its StaticLayout as makeSingleLayout does and draws with Layout.draw; touches reach its
  movement method, so links fire (they never did). Cost: Mihon's theme taps 10-15 ms slower once
  Compose's text runs AOSP's StaticLayout (warm light 75 -> 90 ms); every gated tap stays under
  150 ms. Hyphenation (no patterns on the page), glyph bounds (no overhang) and TextRunShaper/
  PositionedGlyphs remain unimplemented.
- 2026-09-30, system services behind binder (Stage D.3). Each service is a TS subclass of its AIDL
  Stub (`hostStub` in binder.ts; a Stub whose methods declare @EnforcePermission is built with a
  PermissionEnforcer), and AOSP's manager runs from bytecode over it, built as SystemServiceRegistry
  builds it (`AOSP_MANAGERS` in context.ts). In-process calls reach the Stub through
  queryLocalInterface without parceling. Hosted: activity, activity_task, audio (loudness only),
  window (animator scale, screen recording, keyguard), connectivity, power, thermalservice,
  deviceidle, user, uimode, alarm, clipboard, vibrator_manager, batterystats and
  batteryproperties, appops, trust, notification (an empty Stub; notifications stay TS),
  usagestats, jobscheduler, location, account, shortcut, locale, textservices, game, dropbox,
  restrictions, accessibility, auth and usb (fingerprint is built without a service, as on a device
  without the feature). Values come from app_process probes and
  `dumpsys` on the reference AVD; failure paths from the AVD's services.jar (`dis` reads it).
  Findings:
  - AppOps: a runtime permission's op is IGNORED until granted (the AVD lists every
    unrequested one as `ignore`), other ops take their default mode (MODE_DEFAULT for special
    access), and a package the uid does not own reads as the op's default when checked but ERRORED
    when noted. The TS manager allowed every op and had no permissionToOp.
  - Registering for BATTERY_CHANGED returned null: the platform keeps it sticky, and a receiver
    hears it at once (`stickyBroadcasts` in broadcast.ts).
  - Every generated Proxy obtains its parcel with `Parcel.obtain(IBinder)`, whose body calls the
    native markForBinder; it fell through, so no AIDL Proxy could call another process. Found
    through the account service, the first to call a Stub in another process (microG's
    authenticator).
  - A hosted service stands in for system_server, so its calls into other binders carry uid 1000
    (`asSystem`): an authenticator's @EnforcePermission(ACCOUNT_MANAGER) checks the caller, and its
    Stub, built in an app process, asks `ActivityThread.getSystemContext()` for its enforcer (the
    application answers there). AccountManagerService binds an authenticator with its action set;
    microG's onBind dereferences it.
  - JobScheduler, JobParameters, JobWorkItem, JobService and JobServiceEngine, Location,
    LocationRequest and the listener transports, AccountManager with its futures and
    AbstractAccountAuthenticator, and AttributionSource now run from bytecode; the TS halves are
    the IJobScheduler/IJobCallback, ILocationManager and IAccountManager services.
  - Locations need a location permission, and a caller without one sees no providers, as in
    LocationManagerService; the AVD's providers are passive, network, fused and gps. A coarse grant
    is not fudged.
  - TS copies of these managers had drifted from AOSP: DropBox reported every tag disabled (a
    device enables them by default), and ShortcutManager accepted intents without an action
    (AOSP's builder rejects them) and never normalized ranks. Hidden platform methods the managers
    reach were missing: `Context.getMainThreadHandler` (FingerprintManager), `Log.println_native`
    (every Slog), `Binder(String)` (AttributionSource's token).
  - Deliberately not moved: DevicePolicyManager and TelephonyManager. This device declares neither
    FEATURE_DEVICE_ADMIN nor FEATURE_TELEPHONY while framework-res is the AVD's (a phone, voice
    capable), so AOSP's managers would answer from a mixed device model; the device's features
    have to be decided first.
- 2026-09-30, java.util's collections, streams and ObjectStreams from libcore (Stage B.4). jutil.ts,
  jwrappers.ts, jstream.ts, jblockingqueue.ts and jobjectstream.ts are gone (about 6,000 lines),
  with them the TS ArrayMap, ContentValues, WorkSource, SearchRecentSuggestions, the
  android.database Observables, Timer, UnicodeBlock, both Base64s, the xmlpull parser (a replayed
  DOMParser tree) and org.json. TS reaches collections through `jcoll.ts`: ArrayLists it builds or
  reads through the list's own fields, everything else through Java calls.
  - Per-call cost, measured in V8 (node 24, one process per side, medians, TS / libcore ms):
    ArrayList add+5 gets of 2,000 0.19 / 0.11, iteration 0.16 / 0.19, String-keyed HashMap 0.25 /
    0.27, Integer-keyed 0.37 / 0.27, entry and key walks 0.45 / 0.48, LinkedHashMap 0.27 / 0.33,
    HashSet 0.20 / 0.24, two-element allocations 0.19 / 0.26, TreeMap 0.26 / 0.82 (the TS TreeMap
    was a sorted array; libcore's walks a red-black tree), the 20,000-key mix 0.97 / 1.41, first use
    10-20 ms more. Before intrinsics, get and iteration were 1.7x and 2.4x slower: the compiled
    frames were not inlined. §4.7 intrinsics (`rt.intrinsic`, differentially tested in
    tests/intrinsics.test.ts against the AOSP bodies) cover ArrayList get/set/add/size/isEmpty,
    its iterator, HashMap lookups of String and Integer keys, Arrays.copyOf(Object[]) and
    ConcurrentHashMap's bin accessors. They are compiled with their fields' literal names: written
    as `this[FIELD]` over a module binding (which a bundler turns into a mutable variable) each
    access stayed a keyed, megamorphic load and the intrinsics gained nothing. Arrays.copyOf's
    `getClass()` resolved the array's owning runtime from its descriptor on every call (180 of
    960 ms in the mix); array classes are now kept per asking runtime once their element class is
    linked. org.json from libcore parses a 150 KB document in 4.5 ms against 2.0 for the TS copy;
    intrinsics for JSONTokener's scanning loops changed nothing, so there are none.
  - Conformance: guava 40,085 -> 366,001 (its Map suites initialise now), jsr166 2,920 -> 3,130,
    luni-io 1,277 -> 1,321, luni-net 767 -> 779, ojluni-time 27,514 -> 30,603.
  - Latency, interleaved under the same (heavy) load: the tree passed `bun run lat` twice where
    its parent failed twice; FitNotes' first tap 52-72 against 263-274 ms, cold Mihon `light`
    127/24 against 186/139 ms.
  - The TS copies had diverged: every map iterated in insertion order, ArrayList also claimed to be
    a Deque, streams ran again after a terminal operation, org.json iterated integer-like keys in
    numeric order, ContentValues took a raw bigint as a Long, the TS Timer answered
    scheduledExecutionTime with the current time.
  - VM gaps the flip exposed: `Enum.getSharedConstants` (EnumMap), `VMStack.getClosestUserClassLoader`
    (ObjectInputStream.resolveClass), ObjectStreamClass.hasStaticInitializer and the object streams'
    float/double conversions, Unsafe's char and short accessors, `System.log`, UNIXProcess's natives
    (ProcessBuilder and Runtime.exec now fail in forkAndExec). Reflection bugs: getDeclaredMethod
    searched inherited methods (a LinkedHashMap serialized HashMap's data twice), native classes'
    fields were typed Object and their statics non-final (libcore hashed default serialVersionUIDs
    for the boxes), a serialization constructor did not initialize the class it allocates, and
    getConstructors returned non-public constructors (ForkJoinTask copied exceptions a device hands
    back as-is).
  - Harness: bun's test runner spends tens of seconds formatting a failed expectation whose value is
    a Java object (it walks the reachable heap); a Java object now inspects as its class and message.
- 2026-10-01, java.nio's buffers and charset coders from libcore (B.7 cut 5). Measured first: with
  the buffer classes cut over (`WEBDROID_BYTECODE`), libcore's heap buffers passed every harmony
  heap/wrapped/read-only buffer test the TS copy failed (the TS Long/Short/Double buffers lacked
  most of their API) at about the TS speed, and direct buffers only needed real addresses. So
  every Buffer class is libcore's, and TS reaches a buffer's memory as NIOAccess does
  (`bufferBytes`/`remainingBytes` in jnio.ts: `address`, else `hb` and `offset`, else a view's `bb`
  and `byteOffset`).
  - **Direct memory.** `VMRuntime.newNonMovableArray(byte)` allocates in guest memory (memory is
    sized for the app's ABI first, since growing it would detach the array) and `addressOf` answers
    its address, so allocateDirect's MemoryRef, JNI's NewDirectByteBuffer (DirectByteBuffer(JI)),
    GetDirectBufferAddress (`address`) and the NDK media buffers all share one memory. libcore.io
    Memory's natives serve DirectByteBuffer; `unsafeBulkGet/Put` index the element array in
    elements and the byte array in bytes (the TS copy never reached them).
  - **Mappings.** A READ_ONLY mapping of an immutable file keeps its 64 KB pages outside guest
    memory, at addresses from 2^48 (`Region` in jmemory.ts); the Memory natives read them and
    load a page on first touch (a Promise the caller suspends on), and native code asking for the
    address gets the whole mapping copied into guest memory once. Other mappings are guest memory
    kept coherent with the file as native MAP_SHARED ones are (mappings.ts); `force` syncs them.
    SharedMemory is guest memory its mappings address. Font buffers are read-only mappings of the
    font's bytes.
  - **Charsets.** Charset, CharsetDecoder/Encoder and CharsetICU's coders run from bytecode over
    NativeConverter natives: one ICU UConverter model per charset table (`Converter` in charset.ts)
    with ICU's partial input, overflow buffers, callbacks and error counts. A device probe (every
    served charset's metadata, and decode/encode of 26 byte and 9 char vectors under each action
    and output size) now matches except one: `new String({0xc3}, "UTF-16")` is "" on the device,
    U+FFFD here. Findings from it: after a malformed input a decoder's position is past it (ICU
    consumes it), an encoder's is before it; an unmapped byte in a single-byte table is unmappable,
    not malformed (only US-ASCII's high bytes are malformed); 27 bytes of 152 tables decode to a
    character that encodes to another byte (the table records them); aliases() includes the
    canonical name, in device order; the encode native reports the output offset reached, the
    decode native the count produced. String's own codecs stay TS (a VM built-in) over the same
    tables and follow Charset.decode/encode's allocation, including its 2n+1 growth.
  - Channels' TS stream adapters are gone (libcore's need `Thread.blockedOn`, now implemented).
  - Measured, V8, HEAD → this, median ms: heapGetInt 64K 3.5 → 6.0, heap get() 4.1 → 3.2, bulk
    get/put 0.12 → 0.15, FloatBuffer put/get 0.04 → 0.05, direct FloatBuffer put 0.025 → 0.093,
    direct putInt/putDouble/get mix 1.47 → 4.7 (a direct access pays BigInt address arithmetic),
    CharBuffer 1.7 → 1.1, CharsetDecoder UTF-8 100 KB 0.73 → 0.92, encoder 22.5 → 3.9,
    InputStreamReader 0.52 → 0.69, Charset.forName 0.47 → 0.37. luni-nio (new suite: libcore's
    buffer, charset and file channel tests) 926 → 2,616 of 2,815; luni-io 1,277 → 1,279.
  - Limits: the multi-byte legacy charsets (Shift_JIS, GBK, EUC-*, ISO-2022-*, UTF-7, CESU-8,
    SCSU, BOCU-1) and the x-UTF-16LE-BOM/x-UnicodeBig variants are unsupported, as before, and ICU
    aliases outside aliases() (`unicode-1-1-utf-8`) do not resolve.
- 2026-10-01, java.util.zip's codecs from libcore (B.7 cut 1). Inflater, Deflater, CRC32, CRC32C,
  Adler32, Checksum and the Deflater/GZIP streams run from bytecode over the 26 natives. The
  blocker was consumed input: libcore's natives return packed read/written counts, and okio's
  InflaterSource and GZIP trailers read the unconsumed rest back through getRemaining, which
  fflate's push API cannot tell. The natives run pako's zlib port at the z_stream level
  (avail_in/avail_out, Z_PARTIAL_FLUSH, dictionaries, raw streams), with zlib 1.2.12's
  deflateParams written over pako's state since pako leaves it out. The TS GZIPInputStream had
  drained its whole source before returning a byte. CRC32 is zlib's slicing-by-8. V8 medians,
  HEAD → this: CRC32 over 4 MB 7.6 → 2.7 ms, Adler32 10.2 → 2.1, GZIP round trip of 1 MB 9.8 → 9.0,
  InflaterInputStream over 1 MB 2.3 → 1.6. luni-io 1,279 → 1,337 (the harmony codec tests that
  still fail want resource files the suite does not package).
  pako's updatewindow, unlike zlib's, does not size a kept window again after inflateReset, so a
  reused Inflater (ZipInputStream resets one per entry) lost its back-references ("invalid
  distance too far back"); the reset native sizes it.
- 2026-10-01, ZipFile, ZipEntry and the Zip streams from libcore (B.7 cut 6). ZipUtils' Unsafe
  offsets of ByteBuffer's `hb` and `offset` resolve now that the buffers are libcore's, so
  ZipFile, ZipEntry, ZipInputStream and ZipOutputStream run from bytecode over RandomAccessFile and
  the zlib natives; the TS copies go (the TS ZipInputStream drained its source and read entries
  from the central directory). The shell's own zip reader (jzip.ts `centralDir`, `zipTree`)
  still loads apks and resources. V8, steady medians, HEAD → this: open + getEntry of FitNotes'
  apk 0.14 → 0.34 ms, of Mihon's 67 MB apk on an async source 0.40 → 0.88, entries() over its
  1,832 entries 0.57 → 2.0, 2,000 getEntry 0.53 → 2.1, stored + deflated reads 29 → 39,
  ZipInputStream over FitNotes' 4.7 MB 28 → 13; a first open costs about 40 ms of class
  initialization and compilation. CRC32C is libcore's Java (Unsafe word reads), 1.9 → 8.5 ms per
  MB. luni-io 1,337 → 1,362, luni-net 537 → 540.
- 2026-10-01, FileChannelImpl and FileLock from libcore (B.7 cut 5, file side). libcore's
  FileChannelImpl, FileLockImpl/FileLockTable and IOUtil's buffer staging run over the file
  natives of FileDispatcherImpl, FileChannelImpl, FileKey, IOUtil and NativeThread (jio.ts; the
  socket side of sun.nio.ch is not there). `map0` maps an immutable file read-only outside guest
  memory (the ICU data file still pages in: a first date format, collator, break iterator and
  normalizer cost 413-442 ms against 405-435) and anything else into guest memory kept coherent
  with the file; `force` syncs it. Locks are granted, since one process holds them all and
  FileLockTable arbitrates overlaps. sendfile is not offered (transferTo copies through buffers).
  Findings: jniCreateFileDescriptor must go through `FileDescriptor.setInt$`, which records
  whether the descriptor appends (an append stream's channel reported position 0); an off_t
  overflow in pread/pwrite is EINVAL; sun.misc.Unsafe gained its raw-address accessors
  (IOVecWrapper's iovecs for scatter/gather). luni-nio 2,616 → 2,685, luni-io 1,362 → 1,364.
- 2026-10-01, BufferedReader and Scanner from libcore. The TS BufferedReader was kept because
  bytecode readLine had measured 2.3x its time; remeasured in V8 it is 1.2x (readLine over 100 KB
  2.27 → 2.78 ms, through an InputStreamReader 0.96 → 1.17, read() 2.09 → 2.27). The TS Scanner
  read its whole source up front and lacked most of the API (hasNextDouble fell through to a
  platform body over missing fields). libcore's needed two regex translation fixes: a property
  escape inside a class set (`[\p{javaDigit}&&[^0]]`, Scanner's integer pattern) lost its braces
  when rewritten for the `v` flag, and Java's `\x{h}` is JS's `\u{h}`; a device probe of
  hasNextInt/hasNextDouble/nextLine/useDelimiter now matches. Scanner is 60-80x slower than the TS
  copy (4,000 lines 0.35 → 21 ms, 20,000 mixed tokens 6 → 470 ms, first use about 400 ms): its
  Matcher works over a 1,024-char CharBuffer that `resetForInput` turns into a String on every
  usePattern/region/reset (30% of the time in charsToString, 12% GC), and each usePattern makes a
  MatcherNative. No gated app uses Scanner on a tap path; a §4.7 intrinsic would be the fix.
- 2026-10-01, the rest of java.util.concurrent from libcore (B.5). Atomics and field updaters,
  TimeUnit, the executors, FutureTask and their interfaces; worker threads stay TS Threads.
  Findings: every wake after a park waited on a clamped `setTimeout(0)` (1-4 ms each), probably the
  cause of the earlier 191 ms cold Mihon tap; wakes now go through the yield channel. VarHandle
  accessors are generated per field and Unsafe's read-modify-writes are single operations
  (AtomicInteger.incrementAndGet 6.2 -> 2.4 ns, TS 1.0). getConstructors returned non-public
  constructors, so ForkJoinTask copied exceptions a device hands back (fixed in reflect). jsr166
  2,544 -> 3,132. ConcurrentHashMap's tabAt/casTabAt/setTabAt are intrinsics (their long offset
  math was ~25 ns of BigInt a call).
- 2026-10-01, the rest of java.net from libcore (B.7 cuts 7-8). InetAddress, NetworkInterface,
  Datagram/Multicast sockets, URLConnection's base, Socket, ServerSocket, SocketImpl and the
  factories run over libcore.io.Linux socket natives (`src/android/socket.ts`) on the same socket
  model as native code (`src/native/net.ts`): IPv6, listen/accept, in-process loopback, Linux
  option defaults, one-sided shutdown (server.ts and worker/tcp.ts accept a "shutdown" message).
  HttpURLConnection over fetch and SSLSocket at the relay stay TS boundaries. luni-net 537 -> 779
  with socket tests enabled. Costs: getByName of a cached host 0.41 -> 7.2 us and connect+round
  trip 6 -> 33 us, both from libcore parsing the host as a numeric address first and catching the
  exception (the §4.6 throw cost); byte reads got faster.
- 2026-10-01, java.math and the JCA from libcore (B.7 security). BigInteger/BigDecimal are libcore's;
  java.security, javax.crypto, certificates and x500 run from libcore over conscrypt's
  NativeCrypto natives (`src/android/conscrypt*.ts`, digests, HMAC, AES/ChaCha/GCM, RSA, EC,
  X25519, X.509) and bouncycastle, providers installed from security.properties and
  ZygoteInit.warmUpJcaProviders (50 ms per realm cold). AndroidKeyStore is framework code over a
  keystore2 service behind binder with a software KeyMint (`src/android/keystore.ts`; keys the TS
  store saved are not migrated). TLS still ends at the relay: each realm mounts a relay CA and
  presents a leaf per host, so hostname checks pass and pinning fails, as with an intercepting
  proxy; the old keyless placeholder crashed ChatGPT. NetworkSecurityConfigProvider installs as
  handleBindApplication does (AndroidNSSP first; cleartext policy, anchors and pins apply). New
  suite luni-security 715/722. Measured in V8 (TS -> now): BigInteger add/multiply 17-27 -> 37-46 ns
  through bigint intrinsics (libcore alone 224-1,350 ns), AES-GCM 16 KB 21 -> 90 us, AES-CBC 28 -> 65
  us, SHA-256 1 MB 0.61 -> 3.2 ms and ECDSA P-256 verify 78 -> 458 us (the TS copies used async
  WebCrypto, which a synchronous JCA cannot). V8 turned a class constructor into a dictionary
  once <clinit> stored its statics; constructors return to fast properties after initialization
  (BigInteger construction 38 -> 7 ns; applies to every class).
- 2026-10-01, java.lang's non-VM classes from libcore. Exceptions, marker interfaces, annotations,
  StackTraceElement, EmptyArray; the boxes, Number, Character (TS reads and makes boxes through
  `jbox.ts` over each class's `value`); Math and StrictMath (StrictMath's natives are an fdlibm port,
  `fdlibm.ts`, bit-exact with the AVD on 435 probes); Enum, Thread.State, UnicodeScript;
  java.util.Formatter under String.format; ThreadLocal/InheritableThreadLocal; ThreadGroup and
  UncaughtExceptionHandler. Kept as §4.7 intrinsics: StringBuilder and StringBuffer (libcore's are
  8-15x slower on appends; a generated-operations test holds the TS ones to libcore's results).
  Intrinsics, all differentially tested: box valueOf/getters/equals/hashCode/toString/parse,
  Math's abs/min/max/round/signum/floorDiv/floorMod, Enum compareTo/valueOf, ThreadLocal get/set.
  VM fixes: a fieldless class gets V8's elided default constructor (boxing 0.34 -> 0.25 ms per
  20,000), a float/double static starts as a double (an int-to-double static change turned Math's
  and Double's constructors into dictionaries), a platform native's resolved implementation is kept
  in its stub. Divergences found: the TS Integer cache covered -128..255, Long cached nothing,
  compareToIgnoreCase returned -1/0/1, UnicodeScript knew 49 scripts, javaFormat ignored locale and
  %g/%a/%t, float text used JS's shortest digits (1,860 of 40,000 values print differently from
  FloatingDecimal). Costs: String.format 0.83 -> 4.4 us, Double.toString 2.4x, Long.parseLong 0.2x.
- 2026-10-01, buffer, regex and charset intrinsics after the nio flip. The buffer flip made GL-style
  loops 2-8x slower (a direct FloatBuffer put loop 0.37 -> 2.3 ms). ByteBuffer, the typed views and
  their bulk copies are now intrinsics that read a direct buffer's address once per call (0.30 ms);
  a Matcher keeps one MatcherNative per pattern, long char runs decode with a fatal TextDecoder, and
  charset names are memoized by spelling. Still slower than TS: Scanner (2,000 ints 0.37 -> 11 ms;
  libcore rebuilds its 1 KB buffer's string on every Matcher reset) and ZipFile lookups (~2.5x).
- 2026-10-01, java.util.Random from libcore with its next(int) an intrinsic over three 16-bit limbs
  of the seed (25,000 draws: TS 0.40, libcore 1.08, intrinsic 0.63 ms). A new suite, luni-util
  (libcore's own java.util tests), passes 2,237 of 2,586 against 1,663 before the java.util flip;
  an array larger than the 512 MiB heap limit now throws OutOfMemoryError as on ART instead of
  hanging in `new Array(n).fill(null)`.
- 2026-10-01, Stage B completion: System and Runtime from libcore. System is a `platformClinit`
  spec whose TS keeps arraycopy, the clocks, identityHashCode, `specialProperties`, mapLibraryName,
  setIn0/Out0/Err0 and caller-sensitive loadLibrary/load (`Reflection.getCallerClass` resolves a
  frame's class by name in the root runtime, so a DexClassLoader child would get the wrong loader);
  Runtime is libcore's over nativeLoad/nativeGc and the memory natives, and nativeExit marks the
  process exited after the shutdown hooks. The `<clinit>` needed VMRuntime's bootClassPath,
  classPath, vmVersion and properties (`user.locale`), Linux getuid/getpwuid and
  ProcessEnvironment.environ. ICU4J cannot answer ICU's version natives during it (ICUBinary reads
  System properties, still null), so getUnicodeVersion/getCldrVersion read the .dat as ICU4C does
  (15.1, 45.0). Device behaviour now followed: java.home /apex/com.android.art, http.agent from
  RuntimeInit.getDefaultUserAgent, java.io.tmpdir and TMPDIR the app's cache directory, the ART/i18n/
  tzdata roots in the environment, os.version from uname, `user.name` root because the zygote runs
  `<clinit>` as uid 0 (reasoned from AOSP, not probed). `Thread.started` must be a Java int (libcore's
  addShutdownHook reads it). The zygote pays about 35 ms for System's `<clinit>`. Limits:
  android.zlib.version/android.openssl.version are unset; a direct Runtime.loadLibrary(String) finds
  its caller by stack scan (root runtime only).
- 2026-10-01, the last libcore remainders: ClassPathURLStreamHandler verifies the archive as
  DexPathList asks; Modifier, InvocationTargetException (Method.invoke builds it through its
  constructor; stack text walks causes through `getCause`, so UndeclaredThrowable and
  PrivilegedAction causes print), WrongMethodTypeException, javax.net.ssl's exceptions,
  HostnameVerifier, KeyManager, SSLSession and SSLContextSpi; java.lang.reflect.Array over ART's
  createObjectArray/createMultiArray. The TS Array.get returned a primitive element unboxed, so
  `JSONObject.wrap(int[])` failed with "equals(Ljava/lang/Object;)Z is not a function" in every
  reddit and TikTok run (appsflyer). TikTok's v1-signed APK (26,422 entries, 2.2 MB MANIFEST.MF and
  signature file): opening is unchanged at 130-146 ms, the first class-path resource read went from
  6.9 ms to about 500 ms cold (first use of Manifest, JarVerifier, PKCS7, X.509 and the JCA) and
  135-170 ms compiled (inflate 22, SHA-256 15, Manifest parsing 65, ManifestDigester 10, GC 20); later
  reads 0.5-1.2 ms. SSLSocket and its factories, SSLContext, SSLEngine, SSLParameters,
  HttpsURLConnection, the TS SSLSession and conscrypt's SSLParametersImpl marker (OkHttp's platform
  check) stay TS for TLS at the relay; `TS_SPECS` in provenance.ts lists every allowed TS spec in
  libcore's namespaces and tests/provenance.test.ts holds registrations to it.
- 2026-10-01, throw cost and the formatting debts. A failed Integer.parseInt spent 4.5 of 6.3 us in
  `new Error()`: V8 builds a deopt TranslatedState for every optimized frame (150-225 ns each);
  stackTraceLimit 1 still costs 1.2 us and captureStackTrace(o, fn) saves nothing. A lazy capture
  cannot be exact (frames are gone after unwinding; 166 TS catch sites) and capping frames does not
  help at typical depths. `discard.ts` instead marks, at a hot compile, calls whose handlers all
  leave the exception dead and whose reachable platform bytecode cannot observe or keep a
  throwable; while one runs, `R.quiet.types` names the handled classes and captureStack skips them
  (cleared on return, throw, suspension and runClinit). The analysis links and compiles nothing:
  a first version that linked field types stubbed classes a realm lacked. parseFail 6.0-6.3 ->
  1.5 us; Double.parseDouble is not covered (it reaches Matcher and an interface call). FloatingDecimal's
  dtoa is a §4.7 intrinsic keeping libcore's digits (4,000 calls 2.07 -> 1.43 ms; BigInt64 beat
  32-bit halves); String.format 3.03 -> 2.71 us is a flat profile (parsing 40%, FloatingDecimal 30%);
  compiled instance-of/check-cast cache two receiver classes; arraycopy of up to 16 elements loops.
  Scanner is unchanged (2,000 ints about 10 ms): every Matcher.region() resets and stringifies the
  1,024-char CharBuffer, and an exact fix needs a Scanner- or Matcher-level design.
- 2026-10-01, crypto debts. SHA-256 in JS is at its ceiling (3.1 ms/MB; unrolled 2.9); the old
  0.61 ms was WebCrypto's SHA instructions. A digest now holds its message (to 64 MB) while nothing
  is hashed, and EVP_DigestFinal_ex of 64 KB or more returns `crypto.subtle.digest`, suspending once
  (1 MB 3.3 -> 0.46 ms); smaller messages, SHA-224/MD5, clones and sign/verify hash in JS. ECDSA P-256
  verify 467 -> 310-322 us: 85% was point arithmetic and in it the bigint `%` (105 ns on a 512-bit
  product); Barrett reduction (75 ns), folded subtractions, per-point odd-multiple tables and an X
  compared against r*Z^2 instead of an inversion. Limbs in Int32/Float64 (no 64-bit products),
  Lehmer inversion (one per verify) and per-verify WebCrypto (a suspension per call) were rejected;
  the rest needs Wasm or WebCrypto. The first certificate parse (~200 ms) is not certificate code:
  about 100 ms is the JCA provider list (8 ClassNotFoundExceptions; ZygoteInit.warmUpJcaProviders
  pays it on a device) and 116 ms the first `Calendar.getInstance(UTC)` from
  OpenSSLX509Certificate.toDate loading ICU locale data cold; the certificate is 11 ms cold. jbench's
  runner had read the whole ICU file for every range, overstating earlier first-use numbers.
- 2026-10-01, collection, zip, json and address debts. Strings from bytes skip the argument array,
  the subarray view and the charset lookup (byte-range constructors now throw as libcore's
  checkBoundsOffCount does); a String compareTo whose result feeds only zero tests compiles to JS
  comparison (`markSignOnly` in prepared.ts; UTF-16 order is JS's); equalsIgnoreCase compares ASCII
  without regular expressions. V8: TreeMap 0.72 -> 0.45 ms (TS 0.26; the rest is the red-black tree,
  0.19 ms as hand-written JS), zipOpen 0.60 -> 0.50, org.json parse 4.2 -> 3.9 (TS 2.0; no single
  hotspot, megamorphic instance-of about 10% of writes). InetAddress.getByName of a cached host
  stays 8.9 us (TS 0.4): 70% is the stack capture of the GaiException libcore provokes on every
  non-numeric host, the rest per-frame rethrows in ForwardingOs/BlockGuardOs and socket.ts glue.
  Back-edge fuel checks cost 12-18% of tight loops; moving or batching the counter gained nothing.
  Rejected: dropping the suspension check after leaf calls (0-6%), loop fills instead of
  `fill(null)` (holey arrays; listRemove +16%). A matched jbench run of the whole pass against
  0fd5fe74 shows no steady regression beyond run-to-run spread (b64java 1.00-1.13 and mix
  1.34-1.45 ms within one commit).
- 2026-10-01, a launch race and cold Mihon latency. provisionPackages runs beside startZygote and
  built a ComponentName per disabled microG component; linking the spec before the platform dex was
  indexed stubbed java/lang/Comparable, and a launch that lost the race failed (2 of 5 fast gates
  under load; 0 of 6 after component state became keyed by name). Cold Mihon `light` is bimodal
  because its answering frame is either a ripple frame presented ahead of the recomposition (17-36
  ms) or the recomposed one; interleaved against 8c8796fb (before the java.lang flips) both trees
  measured 147-183 ms in the slow mode, so the flips did not cause it. A slow tap's 190 ms: about
  60 ms runtime and JIT TS (13 ms V8 parsing new bodies, 47 classes compiled on the tap), 90 ms Java
  and 27 ms cold tier; libcore Java about 3 ms, plus a one-time 8 ms ICU property-set build that
  lands in whichever tap is running. Compose's ScatterMap calls Long.numberOfTrailingZeros 14,251
  times per theme switch. After this pass the slow mode measures 128-148 ms and the gate passed
  5 of 5 cold runs and warm.

- 2026-10-01, Stage C completed on branch `knlnks/bytecode-stage-c` (parallel units merged by
  cherry-pick; each commit message records its gates). Every class under `android/graphics/` and
  `android/text/` now runs from AOSP bytecode except the layout-only geometry specs (Rect, RectF,
  Point, PointF, Insets: bytecode fields are mangled per class, so TS reads `r.left` only through a
  spec's layout; every method is AOSP's). Units and their measured findings:
  - Canvas, RecordingCanvas, RenderNode (`canvas.ts`, `rendernode.ts`; bridge `canvasOf`). The TS
    view stack passes Java canvases; the window canvas is one cached RecordingCanvas per target
    context. RenderNode properties match the reference AVD (setter change flags, matrices incl.
    rotationX/Y and camera). hwui's promotion of a fading overlapping node to a layer was dropped:
    it doubled Compose draw time (58 ms of layer compositing); alpha multiplies each draw instead,
    which differs only where a fading node's children overlap. Weak handle slots are transparent
    to `deref`, so every Java draw asking a paint for its handle no longer pins the paint.
  - Bitmap, BitmapFactory, BitmapRegionDecoder, ImageDecoder, AnimatedImageDrawable (`bitmap.ts`,
    `decode.ts`, `animatedimage.ts`; bridge `bitmapOf`). PNG pixels equal the device's, JPEG within
    2 per channel; bounds-only decode of a 3000x2000 JPEG 22 -> 0 ms. HARDWARE bitmaps are served
    by the raster (the device's ImageDecoder defaults to HARDWARE, and a null from BitmapFactory
    would break Coil/Glide); ashmem is absent. Compose's vector cache draws ALPHA_8 bitmaps, which
    the old mask path drew as nothing.
  - Paint, TextPaint, PathEffects, MaskFilters (`paint.ts`; bridge `paintOf`, `newPaint`). The
    TS copy ignored shadow layers, text scale/skew, xfermodes, path effects other than dash and
    mask filters other than blur. Device probe: SUBPIXEL_TEXT does not change measureText or
    getTextWidths, LINEAR_TEXT does, so measurement is hinted unless LINEAR_TEXT is set (it was
    unhinted under SUBPIXEL). Paint's constructor reads LocaleList.getAdjustedDefault, so
    zygoteInit sets the device locales before preloading a Paint.
  - android.text's span model, Editable, Selection, Linkify, android.util.Patterns,
    AndroidCharacter. The TS TextView/EditText drive AOSP's SpannableStringBuilder through Java
    and a ChangeWatcher; listeners get real ranges. In V8 SSB appends/edits cost 2.5-3.3x the
    TS copy (0.12 -> 0.34 ms per 500) and one typed character 0.66 -> 3.96 us: microseconds, no
    intrinsic.
  - TextRunShaper, PositionedGlyphs, Font glyph bounds, Canvas.drawGlyphs over HarfBuzz
    (harfbuzzjs 434 KB wasm, lazy, shared per tab; `harfbuzz.ts`, `shaping.ts`). Glyph ids,
    positions and bounds match the device to one ulp where the fonts agree; androidx's
    TypefaceCompat.guessPrimaryFont (Mihon, NewPipe, YouTube, ...) now resolves. The page's
    Roboto is static where the device's is variable (ligature ids differ by 3).
  - Drawables, VectorDrawable, AnimatedVectorDrawable, NativeInterpolatorFactory,
    RenderNodeAnimator, CanvasProperty, the framework's RippleShader, PathParser, and
    android.animation (Stage D's list, flipped because AOSP's drawables need AnimatorInflater's
    theme form and keyframe data). Vectors match device pixels within 3 per channel. Cost, e2e
    `--jobs 1` summed draw ms: calculatorm 1210 -> 1729, mihon-app 2780 -> 3635, mihon-onboarding
    860 -> 1446, komikku 10002 -> 11507: the real patterned ripple and full-duration state
    animations replace a flat circle. In headless SwiftShader a ripple frame rasterizes in 1.8 ms
    (GPU 0.4) but its program compiles in about 270 ms (GPU 13) on first use per realm, which
    blocks the main thread; the e2e harness can then settle on still pixels mid-transition, and
    Komikku's fast flow failed at populated-library in 4 of 8 parallel runs against 0 of 3
    at 51f45b5a (it passes alone). CPU over a Komikku tap window: 205 against 167 ms.
  - RenderEffect over hwui's image filter graph: blur sigma is Blur::convertRadiusToSigma
    (0.57735 r + 0.5); the TS copy blurred by the radius (1.6x at r = 10).
  - SurfaceTexture over GLConsumer's latch/attach semantics; its transform after a latch is the
    device's vertical flip (the TS copy returned identity).
  - Found while gating: a generator named like its `driven()` wrapper yields an unrun Generator
    (Runtime.drive returns it as a value) — XML `<set>` children, menu `<group>` items and child
    visibility never ran; inner generators take a `$` suffix. The TS Handler lacked the
    asynchronous constructors bytecode now calls.
  A review pass then restructured the flips without changing behaviour (canvas.ts, paint.ts,
  textview.ts and fwtest.ts split along their seams; one decode request model; one Recorder; the
  bitmap context Proxy replaced by marking bitmaps written at draw entry, 176-214 -> 4-34 ns per
  draw in V8) and fixed what it found: handle ids were reused at once, so `setLocalMatrix` twice
  left a paint drawing the stale shader; a Picture drawn into a recording replayed at record
  time; text ignored the paint's blend mode; outline and crop clips skipped the canvas's clip
  bounds; decorations and text on a path measured with browser widths, not minikin's; ImageView
  applied its alpha twice; verifyDrawable and hotspots skipped subclass drawables; drawable
  adoption differed from AOSP per setter (ProgressBar never set a callback); a malformed vector
  path string did not throw.
  Limits: text hyphenation (no patterns), single bidi direction per drawn run, CJK/Arabic/serif/
  monospace fonts absent from the page, glyph fake-bold not outlined, color management (sRGB
  only), 565/4444/F16 not quantized until read back, vertices/meshes/clipShader and texture-layer
  and WebView-functor draws throw UnsupportedOperationException, elevation shadows and Z order
  not drawn, getFillPath needs the page's CanvasKit, resolution logging, ObbScanner, ResourceTimer
  and fd-backed ApkAssets unimplemented.
- 2026-10-01, input events on bytecode (Stage D). MotionEvent and its PointerCoords/Properties,
  InputEvent, KeyEvent and its DispatcherState, KeyCharacterMap, InputDevice, VelocityTracker,
  InputManager and InputManagerGlobal run from AOSP bytecode over natives with libinput's
  semantics (`motionevent.ts`, `velocity.ts`, `keyevent.ts`) and a hosted IInputManager
  (`inputdevices.ts`). scripts/InputProbe.java prints 128 lines on the reference AVD; fwtest runs
  the same dex here and matches every line (event ids masked). Device findings: Java coordinates
  are stored through calculateTransformedXY, so obtain(x = 100.3) keeps 100.299805 (1/1024) and
  offsets add to that; nativeInitialize sets the private orientation flags (0x180) only when a
  pointer's orientation is nonzero, and getFlags hides them; orientations go through bionic's
  atan2f, one ulp off a correctly rounded atan2, so it is ported; the eleven VelocityTracker
  strategies agree to the last digit. The touchscreen is the AVD's virtio_input_multi_touch_1 (id
  12, sources 0x80005103, Generic.kcm); `adb emu event mouse` shows its touches as
  TOUCHSCREEN|STYLUS with private flag 0x80, pressure 1 and xPrecision 32768/width. The virtual
  keyboard is id -1 (Virtual.kcm), and hasKeys on a negative id asks every AVD device, so its key
  set is recorded (`gen-framework --input`). The host builds the reader's event (`touchEvent`) and
  wraps it in a pooled Java MotionEvent, recycled after dispatch; the TS view stack reads through
  `motionOf`/`eventX` and offsets as dispatchTransformedTouchEvent does; key events reach views,
  activities and dialogs through KeyEvent.dispatch with the dispatcher state. One move costs 1.4 us
  in Bun (obtain, View dispatch, VelocityTracker.addMovement, recycle). Found while gating: a typed
  view's bulk get over an external mapping did not wait for its pages, so java.text.Normalizer's
  first NFC load read zeros and every composition threw StringIndexOutOfBounds (getDeadChar
  reaches it); SparseArray lacked setValueAt. Limits: the TS scrollers and GestureDetector keep
  their per-frame EWMA velocity; IInputManager hosts only what InputDevice, KeyCharacterMap and
  VelocityTracker reach; no InputChannel/InputEventReceiver yet.
- 2026-10-02, Stage D notifications on bytecode: Notification (every Builder, Style and Action
  class), Person, NotificationChannel(Group), NotificationManager and RemoteViews run from
  framework.jar over a hosted INotificationManager (notification.ts) ported from the reference
  AVD's services.jar (NotificationManagerService, PreferencesHelper, GroupHelper, checked with a
  probe app at targetSdk 25, 32 and 35; its logs match webdroid's line for line apart from the
  uid in notification keys, which orders ArrayMap iteration). Findings:
  - Posting needs POST_NOTIFICATIONS (areNotificationsEnabled, getImportance 0/3); a missing or
    deleted channel drops the post (only a conversation post restores a deleted channel); an app
    reads back parcel copies; config_autoGroupAtCount is 2, so two ungrouped posts add the
    system's `ranker_group` summary (key suffix `|ranker_group`, flags 1792), which cancel() cannot
    remove (FLAG_AUTOGROUP_SUMMARY is in its must-not-have flags) and which leaves with its last
    member or the channel.
  - An app targeting below 33 cannot request POST_NOTIFICATIONS (the dialog answers -1); it gets
    the permission implicitly (CompatibilityPermissionInfo) and PermissionPolicyService prompts on
    a launcher launch once a channel exists at launch time — not when onCreate creates the first
    one. Below 26 the `miscellaneous` channel ("Uncategorized", importance -1000) exists from the
    first NotificationManager call; it is not a channel the prompt counts on a fresh install.
  - Recreating a channel renames and re-describes it and only lowers its importance; bypassDnd,
    lockscreen visibility and allowBubbles are reset to the package's defaults on creation.
  - Do Not Disturb is off (filter 1) with the AVD's policy (380, 2, 2, 157, 0, 2); every zen
    write, rule read and filter change throws "Notification policy access denied".
  - Device flags (app_process probe): lifetimeExtensionRefactor, checkAutogroupBeforePost and
    secureAllowlistToken are off, modesApi and autogroupSummaryIconUpdate on.
  Found while gating: ServiceManager logs a slow lookup through EventLog.writeEvent, which had no
  native, so a loaded page's Choreographer threw from DisplayManagerGlobal; Parcel lacked class
  cookies and PendingIntent its marshal listeners (Notification.writeToParcel uses both), Binder
  isDirectlyHandlingTransaction (Parcel's string-array bound) and UserHandle.of.
  Limits: nothing is shown (no shade, sound, vibration or listener service; listener and
  assistant access stay ungranted); toasts are still the TS Toast; snoozing, notification
  history, bubbles, conversations' shortcut checks, the immutable-PendingIntent checks for
  remote-input actions and user-initiated jobs are not modelled; the foreground service
  notification follows ActiveServices from source, not a device probe.
- 2026-10-02, Stage D: PackageManager on bytecode. `pm.ts` hosts IPackageManager, IPermissionManager,
  ILegacyPermissionManager and ICrossProfileApps over the package registry, and
  `packageinstaller.ts` IPackageInstaller and its sessions; ApplicationPackageManager,
  PermissionManager, PackageInstaller and every android.content.pm data class run from bytecode.
  Context.getPackageManager is ContextImpl's (one per base context); getResourcesForApplication
  reaches the TS ActivityThread's getTopLevelResources through ContextImpl.mMainThread. The
  service's answers were diffed field by field against the reference AVD for FitNotes
  (IPackageManager as uid 2000): beyond install paths, uid, data dir (`/data/user/0` there) and
  install state (the AVD's copy was never launched, so FLAG_STOPPED), they match, which needed
  ParsingPackageUtils' defaults the TS copy lacked: manifest booleans resolved through resources
  (WorkManager's `@bool` enabled flags hide two of its components, as on the device), MCC|MNC in
  every activity's configChanges, FLAG_CAN_DISPLAY_ON_REMOTE_DEVICES, resizeMode 1 from the
  target SDK, maxRecents 8, privateFlags (pointer tagging, audio capture, partial direct boot),
  empty splitNames/attributionTags/pathPermissions arrays, kill-after-restore only with a backup
  agent, and Context.getApplicationInfo without meta-data. PackageInfo.reqFeatures needs
  GET_CONFIGURATIONS; PackageManager.checkPermission now consults runtime grants (the TS copy
  granted every requested dangerous permission). getPackageArchiveInfo is AOSP's PackageParser2 and
  ApkSignatureVerifier; it needed split permissions (the AVD's list), Build.VERSION.ACTIVE_CODENAMES,
  IncrementalManager natives answering "no IncFS", and IntentFilter methods. PackageInstaller
  sessions write through AOSP's revocable-fd path (`fw.revocable_fd`), since a FileBridge needs a
  server thread. The service builds its answers in `driven` generators, never `async` functions: a
  Java call after an `await` runs on whatever thread is current, so it can wait on a class the
  calling thread is itself initializing. Reddit's launch deadlocked that way inside hostStub's
  async Stub construction (newStub now constructs on the asking thread), and a SigningDetails
  built after an await read ICU's Calendar mid-initialization from another of its threads. The
  first getService of a hosted service can take long enough for ServiceManager to log a slow
  lookup, so EventLog's natives now write to the log. Launch timings under `--jobs 1` match the
  parent within noise (FitNotes 2.33-2.42 against 2.33-3.43 s; calculatorm 1.71-1.80 against
  1.81-1.90 s); Komikku alone passed 3 of 3 interleaved with the parent (2 of 3).
  Limits: package visibility (AppsFilter, `<queries>`) is not applied; ResolveInfo.filter and
  match are not filled; resolveIntent returns the best match rather than the chooser for ties;
  installs reach only the realm that ran them; ILegacyPermissionManager answers nothing.
- 2026-10-02, Stage D: Intent and its kin on bytecode. Intent, ComponentName, IntentFilter,
  PatternMatcher, IntentSender, UriMatcher, ContentUris, UriPermission and their exceptions run
  from framework.jar over the TS Bundle, Uri, Rect and Parcel; the shell reaches them only
  through their Java API (`intent.ts` helpers: newIntent, mkComponentName, componentParts,
  intentQuery, putExtra). Intents cross processes as AOSP's parcel of them, which needed
  BaseBundle's lazy unparcelling: Parcel.readBundle keeps the bytes after BUNDLE_MAGIC (and their
  binders) until an accessor reads the bundle, and writing an unread bundle copies them back, so
  the broker resolves receivers without the sender's extras classes (the TS encoding used to drop
  extras for that). TS code that reads `JBaseBundle.map` must `unparcel` first; the getter throws
  while parcelled. The PendingIntent registry keys records by Intent.filterEquals and applies
  FLAG_UPDATE_CURRENT with Intent.replaceExtras. Manifest `<intent-filter>`s become the
  IntentFilter ParsedIntentInfoUtils builds (cached per node) and resolve through
  IntentFilter.match, as IntentResolver does: about 0.1-0.4 ms for YouTube's ~90 service filters
  once built, 16-20 ms for the first query that builds them.
  Device code against the deleted copies, same calls: the TS parcel layout lacked API 35's
  mExtendedFlags after mFlags; toUri wrote `action=VIEW` beside a data scheme and extras in
  insertion order (AOSP omits that action and walks the ArrayMap); Intent.toString was
  `Intent{act=… cmp=…}` and ComponentName.toString Object's; Intent.parseUri and
  IntentFilter(String, String) were missing. The reference build's
  Flags.relativeReferenceIntentFilters is a constant true (FeatureFlagsImpl), so
  `<uri-relative-filter-group>`s are parsed and decide matches (the first group whose filters all
  match allows or blocks; a URI no group matches does not match); the TS matcher rejected every
  filter that had one. IntentSender's <clinit> sets ComponentOptions' background start mode
  (COMPAT through DENIED kept, the ALLOW modes stored as ALLOWED), which the TS ActivityOptions
  now holds. Java-facing entry points that call Java after a suspension are driven generators
  (registerReceiver, startService, stopService, the IntentSender binder methods), per the
  PackageManager entry's thread finding.
  Measured: an intent with eight extras put, read, parcelled and read back costs 8.9-11.9 us in Bun
  against the TS copy's 7.2-9.4 us. Live YouTube in a six-flow batch fails on load as on the
  parent (2 of 4 parent batches, 1 of 4 here, all passing alone); live Harmonic misses a swipe
  alone on both (1 of 3 here, 1 of 4 on the parent); TikTok wedges after background on both.
  Limits: PendingIntent itself is still TS (IntentSender is AOSP's over its binder); manifest
  attribute references resolve against the running app's resources, not the owner's; priorities
  are not clamped for non-privileged apps; Intent.prepareToLeaveProcess's StrictMode and
  file-URI checks (Uri.checkFileUriExposed and friends) have no TS Uri counterpart yet.
- 2026-10-02, Stage D: Settings and DeviceConfig on bytecode. Settings, Settings.System/Secure/
  Global/Config, NameValueCache and DeviceConfig run from framework.jar over `settings.ts`, a
  hosted IContentProvider (a ContentProviderNative subclass) for the `settings` authority, ported
  from the reference AVD's SettingsProvider.apk: GET/PUT/DELETE/LIST/RESET for the four tables,
  query/insert/update/delete/getType/openFile with its Arguments parsing, moved-key rerouting and
  error messages. The TS ContentResolver reaches it through acquireProvider (NameValueCache) and a
  ContentProvider-shaped adapter (its own query/call/insert...); ActivityManager.getContentProvider
  hands AOSP's ActivityThread a ContentProviderHolder for it. `server/content.ts` is ContentService's
  observer tree (hosted as IContentService for AOSP's ContentResolver; the TS resolver registers
  there too) with ObserverNode's rules: a change reaches observers at its uri, ancestors watching
  descendants, and every observer below it. The tables live in the broker's SettingsStore
  (`shell/settings.ts`), persisted with the device (`wd:settings`), and each process's observers
  hear every write. Values are `device-settings.ts`, which `gen-framework --settings` records from
  the AVD. Findings (probe app at targetSdk 30 and 35, run on the AVD and in webdroid; the logs
  match line for line apart from the data scope below and generation tracking):
  - Readability: enforceSettingReadable applies checkReadableAnnotation at every target SDK (only
    FLAG_TEST_ONLY and system apps skip it), so a declared non-@Readable key throws at targetSdk 30
    too; @Readable(maxTargetSdk) keys throw above their ceiling; undeclared keys are readable.
    multi_sim_data_call needs READ_PRIVILEGED_PHONE_STATE at 30 and 35; bluetooth_address answers
    null without LOCAL_MAC_ADDRESS. LIST_* and whole-table queries skip what the caller may not read
    and null values; DeviceConfig reads need no permission.
  - Writes: an app gets "<pkg> was not granted  this permission: android.permission.WRITE_SETTINGS."
    for System (WRITE_SETTINGS is signature|appop|pre23|preinstalled, so only an app targeting
    below 23 or a system one holds it here), "Permission denial, must have one of:
    [android.permission.WRITE_SECURE_SETTINGS]" for Secure/Global and the WRITE_DEVICE_CONFIG
    message for config; RESET with mode 0 is "Invalid reset mode: 0".
  - Observers: night mode on the AVD notified content://settings/secure/ui_night_mode (plus its
    custom-type and dark-theme times); a non-descendant observer of the table heard nothing.
  - Device values: ui_night_mode is absent until night mode is first set (2 dark, 1 after); the
    shell writes it from the browser's preference. location_mode follows the location switch
    (written by LocationManagerService on the AVD) while location_providers_allowed stays the
    stale "gps" either way. The data keeps declared, @Readable, non-null keys and drops undeclared
    product keys, values naming AVD apps (IME, assistant, autofill, spell checker...) or
    /product/media sounds, the default sounds' media URIs, Bluetooth identity (no adapter here)
    and device_name, which is Build.MODEL as DatabaseHelper sets it. SSAID is AOSP's HMAC-SHA256
    of the signing certificates under a per-device user key, so packages sharing a signer share it
    (the old per-origin `wd:android_id` is gone). Device config keeps the 48 flags named by a boot
    class path class that reads DeviceConfig or Settings.Config, of the AVD's 3,419.
  Also: AOSP's canDrawOverlays falls back to checkSelfPermission(SYSTEM_APPLICATION_OVERLAY), which
  the TS check granted to any app for any non-runtime permission; an app's own check now needs the
  permission requested, and SYSTEM_ALERT_WINDOW/WRITE_SETTINGS (special access) are held only below
  targetSdk 23. A driven computation's suspended promise carries its asker's frames (suspendWith
  appends to them), so a cache must never hand that promise to a second asker: it would resume
  with the first asker's result. Harmonic's welcome-scroll swipe fails intermittently on the parent
  too (4 of 8 runs alone), as does Komikku after a parallel run.
  Limits: no generation tracking (MemoryIntArray), so NameValueCache never caches; System writes
  by an app holding WRITE_SETTINGS skip SystemSettingsValidators (they ship in
  SettingsProvider.apk); resets, sync-disabled mode and the config monitor callback are
  unimplemented for the callers allowed to use them; observers hear changes made in other
  processes only through the store, not other apps' providers' notifyChange; registerContentObserver
  does not check that the authority exists.
- 2026-10-03, Stage D boots apps. With Settings in place FitNotes, CalculatorM and DoodleJump reach
  their first frames under `?bytecode=stage-d` through ActivityThread, ViewRootImpl and hwui.
  Flipping a TS spec to bytecode exposes the service methods the real class calls and the TS one
  never did (View.playSoundEffect → IAudioService.playSoundEffect, StorageManager.getVolumeList →
  ActivityThread.currentOpPackageName), and one failure hides the next (CalculatorM's Environment
  crash hid a null TransactionStats). What changed and why:
  - Data classes a framework caller casts (RunningAppProcessInfo, RecentTaskInfo) must be AOSP's
    own: the TS specs shadowed them and Firebase's provider failed its cast, which aborted
    bindApplication and surfaced as Injekt's "No registered instance" in Mihon and Komikku.
    `setDeclared` fills a framework object's fields.
  - Hosted services that wait on work queued to a client's main looper must not hold that client's
    synchronous binder call: startActivity/finishActivity awaited the pause item the parked main
    thread had to run, so an activity starting another from onCreate deadlocked. ATM now returns
    once the start is under way, as ActivityStarter does. A static Java method on a Stub class must
    be reached with `scall` (`IIntentSender$Stub.asInterface`); `vcall` on its constructor fails.
  - Managers now on bytecode: AudioManager/Spatializer over IAudioService (`audio.ts`: the AVD's
    stream volumes and aliases, MediaFocusControl's focus stack, AudioSystem natives for Web Audio),
    Environment/StorageManager/StorageVolume over IStorageManager (`storage.ts`: emulated;0 at
    /sdcard, vold's mkdirs rule), SensorManager over SystemSensorManager natives (the profile has no
    sensors), haptics as VibratorManagerService maps them (`HapticFeedbackVibrationProvider` and
    VibrationSettings' fallbacks from framework-res; services.jar is not vendored, so these were
    decoded from the AVD's copy). Under AOSP, isExternalStorageManager follows appops and the
    permission check (TS answered 1) and isExternalStorageLegacy the OP_LEGACY_STORAGE default.
  - App components under Stage D (`server/activeservices.ts`, `server/broadcastqueue.ts`): services
    are brought up and down through scheduleCreateService/ServiceArgs/BindService/UnbindService/
    StopService in ActiveServices' order; registered receivers get scheduleRegisteredReceiver and
    manifest receivers scheduleReceiver, with ordered results, abort and NOT_EXPORTED enforced;
    PendingIntents and the broker's service, broadcast and activity requests take these paths. A
    process the broker spawns for a service must not start its launcher activity.
    ensurePrivateDirExists chowns to the cache gid and tolerates a failing setxattr (EOPNOTSUPP).
  - Composition: SurfaceView is not under its window by tree order but a child of ViewRootImpl's
    bounds layer at relative Z -2, shown through the view's punched hole; its position arrives only
    through hwui's RenderNode position callbacks merged into the window's next buffer. GL window
    surfaces on a BLAST queue present through queueBuffer; a frame belongs to the layer that latched
    it, which closes it on the next latch (closing in eglDestroySurface left a closed bitmap drawn).
    TextureView draws through TextureLayer natives. GLSurfaceView runs from bytecode under Stage D
    because the TS one subclassed the TS SurfaceView. DoodleJump plays at about 32 GL fps in D-mode;
    TS-mode GL throughput is unchanged (4,231 vs 4,187 frames in 60 s). Transaction completion
    carries a present fence that has signaled (composition is synchronous).
  - The device has no PermissionController module: getPermissionControllerPackageName is null and
    AOSP's PermissionControllerManager reports it (Log.wtf, IllegalStateException), which
    LeakCanary's getSystemService catches; the empty TS marker class had hidden this.
  Limits: cross-process activity results, service timeouts and restarts, app-sent sticky
  broadcasts and audio devices/ports are not done in D-mode.
- 2026-10-03, Stage D: providers, WebView, the IME and the harness. FitNotes, CalculatorM and
  DoodleJump pass their whole fast flows under `?bytecode=stage-d`; Mihon, Komikku and FlappyBird
  stop at TelephonyManager's constructor (a TS manager under bytecode).
  - Cross-process providers: getContentProvider resolves the authority and imports the provider
    process's binder behind ContentProviderNative.asInterface; a local holder needs `mLocal`, or
    ActivityThread (API 31+) waits 20 s for a publish notice inside its own provider install.
    ParcelFileDescriptors cross as their bytes plus a writer binder; IPermissionChecker answers
    attribution-chain checks; IUriGrantsManager holds persisted grants.
  - WebView runs from bytecode over a TS WebViewFactoryProvider (both modes; the TS WebView spec is
    gone). Its position comes from the draw functor replayed each frame, not onDraw, since hwui
    reuses unchanged display lists; Chromium's `setWillNotDraw(false)` is needed for any draw. A TS
    view spec on the bytecode view stack breaks (WebView, GestureOverlayView): such classes move to
    bytecode or behind AOSP's extension points.
  - The IME: API 36 sets `useZeroJankProxy`, so InputMethodManager waits on
    startInputOrWindowGainedFocusAsync's onStartInputResult; RemoteInputConnectionImpl drops
    commands whose session id is stale; a new ime InsetsSource starts invisible.
  - Window order: an activity's windows stack by token with its base window below its dialogs (a
    dialog shown in onCreate is added first); a sub-window's Z is relative to its parent.
  - Harness timing. A tap held for a real 60 ms let a controlled clock pass the 400 ms long-press
    deadline; it is now 60 guest ms. Under Stage D a start or finish completes only after the client
    reports its pause, and AbsListView clicks 64 ms after UP (pressed-state duration) through a
    delayed message, which the fast lane's controlled clock never reached because it advanced only
    during actions: the next step's tap then landed on the old window and started the activity
    twice. The pixel rule now waits while ATM counts a transition, and a controlled clock runs
    through the pixel rule's sampling window as a real clock does. Text toasts queue as
    NotificationManagerService does and draw through ToastPresenter, as SystemUI's ToastUI does.
  - The remaining managers SystemServiceRegistry builds (telephony, Wi-Fi, Bluetooth/NFC, camera,
    device policy, app widgets, media router/metrics, storage stats, health, netstats, NSD,
    performance hints, adservices, captioning, biometrics callbacks) run from bytecode over hosted
    services that answer as a device without that hardware or backing package; each commit
    message records its device evidence. Their unit tests replace TS-spec tests: a TS manager
    test with null arguments hung once AOSP's MeasurementManager ran (its binder lookup waits),
    so a test of a deleted spec must go with it. The page's main Looper starts as the zygote
    before the app's uid is set, and Looper.loop captures its calling-identity token once, so
    every message logged "Thread identity changed" (a stack trace and an AMS call each); this
    process's own identity is now one token whatever its uid.
- 2026-10-04, Stage D: the fast gate, the live flows and the corpus. The fast gate passes 7/7 in
  both modes; the D-mode live flows and corpus reach their TS-mode depth except where noted below.
  AOSP's own code is stricter than the TS stack was, so most fixes were fidelity, not D plumbing:
  - Time: the harness pinned `Date.now`, which froze `currentTimeMillis`. Mihon's and Komikku's
    splash keep conditions (`elapsed <= 500 || !ready && elapsed <= 5000`) then never cleared, and
    ViewRootImpl honours the cancelling pre-draw listener. The TS stack had ignored it. Under a
    controlled clock the guest wall clock is now start plus guest time; a pinned page's clock
    advances from its fixed instant. Komikku's `ready` is set only for its own intent actions, so
    a launcher start holds the splash 5 s on a device too; the fast lane keeps a launch's horizon.
  - Order matters where the TS stack was lenient. A Bundle's keys iterate by hash, as ArrayMap's
    do, which androidx.startup's initializer order follows. A process's providers install by
    descending initOrder: Reddit's DI provider must precede InitializationProvider, whose
    initializers wait on its graph with a timeout.
  - Windows: a new window got focus before its input channel existed, so a dialog never heard
    it and its ViewRootImpl dropped the back key. A surface with insets (a dialog's shadow room) sits
    at the frame less the insets.
  - Surfaces: lockCanvas returned the surface's own handle, which unlockSwCanvasAndPost releases
    as its locked reference. The first software frame freed the window surface (Unity's FATAL
    EXCEPTION in Among Us, Cut the Rope and Subway Surfers). Destroy must not free either: release
    follows it, and a slot reused in between was freed.
  - A start waiting for a pause must not wait on a record that a finish destroyed (TikTok's splash
    finishes in onCreate).
  - SAF: the storage documents provider is a system provider with a binder, and a result's URIs
    are granted to the receiver, so `takePersistableUriPermission` works. The provider's asset
    descriptor has unknown length; with length 0, AssetFileDescriptor's output stream dropped
    every write.
  - Harness: a tap's UP follows its DOWN by 60 guest ms regardless of when the DOWN is handled; a
    late UP read as a long press. The pixel rule waits out main-thread jobs, transitions, and on a
    real clock the first 1.5 s of frames or runnable threads. A fling's overscroll stretch draws
    no new pixels, so a tap landed in the scroll and was consumed. `locateText` ranks exact
    matches first, as the device driver does. A sample asks the compositor to present, since the
    TS needsDraw does nothing under Stage D.
  - Many system services gained the methods apps reached, each answering as this device does
    (blur, screen recording/capture, media projection, backup, WebView update, status bar
    tiles, window contexts, URI permissions, audio mode, Wi-Fi reconnects).
  - The activity starter honours launch modes and CLEAR_TOP/SINGLE_TOP/REORDER_TO_FRONT/CLEAR_TASK
    (every start had pushed a new instance), and an activity's translucency comes from its theme
    as AttributeCache reads it. Before, only convertToTranslucent set it, so dialog-themed
    activities stopped what they covered and the broker hid the process beneath a translucent
    one.
  - The latency gate passes under Stage D, cold and warm (FitNotes, Calculator M, Mihon, taps
    9-51 ms on a loaded host). Its FitNotes scenario had tapped TS-layout coordinates that miss
    AOSP's dialog. D-mode launches compile about 45% more classes and run about twice the cold
    calls of TS mode (FitNotes first frame 2.8 s vs 1.9 s, loaded host). The framework's bodies
    now persist in one store shared by all packages, so an app's first launch after any other
    app's is warm in framework code (Calculator M 1.95 s → 1.28 s after FitNotes).
  Limits: Clash of Clans and Clash Royale fail their anti-tamper checks in both modes; Resy and
  TikTok fail their live flows in both modes. Reddit's flow is timing-sensitive under D: microG's
  One Tap sheet arrives in its own process during the launch and takes the next taps.
- 2026-10-04, Stage D lifecycle differential (§5.3). ActivityThread writes `wm_on_*_called`
  EventLog tags (30021-30065) on both sides. Replaying a flow on the reference AVD with
  `logcat -b events` cleared per step, and on webdroid with the page's `[I/EventLog]` lines, then
  comparing each step's (event, activity, reason) sequence for the app's own activities:
  - FitNotes (39 steps), CalculatorM (8) and Mihon onboarding (5) now match (since the review
    below, launches differ only in the top-resumed reason string). The one remaining
    FitNotes difference is a step boundary: the AVD's start for `28 ex-custom` lands in step 29's
    window. The AVD's mihon-app replay diverged from the flow on its own (it was at the Library by
    step 15 and left the app at 16), so that flow is not evidence either way.
  - No TopResumedActivityChangeItem was ever sent, so `onTopResumedActivityChanged` never ran.
    ATM now sends gained after a launch (the client reports `topStateChangedWhenResumed`) or with
    a resume (`topWhenResuming`), and lost in the transaction that pauses.
  - `Activity.recreate` did nothing: `scheduleRelaunchActivityIfPossible` skips an activity whose
    token is a local `android.os.Binder` (an ActivityGroup child the server does not know), and
    ATM's tokens were local Binders. A client now holds a BinderProxy for a system-owned binder,
    as on a device. Mihon's onboarding theme choice relaunches as the AVD does.
  - A splash screen that starts its successor and finishes raced: the finish saw the activity
    already pausing and scheduled its destroy before the pause transaction was built. A
    lifecycle request for a missing record is ignored, so this was silent until the top-resumed
    callback, an ActivityTransactionItem, threw on it. A second pause now waits on the first.
  - The recorder read the status inset only as `ITYPE_STATUS_BAR`; the current API 35 image prints
    `InsetsSource id=… type=statusBars`, so it could not start. It reads both now.
  - Under SwiftShader, the pixel rule's readbacks dominate a step whose screen keeps changing: in
    Komikku's `09 manga`, `getImageData` took 5.7 s of a 7 s step. Its settle exceeds 20 s on a
    loaded host and times out under the parallel gate.
- 2026-10-04, Stage F and Amazon's launch freeze. With Stage D the only mode, the TS view, widget,
  window, app, context and lifecycle layers were deleted (about 18,000 lines under `src/`): every
  spec in them was under a STAGE_D prefix and withheld. Their removal exposed Stage D paths that
  still read the TS app model, which is always empty under D (app tasks, process importance, the
  notification prompt, MediaStore requests' PendingIntent context); those now read ATM's stack.
  - Amazon froze the page at launch in both modes. A pool thread's HttpURLConnection exchange called
    the app's CookieHandler after `await fetch`, and a plain async native resumes with the main
    thread's identity. Amazon's cookie jar waits on a lock in `NetworkAccessManager.waitForAccess`,
    so the exchange, running as "main", entered the monitor the real main thread had released by
    parking in `wait()`, and both believed they owned it. Main later called `wait()` while a pool
    thread held the lock. javac's catch-all around a synchronized block covers its own
    `monitor-exit`, so the IllegalMonitorStateException re-ran the exit forever. `fetchResponse`
    is now a driven generator, which re-enters the calling thread at each resume, and Amazon
    reaches its sign-in screen.
  - Any TS async native that calls Java after an `await` has the same exposure. Driven generators
    are the safe form. Hosted services still use plain async natives that call Java after host
    awaits (notification, appwidget, telephony, storagestats); they were not converted.
  - Harness: the pixel rule's readbacks starved Komikku's manga step (above); a screen whose every
    sample differs is now sampled less often. Komikku's `16 populated-library` timeouts came
    from step 06 settling on the unchanged welcome page before the library appeared, leaving later
    taps a screen behind; that step now waits for the navigation bar.
  - Open: about one parallel gate run in five early in this session failed Komikku's
    `21 restore` with NotFoundError from `docRead` on a picked "single" document (the backup file
    in the OPFS stand-in). Logging showed no delete or rename of it; it did not recur in 16 later
    runs, alone or parallel. A read overlapping the backup's `createWritable().close()` is the
    untested hypothesis.
  - AOSP's ContentResolver.getType calls `getTypeAsync` (canonicalize and uncanonicalize have
    async forms too), which the hosted Settings and ExternalStorage providers lacked, so getType
    on their URIs failed. A shared base in `systemproviders.ts` answers them as
    ContentProvider.Transport does, and MediaStore's provider is hosted on it (`media`, package and
    process `com.google.android.providers.media.module`, as on the reference AVD).
- 2026-10-04, review of the Stage D/F branch. A strict review of the branch found:
  - ATM: a launch sent "top-resumed gained" in a second transaction that a finish in onCreate
    could overtake. It now rides with every resume, so top-resumed is exactly the resumed
    state; launches therefore report `topWhenResuming` where the AVD reports
    `topStateChangedWhenResumed`, with the same callback order.
  - A plain start answered getCallingActivity: a result record is now kept only for a start for
    a result. A CLEAR_TOP that destroyed a broker-started activity never told the broker.
  - The notification prompt awaited a pause of the main thread that was usually its caller.
  - `after()` and HttpURLConnection's accessors ran Java on the event loop's thread after a
    promise: the Amazon bug class.
  - Providers: two registries of system providers disagreed, so PMS did not resolve Settings or
    Media. The three hosted providers each re-implemented ContentProvider.Transport's defaults,
    and ExternalStorage lacked createCancellationSignal. AMS and IPermissionManager answered uid
    permission checks differently. These are now one registry, one base and one
    `checkUidPermission` in `permissions.ts`.
  - Dead leftovers of the TS stack: drawn-text semantic tracking (a recorded op per drawText),
    AppHost fields and the boot theme work that filled them, the TS resource reader, the Java
    side of the preference store, and withheld registrations. Runtime.register now warns when a
    spec is under a STAGE_D prefix.
  - MediaPlayer.create, SoundPool.load and MediaStore.canManageMedia read the deleted TS
    Context's `$host`.
- 2026-10-05, Stage F: specs that stood in for AOSP bytecode. Specs of platform classes fell from
  291 to 80, and spec methods resolving to an AOSP body from 1,752 to 494 (465 in TS_SPECS' VM
  classes). android.os, android.system, android.database, android.media, android.speech,
  android.renderscript, android.net, android.util, android.location, android.webkit, android.opengl,
  telephony, Camera, Compatibility and the graphics geometry values run from bytecode over natives
  and hosted services. Hand-written TS in `src/android` + `src/jvm/natives` fell from 44,438 to
  41,612 lines. `bun run desccheck` now fails a spec method with an AOSP body outside TS_SPECS.
  - Parcel's native half is a NativeParcel behind mNativePtr (bytes plus a side table of binders
    and owned descriptors; a binder is a flat_binder_object plus stability word). Incoming
    transactions enter through Binder.execTransact; marshall() throws when objects are present.
    A ParcelFileDescriptor crosses processes as its bytes plus a writer binder, written back when
    the importer closes its last descriptor; a raw pipe or socket throws instead of crossing.
  - SystemClock.<clinit> reads System.nanoTime, so the main loop's first SystemClock read started
    System.<clinit> on a JThread that other jobs share; one judged it re-entry and read null
    properties. startMainLooper initialises System first, as the zygote does. Re-entry is judged
    by call chain since 2026-10-02 (below).
  - Build keeps a fields-only spec: its <clinit> reads ro.* properties in zygoteInit, before the
    app's ABI is known, so ARM32-only apps would see an arm64 CPU_ABI. It needs per-ABI zygote state.
  - SQLiteConnection's natives run over sql.js (rebuilt with the C API they call,
    `vendor/sql.js/sqljs.patch`); each connection is its own sqlite3 handle on the file, TEMP state
    stays per connection, and snapshots are debounced per file until every connection is in
    autocommit. A file replaced on disk while closed is reread. Error codes and collator strengths
    follow recalled AOSP behaviour and are unverified. SQLiteRawStatement, custom functions and
    PHONE_NUMBERS_EQUAL are unimplemented. Cursor iteration costs 1.5–2x, inserts about 2x the TS;
    no tap regressed.
  - MediaPlayer's and MediaCodec's Java EventHandler drops events while mNativeContext is 0, so
    the natives set it; native_invoke must rewind its parcel before enforceInterface. Unsupported
    paths (encoders, DRM, AudioTrack static mode, RenderScript intrinsics other than blur) fail as
    AOSP documents. Audible output was not verified headless.
  - The kernel gained AF_UNIX bind/listen/accept for LocalSocket; libcore's MimeMap comes from
    framework.jar's mime.types through RuntimeInit.preForkInit; geocoding goes through
    ILocationManager, so no provider answers an empty list where TS threw IOException.
  - StatsEvent stays TS: with bytecode StatsEvent, Mihon's main thread spent ~12.7 s of a 20 s
    latency run in GC and its theme taps took 170–540 ms. It narrows to ChangeReporter's
    FrameworkStatsLog.write(IIJII); the cause is not found (next: a Chrome heap snapshot). Print
    stays TS: AOSP's print() with no print feature returns null, losing WebView's window.print.
  - Async natives: `rt.su` makes the thread main whenever a frame suspends, so Java after any await
    in an async native, even one on a Java call, ran as main, losing binder calling identity too.
    About 45 services and helpers became driven generators, and `scall` now resumes through
    `after`. `bun run async-natives` (in `bun run test`) finds async functions natives reach that
    call Java after an await, plus generators called without being run; its baseline holds the
    remaining sites (ATM, WM, IMM, surfaces, intentipc). `.then` and host-timer callbacks that run
    Java are the same class and are not linted.
  - Measured noise: doodlejump's `05 back` times out about one run in five at any commit under
    load (timers and frames keep it busy, so it settles only by the pixel rule); a single-run
    bisect blamed an unrelated commit.
- 2026-10-06, review of the Stage F branch. A strict review found six bugs and the TS left behind
  repeating its plumbing per module; all were fixed:
  - A pending SQLite snapshot outlived its last connection and wrote old bytes over a database the
    app had restored; save and open now share one staleness rule. Connections are raw sqlite3
    handles on the Emscripten file (open+close of a 40 MB database 7.7 → 1.4 ms) and the androidx
    bundled driver shares the framework natives' core.
  - Imported parcels were never recycled, so an imported writable descriptor never closed and its
    owner's write-back never ran. `parcelled`/`unparcelled` in binder.ts are the one crossing and
    recycle; Parcel helpers take the NativeParcel only.
  - `viaEdges` wrote glyph bounds back before HarfBuzz's async load settled; bounds are returned as
    boxes. A closing AF_UNIX listener left unaccepted clients blocked; fs/unix own AF_UNIX for
    every front end.
  - A finalized AudioTrack kept its timer, and internal seeks posted OnSeekComplete; media natives
    share one peer, event and source layer and media.ts is split by class.
  - Hosted providers answer through one string-URI transport; URI grants are synchronous again.
  - Mihon onboarding race: removing a needless suspension in `getRunningAppProcesses` (part of
    making `newObj` and friends suspend only when they must) makes its theme taps lose about half
    the time, where the base commit wins 20/20. Mihon's splash waits for a library state that
    arrives after a 250 ms search debounce plus a database query on cold code, while the
    onboarding transition drops HomeScreen's collectors about 250–300 ms after it composes: two
    app wall-clock timers, and a faster main thread starts the transition earlier. A CFS-weighted,
    4-core scheduler honouring setThreadPriority and the top-app boost reached only 20/36 and cost
    7% on Komikku, so it was not kept. The lever is a faster library path (§4.1/§4.3). That change,
    the runtime thread-ownership check that replaces the async-natives lint, and the lint's
    deletion wait on `knlnks/q-async`.
- 2026-10-02 (after the Stage F review), the persisted code store and the platform image (§4.1):
  - The platform store shared by every app was deleted on every launch that started a `/process`
    realm (microG for most apps): the store was keyed by the URL of the chunk holding codecache.ts,
    which differs between index.html's and process.html's bundles, so each realm deleted the
    other's chunks as stale. Warm launches therefore ran most platform code cold (FitNotes 125k
    cold calls at its first frame). Stores are now keyed by a hash of `src/` served with the link
    table, and the platform store loads before zygoteInit, which had run platform code cold on
    every launch. Warm first-frame cold calls: FitNotes 125k → 2.6k, Calculator M 138k → 9.6k,
    Mihon 196k → 15k; FitNotes' warm first frame 1.87 → 1.51 s.
  - Persisting bodies that had only run cold exposed a hot-tier fault: a hot `invoke-direct` into
    an interface (a private interface method, e.g. Consumer.andThen's R8 lambda bridge) called the
    method's direct name on the receiver, which no implementor's prototype chain has. It now calls
    the resolved function, as the cold tier does (JvmTierProbe covers it).
  - Platform image, measured and not built: the reference boot image profile's 30,923 methods in
    bytecode classes emit 37 MB (4.7 MB gzipped) in 0.8 s in Bun, and Chrome imports that module in
    2.5–2.7 s whether its factories compile eagerly or lazily. What it could save is at most what a
    warm platform store saves a first launch: FitNotes after Calculator M warmed the store reached
    its first frame in 1.67 s, against 1.89 s cold. The store already makes an app's first launch
    reuse what earlier apps compiled, so only a browser profile's first app would gain.
  - Mihon's 7 s to first frame is its own splash: `setKeepOnScreenCondition` waits for a home tab
    to set `ready`, for at most 5 s, and the onboarding a fresh install shows sets none. The
    reference AVD's `am start -W` reports 5,428 ms for the same fresh launch; webdroid adds ~2 s of
    boot. FitNotes and Calculator M report 117 and 199 ms there.
  - Harmonic's overflow tap wedged the main loop (also at 9b1b5a0b), and Reddit, TikTok, ChatGPT and
    YouTube wedged their full-lane runs. The connectivity service memoised `theNetwork`,
    `capabilities` and `linkProperties` with `??=` over newObj/rt.drive. While pending, that value is
    a suspension, and every frame that awaits it joins its continuation list (suspend.ts), so the
    main thread's getNetworkCapabilities resumed inside a coroutine worker's stack and never got
    its answer. Wrapping the value in a fresh promise hid the wedge, which is how it was found.
    `once` shares the computation; keystore's security level and IMM's session stub had the same
    shape, and `bun run async-natives` now reports any `??=` of a Java entry or rt.drive.
  - MediaPlayer.setPlaybackParams/getPlaybackParams follow MediaPlayer::setPlaybackSettings over
    the element's playbackRate (pitch is kept only at 1); YouTube's minimum frame rate went 0 → 10/s.
    ARM32 mmap64 read its off64_t from the padding slot; it now reads the aligned pair.
- 2026-10-02, recorded system properties and Build from bytecode (Stage E open 4, Stage F open 2):
  - `gen-framework --properties` records `src/shell/device-properties.ts`: of the properties in
    areas untrusted_app may read (54 of 124 contexts, 628 properties, decided through
    `/sys/fs/selinux/access` as root), the 208 read-only ones the build fixes. Dropped: runtime state
    (init.svc.*, sys.*, gsm.*, dev.mnt.*), debug switches and server flags, ro.boot.*/ro.kernel.*/
    ro.adb.* (AVD name, the host's adb key, qemu flags), the emulator's HAL/GPU/display selection,
    ro.config.* media names and empty values. ro.debuggable and ro.boot.qemu are not app-readable on
    the AVD, so Build.IS_DEBUGGABLE and IS_EMULATOR are false here as there.
  - The AVD is zygote64 with no 32-bit ABI; this device runs armeabi-v7a, so the ABI lists, ro.zygote
    (zygote64_32) and dalvik.vm.isa.arm.* are derived from the native tier's ABIs, which now live in
    properties.ts. ro.build.version.known_codenames (302 bytes) needed bionic's long-property layout.
  - Build, Build$VERSION and Build$VERSION_CODES have no TS spec. Bitness is per-zygote state on a
    device: System.<clinit> takes os.arch from uname and Build.<clinit> CPU_ABI from
    VMRuntime.is64Bit, and zygoteInit's first step runs System.<clinit>. So startZygote loads the
    platform app-free and awaits the process's bitness before zygoteInit; the page fixes it from the
    install's central directories. Measured (headless, port 4402): bitness fixed at 368-478 ms and
    platform ready at 420-560 ms warm, 12.4 s vs 28.3 s with the network throttled to 40 Mbit/80 ms,
    so zygoteInit never waited. Fixing it only in bootApk would have serialized zygoteInit (~0.4 s
    warm, 2.5 s throttled) behind a download whenever the platform is cached and the apk is not.
  - uname (both libcs and Os.uname) is the reference kernel's; a 32-bit process reports armv8l,
    as an arm64 kernel reports compat tasks. flappybird and Cut the Rope (armeabi-v7a only) boot
    with CPU_ABI armeabi-v7a, CPU_ABI2 armeabi.
  - Identity now reported: MODEL/PRODUCT sdk_gphone64_arm64, DEVICE emu64a, BOARD goldfish_arm64,
    HARDWARE/SOC_MODEL ranchu, FINGERPRINT google/sdk_gphone64_arm64/emu64a:15/AE3A.240806.043/
    12960925:userdebug/dev-keys, ro.build.characteristics emulator. These are recognizably an
    emulator's; recording a production device's build instead is a gen-framework input change.
    GL_VENDOR/EGL_VENDOR still read "webdroid".
- 2026-10-02, the Pixel 9's identity from its factory image (E/F follow-up decision):
  - `gen-framework --identity` reads Google's tokay-ap3a.241005.015 factory image (Android 15's
    first Pixel 9 release, sha256 880138730c75aca3dd388759fa1711cab650aad21047889d5adf6bfa514ac87a).
    Its partitions are ext4, read with debugfs (e2fsprogs). It merges the build.prop files in init's
    order: vendor and odm files set only what vendor_init may, and values are checked against their
    property_contexts type. It then derives ro.product.* (default source order), the fingerprint and
    ro.vendor.api_level (34: the board sets no first level), and checks the API level against vendor/aosp.
    App readability is evaluated from the image's CIL policy for untrusted_app. It agrees with the AVD's
    selinuxfs answers on the shared properties: ro.odm.build.id, ro.debuggable, ro.secure and
    ro.vendor.build.security_patch are unreadable, and ro.bootimage.* is unreadable too.
  - Identity (build, partitions' builds, ro.product.*, board, SoC, hardware, bootloader, vendor API
    level) now comes from the image. Everything else still comes from the AVD recording in
    `platform-properties.ts`: ART configuration and heap sizes, SDK extensions, crypto and logd.
    The ABI lists, ro.zygote, density, GL/EGL/Vulkan selection and the media performance class remain
    this device's. The phone is arm64 only, GLES 3.2 on Mali at 420 dpi, and declares performance
    class 34.
  - Boot-time values: ro.bootloader is android-info.txt's required version, which the image also
    flashes. ro.hardware is `tokay` because init.rc imports `init.${ro.hardware}.rc` and the vendor
    ships only init.tokay.rc. vendor_boot's bootconfig carries only boot_devices. ro.baseband,
    ro.bootmode, ro.revision and the serial are left absent because the bootloader supplies them.
    With no telephony there is no RIL to set gsm.version.baseband, so Build.RADIO is "unknown".
  - uname comes from the boot.img kernel banner (6.1.75-android14-11-g48b922851ac5-ab12039954, `#1 SMP
    PREEMPT Tue Jul  2 09:33:34 UTC 2024`) and init.rc's hostname/domainname. init refuses one vendor
    value (persist.device_config.configuration.disable_rescue_party).
  - Checked in the page: Build reports Pixel 9/Google/tokay/Tensor G4, user/release-keys, patch 2024-10-05,
    IS_EMULATOR false. http.agent is `Dalvik/2.1.0 (Linux; U; Android 15; Pixel 9 Build/AP3A.241005.015)`.
    Open: the WebView UA keeps webdroid's shape (no `Build/…; wv`, `Version/4.0` or full Chrome
    version), and GL_VENDOR/EGL_VENDOR still read "webdroid".
- 2026-10-02, cleanup of the graphics, input, service and server natives (`src/android` −75 lines
  net). Local `declaredField` wrappers now use `getDeclared`/`setDeclared`, the server files share
  `pms` and `runsHere` from am.ts, and pm, decode, socket, path and the CanvasProperty readers use
  their owners' helpers. Three faults turned up: addAccountExplicitly read `Set.toArray()` through
  `toJsArray`, which asked the JS array for an iterator and threw for any extras or visibility;
  a float `<meta-data>` value was decoded from int bits twice, so 1.5 became a denormal; and
  vectordrawable registered `VirtualRefBasePtr` a second time, a reference count the app never
  ran because rendernode's registration loads later and wins. Open: base64 is hand-rolled in
  notification, keystore (unchunked spread), webkit, sqlite, framework and proxy; framework-res
  lookups through `getSystem().getIdentifier` repeat in notification, services, storage and
  vibrator. Both want an owner outside these files.
- 2026-10-02, class-init re-entry by call chain (Stage F open items 3 and 4). JLS 12.4.2's
  recursive request was judged by JThread alone, and main-loop jobs and host turns share
  mainThread, so a job interleaved while another's `<clinit>` was suspended proceeded with partial
  statics. A request is now recursive when it comes from the initializing thread *and* call chain.
  The chain is `suspend.ts`'s strand: every suspension records the chain that made it and `unwind`
  resumes as it; a host turn's chain gets an identity when it enters `callOn`, starts a `<clinit>`
  or first suspends. Another chain on the same thread now waits with the 60 ms timed escape (it was
  unreachable before: same-thread requests returned at once); other threads still wait untimed.
  The escape stays because host code that continues a chain without carrying it, or a `<clinit>`
  awaiting work only the waiting chain would deliver, cannot be told from a wait that never ends.
  - Host code that continues a chain must carry it, or its Java waits the escape out: the first run
    caught Komikku's `ImageDecoder.<clinit>`, whose System.loadLibrary ran JNI_OnLoad from
    `loadNativeLib`'s awaits and JNI calls that awaited class initialization. `Cpu.call` now carries
    its caller's chain into every slice it resumes, `caller()` (jlang) captures thread and chain for
    host continuations (`after`, nativeLoad, JNI Call*/NewObject/AllocObject), and conscrypt's BIO
    readers and WebView's shouldInterceptRequest are driven generators. A MediaDataSource is read
    on a binder thread, as the media server reads it through IDataSource. All seven local fast flows
    then ran with no clinit wait timeout, `[webdroid unowned]` or failed `<clinit>`.
  - A static check for Java entered from `.then`, timer or post-`await` code was prototyped over
    `src/` and found only calls already wrapped in a local `callOn` alias; every real case (Cpu
    loop, loader, JNI) entered Java through a helper, so it was not added.
  - Monitors are still owned by JThread: two chains interleaved on mainThread share a lock's
    ownership. Same-thread waits that outlast 60 ms (a heavy `<clinit>` suspended past it) still
    proceed with partial statics and mark the class reentrant for every later request.

- 2026-10-02, the desccheck backlog: StatsLog and print on bytecode, StatsEvent's GC stall found:
  - StatsLog runs from bytecode: its <clinit> loads `stats_jni`, which nothing claimed, so every
    FrameworkStatsLog.write threw UnsatisfiedLinkError, then NoClassDefFoundError (Mihon died at
    launch). `stats_jni` is claimed and `writeImpl` drops the event, as libstatssocket does with no
    statsd socket. ChangeReporter marks a change reported before it writes, so a Mihon session
    writes ~21 events (atom 228, 43 bytes); the bytecode path costs ~1.2 us a write.
  - StatsEvent stays TS, and the stall's mechanism is not StatsEvent's: its Builder takes a pooled
    buffer from `ByteBuffer.allocateDirect`, whose non-movable array (`nonMovableBytes`) sizes guest
    memory for the app's native ABI before any library loads. For arm64 Mihon that commits 4 GiB of
    Wasm memory, after which Chrome keeps incremental marking running: CPU profiles of Mihon's
    theme taps (a lat-style CDP driver) show 10.4–11.7 s of ~23 s in GC against 0.36–0.42 s on the
    base, taps of 180–370 ms. TS StatsEvent with a forced `setA64(true)` reproduces it; bytecode
    StatsLog over TS StatsEvent does not. In isolation (Chrome, ~600 MB retained heap) an
    allocation loop runs 3x slower once committed Wasm memory passes 512–768 MB, whether grown or
    initial; a 4 GiB maximum with 256 MiB committed costs nothing, `--no-incremental-marking`
    removes it and Node does not show it. Every arm64 (4 GiB) and ARM32 (2 GiB) process that sizes
    native memory pays this, Mihon's reader included; StatsEvent only brings it forward. Deferring
    the sizing would leave non-movable arrays in memory a later grow detaches, so the fix is the
    native tier committing guest memory as it is used.
  - Printing: the reference AVD declares `android.software.print` and runs `com.android.printspooler`,
    so the device declares it and PrintManager, PrintJob and PrintDocumentAdapter run from bytecode
    over a hosted IPrintManager. Its print creates the job and answers with a one-shot intent for
    `android.print.PRINT_DIALOG`, created as the calling package (the broker refuses another
    creator). The dialog, a system activity, fills unset attributes with the spooler's en-US
    defaults (letter, 300 dpi, colour, no margins; Markor sets none), lays out and writes the
    document to a spool file and prints the PDF from a browser frame. WebView's adapter writes its
    page snapshot as JPEG pages of the chosen media. In Markor, Share > Print / PDF reached the
    dialog, layout and write with no missing API; with a synthetic snapshot the frame received a
    valid 3-page letter PDF (PDFKit rendered it). The isolated WebView's own snapshot failed there,
    as it does on the base: its injected script's synchronous `describe` bridge call times out
    (504) when Markor's preview loads, so the snapshot (and the base's direct `print` message) has
    no listener. Custom adapters that draw with PdfDocument still lack its natives.
- 2026-10-02, the platform open items: WebView's bridge, PdfDocument, loopback URLs, shared
  libraries and serial unit tests (branch `knlnks/open-platform`):
  - The `describe` 504 needs no site isolation: Playwright's default launch drops it, as Safari and
    Chrome on Android (for most sites) do, so the renderer frame shares the WebView owner's
    thread, and its synchronous XHR blocked the thread that had to answer it until the bridge's
    30 s timeout. With `--site-per-process` (the e2e driver's launch) it answered in 1-15 ms. The
    interface names now travel in the load message. Unfixed limit: `document.cookie` and
    JavaScript interface calls are synchronous by contract and still deadlock (30 s, then throw)
    without site isolation. Markor's Share > Print / PDF then wrote a 2-page letter PDF of the page
    (PDFKit read it; the blob reached the print frame) with and without site isolation.
  - PdfDocument records each page as a picture does and rasterises it at 300 dpi on writeTo. A
    vector writer was rejected: CanvasKit 0.38 has no SkPDF, and a display list holds Path2D,
    gradient and deferred-replay objects a PDF writer cannot read back, so it would need its own
    Canvas interpreter with font embedding. Two letter pages took 173 ms and 122 KB (Flate, CPU
    canvas); a GPU canvas spent 360 ms reading back the first page. PdfRenderer is unimplemented:
    only ChatGPT references it, for attachment thumbnails, and it would need a PDF renderer
    (PDFium on the device).
  - Loopback URLs: host code (MediaPlayer, HttpURLConnection, WebView's proxy) sent every http URL
    to the dev server, which looked for YouTube's `localhost:32768/exocache` on the host (502). It
    now connects to the process's own listener without a guest descriptor and speaks HTTP/1.1; the
    proxy refuses a guest address unless a remap names one (the fuzz probe's adb-reverse origin).
    Listeners in other processes are not reachable (one socket table per realm). MediaPlayer
    reads such a body whole before playing (4.1 MB for one Short). No hosted downloads provider
    exists, so DownloadManager fetches nothing on the host.
  - The exocache server then died on NoClassDefFoundError: YouTube declares `<uses-library
    org.apache.http.legacy>`, and the device's shared libraries were never loaded; TS stand-ins for
    a few Apache HTTP classes answered with no-ops. ApplicationInfo now carries the
    SharedLibraryInfos (SystemConfig's /system jars, mirrored by gen-framework, plus the implicit
    Apache and android.test.base libraries for old targets), and a PathClassLoader asks its shared
    library loaders before its own classes. The app's dex loads at boot, before its loader exists,
    so a class the app bundles that a library also defines still resolves to the library's.
    /system_ext and /product libraries (androidx.window.extensions, sidecar) are not mirrored.
    With both changes the exocache answered 200 with the mp4 its URL names and the Short played.
    YouTube `--live` passed 15 of 17 runs; two runs under host load 25-30 hit
    `removeSyncBarrier`'s IllegalStateException from a resumed Choreographer.doFrame, which 4 base
    runs did not show. Unresolved: whether the newly working in-process server and preview
    playback only expose an existing suspension race in doFrame.
  - `bootApp` in a serial `bun test`: a file asking for another package takes the process over
    (identity, name, app host, an Application from its own LoadedApk, ActivityThread's current
    application and bound package). The notification order assertion depended on the uid, which
    install order decides. Serial runs of every file pass 1098/1098.
- 2026-10-02, YouTube's `removeSyncBarrier` race and WebView's bridge without site isolation
  (branch `knlnks/open-race`):
  - The race did not reproduce. A probe (intrinsics over MessageQueue.postSyncBarrier/
    removeSyncBarrier and ViewRootImpl's schedule/unschedule/doTraversal, plus Looper.loopOnce,
    recording each call's chain) found no chain but the main loop's (and the looper callbacks it
    runs) touching a traversal or barrier, in unthrottled runs and in YouTube `--live` under
    `WEBDROID_CPU_THROTTLE=2` (CDP Emulation.setCPUThrottlingRate; at 3x the flow's steps time out).
    Nothing dispatches a main-loop message while another is suspended: the loop's only reentry,
    `loop()` after an uncaught error, starts after the old chain ended, and host turns reach Java
    as messages (onMain) or through binder and Handler posts. On this base, before ef-followup's
    `6a755f69`, every YouTube run wedged at video-open: callGuestNative awaited before cpu.call
    captured the chain, so NetFetchCallbacks$CppProxy.a ran as chain 0 and each JNI callback was a
    fresh chain, which waited on the class lock (aojk) its own native caller held; the main thread
    then waited behind it. That is the commit's fix. With it, 10 of 10 throttled runs (and 5 of 5
    later) completed without the IllegalStateException; 3 of 10 (and 1 of 5 at the base) missed the
    harness's 3 s liveness probe at fullscreen or video-back under throttling, then went on. The
    17-run failure predates chain-owned monitors (no timed escape since) and chain-carrying native
    calls; neither mechanism is left to explain it, so it is recorded as not reproduced, not fixed.
  - WebView without site isolation: document.cookie is the cookies the app sends the page (with
    the load, after the document's own response, and on every jar change, each with its expiry);
    a write applies in the page as the jar would store it and is posted, and the jar's answer
    replaces the page's copy once it acknowledges every write. Interface calls stay synchronous
    when the app can answer while the page waits; the first call probes that (a bridge call with a
    1.5 s timeout that the app's socket answers apart from calls under way), and a renderer that
    shares the thread posts calls returning nothing and throws for calls returning a value. No
    browser mechanism answers a cross-origin synchronous call from the same thread (the frame's
    origin must stay apart from the app's), so that is the honest limit. Markor's `Android`
    interface: 3 ms isolated; without isolation the probe took 1.5 s once and calls returned at
    once (its "toast" command then fails on the JavaBridge thread, as on a device: Toast needs a
    Looper). JavaScript arrays now reach array parameters as Chromium converts them. A same-origin
    WebView frame (no interfaces, no interception) still sees the host page's own cookies.
  - The WebView reports Android WebView's client hints: userAgentData's brands (Chromium's
    GenerateBrandVersionList for "Android WebView" at the host's Chromium major), mobile, Android,
    and model/platformVersion from Build; the renderer's worker sends the default Sec-CH-UA,
    -Mobile and -Platform to secure origins. Architecture and bitness answer empty, as Chrome on
    Android does; high-entropy hints are not sent as headers (no Accept-CH bookkeeping).
- 2026-10-02, every WebView page on its own renderer origin (branch `knlnks/open-webviso`):
  - A page without interfaces or interception rendered same-origin with the emulator (srcdoc,
    /proxy?frame=1 and /asset frames). FitNotes' change log (loadDataWithBaseURL) read the app
    page's localStorage, cookies, IndexedDB names and `top.wd`; its contentWidth read of a null
    documentElement then threw in View.measure and the dialog never showed. Every load now takes
    the renderer path, on `<sha256(package, web origin)>` substituted into a `*` label of the
    renderer origin: `*.localhost` on the dev server (Chromium resolves it to loopback, and each
    name is its own site), a wildcard WEBVIEW_ORIGIN when deployed. A fixed WEBVIEW_ORIGIN (the
    current Pages deployment) still shares one origin's storage among apps and sites. The web
    origin is the URL's, the base URL's for loadDataWithBaseURL, `file://` for files, and one
    partition per app for opaque documents (Chromium gives a data: document a unique origin
    without storage; here an app's opaque documents share one). A main document redirected to another origin is
    handed to a frame on that origin's renderer without a second fetch.
  - Escapes closed: the frame is sandboxed without top navigation; WEB_FRAME refuses to run when
    its top is readable (a frame of the app's own origin, which a page could otherwise drive
    with its own `load` message); /proxy and /asset documents loaded as frames get
    `CSP: sandbox` (an opaque origin). tests/webview.test.ts serves the frame from a Bun server
    on `localhost` and `*.localhost` and fails if either guard is removed.
  - A hidden frame was display:none, so a wrap_content WebView measured a 0 content height.
    Frames now hide with visibility, take the measured width before they show, and report
    content size changes; a change requests layout only when the measure used that dimension
    (AwLayoutSizer). FitNotes' change log and Markor's view mode render, with and without site
    isolation.
  - Measured (headless Playwright, Harmonic's WebView with its client replaced by the default,
    https://example.com/, 7 warm loads, median): the old same-origin path loaded (iframe load) in
    33-36 ms with first contentful paint at 88-112 ms; the renderer path reports loaded (the
    document's load) at 63-79 ms and paints at 54-69 ms. The first load on a new origin adds the
    service worker's install (131-548 ms first loads). rAF in the page runs at 50-61/s under
    `--site-per-process` against 120/s same-process; the old renderer path (Harmonic's
    intercepting client) measures the same 58-61/s, and without site isolation the new path
    runs at 120/s, so this is the out-of-process frame's rate in headless Chromium. Markor's
    view mode: loaded 195 ms, paint 215 ms (base 222/722 ms, one run each).
  - Open: WebStorage and WebViewDatabase answer no origins and clear nothing, and neither app
    data clearing nor uninstall removes an app's renderer storage (it lives in the browser's
    partitions, keyed by a hash that a reinstall reproduces). Subframes of a WebView page load
    straight from their sites, not through the app's cookie jar.
- 2026-10-02, WebView data, subframes and fonts on the renderer origins (branch `knlnks/open-webdata`):
  - A browser lets only an origin enumerate or clear its storage, so the app notes each web origin
    its WebViews render (`wd:install:<pkg>:webview`), and a hidden frame on that renderer origin
    answers its usage (`navigator.storage.estimate`, less the proxy worker's registration and an
    emptied IndexedDB store the quota manager would delete) or deletes as AwQuotaManagerBridge does:
    deleteOrigin IndexedDB and file systems, deleteAllData also localStorage, getOrigins the origins
    holding quota-managed data by URL spec. Harmonic's article origin (IndexedDB written): getOrigins
    listed it, usage 4,477 bytes, and empty after deleteAllData. WebViewDatabase keeps HTTP auth
    credentials in the app's `http_auth.db` (HttpAuthDatabase's schema); form data is not kept, as
    in current Chromium.
  - The renderer origin hashes the install time with the app and web origin, so a reinstall starts
    clean; the shell's reset (the only data wipe here) first clears every noted origin through such
    a frame, and drops the app's cookie jar. Playwright, FitNotes' change log: localStorage and an
    IndexedDB written in the frame were gone after `wd.reset()`, and the reinstalled app rendered on
    a new, empty origin. ActivityManager.clearApplicationUserData, `pm clear` and uninstall do not
    exist here (no per-package data wipe at all); `clearWebData(pkg)` is the WebView share of one.
  - A renderer frame took a `load` from whichever window framed it, so a page could frame another
    app's or site's renderer and run a document there with its storage. It now takes documents and
    storage requests only from the app's realm, the nearest ancestor of the top's origin
    (`location.ancestorOrigins`; without it, its parent).
  - Subframes: a page asks the app where each http(s) frame loads; the app hands out a frame on that
    web origin's renderer under a token, and a `frame-src` policy (renderer origins only) stops the
    direct load before any request. The subframe's document and requests go through the app's
    cookies (the main page as site; third-party only if allowed), interception (isForMainFrame
    false) and interfaces; its navigations stay in it. Measured (Markor view mode, three iframes on
    three LAN origins, tap to each subframe's script, two runs): base 174-178 ms cold, 125-177 warm;
    routed 234-260 cold (each new origin installs the proxy worker), 124-161 warm. Harmonic's
    Substack article routes its two substack.com frames.
  - Fonts: AwSettings sets Blink's family and size preferences, which no page can set in a host
    browser. The standard family and default font size apply as the document's lowest-precedence
    style, and every system font map name that is no CSS generic (sans-serif-light, arial, times,
    sans-serif-condensed with its wdth as stretch) is a FontFace over the device's file, fetched from
    the app. FitNotes' change log renders in Roboto (it was Times). Limits: CSS generics (serif,
    monospace, ...) and names neither the device nor host has (Markor's `sans-serif-regular`) still
    resolve to the host's fonts, and the default fixed and minimum sizes and text zoom have no CSS
    equivalent (desktop Chromium ignores `text-size-adjust`). Checked with and without site
    isolation: FitNotes' change log, Markor's view mode (with subframes), Harmonic's article.
- 2026-10-02, app data clearing and uninstall (branch `knlnks/open-cleardata`):
  - Evidence: the reference AVD's services.jar. AMS.clearApplicationUserData force-stops the package
    (reason REASON_USER_REQUESTED, "stop <pkg> due to clear data"), PMS clears its data, resets runtime
    permissions and keystore keys, then AMS removes URI grants, calls NotificationManager.clearData
    (channels survive when the app cleared itself: PreferencesHelper.clearData only `!fromApp`),
    cancels jobs and alarms, and its observer wrapper sends ACTION_PACKAGE_DATA_CLEARED before the
    caller's observer. ATM.onPackageDataCleared drops per-app night mode and locales. Neither
    AccountManagerService nor AppExitInfoTracker handles DATA_CLEARED (both act on PACKAGE_REMOVED
    only), so accounts and exit records survive a clear and go with an uninstall.
  - Each owner of per-package state has a hook and `shell/packagedata.ts` calls them: PrivateFiles
    (`/data/data`, `/data/user/0`, `/data/user_de/0`, `Android/data` and `Android/media`), legacy
    `wd:db:` snapshots, renderer storage (`clearWebData`), the cookie jar, `wd:keystore2:<uid>`,
    runtime grants, alarms, notifications and channels, platform preference files, persisted URI
    grants; removal adds senders, accounts the package's authenticator kept (and visibility to it),
    exit records and `wd:install:<pkg>*`. `wd.reset()` removes every package with state through the
    same hooks (its own key list had drifted once already). The broker runs the change after the
    caller's JVM built the broadcasts, since the caller is often the package it kills; the work is
    the top realm's code, as a killed process frame's promise jobs never run.
  - Faults found on the way: a dead page realm's SQLite save timer rewrote the database after the
    clear (a detached view's writes are now ignored); process realms re-registered a removed package
    from their own `/data/app/<pkg>/base.apk` copy and recreated its install time (every realm now
    forgets the record and archive, and install time is recorded only for a registered package); a
    dead app's WebView frames held IndexedDB connections that blocked the deletion (renderers now end
    with the process).
  - Uninstall: PackageInstaller.uninstall with DELETE_PACKAGES deletes at once; otherwise
    REQUEST_DELETE_PACKAGES (target >= 28) gets STATUS_PENDING_USER_ACTION with the
    ACTION_UNINSTALL_PACKAGE intent and an UninstallCompleteCallback, as PackageInstallerService
    does. ACTION_DELETE/UNINSTALL_PACKAGE run the uninstaller, which asks through the page's
    `confirm()`. System packages answer DELETE_FAILED_INTERNAL_ERROR. The launcher lists `/apks`
    samples, not installed packages, so it has no uninstall affordance; `wd.clearData(pkg)` and
    `wd.uninstall(pkg)` drive the two paths.
  - Subframes: a subframe's port now carries the jar's document.cookie as the main frame's message
    does, acknowledged against its writes; the page listens on that port (its parent is the
    framing page). Base (same probe, FitNotes, a LAN page with a same-site subframe): the subframe
    never saw a cookie CookieManager set after load nor the jar's answer to its own write; now both.
  - Verified (Playwright, FitNotes on 4406): after the app's own clearApplicationUserData() every
    store was empty (files and databases in IndexedDB, prefs, keystore, cookie jar, renderer
    localStorage and IndexedDB), the exit record kept REASON_USER_REQUESTED, and the relaunched app
    read no seeded preference, file or database. After uninstall no `com.github.jamesgay.fitnotes`
    key or file remained; the reinstall had a new install time and renderer origin with empty
    storage. ACTION_DELETE showed the confirmation, microG's receiver got PACKAGE_REMOVED.
    fitnotes, mihon-onboarding and komikku pass.
  - Limits: implicit-broadcast restrictions are not modelled for these broadcasts (as for the
    others); a package another realm installed through a session is unknown to the broker's
    registry, as before; the uninstaller's failure result is RESULT_CANCELED, not RESULT_FIRST_USER.
- 2026-10-02, WebView subframes held before their navigation (branch `knlnks/fix-subframe-csp`):
  - flappybird failed on four `Framing '' violates ... frame-src` errors from its AdMob page. The
    frames were `afma-notify-*` iframes with `gmsg://mobileads.google.com/...` srcs (loadSdkConstants,
    invalidRequest, log), the SDK's messages; the empty URL is how Chromium reports a non-network
    scheme. Before the routing change they went to the host's external-protocol handler and vanished,
    so the SDK never received them either. Every script-created http(s) frame also logged a violation
    before it was routed (Harmonic's tej.as article: its Twitter widget).
  - Reference AVD probe (a WebView test APK, loadDataWithBaseURL page): shouldOverrideUrlLoading
    (isForMainFrame false, no gesture) sees subframe navigations of data:, blob:, gmsg:, intent: and
    custom schemes, including a frame removed right after insertion and a child's location change;
    not http(s), about:blank, srcdoc or javascript:. An overridden frame stays on its initial
    document with no load event; an unknown scheme not overridden gets shouldInterceptRequest, then
    onReceivedError(-10, net::ERR_UNKNOWN_URL_SCHEME) and an error page. data: (also offered to
    shouldInterceptRequest) and blob: load when not overridden; about:blank, srcdoc and javascript:
    frames are same-origin with the page.
  - The page now holds a frame's URL before its navigation starts: src and setAttribute (frame and
    iframe), srcdoc, innerHTML/outerHTML/insertAdjacentHTML/setHTMLUnsafe/createContextualFragment/
    document.write, and the initial document, whose frames' src a small tokenizer renames
    (`data-wd-frame-src`, skipping comments and raw-text elements) so the parser inserts them
    without navigating. The same hooks go into each same-origin frame's realm (on contentWindow/
    contentDocument access, or its load). Held frames route as before, or for another scheme ask the
    client, then route (android_asset) or report ERR_UNKNOWN_URL_SCHEME. about:, srcdoc,
    javascript:, data: and blob: frames load untouched; `src` reads the page's URL. The tokenizer
    costs ~5.5 ms on a 2.4 MB page with a frame and nothing without one.
  - Verified (4406): flappybird 3/3 (AdMob's four GMSGs reach shouldOverrideUrlLoading, which
    claims them); Markor view mode with three routed iframes (example.com, example.org, wikipedia)
    and a srcdoc frame, no CSP violation; Harmonic's tej.as article routes its Twitter frame with no
    violation (base: one); FitNotes' change log renders. tests/webview.test.ts covers script,
    parsed, srcdoc-nested, about:blank-written, data: and custom-scheme frames with no console error.
  - Limits: Chromium also offers data: and blob: subframes to shouldOverrideUrlLoading, and custom
    schemes to shouldInterceptRequest; here neither is asked (a revoked blob: URL would not survive
    the round trip). Paths the hooks do not see still meet the policy and log a violation: a child
    frame's own location change or a named-target navigation, a static `srcdoc` attribute's frames,
    an Attr node's value, frames adopted from a DOMParser document, document.write chunks that split
    a tag. A held frame shows one about:blank load event before its routed one. The dev server
    injects the page script into proxied pages, so it must restart after webinject changes.
- 2026-10-03, WebView subframes reached however the page navigates them (branch `knlnks/open-subframes`):
  - Reference AVD probe (WebView test APK, page on the host): data: and blob: subframes reach
    shouldOverrideUrlLoading (isForMainFrame false, no gesture); data: and custom schemes then reach
    shouldInterceptRequest (blob: does not), and its response loads (data: origin null, myapp://x
    origin `myapp://`); unanswered, data: loads and a custom scheme gets onReceivedError(-10) and an
    error page with a load event. A revoked blob: URL still loads. Named targets (link, window.open)
    and a parent's or child's location change navigate the frame, with the client asked as for src.
    Every frame fires one load event (a frame without src: its about:blank one).
  - Here a routed frame fired three: its initial document's (held), its renderer bootstrap's
    (WEB_FRAME's own document before document.write) and the page's. The first is stopped while the
    app answers; the bootstrap posts `{wdFrame: "bootstrap"}` to its parent, which stops that frame's
    next load (message before load in 100/100 OOPIF trials; the written page's own message arrives
    after its load, so it cannot announce itself). A streamed, never-ending bootstrap response also
    has one load but holds an HTTP/1.1 connection per frame: rejected.
  - Held before navigation: static srcdoc attributes (tokenizer decodes, holds, re-encodes), Attr
    nodes (value/nodeValue/textContent on Attr.prototype; setAttributeNode(NS), setNamedItem(NS) via
    frame `attributes`), DOMParser/parseHTMLUnsafe/XHR documents (frames renamed before adoption;
    frame getAttribute/src read the page's URL), document.write chunks (open tag, comment or raw-text
    end carried to the next write, flushed at a microtask or close). A hooked realm routes its own
    cancelable navigate events, targeted links and forms (`_self`, `_parent`, names found through
    same-origin documents) and window.open(url, name); the main document's link and form handlers
    use the same lookup. A same-origin routed page marks the app's navigation of it
    (`Symbol.for("wd.routed")`) so its own navigate handler does not re-route the answer. Parsed
    frames are visited synchronously, so a blob: is fetched before the page can revoke it.
  - Measured (probe, data:/blob: frame, src set to load, 41 interleaved runs, twice): data: 7.2/7.7 ms
    native vs 8.1/9.0 ms asked; blob: 8.2/4.3 vs 8.2/3.8 ms.
  - Verified (4406): probe callbacks and load counts match the AVD for data, blob, custom scheme,
    http, named and child scenarios; flappybird 3/3 with no browser errors (AdMob gmsg still reach
    the SDK); Markor view mode routes three iframes plus one in a static srcdoc and a `target` link
    loads Wikipedia into its frame; Harmonic's tej.as article and FitNotes' change log show only
    base errors (Partytown dispatching to a cross-origin `top`, a Sentry 429).
  - Limits: a navigation of a cross-origin frame through its WindowProxy by another origin
    (`frames[0].location = url`), or of an initial or document.open()ed about:blank frame by its own
    location setter, is neither observable before (no navigate event there; Location is
    unforgeable) nor after (the violation reports only the origin): it still logs a violation. An
    opaque frame (sandboxed srcdoc, data:) navigating itself likewise. A static srcdoc document's
    own frames fire their blank load before its realm is watched. data:/blob: frames get no
    JavaScript interfaces, and an intercepted document reads its renderer URL as location.
- 2026-10-02, StatsEvent's GC stall: lazy guest-memory commit and early sizing both tried, neither
  fixes it (Stage F open 1):
  - Lazy commit (branch `knlnks/lazy-guest-mem-experiment`, not merged): every mem.zig allocator
    took the lowest free run (images bottom-up, ARM64 pool units from plane 0's free pages) and the
    core grew the wasm memory in 64 MiB steps where pages came into use, notifying the host to
    rebuild its views. Mihon, Komikku and doodlejump then stayed at 256 MiB committed (4, 4 and
    2 GiB before). Non-movable byte arrays had to pin the memory (committed whole, never grown
    again: a grow detaches the Int8Arrays Java holds), so StatsEvent's direct buffer still
    committed 4 GiB and still stalled, and a process pinned before sizing gets ENOMEM past 256 MiB.
  - `toResizableBuffer` does not keep such arrays attached usefully in Chrome 153: Web APIs
    reject views over a resizable buffer (TextDecoder.decode, encodeInto, getRandomValues, Blob,
    WebGL bufferData, ImageData: "must not be resizable"), and V8 reads them 4x (typed arrays) to
    13x (DataView) slower. A shared memory keeps views attached across a grow, but TextDecoder,
    getRandomValues and Blob reject shared views and other browsers need cross-origin isolation.
  - In isolation (Chrome 153, ~600 MB retained heap, 3e7 allocations) the committed size alone
    costs nothing and a grow after the heap is built does, non-monotonically:

    | wasm memory                                   | loop        |
    |-----------------------------------------------|-------------|
    | 256 MiB                                       | 129–135 ms  |
    | 4 GiB committed before the heap is built      | 127–131 ms  |
    | one grow after it to 384 MiB, 1 or 2 GiB      | 128–137 ms  |
    | one grow after it to 512 or 768 MiB, or 4 GiB | 206–219 ms  |
    | 64 MiB steps separated by allocation, to 2 GiB| 128–133 ms  |

  - In the app the timing does not carry over. Mihon onboarding theme taps (perf-browser, 15 s,
    `--trace`): the base sizes to 4 GiB a few seconds into launch (heap ~350 MB) and spends ~80 ms
    in incremental marking and ~35 ms in major GC. Sizing at `fixProcessBitness` (329 ms, heap
    144 MB, before zygoteInit) stalls with TS StatsEvent as well as bytecode: 5.0–5.5 s of
    incremental marking and 3.4–3.9 s of major GC, no scavenges, the CPU profile 10 of 17 s in GC.
    Bytecode StatsEvent on the base (pinned or sized at its first event) stalls the same way, even
    with JS-heap arrays in place of guest views and without the finalization registry; JS-heap
    arrays at 256 MiB do not. V8's trigger is history-dependent and not yet identified, so
    StatsEvent stays TS and memory is sized as before.
  - Unchanged on both: e2e doodlejump wedges at its title (perf-browser reaches play), and microg's
    ServiceTrigger throws a NullPointerException in komikku, mihon-app and the games.
- 2026-10-02, StatsEvent's GC stall found and fixed; monitors, class-init waits and fire-and-forget
  entries by call chain (Stage F open items 1 and 4):
  - V8's trigger (`--trace-gc-nvp --trace-incremental-marking` in headless Chromium): every realm
    of the page shares one isolate, and each committed Wasm memory counts in its global size as
    external memory. Bytecode StatsEvent sized guest memory in every realm that wrote a stats event:
    Mihon's and both of microG's GmsCore processes, 4 GiB each. Past V8's global ceiling (about
    twice the old-generation maximum, 8.3 GB here) the global allocation limit sits at the current
    size, so marking restarts as soon as it finishes ("Start (global allocation limit) ... global:
    9056MB / 0MB / 6721MB"), with external-memory-pressure full GCs between. In isolation one 4 GiB
    memory costs nothing and two make an allocation loop 18x slower; 1e5 registered views over one
    memory cost nothing, so views and the finalization registry were not the trigger. This also
    explains the earlier history-dependence: sizing at fixProcessBitness sized every realm.
  - Fix: a non-movable byte[] made before native code sizes the memory is a JS-heap array at an
    address outside guest memory (jmemory's HostBytes, beside the read-only mappings). Memory,
    NIO, zlib, file I/O and conscrypt reach it by address; NIO's element intrinsics go through the
    buffer's array, which AOSP keeps at its address (jbench fbLoop/dbInts/fbBulk match guest
    memory). Native code cannot see it: GetDirectBufferAddress answers 0, JNI's "region undefined",
    and Unsafe's raw accessors fault as they do on a read-only mapping. Memory is sized only when
    native code initialises, so microG's realms stay at 256 MiB. Mihon theme taps (10, CPU profile):
    GC 0.38-0.56 s of the run, against 21.0 s with bytecode StatsEvent before and 0.50 s with the
    TS spec; taps 64-139 ms on a loaded host. StatsEvent's spec is deleted.
  - Still open: more than one realm that runs native code commits 4 GiB each and crosses the same
    ceiling, and on a machine whose V8 heap limit is 2 GB one realm does. Lazy commit needs
    non-movable views that survive a grow, which Chrome cannot give without cross-origin isolation
    (entry above); separate isolates for process realms (cross-site frames) would remove it.
  - Monitors are owned by thread and call chain, as class initialization judges re-entry; chain 0
    (Java no entry identified, in host tools) shares its thread's locks. In FitNotes the main
    loop's MessageQueue.next() now waits for a chain suspended inside enqueueMessage's lock. jbench
    `monitors` costs about 0.6 ns more a lock pair in steady state.
  - The same-thread class-init escape is gone: waits record which chain each blocked chain waits
    for (class initialization and contended locks), and a request proceeds with partial statics
    only on a cycle through that graph. In the seven fast flows the one same-thread wait was the
    main loop on Long$LongCache (22-445 ms, completed); no escape had fired. A host callback that
    loses its chain would now hang rather than read partial statics.
  - Fire-and-forget Java entries (postTo's post, Locale.setDefault on a locale change) enter
    through callUncaught; `scripts/generators.ts` rejects a `void` or bare-statement entry.
  - Komikku's restore step then failed 3 of 10 runs (0 of 5 at the base) on OPFS's NotFoundError
    from a document removed while a listing or lookup read it; documents.ts answers such a
    document as gone, and komikku passed 6 of 6. The failing operation itself was not captured.
- 2026-10-03, Mihon's warm theme taps (lat, the gate's tightest scenario):
  - Breakdown at load 4: dark-warm 95 ms = main thread 77 ms, app background threads 15 ms (OkHttp
    and certificate parsing, coroutine workers, Firebase, DataStore), host 3 ms. Each tap relaunches
    the activity (about 14 ms) and Compose composes the screen from scratch (55-75 ms); draw is under
    1 ms. The 66-67 hosted binder calls per tap cost 3 ms, 0.2 ms of it the parcel copies.
  - Compiled prologues read their thread from `R.cur` instead of calling `R.th()`, which V8 did not
    inline: 2.4-3.0 ms of self time per tap.
  - Rejected (branch `knlnks/open-mihontap`): app threads at default priority yielding behind input,
    with priority inheritance through monitor, class-init and FutureTask/lock-owner waits. Against
    39b8a5b5 it is within noise (warm dark-warm mean 98 vs 96 ms, cold 117 vs 113, 4 pairs each at
    load 6-12); the earlier gain was the prologue change.
  - Launches that never drew a first frame under load (5 in about 45 hunted runs, on every build)
    were the shared ApplicationInfo suspension fixed above; 48 runs after it had none.
  - Remaining: the main thread's Java work, 63-80 ms per tap, spread over Compose's runtime with no
    dominant helper.
- 2026-10-03, first-launch compilation past the baseline profile (§4.4, branch `knlnks/open-aot`):
  - Coverage: through Mihon's lat scenario 3,692 app methods ran cold outside its 18,274-method
    profile (the profiled classes hold 595 of them). Breadth first from the profile and the launch
    components, exact calls and touched classes' `<clinit>` add 4,399 methods covering 518; adding
    each virtual call's declared target, 8,857 covering 1,329. TikTok: 16,359 cold outside its
    66,140-method profile; the closure's first 20,000 cover about 5,100 (all 218,894 cover 12,706).
    RTA from the manifest (reach.ts) reaches 52k (Mihon) and 1.16M (TikTok) methods, less precisely.
  - The compile worker now runs on every first launch: the profile, the Application's and launcher
    Activity's methods, then breadth first what they call (`callClosure`, declared targets), then
    the manifest's other components, up to 20,000 methods past the profile. FitNotes, which has no
    profile, gets 3.5k bodies. Bodies still persist only once a method claims one.
  - Idle preparation took its queue oldest first. A method queues on its first call, so a tap's
    methods waited behind launch's; it now takes the newest first. Interleaved against oldest
    first (n=2): Mihon's second dark tap 3,128 cold calls against 5,409.
  - Cold lat, fresh browser profile, pooled interleaved runs (7 against 10 at the base, load 3-11):
    cold calls in Komikku's first tap 12,256 -> 5,050 (compile 27 -> 17 ms, 198 -> 185 ms), Mihon's
    second dark tap 6,426 -> 2,569 (10.7 -> 2.7 ms, 126 -> 110 ms), second light 4,552 -> 1,922;
    first frames 1,778/7,444/4,638 ms against 1,824/7,417/4,552 (FitNotes/Mihon/Komikku, within
    noise); page heap +49-65 MB, from offered bodies no method claims; code store +1-2 MB.
  - Rejected: starting the worker beside the zygote. First frames were no better (n=2: Mihon 7,588
    against 7,437 ms, Komikku 4,900 against 4,682) and launch ran as many app methods cold. Importing
    the closure's chunks only after the first frame changed no first frame measurably and left
    Komikku's first tap at 8,698 cold calls against 4,966.
  - Mihon's first launch then hung 7 of 22 times before its first frame: `applicationInfoOf` cached
    rt.drive's pending result, a suspension whose continuation list a second caller's frames joined
    and which settles only when the first caller's whole chain (here the main looper's) ends. The
    second `getInstalledPackages` waited on it forever; `once` now shares the build (12/12 launch).
    `scripts/generators.ts` now reports such a result kept by `??=`, `||=`, `Map.set`, a property
    or element store, or a variable its function does not own, directly or through a local; it
    found no other site.
  - Memory: the offered chunks were modules, whose records keep every function they compiled for
    the realm's life (dropping unclaimed factories freed 2 MB). They now run as classic scripts,
    which block the main thread as long (5-6 ms for 3,000 bodies), and the unclaimed bodies are
    dropped 30 s after the last claim. Heap 100 s into a launch: Mihon 669 -> 559 MB, Komikku 710
    -> 600 MB; tap cold calls and latency unchanged (Komikku n=9, Mihon n=5).
  - Open: TikTok (no guest session on this host) is unmeasured; its swipe's 9,500-class message is
    class linking, which a worker's runtime cannot do for the page.
- 2026-10-03, the JVM runtime's structural review (branch `knlnks/refactor-jvm`, behaviour kept):
  - Detached calls: one `detached(call, escape)` with Escape policies (`toThread`, `logUncaught`,
    `binderEscape`) replaces callUncaught, systemUncaught, binderUncaught and reportUncaught.
    `postMain(job, escape)` replaces the twelve `…Uncaught(() => onMain(…))` sites: the outer chain
    was unused (onMain enters through callOn), and a failed job now escapes the main thread, where
    it ran, rather than whichever thread posted it.
  - Traces: one cold stack of frames (`ColdFrame.method`); a throwable keeps each cold frame's method
    and next instruction, and frames carry their position until a trace is read. A per-method script
    is named by its code key (`bodyScript`, `wd/Class.method.js?<key>`), so codecache's `bodyAt`
    maps a line of either a chunk or such a script to its body, and stacklines resolves the class
    through the runtime that loaded the body's dex. The old root-runtime `link` by name could
    auto-stub a forked loader's class (noting it missing); a frame without a body now looks only at
    the classes its runtime linked. Thread traces still skip line lookup, as before.
  - Ownership: `aot.ts` holds the page side of compile-ahead (worker, offered chunks, their sweep);
    a claimed body is adopted into codecache, which keeps the persisted store and the line layout.
    `wd.code()` reports `offered` beside `loaded`, which no longer counts unclaimed offers.
  - Measured and not adopted: an intrinsic that only builds `LikelySubtags$Data` from the page's
    decode and leaves maximize in bytecode. Each realm then runs LSR.decodeInts, LikelySubtags'
    clinit and a cold maximize: the first addLikelySubtags in bun took 39-74 ms (2,599 cold calls)
    against the port's 21-29 ms (1,312) and 59-69 ms (3,642) with neither. The port stays, with its
    ResB and BytesTrie readers in `icudata.ts`.
  - jlang.ts (1,564 lines) splits into jentry (the turn's thread and host entries), jthrowable,
    jstring and jthread; JThread's shape stays with the entry state, so jentry imports no other
    native module and each module evaluates first without a TDZ read. runtime.ts gives class
    initialization to `clinit.ts` (1,224 -> 1,110 lines). jbench `monitors` medians stayed within
    0.43-0.49 ms against the base. Gates: 1,133 tests, FitNotes smoke, fwtest, fast e2e 7/7, lat
    cold and warm (Mihon dark-warm 118 and 96 ms, load 6-19).
  - Chains (after the native refactor merged): `after` continues through suspendWith as a
    suspended frame does, and nativeLoad, loadNativeLib, loadModule (ifunc resolvers and
    initializers), JNI NewObject and guest-native calls are driven generators, so no host code
    captures and re-enters a chain by hand; `caller()` and callOn's chain parameter are gone.
  - The chain is then a `Strand` (suspend.ts) carrying its thread, held in `rt.cur`: compiled and
    cold frames already captured `R.cur` per frame, so one restore covers thread and chain, and
    unwind no longer switches chains. Monitor owners and class initializers are strands; a
    thread's root strand stands for chain 0 (shares the thread's locks, records no waits). A Cpu
    runs as its caller's strand when the caller is its own thread, else as its thread's root (a
    pthread's start, chain 0 before). jbench `monitors` median 0.42-0.47 -> 0.33-0.37 ms;
    initClass and linkInit fast paths unchanged (5M/1M calls, equal medians). Fast e2e 7/7 with no
    wedged or timed-out step; lat --warm passed (Mihon dark-warm 92-102 ms, load 5-16).
  - Regression found after merge: YouTube never drew a first frame (the live flow hung 70 min),
    its pool threads spinning in a synchronized method's handler. Mechanism: `Runtime.within`
    stored the strand on the runtime it ran on, and a class initialized by a DexClassLoader's
    forked runtime gave that fork its own `cur`, shadowing the root's slot its compiled code reads
    through the prototype. Frames then captured a stale strand, so a monitor entered as one thread
    was exited as another: IllegalMonitorStateException in the catch-all whose own monitor-exit
    the same try covers, an endless loop on the page's thread. `within` now writes the root's slot
    (a fork never has its own); YouTube presents again (live flow 3/3), fast e2e 7/7.
- 2026-10-03, the WebView stack's structural review (branch `knlnks/refactor-webview`, behaviour kept):
  - One frame protocol: every renderer document, main frame or routed subframe, is a
    `RendererFrame` whose page talks to the app over the port its load hands it. The window carries
    only the bootstrap's `ready`, dispatched by bridge id in `shell/webrenderer.ts` (shared with the
    storage frames, as `rendererUrl` and `openRenderer` are); the bridge-id routing of every page
    message, `subframeWindows`, `SubframeCookies` and the page's `sub ?` branches are gone.
    Evaluate and snapshot carry a reply port and end on the page's `AbortSignal`, in place of the
    sequence maps. The load message carries page, user agent and interception, so renderer URLs
    keep only the bridge and a subframe token and the worker asks its client (`webcontext`) for
    the document fetch too. `parsePageMessage`/`parseBridgeCall` (`webpage/protocol.ts`) are the
    one validation of page and bridge messages.
  - Page code: the page script, renderer bootstrap and proxy worker are TypeScript entries under
    `src/shell/webpage`, bundled at preload (`scripts/build-web.ts`, generated
    `webpage.gen.ts`, not committed) instead of `toString()` templates: no `__name` shims, double
    escaping or threaded `hold`/`formRequest` parameters; minified whitespace and syntax only, the
    page script is 29 KB (39 KB) and the bootstrap 36 KB (50 KB). A page's links, forms,
    `form.submit()` and navigate events go through `routeSubframes`' one policy in every realm; the
    page's own document keeps its capture-phase links and window submit listener, handing what
    targets no frame to the app (`leave`). The dev server must restart after `webpage/` changes.
  - webkit.ts (1,076 lines) is the provider (556) beside webfactory, websettings, webuseragent,
    webfonts, webjavabridge, webnavigation (entries, `WebHistory`), webrequests and webframes
    (layer, frames, `Subframes`). WebView state resolves `runningApp()` or throws.
  - Differences: a subframe redirected to another origin rendered on the opaque partition (its
    entry carried the document, so `webOrigin` read no URL); it now renders in the target origin's
    partition, as the main frame always did. A snapshot requested before the page script listens
    waits for it (up to its 10 s) rather than timing out unanswered. In the page's own document an
    `area` link now goes through the link handler and an `about:` link through the navigate event,
    each sending the app the navigation it sent before; a link already cancelled by a window
    capture listener is no longer sent.
  - Verified (4406): the frames probe APK's data, blob, scheme, http, named, cross and child
    scenarios log the same client callbacks as the base with and without site isolation; Markor's
    view mode (three routed iframes, a srcdoc frame, a targeted Wikipedia link) and FitNotes' Change
    Log match the base screenshots; Harmonic's blog.cloudflare.com article matches the base pixels
    and errors in both modes; flappybird 3/3 per mode with AdMob's gmsg reaching the SDK as at the
    base; Harmonic and ChatGPT `--live` pass. Gates: typecheck (both configs, `wrangler deploy
    --dry-run` bundles the worker), 1,135 tests, FitNotes smoke, fwtest 31/31, fast e2e 7/7, `lat`
    cold and warm (Mihon dark-warm 110 and 97 ms, load 5-6).
    Main-frame load (probe, started to finished) measured 125-130 ms at the base and 132-139 ms
    after, one run each at load 4-8, consistent with the added `webcontext` round trip; repeated
    runs at load 10 (base 159-286 ms, after 135-418 ms) could not resolve it.

- 2026-10-03, the Android services and process layer's structural review (branch
  `knlnks/refactor-android`, behaviour kept):
  - Service start state has one owner, the broker's ServiceRecords. The hosting process's
    ActiveServices changes it through `starts()` (created, start, deliver, done, stopSelf,
    foreground, destroyed) instead of mirroring a local copy with report() snapshots, so a restart
    reads what the process last changed; it keeps only its tokens, IntentBindRecords and the
    Intents of starts not yet delivered. A realm the broker does not know (the activity-manager
    fixture) keeps a standalone ServiceRecords. ServiceRecords takes one port (send, connected,
    persistent) and owns the binding-key namespacing, the client-death unbind and the
    BIND_AUTO_CREATE wait rule; a sticky restart's null-intent start is queued by
    performServiceRestartLocked's side. A local oneway binder call stays synchronous, which keeps
    the driver's per-binder order (only the caller waits where a device's would not).
  - Death: appexitinfo owns `Death`/`deathOf`; the broker's `fail(pid, message, death)` hands the
    death to watchers, so the exited screen watches the page process as it watches a relaunched
    one, and only a death before the page process registers (its package registers late in
    bootApk) comes from the realm's own exit. A frame failure now logs `[process] ... (pid N):
    <message>` as an exit does, and an exit's DeadObjectException carries its signal or status.
  - Harness: `realmWd()` gives every realm the same uiTree, testFrame and tap, so a tap in a
    relaunched frame is the page's 60 ms press; the page adds the realms of
    `activities.shownWindows()` (the layers show() last applied) instead of scanning and z-sorting
    iframes. Per-package state is one table of owners (clear, remove, packages) next to their
    storage; `wd.reset()` takes the union of `packages()`; a removal runs clear then each remove
    once (the cookie jar is emptied once, its key then dropped).
  - Binder: one execTransact harness for remote and local transactions; a thread's caller,
    explicit flag, StrictMode policy, work source and system identity are one record. A trivial
    hosted call (isUserAMonkey, bun, interleaved runs) measured 2.38 us before and after.
  - MediaCodec definitions carry their bitstream (key frames; AVC/HEVC Annex B SPS codec strings)
    and audio codec strings and rates as data; vectors pin AVC, HEVC, VP8, VP9 and AV1 readings.
    gen-framework shares adb/pull/runDex and one generated-file writer (bootclasspath.ts has one
    writer, which --fonts reuses); recordIdentity is `scripts/identity.ts`. Regenerating the
    recorded files from their current values reproduced them byte for byte; no recording was rerun.
  - ActivityStack and `shell/process-endpoint.ts` leave the broker (processes.ts 677 -> 380 lines).
  - Verified against `b92f4956` with the same probes: clear data then uninstall of FitNotes leave
    identical state (`wd.uninstall` of the running page app never answers on either: the
    deletion kills the realm whose main loop would answer); killing microG's processes rebinds a
    BIND_AUTO_CREATE client of AuthProxyService 2 s later and restarts McsService in a new
    `:persistent` process on both. Gates: typecheck, 1,135 tests, FitNotes smoke, fwtest,
    `gen-framework --verify`, relaunch, fast e2e 7/7 (doodlejump wedged once in a loaded parallel
    run and passed 3/3 alone and in the next full run), reddit and youtube `--live` (youtube's
    controls step failed once on live content, then passed), lat cold (load 8.5; warm not run).
  - Not reduced: the source grew by about 200 lines net (module headers, the ports' contracts, the
    bitstream vectors and the servicerecords tests of the start operations).
- 2026-10-03, the native kernel's structural review (branch `knlnks/refactor-native`):
  - Sockets: a socket is an open file in fs.ts's table (`OpenFile.socket`), so dup, close, fcntl,
    poll, epoll and SCM_RIGHTS see one kind of descriptor. `socket/core.ts` holds the Socket base
    (options, SO_*TIMEO `block()`, generic SOL_SOCKET options) and Loopback (byte or message mode,
    rights carried on each write, a peerless end as a datagram queue); `inet.ts` TCP/UDP,
    `unix.ts` the path namespace, credentials and the logd/dnsproxyd peers (now Loopback peers),
    `abi.ts` every guest layout with a typed SocketAddress, `syscalls.ts` and `resolver.ts`. One
    `written()` raises SIGPIPE for EPIPE on pipes and SOCK_STREAM sockets. The socket core imports
    fs only as a type (`naming(fd, socket)` checks the descriptor a wait is on), so the family
    classes' `extends` reads no binding of their import cycle.
  - Behaviour that now follows Linux instead of the old split's quirks: shutdown(2) validates
    `how` on AF_UNIX; a non-socket descriptor answers ENOTSOCK (not EBADF) from listen/accept/
    shutdown and libcore's socket calls; FIONREAD on a message socket is the next message's length;
    a truncated AF_UNIX message read without MSG_TRUNC answers the bytes copied (read(2), libcore's
    recvfrom); lseek on an unconnected AF_UNIX socket is ESPIPE; ARM32 libc `send()` honours
    MSG_NOSIGNAL (it raised SIGPIPE regardless); libcore's sendto on AF_UNIX uses its destination,
    and SocketInputStream/OutputStream read and write AF_UNIX descriptors; SO_PEERCRED or a group
    request on the wrong family is ENOPROTOOPT; fcntl F_GETLK on a socket reports F_UNLCK and an
    unknown command is 0, as for files; closing one of a dup'd AF_UNIX descriptor wakes a call
    waiting on that number (EBADF), as inet did. Unconnected AF_UNIX sockets still poll readable.
  - Signals: `signals.ts` has the numbers, sigset bits, one disposition table and `action()`,
    which kill and delivery both follow, with the signal calls out of proc.ts; `sigframe.ts` is the
    only spelling of the per-ABI siginfo/ucontext layout; `crash.ts` owns exit_group, dieOfSignal,
    the tombstone's assembly (out of dl.ts), the abort message and debuggerd's handlers, so the
    three hooks go. Cpu keeps one typed frame stack: a handler's Frame carries its stack range,
    siglongjmp exit and sigreturn, with no label-prefix matching. A fault a parked host call's body
    raised now goes through the slice-fault branch, which yields one macrotask after the handler.
  - Bad pointers: kernelInit marks system call slots once (`kernelEntry(slot)`), and the three
    catch sites call `onBadAddress`; a raw svc's EFAULT now also sets errno, as wrapper bodies do.
  - GL: gles3.ts (1,183 -> 624 lines) keeps strings, queries and the entry table; state, pixels,
    buffers, client arrays and validation are gles3-* modules. Entries marked `keepsClean` where
    defined replace the TRACKED name list (the marked set equals it), a texture's tracking is a
    typed unknown/unbound/bound state, and gles1's host errors use `raise` (first error wins, as
    GL specifies; gles1 kept the last).
  - `shell/devicefetch.ts` (from native/loopback-http.ts) owns the loopback-or-proxy routing.
  - Measured against the base under load 6-12 (interleaved): libc-bench ns/op within noise
    (qsort 268.7k vs 268.1k, mutex 66.5 vs 66.0, clock 56.0 vs 57.5); perf-browser glFps flappybird
    49.4 vs 50.4, doodlejump 46.4 vs 46.4 (4 runs each), lichess 17.6 vs 20.4.
  - Gates: typecheck per commit, 1,135 tests, src/native 781, FitNotes smoke, fwtest 31/31, fast
    e2e 7/7 (twice), lichess live, YouTube live 2/3 (the first failed `resume`, "Play video" not
    found; the next two passed), lat cold and warm (Mihon dark-warm 110 and 89 ms). DoodleJump
    under `?jit=0` times out at `title` on the base and here alike. Markor boots with no missing
    API; its boot path makes no AF_UNIX call, so LocalSocket rests on the unit tests.
  - Not met: the branch adds about 200 lines net (module headers, typed results and the two
    socket families as classes); about 55 family branches, the chunk-keyed side tables, the
    poll-provider and crash hooks, and the TRACKED list are gone.

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
- App files grown through an open descriptor or stream past 4 MiB move to the
  origin private file system: one worker holds sync access handles, requests
  run in arrival order so writes return before they land, and IndexedDB keeps
  only `{id, size}`. Every open file of a path is one shared `VfsFile`, which
  native descriptors, FileOutputStream and RandomAccessFile write through one
  helper; before this, RandomAccessFile rewrote and re-persisted the whole file
  per write. Whole-file writers (SQLite, preferences) stay in memory because
  their readers are synchronous; other synchronous readers (fonts, SoundPool,
  FileReader, System.load) read through `readFile`. Genshin's first boot moves
  its 80 MB `global-metadata.dat`, a 16 MB native mmap cache and an 11 MB font
  to disk and warm boots read them back. The app pane's quota is 4.7 GB, below
  Genshin's full resource download; desktop Chrome offers most of free disk.
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
- `LruCache` follows AOSP: an access-ordered LinkedHashMap (keys compare with
  equals()), sizes from `sizeOf`, eviction through `entryRemoved`. Identity keys
  lost Yelp's search results (looked up with an equal new key); counting entries
  let byte-budgeted bitmap caches grow unbounded; SQLCipher finalizes cached
  statements in `entryRemoved`, so without it `sqlite3_close` returned BUSY.
- `ByteBuffer` equals/hashCode/compareTo compare remaining content; identity
  equality failed Tink AES-GCM and so EncryptedSharedPreferences.
- `saveLayer` is a real offscreen layer composited with its paint's alpha,
  xfermode and colour filter; a plain save broke every DST_IN/DST_OUT mask
  (Lottie). RenderNode compositing layers (`setUseCompositingLayer`, Compose
  `CompositingStrategy.Offscreen`) also composite offscreen; CLEAR ignores the
  paint colour and paint alpha modulates shaders.
- Compose `AndroidView` children draw through RenderNode replay, so per-frame
  side effects of `onDraw` (the WebView frame's visibility mark) are recorded
  operations. WebView frames follow Chromium's GC-based AwContents cleanup:
  detaching only hides, `destroy()` or collection releases the iframe, bridge
  socket and cookie port, and page-side hooks reach the WebView weakly.
- Base contexts are `android.app.ContextImpl` whose reflectable `mResources`
  backs `getResources()` (Phrase injects its Resources there).
- `<tag>` children set keyed view tags on any view; selected/activated state
  reaches a ViewGroup's children; layout factories are asked Factory2, Factory,
  private factory, and their result is used as returned.
- Akamai (mcdonalds.com) rejects requests without `Sec-Fetch-*`, a browser
  Accept-Encoding, or with headless `sec-ch-*` hints. A service worker cannot see
  forbidden headers it forwards, so they are rebuilt from `request.mode` and
  `request.destination`; WebView frame loads carry the WebView user agent and
  HttpURLConnection sends `http.agent` when no User-Agent is set.
- The relay terminates TLS and hands apps a peer certificate without a public
  key; apps that pin certificates would fail.
- `LinkedHashMap` access order stamps a sequence on insert and access, merging
  fast and custom-equals entries in one order; `put` on an existing key moves it,
  as `afterNodeAccess` does. HttpURLConnection follows redirects hop by hop so a
  CookieHandler sees each hop's URI.
- One offscreen-layer path serves `saveLayer`, RenderNode compositing layers and
  `setLayerType`: rasters come from per-pool free lists and recorded layers
  replay with semantics. Layout factories follow AOSP's two FactoryMerger chains:
  a Factory set after a Factory2 is never consulted.
- Overlays route touches and BACK on their real `LayoutParams` flags only: touch-
  modal windows take outside DOWNs, FLAG_WATCH_OUTSIDE_TOUCH windows get an
  ACTION_OUTSIDE copy and the touch passes through, BACK goes to the topmost
  focusable window's callback.

## Native CPU, media and transport

- The Zig Wasm core executes ARM32/A64. Interpreter and JIT must agree on
  registers, memory, flags, faults and callback order. Compare `?jit=0`, then
  narrow with `__wdJit` or `core.jit_fallback(lo, hi)`. Writes to executed
  pages invalidate decoded instructions and regions; install regions only
  against the source-page epoch. A region discovery budget once let a branch
  enter with stale carry and broke Lichess P-384 TLS only under JIT.
- Pre-boot native debug globals (set with `page.addInitScript`): `__wdNativeTrace`
  and `__wdNativeStep` arm `wd.native.trace`/`step`; `__wdWatch` (pcs) logs
  registers at each watched pc while stepping; `__wdSlowMs` logs host calls
  and slices slower than that many ms; `__wdGlProbe` checks `getError` after
  every GLES entry point, naming it and counting `perf.glErrors`.
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
  player/backend records and the intro handoff remain unverified. Its
  "OPENGL NATIVE PLUG-IN ERROR: GL_INVALID_OPERATION" came from Unity's
  VideoPlayer binding the SurfaceTexture at `GL_TEXTURE_EXTERNAL_OES` and
  attaching it to a read framebuffer for a blit; native ES 2/3 now maps that
  target to the TEXTURE_2D storage `updateTexImage` fills. The intro still
  shows black. `samplerExternalOES` shaders read it as sampler2D, and the Java
  bindings map the target the same way.
- Native ES 2/3 client arrays (default vertex array only) stream each draw's
  reached vertex range into reused buffers at guest offsets, so `first` and
  indices stay unchanged. A client-vertex draw with a bound element buffer reads
  the indices back with `getBufferSubData` because the host keeps no copy.
  WebGL still rejects what GL allows here: `GL_FIXED`, strides over 255 and
  offsets or strides misaligned to the component size.
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
- Guest memory cannot alias a page at two addresses, so a `MAP_SHARED` file
  mapping is a copy. Realm maps its data file read-only for readers and
  writes through separate writable windows (two can cover the same range);
  readers never saw committed arrays (`No such table exists` from
  `OsKeyPathMapping`) and an older window's `munmap` wrote its stale copy
  over newer ones. Writable mappings now keep the bytes they last agreed on
  with the file: msync, munmap, file reads and new mappings carry exactly the
  changed bytes to the file and every other mapping; `write(2)` reaches all
  mappings. Stores stay invisible to another mapping until one of those
  points, which Realm's full-durability commits always reach.
- An instruction the core lacks is SIGILL to an installed, unblocked handler
  (pc at the instruction, `ILL_ILLOPC`), as for the advertised CPU without
  optional extensions; OpenSSL's armcap probes PMULL/AES/SHA this way. A
  `siglongjmp` from a handler to a `jmp_buf` outside the handler's stack ends
  the handler's `call()` frame and resumes the interrupted frame in the
  `jmp_buf` state.
- `fcntl(F_DUPFD[_CLOEXEC])` must return the lowest free descriptor at or above
  its argument. Returning 0 made mio's cloned epoll fd stdin; dropping a tokio
  runtime closed it and sockets then collided with epoll on fd 0, failing every
  reqwest connect in Tubi within 13 ms. It was not IPv6 or DNS.
- `munmap` rounds its length to whole pages and refuses an unaligned address
  before syncing shared mappings, which read guest memory as aligned words.
- WebGL `getParameter` is a synchronous GPU-process round trip; pixel-store state
  is tracked in JS (~770 ms of a Snapseed Tune Image open on SwiftShader).
- Snapseed's Looks runs MediaPipe/LiteRT's ML Drift OpenGL delegate, which needs
  GLES 3.1 compute (`glGetIntegerv` 0x90DB/0x91BD/0x91BC, then a 0-byte max
  allocation) and `_exit(1)`s on failure; an ES 3.0 device fails the same way.
- ExoPlayer HLS through MediaCodec/WebCodecs plays Tubi's clear streams at the
  content rate with audio, pause and seek; the relay carries 12–13 MB/s.
  Widevine-only titles (`hlsv6_widevine_psshv0`) need MediaDrm over EME, which
  headless Chromium cannot test.
- SIGILL reaches a handler only for `.undefined` and for `.extension`: optional
  encodings HWCAP does not advertise (A64 AES/SHA/SHA512/SHA3/SM3/SM4, PMULL
  .1Q, CRC32, PAuth, SVE; A32 NEON AES/SHA/VMULL.P64, CRC32). `.unimplemented`
  stays a loud fault so crash SDKs never see fabricated signals. A32 CRC32 used
  to decode as a flagless TST and run as a silent no-op.
- `readv` returns what it moved rather than waiting on an empty pipe or socket,
  and continues across iovecs on lazy files. POSIX timers and timerfds arm on
  the guest clock, so under `testClock=controlled` they fire only as virtual
  time advances. MAP_SHARED mappings live on their `VfsFile`: `vfs.writeAt`
  propagates every write (Java streams included) and reads flush mapping stores.
- GLSurfaceView was paced twice (swap's vsync plus an in-flight tick gate), so it
  drew every other display frame (30 fps at 60 Hz). Its GLThread is one loop
  woken by the holder callbacks, with BufferQueue-style backpressure: the next
  frame waits until `present()` has latched the last one, since `vsync()`'s
  watchdog alone let headless GL queue ~60 frames/s against ~8 shown.

- **Stage E1: the reference build's bionic as guest code** (2026-10-03, branch
  `knlnks/bytecode-stage-e1`; the plan's §9 "Stage E handoff" has the state and next steps).
  `?libc=bionic` runs the AVD's libdl/libc/libm/libc++/liblog/libz in arm64 processes, dl.ts
  doing the linker's part (`src/native/bionic.ts`). What bionic needed from the boundary, each
  found by running it:
  - libc_shared_globals, the static TLS layout and each thread's TCB/pthread_internal_t/bionic_tls
    at this build's offsets, checked against libc.so's code (`__errno` +0x300, `getauxval` auxv
    at globals+0x418, `__init_static_tls`'s module table at +0x4d0, `__init_tcb` slot 1).
    Hidden helpers (`__pthread_internal_add`, `zero_dtv`, `__libc_globals`) come from
    `.symtab`, which the loader now reads (it also symbolizes them; symbolization of images above
    2 GiB had sorted signed and unsigned addresses together).
  - Threads the host starts with `run()` (audio, looper, callback threads) must attach too, or
    `__errno`/`pthread_getspecific` read the HLE's TCB (cronet, libnetd_client). clone's thread
    pointer must be the 64-bit guest address: a translated buffer offset went stale when its
    plane moved.
  - libc calls malloc directly as well as through its PLT, so interposing the allocator by
    symbol mixed scudo and host chunks; bionic's malloc dispatch table (`__libc_globals`+0x48)
    covers both paths. Scudo still initializes: its primary reserves 8.25 GiB and commits at a
    256 MiB stride, it executes crc32cx unconditionally (libc is built with +crc), and its
    chunk pointers carry a top-byte tag, which is why the core gained extents, CRC32 and TBI.
  - Since Android 10 getaddrinfo reaches netd only through libnetd_client's `dnsOpenProxy`;
    bionic's own fallback queries a nameserver over UDP. The CFI-enabled libnetd_client needs the
    linker's CFI shadow (linker_cfi.cpp's encoding, host trampolines marked unchecked).
  - Faithful libc behavior surfaced VFS gaps the HLE hid: FORTIFY aborted TikTok on
    `readdir(NULL)` after `opendir("/proc/self/task")` failed, and `pthread_getattr_np` on the
    main thread (tid == pid) aborted YouTube with "stack not found in /proc/self/maps".
    bionic's `abort()` falls back to `_exit(127)` when SIGABRT is ignored, which is how an
    unhandled crash signal first showed up as a silent exit.
  - YouTube's libgoogle3 run headless overran a 1 MiB main-thread stack into the core's own data
    (the pool table), corrupting translations; stack guards and the core's data now fault on store.
  - Rejected: translating plane memory per 2 MiB unit (sparse by construction, no prefix moves).
    Units first touched out of order had to be relocated to stay contiguous for host and
    unaligned accesses, and host operations that hold a buffer offset across an await then
    wrote to the old place: Unity deadlocked after its first frame (0 GL frames/s vs 19.5).
    Prefix windows plus extents for commits 64 MiB past the prefix kept parity (19.7).
  - Measured (headless, one job): Among Us menu 20.5-20.7 GL frames/s HLE vs 22.7-23.2 bionic
    with less than half the host calls; YouTube and TikTok live flows equal in both (TikTok's
    known swipe/video wedges in both); per call from guest code (ns, HLE/bionic) malloc+free
    37/57 (531 with scudo), snprintf 780/2000+, strtod 260/115, mutex 22/68, clock_gettime 46/55
    (189 before the core served svc 113), sin+exp 37/180, qsort of 1,000 ints 26.6 ms/0.27 ms.
    Cut the Rope is armeabi-v7a only and the reference build has no 32-bit bionic.
  - Adopted for every arm64 process (decision record `docs/decisions/0001-bionic-libc.md`); the HLE
    libc is ARM32-only and a 64-bit process no longer registers it: the kernel layer had served
    syscalls by looking up HLE libc bodies by name, so bionic had to hide a libc it never used;
    syscall bodies are now module-level records the syscall table references directly. The gate matrix under bionic found what the HLE had masked:
    `Args64` read a host function's stack arguments from plane 0, and bionic's pthread_create
    puts thread stacks in higher planes, so Flutter's ninth glTexSubImage2D argument (pixels) read
    as NULL (Lichess drew no text) and TikTok's player passed a string as a pointer to
    glTexImage2D; `mremap` was ENOSYS (bionic's `__cxa_atexit` grows its table with it); writing
    `/proc/self/task/<tid>/comm` (pthread_setname_np on another thread) failed; `openat` with
    O_DIRECTORY answered ENOTDIR for a missing path (Google Maps' navigation cache).
  - Properties: bionic reads init's pre-split prop_area from `/dev/__properties__` only when it
    is root-owned and not group/other writable, and its CachedProperty re-finds a property only
    when the area serial moved from 0, so the serialized area carries a serial per property.
    Without it native `localtime` ran in GMT; Java, bionic and the ARM32 HLE now share
    `src/shell/properties.ts`.
  - A Java thread that entered native code now leaves bionic as pthread_exit does
    (`__cxa_thread_finalize`, `pthread_key_clean_all`, `__free_dynamic_tls`,
    `__pthread_internal_remove`, all `.symtab` locals); before, its destructors never ran and its
    TLS block and pthread_internal_t leaked.

- **Stage E2: text on HarfBuzz and the reference fonts, paths on Skia** (2026-10-01; decision record
  `docs/decisions/0002-text-on-harfbuzz-and-skia.md`).
  - Paint's advances came from the browser's `measureText` (prefix differences per cluster, whole
    pixels bolted on) while TextRunShaper shaped with HarfBuzz; they now share one layout, each
    glyph's advance on its cluster's first code unit. A tab has HarfBuzz's space fallback and no
    letter spacing on the device. A glyph HarfBuzz zeroes (a mark, a soft hyphen) kept a hinting
    residual (0.047 px) in both paths.
  - Measuring against real advances exposed the page's fonts: CJK had measured as the host's CJK
    face, which the browser substituted. The reference build's `/system/fonts` and
    `font_fallback.xml` replaced four static Roboto files and a hand-written fonts.xml.
  - minikin runs HarfBuzz at 256 units per pixel over Skia's advances: Skia's advance is truncated
    to that grid and HarfBuzz rounds kerning onto it ("oy" at 20 px: -15 units = -37.5/256, the
    device -37/256). HarfBuzz at upem scale rounds a varied advance to whole units, which flipped
    hinted advances at heavy weights; fonts now run at 256 units per font unit.
  - A variable face takes the style on its axes: the device draws Roboto at wght 900 without
    fakery, and italic at ital 1. Chrome sets wght and wdth from a canvas's font but not ital, so
    an italic variable face is drawn from a HarfBuzz instance with ital pinned; HarfBuzz's
    subsetter fails on the CFF-based CJK collection, whose faces are extracted as tables instead.
  - A line's and `getFontMetricsInt(text)`'s extent is the extent of the fonts its pieces used,
    as minikin's LayoutPieces keep it; text bounds are the laid-out glyphs' boxes.
  - Every system family is read at zygote boot (Typeface.createFromFamilies resolves styles from
    OS/2), so laziness needs what the device's serialized font map carries: `/font-index.json`
    (which since 2026-10-02 carries the map itself; see the follow-up below).
  - `textcmp`'s harness started layouts once `bootMs` was set, but Stage D binds the application
    afterwards and LineBreakConfig dereferences `currentApplication()`: under a cold server every
    layout threw. It now waits for the application.
  - Path.op's TS clipper flattened curves (conics not even sampled), ignored inverse fill types and
    returned a polygon starting elsewhere; SkPathOps through CanvasKit gives the device's verbs.
    CanvasKit's binding names two of SkPath's four fill types; the other two pass by value. Once
    inverse operands counted, drawing an inverse path as "bounds less the path" had to subtract
    the path's plain fill (graphics fuzz seed 20261001, case 36).
  - Text into bitmaps went through CanvasKit's unshaped drawText (no kerning, ligatures faked with
    Unicode presentation forms); it draws minikin's glyph runs with drawGlyphs.
  - The corpus's one native requirement was `sched_getattr` (Nulls Royale), then `sched_setattr`.
- **2026-10-02, the kernel's open Stage E items** (sockets, process creation, mremap, planes).
  A survey of every arm64/armv7 library in `apks/` (dynamic imports, read from `.dynsym`) set
  what evidence each item had:
  - fork 45 libraries (crash reporters, cronet, flutter, TikTok's security SDKs), popen 15
    (getprop and /proc probes), system 3, vfork 2 (libarchive), execvp/execve after a fork only.
    A tab holds one process, so clone without CLONE_THREAD (bionic's fork, vfork, posix_spawn)
    and the ARM32 libc's fork/vfork answer EAGAIN, the kernel's process-limit answer, rather
    than ENOSYS, which no Android kernel gives for them; wait/waitpid answer ECHILD, and
    libcore's forkAndExec throws "error=11, Try again" instead of claiming the program is
    missing. Emulating `sh -c` would fabricate a child process; none of the observed paths
    needs one to proceed.
  - Native sockets read and write sockaddr_in6 over the socket core libcore already used for
    AF_INET6: IPv4-mapped peers, IPV6_V6ONLY (ENETUNREACH for a mapped peer, EINVAL to bind
    one), scope ids, and the family check Linux makes (EAFNOSUPPORT for a sockaddr of the other
    family, except a datagram an AF_INET6 socket sends to an IPv4 address). The relay has no
    IPv6 route, so a UDP connect to a non-loopback IPv6 address is ENETUNREACH as a send was;
    a UDP connect had succeeded, which would have let Chromium's IPv6 reachability probe
    believe the network had IPv6. dnsproxyd and the ARM32 resolver answer AF_INET6 hints
    (numeric IPv6, ip6-localhost; names stay A-only).
  - sendmsg/recvmsg were ENETUNREACH for every socket while 40/53 libraries import them
    (Chromium's unconnected UDP receive, Dart, WebRTC). They move iovecs and msg_name; control
    data on send is EINVAL and msg_controllen reads 0. recvfrom on a stream with an address
    buffer reports length 0 rather than ENOTCONN.
  - AF_UNIX: socketpair ends were not AF_UNIX sockets (getsockname, getsockopt, shutdown failed
    on them) and SOCK_DGRAM/SEQPACKET pairs merged messages. Sockets keep their type; message
    sockets read one message (MSG_TRUNC reports its length); a datagram socket sends to and
    connects to one bound in the process (EPROTOTYPE across types, the sender's name in
    recvfrom). Not modelled: SCM_RIGHTS/credentials, SO_RCVTIMEO on AF_UNIX (accepted), EPIPE
    for a peer that closed, and a bound pathname leaving a socket file.
  - mremap (46 libraries, SQLite among them: `unixRemapfile` remaps its MAP_SHARED database
    mapping with MREMAP_MAYMOVE and turns mmap off when that fails) grows in place through the
    core's `extend_va`, honours MREMAP_FIXED (as MAP_FIXED: only over mapped or reserved
    space), and moves or grows a shared file mapping with its file range and the file's bytes.
    A private file mapping's growth still reads zeros rather than the file.
  - dlclose stays a reference count: 165 libraries import it, mostly closing probes of system
    libraries, and no app was found reloading a library for fresh static state.
  - Planes can move while a host operation waits. `anchor(p)` in mem.ts keeps the guest address
    and answers the current offset; the existing va/guestAt pairs use it, and the holders that
    kept a raw offset across an await now do (readv/writev's iovec array, inotify's read wait,
    Java mmap's read, AMediaExtractor_readSampleData, AMediaCodec_dequeueOutputBuffer,
    AAudioStream_waitForStateChange). rt_sigtimedwait read its info argument twice and took
    sigsetsize as the timeout. The ARM32 libc's holders (qsort, bsearch, fgets, scandir, its
    pthread waits) were left: a 2 GiB process has no planes. Lichess (Flutter, cronet) passed
    15/15 live afterwards.
  - The sendmsg/recvmsg commit broke YouTube's live flow (launch, search and video completions
    timed out), found by tracing every syscall of Cronet's threads. Two causes: msghdr's
    offsets were computed when net.ts loaded, before an arm64 process set PTR to 8, so
    recvmsg read the iovecs from the wrong words and wedged CronetNet; and with recvmsg
    working, QUIC to Google hosts stalled because the UDP relay framed replies with the
    server's resolved address, which a socket connected to the name's synthetic address
    drops. ENETUNREACH from recvmsg had made QUIC fail over to TCP at once before. Replies
    now name their source as the guest dialed it; YouTube passes 16/16 with QUIC carrying
    its traffic. Module-level constants that depend on PTR are wrong for arm64.
  - 2026-10-03: YouTube's video-open then failed intermittently. The relay and the guest's QUIC
    were exonerated:
    - Server and guest packet counts agreed, with no send failures and no queue drops.
    - 5% injected upstream loss recovered.
    - With UDP blocked entirely, the flow failed the same way in the same period.
    The cause was live content: a sponsored card up to 1,600 px tall sometimes sits above the
    film, so the fixed tap at y=1350 opened the ad. The fast lane now taps the film's text
    anchor, and passed 4/4 with an ad above it each time. Logging every datagram to the console
    slowed boot past the 18 s launch bound, so instrument with counters only.
- **2026-10-02, the kernel's second round** (branch `knlnks/open-kernel`):
  - AF_UNIX: SCM_RIGHTS holds a reference on each open file (fs.ts's or net.ts's table) with the
    bytes and installs it at the lowest free number on receipt, as scm_detach_fds does (partial
    cmsg and MSG_CTRUNC when the buffer is short, MSG_CMSG_CLOEXEC); a stream read stops after
    bytes that carried descriptors, a peek duplicates them, a reader's last close releases what it
    never read. SO_PASSCRED/SCM_CREDENTIALS and SO_PEERCRED report this process (every peer is
    in it); an explicit SCM_CREDENTIALS other than its own is EPERM. LocalSocketImpl reads and
    writes through the same calls (outboundFileDescriptors goes with every write, as
    socket_write_all never clears it).
  - SO_RCVTIMEO is kept per AF_UNIX socket: recv/read/accept answer EAGAIN once the guest clock
    passes it; socket, poll and SO_*TIMEO timers moved from setTimeout to the guest clock.
    SO_SNDTIMEO is stored but nothing waits: sends are unbounded queues here (no sk_sndbuf).
  - A pipe or socket whose reader closed (or shut down reading) answers EPIPE; a stream raises
    SIGPIPE unless MSG_NOSIGNAL. Linux has no SO_NOSIGPIPE. The AVD's app threads block SIGQUIT,
    SIGUSR1, SIGPIPE and 32 (`SigBlk 0x80001204`, ART's BlockSignals); Cpus now start with that
    mask, so SIGPIPE stays pending as on the device. An unblocked, unhandled terminating signal
    is still dropped rather than ending the process. Fifos keep their old reader semantics.
  - mremap growing a private file mapping reads the file (private mappings record their range);
    MAP_FIXED/MREMAP_FIXED over free space claim it through the core's map_fixed (free plane-0
    pages, a free plane, or a plane's mapping widened, its prefix moved up when the range lies
    below). The core's own regions stay ENOMEM. Java's Os.mmap still refuses MAP_FIXED.
  - Unsafe.addressSize is the process's pointer width, so IOVecWrapper's iovecs carry 64-bit
    addresses and readv0/writev0 translate them (direct buffers from scudo sit above 4 GiB).
    The audit of module-level values computed from PTR/KLAYOUT/MEM_SIZE found none left;
    `scripts/generators.ts` rejects a direct read at load (indirect reads through a called
    function are not seen).
  - dlclose follows soinfo_unload: fini_array (reverse) and DT_FINI, root first, then images go
    back to module space (zeroed, decoded code invalidated, holes reused, the lowest returned),
    and symbols, handles, TLS descriptors and CFI granules go. Each DT_NEEDED edge now holds a
    reference. NODELETE (flag or RTLD_NODELETE), the bionic boot libraries and images with TLS
    stay (dynamic TLS blocks are not released); thread_local destructors hold their image. An
    image's phdr copy (host data, bump only) is not reclaimed.
  - Item 9 measured before acting: Lichess board-editor frames (7.3 fps) sample libflutter 62%,
    libapp 25%, libc 1.6%, host malloc 1.2%; its Stockfish game is 82% engine, libc 2.8% (free).
    No snprintf, mutex or libm samples, so no change. Its V8 profile spends 1.2 s of 12 s in
    WebGL getError, which is where software GL's queued work is waited on.
  - FlappyBird under `?jit=0` reaches every checkpoint as the JIT does (same game-over screen).

- **2026-10-02, process death and synchronous fault signals** (branch `knlnks/open-death`):
  - A process ends all at once (`src/process-exit.ts`): exit_group, exit/_exit, a signal's default
    action, Runtime.nativeExit (Runtime.exit runs the shutdown hooks from bytecode first) and
    Process.sendSignal(SIGKILL) record the status and never return to the caller. From then the
    realm runs nothing: Cpu loops park, `unwind` never resumes a suspended Java chain, yieldToLoop,
    guest timers, callOn and callUncaught never return, and the AudioContext and playing media
    stop. The broker hears it as appDied (`died` → `fail`): death recipients fire, transactions to
    the pid throw DeadObjectException, its bindings and activities go (a caller gets
    RESULT_CANCELED), and a process realm's frame is removed. SIGKILL of another process of the
    caller's uid goes through the broker. The page's app shows an "exited" session: AOSP removes an
    activity with no saved state when its process dies and shows no dialog on a first crash, so the
    launcher returns; opening the app again reloads the page, whose realm keeps the dead app's
    classes. Probed: FitNotes after System.exit(3) (state exited, ticks and yields frozen) and its
    microG realm after SIGKILL (frame gone, the app running on).
  - Limits: the page realm also runs system_server's Java work (`asBroker`), so after the page's
    app dies the broker's Java-backed requests from other realms wait until reload. Uncaught Java
    exceptions still only log (no KillApplicationHandler). AMS does not restart START_STICKY or
    auto-create-bound services: their ServiceRecords live in the hosting realm's activeservices.ts,
    so a restart needs those records in the broker first. ApplicationExitInfo is not recorded.
  - Guest faults are synchronous signals on the faulting thread: below the null page, an unbacked
    plane address or a write-protected page (stack guard, core data) is SIGSEGV with SEGV_MAPERR or
    SEGV_ACCERR, a null branch target SIGSEGV with pc at the target, a misaligned pc or
    alignment-checked ARM32 access SIGBUS/BUS_ADRALN, an undefined instruction SIGILL and BRK
    SIGTRAP, each with si_addr. Emulator gaps (unimplemented encodings, unsupported syscalls) and
    host functions tripping on a bad pointer stay host faults; wasm traps (an ARM32 address past
    2 GiB) too. Handlers get the kernel's frame for both ABIs (arm64 fault_address and
    fpsimd_context, which Mono asserts; ARM32 sigcontext and vfp_sigframe), and sigreturn loads the
    registers, pc, FP state and mask they leave. A blocked or ignored fault takes the default
    action; SA_RESETHAND is honoured. The core keeps the full 64-bit fault address. JIT exits wrote
    the flag locals without a pending compare's flags, so a handler resuming a region saw stale
    NZCV; exits now write them (the unit test fails without it, in both ISAs and Thumb).
  - Faults had no handler to reach: on a device the linker's debuggerd handler is installed for
    SIGILL, SIGTRAP, SIGABRT, SIGBUS, SIGFPE, SIGSEGV, SIGSTKFLT and SIGSYS, and runtimes chain to
    the handler they replaced. Without it Among Us's libunity logged "No handler for signal 11" and
    returned to the fault 9,000 times in 3 s. kernelInit now installs a host debuggerd handler that
    logs the tombstone from the ucontext and ends the process. Among Us (arm64 il2cpp), a null
    il2cpp_object_get_class on a real thread: libunity's handler read the ucontext (pc, lr, sp,
    "null pointer dereference"), wrote its crash report, forwarded to debuggerd, and the page
    showed "The app stopped". A handler that keeps returning to a fault now yields between
    deliveries rather than holding the page. Survey: SIGSEGV/SIGBUS handlers in apks/ are crash
    reporters (libunity, Sentry, Crashlytics, Bugsnag, xCrash, Google's native crash handler) plus
    Go (Feeder's libgojni) and TikTok's probes; no app has Mono, and no e2e flow takes a handled
    fault, so the `?jit=0` comparison is the unit test's.
  - Cost: none on the slice path (only the fault exit changed). libc-bench ns/op base vs new within
    noise (3 alternating runs each); DoodleJump executes the same 10.97 G guest instructions, and
    its native-ms varies with presented frames (GL calls run inside slices), in both builds.
    doodlejump, flappybird, komikku and lichess (`--live`) pass.
- **2026-10-02, system_server's work outlives app processes** (branch `knlnks/open-sysserver`):
  - The broker is JS in the page's window, but its broadcasts (intent decode, receiver query),
    PendingIntent matching (filterEquals, replaceExtras), alarm timers and unbinds on a client's
    death ran on the page realm's JVM, guest timers or `callUncaught`, which a dead process never
    resumes. Probe: GmsClient's page app SIGKILLed, then a broadcast and a PendingIntent creation
    replayed as microG's realm: no answer after 10 s at base, answered at once now. The sender
    resolves its intent's manifest receivers and the broker checks export and permission from its
    own registry; the creator's realm runs the PendingIntent codec (failing if it dies); alarms
    and service restarts use system timers (`setSystemTimeout`) that no process death stops.
  - No dedicated system realm: one process realm (microG's) takes 0.6-0.7 s of main-thread time
    from frame to ready and about 75 MiB of JS heap (FitNotes, 2 runs), and the broker needs no JVM
    of its own, only a live requester's. Launch is unchanged (launch-profile, load 6-8): FitNotes
    first draw cold 1533-1729 ms at base vs 1626-1680 (one 2010 after a server start), warm
    1129-1483 vs 1157-1265; GmsClient cold 1164/1190 vs 1173/1192, warm 958/927 vs 908/915.
  - Service restarts: the hosting realm keeps ServiceRecord's start items (delivery and done
    counts, onStartCommand's result via serviceDoneExecuting, stopSelf(startId) trimming) and
    reports each created service's start state to the broker (`shell/servicerecords.ts`), which
    also holds every cross-process binding under a client-scoped key. On the host's death it applies
    killServicesLocked/scheduleServiceRestartLocked: unfinished starts are redelivered with
    START_FLAG_RETRY/REDELIVERY after twice their run time (at most 3 deliveries, 6 done), a
    sticky start returns with a null intent, auto-create bindings are rebound, other services are
    brought down and their connections hear `connected(null, dead)`; delays start at 1 s, grow 4x
    within a minute of the last restart and stay 10 s apart, and a process starting runs its
    waiting restarts at once (attachApplicationLocked). Bindings now hear their binder pushed through
    the broker on every publish. Probes: SIGKILL of microG while GmsClient is bound to its location
    service restarts it 1 s later in a new process, the client library reconnects and re-registers
    its request, and the app runs on; killing the persistent process redelivers McsService's
    unfinished CONNECT start after 4.2 s. fitnotes, mihon-onboarding and reddit (`--live`) pass.
  - The shared JVM: hosted services are the app's own IActivityManager Stubs, so same-process
    starts get the caller's objects. ATM and ActiveServices copy the Intent (`new Intent(intent)`),
    whose extras Bundle shares its values: a mutable extra changed after startActivity or
    startService is seen by the started component, `==` holds, and an extra that would fail to
    parcel (or exceed a transaction) does not fail. A parcel round trip at that boundary would
    match a device. Calling identity inside a hosted method is the app's, as system_server sees
    it; hosted state lives in TS modules per realm, and no app class is loaded on the system's
    behalf, so no static or class loader effect was found.
  - Limits: reopening the page's app reloads the tab, ending every realm and the broker with it;
    a process started later does not take a stopped service's non-auto-create bindings; crash
    counts (BOUND_SERVICE_MAX_CRASH_RETRY) are not modelled; the page app's own sticky services
    restart in a process frame while the page shows it exited, as a device would.
- **2026-10-02, crash semantics: uncaught exceptions, exit info, bad pointers** (branch `knlnks/open-crash`):
  - An exception escaping every Java frame only logged. Thread now has libcore's
    dispatchUncaughtException (the pre-handler, then the thread's handler or its ThreadGroup, which
    reaches the default handler), and every escape dispatches on its thread: main-loop messages,
    Java threads, host-entered callbacks (`callUncaught` dispatches on the entering thread),
    native thread bodies and AAudio callbacks. zygoteInit runs RuntimeInit.commonInit, so
    LoggingHandler logs "FATAL EXCEPTION" and KillApplicationHandler calls handleApplicationCrash,
    then killProcess. Probed in FitNotes (a throwing Runnable on the main looper and on a Java
    thread): FATAL EXCEPTION, am_crash, death by SIGKILL, "The app stopped", the record persisted;
    a second crash within MIN_CRASH_INTERVAL after a reload showed "FitNotes keeps stopping", and
    getHistoricalProcessExitReasons returned both as APP CRASH(EXCEPTION).
  - Not every escape is a thread's on a device: a oneway call into a local stub and a death notice
    follow Binder.execTransact (a RuntimeException is logged as a warning; an Error aborts, as
    JavaBBinder's report_exception does), FileObserver events log, and system_server's own work
    (`systemUncaught`: AMS/ATMS, broadcasts, jobs, settings, IMM, vibrator, toasts) logs, because
    the page cannot restart system_server under its apps.
  - AMS's handleApplicationCrash does AppErrors' part: am_crash, the death noted as REASON_CRASH,
    and the dialog only for a crash within MIN_CRASH_INTERVAL of the process's last (the first-crash
    settings are unset; nothing here can set them). debuggerd's path (a core-dumping signal's
    default) reports REASON_CRASH_NATIVE with the tombstone as tombstone.proto (crashing thread,
    registers, frame-pointer backtrace with module, offset and symbol), served through an
    IParcelFileDescriptorRetriever. Each process's end is recorded per package in localStorage
    (16, newest first): EXIT_SELF with its code, SIGNALED with its signal, CRASH (status 0),
    CRASH_NATIVE (signal), importance, setProcessStateSummary. Not modelled: ANR (nothing detects
    one), pss/rss, start reasons. The tombstone's field numbers were not checked against a device
    tombstone (no AVD was up).
  - Bad pointers: mem.ts throws BadAddress with the address. A system call (svc, syscall(2)) or a
    host body for a libc function bionic implements as a syscall stub, or as a call that only hands
    its pointers to one (stat, open, access, readlink, connect: read from the reference libc.so's
    code, its svc stubs and the functions that only tail-call them) fails with EFAULT,
    synchronously or after it parked; any other host libc body raises SIGSEGV at its entry with
    si_addr, which a handler that returns runs again. Host-call cost 44-48 ns before and after
    (base 46-58, noisy host).
  - Guest accesses past the memory trapped in wasm. On the shared, lazily committed memory (the
    entry before), load address tests are now signed compares, which catch ARM32's past-2-GiB
    addresses at no extra instruction; pages past those the memory backs are write-protected, so a
    store there faults through the store path's existing flag test (back() clears the flags as it
    grows); a dispatch past the end faults as a null target does. All are SEGV_MAPERR. A load below
    2 GiB into space not yet backed (free or PROT_NONE pages) still traps in wasm: telling it from a
    backed page would cost every load a compare against the committed size.
  - StackTraceElements had no file and line -1 ("Unknown Source" in FATAL EXCEPTION, am_crash and
    crash reporters). A trace now gets them when read, not thrown: the class's SourceFile and the
    line the code item's debug info gives the frame's pc. A cold frame's next instruction is noted
    at capture; a compiled body's function name carries its method index, and the frame's line in
    its script (its own, `new Function`'s two header lines down, or a persisted chunk, whose
    bodies codeText writes in order) is matched to the instruction the emitter marks on that line
    when it regenerates the body. FitNotes' main looper reads Handler.java:959 and 100,
    Looper.java:232 and 317, as Android 15's traces do, from fresh and persisted code. Eagerly
    compiled classes (smoke) keep -1. Bun's stack depth cuts a deep hot trace in unit tests.
  - Flows: the fast gate already fails on any `[uncaught]` console error (still logged before
    dispatch), so no non-live flow passed despite one; fitnotes, mihon-onboarding, komikku,
    doodlejump and reddit `--live` pass with no uncaught exception and no crash. Other live flows
    were not run and may report uncaught exceptions as gaps; those now end the app.
- **2026-10-02, calls into hosted services cross a parcel; reopening starts a new process**
  (branch `knlnks/open-relaunch`):
  - The service manager and every reply hand an app a BinderProxy for a binder hosted on
    system_server's behalf (the `webdroid/` classes); its transactions run Binder.execTransact
    over a copy of the data parcel on the calling thread (as a transaction from this process, the
    thread's identity, StrictMode policy and work source restored after), and the caller reads a
    copy of the reply. Extras changed after startService are not seen by the service, extras are
    no longer `==`, and a data parcel or reply past BINDER_VM_SIZE fails as signalExceptionForError
    reports it (TransactionTooLargeException over 200 KB). Blobs, bitmaps and cursor windows a
    device would send in ashmem count as descriptors. What the copy exposed: AMS asked for
    providers with GET_META_DATA, so microG's publishContentProviders was 1.4 MB (each holder
    carried 120 KB of application meta-data; AOSP's query has none); MediaSession's two binders and
    the print callbacks shared one spec constructor and so one Stub supertype; SurfaceControl,
    its Transaction, InputChannel and OverlayProperties had no parcel natives (a released
    SurfaceControl writes nothing after its 0). Cost (bun): a trivial call +6 us, getDisplayInfo
    +27 us, relayout +58 us; FitNotes makes about 140 hosted calls to its first frame and 5-90 per
    tap. System-to-app calls (IApplicationThread, IServiceConnection) still pass objects directly.
  - Doodle Jump then wedged every run in its known lock-order race. The billing bind answered in
    0.7 s in some base runs and 7-8 s in others: the bound service's onBind ran after the bind
    request, at background priority under the game's decode. A process now runs in the scheduling
    group of a foreground client bound to it (OomAdjuster; not for BIND_NOT_FOREGROUND or
    BIND_WAIVE_PRIORITY): the bind answers in 0.8 s and doodlejump passes 3/3.
  - ActiveServices: a death carries ApplicationExitInfo's crash and AppErrors' repeat-crash
    verdict; crashes count against the services the process ran (reset after MIN_CRASH_INTERVAL
    from their start), a repeat crash restarts none unless a started service is in the foreground,
    later quick crashes wait BOUND_SERVICE_CRASH_RESTART_DURATION per crash, and at
    BOUND_SERVICE_MAX_CRASH_RETRY (16) the service is brought down; a persistent system package's
    services restart at once. A binding without BIND_AUTO_CREATE no longer starts the process; the
    broker keeps it and a process starting for any reason takes it (attachApplicationLocked).
    Not modelled: procIsBoundForeground in the crash retry, and AppErrors' bad-process mark.
  - "Open again" starts a new process for the package in a frame (the home screen's launch: it
    starts its launcher activity, at the top app's priority until shown); the tab, the broker and
    microG's processes live on, and a relaunched process that dies opens again the same way
    (`bun run relaunch`). FitNotes' relaunch draws 0.87-1.0 s after the click (lat-style harness,
    warm), against 1.1-1.3 s for a warm page load, which also ended every realm.
  - Evaluated, not done: the first launch in a frame too. A prototype that installed in the page
    and launched FitNotes in a frame drew at 1735-1802 ms from navigation against 1596-1611 ms in
    the page (3 cold runs each), as the frame's zygote no longer overlaps the download. Taps on
    lat's fitnotes and calculatorm scenarios answered in 6-68 ms in a frame against 3-43 ms in the
    page (all under 150 ms); the frame presents once per vsync as the page does (239 vs 262
    presentations over the same pager taps); pointer input reaches the frame's canvas directly.
    It also needs the e2e probe, lat and textcmp, which hook the page realm's canvas and timers,
    to follow the app's frame, and the page's system Java work (provisioning, BOOT_COMPLETED) a
    JVM. A frame started at page load, booting its zygote during the download, could close the gap.
- **2026-10-02, GL errors, signal defaults, TLS unload, WebView's UA** (branch `knlnks/open-gl2`):
  - Lichess's getError time is Skia's allocation bracket (bind, glGetError, glBufferData or
    glTexStorage2D, glGetError): about 600 queries in 12 s. Most cost under 0.3 ms, but the first
    one after a present waits for that frame's GPU work (24-185 ms each on SwiftShader). Each WebGL
    context now records whether WebGL can have latched an error since it last answered NO_ERROR.
    Binds, texture parameters, pixel store, texStorage2D, texImage2D, texSubImage2D into tracked
    storage, bufferData and bufferSubData, renderbuffer storage and fences keep it clean when their
    arguments pass checks that mirror WebGL's INVALID_ENUM/VALUE/OPERATION; anything else, or a Java
    GLES, ES 1 or SurfaceTexture call on the context, defers to WebGL. Clean answers skip
    OUT_OF_MEMORY: GL may report it late, WebGL keeps it latched for the next real query, and
    Chrome usually loses the context instead (always queried). Host-raised errors are per context.
    perf-browser, editor exercise, 12 s, 3 runs each: getError 1.12-1.71 s → 0.62-0.64 s, glFps
    4.5-5.5 → 6.5-7.3 (noisy host). What remains is the clear after draws, which only WebGL's
    draw validation can answer. DoodleJump and FlappyBird never call glGetError; their WebGL time
    is command-buffer backpressure in uniform and attribute calls. A fence after each present,
    polled before a query (tried first), freed the thread but cost 100-130 ms in polls with no fps gain.
  - Signals: an unhandled, unblocked signal now takes signal(7)'s default instead of being dropped.
    SIGCHLD, SIGCONT, SIGURG, SIGWINCH and the stop signals are discarded; SIG_IGN is a disposition.
    Everything else ends the process through `markProcessExited` (as exit_group and
    Process.killProcess do; Java threads keep running, as they already did for those). Core-dumping
    signals first log debuggerd's "Fatal signal" line and tombstone head with the abort message and
    backtrace. A raise or unblock returns to the signal before the next guest instruction, so bionic's
    abort dies of SIGABRT rather than reaching `_exit(127)`; the HLE abort raises it too. A blocked
    SIGPIPE or SIGQUIT stays pending, as on the AVD (ART's signal catcher is not run). Memory faults
    still surface as host faults, not SIGSEGV: no guest SIGSEGV handler (sigchain, crash reporters)
    sees them, which is unchanged.
  - dlclose unloads images with TLS: each thread's block for the image is freed, as bionic retires
    the module and frees the block at the next dtv update. dl_iterate_phdr reports the mapped headers,
    found as ElfReader::FindPhdr finds them, instead of a copy that leaked on every reload.
  - WebView's default user agent is AwContentClient's (`Android 15; Pixel 9 Build/AP3A.241005.015;
    wv ... Version/4.0 Chrome/<v> Mobile`), with the provider version taken from the host's Chromium
    (full version from its client hints, fixed at first use). The page renders in the host's Blink,
    so a site's UA checks then match the engine and the host's client hints. `navigator.userAgentData`
    still reports the host's own platform.

- **2026-10-02, Stage E2 follow-up: the serialized font map, hyphenation, emoji and heavy weights.**
  - Every realm loaded the system font map twice: the zygote ran `loadPreinstalledSystemFontMap`,
    and bindApplication, handed no map, called `setSystemFontMap(null)`, which parses
    `font_fallback.xml` and builds every family again (6 parses for FitNotes' 3 realms). One
    load cost 37-177 ms and 8-45k cold calls a realm in the page, 49 ms headless. `/font-index.json`
    now carries `Typeface.serializeFontMap`'s bytes, built by AOSP's own code in a headless boot at
    index time (`nativeWrite/ReadTypefaces` serialize minikin's collections by font path, as
    MinikinFontSkia does); bindApplication receives them as SharedMemory, as FontManagerService
    shares them: 7 ms and 508 cold calls headless, no configuration parse. textcmp stays 72/72.
    Typeface.<clinit> still parses the legacy `fonts.xml` and runs ICU's likely-subtags for ~150
    families in every realm: 130-500 ms and 25-60k cold calls (fonts.xml cold 60-150 ms, the
    first `addLikelySubtags` 60-190 ms); the device runs it once in its zygote, so only the boot
    image (§4.3) removes it.
  - Hyphenation: the reference build's 53 `.hyb` files (extracted from the AVD's system image,
    as gen-framework now pulls them) back `hyphenator.ts`, a port of HyphenatorCXX (alphabet
    tables v0/v1, the trie, minPrefix/minSuffix), HyphenatorMap's subtag fallbacks and
    android_text_Hyphenator's registry (`hyph-am.hyb` is absent, so `am` resolves through
    `und-Ethi` as on the device). minikin's HyphenatorTest and HyphenatorMapTest cases pass.
    MeasuredText computes points (full, or fast from advances), OptimalLineBreaker merges them
    with desperate breaks, the greedy breaker hyphenates a word that does not fit, line flags
    carry the edits, and Paint's measurement and drawText apply a paint's hyphen edits (the
    hyphen shaped in the edge font run, U+2010 falling back to U+002D). No device layout with
    hyphenation is recorded: textcmp's probe uses StaticLayout's default (none), so hyphenated
    breaks are checked only against minikin's unit tests and plausibility.
  - The updatable emoji font: the AVD's fwtest recordings shape "a👍🏽b👨‍👩‍👧🇨🇦" to glyphs 571
    and 856 of `NotoColorEmoji.ttf` with the preinstalled font's advances, which the page
    reproduces, and nothing recorded points at `/data/fonts`. The image supports updatable fonts
    (an API 35 device has fs-verity; `/system/etc/security/fsverity` holds the release cert), but
    without evidence of an installed update the page keeps `/system/fonts`. Checked afterwards:
    the AVD holds an update installed on 2026-09-30 (`/data/fonts/files/<dir>/NotoColorEmoji.ttf`,
    2,813,064 bytes against the image's 2,779,576), and `dumpsys font` serves it; it arrived through
    GMS after the image booted, so whether the reference is the image or the updated device is
    still to decide.
  - FreeType's heavy-weight advances (fwtest "Blk": the device's `l` at wght 900, 20 px is 6, the
    page's 5): HVAR and the gvar phantom points agree (5.498 px), so the variation source is not
    the cause. Roboto's variable face is unhinted (no fpgm/prep or glyph programs), so FreeType
    auto-hints it; CanvasKit's FreeType on a static wght-900 instance gives 5.498 unhinted or
    slight and 5 under normal auto-hinting (which also moves wght-400 advances off round(linear),
    I at 20 px to 6, where every recorded wght-400 advance is round(linear)). Neither mode
    reproduces the 6, so it is left: the next step is a device probe of getTextWidths across sizes
    and weights, with and without `Paint.setHinting(HINTING_OFF)`, against a static instance.
  - The faster boot made DoodleJump wedge every run in a Java monitor deadlock inside the app: main
    holds IabHelper.mServiceLock across onServiceConnected's isBillingSupported call and then wants
    the game's lock; the game's Thread-1, holding that lock each frame, wants mServiceLock. On a
    device the billing service binds long before the game's loop starts and the call takes under a
    millisecond. Here the bound service's realm booted at `scheduler.postTask` background
    priority, since it presents nothing, under the game's native texture decode: 8 s from
    bindService to the answer, so whichever of the game loop and the answer came first decided the
    run, and removing the font map parses moved the game ~0.5 s ahead. A realm now inherits the
    priority of a presented process (or of one serving it) for each bind, start, provider request
    and transaction that process waits on, through its boot, as binder calls inherit their
    caller's priority and a service bound by the top app runs in its scheduling group: the bind
    answers in 0.9 s and the loop starts after it. A realm nobody visible waits on still yields at
    background priority. microG's exposure-notification ServiceTrigger NPE in its process (a
    browser error that fails the flow in some runs) also occurs at 55c3a17b without this change.
- **2026-10-02, the emoji font is the one Google Play installed.** The reference AVD's
  FontManagerService serves a NotoColorEmoji update GMS installed on 2026-09-30
  (`/data/fonts/files/~~Nd6t1SNlfuHRxjD2O1nQ6A==/NotoColorEmoji.ttf`, revision 134152 against the
  image's 133825; config.xml: lastModifiedDate 1790762392872, no added families; config version 1).
  An app process (a probe APK started with `am start`) sees it: SystemFonts.getAvailableFonts lists
  that path, and TextRunShaper shapes "a👍🏽b👨‍👩‍👧🇨🇦" to glyphs 571 and 856 of it with the image's
  advances, and the Unicode 16 additions (U+1FAC6, 1FAE9, 1FA89, 1FADF; also 1FA8F, 1FABE, 1FADC) to
  its glyphs 3254, 3280, 3183 and 3270. `app_process` probes (textcmp, earlier fwtest recordings) load
  the preinstalled map, which is why nothing recorded pointed at `/data/fonts`; the app process's
  StaticLayout rows equal textcmp's fixture, so it stays. Of the image's 1,449 code points, 281
  map to other glyph ids and 50 render differently (the hand emoji, and their skin-tone and ZWJ
  forms).
  - gen-framework (`--fonts` alone) pulls updated files to their device paths and records
    `src/android/font-updates.ts`; the font index serializes the map as FontManagerService does
    (SystemFonts.getSystemFontConfig over the PostScript-name map, buildSystemFallback,
    buildSystemTypefaces), and a headless realm serializes it itself in place of the preinstalled
    map. Skia's bitmap-text emoji face is the served file. The page now matches the app process,
    and the image's emoji file is no longer fetched. Headless loadSystemFontMap stays 80-140 ms.
  - fwtest's Typeface values were app_process's: in an app, a deserialized alias is its own
    Typeface, so `Typeface.create("arial", 0)` is neither `==` nor `equals` DEFAULT (the device
    app process, recorded with the probe). Those two expectations changed with the headless map,
    not with the font. The shaping fixture gains the update's path and the Unicode 16 run.
  - No golden is affected: all were recorded before 2026-09-30, and none shows emoji (the UI dumps
    of calculatorm, lichess, reddit, resy and youtube hold none; fitnotes, harmonic and both mihon
    flows load no emoji font). IFontManager.getFontConfig needs UPDATE_FONTS (signature|privileged),
    so apps cannot read it; the page registers no `font` service.
- **2026-10-02, the text open items: device-recorded hyphenation and advances, Typeface.<clinit>.**
  - `textcmp --record` now records hyphenated layouts (en-US and de, NORMAL and FULL, two widths:
    each line's hyphen edits, and a hyphenated line's glyphs shaped with them) and getTextWidths
    of printable ASCII at wght 100-900, ten sizes, hinting on and off (fwtest compares all
    11,280). `app_process` registers no hyphenators, so the probe calls `Hyphenator.init()` as
    the zygote does; without it the device breaks desperately and records no hyphen.
  - The recording showed three measurement rules, now followed: minikin lays text out at the
    paint's size truncated to whole pixels unless it has LINEAR_TEXT (prepareMinikinPaint; 13.5 px
    measures as 13, while Font.getGlyphBounds keeps 13.5); FreeType varies an advance with 16.16
    coordinates through avar and rounds HVAR's delta to whole units, where HarfBuzz rounds the
    coordinate to 2.14 and keeps the fraction (Roboto's avar maps wght 300 to exactly -0.5 in 2.14,
    so A was 1279.5 units here and 1279 on the device; `variedAdvances` in sfnt.ts); and a hinted
    advance rounds the 26.6 advance to pixels, so wght 900's `l` at 20 px (351.75/64, 352/64 in
    26.6) is 6. The 2026-10-02 autohinter hypothesis was wrong: no hinter is involved. HINTING_OFF
    now measures unhinted.
  - Hyphenation itself already broke where the device does (108/108 layouts with their edits);
    TextRunShaper, getTextBounds and getTextPath ignored a paint's hyphen edits, which
    MinikinUtils::doLayout applies, and pieces were placed by one running float sum where
    Layout::appendLayout adds each piece's own layout at the advance so far (184/184 hyphenated
    lines now match the device's glyphs and positions).
  - Typeface.<clinit> in each realm: with warm code (0 cold calls) it still took 92-137 ms in a
    FitNotes process realm, mostly suspended on ICU data reads. Every realm mounted its own
    platform sources and faulted in its own 64 KB pages of the ICU data. The sources and the pages
    of a mapping are now the page's, as a device's page cache serves every process: process realms
    run the clinit in 42-47 ms warm and 47-80 ms cold (from 122-339 ms, 4.6k cold calls instead
    of 22-55k). The first realm is unchanged (92-104 ms warm, 142-162 cold): 8 page faults
    (12-18 ms), the fonts.xml parse (15 ms warm in bun) and ICU's likely-subtags data decode
    (LSR) on the first addLikelySubtags. Making nativeWarmUpCache non-blocking (the device's
    madvise does not block) measured no gain and was left out. Still open for the first realm: a
    TS intrinsic for addLikelySubtags (§4.7, differential against ICU4J) or a page-shared
    likely-subtags table; a precomputed FontConfig would replace a method's bytecode for ~15 ms.
- **2026-10-02, the first realm's Typeface.<clinit>.**
  - Bitness never delays the zygote: the install fixes it from the central directory in 30-90 ms,
    before the platform is even linked (130-430 ms), so starting the text preload before
    `processBitness` would gain nothing. Prefetching the likely-subtags table at zygote start
    measured 3 ms (noise) and was left out; ICU's 8 page faults in the clinit took 1-6 ms each warm.
  - The clinit's parts, warm with persisted code: LikelySubtags.<clinit> 39-53 ms (Data.load: ICU's
    bundle infrastructure, the langInfo pages, LSR.decodeInts, UScript names), the legacy fonts.xml
    parse 30-40 ms, the family loop ~20 ms. Skipping the clinit's lookups alone only moved the
    decode: Calendar.getRegionForSupplementalData calls addLikelySubtags during the app's launch.
  - `ULocale.addLikelySubtags` is now a §4.7 intrinsic over a page-shared decode of langInfo.res's
    "likely" table (jicu.ts: a ResB reader and BytesTrie, LikelySubtags.maximize; ULocale's parsing,
    UScript names and Region types stay ICU4J's). No realm initializes LikelySubtags by its first
    frame. Interleaved A/B, FitNotes warm: first realm 88 -> 75 ms (cold 162 -> 132), the first
    process realm 61-109 -> 17-21 ms; Mihon first realm 110 -> 87 warm, 167 -> 146 cold. A
    process realm's Promise is not `after`'s: the realm keeps its own promise over the page's.
  - First frame did not measurably move (FitNotes warm ~970 ms either way with provisioning
    deferred). The large variance is elsewhere: `provisionServices` starts microG's process realm
    right after bootApk, and when its boot lands before the app's first frame that frame slips
    ~400 ms (warm FitNotes 1.26-1.3 s vs 1.5-1.9 s, bimodal). Deferring provisioning to the first
    frame gave 945-998 ms in 8/8 runs (experiment only, not committed; an ordering decision for the
    process broker). Still open: the fonts.xml parse (~35 ms, bytecode) and UScript's pnames load
    (~6 ms) in the first realm.

## App investigations and remaining limits

- 2026-10-02, live Resy, Reddit and TikTok (the E/F follow-up's failing live flows):
  - Resy failed on webdroid, not live content. With View on bytecode every UI-dump `resId` was
    empty: View sets a node's view id only while the window's AttachInfo carries
    FLAG_SERVICE_REQUESTS_REPORT_VIEW_IDS, which AccessibilityInteractionController holds there for
    UiAutomation; `dumpWindows` now does the same, so every resource wait (search results, venue)
    could pass. The launcher activity's "Unable to configure device for notifications" alert,
    raised after it stopped under the list, stayed shown: the window manager now keeps
    ActivityRecord's client visibility per token (dispatchAppVisibility to every window of a
    stopping or restarting activity, no ADD_FLAG_APP_VISIBLE for a hidden one). The fast flow
    sampled the list before it loaded and closed the announcement sheet before it arrived (about
    5 s after the venues); it now waits for a venue row and up to 10 s for the sheet. 7 of 8 runs
    passed afterwards (the last 6 in a row); the one failure's artifacts were overwritten.
  - Reddit: the welcome screen pauses to start microG's One Tap activity, whose process shows it
    0.6-3.3 s later. Until then taps reach the paused welcome screen, as on a device (input goes to
    the topmost shown window), so the fast lane's taps raced the sheet. `wd.uiTree` now dumps every
    shown process's windows, as uiautomator dumps the display, and the flow awaits the sheet and
    presses back while it shows; the sign-up sheet's exit is awaited by its top row, since it
    takes taps while it slides out. 4 of 4 after both changes.
  - TikTok's wedge is V8 memory pressure, not live content or a lock: no monitor is blocked and
    the main queue drains when it gets the thread. Its feed runs two 64-bit native processes, each
    with a 4 GiB guest memory, beside a 1.9-2.1 GB JS heap and 1.3-1.8 GB of other ArrayBuffers
    (dex and resources) in the one renderer isolate. Wasm memory counts in V8's global consumed
    bytes (two committed 4 GiB memories alone report 8.7 GB in an empty page), and from the
    `resume` step on every incremental marking starts on "global allocation limit" with the limit
    equal to consumption (8.5 GB, then 9.25 GB once the second process starts at the swipe). A
    25 s trace across swipe and video: 51 major GCs, 14.7 s of main-thread mark-compact, ~2 cores
    of background marking; the CPU profile spends 300-800 ms of each second in GC, so the main
    loop misses the 3 s liveness probe and a swipe's 20 s bound. V8's
    `--maximum-global-heap-limit-factor=8` left the limit unchanged, and 3 GiB ARM64 memories
    (experiment only, 6.4 GB for the two) still wedged.
    The fix is guest memory committed as used (`knlnks/lazy-guest-mem-experiment`), which needs
    non-movable arrays that survive a grow: TikTok allocates 62 of them (1.8 MB) during launch,
    and a grow detaches every view over the old buffer. Resizable-buffer views (slower element
    kinds for every byte[], Web APIs reject them) or a shared memory (cross-origin isolation) are
    the known ways; both were rejected before and remain open.
  - TikTok's other reported gaps are optional: 27 missing classes are app and SDK classes the APK
    does not ship (Lynx devtools, Kakao/Line BPEA, MIUI referrer, AppsFlyer LVL), probed by
    reflection; 17 placeholders are void or false service answers; its `E/` lines are its hook
    libraries failing to find libart. The one native requirement, ARM64 syscall 291 (statx),
    answers ENOSYS as a pre-4.11 kernel would; TikTok's own code issues it (bionic's stat calls do not).

- 2026-10-03, Resy's venue steps timing out (`11 venue-offer-close`, `12 venue-retry`): live
  content, not webdroid. Tapping the sheet's X ran its listener (`dismiss()`), and the fragment and
  dialog were destroyed; a new sheet replaced it within about 0.4 s. ResyListActivity calls
  `loadAnnouncements` from `updateVenues` on every venue-list update and shows the first
  announcement whenever no "announcement" fragment exists (`addAnnouncementHistory`, which
  `canShowAnnouncement` reads, has no callers). After the "Car" search the API answered each
  `loadAfter` with the same bookmark (23) and one venue, so paging (page size and prefetch 20)
  appended the same venue ten times over 5-8 s until 24 rows were loaded. Each update re-showed
  the sheet, so the flow's four taps ran out. The flow now taps while the sheet shows until it
  has stayed away 2 s (tapAt `quietMs`). Resy `--live` passed 3/3. The occasional `08 search-go`
  and `13 venue-back` failures did not reproduce in 4 runs.

- 2026-10-02, guest memory committed as used, in a shared memory (the realm-memory item):
  - Candidates, measured in headless Chromium 153 (a page with a ~600 MB retained heap and an
    allocation loop that promotes): V8 counts a wasm memory's committed bytes, shared or
    not, toward the isolate's global size (two 4 GiB memories, grown: 23.7 s for either kind
    against 0.27 s with none; ungrown with a 4 GiB maximum: 0.20 s), so a shared memory alone
    does not help. What it does give is a grow that detaches nothing: Chrome makes one without
    cross-origin isolation (the `SharedArrayBuffer` global is absent, the memory's buffer is one),
    wasm loads and stores on it run as fast (2e8 load/store iterations 54-56 ms either way) and so
    do typed-array reads and writes from JS (34-46 ms per 1e8 either way, monomorphic). Separate
    isolates per realm (cross-site frames) would need every broker call, store, `pageShared`
    resource and the guest clock behind postMessage, and storage partitioning splits OPFS per
    origin; it also leaves a single realm on a small-heap machine over the ceiling. A smaller
    fixed reservation only moves the ceiling (3 GiB wedged).
  - Fix: the guest memory is shared, and `knlnks/lazy-guest-mem-experiment`'s allocator (every
    allocator takes the lowest free run, ARM64 pool units from plane 0's free pages, 64 MiB grow
    steps, `mem_grown` refreshing the host's views) is back without pinning, with MAP_FIXED
    refusing pool units and dlclose freeing image pages for any later use. The build declares the
    import's maximum and the host flips its flags byte to shared; the JIT's modules declare the
    same. Non-movable arrays live in guest memory from the start. Where no shared memory can be
    made, mem.init commits the address space whole and early non-movable arrays stay host
    arrays, as before. Shared views are refused by TextDecoder.decode (shimmed, as the Encoding
    Standard's AllowSharedBufferSource reads), getRandomValues, Blob, ImageData, WebSocket.send,
    AudioBuffer.copyToChannel and structured clone; WebGL, VideoFrame, the encoded chunks,
    AudioData, Response/Request and crypto.subtle take them. libc's and conscrypt's random fill,
    the relay's WebSocket write and the bitmap decoder's Blob now copy. A view cached across an
    allocation is short after a grow (proc.ts's cpu and fd sets read through `mem` now).
  - TikTok (live, scratch tracer over the whole flow, main-thread GC union of trace events):
    before, two realms at 4096 MiB, used heap 1.8-2.3 GB plus 1.8-2.0 GB of ArrayBuffers, GC 52%
    of 203 s (47% during launch, 35-88% per later step, 4-120 frames per step). After, 1024-1472
    MiB in the main realm and 256 in the others, GC 2.8% of 221 s; `e2e --live --test tiktok`
    went from 20 failures (every step wedged) to one: the swipe step's main loop misses its 3 s
    probe while 12.7 s of its 16 s run native code (the feed's video path), not GC.
    Mihon (mihon-app): 4096 → 256 MiB committed, GC 1.4% → 1.4%. Doodle Jump: 2048 → 256 MiB,
    GC 2.4% → 2.3%; its perf-browser play window was within host noise (44-50 presents/s, 0.85-1.18
    native Ginstr/s for both kinds of memory, alternated).
  - TikTok first hung at launch on this base: KevaImpl.<clinit> called its native initialize,
    whose JNI_OnLoad's GetStaticMethodID(KevaImpl) waited on that <clinit>. callGuestNative and
    loadModule awaited before calling the guest and so ran it as chain 0; they now carry the
    caller's chain. Some TikTok runs still stop answering on the main loop for 8-60 s with the JS
    thread idle; no class-init wait was involved, one run had a monitor wait on applog's DbStore
    past 5 s, and the cause is not yet identified.

- 2026-10-02, TikTok's swipe wedge and idle stalls (branch `knlnks/open-tiktok`):
  - The idle stalls were the process dying at launch. libmetasec_ov raises SIGRTMAX at itself
    (its own syscall stub: tgkill(getpid(), gettid(), 64)) and its handler restores the
    pre-raise registers by hand rather than returning. The handler frame then reached its return
    sentinel with the interrupted JNI call's sp; call() restored the frame below, which resumed
    at the raise's stale svc 15 M instructions later, returned into .bss (an "unimplemented
    0xffffffff" host fault) and took metasec's anti-tamper exit: zero the stack, sp = 0x7b, branch
    to 0x4000. Since process death (2a679101) that SIGSEGV ends the process and the JS thread goes
    idle, which every step then reports as a wedge; before it, only that thread died. A handler
    frame whose return finds another sp now returns from the interrupted call too, in that state
    and signal mask (Linux keeps the handler's mask without sigreturn); a unit test covers it.
    No process died in the 34 TikTok runs after it (their error logs carry no fatal signal).
  - Native CPU on the swipe: TikTok decodes in software (libByteVC1_dec and libbyteVC2dec NEON,
    plus libttcrypto, libbdzstd and libaudioeffect). 99.7% of the swipe's guest instructions run
    JIT-compiled (15 M of 5.7 G interpreted); fallbacks are 0.07% of instructions (fmaxv, fcvtzs
    with fraction bits, sri/sli, shll, cmlt #0, about 0.3 s per step), so implementing them
    is not the lever. The JIT runs this NEON-heavy code at 0.15-0.7 G instr/s against Doodle Jump's
    ~1 G/s. TikTok's AJMediaCodec takes a hardware decoder only when its name starts with "OMX." or
    "c2." and not "OMX.google"/"c2.android" ("non hardware codecname matched" for webcodecs.*).
    Tried, not kept: Codec2 names (c2.webcodecs.<type>.decoder) with MediaCodecInfo flags from
    `isConfigSupported({hardwareAcceleration: "prefer-hardware"})` (HEVC hardware-only, VP8
    software-only in headless Chromium 153). TikTok then chose MediaCodec for some HEVC videos
    but configured no csd and queued hvcC length-prefixed NAL units with in-band VPS/SPS/PPS,
    which WebCodecs rejects ("a key frame is required"); after "decoded first frame timeout" it
    fell back to software. Device decoders need Annex B too, so the missing extradata upstream is
    the open question, not the decoder.
  - The JS thread while video plays: a CPU profile spent 30-55% in WebGL getError. TikTok uploads
    three LUMINANCE planes into textures glTexImage2D made and checks glGetError each frame, and
    an upload into a mutable texture always asked WebGL, whose answer waits for the GPU process to
    drain the uploads: 112 queries took 5.06 s of a 10 s step. gles3 now records the levels
    glTexImage2D specified and answers uploads inside them in the same format and type.
  - The swipe wedge: the probe now records a wedged step's looper, threads (with the thread a
    FutureTask or lock waits for) and running guest threads, then how long the loop took to answer.
    Wedged swipes stalled 4.1-17 s. The main thread was either running the first swipe's cold code
    (8-10 k classes compiled in the step) or parked in KevaFuture.getKeva for about 1 s at a time,
    while guest threads took 75-85% of the step's wall time. LockSupport wakes rode the yield
    channel's batch, which resumed every yielded thread in one task, so a woken thread waited a
    round of every native thread's slice: in launch, main's 44-45 FutureTask waits took 3.19 s,
    1.4-1.7 s of it between unpark and resuming, and other threads waited 24-28 s. Woken threads
    now go first and a turn resumes one yielded thread: 0.67-0.76 s and 5.7-8.0 s. Batching yields
    behind woken threads alone changed nothing; 4 ms turns halved the waits only. Doodle Jump's
    perf-browser window presented 748 frames per 15 s against 766 (650-808 across 7 alternated
    pairs on a loaded host).
  - Rejected: a background share divided among all throttled native threads and extended to while
    the main thread runs a message. Wedged steps kept 75-84% native time (the main thread was
    mostly parked on Keva or ran cold code).
  - Limit: after about 40 fresh installs from this host in a few hours TikTok stopped offering a
    guest session (launch shows "Sign up for TikTok", then "Log in to TikTok", with no skip); the
    SSAID is random per browser profile, so this is TikTok's server-side limit per network or
    fingerprint. Those runs fail at launch ("completion timed out") on live content.
  - Result: before, every step wedged after the launch death. With the handler fix, 9 of the 24
    runs that got a guest feed passed, across the experiments above (the rest wedged one to three
    swipe/video steps). One run with the GL and wake fixes passed launch and both swipes and
    wedged in the video step with the main looper idle-polling (stalled 5.6 s, guest threads 79%
    of the step): its yields waited behind every thread's slice, so the main looper's yield now
    goes first. The two runs after that each wedged once, on the swipe that opens the first video
    page: the main thread inside one message for 6.3-6.4 s (9.0-9.5 k classes compiled, compile
    0.4 s, class init 0.14-0.18 s, the rest running that code cold) while guest threads took
    47-67% of the step. Open: the first video page's cold code on the main thread (the §4
    performance items), the software decode's share of the one JS thread, and TikTok's player
    choosing MediaCodec (its missing extradata).


- 2026-10-02, MediaCodec as the device's hardware decoders (branch `knlnks/open-mediacodec`):
  - Names and flags: the Pixel 9 factory image lists c2.exynos.{h264,hevc,vp8,vp9}.decoder and
    c2.google.av1.decoder as its hardware decoders and AOSP's c2.android.* (aliases OMX.google.*)
    as software; the reference AVD lists its host-backed c2.goldfish.* decoders with attributes
    0xa (vendor, hardware-accelerated) whether the host decodes on its GPU or not. WebCodecs
    decodes off the guest's thread the same way, so the list is now c2.webcodecs.<type>.decoder
    (avc, hevc, vp8, vp9, av1, aac, mp3, opus), vendor and hardware-accelerated. The Exynos names
    would claim another vendor's component and its quirks to apps that key workarounds on them.
    Profiles and levels are probed one by one with isConfigSupported (headless Chromium 153 on
    Apple silicon: AVC to High, HEVC Main/Main10 hardware-only, VP9 0/2, AV1 Main 8/10, VP8
    software-only); limits are 4096x2304 at 60 fps, below the level bounds; no performance
    points or measured rates are claimed.
  - Input, as a c2 decoder takes it: codec-config buffers (BUFFER_FLAG_CODEC_CONFIG) were dropped,
    so ExoPlayer's adaptive reconfiguration and any player that sends parameter sets in band lost
    them; they now lead the next key frame (AVC/HEVC) or become an audio decoder's description.
    The VideoDecoder is configured at the first key frame, its codec string from that SPS (HEVC's
    general profile_tier_level, checked against Chromium-encoded streams); input before a key
    frame decodes to nothing as on a device instead of throwing DataError out of
    queueInputBuffer, and decode failures reach onError. Length-prefixed (hvcC/avcC) samples are
    not accepted, as no device decoder accepts them.
  - TikTok's player (libttmplayer, aj_media_codec_async.cpp) builds a codec's input itself: with
    the stream's hvcC/avcC it converts the extradata to Annex B, prepends it to the first frame
    ("copy sps pps first") and rewrites each sample's NAL lengths to start codes, but only when
    the NAL length size from that extradata (3 or 4) is known; a sample already starting
    00 00 00 01 passes as is. Its "optimize async init" configures a decoder before the stream's
    extradata (default 1280x720, no csd) and takes the extradata later from packet side data.
    The earlier experiment's length-prefixed samples are that window: the first sample threw out
    of queueInputBuffer, which ended the attempt; a device decoder drops such input silently,
    as this one now does. Not verified live: TikTok still offers no guest session from this host
    ("Sign up for TikTok" at launch in fast and full runs), so its fps and guest CPU share after
    the change are unmeasured (before: 2-5 video frames/s, libByteVC1_dec at 0.15-0.7 G instr/s).
  - YouTube configures c2.webcodecs.vp9.decoder (vp09.00.51.08). `e2e --live --test youtube`:
    5 of 7 runs passed here, the two failures the first runs after a host reboot (with debug
    logging), at "resume"; the parent passed 3 of 3 and both pause at 0:00. perf-browser after
    video-open, 10 s: 30.6 presents/s and 29.6 GL frames/s with the main thread 91% idle and guest
    Wasm 1.1% of samples, against 30.5, 29.5, 91% and 1.0% at the parent. Lichess plays no video (no codec created) and passed.
- **McDonald's 26.72.3 (XAPK, ARM64 Realm and Akamai BMP):** reaches its
  startup blocker after the shared-mapping and SIGILL fixes. The US build
  gates startup on Play Age Signals (`R.bool.is_age_gate_enabled`); the
  library finds microG FakeStore (version and spoofed signature accepted)
  but FakeStore 0.3.16 has no age-verification service, so the bind fails
  and any error maps to `BlockerResult.Blocking` — the same outcome as a
  device with that FakeStore. microG merged an Age Signals service
  (GmsCore PR #3742, milestone 0.3.17) whose reply omits `user.status`,
  which the app maps to `SignalDecision.NULL`, a non-blocking result.
  As of 2026-09-27 no release has it (latest 0.3.16.252432); the user chose to
  wait for the official 0.3.17 rather than build from master or bypass the gate.
- **Tubi (XAPK):** onboarding, Home, details, Explore search, Live TV and clear
  (non-DRM) VOD play. Widevine-only titles and every detail-page preview need
  MediaDrm (open decision).
- **Walmart (XAPK):** the location GraphQL answers from the egress IP (this
  host geolocates to Mississauga, CA) and ignores the device's US coordinates
  and ZIP; curl from the host gets the same answer. Onboarding then fails and
  search returns nothing; with a harness-only seed of a US store the home feed
  and type-ahead work. microG's FIDO UI answers CredentialManager sign-in in the
  `gms:ui` process and needs a Back.
- **Yelp (XAPK):** onboarding, home, suggestions and category search (map, list,
  results) work. Search rejects fixes older than 15 minutes; Playwright's
  emulated fix is timestamped before page boot, so the harness must re-set
  geolocation. The business page was unverified at the end of the session.
- **Snapseed (XAPK):** Tune, Crop/Rotate, Details, Healing, Brush, undo/redo and
  repeated export work; Looks aborts (GLES 3.1 compute, above).
- **Genshin Impact 7.1 (XAPK, ARM64 Unity 2017.4 IL2CPP):** reaches the logo,
  the Home scene and the login page context: it downloads the global dispatch
  and SDK configuration, runs SDK init/login and renders the Celestia login
  scene at full surface size. Causes found on the way: its allocator's 4 GiB +
  8 MiB read/write `mmap` failed and it built a heap at address 0 over thread
  stacks (now overcommitted: a plane's writable limit commits on touch, from
  guest accesses with moves allowed and under host accesses in place, since the
  host already holds the address; raw typed-array views bypass that guard);
  32 MiB pool units exhausted
  the pool with 16 KiB/1 MiB mappings; missing `FromReflectedField`, array
  `getSuperclass` and ART's `ClassNotFoundException` for malformed array names
  made Unity's reflection fail asset lookups; `Os.chmod` absence surfaced as a
  Chromium fatal in `libtelemetry` (it treats any pending exception as fatal);
  `allocateDirect` buffers lacked ART's accessible array (now present from the
  first allocation: an app with native libraries has guest memory sized then). The GC-finalizer
  deadlock was the sigreturn race fixed for Among Us. At launch its bundled
  Play Games v2 client opens microG's Google sign-in, as an account-less device
  does; cancelling it continues. The HoYoverse login panel then shows over the
  dimmed scene after four fixes: `NinePatch`/runtime `NinePatchDrawable` and
  `Drawable.createFromResourceStream` (the SDK activity finished on
  `NoClassDefFoundError`); `setContentView(View)` filling the content parent and
  converting foreign params; occlusion from the manifest `Theme.Dialog` rather
  than the `setTheme` in `onCreate`; and a window background set before the
  decor exists. Password login then failed with `-3001 Invalid parameters`:
  the passport SDK encrypts account and password with `RSA/ECB/PKCS1Padding`,
  which threw `NoSuchPaddingException`, so both went out empty, and the error
  toast (`new Toast(Context)` + `setView`) crashed the main thread. With PKCS#1
  and custom-view toasts the server answers with a Geetest slide captcha. Its
  WebView sat in a Dialog, and any visible window hid every WebView frame; the
  bridged frame (JavaScript interfaces) also kept its `/webview` URL, so
  `./gt4.js` and the page's `?data=` parameters missed the asset. With both
  fixed the puzzle renders; solving it and signing in need the account owner.
  Unity pauses behind the SDK login activity (`onPause`), as on a device; with
  the panel closed the Celestia scene runs at about 29 GL frames/s against the
  game's 30/s target with the page's main thread mostly idle in the app pane.
- **Genshin performance (login scene, 1920×1080, headless hardware Chromium on
  Apple M4 Pro):** 19.4 GL frames/s at first. The texture-swizzle emulation read
  sampler units back with `getUniform` after every `glUniform1i`, 20% of the
  main thread; tracking units from the writes gave 26–27 frames/s. The thread is
  then saturated: JIT-compiled guest code is 76%, about 290M guest instructions/s
  and 200K host calls/s (`clock_gettime` about 1,700 per frame). The JIT enters
  a region about 14.8M times/s for 20 instructions each; fitting a run with
  regions capped at 4 blocks gives about 2.3 ns per instruction and 21 ns per
  transition, so transitions cost about 30%. Exits are 42% direct branches to
  another page, 30% `ret` and 22% `br`/`blr`. Emitted wasm averages 103 bytes per
  compiled guest instruction (213 MB over 43K regions by the login scene).
  `--no-liftoff` raised throughput 11%, so V8 tier-up lag is a minor share.
  A Unity job-system spin (`ldar` poll, up to 1,000 iterations) took 20% of
  slice samples, yet reporting 1 core dropped to 21 frames/s and 2 cores was
  within noise. Letting A64 regions take blocks from up to three other pages
  (epoch-checked at entry) halved transitions but fell to 166M instructions/s:
  the callee code duplicated into many regions multiplies compiled wasm and V8
  tier-up work. Uncontended rwlocks no longer park in JS but were not frequent
  in this scene. 60 fps needs roughly 2.3× on this scene alone; gameplay is
  heavier, and every guest thread shares one browser thread. Serving
  `clock_gettime` in the core removed about 45K host exits/s (a quarter of
  them) in the scene; four alternating samples gave 25.6–27.8 GL frames/s with
  and without it, as the scene is not CPU-bound on this host.

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
  been incorrectly rejected by `mprotect`, causing V8 ENOMEM. The "undefined
  0x00000000 @ 0x10004d20" fault was V8 tail-calling code in its code range at
  `0x2_1000xxxx`: mmap had ignored V8's low hints and placed the range in a
  plane above 4 GiB, and the core runs a 32-bit pc, so the branch landed on
  zeroed plane-0 memory (the fault text prints only the low word; the full
  target is in `wd.native.lastFault.regs` x17). The Java InternalError left
  the Elements native mutex held; `ComponentLayoutThread` then parked in
  `pthread_mutex_lock` forever, comments stayed half-rendered and a later
  synchronous Litho layout wedged the main looper. Executable and low-hinted
  mappings now stay in plane 0; comments load, scroll and open replies.
  Converting a native fault into a Java exception still abandons whatever
  native locks the frame held, so any other fault can wedge the same way.
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
  browser `print()` without a verified saved PDF. The handoff (corpus-plan-v2.md, in 24cade3f^)
  listed every pinned app and its remaining feature paths.

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
- Framework services from the 2026-09-26 APK exploration. A driven native
  only waits on its own realm's `Promise`, so in a child process every
  `CookieManager` call read the broker's parent-realm Promise itself (microG
  sign-in's `removeAllCookies`); `useWebCookies` now adopts it. Other broker
  results reached from driven code need the same care. Jobs run through the
  service's `onBind` binder and an IJobCallback, so `JobIntentService`'s own
  `JobServiceEngine` and services in another process receive work; the
  per-run callback and parcelled `JobParameters` are private formats between
  our own specs. Host system activities (pickers, share, chooser) resolve to
  the platform package's `ResolverActivity`. Trash and favourite requests now
  set persisted `is_trashed`/`is_favorite` columns, and queries apply
  MediaProvider's default match rules (trashed and pending excluded).
- java.time now keeps ISO fields and does proleptic Gregorian arithmetic
  itself; zone offsets come from `Intl` (`timeZoneName: "longOffset"`), and
  only the host's own zone uses the JS `Date` getters, so `TimeZone.setDefault`
  and every non-host zone (Calendar, SimpleDateFormat, `Date`'s deprecated
  fields) follow the zone's rules instead of the host's. DateTimeFormatter,
  its builder and SimpleDateFormat share one pattern token engine; localized
  FormatStyle patterns are read back from `Intl.formatToParts`. A failed
  `<clinit>` now leaves the class erroneous (ExceptionInInitializerError once,
  NoClassDefFoundError after), which can surface failures that partial statics
  used to hide. Unresolved: Feeder's per-launch "DiskLruCache journal corrupt"
  did not reproduce with our File/FileOutputStream sequence; FitNotes' UTC
  "today" was not pinned to a call site (its own date code reads local
  Calendar fields). Large file persistence still copies whole files:
  `privatefiles` flushes the full `Uint8Array` (structured clone copies the
  entire backing buffer) on every write tick, which dominates heap during
  long downloads.
- Shell, network and native follow-up to the 2026-09-26 exploration. Guest
  resolvers (minidns, dnsjava) get a DNS server from `LinkProperties`, and
  their port-53 datagrams are answered through `/dns-query` (DNS-over-HTTPS on
  the dev server and the Worker); Thunderbird's autodiscovery then reaches
  "Configuration found". Launch modes, CLEAR_TOP/SINGLE_TOP/CLEAR_TASK,
  Back as a tracked KEYCODE_BACK press, `moveTaskToBack` and a home surface
  after the last activity follow AOSP's ActivityStarter and Activity
  semantics. `wd.configuration` models a physical rotation, so activities
  with a fixed orientation (Flappy Bird, lichess) ignore it; lichess's
  stale-surface report was an artefact of forcing its orientation. Static
  fields a native class does not declare are now reported, which surfaced
  about thirty silent `undefined` statics across the corpus. Komikku's
  bundled requery SQLite logs `SQLITE_WARNING` and `AUTOINDEX` lines at
  error level, as it does on a device; the quick gate counts them as new
  errors. Open: Amazon's startup service reads its current activity only
  from the splash activity and re-runs `taskSetCountry` without one; TikTok's
  Keva block file is `MAP_SHARED` across app processes, which per-process
  Wasm memories cannot keep coherent; a Harmonic row stall past ~80 items
  reproduced once and not again.
- Invisible switches had three independent causes: TextView measured and drew
  from its padding fields instead of the virtual `getCompoundPadding*` that
  Switch/SwitchCompat override (0 px wide), Material's switch vectors spell
  `pathData` as `@string` references, and selectors dropped app-defined states
  (`state_indeterminate`), so the first item always matched. Compound buttons,
  Switch, ToggleButton, CheckedTextView and ProgressBar now follow AOSP's
  drawables and styles; `AID()` memoizes 0 before the framework table loads,
  so style attributes must be resolved at construction, not module load.
  A themed context clones its base inflater (dialog rows become AppCompat
  widgets), windows draw into a `RecordingCanvas`, and framework layouts
  dispatch `measureChildWithMargins` virtually (NestedScrollView settings now
  scroll). The limits recorded here (painted indeterminate progress, no Switch
  drag, no leading margins, `Html.fromHtml` without `<img>`/`<sub>`/TagHandler,
  shadowless popups) were resolved in the follow-up entry below.
- Performance pass, 2026-09-27 (Apple M4 Pro, 120 Hz display, hardware GPU).
  The virtual display was fixed at 60 Hz while GL swaps waited on raw rAF, so
  on a 120 Hz host Doodle Jump rendered 120 GL frames/s and presented 60. The
  shell now measures the host rate before boot (`?hz=` pins it; process frames
  inherit it) and eglSwapBuffers waits for the virtual vsync: Doodle Jump
  presents 120/s. At 4x CPU throttle, Calculator taps presented 105 instead
  of 57 frames/s (input-to-present p90 34 to 25 ms), Harmonic scrolling 77
  instead of 53 (p90 39 to 14 ms) and Mihon 81 instead of 59 (p90 90 to 53
  ms). The harness's swipe then stepped every 16 ms, capping View-list
  scrolling near 60/s; it now steps at the display's refresh interval.
  Launch: cold handlers are built when an instruction first runs rather than
  for every instruction at a method's first call, and constant typing runs
  only when a float read can see a constant (a separate first-call scan that
  also skipped the CFG was measured and dropped: it saved no launch time); resource string pools decode on first read and
  every type chunk parses on first lookup; generated bodies compile eagerly.
  Matched first draws fell 5-11% (Mihon 1729 to 1545 ms, Calculator 900 to
  820). A promotion threshold of 8 or 128 calls did not beat 32. ARM32
  regions exited to the interpreter, spilling every core register, for vcmp,
  vmrs, vcvt, core/VFP vmov, vldm/vstm, ldrex/strex, barriers and NEON
  whole-register vld1/vst1; in Cut the Rope these were millions of exits a
  second. They now compile (a Thumb float loop: 1.7 instead of 9.3 ns per
  instruction). ARM64 regions fall back for about 0.03% of Subway Surfers'
  instructions. ARM-mode ldrex/strex only compiled once armMisc stopped
  claiming them first. NEON data processing (integer, bitwise, shifts, f32
  arithmetic and compares, permutes, lane moves, VNMLA/VNMLS) now compiles
  in jitneon.zig: Cut the Rope's integer and matrix loops run at about 0.4
  ns per instruction against 33-44 with the interpreter, the f32 forms
  copying its fp.standard32 input and output steps. The ARM32 test sweep
  compares only v0-v15, since the interpreter uses the upper V registers as
  scratch. Matched against main on one machine, Subway Surfers' age screen
  presented 45 instead of 24 GL frames/s and Cut the Rope 29 instead of 19.
- ARM32 fallbacks in Cut the Rope, 2026-09-27. Thumb-2 modified immediates
  with a replicated pattern (`cmp.w r1, #0x10001`, `mov.w r2, #0x55555555`)
  fell back because the Thumb path re-encoded them as ARM immediates, which
  cannot express them. `jit32thumb.zig` now maps Thumb-2 data processing,
  multiplies, CLZ/REV/RBIT, extensions with rotation, register-controlled
  shifts, ADDW/ADR and LDM/STM to ARM words, carrying ThumbExpandImm's value
  and carry separately; rwThumb reads the same words, so translated forms and
  branches declare their flags precisely while other wide instructions stay
  conservative. B.W, TBB/TBH, LDRD/STRD in every indexing mode, literal
  loads, doubleword exclusives and CLREX, PC-relative VLDR and VMAX/VMIN.F32
  (the first NaN operand's bits, as fp.fmax returns them) also compile. A
  back edge's instruction-limit exit settled flags inside its `if`, which
  the safe build rejected once a compiled compare preceded an unconditional
  branch into a block that ignores them. Over 50 s of level 1 the 400
  hottest fallback sites went from 35.4M to 1.6M exits; guest instructions
  rose from about 334M to 366M a second and GL frames from 34 to 36 a
  second. A loop of these forms runs at 1.0 ns per Thumb instruction (20.7
  before, 14 with every instruction forced to fall back). The gaps left then
  (single-lane VLD1/VST1, reciprocal estimates and steps, pairwise ops,
  halfword multiplies, SSAT/USAT, SXTB16/UXTB16/PKH/ORN, general IT bodies)
  compile since the follow-up below.
- Findings from the 2026-09-27 cleanup, confirmed against OpenJDK/AOSP and
  fixed: ValueRange.of and Period.from(null) threw nothing or the wrong
  type; Math.abs did not wrap at MIN_VALUE; getLocalizedMessage, isDigit,
  DecimalFormat(String, DecimalFormatSymbols), JSONArray.toString(int),
  X509 critical extension OIDs and Array.newInstance of array classes were
  wrong; DataInput/DataOutput UTF used standard rather than modified UTF-8,
  as JNI's string functions did (ART's form: two-byte NUL, a valid surrogate
  pair as one four-byte sequence); Random.nextInt(bound) skewed bounds over
  2^30 because Java's rejection test relies on int overflow, and
  ThreadLocalRandom.nextInt(origin, bound) took a biased modulo. On the UI
  side getColorLong, touch major/minor, Editable.Factory, LengthFilter, Path
  delegate copies, Drawable.setBounds(Rect) and postInvalidate(IIII) now
  follow AOSP, and CharSequence arguments go through csText. Java GLES20
  client arrays leaked a buffer per call and sized int indices as bytes;
  native ES 2/3 gained client vertex arrays and indices, and
  GL_TEXTURE_EXTERNAL_OES and samplerExternalOES read SurfaceTexture's 2D
  storage (Cut the Rope's "OPENGL NATIVE PLUG-IN ERROR" was Unity's video
  player binding that target). Flappy Bird's long-standing page error was an
  AdMob script's uncaught exception escaping its WebView frame; frames now
  report such errors through WebChromeClient.onConsoleMessage. Unit tests
  that parse every module or load full browser bundles exceeded bun's 5 s
  default only under parallel load and now carry explicit timeouts.
  InputFilters and `maxLength` and the external-sampler uniform type were
  resolved in the follow-up below; Cut the Rope's intro video is still black
  (media, not GL).
- Follow-up to the 2026-09-27 findings. ARM32 regions now compile halfword
  multiplies (Q set in CPSR, which spillFlags keeps), SSAT/USAT, PKH,
  SXTB16/UXTB16, ORN (ORR of an inverted operand), NEON lanes, pairwise ops
  and reciprocal steps; VRECPE/VRSQRTE call the core per lane. IT blocks
  compile any body emitThumb compiles without a branch, running 16-bit flag
  setters as their ARM words without S. A leftover wasm stack value only
  fails validation where a block does not end in a branch, which an IT body's
  `if` exposed: compiling all 48,280 IT blocks and 18,846 compilable wide
  instructions from Cut the Rope's libraries against the interpreter found a
  stray push in all-lanes VLD1 and T3 `B.W` bodies that left the block; the
  rest agreed (bodies that increment memory outside the reset region differ
  by construction). Single ARM32 loads skipped the low-address check the
  interpreter and A64 apply, so a null read returned core memory; the check
  costs about 0.07 ns per load in a load-dense loop. The interpreter lacked
  VPADD.I, did not set Q for SMLAW and rounded reciprocal steps in double.
- AnimatedVectorDrawable was a static first frame, so framework spinners were
  a painted substitute. VectorDrawable keeps its named tree (trim paths per
  hwui's first contour, clip paths, caps, joins); AVD targets run animator
  timelines (sets, keyframes, path morphs and path keyframes, colours) at each
  draw, and interpolator XML loads (`PathInterpolator` had been the identity).
  Bitmaps took their density from the path qualifier, which resource
  shrinking removes (NewPipe's `res/RJ.png`), and an unqualified `drawable/`
  PNG is mdpi on Android; densities now come from the table configuration.
  `drawLeadingMargin` takes five ints: the registered spans and the new layout
  call named six, so app spans were missed. Popup and dialog shadows filled at
  `globalAlpha` 0.01, and a canvas shadow takes its opacity from the fill, so
  they drew at 1%. Leaving Cut the Rope during its first boot made later boots
  fail IL2CPP's `Assembly::Load("mscorlib.dll")` until stored files were
  cleared; `PrivateFiles.flush` had committed a spilled file's record before
  its bytes were flushed, the likely cause and now reordered. MediaPlayer
  presents video frames to its display and VideoView exists; frames stop
  while the page is hidden, as `requestVideoFrameCallback` does. General view
  elevation shadows remain unimplemented: goldens here are Material 3 and flat,
  so none calibrates them.
- Native callback allocation pass (2026-10-02). Every JNI `Call<Type>Method`
  previously parked the guest because `invoke` was async, even when Java
  returned synchronously. It now parks only for class initialization or a
  suspended callback; exception conversion, calling-thread identity and
  pinned-array synchronization still enclose the complete invocation. Cpu
  call frames reuse their architectural byte view, allocate stack-argument
  storage only when registers spill, and drain idle waiters only when present.
  Against 304c0529, a Bun scratch probe entering an A64 `CallStaticIntMethod`
  through `Cpu.call` (100k calls/sample, five samples after 10k warmup, loaded
  platform jars) went from median 64.71 to 47.60 ms; guest parks fell from
  100k to zero. This isolates a synchronous callback, not app latency or FPS.
  The 39 CPU/JNI/cache tests passed, including both ABIs, signal ordering,
  floating argument spills, suspended class initialization and callback
  rejection; TypeScript checking passed. The scheduler and JIT architecture
  remain intact: historical native profiles still identify compiled guest
  execution and region transitions as the larger native-game costs.
- Native JIT batches no longer make a JS-owned copy before WebAssembly
  compilation. The [WebAssembly JS API](https://www.w3.org/TR/2026/CRD-wasm-js-api-2-20260224/)
  snapshots the BufferSource synchronously for both `Module` and asynchronous
  `instantiate`, so a view into the emission buffer suffices. This removes one
  allocation and copy of up to 1 MiB per batch; no FPS gain is claimed. Existing
  cache/JIT tests passed, and a scratch Bun probe overwriting the source after
  `instantiate` returned still compiled the original bytes successfully.
- RenderNode allocation pass (2026-10-02). Every ordinary 2D transform update
  built 13 temporary Float64Arrays through general matrix multiplication.
  Scalar composition now writes the node's retained matrix, keeping the
  original arithmetic grouping; 3D and nonfinite inputs retain their existing
  path. Camera3D is allocated on first use. Position listeners retain numeric
  bounds instead of allocating corner arrays and string keys each frame,
  preserving NaN and signed-zero deduplication. Recording contexts consult
  their method cache before reading the native context again.
  Scratch differential probes found no differences across 10k transforms
  (Object.is) or 10k position cases including nonfinite coordinates. Seven
  V8 samples of 100k transform updates measured median 292.8 ms before and
  2.3 ms after; Bun measured 28.3 and 1.51 ms. These isolate allocation and
  arithmetic, not app performance: verified Mihon settings scrolling remained
  equivalent, 69.91 versus 69.66 presentations/s. All 16 graphics tests and
  the existing browser Canvas, render-effect and runtime-shader probes passed.
  A compact display-list rewrite remains unproven: first measure argument-array
  allocation and command distributions. Moving individual Canvas2D commands to
  Wasm would add crossings; a renderer rewrite needs a batched rendering boundary.

- JVM allocation and tiering pass (2026-10-02, base `304c0529`). Short UTF-16
  conversion reuses numeric scratch arrays by length below 128 code units; typed
  reads cannot re-enter Java and the cache retains no caller objects. A V8 probe
  of 40M conversions reduced scavenges from 16,466 to 8,425, with only 0–5% timing
  improvement. Cold-frame pooling was removed after V8 probes slowed by 1.6–2.0x;
  clearing registers and managing pools outweighed fresh allocations. Replacing
  superclass `.call` with `super` was neutral: V8 already inlined the existing
  call shape. Static live-register analysis suggested only 8–15% fewer saved
  slots in the inspected DEX sets, insufficient evidence for an OSR/liveness rewrite.
- Idle code emission previously persisted source for the next launch while this
  launch continued interpreting it. It now binds that same source and retargets
  method cells during idle time; resumable code is prepared only after a cold
  frame actually suspends. Existing suspended frames retain their method state.
  The existing 32 MiB source allowance reserves 8 MiB for demand promotion; idle
  installation cannot disable a method's later demand promotion. The allowance
  accounts for source, not total heap; persisted/worker bodies already follow
  a separate path. A 16 MiB idle limit lost much of the benefit to startup code;
  24 MiB is measured tuning, not a universal optimum. An idle callback still
  cannot preempt one large compilation. The core tier test covers a suspended
  frame crossing installation, source reuse and demand promotion after the idle
  allowance fills. A bulk worker experiment emitting every baseline-profile
  resumable body was removed: Mihon added 44.6 MB to 32.1 MB of entry source,
  retaining unused offered bodies. See [performance boundaries](decisions/0003-performance-boundaries.md)
  for the architecture audit and remaining Wasm/batching experiments.
- Performance capture validation (2026-10-02). The first Mihon scrolling sample
  missed More/Settings during its splash, then reported advancing ticks with no
  presentations on a static library screen. It was discarded. `perf-browser`
  now fails missing setup targets and marks hidden/stalled, incomplete-input or
  zero-presentation interaction windows invalid while preserving their reports.
  Explicit setup readiness produced valid settings scrolls. Never interpret
  shell ticks as FPS or an invalid window as a faster implementation.

- Final performance samples (2026-10-02, `8e00b97d`). The cold latency gate
  passed with per-app maxima of 71 ms (Calculator), 26 ms (FitNotes), 131 ms
  (Mihon); the warm gate passed at 84/28/150 ms. The initial baseline cold gate
  peaked at 97 ms and a later baseline Mihon run at 130 ms. These are individual
  shared-host samples, not evidence of a wall-time speedup. The user explicitly
  approved continuing while another checkout ran browser tests. During a later
  scrolling sample, external parallel Bun workers consumed hundreds of percent
  CPU; no unrelated processes were stopped. Cold-call reductions are clearer:
  final FitNotes repeated date navigation had zero versus 1,666–2,408 baseline;
  Mihon's repeated theme switches had 2,913/2,183 versus 8,448/6,002 in the later
  baseline run (the initial baseline was itself variable at 1,284/5,879).
  Final scrolling samples were valid but noisy: candidate 32.00, baseline 38.58,
  candidate repeat 62.58 presentations/s, following the earlier 69.91/69.66 pair
  before idle installation. All completed 11/11 inputs with visible advancing
  ticks, presentations and healthy process diagnostics. The final repeat retained
  25,573,689 source bytes versus baseline 4,471,890; post-GC heap was 610.5 versus
  617.7 MiB, one sample each. Do not infer a general memory or FPS improvement.
  Reports are under ignored `webdroid-shots/performance/`; reproduce scrolling
  with `perf-browser --flow mihon-app --after settings --exercise
  settings-scroll,settings-scroll-back --interval 1000 --ms 12000
  --setup-min-wait 6500`, alternating immutable revisions on private ports.

  Lichess tools/home interaction likewise completed 11/11 inputs using SwiftShader:
  the earlier baseline was 16.67 presentations/s, final candidate 14.75, following
  baseline repeat 10.25. All three processes answered diagnostics; the existing
  `androidx/window/sidecar/SidecarProvider` missing class was unchanged, with no
  native requirements or runtime errors. This variability does not isolate a
  native FPS gain. Candidate cold calls fell to 470 from the initial baseline's
  4,432, but guest execution remained the dominant cost. The candidate's tools
  screen and Mihon's scrolled settings screen were visually inspected.

- Verification for the performance pass: final typecheck and all 1,183 unit tests
  passed (76,148 assertions). FitNotes (4,213 classes), Mihon (21,918) and Lichess
  (3,300) smoke-compiled with zero method failures; framework checks passed 30/30.
  Both baseline and candidate completed all seven serialized quick flows, 105
  steps each, with every process's diagnostics available and no new missing APIs,
  native requirements or runtime errors. Komikku's 11 existing SQLite diagnostic
  messages were identical. Three Android visual checkpoint scores matched exactly.
  The initial baseline FitNotes PNG caught a spinner despite the same UI tree as
  the candidate's completed workout; repeating baseline FitNotes produced a PNG
  byte-identical to the candidate. Goldens were unchanged. This covers the local
  reproducible lane and the measured Lichess interaction, not the full live/corpus
  matrix or arbitrary APK compatibility. Cold/warm latency gates pass, but the
  shared host prevents a reliable overall FPS conclusion.

- Performance review fixes (2026-10-02, review base `3ad7aa3e`). Deferred emission
  was keyed by DEX/method in the persistence cache, but its closure installed code
  into one Runtime. Two runtimes reaching the same method before idle time left
  the first cold; a source already pending persistence could suppress a later
  instance's installation entirely. `jvm/tiering.ts` now owns per-instance jobs,
  promotion, resumption and retargeting; `jvm/compiler.ts` owns DEX emission and
  drops from 1,007 to 840 lines. One queue handles idle and deferred demand work,
  independently of Cache Storage. Persistence retains DEX-key deduplication and
  first-call phase attribution; a coalesced retry saves bodies emitted after the
  first batch without needing another method call to trigger a write.
  The core tier test drives the real queue across multiple runtimes, pending
  source, suspended frames, late-loaded factories and the idle allowance.
- The old idle resume callback charged emitted source even when `resume()` bound
  a late-loaded factory. Budget accounting now happens only after creating a new
  resumable function, once per instance. Demand-created resume source is counted
  too, but mandatory resumption is never blocked by the allowance. Idle-rejected
  source is not retained for later demand compilation. A separate cache lifecycle
  probe verified startup/later chunks and one delayed save after throttling.
  Pivoted affine composition and its exceptional-value fallback now share the
  matrix module; RenderNode keeps destination ownership and invalidation. The
  existing graphics test compares ordinary, signed-zero, snapped, extreme and
  non-finite values against generic composition and verifies destination reuse.
- Review-fix validation (`4f055580`, `82836a61`): typecheck passed; the standalone
  full suite passed 1,183 tests / 76,265 assertions, and all nine browser probes
  passed separately. An earlier full suite overlapping typecheck failed the
  drawable-span probe with `JThrowable`. The review baseline's overlapping run
  failed that probe and two others with SyntaxErrors, so an identical cause is
  not established; isolated drawable probes passed on both revisions. No test
  expectations or timeouts were relaxed. FitNotes/Mihon/Lichess smoke compilation
  again had zero method failures, and framework checks passed 30/30.
  Cold latency maxima were 82/26/113 ms for Calculator/FitNotes/Mihon; warm maxima
  were 31/24/93 ms, with zero cold calls for every gated warm tap. The review
  baseline's cold maxima were 64/20/106 ms. Demand resume accounting consumes
  previously uncounted capacity, so it can leave less room for idle entry bodies;
  Mihon's repeated cold-launch theme taps made 4,466/3,309 cold calls versus
  2,847/2,108 in that baseline sample. These are qualified shared-host samples,
  not a demonstrated latency or FPS improvement from the review fixes.
  All seven serialized quick flows passed (105 steps, 314 process snapshots),
  with every process returning diagnostics, no new missing APIs/native requirements
  or runtime errors, and no draw/layout/GL errors or wedged/timed-out steps. All
  four visual checkpoint scores exactly matched the pre-fix capture; Komikku's
  existing SQLite messages were unchanged. Goldens remain unchanged. Review logs
  and captures are under ignored `webdroid-shots/performance/review-*`.

- Branch maintainability review (2026-10-02, against `main`, working baseline
  `4123b7b7`). The review began with 576 changed files; the parallel audit concentrated
  on JVM resolution/persistence, native networking and Android service boundaries.
  `DexLink` now owns per-DEX resolution caches with shared prototype methods,
  replacing a duplicate interface and ten closures per DEX. Defining-runtime
  ownership, initialization and tier-retargeting remain unchanged. `runtime.ts`
  falls from 1,321 to 1,218 lines; its coupled class linking/initialization and
  runtime-bound String constructors remain a decomposition concern, not an
  unconditional approval of the file's size.
- Network address parsing, resolution, interfaces and constants now have one
  owner, `native/net-address.ts`, which both the socket core and netd adapter use.
  This removes the direct `net.ts`/`unix.ts` cycle and brings `net.ts` from 1,088
  to 997 lines. The two sockaddr serializers were left separate because their
  behavior differs for non-IPv4 inputs. Android account, widget and notification
  code uses the canonical declared-field helpers; notification ordering reuses
  Java's string hash. The vsync receiver Set is now its sole scheduling state,
  eliminating the mirrored boolean. Widget provider metadata parsing remains
  outside the existing device-service tests' exercised paths.
- Two correctness findings were fixed at their shared owners. System property
  lookup used an ordinary object, so `toString` fabricated a value, `constructor`
  returned an object and `__proto__` threw. A Map now represents exactly the
  configured properties; one Java-facing regression test covers absent names.
  Code-cache saves cleared pending source before asynchronous storage succeeded.
  They now retain a snapshot until all writes succeed and remove only its matching
  entries, preserving concurrent additions and failed writes for the existing
  save triggers. A temporary failure-injection probe reproduced the starting
  revision's loss and verified open/put failure, recovery and concurrent additions;
  no retry loop was added. The probe is saved with the ignored review artifacts.
- Review validation: typecheck, 30 framework checks, and FitNotes/Mihon smoke
  compilation passed (4,213/21,918 classes, zero method failures). The final
  uninstrumented suite passed 1,184 tests / 76,274 assertions; the clean starting
  revision passed 1,183 / 76,265. An earlier candidate run failed five concurrent
  browser probes with SyntaxErrors. Instrumented repeats received byte-identical
  bundles and passed, as did isolated browser runs. The original failure's cause
  remains unisolated; a matching baseline failure was not reproduced, and the
  harness, timeouts and expectations were not changed.
- The first serialized quick matrix reached 6/7 flows: Mihon onboarding parked
  during Java main-queue dispatch with no reported exception or missing/native
  requirement. Vsync had posted and host ticks advanced, but queued Java messages
  stopped draining. A matched starting-revision onboarding run passed, followed
  by a candidate repeat with a byte-identical checkpoint PNG. The second complete
  serialized matrix passed all 7 flows / 105 steps: 311 process snapshots answered,
  every step rendered, shell ticks advanced, and no missing APIs, native requirements,
  layout/draw/GL errors, timeouts or wedges were observed. Komikku retained its
  11 configured expected SQLite diagnostics. The first wedge remains an unisolated
  intermittent failure; neither the passing repeat nor the baseline pass explains
  its cause. Goldens are unchanged. Captures and logs live under ignored
  `webdroid-shots/quality-review/`; the full live/corpus matrix was not rerun.
- Cold and warm latency gates passed. Per-app maxima for Calculator/FitNotes/Mihon
  were 40/24/146 ms cold and 61/23/97 ms warm. Mihon's cold sample has little
  margin against 150 ms. These are gate samples without a matched performance
  baseline, not evidence of a general speedup or FPS gain.

- Branch quality follow-up (2026-10-02, against `main`, working baseline
  `6a7f1920`). The parallel review concentrated on JVM ownership and initialization,
  Android resource selection, native descriptors/syscalls and the shell boundary.
  Unsafe and VM array allocation/process configuration now live outside reflection;
  Class descriptors have one owner beside `JClass`, and the two Unsafe registrations
  share their read-modify-write implementations. `jreflect.ts` drops from 1,365 to
  1,022 lines. An accessor cache keyed only by a native JS property reused integer
  accessors for floating fields with that property: `getInt` returned 1.5 instead
  of its IEEE bits, 1069547520. The key now includes the JVM descriptor, with one
  core regression covering integer/float and long/double access.
- Class initialization's timeout escape was unreachable: same-thread requests
  returned before the only call that could enable its timer, and the other caller
  always disabled it. The timer, fallback state and associated branches are gone;
  the original success/error Promise chain retains its settlement timing.
  `runtime.ts` falls from 1,218 to 1,199 lines, but remains above main's 955 lines.
  Native member installation and String-constructor bridging remain concrete
  decomposition candidates; this pass does not waive that ownership concern.
- Resource selection generations now belong to each `Resources`, preventing a new
  unrelated AssetManager from flushing every theme's resolved values. The existing
  resource test reproduced that unnecessary invalidation and now checks both cache
  isolation and reselection after an owning-resource change. `NativeTheme` requires
  its resource owner at construction and no longer masquerades as a Java object.
  Global qualifier changes still invalidate registered resources; configured native
  managers, theme copying and rebasing retain their explicit invalidation paths.
- Native descriptors now read append/nonblocking behavior from `statusFlags`,
  removing mirrored booleans and their synchronization at creation, accept and
  `fcntl`. A temporary probe exercised append, positional writes, duplicated
  descriptors, pipes and Unix sockets on both ABIs. The ARM64 `rt_sigtimedwait`
  adapter separately consumed a non-null output pointer twice, shifting its
  timeout to the sigset-size argument and faulting at address 0x8. It now reads
  that virtual pointer once; one core test covers immediate/delayed siginfo and
  zero-timeout delivery. No app-specific behavior or visual goldens changed.
- Integrated validation: full typecheck passed; the standalone suite passed all
  1,186 tests / 76,293 assertions, including browser probes. The descriptor audit
  retained its checked-in 29 mismatches in nine classes. Framework checks passed
  30/30, and FitNotes/Mihon smoke compilation passed with 4,213/21,918 classes and
  zero method failures. The serialized quick matrix passed all seven flows and
  105 steps. All 313 process snapshots supplied diagnostics, every step had a
  presented frame and shell ticks advanced in each flow. There were no new missing
  APIs, native requirements, layout/draw/GL errors, wedges or timeouts; Komikku
  retained its 11 configured expected SQLite messages. The four visual checkpoints
  passed their existing limits. No matched visual/performance baseline or full
  live/corpus matrix was run, so these results establish the tested paths only.
  Logs and diagnostic summaries are in ignored
  `webdroid-shots/quality-review-followup/`; step captures are in
  `tests/e2e/actual-fast/`. The broad optional descriptor-state model and native
  `setsockopt` suppressing unsupported-option errors remain review concerns; the
  latter inherits main's success behavior and was not changed speculatively.
- Cold and warm latency gates passed, with Calculator/FitNotes/Mihon maxima
  of 72/38/142 ms cold and 43/43/97 ms warm. Mihon
  retains limited cold margin against 150 ms. These are individual gate samples,
  not evidence of an overall speedup or FPS improvement.
- Deslop follow-up (2026-10-02, baseline `18251cfa`): removed redundant VM prose,
  casts and socket-to-descriptor forwarding; reused declared-field helpers and
  V8's profile types without intended behavior changes. Typecheck and the normal
  full suite passed (1,186 tests / 76,293 assertions); profile summaries matched
  the original in full, time-cut and tap-window modes. No tests were added.
  The combined Android content/device-services invocation failed `databaseList`
  on both revisions after sharing package state; both suites passed separately.
  Logs are in ignored `webdroid-shots/deslop/`.
- Performance survey (2026-10-03, `knlnks/bytecode-claude-performance`, base `30915b39`;
  [performance plan](performance-plan.md)). Mihon's warm theme taps (92–158 ms) are cold-tier
  execution and compilation (50–60 ms of a 158 ms tap with 2.4–3.3k cold calls), whole-Scaffold
  recomposition and background coroutine threads taking `MessageChannel` turns; steady scrolling
  presents at p50 9.4 ms even at 4x throttle, with p99 75–200 ms from single 100 ms tasks.
  The first RuntimeShader draw resized the shared WebGL surface from 1x1, a 150–300 ms stall per
  launch; V8 profiles attributed it to `atLeast`'s width checks, and only in-page timing found the
  resize. Persisted-code saves concatenated and encoded the whole store in one task (~245 ms at
  4x throttle mid-scroll); they now encode Blob parts in idle slices. Rejected: ending the main
  looper's turn while a composite is pending left the composite lag unchanged (p90 ~11 ms on Mihon
  taps), so that lag comes from inside the drawing message. Arrays hashed to 1 and `a.equals(a)` was
  false on array-typed receivers.
- Suspension by throwing (2026-10-03, `2a0198e1`). Compiled code calls a method's Java-ABI name
  (`x` + mangled), whose function throws `SUSPENDED` instead of returning a Promise; the public
  mangled name keeps the Promise protocol for host code through an adapter. Pitfalls found on the
  way: adapters made by `new Function` must be strict, or a string receiver is boxed and
  `"a".equals("a")` is false; JavaScriptCore elides frames for calls in tail position, and Bun keeps
  about ten frames of a stack, so an extra non-tail frame per cold call pushed
  `VMStack.getStackClass1`'s caller out of the trace (the cold entry now throws from `step`, keeping
  its calls in tail position); a suspension thrown inside the cold runner's instruction `try` was
  taken for a callee's and registered the frame twice; a second property per method on a fresh
  prototype doubled link-time stores (~60 ms of a 1.8 s Calculator launch) until prototypes take
  their methods in dictionary mode. Host overrides assigned under the mangled name alone (test
  listeners, Proxy handlers) are skipped by compiled callers; `implement()` installs both names.
  Measured with jbench and alternating `lat` rounds against the previous tip while another checkout
  ran conformance suites on the host (load average 8–15), so frame-rate runs on both trees showed
  occasional 20–50 frames/s windows; those are host contention, not either tree.

## Wasm backend gate results

- G1 (2026-10-04, `5920452f`; node 24 and Chrome 153; shared host, load average 2–4, ±10% per workload;
  js/wasm geometric means over the 42 jbench workloads). Steady state passes (node 1.54–1.76x, Chrome
  1.74–1.90x against the JS tier, up from 0.84x on the first matching set; the 1.3x bar). First call passes
  in node (1.97–2.42x) and fails in Chrome (0.73–0.76x, from 0.25x): small workloads are at JS parity, the
  geomean is dragged by about 12 workloads that run platform or `framework.jar` code outside the AOT set or
  that V8 must validate (a 204 MB framework set also failed to fetch in a Chrome page). "No workload more
  than 10% slower" fails on: `sha256` (the harness runs the JS-form digest because a native cannot await
  `crypto.subtle`; needs S3 suspension), `fbBulk` (no bulk operation between linear memory or a JS buffer
  and a GC `byte[]`; about 0.25 ns per byte per `array.set`; the route is direct buffers in linear memory
  with a native allocator), `strConcat`/`strSubstr`/`strBuild` (a struct plus an `i16` array per String
  against one JS rope or slice; chars sharing reaches about 0.8x at best), `bbInts`, `ecdsaVerify`, `fbLoop`.
  The decision: the design stands (Wasm GC beats JS 1.5–2.4x on allocation-heavy code, so the linear-memory
  trigger G8 is not met), G1 stays open for the listed workloads and for Chrome first call, and each is
  carried into S2 as a named defect: direct buffers in linear memory, framework chunks in the AOT set
  sized below Chrome's fetch and 8 MiB synchronous-compile limits, and sha256 under S3.
- Stack-class lookups (`Reflection.getCallerClass`) read V8's wasm frames, so the harnesses run under node;
  JavaScriptCore names none. A module streamed with `compileStreaming` names its frames by URL, which broke
  that lookup in Chrome (it looked like a builtins mismatch); `aotstore` streams again with the frames fixed.
- The wasm gate work found and fixed production-tier bugs: handler register typing in `prepared.ts` (an int
  constant assigned after the last throwing instruction was typed float, so `l >>>= 32` shifted by 0), and
  pinned JS-tier divergences from Java: no `ArrayStoreException`, the most-specific default method, default
  interfaces not initialised with the implementor, `Field` type/receiver/final checks and widening,
  `String.startsWith(prefix, offset)` / `lastIndexOf(s, negative)` and null arguments.

- B3 (2026-10-04, `knlnks/wasm-tb3`; plan 4.15). Failure mechanism: the Wasm tier made every `VMRuntime.addressOf` byte[] a table entry and map key for good, and a direct buffer's address
  (bit 50 plus a table index) was meaningless to native code and to the production natives (`FileChannel`, `Memory.memmove` between buffers). Direct buffers now live in the core's memory.
  JNI weak globals were strong globals; they are `WeakRef`s now. Evidence limits: the G1 rows were measured at load 11 to 20; a native that makes its own JNI calls was tested on the JS tier only.

- X1 (2026-10-05, `knlnks/wasm-x1`; plan 4.18). Failure mechanisms of a Wasm-tier launch (warm FitNotes, 3.5 s at `d0c9a31b`): the saved app build covered the likely methods only, so a launch compiled 829 app methods, 733 synthetic
  functions and 1,365 class modules on demand, and 27 platform methods that the app's classes undo (installProvider: 98 ms, most of it the one-time class-hierarchy index); loading a platform module made a record (and built the member
  list) of every class it names and built the members of every class in it; `hostObject` made a new `fieldReader` module on every call (1,151); the streaming compile of 130 MB held the main thread for 450 ms; one static initializer
  with a long array literal (ICU `LocaleIDs`) was 140 ms of lazy Liftoff compile. Decision: the build holds what a launch built on demand (the next launch compiles 23 methods, 6 ms), a platform build ships the builds of the apps it was
  profiled with, and the boot image (G6) is not built: of the zygote's 453 ms from the World to `startZygote`, 12 ms are Java (wasm self time), 172 ms module loading; of the 845 ms after it, 141 ms are Java; the page's Java heap at the
  first frame is 140,139 objects (20.7 MB), so a loader would be fast and would save at most 8%, because the statics live in the globals of D modules that the loader must instantiate anyway. Results: warm 3.53 -> 1.74 to 1.87 s,
  cold 4.06 -> 2.15 to 2.55 s with a shipped build (2.9 to 3.0 s without), against 1.27 and 1.70 s on the JS tier. Evidence limits: loaded shared host (load 4 to 9), headless Chrome with swiftshader, two builds alternated on two ports;
  only 8.4% of the methods in the platform code modules a launch loads run before the first frame (a method-level split would cut the fetched code to a tenth, not built: it is X2's chunking); Mihon still does not present
  (`Bridge.shellOf` over a dex interface); the shipped builds exist for FitNotes, Calculator M and the framework's processes only.

- Crash recovery (2026-10-05, base `1d7fdeea`): the main worktree was clean; Y1's uncommitted stabilization changes and Y2's commits through `47059fe3` survived. Fresh typecheck passed. The first full test run had 1166 pass and three browser fixture bundle syntax errors (`Unexpected token var`, invalid token, unexpected end); the browser file alone passed 9/9 and a second full run passed 1169/1169. The transient failure is unresolved and is not a regression waiver. Gate status was reconciled with section 6 of the Wasm plan: G1/G2/G3/G4/G5 still need final evidence, G6 is a measured alternative decision, and S5/S6 remain unfinished.
- AOT source invalidation: `host/natives.ts` emits Wasm import signatures and native-call wrappers but was absent from the source key and server freshness scan. A suspension ABI change could therefore reuse platform and persisted app modules generated for a different ABI. Source tracking now includes all Wasm layers and the build emitter, with one canonical path list shared by the hash and freshness check. Per-file path/mtime/size replaces the maximum mtime, which missed deletion or edits to files below the newest timestamp. A temporary host source addition changed the key and caused the same-process manifest handler to reject the old build (404); removal restored the key and acceptance (200). Existing generated assets need rebuilding.
- AOT validation during recovery: removed the retry path that omitted functions V8 rejected and published a build relying on the same compiler to fail later at runtime. Invalid code now aborts the build with the module and function identity. The eight-jar build validated 290,828 emitted methods without omissions; `wasm aottest` passed over a fresh four-jar build, and `wasm diff` matched 1105/1105 cases across 75 methods. A fault-injection probe changed the first emitted function's opcode to `0xff`: the build failed on `java/lang/Object.<init>()V` after one emission, without retry. Typecheck passed; generated assets and temporary probes are not committed.
- Optional app bundles: each unprofiled APK/process probed `app.<key>.json`, producing browser 404 errors during otherwise completed FitNotes checkpoints. Platform builds now ship an explicit `apps.json` catalog; profiling adds exported bundle keys to it, and each realm loads it once before fetching a listed bundle. This works with static hosting and preserves local compilation for unlisted APKs. Typecheck and a present/absent bundle probe passed; a rebuilt eight-jar platform removed all three bundle 404s from the 39-step FitNotes run. That run still failed on the separately tracked microG `HashMap.putVal` stack overflow; browser parity remains open.
- AOT host contracts: method-name keys alone miss changes to host superclasses, interfaces, fields, initialization policy and suspension metadata. These registrations and their dependencies live throughout `src/`, outside the Wasm host. The source digest and freshness scan now conservatively track all production TypeScript sources, excluding tests and generated core blobs. A native-source addition changed the digest and removal restored it; `src/natives.ts`, graphics registrations and framework provenance are included. This may rebuild AOT after a source edit that leaves the ABI unchanged, but cannot silently retain an incompatible class layout under the old key.
- Recovered Y1 stabilization (`7180a2e0`, `e54eb853`, `2da60a28`, `ef280666`): suspended native array results and argument copies now travel through private per-call tokens; resumed Wasm writes scratch and restores it before checking exceptional results. Loop fuel covers all back edges, including arithmetic loops, mutable bounds and overflowing increments; removed the unsafe finite-loop exemption. A compiler stack overflow no longer installs a permanent missing-method body. App/worker DEX order and host overlays agree from startup. Agent checks passed: 1169 tests, threads 67/67, differential 1105/1105, custom 375/375, unresolved references 19/19, strict AOT and aottest; final scratch follow-up passed substrate 22/22. Parent typecheck and lazy linking/invalidation checks passed after merge. G4 loop continuation and browser parity remain open.
- TestNG coverage recovery (`1ea1bac7`, `c664d867`): Android preserves `GenericArrayTypeImpl` for array type arguments, while TestNG 7.4 casts its iterator element type to `Class`. The runner adapts only default local zero-argument array providers to TestNG's raw-iterator row path, preserving unchanged provider bytecode, reflected types, expected exceptions and failures. Targeted classes recover 6,123 executions and pass 8,065 cases without skips; remove the evidenced cast pin. The shared suite preparer invalidates runner caches by source content, removes stale inner classes and publishes new DEX files after successful D8. Parent runner regression confirms generic array types and deliberate row/provider failures on JDK and Wasm. The serial recovery cut and its coverage limits are recorded below; final integrated browser acceptance remains open.
- Browser stabilization after recovery: the subtype lists beneath `Object` exceed the argument-spread limit on a deep compiler stack. Both CHA traversals now push children individually. With Y1 merged, fresh AOT assets and a restarted dev server, FitNotes passes 39 checkpoints and Calculator M passes eight (47 total, two Android-compared flows, no browser errors or observed gaps). FitNotes launch confirms 188 AOT modules loaded. Earlier captures against a server retaining the old source-key function rejected the rebuilt manifest and ran without AOT; those are not final gate evidence. Timing under concurrent diagnostics is not a performance result.
- DEX ordering: lexical sorting put `classes10.dex` before `classes2.dex`, and renamed split entries (`classes1000.dex`) before base secondary DEX files. Archive insertion order was also affected by asynchronous inflation. One numeric ordering helper now serves app startup, JS compile-ahead, framework jars, Wasm class-loader archives and command-line readers, following ART's numeric multidex sequence ([DexFileLoader](https://android.googlesource.com/platform/art/+/66166d566ef09982c23d95d185bf8276dee96676/libdexfile/dex/dex_file_loader.cc)). A shuffled APK containing conflicting existing loader fixtures executes the `classes2.dex` implementation; the same executed check fails with the former lexical order. Loader checks and typecheck pass.


- Y2 recovery (2026-10-05, `knlnks/wasm-y2`, starting `47059fe3`, original base `1d7fdeea`). Retained the existing generic fixes after inspection: `8a046d34` tests SurfaceTexture by Java class before reading its host state; `a5749f0e` creates a concrete shell for an abstract host class before CHA chooses implementations and replaces the two Object-subtype argument spreads with loops; `47059fe3` repairs AOT vtables for host-overlaid methods, binds host initializers instead of the platform build's original slots, and lets a nested JNI strand of the initializing Java thread see partially initialized statics. No new changes were made to Y1's `host/natives.ts`, `compiler/method.ts`, or `link/sched.ts`.
  - `02e82805`: an interface host shell was still registered only when its first object crossed the bridge. A method compiled before that crossing could choose the sole bytecode implementor and keep calling it on the host receiver. The new `Hc.faces` differential returned 303 on Wasm against 307 on JS before the fix; registering the concrete interface implementation when the spec is defined restores 307. Files: `src/wasm/link/hostclass.ts`, `scripts/wasm/hostcases.ts`, `tests/fixtures/wasm/java/hc/Hc.java`, `tests/fixtures/wasm/java/hc/stubs/wdtest/Maker.java`.
  - `f07dbca4`: an unshipped optional app bundle generated browser 404 diagnostics even though runtime compilation succeeded. For an existing platform build, its absent `app.<key>.json` now returns 204 with no-cache, which the client interprets as no shipped bundle. Missing modules and unknown platform builds still return 404. Files: `scripts/wasm/aot-serve.ts`, `src/wasm/host/bundle.ts`. This protocol was superseded by main's `d36eb94a` app catalog; `469070a4` removes the temporary 204 handling. Both files now match main, so there is no remaining Y2 delivery change.
  - Main was merged into Y2 at `e10dae6d` (through `8840b332`) and `0cd312b3` (through `b62becb4`, including `829e53af` strict AOT validation). Fresh isolated eight-jar assets validate 290,828 methods; the final catalog build key is recorded in the Y2 subsection of the Wasm plan. Main's `d36eb94a` was merged at `3ee7c299`; `b38825f5` merges through `809ce40d`, including Y1, the all-production-source AOT key (`4d4c64c3`), and parent's isolated CHA fix (`ab42ca02`). The CHA merge uses main's exact version, with no remaining CHA diff. Generated assets are ignored. Hostclass passes 31 cases against JS with lazy linking and with a four-jar AOT build; the initialization race, cycle and failure cases pass 3/3 against the JDK. Typecheck passes. Doodle Jump, Flappy Bird, Komikku and Mihon APK smoke compilation each reports zero method failures. Verification was limited to this slice, not the full core suite.
  - Initial standalone Wasm quick flows (`--jobs 1`, before the final Y1 merge): Doodle Jump 6/6, Flappy Bird 7/7, Komikku 23/23, Mihon onboarding 5/5 pass. Mihon app completes 17 steps but its standalone Appearance checkpoint fails (74.54% against the unchanged 14% limit): the captured screen is Download queue. A fresh build of starting commit `47059fe3`, with matching APK, preferences, geometry, clock and flow, reproduces the same screen and 74.60% diff. In both runs the Appearance/Dark/Light text targets return false; earlier Settings and Reader targets return true. A later sequence at `0cd312b3` passes all five flows, with Appearance at 2.58%; the standalone failure remains an intermittent navigation/target-resolution problem, not explained by the generic EGL/JNI fixes. No direct Unsafe offset fix was added: neither final Mihon flow observes the old accessor error, and that observed-path success does not establish every Unsafe offset works.
  - Every standalone step has process diagnostics with status ok, no new missing APIs or native requirements, no unexpected runtime/browser errors, no wedged main loop or completion timeout, and no error counters. Komikku's declared SQLite messages remain. The eight unique code 28/284 messages, including their `E/SQLiteLog` severity, match the fresh starting `47059fe3` jobs-1 sequence at identical geometry and flow hash; whether that severity matches AOSP is unresolved. Both game motion checkpoints present advancing frames; no idle-host performance claim is made. These three target flows have no Android golden manifests in this repository and are smoke checks; Mihon retains its existing visual references. No flows, thresholds, golden images, APKs or app bytecode were changed.
  - Archived-base diagnostics at `1d7fdeea` use matching inputs and fresh eight-jar assets, with a read-only World handle in the archived host to observe each process. The available app-process snapshots after 45-second observations show no completed presentations or game GL frames (some bounded diagnostics timed out); Komikku records a process failure including an UnsatisfiedLinkError from HashMap.putVal with Maximum call stack size exceeded, and Mihon records AbstractMethodError. These bounded observations are not completed baseline sequences. Direct Object-subtype counts are 42,726 / 42,624 / 58,501 / 55,636 for Doodle Jump / Flappy Bird / Komikku / Mihon. A shallow Chromium worker spread accepts all four counts; the pre-crash compiler-stack argument-limit mechanism has not been isolated in this recovery. The retained CHA mechanism is exactly the two for-loops already in `a5749f0e`; the final file uses parent's equivalent `ab42ca02` version after the overlap was resolved during the merge.
  - Evidence is isolated under `webdroid-shots/y2-recovery/`: `crash-results`, `head-sequence`, `pre-strict-sequence`, `standalone`, `standalone-telemetry.json`, `final-standalone`, `final-sequence`, archived `base` and `start`, matching-start Mihon results, core/build logs, and route status checks. The original base full sequence was interrupted after startup could not progress; it is not counted as a completed test. Only owned servers/captures were stopped. Final sequence results are recorded in the Wasm plan's Y2 subsection.
  - Final merged `b38825f5` sequence passes all five flows: Doodle Jump 6, Flappy Bird 7, Komikku 23, Mihon onboarding 5, Mihon app 17 steps. Mihon storage is 15.36% against 29%, Appearance 2.58% against 14%. Its final standalone app run still fails Appearance at 74.77%, showing Download queue. The restarted server returns HTTP 200 for build `1fabf74bff3914b6`; all five final sequence flows have nonzero AOT loading. Final standalone Doodle Jump 6/6, Flappy Bird 7/7, Komikku 23/23 and Mihon onboarding 5/5 pass. Every final standalone and sequence step has healthy observed process diagnostics, no new missing/native requirements, unexpected errors, error counters, wedging or settle timeout. The detailed outcomes and telemetry are recorded in plan 4.19.

- Compile-worker AOT host vtables (2026-10-05): the recovered full browser matrix exposed missing `g48` mutable globals for TLS classes, although `d48.wasm` exported them. A bounded diagnostic captured `compileOnly: true` and the worker stack `World.link -> repairVtable -> hostFn -> instantiate`. Compile-only AOT class records deliberately have empty exports; host vtable repairs must run only in executing Worlds. The shared repair entry now skips compile-only and build Worlds, covering both initial links and later host overlays. The existing hostclass harness emits and validates HTTP code in a compile-only World and requires zero additional instances. Removing the guard reproduces the exact missing `HttpURLConnection` vtable import; restoring it passes the 31-case hostclass suite against JS with the eight-jar AOT build. Typecheck passes. Temporary diagnostics and manifest metadata were restored; the interrupted full matrix is not an acceptance pass. Broader browser verification remains pending.
- Y2 navigation follow-up (`daf308dd`, 2026-10-05; canonical numeric DEX order merged): delayed browser timers timestamped a synthetic swipe's catch-up positions as though the finger accelerated. Compose then flung Default rotation off screen; no dialog opened, so the flow's two Back actions left Settings and its Appearance fallback hit Download queue. `src/main.ts` now supplies the scheduled sample uptime to `src/shell/device.ts`, which retains its ordinary timestamp default for other callers. A controlled 100 ms delivery stall loses the target before the fix (final intervals 5–7 ms, event duration 509 ms), but opens its dialog after the fix (8–9 ms, exactly 400 ms). A matching fresh baseline passes once on both JS and Wasm, so those passes alone would not establish the fix. Both subsequent unchanged standalone runs pass the retained Appearance golden at 2.58% against 14%. Typecheck and strict 290,828-method AOT validation pass. The final Wasm jobs-1 target sequence passes 5/5 (58 steps), with no observed missing/native requirements, unexpected errors, error counters or semantic tap misses. Detailed results are recorded in plan 4.20; no idle-host performance claim is made.
- SQLite callback ownership: modern Android 15's callback logs primary WARNING as WARN, AUTOINDEX and several primary codes only when verbose, and other errors as ERROR. Komikku's bundled requery `libsqlite3x.so` uses an older callback that emits codes 28/284 as ERROR. Its actual ARM64 registration and callback disassembly prove priority 6 reaches `__android_log_print`; the host preserves it correctly. Changing liblog based on the SQLiteLog tag would silently change unchanged guest behavior and could hide real errors. No such filter or guest callback substitution was added. Primary source links, native addresses/hashes and the full observed severity distinction are recorded in plan 4.20.

- Full-width executable reflection (2026-10-05): `Executable.artMethod` stored the class/index cookie in 64 bits, but annotation, declared-exception and parameter-comparison paths wrapped it to 32 bits before decoding. Reserving class IDs through 65,535 before running the existing `N.members` and `N.annots` fixtures reproduced 80 throwing Wasm cases against successful JDK answers. Those host metadata paths now decode the full cookie and use the existing method-table slot as their 32-bit identifier; method invocation and the stored Java field retain their original representation. The fixed boundary probe passes 80/80; the existing differential gate passes 1,105/1,105 and two retained full-width JDK comparisons, with typecheck clean. No APK-specific mapping or new fixture was added. This proves the class-ID boundary mechanism; its contribution to the earlier TikTok `methodIdx` errors still requires the browser rerun. Before this reflection change, the integrated seven-flow quick gate passed at `5156bed1` using fresh build `a7ba6315d46ccd92`, with four Android-compared and three smoke flows and zero reported gaps; that capture is not verification of the later reflection change.

- Typed loop re-entry integrated from `9abe6438`/`8d7b7e62` (2026-10-05): structured loops use bounded outlined Wasm functions with typed activation state, preserved fuel, nested exits/returns/Java exceptions and Java-frame trace folding. Agent checks include 290,828-method strict AOT, aottest, 1,105 differential cases, 375 custom cases, 19 linkage cases, 69 thread cases (three known JS-oracle differences), nested entries, 14,400 fuzz cases, 1,169 tests and 47 FitNotes/Calculator steps. Shared-load instrumented Chrome first activation approaches repeated-call speed in its 10–20 ms window; G4 remains open without idle confirmation and an engine optimization trace. Code size grew about 17%; tiny-loop overhead was observed, irreducible dispatcher cycles remain unoutlined, and one FitNotes Proxy(Throwable) abort remains unexplained despite later passing captures. The existing persistence harness now exercises the shipped apps catalog instead of rejecting its request.
- Cold CHA scan (2026-10-05): the integrated full browser run at `64622fec` lost TikTok input progress after empty launch/fullscreen UI captures and a browser Error; it was interrupted and is not an acceptance pass. Inspector profiling/pause attempts did not complete on that workload. A bounded V8 engine log captured `reaches -> targets -> resolveCallee -> planDepth` as a leading compiler hot path. Node's processor reported newer V8 code states it does not understand, so this is diagnostic attribution, not an accepted percentage or timing measurement. For unrelated receiver and method-owner hierarchies, reachability now walks the candidate owner's subtype tree and filters by receiver, instead of repeating the receiver's whole tree for every owner. Both enumerate the same concrete intersection and retain override pruning. The merged compiler passes 1,105 differential cases plus two full-width reflection cases, classdiff 33/33 with eight existing JS differences, and typecheck. Browser impact still requires a matching-input rerun.
- Integrated loop/CHA browser attempt (`d3847282`, 2026-10-05): strict eight-jar assets `e67148ff246af268` validate 290,828 methods with five existing gaps; compiled code grows from 179,036 KB to 210,300 KB. The jobs-1 full run aborts TikTok after 30.1 s with a crashed target. A separate bounded launch with Chromium stderr enabled confirms `V8 javascript OOM (MarkCompactCollector: young object promotion failed)`. Its last major collection reports 227.7 MB before and 162.4 MB after, with 283.0 MB capacity; neither retained guest heap growth nor a compiler-worker cause is established. A guest MobMainSessionStartTask NullPointerException precedes the fatal error, but causality is unproven. Subsequent YouTube steps remain black with empty UI. The full attempt was stopped, is incomplete and cannot establish runtime or performance acceptance. Evidence: `/tmp/webdroid-wasm-full-d3847282.log` and `/tmp/webdroid-tiktok-d3847282-crash.log`; matching baseline attribution remains required.
- Deferred main-thread context loader (`8124380a`, 2026-10-05): loader construction can first create the runtime Thread through BlockGuard/ThreadLocal and reenter the unfinished system-loader initializer. The runtime now binds that peer before initialization and completes its pending context assignment only when the actual system loader exists. An explicit Java setter, including null, cancels the assignment. The four affected time classes execute 1,537 passing cases; the complete time suite remains pending. After integrating this fix, exact-name-first outlined-loop trace parsing and archive transport, main passes typecheck, the JDK/Wasm cold startup fixture (including explicit null during initialization, inheritance and defining-loader identity), and the Chromium archive ownership/teardown test. These focused checks do not replace a fresh browser matrix or prove the earlier guest NPE resolved.
- Browser verification after startup/archive integration (`3195bc41`, 2026-10-05): strict assets `a62bd7bd5878d092` validate 290,828 methods with the same five gaps; manifest/index return HTTP 200. An interrupted default five-job quick runner continued through child processes after SIGTERM, overlapping a serial restart. Those artifacts are invalidated; cleanup now verifies owned processes have actually exited. A fresh bounded, isolated FitNotes capture completes 39 steps with no capture or browser errors; it does not score visual checkpoints. Isolated jobs-1 Mihon onboarding completes five captures in 322.2 s but fails all checkpoints, displaying its crash UI with StackOverflowError during MutableObjectIntMap/SnapshotKt/VectorPainter and deep Compose measurement/placement. No stack limit or golden is changed. Evidence: `/tmp/webdroid-wasm-recovery-fitnotes-diagnostic.log`, `/tmp/webdroid-wasm-recovery-mihon-isolated.log` and the corresponding main `actual-fast/` captures. The earlier stalled serial runner was not proven to be executing FitNotes; directory timestamps from overlapping captures were insufficient attribution. Controlled agent TikTok launches also crash without outlining (31.5 s, semi-space-copy OOM) and with outlining (31.7 s, CALL_AND_RETRY_LAST, about 168 MB live), excluding debugger-attached runs with different native stacks. This rules out removing outlining alone as a fix, not other outlining costs or the memory mechanism.
- Y2 S5 archive boundary (`4f090a6f`, 2026-10-05, base main `64622fec`): process bootstrap previously handed out live PackedArchive instances and FileSource read functions. Bootstrap now carries packed index/base descriptors or read-only archive ports. No raw APK bytes are eagerly copied into the bootstrap message. Each returned read buffer is independent and transferred; replacement bootstrap closes the previous owner set, failed handoff closes unpublished exports and retains the old set, and process death closes only that process's exports. A Chromium Worker probe covers both structured-clone and Worker-message transfers, out-of-order reads, source errors, alias protection and teardown. A real broker probe verifies zero eager reads, repeated bootstrap, handoff failure cleanup and separate process ownership.
  - Typecheck and the focused boundary test pass. Strict eight-jar AOT validates 290,828 methods; build `39e336d95afee941` has manifest/index HTTP 200 from a freshly restarted isolated server. Final unchanged Wasm jobs-1 quick sequence passes 7/7, 105 steps (four Android-compared, three smoke), with healthy process diagnostics, nonzero AOT loading and no unexpected errors, missing/native requirements, error counters, semantic misses, wedging or timeouts. Komikku retains its declared guest SQLite messages. Evidence: `webdroid-shots/y2-s5/quick/summary.json`, per-flow runs, `telemetry.json`, test/typecheck/build logs and manifest. The earlier draft capture is superseded by the final-source capture. The owned server is stopped; no main merge or performance claim.
  - This does not enable JVM process Workers. The current iframe loader still materializes unpacked registry APKs; narrow foreign-package metadata loading or measure it before Worker enablement. Endpoint RPC, canonical mutable stores and SQLite connection/transaction semantics, controlled clocks, Worker-local immutable caches and eventual window/WebView presentation remain required. The minimal order and open full-e2e/corpus/WebView/presentation gates are recorded in plan 4.21; Firefox is not required for this task.

- Canonical thread-loader startup (`4a040a08`, integrated as `8124380a`): a cold system-loader initializer reaches `Thread.currentThread` through `DexPathList`, filesystem initialization and `BlockGuard`. The lazily created peer previously retained the real partial null loader. ART assigns the main peer context after system-loader creation; the Wasm scheduler now completes that pending assignment after the holder initializer succeeds, before waking waiters. The real Java setter cancels the pending assignment, including explicit null; defining-loader identity and recursive/concurrent initialization stay intact. The four affected TestNG classes recover 1,537 raw executions (1,536 baseline names), all passing without skips. The real JDK/cold-Wasm fixture passes 16 checks across ordinary startup and cancellation during startup. Typecheck, classdiff 33/33, customdiff 375/375, loader checks and three initialization race/cycle/failure checks pass. A separate bounded diagnostic builds the same fixture through the real app AOT emitter and executes it in a fresh World: four checks pass, `threadLoaderReady` is present and installed from the synthetic module. This rules out a direct recursion in that hook on this source cut; it does not reproduce Mihon's reported browser overflow or validate newer integrated browser source.
- Class setup coverage accounting: the previous pin matcher could propagate the first failure reason whenever every emitted result failed. Only an explicit class failure or a solitary JUnit validation result now supplies a class-wide reason. A class setup failure with baseline passing names fails coverage even when both tiers lose those names. The existing IO private-suite pin permits only the exact single “No runnable methods” validation result. Original `OutputStreamTesterTest` and `WriterTesterTest` have private `suite()` methods; real JDK reflection hides them and produces the same validation failure as Wasm. Their 59 + 65 missing baseline names remain a documented 124-case execution gap; current JS incorrectly exposes the private suites. Pins and baseline files are unchanged. Negative checks and a replay injecting a new setup failure into both tiers fail the comparator with one regression for 65 lost rows rather than accepting common drift.
- Nine-suite serial recovery cut: 976 classes emit output on both tiers; 410,870 raw passing records, 599 raw failure records and zero skips (411,461 ordinary case outcomes: 410,870 pass / 591 fail, plus eight class setup/synthetic validation failures), with zero regressions, zero unexplained differences and 3,009 pinned divergences. Successful full time is 30,819/6/0; its original failed capture is excluded. Guava/JSR166 ran at `c664d867`, util/IO at `3c6da02a`, successful time/nio/nio-file/net/security at `4a040a08`; no later main, G4 continuation, final S4/S5 or parent reflection-cookie repair is included. The 124 IO baseline names remain absent under the verified private-suite mechanism; ten time hashes are reconstructed date/set-order name changes, not executed baseline names. Existing resource, charset, network, filesystem and synthetic runner failures remain reported. All nine saved outputs also pass the tightened coverage comparator with unchanged pin counts; two focused guard tests (15 assertions) and typecheck pass. Aggregate: `conform-cache/g2-full-loader-fix/final-results.json`; raw tier output and logs: that directory for the successful time rerun, `conform-cache/g2-full-c664d867-local` for the other suites. Pins and baselines are unchanged. Both owned serial drivers have completed. Final integrated browser correctness remains open; Mihon's separately reproduced Compose stack overflow is not attributed to the canonical loader fix, and no idle-host performance claim is made.

- Y1 heap diagnosis (2026-10-05, fixed control source `c433e92f`): TikTok boot completed and then V8 failed both with the pre-G4 method emitter (31.5 seconds, `Scavenger: semi-space copy`) and with outlining (31.7 seconds, `CALL_AND_RETRY_LAST`, last-resort GC approximately 168 MB live). Both controls used fresh strict eight-jar AOT assets, HTTP 200 manifests, isolated port 4197 and no worker debugger attachment. Thus removing G4 alone does not remove this OOM on that base. Earlier CDP-attached workers crashed during startup with a different native stack; those probes are excluded from this comparison. Shared load makes elapsed times diagnostic, not performance evidence. The failed isolate has not been identified from its GC clock or thread name.
  - Page allocation sampling identified AOT assumption validation (`World.holds` -> `Program.implFor`) materializing every field and method of candidate app classes. A missing declared-method lookup now scans the class data without retaining its full member model; matching methods retain canonical identities and indices when full members are later requested. An existing class differential harness checks that identity across materialization. No World, scheduler, cold interpreter, heap limit or app behavior is changed.
  - Separate Node 24 processes, explicit GC, unchanged TikTok/platform DEX and three inherited-method queries across 424,851 concrete app classes: baseline live heap 218,776,528 bytes before and 1,937,479,624 after; changed 222,930,792 before and 571,247,952 after. Both returned 1,274,544 implementations. This isolates approximately 1.37 GB of avoided retained metadata; it is not a whole-app memory or latency gate, and RSS did not decrease. Checks: TypeScript, class differential 33/33 (eight existing JS-tier divergences), identity boundary 1/1, loaders, link differential 19/19, core differential 1105/1105 plus two full-width reflection cases, and strict full-platform AOT validation 290,828 methods (five existing build gaps). Browser OOM closure, isolate attribution and G4 performance acceptance remain open. Evidence is under the Y1 checkout's `tests/e2e/actual/y1-recovery/g4-{crash,metadata}-*` outputs.

- Y1 G4 layout regression (2026-10-05): matched Mihon onboarding on runtime `4d6b897d` plus member-retention fix `05d2a242`, port 4197, fresh strict eight-jar AOT, unchanged 720x1280@320 flow and its existing pinned clock. Original outlined emitter: first draw enters CrashActivity with Java StackOverflowError through Compose measure/layout; five captured steps remain wedged, two browser errors. Replacing only `compiler/method.ts` with `5156bed1` passes all five checkpoints (21.0 seconds). Active-frame accounting with outlining retained passes all five (22.6 seconds), no process errors/missing/native requirements or browser errors, completed rendering and advancing ticks. These elapsed times are diagnostics under concurrent load, not G1/G3/G4 performance acceptance.
  - Cause: method entry reserved the largest possible nested chunk stack for the entire Java activation, including inactive loops. Each method now charges its own frame; a chunk call charges its dispatcher and chunk only while both are active, restoring the caller depth before status handling, Java returns or exception propagation. Nested calls charge separately. MAX_DEPTH, fuel, chunk sizes and Java bytecode are unchanged. Existing nested try/monitor/typed-state and trace cases exercise the continuation paths; stack-overflow controls still catch Java errors on plain and suspended entries (5,599/5,090 light frames and 1,057 heavy frames in this diagnostic).
  - Asset epochs: original outline `c78a143936282ec6` / source `72e3fb232f36e45d999621db1a7891fe6d165994351554e4c0a8fd01cca3310f`; no-outline `f701de86c29ca6e5` / `1984d198871725cf13e96542b6412af9d955f3dc92c42b27a4458a81a5bf7f41`; active accounting `993532c21e16c061` / `013746baeb9cfd71611dc13af75af7ad71ec4dbcfddd4ac29021aa92cf6bbbb2`. Each was served after restarting the owned server with an HTTP 200 current manifest. An earlier original-outline browser target crash before checkpoints is excluded from the guest-SOE comparison.
  - Checks: TypeScript, differential 1105/1105 plus two wide reflection cases, nested native entries, full threads 72/72 (existing JS-tier stack-overflow divergences explicitly reported), focused loop state/trace/overflow/substrate 28/28, and strict platform validation 290,828 methods with five existing gaps. FitNotes 39 checkpoints pass (24.3 diagnostic seconds). Evidence: Y1 `tests/e2e/actual/y1-recovery/g4-mihon-fixed-{outline,nooutline}*` and `g4-active-depth-*`, including separate run.json captures. The JS fuel comparison appeared stalled but completed; it is not an excluded check.
  - Limits remain: idle engine tier-up proof within 100 ms, irreducible-loop continuation coverage, all-local continuation allocation/code growth and G1/G3 tradeoffs, unresolved prior FitNotes Proxy abort, and native TikTok OOM isolate attribution. This patch fixes the matched layout regression, not those gates. On the newer runtime, both member-retention control and changed browser probes also survived approximately 120 diagnostic seconds; that does not establish the member fix alone closes native OOM.

- Cold Wasm interpreter integration (2026-10-05, base `3195bc41`): a shared GC opcode loop executes decoded numeric/control DEX data, retaining raw numeric bits, references, register kinds and precise instruction cursors across bounded slices and snapshot transfers. Opt-in `WorldOptions.cold` installs typed method-table adapters; call and back-edge counts promote subsequent calls through the existing compiler. Shared-module instantiation uses World accounting. Unsupported bodies, exception tables and synchronized methods compile before execution; production defaults remain unchanged.
  - `scripts/wasm/cold.ts` checks 1,290 unchanged DEX cases against JS and JDK at instruction budgets 1/7/4096, plus injected state, reference retention, typed equality, raw floating bits, unsupported-body rejection and promotion. Real World entries exercised 16 interpreted methods and 431 calls. Full typecheck passes. These checks establish numeric/control semantics, not performance or S4 acceptance: object/field/array/invoke/monitor operations, Java exception dispatch and active-frame deoptimization/promotion remain open.

- Active-frame CHA dispatch (2026-10-05): invalidating a method-table entry after loading an override cannot change a direct call in an already running module. A native callback loading a subclass and returning its receiver reproduced the wrong implementation (1 instead of 2) in the existing lazy linker fixture. Monomorphic calls now test the receiver's actual method slot before taking the direct path, with the existing indirect fallback and depth accounting. The fixture passes after the fix; Node differential passes 1,105/1,105 plus two full-width reflection cases, class differential 33/33, lazy linker checks and full typecheck pass. The tier test checks the specific method's upgrade eligibility rather than a global counter that can also include newly warmed callees. Performance impact remains to be measured on the idle integrated source; this is not a Mihon attribution or complete deoptimization implementation.
  - Guards now require an actual direct function in the compilation unit. AOT and other indirect sites read the receiver's slot once and count depth at the plain call site. Polymorphic candidates use the same direct-function predicate. This retains the active-frame regression check and reduces platform C bodies from 234,040 to 219,463 KB, with 290,828 methods validating in both builds. Differential 1,105 + two reflection cases, lazy linker checks and typecheck pass. Build size is measured; browser latency and the remaining Komikku overflow are not settled by it.

- Integrated browser cut `7e19d749` (AOT `23be3c68f76eaae6`, source `b7eb0e58db0ed76a50f38f03011ead2189e437c42f50ca99b007f3e90135787f`): jobs-1 quick completes Mihon onboarding's five captures, then stops advancing after Komikku Browse. The renderer's native sample reports 9.8 GB physical footprint, 11.1 GB peak, with opaque Chrome export symbols; those names do not identify a JavaScript isolate or allocation mechanism. The interrupted run is not a seven-flow acceptance pass. Owned browser/CLI processes were killed and verified absent before standalone probes.
  - Bounded standalone probes reproduce the guest death at Local source. Diagnostic bundle logging identifies `RuntimeInit$KillApplicationHandler.uncaughtException` through Crashlytics/global handlers, then `Process.killProcess`/SIGKILL. The native crash-report delegate receives `java.lang.StackOverflowError`, null message/file and line 1. New process launches create new compiler-worker pairs. This is an uncaught Java failure, not permission to suppress process death. Logging uses routed diagnostic bundles, excluded from acceptance/performance. The full throwable stack and matching source attribution remain open. Parent logs are `/tmp/webdroid-komikku-c30593ac-{workers,exit-reload,report}.log`; the interrupted artifacts and native sample are retained under `tests/e2e/actual/parent-recovery-c30593ac`.

- Y2 process compiler teardown (2026-10-05, parent base `c30593ac`): `AppCode.close` stopped only its builder port. Its refinement timer, pending build promise and second-tier CompileClient survived; boot never invoked that close on process death/unload. `CompileClient.close` already existed but left queued initialization payloads and its World reference resident. `boot.install` also registered an anonymous usage callback in the page-owned FetchStore.worlds Set without removing it, retaining a dead realm's World/Program.
  - AppCode now closes both owning compiler clients, clears its one refinement timer and rejects pending builds. Closed owners ignore late replies and cannot restart workers. An AbortSignal bounds preparation across asynchronous metadata loading and reentrant worker creation; a worker returned after death is terminated immediately. Ordinary builder retirement still permits a later explicit refinement. Boot calls cleanup on process exit/pagehide and removes the exact usage callback it registered. This changes no guest exit status or JVM death semantics. Persistence already initiated before close can finish; late completion cannot resolve another request or restart the owner.
  - Focused AppCode core contracts cover idempotent close, watch cancellation, pending rejection, late reply/start/refine behavior and death reentering worker creation: 2/2 pass. Full typecheck passes; restricted World/scheduler/compiler-method owners are untouched. Evidence: `webdroid-shots/y2-s5-endpoint/teardown-test.log`, `teardown-full-typecheck.log`. No post-change browser/AOT gate is claimed. The preceding endpoint candidate's strict AOT build validated 290,828 methods and served manifest/index 200; its isolated Wasm quick passed Doodle Jump 6/6, but Komikku required browser termination after 195 seconds (partial artifacts through Manga), and the remaining capture was stopped before source edits. Parent independently observed a signal-9 guest death after Browse on the matching base. These are unresolved current browser causes, not regression waivers or proof that teardown fixes the kill; no memory or speed improvement is claimed.

- Active-frame dispatch tier coverage (2026-10-05): the existing native-loaded override fixture now exercises both an initial method and the same method promoted to a unit with direct callees before the callback loads the overriding subclass. Both ongoing activations return the new implementation. The warmed check verifies the method's actual table entry changed before loading. The lazy linker harness, including exception and Java-frame checks, passes; no production behavior changes in this check.

- Komikku outlining control (2026-10-05, production source `6faa0c2b`, strict eight-jar AOT `7ba30d7391162d64`): unchanged flow/APK/geometry/settings on port 4119. The outlined app emitter reproduces guest death after Browse. Routed diagnostic bundles disabling app MC outlining in both the process and compile worker, while retaining the identical outlined platform build, complete all 23 steps with capture errors empty. The existing SQLite native messages remain; no golden or guest code changed. The initial 45-second no-outline probe stopped before Browse and is not a pass; the subsequent 120-second control completed.
  - Routed Error.stackTraceLimit=4096 and World.boundary logging identify a synthesized Java StackOverflowError without observed engine RangeError. Its raw stack contains 387 Wasm frames, including 166 reportGroup roots and 162 reportGroup#loop359 frames; the Java trace has 166 recursive reportGroup frames. Current chunks declare the full method local layout, even when they use a subset. This is a hypothesis for the frame cost regression, not yet a fix. The quota is unchanged. Diagnostic logs/scripts and DEX disassembly are retained under `tests/e2e/actual/parent-recovery-6faa0c2b`; sequential default artifacts were overwritten and are not presented as one complete preserved flow. Shared host timing and routed code are excluded from acceptance/performance.

- Lazy declared-member lookup consolidation (2026-10-05): Program resolution, CHA's wide-hierarchy fallback and method-ID decoding now share `declaredMethod`. The CHA fallback and identifier path previously read byKey, retaining every member of candidate classes despite the lazy member cache. The helper preserves declaration-only semantics and existing MethodInfo identity while leaving synthetic/host classes on their canonical map. Class differential 33/33 (eight existing JS divergences), lazy linker/active-tier dispatch and full typecheck pass. No whole-app memory or speed claim is made.

- Y1 irreducible-cycle reentry (2026-10-05, integrated parent `c30593ac`, merge `6e79cd62`): the compiler computes strong components of normal region transitions. Within cyclic components it outlines targets of non-forward region edges; every cross-region cycle crosses such an edge, so it necessarily re-enters a compiled function. Acyclic handler paths remain inline. Existing typed activation state, return/exit/exception statuses, root Java handlers, fuel and active-frame quota accounting are reused; native-loop chunks still bound intra-region loops. No app names or fixture-dependent compiler paths are involved, and the active CHA guard region is unchanged.
  - Checks on the final feedback-entry version: TypeScript, two irreducible fuzz seeds each 2,400/2,400 comparisons across 200 generated methods (54 and 65 irreducible methods; 66 and 104 throwing cases), zero compiler gaps; core differential 1,105/1,105 plus two wide reflection cases; loop state/trace, overflow and suspended-native substrate 28/28 with reported JS stack-overflow divergences; strict eight-jar validation 290,828 methods with five existing gaps. Build source fingerprint `33e9ad5102d19c36a7d01592de12d6ea32c566e3222e2cb1b59757a4632dd2f0`. The first prototype outlined all cyclic regions; an initial readonly-target mutation was caught by typecheck/fuzz and removed before the accepted runs. Neither abandoned prototype is an accepted gate.
  - Evidence: Y1 `tests/e2e/actual/y1-recovery/g4-regions-*`, with the strict build isolated in `g4-regions-aot`. Final emitted code totals 235,565 KB in C modules and 38,312 KB in D modules on this integrated source. These are absolute sizes, not an isolated code-growth comparison against older pre-CHA sources. Browser captures and performance measurements are paused during parent quick verification. This establishes generic cycle reentry and tested semantics, not the idle <=100 ms tier-up gate or G1/G3 acceptance.

- G4 exception-cycle review correction (2026-10-05): normal-only region edges missed cycles whose return edge is a Java throw into a handler. The compiler now includes each applicable handler edge from reachable protected instructions not marked NO_THROW. Strong-component selection still leaves acyclic EH paths inline; original PC/status/fuel and root handlers are retained. The existing irreducible fuzzer at seed 1 passes 2,400/2,400 comparisons and a diagnostic identifies F.m71 with an acyclic normal region graph but an EH cycle, five regions and reentry at region 1. Initial block lookup and readonly-target mistakes were rejected by checks and corrected before this passing capture. Evidence: Y1 g4-regions-eh-coverage.log and archived eh-cycle-check source. No performance gate is claimed.


- G4 compact native chunk frames (2026-10-05, Y1 on parent 8fcfadef): matched parent Komikku controls on 6faa/strict7ba isolate APP outlining: original chunks overflow after Browse, while disabling app chunks completes 23 steps without errors. The expanded trace contains 166 recursive reportGroup Java roots and 162 accompanying loop359 chunks. Each chunk declared the full method layout, duplicating dead native locals at every recursion level. Code now defers logical local operands until MC assigns compact native indices; activation struct fields retain their original method indices and non-null reads/tees retain their checks. Nested chunk entry-depth locals are included before layout finalization. Dispatcher/chunk quota charges match the physically declared compact frame; MAX_DEPTH is unchanged.
  - reportGroup root remains 146 parameters/locals. Its loop81/107/359 chunks shrink from 146 declared locals to 83/62/28, with dispatcher-plus-chunk weights 95/74/40 (formerly 158). Its module validates. This is measured generated layout, not browser acceptance or execution timing. Generic raw-table invocation bypassing World.entry restoration preserves a nonzero depth sentinel across five repeats each of the existing nested try/monitor loopState and loopTrace fixtures (15/15 checks including fixture results).
  - Checks: typecheck; core differential 1,105/1,105 plus two wide cases; threads 72/72 (three reported JS-tier divergences); nested entries pass; existing irreducible/EH fuzzer seed 1, 2,400/2,400 with the exception-only cycle identified; strict eight-jar build validates all 290,828 methods with five existing gaps. The tested checkout also contains unfinished compiled-resume work, separately uncommitted: 865 precise-PC cold-to-compiled numeric/reference/raw-FP and transfer checks pass across 45 entries. No production cold integration is claimed.
  - Evidence is isolated in Y1 tests/e2e/actual/y1-recovery/compact-*. Tested source fingerprint e5856d19eeed432b3086abfc7eb93660a6bd4d8028550cf6d21bd0a9fba74b4e includes that separate resume work; the focused patch alone requires a fresh parent AOT build and Komikku acceptance. C modules total 220,663 KB on this source; shared-load build timings are diagnostic only. Idle <=100 ms optimization, G1/G3 tradeoffs and the earlier TikTok OOM attribution remain open.
### Cold slow runtime and committed snapshot validation (2026-10-05)

The opt-in cold numeric loop now stops before slow operations and uses canonical
MC/Compiler/World adapters for object, field, array, invoke, throw, explicit
monitor, class initialization and JSPI behavior. Registers commit after success;
ordered typed DEX handlers retain the original Throwable and pre-fault destination.
Snapshots include pending results/exceptions, String constructor aliases, monitors,
strand ownership and logical depth. The shared World validator rejects a pending
result unless its invoke/filled-array producer immediately precedes the committed
cursor; fixtures verify rejection before writes. Compiled resume must reuse that
validator; active OSR remains separate compiler integration work.

Fresh JSPI bridge entry initially lost the unbound Thread peer during constructor
execution, producing recursive construction/StackOverflowError. Restoring a null
entry peer also discarded a newly bound peer and lost currentThread identity.
Passing the partial peer and preserving newly bound ownership fixes both. Cold
traces now carry real methods and fault PCs, frozen when Throwable stacks capture.

Focused recovery-source checks: slow fixture 140, numeric 1290, classdiff 33,
customdiff 375, differential 1105, selected threads 11; typecheck. Exact commands,
source epoch, output files and remaining boundaries are recorded in
`research/wasm/cold-slowops-review.md`. Pins/baselines are unchanged. Cold stays
opt-in: implicit synchronized bodies and unsupported method-handle/type constants
fall back before effects. Per-PC helper modules, typing and register copying are
counted, not accepted as a performance improvement. No broad G2/browser rerun or
later parent G4/S5 source acceptance is claimed.

### Share identical cold slow adapter calls (2026-10-05)

Executed slow sites within a declaration can share compiled helpers when opcode
operands, normalized register roles/aliases, precise web kinds and preparation
flags agree. PC/result/EH state stays site-specific; PC-relative array payloads
retain their absolute location. Unvisited sites do not compile eagerly. A paired
real volatile-field probe retains 75 sites: modules75->5 and compiled bytes
86902->9396, with the same side effects/result600. The prior nonvolatile probe was
optimized down by D8 and is not cost evidence. The unchanged slow fixture uses
175->161 modules with the same1049 slow calls. Extended145 checks, cold diff1105,
customdiff375, selectedthreads11 and typecheck pass. Exact output paths and source
epoch are in the cold review document. Full register copies and whole-method
inference remain; no G3 timing acceptance or broad G2 rerun is claimed.

- Worker clock transport (2026-10-05, parent `54e01cfa`): bootstrap carries the page monotonic origin and controlled wall-clock origin. Worker callbacks stay local; a broker-owned MessagePort binds timer ownership to the process and orders schedule/cancel messages before callback acknowledgments. Controlled advancement synchronizes clocks, waits for delivery acknowledgment, and serializes overlapping advances without rewinding time. Existing in-page clocks keep their direct function bindings and synchronous callback policy; arbitrary guest promises are not awaited as timer completions. System-service timers remain broker-owned.
  - Core clock checks pass (three cases, including nested microtask scheduling, cancellation/death and overlapping advances); typecheck passes. A real Chromium Worker receives uptime 110, wall time 1110 and page origin 123 at its callback, schedules a same-time nested callback before acknowledgment, and cancels its remaining timer on disposal. Diagnostic script/log: `/tmp/webdroid-clock-worker.ts`, `/tmp/webdroid-wasm-clock-worker.log`; focused test/typecheck logs share that prefix. This provides the clock contract for process bootstrap; production process Workers and their presentation/store acceptance are still unfinished. Closing the broker clock port is required on process death; MessagePort alone does not detect a terminated peer.


- Y2 canonical SQLite process service (2026-10-05, based on parent `2ace54d6`, Y2 merge `ccfc0636`): process startup previously installed another realm's mutable SQLiteStore and sql.js initializer. SQLiteConnection and bundled-driver natives now reuse their canonical owning tables behind a PID-bound broker command. Every native client entry advertises suspension through `driven`; requests omit caller Runtime arguments, Java objects, JNI handles and raw statement pointers. Opaque monotonic tokens validate statement ownership. Serial session requests retain live connection-local TEMP/PRAGMA/transaction state on the one canonical sql.js file; no whole-file database replica replaces them.
  - CursorWindow replies preserve typed values and accounting, including partial mutation before an oversized-row exception. A read-only window is rejected without replacing its existing cells. Errors are class/message data reconstructed in the caller's VM. Process death rejects current/queued/future calls immediately, releases queued payloads, finalizes statements then closes connections. A still-loading open closes its returned handle; only that in-flight request remains until it settles. Existing persistence may finish an already-started flush. Guest kill behavior is unchanged.
  - Four selected core checks pass (36 assertions): real AOSP database/session/pool calls over ports, rollback visibility, independent TEMP schemas, 64-bit/blob values, error reconstruction, bundled-driver families, foreign-token rejection, failed/read-only window state and immediate death/late-open cleanup; existing large snapshot/TEMP checks pass. Four endpoint/archive/compiler-owner checks pass (17 assertions), typecheck and strict eight-jar AOT validation pass (290,828 methods, five existing gaps). Final AOT key `0acdffb7058254ea`, source `7c4ba012d1e90ca09abf5ca7c2ac3aa3a291c51b1f3792f7010691b0c14bd197`, manifest/index HTTP 200 after server restart.
  - Final unchanged Wasm jobs-1 sequence: FitNotes 39, Mihon app 17, Komikku 23, all 3 pass (79 steps, two Android-compared and one smoke). All 221 process snapshots are healthy; no missing/native requirements, timeout/wedge or unexpected runtime/browser errors. Observed AOT maxima 264/265/337 and completed rendering are nonzero. Declared Komikku native SQLite 28/284 logs remain. A startup owner probe confirms PID 1000 reaches canonical SQLite with two WorkManager and one app-database connection; it is not another full-flow gate. Evidence is isolated in `webdroid-shots/y2-s5-endpoint/sqlite-final-*`, `sqlite-service-test.log`, `sqlite-endpoint-test.log`, `sqlite-full-typecheck.log` and `sqlite-owner-probe.*`. The earlier browser pass preceded the read-only error-path guard and is retained separately. No idle-performance claim or full-matrix/S5 acceptance follows.
  - S5 limits: the sql.js owner still executes synchronous C on the page; other mutable stores, FD/VFS coherence, controlled clocks and presentation/WebView need explicit Worker contracts. No JVM Worker is enabled. The earlier FD copy tests concern wire ownership only. Bounded source/import reads show cross-process stale data and distinct positions; final importer writeback can overwrite intervening source writes. A canonical broker open-file description and region/mapping coherence remain required before FD sharing can be claimed (plan 4.22).


- Y2 SQLite finalize/close review correction (2026-10-05, follow-up to `c159cbf7`): retiring a statement token only after the native returned could leave a freed pointer owned if an error was thrown after destruction. Tokens now retire at validated finalize dispatch for both AOSP finalize and bundled statement close. The canonical finalizer drops statement ownership in `finally`, preserving any thrown error; ordinary SQLite finalize error codes remain ignored as before. This follows SQLite's destruction-on-error contract, not a change to AOSP error handling ([SQLite finalize](https://www.sqlite.org/c3ref/finalize.html), [AOSP nativeFinalizeStatement](https://android.googlesource.com/platform/frameworks/base/+/ebadfb1/core/jni/android_database_SQLiteConnection.cpp)).
  - Statement ownership replaces lookup through a connection pointer that close_v2 had removed. A zombie connection remains in its canonical file's owner set until the final statement releases it; snapshots defer without querying the unusable database pointer. Session requests after connection close reject execution but allow remaining finalizers, including platform finalization after its public connection token has retired. Bundled local statement operations also reject a closed owner before calling SQLite. SQLite defines close_v2 zombies as unusable and releases them after dependent resources finish ([primary close contract](https://www.sqlite.org/c3ref/close.html)).
  - Five selected core checks pass (56 assertions), full typecheck and diff check pass. The new case in `tests/data.test.ts` covers both driver families, runs a real failing UNIQUE insertion, verifies finalize returns primary code 19, then injects a Java error after the actual C destruction. The error is preserved, the expired token is rejected and death finalizes the other live statement without revisiting the freed pointer. The diagnostic guards against repeat native destruction to avoid corrupting the test heap on regression. Zombie close retains one file owner, rejects execution, permits finalization and then has zero owners. Tests use the canonical shared sql.js module rather than initializing a different module for inspecting the native finalizer. Evidence: `webdroid-shots/y2-s5-endpoint/sqlite-finalize-{test,typecheck}.log`. No browser or AOT gate was repeated for this correction; the prior 79-step sequence predates it. Parent integration must rebuild AOT. No owned server/capture/build is running and no S5 completion is claimed.


- Y2 S5 CookieManager ownership (2026-10-05, after `9dc536b1`): CookieManager's previous live WebCookies reference now crosses the reverse process port as six acknowledged operations. The existing canonical page jar is resolved from the port's PID/package, with no client package selector. Same-package clients and WebView retain one jar, acceptance setting and persistence owner; other packages remain isolated. Async jar initialization is followed by a death check immediately before the operation, so a process killed during initialization cannot perform a late write. CookieManager awaits mutations before main-looper callbacks. The local fallback retains lazy tough-cookie loading and the same operation implementations.
  - Two selected existing core fixtures pass (12 assertions). The real Chromium Worker contract checks shared reads, HttpOnly document filtering, acceptance, session/persistent removal behavior, canonical watcher delivery, death during jar loading, future rejection and surviving-client access. The JVM fixture delays the real owner acknowledgment over MessageChannel and confirms no callback/write before release, then successful Boolean callback delivery and getter/removal behavior. Full typecheck and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/cookie-{port-test,manager-test,typecheck}.log`.
  - WebView still reaches live jar/watch objects; its renderer and document/network cookie boundary are part of the remaining presentation conversion. FD/VFS coherence and the other mutable stores remain required. Parent owns the clock transport files; Y2 owns bootstrap wiring. No process JVM Worker, app capture, AOT rebuild or performance acceptance is claimed for this change. Rebuild AOT after integration before browser verification. No owned background drivers are running.

- Y1 compiled precise-PC resume entry (2026-10-05, parent canonical cold state through 71b6d219 merged as 2d3dcc49): infer reconstructs the live register webs at one requested DEX boundary after its normal fixpoint, without retaining a per-instruction state matrix. MC adds an entry region, seeds raw bits/references into typed locals once, and reuses ordinary Java EH, outlined state/returns, fuel, and compact physical frame accounting. Resume calls use the normal method table, including recursive calls, rather than calling the snapshot ABI as a Java ABI. Native declarations are prepared as in ordinary units, and resume trace names carry their actual Java MethodInfo.
  - compiler/resume uses Gibbs's canonical ColdSnapshot type and validator (method/activation, owner, next/executed PC, raw bits/references/kinds, pending result/exception, monitor counts and uninitialized allocations). Pending move-result/move-exception is validated and consumed into a copied register state before entering the following instruction. The original producer/throw is not re-executed. take({validate,claim}) validates runtime strand/monitor/handler ownership synchronously, retires the cold activation once, and returns the compiled ABI input; claim or entry failure cannot authorize replay. Uninitialized String allocations and synchronized method boundaries stay cold before any transfer; their production extension remains open.
  - Diagnostic verification: 871 checks with 47 cached method/PC entries and dedicated monitor, suspended-native and active-transfer cases, using actual cold execution at budgets 1 and 7, numeric/control/long/floating comparisons, identity/null references, signed zero and NaN payloads, duplicate-transfer rejection, rejected-state retry, pending invoke results and Java handler exceptions. The pending-state cases inject committed snapshots; an invoke-effect counter confirms compiled prefix effects are not replayed. A generated typed method-table adapter executes two real shared cold slices and then uses a returned Wasm function reference with return_call_ref, transferring at PC 6 on the same strand once and producing the matching long result. World.validateColdSnapshot runs before effects; ColdInterpreter.transfer retires the real frame and caller depth is restored before the tail call physically replaces the adapter. A monitored continuation releases its existing lock once; a suspended Thread.sleep continuation preserves its owner and result. The production adapter/promotion policy still needs Gibbs's integration; these generated-adapter checks are not a production S4 gate.
  - Final normal-path checks: core differential 1,105/1,105 plus two wide reflection cases; loop/trace/overflow/native substrate 28/28 with reported JS stack divergences; full typecheck; integrated cold-slow 140 checks / 55 methods / 491 activations. Evidence: Y1 tests/e2e/actual/y1-recovery/resume-{tail-active,tail-diff,tail-threads,tail-typecheck,tail-cold-slow}. No browser or idle timing capture was started. Production active OSR, deoptimization transfer, full slow-op/EH/monitor coverage and S4 acceptance remain open until the joint runtime integration is verified.


- Compiled resume declared-monitor correction (2026-10-05): DECLARED_SYNCHRONIZED denotes D8's explicit monitor bytecodes, so it no longer blocks resume. True implicit SYNCHRONIZED still compiles before cold entry. Canonical snapshot and World ownership validation run before transfer; a D8-produced synchronized instance method resumes after monitor-enter, returns 12 and releases the existing lock, without re-entering it. The combined resume checks pass 872/872, including tail-call transfer, pending state, raw floating bits and suspended native continuation. Evidence: Y1 resume-declared-active.log. Live uninitialized String aliases continue in the original cold activation until their constructor commits; this is a precise-PC promotion deferral, not a whole-method restart or full live-state OSR coverage claim. Strict platform validation and aottest on preceding 5311502f passed all 290,828 methods with five existing gaps; this one-line preflight change requires a new source key before browser use.

- CookieManager bootstrap ordering correction (2026-10-05, integrated `ff3a90f0`): the root calls `connectProcess()` before `bootApk` registers its foreground PID. Eager cookie command acquisition opened a broker port for the unregistered PID and raised `DeadObjectException: Process is dead: 1000`; Komikku never rendered. A bounded startup probe reproduced the failure after a server restart, with an idle main queue and advancing page ticks. Cookie transport now supplies a lazy command factory, acquiring the canonical port on the first operation. The existing mutation-acknowledgment fixture passes (eight assertions), full typecheck and diff check pass. Failed launch evidence is retained under `tests/e2e/actual/parent-recovery-ff3a90f0/startup-failure`. Fresh AOT and browser verification follow; compiler differential success did not validate this bootstrap path.

- Y2 clock/bootstrap ownership (2026-10-05, parent clock API `88dc1058` integrated as `8a8046c9`): Worker bootstrap requests include clock metadata and an optional transferred clock port. One transfer-list helper covers both structuredClone and the subsequent Worker postMessage. The broker retains the exact clock/archive close callbacks, retires the previous set after a successful replacement, closes unpublished owners after failed cloning, and closes retained owners on death. Iframe callers retain their direct clock path; system-service timer owners are unchanged. Registry loading is shared with the production iframe entry without changing packed/raw/split or foreign-lazy archive branches.
  - Two selected existing browser core fixtures pass (nine assertions), full typecheck and diff check pass. Actual broker bootstrap reaches a Chromium Worker through both hops. The Worker attaches time before its archive read/timers; page origin, uptime and wall offset match. Nested microtask scheduling completes in order. After Worker termination, explicit broker death removes its pending timer but preserves a root system timer. Replacement, failed initial clone and death close four clock owners with zero remaining callbacks. Evidence: `webdroid-shots/y2-s5-endpoint/bootstrap-{clock-test,endpoint-test,clock-typecheck}.log`.
  - No application JVM Worker is enabled. Remaining stores, canonical FD/mapping coherence and presentation are still required; a future entry must attach time before JVM boot and publish/close its endpoint owners. No AOT/browser app gate or idle performance acceptance is claimed. Parent clock source files are unmodified after cherry-pick. Rebuild AOT on integrated source before app verification.

- Y2 canonical Clipboard/registration contract (2026-10-05, integrated parent `ff3a90f0` plus CookieManager ordering fix `e38f3b10` as `fcced894`): ClipboardService's direct broker accesses now use acknowledged get/set/listen commands bound to its caller PID. The existing foreground-UID check and copied canonical Parcel remain in the broker. Java reads await null/data rather than mistaking a Promise for a present clip; mutations and listener registration await the owner, with callbacks on the main looper. The local synchronous path remains immediate. Transport connection installs lazy closures and does not open a reverse port before PID registration.
  - Three selected existing core tests pass (22 assertions), full typecheck and diff check pass. A browser regression connects the root transport before PID 1000 exists, registers the PID, then exercises cookie and clipboard operations. A real Worker verifies shared state and buffer independence, foreground-UID denial/access, observer registration/removal, clear and clip survival after writer death. A Java ClipboardService check delays the owner write acknowledgment and verifies absence before release, Parcel/text reads afterward and absence after clear; CookieManager's eight-assertion acknowledgment check still passes. Evidence: `webdroid-shots/y2-s5-endpoint/clipboard-{port-test,cookie-jvm-test,typecheck}.log`.
  - No application JVM Worker or app/performance gate is claimed. Parent owns canonical settings plus its broker registration; Y2 owns bootstrap/Worker wiring, Clipboard and remaining stores/presentation. Canonical FD/ashmem mapping coherence remains required. Rebuild AOT on integrated source before browser acceptance. No owned browser/server capture drivers are active.

- Canonical settings process access (2026-10-05, after `3e997b5d`): remote SettingsProvider reads, ordered entries, mutations and the SSAID user key use PID-bound broker commands. The page retains direct access to its owning store. Provider permission/readability/user checks, derived values and certificate hashing remain in their owning modules. Remote Java entries await values and write acknowledgment; query row IDs retain SettingsState insertion order. Bootstrap installs the broker-owned change subscription before Java starts; notifications reach the process endpoint and its own content observers. Process death removes the subscription. No remote live store or foreign Java callback crosses the boundary.
  - Eleven selected core checks pass (48 assertions), full typecheck and diff check pass. The existing Chromium Worker ownership fixture additionally verifies shared settings, copied reply entries, change delivery, one SSAID key and continued reads after writer death. One Java provider case delays the actual mutation acknowledgment, verifies no premature write, then checks acknowledged put/get and a real query cursor. Existing permission, SSAID, DeviceConfig, readable-query and observer cases pass. Evidence: `/tmp/webdroid-wasm-settings-{integrated,typecheck,port,core}.log`. Actual process Workers, the other stores, FD/mapping coherence and presentation remain unfinished; fresh AOT/application verification follows integration.

- Production cold activation OSR (2026-10-05, Y1 on parent ff3a90f0 merged as 20a1d5d2): cold method adapters now ask World at committed boundaries once the existing back-edge budget is reached or their normal method slot has upgraded. World validates the canonical method/strand/PC/EH/monitor snapshot before compilation and again before take; unsafe uninitialized String aliases remain in that same cold activation until their constructor commits. A cached precise-PC entry retires the interpreter frame once, restores its validated caller depth, and is entered by typed return_call_ref, physically replacing the charged cold adapter. Ordinary future-call promotion is independent. Resume bytes go through World's existing compile/instantiate accounting; units, methods, resume entries/transfers and snapshot registers are counted. Class arrival clears cached entries and slot invalidation evicts the affected method; traces and assumptions use the ordinary unit registration path.
  - Core cold suite passes 1,290 numeric/control comparisons. Its first 50,000-iteration call transfers once while future-call upgrades are held; three subsequent raw-table calls each transfer and preserve caller depth 123, sharing one compiled PC entry. New focused cold-osr suite passes 13 checks: native class loading after transfer invalidates an interface assumption slot, dispatch reaches the new override, prefix effects execute once, and two monitored long activations suspend in a native and preserve normal/Java-exception results while releasing the lock. It observes three active transfers and two compiled entries. Generic diagnostics additionally pass 872 precise-entry checks and actual production-boundary transfers for one pending invoke result, one selected Java handler and two held-monitor bodies; three unsafe String boundaries defer before a safe transfer. Those boundary diagnostics force only the hotness threshold, not bytecode or dispatch behavior, and are not performance evidence.
  - Differential 1,105/1,105 plus two wide cases and cold-slow 145 checks pass. Cold-mode focused threads remain red at 25/28 both before and after this change: loopTrace and two plain-entry overflow controls; no pin/skip closes them. Cold Thread.sleep initialization also throws ExceptionInInitializerError on both source cuts; the focused OSR native uses its separately bound async native and does not claim that platform path fixed. Evidence: Y1 tests/e2e/actual/y1-recovery/osr-{production-*,baseline-cold-threads,baseline-sleep}. No browser capture, broad G2, idle performance, compiled-to-cold deoptimization or full S4 acceptance is claimed. Runtime edits are limited to the promotion/tail-call hooks; Gibbs retains interpreter, slowops/performance and browser opt-in ownership.
- Cold adapter native declaration scan reduction (2026-10-05): each shared slow adapter previously declared its entire caller, decoding all its bytecode again to find String constructors. Ordinary adapter invokes enter method-table functions that own their native imports. Slow adapters now declare only the current String constructor, using canonical declared-method lookup before defining functions; preflight, pending-state validation and execution semantics are unchanged. On the unchanged 145-check fixture, declaration work fell from 5,439 to 17 bytecode words and 173 to five declaration calls; 258 adapter PCs, 169 modules, 1,136 slow calls and 3,239 copied snapshot registers stayed equal. The expanded 156-check fixture exercises production native UTF-8 constructor fallback against JDK and the compiled tier and rejects rescanning cold caller bodies. Original logic fails that regression with 3,028 caller words scanned. The expanded fixture passes with 28 total declaration words and six declaration calls. Diff 1,105/1,105, classdiff 33/33 (eight existing JS divergences), customdiff 375/375 and typecheck pass. An experimental invalid byte range reproduced a missing `StringIndexOutOfBoundsException`/illegal-cast failure with both original and reduced scans; it remains a separate unresolved native exception-path limitation.
  - Matched browser diagnostics completed serially on port 4198 at source `9ed491c0` (selector `9944c163`, cookie ordering fix included), matching AOT `9092253edf87f94f`, before this source edit. FitNotes off completed nine steps, Calculator M off seven, with no new missing/error/native-required telemetry. Both on runs failed the boot deadline before taps; root cold calls were 399,900 and 399,393, copied registers 22,741,976 and 22,737,196, slow modules 16,715 each. Their final settle busy maps reported 816 and 962 main jobs. FitNotes off launch action/settle were 3,732.7/5,645.4 ms. These are competing-load diagnostics, not tap-latency or G3 acceptance. Off runs also retained scheduled timers, and AOT/worker work is reported separately per realm. The probe now preserves source/AOT, phase/settle busy data and console details, closes its owned browser before watchdog exit even if saving fails, rejects new gaps/errors and requires actual root cold calls after an on launch. Evidence is `conform-cache/cold-review/{fitnotes,calculatorm}-{off,on}.json`, `native-declaration-{before,after,diff,classdiff,customdiff,typecheck}.log`, `native-constructor-{baseline,valid}.log` and `native-scan-regression-red.log`. Serial capture driver has exited; whole-method typing, snapshot copying and runtime promotion/OSR remain open. World/runtime promotion is separately owned; no World/runtime changes or broad conformance rerun were made here.

- Native constructor diagnostic correction (2026-10-05, after `5a92ffed`): the cold-slow fixture supplied production natives but left `rt.mkThrowable` bound to the JS runtime, whose independent class table lacked the fixture World's DEX classes. An invalid byte range logged a missing StringIndexOutOfBoundsException, produced a generic host Throwable named Object, and trapped while World attempted to cast that Object to Throwable. The fixture Program actually contains the real exception DEX class and its IndexOutOfBoundsException superclass. The fixture now binds `hostThrowable`, as production tier boot does. Ten added comparisons reuse the existing constructor fixture inputs and check valid/invalid byte ranges against both the JDK and compiled Wasm; all 166 checks pass. Native declaration accounting is 39 words/seven calls for the expanded fixture. This closes the diagnostic's class-table mismatch; no production exception substitute or World workaround was added. Evidence: `/tmp/webdroid-wasm-native-throwable-harness.log`.

- Capture abort diagnostics (2026-10-05, after `9da2ae6b`): a thrown browser evaluation discarded all completed step metadata and left no run.json, so quick outcomes misleadingly reported zero steps. Capture now saves completed steps, browser errors and the aborting step before propagating the failure; quick reporting retains those steps, and standalone full scoring explicitly rejects aborted captures. A deliberate throw after an actual FitNotes launch saved and returned one completed step with two healthy process diagnostic snapshots. Typecheck and diff check pass. Evidence: `tests/e2e/actual/parent-recovery-9da2ae6b/capture-abort/`. This verifies evidence retention only; the intermittent FitNotes guest failure remains open.

- Y2 Worker command attachment (2026-10-05, after `bd05848b`): bootstrap includes actual PID and a bound reverse command port; the same transfer helper covers clone and Worker handoff. Broker replacement/failure/death close exact command owners with archive/clock owners. `attachWorkerBootstrap` attaches time before loading native/JVM modules, sets PID/UID/name and binds canonical SQL/cookies/clipboard to the received port. Attachment failure closes received capabilities without disposing an already attached clock on duplicate attachment.
  - Two existing Chromium core fixtures pass (11 assertions), full typecheck and diff check pass. The actual production attachment runs inside a Worker, with correct identity, canonical commands, shared page clock origin, ordered nested timers, system-timer survival and dead command rejection. Evidence: `webdroid-shots/y2-s5-endpoint/worker-commands-{core,typecheck}.log`.
  - This is not application Worker boot or S5 acceptance. Incoming endpoint publication, remaining stores, FD/ashmem coherence and presentation remain open; settings/device are parent-owned. No app/AOT gate or performance claim. No owned browser/server capture drivers.


- Y2 incoming Worker JVM endpoint (2026-10-05, settings owner `7302c49c` integrated by `bc5827ce`): the shared JVM endpoint factory is separated from the iframe's live broker/store setup. The iframe retains its activity-result map; a Worker serves the same handlers and transfers its peer to the existing broker readyPort owner. Canonical remote settings are attached in the common received-command binding path, preserving the parent's root direct path and PID subscription cleanup.
  - Two existing Chromium core fixtures pass (11 assertions), TypeScript/full typecheck/diff check pass. The production Worker attachment and real endpoint factory run in the fixture Worker; settings and package callbacks are acknowledged over its published port, with nested clock ordering and process-owner teardown still covered. Evidence: `webdroid-shots/y2-s5-endpoint/worker-incoming-{core,tsc,typecheck}.log`. The first integration run found omitted parent settings-notification fixture variables; restoring them resolved ReferenceError and TypeScript errors without production changes.
  - No application Worker or S5 acceptance is claimed. Activity result-map wiring, death records, remaining stores, FD/ashmem coherence, diagnostics and presentation/WebView remain required. No app/AOT/performance gate or active browser/server capture driver.

- Compiled-resume deoptimization target (2026-10-05, Y1 following 06699ad8): resumed compiled activations compare a runtime invalidation epoch at committed block/invoke boundaries. On change, the compiler captures live register webs as raw bits/references plus next/last DEX PC, caller depth and owned monitor counts. Nested outlined chunks return a separate deopt status and copy the captured state outward; the method root tail-calls a snapshot-ABI cold continuation after physical chunks have unwound. Canonical World ownership validation precedes claiming the compiled activation and creating the replacement cold frame. Duplicate entry is rejected before interpreter restoration, and the new frame can promote again without restarting either method prefix. Successful monitor bytecodes update the frame's ownership ledger. Live String allocation/constructor windows defer transfer; exception paths with abandoned allocations conservatively keep the activation compiled. Implicit synchronized bodies remain excluded.
  - Focused production core cold-osr passes 24 checks: native-loaded interface override invalidates the executing slot and produces one compiled-to-cold handoff; nested loops invalidate inside an outlined chunk while holding a monitor, unwind and resume with the expected result; raw caller depth 123 survives; all three deoptimization entries reject a duplicate without allocating/executing another activation. Eight cold-to-compiled transfers and six precise entries are observed across these cases; prefix effects and monitor release are checked. Numeric/control cold 1,290 and default differential 1,105 plus two wide cases pass. Evidence: Y1 deopt-{live,cold,diff,typecheck}. A first emitter draft declared imports after reserving a function, producing an invalid body; imports were moved before reservation and that draft is not a passing cut.
  - This milestone instruments compiled resume entries, not ordinary hot/worker/AOT entries yet. No browser, idle timing, code-growth tradeoff or full S4 acceptance is claimed. Parent source through 3e997b5d is merged; Gibbs retains interpreter/slowops and the known cold Thread/trace/overflow repairs.

- Integrated Worker/deoptimization verification (2026-10-05, `d9087293`): Worker attachment/endpoint fixtures pass two checks with 11 assertions, full typecheck passes, and production OSR/deoptimization passes 24 checks (three deoptimizations, eight promotions and six precise entries). Fresh default eight-jar AOT validates 290,828 methods in 41,247 classes, with five existing gaps. Worker settings access is installed alongside the other command transports before JVM use; root settings retain their direct owner. Actual application Workers and ordinary hot/AOT deoptimization remain unfinished.
  - FitNotes completed 39 steps in a native-handle diagnostic that installed two verified bundle replacements in root and child realms; no missing handle was observed. A separate forced-GC diagnostic also completed 39 steps with no missing handle. Neither timing-changing diagnostic establishes the intermittent failure's cause or final acceptance. Evidence: `tests/e2e/actual/parent-recovery-{a931c931,d9087293}/`; integrated logs `/tmp/webdroid-wasm-{worker,deopt}-integrated-*.log`.
- Cold bridge caller and overflow correctness (2026-10-05, parent production OSR `3cbb7e05` merged as `b4d0790a`, constructor fixture correction `9da2ae6b` as `4e8d8a6c`): each slow-operation call enters a fresh JSPI stack through World.callFn. Caller-class lookup previously saw only the current physical stack. Cold MethodHandles.lookup returned a null caller; Lookup.checkUnprivilegedlookupClass then threw NPE during AtomicInteger initialization, propagating through VMRuntime/System as ExceptionInInitializerError even for fresh Thread.sleep. Suspended parents also disappeared from Throwable traces, making Th.loopTrace return zero. World now retains lazy caller Errors in a strand-owned continuation chain until each call completes. An explicitly named bridge marker separates physical frames from the suspended callers; one canonical parse keeps recursive cold PCs in activation order and includes compiled frames between cold calls. Completion removes the chain on synchronous success, Java failure and asynchronous settlement. Caller lookup and captured Throwable traces share this path. Promotion/deoptimization hooks are unchanged.
  - Plain cold recursion additionally retained host adapter frames that were absent from its Wasm-local depth weight. It exhausted the host stack at recursive counters 506/379 before Java could construct/catch SOE. Cold entry now counts another 128 depth units only for a plain/synchronous stack; independent JSPI stacks keep the existing weight. The existing SOE guard then throws with construction headroom, and the unchanged plain-entry controls catch at 368/297 frames (both exceed their required 100). Slow-op failures also pass through the canonical World boundary conversion before Java handler selection.
  - New `bun run wasm cold-init` passes 13 JDK comparisons/checks: fresh World sleep=14, sleeping initializer=42, caller class identity, one visible Throwable activation, five recursive frames, a compiled synchronized middle between cold callers, and eight concurrent suspended mixed-stack strands. Restoring the old World bridge makes this fixture fail at the first cold sleep with ExceptionInInitializerError. Focused cold thread gate improves 25/28 to 28/28; the same compiled gate passes 28/28. Cold initialization/sleep/interrupt/join/name/ThreadLocal checks pass 11/11; numeric cold 1,290, production active OSR 13, cold slow 166, diff 1,105 plus two wide reflection cases, classdiff 33 (eight existing JS divergences), customdiff 375 and typecheck pass. No pins, expectations or bytecode changed. Evidence: `conform-cache/cold-review/cold-init-{baseline,ops,gate,regression-red}.log`, `cold-thread-{integrated,bridge,guard}.log`, `cold-overflow-depth.log`, `compiled-bridge-threads.log`, `cold-bridge-{numeric,osr,slow,diff,classdiff,customdiff,thread-init,typecheck}.log`. Fresh AOT and actual cold-on browser startup are still required; the earlier 399k-call failed browser probes and this source fix do not establish G3 performance or full S4 acceptance. Lazy Error capture adds bridge work that must be measured before optimization.

- Y2 Worker activity commands (2026-10-05, after `434ebc4b`): three reverse commands bind caller PID for canonical ActivityStack launch/finish/presentation. Requests carry serialized AOSP intents, while result callbacks stay local and share the incoming endpoint's request map. Reentrant replies before acknowledgment work; duplicate results and late results after failed launch do not invoke callbacks; reverse-port close clears the map. Lifecycle commands acknowledge queueing, preserving the existing asynchronous launch/pause ordering rather than holding the launching main job until stack completion. Iframe bindings remain direct.
  - Three selected existing core tests pass (18 assertions): real Java Intent copy/action and delayed/reentrant/error result ownership, plus Chromium Worker/bootstrap/endpoint checks. Full typecheck/diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/worker-activity-{java,core,typecheck}.log`. The initial Bun rejects.toThrow assertion hung; explicit rejection capture verifies the same transported message successfully.
  - Application Worker entry, canonical exit records/teardown, remaining stores, FD/ashmem coherence and presentation/diagnostics remain open. No AOT/app gate or performance acceptance.
- Y2 canonical Worker exit history (2026-10-05, after activity `09fa6277`, parent through `d9087293` integrated by `63283310`): AppExitInfoTracker publishes its real exit record over a PID-bound notification before Worker bootstrap closes received owners. The page binds identity, recomputes repeated-crash policy against canonical history, persists the existing bounded record list, then performs broker death cleanup. Java historical queries await owner replies; broker reads enforce same UID or DUMP. The direct page history/record path remains unchanged. Closed Worker command proxies remain closed, preventing a post-death window-parent reacquisition. Incoming endpoint close is owner-driven after persistence, preserving the actual crash flags.
  - Five existing core checks pass (37 assertions), full typecheck/diff check pass. Chromium runs actual Worker process-exit from a crash kill note, verifies bound canonical history/repetition/copy ownership and surviving readers, and preserves system timers while process timers close. Java ActivityManagerService waits for a delayed history reply and produces real ApplicationExitInfo PID/reason. Activity, clipboard and CookieManager acknowledgment checks remain green. Evidence: `webdroid-shots/y2-s5-endpoint/worker-exit-{core,java,tsc,typecheck}.log`.
  - No application Worker is enabled. Worker-local lastExit dialog can be provisional; future diagnostics must read the owner-computed record. Host Worker termination still needs explicit broker failure. Remaining stores, FD/ashmem coherence, diagnostics and presentation/WebView are required. Proposed parent disjoint accounts owner files are shell/accounts.ts and android/accounts.ts; Y2 retains process wiring and Worker/presentation. No AOT/app gate or performance acceptance.

- Canonical account access contract (2026-10-05, after `7d9c3791`): AccountManagerService now reads copied public account summaries separately from authenticator-owned credentials and awaits granular canonical mutations. Owner-side authenticator/UID checks guard credential reads and writes; token cache replies retain visible-account checks and their authenticator's type ownership. Atomic add and independent data/token changes avoid stale whole-table writeback. Owner-allocated account IDs preserve pending-session identity across rename; these IDs are not persisted as Android account data. Password changes still invalidate all cached tokens. Java authenticator sessions and callbacks retain their existing local entries. Exported commands and change delivery await Y2 broker/bootstrap wiring; no application Worker is enabled.
  - One focused Java/MessageChannel core case passes 12 assertions: delayed password acknowledgment, token invalidation, concurrent data/token updates, valid __proto__ user-data key, copied summary/credential data, denied foreign credentials/token changes and wrong-authenticator cache, then rename followed by removal through the original account identity. Typecheck and diff check pass. Evidence: `/tmp/webdroid-wasm-account-{core,typecheck}.log`. Fresh AOT/application verification follows wiring.
- Unmodified quick-flow failure evidence (2026-10-05, production `d9087293`, AOT `a0af67bd99923458`): six flows pass; FitNotes stops at category creation with an uncaught NullPointerException in RenderNode.nHasIdentityMatrix reading an absent native object's hasTransform property, during Editor.PositionListener pre-draw positioning. Step 22 reports the Java error, frozen ticks and a wedged main queue; the following steps remain wedged. After retaining three failed-step snapshots, the owned browser was explicitly terminated to bound the diagnostic. The capture's final target-closed abort is that intervention, not the initiating cause. Twenty-five completed steps and both process diagnostics were retained. Evidence: `tests/e2e/actual/parent-recovery-d9087293/quick/`, including explicit source/intervention metadata. This strengthens the recurring native-handle failure evidence without identifying a numeric handle or release cause; no regression waiver or accepted performance number follows.
### Ordinary compiled activation deoptimization (Y1, parent a931c931)

The resume-only deopt contract now also applies to ordinary Java-ABI methods compiled in a cold-enabled World. Compiler declares the namespace before reserving functions, including units generated by a compile worker. Each invocation creates a small method/strand/suspension/depth token and monitor ledger; register arrays are allocated only for an actual precise-PC handoff. Bodies are preflighted before execution; implicit synchronized methods stay compiled, and unsafe String construction conservatively postpones transfer. The existing canonical snapshot validation and single-use claim precede replacement; physical frame weights include the added locals. No depth quota changed.

Upgrade jobs carry the executing World's cold policy, worker adoption rejects a policy mismatch, and worker/AOT loaders supply the canonical deopt namespace. Ordinary worker roots and resume roots use the same committed-boundary capture and chunk unwind path. The AOT producer currently does not enable this profile: namespace compatibility is not evidence that default shipped AOT activations deopt. Enabling and keying a cold AOT profile requires coordination with the parent-owned build scripts and code-size/cold-cost measurement; blanket platform instrumentation was not added.

At this source, `cold-osr` passes 40 checks (the existing 24 plus ordinary worker-root nested monitor/depth transfer and native-loaded interface override, with prefix effects once). `cold` passes 1,290 cases and its four production transfer checks; `diff` passes 1,105 cases plus two wide reflection cases; `persist` passes its worker/adoption and actual app-AOT persistence coverage; typecheck passes. The first local attempt lacked Java on PATH and did not run the fixture; checks used `/opt/homebrew/opt/openjdk@17/bin`. Node/build timings were concurrent diagnostic output, not accepted performance. No browser capture, idle G4 <=100ms proof, full S4 acceptance, or native-handle/GC root-cause closure is claimed. Gibbs's interpreter, slowops and caller-stack files were not edited.

- Aborted quick summaries (2026-10-05, after `1c71bf8f`): aborted-flow reporting now applies the same diagnostics to retained completed steps before adding the final abort. Replaying the actual 25-step RenderNode failure record through runFlow retains the initiating hasTransform guest error and reports ten failures instead of only browser closure. Host-file inventory is also inside capture's persistence boundary, so a late inventory failure preserves all completed steps. Typecheck and diff check pass; offline evidence is `/tmp/webdroid-wasm-abort-report-probe.log`. No production source or browser gate was changed for this reporting correction.

- Y2 Worker frame ownership (2026-10-05, after `d5a6e956`): device presentation accepts a whole-frame sink, with the existing page path synchronous. Frame ports bound ownership to one transferred request and one newest pending bitmap; superseded pending frames close and do not count as presented. Page acknowledgment follows sink consumption, controlling presentation/first-frame accounting. Errors propagate; close rejects pending/future frames and releases retained bitmaps. Optional bootstrap display ports share exact replacement/failure/death ownership and transfer lists. Worker startup/exit closes the local sender, and broker death releases its page canvas.
  - Two existing Chromium core fixtures pass (12 assertions), full typecheck/diff check pass. Actual Worker snapshots preserve red/blue pixels after source repaint, with middle-frame replacement, detached/released images, resized page sink, sink-error propagation and teardown. Four broker display owners close across replacement/unpublished failure/death; production Worker attachment receives its display capability. Initial fixture failures were split-module URL resolution and creating an image before its context; neither established a production failure. Evidence: `webdroid-shots/y2-s5-endpoint/worker-frame-{core,tsc,typecheck}.log`.
  - Application Worker entry is not enabled. Input/IME/WebView, diagnostics, remaining stores and FD/ashmem coherence remain required. No app/AOT/performance acceptance. Parent owns accounts owner files; Y2 owns process integration and Worker/presentation.
- Canonical account process wiring (2026-10-05, after owner contract `5f57d19b`, display `da95b966`, parent compiler `1c71bf8f`): five account commands resolve authority from the port's registered PID/package/UID on each operation. Child/Worker AccountManager access uses lazy reverse-command closures; root retains its direct canonical store subscription. Bootstrap installs remote account notifications before Java initialization, commands subscribe idempotently, root binding replaces that notifier with its local watcher, and process death retires the exact owner subscription. Incoming `accountsChanged` dispatches in the receiving JVM. No credential table or foreign Java closure is transferred.
  - Existing real Chromium Worker fixture verifies copied public summaries without credential fields, visible cached tokens, denied credential reads/password writes, rename through the same owner identity, one account change notification, and canonical reads by a surviving peer after Worker death. Existing owner Java/MessageChannel case verifies granular authorized mutations separately; the browser fixture has no authenticator metadata and does not claim authorized writes through that port. Three focused integration cases pass (28 assertions), process-port fixture passes (six assertions), full typecheck and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/worker-accounts-{core,integration,typecheck}.log`. Merge `74fcb398` duplicated an identical activity transport block; local repair `ae98ee38` removes one copy and is not required on a parent with one existing block.
  - No fresh application AOT/browser gate or Worker APK launch is claimed. Application entry, input/IME/WebView, remaining canonical stores and FD/ashmem coherence remain open. Parent owns permissions transport plus service/location/notification asynchronous callers and their focused checks; Y2 retains broker/endpoint registration, Worker entry and presentation/input/WebView. Account owner files remain parent-owned.

- Canonical permission access contract (2026-10-05, after account wiring `0a164468`): runtime grant checks and granular grants have typed owner commands; Java permission requests await grant acknowledgment and return the canonical results. AppOps, location and notification paths resolve asynchronous checks before selecting allowed/denied behavior; location checks batch fine/coarse permissions and notification prompts acknowledge grants before covering the activity. Immutable install-time/special-access policy retains its local fast path. Broker PID authorization and Worker bootstrap binding follow in Y2's owned process files; this contract alone does not enable application Workers.
  - One Java/MessageChannel core case passes nine assertions: denied permission/location access, no completion or visible grant before owner acknowledgment, allowed Java check afterward, and foreign grant rejection without mutation. The first diagnostic stalled in Bun's asynchronous rejection matcher; explicit rejection capture completes the same port operation. Full data checks pass 17 cases/136 assertions; existing notification/device-service checks pass 21 cases/62 assertions; typecheck and diff check pass. Evidence: `/tmp/webdroid-wasm-permissions-{core,data,callers,typecheck}.log`. No AOT/application or performance gate is claimed.

- Cold bridge preparation follow-up (2026-10-05, recovery based on `05ed5d64`): matched AOT `2457bf81f56c9b28` cold-off FitNotes/Calculator completed 9/7 steps; cold-on both missed the unchanged 20s launch gate, with no presentation, about 365k calls, 2.04m slow operations and 20.85m copied registers. A bounded root-page CPU profile attributed 6.47s of self samples to the callFn closure, almost all at Error construction, versus 1.90s snapshot copying. This is competing-load diagnostic evidence, not performance acceptance.
  - Slow bridges may reuse a caller Error belonging to that cold activation; Java PCs still resolve through live canonical activation traces. Ordinary bridges capture their own callers. A scoped override is consumed at entry, so nested callbacks cannot inherit it accidentally. Fresh/restored/deoptimized activations get independent captures. Added two distinct caller source lines across Thread.sleep to the JDK fixture: 15 checks pass, including recursion, a compiled synchronized middle and eight suspended concurrent strands. OSR/deopt 24, slow semantics 166, cold threads 28/28 and differential 1105+2 pass.
  - A subsequent diagnostic exposed 1.56m emergency-yield bridge captures: the cold loop used raw WebAssembly.Suspending instead of Sched.suspending, bypassing canonical nested-stack reset and idle ownership. The cold slow boundary now uses that canonical scheduler wrapper. Caller captures and residual bridge captures have explicit work counters. No snapshot validator, register/monitor contract or promotion/deopt policy is weakened. Fresh browser validation after this repair remains required; prior cold-on runs are failed evidence. Logs/profiles: `conform-cache/cold-review/bridge-browser/`; focused checks: `conform-cache/cold-review/caller-{reuse,sched}-*.log`.

  - Resetting the quota before every cold import initially suppressed the recursive retained-stack guard and failed the cold-thread substrate. Sched.suspending now resets only when the import returns a Promise, after executing its immediate portion; immediate imports retain the quota. Cold threads return to 28/28 (plain depths 368/297, JSPI depths 2433/947), initializer/caller checks 15/15. The failed intermediate run was not accepted. The browser probe supports an explicit diagnostic startup bound up to 60s and records that override without changing the official 20s gate.
- Cold paired startup after caller/quota repair (2026-10-05, `43f570f4` plus parent `1c71bf8f` merged as `ae14027b`): fresh eight-jar AOT `82e7dd578bbff332`, source hash `a78e9766f9936cdf3f66fbc8658ad962891b69c385a77dcc20076fce0fab97ff`, validates 290,828 methods with five existing gaps. Integrated OSR/deopt 40, compiled threads 28/28 and full typecheck pass. Serial fresh-profile off/on probes use an explicit 60s diagnostic launch bound; the official 20s gate is unchanged. Off FitNotes/Calculator finish 9/7 steps with errors empty, presentation counters 45->124 / 2->83 and shell ticks 299->847 / 162->339. Launch action times 3503/3067ms, settle 7668/7232ms; these competing-load diagnostics are not accepted latency. Root compile counters 17,273/16,274 methods and 3565/3704ms; worker jobs 12/12 with 11 adopted each, and platform AOT 132D+20C / 130D+20C.
  - Both on probes fail the 180s outside deadline before a launch result; owned browsers close and no surviving sibling capture is used as evidence. A separate bounded read-only debugger watch captures a WeakRef to the actual World without replacing app bytecode or served bundles. Cold work stops at 504,663 calls, 2,438,055 slow operations, 412,500 waits and 23,856,354 copied registers; caller captures 448,334 and residual bridge captures 776. Its root compile counter is 343.7ms for 3,035 methods, with 16709 slow modules, 70 upgrades and 130D+20C AOT. This is a different unfinished execution cut, not a matched compile-time win.
  - From about 31s through the final 94s sample, strand PCs and work counters remain unchanged: main Looper Handler.handleCallback PC2, ActivityThread.attach PC47 -> IActivityManager.Proxy.attachApplication PC28 -> BinderProxy.transact PC160, and Binder.execTransactInternal PC79 -> IActivityManager.Stub.onTransact PC7435. Java monitor wait counts are zero; no Java error is observed. Shell ticks advance but presentations/completed frames stay zero. This localizes the unresolved startup wait to the attachApplication transaction/host continuation; it does not prove the awaited host operation or root cause. No G3/healthy-launch acceptance. Pair and watch evidence: `conform-cache/cold-review/caller-main-browser/`; watch diagnostics and CPU-sample aggregation are reproducible through `scripts/wasm/cold-watch.ts` and `cold-profile.ts`.

- Canonical preference access contract (2026-10-05, after `e998256d`): platform preferences use copied reads and granular acknowledged changes, replacing exposed mutable Prefs maps and their cache reloads. Arrays are copied in both directions; concurrent changes update the owner's map instead of writing back stale file snapshots. Persisted key names and long encoding remain unchanged; persistence now preserves __proto__ keys. Notification channel/group/delegate helpers, battery exemptions and locale/night configuration await owner replies; startup obtains canonical preference-file values before materializing absent SharedPreferences XML. Installed APK SharedPreferences bytecode still reads/writes its real VFS files; this contract does not establish shared VFS coherence or notification-list ownership.
  - One Java/MessageChannel core check passes ten assertions for acknowledgment, Java DeviceIdle reads, concurrent keys, full-width longs, copied arrays, removals and denied foreign writes. Existing notification checks now run through real preference ports (two cases/15 assertions). Combined data/device/notification checks pass 39 cases/208 assertions; typecheck and diff check pass. The initial remote notification run stalled in Bun's asynchronous rejection matcher; explicit rejection capture preserves the existing Java exception assertion and passes. Evidence: `/tmp/webdroid-wasm-preferences-{core,notification-remote,integrated,typecheck}.log`. Broker authority/bootstrap wiring follows in Y2's process files. No fresh app/AOT acceptance or performance claim.
- Native import suspension ABI across AOT/runtime binding (2026-10-05, Y1 source through parent `e998256d`): a real shipping-producer OSR fixture exposed a plain emitted native import being rebound as transparently suspending when the runtime implementation was async. The activation resumed under the root strand and canonical ownership validation rejected the handoff. Import names now fix the ABI: `#s` suspends, `#p` is the known conditional landing form, and unsuffixed imports retain explicit park/settle behavior even if the later binding is async. The generated plain call saves strand context before entering the native, rather than after a potentially reentrant native returns. No ownership or quota check is relaxed. On the combined guarded-AOT draft, real native result/throw, monitor release and lazy interface invalidation pass in cold-enabled and disabled Worlds; threads 72/72 and nested entries pass. This does not attribute intermittent app native handles or browser startup stalls to this mechanism.

- Guarded shipped AOT and persisted activation policy (2026-10-05, Y1 merge `ce2e5b9f`, parent `e998256d`; native ABI dependency `150af08b`): the shipping builder defaults to `--deopt guarded`; `--deopt off` remains explicit. Policy ABI 1 is recorded in platform/app indices and executable module headers, included in build-key options, and checked before adoption. Persisted app format is version 3; saved executable headers must match their index. App compilation follows its platform policy, profile export rejects mismatched bundles, and compile-worker adoption rejects stale policy. Guarded bytes loaded with `cold:false` create no interpreted activation and cannot call the cold target; actual cold-enabled handoffs retain canonical snapshot ownership, result/EH state, explicit monitors and exact caller depth. AOT eligibility preflight decodes without retaining all platform programs. The duplicate CompiledActivation alias from the merged source is removed; Gibbs caller capture/reuse, quota and scheduler changes remain intact.
  - Exact production source fingerprint `6db8a02e10b1531fb063cbc03eda9887633b5fa57a3af3227235f80f308bd285`. Strict builds of all eight jars validate 290,828 methods with five existing gaps for both policies. Guarded: 1,176 C modules / 435,732 KiB (34,682 KiB traces), 1,081 D / 38,137 KiB, largest 5,532 KiB. Off: 1,104 C / 220,679 KiB (7,081 KiB traces), 1,081 D / 38,103 KiB, largest 4,255 KiB. C size grows 97.45% including traces, 87.76% excluding traces; C+D grows 83.12%. The guarded estimate is raised from 14 to 42 bytes per DEX unit after the old partitioning emitted an 8.31 MiB media module; the physical 7 MiB cap is unchanged. This large instrumentation cost is an unresolved G1/G3 issue, not an accepted tradeoff.
  - `cold-osr --aot` passes 84 assertions using the real shipping producer/loader: four fresh guarded consumers (cold off/on crossed with native return/throw), actual AOT code execution, native suspension, monitor release, lazy subclass/interface invalidation, exactly-once prefix effects and transfers; real off-produced assets accepted with cold disabled and rejected with cold enabled; stale worker policy rejected before installation. The printed original-World counters are not totals over these independent consumers. Persist passes actual matching module loads and index/module plus app/platform mismatch negatives; aottest passes. Threads 72/72, nested entries, diff 1,105/1,105 plus two wide reflection cases, cold 1,290 cases, cold-init 15 and full typecheck pass. No checks use pins/skips. Evidence is isolated under `tests/e2e/actual/y1-recovery/aot-deopt-*`, including both build logs and `aot-deopt-evidence.json`.
  - No browser capture or accepted performance measurement in this milestone. Parent/Gibbs cold Binder startup stall remains unresolved; native-handle intermittence and TikTok OOM are not closed by this patch. G4 idle first-activation optimized-speed proof within 100 ms and code-growth/launch/tap gates remain open. Implicit synchronized methods compile before entry and unsafe live uninitialized String aliases defer transfer; no partial activation restarts or effects replay. This is a shipped-AOT correctness milestone, not full S4 or final matrix acceptance.

- Integrated guarded AOT delivery check (2026-10-05, `83e077b5`): typecheck passes; the production OSR suite passes 41 checks and its --aot shipping-producer variant passes 84. Standard bun run aot translates/validates the default eight jars (290,828 methods, five existing gaps) into guarded build f4c88320ec01e7d1, but aot-startup fails before publication with SuspendError in ICU.getUnicodeVersion during System initialization. The new current manifest is not installed. This exposes a plain startup-profiling entry after the native suspension ABI correction; source compilation alone is not complete delivery. Gauss owns the repair and subsequent required guarded-code cost reduction. Evidence: `/tmp/webdroid-wasm-guarded-aot-{osr,shipping-osr,typecheck,build}.log`. No browser acceptance is claimed against this unpublished build.
- Page-owned input bindings (2026-10-05, after account wiring `84737163`): pointer and wheel state now belongs to one canvas binding with an injected asynchronous dispatcher. The legacy IME uses that same binding. A blocked DOWN retains coalesced MOVE and final UP ordering; a second canvas progresses independently. Closing aborts listeners and discards unpublished queued samples, without dispatching after process death. Existing Chromium process-port fixture passes seven assertions, including delayed Worker replies, per-canvas geometry, CANCEL and post-close listener removal. Full typecheck passes. Evidence: `webdroid-shots/y2-s5-endpoint/worker-input-{core,tsc,typecheck}.log`. Worker application entry remains a separate draft; this input boundary does not claim application acceptance or IME/WebView conversion.

- Canonical permission process wiring (2026-10-05, owner contract `13aa3f0a`): child/Worker checks and grants use lazy reverse-port commands; root retains direct PermissionStore access. Grant authorization resolves the current registered caller and target UID, accepts root/system UIDs, same UID or the caller's canonical GRANT_RUNTIME_PERMISSIONS metadata, and raises a Java SecurityException for other callers. Both calls check live PID ownership; query results are copied arrays, and grants acknowledge the canonical mutation before Java callers continue. Existing real Worker fixture checks initially denied state, same-UID grants visible to another owner, copied results, denial of a foreign unprivileged grant, and a grant authorized by current canonical platform metadata. Alongside the existing Java async permission case, two focused cases pass 16 assertions; full typecheck and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/worker-permission-{core,tsc,typecheck}.log`. An initial fixture cleanup called nonexistent PermissionStore.remove; using its actual clear owner fixes that fixture failure. No parent-owned permission/service/location/notification file was edited and no application gate is claimed.

- Canonical Worker directory metadata (2026-10-05, after permission wiring `bd8bba62`): Worker startup prepares its data with the root PrivateFiles owner. The existing installd data/cache directory creation occurs there before package initialization. Typed stat/access/mkdir/list commands bind private package paths to the registered UID; mutable-path libcore directory operations await the owner rather than publishing local directory copies. Platform archives and procfs retain their local owners. Java File attributes, list and mkdir plus Linux stat/access/mkdir use these commands; remaining path operations, open descriptors, byte access and mappings are not converted by this milestone.
  - Two selected core cases pass 13 assertions and full typecheck/diff check pass: actual Java mkdir remains pending before owner acknowledgment, directory/list reads use the owner, a repeated mkdir returns false; the existing real Worker fixture verifies owner-visible directories, EEXIST, copied lists and foreign-package denial. Initial fixture/typecheck failures were an omitted onMain import, duplicate vfs import and an interface intersected with the port's Record constraint; the command type alias and actual imports resolve those build/fixture failures. Evidence: `webdroid-shots/y2-s5-endpoint/worker-file-path-{core,tsc,typecheck}.log`.

- Actual application Worker entry and copied controls (2026-10-05): a standalone process-worker entry attaches transferred clock/identity/commands/display before dynamically loading JVM code. It loads the unchanged package registry and APK, platform data, Skia and the selected tier, then calls the same bootApk as the iframe. Visibility starts false; page-owned frame requests drive actual vsync after visibility publication. Incoming JVM endpoints publish after application boot. Copied snapshots expose phase, liveness, ticks, main-queue state, performance counters, missing/native-required telemetry and logs; UI trees and tap/pointer/back/frame controls execute in the Worker. Dev/static bundles include the entry. ProcessBroker's production selector still uses iframes; this does not enable Workers with unfinished mutable-store or descriptor boundaries.
  - Bounded serial real Chromium launch probes use unchanged FitNotes.apk in fresh JS-tier contexts at port 4123 with identical screen/clock/registry inputs. The final route control removes exactly one Worker path binding from the otherwise identical bundle SHA256 `35e2d8109362e4fcbbc46258f8b22cef25f5b4eff39f676e661060d51e33349e`; it reproduces SQLITE_CANTOPEN in WorkManager, the ordinary uncaught-handler guest kill, and zero completed/presented frames. With the canonical path binding intact, the real APK reaches ready, presents its welcome UI twice, completes one frame and advances 27 ticks; the copied Worker snapshot reports no missing APIs, native-required calls, draw errors or error logs. Readiness alone did not establish health in the failing control. The earlier root setup was corrected to call the normal connectProcess, and an initial route expression matched zero renamed Bun variables; neither is causal evidence. The final control verifies one replacement and matching bundle fingerprints.
  - Evidence: `webdroid-shots/y2-s5-endpoint/worker-entry-js{,-baseline-matched}.json`, probe/server logs and `worker-entry-typecheck.log`; full typecheck passes. This is launch diagnosis, not an untouched e2e golden, Wasm launch or performance gate. Parent preference contract `d98bb151` and later compiler `e998256d` are not yet integrated in this cut. Next work must merge those, register lazy UID-bound preference commands, rebuild strict AOT, run actual Wasm Worker paths, and finish page input/IME/WebView, production creation/diagnostics/teardown, descriptors/ashmem, service/pending-intent and notification boundaries. Parent owns preferences/callers and the optional notification-only Binder lookup hook/notification foreground helpers; Y2 retains typed broker/endpoint wiring and Worker/presentation/input/VFS integration.

- Integrated Worker entry fixture cleanup (2026-10-05, `b1c846bf`): the full data file exposed a closed-port permission/path binding left by the activity command fixture. Its next Application initialization failed with DeadObjectException. The fixture now restores path calls/preparation and local account/permission/preference owners after closing its owned port; production closed-port semantics remain unchanged. Data and real Worker port checks pass 20 cases/159 assertions, and typecheck passes. Evidence: `/tmp/webdroid-wasm-worker-entry-integrated-{core-fixed,typecheck}.log`; the failed log retains its initial exception after stopping an unbounded Runtime object dump. This does not establish Wasm Worker APK acceptance.

- Notification owner access hooks (2026-10-05, after `2a25e925`): selected system-service lookups can obtain an exported canonical Binder handle through typed asynchronous access; local hosted services remain the direct root owner. Foreground start/stop sends the actual Notification Parcel to an owner helper that enters with the bound application caller identity and reuses the existing notification posting/cancellation paths. Broker PID authorization and Worker binding remain separate integration work.
  - Existing notification cases now exercise owner lookup and foreground start/stop over MessageChannel alongside canonical preferences: two cases pass 18 assertions, including foreground flags and removal. The fixture uses the same JVM PID for its Binder handle, so it does not prove cross-Worker AIDL dispatch. Combined notification, data, device and real Worker port checks pass 41 cases/224 assertions; typecheck passes. Evidence: `/tmp/webdroid-wasm-notification-owner-{core,integrated,typecheck}.log`. No application or performance gate is claimed.
  - A separate temporary NativeAllocationRegistry lifetime probe retains all 100 registered owners before dropping its Java collection and releases 99 afterward. A controlled temporary-bundle change clearing asynchronous bridge return globals produces the same 100/99 result. This comparison does not establish the remaining reference or explain the intermittent application RenderNode failure; no production compiler change follows from it. Evidence: `/tmp/webdroid-wasm-registry-{lifetime,compare}.log`.

- Asynchronous pending-intent and alarm callers (2026-10-05, after `c4e777d1`): the existing pending transport now declares asynchronous owner access for cancellation, metadata and operation consumption. Java cancellation, PendingIntentInfo construction and activity sender execution await those replies. Alarm scheduling/removal also await their owner transport; creator identity and registry/clock ownership remain in the existing canonical broker. Typed PID-bound Worker commands are still integration work.
  - The existing operation-type fixture uses actual Java PendingIntent APIs through MessageChannel, checks delayed cancellation acknowledgment and CanceledException after the owner cancels, and exercises Java alarm schedule/remove through the port. Two pending-intent cases pass 15 assertions. Full content, notification and device-service checks pass 41 cases/883 assertions; typecheck passes after correcting the fixture to account for the driven helper's synchronous-or-Promise return. Evidence: `/tmp/webdroid-wasm-pending-owner-{core,integrated,typecheck}.log`. No application/performance acceptance is claimed.
- Complete AOT delivery after explicit native suspension imports (2026-10-05): parent standard `bun run aot` exposed SuspendError in System initialization through ICU.getUnicodeVersion. The recorder's plain processState entry was incompatible with the emitted suspending import even though harness ICU results had settled. A shared async processState helper now enters both setup calls through entryAsync; the recorder and browser boot probe use it. The source digest includes oracle and recorder scripts, so an old startup manifest cannot bypass the repaired stage. In Y1, the unmodified standard `bun run aot` completes strict eight-jar validation (290,828 methods, five existing gaps), records 125 startup files and publishes current.json; full typecheck passes. Log: `tests/e2e/actual/y1-recovery/aot-startup-complete.log`. No browser acceptance or idle timings are inferred.

- Pending callFn reference lifetime (2026-10-05): asynchronous completion now clears the return/throw reference global only when its completion token still owns that global, preserving the original Promise and reentrant results. The existing hostclass lifetime harness adds actual suspending callFn return and throw cases with identity and forced-GC checks: both references remain reachable before the change and both collect after it. Existing 31 hostclass cases plus lifetime checks pass on demand and against the runner's strict four-jar AOT build; fresh shared Worlds initialize through the async process-state helper after binding their own host entry. Full typecheck passes. Evidence: `tests/e2e/actual/y1-recovery/bridge-lifetime-{red,fixed,typecheck}.log`. Parent's separate NativeAllocationRegistry comparison remains retained100/released99 under both variants; this patch does not explain that retained handle, premature native cleanup, or the RenderNode failure.

- Asynchronous location owner callers (2026-10-05): location availability, enablement, last fix, subscription and removal accept asynchronous transport replies. Provider selection, last-location queries, listener registration and related Settings/Wi-Fi reads resolve those replies before choosing results. Provider enumeration checks enabled state once per request. Subscription cancellation marks the local receiver inactive immediately; registration observes replacement/expiry while waiting and removes a late registered owner subscription. An owner rejection retires the current local receiver/timer while retaining the original error. Broker commands and copied event routing remain Y2 integration work.
  - Existing Settings coverage now resolves asynchronous false/true availability and enablement, preventing Promise truthiness from fabricating providers or location_mode. Combined Settings, device-service and data checks pass 47 cases/238 assertions; typecheck passes. Evidence: `/tmp/webdroid-wasm-location-owner-{core,typecheck}.log`. No location hardware, application or performance acceptance is claimed.
- Cold Binder attach continuation cycle (2026-10-05): bounded read-only generator tracing follows `attachApplication` through application bind into launcher `resolveActivity`, where its second `pms()` ask never reaches `queryFor`. `hostedService` cached the constructor's Java suspension promise. `Runtime.drive` joined the first asker's continuation list to that same promise; its later ask waited on itself before the cache's completion observer could replace it. Cache asynchronous construction through canonical `shareable` so callers receive a shared value promise with independent continuation stacks. No scheduling, transaction ordering, Java class or World policy changes. `cold-binder` uses the real AOSP Binder constructor and Java interface-descriptor call, with repeated and concurrent asks: before repair compiled passes, cold fails its 3s liveness bound; after repair both pass six identity/liveness checks, cold executing 1,218 calls. Fresh initializer/caller checks 15 and differential 1,105+2 pass; matched browser evidence remains required. Diagnostic outputs: `conform-cache/cold-review/binder-{red,green,init,diff,aot,typecheck}.log`; resolver trace `caller-main-browser/watch-resolve2.json`.
- Cold slow-operation turn deadlines (2026-10-05, Binder `1188d0ac`, NativeABI `150af08b`, guarded shipping `3235de0c`, async startup delivery `cedfbd4a`): the constructor-cache repair advances through attach/launcher transactions, but the bounded cold-on FitNotes probe still misses launch/render. A full watch continues after boot completion instead of accepting that as presentation: provider queries return and execution progresses into ICU; diagnostic reads then stop being serviced. Slow operations split numeric fuel slices, while an immediately fulfilled async native resets the stack quota and resumes only microtasks. Neither remaining trigger guarantees a turn for such loops.
  - At the existing cold slow boundary, request canonical `yieldFuel` when the host turn deadline is due or the engine stack quota is owed. No effects precede the existing preflight, and the captured strand/depth/peer and held monitors remain intact. Only strands that can suspend and are not executing a synchronous callback may yield. The initial draft lacked the root guard; the OSR fixture caught a pending snapshot on a plain entry, and adding `strand.canSuspend` restores the synchronous contract without relaxing validation.
  - `cold-turns` binds a declared async native identity function and compares the compiled/cold loop arithmetic to the JDK's corresponding Java identity loop; verifies 1,000 actual native calls per mode, cold turn requests, and an immediate plain Java entry. Before repair it computes the right answer but requests zero turns over 3,004 cold slow operations; after repair the deterministic always-due host sees 3,004 turn requests, while the plain entry requests none. A simple synchronous field loop already yields by stack quota; it was a rejected reproducer. Binder 6, initializer/callers 15, slowops/EH 166, OSR 41 and typecheck pass. No browser healthy-launch or performance closure follows these core checks. Evidence: `conform-cache/cold-review/turns-*.log`, `binder-browser/watch-provider.json`; fresh strict eight-jar AOT validates 290,828 methods/five gaps and completes 153-file startup delivery.

- Canonical preference process wiring (2026-10-05, parent `ae160527` / contract `d98bb151`): all four typed preference commands bind the live caller PID and resolve current package UID at the owner. Private reads/mutations and startup file enumeration require same UID or root/system; public notification-policy and battery-exemption reads remain available. Foreign policy writes remain denied. Empty foreign file enumeration checks authority before looking at existing files. Child/Worker access installs lazy operation closures; only the page root installs the direct store. Copied values and granular acknowledged changes retain the contract's canonical map/persistence owner.
  - The existing actual Worker endpoint fixture now covers owner-visible changes, independent array reads, concurrent keys, private and empty-store denial, public delegate queries and denied policy writes. Alongside the existing Java preference acknowledgment case, two focused cases pass 17 assertions; full typecheck and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/worker-preference-{core,typecheck}.log`. An initial fixture expected the wrong test package string; the corrected assertion matches the registered caller. Parent owns the broader data-fixture transport restoration repair; no closed-port production behavior was weakened.
  - Actual APK SharedPreferences XML/FD writes and mappings still require canonical VFS coherence. This wiring does not move notification grouping/posted state or authorize foreign system operations from a Worker; those require the parent's notification-only canonical Binder/helper path. Fresh strict AOT and actual Wasm Worker launch follow; no app/golden/performance acceptance is claimed.

- Production Worker process selector (2026-10-05, after preference wiring `95342cd8`): `processMode=worker` now makes ProcessBroker create an actual application Worker for a newly allocated process. The page owns its canvas, pointer/wheel binding, bounded frame-request stream and copied-control proxy. Launcher identity is assigned before the queued bootstrap. Incoming JVM endpoint publication waits for the Worker ready notice; bootstrap failure, message/control failure, process death and pagehide dispose the owner's ports/input/frame loop and Worker. ActivityStack layers canvases as well as iframe surfaces, and page tree/tap/test-frame commands reach shown Workers. `wd.workerProcesses()` obtains their copied diagnostics rather than reading foreign JVM objects. Existing iframe selection remains the default while remaining contracts are implemented; its URL now also carries explicit cold/process-mode pins.
  - The actual production selector, rather than the prior hand-constructed Worker, launches unchanged FitNotes.apk as PID 1001 in a fresh JS Chromium context and presents its real 45-node welcome tree. It reports ready/alive, 27 ticks, one completed/presented frame and zero draw errors, missing/native-required calls or error logs. Evidence: `webdroid-shots/y2-s5-endpoint/worker-entry-js-selector-preferences.json` (Worker bundle SHA256 `ae32f56fedfa9b5ac0861d0df27e9d58d8624c9701c92a1ec1dc1fed675c7217`), `worker-selector-js-probe.log`; existing endpoint core passes one case/seven assertions and full typecheck/diff check pass. The probe's initial HTML route did not match its query URL and timed out before loading the probe; correcting that diagnostic route enabled the launch. The final pagehide cleanup addition is typechecked after capture. The capture server/browser are closed.
  - This selector does not yet move the first page-realm foreground application into a Worker. Page IME, WebView and complete FD/ashmem canonical backing remain unimplemented, and harness-wide aggregation/rotation/configuration need conversion before Worker parity acceptance. No golden/e2e/performance claim. Standard fresh AOT at `95342cd8` validates 290,828 methods/five gaps but fails aot-startup with ICU.getUnicodeVersion -> System initialization SuspendError, reproducing the parent's guarded-AOT publication blocker; no fresh current manifest is published. Gauss owns that ABI/startup repair. Evidence: `worker-entry-aot-build.log`; no Wasm result is claimed against stale/unpublished assets.
- Worker selector import-order repair (2026-10-05, after `b7d0cc54` and parent cleanup `2a25e925`): the page client now imports a pure copied-control method allowlist rather than evaluating Worker JVM/rendering controls. The first broader data sequence exposed the eager device import as OffscreenCanvas-is-not-defined before fixture startup. Separating the wire names removes that initialization dependency without changing port behavior. The actual existing data sequence now passes 19 cases/152 assertions, including activity transport restoration and preference/path acknowledgment; no rejection or closed-port behavior was weakened. Evidence: `webdroid-shots/y2-s5-endpoint/worker-preference-data-sequence.log`. Typecheck/diff check pass. This is not fresh AOT or Wasm application evidence.
- Canonical notification Worker wiring (2026-10-05, parent hook `c4e777d1`): the two typed reverse commands bind live caller identity. Notification-only lookup enters the root registry through asSystem and rechecks caller lifetime after lazy construction. Foreground start/stop receives the registered package/PID/UID and retains that application caller through the parent's decoder/helper; no supplied identity or system wrapping is accepted there. Child/Worker service lookup selects only notification, while the page retains the local registry/store. The common received-command path now installs serialized Binder transact, which was previously installed only by the iframe's connectProcess. Broader data fixture teardown restores the newly installed service/foreground/Binder hooks without weakening closed endpoints.
  - The existing data/notification/endpoint checks pass 22 cases/177 assertions and full typecheck/diff check pass. A bounded serial real Chromium JS probe boots unchanged FitNotes in a root application owner and another actual Worker (PID 9101, UID 10001). The Worker receives notification Binder `{pid:1000,id:20}` and executes eight real AIDL transactions to that root; all captured outgoing transactions retain non-system app identity. Channel create/read returns importance 3. Posting id 91 creates the root record; foreground id 92 receives flags 96 and canonical automatic grouping creates its summary. Stop removes id 92 while retaining the ordinary post/summary; cancelling id 91 clears the root records. All five operations reply without errors; root error logs are empty. Evidence: `webdroid-shots/y2-s5-endpoint/worker-entry-js-notification-preferences.json`, `worker-notification-{probe,core,typecheck}.log`. The compiled diagnostic fixture adds only framework commands to the actual Worker entry; APK/library bytecode remains unchanged. Initial diagnostic errors were an incorrect grantPermissions argument and a host async callback/generator invocation that did not preserve Java strand entry; correcting the fixture resolved them without production changes. An additional fixture draft delivered diagnostic messages to both its probe listener and the bootstrap handler, producing bootstrap page errors despite successful AIDL replies. The final diagnostic explicitly dispatches its own messages and delegates only bootstrap envelopes to the unchanged entry; the clean repeat has no console/page errors (fixture SHA256 `0e2f4f0639e2e7b993907d5867bb2267f41a6b3a9a6b7420c7c463095737ab7b`). The failed dispatch result is retained as `worker-notification-dispatch-draft.json`.
  - This proves cross-Worker AIDL/root grouping and foreground state on the observed JS path, extending the parent's same-PID fixture. The diagnostic root is a real application owner, not a completed standalone system-server Worker boot. Worker Binder liveness/death subscriptions, FD/mapping coherence, full application/golden/Wasm verification and first-foreground Worker migration remain open. No performance claim or full S5 acceptance. The parent retains Binder/notification owner hooks and pending/alarm/location adapters; Y2 retains typed broker/endpoint and canonical store wiring.

- Integrated recovered delivery and application check (2026-10-05, parent `2b11ae00`): standard eight-jar AOT delivery completes and publishes `aeecaa88768a03a7`, source `f301823adf19fda64d1f914e26e18115a46d3e1ac693c02d4f8275318e323e7a`, with 290,828 methods/five existing gaps and 153 startup files. Restarting the owned dev server picks up the new source-fingerprint helper; its HTTP manifest matches. Binder 6, canonical turn regression, hostclass 31 plus lifetime controls, OSR 41 and typecheck pass. Evidence: `/tmp/webdroid-wasm-recovered-{delivery-build,cold-binder,cold-turns,hostclass,cold-osr,delivery-typecheck}.log`.
  - Unmodified Wasm FitNotes completes 39/39 quick checkpoints, all process reads succeed, browser/error/missing/native telemetry is empty and the existing home-final visual threshold passes (13.92% under 22%). Its observed Wasm counters include 153 AOT files, real entries and completed frames. This uses compiled/cold-off execution and does not close cold-on startup, intermittent RenderNode handles or idle performance. The source stays frozen during capture. Evidence is copied to `tests/e2e/actual/parent-recovery-2b11ae00/fitnotes/`, including manifest, summary and capture log. Goldens remain unchanged.
- Worker diagnostics in the capture reader (2026-10-05, after `18bd56d9`): per-step process reads include copied broker Worker snapshots alongside frame realms. Both reads are bounded; rejected owner reads retain frame results, and incomplete, dead, unready or explicitly failed Worker rows report failure. Worker URLs are diagnostic identifiers prefixed worker: and scoped by PID. Native requirements, error logs and provenance are carried from the actual snapshot, not manufactured as empty success. The current producer still needs trace/placeholder/coverage fields and independent failed-row retention; Y2 owns that runtime work.
  - A temporary Chromium transport check receives copied telemetry from a real Worker, retains its native/error/provenance fields, reports both owner-error and incomplete rows as failures, and retains the healthy root on aggregate rejection. Typecheck passes. No additional permanent test or application/gate claim. Evidence: `/tmp/webdroid-wasm-worker-diagnostics-{check,typecheck}.log`. Integrated notification/data checks pass 21 cases/170 assertions; the existing real endpoint browser check passes one case/seven assertions and typecheck passes, giving the reported 22 cases/177 assertions together.
- Wasm array handle release identity (2026-10-05, after `ce7835f1`): `release` called the public `deref`, which converts an opaque Wasm array into a host view inside a native bridge scope. The reverse handle map is keyed by the original array, so deleting the view leaves a stale handle pointing at the freed slot. Release now deletes the stored identity directly, avoiding conversion and array copying. A real World probe fails before the repair (`before=after=5`, dereference absent) and passes after (`before=5`, `after=6`, live). One case in the existing hostclass suite exercises the actual Wasm array and bridge scope; all 31 differential cases and lifetime checks pass on demand and with four-jar AOT, and typecheck passes. Evidence: `/tmp/webdroid-wasm-handle-key-{red,green,hostclass-final,typecheck}.log`. This is independent of the unresolved RenderNode handle failure.
- Paired FitNotes readiness evidence (2026-10-05): the seven-flow compiled/cold-off quick run at `ce7835f1` captures 105 steps and passes six flows, but FitNotes fails the unchanged home-final visual threshold at 87.69%. A correctly built and HTTP-verified local AOT control at `2b11ae00` reproduces exactly that failure and the missed text targets; a paired current repeat reproduces it again. Home is still loading when Start New Workout falls back to its recorded point, causing later tutorial actions to land one dialog behind. Empty error telemetry does not establish successful interaction. The earlier `2b11ae00` 13.92% visual pass also uses a fallback at 3-save and ends with a loading spinner; it is a harness pass with limited semantic coverage. No Worker wiring regression or performance conclusion is established. Artifacts: `tests/e2e/actual/parent-recovery-ce7835f1/{quick,paired-baseline,paired-current}`. An initial control with a dangling AOT asset link returned index HTTP 404 and was stopped; it remains separate under the managed control's `parent-quick-control/setup-failed`, excluded from source comparison. Goldens are unchanged; readiness investigation remains open.

- Guarded activation carrier cost (2026-10-05, Y1 based on `33dab275`, parent through `e998256d`): capture sites now pass pooled u16 register maps and typed GC bit/reference vectors to one canonical snapshot adapter. Numeric helpers share by bit/reference counts, with raw IEEE reinterpretation at the call site; more than 64 live values use bounded array stores rather than an oversized helper signature. The extra physical helper frame is charged and retired, all transient carrier bytes use the allocation window, and the import-free reader is instantiated through World so its module bytes are counted. The canonical owner/PC/EH/monitor validator and one-time transfer remain unchanged. All original poll sites remain; last-PC stores are omitted only when the following instruction is pure straight-line code with no poll, handler or outgoing edge. Existing typing already includes handler liveness and excludes dead registers. Cold-disabled consumers use an immutable gate to skip activation allocation, epoch comparisons and monitor/String bookkeeping imports. Capture ABI 2 invalidates old worker/app/platform modules; worker adoption compares the actual ABI rather than a boolean.
  - Exact source fingerprint `a4b709525d017f9e249d4300e36e511102f2d7074dee8414c2099a04290bdeda`, shipping key `7eac695d1e7b934d`. Unmodified standard `bun run aot` and the paired standard off command both finish strict eight-jar validation (290,828 methods, five existing gaps), startup recording and delivery. Guarded C: 403,121 KiB including 20,860 KiB traces, 1,176 assigned groups / 1,150 emitted files; D: 38,137 KiB; largest module 4,164 KiB. Off C: 220,679 KiB including 7,081 KiB traces, 1,104 assigned groups / 1,078 emitted files; D: 38,103 KiB. Both use 1,081 assigned D groups plus one extra module. C bytes fall 7.48% from the prior 435,732 KiB guarded cut; they still grow 82.67% versus off, or 78.96% excluding traces. C+D grows 70.51%. Physical 7 MiB module cap and stack/heap quotas are unchanged. Work counters: 1,817,225 capture sites, 7,058,608 live value occurrences, 356,409 pooled maps / 4,898,612 metadata bytes. Compile/startup times in these logs are concurrent diagnostics, not accepted latency.
  - Actual shipping producer/loader `cold-osr --aot` passes 109 checks, retaining all original 84: off consumers call neither make nor blocked, on consumers deopt after real invalidation, native return/throw, monitors and prefix effects remain correct. Added negative long, IEEE NaN payload/signed-zero, reference/null and 65-live-register transfers plus old capture-ABI rejection. Each on consumer observes four transfers with prefix effects once; the printed original-World counters are separate. Threads 72/72, nested entries, differential 1,105 plus two full-width reflection cases, numeric cold 1,290, initializer 15, slow semantics 166, actual persisted app/worker modules, platform aottest and full typecheck pass. No pins/skips. Logs and exact byte evidence: `tests/e2e/actual/y1-recovery/aot-cost-{packed,final}-*` and `aot-cost-evidence.json`.
  - Abandoned inline-vector emission grew C to 460,456 KiB; typed helper and raw-bit sharing plus packed maps produced the final reduction. Poll coalescing and whole-layout helper probes were removed. A first wide fixture lacked a subsequent poll and therefore did not transfer; its generic branch now exercises the actual large-carrier path. Missing Java PATH attempts and a nonexistent cold-resume suite invocation were not passing checks. No browser capture, idle <=100ms G4 proof, G1/G3 cost acceptance, full S4 acceptance, TikTok OOM closure, or native-handle cause is claimed. Remaining instrumented code growth is substantial.
- Fresh Wasm application Worker launch (2026-10-05, Y2 `5cffb1e1`, parent `2b11ae00` including promising startup `d05ac3a6`, pending lifetime `5616978e`, Binder construction `0f92b3c6` and turn deadline repair): standard bun run aot succeeds and publishes build `f9eaf5d37d779d7a`, source `42d23d3c71ce87678e354c084a83e2554363a2b0ac694eb4ae23d1b4202c2a2f`. It validates 290,828 methods with five existing gaps and records 126 startup files. A freshly started isolated server serves the matching current manifest with HTTP 200.
  - The actual application Worker boots unchanged FitNotes.apk in Wasm and renders its real welcome tree: ready/alive PID 9101, 48 advancing ticks, one completed/presented frame, 3,655 Wasm entries and 126 AOT modules loaded. Missing/native-required lists and error logs are empty, drawErrors/wasmGaps/wasmSuspendErrors are zero on this launch path. The same framework diagnostic then passes all five notification channel/post/foreground/stop/cancel operations across Worker-to-root AIDL, retaining the canonical grouped records and app caller identity. No console/page error is recorded. The diagnostic root is a real JS application owner; this does not establish a standalone root system-server bootstrap or all-Wasm multi-process golden parity.
  - Evidence: `webdroid-shots/y2-s5-endpoint/worker-entry-aot-build-current.log`, `worker-wasm-{manifest,probe,server}.log`, `worker-entry-wasm-notification-preferences.json`. The source remained stable through build and capture. Owned server/browser are closed. These structural checks ran while parent diagnostics were active; no idle timing/performance or full S5 acceptance is claimed. Pending/alarm/location owner wiring follows and will invalidate this source's AOT key; first-app migration, Worker diagnostic aggregation/liveness watchers and FD/IME/WebView remain open.

- Worker diagnostic ownership (2026-10-05, after fresh launch evidence `18896024`): copied Worker snapshots include actual missing/placeholder traces, JVM coverage, bootstrapped PID/UID/process/package identity and the available compositor status (currently unavailable/null). The broker records the actual Worker URL, bounds each read at five seconds, and catches rejection/dead/unready/timeout per process so surviving rows remain observable. It retains one unresolved snapshot RPC per Worker across repeated deadlines rather than accumulating requests. Process death closes live owners while retaining the actual URL and failure/exit message as an error row; constructor failures also dispose the canvas and reject the process. No empty telemetry substitutes for an unavailable process.
  - The existing real Worker IPC core fixture passes one case/eight assertions, including surviving rows beside an explicit rejection and an indefinitely pending handler, one pending request across three reads, unready phase failure and retained death cause after owner removal. Full typecheck/diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/worker-diagnostics-{core,typecheck}.log`. Initial fixture TypeScript access lacked narrowing of snapshot/error rows; fixing the fixture guards resolves it without a production contract change. Parent owns tests/e2e/lib/processes.ts reader `ce7835f1`; source integration, fresh AOT and actual Wasm producer/reader verification follow. No all-process golden parity or S5/performance acceptance yet.

- Actual Wasm Worker diagnostic reader integration (Y2, 2026-10-05, source `003301f3`): strict standard AOT key `5bd7d61d12f7148a`, source `4120e9c5757d8efbb3ee753ec15a2b98fa93e415f273c33f1877ebf374476a22`, compiles 290,828 methods/five existing gaps and publishes 126 startup files; the restarted isolated server returns the matching HTTP manifest. The unchanged FitNotes APK launches through the production opt-in Worker selector as PID 1001/UID 10001. The parent reader `ce7835f1` observes an `ok` row at 65 ticks, four completed frames/six presentations, 4,627 Wasm entries/126 AOT files, zero gaps/suspension errors/draw errors, and an idle observed main queue. Missing/native/error arrays are empty; actual placeholder provenance records Typeface.nativeRegisterLocaleList and coverage is explicitly disabled, not fabricated as enabled. After canonical teardown the reader retains the same URL/PID as a failure with the exact owner exit message. Typecheck passes. Evidence: `webdroid-shots/y2-s5-endpoint/worker-diagnostics-{aot,manifest,wasm-probe,merged-typecheck}.*` and `worker-entry-wasm-selector-preferences.json`.
  - Console inspection exposes CSS FontFace registration attempting `document.fonts` in the Worker. The canonical CSS font owner now registers with the actual process realm's FontFaceSet (document in a page, global font set in a Worker); loaded font bytes, axis instancing and descriptors remain the same. This is a concrete presentation boundary defect, so the next fresh AOT check must verify that warning is gone. Directory chmod warnings and the stale JS link-table warning were also present; they are not hidden by the diagnostic reader. This single welcome-render probe is not golden-flow, system-server, semantic onboarding, FD/IME/WebView, idle performance or S5 acceptance. Parent FitNotes seven-flow divergence remains unaccepted and unattributed.

- Worker font and reader repeat (Y2, 2026-10-05, source `9210925a`): fresh strict AOT `ac45892a06368064`, source `cb054ce429532e6a94e672f523cc3ba2f3596c2183aadc5f25b1536a49f7ea8b`, again validates 290,828 methods/five existing gaps and publishes 126 startup files; restarted isolated port 4123 returns the exact manifest. The unchanged FitNotes APK again launches through the production opt-in selector. The parent reader reports PID 1001 alive at 66 ticks, four completed frames/six presentations, 4,628 Wasm entries/126 AOT files, zero missing/native/error/suspension-error/gap/draw-error telemetry and an observed idle main queue. The actual Typeface placeholder and disabled coverage remain visible. The FontFace/document warning is gone; console retains the stale JS link-table warning, directory chmod warnings and the deliberate owner teardown notice. Canonical teardown remains an explicit diagnostic failure with its actual message. This probes the real Worker application entry and page frame sink, not an app substitute. It does not exercise the 39-step flow or establish visual/semantic, FD, IME, WebView, performance or full S5 acceptance. No source mutation occurs during either capture.
  - Evidence is `webdroid-shots/y2-s5-endpoint/worker-font-{aot,typecheck,manifest,wasm-probe,server}.*` plus `worker-font-wasm-selector.json`. The shared `worker-entry-wasm-selector-preferences.json` output is overwritten by the repeat; the prior `003301f3` result remains in `worker-diagnostics-wasm-probe.log`. Full typecheck/diff check pass. Owned browsers and the isolated server are closed. The diagnostic producer's existing real-Worker rejection/hang/phase/death fixture passes one case/eight assertions and verifies repeated reads retain only one hung request while healthy peers survive.
  - Next canonical boundaries remain PendingIntent/alarm/location and ServiceStarts. PendingIntent commands must bind creator UID/process to the port and compare/update serialized Intents using the canonical Android Intent helper; alarms must retain broker system timer ownership across guest death. Location callbacks require process-local callback IDs and generation guards, with only serialized fixes/errors crossing ports and canonical BrowserLocation watch removal on death. First foreground migration needs an actual initialized system Java owner before moving page boot into a Worker; no fake Application/context or readiness marker will stand in for it. Worker selection remains opt-in until those contracts and FD shared backing/offsets, IME and WebView are verified. Parent retains Android adapter/contract files and the reader; Y2 retains broker/bootstrap/endpoints, VFS/FD and presentation/input integration.
- Integrated Worker snapshot identity (2026-10-05, after `d5de6814`): the capture reader verifies the producer's actual PID, process and package against its broker row and preserves its compositor field. A copied but misrouted snapshot is a failure, not another process's healthy diagnostics. A temporary actual Worker check covers copied telemetry/compositor, mismatched identity, incomplete rows and rejected owner reads without hiding the root. Integrated typecheck, existing Worker endpoint case/eight assertions and shipping `cold-osr --aot` 109 checks pass. Standard eight-jar AOT publishes key `0da96bc9b547b1e0`, source `f0d90c906dcd7799e11ecb522f91bd54dbbda222221fc3595fc0166fb9cc4c0f`, validating 290,828 methods/five existing gaps and recording 153 startup files. Evidence: `/tmp/webdroid-wasm-packed-integrated-{reader,typecheck,endpoint,osr,aot}.log`. Fresh HTTP delivery and application verification follow; no full S4/S5 or latency acceptance is claimed.
- Annotation materialization across cold/compiled suspension (2026-10-05, isolated `9618a1cd` source/AOT `36df1cb9766c01ac`): the serial pair renders FitNotes off (9/9) and Calculator off (7/7), while cold FitNotes reaches the outside watchdog and cold Calculator presents no frames. Calculator records 385,816 cold calls / 2,140,635 slow operations; its concrete first error is SuspendError in AnnotationFactory initialization beneath the plain annotation callback, followed by the main-loop failure. These are diagnostics under competing load, not timing acceptance (`conform-cache/cold-review/turns-browser/`).
  - A fresh real annotation fixture also reproduces compiled System initialization reaching a suspending Linux native beneath the plain callback. Annotation Java constructors, boxing, enum initialization and factory calls now use canonical World.callFn on the captured strand; a sequential generator keeps immediate answers immediate and waits only for actual Java waits. The annotation callback has its own conditional park/settle imports, and the intrinsic saves caller strand/thread/depth before entry. Class-loader metadata retains the plain object import. Plain Java entries retain the existing synchronous contract; no class-init or exception result is fabricated. World promotion/deopt is untouched.
  - Fresh compiled/cold checks compare 21 outcomes to JDK: field annotation, enum default whose initializer sleeps, four actual Java threads reading annotations concurrently, and existing sleep/initializer/caller/recursive trace cases. An exploratory probe starting independent host entries on the same Java main thread observed IntegerCache's partial state: those are same-thread class-init reentries, not four concurrent Java threads; the retained fixture uses real Thread.start/join. Differential 1,105 plus two full-width reflection cases, classdiff 33 (eight existing JS-tier divergences), OSR 41 and full typecheck pass. Red/green and gate logs are `conform-cache/cold-review/annotations-*.log`. Actual cold browser startup remains required after a fresh matching AOT build; this core milestone does not close that gate.

- Cold vsync referent initialization (2026-10-05, annotation `a4099d8d` plus parent pending-reference cleanup `5616978e` cherry-picked as `8bb2442c`): fresh strict AOT `e3370be0987d2627`, source `2988770920041f81e7073740a040c505c406bb01b37f831186b3adcc1b2cf053`, delivers 153 startup files and passes all 21 initializer/annotation checks against shipped bytes. The serial frozen pair passes Calculator off 7/7 (presentations 2->80, ticks 240->466) and FitNotes off 9/9 (108->191, ticks 258->826). Calculator on records 388,078 root cold calls / 2,153,861 slow operations, no annotation SuspendError, but zero presentations and a main-loop NPE. FitNotes on reaches three presentations and layout inflation, then an 8 MiB allocation OOM (847,404 root calls / 4,210,857 slow operations). Neither cold run passes launch; no G3 timings are accepted. Outputs: `conform-cache/cold-review/annotations-browser/`.
  - A separate bounded read-only exception/strand watch catches the original Calculator TypeError in `vsync.fill`: `DisplayEventReceiver.nativeInit` stored the two results of Java WeakReference.get without waiting, so a Promise entered receiver state and `frameTimelines[0]` failed at delivery. This native initializer now uses the canonical driven generator, resolving both referents before committing a native handle; declaration of its suspension follows the existing native ABI. No ordering workaround, Java replacement, scheduler/promotion change or exception suppression is used.
  - `cold-vsync` constructs real AOSP VsyncEventData, MessageQueue and Java weak references, using an always-due host turn to require actual cold get waits. Before repair compiled identity checks pass while cold retains unresolved callbacks. After repair 12 checks pass through both direct JNI and the emitted native ABI; cold executes 4,717 calls and observes real waits. Full typecheck passes. Evidence: `vsync-red2.log`, `vsync-abi-green.log`, `vsync-typecheck-final.log`, and `annotations-browser/watch-calculator-exceptions.json` under `conform-cache/cold-review/`. The receiver referent is a plain Java Object because this fixture validates initialization/identity only; actual browser delivery remains the required next gate. The separate FitNotes allocation failure is not closed by this native initializer repair.

- Canonical pending-intent, alarm and service-start commands (Y2, 2026-10-05): Worker reverse commands now bind PendingIntent creation/cancellation to the live registered UID/process and reuse Android's Intent.filterEquals/replaceExtras helper in the canonical Java owner. Only serialized Intents cross; the root helper preserves parcelled extras rather than borrowing a foreign VM callback. Reads, sends, one-shot take and alarm schedule/cancel acknowledge the canonical registry. The Alarms owner and system timers stay in the broker and survive caller death; its existing service dispatch can target the creator's replacement process. Root iframe bindings retain their prior direct path.
  - ServiceStarts exports a synchronous-or-Promise access type. Actual Java creation/delivery, stop/stopSelf, done and foreground decisions await owner acknowledgments. A local in-flight creation promise orders a concurrent start/bind behind creation. Typed commands validate service manifest ownership and process metadata against the port-bound PID before mutating canonical records. Binding publication, serialized service/provider/broadcast calls are installed for Workers too; no ServiceRecords/live callback objects cross realms. Closing a command port rejects pending operations through the existing owner.
  - Existing core files pass 42 cases/992 assertions and typecheck/diff check. The real Java activity-manager fixture runs every ServiceStarts operation through a delayed MessageChannel owner and keeps its expected lifecycle/binding/receiver results. The canonical pending fixture checks foreign-UID creation/cancellation denial, creator process retention, filterEquals/update-current and parcel copy isolation, one-shot retirement, and actual alarm delivery to a registered replacement after creator death. Fixture cleanup restores newly installed pending/alarm/service/provider/broadcast adapters, preserving later checks. Evidence: `webdroid-shots/y2-s5-endpoint/worker-{pending-core-isolated,services-core,services-typecheck}.log`. An initial Bun path filter accidentally discovered old ignored recovery-checkout copies; its six failures are from those archived tests, not this source. Explicit ./tests paths pass and avoid that discovery.
  - No fresh AOT or application/Worker/golden acceptance is claimed for this source yet. Location notification wiring, Binder liveness, first foreground/system Java owner boot, FD shared backing/offsets, IME and WebView remain required. Normal exit versus crash classification also remains an explicit diagnostic acceptance boundary; dead alone cannot establish a failed Android lifecycle.

- Canonical location callbacks (Y2, 2026-10-05): Workers and child realms now use typed availability/enabled/last/subscribe/remove commands; the root alone retains direct BrowserLocation access. Port-bound permission checks protect last fixes and subscriptions using the canonical permission owner. Subscriptions carry a local generation token, with callbacks remaining in the requesting VM. Old-generation events and late removal acknowledgments cannot target a replacement listener; process teardown clears local callbacks, canonical routing tokens and browser subscriptions. Callback work already waiting on a dead owner is discarded after the liveness check; other errors still report. Location timestamps/monotonic origin and actual browser provider behavior remain unchanged.
  - The existing Chromium endpoint fixture passes one case/nine assertions, including real Worker callbacks over the production broker ports, denied owner reads, copied last fixes, stale-generation rejection, explicit remove, peer survival and final browser-watch removal on death. Geolocation positions are fixture inputs to the canonical browser owner, not APK behavior or fabricated platform fixes. Its root VM lacks framework Throwable metadata, so this wire fixture asserts the actual denial message; the actual Java core fixture separately verifies java/lang/SecurityException and a granted null last result. Four selected existing Java cases pass 47 assertions, typecheck/diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/worker-location-{browser,java,typecheck}.log`. Fixture-only development errors (a file-write mistake, a copied callback in a structured message, and a variable shadowing global location) were corrected without changing production authority or weakening denial.
  - This closes the transport contract, not full Worker location/provider or golden-flow acceptance. A fresh integrated AOT/real application check is still required. Android pending/alarm/location/permissions adapters remain parent-owned; Y2 changes only broker/endpoints, the new local callback owner and existing core fixtures.
- Compiled FitNotes semantic verification (2026-10-05, `46ece0e7`): real-clock full capture completes all 39 steps, with no coordinate fallbacks, browser/Java errors or settle timeouts. The UI confirms Barbell Curl 60kg/10 and 65kg/8, then the new Webdroid Press 40kg/12 and 45kg/10. Mean content difference is 7.43%; all frames render. This diagnoses the accelerated controlled-clock divergence, but does not establish whole-matrix or idle performance acceptance. Evidence: `tests/e2e/actual/parent-recovery-46ece0e7/fitnotes-full/` and `/tmp/webdroid-wasm-packed-integrated-fitnotes-full.log`. The same source's actual Wasm Worker selector presents unchanged FitNotes with 153 AOT files, advancing ticks, a healthy copied PID-bound diagnostic row and no FontFace warning; owned teardown retains its exact message. Evidence: `webdroid-shots/parent-worker-integrated/worker-entry-wasm-selector-preferences.json`.
- Integrated canonical stores and cold callbacks (2026-10-05, `49b506b0`): initializer/annotation 21, real vsync referent 12, shipping activation 109, canonical data/content/device/notification 61 cases/1,057 assertions, actual Worker endpoint one case/nine assertions and typecheck pass. Standard eight-jar AOT validates 290,828 methods/five gaps, records 153 startup files and publishes `3f0090d69e0a3524`, source `f1f885c0d878479709aaefff885c16683c969ebd4c80cb98bab6dc43e0add627`; restarted HTTP manifest and index match. Logs: `/tmp/webdroid-wasm-{annotation,stores}-integrated-*.log`. The first store command used two nonexistent test filenames; its 40 cases/992 assertions are superseded by the explicit four-file cut above. No S4/S5 acceptance follows these core checks.
- Accelerated input readiness (2026-10-05, runtime `49b506b0`): stable pixels can describe an activity still loading. Required text actions now wait for their actual target within the existing action timeout; controlled coordinate typing waits for an enabled editable target. The fast lane preserves controlled virtual horizons so a fling can finish before the next input. No real dwell or APK-specific condition is added. The real framework AbsListView.onTouchDown bytecode contains the fling-ending branch (`/tmp/webdroid-wasm-abslist-touch-down.txt`); a tap on an unsettled list can end scrolling before selecting its item.
  - Counterfactuals distinguish both defects: restoring virtual horizons alone still misses the first loaded home; target readiness alone saves the first correct set, but the first custom-exercise tap leaves the list and the subsequent editable-field deadline correctly fails. Combined readiness and original horizons complete all 39 controlled steps, no fallbacks/errors, with all intended sets/exercises in the final tree. The official modified harness repeats this result and passes the unchanged 13.92% home-final visual check. Typecheck passes; seven-flow integration verification follows. Evidence: `/tmp/webdroid-wasm-fitnotes-{horizon,target,target-horizon}-control.{log,json}`, `/tmp/webdroid-wasm-action-readiness-{fitnotes,typecheck}.log`, `tests/e2e/actual/parent-recovery-49b506b0/action-readiness/fitnotes/`. Prior failing controls remain retained, and goldens are unchanged. These loaded-host durations are diagnostics, not accepted performance measurements.
- Accelerated integration gate (2026-10-05, `3a14a23e` harness, runtime `49b506b0`, AOT `3f0090d69e0a3524`): the unmodified seven-flow Wasm quick gate passes 7/7 and captures 105 checkpoints. Per-flow errors/gaps are empty, all process diagnostics return, and the retained visual/motion checks pass. FitNotes has no coordinate fallbacks and its final UI contains the intended Barbell Curl and Webdroid Press sets. Captures share a frozen source/build, run serially, and retain unchanged goldens. Archive: `tests/e2e/actual/parent-recovery-3a14a23e/quick/` with all flows, manifest, summary and log. Host load includes agent work, so the 254.8s duration is diagnostic rather than accepted latency. This closes this quick correctness cut; cold-on startup, main stage/gate performance, full/live/corpus and remaining S5 boundaries are still required.

- Shared method-root guarded capture (2026-10-05, Y1 after parent `49b506b0`, merge `5c2683f8`): guarded methods with multiple poll sites now construct the value vectors once at their root. Each original poll keeps its exact DEX PC and live-register map; outlined chunks return through their existing typed state before capture. A compact unsigned-LEB map pairs each live DEX register with its value in the root's typed union. Single-poll methods retain the prior capture path. Raw long/FP bits and reference kinds remain separate; only the selected PC's live registers enter the canonical snapshot. Ownership validation, String deferral, monitor accounting, depth replacement and once-only cold entry remain unchanged. Contract ABI 3 rejects earlier guarded assets for cold execution.
  - Shared capture stays inside the original Java exception scope. A strand-owned trace scope supplies the actual PC for shared payload calls; catch-all cleanup retires that scope on Java or host exceptions, and normal completion retires it before the tail handoff. Cold caller-PC ordering and outlined Java-frame folding are preserved. The existing OSR fixture retains its 109 checks and adds 20 checks across enabled/disabled shipping consumers: injected capture failure reaches a protected Java handler, releases its monitor, preserves one prefix effect and records one Java activation at the exact protected PC. An initial fixture injected at a guard outside the typed catch's D8 protected range; its escaping exception was expected, and moving an ordinary Java call inside that range makes the corrected check meaningful.
  - Both standard `bun run aot` delivery and `bun run aot --deopt off --out ...` complete strict 290,828-method validation with the same five existing gaps and successful startup recording. Guarded manifest `ee29a24b6e623c8d`, source `186e4da5fbbd483e1715319f1cb168deaa9ffa0544dbd698deb9a32bad62cce9`, includes Gibbs's annotation waits and vsync fix. Actual guarded C files total 375,218,409 bytes, including 13,545,130 trace bytes, versus 226,034,786 / 7,250,585 bytes for off policy on this same source. C growth remains 66.00% (65.31% excluding traces); C+D growth remains 56.30%. The preceding 5fa source had 412,796,105 C bytes; the 9.10% reduction is a cross-epoch comparison including subsequent parent changes, not an isolated latency result. Emitted vector construction sites drop from the prior per-poll 1,817,225 to 285,027, with 1,721,477 carrier values instead of 7,058,608 per-poll values. Original poll counts remain unchanged. Largest union is 1,665 values: deoptimization can allocate larger transient vectors than that PC alone needs, and their full sizes are charged to the existing heap budget. No heap/depth quota is increased.
  - Correctness evidence and exact byte/work accounting are isolated under Y1 `tests/e2e/actual/y1-recovery/aot-root-*`. No browser acceptance or idle timing is claimed; concurrent build/core load makes compile timings diagnostic. G1/G3 cost acceptance and G4's first-activation optimization within 100 ms remain open. Idle follow-up must use the integrated source/key, fresh single browser contexts, jobs 1, default V8 tiering settings and unchanged DEX; align compilation-trace events to first-entry markers and compare progress within that activation against the same kernel's repeated-call baseline. A completed optimization compile alone does not establish execution at optimized speed. Include normal, irreducible and exception-cycle loops, retain yields, and report noisy or interrupted runs separately.
  - Final integrated checks pass without pins/skips: shipping OSR 129 (original 109 retained), threads 72/72, nested entries, differential 1,105 plus two wide reflection cases, cold 1,290 plus four active transfers, slow semantics 166, initializer/annotation waits 21, vsync 12, persistence, aottest and typecheck. Raw module sections attribute 129,825,297 bytes of the remaining guarded/off difference to executable code, 10,211,247 to passive data and 6,294,545 to traces; the original guards and per-PC layout construction remain substantial costs. These builds precede Gibbs's newly confirmed `World.callFn` Compiler-retention repair; his section is reserved, and that gating fix must be integrated before further cost measurements or cold-start acceptance. No attribution to native handle failures is made.

- Y2 shared service creation continuation correction (2026-10-05, follow-up to `31430d46`): `Promise.resolve(rt.drive(...))` preserved the creation suspension identity. Independent Java bind callers therefore joined the cached continuation stack; suspending the first caller after its bind kept the second bind pending behind that caller. The existing ActivityManager fixture now blocks the actual canonical created acknowledgment, starts two Java bind chains, releases creation, and requires the second bind to finish while the first caller remains suspended. Before correction it times out; `shareable` around the driven creation separates caller continuations and the case passes with exactly one create. The owner-created acknowledgment still precedes `s.created`; original error propagation and cache cleanup remain. Both existing activity-manager/provider checks pass; full typecheck and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/service-sharing-{before,after,typecheck}.log`. No new browser acceptance is claimed.
- Y2 pending/service/location integrated Worker launch evidence (2026-10-05, source `27aba4af`, including `31430d46` and `9c34f6f7`): fresh strict AOT key `0d60265aaf694eea`, source `82d2401bc069f8691ad24923701af819f36f9d49c399ab61a5d8000a36f95056`, validates 290,828 methods with five existing gaps. Restarted isolated server 4123 serves the matching manifest. The unchanged FitNotes production opt-in Worker selector reaches PID 1001 ready and visible; integrated reader reports healthy diagnostics, 62 ticks, 4 completed frames, 6 presentations, 126 loaded AOT files and 4,627 Wasm entries. Observed missing/native/errors, gaps, suspension and draw errors are empty/zero; real placeholder and disabled-coverage state remain reported. This is application entry/presentation coverage, not real APK coverage of every pending/service/location command, system-owner boot, IME/WebView/FD completion, semantic golden acceptance or idle performance. The root system Java owner is not booted in this probe. Intentional teardown retains its exact cause. Evidence: `webdroid-shots/y2-s5-endpoint/worker-stores-{aot.log,manifest.json,wasm-selector.json,wasm-probe.log}`. Owned server and browser are closed.

- Y2 first foreground application Worker with a real system Java owner (2026-10-05, based on merge `e8f60ba1`, parent `49b506b0`, retaining shared-service correction `74a48cd9`): the normal opt-in launcher previously bound the first application in the page VM. `shell/system-boot.ts` now fixes system-server identity/64-bit ABI, indexes only the platform, releases the Wasm startup-code gate without application DEX, starts the existing zygote/main looper and invokes bundled `ActivityThread.systemMain()` on the main queue. That real Java method builds the system Context, Instrumentation and Application; no fabricated application replaces it. The registered android/system_server endpoint is ready only after systemMain completes. The selected app archive/resources/signing metadata are registered with canonical installed sources; original split sources belong to the package rather than a root app and are retired on package removal. The application's unchanged bootApk runs in the first allocated Worker; provisioning follows its shown acknowledgment and runs in separate Workers. Worker mode remains explicitly opt-in.
  - Actual normal-page JS and fresh Wasm launches both report the root Java Application package `android`, Process.myUid 1000, visible FitNotes PID 1001 and real microG process Workers. The final Wasm read waits for all allocated Workers to reach ready rather than treating a provisioning startup row as acceptance: page plus PIDs 1001, 1002, 1003 all report healthy diagnostics, with empty observed missing/native/errors and zero Wasm gaps/suspension/draw errors. Root reports 613 ticks/89 loaded AOT files; FitNotes reports 120 ticks/126 loaded AOT files, 47 completed frames and 50 presentations. These counters establish observed rendering/startup coverage, not idle performance or full app-flow correctness. The real Typeface placeholder remains reported.
  - Strict AOT validates 290,828 methods with five existing gaps, final key `7f5c086ac929eacb`, source `2eefa9f6cfe0a15a18db7c1be473eca4ff11af0d7ae56513e36a6a3f7a2ae50e`; isolated server 4123 was restarted and served matching HTTP 200 manifest. Full typecheck, both existing activity-manager/provider core cases and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/system-owner-{aot.log,manifest.json,typecheck.log,core.log}`, `system-main-{js,wasm}.{json,log}`; ignored repeat driver `system-main-probe.ts` uses the normal production launcher, with no platform or app route substitutions. An initial probe mistakenly treated an async polling predicate as ready, then another read caught a still-starting provisioned Worker; neither is accepted evidence. The retained explicit host polling verifies all current Worker rows are ready before reading diagnostics. The final script exits and owned server closes. IME/WebView, canonical FD/ashmem/VFS coherence, Binder death/liveness, expected-exit classification and complete unchanged app/corpus/WebView gates remain open; this milestone is first foreground/system-owner boot, not S5 acceptance.
- Cold bridge Compiler retention (2026-10-05): the annotation/vsync source `a4046754` with matched AOT `f81e0132d0b2e7f3` advances beyond attach and frame delivery but still fails cold startup. Stored Throwable field reads locate Calculator's rejected `wd.uiTree()` in `AccessibilityNodeInfo.obtain` -> its accessibility provider: the tab reports 2.92 GB used JS heap, 80,643 slow modules and 892,697 root cold calls. FitNotes reproduces layout-inflation OOM at 2.97 GB used heap, 70,021 slow modules and 846,811 calls. The exception's 8 MiB number is the allocation-window marker emitted by `allocSlow`, not evidence of an 8 MiB requested array; its printed 512 MiB free count is a fixed message value, not observed free memory. Heap sampling reports 2.66 GB live sampled allocations with substantial per-helper Compiler/import/type-table data; a separate 12,505-method typing sample retains about 53 MB after GC and does not explain the whole excess.
  - A controlled Node sample retaining 1,000 executable `callFn` and 1,000 `hostFn` helpers keeps 1,000/1,000 call compilers alive versus 0/1,000 host compilers. The persistent token/caller closure shares its construction scope with the emitter callback. `World.callFn` now constructs the helper in a separate method activation and keeps only executable and completion globals. Caller strands, token ownership, result/throw reference release and emitted Java behavior are unchanged. The identical controlled sample now retains zero compilers on both paths, with the World and all 2,001 instantiated modules still live (sample heap 58,236,744 -> 31,840,096 bytes; this is not a browser performance acceptance claim).
  - The existing host-class lifetime suite adds one live executable bridge whose Compiler must collect, and passes 31 cross-tier cases plus the lifetime checks. Full typecheck passes. Cold slow operations pass 166 checks on the fixed repeat and pre-fix control; the first fixed run failed its contended suspended-monitor ordering assertion with `20,1,...,19` instead of `1,...,20`, so that observed scheduling-sensitive failure remains reported rather than weakened. Evidence under `conform-cache/cold-review/typing/`: `retained-compiler{,-green}.log`, `hostclass-green.log`, `typecheck.log`, `cold-slow{,-baseline,-fixed-repeat}.log`. Browser failure profiles are under `conform-cache/cold-review/typed-failure/`. Fresh matched AOT/browser startup remains a required next check; this core retention proof alone does not establish healthy app startup.

- Display capture composition (2026-10-05, runtime `bbf33981`): the page probe reads canonical visible canvas layers bottom to top after presentation, counts only shown canvas transfers, and composites translucent layers for hashes, snapshots and shots. A temporary Chromium bitmaprenderer check observes opaque root red, opaque Worker blue, mixed red/blue `[127,0,128,255]`, and ignores a hidden canvas transfer. Typecheck passes. The first unmodified controlled FitNotes run aborts at Graph after 18 completed steps with `Proxy(JThrowable)`; an exact runtime/AOT control using the prior probe completes 39/39. A composite-probe diagnostic repeat also completes all 39 steps with intended data. This does not identify or waive the intermittent guest failure. Evidence: `tests/e2e/actual/parent-recovery-bbf33981/{canvas-capture,canvas-baseline,canvas-diagnostic}` and `webdroid-shots/parent-worker-integrated/canvas-capture-probe.{ts,json}`. Application Worker pixel acceptance and idle performance remain open.
- Y2 canonical displayed-canvas API (2026-10-05, follow-up to first foreground Worker boot `97fd3ea1`): `wd.displayCanvases(): HTMLCanvasElement[]` returns the page root canvas followed by live, shown process surfaces in ActivityStack bottom-to-top layer order, excluding hidden surfaces and duplicate root references. Worker surfaces use their page-owned canvas; same-origin iframe surfaces use their own #screen. `wd.displayCanvas()` returns the top canvas. Translucent top activities retain underlying shown layers. This is an observation API, not a compositor or product UI change. Parent owns probe/actions/capture and must consume the actual layers rather than treating the root system canvas as app pixels. Full typecheck and existing real-Worker owner core pass on the combined Y2 draft containing this API; separate integrated capture remains required. Prior first-foreground evidence established real Java identity, Worker startup and presentation counters, not a scored Worker bitmap/golden capture.

### Y2: Visible Worker diagnostics and queue liveness

`wd.visibleWorkerProcesses(ms = 1500)` returns shown Worker rows bottom-to-top with the canonical PID/package/process/URL, copied snapshot or explicit error, and a separate `alive` main-queue acknowledgment. Snapshot reads have a five-second bound and share one outstanding request per PID; liveness waits share one outstanding queue request per PID, return false on timeout/close/death, and release their owner on process death. `wd.foregroundWorkerSnapshot()` returns the same bounded diagnostic row (without liveness), or null when the foreground has no Worker owner. `wd.alive(ms)` now checks every shown Worker's actual main queue when Workers are visible; the legacy root check remains for other displays. A control-channel reply alone does not establish Java queue liveness.

Worker snapshots additionally copy pending yield count, yield counters, timed-park count, vsync scheduling, pending transitions and actual realm WebView info. Perf counters remain cumulative within each Worker; a harness can difference copied per-PID counters without mutating the owner. Logs/missing/native/coverage remain copied owner diagnostics. The existing Chromium ownership fixture distinguishes a healthy queue from a replying owner with a held queue reply and proves repeated polls retain one pending request. Typecheck and the combined existing browser ownership fixture pass; IME draft checks are included in that working-tree run. No fresh AOT/application capture, Worker WebView support or full S5 acceptance is claimed.
- Guarded alias checks and snapshot allocation accounting (2026-10-05, Y1 after `28a82c15`, Gibbs dependency `101e9a9a`): only methods containing String allocation or direct String construction emit the blocked-alias poll. Compiled resume already rejects incoming uninitialized aliases, and only that activation's own String operations modify its blocked count. All methods retain the epoch check, ownership validation and exact-PC handoff. The existing shipping fixture invalidates during evaluation of a String constructor argument; it must remain compiled until construction commits, then can hand off with the completed String. Native bindings use the normal native source so this actually loads shipping C modules rather than silently falling back.
  - Capture allocation now charges the canonical snapshot's known buffer payload (8-byte register bits, 8-byte reference slots and one-byte kinds) alongside the full union vectors/map. A 65-register shipping capture with 1,000 bytes left in its allocation window consults the actual process heap owner before snapshot creation. Removing the snapshot charge makes that check fail; restoration passes. This exercises the existing heap-window policy and collection owner, with no fabricated GC success, quota increase or application/OOM causality claim. The largest observed union remains 1,665 values and its full transient payload is charged; snapshot buffers can exceed the selected PC's live set.
  - Shipping OSR passes 141 checks, retaining the previous 129; threads 72, diff 1,105+2, initializer/annotation 21, vsync 12, slow semantics 166, cold 1,290, nested, persistence and typecheck pass. Gibbs's unchanged call-bridge Compiler lifetime repair is integrated locally as `28a82c15`, and hostclass's actual retention check passes on demand and against four-jar AOT. Standard guarded and off delivery both validate 290,828 methods/five existing gaps and complete startup. Guarded key `c067468d5214c4a7`, source `e1b43aa4a35802ea9b6a8803ab537feb49b755ef6c1064c882613d623f84aa50`: actual C bytes 357,104,964 versus 226,034,786 off, still 57.99% growth. C size is 4.83% below the preceding root-capture source, a cross-epoch comparison including the retention dependency. Exact evidence: Y1 `tests/e2e/actual/y1-recovery/aot-alias-budget-*`. Compile times are noisy diagnostics; browser cold-start OOM acceptance, G1/G3 and idle G4 remain open.
- Guarded last-PC emission (Y1, 2026-10-05, base `d193d62b` including retention `bbf33981`): methods without Java handlers commit last-PC at outgoing branch/switch/goto or fallthrough boundaries; internal polls materialize the statically known predecessor only when invalidated. Handler-bearing methods retain per-instruction writes so throwing instructions preserve committed state. Both taken and fallthrough branch snapshots are checked through shipping AOT; disabling the pre-branch write is a red control, restored code passes all 153 checks (prior 141 retained). Diff 1105+2, cold 1290+4 transfers, slow 166, nested, threads 72/72 and typecheck pass. Standard guarded and off delivery each validate 290,828 methods with five existing gaps and complete startup (125/164 files). Guarded key `ac692f2c09ca3e02`, source `7072504ef2a21d071c4d71deb21c5ad9c6d95bf8ba611bc1d68d357387adc690`; actual C bytes 352,631,245 vs matching off 226,034,786 (56.01% growth), 1.25% below preceding alias/budget milestone across the parent integration epoch. Exact evidence/logs: `tests/e2e/actual/y1-recovery/aot-boundary-pc-*`. Shared-load compile times are diagnostic, no accepted G1/G3/G4 latency or browser claim.

- Joined guarded condition (Y1, 2026-10-05, follows `0773547d`): immutable 0/1 cold-enabled and mutable epoch inequality are combined with Wasm i32.and before the capture branch. Global reads have no side effects; String alias safety and all capture boundaries remain. This removes one nested if/end per site without adding a host call or activation allocation on cold-off. All 153 shipping execution checks and typecheck pass. Standard guarded and matching off AOT both validate 290,828 methods/five existing gaps and finish startup (125/164 files). Guarded key `d6e404282b7d4beb`, source `5df85b9958705bb56db2f8e054f7f2a3b508f8cab7843f7445222ca1f926581b`; C bytes 348989147 vs 226034786 off, 54.40% growth. Reduction from the preceding same-base PC milestone is 3,642,098 bytes; 1,817,225 capture sites, 285,027 carriers and all payload counters are unchanged. The instruction removal accounts for 3,634,450 bytes; remaining packed metadata/trace offsets account for the residual. Evidence: `tests/e2e/actual/y1-recovery/aot-joined-guard-*`. Build timings remain noisy; G1/G3 cost risk and default-engine first-activation G4 <=100ms proof remain open pending an agreed idle measurement window.

- Integrated Worker capture and readiness (2026-10-05, runtime `1ac5d96e`, AOT `8eae625bb8b70e77`, source `462683ea3c6639c88019e4eae254f45fb1d799af74e1dc4fc4378299fa45c109`): standard eight-jar delivery validates 290,828 methods/five existing gaps and records 153 startup files; typecheck, shipping OSR 153 checks and the existing Chromium process endpoint case/nine assertions pass. The probe now samples actual displayed canvases, reads foreground queue/vsync/yield state, differences cumulative Worker counters by PID and includes copied owner errors/WebView/native/missing state. Main-queue liveness checks every shown Worker separately from control-channel responsiveness. Calculator captures all eight checkpoints and its result differs from the unchanged Android reference by 1.17%, but the run fails: PID 1003 is still loading resources at launch diagnostics and Back returns undefined to a Promise consumer. Those failures remain open; no Worker gate is accepted. Archive: `tests/e2e/actual/parent-recovery-1ac5d96e/worker-calculatorm/`.
  - The diagnostic reader now re-reads initializing Worker rows within the same two-second startup allowance used by frame readers; stuck, dead, incomplete, foreign-identity and rejected owner rows remain failures. A temporary Chromium/real-Worker copy check retains actual telemetry, observes initializing-to-ready progress, rejects a stuck row after its bound, and retains root results when the owner rejects. Typecheck passes; source/log: `webdroid-shots/parent-worker-integrated/diagnostic-reader-readiness.ts` and `/tmp/webdroid-wasm-worker-reader-readiness-check.log`. This is observation readiness, not a longer guest settling delay or a waiver of initialization failure.
- Cold monitor-order assertion classification (2026-10-05, retention parent `a4046754` versus `101e9a9a`): frozen source snapshots use identical bytecode, native callbacks and explicit host-turn admission controls. With no pre-lock turn both return `1,...,20`; with one turn due for request 0, both reproduce the original failure `20,1,...,19`. Strand tracing locates that turn at `serialAwait` PC0 with zero held monitors, before its first lock. Requests 1 through 19 acquire and increment first, then request 0; every acquired increment has canonical monitor depth 1. The fixture's array followed invocation order even though its assertion concerned acquisition order. Real JDK threads with the same two admission schedules return the identical sequences. This is a classified pre-lock scheduling effect on both sources, not a repeat-green regression waiver or a runtime monitor change.
  - `cold-slow` keeps the original strict queued-monitor assertion under an explicit fixture HostLoop admission control, then adds a fresh World with a real pre-lock turn, exact JDK sequence comparison, linearized increments and held-lock-depth checks. The remaining fixture cases retain their default host loop. All 171 checks pass on the current merged source and on both archived source cuts; full typecheck passes. Original failing assertions and per-strand evidence remain under `conform-cache/cold-review/monitor/`: `{baseline,fixed}-{first-held,none,strengthened}.log`, `jdk-{first,none}.log`, and `current-strengthened.log`. The source snapshots are `101e9a9a^` and `101e9a9a`, not reconstructed from current main.
  - The retention-fixed serial browser cut uses source `101e9a9a`, AOT `1782dde351724e10`, source digest `95b3d10a19fd2901fd704c886e134ce097dfa6dd5c009e4c404a36aedb56ddd3` (290,828 compiled methods, five existing gaps, 153 startup files; HTTP manifest/index/startup verified). Calculator off passes 7/7 and FitNotes off 9/9 in these shorter probes. Calculator on renders 88 nodes, presentations 4->5->17 and ticks 7074->7454->8130 over launch/keypad/7; its display changes 0->7 with zero observed errors/missing/native requirements. The 180s overall watchdog closes its browser before the remaining taps, so no full-flow pass is claimed. FitNotes on renders launch (434 presentations, ticks 8646, 1,388,082 cold calls) and unit selection (619, 9627, 1,619,479), then welcome confirmation reports a 3s alive failure whose probe callback eventually answers after about 10.2s (632 presentations, ticks 10658, 1,842,257 calls). No guest OOM/error/missing API is observed, but this is an unresolved liveness failure. All owned browsers close. Outputs: `conform-cache/cold-review/retention-browser/`. This cut predates the current ABI3/Worker/main-harness merge; healthy entire-flow and G3 acceptance remain open.

- Guard/Worker-observation quick cut (2026-10-05, runtime `1ac5d96e`, harness `a437162c`, matching eight-jar AOT `8eae625bb8b70e77`): the unmodified serial seven-flow gate passes 7/7 and 105 checkpoints, all per-flow errors/gaps empty and unchanged golden limits satisfied. FitNotes completes 39 correct-data steps; Komikku 23; Mihon app 17/onboarding five; Calculator eight; Flappy Bird seven; Doodle Jump six. Archive `tests/e2e/actual/parent-recovery-a437162c/quick/` retains each capture, summary, log and exact manifest. Duration 253.6s includes active agent load and is not accepted performance. This verifies this cold-off/frame-process correctness cut, not full S5 or intermittent failure closure. The integrated controlled-JDK monitor fixture subsequently passes all 171 checks (`/tmp/webdroid-wasm-monitor-admission-integrated.log`).

- Y2 routed back acknowledgment (2026-10-05): the page's `wd.back()` returned undefined when ActivityStack routed back to a child/Worker, which violated the harness's Promise operation contract. It now always returns an async operation; ActivityStack returns null for local dispatch and a Promise for routed dispatch. That Promise settles after the existing serialized activity queue receives the owner's back acknowledgment, propagates its failure to the caller, and leaves the queue usable. The existing activity-manager core adds a held owner reply followed by a failed reply and a successful third dispatch (9 assertions); typecheck and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/worker-back-{core,typecheck}.log`. The first fixture attempted Bun's Promise rejection assertion before releasing its gate and timed out; the corrected fixture attaches an ordinary rejection handler and checks it after releasing the gate. Parent's Calculator bitmap evidence is separate; no new browser/AOT acceptance is claimed by this correction.

- Routed activity queue completion follow-up: review found that the initial back and pre-existing bringToFront outer Promises could remain pending when target/previous-entry lookup threw before creating the activity Promise. Both now return enqueue directly. enqueue returns the original task Promise while assigning its reporting catch to the serial queue tail; callers receive failure, and ignored task rejections are still observed and the next task can run. The existing core adds early lookup failure in back and bring-to-front, retaining the held acknowledgment, owner rejection and successful subsequent task checks (12 assertions). Typecheck and diff check pass. Caller audit: awaited launch/finish/background now receive actual task failures; process death cleanup and presentation intentionally ignore completion but remain reported; broker activityLaunch/activityFinish retain queued acknowledgments and their unawaited observers, preserving the documented avoidance of lifecycle self-deadlock. ProcessBroker.launch.shown propagates bring-to-front failure to main's existing failed-launch path. Existing pause/stop timeout semantics are retained. Evidence remains `webdroid-shots/y2-s5-endpoint/worker-back-{core,typecheck}.log`; no additional app/AOT acceptance is claimed.

### Y2: Worker IME ownership and late extracted-text reports

Bootstrap transfers an optional IME port through both structuredClone and the actual Worker endpoint hop. The page owns one hidden text control per process canvas; the Worker retains its real Java InputConnection callbacks. Input/selection/composition/action commands capture editor generation and check it again inside the Java main queue. One command is outstanding, pending consecutive edits coalesce, and editor replacement drops stale pending commands. Canvas visibility controls focus; real pointerdown schedules refocus after the browser's default focus action. The exact timer and DOM/port owner close on replacement, failed bootstrap, process exit or page teardown. A failed replacement retains the previous published owner. Copied Worker control type/enter and the shared existing swipe implementation target the foreground owner; scheduled gesture uptimes retain the existing catch-up semantics.

An unchanged Wasm Worker FitNotes probe exposed a generic IME bug: page input made the Java Editable `60` while the IME mirror became `6060`; a later copied `65` edit produced Java `605`. imeInput's optimistic text update preceded an asynchronous partial ExtractedText report, which was then applied to the already edited text. Partial reports now use a separate last-reported baseline, and report metadata is captured before suspension. Android documents partialStartOffset/partialEndOffset as the replaced range, with -1 denoting a full report ([ExtractedText reference](https://developer.android.com/reference/android/view/inputmethod/ExtractedText)). The existing data fixture reproduces `6060` before the correction and verifies both the reported mirror and actual bundled BaseInputConnection Editable across `60` then `65` afterward. A second core check holds the Java main queue and replaces the editor before a queued edit, proving the old generation cannot mutate either editor.

Full existing data checks pass (21 cases/162 assertions), endpoint/browser ownership passes (10 assertions), bootstrap replacement/failure/death ownership passes (6 assertions), typecheck and diff check pass. Fresh strict AOT compiles 290,828 methods with the same five existing gaps and records 126 startup files; manifest `46065b24943f241d`, source `515fdd0a22c3d5ec0802cddca12125de9f5dd1df0071179d72c1a8e553f3ef66`, HTTP 200 after restarting the isolated server. On merged source e015085a plus this draft, normal production Worker boot of unchanged FitNotes accepts actual page pointer/keyboard text `60` and copied wd.type text `65` into its Java weight editor. The reviewed canonical canvas bitmap displays 65. Visible PID 1001's Java queue acknowledges liveness and presents 162 frames; all three Worker rows are ready and load 126 AOT files each, with no observed missing/native-required entries, draw errors, Wasm gaps or suspend errors and no console/page errors. This is observed typing coverage, not a scored full flow, composition/action parity or an idle performance claim. The earlier failing app repeat and passing core reproduction remain recorded; the passing app source also includes subsequent parent guards, so the core red/green check is the matched mechanism proof.

Evidence under `webdroid-shots/y2-s5-endpoint/`: `worker-ime-{browser,bootstrap,late-report-before,late-report}.log`, `worker-ime-fixed-{data,typecheck,aot,manifest.json}`, `worker-ime-app{,-first,-repeat-before}.json`, `worker-ime-app.png`, and repeatable `worker-ime-app-probe.ts` with before/fixed logs. Owned browser/server drivers have exited. WebView DOM/renderer ownership, canonical FD/ashmem/VFS sharing, expected exit diagnostics and remaining actual Worker app gates remain mandatory; the production selector remains opt-in. Parent owns capture/readiness/observability harness files.

- IME fixture type correction: the final bootstrap ownership assertions added after the earlier successful typecheck used ProcessBroker.entry, which is private. They now retain the actual entries returned by connect. The follow-up full typecheck passes with the terminal-diagnostics draft, without exposing a new production accessor. Include this correction when integrating the IME milestone.

### Y2: Canonical Worker terminal diagnostics

Worker diagnostic rows now retain a copied `terminal: {expected, cause, record}` on death. Healthy rows still carry actual copied snapshots. A successful self-exit (reason EXIT_SELF, status zero) or USER_REQUESTED record is expected only when canonical death is not a crash. Expected terminal rows have identity and terminal evidence, no live snapshot and no error; unexpected terminal rows retain the error and record, including nonzero self-exit, Java/native crash, unknown signal, startup/control failure and death without a record. NOT_CRASHED by itself is insufficient. Pending snapshot failures consult canonical terminal state after death rather than losing an acknowledged expected exit to a generic port error. Returned terminal records are fresh copies. The broker's explicit force-stop supplies USER_REQUESTED unless its caller provides a more specific kill note; a guest's actual crash record still controls crash classification.

The existing real-Worker bootstrap/exit fixture covers exitProcess code zero, code seven, broker force-stop, and a repeated crash delivered through the actual process endpoint. It checks reason/status/classification, copy isolation and timer teardown while the owner clock survives. The existing diagnostic fixture holds a snapshot reply, publishes an exit over a PID-bound command port with deliberately foreign payload identity, then checks that the pending diagnostic returns the canonical bound PID and successful terminal record. Unknown fixture death still retains its error. Both existing Chromium core fixtures pass (6 and 10 assertion groups), full typecheck and diff check pass: `webdroid-shots/y2-s5-endpoint/worker-terminal-{core,pending,typecheck}.log`.

Parent's reader must explicitly consume expected terminal rows as lifecycle evidence, not fabricate a healthy JVM snapshot or ignore unknown failures. No harness file is changed here. No fresh AOT/app gate is claimed after this production change; the preceding IME app evidence is on its recorded source/build epoch. Terminal classification does not implement Binder death subscriptions or suppress guest kills. WebView/FD/ashmem/VFS and remaining Worker app gates stay open.

- Cold activation Compiler lifetime (2026-10-05, after `9019afe7`, production cut `1ac5d96e`): the serial matched browser pair used local AOT `8eae625bb8b70e77`, source `462683ea3c6639c88019e4eae254f45fb1d799af74e1dc4fc4378299fa45c109`. Cold FitNotes rendered launch and metric, then failed the strict alive gate at welcome dismissal (14.6s delayed queue probe); Calculator rendered launch then returned an empty keypad UI tree. No complete cold-on flow passes. The separate FitNotes off control failed in RenderNode.nGetElevation during categories accessibility capture; its original throwable is retained, but native handle and DEX PC were not captured. No baseline waiver or idle timing claim applies.
  - A bounded, read-only WeakRef/PC diagnostic reproduced welcome dismissal liveness failure (7.3s delayed probe), with advancing PCs through SQLite and View traversal rather than one fixed Binder PC. CPU sampling recorded 44.6s GC, 8.7s snapshot copying, 6.7s module compilation and 4.0s instantiation; sampled live allocation stacks retained 1.62GB. This diagnostic includes tracing overhead and competing-load risk. Root slow-module cardinality remains about 80k; sampled allocation stacks are not a complete V8 native module-metadata census.
  - Separately, keeping 100 real cold-unit exports reachable retained all 100 emission Compilers after five actual host turns and collections (24,535,760 observed Node heap bytes). Cold-unit activation callbacks and PC trace closures shared the emitter scope. Building those callbacks in a separate factory releases all 100 Compilers while preserving 100 live exports / 112 instances (20,776,192 bytes in the candidate control). The factory keeps method, interpreter, strand, pending-result/EH and promotion ownership unchanged; generated Wasm emission is unchanged. An installed-method regression observes its Compiler, requires collection, and executes the retained method again afterward. Cold-slow passes 175 checks, ordinary cold OSR 41, initializer/annotation 21 and full typecheck. Evidence lives under `conform-cache/cold-review/{current-browser,typing}`. This closes another retained emitter graph, not the remaining slow-module cardinality or mandatory healthy cold-on application flow.

- Idle gate preparation (Y1, 2026-10-05, production base `be0a915f` / retention `bbf33981`): added standalone browser G4 progress windows for ordinary reducible, checked two-entry irreducible and exception/monitor cycles, with unchanged fuel/scheduler behavior; full first invocation and later reference samples remain distinct. Mechanism controls pass all eight kernel/descriptor cases at n=4,096 and odd-entry irreducible/EH/field cold-on controls at n=65,537. Actual production native crossings, string/primitive-array copies and facade reads are counted with independent result checks. Chrome default-engine traces plus emitted wire import/function/body metadata correlate a unique module to optimized root/chunk functions inside the first invocation; this shared-load short control proves attribution only, not the <=100ms speed gate. Module.imports omits enabled js-string builtin imports, so the metadata reader counts imports from binary sections; the earlier API-based diagnostic mapping is superseded. G1 has explicit cold policy, alternating JS/Wasm order, source/DEX fingerprints, selected/blocked/failure and completed-call reporting; one casts diagnostic pair completes correctly. Raw page+Worker CPU profiler control captures both targets without errors; canonical process-diagnostics callback is required for actual Worker counters. Self attribution control assigns 90us native work, 5us boundary and 5us unresolved rather than charging the whole native subtree to boundary (5%-10% bounds). Unmapped Wasm/World/JNI/ABI frames remain unresolved. Final typecheck passes. Exact run/review protocol: `docs/wasm-gate-measurement.md`; ignored evidence `tests/e2e/actual/y1-recovery/gates-*` and `boundary-*-control.*`. All reports remain accepted:false; host load ~12 on 14 cores, no idle latency, actual heavy-tap capture or G1/G4/G5 closure claimed. No production compiler/runtime source changed in this preparation.

- Guarded serialized-cost attribution (Y1, 2026-10-05): `aot-size.ts` accounts for every C-module byte in the matching `be0a915f` guarded `d6e404282b7d4beb` and off build. Total growth is 122,954,361 bytes: code 107,114,828; data 10,211,247; AOT trace 2,728,725; types 1,550,014; function names 725,488; imports 447,693; AOT headers 87,085; function declarations 84,700, with remaining section/framing differences in the exact ledger. Executable emission accounts for ~87% of the increase, passive data ~8.3%; trace/header reduction alone cannot remove the material code-size risk. Both builds previously passed full strict validation and standard startup. Evidence `tests/e2e/actual/y1-recovery/aot-section-cost.json`; byte totals reconcile to all files. This is static attribution, not retained heap, compile/CPU timing or G1/G3 acceptance.
  - The local cold probe now retains rejected Java Throwable message/cause/backtrace fields in the original realm and rethrows the same object; it does not invoke Java for diagnostic formatting. Optional profiling saves live heap allocation sampling alongside CPU samples. Successful and rejected paths record observed tab heap sizes. The overall diagnostic deadline is explicit/configurable independently of existing per-step correctness/liveness limits; expiry records its own mechanism and closes the owned browser before exit rather than reporting only the resulting TargetClosed error. The latest merged `1ac5d96e` cut passes 171 cold-slow checks and full typecheck; strict local AOT `8eae625bb8b70e77`, source `462683ea3c6639c88019e4eae254f45fb1d799af74e1dc4fc4378299fa45c109`, compiles 290,828 methods with five existing gaps and delivers 153 startup files. Further browser evidence is required; no timeout extension is a correctness or performance waiver.

- Integrated Worker input/exit verification (2026-10-05, runtime `46d9cf5f`, eight-jar AOT `b8607f64217e9050`, source `e43e8724f7a72e718298111ea42ae823228911ff123979b7c43a705f6e9996b5`): typecheck, 175 cold-slow checks and 153 shipping OSR checks pass; activity/data integration passes 24 cases/176 assertions and two real Worker fixtures pass 16 assertions. Standard delivery validates 290,828 methods/five existing gaps and records 153 startup files. The unmodified actual Worker Calculator flow passes all eight checkpoints with 1.17% result difference, advancing foreground ticks and clean copied root/three Worker diagnostics. Back no longer rejects its Promise consumer. Worker FitNotes renders all 39 checkpoints and retains the intended 60/65 kg Barbell Curl and 40/45 kg custom-exercise sets; it fails at new-save when the root system owner reports a missing window Binder service and ToastPresenter layout inflation failure. The foreground Worker continues rendering with empty own errors/missing/native diagnostics; this does not waive the root failure. Goldens are unchanged. Evidence: `tests/e2e/actual/parent-recovery-46d9cf5f/{worker-calculatorm,worker-fitnotes}/`. Both captures ran with competing agent work and are not accepted performance measurements; S5 remains open.

- Shipping-AOT differential entry contract (2026-10-05, runtime `46d9cf5f` / measurement-tool cut `443039d3`): the integrated 31/31 framework exercises pass over standard AOT `b8607f64217e9050`. The core differential fixture intentionally pre-resolves ICU for ordinary synchronous compilation, but shipping AOT retains its emitted suspending import ABI; running its plain entries over those assets failed in System initialization. The existing fixture now selects promising entries when WEBDROID_AOT is set, and the shared comparator awaits the actual result/rejection before conversion. Its ordinary path remains plain. Both configurations execute 1,105/1,105 comparisons and the two full-width reflection cases with unchanged DEX/JDK expectations; typecheck passes. Evidence: `/tmp/webdroid-wasm-443039d3-diff-{default,aot-await}.log`, `/tmp/webdroid-wasm-diff-aot-entry-typecheck.log`, `/tmp/webdroid-wasm-443039d3-fwtest.log`. The abandoned all-suite run with an inherited shipping-AOT override retains its failure log and was stopped during libdiff; it is not a successful matrix run. No runtime behavior or comparison criterion changed.

- Linker trace harness runtime setup (2026-10-05): the integrated ordinary compiler sweep passes numeric/core/library/class/custom/link/loader/entry/host-class, all six fuzz seeds (14,400 comparisons), jbench, threads, nested entries, quick conformance (2,177 cases), descriptors, translation sweep, AOT and persistence suites. Its lazytest child alone fails before executing trace assertions because its private Node launcher omitted JSPI. Reusing bundleForNode removes that duplicate launcher and supplies the canonical JSPI/shim setup; the unchanged lazytest and exact Ex.c/b/a trace assertions pass on rerun. The original all-suite log remains a failed aggregate, not a claimed final all-green matrix. Evidence: `/tmp/webdroid-wasm-8bff2443-all-default.log` and `/tmp/webdroid-wasm-lazytest-node-contract.log`; source remains runtime `46d9cf5f`, parent harness changes only.

- Y1 real Worker heavy-tap self-cost diagnostic (2026-10-05, merge `a05cea14` of parent `46d9cf5f`): standard `bun run aot` validates 290,828 methods with five existing gaps and completes 125-file startup; restarted isolated server 4197 serves key `bd81d13011cd6351`, source `e43e8724f7a72e718298111ea42ae823228911ff123979b7c43a705f6e9996b5`. The new owned `boundary-tap` driver uses canonical full-flow setup and one unchanged FitNotes History tap after the second save. Actual pixels and UI show both 60.0 kgs/10 reps and 65.0 kgs/8 reps, with semantic target hit, pixel settling, advancing app ticks/presentations and no observed guest/browser errors, missing APIs, gaps or draw failures. Three real process Workers expose ready canonical diagnostics and 125 loaded AOT files each; all eight current profiler targets are covered, including the page, three process Workers, three compile Workers and the service Worker. The browser is closed afterward. This is selected-path functional and mechanism evidence, not full-flow or performance acceptance.
  - The app Worker raw profile has 290,308 microseconds of active self samples: source-mapped Bridge/native-boundary leaves account for 12,833 (4.42%), native body source leaves 23,690 and reviewed runtime leaves 49,726; 204,059 remain unresolved, including 69,392 in Java-shaped Wasm names that do not alone distinguish bytecode from native stubs. Thus its conservative boundary interval is 4.42–74.71%, which cannot establish G5 below 5%. Bridge.end is the largest mapped boundary leaf (6,497 microseconds), with toHost, shellOf, facade argument conversion and native owes also sampled. This suggests investigating empty-scope cleanup allocation before any rewrite, not removing cleanup or changing lifetime semantics. `appcode.demanded` also has 9,684 self microseconds; these samples do not establish guard-poll CPU cost.
  - Page-side getImageData/hash/capture and unresolved program work dominate the combined raw window. All-target known boundary samples are 1.53%, but their conservative upper bound is 86.21%; dividing by harness CPU would conceal app costs. Profile start/stop is sequential and includes bracket overhead and canonical full-step telemetry, so the before/after app crossing delta 55,559 exceeds the step's own 39,326. Neither count is asserted to be input-only. No accepted timing under concurrent agents, no native-body inclusive time charged as boundary work, and no G1/G4/G5 closure. Guarded module executable growth remains 107 MB at the last matched section comparison. Evidence: Y1 `tests/e2e/actual/y1-recovery/boundary-fitnotes-46d9/` holds raw target profiles, screenshots/UI, canonical process snapshots, exact emitted bundles/hashes and reviewed node owners/self reports; `aot-46d9-delivery.log`, `served-46d9-manifest.json` and `boundary-tap-typecheck.log` hold delivery/typecheck. The first diagnostic preceded the driver's additional provenance fields; capture source key and fixed merge epoch above identify its production source. Remaining unnamed/generated frame ownership and common-window isolation are explicit prerequisites for final idle attribution.

- Y1 common-window tap attribution (2026-10-05, diagnostic source `648532f3`, production merge `46d9cf5f`, unchanged AOT `bd81d13011cd6351`): profiler startup is bracketed by metadata-only clock markers and all targets stop concurrently before exact loaded-script retrieval. The page/Worker control covers a roughly 60 ms page busy loop with the same marker interval in both profiles; clipping excludes preparation and later debugger/source work. Full typecheck passes. Source errors are distinct from absent CPU profiles, pseudo script IDs are not queried, and a target retiring after stop cannot erase an already returned raw profile. Actual first probe remains retained with one retiring compiler Worker profile missing; it is incomplete evidence, not an app failure or a gate pass.
  - The unchanged full-flow FitNotes History repeat again displays 60.0 kgs/10 reps and 65.0 kgs/8 reps, semantic hit and pixel settling, 96 completed frames/38,556 full-step native crossings, with no observed missing APIs, guest/browser errors or draw failures. Eight target profiles and exact JS source capture have no errors or uncovered targets. Canonical app/Google Workers report ready diagnostics. The browser exits normally; this selected tap avoids the independently reported system-owner toast path and does not waive that failure.
  - Source/ancestor review exposes UI-tree diagnostics inside the app Worker: `World.callFn` samples under `uiautomator.walkView` are real boundary operations triggered by the harness, and must not be treated as the app tap. After retaining 24,321 microseconds of identified diagnostic CPU separately, app active self samples are 200,736: known boundary 18,988 (9.46%), native-source body 15,664, reviewed runtime 43,124 and unresolved 122,960. The conservative upper bound is 70.71%. `$b:acopy` and genuine callback dispatch are present outside diagnostic ancestors. This shared-load single profile is not an accepted G5 failure/pass or latency result; it does establish that lowering the earlier percentage by omitting World/generated-wrapper ownership or adding pixel hash CPU is unsound. Page diagnostic pixel/hash work accounts for another 278,964 self microseconds and is retained separately from 54,489 unresolved/runtime active samples. Production presentation transfers stay in the denominator.
  - `appcode.demanded` has 10,796 self microseconds, while substantial Java-shaped Wasm/anonymous helper leaves remain unresolved. No guard-versus-Java instruction attribution is inferred from method names, and no large emitter rewrite follows this profile. Largest known boundary leaves include real `callFn` dispatch and array copy; empty Bridge scope cleanup remains only a bounded optimization candidate, not a root-cause claim. Profiles show sampling gaps up to about 6.5 ms under shared load and unsampled tails of 62–682 microseconds. Exact evidence, reviewed node owners and common-window self reports are under `tests/e2e/actual/y1-recovery/boundary-fitnotes-window-repeat-46d9/`; the incomplete predecessor is `boundary-fitnotes-window-46d9/`, and page/Worker control/typecheck logs use `boundary-window-*`. Source capture/hash is diagnostic-only, with no production source, budget, fuel or quota change. G1/G4/G5 final idle gates and the 107 MB executable growth concern remain open.

- Corpus tier/Worker observation contract (2026-10-05, runtime `46d9cf5f`, AOT `b8607f64217e9050`): corpus and the E2E driver now reuse one URL composer for WEBDROID_TIER/WEBDROID_BYTECODE while preserving existing query settings. Corpus starts through wd.boot, awaits copied foreground rendering counters within its original deadline, and retains validated expected terminal rows without inventing healthy telemetry. Its previous URL concatenation ignored the selected Wasm tier and malformed base queries; root-only draws cannot observe a displayed Worker. An abandoned async waitForFunction draft returned early because the installed Playwright poller tests the Promise itself; another diagnostic draft read the row rather than its snapshot. Both draft failures are retained as harness evidence, not VM failures or accepted corpus results. The corrected ordinary Worker Calculator and FitNotes boot probes render frames, expose clean root/three Worker diagnostics and positive foreground ticks/draws (2/2); ordinary iframe Calculator also renders with clean diagnostics (1/1). Typecheck passes; no deadline was extended. Evidence: `tests/e2e/actual/parent-recovery-46d9cf5f/{worker-corpus-final-core,iframe-corpus-core}.json` and `/tmp/webdroid-wasm-corpus-{worker-final-core,iframe-core}.log`. These selected boot probes do not establish full corpus or toast/complete-flow parity, and their shared-load times are not performance acceptance.

- Frozen recovery matrix (2026-10-05, harness `a15e8fe3`, runtime `46d9cf5f`, AOT `b8607f64217e9050`): the full unit gate passes 1,191 tests across 63 files, with zero failures and 79,438 assertions. The serial full browser matrix is still running. TikTok completes its 13 captures but wedges at 12 checkpoints; fullscreen reports a compiler gap in `X/00HN.LIZIZ(IJ)Landroidx/recyclerview/widget/RecyclerView$ViewHolder;` (`Cannot read properties of undefined (reading 'key')`), followed by uncaught UnsatisfiedLinkError and process death. An owned-renderer native sample records an 11.7 GB peak physical footprint, without useful Wasm symbol attribution; it does not establish a memory failure mechanism. Same-source JS diagnostic controls reach TikTok's launch/fullscreen and YouTube's launch/notifications with responsive queues, populated UI and no uncaught exceptions. Optional missing classes/services and native E logs remain in their raw evidence. These two-step controls are not full app passes or accepted timing comparisons. Evidence: `tests/e2e/actual/parent-recovery-a15e8fe3/` (unit log/native sample/diagnostics under `verification`, TikTok full failure under `full/tiktok`, separate `tiktok-js-control` and `youtube-js-control` outputs). The initial TikTok control stopped after benign E initialization logs; it is retained separately as `tiktok-js-control-launch`. Goldens and production/harness source remain unchanged during capture. G2 and browser acceptance remain open.

- CLI verification audit (2026-10-05): `scripts/smoke.ts` still calls the JS compiler directly even when WEBDROID_TIER selects Wasm. The separate Wasm sweep validates emitted modules, but `scripts/wasm/lib.ts` currently reads only top-level DEX entries and can report zero methods for split XAPK archives. The browser's canonical installer handles those splits. Correct tier routing and reuse of that canonical archive loader are required before accepting a split-APK compiler smoke result; no zero-method report is treated as a successful translation gate.

### Recovered full Wasm browser matrix and diagnostic gate (2026-10-05)

Frozen production `46d9cf5f`, harness `a15e8fe3`, shipping AOT `b8607f64217e9050`: full iframe matrix ended exit 1 after 2,756 seconds. Raw captures, interventions and matrix metadata are retained under `tests/e2e/actual/parent-recovery-a15e8fe3/full/`. FitNotes completed 39 steps (7.54% mean content difference); Resy, Lichess, Mihon-app, Harmonic, Flappybird, Calculator, Doodle Jump and Mihon-onboarding also reported no wedges/timeouts/new missing/errors. These telemetry counts do not establish visual parity. Komikku retains declared SQLite errors. Reddit exposes the Unsafe accessor gap. TikTok reports the wide-CHA method-key compiler failure and 12 wedged captures; YouTube's Unsafe failure and ChatGPT's Class facade extension failure wedge all completed steps before explicit browser termination. Genshin's XAPK is absent: the capture received HTTP 500 HTML, not an APK. Competing diagnostic load excludes performance acceptance.

Full capture now shares the quick lane's process, wedge, timeout, missing/native and browser diagnostic checks. Live gaps remain explicitly reported under the existing policy. Completed steps are persisted incrementally so later browser failure cannot erase prior evidence. Replaying archived diagnostics yields FitNotes/Resy zero failures, TikTok 21, YouTube 21, ChatGPT eight and Genshin four; Reddit retains two live gaps. Typecheck passed. Goldens unchanged.

- Compiler CLI coverage correction (2026-10-05): JS and Wasm scripts now share `scripts/dexes.ts` and canonical `openInstall` split merging. Unchanged YouTube.xapk produces eight DEX files / 55,149 classes on both paths; FitNotes produces one / 4,213, and core-oj one / 4,199. Previously the Wasm path examined only the outer ZIP and reported zero methods for this XAPK. Raw `.dex` input remains supported. `WEBDROID_TIER=wasm bun run smoke <apk>` dispatches the canonical Wasm module sweep; ordinary smoke retains JS semantics and now exits nonzero on compiler failures. Wasm `--cold` is explicitly rejected in favor of cold execution suites rather than silently changing coverage. Typecheck passes; tier smoke validates all 22,259 FitNotes code methods with zero compiler failures (19 real link-error sites remain reported); loader parity and tier smoke logs are retained in `/tmp/webdroid-wasm-cli-dex-parity.log` and `/tmp/webdroid-wasm-tier-smoke-fitnotes.log`.


- Y1 native scope allocation reduction (2026-10-05, after `795289bc`, production parent `46d9cf5f`): known History boundary self samples total 18,988 microseconds: scope begin/end 7,270, array copying 5,624, callback dispatch 4,548 and primitive argument conversion 1,546. Native descriptors include RenderNode.nSetAlpha(JF)Z, Canvas.nSave(JI)I, RenderNode.nIsValid(J)Z and RenderNode.nHasIdentityMatrix(J)Z in drawing loops; the bulk array-copy sample is under AssetManager.nativeApplyStyle(JJIIJ[IJJ)V. These are few shared-load sampling intervals, not stable cost ratios. Diagnostic UI-tree descendants remain excluded separately and Java-shaped Wasm remains unresolved.
  - Bridge.end skips splice/reverse only if the scope added no cleanup entries. Nonempty cleanup detachment/reversal, reentrant callbacks, scratch restoration, stack pops, outermost live-map cleanup, exception and suspension behavior remain unchanged. Long handle arguments still open scopes because a handle can refer to an array. The existing real hostcase fixture over separate Worlds compares the exact prior end body with the fixed body: warmed controls each open 254 scopes (252 empty); old cleanup makes 254 splices, fixed cleanup makes two. All 31 answers agree. The first World has one additional empty scope (255/253), retained rather than used as the matched control. This proves eliminated empty cleanup-list allocation, not an idle timing or heavy-tap percentage gain. Evidence: isolated Y1 `bridge-scope-work{,-warm}.log` and its ignored driver.
  - Threads pass 72/72, including async arrays, aliasing and exceptional copy-back; nested entries pass; hostclass passes 31 cases plus lifetime and four-jar AOT checks; typecheck passes. Standard eight-jar delivery validates 290,828 methods with five existing gaps and 125-file startup. Key `fc1585f455623a52`, source `c8db5bf487c09a5a8f9b29ca053f5a1e692856ef888887f09373b61580649c02`, served by restarted owned port 4197. C-module bytes remain 348,989,147, exactly matching the preceding guarded build: the 107 MB executable guard growth remains open.
  - Fresh History pixels again show 60.0 kgs/10 reps and 65.0 kgs/8 reps, semantic hit, 45 completed frames, no observed guest/browser errors or missing APIs, and 23,812 full-step crossings. One compile Worker retires before its profile returns; the driver exits nonzero and retains incomplete coverage. No before/after CPU percentage or timing gain is claimed. Parent TikTok capture and other agents remain active; differing frame/sample counts also prevent that comparison. Evidence under `tests/e2e/actual/y1-recovery/`: `boundary-fitnotes-empty-guard/` and `bridge-empty-{threads,nested,hostclass,typecheck,aot,served}` logs/JSON. G5 idle attribution, G1/G4 footprint and parent TikTok/OOM remain open; no OOM cause claim follows from this fix.


- Y1 runtime method declaration registration (2026-10-05, after `de483bf6`, parent frozen `a15e8fe3` / runtime `46d9cf5f`): unchanged TikTok `X/00HN.LIZIZ(IJ)Landroidx/recyclerview/widget/RecyclerView$ViewHolder;` compiles in a flat Program, but reproduces the parent's gap in the browser's layered platform/app Program with canonical host specs. Its RecyclerView.ViewHolder.isBound()Z query reaches CHA's broad-hierarchy fallback, which examines `javax/net/ssl/SSLSocket$$host`: methods includes isBound()Z but byKey is empty. Canonical declaredMethod returns undefined and reaches reads its key, producing the compiler gap. This is a runtime class metadata invariant failure, not an unsupported opcode, network result or app substitution.
  - Program.addClass now installs every declared method in byKey while assigning its canonical index, preserving existing inherited aliases. No CHA result is skipped or weakened, and no hostclass/JNI/graphics file changes. The existing class-model harness adds one method-only runtime class and checks canonical lookup, alias preservation and broad Object hierarchy resolution. Its focused check passes 1/1 without pins. The actual unchanged TikTok method compiles with no gaps and validates under V8 with the guarded ABI; the plain compiler control also compiles with no gaps. Evidence: isolated Y1 `tests/e2e/actual/y1-recovery/tiktok-method-{host-red,v8-green,green,apk.sha256}` and `tiktok-cha-red.log`, with red stacks naming the missing declaration and captured APK digest.
  - Typecheck passes. Required `bun run wasm all` completes: diff 1105+2, libdiff, customdiff, linkdiff, loaders, entry, hostclass (31 cases both ordinary/AOT), six fuzz seeds (14,400 cases), all jbench result parity, threads 72/72, nested, conform-quick, descriptors, default sweep, aottest and persist report their checks. The first aggregate run is NOT green: classdiff's new synthetic fixture omitted explicit header fields (corrected; separate classdiff rerun reports 33/33 with eight pre-existing JS comparison pins), and lazytest's existing separate trace launcher lacks the JSPI flag already repaired in parent. Running the exact failed trace via canonical runUnderNode passes; no launcher change is included here. Conformance retains 18 Guava comparison pins; no pinned aggregate is asserted as acceptance. Default sweep still covers boot jars/FitNotes, not TikTok or an XAPK; the exact TikTok method control above supplies this failure's evidence. No fresh YouTube/TikTok browser pass, OOM closure, idle timing or G1/G4/G5 acceptance follows from this core milestone.
- Y1 aligned Unsafe field cookies (2026-10-05, after `d5eade05`, parent frozen `a15e8fe3`): production installation decoding of unchanged YouTube.xapk loads eight DEXes. Its actual aoxh initializer reproduces `Unsafe: no accessor for this offset`: bacx.a aligns a boolean field offset down with -4, calls Unsafe.getInt, and extracts the addressed byte. Cookies previously advanced by one: Buffer.address:J received 56, bdxl.d:Z received 57, and bdxl.b:I received 58. Aligning 57 selected cookie 56, an unrelated long field; the int accessor correctly rejected that type. Fault-only diagnostic logging records the numeric request and all three field identities before defining this cause.
  - World field cookies now advance by eight, preserving word alignment while remaining opaque field identities. Lookup divides by eight without rounding; interior cookies cannot alias another field. No raw-memory, array, ClassExt or native registration changes. ART's object getInt uses MemberOffset separately from raw-address getInt ([Android 15 Unsafe implementation](https://android.googlesource.com/platform/art/+/refs/heads/android15-release/runtime/native/jdk_internal_misc_Unsafe.cc)). The actual initializer completes under V8 after this change with no accessor gap. This does not establish correctness of every mixed native offset domain or close a browser gate.
  - The existing class-model fixture executes the compiled aligned-word/byte extraction against neighboring long/int fields and rejects an interior cookie; focused classIdent passes 1/1 without pins. Differential checks pass 1105/1105 plus two wide reflection cases; library checks pass 16,480 cases over 412 methods (740 throwing), zero diffs; typecheck passes. Evidence under isolated `tests/e2e/actual/y1-recovery/`: youtube-unsafe-{red,green}.log, youtube-bacx-a.dex.txt, unsafe-aligned-core.log and unsafe-cookie-{diff,libdiff,typecheck}.log. Fresh standard AOT and browser startup verification follow separately; no idle timing or OOM closure is claimed.


- Cold body eligibility preparation (2026-10-05, after `bbe0b6ff`): the frozen bbe/ce9 serial controls passed FitNotes 9/9 and Calculator 7/7. Cold-on FitNotes rendered launch/metric/welcome but failed the alive gate after welcome dismissal; Calculator timed out on the first numeric tap with MotionEvent.obtain NPE. Neither is accepted. Follow-up diagnostics do not waive these failures. Evidence: `conform-cache/cold-review/cold-scope-browser/{serial.json,watch-motion.json,watch-cardinality.json,helper-attribution.json}`. The cardinality sample maps all 85,994 slow helper keys: 35,585 field operations and 31,152 invokes dominate; 179 rejected C modules had subsequently arrived, but rejection mechanism and canonical D-global availability require further classification before retrying them.
  - Every slow adapter constructs an MC with deoptimization enabled; its eligibility check was repeatedly decoding the enclosing whole method. Cache only the eligibility boolean and immutable DEX/body identity per weakly held MethodInfo. The first check remains complete, unsupported results stay unsupported, and replacing the DEX or code offset requires a new check. AOT preflight still retains no decoded body. In the same Node preparation control, 10,000 checks of the 484-word MotionEvent initializer took 396.48 ms before and 1.21 ms after; this is a preparation microcontrol, not idle application/G3 acceptance. Cold-slow passes 182 checks, cold OSR 41, initializer/annotation 21 and full typecheck. Logs: `conform-cache/cold-review/typing/{cold-preflight-before.log,cold-preflight-after.log,preflight-slow.log,preflight-osr.log,preflight-init.log,preflight-typecheck.log}`. Helper module cardinality, the original NPE and cold-on liveness remain open.


- Decoded cold-program identity (2026-10-05, follows `4b55081a`): production DEX bytes are immutable, but host overlays can clear MethodInfo.codeOff. The decoded-program cache now uses the same DEX/code-offset identity as eligibility rather than assuming the MethodInfo itself is immutable. The replacement-body regression primes both caches and then verifies that an unsupported replacement at another offset is rejected and a replacement DEX is decoded. Cold-slow passes 182 checks; evidence `conform-cache/cold-review/typing/preflight-identity-slow.log`. This does not establish dynamic replacement of an active activation or change overlay/deoptimization policy.

- Method-local cold slow-operation batches (2026-10-05, after `cff10888`): frozen `68da3f25` / AOT `554687e2f95ffede` controls passed FitNotes 9/9 and Calculator 7/7. Cold FitNotes failed the launch gate with 1,026,058 root cold calls / 76,130 slow modules; cold Calculator rendered launch/keypad/7, then plus returned an empty UI tree, with 1,197,242 calls / 87,190 modules. No new Java error was observed in that pair; the older MotionEvent NPE remains unresolved. Shared-load timings and alive/UI failures are not performance or correctness waivers. Outputs: `conform-cache/cold-review/preflight-browser/`.
  - Read-only rejection attribution finds all 179 rejected root C modules first missed fetching their bytes; 149 also depend on previously missed D modules. Only 25 have every dependency instantiated canonically. No ABI mismatch is observed, and no late C/D retry or class-global substitution is introduced. The app queue continues through layout/draw PCs in prior traces; module construction and repeated snapshot/caller work are substantial costs, but a single fixed queue deadlock has not been established.
  - Slow helpers now share method-local modules in deterministic batches of at most 16 distinct canonical operations with identical ordered input/result ABIs. Per-PC register roles, web kinds, DEX operands, array payload locations, String allocation aliases and method/referrer/loader identity remain separate; the existing canonical-key sharing is retained. Each case uses the canonical MC emitter. Root and suspending strand helpers retain World.hostFn/callFn ownership and JSPI/native ABI; virtual calls remain dynamic. Batches reserve only unique embedded String constructor declarations and charge the complete function parameter/local frame. Snapshot validation remains before effects. Planning creates adapter descriptors eagerly; coldSlowAdapters counts those descriptors, while coldSlowModules counts actual compiled root/strand batches. No numeric-loop JS dispatch is added.
  - The same 12 observed small slow-heavy bodies, compiled without executing Java exports, produce 46 helpers / 327,758 generated bytes versus 166 / 481,132 before (ordinary guarded compilation remains 136,146 bytes). Cold semantic fixture modules fall 198 to 131 before new cases; the expanded fixture passes 198 checks, including 20 distinct fields crossing the batch bound, pending result/EH/suspension, and collected emission Compilers with live executable batch exports. Cold threads pass 72/72 (three JS-tier overflow differences remain recorded; Wasm matches JDK), ordinary OSR 41 and initializer/annotation 21 pass. Evidence: `conform-cache/cold-review/typing/{cold-body-cost.json,cold-body-cost-batch.json,batch-slow-gc.log,batch-threads-cold.log,batch-osr.log,batch-init.log}`. Native declaration work stays 39 words / seven declarations. Healthy full cold-on browser flows and idle G3 cost remain unverified; method-local batching still carries a cold-unit cost and eager preparation must be measured on real startup.

- Cold batch deferred-linkage refinement (2026-10-05, follows `e42ed9af`): batch planning skips PCs that canonical reaching-definition typing marks unreachable. Removing only that filter reproduces an UnsupportedSlowOperation at dead PC 5 before the live invoke can execute; restoring it executes the unchanged live result. Dormant missing classes/natives retain their actual NoClassDefFoundError/UnsatisfiedLinkError on the negative branch while positive branches report no executed gap or native requirement. A dormant class initializer runs only when its invoke executes. Embedded String constructor factories occupy isolated canonical-key batches, so other cases cannot bind their native imports early; a lookup guard verifies zero constructor lookup on the positive branch and real factory lookup/construction on the negative branch. Existing per-PC snapshot/EH/producer identity and whole-function frame accounting remain unchanged. Cold-slow passes 241 checks and full typecheck passes; native declaration work is 50 words/nine declarations with the expanded cases. Evidence: `conform-cache/cold-review/typing/{batch-unreachable-red.log,batch-deferred-factory.log,batch-deferred-final-typecheck.log}`. No healthy cold application startup or idle performance acceptance is claimed; the earlier AOT build predates this refinement and must be rebuilt before the next matched pair.

- ClassValue/ClassExt Wasm ownership (2026-10-05): frozen parent's ChatGPT a15/runtime46 failed in ClassValue.getCacheCarefully when the JS native wrote host-only JClass.ext onto a strict Wasm Class facade. The matched JS control remained live. A minimal addition to the existing class-model differential fixture reproduces the same facade java/lang/Class.ext failure before the fix (JDK and JS return 31, Wasm throws). AOSP [Class.java](https://android.googlesource.com/platform/libcore/+/refs/heads/main/ojluni/src/main/java/java/lang/Class.java) declares real Class.extData, [ClassExt.java](https://android.googlesource.com/platform/libcore/+/refs/heads/main/libart/src/main/java/dalvik/system/ClassExt.java) owns classValueMap, and ART [Class::EnsureExtDataPresent](https://android.googlesource.com/platform/art/+/refs/heads/main/runtime/mirror/class.cc) allocates and atomically publishes a zeroed extension without invoking the private constructor. The owning Wasm Class intrinsic now reads/allocates/publishes that actual field. Allocation/publication has no suspension or Java callback in a process realm; separate processes retain separate class objects. No facade expando, fabricated ClassExt or host-only map is introduced. The unchanged bundled ClassValue bytecode owns compute/cache/removal. The fixture checks repeated value identity, distinct class and ClassValue owners, removal/recomputation, primitive and array classes. All 34 class-model comparisons pass (eight preexisting JS-tier divergences), the focused cold comparison passes, and full typecheck passes. Evidence `conform-cache/cold-review/typing/classext-{before,after,cold,typecheck}.log`. Parent ChatGPT browser replay and fresh shipping-AOT coverage remain required; no app acceptance is inferred from the core check.


- Y2 Worker WebView surface and storage owner (2026-10-05): WebViewChromium no longer needs a Window or HTMLIFrameElement in its Java realm. The existing iframe path and a transferred Worker surface implement the same narrow DOM operations. The page owns the actual iframe, validates announced renderer Window ancestry, binds opaque frame identities to their actual origin/bridge, and transfers the renderer's MessagePort back through the app Worker. Java interfaces, clients, interception, history, cookies and software snapshot requests retain their existing provider/renderer implementations. Renderer ports are transferred through the process bootstrap's initial structuredClone and actual Worker postMessage. Visibility and stacking track the exact process canvas; sizing uses canonical display geometry rather than an uninitialized canvas bitmap width. Replacement/failure/death close the exact bootstrap surface owners and their DOM frames/observers. Provider destruction closes its own surface without affecting another process or unrelated renderer.
  - WebStorage partition registration, quota reads and deletion execute with the canonical page owner, bound to the registered package. The root/legacy direct path remains; child/Worker calls acquire the broker lazily. Install-time partition identity and the existing ordered quota lane are retained, and copied replies leave Java callbacks in their calling JVM. HTTP-auth credentials still use the existing canonical SQLite commands. Storage frame completion/timeout closes its response ports. The existing data fixture restores the added access hook when closing its synthetic process port.
  - The existing WebView and data suites pass 64 cases/3,096 assertions. A real Chromium Worker, both transfer hops and the actual cross-site WEB_FRAME/WEB_PROXY_WORKER/document script load and evaluate a page; a sibling renderer cannot announce itself as this surface, and process visibility/stacking/close leave that sibling intact. A second real Worker registers origins through the actual canonical storage commands, proves package partitions differ with no Worker localStorage, and an ordered delete/query observes removal of a real renderer IndexedDB database. The existing bootstrap/remote-file browser fixture passes six assertions; full typecheck and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/web-{surface-final-core,surface-final-typecheck,surface-bootstrap,surface-core,storage-core}.log`.
  - This is production wiring plus a core boundary milestone, not unchanged-APK WebView acceptance. Fresh source-matched strict AOT and actual Worker app/cross-site gates remain required. FD/open-file-description sharing, ashmem mapping coherence, VFS mutation ownership and Binder death/signal boundaries remain open; the process selector stays opt-in. No latency/performance claim and no owned active app/browser/server driver at this checkpoint.

  - WebStorage fixture refinement: the synthetic package now records a stable install time before origin registration and writes 8 KiB to the actual renderer IndexedDB store. It requires positive usage from that same partition before the queued deletion, followed by zero usage. The earlier uninstalled-package fixture could otherwise query a different timestamp partition and give a misleading zero. The strengthened check and TypeScript pass; this is a fixture correction, not a production partition change. Evidence remains `web-storage-core.log` and `web-storage-fixture-tsc.log` under the Y2 endpoint directory.

### Y2: system-owner toast framework initialization

The unchanged Worker FitNotes failure at step 24 belongs to the page's system realm, not its application Worker. The typed cause chain reaches ViewConfiguration.<init>:497 through LinearLayout inflation; the bytecode calls WindowManagerGlobal.getWindowManagerService().hasNavigationBar(), and root telemetry records `service window [binder]`. System boot now invokes the existing hostWindowManager registration before running Java, as app boot already does. A subsequent real framework probe reaches TextView and fails in Typeface.create:928. The system realm binds no application and therefore never receives bindApplication's font map. It now invokes the existing loadSystemFontMap helper after zygote initialization, also used by the framework/browser fixtures for realms without an application bind. No toast substitute or Android adapter was added.

Full typecheck and strict AOT pass (290,828 methods, five existing gaps, 126 startup files). The restarted isolated server serves manifest `c10fabe02bab725a`, source `d448883f7daa9f57152138210790a8020c961ed1cf9421d7b3a75e91722e1780`. A real Chromium Wasm Worker Calculator launch followed by the original root ActivityThread's system Context inflates ToastPresenter.getTextToastView successfully with no root missing entries. Readiness uses host-side bounded polling: Playwright waitForFunction does not await an async predicate. Earlier probes that recreated systemMain are diagnostic cause evidence only; the final check requires the original ActivityThread and does not recreate it. Evidence under `webdroid-shots/y2-s5-endpoint/`: `worker-toast-{reinitialize,window-only,fixed-original-context}.log/json` as available, `worker-toast-cause.json`, bytecode disassemblies, `worker-toast-{typecheck,aot,server}.log`, and `worker-toast-cause-probe.ts`.

This closes the observed constructor prerequisites, not the full Worker FitNotes flow or system-window pixels. The system realm still needs its display target and overlay ordering audited: the current displayCanvases places the root canvas beneath app canvases. Actual unchanged-APK WebView gates, canonical FD/open-file-description and ashmem/VFS sharing, and remaining Binder/signal boundaries remain open; Worker selection stays opt-in.


- WebView collection follow-up: the frame diagnostic registry held FrameView strongly, preventing its registered finalizer from releasing a dropped WebView. It now maps frame holds to WeakRefs of their views; process exit can still release every hold, explicit destroy retires the same hold, and collection removes its bookkeeping and surface. A real Chromium collection check retains a view for diagnostic enumeration, drops it without destroy(), collects on separate host turns, and observes exactly one surface removal plus an empty diagnostic list (three assertions). The page surface's ready callback also checks its closed owner before publishing an announcement. Actual Window identities remain solely in the page map; the transferred announcement overwrites frame with its opaque string identity. Evidence: `web-surface-collection.log`; existing WebView checks and TypeScript pass. This checks the frame registry ownership, not every possible pending provider operation.

### Y2: system windows over actual Worker application pixels

The root system realm now installs the existing SurfaceFlinger display target with transparent composition. The page's system canvas is transparent and ordered above the shown app canvases in both DOM stacking and displayCanvases(); its noninteractive toast layer does not intercept app pointer input. Display-target replacement retains the target's transparency. A system toast changes no activity-stack entry, so foreground busy reads still include the underlying Worker; visibleWorkerProcesses/visibleWorkersAlive continue covering all shown app layers. wd.alive now requires the root Java queue as well as those Workers, rather than treating a healthy app queue as proof that system Java can dispatch.

On parent a15e8fe3 plus the reviewed Y2 WebView/toast prerequisites, fresh strict AOT `9ad8fa7afdf78d04` / source `1b4b8ba339f3730d7cae88a4a9964e8c6ca8047be796d8ea7e88efd55930eb80` validates 290,828 methods with five existing gaps and 126 startup files. The restarted isolated server serves the matching manifest. Official unchanged Worker FitNotes full passes 39/39, content 8.51%, strict 3.98%, tolerant 2.74%. The captured step-24 bitmap visibly places the real `Webdroid Press has been added` toast over the app list. UI artifacts confirm 60/10, 65/8 and Webdroid Press 40/12, 45/10. The official quick flow also passes 39/39, one Android checkpoint, zero reported gaps. Each lane contains 156 process diagnostic rows: no missing/native/error entries, draw errors, Wasm gaps/suspend errors, timeouts or wedged queues; browser errors are empty. Each of the three Workers loads 126 AOT files. Full typecheck and subsequent TypeScript/diff checks pass.

Root telemetry reports zero AOT loads: platform-only appCode currently returns before the startup-prefetch wait. Thus these are actual Worker shipping-AOT and system-window correctness checks, not proof of the root's shipping-AOT path; that mandatory system-owner boundary remains to verify. These gates do not establish default Worker acceptance, interactive system-window input, arbitrary translucent activity parity or idle-host performance. FD/ashmem/VFS sharing and unchanged-APK WebView gates remain open. Evidence: `tests/e2e/actual/y2-system-overlay-9ad8/{fitnotes,fitnotes-fast}` and `webdroid-shots/y2-s5-endpoint/system-overlay-{typecheck,tsc,aot,server,fitnotes-full,fitnotes-fast}.log`. Parent harness and Android adapter owner files were not edited.

- WebView provider callback lifetime follow-up: the actual provider's globally registered draw functor held its `size.place` callback, which referenced `this.ref` and therefore captured the provider strongly. The callback now comes from a factory whose scope contains only the WeakRef. Long-lived renderer ready/interface/intercept/cookie callbacks and frame-port message callbacks likewise come from separate weak-owner factories, avoiding the surrounding load method's strong provider scope. The existing collection fixture now creates the actual WebViewChromium and registers its real functor size, instead of a synthetic FrameView with functor zero. Restoring the old placement callback makes that check fail; the correction releases the surface once without destroy and empties diagnostics. This and the real Worker renderer-port fixture pass (two checks/four assertions), TypeScript and diff checks pass. Evidence: `web-provider-collection-{before,final,tsc}.log`. Pending load/Java callback operations can legitimately retain their receiver until they settle; this is not unchanged-APK WebView page collection or app acceptance proof. The earlier system-window app gates predate this callback-only follow-up and are not relabeled as this source's gates. Interactive root window pointer/key/Back ownership, root shipping-AOT initialization, actual APK WebView and canonical FD/ashmem/VFS boundaries remain open.

### Y2: interactive system-window input ownership

Worker-mode page input now consults the real WindowManager's window focus and touch-modal/NOT_TOUCHABLE rules before routing copied tap/swipe/type/action/Back commands to an app Worker. Its copied hit regions create transparent pointer targets only over root-owned windows; a nonmodal root window leaves the underlying app/WebView hit-testable outside its frame. The existing pointer queue listens on this owning layer while measuring coordinates against the canonical display canvas, so gestures keep their channel and event ordering. Root windows appear last in the combined UI tree, matching their compositor ordering. The page routes non-IME navigation keys through the root InputDispatcher while a root window is focused, and restores prior browser focus after root windows dismiss. The region watcher, DOM layer, key listeners and pointer/IME owner close with the exact root owner.

The real framework probe over unchanged Wasm Worker Calculator exposed another root-only IME path defect: rapid browser typing produced Java `root-ownedot-owne` and repeated text in the textarea. Root attachIme still used its old unsequenced DOM input path, while Workers already used the reviewed generation-aware/coalescing receiver. Root system input now reuses receiveIme/serveIme over a local MessageChannel with its existing control. Java no longer directly overwrites that DOM control while page edits remain queued. The supplied-control owner closes its events/proxy/ports without deleting the shell-owned element; replacement/failure-before-published-close retains the exact owner check. Existing legacy canvas input retains its direct path, with explicit listener/timer teardown added.

Full typecheck, existing IME generation/late-partial-report checks (two cases/ten assertions) and fresh strict AOT pass (290,828 methods, five existing gaps, 126 startup files). Restarted port 4123 serves key `34029faaa32bf85e`, source `2bb1a95a32e107707cebfeaaa0399369f49fdce4760748ccb4d23d39b82513ba`, including `50e3e851`. A real AOSP AlertDialog with TYPE_SYSTEM_DIALOG and EditText, created from the original root system Context, proves actual pointer dismissal, canonical Back, browser Escape, rapid `root-owned` typing and copied `copied-root` input. A NOT_TOUCH_MODAL dialog remains shown while a real pointer changes the underlying Calculator display from 0 to 1. On final dismissal, hit regions are empty; the same foreground PID remains alive and all three Workers are ready/load 126 AOT files, with no observed missing/native/runtime/draw/Wasm-gap/suspend errors or browser errors. Existing Surface warning messages remain recorded. The probe accounts for IME-first Back consumption instead of forcing a dialog to close; the completed repeat observed direct dismissal. Earlier failed text and incomplete background-Worker snapshots remain preserved, not relabeled as passes.

Evidence: `webdroid-shots/y2-s5-endpoint/system-input-{typecheck,tsc,aot,server,ime-core,probe*}.{log,json,ts}`. This is an interactive framework owner contract over a real app Worker, not a new official app-flow gate, all window flags/key combinations or global cross-process WindowManager focus-callback parity. Root shipping-AOT initialization, actual unchanged-APK WebView/cross-site gates and canonical FD/ashmem/VFS semantics remain open; Worker selection stays opt-in. Parent harness and Android adapter owner files remain untouched.

### Integrated recovery cut `9be2ce51` (2026-10-05)

Integrated runtime declaration indexing, eight-aligned Unsafe field cookies, canonical Class.extData, bounded cold adapter batches with dormant linkage deferred, and Worker WebView/system-window ownership and input. The epoch-only guard candidate `de483bf6` remains excluded pending CPU comparison: the shipped disabled-policy import is immutable while the epoch is mutable; byte savings alone cannot establish runtime improvement.

Fresh standard eight-jar AOT `9f3f089c36dbd27a`, source `b18d6337b3b6fee155630bc1c06d494e98ec83194690a25f9ff61e244257024a`: 41,247 classes / 290,828 methods / five recorded gap labels / 153 startup files. Correct `/aot/current.json` and `/aot/<key>/index.json` routes return HTTP 200; an initial probe of nonexistent `/wasm-aot/` returned 404 and is not a delivery failure. Typecheck, 1,194 unit checks / 79,443 assertions, 241 cold-slow checks, 34 classdiff cases (eight existing JS divergence pins), 153 shipping-AOT OSR checks and 31/31 unpinned framework exercises pass. Logs are `/tmp/webdroid-wasm-9be2-integrated-*.log`; shared diagnostic load excludes timing acceptance.

Actual Worker quick capture: Calculator passes eight steps, 1.174353% result-screen difference. FitNotes completes 38 steps with clean observed diagnostics, then aborts `home-final` on missing RenderNode `hasTransform`. A fault-only node lookup control and a bounded handle-release ring control each complete all 39 steps; neither catches the missing numeric handle or closes the original failure. Evidence is preserved in `tests/e2e/actual/parent-recovery-9be2ce51/`. The unmodified Worker full rerun reproduces the failure at third-set reps: uncaught `RenderNode.nHasIdentityMatrix` -> `View.transformFromViewToWindowSpace:27438` -> `View.getLocationInWindow` -> `Editor.PositionListener.onPreDraw` -> traversal. Process 1001 dies and later captures time out; expected exit zero is not a waiver for this crash. Numeric handle/release cause remains unresolved, with the real editor-position stack narrowing the investigation. Goldens unchanged.



### Y2: WebView Java client inspection and interception headers (2026-10-06)

On source `487fc612` with shipping AOT `34029faaa32bf85e`, the unchanged Harmonic APK's real article navigation killed its Wasm Worker: WebViewChromium.go inspected the JS prototype of bytecode-owned WebViewClient through Runtime.link, which rejects that Java entry in the Wasm tier. The provider now identifies the exact base client through jentry.classNameOf and lets subclass clients answer through the existing Java interception entry, including inherited defaults. This conservatively invokes subclasses whose defaults previously avoided the interception bridge; no override is substituted. AOSP WebViewClient's request overload delegates to its string overload, whose default returns null (frameworks/base core/java/android/webkit/WebViewClient.java).

The first corrected run exposed an additional missing `put on a host object of class java/util/HashMap`: interception headers used rt.make instead of running the Java constructor. The request now allocates that map through newObj on its existing IO-thread generator. Six existing provider cases pass (12 assertions); both source cuts pass full typecheck and strict AOT validation (290828 methods, five existing gaps, 126 startup files). The final source build is `e1f81278bb0a7dcd`, source `8caabaaf4400d9efd1bfd946c381cd1b811c1659e97f3a8c237f9b23b6594a02`; the isolated 4123 server was restarted and its manifest matches.

Using the parent harness's unchanged onboarding actions and an actual live article-title tap, Harmonic loads `https://reflection.ai/blog/introducing-beam` in a visible separate renderer origin. Its real title, loaded/progress 100, geometry and screenshot agree. Root and three Worker diagnostic rows are complete/ok with no missing/native/errors/draw failures; the three Workers each load 126 AOT files. The earlier real Nieman article returned HTTP 502 and the app rendered its own error asset, so that run is not a document-success gate. The Reflection run still reports a local renderer CSS 404, an upstream cookie-interceptor error (`Cannot redefine property: cookie`) and analytics network failures. This is real APK document/liveness proof, not a clean cross-site acceptance gate or full S5 closure; these browser failures remain open. The flow reset counters report zero for root AOT at this step; this is not cumulative loading evidence. Its separate readiness investigation follows below. Canonical FD/ashmem/VFS sharing remains open. No performance claim and no app/golden/harness edits.

Evidence is isolated under `webdroid-shots/y2-s5-endpoint/`: `web-client-apk-before.json` retains the original throwable/death; `web-client-apk-error-document.json` retains the intermediate missing map and HTTP failure; `web-request-apk.{json,png,log}` records the actual article. Reproducer: `worker-webview-harness-probe.ts`; checks: `web-client-core.log`, `web-request-typecheck.log`, `web-request-aot.log`. All owned browser drivers closed after their captures.


### Y2: No-app system realm awaits platform AOT readiness (2026-10-06)

The Wasm host's appCode returned before awaiting store.ready when appDexes was empty. The system owner has intentionally no application DEX but enters real framework Java after this hook, so startup module prefetch could still be pending. AOT.ready records an unavailable module as missed, making that startup race permanent for the realm. The no-app branch now awaits the existing prefetch readiness promise without constructing application code or fabricating DEX. Existing app preparation and the already-created-World guard remain unchanged.

Full typecheck and strict AOT validation pass (290828 methods, five existing gaps, 126 startup files). Build `71c4a2f51359a4ec`, source `aed703d9bcb3c1ba786280ed052c71c37b9c5ab1c9344b3ddf336e2924eb85b3`, was served HTTP200 after restarting the isolated 4123 server. Two sequential Chromium controls use the same unchanged Calculator Worker APK, source/assets, screen and live clock. The old-policy control restores only the no-app early return in the delivered JS (one replacement); the corrected control is unmodified. Before any perf reset, the final matched control loads 72 root AOT modules versus 126 with the readiness wait, with missing-module counters 126 versus 96. Both root/foreground liveness checks become true, with no root missing entries or browser error logs. An initial startup sample loaded 109 versus 126 but observed liveness before first presentation; it is retained separately, not the completed liveness check. Counts vary with the old prefetch race. There is no idle performance claim.

This corrects the earlier root-loaded-zero interpretation: flow per-step perfReset can erase cumulative loading evidence. The original root already loaded AOT; the fix prevents the no-app readiness race. It does not assert every dynamically used platform module ships in the startup set, nor close remaining S5 FD, mapping and cross-site document failures. Evidence: `webdroid-shots/y2-s5-endpoint/system-aot-{typecheck,build,probe-final}.log`, `system-aot-probe.ts`, `system-aot-probe.json`, and retained `system-aot-probe-first.json`. Both owned browsers close before returning.


### Y2: Copied host stacks survive process-port replies (2026-10-06)

ProcessFailure now optionally carries a string stack for non-Java errors. processError restores that copied origin stack on the caller's locally constructed Error while retaining the original name/message. Java-class failures keep their existing class/message wire and caller-owned exception construction; no Java object or Error instance crosses the port. The existing Chromium Worker endpoint fixture throws a real TypeError in originatingHostFailure and checks that the reply retains that frame without a reconstructed processError frame. Its Parcel isolation, reentrant callback, Java SecurityException, clone failure and pending/later death assertions remain green (one existing test, ten assertions); full typecheck and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/process-host-stack-{core,typecheck}.log`.

This provides origin evidence for the parent's undefined.hasTransform failure; it is not a RenderNode cause fix or app-flow acceptance. Gibbs retains that cause investigation. Production source changes require fresh source-matched AOT before browser verification; the ongoing isolated build also includes the separate uncommitted WebView resource fixes.


### Y2: Renderer resource URLs and configurable cookie instrumentation (2026-10-06)

The real Harmonic article exposed a renderer-local CSS 404 while the exact upstream CSS URL returns HTTP200. Requests resolved against cached script URLs can target the renderer origin; the service worker previously bypassed every local non-proxy URL. For document clients with an isolated HTTPS/HTTP upstream context, those resource paths now resolve against the canonical document site's origin and use the existing proxy/Java interception/cookie pipeline. Reserved renderer bootstrap, cached script and APK/font paths retain their owning routes. JVM/compiler Worker local fetches retain the pre-existing shell path: an initial draft sent their module/archive requests to an unavailable document-context callback, reproducing a Harmonic launch timeout and ERR_FAILED on AOT files. The corrected rule checks Client.type before requesting a renderer context. Those failed drafts and logs are retained, not accepted.

The injected document.cookie descriptor is now configurable so page instrumentation can wrap it like the platform accessor while preserving the canonical getter/setter. The existing cookie fixture first reproduced Cannot redefine property, then verifies all cookie reads/writes/acknowledgments through a wrapped accessor. The strengthened existing isolation fixture reproduces a renderer-local resource reading the host fallback instead of upstream, then verifies the upstream result while retaining parent storage/window, sibling renderer and navigation denial. Its resource-only fetch omits credentials because that fixture does not install a cookie endpoint. Three selected existing Chromium tests pass (three assertions), including actual Worker surface ownership; full typecheck and diff check pass.

Fresh strict AOT `69e19b14b40d572d`, source `be101d9fb886ca5e6e8898536667a2def3fdb4d290442ca36976aff7a3832cb2`, validates 290828 methods with five existing gaps and 126 startup files. The isolated server was restarted and HTTP manifest matched. The unchanged Harmonic APK completes the parent flow's six onboarding/front steps and a required semantic tap on the real live Beam article. Its actual WebView loads https://reflection.ai/blog/introducing-beam at progress100 with the real title and geometry, visible on its own renderer origin. Browser error collection is empty; all seven steps have no errors/missing/native requirements/wedging, and all four process diagnostic rows are complete/ok with no missing/native/errors/draw failures/Wasm gaps/suspend errors. Three Workers load 126 shipping AOT files; root per-step counters are reset and do not measure cumulative loading. Actual owned-root/foreground liveness is true. Request-failure tracing separately retains an Android checkin network failure and an aborted upstream RSC request during teardown; neither is relabeled as successful network service coverage. No golden, APK or parent harness changes and no timing/performance acceptance.

Evidence: `webdroid-shots/y2-s5-endpoint/web-origin-final-{core,typecheck,aot}.log`, `web-stack-{aot,apk}.log`, `web-origin-final-apk.{json,png}` and `worker-webview-harness-probe.ts`. Earlier cookie/resource controls are `web-cookie-redefine-before.log` and `web-origin-before.log`; failed scope draft evidence is `web-origin-apk-launch-timeout.json`, `web-origin-apk-repeat.log` and `harmonic-startup-probe.json`. The no-app AOT readiness change remains successful in this corrected actual APK run; its earlier suspected timeout was the uncommitted service-worker draft, not evidence against that committed change. All owned capture browsers closed. FD/open-file-description, ashmem/map and mutable VFS coherence remain mandatory S5 work; Worker selection remains opt-in.


### Y1: shared-library archive reads and initialization helper ownership

YouTube's unchanged XAPK declares optional `org.apache.http.legacy`; the paired 490,666-byte jar is a shared library, not a bootclasspath jar. An isolated layered-Program control finds `BasicHttpParams` when the actual jar bytes are resident, but not when the same bytes are mounted through the production lazy VFS. Wasm's archive provider accepted only synchronous bytes and cached the pending read as no DEX. The provider now caches/awaits the read, and DexFile's native entry parks through the canonical scheduler completion hook, preserving strand identity and depth across the wait. The existing loader fixture also runs its full identity/reflection checks through a deferred archive provider.

Importing the scheduler from the loader intrinsic exposed a separate obsolete registration: `classes.ts` registered `initWait(I)V`, overwriting the scheduler's `initWait(I)I` under the changed module order. The unchanged `Th.initRace` control then trapped with a null-function/signature mismatch and returned 420000 instead of 424242. Restoring the original loader module passed the same check, as did the archived starting source. Removing the obsolete registration leaves the scheduler as the sole owner; all 72 thread checks pass with the deferred loader path, including the initialization race. The ClassExt region is untouched.

Deferred and synchronous loader checks, the focused initialization race, nested entries, 1,105 differential cases plus two full-width reflection cases and typecheck pass. Earlier draft shipping OSR checks passed, but are not relabeled as final-source checks. One typecheck attempt included an extracted diagnostic source archive and failed on its duplicated/incomplete tree; the archive was preserved as a tarball, then the unmodified typecheck command passed. Evidence is under `tests/e2e/actual/y1-recovery/lazy-archive-*`, with the matching source control in `thread-archive-control.tar.gz`.

This closes archive-read suspension, not YouTube startup. Even the resident and deferred controls find the class only through Java's shared-library loader, while compiler root lookup and host visible-class lookup still miss it. The before/after library graph, defining-loader identity, cached descriptor rebinding and compiled dependency invalidation remain to implement. No fresh YouTube or TikTok browser pass, idle timing or G2 closure is claimed.



### RenderNode RefBase ownership (2026-10-05)

The actual platform VirtualRefBasePtr constructor/release, invoked through reflection, reproduced a freed RenderNode handle while its Java static owner remained reachable. A separate control retains only the Wasm static Holder → RenderNode graph across 30 real Node GC turns: actual NativeAllocationRegistry bytecode registers the raw referent, no host-facade registration executes, and dropping the owner releases once. This control does not reproduce the proposed facade-lifetime failure.

AOSP [RenderNode JNI](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/libs/hwui/jni/android_graphics_RenderNode.cpp) acquires one strong reference on create and drops it in its NAR finalizer; [HardwareRenderer JNI](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/libs/hwui/jni/android_graphics_HardwareRenderer.cpp) also acquires one on root-node creation. [VirtualRefBasePtr](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/com/android/internal/util/VirtualRefBasePtr.java) independently acquires/releases its reference. These creators now opt into per-native-object strong counts in the owning handle module, and their finalizer decrements rather than unconditionally freeing. VirtualRefBasePtr delegates to those counts. Other handle types retain their existing ownership contracts; this does not claim a general audit of every native RefBase consumer.

`rendernode-ownership.ts` passes both ordinary and forced-cold execution: static-owner GC, explicit wrapper release while Java owns the node, Java-owner collection while a wrapper retains the native state, and final-wrapper release. Existing graphics tests pass 21 cases/199 assertions; full typecheck passes. Invocation uses runUnderNode directly with JDK21/build-tools36 PATH, preserving the parent-owned suite CLI. Logs: `conform-cache/cold-review/full-batch-browser/{nar-refbase.log,nar-fixed.log,nar-fixed-cold.log,refbase-graphics.log,refbase-typecheck.log}`. No reference-budget change or strong Java/facade roots are introduced. The prior official FitNotes 9be2 step30 Editor.PositionListener/RenderNode crash remains open: neither a numeric release trace nor an actual app path connects this distinct refcount defect to it. Parent 5de's later unmodified 39/39 pass changes startup timing and is not causal closure. Chrome/Worker GC and shipping-AOT replay remain separate evidence.

### Parent follow-up verification (2026-10-05)

At `5de5144f` / AOT `23d568f8cabf1aad` (`cc1617cd07137c6c544e8ae23f76cc4bdedc31c93706cde6cba4b1b5c7840994`), the official Worker FitNotes full run completes 39/39 with 8.51% mean content difference and 156 healthy process snapshots, no wedges/timeouts/new missing/native/errors or browser errors. A preceding release-ring control also completes 39/39 without a missing numeric handle. These passes do not close the earlier `9be2ce51` RenderNode crash; this source changes system AOT startup timing. The deterministic iframe quick lane completes 7/7, four Android-compared and three smoke, zero reported gaps. Source-matched selected Worker corpus: Aegis renders with four healthy processes and no diagnostics gaps/errors; ChatGPT fails application startup on DataStore's missing `global_device_uuid.json.tmp`. Matching JS Worker reproduces the same rename/ENOENT failure, isolating a shared Worker file-ownership problem. Wasm iframe startup corpus observes a frame and healthy diagnostics after 1.5 seconds; that limited observation does not close Gibbs's later full-flow Compose stack overflow. Raw captures, summaries and matched corpus controls are retained under `tests/e2e/actual/parent-recovery-5de5144f/`. Shared load excludes performance acceptance; corpus process exit 0 remains diagnostic-run completion, not a matrix pass.

The source `9be2ce51` aggregate `wasm all` completes exit 0 across all named suites, including six differential fuzz seeds, lazy traces, 72 thread checks, the default framework/FitNotes compile sweep and AOT persistence. Existing eight classdiff and eighteen Guava comparison pins remain explicit. Later `8a33a88d` initialization-wait/deferred-classloader integration passes typecheck, loader checks and 72 thread checks.

Parent reviewed RenderNode ownership against the paired Android 15 JNI branch (downloaded source snapshots `/tmp/webdroid-android15-{android_graphics_RenderNode.cpp,android_graphics_HardwareRenderer.cpp,VirtualRefBasePtr.java}`): RenderNode JNI acquires on create and decrements in the finalizer; root creation also acquires. At `db099c8d`, the actual static-owner NAR/VirtualRefBasePtr fixture passes ordinary and forced-cold execution. The NativeSource excludes VM/intrinsic host specs and Natives.plan retains NAR bytecode, matching this control's raw-referent registration path; a speculative separate facade-finalization theory has no contrary production trace. The known strong-refcount defect is repaired; its involvement in the earlier app crash is still unproven.


### Integrated Worker full captures and cold telemetry (2026-10-05)

At production db099c8d, shipping eight-jar AOT 3dd66df51379d6ac and harness 5efeb63f, the unmodified ordinary Worker full FitNotes/Calculator run exits 1. FitNotes completes 39 captures but crashes at 3-save in RenderNode.nHasIdentityMatrix (undefined hasTransform), through View.getLocationInWindow and Editor.PositionListener.onPreDraw; later captures time out. Its content difference is 27.95%. Calculator completes eight checkpoints without copied runtime/browser errors, with 13.41% content difference against the full reference; visual parity is not waived. The independent RefBase ownership fixture does not close the recurring application failure. Evidence is tests/e2e/actual/parent-recovery-db099c8d/worker-full.

The separate cold=1 Worker full run also exits 1: both apps exceed the unchanged 20-second boot limit; FitNotes later exceeds action, settle and liveness deadlines and has 84.50% content difference, while Calculator never presents live UI during the observed flow. Browser errors and new Java errors are empty, which does not establish liveness or correctness. No timeout or golden is changed. Evidence is the neighboring worker-cold-full directory. Both captures use jobs 1 but run under other diagnostic load and are not idle performance acceptance.

The existing coldCalls field belongs to the JavaScript tier and remains zero in Wasm captures. bindWorld now exposes distinct wasmColdMethods/Calls/Resumes/Deopts/SlowCalls, upgrades, and existing compiler-phase timings through perf. Worker snapshots already copy perf, so process-local values reach canonical run.json without a new sampling loop or hot-path timer. A temporary instrumented copy of the existing cold suite passes its 1,290 cases and verifies a real cold activation, separation from legacy counters and baseline resets. Full typecheck and diff check pass; logs are /tmp/webdroid-wasm-cold-perf-{runtime,typecheck}.log. These counters enable attribution; they do not improve cold latency or close G3.


### Y2 S5 canonical descriptor owner and ordered operations (2026-10-05)

`FileDescriptors` now owns regular files in the page's existing native kernel table. PID-bound broker ports expose typed `fileDescriptor` operations; mutable path opens retain the existing package/UID authority. Opaque process tokens do not reveal root descriptor numbers or authorize another PID's table. Duplication retains the same OpenFile, sharing file position and status flags while keeping close-on-exec descriptor-local, as [AOSP ParcelFileDescriptor.dup](https://android.googlesource.com/platform/frameworks/base/+/HEAD/core/java/android/os/ParcelFileDescriptor.java) requires. Only a trusted owner can duplicate a descriptor to a different PID; that explicit grant preserves access mode without rechecking recipient path ownership.

Operations are ordered by actual OpenFile identity, including asynchronous lazy reads, seek, positional reads/writes, duplication and close. Public close tokens retire at dispatch; the ordered kernel close prevents descriptor-number reuse while an earlier read is pending. Process death rejects queued/final replies, closes exactly its references after in-flight work, and leaves a granted recipient's open file alive. Wire read/write buffers are copied. Live writes and truncation reach canonical VFS immediately; an unlinked open inode remains usable without recreating its pathname. Pipes, sockets and other nonregular owners return explicit unsupported results through this new interface; their existing local native paths are unchanged.

Two selected existing Java IO core cases pass 22 assertions covering copied/live reads, shared offset/status flags, descriptor-local flags, unauthorized tokens/paths, unlink, independent death and reentrant duplication queued behind a suspended read. The existing real Chromium Worker endpoint fixture passes one case/10 assertions after adding actual PID-bound FD commands: the Worker writes canonical bytes, sees subsequent owner writes, and is denied a foreign UID's private path. Full typecheck and diff check pass. Evidence: `webdroid-shots/y2-s5-endpoint/fd-owner-{core,worker-core,typecheck}.log`.

This is an owner milestone, not FD or S5 closure: application Java/ARM descriptor entry points still need binding to these commands, Binder FD side-table capabilities still need canonical grants/lifetimes, and cross-Worker ashmem/shared mappings require shared backing rather than copied mappings. No APK/browser flow or performance claim follows. Owned server 4123 was stopped before continuing production edits; no owned capture/browser remains. Exit classification is unchanged: a recorded Java crash with status zero remains a failure, distinct from normal EXIT_SELF zero.

### Y2 S5 mapped EOF coherence correction (2026-10-05)

The descriptor audit reproduced a real coherence defect rather than changing the read fast path speculatively. A three-byte file mapped through the actual A64 mmap syscall receives stores at bytes 0, 2 and 7. The first javaReadFd correctly copies three bytes, but SharedMaps.flush previously writes the dirty byte at offset 7 into VFS and extends the backing file to eight bytes; subsequent reads expose data beyond the real EOF. The strengthened existing fixed-remapping fixture fails before the production change with expected length3/actual8. [Linux mmap documentation](https://man7.org/linux/man-pages/man2/mmap.2.html) specifies that stores past EOF in the final partial page are not written out to the file.

SharedMaps.flush now scans at most the intersection of the mapping and current backing-file length. Valid dirty bytes still reach every existing mapping and the canonical local VFS, while tail stores cannot grow the file during read, msync, unmap or fixed replacement. The existing remapping and multiwriter coherence cases pass two cases/12 assertions; full typecheck and diff check pass. javaReadFd's computation order is unchanged: correctly flushed mapped writes do not change the visible file length. Evidence: `webdroid-shots/y2-s5-endpoint/fd-map-eof-{before,core,typecheck}.log`. This local kernel fix is not cross-Worker ashmem backing or application FD acceptance. Guest fault delivery for wholly out-of-file pages, cross-Worker direct mapping coherence and remaining Java/ARM/Binder bindings remain open; no source-golden or exit-policy change.

### Y2 S5 production regular-file binding and ChatGPT startup cause (2026-10-05)

Matched unmodified ChatGPT.xapk runs on the JS tier distinguish the Worker platform failure from compilation: the Worker fails before UI with DataStore global_device_uuid.json.tmp ENOENT, while the iframe renders with errors[]. Bounded routed diagnostics show canonical File.mkdir returns success for the datastore directory, but the next Worker-local open(O_CREAT|O_TRUNC) sees no parent directory. The rename text is DataStore failure context; the immediate underlying errno is the inconsistent open owner. Double-boot guards are unchanged. Parent independently reproduces the same Worker failure in both JS and Wasm tiers.

The Worker installs a lazy descriptor command factory after process registration. Mutable file opens now allocate an opaque canonical descriptor and a local descriptor-table reference; local dup retains the same open-file token and canonical offset. Java libcore/RandomAccessFile/FileDispatcher and actual A64 syscalls/ARM32 libc stream operations await canonical read/write/seek/truncate/stat/sync/close. Root sync flushes the owning VFS before acknowledgment. Java mutable create/remove/rename and native mkdir/rename/access/stat use the same path owner; inode metadata, directory-descriptor operations and additional path operations remain unfinished. Root/legacy local paths retain their immediate implementation. Close retires local descriptors immediately but explicit callers receive the original owner completion/error; process-death cleanup remains canonical.

After the binding, the same unchanged JS Worker ChatGPT renders with advancing ticks, four process diagnostic rows, zero missing/native/errors and no browser error. This is startup coverage, not login or full app parity. Evidence under webdroid-shots/y2-s5-endpoint: chatgpt-vfs-js-{worker-before,iframe-before,worker-after}.{json,log}; chatgpt-vfs-audit-before.{json,log}. The audit alone blocks service workers so routed instrumentation reaches process-worker.js; the unmodified corpus checks retain ordinary hosting behavior.

The existing production Java/ARM core case now covers real AOSP RandomAccessFile plus Os.dup/rename, actual A64 open/read/write/seek/close and actual ARM32 fopen/fseek/fwrite/ftell/fclose over MessageChannel commands. Selected Java IO/native stdio files pass 36 cases/208 assertions; endpoint/data checks pass 22 cases/172 assertions; full typecheck and diff check pass. Logs are chatgpt-fd-io-core-final-isolated.log, chatgpt-fd-ports-data-final.log and chatgpt-fd-typecheck-final.log. A first bare-path Bun test invocation also selected ignored historical checkout tests and failed those stale copies; the explicit ./ paths rerun selects only current source.

Binder FD capabilities/grants are still unwired: remote descriptors do not export copied empty placeholder bytes. Shared remote mapping is explicitly unsupported rather than presenting a private snapshot as shared memory; local pipes/sockets and mappings remain on their existing paths. Cross-Worker ashmem/mapping coherence, remaining VFS operations/metadata and cross-process Java window-focus callbacks remain mandatory S5 work. Fresh merged-source Wasm/AOT verification is pending; no S5 or performance acceptance.



### Wasm shared-library loader graph and archive identity (2026-10-05)

The unchanged YouTube XAPK (eight DEX entries) and paired org.apache.http.legacy jar exposed a second failure after deferred archive reads were repaired: Java loadClass found BasicHttpParams in its shared-library loader, while compiler root lookup and host visible-class lookup could not. BaseDexClassLoader's existing sharedLibraryLoaders/sharedLibraryLoadersAfter arrays now define parent/before/own/after lookup order. The boot view excludes app definitions in layered Programs. Opening the same parsed DEX through another defining loader creates a separate namespace rather than aliasing classes/statics; findLoadedClass tracks initiating-loader results, not every indexed definition.

Changing the graph invalidates resolved DEX caches and refreshes existing MethodInfo/FieldInfo objects and byKey aliases in place, preserving raw descriptors, method indices and field identity. Linked static descriptor aliases retain the same globals. Compiled callers/CHA state and app AOT units using the old graph are invalidated. Linked physical hierarchy or dispatch-layout changes fail with LinkageError and restore the previous graph; this is an explicit limit, not support for arbitrary mutation after class publication. Constructor-time binding is the supported path.

The old host shortcut accepted any /data/app/*.apk as the current app. It now uses the canonical appArchives set from the owning DEX native module, with normalized paths. The existing loaders suite verifies cached own-app DEX identity and a separately read/cached other APK. It also compares real Java shared-library constructors against JS (result 21) in synchronous and deferred modes, warming MethodInfo, FieldInfo and an alias before rebinding and checking their identities/raw descriptors afterward. Typecheck and the actual YouTube library core repro pass: Java loadClass, Program lookup and host lookup all identify BasicHttpParams@1.

Before the final dispatch preflight/archive-identity refinement, the broad Wasm suite completed, including differential 1105+2, threads 72, nested, loaders, AOT and persistence. Its classdiff retains eight JS divergence pins and conformance retains baseline pins; these are not unpinned gate closure. Standard AOT delivery after the refinement validates 290828 methods in eight jars, with five existing gaps and 125 startup files. Source ca1d026c69c8775ef471b5bf5238d5f819a317eb864fc92fe7223b8eff98aa1b, key 3f085710c73e664f. Build timings are shared-load diagnostics.

The earlier graph source 936e231eff8bb213879b7cc6c9c3cc2c34afae2942d03374cb73b6501835cd3d/key e91cf0926a726266 completed both YouTube launch/notifications checkpoints with UI58 and advancing rendering/ticks. The shell still displayed a loading spinner; this is observed-path startup recovery, not full-flow/network or performance acceptance. A matching JS control completed both checkpoints with optional window-provider misses and HTTP400 Google registration errors. TikTok on that source reached MainActivity.onResume and native media initialization but produced no completed Wasm launch record before an owned 180-second external close. TargetClosed is the intervention, not the initiating cause. A JS launch record was responsive (wedged=false) but reported a settle timeout; its diagnostic stopped there. No observed X/00HN key gap in this incomplete Wasm attempt proves neither target execution nor TikTok closure. Evidence remains in tests/e2e/actual/y1-recovery/*library-graph*.

The final bc025612 refinement completed `wasm all` with no failed suite: differential 1105+2, threads72, nested, six fuzzer seeds, framework219874/FitNotes22259 zero-failure sweeps, AOT and persistence. The same eight classdiff and eighteen Guava comparison pins remain explicit. Fresh source ca1d026c/key3f085710 completed both YouTube browser checkpoints with no errors/missing/wedges or browserErrors, foreground ticks639→949, and144 foreground AOT modules observed at launch. Screens remain a rendered loading shell; no full-flow acceptance is claimed. The exact unchanged 55-DEX TikTok X/00HN.LIZIZ(IJ)…ViewHolder method compiles and V8-validates at22037bytes with zero gaps/linkErrors. The app-wide stall is still unresolved.

A follow-up existing-loader regression warmed a child's self MethodInfo and peer FieldInfo through its parent before attaching the parent's libraries. Both sync/deferred executions reproduced stale LShared descriptors while Java selected Shared@2. Rebinding now includes every defining loader whose parent/before/after visibility graph depends on the changed loader, and the linker checks all already linked owned metadata before applying static aliases. Root app AOT invalidation also occurs when a changed shared graph affects the root indirectly. The regression passes in both modes, with typecheck passing; raw descriptors and object identities remain unchanged.


### Parent integration: regular files and shared-library graph (2026-10-05)

Regular-file owner, mapped-EOF and production Java/ARM routing commits integrate as e2bc14fd, 25ec96e1 and c9c280dd. Full typecheck passes; explicit current Java/data paths run 43 cases/288 assertions, and native stdio plus the actual Worker endpoint fixture run 15 cases/92 assertions. The first selected command named two nonexistent paths; Bun selected only Java/data, so no endpoint/native coverage is attributed to that invocation. Fresh eight-jar shipping AOT 60bc02334818a1f4/source7ae4e5fa3129d110351b4a1bcfe18064e0887382add32effc2c024c21d5e684f records 153 startup files. Actual unchanged Wasm Worker ChatGPT startup fails with renderer Target crashed and unavailable process diagnostics; corpus exits zero despite this failed row, and is not a gate pass. Evidence: tests/e2e/actual/parent-recovery-c9c280dd.

Shared-library graph commit integrates as 80edae9e; typecheck/loaders, 72 thread checks and 153 shipping OSR checks pass. Standard eight-jar AOT 61104d66d0f187ef/sourcee9a6f25eeb884ea87c1f9411f129526ac428c5069d97f8b2ba8355498c8876a2 records 153 startup files, 290,828 methods and five existing gaps. An unmodified Worker ChatGPT replay with browser stderr confirms V8 javascript OOM (Scavenger: semi-space copy) before the first frame. The last printed collections belong to a young isolate with roughly 30 MB after collection; this alone does not identify the responsible allocation or total renderer memory. Renderer OOM is observed, while foreground retention, another Worker's bootstrap and competing load are cause hypotheses. No DataStore error precedes this failure, but that absence is not whole-app correctness. Evidence: tests/e2e/actual/parent-recovery-80edae9e. No golden, timeout, heap budget or exception policy changes.

Dependent-loader rebinding integrates as f41c3367, with typecheck/loaders passing; its fresh shipping AOT and application checks continue. Firefox and optional work remain excluded until the mandatory stages/gates finish.


### Worker split resources are published before package lookup (2026-10-05)

At f41c3367/HEAD391cb673, the actual Worker YouTube full flow fails during MainActivity.onPostCreate with Resources.NotFoundException for a drawable supplied only by a density split. Eleven of sixteen failed-flow captures are retained before an explicit SIGTERM closes the owned browser; the later TargetClosed abort is the intervention, not the initiating failure. The matched unmodified JavaScript Worker startup fails on the same resource. Evidence: tests/e2e/actual/parent-recovery-f41c3367, including corrected intervention metadata and the raw log.

The actual loadProcessPackages path over MessageChannel archive descriptors reproduces the mismatch: the registered PackageRecord's base-only table has no entry, while its boot Install's merged table has yt_outline_gear_white_24. registerApk preserves an earlier loaded entry, so publishing the incomplete package can permanently expose that table. The owning package now adds split resource tables and lazy asset sources to its PackageArchive before registerPackage publishes it. No drawable ID, package name or APK substitution appears in production. The base table is reused, and no additional archive read or base parse is introduced. Non-owning registry packages retain their existing lazy split policy; cross-package split-resource coverage is not established here.

The real archive bootstrap before/candidate/after controls confirm matching owning and boot tables after the change. Existing content/resource cases pass 21 cases/840 assertions; full typecheck and diff check pass. Fresh standard eight-jar AOT 94e552e81d82956d/source204eb7afbda4ebc963ea7098fb033cd8c419bba360204bbc363d903f432c4047 retains 153 startup files. Actual unchanged Wasm Worker YouTube draws with 191 advancing ticks, four healthy diagnostic rows and zero copied missing/native/errors during the short 1.5-second observation. This is startup coverage, not full app or idle performance acceptance.

The matched JS after-run passes the resource failure but exposes missing IStorageManager.fixupAppDir at the root Binder endpoint. Its paired Android15 StorageManagerService implementation validates the external app directory, resolves the installed package UID and asks vold to repair ownership; it does not create the directory. That canonical ownership work remains assigned to S5. The Wasm after-run logs a caught MemoryMappedBuffer.nativeMap transport-unsupported warning, confirming the remote-mapping limit on a real app path despite empty diagnostic error arrays. No missing operation is replaced by fabricated success. Logs remain /tmp/webdroid-wasm-worker-split-{js,wasm}-youtube.{json,log}, /tmp/webdroid-wasm-youtube-bootstrap-res-{before,candidate,after}.log, and /tmp/webdroid-wasm-worker-split-{content,typecheck,aot}.log.



### Wasm typed local reuse and Compose logical SOE (2026-10-05)

Gibbs's ChatGPT cold=0 launch trace reaches the compiler's $throw_soe with912 Wasm frames, rather than a physical engine RangeError. Its repeating Compose methods allocate140/176/326 locals despite live-web peaks10/21/14. MC previously allocated one physical local for every web, so sequential temporary definitions accumulated in each native frame. Guarding contributes approximately six locals rather than one allocation per poll; removing snapshot correctness or inflating Java depth is not the repair.

Inference now exposes conservative inclusive intervals from its existing CFG/liveness fixpoint: definitions, uses, normal live block edges and each throwing instruction's handler pre-state. The allocator reserves parameter webs and FLOAT entry copies, and shares storage only for disjoint intervals of the same physical Wasm type. Emitter scratch, shadow-cast, monitor and activation locals remain separate. Def/use endpoints overlap deliberately; normal result stores cannot clobber handler values. Cold entry register seeding and per-PC capture maps continue to address their actual physical storage. The unchanged depth accounting charges the smaller physical root/chunk frames. This is conservative interval reuse, not optimal graph coloring.

On merged parent391cb673 plus the allocation draft (Y1 mergeee26be1a), typecheck passes, differential1105+2 and all six fuzzer seeds pass, shipping producer/loader cold-OSR153 passes (interface invalidation, no-prefix replay, raw bits/references, monitors, native suspension and Java EH). Full wasm all passes including72threads, nested, libdiff, sweeps, AOT and persistence; eight classdiff and eighteen Guava comparison pins remain explicit. Standard eight-jar delivery validates290828methods/five existing gaps. This checkout's profile groups produce125startupfiles; startup-file count is distinct from153OSR assertions and differs from the parent's profiled153file list. Sourceaa0c2036f4ae96c6877d10b6c247c8ebf2961f1fac80189eb380ef16e8839a65/keyb79b1455e02326e9.

Matched module controls validate both allocations with/without guards. Komikku reportGroup guarded root152→72 locals, chunks88/67/32→53/45/28; Mihon root161→72. Selected ChatGPT methods' guarded local counts fall mww.invoke146→59, pk90.d182→73, ug0.invoke329→79, yz0.invoke185→46. Those isolated ChatGPT module controls omit the platform class path and retain identical baseline link-error sites; they establish emitted sizes, not standalone executable app correctness. Across the standard full platform, executable modules shrink340810→324665KB and largest capture carrier1665→144values. These are byte/work counts; compile and browser timings under concurrent diagnostics are not accepted performance measurements.

Actual unchanged ChatGPT.xapk launch at1080x2160@480,cold=0 renders the chat UI with87nodes, foreground ticks504,179presentations, no observed SOE, browserErrors/newErrors/newMissing/drawErrors and no wedge. Settling times out on active timers/network/vsync, so this is rendered launch coverage rather than whole-flow acceptance. The matching control intercepts page and compile-worker JS, skips only this.allocateWebs(), and keeps the same pooled platform AOT/input/source. It reproduces $throw_soe at917Wasmframes, uncaught Java StackOverflowError, zero UI nodes and a wedged app. No quota, heap, timeout or production APK change is involved. The observer fires only on SOE. Evidence: tests/e2e/actual/y1-recovery/local-reuse-{chatgpt-browser,chatgpt-unpooled-control}/{run.json,launch.png}, corresponding logs, layout controls and core logs. This does not close ChatGPT Worker OOM, full app parity, G1/G4/G5 idle timing or the separate TikTok stall.


### Y2 copied fatal reports survive Worker teardown (2026-10-05)

ActivityManager.handleApplicationCrash now reads the existing Java CrashInfo.stackTrace along with class/message/file/line. The owner copies those primitive fields into the process exit record before termination; terminal Worker snapshots copy the nested fatal report again so a diagnostic consumer cannot mutate retained evidence. Retention is bounded to512 class characters,8192 message characters,4096 file characters and65536 stack characters per record within the existing16-record package history. This is diagnostic data only: reason/status/expected-exit and crash repetition policy remain unchanged, including reasonCRASH/status0 as failure. No Java object crosses the port.

The existing real Chromium Worker archive/clock/death fixture now reports a fatal class/message/stack before death, mutates its original report, terminates, reads the retained owner terminal and mutates that returned copy. All fatal fields survive and the owner's next read remains unchanged; normal exit0, exit7 and force-stop classifications retain their existing expectations. One case/six assertions and full typecheck pass (fatal-worker-{core,typecheck}.log under webdroid-shots/y2-s5-endpoint). This provides cause evidence for Gibbs/parent RenderNode investigation; it does not fix or waive that crash. New production source requires fresh AOT before another Wasm capture.

### Y2 canonical Binder regular descriptor rights (2026-10-05)

Binder transactions now stage a reference to the page kernel's regular open file before serializing. Wire data contains a one-shot descriptor token, without a caller-supplied PID. The broker binds sender and receiver namespaces, consumes the staged reference and installs a receiver reference sharing the same backing, offset and status flags. Receiver descriptors use CLOEXEC, matching the driver's [FD fixups](https://android.googlesource.com/kernel/common/+/db6b0b810bf945d1991917ffce0e93383101f2fa/drivers/android/binder.c). Original Parcel recycling and sender death cannot close the receiver's reference. Partial exports/imports, rejected delivery and replies that cannot be published retire their owned rights. Adoption distinguishes a receiver's Java ownership from undelivered rights, so failure cleanup cannot close an adopted descriptor. Explicit close and process death retain their canonical owners.

The production Java Os/Parcel check exports a real file descriptor, recycles the original Parcel, rejects foreign sender namespace and replay, imports the receiver Parcel and verifies shared seek/write visibility and survival after sender death. It also checks receiver CLOEXEC and that delivery cleanup leaves an adopted descriptor alive. The existing real Chromium Worker endpoint fixture passes both actual port hops, returns a canonical FD right and reads it after the replying root PID dies. That receiver endpoint is a typed fixture, not a full cross-VM Java AIDL application. The existing owner/port case additionally closes a reply endpoint while its FD-producing call is pending and confirms the unpublished reference is retired. Selected Java/data/physical-Worker contracts pass45 cases/317 assertions; full typecheck passes. Evidence: binder-fd-{core-final,typecheck}.log under webdroid-shots/y2-s5-endpoint.

These rights apply to Binder transactions only. Stored serialized Parcels (intents, clipboard and pending-intent retention) still need a distinct retained-right lifecycle; they cannot reuse one-shot transaction rights. Existing local asset/ashmem snapshot paths remain and do not prove shared backing. Remote MAP_SHARED remains explicitly unsupported; direct ashmem/mapping coherence, remaining native VFS metadata/path operations, fixupAppDir canonical ownership repair and global Java window-focus callbacks remain S5 work. No new APK flow, generated AOT delivery or full S5 acceptance is claimed for this source.

### Private cold register buffers and instruction lookup (2026-10-05)

A traced actual Calculator Worker launch at8582d306 spends substantial active CPU in slow-step, snapshot and validation. Copied owner counters show2.8million slow calls and the app2.2million; neither presents a frame during that diagnostic. Weighted sampled leaf attribution is retained under tests/e2e/actual/parent-recovery-8582d306/cold-profile-attribution.json with idle, program and unknown samples preserved. This shared-load traced run is attribution only, not G3 acceptance. An untraced5ca6cfaa Worker diagnostic also produces no frame within60seconds, despite advancing ticks and empty observed API gaps; one GMS Worker remains not ready.

Private slow-operation snapshots now reuse their activation's register arrays. Normal snapshots used for restoration and optimized resume stay independent; completion and handoff discard private storage. Slow-operation instruction lookup indexes the already retained prepared instructions byPC instead of scanning them three times per operation. Existing validation, attempted-instruction boundaries, commit-on-success, monitor ownership and suspension ordering remain in force.

A temporary alternating five-round probe of100,000 snapshots with32 registers has median214ms fresh versus152ms reused; published snapshot independence, updated register values and distinct activation storage are also checked. The probe and raw logs are retained with the recovery evidence; this micro measurement is not an application speedup claim. Full typecheck,241 existing cold-slow checks,153 shipping AOT resume checks and canonical ready-async-native turn delivery pass before the final handoff cleanup. Actual application startup comparison remains required; no timing budget, quota or golden is changed.



### Y1 G1 shipping bootstrap entry (2026-10-05)

The shipping-AOT G1 runner used plain `processState`, reproducing `SuspendError: trying to suspend without WebAssembly.promising` during System/ICU boot before a workload ran. Use canonical `processStateAsync` when an AOT directory is selected; the ordinary on-demand control retains its plain entry. A fresh Node run of listAddGet (one repetition, one run) now matches JS and completes both calls with no failures or blocked rows. This is execution coverage only: other agents and the TikTok diagnostic were active, so its timings are not accepted.

The idle G1 command must select exactly `listAddGet listIter mapInt deque sort linkedList treeMap random casts jsonParse`, use `--engines node,chrome --reps 100 --runs 5 --phases --json <isolated-output>`, and point `WEBDROID_AOT` at the matching fresh shipping build. Leave `G1_STARTUP` unset: the standard startup manifest is the preload policy. Retain all ten rows, first calls, steady distributions, completed-call counts and failures; supplemental workloads are separate. These measurements still require a coordinated idle host window.

### Cold public-field reflection and preload attribution (2026-10-05)

The actualfab6d9e8 Calculator Worker cold control requests339 platform files in the owner,423 in the app and279 in GMS. Their union with the153-file process-bootstrap manifest contains422 executable/data modules (171.6MB versus34.3MB). A temporary response override preloads that observed union; production startup.json stays unchanged. The unchanged Calculator reaches one completed frame/four presentations and its startup endpoint returns in13.0seconds, versus no frame in the earlier60-second diagnostic. This shared-load control establishes missing-preload contribution, not idle G3 or full application acceptance. It exposes an unexpected GMS death in Class.getPublicFieldRecursive during SharedLibraryInfo Parcel decoding; empty foreground API gaps do not waive that death.

The Wasm-specific public-field native assumed every Java metadata callback was synchronous and iterated a Promise during cold getDeclaredFields. It now uses the canonical driven generator, awaiting fields, modifiers, names, interfaces and superclass callbacks while retaining declared/interface/superclass search order. A small unchanged DEX/JDK reproduction returns11375 on ordinary Wasm but throws NoSuchMethodError on the prior cold native; both modes return11375 with the fix. The existing fresh-World initialization fixture now includes that core own/inherited/interface/private-field case and selects the actual Wasm entry for callbacks, passing23 JDK comparisons including concurrent suspended strands. Full typecheck passes. Ordinary direct-root lookup also matches; plain cold-root lookup remains unsupported (previously NoSuchMethodError, now a native-suspension error), so the successful suspended entry is not a plain-entry claim.

Raw controls, observed module sets, copied process diagnostics and temporary probes are preserved under tests/e2e/actual/parent-recovery-fab6d9e8/. Fresh AOT with the changed native suspension ABI and an actual application after-run remain required. No manifest-size or latency gate is claimed by the routed diagnostic.


### Collection construction preserves suspended Java callbacks (2026-10-05)

The actual 4e870934 cold Calculator Worker control with the same diagnostic 422-module preload passes the public-field failure and presents a frame, but GMS dies while constructing a ParceledListSlice: newArrayList passes a pending Java constructor into add, or its callers pass a pending list into another Java call. The copied fatal reports an InternalError for a host Promise where a Java Object is required. Foreground rendering does not waive this process death. Raw after evidence is /tmp/webdroid-wasm-4e87-cold-preload-after.{json,log}; shipping startup remains153 files.

The canonical Wasm list builder now drives and awaits the Java constructor and each add. The JS field fast path stays direct. Callers await lists before storing Java fields, invoking constructors or delivering callbacks; enumeration and slice helpers use canonical after. AppWidget and PackageInstaller reuse the owning parceledList helper, while WiFi retains its distinct relocated slice class. No APK-specific behavior or timing budget changes.

Full typecheck and diff check pass. A temporary actual Wasm-entry probe creates and reads [a,b,c] through the canonical helper in compiled and cold Worlds; both also retain the public-field result11375. Existing device-services, notification, settings, android-content, java-lang, intrinsics, activity-manager and net checks pass140 cases/65886 assertions across eight files. Logs are /tmp/webdroid-wasm-list-suspend-{core,more-core,final-typecheck}.log and the probe source /tmp/webdroid-list-suspend-probe.ts. Fresh source-matched AOT and the actual application after-run remain required; this source check does not close full process health or startup latency.


### Canonical storage repair and inode metadata (2026-10-05)

Android15 StorageManagerService.fixupAppDir and vold VolumeManager/Utils validate the installed package and mounted user volume, repair existing package-directory components and their immediate entries, and leave a missing target absent. The implementation follows that operation for the supported emulated user0 data/media/obb paths, including package UID, category GID and mode02770. Unsupported volume/category paths report an error. Sources: [StorageManagerService](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android15-release/services/core/java/com/android/server/StorageManagerService.java), [VolumeManager](https://android.googlesource.com/platform/system/vold/+/refs/heads/android15-release/VolumeManager.cpp), [Utils](https://android.googlesource.com/platform/system/vold/+/refs/heads/android15-release/Utils.cpp). Child/Worker mount-service lookup now reaches the canonical root Binder owner, preserving the existing serialized Java transaction and caller identity.

VFS inode UID/GID/mode are retained across rename/unlink for open descriptors, copied in canonical path/FD stat replies and persisted with private files. Java Linux chmod/chown use the PID-bound owner command; canonical Java File paths resolve emulated-storage aliases before StorageManager validation. This does not implement quota/ACL/project IDs, full Unix access enforcement or the remaining native/NIO attribute stubs.

Selected Java/data/device/native-owner and browser-port fixtures passed65 cases/4469 assertions. Additional unlinked-inode coverage passes1 case/21 assertions; the actual Worker endpoint fixture passes1 case/10 assertions, including canonical metadata mutation and flush/reload. Its initial persistence failure came from missing fixture VFS attachment to the canonical file owner; restoring that real lifecycle setup fixes the check. Full typecheck passes. Strict eight-jar AOT builds290828 methods with5 recorded gaps and126 startup files, key04c91cfb50745d38/sourceb3f386f9ee7516c48f7d6339e175a5d1af33fdfc67edc7cffeb11b558e227b0e; restarted server manifest matches with HTTP200.

Actual unchanged YouTube Worker startup plus30-second observation completes in JS and Wasm with four healthy diagnostic rows and no copied native/runtime/browser errors. JS retains two optional window-provider class misses; Wasm reports no missing classes. A matching JS control removing only the fixup registration also completes: the earlier parent missing-method failure is not reproduced and no fixup invocation is established in these startup observations. This is not full-flow, performance or S5 acceptance. Evidence and diagnostic script: webdroid-shots/y2-s5-endpoint/storage-owner-* and storage-youtube-*; captures used df6f14a3 plus this production diff, identified by the exact AOT source above. All owned capture browsers and server are closed at handback.

Remote MAP_SHARED/ashmem direct-load visibility remains unsupported, including the previously observed caught YouTube nativeMap path. One-shot regular Binder descriptor transfer is implemented separately; stored-Parcel retained/replayed descriptor rights and their replacement/cancellation lifetime remain open. Copying bytes or flushing a mapping cannot substitute for cross-Worker shared-memory semantics.



### InputChannel disposal freed later RenderNode generations (2026-10-05)

The matched db099 Worker FitNotes diagnostic now identifies an actual foreign cleanup, rather than inferring one from a successful timing control. Source 7f9f07f6 / shipping AOT 3dd66df51379d6ac registered an InputChannel Cleaner at sequence 11125 for native handle 3063, whose wrapper allocation was sequence 11124. The slot was later reused at sequence 15377 for RenderNode generation 1222 (`android.widget.TextView`). The old InputChannel Cleaner invoked the generic finalizer and released that later node while its raw Java referent was still alive. The same handle then failed in RenderNode.nHasIdentityMatrix with `undefined.hasTransform`, after 35 checkpoints through 4-save. The earlier handle368 failure had no registration tag; its specific historical registry remains unrecorded. The new trace directly connects the same application failure mechanism to InputChannel disposal.

Android 15 [InputChannel JNI](https://android.googlesource.com/platform/frameworks/base/+/android-15.0.0_r1/core/jni/android_view_InputChannel.cpp) separates dispose (reset the shared channel) from the NAR finalizer (delete the native wrapper). The paired framework DEX calls nativeDispose(mPtr) without clearing mPtr. Our implementation prematurely released that wrapper handle, allowing finite-quarantine slot reuse before its still-registered Cleaner ran. nativeDispose now clears the wrapper's channel reference and leaves wrapper destruction to NAR. Disposed name/token and parcel queries return the uninitialized results from JNI; duplication throws RuntimeException. Live duplicates retain independent wrappers. No current-type free guard, strong referent root, generic handle encoding change or app substitute is introduced.

The existing real-bytecode ownership fixture adds InputChannel setup/dispose through reflection because it is absent from the SDK public stubs. The starting native fails with `InputChannel dispose freed its NAR-owned wrapper`. Ordinary and forced-cold executions pass idempotent disposal, disposed queries/dup, the live peer, 30 GC turns while Java retains the wrapper, then exactly-once NAR destruction after dropping both Java owners. Existing RenderNode ownership checks remain included; full typecheck passes. Evidence under conform-cache/cold-review/full-batch-browser: inputchannel-ownership-{red,green,cold}.log, inputchannel-typecheck.log, rendernode-db099-registration-generation-scoped/{trace,summary}.json, rendernode-db099-inputchannel-to-rendernode/{trace,summary}.json, inputchannel-dispose-dis.log, and android15-InputChannel.cpp. The earlier unscoped diagnostic is explicitly marked invalid because its callback tag persisted into explicit CleanerRunner calls.

Fresh shipping AOT and the matched repaired Worker browser replay are pending at this commit. This repairs the observed owner contract; it does not claim a general audit of every native's manual disposal, all stale-handle safety, or closure of unrelated cold startup/ChatGPT OOM failures.


- Matched repair verification completed: initial repaired diagnostic (`rendernode-inputchannel-fixed`) has 39/39 checkpoints, zero stale RenderNode cleanups, zero missing handles and no browser errors. Unmodified official Worker FitNotes full flow on aa82b110, AOT a208cad57e9d6e89/source 5f09a90695257384a963f90b2e7264bc174fe4acc8fe89b46b6ab2baba41c2a6, exits 0 with 39/39 rendered, 8.51% content difference and no observed errors/wedges. Because that branch also contains the independent a1 Vector ownership change, a second isolated verification restores handles.ts and vectordrawable.ts to 7f9f07f6, leaving only the InputChannel native repair on the failing runtime base. Fresh AOT 6ab3927428ab72fe/source e6fd8a29d9619b2b2b43dd38618cf972d33904b13d6568eef69dfa94b130a6c4 validates 290828 methods (the five existing gaps), completes 153 startup files and serves its index with HTTP200. The unmodified official full Worker flow again exits 0: 39/39 rendered, 8.51% content difference, no observed errors, wedges, missing APIs or required-native gaps. Raw/summary/epoch records: conform-cache/cold-review/full-batch-browser/inputchannel-only-official-fitnotes; logs inputchannel-only-{aot,official-fitnotes}.log. Capture code stayed frozen and owned browsers closed before restoring committed HEAD. No idle timing, cold-browser parity, later-main integration pass or broad stale-pointer safety claim follows from these checks.


### Integrated collection, storage and InputChannel recovery checks (2026-10-05)

Main9ceed5f1 integrates canonical suspended list construction01596955 and storage ownership9ceed5f1. Full typecheck,65 selected Java/data/physical-Worker/private-file cases4470assertions and23 cold fresh-World/JDK comparisons pass. The shipping producer/loader cold-osr --aot fixture passes153assertions; the earlier invocation without --aot covers41 and is not shipping coverage. Fresh standard eight-jar AOT78e3cd9ceb444b1c/source4f44ab117aa1f1e08bb24e2ee1ea8d5a8d8044ba6fac2128dae8d16db88c0dda validates290828methods/five existing gaps and retains153startupfiles. The actual cold Calculator Worker after-run with the unchanged temporary422-module preload reaches a rendered frame,2360foregroundticks and four healthy owner/app/GMS diagnostic rows, no observed missing/native/errors. Its startup endpoint returns12.23s under shared diagnostics, not an idle latency measurement. Shipping preload remains unchanged; full cold parity remains open. Evidence: tests/e2e/actual/parent-recovery-9ceed5f1.

InputChannel repair a5f14082 and its isolated verification history efad9424 integrate without the independent Vector change. Both ordinary and forced-cold actual-bytecode ownership fixtures and full typecheck pass. Matching eight-jar AOT612bdb445ed935c7/sourceed94c6864004b94f6747c7c02ca867b42ee256e022b1669c73a145ea6682f6e6 retains153startupfiles. The unmodified official Wasm Worker cold=0 FitNotes full flow exits0, renders39/39 and has8.51%content difference against unchanged goldens. Every initial/completed checkpoint has four process rows, no observed failed/unavailable diagnostics, missing/native/errors, timeout, wedge or draw error; browserErrors is empty. This verifies the reproduced InputChannel-cleaner/reused-RenderNode failure on integrated main, without claiming a general stale-pointer audit, cold-browser parity or idle performance acceptance. Capture source/AOT stayed frozen. Evidence: tests/e2e/actual/parent-recovery-efad9424/worker-fitnotes-full and adjacent logs/epoch records.


### Explicit Worker AOT profile read (2026-10-05)

`wd.workerAotProfiles()` explicitly requests each retained Worker's control `aotProfile` method. Rows include canonical PID/package/process/URL and either copied phase/identity/build key/wanted module names/live World linked and called class strings, or an error. The broker validates reply identity and bounds each read to5 seconds; existing AOT initialization is bounded to4 seconds. An absent store returns null without creating it. The read does not wait for startup prefetch, open a build or add module requests. Ordinary snapshots contain no new large lists. Parent owns the aot-profile.ts consumer; this API is diagnostic only.

The existing Chromium Worker endpoint fixture now checks absent-owner noninitialization, private Worker page-shared state, copied wanted/classes and an unresolved startup-prefetch promise:1 case/11 assertions passes. The fixture uses shared output chunks so separately imported helpers observe the same canonical module instance; the first unsplit fixture duplicated its private Map and correctly returned null. Full typecheck passes. No actual APK/profile tool replay or source-matched AOT rebuild is claimed for this diagnostic change. Storage, shared mappings and stored descriptor rights retain their separate acceptance limits.



### Bounded persisted-app compiler workers (2026-10-05)

Actual ChatGPT Worker allocation evidence on parentfab6/source040662401a20304d9a54a4bfa38a571852e8114d60ab4429f4dd00452541d176 identifies independent compiler Workers in select/buildApp/init, each constructing platform/app Program metadata and a compile-only World. The supplied concurrent sample observes three compiler heaps around729–791MB,3.67GB aggregate used heap and1.69GB backing storage. These are actual CDP readings, not the runtime heap-budget estimator. Program/DEX records and module instantiation have sampled allocation stacks; the precise fatal-allocation object is not identified.

Persisted app builds now acquire one origin-wide Web Lock before spawning their Worker or copying DEX containers. Each build keeps its original request and fresh numbering context; a refinement rebuilds from the same platform base and complete merged demand. The result's modules are transferred before the Worker is terminated. The lease remains held through completion, pending requests cancel with the owning AppCode, and failed/retired requests cannot close a later generation. Live upgrade compilation remains separate. Without Web Locks, worker retirement still applies but cross-realm serialization is unavailable. No guest Java identity, method slot, quota or heap telemetry is changed.

The existing persistence suite passes execution/adoption/stale-unit checks, saved-module policy and refinement, with one assertion that a transferred build retires its Worker. Typecheck and shipping cold-OSR153 pass. Standard eight-jar AOT validates290828methods with five existing gaps and153startup files. Candidate source71065044fc1a094079bcd72210d06825453acfa5165b8b4e4b24b6185cc9a70c/key677fa349052f8c66.

A fresh unchanged baseline control on the exact original source/AOTcecb95557b2ccf13 reproduces a renderer crash with up to four compiler targets. Its late concurrent heap reads are incomplete;2.73GB is an observed partial sample, not its peak or a valid percentage denominator. The candidate capture observes at most two compiler targets (builders plus separate upgrade service), completes without crash or intervention, and has a complete six-realm sample of2.82GB used heap plus1.28GB backing storage. At completion no compiler target remains. The launch still times out while busy and its screenshot is black with zero UI nodes; this is mechanism evidence and no OOM during that window, not rendered ChatGPT acceptance or whole-app OOM closure. All measurements are under shared diagnostic load. Evidence: tests/e2e/actual/y1-recovery/worker-builder-{baseline,lease}-chatgpt/{trace.json,summary.json,launch.png}, worker-builder-lease-{persist,typecheck,osr,aot}.log. Parent's later public-field callback repair changes the native ABI and requires another fresh build/control.


### Demand-started upgrade compiler Workers (2026-10-05)

The remaining separate upgrade service eagerly spawned and initialized a compile-only World for every process, including observed processes with zero upgrade jobs. Production now supplies a Worker factory: start records the owning World and platform/app source, and the first real hot request snapshots current DEX containers, numbering, initialized classes and host classes before starting the Worker. Requests queue during initialization while first-tier code continues. Default-loader additions before startup enter that snapshot; unsupported graph changes retire the service without spawning. Existing numbering synchronization, epoch checks and stale-unit rejection remain unchanged. A live service still retains its compiler World after actual work; this change does not claim bounded memory for every active compiler.

The existing persistence execution suite passes with a demand-started client: no unused Worker, one Worker on first hot request, pre-start DEX visibility, adoption and stale rejection, continued default-loader updates and inline fallback after incompatible loader changes. Typecheck passes. Evidence: tests/e2e/actual/y1-recovery/worker-lazy-{persist,typecheck}.log. No fresh application heap comparison or idle latency acceptance is claimed by these core checks; fresh source-key AOT and matching healthy app execution remain required.


Fresh actual Worker ChatGPT control after merging parentefad9424 runs source7f160b6cb5d42cc8d71b50c8ed3bfce6910bb5c8c90a405ede804e48760a6ca5/AOTc1eeb6d8be27913b (commitd3a13f76). Standard eight-jar delivery validates290828 methods/five existing gaps and153 startup files. The bounded observer has79 samples, at most two compiler targets, no browser crash and no observer errors. Largest complete six-realm sample:2488613356 used heap bytes and1604657305 backing bytes. Sampling also observes the app process Worker at1.41GB used heap; compiler-only bounds do not cover application metadata/module retention. No paired reduction percentage is valid against the original incomplete late baseline samples.

The copied terminal report still identifies ChatGPT PID1001 dying in Cronet ConnectivityManagerWrapper.<init> with NPE; launch reaches its40-second busy timeout, zero UI nodes and a black capture. The app death prevents an accepted sustained memory control even though no browser OOM occurs during this observation. All diagnostic timings remain under shared load. Evidence: tests/e2e/actual/y1-recovery/worker-lazy-efad-chatgpt/{trace.json,summary.json,launch.png}. The browser and owned driver have closed.

Canonical World.addDexes notifies added(null) for non-root defining loaders, and shared-library rebinding also retires a waiting upgrade service. initialize additionally rechecks class-loader aliases before sending DEX/numbering to the Worker; this protects deferred initialization independently of those notifications. The existing persistence suite verifies incompatible loader retirement before spawning, inline execution afterward, default-loader pre-start additions, actual unit execution/adoption and stale rejection.


### Calculator visual difference matched across tiers (2026-10-05)

Official efad9424 Worker cold=0 Calculator renders8/8, exits0 and has no observed browser/process missing/native/errors, wedges or timeouts. Its13.41%mean content difference matches a same-source unchanged JS Worker control: seven calculator checkpoints differ1.01–1.40%, while Back differs99.36% because the Android reference displays its Nexus launcher and webdroid has a blank post-activity screen. Result and Back PNGs are byte-identical across tiers (six of eight PNGs match; intermediate plus/second7 captures are not byte-identical). This establishes the specific difference's platform context and observed compiler-path parity, not launcher support or a waiver for other visual failures. Goldens and budgets stay unchanged. Evidence: parent-recovery-efad9424/{worker-calculatorm-full,js-worker-calculatorm-control} and corresponding logs.


### Stored regular descriptor rights at the clipboard owner (2026-10-05)

The clipboard previously kept the generic Parcel FD byte-snapshot representation. It now accepts staged regular descriptor rights into a broker-local StoredParcel, whose kernel references survive the originating PID. Each read duplicates into the live recipient's descriptor namespace with CLOEXEC; shared open-file position/status and backing remain canonical. Serialization copies only wire bytes/handle values. Replacement/clear closes the prior store references, partial retention closes acquired rights, failed reply delivery discards incoming tokens, and repeated close awaits the same cleanup. A failed replacement preserves the prior clipboard. An existence-only command avoids allocating rights for hasPrimaryClip. No retained kernel object or Java object crosses the port.

Android15 [ClipboardService](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android15-release/services/core/java/com/android/server/clipboard/ClipboardService.java) stores/replaces its primary ClipData; native [Parcel](https://android.googlesource.com/platform/frameworks/native/+/master/libs/binder/Parcel.cpp) duplicates owned descriptors and releases them with Parcel storage. Android15 [ActivityManagerService](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android15-release/services/core/java/com/android/server/am/ActivityManagerService.java) rejects descriptor-bearing Intents in getIntentSenderWithFeature. The canonical PendingIntent creation owner now applies that rule and discards submitted staged rights on rejection. Alarms retain the resulting sender ID, not separate FD grants. The parent-owned Java getIntentSender entry still needs its early hasFileDescriptors check before encoding, to avoid reaching the generic snapshot exporter first; this milestone does not claim that entry-path closure.

Existing Java/data/browser core fixtures pass45 cases/324 assertions and full typecheck. Production Java ParcelFileDescriptor serialization/import over descriptor ports checks sender death, repeated replay/shared offsets, reentrant release and recipient survival after store release. The actual Chromium Worker fixture uses production clipboard/pending/FD broker commands: reads1,2,3,4 share the offset across repeated reads and sender death; a receiver's pwrite changes the canonical file; partial replacement fails without losing the prior clip; rejected PendingIntent rights are retired. The fixture initializes the system data directory normally present at boot. The first broad invocation omitted ./ and discovered ignored archived recovery tests; that owned run was stopped and is not gate evidence. A subsequent Java fixture cleanup correction restores the descriptor transport before later tests. Final evidence is webdroid-shots/y2-s5-endpoint/stored-rights-{core,java,worker,typecheck}.log.

No fresh AOT/APK flow or performance acceptance is claimed for this change. Shared ashmem rights explicitly fail this retaining transport; remote MAP_SHARED remains unsupported rather than being converted into a private copy. Other retained Parcel consumers, including canonical notification state, need their own ownership integration. The clipboard retains only its current store; imported descriptors follow their recipient lifetime. Shared mappings require a native-memory design: core.ts creates a separate memory per process, mem.zig translates all pages into that memory, Java mem accessors and emitted native JIT loads/stores use the same private backing. Sharing that entire memory would also alias fixed-address MMU/core state. A shared backing-region design must preserve private control state and route interpreted/JIT/Java accesses through the same physical owner; RPC flush/diff synchronization is insufficient.


### PendingIntent Java owner rejects descriptors before encoding (2026-10-05)

The canonical getIntentSenderWithFeature native now awaits Intent.hasFileDescriptors for every supplied Intent and throws the Android IllegalArgumentException before encoding any of the stack. This complements the broker's wire-right rejection and avoids entering the generic snapshot exporter. The existing operation-type fixture adds a real ParcelFileDescriptor extra, calls the Java system-owner entry and verifies rejection without closing the caller descriptor. Selected content/Java-I/O/data/real-Worker checks pass66cases/1166assertions across four files; full typecheck and diff check pass. No new APK or performance claim.

An initial public PendingIntent probe instead hits the client Binder's existing disallow-FD marshalling rule before the owner. That failed probe and one broad invocation were explicitly stopped after verbose Java-object diagnostics; only bounded first64KB records are retained, and they are not passing gate evidence. The corrected owner fixture catches both synchronous and suspended Java throws. Final logs: /tmp/webdroid-wasm-pending-fd-owner-after.log, /tmp/webdroid-wasm-stored-pending-profile-{core-final,typecheck-final,aot}.log. Fresh eight-jar source5630a0cb67726ca9b08982a54a9066437db8f2cb2f2df6e463b689ffc7e642e3/key1e14d9e7d9e48a75 includes clipboard6acbbbad, profile-readinessa3f7fafc and this guard;153startupfiles/five existing translation gaps remain.


### Wasm G1 steady state and G4 tier-up (2026-10-06, `knlnks/wasm-za`)

Shared host, interleaved base/head runs of the ten G1 workloads (3 runs × 100 reps × 2 rounds); base `c99066e1` with guarded AOT, head `76f3901f` with the unguarded build. Steady-state geomean js/wasm: node 1.16 → 2.03, Chrome 1.13 → 1.99; weakest Chrome sort 0.99 (0.91 with the app build). First call: node 0.50 → 1.13 (1.68 with an installed app build); Chrome 0.11 → 0.31 on demand and 0.93 with the app build, so G1's first-call bar still fails in Chrome. G4 (`gate-browser`, n = 32M): all three loop shapes reach optimized speed in 22–23 ms; irreducible loops previously never did.

- The ~190 ms first call was the CHA implementor index decoding every platform method on the first wide query; a method-id scan answers it and the index is built only after 128 queries.
- Outlining second-tier loops allocated and copied state per entry and shrank V8's inlining budget; keeping them in the method took node steady state from 1.25× to 1.73×.
- First-tier chunks ran two counters per iteration and irreducible/handler cycles left the chunk on every region change. Fuel is now charged per chunk, each cycle runs as one chunk, and a method whose first tier ran 64 chunks in one entry gets chunked loops in tier 2.
- The inline upgrade policy was timing-dependent: leaves now wait, the cost estimate is a fixed 1 ms, the queue is oldest-still-hot first and the outermost waiting frame goes first (mapInt and deque are no longer bimodal). Virtual-call guards cover the implementations that have run (Chrome listIter 0.145 → 0.080 ms).
- Processes without the cold interpreter load an unguarded platform build: startup code 17.0 → 11.5 MB, all code modules 331 → 218 MB.
- Rejected after measuring: a tier-2 hybrid that moved an inline loop into a chunk at a fuel tick (larger methods stopped inlining), direct calls to final targets (neutral), callee-sized compile estimates (worse steady state), a JSPI yield fast path (a suspend costs ~55 ns).
- Remaining Chrome first-call cost (inferred): instantiating six modules including the 361 KB app module plus Liftoff's lazy compile, ~1–2 ms fixed per first call; random and jsonParse also run an inline second-tier compile inside the first call.

### Interrupted Wasm work recovered and integration baseline repeated (2026-10-06)

The integration source at `7d5f8ae2` passes `bun run typecheck`, `bun run test` (1,199 cases, 79,525 assertions), `bun run wasm fwtest` (31/31 exercises, zero unexplained differences), and every suite in `bun run wasm all`. The latter includes 1,290 numeric interpreter comparisons, 1,105 core differential cases, six fuzz seeds totaling 14,400 comparisons, 42 matching Java benchmark workloads, 72 thread checks, the conformance subset with zero unexplained differences, AOT loading and persisted-code checks. The compile sweep translates 291,144 method bodies across six platform jars and FitNotes with zero failures; Its four platform and 19 FitNotes emitted Java linkage-error sites remain explicit. The four-jar AOT fixture still records five existing binding gaps. Translation and the conformance subset do not establish full G2 or browser acceptance.

Commands ran from `/Users/kunalan/Projects/webdroid-wasm`; Wasm suites used `PATH=/opt/homebrew/opt/openjdk@17/bin:$PATH`. Logs are `/tmp/webdroid-wasm-recovery-{typecheck,tests,fwtest,all}.log`. These are correctness runs under concurrent recovery work, not idle timing evidence. Pending compiler edits and the launch/correctness worktree commits have not been included in this source epoch. Their cache validity, defining-loader semantics and suspended-native strand ownership require review before integration. Full conformance, full/live/corpus browser checks, cold Worker parity and final idle performance gates remain open; the Wasm default switch and JavaScript oracle removal have not occurred.


### Interrupted Wasm packages integrated (2026-10-07)

The compiler/app-build, AOT verdict/launch and loader/JNI/native-callback recovery packages are merged through `8f6c2e36`. Review corrected prefix-sensitive cached verdict reuse, retired stale app exports after loader graph changes, restored parent-first class resolution, rewrote JNI descriptors into the defining-loader namespace and replaced inferred native-wait ownership with explicit active-strand ownership. The compiler package repairs child/grandchild synthetic build closure and uses the canonical yield operation. The installed G1 protocol now reports its prestarted worker/setup costs and remains supplemental to ordinary first-call measurements.

Combined full typecheck and 1,200 unit cases/79,532 assertions pass. The initial typecheck and broad Wasm run caught a missing `jsLibraries` declaration in the recovered loader fixture: the agent had tested that declaration in its uncommitted proxy changes. `c0bbbd81` restores just the shared-library control; corrected full typecheck and `bun run wasm loaders` pass. Every other broad-run suite passes, including 81 thread checks, all six fuzz seeds, the conformance subset with zero unexplained differences, the compile sweep, AOT and persistence. The original broad invocation exits 1 solely on the missing declaration; its corrected focused repeat exits 0. The combined framework repeat also passes 31/31 exercises with zero unexplained differences; focused cold-slow and cold-OSR repeats pass 241 and 41 checks respectively, covering suspended-native snapshots, monitor/effect ordering and active compiled transfers. Logs: `/tmp/webdroid-wasm-recovery-integrated-{typecheck,typecheck-fixed,tests,all,loaders-fixed,fwtest,cold-slow,cold-osr}.log`.

The reviewed generic proxy fixture independently reproduces loss of the supplied defining loader, collisions between equal binary names in distinct loaders and bootstrap visibility of an application-generated proxy. That repair is separate and unfinished. Fresh production AOT, full browser/conformance and idle G1/G3/G4/G5 measurements remain required; these integration checks establish no performance acceptance or default switch.


### Proxy ownership and frozen browser/conformance cut (2026-10-07, `a4eaa981`)

Proxy generation now retains the Java-supplied defining loader. Synthetic definitions have explicit ownership, including arrays, host implementations and inherited Program layers. Equal binary names in different loaders remain distinct; application proxies are not bootstrap-visible, and existing initiating-loader entries survive later parent definitions. The existing loader fixture covers public Proxy caching and defensive duplicate rejection. The duplicate safeguard throws a Java LinkageError instead of a raw host Error; ART's private CreateProxyClass treats duplicate insertion as an internal invariant, while its public Java cache prevents that ordinary path. Clean committed-tree loader, class differential, 81 thread, 31 host-class, AOT/persistence and full typecheck checks pass; logs are `/private/tmp/webdroid-zc-proxy-clean-*.log`.

Fresh ordinary AOT `f8a3e78e2bafb862` and guarded `c2ca71a63a67476f` share source `26fc67e7d9351f70e9a1e07436966c744dc38356358314ef01f0e7bedef48afc`. Both compile 290,828 methods in eight jars with five existing binding gaps; startup lists contain 150 and 153 files. The owned integration server is on port 4198. The quick jobs-1 gate passes 7/7 flows and 105 checkpoints: 290 copied process snapshots are available, no wedge, settle timeout or draw error is recorded, and the harness reports zero gaps. Komikku retains SQLite warning logs and produces a 458-byte backup; the prior recovered zero-byte capture is not evidence of this run's cause or restore completion. Goldens are unchanged. Captures and a source/artifact-hash manifest are under `tests/e2e/actual/parent-recovery-a4eaa981/quick` and its parent directory.

The frozen nine-suite conformance driver retains both tiers' raw records and source checks under `conform-cache/g2-integrated-a4eaa981`; all nine suites exit 0 with zero regressions and zero unexplained differences, retaining 410,872 raw passing executions, 597 failure records and zero skips. Expected shared failures and pinned divergences remain explicit; the time suite also records ten baseline tests neither tier runs. Every before/after source check matches the frozen hash. The full jobs-1 browser matrix finishes with exit 1 after 15 flows and 221 checkpoints; Reddit, TikTok, YouTube, ChatGPT and Genshin fail. It reproduces TikTok's launch wedge, ChatGPT's activity-process loss/wedges and Resy's missing savedUserProperties field. A same-source JS ChatGPT full control from zA renders 24/24 steps in 92 seconds with zero wedges, settle timeouts or browser errors; the Wasm run renders 6/24 and wedges from the response checkpoint. Resy's same-source JS control from zC renders 15/15 without the Wasm field fault. Live-input and timing differences still require causal investigation; these controls establish concrete tier differences rather than a regression waiver. Full capture logs are `/tmp/webdroid-wasm-recovery-a4eaa981-{quick,full,js-chatgpt,g2,aot}.log`; the Resy control is `/private/tmp/webdroid-zc-resy-js-a4-control.log`. A bounded ChatGPT diagnostic prefix identifies the activity error as a secondary DeadObjectException. Canonical copied exit storage identifies the initiating Java NullPointerException in Chromium ConnectivityManagerWrapper.<init>, called by NetworkChangeNotifierAutoDetect on the Cronet initialization HandlerThread. The unchanged app constructor explicitly passes a null Context; why the JS control avoids this failing path remains under investigation. The stack line number is not a DEX program counter. Evidence: /tmp/webdroid-wasm-chatgpt-{exception,exit-storage}.json and /tmp/webdroid-wasm-chatgpt-exits.log. The diagnostic changes no production source or application bytecode. No idle G1/G3/G4/G5 acceptance or default switch is claimed.


### Frozen-source controls and Reddit One Tap ordering (2026-10-07)

At runtime `a4eaa981`, full typecheck and all 1,200 unit cases/79,532 assertions pass. The serial JS controls for Reddit, TikTok, YouTube and Genshin finish with exit 1; raw captures and source metadata are retained under `tests/e2e/actual/parent-recovery-a4eaa981/js-failed-flow-controls`. Reddit renders 6/6 without wedges or settle timeouts. TikTok renders 13/13 but times out at launch; unlike Wasm, its main loop is not classified wedged. Its shared optional native probes do not explain Wasm's libmetasec native stall. YouTube renders 16/16 without initial settle timeouts but fails later required video-control targets; live inputs vary, so this is no regression waiver. Genshin's requested XAPK is absent from the shared input directory: its URL returns HEAD 200 with zero size and GET 500 HTML. Both tiers record the resulting ZIP failure and render 0/3. Those captures do not exercise the game's compiler paths. The user has been asked for the input location. Logs: `/tmp/webdroid-wasm-recovery-a4eaa981-{typecheck,tests,js-failed-flows}.log`.

Reddit's Wasm captures establish a full-flow ordering bug: launch shows the welcome screen before One Tap arrives; the unconditional Back closes Reddit, the next checkpoint shows One Tap over a black background, and the login tap later reaches the restored welcome screen. The JS control sees One Tap at launch and follows the intended sequence. The full flow now shares the existing fast action that waits for and dismisses the One Tap sheet, removing the duplicate action. With unchanged app/runtime, geometry and goldens, the selected full Wasm repeat exits 0, renders 6/6, reaches the login sheet, and records no missing entries, errors, wedges or settle timeouts. Pixel review still finds One Tap at the sign-up checkpoint, so the intended complete sequence remains unverified despite exit 0. Raw captures: `parent-recovery-a4eaa981/reddit-one-tap`; log: `/tmp/webdroid-wasm-recovery-a4eaa981-reddit-one-tap.log`. The 98.7-second run is under diagnostic load and is not a performance measurement.


The follow-up harness repair lets a live wait require an observable state through the existing state checker, retaining its original horizon plus timeout as the real-time budget. Reddit now requires One Tap at launch, its absence and the welcome screen after dismissal, and the named sign-up/login states before advancing. Full typecheck and the unchanged-runtime selected repeat pass: six state-settled checkpoints, no missing/errors/wedges/timeouts, and copied UI/pixels confirm the sign-up and login sheets at their intended checkpoints. This closes the reproduced flow-order fault; the initial exit-0 repeat remains recorded as incomplete evidence. Captures: `parent-recovery-a4eaa981/reddit-state`; logs: `/tmp/webdroid-wasm-recovery-{reddit-state-typecheck,a4eaa981-reddit-state}.log`. The 80.8-second duration is diagnostic, not idle performance evidence.


The live-flow watchdog previously excluded requested real dwell: TikTok's `liveSample(90_000)` was interrupted by a 50,000-ms outer bound (20,000-ms timeout plus 30,000-ms diagnostic margin). Both frozen tiers' launch settle-timeout records therefore include a deterministic harness failure. The watchdog now includes a live wait's horizon or sample dwell before its existing timeout/margin. A temporary Chromium probe runs the production serialized probe with scaled host timers: removing just the horizon contribution reproduces a settle hang at 50,000 logical ms; the repaired probe completes the requested sample at about 90,260 logical ms without a hang. This is watchdog mechanism verification, not APK execution or performance evidence; Wasm's separate native main-loop stall remains open. Probe and log: `/tmp/webdroid-wasm-real-horizon-probe.ts`, `/tmp/webdroid-wasm-recovery-live-horizon-probe.log`.


### Dynamic loader resolution follow-up (2026-10-07)

The private `cf6949d1` candidate moves initiated identities into Program and refreshes stale DEX/member resolution through canonical World invalidation. Clean-tree loader, class differential, host-class, thread, persistence and typecheck checks pass, including a real DelegateLastClassLoader definition and warmed self-type caches. It is not integrated as browser acceptance: live A4 ChatGPT's GMS loader `@6` has initiated ImplVersion and NativeCronetEngineBuilderImpl, but not NetworkChangeNotifier, AutoDetect or ConnectivityManagerWrapper. Its GMS CronetLibraryLoader resolves those uninitiated references to the app's stripped Chromium classes.

Private C controls use on-demand compilation with `/aot/current.json` returning 404, avoiding a stale image. ChatGPT still throws the initiating Cronet NPE; its wedged full capture is explicitly stopped after six retained checkpoints. Resy renders 15/15 and loses the old savedUserProperties fault, but InitializationParams now resolves AbstractSafeParcelable to the app definition, which lacks findCreator. A generic child Helper reference reproduces the mechanism: JS returns child value 42 while C returns parent value 11. Successful explicit initiation alone therefore does not establish generic symbolic resolution. The next repair must invoke the actual Java loader at the required resolution point and cache its identity, preserving at-use exceptions, reentry and initialization ordering.

Instrumentation counts three resolution changes in each primary realm: Resy performs 314 initiations, 14,690 linked-class visits and 68,663 refreshed class entries; ChatGPT performs 603 initiations, 42,859 visits and 104,208 refreshed entries. These are work counts, not timings. Evidence: `/tmp/webdroid-zc-cf6949d1-diag/{summary.json,uninitiated.log,resy-hierarchy.log,chatgpt-capture-intervention.json}`. Parent runtime remains `a4eaa981`, with its original source/AOT epoch retained.


## Wasm recovery: require a sampled frame for pixel settling (2026-10-07)

The browser probe reset its frame hash to `-1` at each quiescent/live step, then passed that sentinel to the shared stability rule. Repeated sentinel samples could report `pixels` without any presentation. The probe now requests a compositor redraw while its first sample is absent and accepts only a nonnegative stable frame hash. Main jobs, queued work and transitions still prevent pixel settling. `redraw` schedules page composition; this change does not manufacture Java progress.

A controlled Chromium comparison using the production serialized probe reproduces the original false pass (`pixels`, zero presentations). The corrected probe observes an actual bitmap presentation; delayed presentation also settles on a valid hash. An unresponsive renderer and an active main job both time out. Raw evidence: `/tmp/webdroid-wasm-static-settle-probe.ts` and `/tmp/webdroid-wasm-static-settle-probe.log`. Full typecheck and diff check pass. No permanent fixture or golden changes were added.

A three-step actual Wasm YouTube diagnostic on runtime `a4eaa981`, source `26fc67e7d9351f70e9a1e07436966c744dc38356358314ef01f0e7bedef48afc`, repeats launch, optional notification denial and Guest Home. All three snapshots contain a real presentation; launch and Home settle, but notifications still time out. The driver exits 1. This is not full-flow acceptance or an idle timing measurement. Evidence: `tests/e2e/actual/youtube-static-diagnostic/run.json` and `/tmp/webdroid-wasm-recovery-a4eaa981-youtube-static.log`. The actual prefix used the equivalent initial sentinel guard; the final guard additionally rejects a sentinel retained in the sample window after delayed presentation. Further notification/compile-latency investigation and final integrated captures remain required.


## Wasm recovery: suspending JNI class-loader lookup (2026-10-07)

Executed JNI `FindClass` now has an optional tier resolver that can enter the referring class's Java loader and suspend. Synchronous known-class lookup remains available to JNI export binding. The Wasm adapter uses the canonical `World.resolveClass` contract from `ab34d754` on a nested strand belonging to the native caller. The guest trampoline retains its CPU/local-reference owner after suspension and converts synchronous or asynchronous Java failures into a pending JNI exception with a zero return. Android 15's [JNI implementation](https://android.googlesource.com/platform/art/+/refs/heads/android15-release/runtime/jni/jni_internal.cc) routes `FindClass` through the class linker without class initialization; the adapter follows that boundary.

The existing loader fixture exercises actual guest `GetEnv` and `FindClass` trampolines: a Java loader suspends then returns a class, or denies the lookup and leaves `ClassNotFoundException` pending. The full loader fixture passes, full typecheck passes, and the native bridge suite passes 13 cases / 73 assertions. An initial fixture incorrectly used symbolic host lookup for a JNI table entry and entered address zero; that diagnostic was stopped. The corrected fixture reads the public JavaVM/JNIEnv tables. Evidence: `/tmp/webdroid-wasm-jni-resolution-{loaders,typecheck,native-bridge}.log`.

This change is verified in an isolated checkout based on the canonical initiated-class and resolver commits. It does not repair compiled bytecode's unresolved symbolic sites, `Class.forName`, or final integrated APK behavior; those require the remaining loader integration and browser/conformance gates. No AOT artifacts or visual goldens were changed.


## Wasm recovery: integrated handles and defining-loader ownership (2026-10-07)

The integration branch now contains initiated-class lookup (`901ff1a4`), canonical Java-loader resolution (`5f7348ef`), suspending JNI lookup (`b7bd184d`), MethodHandle/MethodType constants (`84bd97dd`) and libcore transformer/frame execution (`b5c2b123`). Transformers execute unchanged libcore bytecode and use its frame accessors; duplicate host implementations of primitive adaptation and constructor-transform behavior are removed. Async continuations retain their original strand's thread and monitor ancestry.

At frozen `b5c2b123`, serial focused suites pass: loaders; customdiff (531 reference cases, 156 cold cases, 12 suspended cases); threads (81/81); cold-slow (241 checks, 69 methods, 622 activations). Full typecheck also passes. Logs: `/tmp/webdroid-wasm-recovery-b5c2b123-{loaders,customdiff,threads,cold-slow,typecheck}.log`. These are combined-source core results, not app or idle-performance acceptance.

Review of package access exposed a canonical ownership error: ordinary inherited platform DEX classes were attributed to the derived application root. The real platform Class probe reproduced that identity; synthetic-owner tests alone did not cover it. `0190838c` normalizes the immutable base's root DEX classes to the process's logical bootstrap owner, preserves explicit custom/synthetic application owners and leaves flattened no-base Programs in their root. The layered fixture now places its application DEX in the application Program. `e4c0a8ea` makes package access compare binary package and defining loader. Only overlapping fixture imports needed merge resolution. Integrated loaders pass; at `e4c0a8ea`, classdiff passes 35 cases with nine pinned JS differences, and hostclass passes 31 cases. Logs: `/tmp/webdroid-wasm-recovery-platform-owner-loaders.log` and `/tmp/webdroid-wasm-recovery-e4c0a8ea-{classdiff,hostclass}.log`.

Generic bootstrap/callsite execution, remaining polymorphic modes, compiled symbolic loader requests and Class.forName remain follow-up work. Fresh AOT, final application/Worker/cold matrices, full conformance and idle G1/G3/G4/G5 gates remain required after source integration settles. The old server at 4198 is stopped. WP-B retains an independent frozen A4 source/AOT server at 4207, with all 4,324 AOT files hash-verified, for matching starvation controls; its long renderer-task/profile evidence remains diagnostic.


## Wasm recovery: generic call sites, turn admission and bootstrap checks (2026-10-07)

`f19b9941` integrates Java-loader Class.forName and preserves initialization errors outside lookup-error wrapping. Its combined loader checks pass, including the guest JNI path. The JS reference-array Class.forName control remains explicitly unsupported; it is not an equality proof. `f2fc6e87` replaces the ObjectMethods-specific compiler with execution of actual Java bootstrap methods and CallSite targets. Success publication permits bootstrap races, does not deduplicate pending Java calls or cache failures, and reads mutable targets at invocation. Android 15 source supplies the collector/retry/race expectations; no ART-device run is claimed. The synchronous MethodHandle follow-up retains plain-stack blocking rejection and cleans up ownership.

Frozen `216e9f71` passes full typecheck and customdiff: 604 reference, 229 cold, 12 suspended, eight ART-derived collector/retry/race and two synchronous-callback cases. Its broad `bun run wasm all` exits 1: diff, hostclass, jbench, nested and conformance setup fail. Numeric cold (1,290), library differential (16,480), class differential (35), loader, entry, six fuzz seeds, threads (95), sweep, AOT and persistence pass. The sweep has zero compilation failures, retaining its explicit linkage-error sites. The broad run is not subsequently relabeled successful. Logs: `/tmp/webdroid-wasm-recovery-216e9f71-{all,typecheck,customdiff}.log`.

Diagnosis separates fixture assumptions from runtime work. Full-width reflection omitted core-icu4j; actual loader execution reaches CharsetFactory. Hosted-object checks compared possible Promise returns with objects before awaiting them. Synchronous process setup and a shared-World HTTP check encounter a legitimately suspending charset native. Matching pre-Class.forName source controls pass; temporary bundling replaces only changed production source with `facfb3d5`, retaining the same fixture inputs. `21b46735` supplies the missing classpath and awaits actual setup/results. Focused repeats pass 1,105 differential cases plus two full-width cases, 31 host-class cases, nested entries and quick conformance (2,177 unique tests; zero regressions/unexplained differences). Full typecheck passes. Evidence: `/tmp/webdroid-wasm-recovery-216e9f71-{diff-fixed,hostclass-fixed,nested-fixed,conform-quick-fixed,harness-typecheck}.log`, `conform-cache/g2-integrated-216e9f71-setup`, and the `facfb3d5-*-control.log` files.

ZIP opening still fails after that setup repair: FileSystems initializes its default provider, Class.forName enters BootClassLoader, VMClassLoader initializes resource JarFiles, and File.toPath re-enters the incomplete default filesystem. The cause is NullPointerException wrapped in ExceptionInInitializerError. The paired `vendor/aosp/preloaded-classes` orders VMClassLoader before FileSystems. `66e6b7d2` follows that order in the asynchronous harness bootstrap, executing Java initialization rather than replacing it. A controlled probe closes the unchanged ZIP workload; all 42 workloads and 31 host-class cases subsequently pass. The 1,200-case unit suite/79,532 assertions passes at `21b46735`. Logs: `/tmp/webdroid-wasm-recovery-216e9f71-{zip-cause,zip-preload-probe}.log` and `/tmp/webdroid-wasm-recovery-21b46735-{jbench-preload,hostclass-preload,tests}.log`. These diagnostic timings are not performance acceptance.

`6969db4d`/`a34ec939` admit lazy links between compilation units once the cooperative turn budget is due and restore caller state on both success and rejection. Plain host exports retain synchronous semantics; promising entries unwrap the export. B's private source-matched ordinary/guarded AOT, selected thread (50), cold (1,290), OSR (41), AOT and persistence checks pass. Actual private TikTok candidates still fail before drawing; shorter compilation tasks alone do not establish startup parity or a latency gate. The conditional host Runnable suspension declaration is integrated at `e5a5ff38`; its private core fixture reproduces the undeclared Promise and passes 54 selected checks after repair. The subsequent actual candidate reaches an undeclared ServiceManager suspension and remains failed. Evidence: `/private/tmp/webdroid-zb-recovery/link-budget-{core,runnable}-handoff.json` and the retained `tiktok-budget-*-wasm` directories. Individual synchronous compilation units and GC can still exceed the nominal admission budget. Final combined AOT, app/cold/Worker/conformance and idle timing gates remain open.

The corrected broad invocation at frozen `1b679ac7` exits 0 with all 19 sections passing, including 99 thread checks, all 42 workloads, the compilation sweep and temporary four-jar AOT/persistence. The separate framework suite passes 31/31 exercises with zero pinned or unexplained differences. Its suspended-native observations remain explicit. Logs: `/tmp/webdroid-wasm-recovery-runnable-bootstrap-all.log` and `/tmp/webdroid-wasm-recovery-1b679ac7-fwtest.log`. These results do not replace full conformance or browser verification.

The separate `cold-slow` run on that source exits 1 during 20 concurrent suspended monitor calls: a resumed activation observes the root strand and attempts to suspend through plain JavaScript frames. Restoring admission ownership in a Promise reaction is too early; another completion can idle the globals before the engine resumes Wasm. The strengthened existing thread fixture reproduces this ordering and fails only its ownership assertion before the repair. `5ad21add` restores sid, thread and depth inside the resumed stub, including exceptional exits. Parent repeats pass 241 cold-slow checks, 55 selected thread checks and full TypeScript checking. Logs: `/tmp/webdroid-wasm-recovery-1b679ac7-cold-slow.log` and `/tmp/webdroid-wasm-recovery-5ad21add-{cold-slow,threads,tsc}.log`.

B's private source-matched eight-jar AOT candidate then reaches 18 frames, 25 presentations and three processes without uncaught suspension errors, but still fails the later alive check. Its largest root renderer task falls from 21,604 to 2,341 ms in diagnostic profiles; live paths differ and both runs fail, so this is neither startup acceptance nor idle performance evidence. Ordinary data modules grow from 41,930 to 69,802 KB, which requires final delivery and G1/G5 measurement. The actual failure and hashes remain in `/private/tmp/webdroid-zb-recovery/link-budget-resume-handoff.json`; the pending ServiceManager/Looper ownership diagnosis is not waived.

`38fd9bce` adds MethodHandle VarHandle normal/exact invokers using actual libcore access-mode types, support checks and adaptation. Field/static/array operations share the compiler emitter; byte-array and heap/direct-buffer views use ART addressing, bounds, byte order, read-only and alignment rules. Parent `f56c3739` passes 676 reference cases, 301 cold cases, 16 suspended cases, eight ART-derived bootstrap cases and two synchronous callbacks. The parent resume check also passes 41 OSR checks. Logs and hashes: `/tmp/webdroid-wasm-recovery-vh-customdiff.log`, `/tmp/webdroid-wasm-recovery-5ad21add-cold-osr.log`, `/tmp/webdroid-wasm-recovery-f56c3739-core-evidence.json`. Ordinary G1 now awaits canonical bootstrap and retains its time in bootMs; no new timing acceptance is claimed.

The bundled Android 15 MethodHandle DEX has invoke/invokeExact/invokeExactWithFrame, but no OpenJDK invokeBasic/linkTo methods; their absence does not require replacement implementations. A's primary-source files, hashes and DEX probe are recorded in its private `vendor/wasm-aot/za-gates/mhandle-research/vh-handoff.json`. Review still requires combined-budget atomicity: dynamically generated getter/setter slots must be installed before a read-modify-write operation, and external memory can fault asynchronously. The private follow-up's first version predates the synchronous-export wrapper and needs correction before integration. Direct VarHandle polymorphic adaptation/views and symbolic class resolution remain open. These core results do not close final application, conformance or performance gates.


### Combined symbolic sites and atomic access recovery (2026-10-07)

`e722bae5` defers application bytecode's ordinary symbolic references until execution, resolves them through the actual initiating Java loader, and replaces the initial Wasm table thunk with a compiled opcode adapter. Hierarchy preparation precedes class mirrors and field layout. AOT format 4 carries symbolic-site metadata; existing format-3 assets cannot establish acceptance of this source. Constants for MethodHandle/MethodType, invoke-custom references, signature constraints and application-selected AOT still require review.

The first integrated cold repeat fails its existing distinct-field module bound: 43 modules instead of the bounded batch. `e1315e97` batches operations only when their symbolic owners are already resolved and prevents appending to a sealed compiled batch. `742c2d46` accounts symbolic unit compilation through common installation with nested compilation charged once. Helper and resume accounting still require a complete audit before comparing G3 counters with earlier epochs. The original failed run remains `/tmp/webdroid-wasm-recovery-e722bae5-cold-slow.log`.

`501e47da` eagerly installs canonical raw field accessors before atomic read-modify-write execution; using a host export wrapper in the Wasm function table was rejected during review. `533897e6` routes direct VarHandle sites through actual libcore access-mode type checks and conversion, with shared field/array/view storage. External-memory views use their owning whole-width read/write operations, including asynchronous immutable-region faults. The expanded core fixture bounds forced admission turns and checks both mutable external storage and one asynchronous whole-width read. A direct exact-type fast path remains under investigation; these correctness results imply no performance improvement.

Frozen combined `bc4117a0` passes TypeScript checking, loaders, 241 cold-slow checks and 694 custom-reference comparisons (319 cold, 32 forced turns, 16 suspended, four external-memory, eight ART-derived bootstrap and two synchronous-callback checks). The separate cold-OSR invocation exits 1: loading the late interface implementation does not invalidate an assumed slot after symbolic dispatch changed. Live guarded invalidation/deoptimization coverage must be restored before this cut is accepted; an unchanged numerical result would not prove that mechanism. Logs: `/tmp/webdroid-wasm-recovery-bc4117a0-{tsc,loaders,cold-slow,customdiff,cold-osr}.log`. Fresh AOT, application/Worker/cold matrices, full conformance and idle performance gates remain open.


The combined unit repeat passes all 1,200 cases/79,532 assertions. Full threads exits 1 with 99/100 checks: three atomic-workload threads encounter a host RangeError in the canonical VarHandle bridge, leaving a partial result. This is stack growth rather than demonstrated split storage updates; the handle bridge repair remains required. Log: `/tmp/webdroid-wasm-recovery-bc4117a0-threads.log`.

The separate fresh-World initialization invocation also initially fails before its first case. Its unchanged fixture lacks core-icu4j and canonical process preload ordering. A production-source override from `5ad21add`, with identical current fixture inputs, reproduces the missing CharsetFactory; this control is failed, not an earlier passing baseline. A temporary current-source setup-only bundle adding ICU and `processStateAsync` passes all 23 checks. The existing fixture now uses those canonical helpers; its official repeat passes 23 compiled/cold/concurrent initialization checks, and TypeScript checking passes. No loader behavior or application bytecode is replaced. Logs: `/tmp/webdroid-wasm-recovery-{bc4117a0-cold-init,5ad21add-cold-init-control,bc4117a0-cold-init-setup-control,cold-init-setup-fixed,cold-init-setup-tsc}.log`.


### Guarded compilation, bridge quotas and synchronous allocation (2026-10-07)

The combined loader follow-ups release ordinary symbolic analysis after installation and serialize small operand ABIs in format-5 metadata. At `7876e4db`, the existing GC fixture keeps MethodInfo/Program alive while collecting all 32 transient analyses and all 33 helper Compilers; repeated installed operations still execute without resolution. Whole-fixture heap totals are not attributable savings, and per-site repeated inference remains a performance risk. Already initiated, prepared identities can use the canonical guarded compiler. The OSR fixture now executes its interface class reference before the loop; a late real override invalidates the assumption and transfers the active continuation. Parent repeats pass 41 ordinary and 153 shipping-AOT checks, preserving actual deoptimizations, Worker adoption and ABI rejection. Logs: `/tmp/webdroid-wasm-recovery-{7876e4db-loaders-memory,symbolic-guard-cold-osr,a5c5a1eb-shipping-osr}.log`.

`bbfc79fa` uses the scheduler's existing nested-entry quota before MethodHandle dispatch. A Promise wait releases completed V8 helper stacks while retaining the captured parent strand; no yield splits storage updates. Its focused atomic repeat passes; after `a5c5a1eb`, the full thread suite passes 100/100. Direct exact VarHandle sites compare actual accessor Class identities, coordinate types and supported modes before unboxed storage; conversions and views retain the Java bridge. Parent customdiff passes 694 reference/319 cold cases, with zero bridge calls for the exact fixture and unchanged conversion/view fallback counts. These are work counts, not latency claims. TypeScript checking passes. Logs: `/tmp/webdroid-wasm-recovery-{mh-quota-atomics,a5c5a1eb-threads,vh-exact-customdiff,a5c5a1eb-tsc}.log`.

`c049868a` permits late platform C modules only against their original data globals. D/app/synthetic availability misses and incompatible policies remain terminal. Matching private control fails three late-C expectations; the combined parent builds fresh temporary four-jar format-5 assets and passes all 59 AOT checks. The 323 old TikTok misses lack fetch-completion events, so they cannot all be called transient; real TikTok attribution and final performance remain open. Log: `/tmp/webdroid-wasm-recovery-c049868a-aottest.log`.

Frozen `c049868a` Resy on-demand diagnostic draws onboarding but wedges when it closes. GMS PID 1001 dies; the initial description as a system-process failure was incorrect. The unmodified attempt is interrupted with exit 130 after three retained steps, and its remaining flow/ChatGPT are not exercised. A separate exit-storage prefix records the initiating InternalError: HttpsHandler.openConnection calls JavaClass.new, whose Wasm implementation passes a Promise from initializing/admitted allocation into Bridge.toHost. That diagnostic is explicitly stopped after collecting the exit, producing a target-closed abort rather than a successful capture. Evidence: `tests/e2e/actual/parent-recovery-c049868a/{on-demand,exit-diagnostic}`, `/tmp/webdroid-wasm-recovery-c049868a-{loader-apps,resy-exits}.log`.

JavaClass.new is synchronous zeroed allocation with its Java constructor unrun, matching jsClass.new. The Wasm seam now uses a canonical synchronous allocation helper without class initialization; newObj retains its initialization/constructor protocol. The existing host-class fixture covers fresh Hc$Boot and HTTPS allocation under forced link admission, asserting immediate identity and uninitialized classes. A matched source override from `c049868a`, with the same final fixture, fails both allocations; the corrected official host-class invocation passes 31 existing comparisons plus these checks both on demand and over fresh four-jar AOT. TypeScript checking passes. Initial fixture placement changed the global handle-view owner before earlier lifetime checks and failed both versions; moving this fresh World after those checks removes that fixture interference. Logs: `/tmp/webdroid-wasm-recovery-linked-allocation-{before,fixed,matched-before,final,tsc}.log`. Application repeats, fresh production AOT, full conformance and idle G1/G3/G4/G5 gates remain required.

### Bounded symbolic analysis and helper ownership (2026-10-07)

At `cea6e393`, 32 distinct symbolic PCs reuse one full inference with 31 cache hits. Recent analyses have a four-method/65,536-cost-cell budget; the probe peaks at four entries/27,738 cells. Under eviction pressure seven analyses leave four retained and 33 Compiler objects leave zero retained while executable operations and Program metadata remain live. Cost cells bound analysis work, not exact bytes; oversized methods stay transient and may repeat inference. The integrated 700 custom comparisons and TypeScript check pass. Executed handle signature metadata preserves sibling-loader identity, but its Java-peer resolver wiring is still being completed. Logs: `/tmp/webdroid-wasm-recovery-cea6e393-{loaders-memory,customdiff,tsc}.log`.

At `83acf79d`, helper/resume unit accounting is integrated with explicit invalidation ownership. Raw helpers decline unowned CHA devirtualization; absence-dependent helpers use private negative owner slots and rebuild cached functions when classes arrive, retaining call completion globals. Dependency-free synchronous helpers keep direct exports. The loader check exercises both synchronous and suspending cached recovery, unchanged warm calls and zero retained Compilers; TypeScript and all 41 OSR checks pass. Manual throwable/field-reader compilation still needs complete cost accounting. No G3 timing acceptance follows from these counters. Logs: `/tmp/webdroid-wasm-recovery-83acf79d-{loaders,osr,tsc}.log`.

### JNI callbacks after an idle Wasm boundary (2026-10-07)

The unmodified `cea6e393` Resy prefix draws onboarding and reports no GMS death or copied runtime errors, but closing onboarding still wedges the main loop. ChatGPT draws welcome and then stops completing the next action; the parent explicitly closes that browser after more than two minutes, retaining one step and a target-closed abort. Neither is a pass. Their combined outcomes and captures are under `tests/e2e/actual/parent-recovery-cea6e393/exit-diagnostic`.

The `83acf79d` Resy root diagnostic reproduces the wedge. Main strand 188 waits in Runtime.nativeLoad beneath Mapbox LibraryLoader.load; JNI callback strand 31312 initializes MapRenderer and waits on a monitor held by 188, with no parent link despite the same Java thread. The initial hook covered child processes only; the corrected root hook is under `tests/e2e/actual/parent-recovery-83acf79d/pending-root-diagnostic`. A same-source JavaScript prefix advances through close, with two missing okhttp class gaps and upstream HTTP failures; it is a progress comparison, not clean application acceptance.

A focused extension of the existing host-class check reproduces the missing parent: a fast nested callback enters with idle Wasm globals, whose return clears the host strand carried by the guest CPU turn. The next callback loses monitor reentry. Restoring the exact host strand in onStrand's synchronous finally repairs both checks. A matching `83acf79d` entry override against the same fresh four-jar AOT fails those two checks; the corrected entry passes. The original fresh-AOT repeat separately fails Hc.sub (1002 versus 20041002), retained in `/tmp/webdroid-wasm-recovery-jni-host-context-fixed.log`. Forcing admission reproduces that mismatch on the old entry: the host fixture multiplies a vcall Promise as a number. Its twice method now uses driven/yield, preserving the Java expectation; the forced case passes. Controls are `/tmp/webdroid-wasm-recovery-jni-host-context-aot-{before,after}.log` and `/tmp/webdroid-wasm-recovery-jni-twice-forced-{before,fixed}.log`. The unmodified application repeat remains required.


## Wasm recovery: executed signatures and prepublication AOT retries (2026-10-07)

At `c64ca4eb`, the unmodified Resy prefix still fails its onboarding-close liveness check, but reaches four native GL frames without the prior LibraryLoader monitor cycle. The instrumented root repeat observes newly entered main-thread callbacks rather than that permanent wait; this does not explain or waive the remaining failure. Its on-demand root compiles 67,404 units/55,730 methods and records 20.9 seconds of compile work. These shared-host diagnostic counters are not performance acceptance. The production AOT on that server belongs to an older source/format and is rejected. Failed captures and root trace remain under `tests/e2e/actual/parent-recovery-c64ca4eb/{exit-diagnostic,pending-root-diagnostic}`; logs are `/tmp/webdroid-wasm-recovery-c64ca4eb-resy{,-pending}.log`.

The integrated `4ed03c89` cut retains dependency-free callFn raw exports, executes MethodType/MethodHandle and bootstrap signature requests through canonical Java loaders, preserves optional combined-image app ownership and retries missing AOT dependency data only before fallback publication. Signature resolution preserves ART ordering and MethodHandle null-receiver precedence; member/access checks share the emitter's resolver. C's retained actual-loader constant fixture and A's denial/retry fixture exercise separate paths. Loader constraints and catch references remain follow-up work.

Full typecheck and all 1,200 unit cases/79,532 assertions pass on this combined source. Focused custom checks pass 700 reference comparisons, 325 cold cases, 14 sibling-namespace and 14 deferred Java-loader checks, 32 forced admissions, 16 suspended cases, four external views, eight ART collector/retry/race checks and two synchronous callbacks. The cold loader fixture resolves its executed MethodType constant through the actual child loader and leaves an unused missing signature lazy. Fresh four-jar AOT passes 68 checks; persistence and 241 cold-slow checks also pass. Logs: `/tmp/webdroid-wasm-recovery-4ed03c89-{typecheck,unit,custom,loaders,aottest,persist,cold}.log`. The `--cold --memory` loader invocation selects cold execution and therefore does not repeat the ordinary analysis lifetime probe. Fresh standard eight-jar delivery, applications, full conformance and idle performance remain required.


The frozen `4ed03c89` broad run finishes with 18/19 sections passing. Its sole failure is the numeric cold fixture: the new executed-reference guard calls objectOfLoader for an unbound root, which eagerly constructs a ClassLoader.parent field accessor although that standalone World has no ClassLoader DEX. Querying a peer now reads existing loader state; actual peer registration remains in the owning loader natives. The unchanged numeric fixture then passes 1,290 comparisons plus recursive cold invokes and active transfers. Original failed log: `/tmp/webdroid-wasm-recovery-4ed03c89-all.log`; focused repair: `/tmp/webdroid-wasm-recovery-loader-peer-cold-fixed.log`. All 42 workloads, 100 thread checks, host callbacks, nested entries, quick conformance, descriptors, the complete compilation sweep, fresh AOT and persistence pass in the original broad run. Separate framework verification passes 31/31 with no unexplained differences (`/tmp/webdroid-wasm-recovery-4ed03c89-fwtest.log`). This does not replace full conformance or browser acceptance.

The follow-up integrates CLI combined-image execution coverage (`a415687b`), canonical throwable/field-reader compile accounting (`045ef5db`), whole-dependency-set request discovery (`6ba151d0`) and prototype resolution despite an initiated MethodHandle/VarHandle owner (`76ec3240`). A's matching Java-loader control reproduces WrongMethodTypeException/null-array precedence where prototype denial should win; the repair passes 18 deferred Java-loader checks. B's source-matched TikTok dependency-discovery pair still fails liveness on both cuts; one extra installed code module and differing live screen progress are not performance acceptance. B's detailed handoff is `/private/tmp/webdroid-zb-recovery/aot-delivery-handoff.json`. Bounded asynchronous readiness before fallback publication remains under implementation.


### Packed DEX loading, bounded typing and loader certificates (2026-10-07)

Fresh dual-policy eight-jar assets built at `da4af095` compile 290,828 methods per policy with five existing binding gaps, recording 188 ordinary and 191 guarded startup files. The actual Resy three-step diagnostic still wedges on onboarding close (105-second action, no GL frames); ChatGPT retains four of seven requested steps before an explicit 300-second diagnostic deadline. Both fail. Captures remain under `tests/e2e/actual/parent-recovery-da4af095/exit-diagnostic`; empty copied child telemetry does not prove those paths healthy.

A separate same-source root trace places Resy's main strand 188 behind background strand 1438 in DexFile.openDexFileNative, through DynamiteModule and LoadedApk. This is a background archive wait, with no demonstrated reverse monitor cycle. The packed GMS archive has 2,897 unique files and 6,709 spans; Wasm openDexes reconstructs its entire archive through vfs.readFile although only DEX is needed. `9ed28d3d` uses the canonical PackedArchive.prepare(true) path already used by the JS loader, retaining ordered DEX identity and retry semantics. The existing loader fixture fails the whole-archive request assertion before repair and passes afterward with only bootstrap metadata and two DEX requests. The diagnostic trace is under `tests/e2e/actual/parent-recovery-da4af095/pending-root-diagnostic`; the app repeat remains required.

`7da16aa0` hands fresh compiler typing to the bounded cold-operation cache without retaining the Compiler or its analysis map. Matching private work counts reduce first-call inference from one to zero and loader-workload inference from 291 to 75, with unchanged 874 resolutions and 349 stub modules. Four analyses and zero operation/supplying Compilers remain under eviction pressure. These are work counts, not G1 acceptance. `fb61cf4b` resolves catch types through their Java loader only for the active try range, preserving the original throwable when a catch type fails resolution. Compiled boot catch dispatch remains static. Combined ordinary/cold loader checks, 241 cold-slow checks and full typecheck pass; logs are `/tmp/webdroid-wasm-recovery-catch-typing-{loaders,cold-loaders,cold-slow,typecheck}.log`.

`8fe8b439` carries prepared declaration hierarchies to compiler Workers. `1c4c4436` validates all certificates before recording initiating identities; an invalid certificate must leave the Worker loader unchanged. Fresh four-jar persistence and full typecheck pass (`/tmp/webdroid-wasm-recovery-worker-certificates-{persist,typecheck}.log`). This protocol rejects missing custom definitions rather than cloning arbitrary Java loader implementations.

`db4718b2` gives each demanded platform code group one bounded asynchronous delivery attempt before publishing fallback data. Synchronous/root calls retain synchronous linking. `0cb195a0` rejects previous lazy-link imports in platform, saved-app and Worker modules using format 6, including data module headers. `71326ca9` resolves executed members by binary DEX descriptors and uses their resolved declaration keys for dispatch; reflection retains exact loader identity. Initialization constraints for cross-loader overrides/interfaces remain in progress. Fresh integrated checks, production assets, browser acceptance and idle performance are still required.


### Format-6 production repeat and remaining loader work (2026-10-07)

Runtime `71326ca9` (documentation checkpoint `6ea73470`) passes integrated ordinary symbolic/memory loaders, the cold member fixture, 241 cold-slow checks, 41 OSR checks, 108 thread checks, fresh four-jar AOT's 95 checks, persistence and full typecheck. Logs: `/tmp/webdroid-wasm-recovery-71326ca9-{loaders,cold-members,cold-slow,cold-osr,threads,aottest,persist,typecheck}.log`. Fresh dual-policy eight-jar production assets are ordinary `54bf81facdec3604`, guarded `206139d6f19b01ef`, source `67d081f4f178ff4259be9b6641906a2a8ad475ec9e0f196a3f009952fb1e8543`; each compiles 290,828 methods with five existing binding gaps. Startup records retain 188/191 files. No production asset is committed.

The unmodified Resy prefix still fails: launch and optional alert complete, but close times out after 39.3 seconds with onboarding visible, no native frames and no wedge flag. A separate canonical-root trace reaches four GL frames, then fails the close budget with the wedge flag set. Its previous whole-archive wait and reverse monitor cycle are absent in the retained snapshot; the active nested loader work is inside NativeHttpRequest construction through EnumEntriesKt/okhttp3 initialization and DexFile.defineClassNative. Neither timing-changing trace nor absent old wait establishes a complete fix.

A matched current-source JavaScript prefix advances through close and renders 64 native frames, reporting two missing okhttp classes plus the same upstream HTTP failures. This is tier progress evidence, not clean application acceptance. A separate 5-ms CPU sampling diagnostic fails Wasm close while reaching four GL frames: its 69-second window contains 9.62 seconds of GC samples, 7.94 in noteLate, 5.83 in implFor, 3.00 in rebindResolution and 2.50 in vslots self samples. Compiler/linker work and broad resolution invalidation need reduction; these profiled/shared-host values are not idle performance acceptance. Original, root trace, JS control and profile are retained under `tests/e2e/actual/parent-recovery-6ea73470/{exit-diagnostic,pending-root-diagnostic,js-control,cpu-diagnostic}`. The profile is `cpu-diagnostic/resy-close.cpuprofile`; a compact extraction is `/tmp/webdroid-wasm-recovery-6ea73470-cpu-summary.json`.


The same format-6 ChatGPT diagnostic reaches the explicit 300-second limit after retaining four of seven steps: welcome times out, the first guest action wedges, and the alternate label lookup also times out. The capture's abort record identifies this intervention and incomplete coverage. No fresh application acceptance is claimed. `f0be40f4` keeps rejected/fallback data terminal; `e4b510a3` retains the bootstrap exact-descriptor lookup path. `a09af295` encodes import module names once per binary build: A's matched 74 workload roots/756 modules retain identical bytes and trace hashes while UTF-8 calls decrease 25,118 to 17,331. This work-count result is not a timing win. Its single binary validation fixture passes two assertions.

`6e7be43d`/`7f92a776` retain the original data-module lazy stubs before AOT code publication and reuse them on invalidation, avoiding replacement module construction without materializing method metadata. A's encoding cache is local to one build; the stub reference map is bounded by installed AOT method slots, with memory overhead still to measure. B's unchanged late-subclass fixture fails the replacement count before repair and passes afterward on both production policies, preserving actual changed dispatch. Parent fresh four-jar AOT passes all 97 checks and full typecheck passes (`/tmp/webdroid-wasm-recovery-original-stubs-integrated-{aottest,typecheck}.log`). These changes do not reduce the number of resolution invalidation decisions; their actual application effect remains unverified.


### Canonical rebind caches (2026-10-07)

`120f3469` retains the subtype index when a loader rebind changes descriptors without changing class hierarchy headers. The integrated loader fixture passes: the descriptor-only control indexes zero classes and preserves the existing subtype array; changing an interface header rebuilds 15 classes and updates membership. The linear header scan and retained header map remain; no measured memory or latency improvement is claimed. Evidence: `/tmp/webdroid-wasm-recovery-late-index-integrated-loaders.log`.

`d0cdd86a` preserves a positive dispatch assumption across a rebind only when its canonical implementation and declaration identities/prototypes still match and the current subtype graph still satisfies the assumption. Unmaterialized AOT and private helper owners remain live; absence assumptions still invalidate. The existing platform fixture retains ArrayList's compiled decision across a descriptor-only library rebind, then invalidates it when an overriding subclass arrives. A fresh integrated four-jar build compiles 43,881 methods and passes all 101 AOT checks (`/tmp/webdroid-wasm-d0cdd86a-aottest.log`). Agent controls fail the two retention assertions before the change and pass ordinary/guarded checks afterwards; their existing production assets establish compatibility, not combined-source application acceptance. Fresh final production assets, actual application reruns and idle performance gates remain required.


`5515b119` fixes interface cache aliasing for selector IDs above 65,535. The prior `class * 65536 + selector` key collides between adjacent class IDs; nested numeric maps retain both complete identities. The existing full-width differential fixture resolves ArrayList.size with a high selector, then HashMap.hashCode with the colliding low selector. The old cache returns the wrong method slot (`/tmp/webdroid-wasm-imt-width-control-host.log`, exit 1); the repair passes the separate cache assertion and all 40 selected Java differential cases (`/tmp/webdroid-wasm-imt-width-fixed.log`, exit 0). The initial probe attempts used nonexistent diagnostic entry points and retain setup-only failures in the earlier `imt-width` logs; they are not runtime controls. TypeScript and diff checks pass. The nested cache adds one map per encountered class and a second lookup on this slow path; no measured latency improvement is claimed. The preceding canonical-rebind source also passes 31/31 framework exercises with zero unexplained differences (`/tmp/webdroid-wasm-d0cdd86a-fwtest.log`). Final combined verification remains required.


`94491b6a` removes the compiled boot-method catch shortcut. Methods containing typed handlers now use the existing active-range Java-loader dispatcher and strand restoration; catch-all-only methods retain direct dispatch. ART's FindCatchBlock resolves types in declared order, ignores secondary resolution failures and restores the original exception ([primary source](https://android.googlesource.com/platform/art/+/fcb5c3a0cc8776cfedf8d289c5de19b605afe7ae/runtime/art_method.cc#305)). The same boot-defined fixture returns 42 on the old emitter but fails its successful initiating-identity assertion; this is a resolution-state regression control, not a changed Java return. The parent integrated plain/strand check passes, leaves untaken and missing catch types uninitiated, and reports zero cold methods (`/tmp/webdroid-wasm-compiled-boot-catch-integrated.log`). Agent checks also pass 22 exception differentials, 241 cold-slow checks and full typecheck; `/private/tmp/webdroid-zb-recovery/compiled-boot-catch-core-handoff.json` records commands and source limits. Fresh final AOT, combined suites and actual apps remain required; old compiled modules do not gain the new emission semantics.


### Signature constraints, dispatch layout and format-8 verification (2026-10-07)

`540d6398` validates actual cross-loader override/interface signature constraints before claiming class initialization. Java linkage failures retain their first error and later initialization failure semantics; host errors remain retriable. `dd516c6c` gives inaccessible package-private declarations distinct dispatch identities using binary descriptors and defining-loader runtime packages. The existing loader controls preserve unused signatures, concurrent waiters and canonical declaration identity. Their JavaScript-tier constraint/package gaps are documented controls, not parity acceptance.

The first combined broad run at `dd516c6c` passes 18/19 sections and fails only the shared-platform host callback with a null function/signature mismatch (`/tmp/webdroid-wasm-dd516c6c-all.log`). A loader-owner hypothesis is disproved: StringBuilder and AbstractStringBuilder stay bootstrap-defined. The actual difference is duplicate abstract `toString` interface slots: the flat build has 106 slots, the shared build 105. `94881d0c` counts existing public abstract declarations when adding interface slots. Both layouts then have 105 slots with no duplicate, and the unchanged callback returns `200:true:true:201:201`. Because physical layout changes, platform and saved-app formats advance to 8, rejecting format 7. Probe controls and the focused repair are `/tmp/webdroid-dd516c6c-host-{owner,layout,duplicate}-control.log` and `/tmp/webdroid-format8-host-{layout-fixed,hostclass-fixed}.log`.

`d4534435` selects qualified slots through the resolved canonical declaration. With the same additive private-child fixture, the preceding selector returns `111111`; the repair matches Java's `112222` for split/delegated loaders and `222222` for a shared runtime package. Public-child coverage alone had hidden this case.

The frozen `d4534435` source passes all 19 broad sections, including the complete compile sweep, fresh four-jar AOT's 101 checks and persistence (`/tmp/webdroid-wasm-d4534435-all.log`). Full typecheck, 1,201 unit tests/79,534 assertions, 241 cold-slow checks, 41 OSR checks and 31/31 framework exercises pass in the corresponding `d4534435` logs. Fresh dual-policy eight-jar production assets compile 290,828 methods per policy with five existing binding gaps, retaining 188 ordinary and 191 guarded startup files. Manifest source is `2f6ad1307f955292e9032807f50c24515fe936cb3e237dcd0661f89a0253fe6c`, ordinary key `6cc3b906ba8ff5bb`, guarded key `cebd6ac3647ca9fc`. These checks do not replace full conformance, browser/application coverage or idle performance acceptance.


The first `d4534435` browser prefixes accidentally omit `tier=wasm`. All copied process Wasm counters are zero, so they are JavaScript controls, despite the fresh format-8 server assets. Resy retains 3/3 steps with 120 native GL frames; ChatGPT retains 7/7 and a visible real service reply. Both exit 1 on missing-class telemetry. Those captures are preserved under `tests/e2e/actual/parent-recovery-d4534435/js-control`. The subsequent full run also uses that wrong-tier URL and is explicitly interrupted while driving TikTok; its running manifest is corrected to an interrupted JS record. Neither run is Wasm acceptance. The parent corrects the URL to `?tier=wasm`, adds a nonzero copied Wasm-method telemetry assertion, and reruns the prefixes before continuing the full matrix. Earlier progress commentary claiming Wasm success for these captures was incorrect.

An initial corrective URL used `jvmTier=wasm`, which is a different configuration option and throws `invalid jvmTier wasm` before boot. That setup-only run is explicitly closed and excluded from runtime evidence; the successful backend selector is `tier=wasm`.


The correctly selected `d4534435` Wasm Resy prefix fails launch: `$symbolic:com/google/android/gms/cloudmessaging/Rpc:1:45` throws a function-signature mismatch, copied processes have nonzero Wasm methods/AOT loads, and the retained launch reports timeout/wedge. Bytecode PC 45 calls the unchanged ScheduledThreadPoolExecutor.setKeepAliveTime(J, TimeUnit). The parent closes the browser after retaining this failure; requested/completed counts identify incomplete coverage. The launch diagnostics remain in `parent-recovery-d4534435/exit-diagnostic/resy/run.json`. A corrective setup process briefly shares the redirect filename; its timeout text contaminates the console log, so the retained per-step JSON is the authoritative runtime failure record.

The root cause is another flat/shared dispatch discrepancy: ThreadPoolExecutor has 64 versus 58 slots, including six duplicate abstract ExecutorService declarations; ScheduledThreadPoolExecutor has 79 versus 73. The nonbootstrap symbolic interface walk ignores `includeAbstract`, while bootstrap resolution includes abstract declarations. `148c7c34` honors that argument in the existing walk. Matching layout probes now report 58/58 and 73/73 slots without duplicates, with identical keep-alive indices. The existing host-class test adds a small flat/shared layout invariant for StringBuilder and both executors. Format 9 rejects the incompatible format-8 physical layout. Fresh four-jar host-class verification passes all 31 Java comparisons and the added invariant; full typecheck passes. Logs: `/tmp/webdroid-d453-executor-layout{,-fixed}.log`, `/tmp/webdroid-format9-{hostclass,typecheck}.log`. Production rebuilding and actual Wasm reruns follow; no application fix is established yet.


A broader diagnostic compares the complete eight-jar Program with a Resy child Program over that same platform, with matching host registrations. All 54,871 enumerated class layouts agree and contain no duplicate keys after the repair (`/tmp/webdroid-format9-all-layouts.log`, exit 0). This is layout evidence, not execution of every class. The full loader suite also passes on format 9 (`/tmp/webdroid-format9-loaders.log`).


Fresh format-9 production assets use ordinary `2ddf7ab604a1cf99`, guarded `1cff7e45e36c1753`, source `0930da2233c402de2713cfaf138238a495dbf08feeb41385bd7313c7a2305801`. Both policies compile 290,828 methods with five existing binding gaps and retain 188/191 startup files. The actual `148c7c34` Wasm Resy prefix now draws onboarding without the prior executor signature exception, but still fails close: 91.4 seconds, timeout/wedge and two native GL frames. All 3/3 requested diagnostic steps are retained with copied nonzero Wasm counters and no observed guest/draw errors. Root close records 3,921 additional methods, 7,610 modules and 3.33 seconds of compile work; the remaining elapsed time is unexplained. Neither absent exceptions nor reduced counters establish application acceptance. Captures are under `tests/e2e/actual/parent-recovery-148c7c34/exit-diagnostic`; `/tmp/webdroid-format9-resy.log` exits 1. A separate close-only sampling diagnostic follows, with timing excluded from idle performance gates.


### Format-9 Komikku startup and integrated ownership checks (2026-10-07)

The explicit-Wasm official quick gate on `148c7c34` is interrupted during Komikku launch after more than five minutes: zero checkpoints, so it proves no rendering or later application behavior. Its manifest and partial run are retained under `tests/e2e/actual/parent-recovery-148c7c34/quick-interrupted`. A 30-second startup sampling diagnostic retains a profile but no launch checkpoint; its observed provider exception wraps “blocking operation on a stack that cannot suspend.” The profile target spends most samples idle, so it does not identify the hot renderer or establish a Java CPU bottleneck.

A hook installed before initial navigation intercepts only `host.sync(Plain)` without changing its return. The first observed call is Unsafe.park → LockSupport.parkNanos → CoroutineScheduler.Worker.run, at root sid 1/depth 73. The unchanged APK and format-9 assets remain in use. The 90-second diagnostic is explicitly aborted without a checkpoint (`komikku-plain`). A second hook observes no immediate suspending-import throw before its first 24 Plain events (`komikku-import-throws`); a broader ownership-history hook reaches no Plain event before its deadline (`komikku-strand-history`). The latter starts briefly alongside the preceding diagnostic before that owned browser is closed; none is timing or application acceptance evidence. The earlier CPU and pending-root Resy diagnostics also remain separate: the CPU-only run stays on onboarding and does not reproduce the failed close, while the pending-root close wedges without the prior whole-archive wait/monitor cycle. Absence of that older cause does not explain the remaining failure.

A separate generic Wasm catch_all control catches an immediate exception from `Sched.suspending`, then reads strand identity through another import: expected 2, observed root 1, exit 1 (`/tmp/webdroid-suspending-throw-baseline.log`). This establishes a scheduler boundary defect; it does not establish that immediate exceptions caused the observed Komikku failure. A focused repair and exception-resume race audit follow.

`3b4dfeea` records each JS compiled/native/resumed frame's execution-specific Runtime, preserving identity when one DEX is defined by two loaders and when persisted factories lack tags. `26b23fc5`, `e12ce06c` and `af01f6cf` dispose Parcel rights with their native owner, scope borrowed broker decoding explicitly, and retain/replay notification rights through StoredParcel. Regular-file offsets remain shared; replacement/cancel/data-clear and partial failures release stored rights without closing delivered recipients. Shared ashmem remains unsupported. Parent combined verification exits 0: 52 actual Java caller-frame checks (`/tmp/webdroid-af01-caller-frames.log`), 86 focused cases/1,870 assertions (`/tmp/webdroid-af01-core.log`) and full typecheck (`/tmp/webdroid-af01-typecheck.log`). Fresh assets and real Worker/application verification remain required.
