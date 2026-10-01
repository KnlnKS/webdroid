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

## App investigations and remaining limits

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
