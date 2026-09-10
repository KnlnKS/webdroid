# microG integration

Integration started from `82e1afb` on `codex/microg-integration`. The merged integration is on `main` alongside `6946f16`.
Completion now continues from `b567197` in `codex/microg-completion`, in the
`../webdroid-microg-completion` worktree at the user’s request.
Run genuine microG and client APK bytecode; add Android platform behavior, never
app-specific substitutes. Keep comments and dependencies minimal.

Generated microG bundles belong in ignored `vendor/microg/`. Commit the preparation
script and pinned metadata only. Generate missing files during setup/server startup;
reuse complete bundles without downloading or reprocessing the source APKs.

## Milestones

- [x] Clean Resy baseline and verified upstream APK downloads.
- [ ] Pinned system packages, unified package registry, scoped signature grants.
- [ ] Isolated process realms and package contexts/class loaders.
- [ ] Binder, service lifecycle, provider/broadcast routing and shared storage.
- [ ] Automatic microG provisioning; Resy passes real availability checks.
- [ ] Android reference with the same microG build and SDK test clients.
- [ ] Authentication, FCM receipt, location and interactive maps at Android parity.
- [ ] Full regression and performance comparisons; focused commits.

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

- Fresh SDK-client baseline on private port 41973 confirms availability 0 and the
  missing NativeConnectivityListener.initialize JNI entry. No map renders yet.
- Next: defining-loader ownership through System.loadLibrary, JNI_OnLoad, JNI class
  lookup and native registration; exercise duplicate-loader fixtures and real maps.
- Existing authorized test account supplied interactively. Firebase project reference
  remains needed for live message delivery; credentials stay outside artifacts.
- Defining-loader native loading and JNI lookup/registration now pass 19 targeted tests
  and typecheck. The SDK map client passes native connectivity initialization and reaches
  GL viewport setup and FrameLayout parameter conversion; maps are not yet rendered.
