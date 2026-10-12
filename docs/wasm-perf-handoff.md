# Wasm-tier performance: handoff (2026-10-12)

Worktree `/Users/kunalan/Projects/webdroid-wasm-dev`, branch `knlnks/wasm-perf`, clean at `54735f23`. The branch is
about 2,050 commits ahead of `main`, because it carries the whole `knlnks/bytecode-wasm` backend. Nothing is
pushed or open as a PR.

**Goal.** Make the Wasm tier fast enough to become the only tier, with in-app latency and FPS first: launch to
first frame, gated taps under 150 ms, and scroll present intervals. Then delete the JS tier.

**Read first.**
- [AGENTS.md](../AGENTS.md): the working and verification rules.
- [wasm-baselines.md](wasm-baselines.md): the numbers to beat.
- The newest sections of [implementation-history.md](implementation-history.md), from "Wasm rearchitecture:
  suspensions, launch profiles and background Workers (2026-10-10)" to the end. They record each measurement and
  each rejected experiment, so check them before you retry an idea.
- [wasm-backend-plan.md](wasm-backend-plan.md) is the older design log, about 2,000 lines. Use it for reference
  only. M7 collapses it.

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
| M7 | Wasm default, delete the JS tier, cleanup | not started |

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

"Now" runs are `--gpu`, Worker processes, one job, Apple M4 Pro. The baseline was SwiftShader with iframe processes,
except its scroll row, which is `--gpu` at `f18fc7dc`. Re-measure both sides before claiming a delta.

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
- **Komikku's later launch.** About 280 ms goes to `loadC`, which instantiates C modules with about 172 global imports
  each. Most of the rest is `addDexes` and `linkSlot`.

## Gate state

The quick gate is `WEBDROID_TIER=wasm WEBDROID_URL=… bun run e2e --jobs 1`. The last runs this session reached 5 of 7
flows' checkpoints. The failures are not caused by the branch:
- **`mihon-onboarding` and `mihon-app`** fail on every commit, `main` included. Mihon v0.20.4 sees v0.21.0 on
  GitHub and covers each screen with an update dialog.
- **`calculatorm`'s `04 7b` step** times out intermittently, also on the base commit: 2 of 4 runs.

The live matrix (`--live`) was run before the loader fix:

| Tier | Flows passing | Failures |
|---|---|---|
| Wasm | 11 of 14 | Resy (fixed since), Lichess (launch visual diff, flaky), TikTok (launch timeout) |
| JS | 10 of 14 | TikTok, Reddit, both Mihon flows |

## Open work, in priority order

### 1. The Calculator intermittent hang
This is a hypothesis with a patch, not yet verified.

**What the hang looks like:**
- The app has `vsyncScheduled` set and an empty main queue.
- It renders `RuntimeShader` patterns continuously; this is the Android 12+ ripple, drawn in the Worker through
  WebGL and then `drawImage` into a 2D pattern.
- `present2` stalls.

**Suspected cause.** The probe's quiescent settle advances the controlled guest clock once, by horizon plus window.
A ripple that starts after that, on a slow tap, stays at its first frame and asks for frames forever.

**The patch.** Advance the clock in 16 ms frames while vsync is busy, up to 2 s past the settle start. The diff below
is against `tests/e2e/lib/probe.ts`. `installProbe` is serialized with `toString()`, so it cannot reference module
constants.

```diff
@@ -350,6 +350,8 @@ function installProbe(cfg: ProbeConfig): void {
     const windowMs = (q.stableFrames + 1) * q.intervalMs;
     if (controlled) await g.wd.guestClock.advanceBy(horizonMs + windowMs);
+    // a ripple or transition runs well inside two seconds; a spinner stops at the bound
+    const animationEnd = controlled ? g.wd.guestClock.now() + 2000 : 0;
     const horizonAt = t0 + (controlled ? 0 : horizonMs);
@@ -375,6 +377,12 @@ function installProbe(cfg: ProbeConfig): void {
       const b = await busy(dueBefore, q.stableMs);
       if (!b.length) return done("idle", seen);
       for (const k of b) seen[k] = (seen[k] ?? 0) + 1;
+      // an animation the app started after the clock ran through the window (a slow tap's ripple) would
+      // stay at its first frame and ask for frames forever: time passes while frames are asked for
+      if (controlled && b.includes("vsync") && g.wd.guestClock.now() < animationEnd) {
+        await g.wd.guestClock.advanceTo(Math.min(animationEnd, g.wd.guestClock.now() + 16));
+        await g.wd.testFrame();
+      }
```

**To verify:**
1. Run `bun run e2e calculatorm --jobs 1` at least 6 times with the patch and 6 times without it.
2. If it holds, run the full quick gate.
3. Check that no golden changes and that the other flows' step times do not grow.

If it does not hold, find the redraw source in the app's process: what keeps invalidating, and whether the ripple's
animator sees time advance. The desktop app also has a background-task chip for this, "Fix intermittent endless
redraw in Calculator e2e".

### 2. Make the gate reproducible again
Keep Mihon's e2e flows offline from the live update check. There is a chip for this too: "Keep Mihon e2e flows
offline from update checks". The fix belongs in the harness or in network fixtures. It must not touch app bytecode
and must not be app-specific in the runtime. Without it, every gate run has two known failures, which hide
regressions.

### 3. Wasm parity on the live matrix, which M7 needs
- **Lichess.** Its launch visual diff is 78–91% against a 76% limit, and it is flaky. Find out what differs in the
  launch frame. Do not raise the limit.
- **TikTok.** Its launch times out on the Wasm tier.
  - It no longer crashes the renderer; the crash was a second process's refine (history, 2026-10-12).
  - The 4 GB shared cage still runs at 3.7–4.2 GB after 100 s.
  - Native code takes 27.6 s and on-demand compiling 26 s of the main process's busy time.
  - Lowering memory is the structural fix. The largest item is the pool stubs: 358,000 of them, 72% for slots never
    looked up. The proposed design passes the slot at the call site, so one stub per signature serves every
    unlinked method.
- **Then the full matrix on both tiers:** `--live`, then `--full --jobs 1`, `corpus` and `textcmp`, run serially.

### 4. First-launch compile cost (Komikku, Feeder, TikTok)
The remaining levers:
- **Compiler front-end allocation.** About 200 MB/s while compiling; `Flow` construction is the largest share, at 12%.
- **Instantiation.** C modules carry about 172 global imports each. Move cross-module class access to id-indexed
  arrays, as M5 proposed.
- **Relocatable numbering.** This is the prerequisite for any parallel or ahead-of-time compile. Classes, slots,
  selectors, gaps and links are all numbered by the page's World today.

Measure each lever on Komikku's first launch, 3 matched runs or more. The history says what has already been tried.

### 5. M7: make Wasm the default and delete the JS tier
This waits on item 3.
- JS is still the default in `src/jvm/tier.ts` (`parseTier`). The e2e and smoke tools pick Wasm through
  `WEBDROID_TIER=wasm`; `lat` already defaults to Wasm.
- **The Wasm tier still imports JS-tier modules.** The main ones are `src/jvm/runtime.ts` (6 imports),
  `compiler-observer`, `tier`, `yield` and `suspend`. The bridge also uses natives registered through
  `runtime.ts`.
  - Untangle these first: move what Wasm needs into shared modules, then delete the compile half.
  - `src/jvm/abi`, `dex`, `prepared`, `natives/*` and `provenance` are shared front-end code and stay.
- **Deletion candidates:**
  - `src/jvm/{compiler,codecache,tiering,cold,discard,link,profile,aot,compileworker,stacklines,frames,coverage}.ts`;
  - the tier branches;
  - `scripts/link-table.ts`, `scripts/jsrc.ts`;
  - tier-comparison tests;
  - unreferenced research probes in `scripts/wasm/`.
  - Confirm each one with a search for references before deleting it.
- **Replace the JS-tier oracle** (`scripts/wasm/oracle.ts`) with JDK-run or recorded expectations.
- **Update the docs:**
  - collapse `wasm-backend-plan.md` into a short architecture note;
  - update `PLAN.md`;
  - update the AGENTS.md architecture section, which still describes iframes, the JS tier and `inMainJob`.

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
  run that reports "0 steps" just after an edit is the bundle rebuilding; run it again.
- **Before you finish:** stop every server you started, and remove temporary scenarios, worktrees and debug hooks.

## Commands

```bash
WEBDROID_AOT_STALE=1 PORT=4191 bun run server.ts
WEBDROID_TIER=wasm WEBDROID_URL=http://localhost:4191 bun run e2e --jobs 1
WEBDROID_TIER=wasm WEBDROID_URL=http://localhost:4191 bun run e2e calculatorm --jobs 1
WEBDROID_TIER=wasm WEBDROID_URL=http://localhost:4191 bun run e2e --live --jobs 1
WEBDROID_URL=http://localhost:4191 bun run lat fitnotes calculatorm --gpu --warm
WEBDROID_URL=http://localhost:4191 bun run lat fitnotes --gpu --cpuprofile
PATH=/opt/homebrew/opt/openjdk@21/bin:$PATH bun run wasm loaders
WEBDROID_TIER=wasm bun run smoke apks/FitNotes.apk
bun run typecheck
bun run test
```

- e2e writes `tests/e2e/actual-fast/<flow>/run.json`. Check each step's `newMissing`, `newErrors`,
  `nativeRequired`, settle reason and timings.
- `lat` scenarios live in `scripts/lat/scenarios/` (calculatorm, fitnotes, mihon). For another app, add a temporary
  scenario there and delete it afterwards. `--timeline` shows the app Worker's startup marks, and `--trace` writes a
  browser-wide trace.
- The `wasm` suites relevant to recent work are `loaders`, `persist`, `lazytest`, `linkdiff` and `hostclass`.
- `bun run test` passes 1,212 tests at `54735f23`.

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
