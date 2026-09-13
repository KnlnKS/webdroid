# Twitch parity

Worktree: `codex/twitch-parity`, based on `f3fefda`. Do not merge into main.
Only Twitch is under app testing during development; run the full serialized E2E
suite at the end, with unchanged goldens.

## Current evidence

- Full Chrome: `http://127.0.0.1:4106/?apk=Twitch.xapk&screen=720x1280@320`.
- The existing XAPK is Twitch Android TV, version 13.0.0.2, ARM32.
- Fixed startup failures in RemoteCallbackList, MediaSession and PlaybackState;
  the subsequent uninitialized Kotlin property error was downstream of onCreate.
  Callback-list tests also pass against the paired AOSP framework bytecode.
- Fixed Thread.getState and PackageInfo.requestedPermissionsFlags. WorkManager's
  invalid serialized data came from a one-byte TC_BLOCKDATA cursor error.
- Full Chrome reaches home, search results, live video/chat, quality selection,
  chat visibility, settings, profile, categories and QR activation. Android Back
  now forwards the APK's Escape event to its WebView. Observed Java missing/errors are empty in the
  main realm and missing APIs are empty in both background realms. Live 720p
  playback advances; this is not yet a controlled performance comparison.
- The isolated WebView loader now declares UTF-8 before executing scripts; rewritten
  scripts also advertise their UTF-8 encoding. A fresh browser verifies the category
  separator, Back navigation and main-queue liveness with empty missing/error lists.
  Full Chrome also verifies the corrected separator on a fresh local origin;
  the original session retained previously decoded scripts.
- Typecheck, all 713 unit tests (20,909 assertions) and Twitch smoke compilation
  (2,360 classes, zero method failures) pass. The final serialized E2E completed all 134 steps in 11 flows; the same suite
  also completed against `f3fefda`. No new missing APIs, queue wedges, capture
  errors, native-required entries or layout/draw errors were observed. Existing
  TikTok splash, Lichess native errors and Flappy Bird low FPS reproduce at baseline.
- Disk space is available again. Isolated Android 35 AVD `webdroid_twitch_ref`
  (5586) boots, but its ARM64-only ABI cannot install the supplied ARM32 split.
  A matching release from APKMirror was unavailable because Chrome blocked its
  download host. Official API 25 ARM32 image reaches Android home in the separate
  `webdroid_twitch_arm32` AVD, but its QEMU CPU hangs during installation, including
  with one CPU and a standard port (5580). Separate crash-report storage resolved
  an old crash-consent dialog blocking retries; graphics now render through host GL.
  Both reference AVDs are stopped. A working ARM32 device or local matching ARM64
  bundle is needed; account-only flows also await user QR activation.
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
