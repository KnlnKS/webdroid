# Android API and graphics fuzzing

Starting revision: `4ecee61`. Integration branch: `codex/android-api-fuzzing`.

## Contract

- API 33 is the behavioral contract. Inventory every public SDK member and add hidden or
  internal members only when framework bytecode or the APK corpus reaches them.
- Run one unchanged probe APK on Android and webdroid. Preserve seeds, normalized results and
  minimized failures; never manufacture support or treat absent telemetry as success.
- Keep fuzz-only coverage out of production-generated methods. Long campaigns are manual;
  normal verification receives only deterministic smoke cases.
- Fix harness blockers and broadly applicable compatibility faults. Record other reproducible
  findings instead of making completion depend on eliminating the platform backlog.

## Delivery phases

- [x] Provision an API-33 reference AVD and ignored oracle cache.
- [x] Build the canonical API catalog and support classifier; migrate audit tools to it.
- [x] Build and run the dependency-free differential probe APK.
- [x] Add deterministic API and graphics generation, comparison, replay and minimization.
- [x] Add opt-in JVM coverage and semantic UI fuzzing with complete process telemetry.
- [x] Audit the full TypeScript/Zig tree and retain only evidenced simplifications.
- [x] Resolve the strict post-implementation review findings for protocol ownership, atomic
  evidence, failure clustering, UI target boundaries, and isolated campaign resources.
- [x] Run the final typecheck, unit, smoke, framework, fuzz, text, E2E, corpus and performance
  matrix. Record measurements and evidence limits in the implementation history.

## Retention gates

- Fixed seeds reproduce identical inputs and normalized results.
- Every retained failure reproduces twice after minimization.
- Missing child-process diagnostics are harness failures, not empty observations.
- Existing visual goldens do not change without independent product evidence.
- With fuzz coverage disabled, primary performance metrics remain within 3% over five serial
  alternating baseline/candidate pairs.
