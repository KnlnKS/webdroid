# Google Maps parity

## Scope

Work on `codex/maps-parity`, isolated from concurrent main work. Do not merge.
Run the unchanged `apks/Google Maps.apk` (26.37.05.977222275), comparing Chrome
at port 4126 with `webdroid_maps_ref`, emulator-5588, API 35 Play Store,
1080×2424 @480 dpi. Preserve visual goldens. Focus tests on Maps and affected
platform contracts; run the full serialized E2E suite at the end.

## Checkpoint

- Own Chrome tab: `http://localhost:4126/?apk=Google%20Maps.apk&screen=1080x2424@480`.
- Android reference captures home, Golden Gate Bridge place details, and a driving route
  from Ferry Building. Files are in `webdroid-shots/maps/` (ignored).
- Chrome reaches the search bar and UI construction. Maps tiles and matching search/route
  interactions are not working yet; do not claim parity.
- Focused commits cover native APS2/RELR relocation, executor virtual factories/completion,
  matrix inversion, AtomicFile, value contracts, frame constructors/relative rules,
  reference queues, message queues, integer buffers, provider identity and widget/GL types.
- Uncommitted work includes SAX, bootstrap platform APIs, ClipData/Parcel, IntentFilter
  path matching, StatsEvent, TimeAnimator and the next GLES operations.
- Maps smoke: 72,887 classes, zero method failures. Focused checks and typecheck pass at
  recent checkpoints; rerun affected checks after subsequent edits. Full E2E not run yet.

## Next

1. Follow native rendering, Cronet/network startup and remote provider openFile failures.
   Read all process diagnostics. Distinguish slow initialization from a deadlock using
   advancing frames, queue state and initialization/task state.
2. Exercise matching Maps search/place/directions interactions in Chrome and Android;
   capture screenshots, correct generic failures and record evidence limits.
3. Verify changed contracts, measure functioning startup/idle behavior, then run the full
   serialized E2E suite and compare ambiguous failures to the base. Keep goldens unchanged.
4. Finish focused commits and leave this worktree separate; do not merge.
