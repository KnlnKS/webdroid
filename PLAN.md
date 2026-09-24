# Webdroid status — 2026-09-23

The current code runs unchanged APK and bundled library bytecode in the browser. This file tracks open work and the latest relevant gates. [Implementation history](docs/implementation-history.md) records failure mechanisms, measurements and evidence limits; [AGENTS.md](AGENTS.md) defines working and verification rules. Historical branch plans and intermediate runs remain in Git history.

## Latest integrated evidence

- The serialized full E2E matrix rendered 183/183 steps across 13 flows. TikTok rendered 13/13 with advancing ticks and no required native, GL, layout or draw failure. YouTube retained two known settle timeouts and its `Matrix.mapRect` draw error. The matrix is compatibility evidence, not proof of original-rate video playback or Cut the Rope gameplay; Cut has a separate focused capture.
- The unchanged ARM32 Cut the Rope XAPK reached the level-one tutorial and advanced after a rope swipe. A clean visible Chrome sample at 1080×2160, 480 dpi presented 36.0 frames/s over 12 seconds, above the 15 FPS target. The intro video still stalls or shows black, and later gameplay rates vary. Cut smoke compilation found zero method failures.
- TikTok's unchanged native ByteVC decoder and EGL path reached a steady near-30/s presentation cadence on one measured 30-fps HEVC segment. Presentation counts include UI redraws; dense live clips can be slower. Original-rate playback across clips and a 150 ms visible action response remain unproved.
- API-33 differential fuzzing found 0/1,000 API differences and 0/100 graphics differences on each of two retained small seeds, with all 38 minimized graphics cases and 42 focused color-glyph probes passing. Larger 1,000-case graphics seeds still report 58 and 74 differences. Exact matrix and clip state, raster edges, small text and arbitrary-transform color glyphs remain open.
- The default `bun run e2e` fast lane runs every action in all 13 flows. Two five-job runs passed in 61.2 and 61.9 seconds after readiness fixes. It is a semantic/startup check with selected Android visual checkpoints. Use `bun run e2e --full --jobs 1` for the final serialized pixel and diagnostic matrix; use one job for motion frame-rate gates.

## Open work

1. **TikTok playback and input:** capture repeatable source media and distinct decoded-video, EGL-swap and browser-presentation counts; profile dense clips and warmed visible action latency. Keep live-content variation out of causal performance claims.
2. **Cut the Rope:** diagnose the intro's output-queue stall and black video, then verify gameplay speed beyond the level-one sample. Player ID/backend behavior and later unlocked features remain unvalidated. The focused flow skips the intro; Cut has no full-matrix flow.
3. **Graphics parity:** minimize the 132 differences across the two larger API-33 graphics campaigns before changing common renderer behavior. Preserve Canvas2D software drawing and existing visual goldens.
4. **App and harness limits:** ChatGPT authenticated upload/voice, TikTok authentication/publishing, general multi-window bar arbitration, and later app paths remain unvalidated. YouTube live-content draw errors, Lichess pthread faults and unavailable Flappy Bird auxiliary snapshots need matched-baseline assessment. A fast pass does not imply visual parity.

## Verification for changed behavior

Run owning unit/framework tests and smoke-compile affected APKs during development. Freeze code before the serialized full matrix and inspect every relevant process's `run.json` for `newMissing`, `newErrors`, `nativeRequired`, layout/draw/GL errors, completion, diagnostics and advancing `wd.ticks`. Use matched inputs and settings for performance; keep goldens unchanged unless reference updates are explicitly requested. The [E2E guide](tests/e2e/README.md) and [fuzz guide](scripts/fuzz/README.md) provide commands and artifact locations.
