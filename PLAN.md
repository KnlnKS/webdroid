# Staged performance replacements

Starting revision: `b16d705`. Target sustained responsiveness across Flappy Bird,
Doodle Jump, FitNotes, Resy, Mihon and Lichess. Aim for >=1.5x representative app
improvements and 55–60 completed frames/s; retain large replacements only for
>=15% reproducible app gains, rejecting >5% responsiveness/startup or >10% retained
memory regressions. Smaller correctness and structural improvements may stand alone.
Guest bytecode, platform semantics and visual goldens remain unchanged.

## Workstreams

- Coordinator: matched browser measurement, harness timing boundaries, integration,
  documentation and final regression matrix on `codex/perf-integration`.
- Rendering: canonical completed-frame publication, then a separate compositor only
  if >=15% of frame cost is attributable to surface transfer/repeated composition.
- JVM: explicit cold operands/reused preparation, then bounded resumable blocks;
  preserve initial promotion and hot-source budgets while comparing stages.
- Native: reproduce and repair code-write invalidation, then precise ARM32 effects;
  indexed eviction only if >=5% native CPU or repeated frame-budget overruns justify it.

Implementation agents use isolated `.worktrees/perf-*` checkouts and focused commits.
The existing `.worktrees/baseline` is preserved; a separate `perf-baseline` points to
this task's starting revision. Correctness work can run in parallel, but all builds,
tests and diagnostic loads pause during serialized performance windows.

## Acceptance

- Three alternating baseline/candidate pairs; seven when near thresholds or inconsistent.
- Fixed inputs, geometry, browser, app state and warmup; separate SwiftShader and verified
  hardware acceleration. No screenshot readback or profiling during timed windows.
- Distinguish shell ticks, completed GL frames and actual presentations. Verify visibility,
  advancing ticks and per-process diagnostics. Trace only in separate attribution runs.
- One compact real-DEX tier fixture plus focused extensions of existing native/surface
  contracts. Typecheck, existing unit suite, affected framework tests and APK smoke.
- Broad runtime replacements require corpus and serialized full E2E. Reproduce ambiguous
  differences against the starting revision. Keep goldens unchanged.
- Record retained/rejected stages, measurements and limits in implementation history.
  Completion means replacement stages were measured and accepted/rejected with evidence.

## Progress

- Three isolated implementation branches and a clean task baseline created.
- Harness counter/time boundary corrected; isolated 15-second windows exclude screenshot
  encoding and tracing, support alternating inputs and report actual GPU backend. Full
  Chromium 151 verifies Apple M4 Pro / ANGLE Metal; original SwiftShader remains separate.
- Native byte-range invalidation, host-buffer notifications, allocation/mapping lifetime
  invalidation and ARM miscellaneous dispatch corrections integrated. Typecheck and all
  1202 unit tests pass at the correctness checkpoint. Three paired native rotations select
  standalone Thumb calls: Doodle title startup 13.08 -> 9.77 seconds against correctness,
  12.89 -> 9.77 against pristine. Reject precise ARM effects (only 6–9% incremental benefit).
  Follow-up far-branch decoding and packed GPU readback fixes pass focused checks; combined
  app/regression verification remains. Detached renderer hooks and completed Window PixelCopy
  fixes are also integrated independently of the rendering experiments.
- Snapshot-only publication measured neutral in three Flappy pairs. CPU Canvas2D backing
  rejected for near-continuous main-thread blocking despite higher FPS. Combined snapshot
  candidate also rejected for blocking; Metal remains near 60/s on both revisions. Separate
  composition and narrower UI coverage also rejected in three 15-second comparisons:
  29.67 -> 23.53/24.66 presentations/s and worse intervals. Metal stays 60/s with only
  1.5–3.2% CPU savings. No compositor replacement meets retention.
- Explicit JVM operands, bounded resumable blocks and synchronous-until-suspension stages
  pass core DEX checks. Seven component rounds show construction 53.9 -> 41.2 ms and cold
  loop 52.3 -> 21.3 ms. App measurements do not clear the 15% gate for either block stage;
  both are rejected. Explicit operands are also rejected after combined latency guards
  remain sensitive to phase and aggregation without an application speedup. The original
  cold handlers are restored; the independent signed-zero correction and real DEX tier
  fixture remain. Promotion and hot-source budgets stay unchanged.
- Integrated typecheck, 1208 unit tests, eight executed framework exercises and eager/cold
  smoke compilation of all six target APKs pass. Framework coverage gaps are documented.
- Earlier combined guards at `39059ba` exposed Resy latency sensitivity. An exact
  minus-operands control also had an unresolved executor failure; an aligned seven-pair
  comparison passed nominally but did not justify retaining the operand replacement.
  Full evidence, including unfavorable pairs and aggregation sensitivity, remains in the
  history. Final production is frozen at `6cbce0b`, with harness `dc5d401`.
- Final selected-build typecheck, all 1208 tests, framework exercises and twelve target
  APK smoke compilations pass. A subsequent fixture audit adds one required native-to-Java
  re-entry case; all five DEX tier cases/442 assertions and typecheck pass against unchanged
  production. This is not a second full-suite run after that test-only addition.
- Final Doodle completed-title startup is 21.5% faster with stable completed presentations;
  secondary rAF p95 rises 4.95%. Lichess navigation passes. Real engine replies are observed
  on both revisions, but differing search work and existing pthread failures prevent an
  engine-throughput claim. Doodle's unimplemented accelerometer prevents a verified sustained
  gameplay workload. Flappy title guards pass on both backends; bounded frozen gameplay
  replay fails proof and remains explicitly unverified.
- Final FitNotes seven-pair navigation guard passes: CPU +3.99%, median opportunity proxy
  -4.51%, p95 +2.40%, heap unchanged. CPU is worse in six pairs, a retained near-threshold
  cost. This exercises the existing empty Graph, not populated chart rendering.
- Final Mihon seven-pair Reader-settings scrolling guard passes: CPU -0.58%, median
  opportunity proxy -0.21%, p95 -1.22%, heap unchanged. This does not measure comic decoding.
- Final Resy seven-pair aligned navigation guard passes: CPU +1.41%, median opportunity
  proxy -5.67%, p95 -6.62%, heap unchanged. Matching live content changes at pair five;
  all samples remain included. None of these three foreground windows executes native code;
  child native-performance telemetry remains unavailable.
- Final static review identifies a pre-existing active-region invalidation gap: a successful
  code-page store drops future dispatch entries but does not stop the current JIT region.
  Inline cache barriers do not universally enforce an exit. A focused reproduction and
  minimal correction are being prepared in an isolated worktree; no runtime verdict yet.
- Remaining: the active-region reproduction/correction and affected native
  measurements, then the serialized pristine/final full E2E and
  17-APK corpus matrix. Expected E2E coverage is 12 flows/159 steps, including four scored
  flows; capture completion alone is not a correctness verdict. Inspect all diagnostics,
  visual differences and missing telemetry before the final retention report.
