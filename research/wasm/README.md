# Wasm backend research

This directory holds the pre-design research for the Wasm tier: probes, microbenchmarks and static analyses. Nothing in
`src/` or the tests imports it. `scripts/wasm/watdump.ts` uses its `node_modules` for `wasm-dis`. The current design is
in `docs/architecture.md`.

Setup: `pnpm install` at the repo root installs binaryen and wabt for this workspace package, and playwright. The
timing scripts (`micro/*.mjs`) need Chrome, and each reports an indicative single run.

- `probe.mjs` and `probe-tiering.mjs` probe engine features, limits, compilation hints and code caching. Their results
  and reproduce commands are in `platform-status.md`.
- `micro/` holds the microbenchmarks.
- `gc/` holds a Zig mark-sweep collector, built with `zig build-exe gc.zig -target wasm32-freestanding -O ReleaseFast
  -fno-entry -rdynamic --import-memory -femit-bin=gc.wasm`.
- `dexstats/` holds DEX corpus statistics over the compiler's register typing: `dexstats/REPORT.md` and its data. The
  scripts that took them are in Git history.
- `survey/` measures how host natives couple to Java objects. `node survey/ast-survey.ts` writes `survey/out/ast.json`,
  which `summarize.ts`, `coupling.ts` and `byte-movers.ts` read.

Reports kept here:
- `platform-status.md`: browser and engine Wasm capabilities (JSPI, GC, EH, tail calls, limits, hints, code cache).
- `dexstats/REPORT.md`: DEX corpus statistics; its tables are `dexstats/out/tables.md`.

The cold slow-operations review, runtime inventory and native-survey reports were removed. They remain in Git
history, and their conclusions are in `docs/implementation-history.md`.

The compiler, linker and host are in `src/wasm/{compiler,link,host}`. Their suites run through `pnpm wasm <suite>`
(see `scripts/wasm/run.ts`), and the Java fixtures are in `tests/fixtures/wasm/java/`.
