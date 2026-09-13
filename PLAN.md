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
- Further commits cover SAX, ClipData/IntentFilter parcels, StatsEvent, TimeAnimator,
  provider file snapshots, serialization block lengths, live-thread enumeration,
  TLS ALPN, URI parsing and CharSequence encoding. Bootstrap platform queries are committed.
- Real TLS probes through the relay and through Java SSLSocket negotiate HTTP/2 with Google.
  Maps progressed through TLS selection and URI encoding to DNS address selection;
  subsequent fixes cover connected socket endpoints, hierarchical URI construction,
  cyclic barriers, stream composition, buffer ranges, View.ALPHA and abstract reflection.
- A later microG receiver reached missing Intent list extras; the getter/setter fix is
  committed and requires another all-process check. Main-process
  capability probes still name unsupported hardware/service classes; do not treat empty
  service telemetry as complete app coverage.
- Maps smoke: 72,887 classes, zero method failures. Focused checks and typecheck pass at
  recent checkpoints; rerun affected checks after subsequent edits. Full E2E not run yet.

## Next

1. Follow home rendering after the layout-listener, media-performance-class and TableLayout
   fixes. Fresh onboarding succeeds; skipping it exposed an undefined Build.VERSION field
   that aborted the transition, then a missing TableLayout setter. Fresh Chrome and a
   Maps-only headless probe are being checked again. Earlier headless coordinate taps
   used pixels where the harness expects fractions, so those runs did not leave onboarding.
   Native disk-cache creation reports SQLite error 15 (locking protocol); inspect native
   evidence before changing the VFS. Read all process diagnostics and distinguish slow
   initialization from a deadlock using advancing frames and queue state.
2. Exercise matching Maps search/place/directions interactions in Chrome and Android;
   capture screenshots, correct generic failures and record evidence limits.
3. Verify changed contracts, measure functioning startup/idle behavior, then run the full
   serialized E2E suite and compare ambiguous failures to the base. Keep goldens unchanged.
4. Finish focused commits and leave this worktree separate; do not merge.
