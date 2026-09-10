# microG integration

Integration started from `82e1afb` on `codex/microg-integration`. The merged integration is on `main` alongside `6946f16`.
Completion now continues from `b567197` in `codex/microg-completion`, in the
`../webdroid-microg-completion` worktree at the user’s request.
Run genuine microG and client APK bytecode; add Android platform behavior, never
app-specific substitutes. Keep comments and dependencies minimal.
The evidence below is chronological; the final checkpoint records current verification.

Generated microG bundles belong in ignored `vendor/microg/`. Commit the preparation
script and pinned metadata only. Generate missing files during setup/server startup;
reuse complete bundles without downloading or reprocessing the source APKs.

## Milestones

- [x] Clean Resy baseline and verified upstream APK downloads.
- [x] Pinned system packages, unified package registry, scoped signature grants.
- [ ] Isolated process realms and package contexts/class loaders.
- [ ] Binder, service lifecycle, provider/broadcast routing and shared storage.
- [x] Automatic microG provisioning; Resy passes real availability checks.
- [x] Android reference with the same microG build and SDK test clients.
- [ ] Authentication, FCM receipt, location and interactive maps at Android parity.
- [x] Full regression and performance comparisons; focused commits.

## Acceptance

Bundle microG v0.3.16.252432 and Companion; enable checkin and messaging without an
extra opt-in screen. Keep account credentials/tokens outside code and reports. Live
tests use the authorized test account and a dedicated no-billing Firebase project;
messages go only to test installations. Normal browser permissions/account challenges
remain interactive. Push is required while webdroid is open, with recovery on reopen.
An upstream limitation needs matching Android evidence, not an assumption.

Run typecheck, unit tests, affected APK smoke compilation, framework checks, textcmp,
one E2E process at a time, and corpus. Leave visual goldens unchanged. Compare cold/warm
startup, frames, compilation, IPC, memory and idle work; investigate repeatable >5%
foreground CPU regressions. Each commit uses `area: sentence`.

## Evidence

- Clean `82e1afb`, private port 41863: Resy reaches sign-in and displays the Play Services
  error dialog. Logs name missing Play Store and GMS packages. Firebase Installations
  also returns HTTP 400 with invalid-configuration diagnostics; compare on Android.
  Capture/logs: `/tmp/webdroid-microg-baseline.{png,json}`.
- Both pinned APKs downloaded to the external `Library/Caches/webdroid/microg` cache;
  SHA-256 matches GitHub release digests. No APK binary added to Git.
- Baseline typecheck passed; 924 unit tests passed (46,035 assertions).
- Package registry/provisioning: typecheck and 10 targeted tests pass. Resy no longer
  displays the Play Services dialog; its own package/signature checks accept the
  verified APKs and scoped compatibility signatures. Services are not yet running.
  Capture `/tmp/webdroid-microg-packages.{png,json}` identifies package contexts,
  service binding and `Executors.unconfigurableScheduledExecutorService` next.

## Remaining architecture

Use one same-origin iframe realm per package/manifest process, preserving local JVM,
main queue and native memory. A browser broker routes IPC and shared services; it must
not queue Binder replies behind a caller waiting on the main queue. Foreground drawing
stays direct. Remote Parcel traffic uses bytes and explicit handles, never Java objects.
Package contexts use target resources and defining loaders. Database connections keep
TEMP state and one canonical persistent owner. Processes and bytecode start on demand.

## Current implementation and next checks

- Generated archives retain every ABI and reconstruct the signed source APK exactly.
  Startup reads package metadata; DEX and native libraries load on demand. Complete
  bundles need no source download or regeneration. Round-trip and integrity tests pass.
- Same-origin process realms execute real microG services. Binder, Messenger and
  ResultReceiver carry nested callbacks and caller identity. Service bindings, provider
  calls and broadcasts route through the broker. Process cleanup, rebinding, secondary
  activity presentation and shared preference ownership remain incomplete.
- Real microG checkin produces persistent registration state that survives reload.
  Two traced platform gaps were the absent radio Build field and preserving explicit
  HTTP content encoding for microG’s own gzip decoder. No identifiers or tokens are
  recorded here. Successful checkin does not establish FCM receipt.
- The standard SDK client reports availability success (0) in webdroid and the separate
  rooted Android reference using the same pinned microG APKs. Browser maps next require
  native-library lookup and JNI ownership for code loaded through package class loaders.
  Android now renders interactive maps after installing the unchanged extracted ARM64
  libraries alongside the system APK; both loaded and camera-idle callbacks were observed.
- Before the main merge: typecheck passed; 938 unit tests passed (46,126 assertions).
  Resy, microG and SDK-client smoke compilation each reported zero method failures.
  Authentication, real FCM receipt, location, interactive maps and the complete regression
  and performance matrix remain open. Existing reference AVDs and goldens are unchanged.

- Main migration: merge `2a92ed9` preserved `6946f16`; typecheck and 946 tests passed.
  The integration worktree was removed after moving ignored generated artifacts into
  main. Subsequent provider, Parcel and reflection changes run from the main checkout.
- ContentProviderClient now reaches the genuine Dynamite provider. Empty primitive Parcel
  reads match AOSP without changing unhandled Binder results. Annotation identity and
  one-argument Class.forName retain defining loaders; a duplicate-DEX fixture covers cold
  and hot calls. The latest maps trace reaches Mapbox’s native connectivity initialization.
  It still does not render a map in webdroid. Android maps do render and pan.
- Resy, microG, Companion and the SDK client each smoke-compile with zero method failures
  on merged main. A full unit run after the annotation fix passed 948 tests.

## Main verification checkpoint

- Typecheck passed. The full unit suite passed 948 tests and 46,357 assertions.
- Framework checks completed: 295/363 declared native delegates (81%); all executable
  framework probes passed. Text comparison: 6/6 paragraphs break identically.
- Serialized E2E (`--jobs 1`) completed all eight flows. Scored rendering: FitNotes
  39/39, Mihon app 17/17, Harmonic 14/14, Mihon onboarding 5/5. Content differences:
  40.89%, 57.20%, 31.93%, 17.56%; overall 36.90%. Goldens are unchanged.
- FitNotes still reported a fragment-destruction exception; Harmonic reported a layout
  exception; Lichess reported missing PhantomReference and native surface diagnostics.
  Compare individual errors with a controlled baseline before closing regression work.
- DoodleJump’s missing Service.getApplication delegate was added after that run.
  Typecheck, service tests and DoodleJump smoke compilation passed; its focused E2E rerun
  rendered 6/6 steps with no missing APIs or errors and minimum measured 36 fps.
- Corpus: 12/13 APKs rendered a frame; TikTok remains unsuccessful. Logs and current
  E2E artifacts/counters are retained under `/tmp/webdroid-microg-main-*`. Cold/warm,
  IPC, memory, idle and controlled foreground CPU comparisons remain incomplete.

## Completion worktree

- Work continues from `b567197` in `../webdroid-microg-completion`, branch
  `codex/microg-completion`, private port 41973. Focused commits retain each platform fix.
- Defining-loader JNI ownership, native dependencies, GL viewport routing, layout parameter
  conversion, bitmap buffer copies, regex interfaces, streaming zlib, vector constant-state
  cloning and bionic character-table indirection now let the unchanged SDK map client render
  real tiles and labels. Loaded and camera-idle callbacks were observed after panning.
  Captures: `/tmp/webdroid-gms-completion-trace.png` and
  `/tmp/webdroid-gms-completion-pan.png`. Full map parity is not yet established.
- Cross-process activities have foreground presentation, input, lifecycle transitions,
  calling-activity metadata and serialized results. microG's genuine login prompt renders.
  No account has yet authenticated in webdroid. Process death, nested/recreated activity
  routing and service rebinding still need broader lifecycle verification.
- Typed Bundle/Intent primitive reads now unbox Parcel values; Boolean/Float/Double writes
  retain their wire types. AccountManager is available through Context service lookup.
- Preferences use one persistent owner across process realms with data-only values.
  Interleaved-write and reload tests pass. Boot completion is dispatched once to eligible
  installed receivers, including non-exported receivers, to restore background services.
- Dedicated Firebase project `webdroid-microg-test` and Android app `org.webdroid.gmsclient`
  are registered on the free Spark plan, with optional Analytics and Gemini disabled.
  Configuration and browser test state stay outside the repository. The SDK received a real
  FCM registration token. A reopened browser retained that token, received a console test
  notification in the unchanged SDK client and sent the upstream acknowledgement.
  Capture: `/tmp/webdroid-gms-completion-receipt.{png,json}`. Private files now share one
  owner and persist through IndexedDB before package startup; binary reload, rename,
  deletion and temporary-cache behavior passed real-browser checks.
- Latest affected smoke compilation: Resy, microG and SDK client each report zero method
  failures. Typecheck and targeted lifecycle/storage/Parcel/network/package tests pass.
  The pre-contract full unit checkpoint passed 977 tests and 47,058 assertions. Full
  regression captures, account authentication and controlled performance comparisons remain open.

- Google accepted the authorized test password and reached interactive two-step verification.
  Account authentication remains pending. WebView cookies have a package-scoped persistent
  owner; isolated rendering preserves synchronous Java interfaces and upstream document URLs.
- Browser geolocation now feeds shared Android providers and genuine microG fused-location
  bytecode. The unchanged SDK client received callbacks with 4 m accuracy in a deterministic
  browser test and 40 m in normal Chrome without a coordinate override. The same pinned
  microG build on Android received a callback with 5 m accuracy from the AVD test location.
  These values describe separate inputs, not an accuracy comparison. No live coordinates
  were recorded. Reference screenshot: `/tmp/webdroid-reference-location.png`.
- The instrumented SDK location capture at `4b0a0c7` reports no missing APIs or undeclared
  native suspension in all four processes. Background main queues were empty. Older captures
  that queried an absent `__wdProcess` global did not establish child-process API coverage.
- Location requests share one browser watch, filter interval/distance and release the watch
  after the last active request. Android 13 Location, LocationRequest and WorkSource parcels
  carry values across process boundaries. Browser providers do not establish physical GNSS
  or Wi-Fi/cell provenance. Denial/regrant, process death and balanced-power coverage remain.
- Runtime permission grants now share a package store across processes. A permission activity
  launched by a background service restores the previously visible app and sends its result
  to the caller. PendingIntent parcels retain Binder handles, but remote sending/cancellation
  and process-independent operation ownership remain incomplete.

- The completion E2E checkpoint rendered all scored steps (overall content difference 37.29%).
  A newly reached GLES sample-count query wedged Lichess; 18fac17 fixes the query and restores
  responsive launch with real Flutter navigation. The full flow still needs a rerun.
  Flappy Bird's six FPS failures also occur on the controlled b567197 baseline.
- AlarmManager now delivers scheduled operations and PendingIntent honors identity and
  creation flags. An unaccelerated idle test at ece2390 sent microG's five-minute heartbeat
  and received HeartbeatAck 61 ms later without a reconnect. Missing APIs and main queues
  were empty across three processes; the reached Looper suspension annotation was corrected.
  System ownership across process death and broader reconnection tests remain incomplete.
- PendingIntent records and alarms now have a browser-broker owner and data-only payloads.
  A real-browser alarm test destroyed the creator iframe, restarted its package process,
  and delivered exactly one broadcast. Creator-UID checks, cancellation, immutable fills
  and focused tests pass. Raw IIntentSender transactions beyond descriptor queries remain
  unsupported; actual MCS recovery after process death still needs verification.
- Browser location denial, active/idle regrant and process-death cleanup now pass real-browser
  checks. Permission changes are event-driven; idle permission observation does not retain
  a geolocation watch. Lichess's 15-step rerun is responsive, but its captures remain on a
  loading screen with existing missing PhantomReference/SidecarProvider.
- Account records now share a lazy browser-owned store with authenticator ownership and
  package visibility. Credential/user-data access requires the owner UID; exposed account
  identity does not grant token access. Real-browser fixtures verify cross-process writes,
  reload persistence and microG metadata ownership. This does not establish Google login;
  interactive authentication and authenticator Binder request routing remain incomplete.
- Service death now notifies surviving clients and reconnects BIND_AUTO_CREATE bindings;
  client death releases its remote bindings. A real-browser microG common-service fixture
  observed connected → disconnected → connected with a new process PID, no missing APIs,
  no undeclared suspension and empty main queues. Eight focused tests and typecheck pass.
  Evidence: /tmp/webdroid-service-reconnect-browser.{json,log}. Account Parcel round-trips
  also preserve Android 13's name, type and access ID. Broader crash-loop policy remains open.

## Completion verification at 260ca78

- Typecheck passes; full units: 984 passed, zero failed, 47,106 assertions. Resy, microG and
  SDK-client smoke compilation each report zero method failures. Framework checks remain
  295/363 delegates (81%), with all executable probes passing; text comparison passes 6/6.
- Serialized E2E rendered 75/75 scored steps: FitNotes 39/39, Mihon app 17/17, Harmonic 14/14,
  onboarding 5/5. Content differences were 40.89%, 56.40%, 36.20%, 17.56% (overall 37.76%).
  Existing fragment/layout exceptions remain. DoodleJump minimum was 36 fps; Flappy Bird's
  six FPS failures also reproduce on b567197. Lichess remains on a loading screen despite
  responsive navigation. Goldens are unchanged; artifacts: /tmp/webdroid-completion-260ca78-e2e-*.
  The matching b567197 run rendered the same scored steps (overall 38.02%). Harmonic's launch
  exception was intermittent: four exact-launch repeats reproduced it once on completion and
  twice on baseline. The captured baseline stack shows background-thread identity during layout.
- Both completion and b567197 corpus runs rendered 13/14 APKs; TikTok failed on both. No new
  missing APIs were reported by completion. Corpus evidence establishes first-frame launch,
  not complete application behavior or secondary-process API coverage.
- Real MCS process-death recovery now passes without accelerating timers: the original
  five-minute alarm restarted microG and MCS logged in at 306.815 seconds. All three reached
  runtimes subsequently had empty missing-API/suspension sets and main queues. This test
  establishes delayed reconnect, not immediate sticky-service restart or another receipt.
- Three matched FitNotes cold/warm pairs measured median foreground CPU +4.76%/+5.48%.
  Profiling attributed extra early idle work to delayed microG startup/class compilation;
  steady-idle work was similar in one later pair. A separate settled nine-step interaction
  pair used 636.6 → 585.4 ms CPU and 129.0 → 137.5 MB live JS heap. These limited samples do
  not establish a general speedup; Wasm/external memory is excluded from that heap measure.
  Full inputs and caveats are recorded in the implementation history.
- Resy's remaining “Unable to configure device for notifications” dialog reproduces on the
  dedicated Android reference. Both platforms report Firebase HTTP 400 and invalid configuration
  for this APK, separately from the resolved Play Services availability checks. The dedicated
  SDK project's successful FCM receipt does not fix Resy's Firebase configuration. Evidence:
  /tmp/webdroid-resy-final-{android,browser}.{png,json}. No app-specific success is fabricated.
- Google authentication remains unverified: the existing Chrome sign-in tab is back at the
  email step and awaits interactive completion. Authenticator request dispatch, broader activity
  recreation/crash-loop semantics, balanced-power location and full map parity remain open.

## Authenticator dispatch checkpoint

- AccountManager now binds the installed authenticator, invokes real Binder methods and
  delivers asynchronous results on the selected Handler. Cancellation, timeouts, process death,
  caller identity and nested login response Parcels are covered by focused tests. Genuine microG
  feature filtering and login-Intent responses pass clean-browser checks using a synthetic local
  account; this does not establish Google authentication.
- Login activity handoff, Back cancellation and Cancel from a separate task now return to the
  client without missing APIs. Task membership survives recreation and root removal across
  processes. Task affinity/launch-mode policies, token-by-features selection and encrypted
  account sessions remain incomplete. The broader regression matrix is being refreshed.

## Location and lifecycle verification

- At 25e39a8, typecheck and 1,001 unit tests pass (47,201 assertions). Resy, microG
  and SDK smoke compilation each report zero failures; framework checks remain 295/363
  with executable probes passing, and text comparison passes 6/6. Serialized E2E renders
  75/75 scored steps (37.36% overall content difference); goldens are unchanged. Corpus
  renders 13/14 APKs. Existing FitNotes/Harmonic exceptions, six Flappy FPS failures and
  Lichess's loading screen remain. The newly observed Reddit executor-bindService gap also
  reproduces on b567197. Artifacts: /tmp/webdroid-auth-final-*.
- Balanced location now uses microG's genuine platform-provider fallback through a bundled
  component default that preserves explicit settings. Fresh browser and matching Android
  reference tests receive callbacks; browser request removal releases its watch, with clean
  diagnostics in all three reached processes. WGS84 distance/bearing calculations match six
  Android float-result fixtures. These tests use synthetic inputs, not physical radio scans.
- Interactive Google authentication, full map parity, task affinity/launch-mode policies
  and broader crash-loop behavior remain open. Final profile regression/performance checks
  are in progress.

## Final verification at a780ce4

- Typecheck passes. Full units: 1,002 passed, zero failed, 47,229 assertions. Resy,
  microG and the rebuilt SDK client each smoke-compile with zero method failures. Framework
  coverage is 295/363 (81%), executable probes pass, and text comparison passes 6/6.
- Serialized E2E renders 75/75 scored steps: FitNotes 39/39, Mihon app 17/17, Harmonic
  14/14, onboarding 5/5. Content differences are 40.89%, 57.09%, 34.07%, 17.56%
  (overall 37.40%). No flow wedges or times out; no newly reached missing APIs relative
  to b567197. Goldens are unchanged. Existing FitNotes/Harmonic exceptions remain, as do
  six Flappy FPS failures and Lichess's loading screen. DoodleJump passes 6/6 at minimum
  34 fps. Corpus renders 13/14 APKs, with no new gaps versus the preceding checkpoint.
- Three matched cold/reset pairs measure median foreground CPU 1,231.1 → 1,275.3 ms
  (+3.59%) and 1,050.9 → 1,109.3 ms (+5.56%). The extra startup work remains; broker
  calls rise 10 → 42, largely provider requests, consistent with the earlier startup
  profile. Three later nine-step interaction pairs measure median 628.7 → 630.1 ms
  (+0.22%). A first +12.8% interaction pair did not repeat. Median live JS heap after
  collection is 129.0 → 137.6 MB, excluding Wasm/external memory. No general speedup
  or zero-overhead claim is made. Details and artifacts are in the implementation history.
- Interactive Google authentication remains pending in the preserved Chrome sign-in tab.
  Resy's remaining Firebase configuration error still has matching Android evidence; no
  runtime change can establish success for that rejected configuration. Broader account
  sessions, task-affinity/launch-mode behavior, sticky-service crash policy and full map
  parity are still open. This is a verified integration checkpoint, not full Android parity.
