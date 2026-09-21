# Fuzz-audit integration ledger

Baseline: `02aec2c1f92c140a1754ba72a0e239a7305211da`. Source: `1bb72551`.
Local main only; no remote push. Baseline stays fixed across all chunks.

## Final decision

Retained in local main: UTF-16 conversion optimization, narrowly scoped ancestor layout-flag
repair, and async UI-tree capture. Final production revision: `bccf7ff3`; production tree:
`ca0a097592e72aa527b97c1f20c14811c8155bad`. No measured CPU gate crossed +5%.
Three matched pairs per workload: FitNotes thread/process -4.63%/-1.80%; Mihon
-1.39%/+0.91%. These are renderer CPU measurements for those working workloads, not an
all-APK or whole-browser CPU guarantee. Both post-merge checks also pass.

The general dialog-dismiss change was withdrawn after AOSP contradicted its callback
semantics. Unconditional layout replay was also removed; Android's flag filter and parent
callback guard are preserved. The larger fuzz branch remains unmerged.

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

### 2. Layout invalidation — narrowed in the final candidate

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

Withdrawal merge `5daf486d`: post-merge FitNotes thread/process
3231.728/5946.330 ms (-0.52%/+0.71%); Mihon
8604.702/20166.957 ms (-3.25%/-1.67%). All 56 steps complete cleanly.
Evidence: `post-5-summary.json`, `post-5-1.json`, `mihon-post-5-1.json`.

### 6. Narrow layout propagation to the proven defect — accepted

AOSP `ViewRootImpl.getValidLayoutRequesters` (PC 26–31) requires `PFLAG_FORCE_LAYOUT`
(0x1000) after the first layout pass; `View.layout` clears it at PC 243–247. The source
branch's unconditional replay was therefore unjustified. Restore main's replay filter;
replace the contrary test expectation with the actual Android rule. The original test
proved the proposed behavior, not its correctness. Evidence: `layout-aosp-requesters.txt`
and `layout-aosp-layout.txt`.

Keep the internal stale-ancestor repair, while skipping the already-requested parent's
virtual callback as Android does. A single core case now checks both root remeasurement
and zero duplicate parent callbacks. Candidate commits `816b7d3`, `efb9fc5`; production
tree `ca0a097592e72aa527b97c1f20c14811c8155bad`. Nine targeted tests and typecheck pass.
Pre-guard samples are retained under `layout-pre-virtual-guard/` and excluded.
The bundled `View.requestLayout` bytecode also confirms the parent `isLayoutRequested`
guard before its virtual request (PC 80–94); see `layout-aosp-request.txt`.

Three fresh alternating pairs per workload on the final candidate:

| Workload | Main thread/process ms | Candidate thread/process ms | CPU change |
| --- | ---: | ---: | ---: |
| FitNotes | 3382.434 / 6070.863 | 3225.954 / 5961.534 | -4.63% / -1.80% |
| Mihon | 8805.053 / 20328.622 | 8682.401 / 20513.103 | -1.39% / +0.91% |

All 336 steps across 12 runs complete without wedges, timeouts, errors, or new missing/native
requirements. FitNotes: all 39 trees match, 38/39 screenshots match; the 168 differing pixels
form its blinking caret. Mihon: all 17 trees match, 15/17 screenshots match. The remaining
captures show a random empty-library face and a launch spinner captured on both baseline
and candidate repeats. Separate quiescence checks reach the fully loaded library on both,
without errors; those images were inspected. The original presentation-count launch wait
is not a reliable loaded-content checkpoint, so this is an explicit harness limitation.
No goldens changed. Evidence: `summary-6.json`, `mihon-summary-6.json`, `pixels-6.json`,
`mihon-pixels-6.json`, `library-{base,candidate}.{json,png}`.

Merge `bccf7ff3` retains production tree `ca0a097592e72aa527b97c1f20c14811c8155bad`.
Post-merge FitNotes thread/process 3216.548/5922.936 ms
(-4.90%/-2.44%); Mihon 8678.173/20445.987 ms
(-1.44%/+0.58%). All 56 steps pass the compatibility/visibility/liveness checks.
Evidence: `post-6-summary.json`, `post-6-1.json`, `mihon-post-6-1.json`.

## Deferred scope

- Generated API expansion and native/DEX ownership: broad coupling and compatibility risk.
- Software glyph/Skia rendering and its cache optimization: observed full-branch CPU
  regression exceeds this gate; the glyph optimization depends on that renderer.
- JSON number boxing: the historical patch duplicates `optInt` and uses sentinel-string
  serialization; it needs a separately reviewed extraction rather than blind cherry-picking.
- Android-side semantic fuzz targets and exit handling: no connected Android oracle for
  validation. The source patch also needs correction for missing targets and oracle-free
  exit classification; do not cherry-pick it unchanged. The one-off tree replay script stays out.

## Final validation on the retained state

- Typecheck passes; 1,237 tests pass, zero fail, 26,599 assertions (218 files).
- FitNotes smoke compiles 4,213 classes with zero method failures.
- Text parity: 6/6 paragraphs. Framework delegate coverage stays 295/363; the 68 gaps
  remain unsupported, not newly implemented.
- Full serialized E2E: 159 steps across 12 flows, 827.1 seconds. Zero main-loop wedges
  or harness action failures; all 524 relevant process-diagnostic snapshots succeed.
- Two YouTube settle timeouts remain at `show-controls` and `pause`. They must not be
  described as a clean 159-step functional pass. A fresh, matching main replay completes
  without these timeouts but stays on the home screen at the supposed player steps;
  the candidate reaches actual Big Buck Bunny playback. Its timeout telemetry shows
  continuing presentations, sockets and timers. Thus these runs do not provide equivalent
  player workloads or establish pause/control compatibility. Caption-style fields and a
  short-form `mapRect` diagnostic appear only in the candidate's newly reached player path.
  They remain real compatibility gaps. The SAX initialization error reproduces on main.
  Images and complete diagnostics are in `final-actual/youtube/`, `baseline-replay/youtube/`,
  and `youtube-matched-comparison.json`; no error is suppressed or wait extended.
- No added missing/native requirements outside YouTube. TikTok's existing render-error
  footprint remains. Lichess's pthread and Stockfish failures match baseline signatures;
  only allocated code-block addresses are normalized for that comparison. Harmonic's
  atomic-regex error also reproduced in the earlier fresh main comparison.
- Static pixels versus saved main: FitNotes 38/39 exact (168 caret pixels); Calculator
  6/8 exact (each remaining image differs in a 1-by-34-pixel vertical column); Mihon
  onboarding 5/5 exact; Mihon app 15/17 exact (initial spinner phase and random library face).
  Separate quiescence captures confirm the loaded Mihon library on both revisions.
- Unchanged-golden content differences: FitNotes 40.12%, Mihon app 62.13%, Harmonic
  32.50%, onboarding 17.69%. Random/live content prevents treating the small aggregate
  change as a fidelity improvement. Goldens are unchanged.

Final logs, `final-comparison.json`, `final-static-pixels.json`, full captures and report:
`/tmp/webdroid-staged-integration/webdroid-shots/integration/`. The main replay was saved
separately; `tests/e2e/actual/` and `tests/e2e/report/` again show the full candidate matrix.
The failed assumptions and intermediate measurements above are retained for auditability.
