# microG integration

## Current checkpoint

Branch `codex/microg-webview-base` continues from `28b9246`. At `3902e02`, genuine
microG v0.3.16.252432 and the unchanged Google SDK client complete DEFAULT_SIGN_IN
in webdroid and on the dedicated Android reference. Browser authentication succeeds
again after a full reload using its persisted account. All four reached processes
have empty missing-API sets; the successful flows have no console errors or auth
warnings. Other OAuth scopes, server auth codes and ID-token modes remain unverified.

The branch fixes upstream WebView base/history/location behavior and fragment
completion, reflective primitive field writes, application icons, Matrix.set(null),
Semaphore.drainPermits and preference type errors. The test app also needed its actual
package/SHA-1 registration and Google provider enabled in Firebase. No APK, token or
callback substitute was used. Failure mechanisms, controlled comparisons and evidence
limits live in [implementation history](docs/implementation-history.md).

The integration also provides:

- Pinned microG/Companion provisioning, scoped signature grants and lazy DEX/native
  loading. Resy passes its genuine Play Services availability check.
- Separate process JVM state, Binder/Parcel routing and broker-owned preferences,
  files and accounts. Broader lifecycle and account API coverage remains open.
- Real checkin, FCM registration, retained token after reopen, one received test push
  and upstream acknowledgement. A real five-minute alarm restarts a killed MCS
  process and reconnects; immediate restart and receipt after death are not established.
- Browser-backed location through genuine microG fused-location bytecode, with
  priority, denial/regrant, removal and process cleanup coverage.
- Real map tiles, camera movement, animation interruption, markers/clicks, pan and
  activity reopen. Window geometry fixes remove the former 72-pixel origin mismatch.
  Handler cancellation now matches Android callback ordering; completed callbacks
  no longer retain reopened map activities.

## Verification

At the authentication checkpoint: typecheck; 650 tests / 20,620 assertions; zero
method failures for microG, GmsClient and Resy; executable framework probes; 6/6 text
comparisons. Serialized E2E renders all 111 steps without added missing/error/native
requirements, layout/draw errors or wedges versus `28b9246`. Goldens are unchanged.

Corpus renders 13/14 APKs on both builds. TikTok remains the failure; current reaches
25 distinct gaps versus 23 in the matched baseline capture. The additional Keva
nativeStoreString diagnostics are not reproduced on baseline; shorter paired runs
have identical diagnostics but do not reach that call. No other APK adds diagnostics.

Performance acceptance remains open. Two matched Harmonic pairs show about 15.5%
more foreground CPU and 43-second flows versus 24–25 seconds on baseline, with a
persistent shimmer callback. A direct full current run returns to 24.32 seconds.
All runs render visibly with advancing ticks. No competing image encoders are present
in these latest comparisons; earlier Handler measurements overlapped encoding and
cannot establish quiet acceptance. Detailed series and limits are in the history.

## Next work

1. Reproduce the retained Harmonic shimmer and inspect its ancestor visibility.
   APK bytecode stops it through onVisibilityAggregated; View.setVisibility currently
   does not dispatch visibility callbacks. Attachment/hide ordering is a hypothesis,
   not an established cause. A delayed topstories request did not reproduce it.
   Implement general AOSP callback behavior only after confirming the mechanism.
2. Complete quiet cold/reset startup, native, memory and idle comparisons for the
   Handler changes. Use exact committed baselines and no competing diagnostic load;
   investigate repeatable foreground CPU increases above 5%.
3. Extend Android parity coverage: transformed window coordinates, inset/flag
   notifications, overlay inset dispatch, dialog themes, task affinity/launch modes,
   sticky-service crash policy, account selection by features, encrypted account
   sessions and consent. Legacy per-package accounts have no production migration.
4. Track TikTok's additional Keva call coverage. Resy's Firebase HTTP 400 configuration
   error reproduces on Android; the SDK's successful push does not repair that APK.

## Fixtures and resume

See [SDK probes](tests/gms-client/README.md) for sign-in, map, bitmap and window
verification. Preserve `apks/GmsClient.apk`; rebuilt probes belong under
`tests/gms-client/app/build/outputs/apk/debug/`. Generated Wasm and microG bundles
remain ignored. Complete package bundles must not be downloaded/reprocessed again.

The dedicated Android reference is `emulator-5580`, API 35, with the same microG build;
webdroid advertises API 33. Compare compatible contracts. Firebase project
`webdroid-microg-test` uses package `org.webdroid.gmsclient`, Spark/free with no billing.
Private configuration and browser state are under
`/Users/kunalan/Library/Application Support/webdroid/test-config/`. Never print or commit
credentials, cookies, checkin IDs or tokens. Inspect auth diagnostics narrowly.

The last successful Chrome session used `http://localhost:41979/?apk=GmsClient.apk`.
Discover current servers, checkouts and browser targets before reusing them; old ports,
PIDs and debugger IDs are not evidence of current source. Temporary `/tmp` evidence
may expire; committed regressions and the history preserve durable findings. The old
receipt script can overwrite protected state and counts total receipts rather than a
fresh delta; do not rerun it unchanged. Further MFA attempts require a concrete
hypothesis and tracing; phone challenges remain interactive.

## Acceptance

Run genuine app and library bytecode unchanged. Keep implementation minimal and
platform-owned. Bundle pinned microG and Companion; enable checkin and messaging
without another opt-in screen. Push must work while webdroid is open and recover on
reopen. Live tests use the authorized test account and dedicated no-billing project;
messages go only to test installations. An upstream limitation needs matching Android
evidence. Full Android parity is not established by the verified flows above.

Select checks for each change following [AGENTS.md](AGENTS.md). For integration
acceptance, run typecheck, units, affected APK compilation, framework checks, textcmp,
serialized E2E and corpus without changing goldens. Compare cold/warm startup, frames,
compilation, IPC, memory and idle work. Use focused `area: sentence` commits.
