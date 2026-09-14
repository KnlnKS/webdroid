# Engineering constraints and investigation results

Retained findings through 2026-09-11, organized by engineering problem.
[PLAN.md](../PLAN.md) owns active work; [AGENTS.md](../AGENTS.md) owns implementation and
verification rules. This document preserves failure mechanisms, constraints, negative results
and evidence limits, not a complete API-coverage claim. Older source comments naming AGENTS
investigations refer here; Git retains their full chronological narratives.
Temporary /tmp evidence may expire. Committed regression fixtures are the durable reproductions.

## microG completion and open acceptance

PLAN.md owns current status. Both Android and webdroid now
return `authentication: true` through the genuine SDK's DEFAULT_SIGN_IN flow. Webdroid
also succeeds after a further full reload using its persisted account/preferences.
Earlier consent, missing platform operations and OAuth registration failures are
explained below. Full Android/API parity is not established.

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
- Shared account ownership, authenticator dispatch and Google sign-in are covered in the
  account-state and authentication updates below, including their earlier failure mechanisms.
- The dedicated Firebase project is webdroid-microg-test, Android client org.webdroid.gmsclient,
  free Spark plan. Configuration, browser state, credentials and registration tokens stay outside
  Git/reports. Upstream HTTP-form logs contain authorization values even without the word token:
  exclude the whole tag. The 260ca78 verification checkpoint below records regression/performance
  evidence; the later authentication checkpoint records successful interactive sign-in.

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

### 2026-09-11 — Lichess guest browsing, offline play, and a Dart-TLS JIT miscompile

With PhantomReference fixed on main the guest app is fully usable offline and for online browsing:
Home loads live content (Good evening, welcome card, Play), Puzzles loads the Puzzle of the day and
Storm/Streak/Themes, Watch loads Broadcasts and Lichess TV top games, Learn opens Coordinate
training, and the 15-step flow renders distinct frames end to end including the board-editor e2–e4
drag and a level-1 computer game whose native Stockfish replies (`1. e4 b6 2. Nf3 h5 3. Ne5 a5`)
appear in the move list. All that HTTP content arrives through Cronet, whose BoringSSL verifies the
Let's Encrypt ECDSA (P-384) chain fine. `renameat`/`renameat2` (bionic uses them for
atomic replace; Dart/sqflite journalling) were missing native symbols — added to stdio with a
`renamePath` helper that also carries directory renames and lazy sources, with a unit test.

Remaining limit: the app's realtime WebSocket to `socket.lichess.org` is opened by Dart's own
`dart:io` SecureSocket, which uses libflutter's statically-linked BoringSSL, and its ECDSA P-384
chain verification fails **only under the JIT** — the connection is torn down and retried in a
tight loop (~13 reconnects/30 s; ~2.4 M guest instr/s while a browsing screen sits idle). Under
`?jit=0` the same handshake succeeds and the socket stays up (1 connect/30 s), so this is a
JIT-vs-interpreter disagreement with the interpreter correct, not a TLS/relay or cert-store gap
(the pinned AOSP store resolves the by-dir hashes `1a416bbd/8ed85ee6/0b9bc432` and openssl verifies
the served chain against it). Runtime JIT bisection (`wd.native.core.jit_fallback(lo,hi)` +
`invalidate_range`, now exposed on `wd.native.core`) localized the miscompile to libflutter's
generic `bn_mul_mont` (the P-384 modular multiply), file offset 0x4c8238–0x4c825c inside the outer
Montgomery loop head at 0x4c821c — an `adds/adc/mul/umulh` limb chain feeding a `cmp x6,#1` whose
carry a later block's `adc x13,x13,xzr` consumes across the loop back-edge (deferred-flag
liveness). Forcing the interpreter over that one block makes the handshake succeed. It could NOT be
reproduced in an isolated tier-parity harness: BoringSSL's `bn_mul_mont` extracted verbatim and run
with a Montgomery oracle agrees between interpreter and JIT both when the region is entered at the
function start and when a snapshot is used to enter a region at the outer-loop head, across 24
random P-384-sized moduli, because the browser's region has a shape no in-body entry produces.
Replaying `discover` over the real page (region formation is a pure function of the page bytes and
the entry pc) showed it: the hot entry is bn_mul_mont's entry 0x4c8140, the `bl` target, whose
dispatcher `b.eq`s into bn_mul4x_mont (0x4c8380) and bn_sqr8x_mont (0x4c8d60) on the same page.
Those blocks spend the 320-instruction region budget, so the generic body's 0x4c8268 and 0x4c82b0
were registered as successors of the block 0x4c81f0–0x4c8264 (which runs straight through the
`cmp x6,#1` to `cbz x21`) but never scanned: `n = 0`, no successors, `exits` false. The flag
liveness gave such a block `lin = 0`, so the branch settled nothing into it, yet entering it
leaves the region — the exit spilled the carry of the earlier `adcs x13,x13,x7` and the
interpreter's `adc x13,x13,xzr` consumed it. A fallback range covering the `cmp` executes it in
the interpreter and reloads the flag locals eagerly, which is why the bisection "fixed" it. Not a
back-edge problem: any flag-setting branch into a budget-starved block, on either ISA. Fix:
`discover` marks the unscanned blocks as region exits, so the dataflow settles every flag on the
edges into them. `a64carry.test.ts` reproduces the shape with an in-page sibling block that spends
the budget (clang encodings) and disagreed between tiers before the fix (JIT x3=5, cpsr=0 against
the interpreter's 6 and Z|C); afterwards the Lichess socket connects once and stays up under the
JIT with idle guest execution at the interpreter's level (65 K instr/s over 30 s, no reconnects).
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
- Surface/TextureView lifecycle and ownership are independent of decoded-frame counts. Recorded
  display lists install a live surface operation before the first frame: otherwise winning that
  recording race leaves later decoded frames outside the cached list. Replay must not retain
  closed VideoFrames. MediaCodec/WebCodecs queues are bounded; AVC key-frame
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

## WebView same-document history and resumed consent — 2026-09-11

The resumed Google identifier step called History.pushState with an upstream URL and
threw SecurityError because the document runs on the isolated renderer origin. The
new history wrapper resolves URLs against the document base and translates only the
upstream origin to the renderer. Browser history owns entry creation, state cloning,
replacement and back/forward; the wrapper updates the worker context and generated
document base after successful changes. Explicit upstream bases remain unchanged.
Empty/null/omitted URLs retain the current document URL, following the
[shared History steps](https://html.spec.whatwg.org/multipage/nav-history-apis.html#shared-history-push/replace-state-steps).

The initial implementation assigned URL.host after changing the protocol. Assigning
a host without a port leaves an existing non-default port intact, contaminating the
upstream context with the renderer port. Six Chromium cases fail when the fixture
uses a non-default renderer port. Explicit protocol/hostname/port assignment fixes
them, including HTTPS upstream to HTTP renderer translation. The final 23 HTML/history
cases pass with 34 assertions. Typecheck passes; the full suite passed 628 tests and
20,462 assertions before the final port refinement, followed by the focused rerun.
Full transport/E2E verification of this change is still pending. Android WebView's
own history list, visited-history callbacks and document-cookie path synchronization
remain outside this bounded wrapper; do not infer complete History/WebView parity.

The first live run passed password and user-approved phone verification, then failed
after terms. Protected response capture recovered `egQ4Re` HTTP 200 with `[[null,true]]`
and `ihzRS` HTTP 200 with a null payload and error field `[13]`. The cached public script
names the latter `/CredentialDataService.GetCredential`. The genuine bridge reached
notifyOnTermsOfServiceAccepted but not addAccount, and no page exceptions were observed.
The error code does not identify why Google rejected credential retrieval. The retry
with corrected ports passed another user-approved phone challenge and failed identically.
Sanitized request capture shows hostname `127.0.0.1`, path
`/v3/signin/speedbump/embeddedsigninconsent`, and correct Origin/Referer origins
`https://accounts.google.com`. In the cached public script, navigation Ul() reads
window.location.href; Kzb() serializes the parsed hostname/path into eL()'s credential
request. The renderer hostname therefore still enters the payload even though the
worker sends correct headers. This is a proven location-semantics gap, not yet proof
that changing it resolves error 13. Further MFA needs a general location solution and
a controlled comparison; a Google-specific request rewrite would hide the platform
bug. No production payload transformation or fabricated credential was added.

Evidence: `/tmp/webdroid-webhistory-{tests,port-before,typecheck,units}.log` and the
protected test-config `resume-network/` response captures. Credentials and raw request
payloads are excluded from reports and source control.

## WebView upstream Location — 2026-09-11

The controlled retry with static Location virtualization changes GetCredential's
hostname from `127.0.0.1` to `accounts.google.com`; Origin, Referer and request path
retain their previous correct values. Consent now returns a non-null payload without
error 13. The broker's microG cookie jar contains the genuine HttpOnly `oauth_token`,
and Google's page navigates to `#close`. Script-visible cookies exclude that token,
as expected. There are no page errors. No account is stored yet because fragment
navigation has no Java WebView completion notification.

The exact microG LoginActivity source reads the token in `closeWeb(false)` after
`onPageFinished` sees `#close`, then performs the real AuthRequest exchange. Its
`JsBridge.addAccount` is a no-op. Chromium's AwWebContentsObserver separately posts
visited-history and page-finished callbacks for fragment navigation, without page-start
or page-commit-visible. Calling the full-load completion path would emit extra callbacks.
Sources: [microG v0.3.16.252432 LoginActivity](https://github.com/microg/GmsCore/blob/v0.3.16.252432/play-services-core/src/main/java/org/microg/gms/auth/login/LoginActivity.java)
and [Chromium AwWebContentsObserver](https://chromium.googlesource.com/chromium/src.git/+/master/android_webview/java/src/org/chromium/android_webview/AwWebContentsObserver.java).

The server uses the existing TypeScript parser to preserve source slices while routing
static Location access through a Window/Document owner helper. Real browser security
origins remain unchanged. Inline executable scripts and handlers participate; JSON/data
scripts and integrity-protected resources do not. Local bindings, getters, receivers,
constructors, simple destructuring and history/fragment behavior have Chromium tests.
Constructor precedence initially failed and is covered by a regression test. The HTML
rewriter collects script chunks before replacement so unclosed script content is retained.
Dynamic computed names, generated code, native evaluateJavascript, some destructuring/
optional chains and reflection remain outside the current transformation. Parser source
maps are not regenerated. This is not complete proxy transparency.

Typecheck and 637 tests / 20,476 assertions pass, including 32 Chromium cases. Eighteen
cached public scripts (4.64 MB total) remain syntactically valid after transformation.
Their aggregate transformation took 2.8 seconds under competing load; this is not an
isolated benchmark. TypeScript stays server-side. Broader transport/E2E and performance
acceptance remain pending. Evidence: `/tmp/webdroid-weblocation-{typecheck,units,tests,
public-syntax,preflight}.log`; protected consent captures stay outside the repository.

The fragment follow-up reports trusted renderer hash changes through the existing
bridge and handles same-origin frame events locally. The owner updates its current
URL before scheduling visited-history and page-finished callbacks on the main queue;
generation checks suppress completion if a preceding callback navigates or destroys
the view. It does not emit full-document start/commit callbacks. Ordinary proxy-frame
hashes are mapped onto the upstream URL. The account exchange needs a fresh run.

Twelve focused tests / 18 assertions and typecheck pass before the final ordinary
proxy URL refinement. Real transport fixtures then pass for ordinary and isolated
WebViews with exactly `visited,finished`, correct URL, unchanged loaded state and no
runtime/page diagnostics. The original isolated transport times out. The first fixture
incorrectly used `loaded` to wait for callback completion; it now waits for the observed
initial page-finished callback before starting its fragment action. Native WebView
back-stack integration with renderer same-document entries remains incomplete.
Evidence: `/tmp/webdroid-webfragment-{tests,typecheck,transport,baseline}.log`.

Two callback URL races are covered by a follow-up: mutating the current history entry
must not change an already queued page-start URL, and document completion must report
the current upstream URL if parsing changed history. Both regression tests fail before
the fix. The follow-up passes typecheck, all 642 tests / 20,482 assertions, 37 focused
tests and actual ordinary/isolated WebView transport. Evidence:
`/tmp/webdroid-webfragment-{queued,completion}-before.log` and
`/tmp/webdroid-auth-callback-{tests,typecheck,units,transport}.log`.

At `91d9ff7`, microG/GmsClient/Resy compile with zero method failures; executable
framework probes and all six text comparisons pass. Serialized E2E completes 111
steps without new missing APIs, native requirements, normalized errors, layout/draw
errors or wedges versus `28b9246`. Flappy Bird's minimum 27 FPS and Doodle's 39 FPS
also occur in the stored baseline run; this does not replace quiet CPU/memory checks.
Goldens are unchanged. The initial corpus browser closes during Reddit startup with
no new crash report; a complete current rerun and the baseline both render 13/14 APKs.
Current retains 24 distinct gaps. Targeted paired Reddit/TikTok reruns have identical
normalized diagnostics, including TikTok's variable Keva fetchBoolean gap. Two Reddit
SSL messages seen only in the full current run and the first browser closure remain
unexplained and were not reproduced by the pair. Evidence:
`/tmp/webdroid-auth-location-{e2e-comparison,corpus-comparison}.json`,
`...-corpus{,-rerun}.log`, `...-corpus-recheck-{baseline,current}.json`,
`...-perfsum.log` and `/tmp/webdroid-auth-final-e2e.log`.

The fresh real sign-in with fragment completion is waiting for phone verification;
the Chrome tab is preserved on port 41979. No live callback or token was fabricated
or transplanted into that session. The previous successful credential response and
HttpOnly token-cookie presence establish upstream progress, not a stored account or
successful SDK result. Image encoders were no longer present during the final check;
the earlier quiet-performance backlog is still unverified.

Phone verification subsequently completed. With `91d9ff7`, the actual fragment callback
lets microG exchange the Google token and persist one account with a nonempty refresh
credential. The next AuthResponse parse throws NoSuchMethodError for Field.setLong in
Thread-4; the account survives in `wd:accounts`, but LoginActivity remains finalizing.
DEX inspection identifies AuthResponse.parse and HttpFormClient.parseResponse as
callers. AuthResponse uses typed setters for expiry, booleans and integers. Its source:
[pinned AuthResponse](https://github.com/microg/GmsCore/blob/v0.3.16.252432/play-services-base/core/src/main/java/org/microg/gms/auth/AuthResponse.java).

The reflection fix adds the primitive setter family to its owning registration and
reuses the existing write path, including initialization. Tests cover the complete
primitive widening matrix, long precision, invalid receivers, reference-field rejection,
static receivers and suspended initialization. Long-to-float keeps discarded bits sticky
before JS number conversion to avoid double rounding at halfway boundaries. A Java 17
oracle agrees on all conversion pairs and the three boundary float bit patterns.
The genuine unchanged AuthResponse parser now parses expiry 9007199254740993, integer
37 and boolean values with no missing APIs; the baseline throws missing setLong.
This does not expand reflection's pre-existing access-control implementation.
Evidence: `/tmp/webdroid-authresponse-{parse.dis,probe.log,baseline-probe.log}`,
`/tmp/webdroid-field-callers.log`, `/tmp/webdroid-reflection-field-{tests,typecheck,oracle}.log`.
The full reflection verification passes typecheck and 646 tests / 20,592 assertions.
After reload the account survives and SDK sign-in reaches AuthSignInActivity. Its
missing PackageManager.getApplicationIcon prevents the picker from initializing.
The paired ApplicationPackageManager bytecode delegates the String overload through
getApplicationInfo with MATCH_UNINSTALLED_PACKAGES, then ApplicationInfo.loadIcon.
PackageItemInfo and ComponentInfo now load package resources and use Android's actual
default application icon when necessary. No drawable substitute is fabricated.
A Chromium probe returns the 216x216 default for the iconless client and the installed
microG's 144x144 icon; invalid resources return null and unknown packages throw
NameNotFoundException. No missing APIs are recorded. Evidence:
`/tmp/webdroid-application-icon-{probe.log,typecheck.log}`, and
`/tmp/webdroid-{application-icon,default-icon,package-load-icon}.dis`.
The real picker then exposes CircleImageView.updateShaderMatrix calling Matrix.set
with null; our delegate incorrectly dereferences it.

The one-line Matrix.set fix restores identity for null, matching both public Android
documentation and the paired framework bytecode's reset branch. The regression verifies
copy independence and null reset; it fails before and passes after. Typecheck and all
647 tests / 20,595 assertions pass. Evidence: `/tmp/webdroid-matrix-{before,after,units}.log`
and `/tmp/webdroid-matrix-framework.dis`. The live account picker now renders its account
row and selecting it returns SDK status 8. Its warning gives the exact upstream cause:
UNREGISTERED_ON_API_CONSOLE, asking for matching package/SHA-1 OAuth registration.
No missing APIs appear in the four current process diagnostics. Android previously
returned status 8, but its exact warning still needs a fresh matched comparison.

The fresh Android warning matches UNREGISTERED_ON_API_CONSOLE and the package/SHA-1
explanation. Both original browser APK and expanded Android fixture are signed with
SHA-1 9b898f830346ab06c8ff35882c6d9233104327ff. The test Firebase app had no fingerprints
or OAuth clients. Adding that fingerprint alone still returns status 8. Enabling Google
sign-in in the existing Spark project creates OAuth clients, after which Android shows
`authentication: true`. No APK or runtime workaround is used for registration.
[Firebase's setup requirements](https://firebase.google.com/docs/auth/android/google-signin)
explain the fingerprint and provider configuration. The private google-services.json
predates this registration; it was not overwritten or committed.

Webdroid then reaches the SDK's missing Semaphore.drainPermits completion call. The
delegate returns the previous count and sets it to zero synchronously, including negative
counts, preserving waiting acquisitions. Two tests fail before and pass after (19 assertions);
typecheck and 649 tests / 20,614 assertions pass. Java's
[drainPermits contract](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/Semaphore.html#drainPermits())
supports these semantics. Evidence: `/tmp/webdroid-semaphore-{before,after,units,typecheck}.log`.
On reload, the next live attempt fails an Object[]-to-String cast in the account process;
that remains to diagnose. The earlier broad E2E run was explicitly stopped before this
production edit, so its partial captures do not establish final acceptance. Smoke
compilation of all three affected APKs, framework probes and 6/6 text comparisons passed
at the preceding Matrix checkpoint.

A conditional debugger breakpoint identifies the cast at pc 114 in
SignInConfigurationService.setAuthInfo. Its getString call reads the string set saved
by the previous attempt. microG wraps that getter in runCatching to support old string
and new string-set formats, but our getter returns the array; Kotlin's later String
cast falls outside the intended handler. getString and getStringSet now throw on a
stored value of the wrong type, following the
[Android contract](https://developer.android.com/reference/android/content/SharedPreferences).
A public-API regression covers both wrong-type directions, successful values and absent
defaults (6 assertions). Numeric preference representation remains unchanged.
After reload, the actual SDK client shows `authentication: true`. All four reached
processes have empty missing sets; the observed flow has no console errors or auth
warnings. The debugger breakpoint was removed and the debugger disabled before this run.
No auth callbacks, account data or tokens were injected. Evidence:
`/tmp/webdroid-preferences-{before,after,typecheck,units}.log`.

### Authentication verification at 3902e02

A further full reload and account selection again returns `authentication: true`.
The four reached process missing sets remain empty, with no console errors or auth
warnings. This verifies genuine DEFAULT_SIGN_IN with persisted browser-owned credentials;
other OAuth scopes, server auth codes and ID-token modes have not been established.
The unchanged original GmsClient APK remains the browser fixture. The microG
[helpful information](https://github.com/microg/GmsCore/wiki/Helpful-Information) and
[prerequisites](https://github.com/microg/GmsCore/wiki/Prerequisites) describe account
setup and platform requirements; they do not replace the actual SDK result above.

Typecheck and 650 tests / 20,620 assertions pass. microG, GmsClient and Resy smoke
compile with zero method failures; executable framework probes and 6/6 text comparisons
pass. The final serialized E2E run completes 111 steps in 269.3 seconds, all rendered,
with no added missing/error/native-required diagnostics, layout/draw errors or wedges
versus the stored `28b9246` capture. The earlier FitNotes FragmentManager-destroyed
error is gone. Minimum Doodle FPS is 40 versus 39, Flappy 27 versus 27. Goldens are
unchanged. Evidence: `/tmp/webdroid-auth-complete-{smoke-*,fwtest,textcmp,e2e}.log`
and `...-e2e-comparison.json`.

Corpus renders 13/14 APKs on both builds. TikTok remains the failure; current reaches
25 distinct gaps versus 23 in the matched baseline capture, adding nativeStoreString
and its failed-call diagnostic. No other APK adds diagnostics. Twelve-second targeted
reruns have identical normalized gaps/errors, but neither reaches nativeStoreString.
Thirty-second reruns reach it only on current; baseline instead reaches an additional
fetchBoolean failure. This establishes variable coverage in the already unsupported
Keva path, not baseline reproduction of the new call. Evidence:
`/tmp/webdroid-auth-complete-corpus-comparison.json` and
`...-tiktok{-long,}-{baseline,current}.{json,log}`.

Two serialized Harmonic pairs, with order reversed in the second, show foreground
CPU 7149.31 → 8257.52 ms and 7329.42 → 8474.77 ms (about +15.5%). Wall time grows
25.42 → 43.41 seconds and 24.35 → 43.32 seconds. Both builds render visibly and
advance ticks without errors; no competing image encoders are present. Slow current
runs retain the actual APK's `sh` Choreographer callback through the first ten steps,
settling on pixels instead of idle. A direct full current run takes 24.32 seconds and
7518.95 ms CPU with no early shimmer callback. Narrow runs on pre-cancellation,
cancellation-only, pre-platform-fix and current builds all settle idle. These results
leave performance acceptance open; they do not justify a regression waiver.

DEX inspection shows `sh` invalidates active BoxShimmerLayout instances each frame.
Their onVisibilityAggregated callback stops the animation when hidden. The current
View.setVisibility changes state/layout/draw flags without dispatching visibility
callbacks, unlike the paired AOSP View/ViewGroup implementation. A timing-dependent
attachment/hide sequence is therefore a candidate cause, but the retained instance's
ancestor visibility has not been captured. A two-second delay of the public topstories
request did not reproduce the active callback. No speculative visibility change or
app-specific animation suppression was applied. Next reproduce and inspect an active
instance before implementing general callback propagation. Evidence:
`/tmp/webdroid-auth-complete-harmonic-{baseline,current,reverse-*}.{json,log}`,
`/tmp/webdroid-auth-harmonic-current-full-direct.json`,
`/tmp/webdroid-harmonic-{sh,shimmer}.dis` and
`/tmp/webdroid-{view-setflags,view-visibility-aggregate,group-visibility-aggregate}.dis`.

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


### 2026-09-11 — Dialog dimensions below background padding

The boundary flagged at the window checkpoint reproduces on `613a2c2`: requesting
48x24 or 0x0 leaves a 96x96 dialog root, because the empty measured content is added
back to the background padding. Android preserves the explicit dimensions. The root
now uses the exact requested size (or the available match-parent size); wrap-content
still derives from content plus padding. Child layout uses its measured width/height,
so an undersized root does not create negative child bounds.

At 1080x2424@480, Android and corrected browser both report the 48x24 bottom dialog
at root 516,2328 with content origin screen 564,2376/window 48,48 and zero content
size. The 0x0 root is 540,2352, with content at screen 588,2400/window 48,48, also zero
size. The probe restores 640x360 after these checks. All preceding geometry results
are unchanged, including the known two-pixel wrapped text-height difference. Browser
errors/missing APIs are empty in the reached runtime. The rebuilt SDK compiles 6677
classes with zero method failures; typecheck passes. Evidence:
`/tmp/webdroid-window-small-{android,before,after}.log`, adjacent browser JSON and
`...-{build,smoke,typecheck}.log`. This targeted correction follows the full matrix and
performance checks at `613a2c2`; it does not rerun every earlier benchmark.

The follow-up FitNotes run completes all 39 steps with byte-identical PNGs to the
`613a2c2` capture, no layout/draw failures and no additional normalized diagnostics.
Only the existing exception's bundle hash changes. Evidence:
`/tmp/webdroid-window-small-fitnotes.log` and
`/tmp/webdroid-window-small-fitnotes-before/`. Goldens remain unchanged; the generated
report currently shows only this selected flow, while other full-run captures remain.


### 2026-09-11 — Controlled map animation interruption

A new SDK Twice control starts a 500 ms animation and posts another after 50 ms on
its view's main queue. Separate ADB taps previously missed the interruption window.
This fixture changes only the test APK; genuine Maps/microG/Mapbox bytecode is untouched.
Both platforms now deliver one cancellation and one completion. Android emits camera
idle after completion (idle count 2 at cancel/finish, then 3). Webdroid emits idle before
cancellation (count 3 already at cancel) and emits none after completion. The callback
ordering difference therefore reproduces against the same pinned microG build on the
dedicated Android reference and must not be dismissed as an upstream limitation.

Both platforms deliver a marker click at the resulting, unreset camera position, then
pan, reset the camera, replace the marker and click again. Browser teardown/reopen also
reaches loaded. Its three reached runtimes include NativeMapView's and have empty missing
sets and error lists. This narrows the earlier variable-camera miss after the coordinate
fix; it is not exhaustive hit-test parity. Android's intermediate/final zoom differs
because real execution timing differs; it is not a fixed-camera pixel comparison.

Build and smoke pass (6678 classes, zero method failures). Evidence:
`/tmp/webdroid-map-twice-{android,browser}.log`, browser JSON, stage screenshots and
`...-{build,smoke}.log`. Production remains at `6f47f86`; investigate event dispatch and
main-queue ordering next, without replacing or fabricating SDK callbacks.


### 2026-09-11 — Handler cancellation after enqueueing

The pinned MapLibre 10.2.0 CameraChangeDispatcher suppresses an interrupted animation's
intermediate idle/cancel sequence by checking and removing queued messages before the
next move-start event. The exact APK bytecode matches the published source's
`CameraChangeHandler.scheduleMessage`. Webdroid's `JHandler.cancel` deleted the lookup
entry but left its Set populated. Already-enqueued jobs retain that Set and therefore
still dispatched supposedly removed messages. The stale idle set the dispatcher's
idle flag before the replacement animation finished, suppressing the final idle event.

The correction clears the pending Set before dropping its lookup entry.
It preserves replacement messages and other keys and does not modify map callbacks or
APK/library bytecode. Four tests exercise actual Handler APIs on the main queue:
immediate removal/replacement, timer expiration behind a busy looper, runnable
removal/reposting, and removeCallbacksAndMessages(null). All four fail on `5d7875e`
and pass with the fix (9 assertions). Full units pass 615 tests / 20,448 assertions;
typecheck, framework probes and affected APK smoke compilation also pass.

The genuine controlled map flow now gives cancellation, completion, then idle, matching
Android. Both variable-camera and reset-camera marker clicks work, pan works, and a fresh
activity reaches loaded after reopen. All three reached runtimes, including NativeMapView's,
have empty missing sets and error lists. Broader checks are recorded below.
Evidence: `/tmp/webdroid-map-handler-test-{before,after}.log`,
`/tmp/webdroid-map-handler-after.{log,json}`, stage PNGs, and
`...-{unit,typecheck,fwtest,gms-smoke,resy-smoke}.log`.

Sources: [MapLibre 10.2.0 source archive](https://repo.maven.apache.org/maven2/org/maplibre/gl/android-sdk/10.2.0/android-sdk-10.2.0-sources.jar),
[pinned microG map adapter](https://github.com/microg/GmsCore/blob/v0.3.16.252432/play-services-maps/core/mapbox/src/main/kotlin/org/microg/gms/maps/mapbox/GoogleMap.kt),
and [AOSP MessageQueue removal](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-13.0.0_r12/core/java/android/os/MessageQueue.java).
The local source/disassembly files use `/tmp/webdroid-map-twice-*` and
`/tmp/webdroid-map-handler-MessageQueue.java`. The matched baseline worktree is
`/tmp/webdroid-map-handler-baseline` at `5d7875e`, served on 41983.

The serialized Handler E2E run completes all 111 steps in 257.0 seconds with no added
normalized missing/error/native-required diagnostics, layout/draw failures or wedges.
FitNotes' prior FragmentManager-destroyed exception disappears while its visual score
is unchanged. Content scores are Mihon 57.20%, FitNotes 41.54%, Harmonic 29.76%, onboarding
17.56%, overall 36.52%; goldens remain unchanged. Corpus renders 13/14 with the same 24
gaps and no added per-APK errors; TikTok still fails. Evidence:
`/tmp/webdroid-map-handler-{e2e,comparison}.log`, `...-window-comparison.json`,
`...-corpus.{log,json}` and `...-corpus-comparison.json`.

Mihon's back-out step waits 3038 ms (pixel settling) versus 666 ms (idle) in the preceding
window capture, but its PNG is byte-identical. Lichess retains its known
responsive loading state; Flappy retains the 27 FPS limit, and Doodle minimum FPS is 38.

A fresh matched Mihon pair against `5d7875e` does not reproduce the long settle: back-out
is idle after 670 ms baseline / 700 ms fixed, with 34 draws on both. Whole-flow foreground
CPU is 9123.75 → 8933.13 ms (−2.09%) and elapsed capture time 25.19 → 24.82 seconds.
The single back-out step's CPU rises 359.29 → 400.46 ms, so this pair is not proof of
identical per-step cost or an explanation of every transient wait. It rules out a
persistent three-second wait in this matched run; repeated standard startup/native
comparisons follow. Files: `/tmp/webdroid-map-handler-mihon-{baseline,current}.json`,
adjacent logs and `...-mihon-pair.log`.

Three alternating FitNotes pairs against `5d7875e` give median foreground CPU
1301.95 → 1249.25 ms cold (−4.05%) and 1165.86 → 1231.10 ms after reset (+5.60%).
The latter crosses the investigation threshold; a fresh series records per-step CPU.
Retained heap falls 0.017% / 0.020%; 600 classes, 42 broker calls/100 bytes and 256 MiB
root Wasm memory are unchanged. Every run renders visibly with advancing ticks and no
added diagnostics; only the baseline has the FragmentManager-destroyed error.
First/steady idle CPU changes are −6.84%/+3.18% cold and −3.19%/+8.08% after reset.
Files: `/tmp/webdroid-map-handler-perf-{baseline,current}-{1,2,3}.json` and
`...-perf-summary.jsonl`.

Three alternating Doodle pairs give median CPU 12229.44 → 11857.62 ms (−3.04%),
retained heap 150707128 → 150764372 bytes (+0.038%) and native time −3.41%.
GL frames fall 686 → 664 (−3.21%); this does not isolate a throughput improvement.
All six runs render the animated tutorial visibly, advance 1573–1765 ticks and have
no missing/error/native-required or layout/draw/GL diagnostics. Classes remain 68 and
root Wasm memory 256 MiB. Evidence: `/tmp/webdroid-map-handler-native-perf-*`, summary
JSONL and captured PNGs. This measures the tutorial flow, not full gameplay.

A fresh three-pair FitNotes series adds CDP CPU measurements around each step on both
builds. Median CPU is 1326.50 → 1285.92 ms cold (−3.06%) and 1240.31 → 1238.63 ms after
reset (−0.14%); the earlier reset increase does not repeat. Per-step costs vary with
execution timing: one reset pair has launch −258 ms and the next step +272 ms, while
the whole flow changes +19 ms. This is not an isolated causal profile of that shift.
Retained heap changes −0.016%/+0.038%; pre-GC heap rises about 3.8% in both phases.
First-idle CPU rises 12.23%/14.26%, while later steady-idle falls 1.79%/5.72%; no
uniform idle reduction is established. Classes, broker counts/bytes and root Wasm size
are unchanged. All runs render visibly, advance 3601–3614 ticks and retain the same
diagnostic difference. Per-step instrumentation affects timing, so retain the two
series separately. Files: `/tmp/webdroid-map-handler-repeat-perf-{baseline,current}-{1,2,3}.json`
and `/tmp/webdroid-map-handler-repeat-summary.jsonl`. These initially did not reproduce
the >5% foreground CPU increase. Later inspection found competing encoding work,
started at 15:24:25, overlapping the repeat and native comparison. These series cannot
clear the original increase; quiet matched measurements remain necessary.

### 2026-09-11 — Completed Handler callback retention

After the cancellation fix, a post-GC browser probe finds empty pending-map entries
holding completed Runnable keys. In the SDK map flow, a long-lived Handler grows from
7 such keys after the first close to 11/15/19/23 after successive opens. Across all
queried Handler instances, completed callback keys reach 32 and retained instances
grow 5 → 9 → 13 → 17 → 21, although every pending queue is empty. CDP object groups
are released after each count; the probe retains only numeric summaries.

The follow-up deletes a key when its final message leaves the queue, before dispatch
so reentrant callbacks can repost. Two tests fail on `3c98726` and pass after: a batch
of 1000 completed callbacks leaves no keys, and a callback safely reposts itself.
The same real map flow now retains zero completed callback keys; Handler instances
return to 5 after each close and 9 after reopen. Cancellation/completion/idle ordering,
both marker clicks, pan and five map loads succeed. All three reached runtime missing
sets and error lists remain empty. These counts establish removal of this retention
path, not absence of all map/native memory leaks.

Typecheck, 617 units / 20,451 assertions, framework probes, zero-method-failure smoke
compilation of microG/Resy/SDK and 6/6 text comparisons pass. E2E/corpus/performance
verification is in progress. Evidence: `/tmp/webdroid-map-handler-retention.{log,json}`,
`/tmp/webdroid-handler-retention-after.{log,json}`, `...-test-{before,after}.log` and
`...-{typecheck,unit,fwtest,smoke,textcmp}.log`. The baseline worktree on 41983 is now
`3c98726`; current 41977 includes the follow-up.

E2E completes 111 steps in 331.9 seconds with no added normalized missing/error/native
diagnostics, layout/draw errors or wedges. Scores are Mihon 57.44%, FitNotes 41.44%,
Harmonic 27.12%, onboarding 17.56%, overall 35.89%; goldens are unchanged. Harmonic's
step time grows 24.5 → 62.6 seconds, largely in draw time; minimum Doodle FPS falls
38 → 22 and Flappy 27 → 12. A concurrent encoding job in another project runs many
avifenc processes, observed collectively using several CPU cores. This is a concrete
confounder, not a proven explanation or a regression waiver. Repeat the affected flows
and performance under quiet matched conditions. Evidence:
`/tmp/webdroid-handler-retention-{e2e,comparison}.log`, `...-comparison.json` and
`...-competing-load.txt`. The encoding parent started at 15:24:25 on 2026-09-11,
overlapping the preceding cancellation repeat/native measurements too.

Corpus retains 13/14 rendered and 24 gaps, with two additional captured error messages.
Fresh matched ChatGPT/Reddit runs have identical normalized diagnostics; ChatGPT's
InheritableThreadLocal failure appears on both. Extending Reddit observation by 15
seconds reproduces its Uri-JsonAdapter StartupException on `3c98726`, establishing
that the short corpus window can miss it. Evidence: `...-corpus.{log,json}`,
`...-corpus-comparison.json`, `...-corpus-recheck-{baseline,current}.{log,json}` and
`...-reddit-{baseline,current}.{log,json}` under `/tmp/webdroid-handler-retention-`.

A fresh Harmonic pair under the same competing load takes 59.93 seconds on `3c98726`
and 51.73 seconds fixed; CPU is 7038.91 → 7105.91 ms (+0.95%), draw time 32.38 → 24.40
seconds. Both have the same WindowExtensionsProvider gap and no errors. The large
wall-time slowdown therefore also occurs without the retention fix. This is a
diagnostic comparison under load, not an isolated performance result. Files:
`/tmp/webdroid-handler-retention-harmonic-{baseline,current}.{json,log}`.

## Resy guest browsing at 8835eb4 — 2026-09-12

Resy 1.18.0-687 now browses as a guest end to end: the nearby list with live slots and the
MapLibre map (microG's maps module in the app process, markers and the user's location),
keyword search from the action-bar pill through the keyboard's Search key, a venue page
(photo, rating, description, need-to-know), back, and the location search. Every fix is a
platform answer no device gives; none is Resy-specific.

**A missing `Double.valueOf(String)` and a Bitmap that could not be parcelled.** `MarkerModel`
parses coordinates through `Double.valueOf(String)`, which threw inside a LiveData observer.
`BitmapDescriptorFactory.fromBitmap` writes the marker icon into a binder transaction and
Bitmap claimed Parcelable without `writeToParcel` or a `CREATOR`; the wire form is Bitmap's
own (flags, geometry, RGBA bytes), as on AOSP where only `CREATOR` reads it. `parcelCreator`
moved to its own module so a Parcelable's owner can import it without a module cycle.

**An activity launch waited forever on a pause that could not happen.** microG asked the user
for its own location permission from `AskPermissionActivity` while Resy's main thread sat in
a synchronous fused-location binder call; the broker waited for Resy to pause before showing
the new activity, Resy could not pause until the binder call returned, and the call returned
only after the permission was granted. AOSP bounds the previous activity's pause at
PAUSE_TIMEOUT (500 ms) and its stop at STOP_TIMEOUT (11 s); the broker now does the same. The
permission prompt itself then went away for the right reason: AOSP's
DefaultPermissionGrantPolicy gives the privileged location provider its location permissions
at boot, so provisioned system packages carry `defaultGrants` and `checkSelfPermission` honours
install-time grants.

**Dialogs, touches and layout.** `Dialog.show()` on a showing dialog only re-shows the decor
(a DialogFragment hides in onStop and shows in onStart; the announcement sheet went INVISIBLE
around the permission activity). A ViewGroup's OnTouchListener runs only after its children,
as View.dispatchTouchEvent does when no child took the event — BottomSheetDialog's sheet
installs one that swallows everything and ate its own close button. A RelativeLayout child
whose rules fix both edges measures EXACTLY to the span between them, whatever its
`layout_width`; the search pill measured to nothing.

**Collections and animators.** `Object.clone` copied the JS object, so a cloned ArrayList
shared its backing array; androidx.transition iterates a clone while listeners remove
themselves, and the shared copy shrank under the loop (`Index: 14, Size: 14` at the end of
every transition). Lists, maps and sets now clone with their own store. A ValueAnimator
animates fraction zero when started (AOSP's start() does), and a one-value ObjectAnimator on
a Property reads its start from `Property.get` rather than a named getter with an empty name
— Fade's transition alpha animator threw inside start() from a pre-draw listener, so the
search screen never signalled its animation complete.

**The location chain.** Resy reads `Settings.Secure.LOCATION_MODE` before asking for fixes and
treated the missing setting as location off; the setting now answers from the LocationManager's
state, with `LOCATION_PROVIDERS_ALLOWED`. microG's location settings check derives gps/network
presence from `PackageManager.hasSystemFeature`; the device declares `android.hardware.location`
with its gps and network features (browser geolocation stands behind both providers), and the
check answers SUCCESS instead of SETTINGS_CHANGE_UNAVAILABLE. With that, Resy's own
`FusedLocationProviderClient.requestLocationUpdates` registers with microG and
`ResyLocationManager$1.onLocationResult` receives fixes. The maps module's my-location marker
then reached `Matrix.setRectToRect`/`ScaleToFit`, `Paint.setARGB`,
`RelativeLayout.LayoutParams.alignWithParent`, `ActivityInfo.flags` and `BaseColumns`; the
ScaleToFit resolution failure had aborted a RecyclerView layout mid-pass, after which it refused
adapter updates ("Cannot call this method while RecyclerView is computing a layout").

**The keyboard's Search key.** Resy's search field listens with an OnKeyListener for ENTER,
not an editor-action listener. `TextView.onEditorAction` consults the listener, moves focus for
NEXT/PREVIOUS, closes the keyboard for DONE and otherwise sends an ENTER key down/up to the
view; the served InputConnection's `performEditorAction` was a stub. The e2e harness gained an
`enter` action (imeAction on webdroid, `input keyevent 66` on the emulator) and
`tests/e2e/flows/resy.ts`, a smoke flow (live content, no goldens) that renders 12/12 steps
with nothing missing.

**Also declared:** the Wi-Fi system service (the device's one network is Wi-Fi; the Places
client caches a WifiManager), `Float.valueOf(String)`, SensorManager's per-sensor unregister
and Handler overloads (a device without sensors answers them as the existing entries do).

**What is upstream, with evidence.** The "Unable to configure device for notifications"
alert and the Firebase installations 400s reproduce on a device (above). The Facebook
`GraphResponse` 400 (`App button auto detection is disabled`) is Facebook's answer. The two
`[W/ResyActivity] Error parsing JSON` lines are Branch's session callback: with no deep link,
the referring params carry none of `action_text`/`content`/`heading`/`$canonical_url` that
`lambda$onStart$4` reads with `getString`, and each miss is logged — a device without a
referring link logs the same. The announcement bottom sheet ("Not a Gold Card Member?") is
served by `/2/announcements` and requested again after every venue reload (`updateVenues` →
`loadAnnouncements`); the API returned it repeatedly within a minute for the same uuid, so
the flow closes it twice. The initial list queries `/4/find` at the saved city's default
coordinates (40.764034, −73.9774937 for "ny") rather than the fused fix; Resy uses the fix for
the map marker and `saveLocationLatLng`, and "Near Me" opens the location search rather than
re-querying — both reproduce with the same code path on any device.

**Observed, not changed.** microG's maps module loads into the app process with a
PathClassLoader whose parent is microG's `FilteredClassLoader` over the app's loader, and its
`GoogleApi`/`GoogleApiManager` calls resolve to Resy's bundled play-services copies exactly as
that filter intends; the app-side traces here tag classes by dex to tell the copies apart.

**Focus handoff on a reopened search.** After a keyword search, the shared search model already
held 25 popular cities, but reopening on the location field left them GONE. The second
`Consumable` was distinct and handled, the first search fragment had been removed, and the new
fragment was RESUMED: this was not LiveData replay or live data. `View.requestFocus()` bypassed
the virtual directional overload, so `SearchField` could not redirect focus to its EditText; focus
changes also never called the registered `OnFocusChangeListener`. The Android overload chain and
old/new listener notifications restore location mode.

Gates at 8835eb4: typecheck; 670 tests / 20,693 assertions; Resy smoke-compiles 30,589
classes with 0 method failures; `e2e --test resy` renders 12/12 with nothing missing; fitnotes
41.54% content / 17.47% strict and mihon-onboarding 17.56% / 11.10%, identical to the
starting commit run side by side on the same machine (a first run beside the unit and smoke
gates spread to 41.93/17.56 and 17.56/13.46, which a second run did not reproduce).
### 2026-09-12 — Reddit logged-out launch

Reddit (2026.36.0, `Reddit.xapk`) threw a `bindService(Intent, int, Executor,
ServiceConnection)` NoSuchMethodError and a Moshi StartupException ("Platform class
android.net.Uri requires explicit JsonAdapter") at boot, then stayed white. Mechanisms, each
verified by re-booting and observing for at least 45 s:

- `bindService` lacked the API 29 Executor overload (`f8eaaf5`); callbacks now go through
  the given Executor instead of the main queue.
- `HashSet` had no `equals`/`hashCode`, so `Collections.emptySet()` never equalled Kotlin's
  `EmptySet` and Moshi's adapter-method matcher rejected every registered `@ToJson` adapter
  whose qualifier set was empty (`0c643e1`).
- `KeyFactory.getInstance(String, Provider)` and the whole `java.security.Signature` class
  were missing (`239d202`, `6ed8c23`). Tink's `RsaSsaPkcs1VerifyJce` inside reCAPTCHA's
  coroutine hit the NoClassDefFoundError, which `runCatching` swallowed, so no error surfaced.
- The white screen was Reddit's keep-on-screen splash predicate never clearing: the launch
  delegate's lifecycle callback was never registered because `e()` threw before it —
  `addAccountExplicitly` for the guest account refused with SecurityException, because the
  authenticator's `accountType` resolved to a resource id string. A first-parent bisection
  (export of each commit into the scratchpad, 40 s observation for the intro text) found
  `e3c4ded` first bad; the fix takes the literal only when the attribute is a string
  (`cabddab`).
- The API 16 `startIntentSenderForResult` overload was missing (`98c1df6`). Credential
  Manager's HiddenActivity starts microG's One Tap PendingIntent with it; the start now takes
  the operation from the store that owns the sender (consuming a one-shot there), fills in
  the intent and launches an activity sender as its creator with a result target.
- `setCanceledOnTouchOutside(false)` made dialogs uncancelable, so Back could not dismiss
  microG's bottom sheet (`8b4c6a3`). Process realms now expose a `wd` handle (`2c1b8e3`).

Result: the welcome screen ("The most real place on the internet", Get Started, I already
have an account) renders after Back dismisses microG's "Add Google account" sheet; the
sign-up and login sheets open and close. Guest content is unreachable by app design: the
launch delegate shows the intro whenever the session is logged out (`f()` reads only
`Session.isLoggedOut` and the `android_launch_session_snapshot_ks` kill switch), the
welcome screen never references the `Skip` string (`action_skip` is used only by
notification re-enablement), a second launch repeats the intro, and a
`RedditDeepLinkActivity` VIEW intent for `/r/pics/` also lands on the intro plus the
credential sheet. Feed, post, comments, search and media were therefore not exercised
without an account; `tests/e2e/flows/reddit.ts` covers the reachable logged-out screens.
Remaining optional gaps: `media_metrics`, MIUI referrer, AppSet and AppsFlyer LVL/OAID
classes, and Cronet's DnsConfig warning. microG keeps two activities resumed in its realm
(`IdentityCredentialChooserActivity` under `AssistedSignInActivity`), unverified against
Android.

### 2026-09-12 — TikTok guest feed lifecycle

TikTok 46.8.3 (`TikTok.apk`) reaches a live guest For You feed. A clean 120-second feed
observation held native allocations between 68 and 80 MB after startup (214.66 MB peak with
more than 3.8 GB free) and reported no native fault, so earlier `std::bad_alloc`, JNI
`GetStringChars` address-zero and Cronet `memcpy` failures are not reproducible allocator
exhaustion. The native renderer did repeatedly feature-probe
`eglPresentationTimeANDROID`; EGL now advertises the extension, resolves its proc address and
keeps the requested timestamp on the destination surface. `SensorManager.getRotationMatrix`
uses Android's normalized east/north/up construction for both 3x3 and 4x4 matrices.

The TikTok smoke flow models the clean-device gates as optional semantic taps: Android's
full-screen notice, guest sign-up, age confirmation, consent, notification denial and interest
selection. It then backgrounds the foreground task through pause/stop and start/resume before
two swipes. The first extended serial run rendered all 13 captures with advancing video after
resume and both swipes, without a wedge, draw failure or native fault. Reached framework probes
now report the real available state: overlay permission is not granted, WebSettings supplies
its default user agent, Class annotations include inherited runtime annotations and
`Runtime.exec(String)` tokenizes before returning IOException because webdroid has no host
process table.

Absent TikTok/Lynx/AppsFlyer/MIUI/EffectSDK classes and native methods remain optional vendor
feature probes rather than fabricated implementations. Camera, MediaDrm, measurement and
backup classes describe hardware or system capabilities this browser device does not provide.
The interest screen once logged a dynamic-layout expression referencing absent sibling ids;
the feed continued and all later video captures rendered, so this is recorded as live-content
fallback evidence rather than suppressed as a platform error.

A later matched two-swipe replay reproduced the intermittent allocator failure: repeated
private read/write mappings below 32 MB interleaved with native allocations advanced plane 0's
monotonic heap from an 808 MB peak with 3.21 GB free to 2.56 GB with 1.46 GB free, followed by
`std::bad_alloc`. A64 anonymous reservations and mappings of at least the existing 1 MB native
stack unit now use virtual-address planes; smaller mappings retain the plane-0 fast path. Under
the same flow, resume was 355 MB peak with 3.67 GB free, the first swipe was 377 MB with 3.64 GB
free, and the second-swipe dwell finished at 396 MB with 3.62 GB free. All 13 steps completed
without a native fault or main-loop wedge; the second swipe and final dwell ran at 31 and 87 fps.

### 2026-09-13 — TikTok, Resy and YouTube parity integration

The exact bundled TikTok 46.8.3, Resy 1.18.0-687 and YouTube 21.36.45 packages now complete
their guest flows unchanged in webdroid and on the dedicated Android reference. The final
webdroid captures cover 13 TikTok steps, 13 Resy steps and 16 YouTube steps. TikTok resumes its
For You feed and renders different advancing video after two swipes; Resy searches for Carbone,
opens the venue, returns and opens Near Me; YouTube searches for Big Buck Bunny, exercises the
player controls, pause/resume, fullscreen/back and renders different Shorts after a swipe.

Resy's MapLibre wedge was an EGL ownership mismatch, not a pthread condition-variable failure.
The app creates and binds its context through Java EGL10, then renders through native GLES. Java
stored the current binding globally while native GLES looked it up by CPU object, found no owner,
cleared the context and faulted during Mapbox's `call_once`; the next render waited on the poisoned
once flag while Activity pause synchronously joined the GL thread. Java EGL10/EGL14 and native
EGL/GLES now use the Android guest `JThread` as the canonical owner, share surface state and keep
validated per-thread wrapper caches. A Java-EGL-to-native-GLES regression test covers the exact
boundary. The 13-step replay completed in 140.3 seconds without a wedge, new error or reached
missing API.

TikTok's native renderer reached A64 `SQRSHL`; the core now implements the SQSHL/UQSHL/SQRSHL/
UQRSHL lane semantics and agrees with the hardware oracle. Its repeated anonymous native mappings
also use virtual-address planes, preventing the monotonic low-plane growth that previously ended
in `std::bad_alloc`. The surrounding platform work supplies path-valued property animation,
font feature/variation state, split-limit-compatible regex behavior and correct in-layout measure
cache invalidation. These are Android/JDK contracts exercised by the package rather than package
checks or substituted content.

YouTube's late SurfaceView frames were omitted when the parent display list had already been
recorded; recorded surface nodes now retain and invalidate against their first arriving frame.
Opening search additionally reached `AudioRecord`. Webdroid reports supported PCM buffer sizes
and a truthful uninitialized/stopped recorder because this browser device exposes no audio-input
device; it does not fabricate captured audio. The 16-step targeted run rendered every state with
clean reached telemetry. A manually reused full-Chrome tab can intermittently show a black canvas
even while its Android view tree and frame ticks advance; repeatable headless Chrome captures and
the AVD reference render the same tested states, so the evidence does not justify an app-specific
canvas workaround.

All three smoke compilations finished with zero method failures. Consolidated typecheck and the
focused EGL, AudioRecord, A64, graphics, animation, regex, surface and measure regressions pass.
Paired screenshots remain under `tests/e2e/actual/paired/`; the exact-app golden directories used
only for capture are not committed.

The one requested serialized full E2E run completed with exit code 0 in 806.8 seconds. Every flow
rendered every step. The requested smoke-scored flows completed TikTok 13/13, Resy 13/13 and
YouTube 16/16; their per-step records contain no main-loop wedge or settle timeout. The run also
reproduced previously documented diagnostics outside this task, including Lichess native-thread
errors and Harmonic's unchanged final shimmer frame, without turning them into app-parity work.
### 2026-09-13 — Twitch TV startup and guest playback

The supplied `Twitch.xapk` is Android TV 13.0.0.2 (1100000018), with 2,360 DEX
classes and ARM32 Sentry libraries. In the `codex/twitch-parity` worktree based on
`f3fefda`, startup failed before the app's WebView was created. The later Kotlin
`thermalNotificationHandler` error was a consequence of incomplete `onCreate`.

- RemoteCallbackList was absent. Its implementation keys callbacks by Binder,
  links death recipients, unlinks replacements, and snapshots broadcasts. The
  same tests pass against the paired AOSP class, including concurrent registration
  on separate Java threads. Rechecking after the suspending death link prevents
  duplicate watches and resurrection after kill/death.
- MediaSession and PlaybackState.Builder were the next startup gaps. Sessions
  preserve token/controller identity and dispatch commands through the callback's
  looper; replacement/release suppress pending callbacks. Playback builders create
  independent snapshots and preserve long values. This does not implement the
  whole media-session service or claim token/PlaybackState parcel transport.
- WorkManager's ObjectInputStream read truncated short block data by one byte:
  JavaScript evaluated the starting cursor before awaiting the length byte. Reading
  the length first fixes the block boundary, including primitives spanning blocks.
- Thread.getState now distinguishes lifecycle, monitor contention and timed or
  untimed parking. Restarting a terminated thread throws IllegalThreadStateException.
- PackageInfo.requestedPermissionsFlags now aligns each permission with the
  canonical PackageManager grant state, and archive queries report ungranted flags.
- Android Back did nothing inside the page: the APK's onBackPressed sends an
  Escape KeyEvent to WebView, whose inherited key handler returned false. WebView
  now forwards navigation key down/up events, retaining Java listener/client
  interception. Renderer dispatch must not block the main queue: page handlers
  can synchronously call Java through the bridge. Unhandled results return to the
  WebViewClient asynchronously.
- The isolated renderer boot document defaulted to Windows-1252 before replacing
  its document. An inserted UTF-8 meta element could not repair the already chosen
  encoding, so external script literals such as a category's bullet were garbled.
  The boot document now declares UTF-8 before its script, and rewritten script
  responses advertise UTF-8. A fresh browser reports UTF-8 and renders the bullet
  correctly; previously decoded scripts can remain cached in an existing browser.

Full Chrome reaches home, search, live video/chat, quality selection, chat hiding
and QR activation with unchanged app/library bytecode. One observed live stream
advanced at 1280×720 with no reported dropped video frames; this is functional
evidence, not a controlled performance comparison. Main-realm Java missing/error
lists were empty, as were missing lists in both background realms. The WebView
console still reports an upstream service-worker origin restriction, so empty
Java telemetry does not mean every browser operation succeeds. The page's Pause
button has an empty mouse handler in shipped Twitch JavaScript; TV key behavior
needs Android comparison before attributing it to the platform.

Typecheck, 713 unit tests (20,909 assertions), and Twitch smoke compilation
(zero method failures) pass. Reference screenshot parity remains pending. The
isolated API 35 AVD boots but cannot install the ARM32 split. The official API 25
ARM32 image reaches Android home with host GL, but QEMU CPU threads hang during
installation, also with a confirmed single CPU. An old crash-consent dialog had
blocked renderer retries; separate crash-report storage let boot proceed without
uploading those reports. No visual goldens or APK contents were changed.
Account-only flows require completing QR activation.


Final regression check: serialized full E2E completed 134/134 steps across 11
flows in 694.6 s; the identical suite against `f3fefda` on a separate port took
689.3 s. Neither run reported queue wedges, capture failures, native-required
entries or layout/draw errors. Every flow's missing-API set matched baseline.
This does not establish full app functionality: TikTok remains on its splash in
both builds (all five captures are pixel-identical below the status bar), with
19 missing APIs and 114 versus 110 error-level logs. The extra distinct messages
are parent/child lifecycle diagnostics. Lichess reproduces the same native
pthread error types (35, 22, 3), with 57 versus 54 error logs. Flappy Bird remains
slow at 28 versus 29 minimum FPS. These are unresolved baseline limitations.

FitNotes and Mihon onboarding scores match baseline (41.54 and 17.56 content
diff). Mihon app scores 57.82 versus 57.10: launch pixels differ only in the
empty-state emoticon rectangle; the final Library capture also has 105 changed
pixels in its selected navigation icon. Harmonic scores 30.00 versus 29.46;
inspection shows updated vote/comment counts, a replaced story and shifted
scroll position. Goldens remain unchanged. Single-run timing and live-content
variation do not establish a performance improvement: aggregate duration is
similar, while individual draw/boot counters vary. Per-step telemetry, both full
reports, screenshots and performance rollups are retained under the ignored
`twitch-investigation` artifact directory and the separate baseline worktree.

A serialized Mihon-only repeat scored 58.09 (candidate) and 57.78 (baseline).
The selected-icon region also changes within each unchanged build (76 and 35
pixels respectively), reproducing that small capture variation without any code
change. Both repeats complete 17 steps with no missing APIs or errors. Original
full-suite outputs were restored after saving repeat artifacts separately.

Final full-Chrome captures use `127.0.0.1:4106` as the shell origin, giving the
isolated renderer a fresh cache namespace. The category heading renders its
Unicode bullet correctly and Android Back returns to Home. The original Chrome
origin retained previously decoded scripts despite a parent-page hard reload.

## Twitch mobile 31.0.0 startup — 2026-09-13

The replacement ARM64 bundle (3100006, three unchanged splits) installs on the
isolated API 35 AVD, emulator-5586. The 58,282 classes smoke-compile with zero
method failures. Android reaches welcome and web login. LoginActivity sets
FLAG_SECURE, so adb screenshots are black; visible emulator-window captures
provide the reference without changing app bytes or window flags.

Mobile startup exposed missing CompletableFuture supplier/dependent operations,
queue drainTo, emptyIterator, identifier classification, AtomicLongArray.lazySet,
JSONStringer, unsigned long formatting, display/window contexts and process ABI
fields. Undefined Build.CPU_ABI caused a downstream StringUtils null-check failure.
Native-created iterators also lacked registered interface defaults: linking now
copies those defaults, preserving concrete overrides. Focused tests cover these
paths. Window contexts retain their associated display and own window manager;
full display-area/token behavior remains outside the observed implementation.

Subsequent startup needed WebSettings.getDefaultUserAgent, camera callback base
classes, finite-number checks, File natural ordering, and TimeUnit enum values.
Camera callbacks implement AOSP's empty defaults only; abstract app callbacks
remain app-owned and camera capture is not claimed. A dalvikvm reference probe
confirms java.beans.Transient and ConstructorProperties are absent on Android,
while BaseStream and CaptureCallback exist. Optional MIUI referrer lookup can
also appear; these probes do not establish missing Android platform behavior.

Twitch login exposed two shared WebView bugs. Frame dimensions followed the
browser's displayed phone size (475 CSS pixels here) instead of Android density
(360 CSS pixels). Frames now lay out in density-independent pixels and scale
through one ResizeObserver on their containing layer, avoiding per-frame layout
reads. A Twitch-only browser check confirms 360x592 CSS layout before and after
resizing the host viewport. Second, evaluateJavascript could send before the
isolated renderer had an origin, throwing an invalid-target-origin browser
exception. Evaluations now wait for renderer readiness and are cancelled with
other outstanding evaluations when navigation destroys that renderer. Repeating
startup/login removes that exception and leaves the main queue responsive.

Full Chrome renders welcome, login, and signup (email and phone forms). Matching
light appearance uses a temporary Chrome media emulation because macOS is dark and
the AVD is light. Login sizing matches Android's logical geometry. A browser keyboard-map permission-policy error appears intermittently, including
in the final dark-mode headless check. It is separate from Java diagnostics and
does not prevent the tested native-portal login/Back interactions.
Signed-in functionality awaits user authentication. The previous TV full-suite
result does not validate these mobile changes. Artifacts are under
`tests/e2e/actual/twitch-investigation/mobile-31/`.


Welcome layout exposed missing ViewGroup.onViewAdded/onViewRemoved dispatch.
ConstraintLayout's unchanged Barrier implementation had zero referenced widgets;
dispatching virtual hierarchy callbacks before listeners gives it both buttons and
the correct top direction. Mutations propagate suspended overrides, including
in-layout and range removal, while default native hierarchy callbacks stay synchronous.
SpannableStringBuilder now preserves appended span identities and offsets, and
TextView/StaticLayout draw CharacterStyle runs through virtual updateDrawState.
ForegroundColorSpan's color reaches Paint. A real browser bitmap probe verifies
white highlighted glyphs and blue unstyled glyphs in both drawing paths. Full
metric-affecting span measurement remains incomplete.

The bundled Roobert font measured at 68 px on Android reports top=-79, ascent=-67,
descent=14, bottom=18. An isolated instrumentation APK measured the unchanged font;
its hhea ascender/descender are 966/-204, head yMax/yMin 1129/-251, unitsPerEm 975.
The parser incorrectly used OS/2 win values for padded bounds, and browser-rounded
ascenders compounded the error. Glyph bounds now supply padding; registered faces
retain fractional metrics until Android integer rounding. Welcome rows now measure
97 px and the final three-line block 259 px, matching AVD bounds exactly. Drawable
XML dimensions now resolve resource/theme references before decoding; the APK's
6 dp corner radius produces the reference's rounded buttons.

A rendered login form was insufficient evidence: its Back button rejected with
"Portals plugin is not implemented". The APK's l350 WebViewClient override serves
bundled authentication HTML through shouldInterceptRequest, but the platform never
called it. Isolated WebView requests now invoke the app's callback, preserving
method, headers and main-frame identity; returned InputStreams and response metadata
reach the existing document/script loader. Redirect callbacks follow Android's
initial-request-only rule. Default clients avoid this callback transport. Intercepted
bodies are currently buffered, not streamed. URLConnection.guessContentTypeFromName
uses the shared MIME table and Android's filename/fragment/directory rules. Script
evaluation now waits for the document's message listener, not just the outer
renderer loader. The Twitch-only test verifies username entry/clearing, in-app Back,
360x592 CSS dimensions through resizing, progressing frames and no observed
uncaught/layout/draw failures or native-required entries. Raw error-level Java logs
include SLF4J's three no-provider warnings, also observed in AVD logcat; the focused
exception filter alone does not prove an empty raw log. Optional java.beans and
MIUI probes remain. Full Chrome
also exposes diagnostics in all four background Android process frames; each reports
empty missing-API and native-required sets.

The first final mobile E2E completed 134 steps in 11 flows and exposed a span
regression: the new drawing path reached unimplemented StyleSpan and RelativeSizeSpan
paint updates in FitNotes and TikTok. Their draw/measure callbacks now follow Android
style composition, weight adjustment and relative sizing; three focused tests pass
with ten assertions. Twitch also probes ScaleGestureDetector.OnScaleGestureListener,
now linked as an interface; this does not claim a scale detector implementation.
All 735 earlier unit tests pass (21,015 assertions), and typecheck passes after the
span fixes. The repeated final serialized E2E completes all 134 steps across 11 flows in
674.6 seconds. Missing-API sets match the starting commit, with no native-required
entries, queue wedges, capture failures, or layout/draw errors. TikTok and Lichess
retain their baseline limitations. Resy emits one unmatched Okio watchdog failure;
a full baseline repeat, a baseline startup repeat, and a candidate startup repeat
do not reproduce it. The isolated failure remains unresolved, not waived as a
baseline issue. Its log and all repeat captures are retained.
Flappy Bird's low FPS reproduces in a sequential repeat: baseline minimum 24 FPS,
candidate 25 FPS, with nearly identical 18.96-second action totals. Original full
captures are restored after retaining repeat artifacts separately.

Final content-difference scores are FitNotes 41.12%, Mihon app 57.58%, Mihon
onboarding 17.69%, and Harmonic 30.15% (baseline 41.54%, 57.10%, 17.56%, 29.46%).
Mihon includes changing empty-state emoticons, and Harmonic uses live content;
font-metric changes also affect text pixels. These scores do not prove pixel
identity or complete compatibility. Goldens remain unchanged.

Instrumented Chrome sessions reported 25,768 and 48,166 ms boot, compared with
roughly 1.6 seconds in the focused headless run. A Chrome tab opened through the
desktop UI reached welcome with 7,958 ms reported boot. Browser Use reported
paused document loading during the slow reload. A short trace showed a visible,
focused document with stalled ticks and a growing main queue; an earlier profile
was mostly idle. Automation overhead is a candidate cause, not a controlled
explanation or a code-level performance fix. Final ticks advance and queues drain.

The ordinary Chrome launch also logged a caught `length()I is not a function`
lookup. Login and Back work; tracing repeated navigation and a fresh dark-mode
headless startup did not reproduce it. This remains an open compatibility finding.
The final Chrome session uses the system dark appearance; matching light reference
captures are retained from earlier verification. Temporary tracing was removed and
the duplicate instrumented tabs were closed. Signed-in feed, search and playback
remain unverified pending user authentication in Chrome and emulator-5586.

A subsequent lookup investigation added temporary cold-runner tracing of method,
DEX offset and receiver types. Fresh dark-mode startup, the persistent Chrome
profile on port 4107, and a fresh browser seeded with the Twitch-only preferences
from the affected port-4109 session did not reproduce the length lookup. The
restored preferences also skip the optional MIUI probe, so that difference alone
does not identify the failure. Temporary instrumentation was removed; diagnostic
logs remain local under mobile-31. Authentication is still pending.

### 2026-09-13 — Amazon Shopping launch and home

Amazon Shopping 32.17.0.100 (`Amazon.xapk`) initially faulted in MMKV's libc++
`unordered_map`. Compact Thumb arithmetic inside an IT block updated condition flags even
though only the instruction's non-IT form may do so; the changed flags selected a wrong
conditional path. JIT tail chaining also bypassed the dispatcher's active-IT guard. Preserving
IT state across compiled regions and suppressing those flag writes makes the ARM interpreter
and JIT agree and removes the native fault (`3618ec4`). Thumb table branches, shifted-register
operations and the ARM SIMD operations reached by the same production libraries were filled
from decoded instruction behavior rather than library-specific hooks.

The app now launches its unchanged bytecode, shows sign-in, skips to the live Amazon home and
loads the proxied web content. Supporting framework work includes launcher-intent semantics,
modern collection/future/NIO APIs, ICU locale/currency bridges, validated-network capability,
and unavailable-GNSS clock behavior. The TLS relay verifies the upstream peer; its synthetic
peer certificate is accepted only by the default trust manager and is explicitly marked as a
relay peer. The default HTTPS hostname verifier still checks the requested host, and app pinning
continues to fail closed rather than receiving fabricated key material.

On an API 35 AVD, Amazon's live Weblab service assigns the transparent-navigation treatment and
the home uses bottom tabs. The Java-client FileStore/Redstone routes exhaust under webdroid
because Amazon pins those endpoints and the relay cannot present the real peer certificate to
guest Java. Consequently webdroid receives Amazon's fallback home experiment while the live
shopping WebView remains functional. Hardcoding the treatment or forging a pin success was not
accepted as a visual fix. Vendor-only `amazon.os` and Amazon system-service probes remain
unsupported optional capabilities.

JDK immutable maps reject mutation through their maps, entries, views and iterators;
`Collections` protected and synchronized wrappers remain live while enforcing their mutation
and monitor rules. Stream collection invokes the public `Collector` protocol for framework and
foreign collectors, including `CharSequence` conversion. Wi-Fi locks track reference counts and
under-locking, and executor draining periodically yields to the event loop instead of sustaining
an unbounded microtask chain.

The Thumb-16 and Thumb-32 decoder paths are separate. Re-running Amazon exposed `UMULL` in MMKV,
so the long multiply family executes in the interpreter and unknown wide instructions fall back
atomically from compiled regions. Removing late lifecycle delivery left Amazon on a blank
activity because its background startup task registered `LifecycleListeners` after the
cooperative main-queue transition. The bounded, deduplicated catch-up remains in the lifecycle
policy; normal dispatch takes a fresh callback snapshot at each pre/plain/post stage, matching
Android's separate dispatch passes.
