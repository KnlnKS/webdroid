# webdroid — in-browser Android emulator

Run APKs client-side with static hosting, a CORS proxy and a TCP relay.
[PLAN.md](PLAN.md) tracks the current task; [implementation history](docs/implementation-history.md)
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
bun run typecheck
bun run test
bun run smoke apks/FitNotes.apk
bun run fwtest
PORT=4090 bun run server.ts
WEBDROID_URL=http://localhost:4090 bun run textcmp FitNotes.apk
WEBDROID_URL=http://localhost:4090 bun run e2e --jobs 1
WEBDROID_URL=http://localhost:4090 bun run corpus
bun scripts/perfsum.ts tests/e2e/actual <baseline.json>
```

- Use an unused port for this checkout; 4090 is an example. Serialize captures that share
  output directories and keep the code under capture stable. See the
  [harness guide](tests/e2e/README.md) for flow selection, output paths and recording.
- Typecheck includes `noUnusedLocals` and builds the Wasm core with Zig 0.16. Generated core
  blobs and the sql.js build are not committed; Bun preloads their builders and tests use
  ReleaseSafe. The server builds `vendor/framework-res.apk` when it is missing.
- Smoke-compile affected APKs; require zero method failures or explicitly report a reproduced
  baseline failure. Use `fwtest [prefix ...]` for real framework delegate coverage.
- Inspect per-step `run.json`: `newMissing`, `newErrors`, `nativeRequired`, layout/draw errors,
  completed rendering and performance. Empty telemetry proves only observed-path coverage.
  Confirm diagnostics actually reached each relevant process.
- Compare ambiguous failures with the starting commit under matching inputs and settings.
  Live content, coordinate fallbacks and prior failures are hypotheses, not regression waivers.
  Keep visual goldens unchanged unless reference updates are explicitly requested.
- Measure performance with `--jobs 1`, no competing diagnostic load and working rendering.
  Check visibility and advancing `wd.ticks`; throttling or a wedged app can mislead counters.
  Prefer headless Playwright for repeatable timing and disable expensive tracing.
- `settleDelayMs` bounds scheduled work, not a mandatory sleep. Read `settled`/`busy` before
  extending it. Different screen geometry runs as smoke against mismatched goldens.

## Architecture and correctness boundaries

- DEX becomes lazy JavaScript; suspension is cooperative within each process realm. Processes
  have separate JVM state, main queues and native memory. Broker IPC carries serialized Parcels
  and handles, not Java objects; replies must reach callers waiting on the main queue.
- Java strings are JS strings; int/float/double are numbers, long is BigInt; primitive arrays
  are typed arrays and object arrays carry `$t`. JVM code owns mangling, defining-loader
  identity, null/zero normalization and reaching-definition typing of floating constants.
- Main-thread entry uses `onMain`; queue ownership is `inMainJob()`, not thread identity.
  Preserve lifecycle/callback ordering. Class initialization waits for concurrent initialization
  while allowing same-class re-entry and handling cycles.
- Java overrides, overloads, reflection and boxing must reach the correct Java entry point.
  Re-entrant callbacks can suspend; do not infer synchrony from one observed fast path.
  Collection views stay live. Resolve CharSequence with `csText`, not `String(javaObject)`.
- Resources drive widget defaults, themes and geometry (`src/shell/config.ts`). AOSP bytecode
  needs its paired jar/resources from the same build, not relinked substitutes. Provenance lives
  in `src/jvm/provenance.ts`. Preserve the software draw path when adding rendering capabilities.
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

## Diagnosis

`package.json` is the command index. Start with `inspect`/`dis`/`jsrc` for bytecode,
`audit` for reachable missing APIs, `fwscan`/`fwtest` for framework evidence and `natcheck`
for suspension contracts. Native tools are `scripts/nrun.ts` and `scripts/ndbg.ts`.

The browser exposes `wd` from `src/main.ts`; missing APIs are `wd.rt.missing`.
For suspected JIT faults, compare `?jit=0`, then narrow with `__wdJit` ranges or
`core.jit_fallback(lo, hi)`. Combine reproduction, tier comparison and source inspection.
A framework provenance cut uses
`WEBDROID_BYTECODE='android/graphics/Paint,android/graphics/Canvas'`.
