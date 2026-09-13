# Google Maps parity

## Scope

Work on `codex/maps-parity`, isolated from concurrent main work. Do not merge.
Run the unchanged `apks/Google Maps.apk` (26.37.05.977222275), comparing Chrome
at port 4126 with `webdroid_maps_ref`, emulator-5588, API 35 Play Store,
1080×2424 @480 dpi. Preserve visual goldens. Focus tests on Maps and affected
platform contracts; run the full serialized E2E suite at the end.

## Checkpoint

- Android installs the unchanged Google-signed APK and renders home, tiles and
  search results. Captures are in `webdroid-shots/maps/` (ignored).
- Starting commit `f3fefda` fails before the first app frame on Process.isApplicationUid.
- Platform initialization fixes in progress: application UID classification, preferred
  refresh rate, URI permission checks, provider metadata/properties, executor adapters,
  collection overloads and virtual executor task creation.
- Native loading formerly rejects DT_ANDROID_RELA. Decode APS2 and RELR (standard
  and Android tags), applying relocations before collecting constructor addresses.
  Maps' native loader now clears the earlier relocation rejection and invalid-PC fault.
- Maps smoke compilation: 72,887 classes, zero method failures.
- Focused relocation and executor queue checks pass. Initial typecheck passes.

## Next

1. Follow the Joda provider UTC membership failure and remaining startup errors.
2. Exercise matching Maps search/place/directions interactions in Chrome and Android;
   capture screenshots and inspect all reached-process diagnostics.
3. Verify changed platform contracts, measure functioning startup/idle behavior, then
   run the full serialized E2E suite and compare ambiguous failures to the base.
4. Record evidence and limitations, make focused commits, leave the worktree separate.

Prior microG integration findings and evidence remain in docs/implementation-history.md.
