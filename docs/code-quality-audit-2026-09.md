# Code-quality audit: Android compatibility fuzzing

This audit reviewed the fuzzing changes across TypeScript and Zig source,
ownership boundaries, the strict build and targeted harness behavior. File
size identified review candidates; it did not justify splitting cohesive
state machines. Git history retains the detailed scan.

## Resolved ownership and correctness findings

- `scripts/native-surface.ts` is the shared registration resolver for
  inventory, audit, corpus and framework tools. It distinguishes
  placeholders without a normal-invocation branch.
- `scripts/android-sdk.ts` owns SDK/build-tool discovery. Probe and UI
  campaigns share a browser/server session owner with exception-safe cleanup.
- Coverage mode is selected before DEX method generation: disabled methods
  contain no per-call probe. Enabled coverage reaches child realms.
- Paint cap/join round trips and inverted Canvas bounds now follow probe
  evidence instead of browser defaults.
- Failure bundles retain original and minimized inputs, outputs,
  diagnostics and artifacts from matching runs, followed by two
  serialized reproductions. Graphics keys separate stable reproduction
  from clusters.
- Graphics commands use validated exact tuples and enum domains; an
  exhaustive operation list is checked against the probe's Java switch.
  API recipes own their member metadata.
- UI orchestration has explicit Android/webdroid targets, one
  `uiautomator` parser and tagged process-diagnostic states. Campaign
  servers use private ports and temporary APK directories.
- API/graphics minimization batches independent candidates; UI
  minimization resets both platforms for stateful replay.

No test deletion met the standard of removing duplicated behavior and
regression evidence. The review reduced the UI orchestrator from 423 to
347 lines by moving actual platform state, not by adding façades.

## Remaining review queue

| Area | Reason to revisit |
| --- | --- |
| `src/jvm/natives/jutil.ts` | Live collection views, iterators and suspension are coupled; extract only a proven complete owner. |
| `src/android/view.ts` | Measurement, layout and invalidation need transition evidence before separating state. |
| `src/android/graphics.ts` and `drawable.ts` | Similar geometry can have different Android rounding; use minimized graphics cases before sharing it. |
| JVM dynamic boundaries | Add validated types where a stable wire contract exists. |
| Harness process/deadline helpers | Similar syntax hides different timeout and lifetime contracts; share only a proven common one. |
| Native ARM/JIT modules | Instruction-family ownership is cohesive despite file size. |

Rejected: thin façade modules, fabricated generic API receivers, runtime
coverage guards, broad test pruning and one catch-all subprocess helper.
The next cleanup should follow a minimized compatibility defect or a
measured hot path.

## Follow-up: exploration, probes and networking

- The corpus report previously ranked only the main process's missing calls,
  even though it captured child-process diagnostics. It now reports missing
  calls and native requirements from every relevant process and marks missing
  telemetry explicitly. A drawn frame remains a boot observation, not an app
  compatibility verdict.
- UI exploration state lives in a bounded journal outside the replay and
  minimization protocol. Current-screen action candidates are generated when
  visited instead of persisted, avoiding large stale candidate lists. An
  unused semantic-identity helper was removed. The remaining structural state
  key can merge screens with identical controls; this is an exploration limit,
  not evidence that their behaviors match.
- Bundle and Intent sequences reuse the existing validated API probe protocol
  and its minimizer. Recipe metadata names the declaring framework class, so
  inventory's exercised flag does not need a second catalog.
- The TCP relay now preserves partial writes and caps queued bytes. The HTTP
  delegate preserves manual redirect status and headers through the proxy.
  Those fixes stay with the transport and URLConnection owners instead of
  adding special handling to individual apps.

This review retained the focused persistence and HTTP tests because they cover
state and wire behavior that would otherwise be easy to regress. It found no
additional test whose removal would preserve that evidence.
