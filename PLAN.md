# Twitch parity

Worktree: `codex/twitch-parity`, based on `f3fefda`. Do not merge into main.
Only Twitch is under app testing during development; run the full serialized E2E
suite at the end, with unchanged goldens.

## Current mobile build

The user replaced `apks/Twitch.xapk` with Twitch mobile 31.0.0 (3100006), ARM64,
min SDK 26 / target 36. This supersedes the TV build for current acceptance.
The complete unmodified three-split bundle installed on `webdroid_twitch_ref`
(API 35, emulator-5586). Android reaches the welcome screen and web login form.
Its LoginActivity has FLAG_SECURE: Android screencap is black, while captures of
the visible emulator window show the screen without changing the APK or flags.

Full Chrome uses port 4109 for the mobile install. Port 4107 served isolated
headless verification; that server and the baseline/old-TV servers are stopped. Startup and login now render with the generic API fixes
recorded in implementation-history.md. Focused tests and typecheck pass.
WebView layout now uses Android density and early script evaluation waits for
document readiness. Welcome category bounds match Android after hierarchy, span,
font-metric and drawable-reference fixes. The APK native WebView bridge now handles
login Back navigation through shouldInterceptRequest;
signed-in flows await user authentication in Chrome and the AVD.
The 58,282-class APK smoke-compiles with zero method failures. Development testing
focused on Twitch. The first final full E2E exposed StyleSpan/RelativeSizeSpan draw
regressions; both now implement Android paint updates, with focused tests passing.
The second serialized full E2E completed all 134 steps in 11 flows, with no new
missing APIs, native-required entries, queue wedges, capture errors or layout/draw
errors. One intermittent Resy watchdog diagnostic remains unresolved.
All 735 earlier unit tests pass (21,015 assertions); three added metric-span tests
pass with ten more assertions. Typecheck passes.
Artifacts: `tests/e2e/actual/twitch-investigation/mobile-31/`.

## Previous TV build evidence

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

1. Investigate the intermittent Resy Okio watchdog failure and the caught Twitch
   `length()I is not a function` lookup seen once in ordinary Chrome. Neither
   reproduced in the targeted repeats; they have not been classified as fixed.
2. User authentication in Chrome and the AVD is required to exercise the mobile
   feed, search, and playback. Both are left at login.
3. Full Chrome startup varied from 8 seconds through the desktop UI to 25.8/48.2
   seconds in instrumented tabs; Browser Use reported paused document loading.
   Headless startup was roughly 1.6 seconds. Automation overhead is a candidate
   cause, not a proven explanation. Performance parity is not demonstrated.
   A browser keyboard-map permission-policy error also recurs in the dark-mode
   headless check, without preventing the tested login/Back interactions.
4. Continue from authenticated sessions, preserving APK and library bytecode, and
   record further evidenced platform fixes with focused commits.

Ignored investigation artifacts: `tests/e2e/actual/twitch-investigation/`.
