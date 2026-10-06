# Idle G1/G4 and boundary attribution

These tools always write `accepted: false`. Run them serially after the parent agrees that the host is idle, against one frozen production source epoch. Record the fresh AOT manifest/source, Chrome version, DEX/harness hashes and host load. A low load average alone does not establish an idle host. Diagnostic runs under shared load establish mechanisms only.

## G4: one active invocation

From the Y1 checkout, run the untraced speed sample first:

```sh
PATH=/opt/homebrew/opt/openjdk@17/bin:$PATH bun scripts/wasm/gate-browser.ts \
  --methods reducible,irreducible,exceptionCycle --n 32000000 --repeats 5 \
  --idle-confirmed --out tests/e2e/actual/y1-recovery/idle-g4
```

Repeat the same input with `--cold` to cover actual interpreter promotion/compiled reentry. Each method gets a fresh Chrome process. The fixture executes ordinary DEX with no compiler substitutions: a reducible loop, a generated two-entry SCC, and a Java throw/handler continuation cycle inside an owned monitor. The multiple-entry graph is checked after D8. Independent numeric results and all repeated results must match, with no Java/browser gaps or errors. Normal fuel/yield behavior is retained and yields are counted.

Checkpoints every 32,768 iterations record work and wall time inside the invocation. Five-millisecond windows include native checkpoint dispatch, scheduling waits and chunk reentry. `speedReachedMs` is a **candidate**: three consecutive windows at least 90% of the median later-call rate. Require `referenceStable`, enough windows, visible execution, and the actual first invocation's rate reaching that reference by 100 ms. Preparation, whole first-call time and the Java entry marker are separate fields. A whole-method average or an optimized later invocation does not close G4. No automatic rerun searches for a favorable sample.

Collect engine evidence separately, using the same frozen source and input:

```sh
PATH=/opt/homebrew/opt/openjdk@17/bin:$PATH DEBUG=pw:browser \
  bun scripts/wasm/gate-browser.ts --methods reducible,irreducible,exceptionCycle \
  --n 32000000 --repeats 5 --trace \
  --out tests/e2e/actual/y1-recovery/idle-g4-trace \
  > tests/e2e/actual/y1-recovery/idle-g4-trace.log 2>&1
bun scripts/wasm/gate-trace.ts \
  --mechanism tests/e2e/actual/y1-recovery/idle-g4-trace/mechanism.json \
  --log tests/e2e/actual/y1-recovery/idle-g4-trace.log \
  > tests/e2e/actual/y1-recovery/idle-g4-trace/correlated.json
```

The only V8 flag is compilation tracing; there is no forced tiering budget or eager optimizer. Raw browser traces retain Java entry/end markers and Wasm top-tier events. The trace run also records emitted function names, wire function indices and body sizes. `gate-trace` matches each engine module address by its complete observed signature and leaves ambiguity unresolved. Count imports from the binary: enabled js-string builtins are absent from `Module.imports`, so that API alone gives wrong function indices. Debug-log receipt time is an upper bound on completion, not the exact optimizer timestamp. Review the raw events and correlated **loop chunk** functions inside the first activation; unrelated TurboFan work is insufficient. Instrumented trace timing is not the untraced latency result.

## G1: matched first call and steady state

Use the current guarded build's absolute directory in `WEBDROID_AOT`; do not set `G1_STARTUP=all`, supply a historical `--ref`, or change V8 budgets for acceptance. Standard startup/module misses and compile/instantiate work remain visible.

```sh
PATH=/opt/homebrew/opt/openjdk@17/bin:$PATH \
WEBDROID_AOT=/Users/kunalan/Projects/webdroid-wasm-y1/vendor/wasm-aot/KEY \
  bun run wasm g1 listAddGet listIter mapInt deque sort linkedList treeMap random casts jsonParse \
  --engines chrome --runs 5 --reps 100 \
  --json tests/e2e/actual/y1-recovery/idle-g1.json
```

Repeat with `--cold` and a distinct output. JS/Wasm order alternates between passes. The report records source/DEX identity, cold policy, AOT directory, first/steady samples and compilation work. Require every selected workload, matching results, full call counts, empty `blocked`/`failures`, steady geometric mean at least 1.3x, no workload more than 10% slower, and first-call performance no worse. Matching an unsupported subset cannot pass the gate. Use additional workload rows required by the current plan rather than replacing this set with convenient kernels.

For byte attribution, `bun scripts/wasm/aot-size.ts --guarded DIR --off DIR --out FILE` accounts for every C-module byte by Wasm section, including framing, names, AOT headers and traces. Use full builds from matching source/settings with only the guarded policy changed. This measures serialized size, not heap retention or CPU cost.

## G5: conversions and an actual heavy tap

The mechanism harness's `scalarCalls`, `textCalls`, `emptyArrayCalls`, `arrayCalls` (4,096 ints) and `fieldCalls` use descriptor-generated production native stubs, real string/array conversion and the actual facade accessor. Loop results are checked independently; host-body calls and canonical native crossings are counted separately. Run those methods with identical input/repetitions in an idle window. Their total per-call cost includes guest dispatch and trivial native work: it is a microcost diagnostic, **not** a subtraction proving the heavy-tap boundary fraction.

For the real tap, reuse the ordinary parent harness and unchanged flow/action. An example setup is FitNotes after `2-save`, exercising `tab-history` once. Existing `scripts/perf-browser.ts --cpu-profile --exercise-once` provides a foreground profile and validated interaction report; it does not by itself cover the current process Workers. Do not perform a second action merely to obtain a profile.

`startBoundaryProfiles(browser, readProcessDiagnostics)` in `scripts/wasm/boundary-capture.ts` can bracket that existing action. Supply the parent's canonical process-diagnostics callback: process Workers expose counters over their control port, not a global `wd`. It profiles every current page/frame/Worker target in the owned browser, retains canonical pre/post process diagnostics plus direct counters where available, and reports target failures or newly appearing targets as incomplete coverage. It never pauses Workers, collects garbage or changes clocks/queues. Call its returned stop function in `finally`, then save each target's raw `profile` as a `.cpuprofile`. Require actual target readiness, advancing ticks/rendering, action completion and the intended changed pixels from the parent capture. Resolve each target to its Java process; absent diagnostics are not empty counters. `completeCoverage` describes profiler targets, not the correctness of a missing diagnostics callback.

```sh
bun scripts/wasm/boundary-profile.ts --profile TARGET.cpuprofile \
  --owners reviewed-node-owners.json --out TARGET-boundary.json
```

The optional ownership file maps node IDs to `{ "category": "boundary", "evidence": "mapped source/function ..." }` (or `nativeWork`, `java`, `runtime`, `idle`, `unattributed`). Review bundled/generated frames against their actual source or module/function map. Only **self** samples count as boundary cost. Native body descendants stay native work, even when called from a bridge. Unmapped Wasm may be Java, native stubs, accessors or the ARM core and therefore remains unattributed. The analyzer reports a known-boundary lower bound and a conservative upper bound including all unattributed samples. Sum sampled active CPU and boundary CPU over every relevant target; do not average process percentages or use whole-native inclusive time. G5 remains open if unresolved ownership/coverage prevents proving boundary cost below 5% of the actual heavy tap's CPU.
