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

### 3. Activity dialog teardown — withdrawn after Android evidence review

**Not retained in final main.** Bundled AOSP `Activity.onDestroy` calls `dismiss` only
for `mManagedDialogs` (PC 10–48). `WindowManagerGlobal.closeAllExceptView` reports leaked
windows and calls `removeViewLocked` (PC 44–113), without `Dialog.dismiss`.
`PhoneWindow.onDestroy` only unregisters its audio mode listener. Thus the historical
claim that general window teardown dismisses all context-owned dialogs was incorrect.
Our browser probe established the patch's behavior, not Android parity; its expected
callback was wrong. The source patch and our extraction are deferred. The generic window
cleanup gap needs a separate implementation with ownership/token and callback evidence.
Disassemblies: `dialog-aosp-{activity,closeall,window}.txt` in focused evidence.

The measurements below describe the withdrawn intermediate state for auditability.

Source `3f7c2a3f`, extracted with corrected callback semantics as `00a5e91`.
Main left a dialog showing after both finish and recreation. The browser reproduction now
closes it, fires exactly one dismiss callback and zero cancel callbacks in each case.
The historical patch used `dismissOverlay`, which invokes the dialog's cancellation path;
activity teardown now calls virtual `dismiss` directly. Only direct activity ownership is
covered; this does not add support for arbitrary wrapped-context ownership.

Typecheck and 14 existing window/attachment tests pass. Three alternating FitNotes pairs:
main thread/process 3389.704/6043.490 ms, cumulative candidate
3270.808/5927.457 ms (-3.51%/-1.92%). All 234 steps
complete without errors, wedges, timeouts or new requirements. All 39 screenshots and
semantic trees match baseline repeats. Production tree:
`4cfa72d886301e5a9e1ffa577cbcf784a390afb0`. Evidence: `dialog-before.json`,
`dialog-after.json`, `summary-3.json`, `pixels-3.json`, `{base,chunk}-3-*`.

Merge `c7c995f9` retains the tested production tree. Post-merge thread/process CPU:
3283.990/6001.789 ms (-3.12%/-0.69%); all 39 steps pass the same
compatibility checks. Evidence: `post-3-1.json`.

### 4. Async capture contract — accepted

Source `2f6d8d29`, extracted as `9859aa1d`. Await UI-tree results before state matching and
capture, allowing both synchronous and asynchronous providers. Typecheck passes. A real
FitNotes browser probe wraps only the diagnostic tree reader in a Promise: main's harness
throws in `.some`; the candidate reaches the text state, captures 49 nodes, and reports no
errors or wedge. No emulator behavior is replaced by this probe.

This is test-harness code only. The production tree remains
`4cfa72d886301e5a9e1ffa577cbcf784a390afb0`, identical to chunk 3; the shared measurement
harness already contained this correction for every preceding comparison. Therefore chunk
3's repeated CPU and compatibility evidence applies without another pre-merge benchmark.
Merge `b823f214`; production tree unchanged. Post-merge FitNotes thread/process
3162.784/5833.684 ms (-6.69%/-3.47%); Mihon
8618.334/20473.704 ms (-3.09%/-0.17%). All 56 steps pass, with advancing
ticks and no errors or new requirements. These are single post-merge checks, not a new
claim of a larger optimization than the repeated candidate medians. Evidence:
`post-4-summary.json`, `post-4-1.json`, `mihon-post-4-1.json`. The full matrix is running. Evidence: focused check logs
`chunk-4-probe{,-before}.log`, `chunk-4-typecheck.log`.

### Withdrawal and final retained state

Withdraw `00a5e91` while retaining the string, layout and async capture chunks. Production
tree returns exactly to `38e8731312d43692e8f0b400bdebaf7db40e8d11`, already validated by
chunk 2's three alternating FitNotes and Mihon pairs. The first full E2E run was stopped
and its artifacts moved to `withdrawn-dialog/`; it is not final-state evidence. Typecheck,
1,237 unit tests, smoke, framework coverage and text checks had passed on that intermediate
state. Repeat final validation after withdrawal and record post-merge CPU again.

## Deferred scope

- Generated API expansion and native/DEX ownership: broad coupling and compatibility risk.
- Software glyph/Skia rendering and its cache optimization: observed full-branch CPU
  regression exceeds this gate; the glyph optimization depends on that renderer.
- JSON number boxing: the historical patch duplicates `optInt` and uses sentinel-string
  serialization; it needs a separately reviewed extraction rather than blind cherry-picking.
- Android-side semantic fuzz targets and exit handling: no connected Android oracle for
  validation. The source patch also needs correction for missing targets and oracle-free
  exit classification; do not cherry-pick it unchanged. The one-off tree replay script stays out.
