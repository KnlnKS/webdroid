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
- Harness counter/time boundary corrected; isolated browser runner under validation.
- Rendering snapshot candidate and native invalidation correction await integration review.
- JVM operand replacement and ARM32 effects implementation in progress.
