# Google Maps parity

## Scope

Work on `codex/maps-parity`, isolated from concurrent main work. Do not merge.
Run the unchanged `apks/Google Maps.apk` (26.37.05.977222275), comparing Chrome
at port 4126 with `webdroid_maps_ref`, emulator-5588, API 35 Play Store,
1080×2424 @480 dpi. Preserve visual goldens. Focus tests on Maps and affected
platform contracts; run the full serialized E2E suite at the end.

## Checkpoint

- Full installed Chrome runs the unchanged APK at port 4126 with JIT enabled.
  Search, place details, directions and preview are reachable. Base-map rendering
  remains inconsistent; screenshot parity is not achieved.
- Android reference captures include home, place, Ferry Building driving directions,
  and route preview. Captures are in `webdroid-shots/maps/` (ignored).
- Focused commits now cover native loading/rendering, networking, platform value and
  collection contracts, resources and widgets, attachment lifecycle ordering, date
  ranges, ICU percentage formatting, floating array search, and Handler thread identity.
  Evidence and limitations are recorded in `docs/implementation-history.md`.
- AnimatorSet start callbacks now make the incoming search container visible and
  clear the app's full-screen flag when directions open. Route lines and the preview
  maneuver render. Awaiting inherited compound-button measurement fixes clipped
  place action chips. Preview control geometry and base-map GL output remain under
  investigation, alongside text and image differences.
- Startup still reports the LoginPromoTutorialController trace-span mismatch. The
  Handler identity fix passes focused tests but did not remove that app error.
  The previously observed detached AndroidViewHolder error is absent in fresh runs.
- Maps smoke at an earlier checkpoint: 72,887 classes, zero method failures. Focused
  checks and typecheck pass after recent edits. Full E2E has not run yet.
- Bitmap shader tile caching removes repeated canvas allocation across shader
  instances (over 900,000 allocations in one earlier diagnostic run). Normal Chrome
  now survives repeated place/route interactions; this does not prove every crash
  resolved. Diagnostic instrumentation invalidates timing results.

## Next

1. Diagnose remaining base-map rendering and preview layout failures. Continue
   checking startup thread/span ordering and remaining API failures against
   Android/bytecode evidence.
2. Exercise matching Maps search, place, directions and preview interactions in Chrome
   and Android. Capture fresh screenshots; fix geometry and behavior without app cases.
3. Verify affected contracts and Maps compilation, measure functioning rendering with
   instrumentation disabled, then run the full serialized E2E suite. Compare ambiguous
   failures to starting commit `f3fefda` under matching settings; preserve goldens.
4. Remove temporary diagnostics, finish focused commits, leave the worktree separate.
