# Wasm-tier performance: handoff (2026-10-13)

Worktree `/Users/kunalan/Projects/webdroid-wasm-dev`, branch `knlnks/wasm-perf`. M7's series ends at `c6b28ec3`, and
the tap-latency series after it at `de7ba895`.
The branch is about 2,070 commits ahead of `main`, because it carries the whole `knlnks/bytecode-wasm` backend.
Nothing is pushed or open as a PR.

**Goal.** Make the Wasm tier fast, with in-app latency and FPS first: launch to first frame, gated taps under
150 ms, and scroll present intervals. Since M7 (2026-10-13) Wasm is the only tier; there is no JS tier to compare
against or fall back to.

**Last session (after M7).** Its subject was tap latency; see the history, "Where a tap's time goes". What it
did:
- removed the cold interpreter;
- fixed warm launches that hung at "Starting app…";
- made `Math`'s transcendental functions direct host imports;
- added a Komikku `lat` scenario;
- added compiling ahead in idle time.

What it found:
- **Warm taps** are bound by the app's screen transitions and the harness's state probes, not by guest compute.
- **Cold taps** are mostly on-demand compiling, one module per method. Chrome charges about four times what Node
  does for each module, so the lever is fewer modules.

**M7** deleted the JS tier (history, "The JS tier removed"). From `66978ee6` until `06f9ceb4` the dev server
answered 500 for the platform build. Numbers measured in that window are not comparable.

**Read first.**
- [AGENTS.md](../AGENTS.md): the working and verification rules.
- [wasm-baselines.md](wasm-baselines.md): the numbers to beat.
- The newest sections of [implementation-history.md](implementation-history.md), from "Wasm rearchitecture:
  suspensions, launch profiles and background Workers (2026-10-10)" to the end. They record each measurement and
  each rejected experiment, so check them before you retry an idea.
- [wasm-architecture.md](wasm-architecture.md): the map of the tier. The older design logs are in Git history.

## Milestones

The milestones come from the rearchitecture plan. Its main ideas:
- the UI thread does only input, presentation and routing;
- code is delivered in a few large images instead of thousands of tiny modules;
- no suspension happens without a real wait;
- Wasm becomes the only tier.

| | Milestone | State |
|---|---|---|
| M0 | Clean measurement: `lat` defaults to Wasm, probes state once per frame, gates counters behind `perfProbe`, adds a scroll-FPS step and `--gpu` | done |
| M1a | Fuel yields that do not suspend unless a turn is due | done |
| M3 | Background processes are not started during interaction | done, then superseded by M2a |
| M1b | Host↔Java crossings | partly done; see below |
| M2a | Every app process in its own Worker; the page realm is `system_server` only | done |
| M4 | Whole-app AOT at install time | partly done; see below |
| M5 | Pre-linked images with direct calls and relocations | not started; value is in doubt |
| M6 | Symbolic sites without per-site modules | dropped |
| M2b | `system_server` and the broker stores off the page | not started |
| M7 | Wasm default, delete the JS tier, cleanup | done |

**M1b.**
- Done:
  - caller stacks are captured only when a call actually suspends;
  - suspending natives return a Promise only when they wait.
- Not done:
  - `hostFn` and `callFn` still build a module per owner class or per signature;
  - `ColdSlowOps.compileSite` remains.
- These cost 15–30 ms of a launch, so the remaining work is low value.

**M4.** What exists:
- App builds are made in a Worker after the first launch and persisted.
- Bundled builds cover the gate apps (`vendor/wasm-aot/*/apps.json`).
- A zygote and a spare process warm the platform code before the package arrives.
- Classes linked on demand get globals-only modules, built in batches.
- First-tier units are merged into large modules, and share their helpers.
- Refines wait until new demand reaches `REFINE_SHARE` (an eighth) of what the build covers.

What does not exist:
- the parallel, whole-app, install-time compile;
- removal of the refine machinery.

The history shows why: a one-Worker build makes a first launch slower than compiling on demand. Feeder takes about
5 s that way against 3.2 s. Each extra Worker also holds the app's Program, which TikTok's size rules out.

**M5.** Direct calls in precompiled code measured neutral (history, 2026-10-11, "Direct calls in precompiled code").
The remaining case for M5 is relocation: without relocated code, nothing can be compiled ahead of the page's
numbering. An ahead-of-call Worker compile was built and rejected for that reason (history, "First launches compiled
on demand"). For FitNotes' warm launch, M5 is estimated to save only 100–200 ms. The app thread is busy about
1.3 s there: JS 0.7 s, Java 0.38 s.

**M6.** Calculator and FitNotes resolve no symbolic sites in any process, and Mihon's app resolves 18. That is too
few to justify the rewrite (history, "What an on-demand launch still compiles").

## Current numbers

"Now" runs are `--gpu`, Worker processes, one job, Apple M4 Pro, taken before M7 with the platform build served. The
baseline was SwiftShader with iframe processes, except its scroll row, which is `--gpu` at `f18fc7dc`. M7 rebuilt
the platform build (`875b5beb730c3154`) and its bundled app builds, so re-measure both sides before claiming a
delta. The JS columns are historical.

| | 2026-10-10 baseline | Now |
|---|---|---|
| FitNotes launch, cold / warm | 3,366 / 2,427 ms | 1,365–1,486 / 1,449 ms (JS warm: 1,561) |
| Calculator launch, warm | 2,521 ms | 1,517 ms |
| Calculator gated taps | 60–390 ms | 24–92 ms |
| FitNotes gated taps | 23–111 ms | 12–110 ms |
| FitNotes scroll p50 / p95 / p99 | 16.6 / 18.2 / 29.3 | 16.6 / 18–26 / 19–33; bimodal from run to run, so compare several runs |
| Komikku first launch (no saved build) | about 8.7 s | 8.1–8.2 s |
| Komikku later launch | | 2.5–2.6 s |
| Resy e2e flow | 61–66 s, wedged | 32.1–32.6 s (JS: 27 s) |

- **Mihon.** Its launch is not measurable with `lat` while its live update check opens a "New version available"
  dialog over onboarding.
- **Komikku's first launch.** It compiles about 15,600 methods in 3.2 s (emit 1.5 s), at about 115 µs per method in
  Node and 200 µs in the browser. It creates about 17,900 modules. The cost is spread thin, with no single hotspot
  left.
- **Taps** (`lat calculatorm komikku --gpu`, medians at `de7ba895`):
  - Warm: Calculator 20–70 ms, Komikku 160–230 ms.
  - Cold (no saved build): Calculator `7` 127 ms, the other Calculator taps 43–101 ms, and Komikku 190–290 ms.
  - Komikku's warm taps last as long as Compose's screen transition. The probe adds 5–10 ms after every frame.
- **Komikku's later launch.** About 280 ms goes to `loadC`, which instantiates C modules with about 172 global imports
  each. Most of the rest is `addDexes` and `linkSlot`.

## Gate state

At `de7ba895`:
- **Quick gate** (`e2e --jobs 1`): 7 of 7 flows, with no new missing APIs, errors, required natives, draw errors,
  settle timeouts or wedges.
- **Unit tests:** 1,147 pass. The browser tests' "End Of Central Directory" flake recurred once.
- **`smoke`** (FitNotes): clean.
- **`wasm all`:** all 17 suites pass. **`fwtest`:** 31 of 31.
- **Not run since M7:** `--live`, `--full --jobs 1`, `corpus` and `textcmp`. Before M7 the serial `--live` matrix
  reached 13 of 14 flows; TikTok misses its launch budget (history, "Live matrix parity").

## Open work, in priority order

### 1. Cold taps: fewer, cheaper modules
A tap without a saved build compiles the methods it first calls. Compiling ahead covers 16–45% of those links.
The rest is compiling, one module per method (history, "A cold tap is mostly compiling"). The levers:
- **The compiler.** It takes 52% of `linkSlot`.
- **Module count.** A Chrome Worker charges about 18.5 µs per module against Node's 4.2 µs, and no V8 flag changes
  that. The main process makes about 6,400 modules:
  - 3,953 from `linkSlot`;
  - 911 from `buildClasses`;
  - 603 from `linkEnsure`;
  - 318 stub pools.

  `linkEnsure` and the stub pools are the candidates to fold into fewer modules.
- **Better prediction.** Adding single-target callees to a link's batch hits 64% of the time, below the 70% where
  it breaks even. A prediction that hits more often than that pays inside the tap itself, not only when the app is
  idle.

The harness's state probe also costs about 31 ms per Komikku tap. Probing less often would lower what `lat`
reports, but not what a user sees.

### 2. The full matrix after M7
Run `--live`, then `--full --jobs 1`, `corpus` and `textcmp`, serially, with a platform build that matches the
sources. Compare any failure with `33373567` (the last commit before M7) under the same settings. That commit
cannot key a platform build either. Check it out in its own worktree with its own `vendor/wasm-aot` (not the
symlink), cherry-pick `06f9ceb4`, and run `bun run aot` there. Lichess's launch diff was the same on both tiers:
the reference shows a notification-permission request and live content that neither tier shows. Do not raise the
limit.

### 3. TikTok's launch
It times out on the Wasm tier.
- It no longer crashes the renderer; the crash was a second process's refine (history, 2026-10-12).
- The 4 GB shared cage still runs at 3.7–4.2 GB after 100 s.
- Native code takes 27.6 s and on-demand compiling 26 s of the main process's busy time.
- Lowering memory is the structural fix. The largest item is the pool stubs: 358,000 of them, 72% for slots never
  looked up. The proposed design passes the slot at the call site, so one stub per signature serves every
  unlinked method.

### 4. First-launch compile cost (Komikku, Feeder, TikTok)
The remaining levers:
- **Compiler front-end allocation.** About 200 MB/s while compiling; `Flow` construction is the largest share, at 12%.
- **Instantiation.** C modules carry about 172 global imports each. Move cross-module class access to id-indexed
  arrays, as M5 proposed.
- **Relocatable numbering.** This is the prerequisite for any parallel or ahead-of-time compile. Classes, slots,
  selectors, gaps and links are all numbered by the page's World today.

Measure each lever on Komikku's first launch, 3 matched runs or more. The history says what has already been tried.
Without a platform build FitNotes' quick flow takes 144 s against 46 s and times out on four steps, so the on-demand
path is itself a cost worth profiling.

### 5. Post-M7 cleanup candidates
Confirm each with a search for references before deleting:
- `src/jvm/runtime.ts` is still shaped around the JS tier in places (`rt.make` gives a carrier of fields that cannot
  take a virtual call). Narrow it to what natives and the Wasm host use.
- `docs/bytecode-first-plan.md` and `docs/performance-plan.md` describe the JS tier's design and measurements.
- `research/wasm/` measured JS against Wasm; only `scripts/wasm/watdump.ts` uses it (for `wasm-dis`).
- Browser tests once failed 9 at a time with "End Of Central Directory signature not found" while reading a jar. This
  happened once in 13 full runs at the end of M7. The history records earlier occurrences, still unexplained.

### 6. Lower value; do these only with a new measurement that justifies them
- **M2b:** `system_server` and the broker stores in a system Worker.
  - The e2e probe showed why it matters: the broker answers app IPC on the page thread, and slow page work (the probe's
    readbacks) starved Komikku's chapter-list queries.
  - Measure page-thread time during app IPC before you start.
- **M5:** pre-linked images, for the reasons above.
- **The rest of M1b:** per-signature trampolines in place of the per-name `callFn` and `hostFn` modules.

## Rules
- **Performance claims** need matched before/after runs on the same inputs:
  - serial, `--jobs 1`, nothing else running;
  - at least 3 runs per side;
  - use `--gpu` for scroll.
  - Compare against the starting commit before you call a failure a regression; Calculator and Lichess are flaky on
    unchanged code.
- **Behaviour:** nothing app-specific, bytecode unchanged, goldens unchanged.
- **Code:** DRY and YAGNI. Delete the machinery a change replaces, in the same series. Comments only where the reason is
  not obvious. Add tests only for core semantics a change introduces.
- **Commits:** focused `area: sentence` subjects, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Record every finding, including rejected experiments, in
  [implementation-history.md](implementation-history.md).
- **The dev server serves source fresh**, so do not edit served code while an e2e or `lat` run is in progress. An e2e
  run that reports "0 steps" just after an edit is the bundle rebuilding; run it again. Server-side code
  (`server.ts`, `scripts/wasm/aot-*.ts`) loads once, so restart the server after editing it.
- **The platform build is keyed by every file under `src/`** and the AOT scripts. After a source edit the server
  answers 404 for it unless `WEBDROID_AOT_STALE=1`. That flag is right for edits outside the compiler and linker;
  after one inside them, run `bun run aot`. Check `browserErrors` in `run.json` for a failed `/aot/current.json`,
  and `wasmAotLoaded` above 0 in the step counters. A temporary counter added under `src/` has the same effect: it
  turns a `--warm` run into an on-demand one, which fails with "app code is not saved". Rebuild the platform build
  before you measure.
- **`vendor/wasm-aot` is shared.** It is ignored by Git, and a worktree usually symlinks it to this checkout's.
  `bun run aot` prunes the builds it replaces, including the bundled app builds. Regenerate those with
  `bun run wasm aot-profile` against a running server.
- **Before you finish:** stop every server you started, and remove temporary scenarios, worktrees and debug hooks.

## Commands

```bash
WEBDROID_AOT_STALE=1 PORT=4191 bun run server.ts
WEBDROID_URL=http://localhost:4191 bun run e2e --jobs 1
WEBDROID_URL=http://localhost:4191 bun run e2e calculatorm --jobs 1
WEBDROID_URL=http://localhost:4191 bun run e2e --live --jobs 1
WEBDROID_URL=http://localhost:4191 bun run lat fitnotes calculatorm --gpu --warm
WEBDROID_URL=http://localhost:4191 bun run lat fitnotes --gpu --cpuprofile
bun run aot
WEBDROID_URL=http://localhost:4191 bun run wasm aot-profile
PATH=/opt/homebrew/opt/openjdk/bin:$PATH bun run wasm all
PATH=/opt/homebrew/opt/openjdk/bin:$PATH bun run wasm loaders
bun run smoke apks/FitNotes.apk
bun run fwtest
bun run typecheck
bun run test
```

- e2e writes `tests/e2e/actual-fast/<flow>/run.json`. Check each step's `newMissing`, `newErrors`,
  `nativeRequired`, settle reason and timings.
- `lat` scenarios live in `scripts/lat/scenarios/` (calculatorm, fitnotes, komikku, mihon). Mihon's live update
  dialog covers its onboarding, so use Komikku for a Compose app. Without `--warm`, `lat` measures a launch with no
  saved build. `WEBDROID_JS_FLAGS` passes V8 flags to the browser. For another app, add a temporary
  scenario there and delete it afterwards. `--timeline` shows the app Worker's startup marks, and `--trace` writes a
  browser-wide trace.
- The `wasm` suites relevant to recent work are `loaders`, `persist`, `lazytest`, `linkdiff` and `hostclass`.
- `wasm` suites that compile Java test sources need `javac`, which is not on the default PATH; Homebrew's
  `openjdk` (26) works.
- `bun run test` passes 1,147 tests after M7 (the JS tier's mechanism tests went with it).

## Profiling Workers during an e2e flow

`lat --cpuprofile` profiles every Worker in a `lat` scenario. e2e has no such switch, so profile it through Chrome's
remote debugging port:

1. Temporarily add `...(process.env.ZZ_CDP ? ["--remote-debugging-port=" + process.env.ZZ_CDP] : [])` to the launch
   `args` in `tests/e2e/drivers/webdroid.ts`. Revert it afterwards.
2. From a script, attach to the browser over CDP:
   - Read `webSocketDebuggerUrl` from `http://127.0.0.1:<port>/json/version`.
   - On the page target, send `Target.setAutoAttach` with
     `{ autoAttach: true, waitForDebuggerOnStart: true, flatten: true }`.
   - On each `Target.attachedToTarget` event:
     - for a `worker` target, send `Profiler.enable`, then `Profiler.setSamplingInterval` with `{ interval: 500 }`,
       then `Profiler.start`;
     - for any other target, set auto-attach again;
     - then send `Runtime.runIfWaitingForDebugger`.
3. When the step of interest ends, send `Profiler.stop` to each process Worker; their URLs contain `process-worker`
   and `pid=<n>`. Write each profile to `w<pid>.cpuprofile` and open it in DevTools.

This method found both the probe's readback starvation and Resy's per-class loader re-resolution.
