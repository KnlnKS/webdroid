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
`pixels-1.json`, `base-1-*`, `chunk-1-*`. Merge `42ab191f`; production tree `6db61cb42fd19ead6e9525653752071b3cf67d91`
is identical to the tested candidate. Post-merge CPU: thread 3295.035 ms (-3.31%), process
6024.767 ms (-0.96%); 39/39 steps complete with the same clean compatibility checks.
Evidence: `post-1-1.json`.

### 2. Layout invalidation — accepted

Source `4b7989fa`, extracted as `1182651` plus standalone fixture setup `9136d42`.
Two new core regression cases reproduce missed root remeasurement on the pre-change source;
both pass after the fix. Nine focused tests and typecheck pass. The existing fixture needed
native registration when run alone; initialization is now explicit.

Three alternating FitNotes pairs: baseline thread/process 3248.559/5904.490 ms, candidate
3164.396/5802.566 ms (-2.59%/-1.73%). All 234 steps across six runs pass; 39 screenshots
and semantic trees match the baseline repeats. Production tree:
`38e8731312d43692e8f0b400bdebaf7db40e8d11`.

Additional 36-step Mihon/Harmonic captures complete without wedges, action errors or added
missing/native requirements; all 108 process snapshots succeed on each revision. The
source branch's newer Mihon text-readiness condition times out on BOTH revisions, because
its accessibility expansion is not included here. Both also reproduce Harmonic's atomic
regex error. The matching captures are retained as limits, not counted as clean passes.
Mihon uses frozen main's original flow definition and the same async-capable capture
harness on both sides. Three alternating pairs complete all 17 steps without timeouts or
errors. Median thread/process CPU: main 8893.414/20508.902 ms, candidate
8655.656/20238.509 ms (-2.67%/-1.32%). All 17 trees match; 15/17 screenshots match exactly.
The two differences are confined to the random empty-library face (visually inspected;
labels and geometry outside that face match). No golden changed. Evidence:
`mihon-summary-2.json`, `mihon-pixels-2.json`, `mihon-{base,chunk}-2-*`, and
`{base,chunk}-2-e2e/`.

Merge `3798a575` retains the tested production tree. Post-merge FitNotes thread/process:
3253.257/5919.652 ms (+0.14%/+0.26%); Mihon: 8671.127/20306.984 ms (-2.50%/-0.98%).
Both finish all steps without wedges, timeouts, errors or new requirements. Raw values:
`post-2-1.json`, `mihon-post-2-1.json`.

## Deferred scope

- Generated API expansion and native/DEX ownership: broad coupling and compatibility risk.
- Software glyph/Skia rendering and its cache optimization: observed full-branch CPU
  regression exceeds this gate; the glyph optimization depends on that renderer.
- JSON number boxing: the historical patch duplicates `optInt` and uses sentinel-string
  serialization; it needs a separately reviewed extraction rather than blind cherry-picking.
