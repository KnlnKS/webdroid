# microG integration

## Resume — 2026-09-11

Work resumed from `28b9246` on `codex/microg-webview-base`. Commits `0ff3003` and
`349c4e0` fix the duplicate-base investigation below. Google's current identifier
document supplies one base pointing to `/v3/signin/`; the old proxy added a second.
The server now parses HTML, resolves upstream base hrefs and preserves first-href/
first-target selection, inert templates and standards mode. A temporary fallback
resolves resources before the upstream base is parsed and is removed before later
page scripts run. Genuine microG reaches Google's identifier page with one correct
base, no page exceptions and no missing APIs in the three reached child JVM realms.
This does not establish that the final consent rejection is fixed.

Current checks: typecheck; 603 tests / 20,401 assertions; zero method failures for
Resy, microG and GmsClient; executable framework probes; 6/6 text comparisons.
The serialized E2E run at `0ff3003` reached all 75 scored and 36 smoke steps, with no
new diagnostics versus `28b9246`. The subsequent resource-order refinement passed
12 Chromium tests and repeated isolated WebView/real-microG page checks. Its final
serialized E2E rerun also completed all 111 steps without additional diagnostics;
corpus rendered 13/14 APKs (TikTok failed). Goldens are unchanged. Detailed fresh
CPU/memory comparisons are recorded below.

The genuine SDK map probe exposed missing `BitmapFactory.decodeResource`. Commit
`c376306` decodes through the existing bitmap path using the selected compiled resource's
density, including aliases. Camera movement, animation completion, a default marker,
marker click and title bubble now work. A 33-result bitmap probe matches the dedicated
Android reference for density, sampling, bounds and mutability. Typecheck, 603 units,
affected APK compilation, framework probes and textcmp pass. Its full E2E run completes
111 steps with no additional diagnostics, layout/draw errors or wedges; corpus renders
13/14 with the same 24 distinct gaps as the baseline. Three alternating baseline/current
pairs give median foreground CPU changes of −0.19% cold and +0.17% after reset; retained
JS heap is effectively unchanged. These measure eight FitNotes steps with rendering and
advancing ticks, not all APKs or total browser/process memory. This is bounded map
progress, not full interaction parity.

The extended map flow reproduced a native thread-identity leak: `ResourceLoaderTh`
remained current across CPU waits/yields and reached UI gesture bytecode. The runner
now releases identity while suspended and restores its guest before execution resumes,
including signal delivery (`f459bcb`). Eight ARM32/A64 tests fail on `4acef6d` and pass
with this change. A matched fixed-camera flow completes cancellation, pan, marker replacement,
click and activity reopen without exceptions; the old build throws during gesture
dispatch. Typecheck, 611 units, APK compilation, framework probes, textcmp, all 111 E2E
steps and corpus are verified with no additional diagnostics versus the starting
baseline; corpus retains TikTok's failure (13/14 rendered). Three alternating native
benchmark pairs versus `4acef6d` give median foreground CPU +0.15%, retained JS heap
−0.001% and native execution time +0.59%, with working visible rendering in every run. An earlier click miss at a variable camera position, screen-coordinate
differences and camera-idle callback ordering during interruption remain to investigate.
The expanded SDK trace confirms a 72-pixel mismatch between browser-reported and drawn
map origin (248 versus 320); Android reports/draws 322. Browser map height is 2104 versus
Android 2030 at 1080x2424@480. Both platforms report equal screen/window origins, so a
screen-only offset is insufficient. Correct the owning window geometry, including
system bars and overlays, before changing shared coordinate helpers.

Verified window geometry checkpoint (probe commit `05141f6`):
activity decor now occupies the display and consumes bar insets according to fullscreen,
edge-to-edge and legacy layout requests. Drawing, input and API coordinates share that
space. Dialogs use their actual window bounds, theme padding/minimum width and layout
parameters; the shell handles positioning and dimming. Android/browser probes match
normal/fullscreen/edge/hidden/legacy/popup coordinates and fixed dialog geometry. Wrapped
dialog height retains a two-pixel text difference. Map reports/draws top 320 with height
2032, versus Android 322/2030; the previous 72-pixel discrepancy is gone. Matched gestures,
marker click and reopen pass with all three runtimes observed and no added diagnostics.
Typecheck, 611 units, affected APK compilation, framework probes and textcmp pass.
The first full E2E pass exposed a Flappy Bird flow race: its first flap could press Rate
during the title fade. Commit `6fc0163` waits for the observed transition; three alternating
pairs complete both games without exceptions. Final E2E completes all 111 steps with no additional diagnostics or layout/draw errors;
corpus renders 13/14 with the same 24 gaps. Three alternating pairs against `05141f6`
give median CPU +0.03% cold, −1.29% after reset and −0.34% in the native Doodle tutorial
benchmark; retained JS heap changes at most +0.021%. Detailed frames/idle/memory limits
are in the history. Goldens are unchanged. This is not full window parity: pending
reference coverage includes transformed coordinates, inset/flag notifications, overlay
inset dispatch and broader dialog themes. A follow-up Android probe covers 48x24 and
0x0 dialogs: exact window dimensions now survive background padding, and the child
uses its measured size. Typecheck and the complete geometry probe pass; all 39 FitNotes
PNGs are byte-identical to the window checkpoint, with no additional diagnostics.

The SDK now has a controlled Twice action (second animation after 50 ms). Both Android
and browser deliver one cancellation and one completion; both accept marker clicks at
the resulting camera position. Android emits idle after completion. Webdroid instead
emits idle before cancellation and none after completion, with all three reached
runtime diagnostic sets empty. This is a reproduced platform divergence, not an upstream
waiver. The bundled dispatcher removes pending idle/cancel messages, but Handler.cancel
left the captured message set populated after deleting its map entry. The fix
clears that set so queued jobs cannot dispatch removed messages. Four public-API tests
fail before and pass after; the genuine map now matches Android cancellation/completion/
idle ordering and still passes marker/pan/reopen checks with all three runtimes observed.
Typecheck, 615 units, affected smoke compilation, framework probes and textcmp pass.
All 111 E2E steps complete without added diagnostics; corpus retains 13/14 rendered
and the same 24 gaps. FitNotes' prior FragmentManager-destroyed error disappears.
Three pairs show cold CPU −4.05% and reset CPU +5.60%. A fresh three-pair comparison
with per-step CPU measurements gives −3.06% / −0.14%. Subsequent inspection found
concurrent image encoders overlapping that repeat and the native comparison, so quiet
verification of the original reset increase remains open. Retained heap changes at most
0.039%. Native tutorial CPU is −3.04%, with
3.21% fewer GL frames; this does not establish a throughput improvement. Both series,
idle/frame measurements and their limits are retained in the history.
The cancellation fix is committed as `3c98726`; its matched baseline was `5d7875e`.

A post-GC map reopen probe finds that completed runnable keys accumulate in a
long-lived Handler (7 after the first close, then 11/15/19/23 after successive opens).
The pending queues are empty. Commit `e3c651f` removes a key when its last
message leaves the queue, before dispatch so callbacks can repost safely. Two new tests
fail on `3c98726` and pass after. The repeated map flow now has no completed callback
keys, and Handler instances return to 5 after each close instead of growing to 21.
All three reached runtime diagnostics remain empty. Typecheck, 617 units, framework
probes, affected smoke compilation and textcmp pass; E2E completes 111 steps without
added diagnostics or wedges. Harmonic draw times and native FPS worsen during the
competing encoding load; those comparisons require matched quiet reruns. Corpus
retains 13/14 rendered and 24 gaps. Two newly captured messages reproduce on the
committed baseline (the Reddit startup error needs a longer observation window).
The same loaded-machine Harmonic comparison takes 59.9 seconds on `3c98726` and
51.7 seconds after the retention fix, with no new diagnostics; this reproduces the
slowdown before the fix but does not replace quiet verification. Performance is pending.
The matched baseline is now
`3c98726` on 41983 in `/tmp/webdroid-map-handler-baseline`.

Quiet verification is prepared with three source states: pre-cancellation `5d7875e`
on 41984 (`/tmp/webdroid-handler-cancel-baseline`), cancellation-only `3c98726` on
41983, and current `e3c651f` on 41977. `/tmp/webdroid-handler-quiet-startup.ts` runs
three rotated-order cold/reset pairs across these states using the existing startup
driver; it refuses to begin a run while image encoders are active. Inspect machine
load before accepting timings. Native and affected E2E timing reruns remain necessary.
The user has been asked whether to wait for encoding or pause it for up to 15 minutes;
no permission to pause that other project's work has been received. No processes have
been paused. The encoder parent PID 39311 remains live as of the latest continuation.

The resumed login exposed native History rejecting upstream same-origin URLs on the
isolated renderer. A general history wrapper now translates those URLs, updates the
worker's upstream context and follows generated document bases while preserving explicit
bases. Native state cloning and history traversal remain browser-owned. Differing-port
tests also caught the renderer port surviving URL.host assignment; protocol, hostname
and port are now assigned explicitly. Typecheck and 23 focused Chromium tests pass.
The full suite passed 628 tests / 20,462 assertions before the final port refinement;
the affected Chromium tests were rerun afterward. Broader transport/E2E verification
of this history change remains pending.

With the first history wrapper, Google accepted the supplied test credentials and the
user's phone verification. Consent again failed: `egQ4Re` returned `[[null,true]]`,
then `ihzRS` returned a null result with error field `[13]`. No account was added.
These bodies were captured before navigation under protected `resume-network/` storage;
there were no page errors. This does not establish the cause of Google's rejection.
The port-corrected retry also passed password/phone verification and failed with the
same credential error. Its sanitized request shows hostname `127.0.0.1` and path
`/v3/signin/speedbump/embeddedsigninconsent`, while Origin and Referer origin correctly
equal `https://accounts.google.com`. Cached public code reads window.location.href
through its navigation service and serializes the hostname into GetCredential. This
proves another renderer-origin leak; its causal role in Google's error still needs a
controlled comparison. Do not rewrite this Google-specific payload or fabricate a
credential. Investigate general upstream location semantics before another MFA attempt.
The controlled upstream-location implementation now sends `accounts.google.com` in
GetCredential. The same consent flow returns a payload without error 13, and the
microG-owned cookie jar contains Google's real HttpOnly `oauth_token`. The page reaches
`#close`, but no account is stored yet: fragment navigation does not reach the Java
WebView client's `onPageFinished`. Chromium explicitly delivers that callback without
`onPageStarted` or `onPageCommitVisible` for fragment navigation. The new general
fragment notification (`91d9ff7`) now passes ordinary and isolated WebView transport
tests, including upstream URL mapping and callback ordering. The old isolated
transport times out waiting for that notification. The fresh login passed phone
verification and stored a genuine account plus its refresh credential in the broker's
persistent account store. Finalization then stopped in `AuthResponse.parse` because
`Field.setLong` was missing. Typed primitive field setters now use the shared writer,
preserve long values, widen valid conversions and reject invalid conversions/receivers.
The unchanged microG parser accepts long expiry, boolean and integer fixture values
without missing APIs; the baseline throws the same missing setLong error as the live
run. Java's primitive conversion matrix and long-to-float boundary results agree.
The account survives reload. The picker next required `PackageManager.getApplicationIcon`;
package icons now resolve from their owning archive, with the paired Android default
icon for apps without one. Current/installed/default/missing-resource/unknown-package
browser probes pass without missing APIs. CircleImageView next calls `Matrix.set(null)`;
the delegate now implements Android's identity reset, with a failing-before regression.
The complete account picker works and selecting the saved account returns SDK status 8.
microG logs the upstream cause: `UNREGISTERED_ON_API_CONSOLE`, specifically requiring
the client's package name and SHA-1 certificate registration. Verify the exact Android
reference error and configure the authorized test project before retesting. Typecheck
and 647 tests / 20,595 assertions pass; broader final regression checks remain pending.

The location implementation rewrites static Location references in isolated HTTP(S)
scripts using the existing TypeScript parser on the server. Ordinary objects and local
bindings retain their behavior; the browser still owns its security origin. Integrity
protected scripts are unchanged. Typecheck and all 637 tests / 20,476 assertions pass,
including 32 Chromium cases; genuine identifier/password/verification/consent execute
without page exceptions. This is a bounded implementation: dynamic property names,
generated code, native evaluateJavascript, some destructuring and reflective access
are not virtualized. The callback follow-up captures page-start URLs before queueing
and reports the current upstream URL when parsing changes history before load.
Both cases fail before and pass after. Final checks: typecheck, 642 tests / 20,482
assertions, including 37 focused tests, and both WebView transport paths. The preceding
checkpoint passes zero-failure microG/GmsClient/Resy compilation, framework probes,
6/6 text comparisons and all 111 E2E steps without added diagnostics or rendering
failures versus `28b9246`. Corpus reruns render 13/14 APKs with the same 24 gaps.
An initial headless browser closure during Reddit is not reproduced; two SSL messages
also do not recur in the paired Reddit rerun. Their cause is unresolved. TikTok's
variable Keva gap reproduces on the baseline. Goldens are unchanged. Quiet CPU/memory
acceptance remains open. Image encoders were absent at the latest check; earlier
encoder PIDs are historical, not a current blocker.
The Chrome tab remains open at `http://localhost:41979/?apk=GmsClient.apk`.
Encoding processes remain active under a replacement parent; inspect
current process state rather than relying on the earlier PID for quiet measurements.

Servers: current checkout 41977, original baseline 41978, instrumented login 41979,
runner baseline `4acef6d` on 41981 (`/tmp/webdroid-map-thread-baseline`),
window baseline `05141f6` on 41982 (`/tmp/webdroid-window-baseline`).
The baseline worktree is `/tmp/webdroid-microg-resume-baseline`. Temporary diagnostic
entry points are `/tmp/webdroid-microg-resume-debug-server.ts` and
`/tmp/webdroid-microg-resume-diagnostics.ts`; safe process state is `/diag` on 41979.
Evidence uses `/tmp/webdroid-microg-resume-*` and
`/tmp/webdroid-webview-{relative,resume}-context*`. See implementation history for
the transient fallback's speculative-loading limit and exact verification scope.

Integration started from `82e1afb` on `codex/microg-integration`. The merged integration is on `main` alongside `6946f16`.
Completion continued from `b567197` on `codex/microg-completion`; the handoff below
records its merge into `main` and the remaining work.
Run genuine microG and client APK bytecode; add Android platform behavior, never
app-specific substitutes. Keep comments and dependencies minimal.
The resume section is current; the handoff below retains the preceding checkpoint.

Generated microG bundles belong in ignored `vendor/microg/`. Commit the preparation
script and pinned metadata only. Generate missing files during setup/server startup;
reuse complete bundles without downloading or reprocessing the source APKs.

## Handoff — 2026-09-10

This section supersedes the older chronological status below. Implementation is paused
at the user's request; the completion worktree is merged into `main`. Resume in
`/Users/kunalan/Projects/webdroid`. Branch `codex/microg-completion` started at `b567197`;
its focused commits retain the implementation history.

### Current implementation

Genuine microG v0.3.16.252432 and Companion run as installed system packages. Resy's
Play Services availability dialog is resolved. This is a working integration checkpoint,
not full Android parity. Google authentication in webdroid remains unsuccessful.

- Package preparation, signature grants, metadata and lazy DEX/native loading work.
  Per-process JVM realms communicate through real Binder/Parcel routing. Services,
  providers, broadcasts and cross-process activities execute genuine APK bytecode.
- Preferences, private files and account records have shared broker ownership.
  Bound-service death notifies clients and reconnects auto-create bindings. PendingIntent
  and alarm ownership survives creator death. Activity task membership/root removal work.
- AccountManager binds installed authenticators, routes asynchronous futures and login
  activities, checks caller identity/account visibility and handles replies/cancellation.
  Platform fixtures pass; they do not establish a real Google account in the browser.
- Real checkin, FCM registration, retained token after reopen, one received test push and
  its upstream acknowledgement were observed. An unaccelerated five-minute MCS alarm
  restarted the killed process and reconnected at 306.815 seconds. This establishes
  delayed recovery, not immediate sticky-service restart or another receipt after death.
- Browser geolocation reaches genuine microG fused-location bytecode. High/balanced
  priorities, denial/regrant, removal and process cleanup were tested. The pinned package
  profile disables microG's optional internal radio provider by default so its own
  fallback uses the browser-backed platform provider; explicit settings win. WGS84
  distance/bearing results match six Android float fixtures.
- Native/JNI and graphics fixes allow real map tiles/labels, loaded/camera-idle callbacks
  and panning. Complete map interaction parity remains open.

### Google sign-in: exact stopping point

Password and phone verification succeed in webdroid. Choosing the device user and
accepting the already-authorized Google terms leads to "Something went wrong".
Fresh retries reproduced this; it is not established to be merely an expired tab.

The same account and pinned microG build on the dedicated Android reference passed
consent, stored one real `com.google` account and reached microG's account chooser.
Selecting it returned SDK authentication status 8, a separate unresolved downstream
error. Do not import Android tokens to substitute for successful browser authentication.

The latest browser trace reached the genuine `notifyOnTermsOfServiceAccepted` bridge.
Consent RPC `egQ4Re` returned HTTP 200 and `[[null,true]]`; the next RPC `ihzRS` also
returned HTTP 200, then navigated to `/v3/signin/unknownerror`. Its response body was
not recovered through CDP after navigation. Five reached runtime diagnostic sets were
empty. No `oauth_token` or newly authenticated Google account was observed in webdroid.

A verified URL bug was corrected in `src/shell/webinject.ts`: internal `__wd_bridge`,
`__wd_url` and `__wd_ua` parameters were visible to the page and copied into Google's
final RPC. Bootstrap context now lives outside the visible URL; the worker obtains it
through messaging and a bounded cache, including after restart. The corrected attempt
sent a clean query but still failed. Retain this for URL correctness, not as a login fix.

**Investigation resolved in the resume above:** `server.ts` unconditionally injected a `<base>` element,
even when the upstream document supplies one. Google's loaded script reported
`Cannot read properties of null (reading 'replace')`. Reading that actual script found
`_.pab` returns a base path only when `getElementsByTagName("BASE").length == 1`;
its caller immediately invokes `.replace`. The resume fixes this using a general HTML
transformation and Chromium tests. Causality for the final authentication rejection
remains unproven.

Another unresolved observation: `/_/bscframe` returned HTTP 200 followed by Chromium
`ERR_BLOCKED_BY_RESPONSE`, with SAMEORIGIN/same-site restrictions. The isolated renderer
origin differs from Google's. Do not indiscriminately remove security headers. Both
platforms logged microG's genuine local-DroidGuard fallback; no result was fabricated.

Relevant owners: `src/android/webkit.ts`, `src/shell/webinject.ts`, `webbridge.ts`,
`webcookies.ts`, `server.ts`, and the Android modules `authenticator.ts`,
`accountrequest.ts`, `accountfuture.ts`, `accounts.ts`. Pinned upstream
[LoginActivity.java](https://github.com/microg/GmsCore/blob/v0.3.16.252432/play-services-core/src/main/java/org/microg/gms/auth/login/LoginActivity.java)
and [DroidGuardHandler.kt](https://github.com/microg/GmsCore/blob/v0.3.16.252432/play-services-core/src/main/kotlin/org/microg/gms/auth/login/DroidGuardHandler.kt)
are also cached under `/tmp/webdroid-microg-*`. LoginActivity reads `oauth_token` at
its genuine close/programmatic-auth URL, exchanges it and saves the account. Terms
acceptance alone does none of these steps.

### Verification and remaining challenges

At `a780ce4` (documented by `3eadfac`): typecheck, 1,002 units / 47,229 assertions,
zero smoke failures for Resy/microG/SDK, executable framework probes and 6/6 text
comparisons pass. Serialized E2E reached all 75 scored steps with unchanged goldens;
corpus rendered 13/14 APKs. Existing FitNotes/Harmonic exceptions, Flappy FPS failures,
Lichess's responsive loading screen and TikTok failure remain. See the final checkpoint
below for scores and controlled baseline comparisons.

CPU medians versus `b567197`: cold +3.59%, reset +5.56%; delayed microG provider/class
startup adds work. Settled nine-step CPU median +0.22%; live JS heap 129.0 → 137.6 MB,
excluding Wasm/external memory. These are bounded measurements, not a speedup claim.

The final URL correction passed typecheck, 3 focused cookie/relay tests (25 assertions)
and a real isolated-browser fixture covering redirects, synchronous Java results,
HttpOnly boundaries, POST body/cookies, Android user-agent, clean visible query, worker
restart and persistent-only cookies after reopen. Evidence:
`/tmp/webdroid-webview-context-{check,typecheck,unit}.log`; fixture:
`/tmp/webdroid-webview-context-check.ts`. The full earlier E2E/performance matrix was
not repeated for this WebView correction. The closing full unit run passed 1,002 tests
with zero failures and 47,229 assertions in 76.10 seconds; output is retained at
`/tmp/webdroid-webview-handoff-unit.log`.

Resy's remaining notification-configuration dialog is its Firebase HTTP 400 invalid
configuration, reproduced with the same APK on Android. Evidence:
`/tmp/webdroid-resy-final-{android,browser}.{png,json}`. The dedicated SDK's successful
push receipt does not repair that APK's configuration.

Other open breadth: task affinity/launch modes, sticky-service crash policy/crash loops,
token-by-features account selection, encrypted account sessions/notification consent,
full map parity and broader lifecycle coverage. Legacy per-package account storage has
no production migration to the new shared account store.

### Resume references and cleanup

- Dev servers on 41863 and 41973–41976 are stopped for handoff. Start a private port
  from main. The prior auth URL was `http://localhost:41973/?apk=GmsClient.apk`; it
  ended on Google's error screen, not a live challenge or successful browser session.
- Dedicated reference: `emulator-5580`, Android 15/API 35, same pinned microG. It now
  contains the authorized test Google account. Webdroid advertises API 33; compare
  compatible wire contracts. The optional radio provider remains disabled to match
  the browser profile. ADB: `/Users/kunalan/Library/Android/sdk/platform-tools/adb`.
  Inspect narrowly; do not dump account databases or raw authentication logs.
- Firebase project `webdroid-microg-test`, Android package `org.webdroid.gmsclient`,
  Spark/free plan, no billing, Analytics/Gemini off. Private configuration directory:
  `/Users/kunalan/Library/Application Support/webdroid/test-config/`, containing
  `google-services.json` and protected `browser-state.json`. Never print, commit or
  overwrite credentials, cookies, checkin IDs or tokens. Account authorization remains
  in conversation history; passwords deliberately are not recorded here.
- APKs, generated microG/AOSP packages and dependencies already belong to main and
  were symlinked into the worktree. Do not overwrite `apks/GmsClient.apk`. Preserve the
  rebuilt client separately at `tests/gms-client/app/build/outputs/apk/debug/`.
  Generated Wasm blobs are never committed. Temporary `/tmp` evidence may expire.
- Earlier evidence: `/tmp/webdroid-gms-completion-receipt.{png,json,log}`,
  `/tmp/webdroid-mcs-death-check.{ts,json,log}`, `/tmp/webdroid-profile-final-*`,
  `/tmp/webdroid-profile-perf-{baseline,final}-{1,2,3}.json` and
  `/tmp/webdroid-profile-steady-{baseline,final}{,-2,-3}.json`. The old receipt script
  can overwrite protected state and tests a total rather than a fresh count delta;
  do not rerun it unchanged. Keep trace secrets outside reports.
- For live login, discover the current Chrome iframe debugger target; old session IDs
  become stale. Enable Network before the action in the current turn and capture bodies
  before navigation drops them. Existing terms acceptance is authorized; actual phone
  challenges still require the user. Further MFA attempts need a concrete hypothesis
  and sufficient tracing. No additional sign-in work was started during final cleanup.

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
