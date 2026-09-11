# Engineering constraints and investigation results

Retained findings through 2026-09-10, organized by engineering problem.
[PLAN.md](../PLAN.md) owns active work; [AGENTS.md](../AGENTS.md) owns implementation and
verification rules. This document preserves failure mechanisms, constraints, negative results
and evidence limits, not a complete API-coverage claim. Older source comments naming AGENTS
investigations refer here; Git retains their full chronological narratives.
Temporary /tmp evidence may expire. Committed regression fixtures are the durable reproductions.

## microG completion and open acceptance

The 2026-09-10 handoff at the top of PLAN.md supersedes the historical status below.
Android passed interactive Google consent and stored the test account, then the SDK
returned status 8. Webdroid still fails after consent. Moving renderer metadata out of
the visible query fixes a verified request-contamination bug but does not resolve login.
Google's observed null `.replace` exception points to its single-BASE requirement and
the proxy's unconditional BASE injection; that next investigation remains unimplemented.
The final WebView change passes typecheck, browser transport/restart checks and all
1,002 unit tests. Full Android parity is not established.

Genuine microG v0.3.16.252432 and Companion run as installed system packages with scoped
compatibility signatures. Resy's own availability checks accept them and its Play Services
dialog disappears. Availability is not authentication or full API support. Baseline: 82e1afb;
the completion worktree starts from b567197.

- scripts/system-packages.ts prepares ignored vendor/microg artifacts. Preserve signing blocks,
  ZIP metadata, every ABI and exact source-APK reconstruction against pinned digests. Complete
  bundles need no source download/reprocessing; DEX and native entries load on demand.
- Package/manifest processes have separate JVM realms and native memory. IPC Parcels carry bytes
  and handles, never Java objects. Replies must not queue behind a main job waiting for them.
  JNI lookup/registration, including JNI_OnLoad, retains the defining loader; shared native
  registries previously bound duplicate classes to the wrong function.
- Remote activities carry the calling component before onCreate, foreground/input ownership
  and serialized results. A permission activity launched by a background service restores the
  previously visible app, not its caller. Nested/recreated activity routing, service rebinding
  and broader process cleanup still need lifecycle coverage.
- Preferences and private files have browser-broker owners. Restore private files from IndexedDB
  before package initialization: losing Firebase Installations' private JSON changed FCM tokens
  across launches. Binary restore, rename, deletion, empty directories, non-persistent cache
  files and interleaved preference writes were verified.
- Google accepted the test password and reached an interactive second factor; no authenticated
  Google-account result is established. Shared account ownership/visibility work is recorded in
  the later account-state update below; authenticator Binder dispatch remains an obstacle.
- The dedicated Firebase project is webdroid-microg-test, Android client org.webdroid.gmsclient,
  free Spark plan. Configuration, browser state, credentials and registration tokens stay outside
  Git/reports. Upstream HTTP-form logs contain authorization values even without the word token:
  exclude the whole tag. The 260ca78 verification checkpoint below records regression/performance
  evidence; interactive Google authentication remains unverified.

### Messaging and process recovery

Real checkin, SDK registration, receipt after browser reopen and an upstream acknowledgement
were observed. The reopened browser retained the same token and the unchanged SDK's received
count increased (/tmp/webdroid-gms-completion-receipt.{png,json}). Checkin alone is not receipt.

Load-bearing fixes: preserve explicit HTTP gzip encoding for microG's own decoder; open wrapped
TLS sockets on first stream I/O even without startHandshake; retain Handler override/callback
semantics; expose real permission metadata. GcmPrefs.setEnabled returns immediately when already
enabled, so reopen recovery needs BOOT_COMPLETED once per browser-device session, including
eligible non-exported receivers receiving this OS event.

At ece2390, MCS logged in at 1.621 s, sent its real five-minute heartbeat at 301.473 s and received
HeartbeatAck at 301.534 s without a reconnect after initial connection. Three processes had empty
missing-API sets/main queues at 350 s. Looper.loop's reached suspension declaration was corrected.
Evidence: /tmp/webdroid-mcs-idle-check.{json,log}. This establishes one idle interval, not indefinite
uptime or actual MCS recovery after process death.

At 22859aa, PendingIntent records and alarms moved to the browser broker. Serialized intents
retain creator identity and decode in a restarted creator process. Identity includes filter
fields, request code and creation flags; extras update separately. Cancellation requires creator
UID; stale operations cannot run under a replacement UID. Immutable operations ignore fills,
mutable fills preserve fixed-field/extras precedence, and one timer handles wall/elapsed clocks,
replacement, cancellation and missed repeating occurrences. A browser fixture destroyed an
SDK-client creator iframe and observed a replacement deliver exactly one ALARM_COUNT=1 broadcast
(/tmp/webdroid-system-intents-browser.{json,log}). Raw IIntentSender transactions beyond descriptor
queries remain unsupported. An alarm restart is not proof of MCS reconnect.

At 260ca78, an unaccelerated process-death test did establish MCS recovery. After the persistent
microG process was destroyed, the original five-minute alarm restarted it; MCS connected at
306.563 s and logged in at 306.815 s. Three reached runtimes had empty missing-API/undeclared-
suspension sets and main queues at 351.645 s. This is delayed recovery, not immediate sticky-
service restart or a new message receipt (/tmp/webdroid-mcs-death-check.{json,log}). A separate
genuine microG common-service binding observed connected → disconnected → connected with a
new PID. BIND_AUTO_CREATE clients reconnect and caller death releases remote bindings;
START_STICKY/START_REDELIVER_INTENT restart policy and crash-loop backoff remain unimplemented.

### Resy configuration and completion measurements at 260ca78

Resy 1.18.0-687 (version code 180) displays “Unable to configure device for notifications” on
both webdroid and the dedicated Android reference with the same pinned microG build. Both
report Firebase HTTP 400, invalid-configuration diagnostics and a rejected installation.
This is separate from the resolved Play Services availability dialog. The SDK test project's
successful real FCM receipt does not repair Resy's embedded Firebase configuration. Evidence:
/tmp/webdroid-resy-final-{android,browser}.{png,json}. No app-specific response was substituted.
Resy's six root-runtime suspension annotation gaps also reproduce on b567197; all three
completion microG runtimes were reached and reported none. Baseline child telemetry was absent,
so it cannot establish their coverage.

Three serial cold/warm FitNotes pairs against b567197 used the completion driver, matching
headless Chromium flags and renderer-thread CDP CPU counters. Median first-eight-step CPU was
1205.8 → 1263.2 ms cold (+4.76%) and 1047.4 → 1104.8 ms after harness reset (+5.48%). The first
ten seconds after the flow used about 80 ms more CPU; profiles located delayed microG startup
and class compilation there. That interval was not steady idle. At 20–30 seconds after the
flow, one pair measured 321 → 310 ms cold and 315 → 328 ms warm over ten seconds. No polling
loop was added to hide the startup cost. Broker call counts in the first pair rose 10 → 42,
mostly provider requests; overlapping request latency is not CPU time.

A separate pair waited 30 seconds, collected garbage, then drove nine more FitNotes steps.
All text actions hit, with no new errors/missing APIs: CPU was 636.6 → 585.4 ms; live JavaScript
heap was 129.0 → 137.5 MB with three processes on each build. This single pair does not establish
a general speedup. Early uncollected heap samples were roughly 164–170 MB, with one 274 MB
completion outlier; do not equate them with live heap. CDP JS heap excludes Wasm/external/GPU
memory; the root native buffer reserves 256 MiB in both builds. Warm reset is the harness's
existing reset, not a full browser-storage/cache reset. Inputs and profiles are retained in
/tmp/webdroid-perf-{baseline,completion}-{1,2,3}.json, /tmp/webdroid-idle-*.cpuprofile and
/tmp/webdroid-steady-{baseline,completion}.json.

The matching complete E2E runs rendered 75/75 scored steps (content difference 38.02% baseline,
37.76% completion); corpus first-frame coverage was 13/14 on both, with TikTok failing and no
new completion gaps. A single full baseline run and one targeted Harmonic rerun did not emit
the observed null-Looper layout error. Four exact E2E launch repeats then reproduced it once
on completion and twice on b567197. Baseline's stack enters ns1.a through drawable state changes;
the active thread was named “Thread” while the main queue was in overlay layout. Plain APK
launches did not reproduce it. This establishes an intermittent baseline failure, not its
root cause (/tmp/webdroid-harmonic-launch-{baseline,completion}.json). Final full captures live
under /tmp/webdroid-{baseline-b567197,completion-260ca78}-e2e-{actual,report}; working reports
were restored to the completion capture after comparisons.

### Maps, location and wire formats

- The reference AVD and paired framework are API 35; webdroid currently advertises API 33.
  Intent/Uri oracle work exposed real wire differences: API 35 Intent adds an extended-flags
  word, and all private Uri types write a full String8. Follow the advertised API 33 source
  contract, not an unlabelled newer-device fixture. StringUri's unchanged bytes match the
  reference; API 33 opaque/hierarchical part fixtures verify encoding and absolute paths.
  Uri Parcelable round-trip and invalid-type checks pass with typecheck. The oracle lives in
  /tmp/webdroid-intent-oracle; it needs app_process, since bare dalvikvm lacks Parcel JNI.
- Intent/ComponentName Parcel support now preserves nested callback Binders, identifiers,
  source bounds and selectors. Broker Intent payloads carry the same metadata without Java
  objects; identifiers participate in PendingIntent/service filter identity. The device-backed
  Intent fixture exposed Bundle length counting the magic word and an incorrect empty encoding:
  Android 13 BaseBundle excludes magic from length and writes one zero word for an empty Bundle.
  Those encodings are corrected. Twenty focused tests (148 assertions) and typecheck pass;
  nonempty ClipData parcels remain explicitly unsupported. Authenticator dispatch still needs
  implementation and live verification after these transport prerequisites.
- The unchanged maps SDK renders real tiles/labels and reports loaded/camera-idle after panning
  (/tmp/webdroid-gms-completion-{trace,pan}.png). Full map parity remains open. On Android, missing
  libmapbox-gl.so was an installation error: unchanged ARM64 libraries needed extraction beneath
  the system package with normal modes/SELinux contexts. Do not blame upstream without matching
  Android evidence.
- GLES host-library resolution follows ELF DT_NEEDED. Selecting a global GLES1 registration for
  a GLES2 consumer mixed handle namespaces. Bionic _ctype_ is a pointer slot, not the table:
  exporting table bytes as the symbol made Date parsing dereference them as an address.
- Browser geolocation feeds Android active/passive providers and genuine microG fused-location
  bytecode through one watch, filtering interval/distance. SDK callbacks reported 4 m in a
  deterministic browser test, 40 m in normal Chrome and 5 m on Android with an AVD test fix.
  Different inputs establish callback paths, not comparative accuracy. No live coordinates were
  retained. Evidence: /tmp/webdroid-gms-location-check.{png,json}, /tmp/webdroid-reference-location.png.
- Browser providers do not establish physical GNSS or Wi-Fi/cell provenance. microG can select
  its own network-location service instead of Android's provider; hiding that service bypasses
  genuine behavior. Balanced-power coverage remains to be established.
- At c0a5057, denial clears the last fix, regrant resumes active requests and provider listeners
  receive disabled/enabled callbacks. Event-driven permission observation remains while idle so
  availability can recover; the geolocation watch stops after the last active request. Browser
  tests passed denial, active/idle regrant, process-death cleanup, passive delivery and interval
  filtering (/tmp/webdroid-location-regrant-fixed.log).
- API-33 Location parcels contain String8 provider, presence mask, wall/elapsed timestamps,
  optional elapsed uncertainty, coordinates, optional measurements and extras. LocationRequest
  and WorkSource need their actual layouts too. ART String8 encodes NUL as C0 80, supplementary
  pairs as four bytes and unpaired surrogates as three; it is not UTF-16. Device-produced fixtures:
  src/android/parcel.test.ts and location.test.ts; probe: /tmp/webdroid-location-oracle/.
  Copies detach optional fields and Bundle maps.
- Empty primitive Parcel reads return zero without advancing, as AOSP does; this must not turn
  an unhandled Binder transaction into success. Typed Bundle/Intent getters unbox Parcel values.
  Annotation prototypes key on ClassInfo, not names; annotation values, Class.forName, enum
  defaults and array Class identities follow defining loaders.
- Child realms expose actual diagnostics and inherit bytecode/jit options. Old collectors
  treated absent child globals as empty telemetry. The 4b0a0c7 location capture checked four actual
  runtimes with no missing APIs/undeclared suspension and empty background queues: reached-path
  coverage only.

## WebView isolation, cookies and navigation

Google login exposed three distinct platform failures: rewritten script src URLs broke its
module loader (Error: nb); asynchronous Java-interface results broke synchronous callers
(Error: int64); missing cookie support triggered HTTP 403 rrk=32. The last was not an upstream
account rejection. Preserving the upstream document path/query and Android user agent then let
account lookup reach the password screen, matching the Android reference.

The service worker proxies scripts while preserving original DOM URLs. JavaScript-interface
WebViews use a separate renderer site: synchronous HTTP relays opaque requests through WebSocket
to a private Java bridge thread in the owning browser realm. Ordinary WebViews retain the direct
path. The relay owns no Java/account state and cleans pending calls on timeout/disconnect.
Local servers use localhost/127.0.0.1; other deployments need a separate site routed to the same
server and WEBDROID_WEBVIEW_ORIGIN. Playwright's default disabled site isolation deadlocked this
bridge; the shared launcher restores normal isolation.

Each package has one cookie owner shared by CookieManager, document.cookie and network requests.
The lazily loaded tough-cookie parser handles domain/path/public-suffix/expiry/prefix/HttpOnly
semantics. Persistent cookies survive reopen; session cookies do not. Private worker MessagePorts
carry replies without exposing HttpOnly values. Apply Set-Cookie before the next redirect hop;
strip cookie metadata before page responses and old authorization/cookies on cross-origin
redirects. Preserve methods, bodies and configured UA. Proxy scripts cannot register as service
workers. Browser fixtures cover delayed synchronous replies, redirects, POST, worker restart,
cookie isolation/persistence and destruction (/tmp/webdroid-webview-cookie-check).

## Regression comparison points

The full 4b0a0c7 checkpoint passed unit tests, framework probes (295/363 declarations; all
executable probes passed) and 6/6 text comparisons. Serialized E2E rendered all scored steps:
FitNotes 39/39, Mihon app 17/17, onboarding 5/5, Harmonic 14/14. Content differences were 40.89%,
56.39%, 17.56%, 34.31% (overall 37.29%), against unchanged goldens rather than main's screenshots.
Archive: /tmp/webdroid-completion-e2e-4b0a0c7-{actual,report}.

- FitNotes' destroyed-FragmentManager exception and Harmonic's layout exception are baseline
  comparison points. Mihon settings/dialog transitions are sensitive to fallback coordinates
  and scroll position; all steps rendering does not prove the intended screen was reached.
  Harmonic live content changes unmasked pixels. Old score spreads are not fixed tolerances.
- Flappy rendered 7/7 but failed six FPS gates at ~22 fps; controlled b567197 with the same
  launcher also failed six at 21–22 fps. Its DexClassLoader absence remains a breadth issue.
  DoodleJump rendered 6/6 with minimum 35 fps.
- A newly reached GLES NUM_SAMPLE_COUNTS query wedged Lichess. 18fac17 translates it to WebGL
  SAMPLES and returns the typed-array length, bounds writes by bufSize and preserves output on
  invalid queries (/tmp/webdroid-gl-query-check.log). Main b567197 was responsive but failed
  Skia surface creation and drew blank. At 22859aa the 15-step rerun was responsive but still
  loading, with missing PhantomReference and optional SidecarProvider
  (/tmp/webdroid-lichess-final-e2e.log). Earlier playable Stockfish captures are historical
  evidence, not current gameplay verification.
- The main corpus rendered 12/13 APKs; TikTok failed with Keva/executor-queue gaps. Boot frames
  are not successful app flows. An isolated LP64 MAP_FIXED reservation test also failed on
  starting main with an unmap overflow; compare before assigning it to microG.

### Reddit: final verification and baseline comparison

At 339de96 an authenticated standalone smoke passed ten feed/drawer/post/comment/composer steps
without Java/page errors, native faults, wedges or layout/draw/GL errors. Optional OEM/AppsFlyer
reflection, ObjectStreamClass/MemberClasses and absent captioning/media_metrics queries remained;
Cronet's DNS warning did not prevent native TLS. Changing video pixels and nonzero scheduled
PCM with an advancing clock were verified separately. Historical artifacts:
tests/e2e/actual/reddit and reddit-media. No votes, posts, replies or account-setting changes were
submitted. Perfsum does not parse this standalone schema: its zero Reddit row is not a measurement.

## JVM execution, identity and suspension

- Main-thread identity is not queue ownership. Order boot, providers, Application.onCreate and
  initial activity attachment in one main job. Check-then-act bytecode can interleave at awaits:
  overlapping Compose initialization created duplicate AndroidComposeViews, dialogs and scrims.
  Use ownership-aware onMain/inMainJob, not curThread equality or another job's global depth.
  Native monitors preserve ownership/recursion and release/reacquire around wait across Java/JNI.
- Restore initiating Java thread identity after successful/rejected awaits, including comparator,
  Map callbacks and probes. A diagnostic wrapper that failed to restore made two Java threads
  share the main native Cpu and corrupted Cronet calls. An old early-unpark experiment caused
  lifecycle callbacks under worker identity and showed no latency benefit; wake timing changes
  require continuation-identity evidence.
- Class initialization waits for in-flight work while allowing valid re-entry/cycles. Run only
  an own clinit, not an inherited JS static: rerunning it changed coroutine sentinel identity.
  Static getters and reflective field reads initialize the declaring class lazily. Copy JS
  accessors without reading them.
- Native re-entry can suspend while common paths stay synchronous: a native returns a value or a
  promise, and an async caller awaits only a promise. The experimental call-graph sync tier was
  removed with the maySuspend declarations and the natcheck audit it relied on. Sound, it needed
  every native to declare its re-entry, and running the analysis at boot cost up to 1.4 s of
  first draw; deferring it behind a proof cache worked but carried more machinery than its
  measured gain justified.
- Dalvik constant typing requires CFG reaching definitions through merges and exception edges,
  not PC order. R8 arms reuse registers; moves propagate wide/float definitions. JS bitwise
  results are signed int32; Java float-to-int conversion saturates where specified. Constructor
  lookup must not inherit a superclass constructor by mangle. Qualify colliding static names by
  descriptor while retaining ordinary direct properties.
- Loop-limit diagnostics must escape the method's DEX catch dispatch. A handler inside its own
  try range caught the guard and produced a non-yielding exception loop. This diagnoses a runaway
  method; it does not fix its underlying scheduler/collection corruption.
- Missing logging, cleanup, catch types or interface ancestry can turn handled failures into
  fatal transaction cancellation. Inspect original causes (Compose's recomposer closeCause)
  before patching symptoms. BlockingQueue add/offer/deque inserts must wake parked takers too.

## V8 code pressure and performance constraints

Cold methods share instruction handlers emitted by the existing compiler and a central
PC/catch/thread runner. Suspending handlers are generators yielding only actual Promises:
async helpers changed synchronous-before-first-await ordering. After 32 calls a method can
promote; captured direct/interface entries follow the promotion cell. Root and loader runtimes
share a 32 MiB specialized-async-source admission limit measured in code units; denied methods
stay cold without regenerating source. Synchronous bodies/shared handlers are outside the bound.
Hot bodies share one await site while retaining the DEX throwing PC. Compiler fixtures and
smoke --cold exercise both paths.

Rejected approaches: per-call-site try/finally inflated generated code; generator-per-method,
small-template sharing and 8/16 MiB generated-source eviction caches still failed on Reddit's
feed. Caches churned through 200k compilations; 44 MiB live instruction streams coexisted with
much larger executable allocation. Fewer JS references do not control V8 reclamation timing.
Larger old space, smaller guest heap and code-range flags did not solve it. Disabling JIT tiers
diagnosed code pressure, but is not the implementation fix.

Shared cold execution reduced a reached stock-Chrome feed from ~211 MiB executable allocation
and ~80% GC to 106 MiB and under 0.3% GC. Broader navigation reached the admission ceiling and
continued cold; final executable allocation there was not measured. Source admission is not an
exact machine-code bound. Keep browser flags, tracing, warm state and live content comparable.

Framework caches reduced FitNotes layout work but did not move Mihon's ~1.4 s initial Compose
composition; further framework caching is not an evidenced remedy for that bytecode cost.
Eager locale decoding doubled retained framework heap (~25.8 to 54.1 MB). Lazy encoded chunks
held it near 27.3 MB with similar parse latency. Scoped Resources share immutable tables and
decoded chunks but own config, metrics, themes and selector/bag caches; don't retain scoped
views in the device registry.

## Collections, persistence and package loading

- Views write through: copied subList.clear retained deleted Compose anchors and caused “Missed
  recording an endGroup”; copied map-view iterator removal recycled the same Glide resource.
  Preserve backing arrays during sort. Collections.sort reaches virtual List.sort; its default
  uses Java toArray/set for custom storage.
- Async sorted searches validate structural revision after comparison and mutate in the same
  continuation. Overlapping awaits used stale insertion indices and caused infinite removal
  loops. Clear/poll/map-view mutations invalidate pending searches; primitive natural-order paths
  remain synchronous. CopyOnWrite iterators are immutable snapshots. Attach/layout/animation
  dispatch also survives listeners removing themselves.
- sql.js Database.export closes/reopens the connection, losing TEMP objects, PRAGMAs, prepared
  statements and potentially transactions. Snapshot backing files without touching app handles,
  after transactions finish. Include committed WAL pages with a nonblocking PASSIVE checkpoint;
  defer when readers/raw transactions prevent completion. Concurrent initialization was rejected
  as a cause: sql.js already memoizes initialization.
- Native SQLite opens own separate connections over the shared file; Java's cache remains shared.
  Verify independent TEMP state, writer contention, read-only opens and close rollback.
  CursorFactory may bind typed values even when rawQueryWithFactory's String[] is empty.
- BigInt at the JS boundary alone is insufficient: upstream sql.js bound it as TEXT and unsafe
  Number as DOUBLE. The reproducible vendor/sql.js build exposes sqlite3_bind_int64. Keep fast
  ordinary Number reads, rereading unsafe rows as BigInt. Converting every integer cost 20.1 ms
  versus 7.6 ms for 20k ordinary rows. Rounded old source IDs cannot recover discarded bits.
- Preferences persist string-set values, not Java collection internals; malformed old records
  cannot recover lost strings. SAF handles restore before startup. Native picker cancellation
  stays canceled; OPFS fallback is only for browsers without the API. The old fast-AbortError
  fallback heuristic was superseded. No server filesystem mount bypasses browser permission.
- APK/XAPK loading shares archive handling, split precedence, distinct DEX and real signature/
  content verification. Stored ZIP entries are views; deflated entries are lazy. Object.entries
  inflates everything: an eager Among Us asset pack exceeded V8 heap. Range caches stay bounded.
  DEX v41 offsets are container-relative; quickened opcodes are walkable but not compilable;
  parameter annotations and header/section bounds must be retained.

## Rendering, resources and input

- Funnel overloads through overridable Java entries. addView/LP conversion lets ViewPager
  populate; View.draw, Drawable.draw, requestLayout, invalidation and InputConnection can all
  be overridden. Global dirtiness cannot replace parent invalidation reaching AndroidViewHolder.
- requestLayout marks the path without premarking the requester; layout gates on actual measure
  work. Replay requests raised mid-layout after flags clear. Queued attachment remeasures the
  subtree once even with unchanged specs; a pager measured before receiving a window token can
  otherwise stay empty. Quick-reject off-screen children.
- Insets/attachment/focus/lifecycle can gate app control flow: missing insets prevented Harmonic
  requests. Merge floating ViewTreeObservers on attach. Configuration changes invalidate caches
  and notify declared handlers or recreate with saved/non-configuration state; repaint alone
  cannot implement dark mode.
- Resolve through the supplied Context/theme, including overlays, selectors and references.
  TypedValue floats carry bits; getResourceId retains provenance; metadata uses owner resources.
  Don't invent resource IDs or app-name rules. Bound dialogs before title chrome: one experiment
  pushed FitNotes' OK off-screen. Keep padding/insets and layer-item size/gravity distinct.
- RenderNodes defer commands; nested nodes/video surfaces read current contents at replay,
  not cached pixels/closed VideoFrames. Ripple masks clip without painting. Drawable callbacks
  reach owners; animation invalidation schedules behind recording so it isn't cleared mid-pass.
- Compose offscreen and present a completed bitmap atomically. Direct visible drawing exposed
  half-painted frames at bytecode yields; drawImage blits cost Flappy FPS. Balance save/restore
  and drawing guards in finally. Catch layout/draw separately and let real invalidation recover;
  automatic retries create deterministic 60-fps exception storms.
- Use Java CharSequence semantics and shared metrics. Preserve spans; ReplacementSpan uses real
  Java callbacks and indivisible geometry. Font ascent/descent differ from includeFontPadding;
  LineHeightSpan changes line metrics. Kerning requires prefix-width differences for advances.
  Lines own trailing newlines; nComputeLineBreaks receives an already split paragraph.
- Geometry comes from the profile, density from dpi/160, rounding at integer boundaries.
  Correctly scaled assets can overlap a hardcoded layout reservation. Capture geometry comes
  from golden manifests, not the current default.
- Browser input uses the served InputConnection, real Editable methods and selection/composition
  on main. A read-only clipboard field is not a broken channel. Wheel uses a queued drag stream,
  one drain per frame, arrival timestamps, out-of-bounds deltas and trackpad inertia before UP.
  ACTION_SCROLL did not reach pagers/drawers; Chrome exposes no momentum phase to infer safely.

## AOSP bytecode boundary

Use framework.jar and framework-res.apk from one device build. Relinking resources shifted
internal IDs and inlined styleable indices (3,582 wrong IDs in one comparison); public-ID stability
doesn't protect them. Provenance cuts belong in jvm/provenance.ts. Index app DEX before framework
DEX and materialize natives after indexing. A cut must include TS references/objects handed to
app code, not just superclasses: withholding Canvas's spec left Java draw methods absent on
JCanvas while TS rendering still worked. Audit this boundary before moving a subtree.

Delegates reuse canonical helpers. AOSP Matrix is full 3×3; TypedArray has seven ints per entry;
XmlBlock returns original string-pool indices; asset cookies distinguish framework/app resource paths.
Translate file references at TypedValue. Preserve the software framework draw path; speculative
recording/hardware delegates reopen a much larger boundary. Canvas2D measurement isn't complete
shaping; perspective and glyph-ID operations need honest results. Locale bytecode may require
the i18n apex's core-icu4j.jar too. fwtest measures declarations and reached calls; textcmp needs
a real drawing browser.

## Native core, memory and ABI traps

The Zig wasm core supersedes historical JS ARM/A64 emitters and the split hi/lo workaround.
Keep semantics in the interpreters and reuse them in JIT fallbacks. Tier-parity kits, the SIMD
hardware oracle and code-write invalidation tests establish correctness. Bisect app failures
with ?jit=0, __wdJit ranges and jit_fallback; inspect wasm function/offset and original host error.

- Fallbacks spill everything they reload; overestimated writes once overwrote dirty locals with
  stale memory. Preserve branch/PC/interworking. Partial flag writers settle preserved flags
  before replacing operands. V-register writes narrower than Q zero architectural upper bits.
  Direct GLboolean/JNI narrow arguments mask to a byte; promoted variadics differ. 0x100/0x101
  once both enabled depth writes.
- Install regions only against their source-page epoch. Mark executed ARM32 words so stores
  invalidate operations/regions too. Decode metadata cannot live in guest heap reachable through
  stale pointers; clear it on reuse. Refused compile batches must retry on subsequent hot entries.
  Exclusive sequences can briefly overrun slices to avoid splitting CAS; host calls exit wasm
  before dispatch. Signals, masks, destructors and guest frames stay ordered. ARM32 sigset/
  sigaction sizes differ from kernel/*64 interfaces.
- Use unsigned free-list/head/owner pointers above 2 GiB and full-width size_t checks. Signed
  reads became sign-extended A64 addresses. Large aligned allocations select aligned page runs:
  overallocate/discard-prefix bookkeeping leaked holes across 410 MiB Stockfish table reuse.
  POSIX errors preserve output/errno contracts; bionic memalign has different rules.
- Reclaim TLS/errno/JNI storage as well as stacks. A 120 s idle trace leaked 264 bytes per finished
  Dart worker at constant concurrency. Exit waits for handlers/destructors; join records retain
  only result/completion and disappear on join/detach. Guest TLS changes don't transfer allocation
  ownership. Extra stacks use mapped memory instead of a fixed sixty-stack ceiling.
- Bound libc searches: memchr scanned 4 GiB and cost 8.6 s without guest-instruction progress.
  environ is a terminated char** shared with getenv/setenv/unsetenv. Console behavior belongs
  to open file descriptions, not fd numbers: dup2 redirected Stockfish but fdWrite still logged
  fd 1 and lost UCI replies.
- GLES handles belong to contexts, not frames. Mixed GLES vertex/index use needs a second WebGL
  backing only on first mixed bind; synchronize later writes and restore temporary bindings.
  Keep Android premultiplication/opacity and genuine query/error behavior; don't disable depth,
  stencil or scissor to make an image appear.

Native performance constraints:

- Tail-call chaining alone barely helped; precise spills and inline memory-plane translation
  mattered more. Browser baseline/optimizing tiers differ sharply from Bun. Removing A64 decode
  caching regressed a byte-copy interpreter from 224M to 139M instr/s; ARM32 direct decoding is
  separate evidence. Cross-page regions add invalidation complexity and need new measurement.
- wasm32 @mulAdd/compiler-rt produced NaNs for finite oracle inputs; fused FP uses Dekker/TwoSum.
  Oracle-permitted NaN payload changes aren't wrong finite results. No measured case justifies
  moving Canvas2D-bound graphics/text or already-native SQLite/crypto wholesale into wasm.
- Among Us executable-cache growth caused GC despite ordinary heap headroom. Bound caches/tables
  and release incoming/outgoing links on eviction, even when compiling a target evicts its caller.
  Core throughput gains didn't translate proportionally to FPS: guest waiting, GL and vsync
  remained. Historical 4–9 fps, 16 fps and 31 swaps/s observations used different stages/scenes;
  they aren't one benchmark series. Process-local UDP supported Practice; external UDP relay
  support wasn't established.

## Network, codecs and capability limits

- Java Socket TLS is relay-terminated; advertise HTTP/1.1 rather than h2 without ALPN. Its
  synthetic peer certificate isn't a verified chain or pinning success. Native Dart TLS verifies
  real chains against pinned AOSP roots in /system/etc/security/cacerts. An absent directory
  failed before ClientHello; Cronet's DNS warning wasn't the cause. Keep these TLS paths distinct.
- Socket timeouts throw without consuming later bytes; OkHttp probes pooled connections with
  one-millisecond reads. FIONREAD reports queued bytes/first datagram without consumption.
  Unknown ioctls/services/relocations fail honestly. Relay backpressure was an identified gap:
  recheck current handling before attributing stalls solely to guest work.
- Streaming gzip separates consumed input, produced output and buffered output. Midstream fflate
  tails aren't untouched Java input; a partially consumed final byte counts as consumed for
  trailer offsets. needsInput cannot request refill with a trailer remaining. Native inflate
  drains output before exposing final input consumption: a real intact PNG lost ~95 final rows.
  Scanline/counter tests cover that failure.
- Read through virtual streams for app subclasses, not inherited native buffers. Java Latin-1
  differs from TextDecoder's Windows-1252 alias at 0x80–0x9f. Matcher.matches anchors the entire
  input so alternations backtrack. Serialization block-data isn't full object-graph support;
  unsupported descriptors/backreferences must fail explicitly.
- Java RSA OAEP permits SHA-256 with MGF1-SHA1, which WebCrypto cannot express independently.
  Retain real crypto with lazy forge for that case; software keystore persistence doesn't imply
  hardware backing/authentication. Lazy pinned Noto COLRv1 still reads the whole font on native
  use: it saves unused-app startup bytes, not used-font bytes. Preserve asset provenance/licenses.
- Surface/TextureView lifecycle and ownership are independent of decoded-frame counts. Replay
  must not retain closed VideoFrames. MediaCodec/WebCodecs queues are bounded; AVC key-frame
  detection uses stream headers when Android flags are absent. Audio retains real PCM/capacity/
  clock state. More than eight access units before first output and midstream format notifications
  remain unverified limitations. Writable FileChannel mappings, non-NORMAL blur and enabled
  shared-element transitions lacked established support. One verified clip doesn't prove them.

## Measurement discipline and rejected shortcuts

Use the [harness guide](../tests/e2e/README.md) and current AGENTS commands. One E2E process at a
time; compare perf with --jobs 1, matching flags and no competing diagnostic browsers. Check
visibility and advancing wd.ticks: throttling can occur even with document.hidden=false.
One old Chrome process took over 15 s for guest work completed in 2.6 s by fresh instances;
foreground/debugger/throttle changes didn't explain it. That proved a process difference,
not that its version update alone caused the speedup.

The in-page probe observes scheduled work within the step horizon; timed parks are waiting.
Don't restore fixed sleeps or change guest deadlines to pass captures. Playwright page.clock
conflicted with timer wrappers, so the harness pins Date itself and uses live clocks for network
flows. Capture the sampled frame: SwiftShader readback can take seconds while the app draws.
Content arrival, settle, screenshot latency, CPU time and frames are different measurements.
A wedged app can appear cheaper because it stopped working.

Suspension-stack tracing made Error.stack dominate CPU and a working post appear stalled.
Disable probes for final timings; labels don't prove V8 flags were passed correctly. Await full
DOWN/UP taps and swipes before diagnosing input. A Mihon gesture-acknowledgement rewrite was
rejected after swipes completed well before capture on both revisions; fallback-coordinate
sensitivity remained. Attribute-index caching and drawable-padding experiments still require
new measurements under AGENTS.

### Shared account state and visibility

AccountManager now uses a lazy browser-owned account store instead of separate package
localStorage arrays. Records carry authenticator ownership and explicit package visibility.
Only the owner UID can read or modify passwords, user data and cached tokens; visibility
exposes account identity without granting credential access. Authenticator discovery reads
metadata and resources from the defining package, including direct XML string attributes.
Password changes invalidate cached tokens. Feature queries no longer claim support for
unchecked features, and notifyAccountAuthenticated requires an owned existing account.

Typecheck and eight focused tests passed (55 assertions). A separate fresh browser fixture
confirmed genuine microG authenticator metadata, account user-data changes across two SDK
processes, and reload persistence. That fixture used a synthetic local account record, not
a successful Google login (/tmp/webdroid-account-store-browser.log). The browser check also
caught registration order: storage attaches before the foreground process exists, so its
process-death cleanup hook is installed only after registration. Reattaching removes the
previous account-update observer. Authenticator Binder request routing remains incomplete.

## Authenticator requests and futures

AccountManager now discovers authenticator services from manifest metadata and dispatches
Android 13 IAccountAuthenticator transactions through a system-owned service binding. The
response Binder enforces the authenticator UID. Caller options replace supplied package/UID/PID
values, and token replies must match the requested account. Futures post to the requested
Handler, reject pending main-thread waits, and release bindings on completion, cancellation,
timeout or service death. Account and Intent replies retain nested callback Binder handles.

The focused suite passes 19 tests and 98 assertions; typecheck passes. In a clean browser,
genuine microG bytecode answered positive/negative feature requests for a synthetic local
account, filtered the visible account list, and returned LoginActivity with its response.
No Google account or token was fabricated. Pending updateCredentials requests canceled cleanly;
process death returned AuthenticatorException, and early cancellation left no binding behind.
Evidence: /tmp/webdroid-authenticator-{browser,lifecycle-browser}.{json,log}.

An Activity-bearing addAccount request rendered microG's login prompt, remained pending, and
Back canceled the future and released its binding. That newly reached path reported missing
Activity.finishAndRemoveTask; task completion is the next platform gap. Evidence:
/tmp/webdroid-authenticator-activity-browser.{png,json,log}. Interactive Google authentication
is still unverified. Token-by-features account selection, authenticator session encryption and
notification-based consent remain outside this dispatch checkpoint.

## Activity task completion

Activity.finishAndRemoveTask now distinguishes task roots from nested activities instead of
aliasing every call to finish. A broker-owned membership table gives local and remote activities
stable task/instance IDs, promotes surviving roots, and retains identity through recreation.
Task removal runs destruction in the owning processes and restores the outside caller. This
models task membership and removal; affinity-based task reuse and launch-mode policies remain
separate work.

Eight focused tests and typecheck pass. The browser fixture creates a local task and child,
recreates the child, removes the task through its root and verifies the original SDK activity
resumes. A genuine microG LoginActivity launched as a new task exits through its Cancel button,
removes that task and returns to the SDK client. The ordinary AccountManager login/Back path
also passes with no missing APIs or suspension diagnostics in all four reached processes.
Evidence: /tmp/webdroid-activitytasks-browser.{json,log} and
/tmp/webdroid-authenticator-{activity,task}-browser.{png,json,log}.

## Platform-backed balanced location

Pinned microG selects its built-in network service when that component is enabled;
otherwise its LocationManager requests the Android network provider. Browser geolocation
cannot supply the radio scans consumed by the built-in backend. The verified system-package
profile now defaults that optional component to disabled using the ordinary component store.
Provisioning checks the component exists and preserves explicit default/enabled/disabled
settings. Fresh-browser fixtures verify all four initial states. No runtime package-name
branch or microG bytecode replacement is involved.

The genuine SDK/microG balanced request receives a synthetic browser fix with
enableHighAccuracy=false, then releases the watch on removal. All three reached runtimes
have empty missing-API and suspension diagnostics. The dedicated API 35 Android reference,
using the same microG component configuration and SDK priority 102, receives the synthetic
network-provider fix with its supplied 7 m accuracy. The temporary Android test provider
and shell mock-location app-op were removed/reset afterward; the reference retains the
matching microG configuration. Input accuracy is not a comparison of positioning quality.
Evidence: /tmp/webdroid-balanced-location.{json,log},
/tmp/webdroid-provision-settings.{json,log}, /tmp/webdroid-reference-balanced.{png,json}.
The SDK fixture accepts a location_priority Intent extra; the default remains high accuracy.

Two failed probes were fixture mistakes: missing background-location permission interrupted
the SDK activity and correctly removed its listener, while updates inside microG's 10-second
network interval were correctly filtered. Respecting both exposed the missing bearingTo
method in real microG. Location now shares one cached WGS84 inverse calculation for distance,
bearing and distanceBetween, matching Android's float results for six oracle cases including
polar/dateline and antipodal coordinates. Four tests pass with 79 assertions; typecheck and
updated SDK smoke compilation pass. Oracle: /tmp/webdroid-location-oracle/output.txt.

## Final profile verification at a780ce4

Typecheck and the full unit suite pass: 1,002 tests, 47,229 assertions. Resy, pinned microG
and the rebuilt SDK client compile with zero method failures. Framework coverage remains
295/363 declared natives with executable probes passing; text comparison passes 6/6.
Serialized E2E renders all 75 scored steps, overall content difference 37.40%, with unchanged
goldens. No main-loop wedges, settle timeouts, native-required entries or newly reached
missing APIs appear relative to b567197. FitNotes's fragment exception persists; Harmonic's
layout exception has the separately recorded exact-launch baseline reproduction. Flappy has
the same six FPS failures (minimum 21); Lichess remains loading despite responsive navigation.
DoodleJump renders 6/6, minimum 34 fps, without missing APIs/errors. Corpus renders 13/14;
TikTok fails again. Its 22 distinct gaps introduce none beyond the preceding checkpoint.

Three serial matched FitNotes cold/reset pairs use the same headless driver and CDP
renderer-thread CPU counters. Median CPU is 1231.083 → 1275.325 ms cold (+3.59%) and
1050.920 → 1109.336 ms after reset (+5.56%). All runs compile 600 root classes with
comparable layout/draw work. The ten-second early-idle medians are 265.166 → 355.266 ms
and 248.088 → 339.513 ms. Broker calls remain 10 → 42 (provider calls 4 → 32), matching
the startup activity identified by the earlier CPU profiles; accumulated overlapping IPC
latency is not CPU. These windows include delayed service initialization, not steady idle.

Three separate pairs wait 30 seconds, collect garbage, then drive nine more interactions.
All text actions hit; every step renders without new errors or missing APIs. CPU samples
are baseline [628.713, 617.403, 640.868] and completion [709.117, 628.129, 630.113] ms
(rounded samples; median +0.22%). The initial +12.8% result did not repeat and is retained,
not discarded. Median live JS heap is 128.986 → 137.622 MB. Both root native buffers reserve
256 MiB; CDP JS heap does not include Wasm/external/GPU memory. These checks do not establish
performance for every APK or hide the measured startup cost.

Artifacts: /tmp/webdroid-profile-final-{unit,fwtest,textcmp,resy-smoke,microg-smoke,e2e,corpus}.log;
/tmp/webdroid-location-final-{typecheck,smoke}.log;
/tmp/webdroid-profile-final-e2e-{actual,report}; /tmp/webdroid-profile-final-comparison.json;
/tmp/webdroid-profile-perf-{baseline,final}-{1,2,3}.json;
/tmp/webdroid-profile-steady-{baseline,final}{,-2,-3}.json;
/tmp/webdroid-profile-final-perfsum.log. The corpus log reports launch/gap coverage; the previous
checkpoint retains detailed per-APK error JSON. The preserved Google sign-in tab is still at
the email step; no authenticated account result has been observed.

## Layout passes, text wrapping and the measure cache

The frame loop laid out and redrew every frame even when nothing changed. Harmonic's idle front
page ran one layout pass and one draw per frame, with about 268 invalidates each. Three mechanisms
fed the loop:
- Every attach, including `addViewInLayout`, `attachViewToParent` and `detachViewFromParent`,
  requested layout on the parent. RecyclerView re-attaches its rows inside its own `onLayout`, so
  each pass asked for the next.
- `replayLayoutRequests` replayed requests made during measure. AOSP collects requesters only
  while `isInLayout()` and keeps those whose force-layout flag survived the pass.
- `settle = 3`, the activity-start timers and `settleWatch` added up to six extra passes per
  request.

Now:
- Hierarchy mutations request through the parent's virtual `requestLayout()`; the in-layout
  variants request nothing.
- Replay keeps only surviving, attached, shown requesters, and the settle machinery is gone.
- `requestLayout` always names a view. `requestLayoutAll` is reserved for boot and configuration
  changes.
- Overlay and decor roots are no longer force-measured each pass.
- AOSP's measure cache (skipped below targetSdk 19) and the EXACTLY-spec skip (targetSdk above 23)
  are in.
- TextView memoises line wrapping and per-line widths. Setters that change wrapping request
  layout, and size and typeface only on change.
- RelativeLayout resolves forward anchors within one pass.
- Layer, Ripple and Inset drawables set their children's callbacks. The old per-frame loop had
  hidden that; without it a MaterialButton morph froze.

Dirty-region drawing was measured out: once idle draws stopped, a draw cost 1.4–2.7 ms against a
~10 ms full blit on SwiftShader, so `present()` stays a zero-copy transfer.

Benchmarked base `91ea9b1` against `847d5d6` on an idle machine:
- two alternating `--jobs 1` E2E runs per build on SwiftShader
- real-GPU first draw in Chrome 152 (headless, ANGLE Metal), 3 runs
- idle renderer CPU (CDP `TaskDuration` over 10 s after a 12 s settle), 3 runs

| Harmonic | Base | Final |
|---|---|---|
| Idle renderer CPU | 506 ms/s | 17 ms/s |
| Idle layout passes / draws per 10 s | 600 / 600 | 0 / 0 |
| E2E wall time | 43.4 s | 24.7 s |
| Layout time | 17.3 s | 2.4 s |
| Frame time | 26.2 s | 6.1 s |
| `measureText` calls | 12.5 M | 92 k |

- **FitNotes:** wall time −13%, layout passes −69%, `measureText` −97%.
- **Other flows:** wall time within ±2%, with 65–75% fewer layout passes.
- **Unchanged:** goldens, fps and diagnostics.
- **Real-GPU first draw:** moves within run spread (FitNotes −1%, Harmonic 0%, Resy +4%).
- **calculatorm:** its median draw time looked 59% higher. The whole difference is a one-time
  launch draw that is bimodal on base too (52 against 450 ms across its two runs); its tap steps
  are equal.

Limits:
- Settles now usually end on "idle", so a missing invalidation would surface as a golden flake.
- `getLayout()` and TextView wrapping still use different line breakers.

## Rejected: a Web Worker per process

Process realms were moved from iframes into module workers, with a message-only broker, storage
mirrors and host-side WebView and audio. It worked, but was not adopted. Its costs:
- **Memory:** about 15% more JS heap (+36 MB for Resy with microG), because each worker holds
  its own copy of the dex it runs. Sharing it would need SharedArrayBuffer, which the WebView
  proxy's framing rules out.
- **First draw:** each worker pays a one-time first decoded-image draw of about 200 ms on
  SwiftShader, on the thread that boots the app. Warming it up could not overlap the install's
  range reads, which need the same thread.
- **Compiled code:** Chrome reused none of it across module workers, even at a stable script URL.
- **Harness:** the harness had to capture inside the worker, and same-package multi-process
  SQLite became last-writer-wins.

## WebView upstream bases — 2026-09-11

Resumed microG from `28b9246` on `codex/microg-webview-base`. The current public
Google identifier document has one `<base href="https://accounts.google.com/v3/signin/">`.
The proxy prepended another using the final document URL. The cached Google script's
`_.pab` returns null unless there is exactly one BASE element, and its caller uses
`.replace` on that result. This confirms the duplicate-base mechanism; it does not
establish the cause of Google's later consent rejection.

`0ff3003` replaces the head regex with Bun's existing HTMLRewriter. The transformer
resolves base hrefs against the final upstream URL, preserves separate href/target
selection and multiple original bases, ignores inert template contents and tag-like
text, and injects the bridge before page scripts without moving the doctype. Invalid
or disallowed base URLs use the upstream fallback, following the
[HTML base rules](https://html.spec.whatwg.org/multipage/semantics.html#the-base-element).
Asset documents use the same insertion path without an upstream base.

A follow-up Chromium test exposed a resource-order regression: an external script
before the document's base loaded from the renderer origin. `349c4e0` keeps an upstream
fallback until the real href is parsed, then removes it through a synchronous script.
Scripts before and after that point execute from the correct document/assets paths.
Chromium may speculatively request an additional relative resource under the temporary
fallback before parsing the removal script; the test observed `/dir/after.js` as well
as `/assets/after.js`, but executed only the latter. This is a remaining transport
cost, not evidence that every dynamic document/base operation matches native WebView.
No host-specific page transformation or security-header relaxation was added.

Verification:

- Final typecheck and 603 units / 20,401 assertions pass, including 12 real Chromium
  HTML cases. Resy, pinned microG and GmsClient compile with zero method failures.
- Framework executable probes pass; the browser-only Paint metric probe is skipped
  by that CLI. Text comparison passes 6/6 paragraphs.
- The isolated WebView fixture passes delayed synchronous bridge returns, relative
  scripts, redirect cookies, HttpOnly boundaries, POST cookies/body, Android user-agent,
  clean visible URL, worker restart, destruction and persistent-only cookies on reopen.
- Genuine microG reaches Google's identifier page with exactly one original base and
  no page exceptions. Diagnostic instrumentation reached all three child JVM realms;
  their missing sets were empty. The old `__wdProcess` helper was absent in this checkout,
  so the fixture explicitly injected it into the process bundle. Empty values from a
  missing helper were not treated as diagnostic coverage.
- Serialized E2E at `0ff3003` and starting revision `28b9246` completes all 111 steps
  (75 scored). No missing/error/native-required entries are added. Content scores,
  baseline → current: FitNotes 40.89 → 40.89%, Mihon onboarding 17.56 → 17.56%,
  Mihon app 56.94 → 57.07%, Harmonic 32.22 → 32.25%. Visual goldens are unchanged.
  FitNotes' destroyed FragmentManager, Harmonic's extension-provider gap, Lichess's
  PhantomReference/sidecar gaps and DNS warning, and Flappy's DexClassLoader gap and six
  FPS failures reproduce in the baseline. Lichess remains on its loading screen.
- Per-flow elapsed changes are between −1.12% and +1.34%. Flappy minimum FPS is 27 in
  both; DoodleJump is 39 → 38. One focused Chromium test overlapped the baseline run,
  so these are regression observations, not an isolated CPU benchmark. The previous
  full matrix precedes the resource-order refinement; its final verification consists
  of focused Chromium/transport/login checks and corpus. Fresh isolated CPU/memory
  comparison and a full E2E rerun remain pending.
- Both full corpus runs render 13/14 APKs; TikTok fails in each. Initial gap counts are
  24 baseline / 26 current, differing only in two nativeStoreString entries on TikTok's
  failing startup path. A matched TikTok repeat produces the same 12 gaps and undefined
  queue `push` failures on both revisions, without those two entries. Neither repeated
  run requests a proxied HTML document or HTML asset, so the changed transformer is not
  reached. The initial difference is retained as an observation, not attributed to a
  proven network cause.

The initial transformer processed a cached 1.48 MB Google document in a 0.62 ms median
across 50 warmed iterations (p95 0.83 ms). This measures server-side transformation at
`0ff3003`, not login latency. The root executable browser bundles match after removing
Bun's path/source-map comments; the server transformer is outside the emulator bundle.

Artifacts: `/tmp/webdroid-microg-resume-{unit-final,typecheck-final,webhtml-final,fwtest,
textcmp,resy-smoke,gms-smoke,client-smoke,e2e,baseline-e2e,corpus,baseline-corpus}.log`,
`/tmp/webdroid-microg-resume-comparison.json`, corpus JSON files beside their logs,
`/tmp/webdroid-microg-resume-{baseline,current}-tiktok-path.json`,
`/tmp/webdroid-microg-resume-{baseline-,}perfsum.log`,
`/tmp/webdroid-webview-relative-context-final.log`, and
`/tmp/webdroid-microg-resume-login-page-final.log`.

A fresh Chrome test tab at localhost:41979 is awaiting user-entered Google credentials
and any phone challenge. The isolated diagnostic server captures only `egQ4Re` and
`ihzRS` response bodies before navigation into a protected test-config subdirectory;
reports contain bridge method names, API gaps and account counts rather than secrets.
The existing protected browser state was neither imported nor overwritten. No new
Google account or successful final consent has been observed in this run.

### 2026-09-11 — SDK map markers and bitmap resource density

The final WebView resource-order E2E rerun completed all 111 steps (75 scored), with
no additional missing/error/native-required diagnostics against `28b9246`. Scores:
FitNotes 40.89%, Mihon onboarding 17.56%, Mihon app 57.16%, Harmonic 32.67%.
Goldens stayed unchanged. Evidence: `/tmp/webdroid-microg-resume-e2e-final.log`,
`/tmp/webdroid-microg-resume-comparison-final.log` and
`/tmp/webdroid-microg-resume-perfsum-final.log`.

A dedicated Maps SDK activity now exercises camera movement, animation completion,
default markers and marker clicks against genuine microG. The initial browser run
matched Android's target/zoom and callbacks, but default-marker construction reached
missing `BitmapFactory.decodeResource(Resources,int)` in microG's
`BitmapDescriptorFactoryImpl.defaultMarker`. No application bytecode was substituted.

The resource decoder uses the existing stream/bitmap decoder and the selected ARSC
configuration's density; file-name heuristics would fail for obfuscated resource paths.
`openRawResource` now supplies TypedValue metadata, follows resource aliases and throws
Resources.NotFoundException for missing files. Resource decoding closes its stream and
follows Android's exception-to-null contract. Density defaults, explicit density,
`nodpi`, `inScaled`, `inScreenDensity` and bitmap density follow
[AOSP BitmapFactory](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-13.0.0_r1/graphics/java/android/graphics/BitmapFactory.java).
The shared decoder also reports sampled output dimensions and requested mutability.

The retained `BitmapProbe` exercises four tiny 8x6 PNG resources (mdpi, nodpi,
unqualified and alias), seven option combinations and a missing ID. All 33 log results
match the dedicated API 35 Android reference at 480 dpi. In particular sampled decode
reports 4x3 bounds before density scaling, while bounds-only decode reports 8x6.
This does not establish arbitrary codec sampling, nine-patch decoding, inBitmap reuse,
hardware/color-space validation or complete BitmapFactory parity; those pre-existing
decoder limits remain outside the observed marker path.

The fixed browser map visibly renders the marker, delivers its click callback and
opens the SDK title bubble. Camera target 51.5074,-0.1278, zoom 10 then 11, one animation
completion and one marker click match Android. Initial minimum zoom and projection
pixels differ with the two screen geometries; these are smoke observations, not a
pixel-parity claim. Three recorded browser runtimes have empty missing sets and no
captured errors. The rebuilt SDK APK remains under its ignored Gradle build directory;
`apks/GmsClient.apk` and the protected login state are unchanged.

Typecheck, 603 tests / 20,401 assertions, zero method failures for Resy/microG/rebuilt
SDK, executable framework probes and 6/6 text comparisons pass. Full E2E/corpus and
isolated CPU/memory verification of this bitmap change were pending at `c376306`.
Evidence: `/tmp/webdroid-map-probe-browser-fixed.log`, map screenshots and JSON beside
it, `/tmp/webdroid-map-probe-android.log`, `/tmp/webdroid-bitmap-probe-{android,browser-final,
typecheck,unit,fwtest,smoke,resy-smoke,gms-smoke,textcmp}.log` and
`/tmp/webdroid-bitmap-probe-browser.json`. Browser scripts are under the matching
`/tmp/webdroid-{map,bitmap}-probe-browser.ts` paths. Android probes use the same rebuilt
APK installed with `adb install -r`, preserving the dedicated test account.

The subsequent full serialized E2E run completed all 111 steps, with no added
missing/error/native-required entries, no layout/draw errors and no wedges against
`28b9246`. Scores: FitNotes 40.89%, Mihon onboarding 17.56%, Mihon app 57.40%,
Harmonic 33.07%. DoodleJump minimum FPS is 39 on both revisions; Flappy is 27 → 26
and retains its known FPS failures. A corpus process briefly overlapped the tail of
FitNotes/start of Harmonic before being stopped, so those timing intervals are not
isolated performance evidence. The complete corpus rerun after E2E renders 13/14 APKs
and reports the same 24 distinct gaps as the baseline; TikTok still fails with 12 gaps.
This corpus run retained its summary, not per-APK error JSON. Evidence:
`/tmp/webdroid-bitmap-probe-{e2e,comparison,corpus-final}.log`.

Three alternating baseline/current performance pairs compare `28b9246` with `c376306`,
using headless Chromium, the same eight FitNotes steps and golden geometry, with no
competing capture/build workload. The middle pair reverses order. "Cold" uses a fresh
browser context; "warm" resets the app in that browser, not an Android warm activity
resume. CDP thread-tick TaskDuration covers the measured renderer, not total system CPU.

Median baseline → current:

| Measurement | Cold | Reset |
| --- | --- | --- |
| Foreground CPU | 1203.52 → 1201.21 ms (−0.19%) | 1171.13 → 1173.16 ms (+0.17%) |
| Boot counter | 141.1 → 140.2 ms | 156.3 → 155.5 ms |
| Lazy compile time | 99.5 → 98.3 ms | 112.7 → 108.8 ms |
| Retained JS heap after GC | 136.858 → 136.859 MB | 137.002 → 136.974 MB |
| Steady idle CPU over 10 seconds | 356.36 → 369.42 ms (+3.66%) | 377.72 → 368.99 ms (−2.31%) |

All runs compile 600 classes and perform 20 cold / 24 reset draws. Frame counters vary
with scheduling (medians 168 → 171 cold, 195 → 202 reset); no layout/draw errors occur.
Every run stays visible, renders all measured steps, advances 3599–3604 ticks across
30 seconds of idle observation and ends with an empty main queue. Each reproduces the
same destroyed-FragmentManager exception and no missing APIs, so this is an observed
flow comparison, not a claim that the app completes every intended transaction.

The broker wrappers observe 42 calls and 100 binary payload bytes in every run.
Aggregate awaited call time is 2342.3 → 2325.8 ms cold and 991.6 → 982.9 ms reset;
these overlapping asynchronous durations are neither CPU time nor serialized wire size.
Root Wasm linear memory stays at 256 MiB; this is addressable memory, not resident RAM,
and JS heap excludes Wasm/external memory. Natural pre-GC heap medians also stay close
(+0.17% cold, +0.01% reset). No repeatable >5% foreground CPU regression was observed.
Evidence: `/tmp/webdroid-bitmap-perf-{baseline,current}-{1,2,3}.{json,log}` and
`/tmp/webdroid-bitmap-perf-summary.jsonl`; driver and series scripts are
`/tmp/webdroid-microg-resume-perf.ts` and `...-perf-series.ts`.

The Google-login test tab remains at the SDK client with zero accounts and no recorded
bridge calls; it still awaits the user's credentials/challenge. No further login
attempt was started. Broader map gestures/cancellation/lifecycle and the previously
listed account/service/task breadth remain open; the integration goal is not complete.

### 2026-09-11 — Native suspension leaked guest Java thread identity

The extended Maps SDK probe interrupts an animation, pans with a marker present,
replaces/clicks the marker, then destroys and reopens its activity. Android completes
this sequence. Webdroid's map also moved, but annotation feature queries and sometimes
camera movement threw MapLibre CalledFromWorkerThreadException. Empty missing-API sets
alone did not expose the failure. The exception originated in touch dispatch through
AnnotationManager/MoveGestureDetector, not the delayed single-tap timer.

A temporary currentThread/setCurThread trace identified `ResourceLoaderTh` inside a
main-queue input job. The last identity setters came from Cpu.loop's native resource
worker. Bytecode releases identity when it suspends, but the native runner left its
worker current while awaiting host promises or yielding its budget. Native view
continuations could then call Java with that worker's identity.

Cpu.loop now releases to the runtime's default main identity before suspension and
on exit/rejection, and restores its guest after a signal handler or host wait. Guest
frame/signal ordering and wake timing are unchanged. Eight real ARM32/A64 runner tests
cover parked host completion/rejection, budget yield followed by a host call, synchronous
return, and a signal handler followed by the interrupted guest. All eight fail against
`4acef6d` and pass with the change; the incomplete first attempt also exposed why signal
resumption and synchronous exit needed explicit coverage.

The first fixed extended run removed the exceptions but produced a map click instead
of the expected marker click at the SDK-reported position. Animation interruption had
left different intermediate zooms between runs. A controlled follow-up resets the
camera before marker insertion: both `4acef6d` and current deliver the marker click,
while only the baseline throws the worker-thread exception during panning. This does
not explain away the earlier miss or establish complete coordinate/hit-test parity.
At 1080x2424@480 the browser also reports a different initial minimum zoom/projected
marker Y than Android; window/navigation geometry and screen-coordinate reporting
remain open. No app-specific callback suppression or marker substitution was added.

Instrumentation now installs before SDK boot, records every reached fork, and confirms
that the runtime owning NativeMapView was captured (three reached runtimes, all missing
sets empty). Earlier successful simple-marker observations retain their narrower scope.
Android's second animation gets one onCancel and one onFinish, as documented by the
[SDK callback contract](https://developers.google.com/android/reference/com/google/android/gms/maps/GoogleMap.CancelableCallback).
Current repeats reach loaded after activity teardown/reopen with fresh callback counts.

Evidence: `/tmp/webdroid-map-advanced-{browser,android}.log`,
`/tmp/webdroid-map-thread-{all,pins}-browser.{log,json}`,
`/tmp/webdroid-map-matched-{baseline,current}.{log,json}`,
`/tmp/webdroid-map-thread-test-{baseline,both}.log`. The source-matched baseline server
is 41981, worktree `/tmp/webdroid-map-thread-baseline` at `4acef6d`; its only extra source
is the copied new runner test. Production/current remains 41977. Login server 41979
and the pending user interaction are preserved. Broad checks are recorded below.

Before the runner commit: typecheck, 611 tests / 20,439 assertions, executable framework
probes and 6/6 text comparisons pass. Resy, pinned microG and the rebuilt SDK client
compile with zero method failures. Logs: `/tmp/webdroid-map-thread-{typecheck-final,
unit-final,fwtest,textcmp,resy-smoke,gms-smoke,client-smoke}.log`.

After `f459bcb`, the serialized E2E run completes all 111 steps with no added missing,
error or native-required diagnostics versus `28b9246`, no layout/draw failures and no
wedged rendering. Existing Doodle/Flappy FPS failures remain (Doodle minimum 39 → 38,
Flappy 27 in both runs); this timing does not establish a regression. Corpus renders
13/14 APKs with the same 24 distinct missing APIs, no added normalized error entries
and the existing TikTok failure. Visual goldens are unchanged. Evidence:
`/tmp/webdroid-map-thread-{e2e,comparison,corpus,corpus-comparison}.log`.

Three alternating native performance pairs compare `4acef6d` with `f459bcb`, with the
middle pair reversed and no competing capture/build work. Each fresh headless browser
runs the first five standard Doodle Jump steps (through gameplay) at golden geometry.
Median renderer foreground CPU is 11488.10 → 11505.70 ms (+0.15%); retained JS heap after
GC is 150.782 → 150.780 MB (−0.001%). Native instruction count is 10.914 → 10.911 billion,
native execution time 9182.20 → 9236.80 ms (+0.59%), host calls 148302 → 148677, and
compiled classes 68 in every run. Draw time is 445.60 → 437.60 ms and GL frames 788 → 795.
Every run stays visible, advances 1790–1817 ticks, renders the gameplay scene and has
no missing/native-required/error diagnostics or layout/draw/GL failures. Wasm addressable
memory remains 256 MiB. CPU is CDP thread-tick TaskDuration, heap excludes external/Wasm
memory, and this bounded flow does not establish every APK's performance or cold/warm
microG costs. No repeatable >5% foreground CPU regression is observed. Evidence:
`/tmp/webdroid-map-thread-perf-{baseline,current}-{1,2,3}.json`, adjacent `.json.png`
captures, and `/tmp/webdroid-map-thread-perf-summary.jsonl`; driver/series/summary scripts
use the same `/tmp/webdroid-map-thread-perf` prefix.


### 2026-09-11 — Map window-coordinate measurements

The SDK marker trace now also reports `getLocationOnScreen`, `getLocationInWindow`
and MapView width/height. The rebuilt APK compiles with zero method failures and runs
on both the dedicated Android reference and browser, without changing production code.
At 1080x2424@480:

| Measurement | Android | Webdroid |
| --- | --- | --- |
| Reported screen origin | 0,322 | 0,248 |
| Reported window origin | 0,322 | 0,248 |
| Drawn map top | 322 | 320 |
| Map size | 1080x2030 | 1080x2104 |
| Projected center marker | 540,1336 | 540,1298 |

Webdroid's view hierarchy omits the shell's 72-pixel status-bar translation, and its
map extends to the display bottom rather than Android's bottom system-bar boundary.
The 2-pixel control-height difference is separate. The SDK still delivers the bounded
marker click in both runs, so a successful click alone does not validate coordinates.
The Android run here completes only one animation, with no cancellation; separate
ADB taps did not reproduce the earlier interruption timing. Earlier cancellation
observations retain their own evidence, not this repeat.

[AOSP View](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-13.0.0_r12/core/java/android/view/View.java)
transforms into window space, then adds the attached window's screen position for
screen coordinates. The Android activity's window already includes system bars, so
its two origins are equal. Webdroid currently computes both from its content-relative
tree, while `device.ts` independently translates rendering and input. The exported
`locationOnScreen` helper also serves popup placement and relative rectangles; simply
adding the status-bar offset to it would mix coordinate systems. A correction needs
explicit ownership of window geometry and checks for fullscreen, overlays and detached
views. No coordinate patch or map-specific offset was added in this checkpoint.

Evidence: `/tmp/webdroid-map-coordinates-{browser,android-run}.log`,
`/tmp/webdroid-map-coordinates-browser.json`, build/smoke logs with the same prefix.
The browser captures all three reached runtimes before boot, including NativeMapView's;
all missing sets and error lists are empty. Login `/diag` still shows the SDK client,
zero accounts and no bridge calls; user sign-in remains pending.


### 2026-09-11 — Window geometry and decor inset ownership

The standalone SDK WindowProbeActivity (`05141f6`) compares actual Android API results
for detached, normal, fullscreen, edge-to-edge, hidden-bar, legacy-layout, popup and
dialog windows. The old implementation returned content-relative activity coordinates,
ignored edge-to-edge requests, gave detached views root insets and included popup screen
position in window-relative coordinates. DialogRoot represented a full-screen dim layer
rather than the dialog's real window. Its width cap/minimum were hardcoded and its
single-view setContentView defaulted to wrap instead of filling a resized window.

The working correction puts activity decor in display coordinates, lets decor consume
bar insets into content margins, and removes the independent shell translation from
rendering/input/diagnostic trees. Root insets are cached by root geometry and visibility.
A popup's window coordinates exclude its root's screen position. Dialog measurement uses
window parameters, theme padding and minimum-width resources, while the shell positions
and dims behind the actual window. Modal outside touches still reach the dialog's own
cancellation handler. This follows the responsibilities visible in
[AOSP View](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-13.0.0_r12/core/java/android/view/View.java)
and [DecorView](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-13.0.0_r12/core/java/com/android/internal/policy/DecorView.java),
without changing client or library bytecode.

At 1080x2424@480, normal/fullscreen/edge/hidden/legacy activity and popup probe values
match Android, including root sizes/insets and both coordinate spaces. Detached root
insets are null. A wrapped dialog reports content origin 48,48 and width 332 in both;
its native text is 55 pixels tall versus Android's 57, giving root heights 151 versus
153 and a one-pixel center difference. After setLayout(640,360) and bottom gravity, both
report root 220,1992,640,360 and content 544x264 at screen 268,2040/window 48,48.
The Android immersive-mode education prompt was acknowledged before the successful
repeat; it blocked the first expanded probe, not the app's window operation.

The genuine map now reports and draws origin 0,320 with size 1080x2032, versus Android's
0,322 and 1080x2030. The remaining difference is the preceding text row's height. Camera
cancellation, pan, fixed-camera marker replacement/click and activity reopen complete
without exceptions or missing APIs in all three observed runtimes. Evidence:
`/tmp/webdroid-window-{before,final}.log`, `...-android-expanded.log`, adjacent JSON/PNG
captures, and `/tmp/webdroid-map-window-current.{log,json}`. Typecheck, 611 units, zero
method failures for Resy/microG/rebuilt SDK, executable framework probes and textcmp pass;
logs use `/tmp/webdroid-window-*`. Broader verification is recorded below.
The probe does not establish transformed-view coordinates, all inset/flag combinations,
all dialog themes or complete window-manager parity.


The first full E2E window run captured all 111 steps, but Flappy Bird stopped producing
GL frames after an unexpected `ACTION_VIEW` launch. Its game surface now ends above the
navigation bar (2088 instead of 2160 pixels). The old normalized flap point maps to
camera y≈273, inside the title's Rate button (y=270..318), versus y=264 previously.
Bytecode and the APK's atlas establish these bounds. Both old and new Play coordinates
remain inside the Play button, so the initial missed-button hypothesis was rejected.
A trace records Play accepted at 151 ms and Rate pressed at 1077 ms while the title's
fade still runs; transition completion around 1151 ms can race the release. The flow's
800 ms horizon was too short. It now waits 1500 ms before gameplay and after restart;
production input and game bytecode are unchanged by this test adjustment.

The original flow failed in one of three current runs versus zero of three baseline
runs. A surface-relative Play-only experiment completed six runs, but changed no hit
region and therefore did not prove a coordinate fix; that experiment was discarded.
With the corrected horizon (`6fc0163`), all three alternating full-flow pairs complete
both games with no new exceptions or missing APIs. Current gameplay steps produce
64–106 GL frames and show actual gameplay; Play captures show Get Ready. Baseline
produces 57–100 gameplay frames. These diagnostic runs are not CPU benchmarks.
The available dedicated API 35 and isolated API 26 references only support arm64 and
cannot install this APK's native ABI unchanged. The temporary API 26 emulator was stopped
and its owned AVD files removed; no APK was modified or physical device used. Evidence:
`/tmp/webdroid-window-flappy-*`, including button/engine/camera disassembly, transition
trace, alternating runs and screenshots. The final serialized E2E run completes all 111 steps in 246.4 seconds with no added
missing/error/native-required diagnostics versus `28b9246`, no layout/draw errors and
no wedged main loops. Flappy gameplay produces 66–113 GL frames. Content-difference
scores are Mihon 57.67%, FitNotes 41.54%, Harmonic 29.35%, onboarding 17.56% and overall
36.53%; goldens remain unchanged. These scores are not claims of visual parity.
Doodle minimum FPS is 37 versus baseline 39, and Flappy retains its old 27 FPS limit;
controlled native timing follows. Lichess still shows its prior responsive loading
state and takes 84.4 seconds versus 78.3 previously; live-network wall time is not a
CPU comparison. Evidence: `/tmp/webdroid-window-final-{e2e,comparison}.log`.

The final corpus JSON reports 13/14 APKs rendering and the same 24 distinct gaps as
`28b9246`. Every APK has no additional normalized missing APIs or errors; TikTok retains
its baseline failure. The earlier console-only run observed 23 gaps, so it was not used
to assert a capability improvement. Files: `/tmp/webdroid-window-final-corpus.{log,json}`
and `...-corpus-comparison.json`. Performance uses three alternating pairs against
`05141f6` on port 41982, with no other test/build/capture work running concurrently.

FitNotes startup comparison (eight steps, median of three pairs): foreground CPU is
1174.03 → 1174.35 ms cold (+0.03%) and 1153.40 → 1138.47 ms after reset (−1.29%).
Retained JS heap is 136.857 → 136.885 MB cold (+0.021%) and 137.010 → 137.016 MB reset
(+0.004%). The transient pre-GC cold heap is +3.40%, not retained growth. First ten-second
idle CPU changes −4.51% cold / +5.33% reset, while the later settled ten-second window
changes −0.22% / −0.87%; these do not establish a sustained idle regression. Both sides
compile 600 classes and issue 42 broker calls carrying 100 bytes; root Wasm memory is
256 MiB. Every phase is visible, advances 3600–3605 idle ticks, and has no layout/draw
errors or added missing APIs. The old FitNotes FragmentManager exception remains on
both sides. IPC timings include awaited service work and are not isolated transport
latency. JS/CDP and root Wasm figures do not measure total browser/process memory.
Evidence: `/tmp/webdroid-window-perf-{baseline,current}-{1,2,3}.json` and
`/tmp/webdroid-window-perf-summary.jsonl`.

The native Doodle Jump comparison gives median CPU 11691.36 → 11651.12 ms (−0.34%),
retained JS heap 150.773 → 150.760 MB (−0.008%), and native execution 9343.50 →
9388.50 ms (+0.48%). Median GL frames rise 748 → 773 (+3.34%); aggregate frame work
rises 469.40 → 493.20 ms (+5.07%) and draw work 454.20 → 476.60 ms (+4.93%). This is
more frame work alongside more rendered frames, without a foreground CPU regression;
it is not a universal speedup. Both sides compile 68 classes, have 256 MiB root Wasm,
remain visible, advance 1750–1793 ticks and report no layout/draw/GL errors, missing
APIs or native-required gaps. Screenshots show the same animated tutorial scene, with
the intended navigation-bar geometry difference. This does not measure the full game,
all native apps or every child process's memory. Evidence:
`/tmp/webdroid-window-native-perf-{baseline,current}-{1,2,3}.json`, adjacent PNGs and
`/tmp/webdroid-window-native-perf-summary.jsonl`.

Remaining window reference coverage includes transformed view coordinates, inset/flag
combinations and notifications, overlay inset dispatch, non-floating dialog themes,
and explicit dialog dimensions smaller than background padding. In particular, review
DialogRoot's exact-size result and child layout for that last boundary before claiming
arbitrary-size parity. The map's animation-interruption idle ordering and earlier
variable-camera marker miss also remain open; Google consent still awaits the user.
