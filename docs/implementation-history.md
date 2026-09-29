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
