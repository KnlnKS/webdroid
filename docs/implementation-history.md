# Engineering constraints and investigation results

Retained findings through 2026-09-14, organized by engineering problem.
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
## Google Maps: packed native relocations (2026-09-13)

The unchanged Google Maps 26.37.05.977222275 APK initially fails at
Process.isApplicationUid on f3fefda. After passing that call, NativeLibLoader throws
`libgmm-jni.so: DT_ANDROID_RELA relocations are not decoded`. APS2 decoding reveals
another loader gap: the libraries use Android's older RELR tags (0x6fffe000/1/3),
which were silently ignored, leaving constructor entries unrelocated and jumping
to 0x131c4. Decode both APS2 and the standard/Android RELR tables through the owning
ELF loader. Relocate before collecting init-array entries. No APK edits or JNI
substitutes are involved.

Reference: Android 13 bionic [packed relocation iterator](https://github.com/aosp-mirror/platform_bionic/blob/android13-release/linker/linker_reloc_iterators.h).
Focused tests cover grouped/individual offsets, info and addends, negative deltas,
malformed streams, and ELF32/ELF64 RELR bitmaps including their highest bit and
constructor collection. Chrome progresses past the earlier native fault; full Maps
operation is not yet established. Smoke compilation reports 72,887 classes with
zero method failures. Android reference uses a dedicated API 35 Play Store image;
the older Google APIs reference contains a differently signed system Maps build
and rejects the Google-signed update. The unchanged APK installs on the Play Store
image and renders real tiles and search results.

### Executor task factories

Maps' Guava `byvz` subclasses AbstractExecutorService, overrides both newTaskFor
methods to return its own ListenableFuture, and casts the result of super.submit
back to that interface. Native submit instead manufactured webdroid/Future and
bypassed both newTaskFor and execute, producing a ClassCastException. Submit now
uses both virtual entry points, including when callbacks suspend, and supplies the
Runnable/result overload. Default FutureTask now runs once and supports cancellation
so this path retains cancellation behavior. The one-argument Executors.callable
uses the existing adapter and rejects null. Focused tests cover overridden factories,
execute, overload results, repeated run, cancellation, and existing executor queues.

Maps then stalled waiting for its native-loading ListenableFuture despite successful
JNI initialization. Its Guava FutureTask subclass releases listeners from `done()`;
the native FutureTask never invoked that virtual callback. Dispatch it once after
publishing success, failure or cancellation, allowing callbacks to suspend. A test
checks completion is visible inside the callback and repeated run cannot notify twice.

### Matrix inversion

Maps reaches `Matrix.invertM([FI[FI)Z` while constructing its map camera. The delegate
was registered with a void return and computed only four cofactors, replacing a
singular matrix with identity. Correct the signature and compute the complete inverse
without temporary arrays. Singular input returns false without modifying output.
A perspective-transform test multiplies the result back to identity and exercises
overlapping input/output offsets and singular input.

### Maps reference queues and main-loop progress

Maps' weak-reference cleanup thread reached ReferenceQueue.remove; the earlier delegate had
no blocking queue semantics. References now distinguish active/enqueued/dequeued state,
explicit enqueue clears the referent, and queue removal parks with interruption/timeout
handling. Weak and phantom references register for host collection without retaining the
Java referent. Java strings use the runtime's primitive representation and remain readable.
`tests/reference-queue.test.ts`: 2 passing tests, 12 assertions. Host GC timing is not asserted.

MessageQueue now belongs to its Looper and tracks due messages through dispatch and
cancellation. IdleHandler callbacks honor retention/removal, rather than firing once after
an arbitrary 50 ms delay. The focused Handler tests cover cancellation behind a busy looper,
reposting, cleanup, due versus future messages, and repeated idle transitions. A slow Maps
native startup was initially suspected to be a queue stall; it subsequently completed with
no initializing classes or native fault. That observation is not a performance measurement.

### Maps UI and provider dispatch

The reference AVD (`webdroid_maps_ref`, emulator-5588) runs the unchanged Google-signed
Maps APK. Home, Golden Gate Bridge place details, and a Ferry Building-to-bridge driving
route render real tiles and results; screenshots are under `webdroid-shots/maps/` (ignored).
Chrome at 4126 has reached the search bar but not map parity. Its first search tap exposed
IntentFilter.addDataPath, after earlier checked-state binding failures.

A remote provider call decoded arguments after establishing Binder calling identity. The
suspending decode let dispatch inherit a different Java thread, making microG's concurrent
GmsService initialization appear reentrant and exposing null enum values. Decode before
entering the identity scope; provider invocation now starts in that scope's synchronous
prefix. Subsequent Maps reloads did not reproduce that exception. This is observed-path
coverage, not proof for every cross-process initialization schedule.

EGL10 constructed a JEGLConfig while registering the Java EGLConfig name to an unrelated
constructor. Register the actual class. CompoundButton omitted Checkable, so Maps' general
property binder rejected CHECKED on AppCompatRadioButton. Focused class-identity and tint
checks pass. Canvas.drawPicture previously discarded recordings; replay its display list
inside saved state and apply destination translation/scaling, following AOSP Canvas.java.

### Maps XML, parcels and telemetry

SAX uses the existing XML pull parser's DOM parse and emits namespace, element and text
callbacks through suspendable Java dispatch. The Android 35 probe reports factory namespace
awareness false but an unconfigured reader true; explicit configuration overrides that.
A Chrome probe parsed an SVG namespace, path attribute and `A&amp;B` text through asynchronous
callbacks. InputSource stream/reader inputs work; system-id-only fetch is not implemented.

ClipData uses Android 15's field order, including nested Intent/IntentSender/Uri slots;
Intent no longer rejects all non-null ClipData on read. Plain TextUtils CharSequence parcels
and PersistableBundle parcel entry points use canonical owners. Spanned-text parcel payloads
remain explicitly unsupported. A nested-intent round trip consumes the entire Parcel.
StatsEvent encodes real little-endian typed fields, annotations and error masks. StatsLog
has no statsd socket and drops fire-and-forget telemetry, as Android's service-absent path
allows; it does not report a fabricated upload. Cronet previously threw constructing StatsEvent.

References: Android 15 [ClipData](https://android.googlesource.com/platform/frameworks/base/+/android-15.0.0_r1/core/java/android/content/ClipData.java),
[TextUtils](https://android.googlesource.com/platform/frameworks/base/+/android-15.0.0_r1/core/java/android/text/TextUtils.java),
and API 35 [StatsEvent](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/refs/heads/androidx-metrics-release/android-35/android/util/StatsEvent.java).


### Maps networking and file transfer

microG's unchanged FontsProvider opens a read-only system font. Provider IPC previously
omitted openFile; read-only file snapshots now cross the boundary and lazily obtain a
native descriptor, allowing JNI file reads and mappings. ParcelFileDescriptor loads lazy
file sources, duplicates native descriptors, and closes descriptors owned by AutoClose
streams. This does not implement shared writable descriptors or pipes across processes.
Focused descriptor tests cover shared duplicate offsets, independent close lifetime and
lazy bytes. Chrome no longer reports the font-provider openFile failure.

ObjectInputStream computed the end of TC_BLOCKDATA using the position before reading the
one-byte length. That shortened every small block by one byte and made its final payload
byte look like a serialization tag. A two-block regression test now consumes both values.

Maps' bundled gRPC platform selection reached missing SSLContext provider operations.
The relay now accepts ALPN offers and returns Bun's actual negotiated protocol. Java
SSLParameters and SSLSocket retain copied offers and report no selection before handshake.
Both a WebSocket relay probe and a Java SSLSocket probe negotiated h2 with www.google.com.
This verifies the transport handshake, not Maps request success. SSLEngine's pre-handshake
ALPN query is supported; engine wrap/unwrap are not implemented. Existing relay certificate
representation and other TLS configuration limits remain.

The gRPC resolver constructs a scheme-less URI such as //host:443. Delegating this to
JavaScript URL rejected valid hosts and discarded explicit default ports. Java URI now
parses components directly. CharBuffer.wrap(CharSequence) preserves a live read-only view;
one-shot CharsetEncoder encoding consumes UTF-16 input and reports malformed/unmappable
input according to the selected action. Existing incremental coder limitations remain.
Missing Collections.shuffle(List, Random) and InetSocketAddress.getHostString were the next
address-selection failures. Focused tests pass; Maps still shows no tiles or search results.

IntentFilter moved into its canonical matching module. Its Android 15 parcel layout includes
static/dynamic MIME types, scheme-specific patterns, authority/path patterns and metadata.
PatternMatcher retains its parsed pattern payload. URI-relative groups and advanced-glob
matching remain explicit unsupported cases. Wearable AddListenerRequest previously failed
writing its IntentFilter array. A parcel round trip preserves matching and consumes all data.


### Maps stream, property and reflection failures

The GL-Map thread stopped at ShortBuffer.put(short[], offset, length). Range writes now
validate bounds and remaining capacity, copying aligned native-order arrays in bulk and
using DataView for other byte orders. Signed-value and bounds checks pass. Missing
SequenceInputStream and Channels blocked stream composition; the adapters preserve stream
close ownership, ByteBuffer ranges, and native-memory view refresh across suspension.
Sequence exhaustion/close and channel round-trip tests pass.

The scale bar's ObjectAnimator used inherited View.ALPHA, which was absent. Its null
property reached an empty setter name and a JavaScript toUpperCase exception. The property
now dispatches through virtual getAlpha/setAlpha; a one-value animator starts at the
view's current value. ViewGroup.getClipChildren returns its existing clipping state.
Locale.Category supports independent display/format defaults. Locale-dependent formatter
default propagation elsewhere remains incomplete.

Guava's Finalizer reflected finalizeReferent on an abstract interface in Maps' DEX.
Reflection had dropped every declaration without a JavaScript function. Method metadata
now survives without a body; a probe on the unchanged bvss interface finds public abstract
flags and invokes a test implementation through Method.invoke. AssertionError constructors
now retain object details and throwable causes, exposing that underlying failure. Source-
qualified logger parameter overloads support indexed substitution; they do not implement
full MessageFormat patterns or handler dispatch.

The next Chrome run had no earlier main-thread/GL exceptions but still no map geometry or
working search. It completed roughly 152,000 measure calls during startup; this is a
performance investigation, not a passing timing measurement. A diagnostic object-graph
walk stalled the tab and was terminated, then the tab reloaded. Use narrow object paths
or explicit counters instead of heap-wide queries. A microG process reached missing
Intent.getParcelableArrayListExtra; named list-extra getters/setters now preserve the
canonical extras map. All process realms must be checked again after reload.

ObjectOutputStream.enableReplaceObject is a newly observed cache-path failure. Existing
object graph serialization is explicitly unsupported; adding a switch alone would not
make that cache work. Investigate independently of map network/rendering progress.
Full E2E remains deferred until the Maps development pass is complete.


Maps' `/glm/mmap` POSTs reached Google with **zero bytes** and returned HTTP 400.
The unchanged `btew.call` body gets its output stream at DEX pc395, calls connect at399,
then writes at462. URLConnection.connect had already submitted and cached the empty
request. For buffered uploads, explicit connect now fixes connection configuration while
response access submits the completed body. Concurrent response accessors share one fetch.
The focused test preserves bytes written after connect and rejects requesting output after
response reading starts. Transport errors for an output connection remain deferred until
response access because this implementation buffers the entire upload. This is an explicit
limit, not evidence that connect has opened a remote socket. See OpenJDK's
[HttpURLConnection input/output ordering](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/sun/net/www/protocol/http/HttpURLConnection.java).
The live Maps run after this fix still needs inspection; do not infer HTTP or visual success.

### Maps wrapped input and remaining rendering (2026-09-13)

The HTTP upload ordering fix produces successful `/glm/mmap` responses (125,549 and
523,306 bytes observed) and successful tile responses. Buffered/DataInput wrappers
previously copied native input bytes and cursors, bypassing subclass reads such as
SequenceInputStream and leaving the original cursor unchanged. Wrappers now retain
and read the source, with buffered mark/reset and fast primitive reads from buffered
bytes. Five affected stream tests pass (24 assertions); typecheck passes.

The subsequent Chrome run parsed 52 zoom tables and built 50 lookup entries. It
still rendered only the map background/search bar: seven GL frames after a pan,
zero geometry draws, and empty base-tile bins. Tapping search creates and resumes
`axfd`, but its root view remains unattached. A prior panel transition remains in
`net.e`, delaying the new panel. These are active failures, not parity. The cache
writer also reaches unsupported ObjectOutputStream.enableReplaceObject; object
serialization remains unsupported. Child microG processes had no observed missing
APIs at this checkpoint. Full E2E has not run.


### Maps home transition diagnostics (2026-09-13)

Fresh headless/Chrome startup reached onboarding, not home. Early diagnostic taps passed
pixel coordinates to a harness that expects fractions; their apparent idle success did
not exercise Skip. A real Skip action reproduced the transition stall. The bounded
exception collector exposed `belc.as()I`: an API outline read the absent
`Build.VERSION.MEDIA_PERFORMANCE_CLASS`, and int-to-long conversion failed on undefined.
The field now reports the documented zero (no declared performance class). The transition
then completes and constructs bottom navigation/home content, but repeated layout passes
fail on TableLayout.setColumnShrinkable. Column shrinking and reversible stretch/shrink
selection are implemented in the existing table owner; the affected tests and typecheck pass.

Separately, View.layout suppressed layout listeners when a required layout kept the same
bounds, contrary to AOSP. Listeners now run in the same branch as onLayout, preserving the
unchanged/no-layout fast path; an async-listener regression test covers both cases. This
alone did not remove the Maps transition failure. The native disk-cache error is 65551
wrapped as SQLite code 15 (SQLITE_PROTOCOL); its root cause remains unproven. Maps has not
drawn map geometry or achieved parity, and the final full E2E remains deferred.


Maps home measurement then multiplied through nested FrameLayout and LinearLayout wrappers.
A single main-queue measure job reached millions of onMeasure calls. A bounded per-view
counter found successive wrappers doubling the calls (one Compose child measured 103,884
times while an outer wrapper measured 1,082 times during the sample). FrameLayout now
performs its second pass only for multiple matching children under a non-exact parent
specification, and LinearLayout only forces uniform cross-axis size under a non-exact
cross-axis specification, matching AOSP. Focused tests cover a nested chain (one leaf
measure) and final sizing of multiple matching children. After this fix the Maps main queue
drains; the inspected run had 18,330 onMeasures and further real layout/draw API failures.
This is evidence that the pathological pass is removed, not a benchmark of working Maps.

Subsequent fixes provide natural-order Arrays.sort subranges (with checked bounds and
suspending Comparable calls), View context-clickable state, and Path.set. Path copies
retain contour cursors/fill rule and own their mutable operation arrays. The first transient
Compose attachment error remains a separate ordering limitation; attachment is queued by
the current platform implementation. Native cache SQLITE_PROTOCOL and zero map geometry
remain unresolved, and full E2E has not run.

Maps now constructs home content and performs live place autocomplete in full Chrome.
The tested path required Path.addPath with Matrix, accessibility-service state listeners,
SpannableString.valueOf, the public minimum scaling span, Space constructors, outline
shadow-color properties, child drawable-state aggregation, Character.offsetByCodePoints
and CharacterStyle.wrap. Span wrappers retain distinct identities and forward draw and
measurement behavior. SHA-384/SHA-512 MessageDigest uses WebCrypto; the earlier SHA-512
lookup and invalid response-signature exceptions no longer occurred in the inspected run.
Place selection next reached missing BidiFormatter; its implementation includes directional
heuristics, embeddings/isolation and preservation of span ranges. Focused checks pass.

An isolated call to the unchanged NativeSqliteDiskCacheImpl reproduced error 65551
(SQLITE_PROTOCOL). Its trace repeatedly opened map_cache.db-shm and issued F_GETLK. The
query returned zero but left l_type=F_WRLCK, which SQLite interprets as another process
holding an exclusive DMS lock. Returning F_UNLCK for the current process-local descriptor
model made the same native open/destroy probe succeed (handle 91048944). This does not add
cross-process record locks or fix shared mmap coherence. It is no longer appropriate to
attribute this reproduced cache-open failure to those unproven alternatives.

A subsequent home run had one layout error (the transient unattached Compose view), zero
draw errors, 4,412 onMeasure calls, and no missing methods on that observed path. Three
microG process frames each reported an empty missing set. Their exception streams were not
captured by the main-realm throwable collector, so this is only missing-API coverage.
The capture headless-home-cache-fixed.png contains Local vibe cards but a blank map.
Full Chrome autocomplete returns Golden Gate Bridge suggestions with incorrect black
placeholder icons. Map geometry is still zero; parity and full regression verification
remain incomplete. Timing varied with concurrent Chrome/headless load and is not a benchmark.

The native SQLite cache then failed with 65537 on fresh paths and 66058 (short read) on
reopen. Host tracing showed one descriptor writing WAL bytes while another descriptor read
zero bytes at the same offset. Native descriptors now share live VFS file contents; writes
publish immediately, rename preserves open-file identity, and unlink does not resurrect a
pathname on close. The unchanged native open/hasResource(empty key)/destroy probe now
returns false without errors. Focused descriptor, AtomicFile and ParcelFileDescriptor checks
pass. Cross-process record locks and complete cross-realm open-file rename semantics remain
outside the demonstrated coverage.

Tile RPCs succeeded but preparation waited indefinitely for styles. The app's own debug
output reported ten tile responses, zero preparations and pending style futures. Its Cronet
fallback enumerates HttpURLConnection header keys from index zero and stops at null; our
implementation incorrectly reserved index zero for the status line. Matching Android's
indexed-header behavior lets the unchanged response handler see Content-Type. Later debug
output reported four style resources received, zero network failures, eight current tiles,
142 completed preparations and 1,736,178 bytes of GL data. The string-null status-line query
remains intact. The focused HTTP test passes.

EGL10's current-context query fabricated an object while no context was bound. Maps skipped
creating its offscreen capability context and cached zero vertex-texture units. Returning
the non-null EGL_NO_CONTEXT sentinel and preserving live context identity lets Maps query
32 vertex-texture units and 8192 maximum texture size in headless Chrome. Its unchanged
vertex-texture shader then compiled. Missing GLES20 uniforms, framebuffer operations and
buffer-offset drawing were added; integer queries now report actual scalar/array/object
bindings. A browser probe attached a texture to a framebuffer, cleared it, read
[255,128,0,255] into a positioned Java buffer without advancing position, and verified the
binding reset after deletion, with GL error zero. Map geometry and labels now appear in
headless-home-tiles-prepared.png, but colors/polygons are wrong. Recent full-Chrome runs still
showed a blank map; neither path establishes parity. The native-only glDraws counter does
not count these Java GLES calls.

Place construction successively reached Collections.disjoint, Rational, TtsSpan,
ScaleGestureDetector, LocaleSpan and LinearLayout divider APIs. Focused checks cover
suspending collection comparisons, rational normalization, TTS span parcels, double-tap
scale state (including rejected updates), locale order through paint copies/parcels, and
visible-child divider spacing/drawing/weights. Text locales reach Canvas2D language selection
and participate in width-cache identity. Locale lists retain all locales; Canvas2D uses the
first language. Scale recognition follows AOSP focus/span and anchored-scale rules; the
existing MotionEvent/input pipeline still only supplies one pointer, so this is not evidence
of browser multi-touch support. Full-Chrome place construction next failed in pcx.onMeasure
on getShowDividers; divider support requires another app pass.

A focused suspended-thread test reproduced ambient Java thread identity leaking into
unrelated host work. Thread.start and non-main Looper.run now restore that ambient identity
as soon as invocation yields, while their promises preserve lifecycle and queue ordering.
The tests cover live-thread enumeration and serialized looper jobs. One subsequent Maps run
had no VTO 'resume must be called on the main thread' errors, but the startup trace-span
mismatch and transient unattached Compose view still occurred. Other concurrent checkout
captures consume substantial CPU; no performance numbers from this diagnostic period are
accepted as benchmarks. The AVD Golden Gate Bridge place screenshot/XML was refreshed.
Typecheck and affected checks pass; the final full E2E suite has not run.

Subsequent Maps place interaction reached TextureView transforms, TransitionDrawable,
Arrays.deepToString, TouchDelegate, SpannableStringBuilder.clearSpans and Range. Focused
commits implement those platform contracts. Unordered set metadata incorrectly included
SortedSet, sending unchanged app bytecode into a comparator call; that interface was removed.
Place photos now appear in full Chrome, although the map remained blank with black label
backgrounds. Headless place content stayed below the screen: the app's pcl.computeScroll
reads the current offset only when computeScrollOffset returns true. Our scroller returned
false while producing its final offset. It now delivers that final update before returning
false on the following call, covered for Scroller and OverScroller.

Full-Chrome GL tracing exposed glEnable/disable receiving 83420592, the JNI environment
pointer, and glStencilFunc receiving environment/class before the actual enum. DEX method
annotations mark ten RendererJni methods CriticalNative. Registration now caches that
annotation and omits JNI handles and the local-reference frame for critical calls. ARM32
and A64 tests cover mixed integer, long, float and double arguments, double returns, and
the ordinary FastNative convention. Both tests and typecheck pass. The host crashed before
app verification of this fix and the scroller change; committed work survived. The server
and reference AVD were restarted, with full Chrome alone to reduce diagnostic resource use.
Rendering parity, all-process diagnostics, and the final full E2E remain unverified.

After restart, full Chrome confirms the CriticalNative fix: a bounded 118-draw trace has
zero WebGL errors and black label rectangles disappear. The scroller fix brings the place
card into view with photos. The map remains mostly beige in full Chrome; a headless run
with the native JIT disabled draws geometry but retains white water and incorrect polygons.
Palette textures contain blue, uniforms and integer-offset attributes bind correctly, and
a sampled white-ocean pixel is painted by the base fill without later water coverage. These
observations narrow the investigation but do not identify its cause. Chrome debugging became
unreliable; that diagnostic tab was closed. Headless timing under these conditions is not a
performance comparison. The AVD place reference was refreshed.

A later Maps bjuo request worker fails at ArrayBlockingQueue.drainTo before processing its
batch. Both drain overloads now use one shared queue implementation, including destination
validation, bounded FIFO/priority transfers and virtual collection adds. The batch is detached
once, avoiding repeated array shifts. Destination exceptions propagate; Java permits partial
transfer on failure. Eight focused queue/executor checks (58 assertions) and typecheck pass.
App verification of this queue change is pending. The ActivityManager test-harness query is
also implemented, but its place-video path still requires verification. Main-thread trace
identity, transient Compose attachment, serialization and rendering issues remain open.

The white-water cause is the Java GLES extension query, not triangulation. Unchanged native
tessellation probes return correct areas for a square, reversed winding, a hole and separate
polygons. GPU-buffer inspection finds a blue-row triangle covering a sampled white-ocean
pixel. Transform feedback then shows the shader rejecting that row: Maps allocated a padded
32×16 palette while its shader used reciprocal logical dimensions 1/29 and 1/10. Empty Java
GL_EXTENSIONS selects the app's power-of-two fallback; native GLES already reports WebGL 2's
non-power-of-two support. Java now reuses the native capability list for a WebGL 2 context.
No app data, shader, geometry or texture dimensions are changed. A fresh JIT-disabled Maps
run renders blue oceans/lakes and expected land colors (headless-npot-fixed-home.png), with
GL error zero and advancing frames. Typecheck passes. Full Chrome and detailed place/route
comparison remain to be repeated. UI attachment, trace identity and visual differences remain.

Full Chrome subsequently reports CONTEXT_LOST_WEBGL. Three stale diagnostic Maps tabs were
closed, but context loss recurred with a single Maps tab: transferToImageBitmap throws and
terminates GL-Map. EglContext now returns failure when a context is lost during make-current
or swap, and Java EGL10/EGL14 plus native EGL expose EGL_CONTEXT_LOST. Other transfer errors
still propagate. A real WebGL_lose_context probe verifies both Java swap APIs return false,
getError reports 0x300e then clears, and a newly created context presents successfully. The
existing framebuffer/readPixels probe still returns [255,128,0,255] without advancing buffer
position or raising GL errors. Typecheck and six platform construction tests pass. The
browser loss trigger and app recovery still need investigation; no parity claim follows
from this contract check. AVD Ferry Building-to-Golden Gate Bridge route was captured again.

### Maps attachment ordering after restart (2026-09-13)

Java ViewGroup.addView and addViewInLayout now await the child's window attachment, then
onViewAdded and the hierarchy listener. AOSP ViewGroup.addViewInner dispatches in that order;
queuing attachment until after the current main job let Maps measure GmmComposeView while
unattached. Synchronous native widget construction retains its deferred helper. Two suspended
callback tests verify ordering and no later duplicate dispatch; five focused view tests and
typecheck pass. Fresh full-Chrome and headless Maps runs report zero layout errors; the
headless run renders corrected water colors and live Golden Gate Bridge autocomplete.
The startup trace-span mismatch persists. Full Chrome again lost its WebGL context and later
crashed with error 11; a JIT-disabled comparison kept a live context but had not drawn map
geometry when checked. Neither the crash cause nor parity is established.

Attachment callback dispatch now retains its initiating thread across awaited callbacks,
including child trees and Java addView layout-parameter work. A scoped vcallOn helper starts
Java under that identity and immediately restores the ambient thread. A suspension test
checks callback identity without pinning the ambient thread during the wait. In the next
headless Maps place run, the earlier attachment listener's main-thread `propagate` failure
was absent. The independent startup span mismatch remains.

Directions text preparation reached java.text.Bidi.requiresBidi from xxn's constructor.
The static query now checks the requested UTF-16 range against the existing Unicode
bidirectional properties (R, AL, AN, RLE, RLO), including supplementary code points and range
validation. The remaining Bidi object-analysis API is not implemented. Focused tests cover
Latin/CJK, Hebrew/Arabic, directional controls, Adlam surrogate pairs, slices and invalid ranges.

Maps' directions fragment also reached missing ViewAnimator through olc. The new FrameLayout
subclass selects/wraps children, preserves selection on insertion/removal, and uses the
existing view-animation APIs. FrameLayout now honors measureAllChildren, enabled by default
for ViewAnimator and configurable from attributes. Focused switching/removal and hidden-child
measurement checks pass, as does typecheck. Route-result parity is still pending: selecting
the start suggestion currently leaves a blank content area without the earlier missing-class
error. A temporary-profile window of installed full Chrome renders the home map with native
JIT disabled (chrome-isolated-home.png, boot 3683 ms under concurrent diagnostic load), while
the reused Browser Use session remained blank and much slower. Profile, instrumentation and
saved state differ; this comparison does not isolate a cause or constitute a benchmark.

Submitting Ferry Building with the IME action reaches route construction in both full Chrome
and headless Maps. The subsequent missing ViewSwitcher is implemented as a two-child
ViewAnimator with factory creation, next-view lookup and reset. The comparator overload of
Arrays.binarySearch now reuses its existing binary-search implementation. Focused tests verify
a suspended comparator and insertion points, plus ViewSwitcher factory/limit/reset behavior;
typecheck passes. The app pass for these additions remains pending.

The visible UI probe now excludes INVISIBLE ancestors as well as GONE ancestors. Maps hid its
autocomplete container while leaving individual suggestion children VISIBLE; uiTree and
locateText previously reported these invisible suggestions. A fresh Chrome route-entry probe
now reports only the visible search controls. The full diagnostic tree retains hidden nodes.

AOSP retains mAttachInfo through onDetachedFromWindow and attach-state listeners. Webdroid
cleared its attached flag before either callback, causing Maps' AndroidViewHolder to reject
its own detach-time read observation. Detachment now clears attachment after the callbacks
and retains the dispatch thread through child and listener awaits. A suspended child/parent
ordering test and typecheck pass; app verification follows the next server restart.

The next full-Chrome JIT-enabled run survives search, place construction and route selection
for eight minutes, with 11,851 regions/1,006 modules and advancing main ticks. The prior
renderer crash remains intermittent; JIT enablement alone is not established as its cause.
ViewSwitcher and comparator binary search now reach live route estimates. DateUtils date-range
formatting then blocks route construction. Its new implementation maps Android's flags to
bounded cached Intl formatters, handles zones and exclusive midnight ends, and appends through
the supplied Java Formatter. Ten cases match a real Android 35 app_process probe after
normalizing ICU-version whitespace differences; 15 focused tests and typecheck pass. After
restart, Maps no longer reports the detach-time AndroidViewHolder error or DateUtils failure;
route construction next reaches missing android.icu.text.NumberFormat. The route still does
not finish rendering and geometry differs from the AVD.

The fuel-saving card reaches ICU NumberFormat.getPercentInstance/format. ICU and Java
percentage factories now share locale-aware cached formatting with half-even rounding;
fraction digit setters preserve their min/max invariant and long formatting avoids Number
precision loss. Three focused tests match Android 35 percentage, locale, rounding and long
probes; typecheck passes. Maps advances to route-map construction, where double-array binary
search is missing. The detailed route cards and controls still have layout defects.

Maps bwep.a checks instanceof SortedMap before calling comparator(). The hash-map family
incorrectly advertised SortedMap and ConcurrentMap on every implementation. Registrations
now expose ConcurrentMap only on ConcurrentHashMap, and no hash map claims SortedMap;
WeakHashMap and ArrayMap also no longer claim unsupported clone/serialization interfaces.
Focused type checks preserve TreeMap's SortedMap contract. App verification follows restart.

Route-map setup reaches Arrays.binarySearch(double[], double). Float/double whole-array and
range searches now use the shared floating comparator. Float/Double.compare also distinguishes
negative from positive zero; NaN sorts last. Tests cover infinities, signed zero, NaN, insertion
points and invalid ranges. Four focused collection/array tests and typecheck pass; app
verification follows restart.

### Handler callback thread retention

Logged dispatch awaited string conversion and Printer callbacks before invoking the
Handler with ambient thread identity. A background-looper regression test observed
the main thread in all four callbacks. Preserve the dispatch thread through each
virtual call, including Handler.Callback falling through to handleMessage after
suspension. Logged and unlogged dispatch tests pass. A fresh headed Chrome Maps run
still reports the LoginPromoTutorialController trace-span mismatch, so this corrects
a platform contract without establishing the cause of that remaining app failure.

### Complete Java view removal before returning

The route had an unattached subtree beneath the attached MainLayout: native removal
queued dispatchDetached after Java had re-added the same view. That late detachment
also excluded surviving layout requests from replay. Java remove methods now await
detachment and the onViewRemoved/hierarchy callbacks, preserving thread identity and
Android's parent-link ordering. Range removal remains linear. Temporary detachment
still preserves window attachment until removeDetachedView.

A focused removal/re-add test reproduced premature returns across all seven removal
entry points; those tests and temporary-detachment coverage now pass. A fresh headed
Maps run has no detached children beneath attached parents and renders route estimates,
distance, traffic text and Preview without diagnostic layout requests. The map remains
hidden, and the progressing renderer now reports missing Matrix.perspectiveM. Startup
trace mismatch, small icons and other geometry differences remain unresolved.

### Perspective and camera matrices

Route rendering reached missing android.opengl.Matrix.perspectiveM after attachment
recovery. Implement the field-of-view projection, preserving the output offset and
Android float intermediates. Replace the adjacent setLookAtM identity placeholder
with camera orientation and translation. Frustum near/far projection and camera-basis
tests pass; typecheck passes. Fresh headed Maps no longer reports perspectiveM missing,
but its map container still remains invisible. This does not establish map parity.

### Picture recording dimensions

Picture reused RenderNode recording but never stored the requested width/height:
a headed Chrome probe recorded a 32x48 canvas and got 0x0 from Picture. Maps route
preview uses Picture aspect ratios to size maneuver icons; the zero dimensions reached
its width-positive precondition and repeatedly aborted layout. Store Picture dimensions
when recording starts, independently of RenderNode's positioned bounds. The same fresh
Chrome probe now returns 32x48 and typecheck passes. Full preview verification follows;
this change alone does not fix drawable sizing or hidden map visibility.

### Dispatch drawable size overrides during widget measurement

Maps' Options drawable reported 96px through Java getIntrinsicWidth but -1 through
its native base helper; a custom image drawable similarly reported 84 versus -1.
LayerDrawable now dispatches child intrinsic-size overrides and honors explicit layer
sizes. Drawable minimum sizes, View suggested minimums and TextView measurement use
the public size contract. ImageView retains measured drawable dimensions for drawing.
The thread-scoped virtual-call helper preserves synchronous returns to avoid allocating
promises for native size queries; asynchronous overrides retain the caller thread.

The 18 focused drawable, Handler and attachment tests pass (91 assertions), as does
typecheck. Fresh headed Maps shows Save/Share/Close with 96px widths instead of zero.
One run crashed soon after startup; a repeat reached the sign-in tutorial without the
usual trace error and continued through search/place. Neither observation resolves the
intermittent crash or startup race. The capture also exposes existing drawing-order
failures: ImageView mutates bounds without notifying its drawable and drops an async
draw result; container bounds callbacks are not awaited. A Chrome probe observes only
`draw`, missing `onBoundsChange`, for a resized custom drawable. These remain next.

### Await drawable geometry and image drawing

ImageView changed drawable bounds fields directly and dropped the virtual draw result.
LayerDrawable also discarded asynchronous child bounds callbacks. Route/place captures
showed misplaced icons and clipped paint. Preserve callback ordering through bounds
changes and layer drawing, including caller thread identity. ImageView scales its canvas
around intrinsic drawable bounds and restores it only after drawing finishes.

Focused layer/transition tests pass. A real Chrome Canvas2D probe now observes bounds
then draw, with a 20x10 drawable filling the expected centered 100x50 area of a 100x100
view; the center is red, the upper margin transparent, and the canvas transform is
restored. The preceding build skipped the bounds callback. Full Maps visual verification
continues alongside an independent bitmap-shader GPU allocation investigation.

### Share immutable bitmap shader tiles

Headed Chrome failed GPU IOSurface allocation even for 1x1 tiles while the host had
57% memory free. A software Canvas2D diagnostic stayed alive and traced 902,254
OffscreenCanvas constructions in about three minutes; over 99% came from bitmap
shader tiles. Fresh shader instances repeatedly copied the same bitmaps (54 bitmap
objects served 230,142 sampled shader draws), defeating the per-instance cache.

Cache tiles weakly by bitmap and pixel generation, including mirror dimensions in
the key, and use the original canvas for uncropped, unmirrored tiles. A real Chrome
pixel probe checks 2,048 pixels across all 16 tile-mode combinations, repeated shader
instances, and mutation invalidation, with no failures. The fresh hardware-accelerated
Chrome Maps run reached search/place/start selection without GPU allocation errors;
only 127 shader tile canvases were allocated at the place checkpoint, including the
probe. This removes the measured allocation explosion, not the separate startup
trace mismatch, missing route map, or clipped chip geometry. Typecheck passes.

### AnimatorSet start notification restores map visibility

The Maps route map stayed INVISIBLE because MainLayout.aB retained its full-screen
content flag. Bytecode shows oam.onAnimationStart makes the incoming search container
visible, and nfi skips outgoing cleanup when that container is already invisible.
AnimatorSet.start never notified its listeners, so both full-screen containers stayed
invisible and cleanup never cleared the flag. Notify start listeners before children,
retaining the caller thread across asynchronous listeners and child starts.

Six focused animator tests pass (17 assertions) and typecheck passes. Fresh full
Chrome now displays start-location suggestions and, after selecting a start and
swapping endpoints, Ferry Building to Golden Gate Bridge route lines and map controls.
MainLayout's full-screen flag clears and the MapViewContainer is VISIBLE without
manual state changes. Preview renders the maneuver icon. Base map tiles, chip geometry
and new Math.log1p / ICU ListFormatter failures remain; parity is not established.

### Newly reachable Maps math and list formatting

After AnimatorSet start callbacks made full-screen content visible, layout reached
missing Math.log1p. Register the host's precision-preserving log1p implementation;
focused checks cover tiny inputs, signed zero, infinity and the domain boundary.
Typecheck passes. Fresh Maps layout verification follows.

Ferry Building details invoke android.icu.text.ListFormatter.getInstance(Locale)
and format(Collection). Implement default/Locale factories and collection/array
formatting through Intl.ListFormat, preserving Java toString dispatch, caller thread
and null failures. Android 15 ICU ListFormatter source specifies per-element toString
and the AND/WIDE default. Focused tests cover empty/single lists, English punctuation,
Spanish contextual conjunctions, German conjunctions, asynchronous objects and nulls.
All three math/list tests pass (16 assertions); typecheck passes. App verification
continues in the rebuilt Chrome session.

### Retain thread identity while constructing native objects

newObj awaited class initialization before constructing the host object and invoking
its Java constructor. A controlled background-thread test observed the main thread in
both constructors. Capture the caller thread before initialization and restore it for
both construction stages, without retaining global thread state across the wait. The
construction and Handler tests pass (six assertions), as does typecheck. Fresh headed
Maps still reports the startup trace-span mismatch, so that separate race remains.

### Await inherited text measurement in compound widgets

The visible Directions chip measured 354px inside a 144px FrameLayout. A live measure
trace found the parent had observed a zero-width chip; CompoundButton discarded the
promise from TextView.onMeasure, so its measurement finished later. CheckedTextView
had the same call pattern. Await both inherited measurements before adding indicator
space or applying height constraints.

A real Chrome Canvas2D probe with delayed suggested minimums reproduced both widgets
returning zero dimensions before the callback finished. The rebuilt browser reports
354px for each child and parent. Fresh Maps now lays out Directions at [48,1536,402,1680]
with non-overlapping Tickets and Share, replacing the clipped negative-left chip.
Typecheck passes. The fresh Android reference also wraps the place title onto two
lines; that observed wrapping is not a parity defect. Base map tiles, rating decoration,
preview control geometry and the startup trace error remain unresolved.
A Maps route-preview row measured 2,328 pixels tall: its match-parent divider supplied the
available height to a wrap-content LinearLayout. Android excludes that child's measured
cross dimension when siblings determine the wrapping size, then measures it against the
resolved size. LinearLayout now follows that rule in both orientations, including weighted
remeasurement, while preserving the all-match-parent case. A focused test reproduced
300 instead of 48 pixels before the fix; five layout/divider checks (15 assertions) and
typecheck pass. Fresh full Chrome places the previous/next controls at the bottom in a
180-pixel overlay instead of the previous full-screen white strip. Captured in
chrome-preview-cross-measure-fixed.png. This JIT-disabled preview also renders water and
roads; an earlier place capture was still waiting on map content. A matching JIT-enabled
comparison remains necessary before attributing the inconsistent base map to either tier.

A later map-label preparation reaches Character.UnicodeBlock through bvun's unchanged
initializer. The missing class aborts that executor path. Subset and UnicodeBlock now expose
Android 15's constants, singleton identities, aliases, gap handling and binary range lookup.
The data is extracted from the paired AOSP Character source. An AVD Dalvik probe scanned all
1,114,112 code points: its 362 range transitions exactly match the table. Two focused checks
(43 assertions) and typecheck pass. Fresh Chrome initializes bvun successfully with no
UnicodeBlock misses. This does not establish complete map-label or base-map rendering.

Native-tier comparisons remain inconclusive. Full JIT initially produced beige maps while
JIT-disabled and several partial-JIT runs rendered water/streets. However, disjoint excluded
ranges both worked, one initially blank capture became correct later, and a fresh full-JIT
run rendered base geometry as well. These observations do not isolate a miscompiled instruction.
A palette probe observed matching logical/actual dimensions (29x16 and 29x14), then incorrectly
queried a uniform absent from a different shader and terminated GL-Map; captures after that
probe failure are invalid. The probe was removed before rebuilding for UnicodeBlock.

Maps' Glide fallback reaches BitmapFactory.decodeFileDescriptor through krl/kra/kqi.
Both public overloads now decode through the shared native descriptor table. Regular and
lazy files read from the current offset without moving it; pipe/socket reads consume the
stream without closing the caller's descriptor. The regular-file path avoids guest-memory
copies. Failed decodes reset output dimensions/configuration instead of retaining stale
results. An Android 15 AVD probe verified full/bounds/sampled decoding at offset 3,
unchanged padding for null results, invalid/empty descriptors and an open pipe after decode.
A real Chrome pixel probe matches those dimensions, offsets and padding, including opaque
red decoded pixels. Five descriptor tests (41 assertions) and typecheck pass. A fresh Maps
place/directions/preview run no longer reports this missing API and renders base-map water,
roads and labels. This does not prove every place image succeeds; AbstractSequentialList
still aborts a separate asynchronous place-data path.

A place-data callback failed while bwge.l constructed bwfx, whose superclass is
AbstractSequentialList. Its unchanged bytecode provides size() and listIterator(int).
The platform superclass now implements indexed access/mutation, bulk insertion and iterator
traversal through those overrides, translating only NoSuchElementException to index errors.
AbstractList.listIterator() now dispatches its indexed overload, as Android does, so sequential
subclasses retain their iterator and traversal complexity. Three focused checks (20 assertions)
cover suspension, live mutation, a single destination iterator for bulk insertion, exception
identity and caller-thread retention across iterator callbacks. Typecheck passes; a fresh Maps search/place/directions run has no
AbstractSequentialList or decodeFileDescriptor missing entries. The startup span mismatch
persists and is being traced independently.

AnimatorSet completion used an independent timeout that launched all end listeners as
floating promises. A focused main-queue gate test reproduces both callbacks beginning before
the current job finishes, and the second listener starting before the first returns. The
completion now runs as one main-looper job, awaiting listeners and chained startup in order.
Seven animator checks (19 assertions) and typecheck pass; the new check fails on the prior
implementation. Fresh Maps renders the home map and local-content cards. Startup still
reports the LoginPromoTutorialController span mismatch. An instrumented run reached the
sign-in tutorial without that error but hit a separate transition-span mismatch, so the
absence in that run cannot establish a startup fix. The temporary flow also waited for
Search here as text while the Compose omnibox exposes it as a description; that timeout
was a harness lookup failure, not a blank Maps home screen.

A lightweight span-write probe reproduced the startup mismatch without changing app bytecode:
FutureTask.run awaited its Callable on a worker, then invoked done() with the ambient main
thread. Guava's direct completion listener consequently installed ClientParametersManagerImpl's
trace over LoginPromoTutorialController.isSignedOut on the UI thread. Capturing the executing
thread and dispatching done() with vcallOn fixes this boundary. The focused success/failure
completion check fails on the preceding code (observing main instead of the worker); six
executor checks (30 assertions) and typecheck pass. Fresh full Chrome without the span/canvas
instrumentation reaches the sign-in tutorial with no trace-end errors.

The blank Street View thumbnail contained a decoded 270x162 bitmap with real pixels.
Its ImageView was hosted under Compose's AndroidViewHolder. Calling the public invalidate()
made the thumbnail visible immediately: image replacement requested layout but did not notify
ancestor recordings, while appearance setters only dirtied the global frame. ImageView's
shared drawable setter and appearance changes now invalidate the view through the existing
ancestor callback. Five drawable checks (20 assertions), including nested ancestor notification
for image replacement/filter changes, and typecheck pass. This addresses stale image content;
rounded clipping is a separate remaining visual difference.

View.clipToOutline was an acknowledged no-op even when MaterialCardView enabled it. View
traversal now clips through the existing Outline renderer, caching provider output until
size, background or outline invalidation changes. Null providers disable clipping; the default
provider asks the background for its geometry. LayerDrawable (also backing InsetDrawable)
forwards the first nonempty child outline, preserving Maps' Material shape radius of 48 pixels.
BOUNDS/PADDED_BOUNDS and Android 15's path-capable canClip contract match AOSP. A real Chrome
pixel probe confirms transparent corners/opaque center, one provider call over two draws,
refresh after invalidateOutline and no clipping with a null provider. Provider/background/inset
checks and typecheck pass. Fresh place imagery appears without manually invalidating it.

MaterialCardView's white thumbnail stroke lived in a foreground drawable that View stored
but never drew. View now dispatches onDrawForeground after content/children/overlay, retaining
virtual overrides, foreground state/callbacks and cached gravity bounds. The common fill case
avoids intrinsic-size queries; views without a foreground or override skip the extra callback.
Focused checks cover suspended bounds callbacks, executing-thread retention, centered versus
fill bounds and callback removal. Typecheck passes. A real Chrome bitmap probe paints green
foreground over red background, then reveals red after removing the foreground.

While tracing Maps' Roboto title, AppCompat was observed resetting its typeface to null during
setTextAppearance. Explicit Context/Theme.obtainStyledAttributes(style, attrs) duplicated
resource resolution and exposed @null as a present reference instead of masking it. Both now
reuse resolveStyleValue. A resource-bag test covers explicit null, a theme reference to null,
index enumeration and retaining a nonnull family; its 12 assertions pass and its first
hasValue assertion fails against the preceding code. Typecheck passes. Maps still selects
Roboto after this change, so it does not establish the cause of the remaining font mismatch.

The place search title requested END ellipsis but kept all 1,407 pixels of text in an
801-pixel line. TextView's breaker only considered omitted logical characters, missing
single-line width overflow. It now checks both, using a bounded binary search instead of
measuring successively shorter prefixes and avoiding a split surrogate pair. Real Chrome
checks cover fitting and overflowing text, widening, cached layouts, last-line truncation,
sub-ellipsis widths and supplementary characters. Typecheck passes; a fresh Maps place
capture shows the requested ellipsis. This does not address other font/layout differences.

Maps' basi.Q builds the rating from a number and a SpannableString containing a replacement
span over the word "stars". TextUtils.concat discarded that span, including on the subsequent
concatenation with the review count. Concatenation now preserves span identity, offsets,
endpoint behavior and immutable SpannedString results, with a plain-string fast path.
Three checks (14 assertions) cover nested image spans, snapshot isolation, null/single-input
semantics, duplicate/NoCopySpan ownership and inclusive endpoints. TextView's independent
plain-text drawing path remains to be connected to the existing span-aware Layout renderer.

TextView now measures and draws replacement spans through that Layout implementation,
retaining measured span geometry across width changes and repeated measures. Ordinary text
keeps its synchronous cached path. A Chrome fixture exercises a suspending replacement
callback, pixel output, centered positioning, height, reuse, getLayout and switching back to
plain text; it fails against the preceding TextView (zero callbacks and transparent pixels).
The fixed browser fixture, concatenation checks and typecheck pass. A fresh unchanged Maps
place renders its gold rating stars, and search/directions/preview remain reachable. General
character styling and all span mutation/ellipsis cases are not established by these checks.

Preview's red navigation arrows were app picture drawables. ImageView.setColorFilter wrote
native tint fields instead of calling the drawable's virtual setColorFilter, so its bitmap
paint never received the requested filter. ImageView now owns the filter, applies it after
drawable mutation, forwards the public overloads and reapplies it to replacement images.
The existing search icon assignment awaits the same path. Six drawable checks (27 assertions)
cover asynchronous mutation, callback thread, filters set before an image, replacement and
clearing; typecheck passes. Fresh Maps preview now has a disabled gray previous arrow and a
dark next arrow, using the app's actual filter colors. The marker size, font/wrapping,
Street View preview thumbnail and map-label outlines still differ from Android.

Canvas.drawText ignored Paint.Style and always filled glyphs. Maps' scale bar explicitly
requests a five-pixel white stroke before its dark text. The common text draw helper now
honors FILL, STROKE and FILL_AND_STROKE, sharing stroke setup with other Canvas primitives.
The real-browser fixture compares all pixels for each style against the corresponding
Canvas2D operations; STROKE and FILL_AND_STROKE fail with the preceding helper. Typecheck
passes. This observed scale-bar fix does not yet prove the cause of missing native map-label
outlines, which were not seen in the bounded Java drawText trace.

Maps' preview Glide path reached the missing FileInputStream(FileDescriptor) constructor.
FileInputStream now uses the shared descriptor table for path and descriptor opens, retaining
native offsets, getFD identity, lazy-file read ordering and channel mappings through rename
and unlink. Android's public descriptor constructor borrows ownership; the hidden ownership
constructor and path opens close their descriptor. In-memory reads copy directly into the Java
array, while special descriptors use the existing native read implementation. Eighteen focused
stream, descriptor, channel and atomic-file checks (121 assertions) and typecheck pass. Fresh
Chrome reaches preview without the missing constructor. Its thumbnail still fails: a relative
query-shaped image path and empty/undecodable input precede the MediaMetadataRetriever fallback;
implementing the constructor alone does not establish image loading parity.

A fresh Maps route run logged "Not on the main thread" from a preference listener. The
notification loop entered onMain but dispatched subsequent callbacks through ambient thread
state after awaits. Each callback now uses the explicit main thread. A suspending listener
check observes [main, worker] on the preceding implementation and [main, main] after the fix;
both focused preference checks (7 assertions) and typecheck pass.

Resources.getValue discarded the selected configuration's density and the source resource ID.
A Maps marker resource queried through getValue reported density 0, while openRawResource and
an Android API 35 app_process oracle both reported 480 for the same res/9J0.png entry.
Value lookup now carries selected density through resolved references and preserves unresolved
references when requested. Four assertions cover selection, aliases and reused TypedValues;
the preceding implementation fails. Fresh Chrome matches the Android oracle's density, ID and
path; typecheck passes. This metadata discrepancy alone has not established marker-size parity.

The next settled Chrome preview shows the origin marker reduced by about threefold after the
resource-value fix, and the earlier Canvas stroke fix now renders white map-label outlines.
A provider audit also found that pinned microG's FontsProvider returns Roboto for every request
(its unchanged v0.3.16.252432 source and a live provider query agree), so Google Sans availability
differs from the Play Store AVD. No APK-specific font substitution was added.

The malformed thumbnail URL then exposed ContentResolver.openFileDescriptor returning empty
storage for a nonexistent file. File URIs now use the canonical decoded URI path and delegate
to ParcelFileDescriptor.open, which rejects missing reads. Parcel descriptor mode parsing also
now preserves read-write access and rejects unsupported mode strings. Eight focused resolver,
parcel and file-stream tests (61 assertions) and typecheck pass; the new resolver tests fail
against the preceding code. An early fresh Maps preview did not report empty decode inputs or the
MediaMetadataRetriever fallback error, but empty decode warnings recurred as later work completed. The original thumbnail URL is still incomplete, so
this fixes false file-open success rather than restoring the image.

Back input used global main-job activity to decide whether it could run inline. An external
Back arriving while a main job was suspended therefore interleaved two main-thread flows;
Maps reported conflicting TripDetails initialization and network callback trace spans and
its preview could no longer close. All Back entry points are external input, so Back now
always joins the main queue. A browser fixture holds a real main job across suspension and
checks top-window callback ordering: the preceding implementation dispatches Back before
the job ends; the fix waits. The focused browser check and typecheck pass.

A fresh-data Android Maps route preview also omits the Street View thumbnail. Chrome's
URL builder receives an empty template from an initial client-parameter cache, although
later parameters contain seven templates. Both parameter updates complete without throwing;
the signed-out cache key remains `unknown@`. No app-specific template fallback was added.
The matched first-run Android screenshot is `android-preview-fresh-config.png`.

Opening a place photo then exposed Parcel Serializable values living only in its object
side table: marshall/unmarshall discarded the duration in InitialItemOptions. Object streams
now carry Java wire descriptors, declared/computed serialVersionUIDs, default fields, arrays,
enums, references, replacement/resolution hooks, custom callbacks and Externalizable bodies.
Parcel's Serializable and writeValue paths use those stream bytes. Native ArrayList and
HashSet forms are declared by their owner; LinkedHashSet retains its superclass's form.
Primitive arrays transfer in bulk rather than suspending and allocating per element.
Object-stream exception registration also now precedes subclasses that need those parents.

The Java fixture runs unchanged as DEX and its Java-generated bytes exercise cycles, shared
arrays, primitive fields, non-serializable superclass initialization, unread external data,
custom callbacks and native collections. Java 21 also reads webdroid's output successfully.
The unchanged Maps j$/time/Duration survives marshalling with -17 seconds and 123456789 nanos.
Twelve focused object-stream, bitmap and descriptor tests pass (74 assertions); typecheck
passes. Fixture regeneration uses javac --release 17, d8 --min-api 28, and the fixture's
`graph` argument to emit its Java reference stream. Full E2E has not run.

A fresh Chrome photo tap now reaches the media viewer's layout rather than losing its stored
objects. That layout exposes missing TextView shadow getters and DynamicDrawableSpan;
the viewer is not yet rendered successfully. Unsupported native serialized forms and advanced
stream operations (persistent field declarations, protocol version 1, unshared objects and
field accessors) remain outside this observed coverage. The diagnostic screenshots and their
instrumentation do not establish performance parity.

The photo viewer's first measure copied TextView shadow properties through absent getters,
then encountered DynamicDrawableSpan. TextView now retains its shadow properties and forwards
them to Paint; text and shape drawing apply the shadow only within their canvas save scope.
Drawable spans use AOSP bottom/baseline/center alignment, drawable bounds for font metrics,
weak drawable caching, virtual suspended drawing and guaranteed canvas restoration. ImageSpan
now follows that hierarchy and obtains its drawable from the supplied drawable, bitmap,
resource or URI. The browser checks cover span pixels/alignment/caching, shadow pixels and
state restoration; existing replacement-span and text rendering checks still pass. Typecheck
passes. Fresh Maps proceeds past these APIs but photo icon construction now reaches the
explicitly unsupported OUTER blur-mask style; the viewer is still incomplete.

BlurMaskFilter now retains SOLID, OUTER and INNER styles. Shape rendering combines the
opaque geometry and blurred alpha before applying Paint color/shader, reusing two scratch
surfaces per canvas. The focused browser test checks all four styles, fractional Paint alpha,
transformed clipping and repeated draws without leaking canvas state (25 assertions);
typecheck passes. Fresh Maps gets past filter construction and now exposes the missing
Bitmap.extractAlpha(Paint, offsets) overload. The photo viewer remains incomplete. Browser
blur kernels are not established as pixel-identical to Skia.

Bitmap.extractAlpha now returns a distinct ALPHA_8 bitmap, preserves density, applies mask
filters and returns their expanded offsets. AVD app_process probes established dimensions
for radii 0/1/2/3/5/10 and all styles, including INNER's original bounds; Paint color alpha
is ignored by extraction. Both framework JNI and direct APIs use the same implementation.
Alpha masks take color/shaders from the drawing Paint, and pixel buffers expose one alpha
byte per pixel. Browser checks and bitmap Parcel checks pass (63 assertions); typecheck
passes. Fresh Maps advances to LightingColorFilter during photo-page construction. Blur
pixel kernels still use Canvas2D; exact Skia pixel equality is not established.

LightingColorFilter now supplies its RGB multiply/add transform through the existing color
matrix path, retaining alpha and supporting updates to attached paints. Its focused API
check and typecheck pass. A fresh Maps media page lays out reaction/share/save and close
controls; image processing and captions next expose Canvas.drawPaint and TextAppearanceSpan.

Canvas.drawPaint now fills the current clip with the Paint under its transform, including
shader/filter/blend behavior, while ignoring stroke style and mask filters as Android does.
The framework nDrawPaint delegate uses the same method. A rotated clipping/alpha browser
check passes alongside the alpha-mask tests; typecheck passes.

TextAppearanceSpan now reads the requested style's font, size, colors, locale, shadow and
spacing values, and applies draw state after virtual measurement. Maps' bcfx subclass can
therefore run its own font/spacing override. Direct span tests cover combined style, colors
and suspended overrides; typecheck passes. Fresh Chrome now displays the same Golden Gate
Bridge photo and Jitesh Patil/219-reaction caption as the AVD. The right-hand action icons
remain absent despite nonzero view bounds; font/geometry and system insets still differ.
The observed constructors are covered; the Parcel and alternate theme-color constructors
are not yet implemented.

TextView now draws top/bottom compound drawables as well as left/right, preserving their
explicit bounds and translating the canvas to Android's compound-padding positions. Intrinsic
bound overloads initialize bounds through virtual size/bounds calls; measurement and text
placement use those dimensions. A browser test covers all four positions, suspended draw
callbacks and unchanged bounds; existing replacement-span/ellipsis checks and typecheck pass.
Maps' media controls also reveal a separate cause: their transparent tint uses PorterDuff ADD,
while BitmapDrawable currently applies every tint as SRC_IN.

Maps intentionally applies transparent ADD tint to media icons. BitmapDrawable/NinePatch
now retain tint mode; cached bitmap tinting applies its composite operation instead of
unconditionally using SRC_IN. Transparent ADD returns the original surface directly.
MULTIPLY retains Android's multiplied alpha; tint caches invalidate on bitmap generation.
The pixel test checks ADD, SRC_IN, MULTIPLY and mutation (70 assertions with mask tests);
typecheck passes. Fresh Chrome displays the media action icons without layout/draw errors.
Other drawable subclasses and Paint's color-filter modes are not covered by this bitmap fix.

Maps' account-prompt Chips set TEXT_ALIGNMENT_CENTER, but TextView previously drew only
from gravity. Text alignment now resolves inherited View values, reads the XML attribute,
requests layout/redraw on changes and notifies the virtual RTL-properties callback. TextView
uses the resolved alignment for plain and replacement-span drawing, including text-relative
first-strong direction and view-relative alignment through getLayoutDirection. A browser test
checks left/center/right pixels, inheritance and relative direction; typecheck passes. This
does not implement View's previously stubbed layout/text-direction setters or full per-paragraph
bidi layout; those remain limitations.

Swiping Maps' photo viewer exposed ImageView.getImageMatrix in the zoom gesture handler.
ImageView now reports and draws the same affine matrix, copies custom matrices, returns
its actual ScaleType, and resets null matrices. Its shared scale calculation follows AOSP
CENTER/CROP/INSIDE rounding and FIT_START/CENTER/END placement; FIT_XY uses drawable bounds
and cropping follows cropToPadding. All eight scale modes, padding, copied/reset matrices,
virtual drawing and canvas restoration pass browser checks; affected drawable checks pass
(109 assertions), and typecheck passes. Fresh Chrome now swipes from the Jitesh Patil photo
to the same Jorge Chacon video page as Android without the gesture exception. Playback is
not yet functional: Chrome remains at 0:00 while Android plays the 22-second clip.

The video source's HTTP headers arrive in about 150 ms and the body delivers continuous
16 KB chunks, but URLConnection buffered the entire file under a single eight-second read
timeout. Response accessors now stop at headers and expose one incremental InputStream,
with per-wait timeouts and a retained pending read so timeout/retry cannot lose bytes.
Disconnect cancels the response, and unknown content lengths remain unknown. A real local
HTTP stream test covers incremental bytes, partial reads, timeout/retry, skip, EOF and close;
the upload regression check and typecheck pass. Fresh Maps reads the clip and reports its
22-second duration, but no video frames reach the surface yet. A missing direct-audio-support
query interrupts track selection and is the next observed platform failure.

AudioManager.getDirectPlaybackSupport now reports DIRECT_PLAYBACK_NOT_SUPPORTED for the
Web Audio output path, consistent with its existing lack of hardware offload/passthrough.
The API 35 SDK confirms the static signature and capability flags. With that query supplied,
Maps' unchanged ExoPlayer selects tracks and presents hundreds of decoded video frames; a
Chrome screenshot shows changing video content. The visible seek control still draws a
spinner: the native SeekBar inherits indeterminate ProgressBar drawing and discards its thumb.

The seek track resource contains ScaleDrawables. Their XML and platform constructor now
size children from level, scale fractions and gravity, preserving virtual bounds/draw calls.
A focused test covers zero/half/full levels, bottom/right positioning and suspended callbacks;
typecheck passes. SeekBar still needs to load and draw this resource instead of its inherited
indeterminate spinner.

The framework seek resources exposed several shared drawable gaps: LayerDrawable ignored
intrinsic dimensions under non-fill gravity; referenced XML dimensions stayed unresolved;
state-list solid colors and theme alpha were dropped; and vector groups never transformed
paths. These now resolve through the resource owner, preserve source alpha under tint, and
apply nested group transforms. Selector children receive virtual state changes. Animated
selectors select their state items, but animated transitions and vector clip paths remain
unsupported. Tests draw the real paired framework resources and check dimensions, alpha,
state, transforms and suspended child sizing; typecheck passes. Reused layer rectangles
avoid per-layout rectangle allocation, and ScaleDrawable retains its dispatch thread after
suspending child calls.

SeekBar now loads its styled track and thumb, draws primary/secondary levels, positions the
thumb, and handles drag progress and start/stop/change callbacks on the originating thread.
Drawable replacement keeps callback ownership and state. Its previous indeterminate spinner
is gone. The browser test checks track/thumb pixels and suspended touch callbacks. Fresh
full Chrome plays the unchanged 22-second Maps clip; Pause changes to Play and seeking
changes the position and resumes decoded frames. Keyboard/RTL seek handling and animated
thumb transitions are not covered by this implementation.

Maps' pause button was below the video because RelativeLayout measured its MATCH_PARENT
overlay child with AT_MOST, then shrank around the centered button. AOSP RelativeLayout's
getChildMeasureSpec uses the available span exactly for MATCH_PARENT when the parent size
is known. Applying that rule restores the full overlay and centers its controls. The focused
layout checks pass; fresh Chrome places the pause button at y=957..1137 versus Android's
952..1132. This does not implement the remaining RelativeLayout rule subset.

The shell's uiTree/locateText walk subtracted scrolling but omitted translations. Maps moves
its media controls by -258 pixels, so the reported bounds and named taps were displaced.
The shared walk now includes each ancestor's translation. A fresh named Pause tap reaches
the visible control and changes it to Play. Scale/rotation-aware inspection bounds remain
outside this change.

A clean paused-media profile still showed a layout every frame. The existing layout tracer
identified Maps' pre-draw callback repeatedly setting identical padding. View.setPadding now
matches AOSP internalSetPadding's change check. In comparable fresh Chrome Pause captures,
layout passes fell from 295 to 1 and layout time from 844 ms to 18 ms (2.42 s versus 2.38 s
capture windows); frame drawing remains active because an app animator is still running.
The measurement-cache test checks repeated unchanged padding and a real subsequent change;
typecheck passes. The clean-source capture is chrome-video-padding-fixed.json.

RotateDrawable was the remaining unsupported drawable tag in Maps' observed media path.
Its wrapper now draws the child around absolute or fractional pivots, updates rotation with
level, and loads XML angles/pivots. The SDK and AOSP Android 15 implementation establish the
API and angle-update behavior. Browser pixels cover half-level rotation, absolute pivots and
canvas restoration; typecheck passes. No application resource names are used by the delegate.

Fresh route verification exposed intermittent blank maps: EGL10 swapped 32–37 frames, then
returned EGL_BAD_SURFACE. A binding trace showed another worker making an EGL14 context
current and releasing it, overwriting the map worker's process-global binding. The same
failure reproduced at cf076e2, before the padding optimization. EGL bindings and error state
now belong to their calling thread; Java and native EGL share that owner. Cooperative thread
switches restore GL dispatch and object tables, avoiding a thread lookup on each GL call.
GLSurfaceView renderer callbacks also retain the GL thread across suspended lifecycle calls.
Khronos eglMakeCurrent/eglReleaseThread specify this thread-local behavior. The browser test
uses two real WebGL contexts, suspended swapping, separate errors, worker release, restored
pixels/object tables, and suspending GLSurfaceView callbacks. Typecheck and this test pass.
With tracing removed, full Chrome with native JIT enabled keeps the Maps surface valid and
renders water, roads and the route: the first preview capture records 77 GL frames in 10.14 s,
with no layout/draw errors. This restores rendering, not screenshot parity or complete EGL
conformance; shared contexts still share WebGL state, and deferred destruction and conflicting
cross-thread context binding remain incomplete.

The final serialized matrix exposed a real Resy image regression: its venue photo decoded
at f3fefda but disappeared on the Maps branch when ExifInterface reached the absent
DataInputStream.skipBytes. The delegate now repeatedly skips the remaining count on the
wrapped stream, stops on non-progress, and preserves its calling thread across suspension.
It follows OpenJDK DataInputStream's contained-stream contract, without app-specific behavior.
The focused checks cover cursor sharing, short skips, EOF, non-positive counts, suspended
virtual calls and exception identity. Typecheck and all 895 tests (22,160 assertions) pass.
A fresh 12-step Resy rerun restores the actual venue photo with zero missing APIs, errors,
wedges or layout/draw errors. Before/after captures are in webdroid-shots/maps/resy-before-skip
and tests/e2e/actual/resy. The full matrix was repeated at this committed code; results follow.


The final serialized matrix at 3dcc2d2 completed all 134 captures across 11 flows in
684.7 seconds. Every step had zero main-loop wedges, layout/draw errors and nativeRequired
entries. Resy again had zero missing APIs/errors and its venue photo rendered. Typecheck
and the EGL browser fixture also pass after correcting the fixture to retrieve the declared
EGL_NO_CONTEXT static field. Maps and Resy smoke compilation report zero method failures;
all 895 unit tests pass (22,160 assertions). Framework exercises pass with 295/363 declared
natives registered; Paint.measureText is skipped without a DOM.

A separate f3fefda worktree ran the same full matrix with one job. Its scored content mean
was 36.29%, versus 36.02% on the final branch (lower is better); these large differences
from goldens remain, and neither value establishes visual parity. TikTok stays on its
post-consent splash in both, and Lichess has the same pthread abort families (35, 3, 22).
Their log counts vary: final Lichess has 43 errors versus baseline 13 and the earlier branch
run 10. Final TikTok has 119 versus baseline 81; new observations include a vsnprintf bad
address in libttmplayer and the absent FileOutputStream(FileDescriptor) constructor, plus
native benchmark/proc diagnostics. These differences are unresolved, not regression waivers.
Flappy Bird gameplay remains 28–29 fps versus baseline 28–29 fps. The performance rollup
also records variable waits and extra native work; it does not support a general speedup.
The matched Maps padding measurement above is the narrower supported improvement.

Exact Maps parity remains open after the EGL fix. Roads/water/routes and media render,
but fine base-map detail, font wrapping and shadows differ. The font provider in the
unchanged bundled microG returns Roboto. Although Chrome and the AVD both use 1080×2424
at 480 dpi, webdroid reports API 33 and 24 dp system bars, whereas the API 35 reference
has different cutout/system-bar geometry. No app-specific font, tile or layout substitutes
were added. Good current captures include chrome-egl-thread-preview.png,
chrome-egl-thread-next-verified.png, chrome-media-final-full.png and their Android
references in webdroid-shots/maps. The E2E report and baseline/current logs are retained;
goldens were not modified. Work stays on codex/maps-parity and is not merged to main.

The post-crash recovery run reached another Maps place-sheet path: the missing
TextView.setLinkTextColor(ColorStateList) caused a repeated layout failure, and then
SuperscriptSpan failed resolution. TextView now retains stateful link colors, resolves
textColorLink from styles, and updates its paint without requesting layout. SuperscriptSpan
applies Android's truncated half-ascent shift through the virtual Paint entry point.
Both APIs have focused checks. A fresh Ferry Building run has zero layout errors and no
RecyclerView attachment failure; these fixes do not by themselves restore base-map geometry.

A bounded full-Chrome WebGL trace narrowed absent base-map geometry to a matrix whose
last row was zero, despite successful draw calls and no GL errors. The upload originated
at libgoogle3.so +0x1047668. Disassembly shows its bridge accepts sixteen floats: s0–s7
and eight stack slots. Cpu.call instead moved overflowing FP arguments into available
integer registers, so a call with two integer parameters lost six matrix values before
reaching the stack. Floating overflow now goes directly to the stack, preserving the
independent AAPCS64 register banks. Two tests cover sixteen floats with integer overflow
and interleaved float/double spills with available integer registers; both fail on the
previous code and pass with this two-line change. Typecheck passes. No APK or shader
substitution is involved. Fresh full-Chrome place, directions and preview captures now
render water, roads and building outlines. The settled first preview matches the reference
road/coastline/route geometry and maneuver; successive maneuvers also render. The long-lived
Chrome session recorded 3,055 GL frames with zero layout/draw errors and only the two Cordz
startup messages. Its native missing set contains syscall 267; earlier diagnostic sessions
also observed powl and pthread_getname_np, so absence in this session is not coverage of
those symbols. Raw captures and telemetry use the chrome-arm64-spill prefix, paired with
android-arm64-spill captures; chrome-arm64-spill-full.png includes the installed Chrome UI.
All 899 unit tests (22,174 assertions), typecheck and Maps compilation pass; the latter
compiles 72,887 classes with zero method failures. Fonts, shadows and device system bars
remain different. The final serialized matrix is repeated after these corrections.


The final matrix at a3bf33e completed all 134 steps across 11 flows in 699.3 seconds,
with one job. Every run.json was checked for freshness against this run's start. No step
recorded a main-loop wedge, layout/draw error or nativeRequired entry. Resy's 12 steps
again have no missing APIs/errors, and its venue photo was visually verified. Scored
content differences are Mihon app 57.56%, FitNotes 40.71%, Harmonic 27.97%, onboarding
17.56%; the 35.95% mean compares with baseline f3fefda's 36.29% and is not visual parity.

TikTok still shows the same post-consent splash as baseline. This run has 110 logged
errors and 18 missing APIs (baseline 81/19), mostly shared startup logs plus extra native
benchmark/proc diagnostics. The earlier vsnprintf exception and file-descriptor constructor
miss are absent, not proven fixed. Lichess has 53 errors (baseline 13), comprising the same
pthread 35/3/22 families plus its DNS warning. Flappy Bird's minimum observed rate is
29 fps, still near baseline. Another worktree ran its own E2E concurrently during part of
this matrix; the retained performance rollup therefore cannot establish an isolated speed
change. These results do not justify a clean regression verdict. The prior 3dcc2d2 log is
retained as webdroid-shots/maps/e2e-3dcc2d2.log; final-e2e.log, final-e2e-summary.json and
regression-performance.txt describe a3bf33e. comparison.html pairs the raw Maps previews.
The source remained frozen during capture, goldens are unchanged, and work is not merged.


## Maps maintainability review follow-up

The review at 72547c3 reproduced worker ObjectOutputStream callbacks on the main thread,
a native detach followed by Java reattachment ending with an attached-parent/detached-child
mismatch, and a rotated LayerDrawable losing an overridden intrinsic width. The fixes
carry the operation thread through recursive serialization and short stream reads, share
awaited hierarchy mutations between Java and native callers, and consolidate drawable
container painting and sizing. Synchronous native construction is explicitly limited to
unattached trees. Activity/dialog content replacement and picker/list rebuilds now await
removal instead of dropping child arrays or queuing stale lifecycle callbacks.

Binder Parcel side tables now transport Binder handles only. Serializable values already
use ObjectStream bytes; the unused graph codec and its protocol branch are removed.
TextView uses a single two-width layout cache for measurement, drawing and getLayout,
with one line array and shared replacement-span measurement. The ordinary text draw path
remains synchronous. Uppercase expansion remaps span offsets; ellipsis respects replacement
boundaries and is reported through Layout. A browser regression combines all-caps,
replacement spans and ellipsis and compares TextView pixels with its returned Layout.

A live City Hall to Ferry Building directions check additionally exposed the missing
InsetDrawable.setDrawable API, producing repeated layout errors. InsetDrawable now uses
DrawableWrapper rather than LayerDrawable, including replacement callbacks, bounds,
padding, pixel/fractional inset sizes and opacity. Android 35 SDK InsetDrawable.java and
DrawableWrapper.java supplied the platform evidence; focused tests cover both inset units.

Fresh full Chrome captures reach Ferry Building details, City Hall directions and two
preview maneuvers. Street geometry eventually settles, with 554 GL frames and zero
layout/draw/GL errors at the first preview capture. Initial tile preparation is still slow;
the observed 33-second boot was recorded with interactive diagnostics and competing local
work, so it is not a controlled performance comparison. The Android reference renders the
same first maneuver. `quality-comparison.html` pairs the screenshots; the place and
directions images precede settled tiles, while `chrome-quality-preview.png` includes them.
Fonts, shadows and system bars still differ. No exact parity claim is warranted.

Typecheck and all 903 unit tests (23,052 assertions) passed, and Maps compiled 72,887
classes with zero method failures. The first final matrix at 4e0ca33 completed 134 steps
in 686.4 seconds without layout/draw errors or main-loop wedges, but visual inspection
caught a real regression: Harmonic's dialog card was transparent. DialogRoot assigned the
background's bounds fields directly, bypassing InsetDrawable's child-bounds callback.
Using the canonical virtual setBounds fixes it without adding another drawable path. A
browser pixel regression fails before this change (transparent center) and passes after
(opaque red center). Typecheck passes again. The first matrix is retained in
`quality-e2e-before-dialog-fix.log`; the final matrix is repeated at 6cb3226.

The repeated matrix completes all 134 steps across 11 flows in 690.7 seconds with one
job and exit code zero. Every run.json is fresh, records advancing frames, and has no
main-loop wedge, layout/draw error, step error or nativeRequired entry. Resy's venue photo
renders and all 12 steps have zero missing APIs/errors. Harmonic's opaque rounded dialog
is restored in its actual APK capture. Content differences are Mihon app 57.45%, FitNotes
40.71%, Harmonic 28.36% and onboarding 17.56%: mean 36.02%, versus 35.95% before review.
Mihon's changing empty-state faces and Harmonic's live story content account for observed
capture differences; unchanged settings screens retain their prior scores.

TikTok again hits the previously recorded libttmplayer vsnprintf bad-address fault and
missing FileOutputStream(FileDescriptor), totaling 119 errors/19 missing APIs versus
110/18 in the saved pre-refactor run. The preceding 4e0ca33 matrix matched that saved
run's normalized error families exactly. This establishes recurrence, not the fault's
cause or resolution. Lichess logs 28 errors from the existing pthread families (53 in
the saved capture, 10 in the preceding matrix). No clean regression verdict is claimed.

Chrome Maps was idle and the owned AVD paused for the repeated matrix; no competing
E2E process was observed. Flappy Bird's minimum was 27 fps versus 29 in the saved run.
The performance rollup is retained in quality-performance.txt. FitNotes layout passes
fall from 68 to 55 while wrapping remains 374; timing changes are mixed, and the saved
baseline had competing work, so these runs do not establish a general speed improvement.
Both the emulator and full Chrome Maps session are restored after capture. Source stayed
frozen during each matrix, visual goldens are unchanged, and the branch is not merged.

## Maps integration with concurrent main work (2026-09-14)

The user authorized merging `codex/maps-parity` at a040643 into main after the Maps review
and cleanup. Main was 398728a, including Amazon and TikTok/Resy/YouTube work; integration
was resolved separately on `codex/maps-integration`. Both parents' regression tests remain.

The overlapping registrations for ClipData, scale gestures, text direction, SAX, StatsEvent,
Range and AbstractSequentialList now use their owning implementations. The provider file
writeback capability checks and native ELF/TLS validation from main remain; provider argument
decoding precedes caller-identity dispatch. Executor submission retains the synchronous native
queue path while awaiting virtual task factories and execute overrides on the captured thread.
EGL Java and native calls share per-thread context ownership; selecting a native context does
not overwrite the ambient Java thread's binding. Drawable drawing retains Android canvas save
accounting and awaits virtual bounds/draw callbacks. TextView uses the shared layout cache.

Main's StatsEvent long-array entry point now writes the repeated-field encoding through the
Maps builder rather than replacing it with the old placeholder registration. Encoding follows
[Android's StatsEvent builder](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/refs/heads/androidx-metrics-release/android-35/android/util/StatsEvent.java).
Its regression test checks the wire header and signed 64-bit payload. Test fixtures were updated
for required context/listener objects, directional animator callbacks, real EGL thread owners,
virtual drawable sizing and Canvas transforms. The hierarchy test now expects Android's reverse
removeAllViews notification order, already covered by the Maps attachment tests.

Typecheck passes. The combined unit run passed 1,194 tests and 24,475 assertions; the final
focused run passed 10 tests, including the additional StatsEvent regression. Smoke compilation
reported zero method failures for Maps (72,887 classes), Amazon (73,100) and TikTok (462,058).
Full Chrome rendered the guest Maps screen and opened directions at the built-in 1080x2160
geometry. These are interaction smoke captures, not a new pixel-parity claim against the taller
Maps AVD. The observed optional missing APIs remain visible in the diagnostic panel.

Screenshots, logs and the earlier Maps worktree artifacts are preserved under
`webdroid-shots/maps-merge/`; the archived original branch plan is `docs/maps-parity-plan.md`.
The full serialized E2E matrix completed in 840.4 seconds: 159 captured steps across 12 flows,
no main-loop wedges, and a 36.66% aggregate content difference across the four scored flows.
Goldens were unchanged. Maps is covered by the separate Chrome smoke captures, not this matrix.
TikTok had 4,579 layout errors and an empty feed; YouTube had 10 draw errors and two settling
timeouts. All other flows had zero layout/draw errors. Lichess retained 31 logged errors and
Reddit one; these counts include existing app/platform diagnostics and are not assertions.

The same harness then ran TikTok against unmodified main 398728a, with one browser and the
same screen/APK settings. It reproduced the empty feed and missing RelativeLayout copy
constructor/getGravity calls (4,260 layout errors, 233 logged errors, versus 97 logged errors
in integration). Different live content and frame counts limit numeric comparisons, but the
failure mechanisms and empty-feed state are present before this merge. The earlier historical
claim that TikTok's live feed works does not describe the current starting main capture.

YouTube's main comparison captured 16 steps in 148.1 seconds with no draw errors or timeouts,
but screenshots show it remained on the home screen when the script labeled steps as video
playback. Integration actually reached the Big Buck Bunny player and kept presenting frames
while the show-controls/pause probes timed out; pause had no semantic hit. The comparison
therefore does not validate playback parity or clear those two integration timeouts. The
Matrix.mapRect(RectF, RectF) and CaptionStyle gaps are also absent from the starting main
implementation. No clean full-E2E regression verdict or performance improvement is claimed.
Both complete runs and per-step telemetry are retained separately under `integration/` and
`baseline-main/` in the merge artifact directory. The baseline pair completed in 340.6 seconds.

Integration preserves both parent histories. The user-requested cleanup removes the Maps
parity, Maps baseline and temporary Maps integration worktrees; the unrelated baseline stays.


## Maintainability and performance audit (2026-09-14)

The user requested parallel component audits, OSS comparison, focused cleanup and
measured performance improvements. Starting point was d018ea9. Five focused commits
retain general changes without altering guest bytecode or adding dependencies:

- 2573390 shares read-only compiler definition sets and copies only growing joins,
  removing deep cloning and dead compiler fields. FitNotes/Resy generated source is
  byte-identical across 34,802 classes / 199,464 declared methods; isolated source
  generation medians improve 3.8% / 7.1%.
- e5ebe84 uses Zig @memmove, emitting Wasm memory.copy. Chromium libc-copy medians
  improve 12–16× at 4–64 KiB, with 16-byte copies neutral. ReleaseFast Wasm shrinks
  1,412 bytes. Overlap, zero-length invalid pointers and code-page invalidation are
  covered by a baseline/current matrix and one core regression.
- 4724039 writes Base64 directly into a sized Int8Array and uses TextDecoder for
  ASCII Strings. Chromium 64-KiB/1-MiB encoding is 5–6× faster; 49,632 differential
  cases match. One core regression covers signed bytes, slices, flags and line ends.
- 4bcddf9 filters v1 APK signature names before reading lazy ZIP properties. Doodle
  Jump certificate lookup falls from 43.11 to 0.240 ms and reads one signature entry
  instead of materializing 505 entries. Of 31.7 MB content, 3.3 MB is deflated and
  the rest stored views; 31.7 MB is not an allocation saving. Certificate hashes
  remain identical, with one core lazy-accessor regression.
- be346bb selects Forge's PKCS#7/RSA/X.509 dependency graph and digest modules through
  a shared lazy entry. Standalone minified browser dependency size falls 93,075 bytes
  (24,366 bytes gzipped). Fresh Bun/Chromium checks pass 16 OAEP digest/MGF pairs and
  certificate signing/parsing/verification. The real v1 APK test exercises PKCS#7.

The [audit report](performance-audit-2026-09.md) contains measurements, primary OSS
references, dependency alternatives and deferred opportunities. fflate, sql.js,
tough-cookie and TypeScript remain: no measured replacement justified their API and
platform compatibility costs. The stale Doodle Jump comment claiming native execution
was unimplemented is removed. Only three core test functions were added; existing tests
were retained. Timing runs were serialized and comparison artifacts preserve the starting
sources and Wasm. These are component-level gains, not app-wide performance claims.

Final typecheck passes. The full unpaused suite passes 1,198 tests and 24,884 assertions
across 210 files in 66.78 seconds. All executed fwtest exercises pass; Paint.measureText
is explicitly skipped because headless Bun lacks Canvas2D. Its declaration scan reports
295/363 native bindings, not complete framework coverage. FitNotes, Resy, Flappy Bird and
Doodle Jump smoke compilation reports zero method failures.

The targeted serialized E2E run at be346bb completed in 218.0 seconds: FitNotes 39/39,
Resy 13/13, Flappy Bird 7/7 and Doodle Jump 6/6 steps rendered. Every step advances
foreground frame counters; all 65 steps have zero newMissing, newErrors, nativeRequired,
layout/draw errors, step errors, main-loop wedges and settle timeouts. Visual inspection
confirms the Carbone venue image, native game/tutorial content and Flappy Bird gameplay.
FitNotes' content mismatch is 40.12%; this is existing-golden comparison, not newly
established parity. Goldens are unchanged. The entire 12-flow matrix was not repeated.

Foreground telemetry does not cover child runtimes automatically. A separate fresh-boot
probe inspected every app/process frame and captured page/console errors across realms.
FitNotes/Flappy Bird each expose three runtimes; Resy/Doodle Jump each expose four. All
reported empty missing/native requirements and visible documents. Resy logs upstream
Firebase/Facebook HTTP 400 and Mixpanel HTTP 410 responses. These are explicit service
responses; this boot probe does not establish clean child-process telemetry throughout
all interaction steps.

Flappy Bird misses the 55-fps target on both revisions. Matching serialized captures on
an isolated d018ea9 checkout measured minimum 28 then 25 fps, versus changed minimum
25 then 26 fps. The ranges overlap; no app-FPS improvement or precise regression bound
is established. A transient page TypeError reading `status` occurred in comparisons on
both revisions; its origin remains unresolved and is not counted by the foreground
newErrors field. Comparison logs preserve it. The initial four-flow changed run had no
reported page exception. Doodle Jump's changed gameplay minimum is 37 fps. A follow-up Chromium tiny-copy
benchmark finds less than 1 ns/call overhead at 4/12 bytes; other sizes below 16 bytes
are neutral or faster. No special-case branch is justified by that result.

All raw logs, per-step JSON, screenshots and runnable benchmark snapshots are retained
under `webdroid-shots/performance-audit/`, including separate original and repeat
Flappy Bird comparisons. Temporary baseline checkout and owned test servers are cleaned
up after evidence preservation.

## September 14, 2026: staged runtime and presentation replacements

This investigation starts at `b16d705` on `codex/perf-integration`. Independent
`codex/perf-*` worktrees preserve each candidate; `.worktrees/baseline` from the
earlier investigation is untouched. Performance windows run exclusively: other
agents pause builds, tests and browsers while continuing source review. The gate
for a large replacement is a reproducible 15% application metric improvement,
with no repeatable >5% responsiveness/startup or >10% retained-memory regression.
Component benchmarks establish mechanisms, not application gains.

### Measurement corrections and backend attribution

The E2E probe now captures counters and elapsed time before PNG encoding. Its
historical `fps` field remains shell ticks/s; `glFps` and `presentFps` distinguish
GL callback/swap completion and atomic framebuffer transfers. The latter counter
is unavailable on older served revisions. `perfsum` sums reset compilation
counters instead of treating them as monotonic gauges.

`scripts/perf-browser.ts` measures fresh contexts after the existing flow setup
and a three-second warmup. A single in-page operation brackets the 15-second
counter window, samples frame intervals and queue state, and optionally cycles
existing input actions. Screenshot encoding, explicit GC and process inspection
remain outside it. The default omits expensive E2E tracking wrappers. CDP CPU
counters cover a slightly wider interval. Post-GC heap/backing-store samples do
not measure all GPU or operating-system memory. Input-to-next-presentation is
explicitly an opportunity proxy; it cannot prove the input changed those pixels.
Bitmap transfers record the application's atomic publication boundary, not a
physical display timestamp. Child runtimes expose missing/native requirements,
but some do not expose logs, queues or performance counters.

The historical software flags force SwiftShader with GraphiteDawnVulkan. Merely
dropping those flags still leaves Playwright's headless shell on SwiftShader;
that diagnostic is not hardware evidence. Full bundled Chromium 151.0.7922.34,
`channel: "chromium"`, with `--enable-unsafe-swiftshader` removed from default
arguments, verifies Apple M4 Pro / ANGLE Metal in both browser SystemInfo and DOM
and Offscreen WebGL1/2, with correct pixel readback. It uses GraphiteDawnMetal.
The runner's `--gpu hardware` selects this configuration and reports the actual
backend. Results across these backends are kept separate.

### Rendering experiments rejected before separate composition

Canonical snapshot publication uses nondestructive `createImageBitmap` for the
retained GLSurfaceView buffer. A generation guards suspended callbacks against
resize, pause and detach; the owner closes replaced images. Destroyed EGL buffers
retain transfer semantics. `transferToImageBitmap` clears the producer even when
`preserveDrawingBuffer` is true, as specified by the
[HTML canvas standard](https://html.spec.whatwg.org/multipage/canvas.html#dom-offscreencanvas-transfertoimagebitmap).
[EGL preservation rules](https://registry.khronos.org/EGL/specs/EGLTechNote0001.html)
distinguish preserved color buffers from destroyed ones; ancillary preservation
cannot be inferred from that setting.

Three alternating Flappy title pairs under the historical software configuration
measured median presentation rate 27.13 -> 27.80/s for snapshot-only publication
(`6cb9423`). Its p95 interval worsened from roughly 38 ms to 52 ms. The experiment
does not pass the performance gate. Its initial virtual onDraw placement also
changed subclass drawing order; later snapshot candidates correct that defect.

Three additional pairs evaluated CPU Canvas2D backing (`8d5fa73`): 28.60 ->
32.87/s, but main-thread TaskDuration rose from 0.266 to 15.13 seconds in a
15-second window. Drawing consumed nearly the entire window. This is a
responsiveness regression, despite the apparent FPS gain, so the trial is rejected.

Combining nondestructive snapshots and CPU backing with corrected virtual draw
order (`aa3d8cb`) retained the same failure mechanism. The first software title
pair measured 30.19 -> 32.28/s while main-thread time rose 0.244 -> 15.087 s.
A fixed-input window measured 30.19 -> 32.39/s, with input-next-presentation proxy
median 22.2 -> 30.7 ms. Repeating seven pairs cannot rescue this independently
reproduced blocking mechanism; further software title pairs were stopped.
On verified Metal, title and fixed-input windows remained near 60/s on both
revisions, without a meaningful FPS gain. All eight completed captures are
visible and alive with advancing ticks and no foreground draw/layout errors.
Their final gameplay images show Game Over on both revisions, so these are fixed
input/health windows, not proof of sustained live gameplay. The shared external
AdMob `status` TypeError is preserved in raw reports; Metal also reports rejected
`gmsg:` URLs. Emulator missing/native requirements remain empty in the observed
main and GMS realms. No goldens were changed.

Separate five-second traces attribute substantial software-renderer time to
transfer/composition: baseline WebGL thread 2054.8 ms and RendererMainThread
2863.4 ms, including 1694.3 ms nested EndRaster work. Snapshot-only does not remove
it (1953.5, 2952.8 and 1735.8 ms respectively). Nested durations must not be
summed. Trace runs are attribution only and excluded from performance claims.
This evidence triggers the planned separate-compositor prototype.

Raw rendering reports live in `webdroid-shots/performance-stages/{rendering,canvas,combo}`;
the renderer worktree retains `webdroid-shots/diagnostic-*` and trace scripts.

The subsequent separate compositor uses an opaque GL surface plus transparent
software UI plane at the existing atomic transfer boundary. It records drawing
operations for fallback without re-invoking guest drawing, leases completed images
through asynchronous draws, checks owner generations and reuses the UI texture on
surface-only updates. Unsupported drawing state, clips, multiple surfaces and
transforms fall back to software. Six existing surface/EGL checks (16 assertions)
and typecheck pass, including callback suspension, retained images and pixel equality.

Initial software results exposed expensive full-screen transparent UI blending.
A successor restricts that pass to disjoint outside strips plus conservatively
covered overlays inside the surface. Review caught fractional post-surface clips:
coverage must round outward before integer GL scissors or lose partially covered
edge pixels. The corrected successor is 56a8f0d. Flappy's measured UI coverage is
77760 pixels per presentation versus 2332800 previously, a 96.7% reduction; the
window performs zero guest redraws and reuses the cached plane throughout.

Three alternating 15-second software triplets after warmup still reject both
variants. Five-second diagnostics are excluded from these medians:

| Flappy title | Presentations/s | Change from baseline |
| --- | ---: | ---: |
| Pristine b16d705 | 29.666 | — |
| Separate compositor 630005a | 23.532 | -20.68% |
| UI coverage 56a8f0d | 24.664 | -16.86% |

Their p95 presentation interval worsens to about 69 ms from 35 ms. A separate
Metal sanity triplet gives 59.996/59.999/59.999 presentations/s; TaskDuration is
1.838/1.811/1.780 seconds (only 1.5%/3.2% less), and p50/p95 intervals remain
16.7/~18.6 ms. Retained JS heaps are 161.497/161.544/161.588 MB with no backing-store
growth. There is no large hardware benefit to justify a conditional compositor
trial. All windows stay visible/alive without emulator rendering failures;
external AdMob errors recur on baseline too. Neither replacement is integrated.
The software path, guest timers and main-queue ordering remain unchanged.

### Native correctness before optimization

An unaligned host halfword write across a page boundary left the second page's
executed instruction stale. The canonical byte-range notification now tests every
overlapped executed word/page, retaining the data-only fast path and source-page
epoch checks. Scalar, floating, wide, bulk and string writes share this coverage.
Host libc, stdio, networking, locale and compression writes notify their actual
destination ranges. A follow-up real-WebGL fixture reproduced the remaining GLES
readback hole: two warmed JIT entries spanning a page boundary still returned 1
after GPU readback replaced their MOV instructions with MOV #2. The shared GLES1/3
readback path now computes the destination from pack alignment, row length, skips,
format and type, and notifies each written row. It also fixes GLES1's too-short
padded destination (INVALID_OPERATION on a 1x2 RGBA read with alignment 8) and the
discarded output of unaligned integer reads. The old wrappers return `[1,1]`,
error 1282 and integer zero; the corrected fixture returns `[2,2]`, no error and
0x12345678. The comparison substitutes only the prior GLES wrappers in the same
browser fixture/core, isolating the write path. Typecheck and the existing EGL
browser fixture pass. Evidence: `performance-stages/readback-{compare,test}.log`;
pack semantics follow the [WebGL2 specification](https://registry.khronos.org/webgl/specs/latest/2.0/).

The follow-up allocator audit reproduced stale code after malloc reused an
executed allocation. Allocation reuse, freelist writes, mapping replacement,
commit/decommit, stack reuse and MADV_DONTNEED discards now invalidate affected
code. This covers synchronous initialization of freshly allocated guest objects;
monotonic module and host allocations have distinct ownership.

Independent review of precise ARM effects exposed pre-existing DSP/QADD/BKPT
misrouting into generic ALU emission. These encodings now reach interpreter
fallback before the overlapping halfword-transfer test. An overbroad MSR mask
also classified BX LR as a flag write and lost carry; it now matches the actual
instruction decoder. A compact fixture compares full architectural state across
normal interpreter/JIT execution. Both failures were reproduced before correction.
The integrated correctness-only revision passes typecheck and the full unit suite:
1202 tests, zero failures, 25975 assertions. Broad browser verification remains
part of final integration acceptance.

Seven alternating rounds of ordinary-store component tests found a small host
notification cost (about 0.4–1 ns/store). Tiny JIT loops showed larger percentages
on subnanosecond operations and only 2–3 ms samples; these do not establish app
regressions or gains. Their snapshots predate the allocator/ARM corrections and
must not be used for final-stage attribution. Corrected app candidates share all
correctness fixes before comparing precise register effects and Thumb call exits.
Native evidence and runnable snapshots are under the native worktree's
`webdroid-shots/native-stages/`.

### Selected native stage and rejected register metadata

Three alternating rotations compare pristine, correctness-only, precise effects,
effects plus Thumb calls, and standalone Thumb calls. All use Chromium 151 / ANGLE
Metal / Apple M4 Pro, 1080x2160@480, without probes or competing diagnostic loads.
Startup ends at the second completed GL frame and next presentation: the first
frame is an early splash while roughly nine billion further guest instructions
execute. Screenshots confirm completed title artwork after this boundary.

| Stage | Median title startup | Median native CPU to title | Median retained JS heap |
| --- | ---: | ---: | ---: |
| Pristine b16d705 | 12.887 s | 11.572 s | 180.231 MB |
| Correctness 40b3756 | 13.084 s | 11.766 s | 180.272 MB |
| ARM effects 90d1893 | 12.436 s | 11.128 s | 180.243 MB |
| Effects + calls c74f464 | 9.105 s | 7.796 s | 180.178 MB |
| Standalone calls f9e382a | 9.766 s | 8.447 s | 180.213 MB |

Standalone calls reduce paired startup by 25.38%, 25.05%, 23.77% against correctness
and 24.24%, 24.15%, 23.34% against pristine. This clears the application gate,
although the roughly 1.34x startup / 1.39x native CPU gain misses the aspirational
1.5x target. Effects alone improve paired startup by -2.35%, 4.96%, 5.10%; adding
effects to standalone calls improves it by only 6.11%, 7.75%, 8.85%. The larger
metadata replacement is rejected. The selected change makes existing Thumb BL/BLX
emission reachable, terminates call regions and removes duplicate dead wide guards.

All 15 windows deliver 24/24 inputs, remain visible/alive with advancing ticks and
roughly 120 completed GL frames/presentations per second, and report no observed
missing/native/error entries across four reachable realms. Guest instruction count
to title stays near 10.883 billion. Follow-up windows show the tutorial at score zero,
so they establish rendering health, not sustained gameplay. Raw evidence is
`native-stages/app-results/{0,1,2}-{stage}/run.json`, with reproduction drivers
`app-measure.ts` and `app-rounds.ts` beside it.

Independent review caught a far-call interpreter overlap before final integration:
valid f3c0/f800 BL was decoded as a data instruction and faulted. Successor 0824888
decodes wide branches before overlapping data families, sharing offset decoding
and removing the old unreachable call decoder. A sparse fixture covers five
overlapping prefixes times BL/BLX/B.W, including halfword-offset PC alignment and
full architectural state. Typecheck and 652 core tests / 22178 assertions pass,
including the hardware SIMD oracle. Original timing variants stay immutable;
combined measurements must include this correction.

Two small rendering correctness fixes are retained independently of compositor
experiments. Detached GLSurfaceViews release animation hooks and restore them on
attachment, including pause/WHEN_DIRTY behavior. Window PixelCopy now reads the
displayed canvas: previously it copied an unpresented red producer frame while
green was displayed, then transparent pixels after transfer consumed the producer.
The existing EGL fixture now verifies completed green before presentation and
completed red afterward, without another framebuffer allocation.

### JVM component evidence and application gates

`ce84447` replaces cold generated-source reparsing with explicit operands in the
shared opcode emitter and reuses method preparation for synchronous output.
`b5f81bf` uses dense resumable blocks, splitting at control flow, try boundaries
and suspension and fusing at most eight instructions. Additional fusion is capped
at 1024 templates / 1 MiB source per root runtime, with shared single-instruction
fallback and no eviction. `61ac6b4` returns synchronously until real suspension.
All retain entry-32 promotion and the 32 MiB hot-source admission limit.

The real-DEX fixture covers numeric/null joins, negative zero, exceptions,
multiple suspension points, rejection, thread restoration, reentry, cooperative
backedges and captured entries across cold/hot/promoted/admission-denied tiers.
Explicit constants exposed an existing negative-zero formatting bug, corrected
in both outputs. Generated eager FitNotes/Resy output matches baseline apart
from that intentional correction. Resy cold compilation succeeds for 30589
classes; the fusion cache reaches its cap and correctly falls back. Stage 3
passes 13 core tests / 1378 assertions, typecheck, and FitNotes 39/39 rendered
steps with no observed new emulator diagnostics.

Seven alternating Chromium component rounds, milliseconds:

| Workload | Baseline | Operands | Blocks | Synchronous blocks |
| --- | ---: | ---: | ---: | ---: |
| Construct 2000 real FitNotes bodies | 53.9 | 41.2 | 48.1 | 48.2 |
| Single long cold activation | 52.3 | 52.5 | 21.3 | 21.9 |
| Hot admission denied | 51.2 | 52.9 | 21.3 | 21.9 |
| Promoted control | 6.4 | 6.4 | 6.4 | 6.4 |
| Eager control | 6.6 | 6.4 | 6.4 | 6.4 |

All 140 samples return the same Java int-overflow result. Time-based cooperative
yielding remains active: faster cold execution reaches fewer wall-time deadlines.
Construction is 23.6% faster with explicit operands, and the cold loop is 59.3%
faster with blocks; neither number establishes application responsiveness.
The JVM worktree retains benchmark scripts, raw results and `STAGE-EVIDENCE.md`
under `webdroid-shots/jvm/`. Application windows and final stage decisions follow.

Subsequent review restores sourceURL suffix accounting in the unchanged hot-source
budget (`0830193`, `818ebd9`, `7d60c0e`); the initial refactor had omitted it from
admission while still appending it for Function construction. All four promoted
fixture variants now account for exactly 869 source code units. Component controls
were far below the cap; formal app comparisons use the corrected successors.

The first interaction diagnostics also exposed an input starting exactly at the
15-second boundary. The runner now caps inputs one interval earlier and reports
planned/delivered counts and in-flight state. Formal windows require complete
matching inputs and no in-flight action. Earlier JVM windows are archived as
diagnostics; rendering title timings are unaffected, and its fixed-input windows
remain health/rejection evidence. Revised Mihon Reader windows deliver all 14
swipes with 14 presentation proxies. Separate before/forward/back screenshots
prove actual list movement; its Compose host tree does not expose the item tree.
The first four-stage software round and Metal baseline/synchronous pair are
neutral in main-thread CPU despite roughly 10300 cold calls per window. These
exploratory samples do not yet establish a final stage decision.

Three matched FitNotes Metal rounds do not retain either resumable-block stage:
main-thread CPU medians are 54.15/55.27/54.82/53.78 ms per second for pristine,
operands, blocks and synchronous blocks. A first-round latency-proxy improvement
reverses in subsequent rounds. Resy baseline/synchronous guards render all 13
steps without observed missing APIs, native requirements or emulator errors;
boot is 1025.9/992.9 ms, below the 15% gate. Live availability makes the roughly
130-second full-flow time unsuitable as a performance comparison. Both larger
JVM stages are rejected despite their substantial component-loop improvements.

The FitNotes workload alternates History/Graph 14 times after two saved sets.
Existing coordinate setup misfocuses the weight/repetition fields on both
revisions, recording 10 kg/0 reps and 8 kg/0 reps. Screenshots establish tab
construction and navigation, not populated-graph correctness. Action behavior
matches b16d705; the setup limitation is not introduced by the harness refactor.

Seven alternating pristine/operands pairs resolve an initial CPU outlier:
median CPU 55.28 -> 54.13 ms/s, retained JS heap 172.55 -> 171.83 MB, boot
151.5 -> 139.6 ms. The explicit-operands stage is considered for structural
simplification, not an app-wide speedup. Its input-to-next-presentation proxy
still worsens in five of seven pairs (median 6.8 -> 9.15 ms), so retention is
held for a separate phase-decorrelated guard. Changing input spacing from 1000
to 1003 ms walks through browser frame phases while preserving 14 inputs and
the 15-second window; this is a controlled hypothesis test, not a latency waiver.

Seven alternating 1003-ms pairs then give CPU 54.143 -> 54.873 ms/s (+1.35%),
median proxy 6.95 -> 7.00 ms (+0.72%), median p95 10.635 -> 11.010 ms (+3.53%),
and retained JS heap 172.539 -> 171.857 MB. All 14 windows deliver 14/14 inputs,
with no in-flight action or observed emulator error and 2277 cold calls each.
The small tail cost remains visible: five of seven pairs have higher p95, three
exceed 5%; the aggregate guard stays below 5%. Retain portable operands ca19eb7
(integration 386393a) for simplification and construction cost, with no claimed
latency gain. Pooling all 98 inputs instead of the predefined per-window medians
gives median 6.80 -> 7.20 ms (+5.9%) and p95 10.73 -> 11.215 ms (+4.5%);
this alternative aggregation does not establish zero cost or replace the declared
guard. Raw phase results live in `webdroid-shots/jvm/fitnotes-phase-1003/`
in the JVM worktree. Combined app guards remain separate from this stage decision.

At integrated 39059ba, typecheck passes, all 1208 unit tests pass (26438
assertions), and all six target APKs compile in eager and cold modes with zero
method failures. The eight executed framework exercises pass; Paint.measureText
is skipped without a DOM. Declared framework coverage remains 295/363 entries,
with 68 declared gaps. These checks precede the combined browser matrix.

### Combined integration checks

With production code frozen at 39059ba, three alternating Doodle Metal pairs
retain the startup gain after all selected native, JVM and surface fixes:
pristine 12.529/12.397/12.804 s, integrated 9.739/9.748/9.810 s. Paired reductions
are 22.27%, 21.37%, 23.39%; the median is 12.529 -> 9.748 s (1.29x). Six follow-up
15-second windows deliver 24/24 inputs at roughly 120 completed frames/s,
without an in-flight action. Tutorial median main-thread CPU is 2.724 -> 2.542 s,
retained JS heap 180.21 -> 179.50 MB. Screenshots confirm title completion and
score-zero tutorial state; this still does not establish sustained gameplay.
Main runtime/browser errors are absent. Child realms expose empty missing/native
sets; logs/perf/queue are unavailable, not empty. Evidence and reproduction drivers
are `webdroid-shots/native-stages/combined-results/` and `app-combined-rounds.ts`
in the native worktree. Other combined app guards and the full matrix follow.

The first Lichess engine pair completes all three legal moves and actual native
Stockfish replies on both revisions, including verified editor pawn drags before
game setup. Pristine plays `1.e4 d6 2.Nf3 e5 3.Nxe5 Nh6`; integration plays
`1.e4 b6 2.Nf3 h5 3.Ne5 g6`. Native work is 1.52 versus 2.82 billion instructions,
so CPU 4.36 versus 5.70 seconds is not an equivalent-work regression comparison.
Both reproduce pthread error types 35/22/3 and the optional Sidecar missing API,
with 91/88 browser-console error entries; neither run is error-free. The existing
live-clock, level-one engine flow does not freeze search work. Further engine
timing pairs are stopped in favor of a separate fixed Tools/editor navigation
guard; engine screenshots and exact logs remain in `combined-results/lichess-*`.

Three alternating Tools/editor pairs then complete 14/14 transitions per window,
with no in-flight action and matching final Tools screens. Median main CPU is
6.835 -> 6.712 seconds, per-window median input proxy 106.0 -> 106.4 ms (+0.38%),
median p95 164.0 -> 165.1 ms (+0.67%), retained JS heap 193.65 -> 193.20 MB.
No new diagnostic family appears beyond the reproduced pthread errors and DNS
warning; Sidecar missing matches. Background native work still varies, so this
supports the responsiveness guard, not a native throughput improvement claim.
The native worktree retains `combined-results/lichess-tools-summary.json`,
screenshots, complete diagnostic logs and reproduction commands.

Full-matrix harness 8da8bc2 additionally retains page console errors. This catches
child-process bootstrap/compiler/activity failures that call `console.error`
inside a catch and therefore do not trigger `pageerror`. It supplements bounded
process snapshots without relabeling unavailable child logs or counters as empty.
Harness typecheck passes; production code remains frozen at 39059ba.

Combined FitNotes initially crosses the latency guard in three pairs (median
proxy +5.56%, median p95 +9.07%), so it is extended to seven before retention.
The full seven give CPU 54.895 -> 53.614 ms/s (-2.33%), per-window median proxy
6.45 -> 6.70 ms (+3.88%), median p95 10.935 -> 11.035 ms (+0.91%), retained JS
heap 172.557 -> 171.853 MB. Median proxy worsens in four pairs, p95 in three;
all 14 windows deliver 14 inputs/proxies with no in-flight action and 2277 cold
calls. Observed foreground/browser errors and reported missing/native sets are
empty; child log/performance/queue telemetry remains unavailable. The predefined
seven-pair guard passes, without a latency improvement claim. An exact combined
minus-operands control was identified but is not run because the extended guard
does not establish a repeatable >5% regression under that aggregation. Pooling
all 98 inputs instead gives median 6.25 -> 6.90 ms (+10.4%) and p95
11.215 -> 11.115 ms (-0.9%), with ranges 1.2–12.8/1.2–13.4 ms. The central-latency
conclusion is sensitive to aggregation; the guard passing is not proof of zero
latency cost. Raw results remain in the JVM
worktree under `webdroid-shots/jvm/combined-apps/fitnotes/`.

Combined Mihon Reader-settings swipes also extend from three to seven alternating
pairs because the initial median proxy is +4.49% with mixed directions. The full
seven give CPU 342.599 -> 343.647 ms/s (+0.31%), median proxy 45.70 -> 46.25 ms
(+1.20%), median p95 52.61 -> 52.335 ms (-0.52%), retained JS heap
359.725 -> 354.812 MB. All 14 windows complete 14 swipes without an in-flight
action or observed failure. Median proxy worsens in five pairs and p95 in four;
the aggregate remains within the predefined guard. This is Reader-settings
navigation with verified list movement, not comic decoding or manga playback.
Raw results are beside FitNotes under `combined-apps/mihon-app/`.

Combined Resy Search/Back fails its extended seven-pair median-proxy guard:
6.50 -> 7.70 ms (+18.46%), with all seven paired medians worse. Pooling all
98 inputs also gives 6.75 -> 7.65 ms (+13.33%). Median CPU 204.592 -> 203.626
ms/s, p95 10.985 -> 10.740 ms and heap 387.524 -> 383.522 MB do not override
that failure. All windows complete their 14 inputs; the same upstream service
errors occur on both builds. The next comparison isolates the operand change:
`d2dacb7` has identical combined production source except `src/jvm/cold.ts` and
`src/jvm/compiler.ts`, restored to their preceding implementation. Its server
uses port 4126; root remains on 4110. Both HTML entry-point bundles are prewarmed
before exclusive, alternating measurement. No retention decision is inferred
from the better CPU, p95 or heap results.

The seven-pair minus-operands/current isolation does not establish a clean
acceptance result. Inclusive medians are CPU 203.966 -> 204.516 ms/s, input
opportunity proxy 7.10 -> 7.15 ms and p95 10.580 -> 11.105 ms (+4.96%);
pooled p95 is 10.815 -> 11.790 ms (+9.02%). Control round seven reports an Okio
PriorityQueue index -2 and two Kotlin executor NPEs while processing HTTP/2;
the paired current build has no matching failures. Both still complete inputs
and display the list, which does not excuse those diagnostics. A model-capacity
interruption also separates rounds three and four by 2h29; the live venue slots
advance across that gap. Raw pairs and failures remain in
`.worktrees/perf-jvm/webdroid-shots/jvm/resy-isolation/`.

The ordinary tap helper sends DOWN, waits 60 ms, then sends UP. A 6–8 ms
input-to-next-presentation sample therefore precedes click completion and may
reflect pressed-state feedback or unrelated frame pacing. A supplemental
`--align-presentation` mode waits for a successful screen transfer, then snapshots
counters and time after the presenting call unwinds. It excludes the anchor,
fails after three seconds without a presentation, and changes no guest timing.
It controls initial phase without turning the opportunity proxy into causal
destination latency. Earlier measurements and guard failures remain recorded.
The harness also accepts fixed input offsets and read-only endpoint inspection
for calibrated gameplay; typecheck passes after these harness-only additions.

The aligned seven-pair Resy control completes with all 14 windows healthy and
matching independent/current presentation counts. Baseline/current medians are
CPU 209.505 -> 209.363 ms/s, opportunity proxy 7.30 -> 7.50 ms (+2.74%), p95
11.070 -> 11.320 ms (+2.26%) and JS heap 386.972 -> 383.441 MB. Pooled medians
are 7.20 -> 7.55 ms (+4.86%), p95 11.030 -> 11.505 ms (+4.31%); both per-window
latency measures worsen in five pairs. Anchor waits are 1.0–6.8 ms and the
post-transfer snapshot starts within 0–0.1 ms. This nominal guard passes; it
does not erase the earlier failure, invalid isolation pair or pooled sensitivity.

Final decision: reject explicit operands as well as the block stages. The
construction-only benefit and compiler simplification do not justify uncertain
application latency cost. This is a conservative selection, not a claim that the
aligned guard failed or that operand emission was proven to cause every earlier
regression. Restore `cold.ts` and `compiler.ts` to the preceding implementation,
retaining the independent `litOf(-0)` correction and real DEX tier fixture.
Typecheck, all 1208 tests/26438 assertions, the eight executed framework exercises
and eager/cold compilation of all six APKs pass again. Logs are
`webdroid-shots/performance-stages/final-selected-*`; two initial smoke commands
used the nonexistent `Mihon.apk` filename and were corrected to
`mihon-v0.20.4.apk`, which has zero method failures in both modes.

A separate baseline Doodle Options inspection finds shooting, sound, snow and
tilt calibration controls, with no touch movement mode. The instruction scene
requires tilt; Java and native sensor APIs currently expose no accelerometer
events. No guest state is changed to bypass it. Sustained score-advancing gameplay
remains unverified, separately from the measured completed-title startup gain.
Screenshots and all-process diagnostics are saved in the native worktree under
`webdroid-shots/native-stages/doodle-options/`; observed main/browser diagnostics
are clean, with child log/performance/queue channels still unavailable.

### Final selected-build Flappy checks

Production is frozen at `6cbce0b`; the final harness is `dc5d401`. Two bounded
adaptive calibration attempts per backend sustain 15 seconds of real gameplay
using ordinary taps, advancing scores 0 -> 3 on SwiftShader and 0 -> 9 on Metal.
Their controller work excludes them from performance acceptance. An initial
software fixed replay starts two physics updates earlier despite identical
100 ms waits. The harness therefore gains a read-only exact start-state condition,
using states recorded before comparison, without guest mutation or timing changes.
It waits at most three seconds before in-page counters start; CDP CPU includes
that setup wait and is explicitly wider than the gameplay window.

The second software calibration and fresh baseline replay pass the exact state
condition, but the final build does not reach a sampled exact match before the
deadline. A single state-only diagnostic reproduces it with matching initial
random state and pipe heights; this does not prove a different random seed or
that the unsampled state never existed. Metal fixed baseline replay matches its
starting state but dies at score three despite all 30 taps completing. Adaptive
and replay runs each complete 900 GL callbacks; the first observed physics-state
divergence is around 2.717 seconds with different bird velocity and matching
pipes/random state. Timing sensitivity is observed, not causally isolated.
No targets are retuned, no further adaptive attempts are made, and no formal
gameplay performance comparison is claimed.

Three alternating 15-second title pairs per backend remain valid. SwiftShader
median presentations/s is 29.395689 -> 29.261010 (-0.458%), main TaskDuration
0.239786 -> 0.240842 seconds (+0.440%), p95 interval 35.210 -> 35.800 ms and
JS heap 161.151 -> 161.093 MB. Metal gives 60.064665 -> 59.994800/s (-0.116%),
TaskDuration 1.713650 -> 1.726734 seconds (+0.764%), heap 161.489 -> 161.508 MB.
Metal p95 is 24.700 -> 18.700 ms with variable baseline tails; no gain is claimed.
All twelve windows have zero backing-store growth, correct title screenshots,
visibility/liveness and advancing completed rendering. Observed main diagnostics
and layout/draw/GL failure counters are clear; child GMS log/performance/queue
channels remain unavailable. The browser status TypeError and Metal gmsg errors
occur on both revisions. Full raw evidence and the gameplay proof failures are
under `webdroid-shots/performance-stages/final-flappy/FINAL-REPORT.md`.

After these captures, fourteen verified unused experiment servers are stopped;
only the final root server on 4110 and pristine baseline on 4111 remain for
selected-build native/app guards and the full matrix. Their worktrees and all
stage evidence remain intact; the older baseline worktree is untouched.

Final selected-build native checks repeat against pristine after the operand
rollback. Three Doodle pairs give median completed-title startup 12.880 -> 10.113
seconds (-21.5%), retained heap 180.31 -> 180.20 MB and completed GL/atomic
presentation rate 119.994 -> 119.995/s. Actual presentation p95 remains 9.2 ms.
Secondary rAF p95 is 10.1 -> 10.6 ms (+4.95%); this is retained as a timing limit,
not hidden behind the startup gain. All tutorial input proxies are saved, but do
not establish gameplay latency. Three actual Lichess editor/back pairs give CPU
6.712 -> 6.762 seconds (+0.75%), median opportunity proxy 107.25 -> 106.15 ms,
p95 162.9 -> 163.0 ms and heap 194.511 -> 194.415 MB. Inputs complete without
an in-flight action; existing pthread/Sidecar families and unavailable child
telemetry remain explicit. Evidence is in the native worktree's
`webdroid-shots/native-stages/final-selected-results/REPORT.md`.

A final audit finds that class-init suspension and Java dispatch tests do not
actually exercise native-to-Java re-entry into an active method. One compact
case reuses the real DEX fixture across all four tiers, checking nested prefix/
finally ordering, returned values and initiating-thread restoration. No new
DEX or mock suite is introduced. All five tier cases/442 assertions and
typecheck pass after this test-only change; production remains `6cbce0b`.

Final selected-build FitNotes extends to seven alternating pairs because the
initial tail-latency direction conflicts with later pairs. Median CPU is
55.106 -> 57.307 ms/s (+3.99%), per-window median opportunity proxy
6.65 -> 6.35 ms (-4.51%), p95 10.84 -> 11.10 ms (+2.40%) and JS heap
172.546 -> 172.557 MB. CPU is higher in six of seven pairs, with two individual
pairs above 5%; the aggregate passes but that near-threshold cost remains.
Pooling all 98 inputs gives median 6.65 -> 6.60 ms and p95 11.10 -> 11.10 ms,
with ranges 3.1–12.2 -> 2.8–13.4 ms. All 14 windows complete every input and
have no new observed diagnostics. The existing fixture's saved workouts leave
an empty Graph, so this measures tab navigation rather than populated charts.
Raw pairs and source/harness hashes are in the JVM worktree under
`webdroid-shots/jvm/final-no-operands/fitnotes/`.

Final selected-build Mihon also extends to seven because its first three pairs
put the median proxy near the 5% guard with mixed directions. The complete set
gives CPU 345.341 -> 343.343 ms/s (-0.58%), per-window median proxy
46.70 -> 46.60 ms (-0.21%), p95 53.425 -> 52.775 ms (-1.22%) and JS heap
359.639 -> 359.638 MB. Pooled 98-input median is 47.05 -> 46.60 ms and p95
54.23 -> 53.275 ms. Every input completes in all 14 windows, without new
observed diagnostics. This is Reader-settings scrolling with verified movement,
not comic decoding. Raw evidence is alongside FitNotes in `mihon-app/`.

Final selected-build Resy extends to seven after its third pair reverses both
opportunity-proxy directions. All samples remain included, including pair five's
CPU outlier (+7.20%). Complete medians are CPU 201.392 -> 204.222 ms/s (+1.40%),
per-window median proxy 7.05 -> 6.65 ms (-5.67%), p95 11.25 -> 10.505 ms (-6.62%)
and JS heap 386.983 -> 386.888 MB. Pooled 98-input median is 7.15 -> 6.65 ms,
p95 12.115 -> 10.615 ms and ranges 1.7–16.6 -> 0.9–13.7 ms. All 14 windows
complete 14 inputs, remain visible/alive on Metal, and match independently counted
presentations where the served counter exists. Only the same five upstream
resource failures appear; the earlier isolation's executor failure does not recur
in these windows. This bounded observation does not explain that prior failure.

The saved baseline/candidate Resy trees grow identically from 531 to 542 lines
at pair five, alongside higher CPU in both builds. Matching paired content is
verified, but the live-content period change limits comparisons across the full
set; its causal contribution to CPU is not isolated. Main-window native
instructions/time/slices and JIT regions are zero throughout the final FitNotes,
Mihon and Resy captures. This does not establish zero child-process native work,
whose performance channels remain unavailable. These results describe the
production `6cbce0b` selection; a subsequent native synchronization review is
recorded separately.

### Instruction synchronization after active-region invalidation

Final static review finds a gap beyond byte-range coverage: `code_write` removes
decoded pages and region entries, but a currently executing JIT region can keep
using embedded instructions. Installation epoch checks and later dispatch protect
future entry, not the active region. Existing ARM cacheflush syscall/host exits
already redispatch; inline barriers did not consistently do so.

A compact A64 fixture writes `MOV w0, #2` over a compiled successor, then performs
`DC CVAU; DSB ISH; IC IVAU; DSB ISH; ISB`. This follows
[Arm's cache-maintenance guidance](https://developer.arm.com/community/arm-community-blogs/b/architectures-and-processors-blog/posts/caches-self-modifying-code-implementing-clear-cache):
instruction synchronization must discard previously fetched successor instructions.
The modified line is in the same active region. Both pristine `b16d705` and
selected `1d35eff` reproduce memory containing the new instruction while the JIT
returns 1 and the interpreter returns 2. Both execute eight instructions; the
architectural snapshots differ only in the result register. Clang/llvm-objdump
verifies the encodings. This is experimentally confirmed pre-existing behavior,
not an earlier documented accepted limitation or a regression from range writes.

Isolated candidate `436ba5e` makes ISB a region-discovery endpoint in A64, ARM
and Thumb. The existing exit path finishes the instruction, spills architectural
state and consults current decoded pages before continuing. It adds no checks to
ordinary stores and no mid-instruction writeback exit. The A64 failure passes,
along with compact ARM/Thumb writeback, flags and IT-state companions. Typecheck
and 654 native tests/22192 assertions pass, including the SIMD hardware oracle.
The fast/safe Wasm cores grow by 44/51 bytes. Unsynchronized self-modification is
not promised immediate instruction visibility, and this adds no model of
concurrently executing CPU cores. Evidence is under
`.worktrees/perf-active-invalidation/webdroid-shots/active-invalidation/`.

Doodle compares pristine, the preceding selection and ISB in alternating
three-stage rotations, extending from three to seven because the initial CPU
aggregate conflicts across pairs. Complete medians in that order are title
12.9813 / 10.0727 / 10.0514 seconds; main-window CPU
2.537648 / 2.342727 / 2.386454 seconds; JS heap
180.244 / 180.220 / 180.216 MB. ISB startup is -0.21% incrementally and -22.57%
versus pristine (about 1.29x). CPU is +1.87% incrementally and -5.96% versus
pristine. The seven incremental CPU changes are +1.839%, +8.621%, -0.583%,
-6.683%, -1.173%, +1.867%, -0.115%; the early slowdown is not repeatable.
Actual presentation p95 is 9.2 / 9.1 / 9.1 ms with roughly 120 completed GL
callbacks and atomic presentations per second. Secondary rAF p95 is
10.1 / 10.3 / 10.5 ms. All 21 cases complete 24 inputs with valid rendering
and observed diagnostics; score-zero tutorial limitations and every proxy value
remain recorded. No conditional-ISB successor is implemented because this guard
does not justify another replacement.

During the Lichess follow-up, review catches a summary-only percentile mismatch:
the new helper used `floor(n * .95)`, whereas the preceding native reports used
the lower empirical quantile `floor((n - 1) * .95)`. With 14 inputs these select
the maximum and second-largest sample respectively. The apparent jump from
roughly 163 to 262 ms was therefore not established as a session slowdown: the
earlier raw baseline already contained a 264.6 ms first input. Raw captures are
unchanged, the incorrect derived summary is preserved, and primary comparisons
are recomputed with the original rule. Interpolated p95 and maxima are added as
small-sample sensitivity measures. No acceptance decision uses the changed rule.

Lichess completes three alternating pristine/preceding-selection/ISB rotations.
Main CPU medians are 6.675 / 6.688 / 6.767 seconds; opportunity-proxy medians
105.90 / 108.40 / 107.95 ms; lower empirical p95 166.0 / 165.1 / 168.0 ms;
retained JS heap 194.565 / 194.322 / 194.480 MB. Incremental CPU is +1.19%,
median proxy -0.42%, p95 +1.76% and heap +0.081%; combined CPU is +1.39%,
median +1.94% and p95 +1.20%. Linear p95 and maximum sensitivity also pass.
All 14 inputs stay in the primary comparison, including the slower first Editor
entry; the report separately records Editor and Back distributions. Background
native instruction counts differ, so no engine-throughput result is inferred.
A fresh untimed candidate capture visibly shows Board editor and the subsequent
Tools screen after ordinary Back. Existing pthread/Sidecar diagnostics remain
visible. All 30 formal native captures finish with valid windows and no new
observed diagnostic family; unavailable child channels remain explicitly null.

Retain `436ba5e` as integration `ca2effd`: a reproduced synchronization correctness
fix with passing incremental guards and no ordinary-store check. The earlier
FitNotes/Mihon/Resy/Flappy windows describe `6cbce0b`, not this later Zig delta;
those foreground FitNotes/Mihon/Resy windows execute no native instructions,
without establishing zero child native work. Final full-suite/E2E/corpus checks
follow on the integrated source. Commands, raw captures, all proxy values and
quantile definitions remain in the isolated `active-invalidation/REPORT.md`.

Final integrated typecheck passes with fast/safe cores 292182/305332 bytes.
The complete unit suite passes 1211 tests, zero failures, 26480 assertions across
211 files (47.14 seconds), including the re-entry and ISB fixtures added after
the earlier 1208-test checkpoint. Logs: `webdroid-shots/performance-stages/`
`final-isb-typecheck.log` and `final-isb-unit.log`. Both served main/process
bundles are rebuilt/prewarmed before the final matrix; exact HTML/bundle hashes
are in `final-isb-prewarm.json`. The earlier eight executed framework exercises
and twelve eager/cold APK smoke compilations cover unchanged JVM/framework code.

### Final pristine/integrated matrix and retained outcome

The final production selection is `ca2effd` on `codex/perf-integration`;
`4a27d71` adds documentation only, and both full passes use harness `dc5d401`.
Pristine `b16d705` on port 4111 and candidate on 4110 each complete the serialized
12-flow / 159-step E2E inventory, including four scored flows. Capture durations
are 836.4 and 832.5 seconds; these are not isolated performance measurements.
Both 17-APK corpus passes observe a first shell draw in every row. The comparator
verifies the exact inventories and records 75 items for review rather than
silently calling differences regressions or accepting them. All 318 PNGs have
valid signatures/chunk CRCs, expected geometry and matching readable JSON trees.
Served main/process HTML and asset hashes are unchanged from prewarm through the
final captures. No goldens or production sources change during the matrix.

Evidence is under `webdroid-shots/final-matrix/`: original baseline/candidate
captures and reports, `comparison.json`, `file-integrity.json`, perfsum rollups,
and component review reports. The exact runner is
`.worktrees/perf-rendering/webdroid-shots/final-comparison/final-matrix.sh`.
It runs `WEBDROID_URL=http://localhost:4111 bun tests/e2e/run.ts --jobs 1`,
archives actual/report, runs `bun scripts/corpus.ts --wait 12000 --json ...`,
then repeats against port 4110. Prior output directories remain in `preexisting/`.
Perfsum is run on both saved actual directories with the pristine rollup as the
candidate's comparison argument; its capture-window counters are descriptive.

FitNotes' 39 screenshots/trees and Mihon onboarding's five are byte-identical.
FitNotes still fails the recorded reps input: y531 misses the actual y441–526
field, so typing overwrites the weight and creates zero-rep sets/empty graphs.
Mihon app has identical trees and 15/17 identical images; the remaining images
vary only in the empty-library mascot. Dark selection still leaves the page light
on both. Harmonic reaches the same story/settings/comments/Back paths with changed
live article ordering and counts. Mean golden content differences are
FitNotes 40.1164 → 40.1164%, Mihon app 62.9733 → 63.5324%, onboarding
17.6914 → 17.6914%, Harmonic 28.6448 → 27.0104%. These compare each capture to
Android goldens, not directly to each other; live-content changes and lower scores
do not establish a rendering improvement.

Reddit's trees and welcome screen match, but neither capture proves the intended
signup/login sheets: all postlaunch steps have zero new draws despite advancing
ticks. YouTube repeats SAX namespace-prefixes/RxJava, cursor-cast and ImageView
mapRect failures, two control-step timeouts, and a loading spinner over the video
poster. Its extra unqualified missing-mapRect signature names the same overload;
unchanged cold/runtime error normalization explains the alternate spelling.
TikTok repeats the getGravity layout failure and black Following screen; different
offscreen video subtrees/metadata prevent full-state or video-performance parity
claims. No new observed fault family is found in those full flows.

Lichess visibly executes editor/pawn/Back operations and legal games with engine
replies on both revisions. Pristine additionally faults at address zero in
FairyStockfish `RootMove::extract_ponder_from_tt+0x280`. Its absence in the
candidate's different game does not establish repair or engine throughput.
Doodle remains in the score-zero tilt tutorial. Flappy reaches flight/collision/
Game Over, but the short flow's restart/second-game labels overstate its screenshots.
Both retain the status TypeError, and neither executes native CPU instructions.

Ambiguous visual differences received matching-input follow-ups. Calculator's
apparent button-outline difference was disproved by raw RGBA comparison: only
1–4 edge pixels on the result digits vary across original and repeated pairs,
which all compute 14 with empty observed diagnostics. Resy initially has one
candidate-only duplicate SVG node and offscreen map y5552 versus pristine y4170.
The frozen venue-plus-eight-swipes follow-up puts the map at y5552–5912 on both
revisions, with one SVG per icon. Both scroll-2 steps time out without wedging;
scrolls 3–8 have identical complete trees and map y1398–1758. Screenshots show
the same gray map grid/marker/address, not street tiles. The original duplicate
node does not recur; its cause remains unresolved without a visible effect.
Inputs, failed/timeout observations and raw results remain in `reproductions/`.

Corpus review distinguishes capped row errors from uncapped browser errors and
all available process snapshots. Twitch's original candidate-only getLayoutMap
permission-policy SecurityError occurs naturally in both extended follow-ups;
no keyboard API call was inserted to manufacture parity. Maps starts with zero
completed GL frames in both follow-ups and reaches one by the additional
three-second snapshot. Amazon has five frames in both original rows: the apparent
missing frame is a wrapper URL versus the same target's resolved URL. Neither
fresh follow-up reaches a WebView by the bounded additional six-second snapshot,
so later document-loading parity remains unverified rather than assumed.
The readiness script records actual snapshot times, raw URLs, document/WebView
state, counters, uncapped errors and screenshots in `readiness/`.

All 17 corpus rows are early observed-path coverage, not healthy initialization.
Among Us, Doodle and Lichess stop before completed GL. ChatGPT repeats existing
Sentry DSN, Character.toTitleCase, pointer-size and URI failures. Amazon retains
its existing libcapture/ARM32 native requirement. Child missing/native channels
are read, but null logs/performance/queue and null external-frame diagnostics
remain unavailable. No absence-of-error claim extends to those channels.

The staged work is complete with the measured selections and rejections recorded
above. The universal 1.5x target and sustained-gameplay proof were not achieved;
the strongest retained application result is Doodle's 22.57% faster completed-title
startup, about 1.29x. The native correctness changes, small rendering fixes,
signed-zero correction and corrected measurement harness remain. Rejected JVM,
snapshot/compositor/backing and precise-ARM effects implementations are absent
from production. The existing GLSurfaceView generation race is not claimed fixed.
All isolated experiment evidence and the pre-existing baseline worktree remain
available. No additional tests are run solely for this final documentation update.

Follow-up artifact checks validate another 72 PNGs, for 390 original/follow-up
images. All six readiness browsers and both Resy/Calculator pairs exit normally;
no diagnostic read times out. `review-resolutions.json` links all 75 comparator
items to reviewed evidence and explicit limits. The task's final servers on
4110/4111 are stopped (4112 and older experiment servers were already stopped);
unrelated servers are untouched. Final candidate actual/report copies are restored
to the default E2E output directories while immutable matrix captures and prior
outputs remain archived. The integration worktree contains only the requested
committed changes; generated core blobs and experiment artifacts remain untracked.

## DEX-to-JavaScript tier redesign

Starting revision `5681101` was profiled again for a DEX-specific redesign. The
new work is isolated on `codex/dex-performance-redesign`; raw measurements and
Chrome CPU profiles remain under `/tmp` and are not production artifacts.

Commit `4c3fc28` adds bounded, off-by-default JVM attribution. `?jvmProfile=1`
records at most 8192 methods and attributes decode, CFG, reaching-definition
typing, cold construction, hot emission, Function compilation, class linking,
cold/hot execution and suspension. `wd.perf` owns aggregate counters;
`wd.jvmProfile()` owns method records. `?jvmTier=auto|cold|js|wasm` and the
perf-browser equivalents are diagnostic controls. A requested Wasm tier reports
unavailable and runs auto; it does not fabricate a backend.

Commit `1d4fd34` makes method preparation idempotent and reuses it for synchronous
methods that proceed directly to JS. Seven FitNotes pairs were application-neutral;
hot emission fell about 1.2 ms in the profile. It is retained as a neutral
structural prerequisite.

Commit `bb8abee` adds executed-instruction and backedge heat alongside entry-count
promotion. Grid measurements at 1024, 4096 and 16384 instructions select 4096 as
the lowest stable default. OSR happens only after a real cooperative yield at a
backedge and transfers registers, PC, exception/invocation temporaries, thread and
suspension state into the existing hot switch emitter. The first implementation
retained decoded CFGs for every async method and raised Mihon heap about 5.5%; it
was removed. The retained implementation rebuilds preparation only for methods
that promote, returning heap to within about 0.5%. The real-DEX tier fixture adds
one long single-activation promotion case and preserves captured entry behavior.

Commit `aeae4d3` removes cold source-string regex rewriting. The shared emitter
now emits cold registers, literals, properties, frame temporaries and generator
yields directly. A profiled Mihon launch reduces cold construction from about
428 to 217 ms and compile time from about 1004 to 772 ms. Three initial startup
pairs give FitNotes 236.74 -> 226.66 ms (-4.3%) and Mihon 1179.82 -> 1079.84 ms
(-8.5%), with lower heap.

The current architecture changes the evidence that led the older operand version
to be rolled back. Seven new 1003-ms FitNotes pairs against the preceding OSR
stage give CPU 46.04 -> 40.04 ms/s (-13.0%), per-window median opportunity
5.4 -> 6.5 ms, p95 10.7 -> 10.6 ms, heap 173.33 -> 172.59 MB, and equal
presentation throughput. Three Mihon pairs give CPU 380.40 -> 381.28 ms/s
(+0.23%), median opportunity 39.3 -> 38.7 ms, p95 57.2 -> 53.7 ms, and heap
361.69 -> 356.93 MB. Every input completes and no observed error occurs. The
unfavorable FitNotes central opportunity metric is retained as a limit; the
declared p95 and CPU gates pass.

Commit `80509af` extracts compact preparation into `src/jvm/prepared.ts`. One
ordered instruction array carries decoded operands and finalized reaching-type
annotations; block leaders use a byte array. Numeric opcode metadata replaces the
hot name-regex classifications for termination, register writes, suspension and
floating consumers. The compiler shrinks from 967 to 871 lines. Three pairs
against direct operands alone improve FitNotes startup another 1.6% and Mihon
2.9%, with flat heap. Instrumented Mihon phases change decode 29.0 -> 16.9 ms,
CFG 22.1 -> 12.6 ms, type 249.6 -> 214.6 ms and total compile 790.5 ->
715.3 ms. FitNotes and Mihon eager smoke compilation report zero method failures.

Commit `8238980` extends the same runner with optional Chrome `.cpuprofile` output
and records conservative primitive numeric-loop eligibility. FitNotes has one
eligible 11-instruction method among 3696 recorded methods, but it never executes;
Chrome samples only 18.6 ms / 0.12% generated DEX JS in the window. Mihon has no
eligible method among the capped 8192 records. It samples 3478 ms / 22.4% DEX JS,
but hot methods are object-heavy Compose, collections, property access and
coroutine dispatch. The required 10% eligible share is 0%, so no Wasm backend or
compiler worker is retained. `runCold` self samples are only about 6 ms FitNotes
and 27 ms Mihon per 15 seconds, below the 15% dispatch threshold; prior fused
blocks and new structured emission are not revived.

The final audit finds that Wasm eligibility and several profiler callbacks still
run while profiling is disabled. Commit `ae8b4be` guards that work at preparation,
entry, suspension, backedge and promotion sites. The real-DEX tier fixture remains
green. Because this changes production timing, the complete seven-pair performance
matrix is discarded and repeated; only the corrected matrix below is final.

Other bounded experiments are removed. A sparse array for cold PC dispatch makes
a forced-cold Mihon component window about 12% faster but normal auto execution
only about 0.5%, below the aggregate gate. Skipping apparently irrelevant type
analysis reduces that phase 10–12% but regresses Mihon startup about 0.8%. A
handwritten single-pass cold source pooler is slower (about 455 vs 428 ms).

Final production is compared with `5681101` in seven serial alternating Chrome
pairs per workload. Medians are:

| Workload | Start | Final | Speedup |
| --- | ---: | ---: | ---: |
| FitNotes first usable state | 237.410 ms | 228.104 ms | 1.041x |
| Mihon first usable state | 1180.594 ms | 1031.908 ms | 1.144x |
| FitNotes History/Graph CPU | 50.466 ms/s | 50.337 ms/s | 1.003x |
| Mihon Reader CPU | 377.110 ms/s | 376.654 ms/s | 1.001x |

The four-workload geometric mean is 1.046x. This misses the 1.5x stretch target
but clears the 3% aggregate retention gate. Neither interaction CPU workload
regresses: FitNotes/Mihon improve 0.26%/0.12%. Their p95 opportunity latency
changes +0.90%/+0.74%; interaction heap changes +0.14%/-0.66%. All 196
scheduled inputs complete, rendering advances, and no page or harness error is
observed. Full architecture, research links and evidence limits are in
`docs/dex-performance-architecture.md`.

The final verification runs after freezing production code. Typecheck and 1212
tests / 26483 assertions pass. Twelve eager/cold smoke compilations across
FitNotes, Mihon, Resy, Doodle, Flappy Bird and Lichess report zero failed methods.
All eight runnable framework exercises pass; declared coverage remains 295/363,
with Canvas text metrics skipped outside a browser. FitNotes text comparison is
6/6. The serialized E2E run exits zero with 12 flows / 159 steps, including 39/39
FitNotes and 17/17 Mihon app rendering. The 17-APK corpus renders a first frame for
17/17 APKs; FitNotes and Mihon reach no missing APIs.

The E2E performance rollup is descriptive because flow durations include settling,
live content and native/rendering work. Against the starting runtime capture, its
compiler counters still show the intended broad effect: FitNotes -21%, Mihon app
-27%, Mihon onboarding -28%, Calculator -24%, Harmonic -26%, Reddit -27%, Resy
-23%, YouTube -28%, TikTok -30%, Lichess -28%, Flappy -30% and Doodle -22%.
No flow wedges. FitNotes and Mihon app have no new missing APIs, Java/page errors,
native requirements, or layout/draw/GL errors. The remaining flows reproduce the
recorded platform and app limitations: Window sidecar/extension gaps, YouTube
Matrix/SAX/cursor failures and two control-settle timeouts, TikTok getGravity and
native log failures, Lichess pthread/Stockfish faults, optional Reddit SDK gaps,
and the existing status TypeError attributed to the following Flappy capture.

## 2026-09-14: strict DEX maintainability follow-up

A thermo-nuclear review after the performance redesign found five structural or
observability defects. Commit `542e575` derives sibling screenshot and CPU-profile
paths with `node:path`, so an output name without a `.json` suffix cannot make the
CPU profile overwrite the primary result. Commit `eb21f75` addresses the runtime
findings:

- `prepareMethod` now owns decode, CFG construction, reaching definitions, type
  annotations, and eligibility as one explicit `PreparedMethod` boundary. Cold and
  hot emitters consume it without a stateful compiler/preparation facade; the main
  compiler shrinks from 880 to 715 lines.
- OSR compilation returns a typed `{ invoke, resume }` artifact. Resumption uses an
  explicit generated frame formal and one cold-frame suspension state, removing the
  `arguments.length` protocol, untyped `Function` state, and duplicate `$osrS`.
- Generated hot methods profile their complete async lifetime and installed direct
  entries. Suspension count/time is recorded in the hot tier, active-time estimates
  subtract suspension from both cold and hot duration, and class linking updates
  only its aggregate counter instead of consuming the 8,192 method-record cap.

The first boundary implementation retained each initial prepared method because
the promotion closure read `prepared.params.length`. A three-pair FitNotes check
showed about +5% retained heap. Capturing only the scalar parameter count removes
that reachability; the discarded measurements are not used for acceptance.

The frozen follow-up is compared with preceding production revision `f32bb4f` in
serial alternating Metal runs. FitNotes extends from seven to fifteen pairs after
its initial median p95 crossed the 5% guard; Mihon uses seven pairs. Every window
completes 14/14 inputs, remains visible/alive, advances ticks and presentations,
uses ANGLE Metal, and reports no app, process, or harness diagnostics.

| Workload | Pre-follow-up | Follow-up | Change |
| --- | ---: | ---: | ---: |
| FitNotes launch action | 231.652 ms | 231.463 ms | -0.08% |
| FitNotes interaction CPU | 51.989 ms/s | 53.687 ms/s | +3.27% |
| FitNotes median window p95 | 10.735 ms | 10.735 ms | 0.00% |
| FitNotes post-GC heap | 162.890 MB | 163.921 MB | +0.63% |
| Mihon launch action | 996.918 ms | 997.709 ms | +0.08% |
| Mihon interaction CPU | 348.749 ms/s | 345.115 ms/s | -1.04% |
| Mihon median window p95 | 52.700 ms | 52.160 ms | -1.02% |
| Mihon post-GC heap | 319.917 MB | 322.544 MB | +0.82% |

FitNotes CPU crosses a bimodal host-load phase during the long series; its median
paired change is +1.40%, while the declared raw-median change remains +3.27% and
below the 5% global guard. Pooled p95 changes +0.93% for FitNotes and +0.06% for
Mihon. All samples are retained in ignored output under
`webdroid-shots/jvm-quality-followup/retained/`.

Final checks run after production freezes: typecheck; 1213 tests / 26489
assertions; 12 eager/cold compilations across FitNotes, Mihon, Resy, Doodle,
Flappy Bird and Lichess with zero method failures; eight runnable framework
exercises; FitNotes text parity 6/6; serialized E2E exit zero for 12 flows / 159
steps; and corpus 17/17. FitNotes renders 39/39 and Mihon app 17/17 without a new
diagnostic. The full matrix sees one historically observed Resy OkHttp timeout
executor exception; matched baseline and candidate repeats both render 13/13
without reproducing it, so it is retained as a live-network outlier rather than a
regression waiver.

## 2026-09-14: zlib checksums in the Wasm core

Commit `d8fde0a` binds the existing `libz.so` `crc32` and `adler32` exports to the
native core. Guest calls now read guest memory and update their incremental state
inside the same Wasm invocation instead of exiting through the JavaScript host
dispatcher. Null-buffer seed behavior remains compatible with the existing zlib
delegates. Browser-side inflate/deflate still needs the JavaScript helpers, so
those are not duplicate dead code. Doodle Jump contains an unresolved `crc32`
import; its observed startup window did not call it, so that import is reachability
evidence rather than an application-level performance measurement.

The CRC uses a generated slicing-by-8 table. The Zig standard library's byte-at-a-
time CRC was about 15% slower than the JavaScript delegate in a Chrome kernel
benchmark and was discarded. Slicing-by-4 reduced the shipped core by about 4.2
KiB but reduced large-buffer CRC speedup from about 3.5x to 2.5x, so it was also
discarded. The retained ReleaseFast core is 302,133 bytes versus 292,182 bytes at
the starting revision: +9,951 bytes (+3.4%).

Headless Chrome medians include alternating order and warmup. Direct checksum
kernel throughput at 4 KiB / 64 KiB / 1 MiB is about 3.50x / 3.51x / 3.52x the
JavaScript CRC and 8.26x / 8.30x / 8.36x the JavaScript Adler implementation. A
second benchmark drives the actual guest trampoline. Avoiding the Wasm-to-JS host
exit is already faster for one-byte calls; at 4 KiB / 64 KiB / 1 MiB, CRC is
2.91x / 3.49x / 3.67x faster and Adler is 5.82x / 8.41x / 8.81x faster. These are
isolated checksum measurements, not whole-application speedups. The benchmark
sources and raw output were temporary worktree artifacts and are not committed.

Final verification after production code froze: typecheck; 1214 tests / 26494
assertions; ARM32 Doodle Jump and ARM64 Lichess eager smoke compilation with zero
method failures; and all eight runnable framework exercises. The serialized E2E
run exits zero for 12 flows / 159 steps. All steps render, no main loop wedges and
no native requirement or checksum fault is reported. Its two YouTube settle
timeouts and the existing TikTok, YouTube, Lichess and window-extension
diagnostics match the recorded platform limits rather than this dispatch change.
## 2026-09-14: Android API 33 and graphics fuzzing

Commits `d8b9fff` through `955d0ed` add an API-33 compatibility oracle without replacing the
repository's API-35 framework pair. The ignored `fuzz-cache/android-33` holds the matching platform
artifacts and the `webdroid_api33_ref` AVD runs at 1080x2160, 480 dpi. One dependency-free probe APK
targets SDK 33, fetches typed cases from a loopback service, and posts normalized results. Android
reaches the service through `adb reverse`; webdroid routes the same `HttpURLConnection` request
through its normal proxy. The APK is byte-for-byte unchanged between platforms.

The public-only catalog contains 78,776 API-33 declarations: 5,782 classes, 44,370 methods, and
28,624 fields. Classification reports 14,432 delegates, 960 explicit placeholders, 38,949 members
available through matching framework bytecode, 21,253 missing members, and 3,182 declarations
already absent at API 33. Twenty-three members are currently exercised by explicit safe recipes.
The full corpus pass additionally records every reached hidden/internal class, method, and field;
those entries are reachability evidence, not a private-framework compatibility promise.

API and graphics cases carry `schemaVersion: 1`, a printed seed, typed arguments, and bounded
command sequences. Results normalize primitive/object values, exception class names, arrays,
state, and PNG pixels. Graphics covers Bitmap, Canvas, Paint, Path, Matrix, Drawable, RenderNode,
text, blend modes, clipping, transforms, density, save/restore, and basic View layout. State is
exact; pixels use the existing tolerant and content-aware metrics. Sequence deletion and argument
shrinking are bounded, and a minimized failure is retained only after two matching replays.

The oracle found three broad runtime defects. API 33 rejects `transparent` in `Color.parseColor`
and accepts only Android's named colors plus six/eight digit hex. Paint stroke cap/join getters
were placeholders rather than state. Canvas arc/round-rect and clip operations mishandled inverted
bounds. Each correction is isolated in a graphics commit and subsequent fixed API cases agree.
Remaining graphics state/pixel differences are retained as campaign findings rather than hidden or
used to make the normal suite platform-antialiasing-sensitive.

`?fuzzCoverage=1` instruments generated JVM methods at generation time, including child process
realms. Disabled output has neither a probe nor a per-call condition. The semantic UI fuzzer derives
enabled tap, edit, and scroll actions from Android hierarchy nodes, records stable identity and
normalized coordinates, and stops when structural divergence invalidates replay. Back, enter,
background/resume, configuration changes, and a recorded coordinate fallback cover non-node state.
Every retained UI state includes tree/frame hashes, screenshots and tolerant diffs when an oracle
is present, coverage delta, browser errors, unread attributes, missing/native APIs, queue state,
compositor state, and layout/draw/GL counters from every reachable process. Missing child telemetry
is a harness failure. A live Calculator campaign detected, minimized, persisted, and replayed an
Android/webdroid semantic-target divergence twice.

`bun run fuzz smoke` injects one deterministic mismatch into each API, graphics, and UI comparison
layer. Each is found, minimized, written under ignored `fuzz-results/smoke`, and replayed twice; the
public replay command can replay all three bundles. These injections test the harness only and are
never present in a production or differential campaign.

Evidence limits remain explicit. Exhaustive inventory is not exhaustive behavioral invocation;
stateful APIs require recipes. Pixel clustering does not declare distinct rasterization correct.
UI hierarchy identity depends on accessibility information exported by the application. Long
1,000-case and full-corpus campaigns remain manual and bounded, while normal verification uses
small deterministic seeds. The strict whole-tree maintainability findings and rejected churn are
recorded in `docs/code-quality-audit-2026-09.md`.

The frozen full catalog contains 148,937 public and reached declarations: 19,488 delegates,
1,596 explicit placeholders, 94,376 framework-bytecode candidates, 30,295 missing members, and
3,182 API-33-absent members. The public subset remains the 78,776-member count above; the added
70,161 entries are corpus/framework reachability evidence. Canonical support resolution also
recognizes direct JNI registrations, restoring `fwtest` to 295/363 declared natives after an
integration test exposed the omission. Corpus collection now identifies process frames by their
webdroid URL contract, so third-party web-content frames are not mislabeled as missing Android
telemetry.

Final acceptance used seed `1592594996`. All 64 API cases agree. Of 24 graphics cases, 23 expose
differences and minimize into three stable clusters: a state value mismatch, an exception mismatch,
and a material pixel mismatch (2.51% tolerant full-frame difference and 50.74% content difference).
All three retained bundles reproduce twice, including the pixel bundle through the public replay
command. The live Calculator UI oracle also finds, minimizes, persists, and twice replays a missing
semantic target. The injected API, graphics, and UI smoke failures are independently detected,
minimized, and twice replayed.

The unchanged probe APK and the affected FitNotes and Calculator APKs smoke-compile with zero method
failures. Typecheck passes; 1,222 tests with 26,563 assertions pass; all eight runnable framework
exercises pass; and FitNotes text comparison is 6/6. Serialized E2E exits zero after 12 flows and
842.3 seconds, with FitNotes rendering 39/39 steps and Mihon app 17/17. No visual golden changes are
made. The 18-APK corpus renders 18/18 first frames and ranks 44 distinct compatibility gaps. All 59
actual main/child process frames have ticks, queue, performance, error, and coverage diagnostics;
the four excluded Twitch descendants are web content rather than Android processes. FitNotes,
Calculator, the fuzz probe, and Mihon report no missing APIs on their observed corpus paths.

Five serial alternating Calculator pairs compare the starting commit with the frozen runtime.
Median launch action changes from 572.462 ms to 573.625 ms (+0.20%), while browser task duration
changes from 292.117 ms to 289.975 ms (-0.73%). Both declared primary metrics remain inside the 3%
retention gate. Every sample remains visible and alive, completes input, advances rendering, and
reports no errors. Single-counter input, compilation, frame, and draw timings remain descriptive;
their small sample variance is not promoted into an additional acceptance gate.

The full E2E and corpus runs retain known platform findings rather than concealing them: TikTok
layout/log gaps, YouTube Matrix/captioning/SAX failures and two settle timeouts, Lichess native
pthread faults, and the Mihon onboarding page error. They are reproducible compatibility backlog,
not evidence that the harness failed. Exhaustive catalog classification therefore closes this task;
exhaustive behavioral coverage continues to depend on adding safe, explicit recipes and running
larger manual campaigns.

## 2026-09-14: strict fuzz-harness maintainability follow-up

The post-delivery thermo-nuclear review identified six harness defects rather than cosmetic nits.
Implementation commits `372210d` through `e14d30a` resolve them without changing Android
compatibility semantics. With fuzz routing disabled, the server returns before URL parsing, so the
test-only endpoint rewrite adds no work to ordinary proxy requests.

Failure persistence is now atomic: original and minimized cases each own the exact pair of outputs
that produced their failure, and every bundle includes two matching minimized observations. UI
bundles retain the minimized run's telemetry and screenshots instead of attaching original-run
evidence to a shorter action list. Replay validates these wire shapes before execution.

Graphics operations are an exact discriminated union rather than an open string and primitive
array. The validator enforces operation-specific arity, primitive types, and enum domains. An
exhaustive operation manifest is checked against the Java probe switch. Failure comparison uses a
stable reproduction key while retained fingerprints add differing state fields and the minimized
operation shape, preventing unrelated graphics failures from collapsing into two global buckets.

Executable API recipes now own the member list used by inventory classification. UI platform
mechanics moved behind Android and webdroid targets, and the golden recorder and fuzzer share one
hierarchy parser. Per-process diagnostics use tagged states, so an unavailable or timed-out child
cannot masquerade as an empty successful result.

Campaign resources are isolated. Case and dev servers select dynamic ports, staged APK directories
are private and removed during cleanup, and each dev server privately rewrites the unchanged
probe's loopback endpoint to its own case server. Two simultaneous webdroid probes completed on
distinct origins. Differential campaigns install the probe once per oracle, reuse one webdroid
session across batches, and execute the independent platform runs concurrently. A three-batch
focused run reused one origin and returned the expected ordered result each time.

Focused verification covered strict TypeScript, protocol/catalog/semantic tests, injected smoke
and replay, a live one-step FitNotes UI campaign with three successful process snapshots, one live
webdroid probe, two concurrent probes, and three sequential batches on a reused session.

The frozen follow-up passes typecheck and 1,225 tests with 26,572 assertions. FitNotes, Calculator,
and the unchanged fuzz probe smoke-compile with zero method failures; all eight runnable framework
exercises pass with 295/363 registered native methods covered. Fixed seed `1592594996` produces
0/64 API differences and 23/24 graphics differences. The corrected retained identity separates the
graphics results into 20 minimized clusters instead of the previous three coarse global buckets;
the material pixel bundle reproduces twice through the public replay command.

The API-33 Calculator UI differential finds the same missing semantic target on its original run,
minimized run, both stored reproductions, and a fresh public replay. Its captured foreground and two
child-process snapshots all report tagged `ok` diagnostics. FitNotes text comparison remains 6/6.
Serialized E2E passes all 12 flows in 845.8 seconds, including FitNotes 39/39 and Mihon app 17/17,
without golden changes. The full corpus renders 18/18 first frames and retains 44 compatibility
gaps: 59 Android process snapshots report `ok`, four excluded Twitch web-content frames report
`unavailable`, and none report a telemetry failure. The follow-up changes no production JVM,
graphics, or generated call site, so the preceding five-pair +0.20% launch and -0.73% browser-task
performance evidence remains the applicable 3% retention check.

## 2026-09-15: Subway Surfers signal and ETC2 compatibility

Subway Surfers reached its Unity age gate, but the visible layers were black and the player loop
eventually stopped consuming input. The unchanged IL2CPP runtime exposed two register-ownership
races in GC stop-the-world signaling. A new pthread was signalable before its deferred start
routine ran, so a signal handler could claim the base register file while the routine started on
the same CPU. Separately, `Cpu.run()` decremented its loop count before `Cpu.call()` restored its
saved frame; the signal pump treated that teardown interval as idle and could install a handler
into registers that the exiting call then overwrote.

Native entry now waits for a queued base signal, pthread startup observes the same ownership gate,
and the pump requires both zero run loops and zero call depth before base delivery. Focused ARM32
and A64 cases cover a signal queued before base entry and a signal arriving during call teardown.
In the game, repeated IL2CPP suspend signal 30 and resume signal 24 sequences then completed with
no handler left pending or parked, and rendering ticks continued advancing. The original Unity
age slider changed value and Confirm advanced to loading, establishing real input consumption
rather than a synthetic success path.

The black layers were independent. Chrome rejected Unity's `0x9274` RGB8 ETC2 and `0x9278` RGBA8
ETC2/EAC uploads, including immutable texture storage. OpenGL ES 3 exposes those formats as core,
so Unity did not first query an extension. WebGL2 advertised the formats only after
`WEBGL_compressed_texture_etc` was activated. The GLES3 bridge now activates that extension lazily
once per context when an ETC2/EAC format reaches compressed upload or texture storage. The check
does not touch ordinary texture calls and adds no draw-loop work.

A fresh Chrome run rendered the complete age scene, Subway Surfers loading art, Buenos Aires main
menu, and live 3D gameplay. Its 12,400 frames all completed, with 6,283 GL frames and zero GL,
layout, or draw errors. UnityMain's log showed ten completed suspend/resume signal pairs, with no
CPU left handling, waiting for, or holding a pending signal. The observed path required no missing
native entry point. Optional shortcut, ad-loader, Firebase, analytics, billing, and other service
lookups still report unavailable; the game tolerates them, and this change does not fabricate
those capabilities.

Final verification passes typecheck and 1,230 tests with 26,584 assertions. The unchanged Subway
Surfers APK smoke-compiles 65,029 bodies-bearing classes with zero method failures. All eight
runnable framework exercises pass with 295/363 declared native methods covered, and FitNotes text
comparison remains 6/6. Serialized E2E completes all 12 flows in 818.9 seconds with no wedged main
loop and no GL errors; it retains the two known YouTube settle timeouts and documented
TikTok/YouTube/Lichess findings. The corpus renders 20/20 first frames, including Subway Surfers,
and retains 46 distinct compatibility gaps. No visual golden changes are made.

This evidence covers the exercised game path; it does not claim that unrelated optional Unity
services or every compressed texture family are implemented.

### Thermo-nuclear maintainability follow-up

The strict branch review found no application package, class, asset, or behavior check in
production source. Both fixes are platform policies: every CPU uses the same register-ownership
rules, and every WebGL2 GLES3 context activates the complete core ETC2/EAC format range when that
range is used. The game name remains only in task and evidence documentation.

The first scheduler fix repeated the zero-loop/zero-depth predicate and bounced a pending base
signal through `queueMicrotask` before waiting for it. A single `baseAvailable` invariant now owns
that state, and `awaitIdleBase` directly takes and awaits a deliverable signal. Signal frame labels
also use one predicate rather than scattered string-prefix checks. This removes the polling state
without changing parked-handler delivery or slice-boundary delivery.

The first graphics fix layered a pass-through context helper over an ETC2 activation helper and
left the format bounds as unexplained literals. One `glForTextureFormat` policy now obtains the
current context, recognizes the named GLES range, and performs the once-per-context activation.
No generalized extension registry is added: ETC2/EAC is the GLES3-core compressed family, while
ASTC, S3TC, PVRTC, and RGTC remain correctly governed by their extension contracts.

No touched source file approaches the review's 1,000-line threshold: after the cleanup `cpu.ts`
is 572 lines, `pthread.ts` 354, `gles3.ts` 766, and the focused CPU test file 179. No new cast,
optional mode, app flag, dependency, or test is introduced. A fresh isolated Chrome context again
rendered the age gate, accepted its original controls, and reached live gameplay with 3,340/3,340
completed frames, 1,175 GL frames, zero GL/layout/draw errors, and no pending or active signal.

The post-cleanup matrix passes: typecheck; 1,230 unit tests with 26,584 assertions; a 65,029-class
Subway Surfers smoke compile with zero method failures; framework coverage at 295/363 declared
natives with all eight runnable exercises passing; and 6/6 text-layout comparisons. The serialized
12-flow browser suite finishes in 823.3 seconds, with no wedged step, required native delegate, GL
error, or process whose completed-frame count trails its frame count. It retains the established
TikTok layout delegate errors, YouTube's two settle timeouts and draw gap, Lichess's Flutter pthread
limits, and Mihon's terminal onboarding page error. The corpus renders 20/20 APKs and reports 45
distinct existing gaps. No visual golden is changed.

## 2026-09-15: trace-directed fast testing

The deterministic development lane now reuses all 82 actions in the six fixed-input flows. Steps
declare state, quiescent, logical-sample, or live completion instead of the former timing flags.
Fast semantic steps retain process diagnostics, errors, liveness, counters, presentation identity,
and a frame hash without PNG readback; stable named checkpoints retain pixels and compare against
the starting revision's visual limits. Any failure reruns the complete flow with full artifacts.

Android-visible Handler/Looper, executor, alarm, animation, lifecycle, input, Java sleep/park, and
native monotonic timing share a stable controlled deadline heap across same-origin process realms.
Host measurements, network, WebSocket, WebGL, media, and persistence time remain real. Mihon's
Compose startup and the two native GL games did not preserve their observed screens under logical
time, so those flows deliberately keep fixed `Date` with real scheduling rather than accepting a
faster but different state.

Three frozen serialized candidate runs complete 82/82 actions in 85.7, 85.8, and 86.2 seconds.
Their 85.8-second median is 30.2% below the retained 123.0-second artifact. The lane writes 6.0 MiB
across 22 files by default versus 64 MiB, with no new runtime
missing APIs, native requirements, errors, or wedges. The 45-second stretch target is not reached;
the retained improvement clears the plan's 20% fallback gate, and native game sampling accounts for
roughly 47 of the remaining seconds.

Chrome precise coverage is collected only by the explicit coverage command. Bun's bundled scripts
are mapped back to repository files through their source maps; the always-executed bundle wrapper is
excluded. The compact index records its source revision, flow schema, APK hashes, screen, browser,
and mode. Focused selection expands dependencies through the TypeScript import graph and widens to
the complete deterministic lane for missing, partial, changed-fixture, uncovered, or critical-root
inputs. V8 instrumentation starves Doodle Jump's long-running native main-loop job, so that flow is
executed uninstrumented and recorded as unsupported; files without sound coverage widen safely.
Coverage is absent from normal and performance runs.

The committed index covers all six deterministic flows and maps 167 repository source files;
Doodle Jump is explicitly unsupported by V8 instrumentation and therefore widens rather than
claiming incomplete coverage. A representative `src/android/sqlite.ts` selection runs 262 owning
unit tests and five selected fast flows in 20.1 seconds. Unknown, stale, generated, critical-root,
and uninstrumented inputs select the complete deterministic lane.

Final verification passes typecheck and 1,232 tests with 26,589 assertions. FitNotes, Mihon,
Flappy Bird, Calculator, and Doodle Jump smoke-compile with zero method failures; all eight runnable
framework exercises pass with 295/363 declared natives covered; and FitNotes text comparison is
6/6. The real-time browser matrix completes all 12 flows and 159 steps in 812.1 seconds with no
wedged main loop or required native delegate and no golden changes. It retains the two known
YouTube settle timeouts and established TikTok, YouTube, Lichess, and Mihon findings. The corpus
renders 20/20 APKs and retains 45 distinct gaps.

Three serial alternating Calculator pairs compare starting revision `e75c7c5` with the frozen
candidate using 15-second windows, a three-second warmup, and the established phase-decorrelated
1,003 ms input cadence. Median launch action is 612.12 -> 605.62 ms (-1.06%), main renderer
TaskDuration is 90.21 -> 89.69 ms/s (-0.57%), p95 input-to-next-presentation opportunity is 14.5
-> 14.4 ms (-0.69%), and post-GC heap is 207.83 -> 208.08 MiB (+0.12%). All six windows complete
14/14 inputs, remain visible and alive, advance ticks and presentations, and report no page or
action error. An initial exact-1,000 ms triplet produced 10.0 -> 12.1 ms p95 because the inputs
repeatedly sampled the same frame phase; it is not mixed into the phase-decorrelated acceptance
series and remains an explicit sensitivity limit. Production mode carries neither controlled time
nor precise-coverage collection.

### Thermo-nuclear testing follow-up

The strict review found that the first fast lane recorded evidence it did not enforce. Fast visual
assertions now live on their owning step and always carry a numeric limit; a missing manifest,
manifest step, golden, or actual capture is a failure. Motion checkpoints run serially and fail
below their declared rate. Unmatched page and console errors also fail the lane. Flappy Bird's
existing `status` page error is retained as an explicit substring allowlist instead of being
silently discarded. Calculator has no golden, so its former unscored checkpoint declaration was
removed rather than represented as visual evidence.

The page probe now receives the `WaitPolicy` union unchanged. Action, horizon, and liveness work
share the guest clock's `advanceBy` and `drive` operations instead of maintaining three subtly
different deadline loops. State completion requires its condition, a successful main-queue
sentinel, and a newly presented frame; failure of any tier produces a timeout reason. Process
realms cancel every owned one-shot and repeating guest timer on unload, including an interval
whose callback is executing during disposal.

Coverage fingerprints now include the complete canonical flow definition, including action
payloads, conditions, timeouts, masks, screens, and evidence. The selector validates JSON at the
boundary, APK hashes, resolved golden screens, unsupported-flow membership, and every relevant
source change since the recorded revision. Bun's parser supplies static and literal dynamic import
edges across runtime, test, script, and generated-vendor roots. Any incomplete graph or invalid
index widens with a visible reason. Source changes also select every instrumentation-unsupported
flow, which closes Doodle Jump's previous false-negative path. Git discovery uses the explicit
`GIT` environment variable or normal executable lookup; no machine-private path remains.

Focused verification passes typecheck and five ownership tests. The enforced visual lane passes
FitNotes and both Mihon flows; isolated motion passes Flappy Bird at 46/28 fps and Doodle Jump at
67/37 fps in the first focused run. A complete three-worker coverage refresh passes all six
deterministic flows in 68.3 seconds and records 167 source files, all six screens, and Doodle Jump
as unsupported. The regenerated index points at the exact source commit and its complete schema
hash. The known Flappy Bird page error remains an unresolved runtime defect outside this harness
hardening; it is now visible and narrowly declared.

The frozen final matrix passes typecheck and 1,235 tests with 26,596 assertions. FitNotes, Mihon,
Flappy Bird, Calculator, and Doodle Jump smoke-compile with zero method failures; all eight runnable
framework exercises pass at 295/363 declared natives, and text comparison remains 6/6. The
serialized real-time E2E run completes all 12 flows and 159 steps in 804.7 seconds with no wedged
main loop, required native delegate, or frame-completion lag. All 524 available process snapshots
report `ok`; 12 excluded web-content frames report `unavailable`. It retains only the two known
YouTube settle timeouts and the documented live-app errors. The corpus renders 20/20 APKs and
reports 46 current compatibility gaps. No visual golden is changed.


## 2026-09-21 — staged fuzz-audit integration with a CPU gate

Extracted from `1bb72551` against frozen main `02aec2c1`. Retained faster UTF-16 conversion,
ancestor layout-flag propagation without duplicate parent callbacks, and awaited UI-tree
capture. Final production revision `bccf7ff3`, tree `ca0a097592e72aa527b97c1f20c14811c8155bad`.
Three alternating pairs per workload: renderer-thread/process CPU changes -4.63%/-1.80%
for FitNotes and -1.39%/+0.91% for Mihon; post-merge checks also stay below +5%.

Do not restore the discarded dialog or layout-replay assumptions. Bundled AOSP
`Activity.onDestroy` dismisses managed dialogs; general `WindowManagerGlobal` cleanup
removes leaked windows without calling `Dialog.dismiss`. `ViewRootImpl` filters first-pass
layout requesters by the surviving FORCE_LAYOUT flag; `View.layout` clears that flag.
A browser probe that merely confirms a proposed callback or extra measure is not Android
parity evidence. The first dialog extraction and unconditional replay were withdrawn.

Typecheck, 1,237 tests, zero-method-failure FitNotes compilation and 6/6 text parity pass.
Framework coverage remains 295/363. Full E2E completes 159 steps with zero wedges or action
failures and 524 successful process snapshots. Two YouTube quiescence timeouts occur during
actual playback; fresh main stays on home at those same player steps, so its lack of timeouts
is not equivalent player coverage. Caption fields and existing SAX/matrix gaps remain;
video-control correctness and comparative playback CPU are not established by this run.
The broad API/ownership and software-renderer expansion remains deferred.

See [the integration ledger](fuzz-integration.md) for every merge, withdrawal, CPU samples,
visual comparisons, evidence paths and limitations. No golden changed.

### 2026-09-21 — TikTok platform recovery and regression validation

Starting `9071fec7`, full Chrome reproduces the black guest feed at 1080×2160/480 dpi.
Video metadata arrives, but RelativeLayout.getGravity repeatedly aborts layout. Once supplied,
getIgnoreGravity is the next reached failure. The bundled API 35 framework DEX establishes
START|TOP defaults, gravity normalization/invalidation, ignore-gravity state and the distinct
RelativeLayout/ MarginLayoutParams copy overloads. The typed copy owns its rule array; the
base LayoutParams overload copies size only. Shared margin copying now has one owner.

The next visible fault is wrap-content centering against the parent's AT_MOST limit: a
72 px engagement count gives its wrapper a 594 px width on a 1080 px screen. AOSP's
positionChildHorizontal/Vertical defer centering until wrap-content measurement finishes.
The delegate now does likewise and respects minimum sizes. Existing layout coverage includes
independent rule copies and one core centered-wrap measurement case. Nine owning layout tests
pass. TikTok's 462,058 methods smoke-compile with zero method failures.

Chrome reaches real video after removing the layout failures; screenshot/interaction parity
and performance remain under investigation. Evidence is under `webdroid-shots/tiktok-parity/`.
The API 33 AVD runs the unchanged APK, completed guest onboarding and plays its live feed.

Additional reached failures repaired during paired guest navigation:

- SensorManager.getOrientation now computes both supported rotation-matrix layouts from the
  bundled framework formulas. ClickableSpan/URLSpan inherit CharacterStyle and apply link
  color/underline through virtual Paint methods; styled text retains TextPaint fields.
- Search construction required insertion action-mode callbacks, transition names/groups,
  PhoneWindow enter/exit transition state, Message.getTarget and MeasureSpec.toString.
- Programmatic START/END rules were ignored. RelativeLayout now resolves them by direction,
  follows a GONE anchor's same-rule chain (AOSP getRelatedView), and retains widths fixed by
  opposing edges during its final MATCH_PARENT pass. The search input now ends at x=835,
  beside the button, rather than overflowing to x=1230. AVD's corresponding edge is x=834.
- Context exposed a plain ClassLoader, so TikTok's BaseDexClassLoader cast stopped Zoin
  decompression. Startup now owns a PathClassLoader; findLibrary uses its owning runtime and
  materializes a readable, archive-scoped path on demand. The unmodified Zoin native decoder
  verifies all four lynxsuit outputs and loads liblynx.so. No Lynx JNI substitutes were added.
- Java File.renameTo only moved files, whereas native rename already handled directory trees.
  Sharing renamePath removes that mismatch: the downloaded search template now reports a
  successful update instead of failing to rename its --updating directory.
- TextView.setHeight and pixel maximum-height enforcement were missing. Existing browser
  text coverage now exercises fixed height, a changed maximum and return to line sizing.

Search-result rendering, font defaults, status insets, feed overlays and performance remain
under investigation. Successful native decoding does not establish a working search result.
JSON "missing method" reports require receiver diagnosis: the named methods already exist.

The APK's resource table contains 12 different package IDs. The parser previously merged all
packages into one type map: 0x7f0b000b, an integer font selector with value 42, resolved to a
library style from package 0x4f. Resource entries, configuration caches and name lookup now
retain their package namespace; the main 0x7f package remains the default. One core parser
case covers colliding IDs and cache invalidation after adding a split. Five resource tests
pass (21 assertions); Chrome resolves the original APK's font selector to integer 42.

ActivityOptions.makeScaleUpAnimation now records screen-relative bounds and package metadata
in the options Bundle. A live Chrome probe returns the expected type 2 and all four supplied
bounds. VibratorManager delegates its default vibrator to the existing service owner.

A stalled cover request exposed a wrapped SynchronousQueue in TikTok's I/O pool: webdroid's
concrete-class check missed the wrapper, limiting a cached pool to one worker with 39 queued
tasks behind a blocked task. ThreadPoolExecutor now calls the queue's virtual offer and grows
up to its maximum when storage is refused. Accepted queue entries are removed when dispatched
or cancelled; direct worker assignments no longer appear in getQueue(). SynchronousQueue's
nonblocking offer refuses storage without a waiting consumer. The bundled core-oj execute
bytecode confirms the offer/add-worker sequence. Sixteen focused concurrency tests pass,
including a wrapped handoff queue with two blocked workers and rejection at the maximum.

Newly released background work reached EnumMap's copy overload, synchronizedSortedMap and
AudioManager's capture-policy query. The map implementation now owns copied entry records;
sorted wrappers reuse the canonical locking/view machinery. Four map checks pass, and a
runtime probe verifies SortedMap identity and firstKey. Audio capture policy is retained as
application state with Android's default and range validation. These repairs do not establish
support for recording other applications' audio.

TikTok's native video path reached ANativeWindow_lock/unlockAndPost. These now allocate a
reusable guest buffer with ABI-correct geometry and pixel pointer, present copied RGBA/RGBX
or RGB565 pixels through the canonical surface owner, and balance window references. The
existing EGL browser fixture verifies two exact pixels, duplicate-lock rejection and handle
release. This establishes software presentation support, not sustained video throughput.

The apparent JSONObject.optString missing API was an invalid receiver: optJSONObject returned
a JHashMap. JSONObject(Map) now recursively wraps values; raw objects supplied to put retain
their Java identity and typed getters reject non-JSON containers. Object and array getters
share one implementation. Six focused JSON checks pass (21 assertions). Temporary receiver
and exception logging was removed. JNI Settings constant probes now resolve SCREEN_BRIGHTNESS,
ADB_ENABLED and ADB_WIFI_ENABLED in their declaring classes.

Saturation diagnostics subsequently reached an AppsFlyer pool at its configured maximum of
six workers. Executor constructors and setRejectedExecutionHandler had discarded the supplied
handler. Rejection now dispatches it, and the built-in CallerRuns/DiscardOldest policies honor
shutdown. The existing saturation case checks caller execution and shutdown behavior; 15
executor tests pass (57 assertions). This does not prove that this analytics pool caused the
search request delay.

A native trace then identified rejected format 0x32315659 (YV12) at 576×1024. Window buffers
now implement Android's aligned Y,V,U planes. VideoFrame performs YUV-to-RGB conversion and
feeds the existing surface presenter; guest decoding remains unchanged. The EGL fixture
checks padded YV12 chroma order in addition to RGBA. A fresh full Chrome capture shows feed
pixels after this repair; sustained throughput and search-video playback still need validation.

Repeated thumbnails were shared Java bitmap identities, not decoder corruption. The custom
cache key's DEX equals method can return true for different hash codes: it relies on HashMap
checking the hash before invoking equals. Our slow-key map/set path skipped that check. It now
retains insertion hashes, compares only matching hashes, and calls equality on the lookup key.
One core hash-map case covers hash filtering, collisions and mutated keys; 21 owning collection
checks pass (119 assertions). This avoids needless bytecode equality calls as well as collisions.

Chrome rejects HEIF files received by BitmapFactory. The fallback recognizes HEIF brands,
lazily imports libheif-js 1.23.2's bundled Wasm decoder, selects the primary image, and releases
image handles and the decode context. Ordinary formats retain browser decoding. The package's
LGPL-3.0 license and upstream source are included in node_modules/libheif-js and its repository
https://github.com/catdad-experiments/libheif-js; the dependency is unmodified and rebuildable.


Slow-key hashing now preserves the calling Java thread across suspending hashCode/equals
callbacks, including immutable factories. The existing hash case checks a suspended callback
under another thread. Fresh Chrome proceeds beyond consent; older reloaded sessions with
large object diagnostics are not comparable performance evidence.

The reached PrintWriter CharSequence append overload now shares Writer's virtual write path,
uses csText and validates subsequence bounds. A runtime probe checks StringBuilder text, char,
subsequence, null and return identity. MemoryInfo exposes summaries from its existing counters
and returns null for unknown keys; KeyGenParameterSpec retains the requested device-properties
attestation flag without claiming hardware attestation support.

The bandwidth estimator's ArrayBlockingQueue grew beyond its ten-element capacity, causing
repeated sort bounds exceptions in X/058j. Shared blocking queues now enforce capacity, reject
nonblocking overflow, park producers and wake them after removals. SynchronousQueue transfers
pending producers without reporting stored entries. Twenty-six queue/executor/collection checks
pass (145 assertions). The next live TikTok search run reports no estimator bounds exceptions.

Search dates were exactly 2^32 seconds late. A64 struct tm.tm_gmtoff was 4294942096 instead of
-25200 because libc stored a signed long with the pointer writer. Time structs now preserve
signed ABI-width fields, read 64-bit time_t on A64 and normalize negative subsecond timestamps.
The NDK time.h declares tm_gmtoff as long int. One core ABI check covers negative offsets,
pre-epoch time and A64 timestamps beyond 2106 (ten assertions). Paired browser verification
of the date correction is still pending.

A result click reached makeClipRevealAnimation. Its bundled framework bytecode records type
11 and screen-relative bounds without a package name. Clip-reveal and scale-up options now
share bounds calculation while preserving that difference; a runtime Bundle probe passes.

Full Chrome now places the search input at y=96, matching the reference AVD. XML
fitsSystemWindows was omitted, and ViewGroup always used pre-R sibling consumption.
The paired framework DEX sets sBrokenInsetsDispatch only below target 30; modern dispatch
passes the parent's result independently to every child, including GONE views. The existing
hierarchy checks now cover both target behaviors. Legacy light-status-bar flags also reach
the shell renderer. Seven hierarchy/measurement checks pass (18 assertions).

Repeated Playwright CDP connections changed prefers-color-scheme on connection/disconnection,
causing actual activity recreation and misleading repeated-consent observations. Raw WebSocket
CDP probes leave that configuration stable. Temporary recreation logging was removed. Old
activity-owned overlays still require a cleanup audit without fabricated dismiss callbacks.

CharsetDecoder now retains and applies replacement strings, reports malformed sequences, and
preserves incomplete/overflow input instead of consuming the entire buffer. UTF-8, ASCII,
Latin-1 and UTF-16 share the supported charset-name normalization. One core buffer case checks
report/replacement, literal U+FFFD preservation and supplementary-character overflow; the three
CharBuffer checks pass (16 assertions). This does not complete encoder streaming semantics.

A search menu reached WindowManager.LayoutParams.setFitInsetsSides. Insets sides/types and
visibility policy now survive Window attribute application and bound dialog layout. A runtime
round-trip probe and the existing window-context check pass; live menu verification is pending.

A later startup deadlocked Keva readers behind a writer. Native fault state identified the
reader's earlier abort inside vsnprintf: %p translated an unmapped diagnostic address before
formatting it. Printing an address must not dereference it. The formatter now consumes the raw
ABI-width pointer and retains all unsigned bits. The exact 0x1107420ec address and all-ones
pointer pass a core native snprintf check; six stdio checks pass (42 assertions). The next
startup passes consent without a native fault. The underlying Keva diagnostic was recoverable
library behavior; no bytecode, library lock or data validation was bypassed.

The later search screenshot shows Jun 16, 2025 for model timestamp 1750095269 and distinct
2023/2026 dates; the signed-time correction is verified in the running APK. Search sheets now
open with Filters and Share feedback. Both photo and video routing reached Intent.putExtras
(Intent), now sharing Bundle merging without sharing the source map. A further coroutine
reached File.toURI; it uses the existing URI constructor to quote the absolute path and append
an existing directory's slash. A runtime probe checks spaces, fragment/query characters and
directory suffixes. MemoryInfo clean counters now expose the framework's field sums.

Native fixed-address remapping also wrote back shared pages after zeroing them. The order is
now write-back, invalidation, replacement. A core mmap/MAP_FIXED probe verifies dirty bytes
survive; seven stdio checks pass (45 assertions). Separate overlapping MAP_SHARED mappings
still use copied pages rather than a continuously coherent page cache; no broader coherence
claim is made. A temporary mmap trace was saved and disabled.

Forest resource fetching reached LruCache.hitCount and threw during its fetch chain. The
cache now counts hits, misses, puts, creations and evictions, with one trimming path used by
resize, insertion and evictAll. Updating a key makes it most recent. The existing LRU check
verifies hit/miss/eviction counts alongside recency and snapshot independence.

The next stable search capture has distinct photo/video covers and avatars with correct dates.
Opening a card now reaches DetailActivity, where missing Activity.getParent aborted fragment
creation and caused downstream scene-state errors. Standalone activities now return null,
consistent with isChild=false and the framework's nullable mParent getter. Typecheck passes.

A subsequent search merge threw in the bundled Guava-style cache's size-eviction path. Its
segment extends ReentrantLock, whose native implementation only incremented a shared counter,
allowing different Java threads to overlap during suspension. Locks now retain thread ownership,
recursive holds and queued acquisitions. Conditions release all holds, transfer signaled waiters
to the lock queue and reacquire before returning or throwing. The former uncontended-only
lock test now checks exclusion, ownership, recursive condition restoration, FIFO transfer and
interrupt removal (one core case, 11 assertions); typecheck passes. The cache failure has not
yet been reproduced under the repaired implementation, so causal validation remains pending.

ViewFlipper inflation was reached by detail/comment UI. Its constructors now share ViewAnimator
initialization, read flipInterval/autoStart, and schedule virtual showNext calls through the main
handler. Visibility and detach cancel pending flips. A real-timer runtime probe checks visible
flipping and detach cancellation; the three owning view-switching checks pass (15 assertions).
The host still lacks general window-visibility broadcasts on activity backgrounding.

A later detail replay produced duplicate roots: a zero-width obsolete child and the fragment's
full-width replacement. This layout issue remains under investigation. Back navigation then
threw ClassCastException casting $Proxy57 to SuggestWordsApi$SuggestApi; that synthetic class
actually implemented ActivityLifecycleCallbacks. Concurrent Proxy creation overwrote the same
interface-set cache entry, so Map.size reused a generated class name for a different interface.
Pending class creation is now cached before suspension, names use a monotonic counter, and
framework declaration indexing is shared. The new concurrent identity/interface check fails
against the previous implementation and passes after the change. Six reflection checks pass
(119 assertions), as does typecheck. Proxy defining-loader semantics remain a separate limit.
TikTok smoke compilation completed 462,058 method bodies with zero method failures; the tool's
printed word “classes” counts method compilation attempts, not class definitions.

Inflater resource overloads bypassed cloned factories and parser overrides by looking up another
inflater from the context. They now dispatch through the receiving inflater's parser overload,
close resource parsers on success or failure, and retain the same inflater for includes. A runtime
probe verifies clone factories, virtual parser dispatch and exceptional close; six hierarchy and
view-switching checks pass (26 assertions), as does typecheck. This did not resolve the duplicate
root by itself. The cache eviction assertion also recurred after the lock fix; its cause is open.

Fragment tracing found the duplicate root followed a swallowed setup exception: the same fragment
retained its first view and then ran performCreateView again. One captured exception was a missing
string from SearchSwipeGuideUIComponent. View.getResources returned the base table instead of the
Context's custom Resources object; the APK's override supplies that string from its own store.
View construction now retains the virtual Context.getResources result, matching the bundled AOSP
constructor/getter. A resource-identity probe and 16 owning view checks pass (87 assertions), with
clean typecheck. A live dispatch experiment then produced one detail root with populated caption
and controls, without the swallowed resource exception. Fresh-build replay remains to be checked.
Another earlier setup exception was UnsupportedOperationException; its source remains untraced.

The cache's access/write queues extend AbstractQueue and populate through Queue.add. That native
base incorrectly reused listMethods, so inherited add wrote a separate array instead of calling
the subclass's offer; its linked iterator then saw no eviction entries. AbstractQueue now inherits
AbstractCollection and implements add/remove/element/clear through virtual offer/poll/peek. Shared
bulk insertion traverses the actual iterator and preserves the Java caller across suspension.
One core subclass-storage case covers insertion, inspection, removal, clearing and empty/self-add
failures. The 26 collection/executor/queue checks pass (146 assertions), as does typecheck. Live
cache replay on this repair is pending. The fresh View-resources build produced a single detail
root and no captured resource exception, but one replay still had empty content.

Fresh full-Chrome replay after the AbstractQueue repair reached a single populated detail root,
playing cat video and the comment sheet without another observed eviction assertion. Initial
comment assembly returned normally; the empty list instead accompanied repeated layout failures
from missing TextView.getCompoundPaddingStart. Start/end getters now select the virtual physical
padding getter using layout direction, preserving the Java caller through suspension. A diagnostic
native-method installation immediately allowed comment rows, dates, likes and reply links to
render. A runtime probe checks both directions and an asynchronous physical getter override;
six owning text checks pass (28 assertions), with clean typecheck. Fresh-source UI replay is next.
Relative drawable assignment still uses the existing physical slots; broader RTL resolution is
outside this reached getter repair.

A caught detail-path ClassCastException also identified NumberFormat factories returning the
abstract base rather than DecimalFormat. The paired AOSP implementation constructs DecimalFormat;
the shared factory now links and creates that class, including integer and percent factories.
Existing formatting checks also assert runtime type: five number checks pass (32 assertions),
and typecheck passes. These repairs do not complete locale/currency/pattern semantics.

The fresh-source comments replay rendered and scrolled rows with no observed layout/draw errors.
Guest reply/sign-up navigation then reached Integer.rotateRight; the implementation now uses
32-bit rotations with Java's masked shift distance. A direct runtime probe covers zero, wrapped,
negative and sign-bit rotations; typecheck passes.

Animated comment images failed because libstatic-webp's JNI_OnLoad requests Bitmap.Config.nativeInt.
The native enum exposed only names/ordinals, so GetFieldID left NoSuchFieldError pending before
registration. Config now exposes AOSP's identifiers (1, 3, 4, 5, 6, 7, 8) through the canonical enum
registration helper. Reflection reads those values; loading the unchanged APK library with all
platform delegates registers 27 JNI methods with no unresolved imports, called missing functions
or JNI misses (7,389 guest instructions). Six owning bitmap/number checks pass (38 assertions),
and typecheck passes. Full browser image replay remains pending. The native loader currently
ignores JNI_OnLoad's return version; that separate failure-reporting limitation remains.

The disassembler also truncated jumbo string indexes to 16 bits, falsely displaying a class name
where the APK actually requested "static-webp". It now reads both index words; no APK changed.
After the host restart, the reference AVD loaded an older snapshot without TikTok. Reinstall and
a reset of that test installation both led directly to a login wall without a guest close button.
Earlier AVD guest captures remain reference evidence; this latest launch is not a paired guest
comparison. No account was created and no comment was posted.

The fresh feed's decoded surfaces advanced, but swiping exposed a separate geometry failure:
a spacer had LayoutParams.height=-147. childMeasureSpec treated every negative dimension other
than MATCH_PARENT as WRAP_CONTENT, so the plain spacer measured the full available height and
LinearLayout assigned its weighted video sibling zero height. AOSP's method leaves unknown
negative dimensions at UNSPECIFIED/0; the shared helper now does likewise. One core weighted
layout check verifies the content retains its space; 12 owning layout checks pass (23 assertions)
and typecheck passes. Fresh feed replay remains pending.

Fresh replay after the child-measure fix displayed the next feed video at full height. A visible,
untraced 10.214-second sample recorded 101 completed shell frames and 61 new video frames
(9.89 and 5.97 fps respectively). This is functioning playback, not a smooth-playback claim or
matched performance comparison. The bundled WebP library also decoded a browser-produced 2×2
WebP, rendered its frame into an Android Bitmap and returned the expected red pixel 0xffff0000.

Profiling showed frequent __memcpy_chk host exits. Valid checked copies now share the core's
existing memcpy/memmove implementation; oversize copies return to the existing host failure path
before writing. The owning copy check includes overlap, zero length and unchanged memory on a
rejected size. Three memory checks pass (81 assertions), and typecheck passes. A warmed A64 loop
of 100,000 identical 64-byte copies, alternating the same trampoline's binding with Chrome closed,
measured median 1.284 ms in-core versus 5.575 ms through the host, with correct bytes in every run
and 0 versus 100,000 host exits. This microbenchmark does not establish a comparable app FPS gain.

Profile navigation reached Compose text-link selection and a bitmap-free Canvas. Layout now
builds selection rectangles across its existing line geometry, including reversed and empty
ranges; mixed bidi runs remain limited by the existing layout model. Canvas's default constructor
was also overwritten by a no-op registration. It now initializes a private backing context, shared
with the framework delegate's construction path; bitmap-free canvases no longer share transforms.
A zero-size browser canvas discards transform state, so the detached backing remains 1×1 while
Android-visible dimensions stay zero. The owning browser check passes (23 assertions), including
multiline selection and independent Canvas transforms; typecheck passes. Fresh full Chrome now
renders the login modal's title, account options and legal links with zero layout/draw errors,
where the prior capture showed only a blank sheet. Authentication itself is not exercised.

Phone-login comparison exposed two CompoundButton defects: an exact 48-pixel height became
144 pixels, stretching/clipping the app's own checkbox drawing, and checked state never reached
its StateListDrawable when the app overrode onDraw. Measurement now resolves its minimum against
the supplied spec; drawable assignment and drawableStateChanged propagate virtual state to
stateful indicators, matching paired framework bytecode. Owning state and browser checks pass
(5 and 24 assertions), with clean typecheck. A separate duplicate save-login row is under diagnosis.
One reload stalled at 302 ticks with a queued main job and no native fault; a fresh browser session
advanced and opened the login modal. This is an unresolved repeated-load observation, not a waiver.

The duplicate phone-login row came from ignored <include android:visibility="gone"> in the
unchanged res/b/y4.xml. Include inflation now applies the resolved visibility enum through the
view's virtual setter, as AOSP parseInclude does. Fresh full Chrome shows one correctly sized,
checked save-login row and the Continue button, with zero observed layout/draw errors. The current
AVD phone form was captured too; Chrome's cursor/disabled-label styling and system IME/navigation
remain visually different. Typecheck passes; the real APK replay verifies the include override.

Final manual pass on 07439dd4 reached guest feed, Profile/login, phone/email tabs, back navigation,
Videos search results, a populated video detail, resume, and a swipe to the next result. No observed
layout/draw errors and the final main-queue sentinel passed. The Top search tab remained loading
in this pass; Videos loaded. The final comment tap opened TikTok's sign-up gate, so earlier rendered
comment captures remain the comment evidence. No credentials or posts were submitted. Screenshots
and navigation telemetry are in ignored webdroid-shots/tiktok-parity. Full regression validation is
next; these observations do not establish complete app parity or smooth playback.

The first frozen full regression run (f88b72c2) completed all 159 steps with no wedges; YouTube's
show-controls and pause steps hit settling limits. All 13 TikTok steps rendered, with zero layout
or draw errors, advancing completed frames and diagnostics from four process realms. Main-process
missing entries were nine optional app/service classes; native-required was empty. Supporting
GMS and vending realms exposed uncaught Integer.reverseBytes failures that the main summary alone
would miss. Integer byte reversal now handles ZIP signatures and signed boundaries (five direct
runtime cases pass). GMS next entered obsolete multidex extraction because java.vm.version was
absent. The runtime already indexes every classes*.dex before initialization; it now reports the
reference AVD's 2.1.0 capability version (adb shell dalvikvm -showversion), allowing unchanged
AndroidX code to select built-in multidex support. Fresh TikTok launch reports no missing APIs or
uncaught errors in all three supporting realms. Typecheck passes; final matrix rerun is required.
The prior full unit run passed 1,252 tests/26,740 assertions; TikTok compilation produced 462,058
bodies-bearing classes and zero method failures. Eight non-DOM framework exercises passed, with
text measurement explicitly skipped and 68 unexercised native declarations lacking delegates.

Phone-form capture also exposed a caret positioned after the empty field's hint. TextView was
using the hint layout for both painting and insertion geometry. The caret now takes its width,
baseline, gravity and vertical offset from the editable text layout, consistent with AOSP's
force-normal vertical-offset path. The existing browser fixture checks an empty hinted input;
25 assertions and typecheck pass. Full Chrome confirms the caret at the start of Phone number
with zero layout/draw errors. Its drawable/color styling remains different from the AVD. The
interrupted final matrix is not counted as completed validation; a new frozen run follows.

Matched starting-revision E2E exposed a regression hidden by Harmonic's nearly unchanged mean
visual score: comments stayed empty, with 450–453 inset/layout passes instead of two inset passes.
A traced pre-draw listener waited for two app inset callbacks. Reading fitsSystemWindows from XML
made AppCompat's FitWindowsLinearLayout consume insets before its children; its reflective
makeOptionalFitsSystemWindows call had no implementation. View now preserves optional fitting and
routes onApplyWindowInsets through virtual fitSystemWindows. Paired framework bytecode specifies
that an attached optional-fit view without a framework content listener clears local inset padding
and passes the insets through. Shared padding mutation also avoids redundant layout requests.
Fresh uninstrumented Harmonic replay restores visible comments: two inset passes, six layout
passes, zero layout/draw errors; starting revision had two and seven. Five owning tests pass with
22 assertions, and typecheck passes. Window.setAttributes also retains change detection for all
stored flags/fit fields instead of unconditionally scheduling insets on identical values.

Final frozen implementation 00208a4d passes typecheck and all 1,253 tests (26,744 assertions).
The full serialized E2E completes 159 steps across 12 flows in 843.4 seconds, with no wedged
main loop or step-action failure. Only YouTube show-controls/pause hit settling limits, reproduced
on starting 9071fec7. All 13 TikTok steps render decoded feed content, resume and successive
videos, with zero layout/draw errors. All four realms return diagnostics on every TikTok step;
its three supporting realms have no missing APIs or uncaught errors. Main missing entries are
nine optional APK/service classes; no realm reports a native-required delegate. Resy again
reaches a populated venue page through all 13 steps, with clean diagnostics in all four realms.
Harmonic comments remain populated with two inset and seven layout passes, matching baseline.

Matched baseline content-difference means are FitNotes 40.116→40.115%, Mihon app 62.528→57.396%,
Harmonic 31.843→31.142%, and Mihon onboarding 17.691→17.691%. These are distances from unchanged
AVD goldens, not direct pairwise differences. Inspection attributes Mihon's worse final library
step to its changing empty-state face; surrounding controls remain aligned. Single matched
rollups show comparable step durations and drawing cost, not a repeated performance guarantee.
YouTube's Matrix/SAX errors, Harmonic's atomic-group regex failure, Flappy Bird's page error and
Lichess's native pthread aborts reproduce on starting revision. Flappy's embedded WebView frames
lack wd diagnostics; its Android realms do report. Rendered-step counts do not waive those gaps.

Full TikTok parity is still unproven: onboarding hand drawing has artifacts, caret color and
phone-button styling differ, Top search stayed loading in one manual pass, an optional JobInfo
parcel operation remains unsupported, and one reload stalled. Earlier decoded playback measured
about 6 fps; shell-frame counters are not video FPS. Latest AVD access is login-gated, while earlier
guest captures remain historical evidence. Authentication/publishing/DRM are unvalidated. Curated
captures, logs and per-step diagnostics are indexed in ignored webdroid-shots/tiktok-parity/README.md.

### TikTok branch structural review

The follow-up review against `main` separates the 1,642-line concurrency registration module
into atomics, blocking queues, and synchronization owners; the executor/future owner is now 796
lines. Both the full registration entry point and the deliberately partial `jsrc` entry point
load the extracted registrations. Queue/deque aliases share their owning method table and one
occurrence-removal implementation. Executor queue parameters accept Java objects, including
bytecode queues, instead of claiming every queue is a native list. Existing interruption,
condition reacquisition, drain reservation, and rejection behavior remains in place.

Native windows previously spread lifetime and buffer state across a surface array, a parallel
reference-count array, and a weak buffer map. Each handle now owns one record; the reverse surface
index resolves an existing handle without scanning every past window. Release removes both
indexes and frees that record's guest buffer. The existing browser fixture additionally checks
shared-handle reference counts and fresh default format ownership after final release.
No new test file or visual golden was added. This reduces ownership ambiguity; it does not claim
a measured playback FPS improvement.

Validation at `66dd0467`: typecheck and all 1,253 tests / 26,744 assertions pass. TikTok smoke
compilation has zero method failures; all eight runnable framework exercises pass, with the
browser-only Paint text-metrics skip and unchanged 295/363 declared-native coverage. The final
serialized matrix completes all 159 steps in 833.6 seconds, with zero main-loop wedges and the
same YouTube `show-controls` / `pause` timeouts. An earlier attempt was operator-interrupted after
TikTok completed and is excluded from this full result.

TikTok renders 13/13 steps with advancing ticks, all four process diagnostics, no layout/draw
errors, no uncaught/executor exceptions, and no required native delegate. Its nine optional
missing classes are unchanged. Resy's Carbone venue and Harmonic's comments are populated;
Harmonic retains two inset passes and seven layout passes on the comments step. FitNotes and
Mihon onboarding retain their rounded content scores (40.12% / 17.69%). Mihon's 57.40% to 57.65%
change is concentrated in the final randomized empty-state face, with unchanged surrounding
controls; Harmonic's 31.14% to 32.02% change is concentrated in menu/scroll captures. These are
single-run visual observations, not a performance or full-fidelity guarantee.

The audit retains all process errors. YouTube repeats Matrix/SAX/cursor failures (one additional
Matrix draw-error occurrence on video-back); Harmonic repeats the atomic-group regex error;
Flappy Bird repeats the WebView status TypeError and unavailable bridge-frame diagnostics.
Reddit additionally reaches `Process.getStartRequestedElapsedRealtime`, which has no implementation
in either cleanup revision. No optional failure was hidden or replaced with fabricated success.

A serialized Lichess replay at cleanup start `b3ed93e3` completes 15/15 steps in 90.6 seconds and
reproduces pthread errors 3, 22, and 35. The candidate also reaches the previously documented
FairyStockfish `RootMove::extract_ponder_from_tt+0x280` null-address fault. It is absent from this
single matching starting-revision replay; historical reproduction establishes prior occurrence,
but the varying engine games prevent a conclusive paired fault-frequency comparison. Complete
TikTok parity and the earlier playback/styling/authentication limits remain unresolved.

### ChatGPT startup and guest conversation

The unchanged ChatGPT XAPK initially stopped in startup contracts: missing executor shutdown
policy, reflection accessibility, Character title casing, URI/CharBuffer operations, and an
object-array Unsafe stride of one byte where bundled bytecode accepts four or eight. The
repairs retain the original bytecode. DisplayManager additionally returned a Promise inside
its Java Display array; awaiting the display fixes the subsequent getState dispatch.

Guest entry then reached FileChannel.truncate and Message asynchronous flags. Sending the
first prompt exposed Character.getType; its exception interrupted Compose composition and
left a secondary layout-state error. Unicode category dispatch now uses the host Unicode
properties with Java category numbers, including the unused category 17, and an ASCII table.
Its Unicode version follows the host browser, as existing character property queries do.
File truncation preserves shared position and cannot extend storage. Focused NIO/Character
checks pass (15 tests, 104 assertions); typecheck passes. Earlier ChatGPT smoke compilation
completed 66,165 classes with zero method failures.

Full Chrome on port 4093 and a dedicated API 33 AVD on emulator-5580 both sent the synthetic
prompt “What is two plus two?” and rendered real service answers. Captures are under ignored
webdroid-shots/chatgpt (gettype-response.png and avd-private-response.png). This establishes
one guest text round trip, not complete app parity. RuntimeShader and text alignment repairs
remain under verification; shadows, settings configuration differences, recreation and further
interactions still need review. No full E2E run has been performed at this stage.

ChatGPT supplies AGSL for its shadows. RuntimeShader now compiles the reached numeric-uniform
AGSL subset to WebGL2, preserving top-left shader coordinates, local matrices and premultiplied
output. Unsupported shader uniform types fail explicitly. Rendering remains Canvas2D; shader
rasters are cached by dimensions, transform and uniform state. Recording must capture uniforms
and defer rasterization until replay: rendering into the display-list recorder's 1×1 mirror
silently erased the shadows. Shared program ownership keeps recorded snapshots alive without
leaking programs. The focused browser fixture verifies snapshot isolation, alpha and transformed
coordinates. It also verifies text coordinates replay through a recorded layer, which fixes
ChatGPT's previously unfindable labels. The repeated shader draws are not yet a performance claim.

Layout now retains requested alignment through BoringLayout, DynamicLayout and StaticLayout's
builder; draw positions, line bounds and cursor offsets use the same origin. The login sheet's
centered text and the toolbar/composer shadows are visible in the paired captures. Greedy line
breaking, some link styling and system-bar appearance still differ from the reference.

ChatGPT's settings and login entry also reach `RestrictionsManager`, class-based
`AppWidgetManager` lookup, and `Locale.Builder.setRegion`. The first now reports the
unmanaged device's empty restrictions; both widget entry points share the existing context
service owner. Locale region construction validates BCP 47 region syntax, normalizes case,
and builds independent values. This removes the login-entry exception; account login itself
is not yet validated. Typecheck and the two existing locale tests pass. No additional tests
were needed for the service registration changes.

The welcome title explicitly requests `StaticLayout.Builder.setBreakStrategy(2)`, confirmed
by observing its real builder calls. Balanced text now minimizes squared unused line width,
including the final line, with Minikin's line and emergency-break penalties. It preserves
paragraph offsets and retains the existing greedy path for default layouts and replacement
spans. This fixes “Welcome / to ChatGPT” against the private AVD capture. The existing browser
text fixture now checks a balanced paragraph and its offsets; it passes. Hyphenation,
language-specific break opportunities and balanced replacement spans remain unsupported.
Source: https://android.googlesource.com/platform/frameworks/minikin/+/refs/heads/main/libs/minikin/OptimalLineBreaker.cpp

RuntimeShader review found that the AGSL square-matrix spelling (`float2x2`) was translated
to a GLSL alias that the uniform parser did not recognize. Normalize square matrices to
`mat2`/`mat3`/`mat4`; the retained browser shader fixture now exercises a matrix uniform.
It still passes the same pixel, alpha, snapshot and coordinate assertions.

Configuration diagnosis: HTTP/2 capture showed `/v1/initialize` on `ab.chatgpt.com` returning
400, with malformed request JSON such as adjacent string fields without commas. The bundled
`eba0` Writer overrides `write(String,int,int)`, `write(int)` and `write(char[],int,int)`.
Our inherited `Writer.write(String)` appended to its own unused string instead of dispatching
to the subclass range method. Restore the Java dispatch chain through virtual string/character
ranges, retain concrete native writers' direct string fast paths, and validate ranges. After
the fix both observed initialization requests return 200 with valid JSON and Brotli responses.
The existing legacy API suite (71 tests, 264 assertions) includes one core asynchronous writer
override check. This was a runtime serialization fault, not an upstream network outage.

Once configuration succeeded, Statsig's real gzip request writer reached
`Deflater.getBytesRead()`. Track consumed input through one feed helper used by both direct
Deflater calls and DeflaterOutputStream; reset clears the count. The gzip footer now receives
its actual uncompressed size. A targeted probe verified pre-consumption, finish and reset counts.

The successful server configuration enables Statsig's SQLite queue on the next startup.
Implement the reached OpenParams builder (flags, synchronous mode, immutable build) and
SQLiteOpenHelper.setOpenParams. Apply synchronous mode before onConfigure and migrations, and
reject changing parameters after opening. Its tables, indices and triggers now initialize
without an uncaught exception. The existing SQLite transaction test passes. This does not add
WAL capability: the existing backend still reports WAL unavailable. Typecheck passes.

The paired app-language dialog measured 1080px wide in webdroid and 960px on Android.
ViewRootImpl first measures wrapping windows at `config_prefDialogWidth` (320dp here),
then expands only when the measured state says content is too small. DialogRoot now follows
that sequence. Preserve size-state bits through Java View calls, FrameLayout aggregation,
and the existing measurement cache without expanding its storage. The dialog now spans
x=60..1020, matching the AVD; vertical size differs by two pixels. The existing layout suite
includes one core state/cache check and passes, as does typecheck. Source:
https://android.googlesource.com/platform/frameworks/base/+/android-13.0.0_r1/core/java/android/view/ViewRootImpl.java

The guest navigation capture also confirms real responses, background/resume, settings,
language and About. The retained E2E flow accepts the observed welcome variants (Skip,
Continue without logging in, or the compact Continue sheet). A first smoke run had failed
to dismiss the compact sheet despite exiting successfully; its screenshots do not establish
conversation coverage. The corrected 14-step run visibly receives “Two plus two is 4,” with
14 completed renders, no wedges, no draw/layout errors and no required natives. It records
three SLF4J provider warnings and optional Amazon/window-extension/DatagramSocket/media-projection
queries. Startup hits a settling limit under competing Chrome/AVD load; this is not a clean
performance comparison. A fresh full-Chrome process is responsive and reuses shader rasters.
The previous hour-long session spent most of a sampled pause in V8 GC; its retention cause
remains unresolved. No speculative shader-cache change was retained.

Authentication remains different from the AVD. The bundled microG 0.3.16.252432 credential
provider routes Google-ID requests to AssistedSignIn; with zero accounts its unchanged
AssistedSignInFragment always opens Add Google account. Cancelling becomes a credential
cancellation, so ChatGPT does not fall through to the email form observed on the AVD. Child
process diagnostics show no missing API or exception on this path. Root-canvas-only captures
omit the foreground child surface; the full Chrome capture shows the actual account sheet.
This is a provider behavior limit, not justification for an app-specific credential response.
Sources:
https://github.com/microg/GmsCore/blob/v0.3.16.252432/play-services-core/src/main/kotlin/org/microg/gms/auth/credentials/identity/IdentityCredentialChooserActivity.kt
https://github.com/microg/GmsCore/blob/v0.3.16.252432/play-services-core/src/main/kotlin/org/microg/gms/auth/signin/AssistedSignInFragment.kt

Font instrumentation found ChatGPT requesting weight 600 while Paint emitted CSS weight 700.
Preserve requested custom-font weights and choose system faces with Minikin's weight/slant
distance and first-match tie rule. The existing medium file now serves both 500 and 600 requests;
the canonical shipped-face table also drives browser registration and native fonts.xml. This
removes the heavier headings seen in paired About/language captures without modifying app styles.
One font-selection check extends the existing font test file. Source:
https://android.googlesource.com/platform/frameworks/minikin/+/e900276/libs/minikin/FontFamily.cpp

The first full unit run found three failures in Canvas semantic-text checks because the shader
pattern check assumed a browser's CanvasPattern global. Guard that optional host constructor;
all affected canvas, shader and text browser checks pass again. The remaining 1,257 tests passed
in that run. Final whole-suite results follow after the candidate is frozen.

The APK's “Learn more” string carries `annotation;url=…` over characters 116..125 in its
binary resource pool, but Resources.getText returned the plain string. Preserve resource
Annotation spans and their inclusive source endpoints as immutable SpannedString values.
Both getText overloads retain their missing-resource behavior; getString still returns text.
ChatGPT now creates its own link styling, and the Settings underline matches the AVD.
Guard the string-pool no-style offset sentinel. This change handles annotation metadata;
other resource style tags and style metadata from merged split pools remain limitations.
The existing resource and span checks pass (12 tests, 55 assertions); no new test file was added.
The preceding complete unit run passed all 1,261 tests, and the final candidate is rechecked below.


Final candidate `dc729dfe`: typecheck passes; all 1,261 tests / 26,813 assertions pass across
220 files. ChatGPT smoke compilation reports 66,165 classes and zero method failures. Framework
exercises pass with the existing browser-only Paint text-metrics skip and 295/363 declared-native
coverage. The serialized full E2E executes 177 steps in 1,307.7 seconds. ChatGPT's 18 steps show a
real “2 + 2 = 4” response, background/resume, Settings, Language, About and login-sheet dismissal.
All 72 ChatGPT process inspections succeed, with zero wedges, settling limits, layout/draw errors
or required natives. Only three SLF4J warnings and optional Amazon/window-extension/DatagramSocket/
media-projection queries remain on this observed path. Empty diagnostics do not cover unused APIs.

The complete matrix records one transient TikTok consent-step liveness failure, followed by
recovery; five Resy settling limits; five YouTube Matrix draw-error occurrences plus its SAX/cursor
errors; Harmonic's atomic-group regex failure; and Lichess's native engine null-address fault.
Flappy Bird retains unavailable bridge-frame diagnostics and its browser status TypeError. No
observed process requires a native delegate. All four scored flows complete: FitNotes 39.50%,
Mihon app 55.78%, Harmonic 31.60%, Mihon onboarding 17.72% content mismatch. Goldens are unchanged.
Game samples fall below some FPS thresholds under other Chrome/AVD workloads; these are not
uncontended performance measurements. Matching selected-flow baseline comparisons follow below.

The maintainability pass keeps repairs in their owning modules: one shipped-font table drives
browser registration, native font metadata and face selection; one Deflater feed helper tracks
consumed bytes; Writer overloads share Java's virtual dispatch chain while concrete native writers
retain direct fast paths; packed measurement state reuses the existing cache. RuntimeShader owns
its WebGL programs, immutable recording snapshots and raster cache. No app bytecode, visual golden,
or bundled credential-provider behavior was patched. Added checks target core contracts and the
actual shader browser path; existing suites were extended wherever possible.

Reviewed paired screenshots and the complete frozen-run captures are indexed in ignored
`webdroid-shots/chatgpt/README.md`; `comparison.html` is the side-by-side gallery. The full Chrome
capture is required for the foreground microG child surface. Root-canvas-only login images do not
prove blank rendering. Full authentication parity, voice/attachments, native system-bar styling,
and the long-session GC retention cause remain unresolved.

Baseline `9d0bb979` reproduces YouTube's Matrix/SAX/cursor errors and the two playback settling
limits. The candidate's initial “video-open” screenshot instead shows Home: a different live ad
pushes the film title bounds to y=1916..2120 (center 2018), overlapping bottom navigation. The
baseline ad leaves the title at y=1766..1970 (center 1868). Both harness taps report semantic hits,
and `untilText` stops before swiping because the offscreen node already exists. Therefore the
candidate's initial 106–121 FPS samples do not measure video playback; rendered counts alone do
not establish interaction success. This is an observed harness visibility limit, not a claim
that the candidate improved playback. Supplemental candidate replay is recorded below.

The matching baseline Resy replay reproduces all five settling limits (location permission,
list, venue, venue-back and near-me), with zero layout/draw errors or missing APIs. It additionally
hits a transient onboarding-close liveness failure and then recovers; the candidate does not.
The baseline takes 363.0 seconds versus the candidate's 332.7 seconds under competing host load,
which is not a controlled speed comparison. Baseline TikTok completes without the candidate's
single consent-step liveness failure; both show slow decoded playback and no layout/draw or
uncaught/executor exceptions. Different live video workloads prevent a timing conclusion.

The baseline Doodle Jump flow also falls below its frame-rate threshold (20–22 FPS in play,
candidate 18–22), with no missing API or render error. The baseline Mihon onboarding score is
17.69% versus 17.72% on the candidate; inspected captures retain layout and controls, with the
small text-weight change from system-face matching. No golden is replaced. The fresh baseline
Lichess game does not reproduce the candidate's previously documented FairyStockfish fault;
historical reproduction establishes earlier occurrence, but this pair cannot establish unchanged
fault frequency. This remains an explicit regression-evidence limit.

A supplemental candidate TikTok replay clears consent, but its interests step misses the liveness
deadline before recovering. The process queue is already empty when diagnostics are collected;
48 frames completed during that step, with roughly 20 seconds in native execution and no
uncaught/executor/layout/draw exception. The moving transient failure is not reproduced by the
single matching baseline TikTok run. Host contention and varying videos complicate diagnosis,
but are not a regression waiver: this liveness comparison remains unresolved.

The supplemental candidate YouTube replay visibly advances Big Buck Bunny frames and completes
16/16 steps, reproducing the baseline's show-controls/pause settling limits, Matrix/SAX/cursor
errors and caption-style field queries. It has six Matrix draw-error occurrences and no layout
errors or liveness failures. Its 225.5-second duration versus baseline 226.5 seconds is not a
performance claim. The final full run and targeted replays establish working ChatGPT guest paths,
but do not establish a clean no-regression result because TikTok liveness and Lichess fault
frequency remain unresolved. Production code stayed frozen at `dc729dfe` throughout these captures.
