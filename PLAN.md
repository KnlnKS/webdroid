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
- Full Chrome reaches live autocomplete and starts place construction. A fresh headless run
  draws map geometry and labels, with visibly incorrect colors/polygons. Full Chrome has
  still shown a blank map on recent runs. Place/route parity is not achieved.
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

1. Continue rendering diagnosis after verifying the CriticalNative calling convention and
   Scroller completion fixes in Chrome after restart. Chrome passed a JNI environment pointer as glEnable's
   enum; DEX annotations show that method is CriticalNative. A place card remained below
   the screen because computeScrollOffset returned false on its final position update.
   Focused ARM32/A64 and scroller checks pass. Chrome now has zero errors in a bounded
   GL trace, no black label backgrounds, and a visible place card with photos. A JIT-disabled
   headless run still shows incorrect water/polygons. Queue draining now covers a later
   request-worker failure and needs another app pass.
   Place construction also progressed through TextureView transforms, TransitionDrawable,
   corrected set interfaces, Arrays.deepToString, TouchDelegate, clearSpans and Range.
   The preceding blockers were
   Collections.disjoint, Rational, TtsSpan, ScaleGestureDetector and LocaleSpan. Native SQLite
   cache open/query/close now succeeds after the lock-query and shared-file-content fixes.
   Android HTTP header indexing, EGL no-context handles and GLES calls allow styles to load
   and tiles to prepare/draw. Investigate incorrect map rendering and the full-Chrome blank
   map. The startup trace-span mismatch and transient Compose attachment error remain;
   a thread/looper identity fix removed the observed VTO main-thread error in one later run.
   Inspect all process diagnostics and advancing queues/frames again.
2. Exercise matching Maps search/place/directions interactions in Chrome and Android;
   capture screenshots, correct generic failures and record evidence limits.
3. Verify changed contracts, measure functioning startup/idle behavior, then run the full
   serialized E2E suite and compare ambiguous failures to the base. Keep goldens unchanged.
4. Finish focused commits and leave this worktree separate; do not merge.
