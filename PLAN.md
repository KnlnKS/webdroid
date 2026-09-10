# microG integration

Branch `codex/microg-integration`, based on `82e1afb`. Existing work in the original
checkout is excluded. Run genuine microG and client APK bytecode; add Android platform
behavior, never app-specific substitutes. Keep comments and dependencies minimal.

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
