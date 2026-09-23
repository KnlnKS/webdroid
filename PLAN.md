# Cut the Rope 15 FPS goal — 2026-09-23

Integrated into `main` from `codex/cut-the-rope-15fps`. Starting revision: `33ab22fd`.
Status: the unchanged ARM32 XAPK reaches the level-one tutorial and advances after a rope
swipe. A clean visible Google Chrome run at 1080×2160, 480 dpi presented 36.0 frames/s
over 12 seconds, with advancing ticks and no page exception or required gameplay API miss.
A matched headless baseline at the starting revision presented 25.3 frames/s; the
intermediate JIT build presented 27.5 frames/s under the same capture timing. A bounded
fallback diagnostic then measured 24.4 to 32.2 frames/s before and after VFP lowering,
with that diagnostic's overhead in both samples. Cut smoke-compiles 64,465 classes with
zero method failures; typecheck and 82 focused ARM/libc tests pass. The final serialized
E2E gate captured 183/183 steps in 973.5 seconds with no main-loop wedge, required native
call, layout error or GL error. YouTube retained two settle timeouts and eight known
`Matrix.mapRect` draw errors; 12 Flappy Bird auxiliary snapshots were unavailable.

Generic Thumb wide and VFP scalar memory instructions now compile in the ARM32 JIT;
reached libc ABI calls, Android media constants, the SurfaceTexture transform and Intent
Parcelable-array overload are implemented in their owning modules. The visible Chrome
sample exceeds the 15 FPS target. The intro video remains a known limit; the focused flow
skips it. A Cronet native fault remains in a previously traced ad network path. Cut is
absent from the E2E matrix, so the gameplay capture supplies its direct evidence.

---

# Fuzzer compatibility follow-up — 2026-09-23

Integrated into `main` from `codex/fuzzer-compatibility`. API 33 oracle:
emulator-5554 at 1080×2160, 480 dpi.
The API 33 1,000-case API campaign has no differences. Both 100-case graphics campaigns
(seeds `20260923` and `20260924`) now have no reported differences, as do all 38 retained
minimized graphics findings and 42 focused color-glyph probes. The fixes cover software
shape coverage, inverted paths, clipping, Android text raster and line wrapping. They use
platform geometry and font data rather than APK-specific behavior. No visual golden changed.
See implementation history for mechanisms, verification and evidence limits.
The renderer review follow-up isolates bitmap raster policy and crops CanvasKit text transfers.
Graphics campaigns now record tolerated float32 state deltas separately: 7 cases in seed
`20260923` and 14 in seed `20260924`. Larger 1,000-case graphics campaigns still have
58 differences for seed `20260925` and 74 for seed `20260926` after the current repairs.
Exact matrix and clip state, raster edge coverage, small text, and arbitrary-transform
color-glyph parity remain open. The zero-difference 100-case campaigns therefore do not
establish graphics parity.

---

# Cut the Rope FPS follow-up — 2026-09-23

Branch: `codex/cut-the-rope-fps`. Starting revision: `756491fb`.
Status: reached non-ad Android game and shortcut APIs are implemented. A generic native
frame-aware scheduler improves paired level-one presentation from about 4 to 5 frames/s
when a sustained background computation is active. The unchanged ARM32 XAPK compiles with
zero method failures and reaches interactive gameplay in full Chrome. A generic Thumb JIT
path keeps IT blocks in compiled regions. On two fresh headless Chrome level-one runs with
the same diagnostic counters, interpreted dispatch fell from 8.7 million to 34 thousand
per eight seconds and presented frames rose from 243 to 266; a clean run also completed the
first puzzle. FPS varies between launches. The prior serialized E2E matrix rendered 183/183
steps in 966.3 seconds. The final serialized matrix for this JIT change rendered 183/183 in
966.7 seconds, with no main-loop wedge, layout or GL error, or required native API. YouTube
retained two control settle timeouts and its Matrix draw failure; 12 Flappy Bird auxiliary
snapshots were unavailable as before. Cut the Rope has no matrix flow, so its focused level
completion remains the direct gameplay check.

Remaining limits: native guest execution still saturates the browser thread; the intro video
stall and later feature parity remain open. Keep the performance claim tied to presented
frames and advancing ticks, with the visible and headless Chrome rates reported separately.
A follow-up generic Thumb JIT lowering compiles the predicated byte-load/shift blocks observed
in Unity's hot loop. Its isolated ten-million-instruction kernel improved from 65–71 ms to
1.5–2.1 ms, and Cut reached the next tutorial after a rope swipe. Warm gameplay FPS could not
be compared reliably because later captures stalled during startup or readback. The final
serialized E2E gate for this follow-up rendered 183/183 steps in 968.8 seconds. No main loop
wedged or required native call appeared. YouTube retained two control settle timeouts and its
`Matrix.mapRect` draw error; 12 Flappy Bird auxiliary snapshots remained unavailable.

The strict code-quality follow-up now decodes Thumb IT blocks once for scanning and emission,
including simple multi-instruction blocks with a wide move. Render-thread pacing exemptions
expire after frame activity stops, package queries share manifest game metadata, and
`GameManager.setGameState` no longer retains unread state. Typecheck, focused ARM/CPU/package
tests, and zero-failure Cut XAPK compilation pass. A fresh visible level-one run rendered and
advanced after a rope swipe; its warm 12-second headless window presented 184 frames, without
a controlled FPS comparison. The final serialized matrix rendered 183/183 steps in 958.6
seconds, with no wedge, required native call, layout error or GL error. The known two YouTube
settle timeouts, seven `Matrix.mapRect` draw errors and 12 unavailable Flappy Bird auxiliary
snapshots remain. Cut still has no matrix flow, and the intro stall remains unresolved.

---

# TikTok playback integration — 2026-09-23

Integrated from `codex/tiktok-playback` (starting revision `756491fb`). Generic A64 SIMD,
vector memory and JIT improvements, virtual-display frame pacing, process identity, and a
process-shared clipboard are committed. TikTok smoke compilation has zero method failures;
the focused flow rendered 13/13 steps without a reached Android API, required-native,
layout, or draw failure. A matched 30-fps-header HEVC segment presented 268 EGL swaps in
9.00 seconds, and two other observed steady segments reached 29–30 swaps/s. Other live
clips presented more slowly, but their source timing was not captured. Original-rate
playback across demanding clips remains unproved. Fixed decoder comparisons and the
parallel-worker constraints are recorded in the implementation history.
The merged `main` revision `5e6744c9` passed typecheck, 1,340 unit tests, framework checks,
and zero-failure TikTok and Cut the Rope smoke compilation. Its uncontended serialized E2E
matrix rendered 183/183 steps in 949.9 seconds. TikTok rendered 13/13 with four available
process diagnostics per step and no required native, wedge, timeout, layout, draw or GL error.
The two live video steps presented 17.5 and 6.0 EGL swaps/s; their source timing is unknown.
YouTube retained two known control settle timeouts and the `Matrix.mapRect` draw failure;
the 18 draw failures counted in this run exceed the seven recorded in the prior `main` run.
That count difference has no matched live-content reproduction. The 12 unavailable Flappy
Bird auxiliary snapshots also remain.

---

# TikTok video playback follow-up — 2026-09-23

Branch: `codex/tiktok-video-playback`. Starting revision: `9a038ff3`.
Status: HEVC extraction/decoding and two generic A64 JIT lowerings are committed. TikTok renders all 13 focused steps, but original-rate playback remains unmet on dense live clips. The final serialized E2E matrix rendered 183/183 steps in 958 seconds with no wedge; YouTube retains two known settle timeouts.

The feed uses TikTok's unchanged native ByteVC1 decoder and EGL rather than Java or NDK MediaCodec. Native decoding dominates the timed samples, especially on dense clips. Keep the remaining performance target tied to controlled source media and presentation counts; live feed videos vary between runs. The observed missing classes are optional app/vendor integrations, not Android platform APIs.

---

# TikTok usability follow-up

Branch: `codex/tiktok-usability`. Starting revision: `9d0bb979`.
Status: performance improvements and compiled-memory fault parity are committed and verified. The `codex/tiktok-playback-20260922` follow-up compiles decoder lane transfers and unsigned halfword shifts, and repairs CopyOnWriteArrayList random-access identity. Full TikTok parity, original-rate playback and the 150 ms target remain unmet.

The final serialized matrix renders 183/183 steps in 969.1 seconds without a
wedge or required native. TikTok renders 13/13 with advancing ticks, but active
video remains at 4.7–8.4 EGL frames/s and a swipe action takes 1.95 seconds.
See the implementation history for the earlier transient consent timeout,
decoder kernel measurements, and existing YouTube/Lichess failures.

Current pass separates cold navigation, warmed input and decoded playback; profiles JavaScript
allocation/GC, method preparation, native execution, scheduling and rendering. Keep only measured
improvements, with focused core/TikTok checks during development and a final full E2E run.

- Compare TikTok at 1080×2160, 480 dpi; retain screenshots and per-process diagnostics.
- Investigate slow playback, interaction latency, reload stalls, and reached platform gaps.
- Implement Android behavior in canonical owners, preserving unchanged APK/library bytecode.
- Keep code and tests proportionate; use focused commits and core checks during development.
- Target 150 ms action response, measuring completed visible changes separately from frame opportunities.
- Freeze the candidate before the final serialized full E2E run; keep visual goldens unchanged.
- Record limitations, matching baseline evidence, and final checks in implementation history.

The shared AVD opened a login wall, while full Chrome reached guest consent.
A separate `webdroid_tiktok_usability` AVD on emulator-5562 now isolates further interactions. Feed comparisons
must identify that state difference; authentication and publishing are outside the exercised guest path.

---

# ChatGPT parity repair

Branch: `codex/chatgpt-parity`. Starting revision: `9d0bb979`.
Status: guest flows repaired; full authentication and visual parity remain incomplete.

Current implementation: `27f36406`; expanded ChatGPT flow: `6c958327`. Guest responses,
settings, attachments, Plugins and reachable email/phone forms work. Browser and native text
share the API 33 Android emoji font pair; fractional metrics and paragraph-span routing retain
the country-list geometry established in the previous parity pass.

The code-quality review follow-up shares paragraph measurement and replacement boundaries
between greedy and balanced wrapping, propagates measured state through native containers,
resolves system-bar colors and appearance from the presented window, and uses one uniform
descriptor for shader declaration validation and uploads. A theme-appearance override was
removed during validation to preserve existing legacy system-UI precedence.

The second review follow-up selects system bars from resolved overlay bounds, treats replacement
spans as indivisible content during whitespace handling, centralizes display-list recording and
replay context in one typed module, and shares a single recyclable shader raster per program.
Focused browser checks verify replacement spaces are drawn and identical recorded shader
snapshots rasterize once while preserving captured uniforms.

Current gate: typecheck; 1,268 unit tests (26,914 assertions across 219 files); ChatGPT
smoke compilation of 66,165 classes with zero method failures; eight runnable framework
exercises with 295/363 declared natives supported. The focused ChatGPT run completes 24/24
steps in 129.5 seconds. Fresh full-Chrome and AVD country-list captures retain aligned rows.
The final serialized matrix completes 183 steps in 13 flows in 978.8 seconds; ChatGPT completes
24/24 in 124.3 seconds with no added missing APIs/errors, rendering failures or settling limits.
Across the matrix there are no added missing APIs, wedges, layout errors or required natives.
Known YouTube control timeouts remain, with seven Matrix.mapRect draw errors versus six in the
baseline; historical Lichess failures and unavailable Flappy child diagnostics remain.
FitNotes' mean golden content difference is unchanged at 39.82%, retaining its prior help-dialog
discrepancy. Mihon's app/onboarding differences improve to 42.83%/9.08% as the recorder now
preserves Canvas letter-spacing capability checks; random emoticons still affect its score.
Harmonic scores 32.01% with different live content. These results do not establish full parity.

Remaining limits: authenticated uploads and voice are unvalidated because no credentials have
been entered. microG's extra chooser, Visualize's remote icon, Latin text rasterization,
the native minimized-keyboard strip and long-session retention remain unresolved. System-bar
selection now handles visible full-screen dialogs within a process; general multi-window and
cross-process bar arbitration remain limited. Concurrent tests in another worktree share this
host, so the current run is not a clean performance benchmark. Goldens remain unchanged.
See [implementation history](docs/implementation-history.md) for evidence and comparison limits.

- Run unchanged ChatGPT XAPK in full Chrome and API 33 AVD at 1080×2160, 480 dpi.
- Fix reached platform failures at their canonical owners, guided by native evidence.
- Test ChatGPT and changed core behavior during development; run full E2E at the end.
- Preserve goldens, record unresolved limits, and keep commits focused.

---

# Cut the Rope parity repair

Branch: `codex/cut-the-rope`. Starting revision: `9d0bb979ae7987cd70b7d5242ec6c6b720b5a1e2`.
Status: original ARM32 and ARM64 builds complete levels 1 and 2 in Chrome; graphics and native
audio work. The AVD completed level 1 and reached level 2, where a test interstitial blocks its
current replay. Original ARM32 reload restores level 3, coins and sound settings; background /
resume and its first level-3 puzzle pass. Rendering remains slow. Typecheck, 1,295 unit tests,
XAPK compilation and all eight runnable framework exercises pass. The final 159-step E2E
completes with no wedge or action failure. Starting-revision visual and performance comparisons
find no reproduced regression. Player ID/backend parity and later unlocked features remain
unvalidated; this is verified early gameplay, not a complete parity claim.
Post-matrix profiling found expensive interpreted Thumb arithmetic and indexed memory operations.
Their shared JIT lowering passes owning checks; arithmetic also completes a fresh puzzle.
The combined candidate `b5ae9cb5` restores level 3 and completes its first puzzle without native
or rendering faults. Its repeated final matrix passes all 1,295 unit tests and completes all
159 E2E steps in 823.4 seconds without wedges, action failures or settling timeouts. Known
baseline errors remain visible. Direct Bun tests now rebuild stale native cores before running.
Performance and Player ID remain unresolved; the full parity goal is not complete.
Follow-up performance work now lowers single-instruction IT/move pairs through the JIT. Owning
checks pass and fresh Chrome restores level 3 and completes its first puzzle. This production
change follows the matrix above; another full E2E is reserved for the final finished candidate.
Thumb indexed transfers also reuse the same memory emitter for pre/post-index writeback. The
combined build passes owning checks and the same gameplay replay; rendering remains below 2 FPS.
Thumb long multiply/accumulate now shares ARM JIT arithmetic and passes the same checks and
gameplay replay. A separate clean browser context is investigating the unresolved Player ID.
Fresh original-ARM32 startup reaches the bundled seven-second intro clip through NDK extraction
and decoding. It decodes initial video/audio samples but playback stalls with full output queues;
a tap skips the intro and the tutorial eventually renders. The new media path and buffer-slot
reuse pass owning tests and typecheck. Merged into main as `02696726`: typecheck, all 1,321
unit tests and zero-failure XAPK compilation pass. The final serialized E2E renders 183/183
steps in 954.9 seconds, with no wedge or required native; two YouTube steps exceed their
settling bound. Intro playback, startup/render speed, Player ID and later unlocked features
remain open.

- Run the unchanged 4.2.1 XAPK in full Chrome and an AVD at matching geometry.
- Capture startup, menus, gameplay, pause/resume and saved progression in both.
- Repair reached platform/JNI/native failures at their canonical owners; retain real app bytecode.
- Ignore ad-specific implementation unless it blocks gameplay or other non-ad features.
- Keep changes focused, remove justified duplication, and add only core contract tests.
- During development test Cut the Rope and owning checks only; freeze before full serialized E2E.
- Record evidence, performance, limitations and focused commits in implementation history.

---

# TikTok parity repair

Branch: `codex/tiktok-parity`. Starting revision: `9071fec70953eb3b76df86c6cdede69bdf316eaf`.
Status: guest-path repairs and final regression validation recorded; complete TikTok parity remains incomplete.

Guest-path implementation: `00208a4d`; structural cleanup: `66dd0467`. Typecheck and 1,253 tests pass; TikTok smoke compilation has
zero method failures. The post-cleanup serialized full E2E completes 159 steps in 833.6 seconds
with zero wedges and two baseline YouTube settling limits. Matched baseline checks caught and resolved Resy startup and
Harmonic inset regressions. Remaining gaps include slow decoded playback, onboarding graphic
artifacts, phone-form styling, intermittent Top search loading, an optional JobInfo parcel API,
and a repeated-load stall. Authentication and publishing are unvalidated. The cleanup review
and supplemental Lichess comparison limits are recorded in implementation history.

- Compare the unchanged TikTok APK at 1080×2160, 480 dpi, with screenshots and diagnostic evidence.
- Trace reached platform failures to Android/DEX/native contracts; repair canonical owners.
- Exercise guest onboarding, feed, swipes, resume and reachable navigation. Keep goldens unchanged.
- Keep changes focused, remove redundant paths where justified, and avoid speculative APIs/tests.
- During development test TikTok only plus owning core checks. Run the full serialized E2E matrix
  once the final candidate is frozen; report existing failures and evidence limits explicitly.
- Record mechanisms, paired captures, verification and focused commits in implementation history.

---

# Staged fuzz-audit integration

Fixed comparison baseline: `02aec2c1f92c140a1754ba72a0e239a7305211da` (starting main).
Source: `codex/cpu-overhead` at `1bb72551`, including reviewed fuzz-audit repairs.
Status: retained subset merged and validated. Final production revision: `bccf7ff3`.
Three improvements retained: UTF-16 conversion, ancestor flag repair, async UI capture.
Dialog teardown and unconditional layout replay were withdrawn after AOSP evidence review.
Repeated FitNotes/Mihon CPU stays within +5%; all 1,237 unit tests pass. Full E2E completes
159 steps with zero wedges and two YouTube settling limits on a newly reached playback path.
The ledger records per-merge measurements, baseline comparisons and remaining limits.

1. Character-array conversion: avoid iterator expansion, preserve every UTF-16 code unit.
2. Layout invalidation: repair ancestor flags; preserve Android callback/replay filtering.
3. Activity lifecycle: withdrawn after bundled AOSP contradicted general dismiss callbacks.
4. Harness: async tree capture. Defer Android-side fuzz changes until oracle validation.

For each candidate: focused checks, serialized fresh-browser FitNotes comparisons against
fixed main, then merge only if compatibility holds and median renderer-thread AND
renderer-process CPU remain within +5%. Repeat measurements after the merge and record
results in [the integration ledger](docs/fuzz-integration.md). A confirmed gate failure
stops further integration; preserve the failed candidate separately. Three alternating
pairs control drift; no tracing or competing diagnostic load. Check visibility, advancing
ticks, all 39 completed steps, errors, missing APIs, and rendered pixels. Keep goldens fixed.

Run the full unit and serialized 159-step E2E matrices once on the final accepted state.
Broad API declarations/ownership changes and software rasterization remain deferred: they
need independent justification and evidence, not inclusion to empty the source branch.

Earlier completed work follows.

---

# Trace-directed fast testing redesign — plan

Starting revision: `e75c7c5`. Planning branch: `codex/trace-directed-testing-plan`.
Status: complete.

## Objective

Make webdroid's normal development feedback loop substantially faster without weakening the
existing full Android-parity evidence. The fast path will execute real APK and framework bytecode,
advance Android-visible time deterministically where the environment permits it, wait for explicit
state transitions instead of broad timing horizons, avoid eager image artifacts, and select the
smallest safe flow set from measured execution coverage.

The full serialized real-time E2E matrix remains the final compatibility gate. Performance runs
remain real-time, uncontended, and uninstrumented.

## Acceptance gates

Measure on the same machine with `--jobs 1`, fresh browser processes, no competing diagnostic
load, advancing `wd.ticks`, and successfully rendered applications.

- Add a deterministic `e2e:fast` lane covering every action in the six pinned-clock flows. Its
  median of three frozen runs must be at most 45 seconds, down from the retained 123.0-second
  artifact, without new missing APIs, native requirements, errors, wedges, or changed designated
  visual checkpoints.
- A typical changed-module run selected from the retained coverage index should complete within
  30 seconds. Unknown, stale, or safety-critical changes must widen selection rather than risk an
  empty or falsely narrow run.
- The fast lane should write no more than 10 MiB by default, down from 64 MiB for the current full
  `actual/` tree. A failure rerun must retain all evidence needed for diagnosis.
- The final full matrix must still execute and score all 159 existing steps. No golden is changed
  as part of this work.
- Production-mode startup, interaction CPU, p95 opportunity latency, and retained heap must not
  regress by more than 1% in matched repeated measurements. Test-only tracing and scheduling must
  be absent from performance runs.
- `bun run typecheck`, `bun run test`, affected APK smoke compilation, targeted framework probes,
  the deterministic fast lane, and the full verification matrix must pass at the frozen candidate.

Targets are retention gates, not permission to alter guest deadlines, omit failures, or fabricate
idle state. If 45 seconds is not reached, retain only measured improvements that clear a 20%
deterministic-lane speedup and document the remaining cost by phase.

## Retained baseline

The latest ignored `tests/e2e/actual/*/run.json` artifacts are a serialized `--jobs 1` run:

| Scope | Steps | Step wall time | Settle time |
| --- | ---: | ---: | ---: |
| All 12 flows | 159 | 790.930 s | 743.885 s |
| Six pinned-clock flows | 82 | 122.971 s | 102.975 s |
| Six live-clock flows | 77 | 667.959 s | 640.910 s |

Settling accounts for 94% of step time. Outcomes are 93 idle, 34 pixel-stable, 30 timed animated
snapshots, and 2 timeouts. The declared flow horizons total 675.7 seconds; animated steps alone
force 239.2 seconds of real waiting. The largest recurring busy reasons are timers, sockets,
presentations, drawing, and animators.

The current probe also reads and PNG-encodes a frame for every step. The remaining roughly 47
seconds outside settling combines action execution, liveness checks, readback, encoding, IPC, and
host writes; it is not yet attributed finely enough to optimize safely.

## Design boundaries

- Preserve two clocks. Host measurement time always uses the real monotonic clock. Guest semantic
  time is real in production and live tests, but can be controlled in deterministic tests.
- Virtual time applies only to Android-visible scheduling and time. Network I/O, WebSocket relay
  progress, WebCodecs, audio, WebGL fence waits, browser file handles, compiler timings, and
  performance counters remain real unless their owning contract provides a deterministic test
  mechanism.
- Do not globally replace `performance.now`, `Date`, `setTimeout`, or `requestAnimationFrame`.
  Prior Playwright clock injection conflicted with the probe's timer wrappers. Route only canonical
  Android scheduling owners through the new clock.
- Run application and bundled library bytecode unchanged. The test scheduler is a platform clock,
  not an app-specific shortcut. Do not add package checks, screen-specific delegates, synthetic
  success, or seeded memory.
- A fast result is diagnostic evidence, not the final parity score. The full mode keeps pixel
  capture, real live content, liveness checks, process diagnostics, and performance semantics.
- Prefer deletion over parallel compatibility paths. Once all flows use the new step model, remove
  `settleDelayMs`, `animated`, and obsolete settle branches rather than indefinitely supporting
  both schemas.
- Add no dependency unless a measured implementation cannot be expressed with the browser,
  Playwright, Bun, and existing utilities.

## Target architecture

### 1. Explicit step completion

Replace the optional `settleDelayMs`/`animated` pair with a discriminated wait policy. Begin with
only the policies required by current flows:

```ts
type WaitPolicy =
  | { kind: "state"; condition: StateCondition; maxVirtualMs: number; maxRealMs: number }
  | { kind: "quiescent"; maxVirtualMs: number; maxRealMs: number }
  | { kind: "sample"; atVirtualMs: number; maxRealMs: number }
  | { kind: "live"; horizonMs: number; timeoutMs: number };

type EvidencePolicy =
  | { kind: "semantic" }
  | { kind: "visual" }
  | { kind: "motion"; minFps: number };
```

`StateCondition` initially supports active activity/component, visible semantic text or content
description, and absence of a previously visible anchor. Add another condition only when a
current flow cannot express its completion with these or quiescence.

A state step completes after its condition is true, the main queue has crossed a sentinel, and a
resulting frame has presented. It does not wait for unrelated future timers. Quiescent steps retain
the current conservative busy checks. Sample steps drive deterministic animations to a declared
logical instant. Live steps preserve wall-clock settling for external content.

Full mode captures every existing visual step. Fast mode captures only designated visual/motion
checkpoints; semantic steps retain UI state, diagnostics, and a lightweight presented-frame hash.
Any diagnostic mismatch automatically reruns the failing flow in full evidence mode.

### 2. Runtime-owned guest clock and scheduler

Introduce one small owner for guest time. Keep its production hot path as direct bound functions,
not allocation-heavy event objects or repeated mode switches.

The real implementation delegates to browser time. The controlled implementation owns a stable
deadline heap ordered by `(deadline, process, sequence)`, a logical monotonic instant, and explicit
frame deadlines. Advancing time performs:

1. Drain runnable main/looper/native-return work across live processes.
2. If the completion condition is satisfied after a presented frame, stop.
3. Otherwise advance to the next eligible guest deadline or requested frame instant.
4. Run callbacks due at that instant in stable order and drain again.
5. Stop with structured `stalled`, `real-io`, or `virtual-timeout` evidence rather than guessing
   that the app is idle.

The parent process broker coordinates logical time for same-origin process iframes. Each realm owns
its callbacks; the broker owns ordering and assigns tokens, so no callback or Promise is serialized.
An unloaded process cancels its tokens. External I/O pauses logical advancement while a completion
condition explicitly depends on that I/O; real network timeouts are never consumed by a logical
jump.

First route the canonical high-value owners:

- Handler/Looper messages, Java sleep/park, Timer and scheduled executors.
- Choreographer callbacks, shell ticks, Animator/View animation time, delayed invalidation, and
  input event timestamps.
- Android alarms and lifecycle delays.
- Guest monotonic APIs in Java, bionic, pthread, and the native core.

Classify every existing time access before changing it. Leave profiling, compiler/JIT accounting,
relay/network deadlines, media clocks, WebGL waits, persistence debounce, and harness watchdogs on
real host time. Record intentional real-time sites in one concise ownership table rather than
repeating explanatory comments throughout the code.

### 3. Lazy evidence pipeline

Split a step into measured phases: action, guest drain, external wait, liveness, readback, encode,
IPC, host write, and diff. Retain these phase timings in `run.json` so speedup claims name the work
that disappeared.

In fast mode:

- Use presentation generation plus a lightweight frame hash for semantic steps.
- Read and encode pixels only for designated visual checkpoints or motion samples.
- Write images and UI JSON only when they are assertions or failure evidence.
- On failure, rerun that flow with full capture and process diagnostics; never discard the initial
  structured failure.

Full mode preserves the current sampled-frame rule and artifacts. Do not compare a fresh readback
when the settle rule selected an earlier frame.

### 4. Trace-directed flow selection

Build the selection index only from successful full or coverage runs. Collection is test-only and
disabled for performance measurements.

Prototype Chrome precise JavaScript coverage against the unbundled module URLs used by `index.html`
and `process.html`. Attach to child process targets as well as the main page. The prototype must
prove that invoked code in process iframes maps back to repository files and that a deliberately
untouched module is not reported as covered.

If precise coverage is sound, store a compact generated index mapping repository source files to
flows and first/last covering steps. Do not commit raw V8 ranges or browser-generated source. Add
explicit coverage only for generated DEX/JIT/native dispatch that browser source coverage cannot
attribute. If precise coverage is unsound, stop this phase and use a conservative subsystem index
at canonical dispatch owners; do not scatter manual `hit()` calls through implementation files.

Selection rules:

- A changed file selects every flow that covered it, including the shortest required prefix.
- A changed dependency owner expands through the static TypeScript import graph.
- JVM compiler/runtime, process/Binder, renderer root, native CPU/memory/core, test harness, build,
  provenance, or configuration changes select named broad representative packs or all deterministic
  flows. Native semantic changes also select the relevant oracle/unit family.
- New, renamed, uncovered, stale-index, or uncommitted generated files widen to the deterministic
  lane. They never produce “no tests needed.”
- Live flows run only when their traced code or a broad networking/media/WebView owner changed,
  and always in the final full matrix.

The index records the source revision, flow schema hash, APK hashes, screen, browser version, and
coverage mode. A mismatch invalidates it visibly.

### 5. Verification lanes

Expose a small command surface:

- `bun run test:focused -- <paths or git base>`: import-graph-selected Bun tests plus the selected
  fast E2E prefixes.
- `bun run e2e:fast [flow...]`: all actions in selected deterministic flows, controlled guest
  time, semantic evidence by default, full evidence on failure.
- Existing focused `smoke`, `fwtest`, fuzz replay, and native oracle commands remain the tools for
  their owning changes.
- `bun run e2e --jobs 1`: complete real-time visual/parity matrix for the frozen final candidate.

Do not create a second test taxonomy. Reuse current flows and action definitions; the wait and
evidence policies are additional semantics on those steps. Reuse minimized fuzz failure bundles as
focused regressions rather than translating them into duplicate unit tests.

## Implementation phases and decision gates

### Phase 0 — measurement and schema

- Add harness-only phase timing without changing settle or capture behavior.
- Record targeted baseline repeats for one idle flow, one animated flow, one live flow, and one
  multiprocess flow. Use the retained serialized full artifact for the initial global baseline;
  defer matched full-matrix repeats until the candidate is frozen.
- Define `WaitPolicy`, `EvidencePolicy`, completion results, and validation at the flow boundary.
- Migrate two representative flows behind an explicit experimental flag.

Gate: phase totals explain at least 95% of wall time and the flagged old/new paths capture identical
frames and diagnostics at their shared checkpoints. Otherwise fix attribution before optimization.

### Phase 1 — semantic waits and lazy evidence

- Implement state conditions using existing activity, UI-tree, presentation, queue, and diagnostic
  owners.
- Add semantic-only fast capture and automatic full-evidence failure reruns.
- Migrate pinned flows, keeping existing emulator recording semantics.
- Delete migrated optional timing flags and duplicate capture helpers once no caller remains.

Gate: pinned flows retain their full-mode results, fast mode is at least 1.5x faster, and failures
produce actionable full evidence. If readback/encoding is not material, retain the simpler pipeline
but do not add caching machinery.

### Phase 2 — controlled guest time

- Introduce real and controlled clock implementations with host/guest time separated by name and
  type.
- Route Handler/Looper, scheduled Java work, frames/animations, alarms, input timestamps, and then
  native guest clocks in small ownership commits.
- Coordinate process realms through the broker and expose one test-driver `advanceUntil` entry.
- Convert animated pinned flows to logical samples and remove the probe's test-clock timer wrapping
  where the runtime now supplies authoritative pending-work data.

Gate: deterministic flows produce the same designated frames and lifecycle/order diagnostics under
real and controlled time; three frozen fast-lane runs meet the 45-second target or the documented
retention threshold. A matched production run proves no performance regression.

### Phase 3 — coverage selection

- Run the precise-coverage prototype before designing stored formats.
- Generate and validate the compact flow index.
- Add import-graph expansion, conservative broad packs, stale detection, and command integration.
- Validate the selector against a sample of historical focused fixes: the reproducing flow or
  owning oracle must be selected for every sample.

Gate: no sampled known fix is missed, unknown inputs widen safely, typical Android-module changes
finish within 30 seconds, and coverage mode is measurably absent from production/performance runs.

### Phase 4 — cleanup and final evidence

- Remove the old optional step schema, obsolete timer interception, duplicate settle branches,
  abandoned experimental flags, and tests made redundant by existing end-to-end contracts.
- Keep only scheduler ordering/boundary tests that protect the core abstraction: one deterministic
  deadline-order unit test, one cross-process cancellation/order browser test, and existing flows as
  integration coverage. Do not add per-timer-wrapper tests.
- Update the harness guide and implementation history with retained measurements, failure
  mechanisms, unsupported virtual-time boundaries, and rejected experiments.
- Freeze code, then run the full verification matrix once at the end as requested.

Gate: all acceptance gates pass and `git diff` contains no compatibility scaffolding or diagnostic
instrumentation that is unused by a retained command.

## Planned commit sequence

Keep commits independently reviewable and use `area: sentence` subjects. Expected sequence:

1. `e2e: attribute step wall time by phase`
2. `e2e: model completion and evidence policies`
3. `e2e: capture semantic evidence on the fast path`
4. `runtime: separate guest time from host measurement time`
5. `android: schedule Java and frame work on guest time`
6. `native: route guest monotonic time through the clock owner`
7. `process: coordinate controlled deadlines across realms`
8. `e2e: drive deterministic flows with logical time`
9. `e2e: select flow prefixes from measured coverage`
10. `test: remove superseded timing and capture paths`
11. `docs: record fast-testing evidence and limits`

Split or combine a commit when the actual ownership boundary makes that clearer; do not preserve
this list at the cost of mixed concerns.

## Final verification

During implementation, run only the smallest owning checks and affected flows. After the candidate
is frozen:

1. `bun run typecheck`
2. `bun run test`
3. Smoke-compile affected APKs with zero method failures.
4. Run targeted `fwtest` prefixes, native oracles, and retained fuzz failure replays.
5. Run three serialized `bun run e2e:fast` measurements with no competing load.
6. Start an unused-port server and run targeted text comparison.
7. Run `WEBDROID_URL=<url> bun run e2e --jobs 1` once for the complete 159-step matrix.
8. Run the corpus and performance comparison required by the final changed ownership areas.

Inspect every `run.json`, including child-process diagnostics, settle/completion reasons, advancing
ticks, rendered state, new missing APIs, new errors, native requirements, and phase timings. Report
network-content drift separately from deterministic regressions; it is not a waiver.

### Result

The frozen fast lane completed all 82 deterministic actions in 85.7, 85.8, and 86.2 seconds.
Its 85.8-second median is 30.2% below the retained 123.0-second baseline and clears the 20%
retention gate, though it does not reach the 45-second stretch target. Doodle Jump and Flappy Bird
deliberately retain real scheduling because controlled scheduling changed their observed native
game state; together they account for roughly 47 seconds. Default evidence fell from 64 MiB to
6.0 MiB across 22 files. A representative SQLite change completed `test:focused` in 20.1 seconds.

The final matrix passes typecheck and 1,232 tests with 26,589 assertions. Five affected APKs
smoke-compile with zero method failures, all eight runnable framework exercises pass with 295/363
declared natives covered, and FitNotes text comparison is 6/6. The serialized full browser matrix
exits zero after all 159 steps in 812.1 seconds, with no wedged main loop or required native
delegate and no golden changes. The two established YouTube settle timeouts and documented
TikTok, YouTube, Lichess, and Mihon diagnostics remain visible. The corpus renders 20/20 APKs and
retains 45 distinct compatibility gaps.

Three alternating Calculator pairs at the established phase-decorrelated 1,003 ms input cadence
compare the starting revision with the frozen candidate. Median launch action changes from 612.12
to 605.62 ms (-1.06%), renderer task time from 90.21 to 89.69 ms/s (-0.57%), p95
input-to-presentation opportunity from 14.5 to 14.4 ms (-0.69%), and post-GC heap from 207.83 to
208.08 MiB (+0.12%). Every sample completes all inputs, stays visible and alive, advances
rendering, and reports no error. A preliminary exact-1,000 ms cadence aliased with frame phase and
produced an unstable 10.0 to 12.1 ms p95; it is retained as an evidence limit rather than mixed
into the predefined phase-decorrelated comparison.

## Principal risks

- Advancing time can reorder work across realms. Stable broker ordering and cross-process evidence
  are mandatory before enabling controlled time by default.
- Skipping intermediate animation frames can hide per-frame defects. Motion checkpoints and the
  full real-time matrix remain; performance/FPS tests never use virtual time.
- A semantic anchor can appear before its screen is actually drawable. Require a main-queue
  sentinel and a subsequent presentation, not text presence alone.
- Future timers may be irrelevant to a state assertion but essential to a quiescence assertion.
  Keep those policies distinct rather than weakening the existing busy definition globally.
- Coverage-guided selection can create false confidence. Staleness and unknown coverage always
  expand selection; core runtime changes use conservative packs.
- Clock abstraction can tax hot paths. Keep production bindings direct and reject the design if
  matched application measurements cross the 1% gate.

## Non-goals

- No process, Java-heap, Wasm-memory, or browser save states.
- No attempt to accelerate external servers, TLS, live video/audio, or real performance time.
- No replacement of the Android emulator oracle or committed visual goldens.
- No app-specific test delegates, package conditionals, synthetic lifecycle completion, or hidden
  retries that turn failures into success.
- No broad test rewrite, new test framework, or duplicate unit coverage for behavior already
  exercised by a retained real fixture.
