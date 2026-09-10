# Engineering constraints and investigation results

Retained findings through 2026-09-10, organized by engineering problem.
[PLAN.md](../PLAN.md) owns active work; [AGENTS.md](../AGENTS.md) owns implementation and
verification rules. This document preserves failure mechanisms, constraints, negative results
and evidence limits, not a complete API-coverage claim. Older source comments naming AGENTS
investigations refer here; Git retains their full chronological narratives.
Temporary /tmp evidence may expire. Committed regression fixtures are the durable reproductions.

## microG completion and open acceptance

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
- Child realms expose actual diagnostics and inherit natcheck/bytecode/jit options. Old collectors
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
- Native re-entry can suspend while common paths stay synchronous. maySuspend records this
  without Promise wrappers. Reached natcheck success cannot validate the whole sync tier.
  The experimental call-graph tier stays opt-in: generated lists miss unreached overloads,
  source scans miss helpers, and assuming all natives suspend erased nearly all advantage
  (historically 13.7% sync versus ~40% under unsafe assumptions).
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
wd.native.bench() changes ABI and resets image memory: never run it in a live app process.

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
