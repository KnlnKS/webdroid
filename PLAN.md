# Maintainability and performance audit

## Scope

Audit compiler/JVM, native CPU/JIT/Wasm, browser/platform runtime and dependencies.
Use parallel component audits to select small, general improvements with measured
performance or clear structural benefits. Preserve Android/DEX/native semantics and
run bundled APK bytecode unchanged. Record each coherent change in a focused commit.

The preceding app-parity and Maps integration work is complete; its results and
remaining verification limits are in [the implementation history](docs/implementation-history.md).

## Acceptance

- Review hot paths, duplication and dependencies against current code and primary OSS sources.
- Retain optimizations only with correctness evidence and reproducible, serialized measurements.
- Prefer existing core tests; add coverage only for a core contract exposed by the change.
- Run typecheck, relevant unit/framework tests and affected APK smoke compilation.
- Exercise affected browser behavior with a serialized capture where applicable, inspect
  run.json telemetry and leave visual goldens unchanged.
- Record measurements, rejected alternatives and unresolved limits in the implementation history.

## Completion

- Five focused implementation commits cover immutable compiler dataflow, native bulk
  copies, direct Base64 output, lazy certificate lookup and a smaller Forge entry point.
- Typecheck passes; the full suite passes 1,198 tests / 24,884 assertions. Framework
  exercises pass, with Canvas2D text measurement explicitly skipped in headless Bun.
- FitNotes, Resy, Flappy Bird and Doodle Jump compile with zero method failures.
- The serialized four-flow capture renders all 65 steps with clean foreground telemetry.
  All app and child runtimes in a separate boot diagnostic expose empty missing/native
  requirements; Resy's browser console records upstream analytics HTTP rejections.
- Flappy Bird remains below its 55 fps target on both the starting and changed revisions;
  repeated captures overlap at 25–28 fps minimum. No app-wide speedup is claimed.
- [Audit report](docs/performance-audit-2026-09.md) records measurements, OSS references,
  library decisions and deferred opportunities. The implementation history records final
  verification limits; raw evidence remains in `webdroid-shots/performance-audit/`.
