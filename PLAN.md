# TikTok, Resy and YouTube parity

## Scope

Run the exact bundled TikTok 46.8.3, Resy 1.18.0-687 and YouTube 21.36.45 APKs unchanged in webdroid and on the dedicated Android reference. Exercise guest-accessible core flows, capture paired structural screenshots and implement only Android/JDK/native behavior reached by those flows. Keep fixes general, measured and small.

TikTok work starts from the existing TikTok worktree. Each app is investigated in an isolated worktree and integrated through focused commits on `codex/app-parity`.

## Acceptance

- Full Chrome has one visible webdroid tab for each exact APK.
- The Android reference and webdroid reach matching app states for the selected guest flows.
- Resy browses nearby inventory, searches for Carbone, opens the venue, returns and opens location search.
- TikTok clears first-run gates, resumes the guest For You feed and shows distinct advancing video after two swipes.
- YouTube searches for Big Buck Bunny, opens the player, exercises controls/pause/resume/fullscreen/back and shows distinct Shorts after a swipe.
- Reached telemetry has no unexplained missing platform API, native requirement, runtime error, layout/draw fault or main-loop wedge. Optional vendor probes and explicit upstream service gates remain classified, not fabricated.
- Focused tests, typecheck and affected APK smoke compilation pass.
- Run the complete serialized E2E suite exactly once, after targeted acceptance is complete, without changing goldens.

## Current checkpoint

- Exact AVD flows and paired screenshots are captured for all three apps.
- Resy completes all 13 webdroid steps, including Carbone search, venue navigation and Near Me, with clean reached telemetry. A Java-EGL10/native-GLES current-context ownership mismatch that deadlocked MapLibre is fixed at the Android guest-thread boundary.
- TikTok completes all 13 steps, resumes the guest For You feed and renders distinct advancing video after both swipes without a native fault or main-loop wedge. The A64 saturating variable-shift path and native virtual-address allocation are now general implementations rather than app-specific handling.
- YouTube completes all 16 steps, including search, player controls, pause/resume, fullscreen/back and distinct Shorts after a swipe. SurfaceView late-frame composition and the unavailable-input AudioRecord contract cover the reached platform gaps.
- Visible full-Chrome tabs show TikTok's live feed and Resy's MapLibre nearby map. YouTube's deterministic browser capture renders every tested state; a manually reused full-Chrome tab can intermittently present a black canvas while its Android view tree and frame counter continue advancing.
- Focused regression tests and typecheck pass. All three APK smoke compilations report zero method failures. Optional vendor classes and explicit hardware/service probes remain classified rather than fabricated.
- The single serialized full E2E run finished successfully in 806.8 seconds. All flows rendered every step; TikTok was 13/13, Resy 13/13 and YouTube 16/16, with no main-loop wedge or settle timeout in those runs. Exact-app capture goldens stayed uncommitted and unchanged.

## Completion

The TikTok/Resy/YouTube implementation was integrated before the Maps merge. Current verification limits are recorded in the implementation history.

## Maps integration

The Maps platform work is integrated with current main, retaining both sets of regression
tests. Typecheck and unit tests pass; Maps, Amazon and TikTok compile without method failures.
The full 159-step matrix and focused starting-main comparisons are recorded in
[the implementation history](docs/implementation-history.md), including the pre-existing
TikTok failure and the inconclusive YouTube playback comparison. The previous Maps scope and
evidence are archived in [the Maps branch plan](docs/maps-parity-plan.md). Screenshots and
reports are retained under `webdroid-shots/maps-merge/` for worktree cleanup.
