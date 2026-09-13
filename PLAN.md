# Twitch parity

Worktree: `codex/twitch-parity`, based on `f3fefda`. Do not merge into main.
Only Twitch is under app testing during development; run the full serialized E2E
suite at the end, with unchanged goldens.

## Current evidence

- Full Chrome: `http://localhost:4106/?apk=Twitch.xapk&screen=720x1280@320`.
- The existing XAPK is Twitch Android TV, version 13.0.0.2, ARM32.
- Starting code throws in MediaSessionCompat creation: RemoteCallbackList is
  absent. onCreate fails; onResume then reads an uninitialized Kotlin property.
- Callback-list implementation follows the paired AOSP framework bytecode.
  Targeted tests cover Binder identity, snapshot iteration, replacement,
  unregister/kill and remote death. Twitch next reaches missing MediaSession.
- Other observed gaps: Thread.getState and PackageInfo.requestedPermissionsFlags.
  WorkManager also reports invalid serialized primitive data; investigate its cause.
- A separate AVD could not start because disk space is exhausted. User choice
  pending: use the existing emulator-5584 or free space for an isolated reference.

## Remaining work

1. Launch the same package on Android and capture matching interactions.
2. Implement evidenced platform behavior, starting with MediaSession. Continue
   until Twitch works or an independently verified external limitation is reached.
3. Capture screenshots and inspect errors, missing APIs, rendering, main-queue
   liveness and performance. Keep app and bundled library bytecode unchanged.
4. Make focused commits with regression checks and record durable findings in
   docs/implementation-history.md. Complete full serialized E2E only at the end;
   investigate ambiguous failures against the starting commit under matching inputs.

Ignored investigation artifacts: `tests/e2e/actual/twitch-investigation/`.
