# Twitch parity

Worktree: `codex/twitch-parity`, based on `f3fefda`. Do not merge into main.
Only Twitch is under app testing during development; run the full serialized E2E
suite at the end, with unchanged goldens.

## Current evidence

- Full Chrome: `http://localhost:4106/?apk=Twitch.xapk&screen=720x1280@320`.
- The existing XAPK is Twitch Android TV, version 13.0.0.2, ARM32.
- Fixed startup failures in RemoteCallbackList, MediaSession and PlaybackState;
  the subsequent uninitialized Kotlin property error was downstream of onCreate.
  Callback-list tests also pass against the paired AOSP framework bytecode.
- Fixed Thread.getState and PackageInfo.requestedPermissionsFlags. WorkManager's
  invalid serialized data came from a one-byte TC_BLOCKDATA cursor error.
- Full Chrome reaches home, search results, live video/chat, quality selection,
  chat visibility and QR activation. Observed Java missing/errors are empty in the
  main realm and missing APIs are empty in both background realms. Live 720p
  playback advances; this is not yet a controlled performance comparison.
- Typecheck, eight targeted tests (45 assertions) and Twitch smoke compilation
  (2,360 classes, zero method failures) pass. Full E2E has not run yet.
- Disk space is available again. Isolated Android 35 AVD `webdroid_twitch_ref`
  (5586) boots, but its ARM64-only ABI cannot install the supplied ARM32 split.
  A matching release from APKMirror was unavailable because Chrome blocked its
  download host. Official API 25 ARM32 image is installed; its separate AVD
  `webdroid_twitch_arm32` (5588) needs its graphics launch environment resolved.
  No app or bundled library bytes have been modified.

## Remaining work

1. Launch the same package on Android and capture matching interactions.
2. Implement further evidenced platform behavior. Continue
   until Twitch works or an independently verified external limitation is reached.
3. Capture screenshots and inspect errors, missing APIs, rendering, main-queue
   liveness and performance. Keep app and bundled library bytecode unchanged.
4. Make focused commits with regression checks and record durable findings in
   docs/implementation-history.md. Complete full serialized E2E only at the end;
   investigate ambiguous failures against the starting commit under matching inputs.

Ignored investigation artifacts: `tests/e2e/actual/twitch-investigation/`.
