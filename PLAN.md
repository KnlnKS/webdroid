# Google Maps parity

## Scope

Work on `codex/maps-parity`, isolated from concurrent main work. Do not merge.
Run the unchanged `apks/Google Maps.apk` (26.37.05.977222275), comparing Chrome
at port 4126 with `webdroid_maps_ref`, emulator-5588, API 35 Play Store,
1080×2424 @480 dpi. Preserve visual goldens. Focus tests on Maps and affected
platform contracts; run the full serialized E2E suite at the end.

## Checkpoint

- Full installed Chrome runs the unchanged APK at port 4126 with JIT enabled.
  Search, place details, directions and preview are reachable. Settled full-JIT previews
  render water, roads and labels, although initial tile preparation can take tens of seconds.
  Screenshot parity is not achieved.
- Android reference captures include home, place, Ferry Building driving directions,
  and route preview. Captures are in `webdroid-shots/maps/` (ignored).
- Focused commits now cover native loading/rendering, networking, platform value and
  collection contracts, resources and widgets, attachment lifecycle ordering, date
  ranges, ICU percentage formatting, floating array search, and Handler thread identity.
  Evidence and limitations are recorded in `docs/implementation-history.md`.
- AnimatorSet start callbacks now make the incoming search container visible and
  clear the app's full-screen flag when directions open. Route lines and the preview
  maneuver render. Awaiting inherited compound-button measurement fixes clipped
  place action chips. LinearLayout cross measurement now keeps preview controls at the
  bottom. Unicode block lookup, file-descriptor bitmap decoding and sequential lists cover
  additional observed failures. Image invalidation, outline clipping and foreground drawing
  restore the rounded place thumbnail with its border. Search titles ellipsize; concatenated
  replacement spans render rating stars. Virtual image-filter dispatch restores preview arrow
  colors. Resource density now corrects map-marker size; Canvas stroke draws the map-label outlines.
  Fonts, wrapping and shadows still differ. Fresh-data Android also omits the first preview
  thumbnail, so its absence alone does not establish a runtime defect.
- The startup LoginPromoTutorialController trace-span mismatch was traced to FutureTask
  invoking completion on the ambient main thread after worker suspension. The callback now
  retains its executing thread; a fresh Chrome startup reaches the sign-in tutorial without it.
  The previously observed detached AndroidViewHolder error is absent in fresh runs.
- Photo viewing, paging to video, reaction prompts, playback, pause, seeking and Close now
  work on observed paths. Native SeekBar and framework drawable resources provide the track
  and thumb; streaming HTTP and audio capability queries let the bundled player decode video.
  Fresh Chrome screenshots and per-step telemetry are in `webdroid-shots/maps/`.
- Unchanged pre-draw padding no longer requests layout: a fresh Pause check dropped from
  295 layout passes to 1 (844 ms to 18 ms of layout time). Drawing remains active while the
  app's animator runs. This is a matched interaction, not a general startup-speed claim.
- Fresh Maps smoke: 72,887 classes, zero method failures; Resy smoke also has zero
  method failures. Typecheck, the corrected EGL browser fixture and all 899 unit tests
  (22,174 assertions) pass. Framework exercises pass, with 295/363 declared natives
  registered and Paint.measureText skipped without a DOM.
- Final serialized E2E at a3bf33e completed 134 steps across 11 flows in 699.3 seconds.
  No main-loop wedges, layout/draw errors or nativeRequired entries were recorded.
  Resy's 12 steps have zero missing APIs/errors and the venue photo renders. The scored
  content mean is 35.95%, versus 36.29% at f3fefda; visual parity remains far from complete.
  TikTok still shows its baseline splash failure; the earlier vsnprintf exception and missing
  FileOutputStream(FileDescriptor) were not reproduced in this run, but remain unresolved
  intermittent observations. Lichess's baseline pthread failure families recur more often.
  Another worktree ran tests concurrently for part of the matrix, limiting timing comparisons.
  Capture completion is not a functional pass or a clean regression verdict.
- EGL10 and EGL14 no longer overwrite another worker's binding. The map's bad-surface
  failure is fixed by thread-local EGL/GL ownership, including native dispatch and error
  state. Fresh native-JIT Chrome preview presents 77 GL frames in 10.14 s; successive
  maneuvers have no new missing APIs or errors. Media decoding, seeking and Close also
  pass fresh checks with 1,300+ decoded video frames. See implementation history for limits.
- Post-crash place-sheet failures exposed stateful TextView link colors and
  SuperscriptSpan. Both now follow platform behavior; fresh place/route/preview captures
  have zero layout/draw errors. ARM64 floating arguments beyond v0–v7 now go directly
  to stack slots rather than consuming integer registers. This restores the native map
  matrices and renders streets, buildings, water, and route geometry in full Chrome.
  Captures `chrome-arm64-spill-preview.png` and `android-arm64-spill-preview.png` show
  the same first maneuver; successive maneuvers also render. Diagnostic hooks were removed.
- Bitmap shader tile caching removes repeated canvas allocation across shader
  instances (over 900,000 allocations in one earlier diagnostic run). Normal Chrome
  now survives repeated place/route interactions; this does not prove every crash
  resolved. Diagnostic instrumentation invalidates timing results.

## Remaining work

1. Exact screenshot parity is not achieved. Font wrapping, shadows and system-bar
   geometry still differ; base-map geometry is restored after the ARM64 argument fix. Both captures use
   1080×2424 @480 dpi, but webdroid reports API 33 with 24 dp system bars and the reference
   uses API 35 with a display cutout; the device environments are not identical.
2. microG returns Roboto for font requests. Vector clip paths and animated-selector
   transitions remain unsupported; SeekBar keyboard/RTL behavior is not covered.
   Optional service/class probes still appear in Maps diagnostics.
3. Investigate the earlier intermittent TikTok native fault before claiming no regressions.
   It was absent from the latest run, which has 110 errors and 18 missing APIs versus
   baseline 81/19. Lichess has 53 errors versus baseline 13, with the same pthread families;
   an earlier branch run had only 10. Performance and visual comparisons are retained under
   `webdroid-shots/maps/` and `tests/e2e/report/`; visual goldens are unchanged.
4. Work remains isolated on `codex/maps-parity`. Temporary diagnostic source files were
   removed; the comparison worktree at f3fefda is retained and its server is stopped.
