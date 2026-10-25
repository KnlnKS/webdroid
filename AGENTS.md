# webdroid — in-browser Android emulator

Run APKs client-side with static hosting, a CORS proxy and a TCP relay.
[PLAN.md](PLAN.md) tracks current status and open work; [implementation history](docs/implementation-history.md)
records failure mechanisms, measurements and evidence limits. Older source comments naming
AGENTS investigations refer to that history. Verify historical status against the current code.

## Working principles

- Run app and bundled library bytecode unchanged. Implement platform/JNI behavior from
  Android, DEX or native evidence; avoid app-specific substitutes and fabricated success.
  Distinguish unsupported capabilities from supported operations that return no result.
- Preserve public semantics while improving internals. Architecture descriptions below
  explain the current design, not a ban on measured, tested changes.
- Follow failures to their cause. Missing APIs can break transactions, but optional queries
  and downstream errors need investigation before adding delegates or suppressing symptoms.
- Reuse owning modules and canonical helpers. `src/natives.ts` assembles registrations;
  import symbols from their owner. Change registrations there rather than patching another
  module's spec through `rt.natives.get`. Check for conflicting registrations, including
  generated ones; a textual name match alone does not establish a conflict.
- Keep changes, dependencies and comments proportionate. Comments explain non-obvious reasons.
  Optimize measured hot paths without trading away correctness. Revisit failed experiments
  when a new hypothesis or changed conditions justify a controlled comparison.
- When commits are requested, use focused `area: sentence` subjects. Record useful findings
  and unresolved limits in the history; remove abandoned code.

## Verification

Follow task-specific acceptance and the user's verification timing. Select checks for the
changed behavior; complete the broader matrix when required by PLAN or the task. Do not
run the entire suite solely for documentation edits.

```bash
pnpm check       # the gate (~95 s): one pool of a stale platform build, typecheck, test shards, wasm parts and e2e [flow ...]
pnpm check --corpus  # also launches each corpus apk no flow launches (~220 s), held to tests/corpus-drawn.json (`pnpm corpus --update`)
pnpm typecheck
pnpm test
pnpm fwtest
pnpm wasm all    # src/wasm suites at once: diff classdiff … sweep (boot jars and FitNotes) aottest persist; `pnpm wasm` lists them
PORT=4090 pnpm dev
WEBDROID_URL=http://localhost:4090 pnpm e2e
# outside the gate: text layout parity, live content and measurement
WEBDROID_URL=http://localhost:4090 pnpm textcmp FitNotes.apk
WEBDROID_URL=http://localhost:4090 pnpm e2e --live
WEBDROID_URL=http://localhost:4090 pnpm corpus
WEBDROID_URL=http://localhost:4090 pnpm lat [--warm]
pnpm conform guava|jsr166|ojluni-time
pnpm ts scripts/perfsum.ts tests/e2e/actual <baseline.json>
```

- Use an unused port for this checkout; 4090 is an example. Serialize captures that share
  output directories and keep the code under capture stable. See the
  [harness guide](tests/e2e/README.md) for flow selection, output paths and recording.
  `pnpm check` is the reproducible gate: it starts a dev server on a free port unless `WEBDROID_URL`
  names one, stops at the first failing task and shows its output. Each e2e flow runs once and is
  scored when it has goldens. `--live` adds flows that depend on network content; `lat`, `corpus`
  and the conform suites measure and run on their own.
- Typecheck includes `noUnusedLocals` and builds the Wasm core with Zig 0.16. Generated core
  blobs, the WebView page bundle and the sql.js build are not committed; the node preload
  (`scripts/preload.ts`) and the Vite config build them, and tests use ReleaseSafe.
- `pnpm lat` gates tap latency (≤ 150 ms, pointerup to the answering frame); `--warm`
  repeats each scenario with the code a first launch persisted. `pnpm conform <suite>`
  compares a conformance suite with its baseline in `tests/conformance/`. `pnpm gen-framework` (reference AVD booted) refreshes the
  platform class path, framework-res, ICU/tz data and the device overlays' values.
- Smoke-compile affected APKs (`smoke <apk>` is the Wasm sweep; `wasm all` sweeps FitNotes); require no unexplained failures or
  explicitly report a reproduced baseline failure. Use `fwtest [prefix ...]` for real framework delegate coverage.
- Inspect per-step `run.json`: `newMissing`, `newErrors`, `nativeRequired`, layout/draw errors,
  completed rendering and performance. Empty telemetry proves only observed-path coverage.
  Confirm diagnostics actually reached each relevant process.
- Compare ambiguous failures with the starting commit under matching inputs and settings.
  Live content, coordinate fallbacks and prior failures are hypotheses, not regression waivers.
  Keep visual goldens unchanged unless reference updates are explicitly requested.
- Measure performance with `--jobs 1`, no competing diagnostic load and working rendering
  ([protocol and baselines](docs/performance.md)).
  Check visibility and advancing `wd.ticks`; throttling or a wedged app can mislead counters.
  Prefer headless Playwright for repeatable timing and disable expensive tracing.
- `settleDelayMs` bounds scheduled work, not a mandatory sleep. Read `settled`/`busy` before
  extending it. Different screen geometry runs as smoke against mismatched goldens.

## Architecture and correctness boundaries

- DEX compiles lazily to Wasm GC; suspension is cooperative within each process realm. Processes
  have separate JVM state, main queues and native memory. Broker IPC carries serialized Parcels
  and handles, not Java objects; replies must reach callers waiting on the main queue.
- At the host boundary Java strings are JS strings; int/float/double are numbers, long is BigInt; primitive arrays
  are typed arrays and object arrays carry `$t`. JVM code owns mangling, defining-loader
  identity and null/zero normalization; the compiler types constants by their uses (`infer.ts`).
- Main-thread entry uses `onMain`; queue ownership is the main loop's dispatch depth, not thread identity.
  Preserve lifecycle/callback ordering. Class initialization waits for concurrent initialization
  while allowing same-class re-entry and handling cycles.
- Java overrides, overloads, reflection and boxing must reach the correct Java entry point.
  Natives reach Java through `jentry` (`vcall`/`scall`/`newObj`), which dispatches by name and descriptor.
  Re-entrant callbacks can suspend; do not infer synchrony from one observed fast path.
  Collection views stay live. Resolve CharSequence with `csText`, not `String(javaObject)`.
- Resources drive widget defaults, themes and geometry (`src/shell/config.ts`). AOSP bytecode
  needs its paired jar/resources from the same build, not relinked substitutes. The classes a TS
  spec may stand in for are `TS_SPECS` in `src/jvm/provenance.ts`. Preserve the software draw path when adding rendering capabilities.
- Preserve measure/layout invalidation, virtual view entry points and frame/lifecycle ordering.
  Back reaches the topmost window. Use shared text metrics; report draw failures and recover
  the frame loop. Detailed widget failure cases are in the history.
- Persistent state has canonical owners across processes. SQLite snapshots must retain live
  connection-local TEMP tables/triggers. Restore package state before initialization when
  startup consumes it. Preserve package isolation and credential ownership.
- Shared APK/XAPK installation preserves split precedence, distinct DEX entries, signing
  metadata and ABI selection. Keep startup loading lazy and asset caching bounded.
- ARM32/A64 execute in `src/native/core/`; `cpu.ts` drives async exits. Interpreter semantics
  and JIT results must agree. Stores to executed code invalidate decoded operations and regions;
  install compiled regions only against their source page epoch. Host calls exit `run_slice`;
  preserve guest-frame, signal and callback ordering. See the history for core implementation
  details and rejected performance experiments.
- Java runs on the Wasm tier, `src/wasm/{compiler,link,host}`, loaded by a dynamic import from `src/jvm/tier.ts`.
  Only `host` may import the runtime, natives and services (`tests/wasm-layers.test.ts`). Its suites are `pnpm wasm <suite>` (`scripts/wasm/run.ts`);
  a change to the shared front end (`prepared`, `dex`, `abi`, `opcodes`) also needs `pnpm wasm all`. Map: [docs/architecture.md](docs/architecture.md).

## Diagnosis

`package.json` is the command index. Start with `inspect`/`dis` for bytecode, `wasm watdump` for generated code,
`audit` for reachable missing APIs and `fwscan`/`fwtest` for framework evidence. Native tools are
`scripts/nrun.ts` and `scripts/ndbg.ts`.

The browser exposes `wd` from `src/shell/harness.ts`; missing APIs are `wd.rt.missing`.
For suspected JIT faults, compare `?jit=0`, then narrow with `__wdJit` ranges or
`core.jit_fallback(lo, hi)`. Combine reproduction, tier comparison and source inspection.
