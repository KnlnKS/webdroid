# Fuzz-audit integration ledger

Fixed baseline: `02aec2c1`; source branch: `1bb72551`. Final retained merge:
`bccf7ff3` (production tree `ca0a0975`). This ledger records why three
changes were retained and two were withdrawn. Intermediate captures and commit
details remain in Git history; ignored raw evidence was saved under
`/tmp/webdroid-staged-integration/webdroid-shots/integration/`.

## Gate and retained changes

The same harness drove fresh visible Chromium on the fixed baseline and each
candidate. Three alternating pairs per workload measured CDP renderer thread
and process CPU across real-time FitNotes and Mihon flows. Both medians had to
stay within +5%; all actions, ticks, visible frames, diagnostics and pixels
were checked. CPU consumption is not wall time or a whole-browser guarantee.

| Retained change | Mechanism and evidence |
| --- | --- |
| UTF-16 conversion | `Reflect.apply` avoids iterator expansion while preserving every UTF-16 code unit. An exhaustive 65,536-unit probe, two CharBuffer tests and all 39 FitNotes screenshots/trees passed. Three-pair FitNotes CPU changed -4.48% thread / -1.35% process. |
| Layout invalidation | Stale ancestor flags now propagate a real request to the root while preserving Android's parent callback guard and post-layout `PFLAG_FORCE_LAYOUT` filter. Two pre-change repros fail before and pass after the fix. Final three-pair FitNotes CPU changed -4.63% / -1.80%; Mihon -1.39% / +0.91%. All 336 steps across 12 paired runs completed. |
| Async UI capture | The harness awaits a UI-tree provider before matching state or capturing. A Promise-wrapped real FitNotes diagnostic reader crashed the old `.some` path; the candidate captured 49 nodes. This is harness-only and was present in the common measurement harness. |

Final post-merge CPU changed -4.90% / -2.44% for FitNotes and -1.44% /
+0.58% for Mihon. All 56 post-merge steps passed visibility, liveness and
compatibility checks. FitNotes' one screenshot difference was a blinking caret;
Mihon's two were a random face and launch spinner. Trees matched. The initial
Mihon presentation-count wait was not a reliable loaded-content checkpoint;
separate quiescence captures reached the library on both revisions. No golden
changed.

## Withdrawn changes

- **General dialog teardown:** Bundled AOSP `Activity.onDestroy` dismisses
  managed dialogs only. `WindowManagerGlobal.closeAllExceptView` removes
  leaked windows without calling `Dialog.dismiss`; `PhoneWindow.onDestroy`
  does not supply that callback. The browser patch proved its own behavior,
  not Android parity, so it was removed after an intermediate merge.
  General window cleanup still needs ownership/token and callback evidence.
- **Unconditional layout replay:** AOSP
  `ViewRootImpl.getValidLayoutRequesters` requires `PFLAG_FORCE_LAYOUT`
  after the first pass, and `View.layout` clears it. The old test encoded
  the wrong expectation. The final change keeps only the stale-ancestor
  repair and avoids duplicate parent virtual callbacks.

Deferred: broad API ownership expansion, software glyph/Skia rendering,
JSON number boxing, and Android-side UI fuzz targets. The renderer branch
exceeded the CPU gate; the other candidates lacked a safe independent
extraction or connected-oracle validation.

## Final verification and limits

Typecheck and 1,237 tests (26,599 assertions) passed. FitNotes smoke-compiled
4,213 classes with zero method failures; text comparison passed 6/6.
Framework coverage remained 295/363 declared natives. The serialized
12-flow E2E run completed all 159 steps in 827.1 seconds with zero wedges
or action failures and 524 available process snapshots. YouTube retained
two control settle timeouts. A matching main replay stayed on Home while
the candidate reached playback, so those runs do not prove pause/control
compatibility. Its caption and `mapRect` diagnostics remain visible.
Lichess pthread/Stockfish and Harmonic regex failures matched baseline
signatures. Static-pixel differences outside YouTube were caret, spinner,
random-content and small Calculator-column effects; goldens were unchanged.
