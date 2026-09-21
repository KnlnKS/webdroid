# Fuzz-audit integration ledger

Baseline: `02aec2c1f92c140a1754ba72a0e239a7305211da`. Source: `1bb72551`.
Local main only; no remote push. Baseline stays fixed across all chunks.

## Protocol

The same harness from source revision `1bb72551` drives both server revisions through
all 39 real-time FitNotes steps at golden geometry, using fresh visible headless Chromium
processes. CDP Performance uses `threadTicks`; ThreadTime and ProcessTime deltas cover
launch, actions, rendering and screenshot readback. They are CPU consumption, not wall
clock or drawMs. No profiler, tracing, parallel captures or competing tests. Three
alternating baseline/candidate pairs precede each production merge. Post-merge runs verify
the integrated tree, with exact production-tree identity recorded. Both CPU medians must
be no more than 105% of frozen main. Near-threshold results need controlled confirmation.

Check all actions complete, no wedges/timeouts/errors, no new missing APIs or native
requirements, visible document and advancing ticks. Pixel/tree comparisons and targeted
checks supplement this gate; the full suite and E2E matrix run at the end. These measurements
cover the observed workloads, not every APK or device.

Raw evidence (ignored): `/tmp/webdroid-merge-review/webdroid-shots/integration/`.
Focused check logs: `/tmp/webdroid-staged-integration/webdroid-shots/integration/`.

## Decisions

### 1. Character-array conversion — accepted

Source `cba423a0`, extracted as `98fc760b`. Two-line ABI change: `Reflect.apply` avoids
iterator expansion without changing UTF-16 conversion or chunking. Typecheck and two
existing CharBuffer tests pass; exhaustive 65,536-code-unit probe preserves all units.

Three alternating pairs (CPU ms, medians):

| Revision | Thread | Process | Draw | Boot |
| --- | ---: | ---: | ---: | ---: |
| Fixed main | 3407.957 | 6083.005 | 1117.0 | 142.2 |
| Candidate | 3255.170 | 6000.982 | 1134.2 | 142.2 |
| CPU change | -4.48% | -1.35% | | |

All six runs: 39 steps, visible, advancing ticks, no wedges/timeouts/errors/missing APIs,
no native-required entries or draw/layout failures. All 39 captured screenshots match a
baseline repeat exactly; all 39 semantic trees match. Evidence: `summary-1.json`,
`pixels-1.json`, `base-1-*`, `chunk-1-*`. Post-merge verification follows.

## Deferred scope

- Generated API expansion and native/DEX ownership: broad coupling and compatibility risk.
- Software glyph/Skia rendering and its cache optimization: observed full-branch CPU
  regression exceeds this gate; the glyph optimization depends on that renderer.
- JSON number boxing: the historical patch duplicates `optInt` and uses sentinel-string
  serialization; it needs a separately reviewed extraction rather than blind cherry-picking.
