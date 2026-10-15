# Handoff: performance re-architecture (branch `knlnks/bytecode-wasm`, 2026-10-13)

The task is to rethink webdroid from first principles for in-app latency and frame pacing:
- every interaction ≤ 150 ms, measured from `pointerup` to the first answering frame;
- display-rate frames.

The approved plan is appended below, unchanged. Read [AGENTS.md](../AGENTS.md) and [PLAN.md](../PLAN.md) first. Findings and rejected experiments go in [implementation-history.md](implementation-history.md); numbers go in [performance.md](performance.md).

## Ground rules carried over from the user

- **Commits.** Don't commit unless asked. Subjects follow `area: sentence` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Leave the user's uncommitted docs reorganization alone.** That covers deleted docs, `AGENTS.md`, `PLAN.md` restructuring, the new `docs/architecture.md` and `docs/performance.md`, and README rewrites. Don't revert anything in it.
- **Other sessions' edits.** `tests/android-graphics.test.ts`, the EGL natives in `src/android/glsurface.ts` and `src/wasm/host/persist.ts` were also changed from outside this work: the user's separate "Implement the remaining EGL14 natives" task and the user. Treat them as current.
- **Measurement.**
  - Gate on the M4 Pro with `--gpu`. `--ecores` (macOS) is the slower-device pass; CDP throttling reaches only the page (see the history).
  - Gate apps: Calculator M, FitNotes, Komikku, plus the Komikku `scroll-appearance` list.
  - YouTube, Reddit, TikTok and ChatGPT are `"gate": false` reports.
  - Use 3+ matched runs per side, alternating.
  - Never edit served code (`src/`) while a `lat` or e2e run is in progress.
- **AOT freshness.** Run `bun run aot` after compiler edits. `WEBDROID_AOT_STALE=1` is fine for runtime-only edits.
- **Platform scope.** Chrome-only features must keep a working WebKit path. Compilation stays client-side.

## State of the working tree

The work below is committed on top of `ef6d85ca` (`git log ef6d85ca..`):
- `timeline:` the event ring;
- `wasm:` the persisted zygote prefix, kept app builds under a library rebind, and paced unit release;
- `vsync:` host-period pacing;
- `lat:` the first-response gate, the FitNotes Legs scroll, and the legacy tap clock removed;
- `input:` `?input=batched`;
- `wasm code:` dead `returnCallRef` removed;
- `lat:` `--ecores` runs Chrome on the efficiency cores for a slower-device pass;
- `wasm compiler:` CHA is asked only about targets the module holds;
- `native:` statfs/statvfs answer the storage estimate in bionic's layouts, and C longs are stored as values, not translated pointers.
- `wasm compile client:` planning and unit adoption wait out the input window;
- `wasm aot-profile`, `lat profsum`, `lat`: retries over a changing OPFS file, Worker profiles windowed by the page's tap marks, and user-timing marks per gated tap.

Still uncommitted: the other sessions' edits listed in the ground rules.

Plan 3.2 (final targets as direct calls) was tried and rejected; see "Rejected: final targets called through their slot" in the history.

### Harness and measurement (plan Stage 0)

- **`lat` v2 first-response metric** (`scripts/lat/run.ts`, `observe.ts`, `expect.ts`, `src/shell/frame-port.ts`).
  - `--ecores`, `--timeline`, `--json`, `--trace`, `--cpuprofile` and `--demand`.
  - `"gate": false` report scenarios: `scripts/lat/scenarios/{youtube,reddit,chatgpt,tiktok}.json`.
- **Environment knobs:**
  - `WEBDROID_TRACE_CATEGORIES` (comma-separated) replaces the trace categories. `disabled-by-default-v8.gc,v8` gives a ~60 MB GC-only trace instead of 450 MB.
  - `WEBDROID_JS_FLAGS` and `WEBDROID_CHROME_ARGS` are for A/B runs.
  - These are documented in the `run.ts` header.
- **Data in `--timeline --json` taps:**
  - the Worker ring (`timeline.raw`);
  - the page's own ring and long tasks (`page.raw`, `page.longTasks`; `wd.pageTimeline` in `src/main.ts`).
- **Timeline events** (`src/timeline.ts`; the ring is always on and costs about one `performance.now()` per mark):
  - **Frame and input path:** Raf, InputIn/Publish/Dispatch/Done, FrameBegin/End, DrawBegin/End, Queue, CompositeBegin/End, Present, LoopIdle/Wake, Turn.
  - **Threads and compilation:** Thread (strand switches, `src/wasm/host/entry.ts`), Prepare/Prepared (AOT module waits, `aot.ts` via the `WorldOptions.note` hook from `boot.ts`), Upgrade/Upgraded (compile-worker messages).
  - **IPC and visibility:** Call/Answer (Worker→page calls, `process-port.ts` `callProxy`), Serve/Served (calls a realm serves, `serveCalls`), Visible (process visibility, `process-endpoint.ts`).
- **Counters:**
  - `wasmRetired` / `wasmCollected` (see below), in `src/perf.ts`, `src/wasm/host/stats.ts` and the `lat` COUNTERS.
- **Switches.** `src/switches.ts` holds the `?flag=` switches that Workers inherit. Two exist:
  - `?bundles=0`: `lat` sets it for cold runs.
  - `?input=batched`: plan 6.1, implemented in `inputchannel.ts`/`wm.ts`. Measured: no clear win, default stays `immediate` (see the history).

### Runtime and code delivery

- **Persisted zygote prefix** (`boot.ts`, `persist.ts` `prefix`/`savePrefix`, `World.adopt`).
  - Fixes saved app builds being rejected because zygote numbering depends on timing.
  - Warm TikTok now attaches its build (launch 12.3 → 8.2 s).
  - `AotRuntime.appRejected` and `numberingDiff` explain any rejection.
- **Paced release of merged-away units** (`World.retire` in `src/wasm/link/world.ts`, `RETIRE_BATCH = 32`, `RETIRE_WAIT_MS = 5000`). This is the latest fix:
  - **Cause.** Merges (`mergeJob`/`adoptMerged`) leave thousands of first-tier unit modules unreferenced. V8 then frees their native modules in one `V8.GC_HEAP_EXTERNAL_SECOND_PASS_CALLBACKS` task of 90–170 ms on the Worker thread. That task caused every intermittent cold-Komikku tap failure.
  - **Fix.** The replaced units are now held and dropped 32 at a time. The next batch is dropped once a `FinalizationRegistry` reports the previous one collected, or after 5 s.
  - **Effect.**
    - The largest second-pass task is now 3–8 ms.
    - Over 10 cold runs, the longest silent stretch in any tap is ≤ 24 ms, against 79–169 ms before.
    - Retained units drain over minutes, so memory falls later than before.
- **Vsync and input.**
  - Host-period estimation in `vsync.ts`.
  - Batched-input plumbing (switch-gated).
  - Timeline marks in `hwui.ts`, `surfaceflinger.ts`, `mainloop.ts` and `inputchannel.ts`.

### Docs updated in this work

- `PLAN.md`: the latency bullet.
- `docs/performance.md`: the first-response table dated 2026-10-13.
- `docs/implementation-history.md` entries:
  - "Zygote numbering depends on timing";
  - "Crashed pages and dead app processes";
  - "Freeing merged-away units stalls the thread";
  - "Stalls the timeline cannot see".

## Cleanup audit (2026-10-14)

A maintainability pass followed the performance work: `git log 7ef4de0b5^..bdff18475` has 52 focused commits, net −740 lines over 110 files. Audits of shell/jvm, the Wasm link/host layers, the native libraries, native core and tests, and `src/android` drove it.

- **Removed.** JS-tier remnants (String's methods on `String.prototype`, `jmethod`/`lateMethod`, `jsStack` reads, stale comments), compiler receipts, the unreached SharedFile mapping path, the IME local-keyboard branch, and members with no reader (`compositorStatus`, PackedArchive `owner`, `vfs.owner`, `ActivityStack.shown`, cipher `blockSize`/`overhead`, res `T_STR`).
- **Consolidated.**
  - Native: `kernelResult` (libc), `guestSort` (qsort, scandir, fts_open), `setClockTimer` (timerfd and POSIX timers), `AddrMap.ensure`, `ldWord`/`stWord`, `Cpu.regHex`, socket `watch`, `uniformBase`, `directiveEnd`.
  - Shell and jvm: `orDer` (conscrypt), `within`/`shared` (processes.ts), and crash tests in appexitinfo.
  - Native tests: about 300 lines of repeated scaffolding.
- **Hot paths.** No BigInt per digit in `strtoNum`, per ARM32 double, or per `lrand48` step. `strlen` uses `indexOf`. Field accessors are cached by field. Matrix and pixel buffers are reused. JNI string copies take one store.
- **Fixes found on the way.**
  - `wcsstr` matched across code-point boundaries.
  - `mrand48`/`drand48` were wrong.
  - `strtoul` clamped negative input instead of wrapping.
  - A64 `strtol`/`strtoul`/`atol` were 32-bit.
  - `ctime_r` printed JavaScript's date layout.
  - `asctime`/`basename`/`dirname` leaked a host string per call.
  - `scandir`/`fts_open` made O(n²) comparator calls.
  - `getResponseCode` skipped a Java subclass's status line.
- **Considered and left.**
  - Process-fd `viaRemote` would allocate two closures per local read/write.
  - Relay `ByteQueue` → socket `Loopback` would couple the shell to native socket internals.
  - Moving `discardDescriptors` into FileDescriptors gains nothing.
- **Flake.** `tests/app.browser.test.ts` fails with `ZipException: End Of Central Directory signature not found` in about 1 full `bun run test` in 6, and passes on rerun. An instrumented failure showed the platform jars arriving at full length with misplaced content. This is the Bun HTTP body corruption already recorded under "Fixture bundle corruption" in the history.
- **Verified at `bdff18475`.**
  - `typecheck`, and `bun run test` 1148/1148 apart from the flake.
  - `fwtest` 31/31, and `smoke apks/FitNotes.apk` with no unexplained failures.
  - After `bun run aot`, `bun run e2e --jobs 1` passed 7/7 in 170 s with empty telemetry.
  - `wasm all` last ran clean before the native commits; none of them touches the shared front end.

A second pass (`git log 2510a6a77..`) cut TypeScript by 121 lines net (+113/−234), and removed the broken `scripts/libc-bench`. jscpd 4.0.5 (`--min-lines 4 --min-tokens 50` over src, scripts and tests) went from 42 clones and 227 duplicated lines to 35 and 184.

- **Removed.** `waitsFor`/`Strand.waitsOn` (no reader), `answeringInput` (the input window is `answeringFor` alone), the unused test `axmlBytes` and harness `unbits`.
- **Consolidated.** One CREATOR helper in binder, one surrogate pair in jstring, one `BOX` table in `compiler/fields.ts`, and one AEAD core in conscrypt. try_table catch clauses are encoded once. The native tests share `calls.testkit.ts`, and the device probes record through `runDex`.
- **Left.** The fdlibm `log`/`log10` and `cha.ts` walk clones; the first mirrors the C reference, and the second would need a visit protocol on a compile hot path.
- **Verified at `866f1ceca`.** `typecheck`; `bun run test` 1148/1148; `fwtest` 31/31; `smoke apks/FitNotes.apk` with no unexplained failures; and, after `bun run aot`, `e2e --jobs 1` 7/7 in 175 s. The rewritten vector and input probes reproduce their fixtures on the reference AVD, apart from per-boot input-device generation counters. The AVD kills `textcmp --record` both before and after the change.
  - The parallel quick gate (5 jobs) failed 5/7 at host load ~9. Every failure was a timeout, a wedged main loop, or a Worker stuck at "Reading package…", and each failed flow passed on a serial rerun. That fits the host-capacity failures noted below, but no matched parallel run of the starting commit was made.

## Verification status (end of 2026-10-13)

- **Passing at `975b232b`:**
  - `bun run typecheck`;
  - `bun run test`: 1148/1148. Runs that overlapped `bun run wasm all` failed with `ZipException` while it rebuilt the platform build; don't run the two together;
  - `bun run wasm all`, run without `WEBDROID_AOT`. With it set, `diff` and `lazytest` fail even on the starting commit;
  - `bun run smoke apks/FitNotes.apk`.
- **e2e:**
  - `bun run e2e --jobs 1`: 7/7 in 177 s.
  - Parallel `bun run e2e` (5 jobs) fails 1–2/7. The starting commit `ef6d85ca` fails the same way under matching load (host load ~43, memory compressed), so this is host capacity, not a regression.
- **`lat --gpu`, cold, trio:**
  - Calculator 21–128 ms;
  - FitNotes 8–72 ms;
  - Komikku `next` ~50, `start` 80–150, `more` 112–142, `settings` 94–117, `appearance` 125–167 ms.
  - Matched Komikku runs at `19cf4724` were within noise of these.
  - The Komikku scroll runs at 59.7–59.9 fps.
- **`lat --gpu --warm`, trio:**
  - Every saved build attached;
  - taps 8–112 ms;
  - FitNotes `scroll-legs` 59.5–59.9 fps.
- **Heavy apps cold** (no crash with paced unit release):
  - TikTok launch 12.0 s;
  - Reddit 11.9 s.
- **Single-run gate failures stay possible on cold Komikku** (`start`/`appearance` up to 167 ms): this is the cold floor below.

## How to run

```bash
PORT=4191 WEBDROID_AOT_STALE=1 bun run server.ts          # the dev server was stopped at handoff
WEBDROID_URL=http://localhost:4191 bun run lat komikku --gpu --timeline --json /tmp/k.json
WEBDROID_TRACE_CATEGORIES=disabled-by-default-v8.gc,v8 WEBDROID_URL=http://localhost:4191 bun run lat komikku --gpu --timeline --json /tmp/k.json --trace /tmp/k.trace.json
WEBDROID_URL=http://localhost:4191 bun run e2e --jobs 1
```

These analyses were done with scratch scripts that are not in the repo; each is a few lines over the `--json` output:
- **Longest silent stretch per tap.** For each tap, take `timeline.raw` (`[ms, event, arg]`) from `compileWindow.up` to `intended` and find the largest gap between events. A gap with no `Raf` and no 33 ms fallback means the Worker thread itself was held. Look for GC or compile tasks in a trace before suspecting the scheduler.
- **GC second pass per trace.** Load the trace JSON and name threads from the `thread_name` metadata. On `DedicatedWorker thread`, list `V8.GC_HEAP_EXTERNAL_SECOND_PASS_CALLBACKS` and `V8.GC_MARK_COMPACTOR` durations.
- **Aligning a tap with the trace.** Match the page's `EventDispatch` `pointerup` events with the taps' `compileWindow.up` spacing.

## Suggested next steps, in order

1. **Done: the gate holds.** Every gated tap's median of three matched runs is ≤ 150 ms, cold and warm (performance.md). **Lower the cold Komikku floor.** In a cold `more` tap, UP is handled in 2 ms, then one 85 ms `doFrame` recomposes, with 699 methods compiled on demand (62 ms of compiling). Levers, in the plan's order:
   - **2.1 deterministic app numbering: measured and rejected for mid-session adoption** (history, "Rejected: seeded app numbering").
   - **Profiled (2026-10-14):** main-thread Java is 80–115 ms of a cold tap, on-demand compiling 10–55 ms, V8 compiling merged modules' functions 9–57 ms. Compile Worker answers now wait out the input window (history, "Worker answers wait out input"); turning merges off moved adoptions into taps and did not help. Merging only dormant units measured neutral.
   - **5.1 flat statics: not a tap lever.** Class modules cost a cold tap 0.3–2.4 ms (history, "Flat statics are not a tap lever").
   - **3.1, 3.2 and 3.3 codegen: rejected or not pursued.** 3.1 was neutral, 3.2 bypassed host vtable repairs, and trivial bodies get 5–7% of calls.
   - What remains of a cold tap is the app's own first-tier Java (Compose recomposition) running on code the engine has just compiled.
2. **Done: ChatGPT and TikTok.** Neither crashed in 2026-10-14's warm runs (ChatGPT 2.4 s, TikTok 7.9 s). TikTok's "Manage your storage" came from `StatFs` failing on its own external cache directory, which another realm owns; `Os.statvfs` now asks that realm (history, "TikTok's \"Manage your storage\" was a failed StatFs").
3. **Done: a slower-device pass.** `lat --ecores` runs Chrome under `taskpolicy -c background` (about 6× slower in every thread); results are in the history ("A slower device on the efficiency cores").
4. **Done: docs committed** (the reorganization landed in `959469a3`).

Plan 1.6 (pointer pipelining) has nothing to recover: UP reaches the Worker 0–6 ms after the page event. Plan 1.3 (the vsync `fill()` undo) is unverified. Looper callbacks run inside `nativePollOnce`'s Bridge scope, so measure before changing it.

---

# Appendix: the approved plan

## webdroid performance re-architecture: ≤150 ms interactions, display-rate frames

## Context

The branch is `knlnks/bytecode-wasm`.
- Java runs only on the Wasm GC tier.
- Each app process is one Worker whose single JS thread runs every Java thread as a JSPI strand.
- The page runs system_server, the broker and sql.js.

You asked for a first-principles redesign that drastically improves in-app latency and frame pacing, and that questions the docs' conclusions. This plan comes from code exploration, profiles of earlier `lat` runs, and three design passes (code delivery, interaction pipeline, emitted code).

**Decisions taken with you**
- **Gate:** each tap is measured from pointerup to the first presented frame that visibly answers it, plus frame pacing during transitions and scrolls. Time to the settled semantic state is still reported, as a secondary number.
- **Scope:** cold launches (no saved app build) and warm launches both count.
- **Machine:**
  - The gate is measured on the M4 Pro with `--gpu`.
  - A 4× CPU-throttled run is reported alongside but does not gate.
- **Apps:**
  - The `lat` trio (Calculator M, FitNotes, Komikku) gates.
  - A Compose list fps scenario is added.
  - Heavy apps (YouTube, Reddit, TikTok, ChatGPT) are tracked as reports that do not gate.
- **Constraints:**
  - Big rewrites are fine if each sits behind an A/B switch.
  - The harness may change.
  - Chrome-only features are allowed only if WebKit keeps a slower path that works.
  - Compilation stays client-side.
  - No SharedArrayBuffer is assumed (the server sends no COOP/COEP headers).

The working tree has uncommitted documentation reorganization (AGENTS.md, PLAN.md, docs/*). Leave it alone and do not commit over it without asking.

## Evidence: assumptions re-examined

| Earlier claim | What the code and profiles show |
|---|---|
| Warm Komikku taps (160–230 ms) are bound by the app's transition and the probes | True for the settled state. But the first frame lands about 31 ms after input. Inside a 250 ms tap window the app thread also runs about 60 ms of `lat` probes (`wd.uiTree()` on the main looper after every frame) and about 42 ms of `upgradeJob`. Warm taps still compile 160–740 methods. |
| Cold taps are mostly compiling | Confirmed, and it happens inside input dispatch. Calculator's `7` tap compiles 342–371 methods and spends `inputMs` 74–82 ms. A Komikku cold launch compiles 13,631 methods (2.7 s) into 15,565 modules, all on the app thread. Code numbering depends on run order, which is the only thing keeping this compilation off Workers. |
| Code quality after tier-up decides little | Only V8 tiering flags were tested. After launch about 90% of Java ticks are in first-tier code (AOT `install` mode), and inside `doFrame` Java is 74% of CPU. That code calls a shared `count` helper and an `enter` helper on every entry, reaches cross-unit calls through `call_indirect` (no V8 inlining; install mode emits no direct calls at all), takes the vtable path even for final targets, treats every reference as `anyref` (one `ref.cast` per use), goes through two indirections per array access, calls JS on every typed catch, and makes about 3 indirect calls per Unsafe field operation. |
| The bridge is cheap | Correct: about 15k crossings, roughly 0.6 ms per Komikku tap. The costs are structural instead (next row). |
| Suspensions are legitimate | Several waits that are not app work cost latency. **Pointerup is held until pointerdown completes a full Java round trip** (`src/shell/pointer-input.ts:30-41`). Every host callback suspends the main looper (`mainloop.ts` `poll`). Every frame adds an extra frame-close entry plus a suspension (`vsync.ts` `postMain`). Composite waits until the main strand suspends (`surfaceflinger.ts:73-77`). |
| Background threads yield fairly | No. Fuel counts loop iterations per activation (`j2w.ts:346-348`, FUEL 4096): a loop with 1 ms bodies yields only every ~4 s, and call chains without loops never yield. The turn clock starts at the first check, not at the start of the macrotask (`src/jvm/yield.ts`). A non-main yield before 8 ms only reaches microtasks (`sched.ts:436`). This fits the p99 tails of 75–200 ms. |
| IPC is cheap | In Worker processes **every SQLite native** (bind, step, column, reset) is a postMessage round trip to the page (`sqlite.ts` `registerSQLite` → `process-endpoint.ts:88`). Settings reads are uncached round trips. Each local Binder transaction copies parcels twice and spawns a new JThread. |
| Frame production is not a lever | JS issue time is small, but replay is 7% of `doFrame` CPU. Raster is never measured, and each frame makes at least 4 full-screen passes. There is no damage tracking. Hardware layers are re-rasterized every frame. The ripple shader compiles for about 270 ms the first time in each realm. FitNotes scroll: 38.6 presentations/s, p95 25.9 ms, p99 33.5 ms, cause not yet attributed. |

**Physical limit.** Java threads cannot run in parallel: Wasm GC objects cannot be shared between Workers. Parallelism therefore comes from compile and shader Workers, and from keeping turns on the one thread short.

## Target architecture

1. Compilation never happens inside an interaction and rarely on the app thread. Numbering is deterministic, so app images and second-tier code compiled in Workers can be adopted at any time.
2. Emitted code is shaped for V8: hot code ships already in the second tier, with cheap prologues, devirtualized final calls, trivial callees inlined, and no JS on catch or Unsafe fast paths.
3. The interaction pipeline has no structural waits: pointer events are pipelined, composite runs right after draw, host callbacks run synchronously in `nativePollOnce`, and input is batched per frame.
4. The main thread comes first. Turns are short and time-bounded, so input and vsync wait at most about 2 ms behind background strands.
5. Class state is flat (linear-memory statics, id-indexed vtables), so modules need few imports and instantiate cheaply.
6. State lives next to its user (batched SQLite protocol, cached Settings).
7. Frames redraw only what changed, and only where traces justify it.
8. The harness measures what users see without disturbing it.

## Work plan

Each item lists the change, files, switch, expected effect and the run that confirms it. Switches are `?flag=` page parameters forwarded to Workers (`processes.ts:336`, `lat --query`). Compiler variants use a `CodegenFlags` bitset (`src/wasm/compiler/consts.ts`), set with `aot-build --codegen/--variant`, included in `buildKey`, and served side by side with `?aot=<key>`. A switch that wins its matched runs becomes the default, and the losing path is deleted.

### Stage 0: measure what users see (first; it gates everything)

- **0.1 `lat` v2** (`scripts/lat/run.ts`, `observe.ts`, `expect.ts`, `src/shell/frame-port.ts`, `pointer-input.ts`):
  - **Window:** nothing touches the app main looper between DOWN and settle. Remove the `snapshot()` between DOWN and UP.
  - **Crops:** the Worker crops each response region from every presented frame into a ring buffer, replacing today's full-screen mirror copies.
  - **`firstMs`:** the first frame after UP in which a region tile differs from the last frame before UP and also belongs to the final changed set. A tap mask of the tapped node's bounds plus 72 px excludes press and ripple feedback. Tiles that change while idle are dropped as noise.
  - **Other metrics:**
    - `settledMs`.
    - Interval p50/p95/max from UP to settle.
    - `missedFrames`: vsyncs where a frame was requested but nothing was presented.
  - **Semantic check:** one `uiTree` after the window closes.
  - **Options:**
    - `--metric legacy` keeps today's measure as a separate run.
    - `--trusted-input` dispatches input over CDP.
  - **Scenarios:** narrow Komikku's response region, which currently contains the buttons being tapped.
  - **Validation:** a null tap and an idle window must produce no gate, and `firstMs` must be ≤ the legacy number.
- **0.2 `--throttle N`:** apply CDP `Emulation.setCPUThrottlingRate` to the page and every Worker target. Verify that Workers actually slow down with a busy-loop probe.
- **0.3 Worker frame timeline:**
  - **Storage:** a typed-array ring buffer with no allocations.
  - **Marks:** pointer received or published, `dispatchInputEvent` start and finish, vsync request, rAF, `doFrame`, `drawFrame`, `queueBuffer`, composite, present, turn start and end per strand.
  - **Counters per frame:** entries, crossings, compiled methods, upgrades.
  - **Read** after the window with worker-control `timeline(since)`.
- **0.4 IPC census and page-delay sampler:**
  - Wrap every `brokerCalls()` method (`process-endpoint.ts:49-107`) to record count, latency and bytes, with a per-native split for SQLite.
  - A page MessageChannel ping measures task delay inside windows. Enable it with `--census` only.
- **0.5 Codegen census:**
  - A flag-gated dump of call counters over each tap window (`World.calledMethods`).
  - Calls classified as static/direct, final-virtual, monomorphic, single-implementation interface, polymorphic, or trivial callee. Catches, Unsafe operations and `arraylength` are counted too.
  - Java self time per frame, split by tier.
  - A repeat-tap experiment (tap 1 vs tap 10) gives the upper bound on second-tier value.
- **0.6 Benchmarks that predict app gains:**
  - Kotlin-shaped G1 workloads (`tests/fixtures/wasm/java/G1.java`): final getter chains, a single-implementation interface, `Function2.invoke`, `checkNotNull`, IntArray slot tables, CAS through field updaters, try/finally, coroutine state machines, cancel throws.
  - The same dex on the reference AVD through `scripts/adb.ts` `runDex` gives the ART headroom ratio.
- **0.7 Scenarios:**
  - A Compose list fps scenario: a long Komikku settings list, or its library with a local-source fixture.
  - Heavy-app reports: launch and one tap each for YouTube, Reddit, TikTok and ChatGPT.
  - Counter gates: `wasmAotLoaded` > 0, no `browserErrors`.
- **0.8 Baselines:**
  - Runs: 3 matched runs each, cold and `--warm`, `--gpu`, plus one throttled pass.
  - Recorded in `docs/performance.md` under the new metric.
  - **The drop caused purely by the new metric must not be counted as a speedup.**

### Stage 1: remove structural waits (low risk; small independent PRs)

- **1.1 Turn clock and vsync awareness** (`src/jvm/yield.ts`, `src/wasm/link/sched.ts` `suspending`/`enter`, `src/wasm/host/boot.ts:58`, `src/android/vsync.ts`):
  - Start the turn clock at the yield-channel handler, at each strand resume, and at top-level entry.
  - A non-main strand also counts as due within 2 ms of the next predicted rAF while a frame is requested.
  - Switch: `?turn=`.
  - Confirm with the turn-length histogram, `missedFrames`, and launch times.
- **1.2 Composite as soon as the buffer is latched** (`src/android/surfaceflinger.ts` `queueBuffer`/`applyOps`/`composite`):
  - When `queueBuffer` latches the buffer directly, composite synchronously.
  - Switch: `?composite=now|microtask`.
  - Use `--trace` to confirm that Chrome takes the bitmap earlier.
- **1.3 Bug fix:** `fill()` in `deliverVsync` pushes a Bridge undo closure outside any scope every frame (`vsync.ts`, `bridge.ts` `refArray`). Add a scope, plus a unit test over 1,000 vsyncs.
- **1.4 `onMain` jobs complete synchronously** when they return a value (`mainloop.ts`); the per-frame `postMain` frame-close becomes a host continuation (`vsync.ts`). First audit the `onNextVsync`/`frameDrawn` users in `hwui.ts`. Switch: `?frameclose=`.
- **1.5 Shader prewarm** (`src/android/runtime-shader.ts`):
  - Persist the AGSL sources compiled per platform build.
  - Compile them at idle after the first frame, or in the spare Worker. In Chrome use `KHR_parallel_shader_compile`; WebKit takes one synchronous idle slot.
  - Removes about 270 ms from the first ripple in each process.
  - Switch: `?prewarm=`.
- **1.6 Pipelined pointer events:**
  - Files: `pointer-input.ts`, `process-port.ts`, `worker-control.ts`, `device.ts`, `server/wm.ts`.
  - The page sends `pointerNotify({seq, action, x, y, at})` without awaiting. The Worker drains a FIFO on the InputDispatcher thread, coalescing moves but never dropping DOWN or UP. The awaited `pointer` call is kept for e2e.
  - Switch: `?pointer=notify|await`.
  - The gain is in cold taps.
- **1.7 Upgrade planning and adoption are deferred** out of input and frame windows (`world.ts` `upgrade`, `boot.ts` `answeringInput`). Switch: `?upgradeHold=`.
- **1.8 APEX/module jars in the platform build** (`scripts/wasm/aot-build.ts` `PLATFORM`), after a counter of on-demand methods from boot jars outside the build.

### Stage 2: compile off the interaction path (fixes cold launches and cold taps)

- **2.1 Deterministic app numbering:**
  - `World.seedApp(dexes)` runs at dex arrival in both the page World (`boot.ts` `appCode`, after `prefix = w.since(w.base)`) and the compile Workers (`compile-serve.ts` `init`, after `w.adopt`).
  - **Seeding:** walk root-namespace class_defs in `Program.add` order, assigning ids and slot blocks (block size asserted equal to what `link()` computes), array types, interface selectors, and rtfns.
  - **`freeze()`:** after seeding, a Worker throws `Unnumbered` for any new key.
  - **Remainder** (anything that still needs a number after the seed):
    - First, exclude and count.
    - Then bind late through imported immutable i32 globals in module `"~"`, using `sites.ts` symbolic imports as the precedent. Gap and link-error ids become string constants.
  - **Mismatch protection:** seed and prefix hashes on every shard.
  - **Related changes:** `AppIndex` gets the seed (`APP_VERSION` 19), and `COUNT_SLOTS` goes to 2^21 (`exc.ts`).
  - **Validation:** first offline, as a `bun run smoke --seed --freeze` exclusion report per app; in the browser it must be launch-neutral.
  - Switch: `?seed=`.
- **2.2 Streamed app images:**
  - **Planner:**
    - Split `parseBaselineProfile` (`src/jvm/baselineprof.ts`) to include startup classes.
    - Order: startup → launch/manifest roots (`compile-serve.ts` `select`) → `callClosure` (`src/jvm/reach.ts`) → hot → post-startup.
    - Shards of 400 methods, then 1k, 2k, and up to 4k methods.
  - **Workers:**
    - N by cores and memory (≤3), starting with 1 at dex arrival and ramping up after the first frame.
    - Each Worker compiles with a synchronous `new WebAssembly.Module` and posts the Module (WebKit: posts bytes).
    - Shards carry a passive element segment plus `$install` (`table.init`; `wasmbin.ts` `addElemPassive`, `code.ts` `tableInit`).
  - **Adoption** happens on a miss (`install(slot)` from `linkSlot`/`batch`) or in idle slices of 4 ms or less (`aot.ts` `addShard`/`adoptIdle`). It never replaces slots that are `done`, and **it never waits**.
  - **Persistence:** each shard is persisted when it arrives (`persist.ts`, content key). A partial image resumes on the next launch. Refinement adds shards (`REFINE_SHARE` retires).
  - **Switches:** `?image`, `?imageWorkers`, `?imageStart`, `?imageAdopt`, `?imagePost`.
  - **Avoiding the earlier rejected regression** (waiting on 6 Workers) requires never waiting, bounding N, and ramping up only after the first frame.
- **2.3 Profile-guided second tier shipped in builds:**
  - **Build:** `scripts/wasm/aot-profile.ts` records counts and likely targets. `apps.ts` `buildApp` then runs `buildUnit(hot=true, install=true)` for top roots, reusing `World.group` and `upgradeJob` planning. The platform does the same for `hot.json` roots.
  - **Exclusions:**
    - HostSpec, `hostWhole`, intrinsic, native and `rt.natives` bodies.
    - `aot.override(m)` drops any group containing `m`.
    - A byte cap per app.
  - **Switch:** `--codegen pgo2`, `?tier2=runtime`.
  - **Confirm:** repeat-tap rep 1 ≈ rep 10, and `doFrame` Java goes down.
- **2.4 Second tier and compile-ahead in Workers that always adopt:**
  - `adoptUnit` (`world.ts:1182`, `unit.ts`, `host/compiler.ts`) keeps only its epoch and assumption checks.
  - `World.ahead` becomes a `compile-serve` request.
  - Switch: `?ahead=worker`.
- **2.5 Compiler front-end throughput:** less allocation in `Flow` construction, reuse of inference scratch space, decoding each instruction once (`src/jvm/prepared.ts`, `structure.ts`, `src/wasm/compiler/infer.ts`, `facts.ts`). Measure with a Node benchmark over Komikku's demand list. Requires `bun run wasm all`.

### Stage 3: emitted code V8 can make fast (warm frame time)

Gate each item on the 0.5 census and the 0.6 workloads. Changes are expressed as `CodegenFlags`.
- **3.1 Merged prologue:** `call $pro(slot, weight)` does the count, the depth check and the fuel budget. The `WARM_AT` load is dropped; `World.warm` primes counters instead (`j2w.ts` `emitCount`/`emitEnter`, `world.ts:1522`).
- **3.2 Final-target devirtualization:** a virtual or interface call to a final method or class becomes a `call_indirect` on a constant slot, skipping the cast, vtable load and `array.get` (`method.ts:1043-1073`, `j2w.ts` `devirt`).
- **3.3 Compiler-inlined trivial bodies** in every tier:
  - Bodies covered: field get/set on `this`, return of a constant or argument, empty methods, and initialized static gets.
  - Guard: `vt[vslot]==slot` unless the target is static, private, super or final.
  - A `checkNotNull`-style fast path calls the original only on failure.
  - Exclusions are the same as 2.3.
- **3.4 Small items:**
  - Hoist each array's data reference per register.
  - `arraylength` uses one cast instead of up to five `ref.test`s.
  - String literals become per-literal globals.
  - Skip `acmp` on typed operands.
  - Files: `method.ts` `emitAget`/`emitAput`/`arrayLength`, `strings.ts`.
- **3.5 Typed catches without JS** when handler types resolve at compile time, using module-local `iof` (`method.ts:623-646`). Unsafe with constant offsets becomes `struct.get`/`struct.set`/CAS (`unsafe.ts`). Confirm with `conform jsr166` and `ojluni-time`.
- **3.6 Conditional:** same-module direct calls with call-affinity grouping, and precise reference types. Only if the census and `--trace-wasm-inlining` show headroom; never cross-module tail calls (WebKit JSPI).

### Stage 4: main thread first

- **4.1 Time-bounded preemption:**
  - A budget word in scratch memory, decremented in `$pro` and every 256 iterations of loop counters (local counters stay as they are).
  - When the budget runs out, a plain import refills it by time and asks for a yield only when one is due: main after 8 ms; background after 2 ms if main has work, input is pending, or vsync is close. Only then does it call `yieldNow`.
  - Files: `j2w.ts` `emitFuel`, `sched.ts` `yieldNow`/`Block.Yield`, `yield.ts`.
  - Switch: `?callfuel=`.
  - Gate: at most 1–2% on call-heavy jbench.
  - Confirm with scroll p95/p99 and the longest background slice.
- **4.2 Conditional:** Chrome `scheduler.postTask({priority:"background"})` for background resumes, with aging and a directed yield to the lock owner the main thread waits on. WebKit keeps MessageChannel. Switch: `?bgprio=`.

### Stage 5: fewer modules, cheaper instantiation (launch, adoption, memory)

- **5.1 Flat statics with a generic `ensure`:**
  - **Layout:** init words and primitive statics in linear memory at fixed addresses; reference statics in one anyref array; `vts[id]`.
  - **Effect:**
    - About 4 imports per module instead of about 172.
    - About 1,500 fewer modules per cold launch (`buildClasses`, `linkEnsure`), and most of `loadC`'s 280 ms gone.
    - Lets a helper Worker warm app code (`World.warm`).
  - **Files:**
    - `j2w.ts`: `initGlobal`, `staticGlobal`, `vtGlobal`, `emitEnsure`, `emitNew`.
    - `method.ts`: `emitStatic`.
    - `world.ts`: `classModule`, `buildClasses`, `linkEnsure`, `classImports`, `repairVtable`.
    - `aot.ts`: `loadC`.
    - `reflect.ts`, `unsafe.ts`, `mhandles.ts`, `hostclass.ts`, `intrinsics.ts`.
  - **Variant:** `abi=flat`.
  - **Gates:** jbench within ±3%, conform suites, and the class-initialization protocol tests.
- **5.2 One stub per signature,** with the slot as a leading `self` parameter:
  - Change `j2w.ts` `sig`/`callMethod`/`emitInvoke` and `world.ts` pools, `stubClass` and `invalidate`.
  - Every Java entry passes `self`: `callFn`, `hostFn`, reflection, MethodHandles, `warm`.
  - Variant: `stub=slotarg`.
  - Gates: jbench and TikTok heap.

### Stage 6: input batching and IPC (sized by the 0.4 census)

- **6.1 Batched input at CALLBACK_INPUT,** following AOSP's InputConsumer: `nativeConsumeBatchedInputEvents` builds one MotionEvent per frame with `addBatch` history, and DOWN/UP flush the batch first (`inputchannel.ts`, `wm.ts`). Switch: `?input=batched`. Confirm with scroll fps and fling flows.
- **6.2 Batched SQLite protocol** (`sqlite.ts` `registerSQLite`, `createSQLiteSession`):
  - Prepare returns metadata, binds are buffered, and step carries the binds and returns the row.
  - Column getters are answered locally; reset and finalize are notifications.
  - Optional read-ahead for read-only statements.
  - A differential test runs batched against per-call.
  - Switch: `?sqlite=batched`.
  - If round trips still exceed about 10 ms per window, the next step is moving database ownership into the first Worker that opens it.
- **6.3 Caches and pools:**
  - Settings cache with ordered broker invalidations (`settings.ts`, `process-endpoint.ts`), `?settings=cache`.
  - PropertyInvalidatedCache nonces, `?pic=on|verify`.
  - Binder thread pool (`binder.ts:298-307`), `?binderpool=`.
- **6.4 Conditional:** move system_server and the broker into a system Worker, if page delay p95 exceeds 8 ms inside windows once the harness load is removed.

### Stage 7: frames that redraw only what changed (only where a trace shows the cost)

- **7.1 Hardware-layer cache** keyed by subtree generation (`rendernode.ts` `drawNodeInto`, `texturelayer.ts`). Switch: `?layers=cache`.
- **7.2 Damage-region replay** into persistent window buffers, as DamageAccumulator does (`hwui.ts` `drawFrame`). Switch: `?damage=on|verify`; `verify` periodically replays the full frame and compares pixels.
- **7.3 Lighter recording and replay JS** where profiles show it (replay is about 7% of `doFrame`): stop parsing styles twice on the mirror context, encode ops flat, cache text state (`recording.ts`, `canvas.ts`, `canvas-draw.ts`, `shaping.ts`).
- **7.4 Filters without readbacks via WebGL** (`graphics.ts` `recolor`, `rendereffect.ts`, `maskfilter.ts`), only for apps that hit them.

The software draw path and the visual goldens stay unchanged.

### Not doing, with evidence

- **Rewriting the host↔Java bridge:** about 0.6 ms per tap. Only 1.3 is done. Skipping Bridge scopes for natives bridged only because of a `J` argument, and in/out array declarations, wait until counters show more than 1 ms per frame.
- **Relocatable units, or indirection at every site:** deterministic seeding gives the same freedom at zero cost per call.
- **A new baseline translator:** 2.5 instead.
- **Java threads across Workers:** not possible.
- **Earlier measured rejections:** priority inheritance (98 vs 96 ms), 4 ms turns, fading-node layer promotion, an off-thread pixel sampler, one-entry MotionEvents, and presenting the top window directly (it would detach the persistent buffer that 7.2 needs).

## Sequence and success criteria

**Sequence:**
1. Stage 0.
2. Stage 1 (independent PRs).
3. 2.1.
4. 2.2, 2.3 and Stage 3 in parallel (2.3 after 3.1).
5. 4.1.
6. Stage 5. Move 5.1 ahead of 2.2 if shard adoption on a miss exceeds about 2 ms.
7. Stage 6.
8. Stage 7.

Record each finding and rejection in `docs/implementation-history.md`, and update `PLAN.md` and `docs/performance.md`.

**Done when:**
- **Taps:** every gated tap (Calculator M, FitNotes, Komikku; cold and warm) has `firstMs` ≤ 150 ms (median of 3 matched `--gpu` runs). The throttled pass is reported.
- **Pacing:** in transitions and in the scroll and Compose list scenarios, `missedFrames` ≈ 0 and presentation-interval p95 ≤ 18 ms at 60 Hz. FitNotes is at p95 25.9 ms today.
- **Cold launches:** move toward warm (estimates: Calculator 2.7 → ~2 s, Komikku 7.0 → ~4–5 s), with warm launches not regressing.
- **No correctness regressions:** quick e2e passes 7/7 with goldens unchanged, plus `wasm all`, `fwtest`, `conform` and smoke.

## Critical files and reused utilities

**Critical files**
- **Harness:** `scripts/lat/run.ts` (+ `scenarios/*.json`), `src/shell/frame-port.ts`, `src/shell/pointer-input.ts`, `tests/e2e/lib/processes.ts`.
- **Scheduling and frames:** `src/jvm/yield.ts`, `src/wasm/link/sched.ts`, `src/android/mainloop.ts`, `vsync.ts`, `surfaceflinger.ts`, `hwui.ts`, `runtime-shader.ts`.
- **Code delivery:** `src/wasm/link/world.ts`, `aot.ts`, `src/wasm/host/boot.ts`, `appcode.ts`, `compile-serve.ts`, `persist.ts`, `scripts/wasm/aot-build.ts`, `aot-profile.ts`, `apps.ts`.
- **Codegen:** `src/wasm/compiler/j2w.ts`, `method.ts`, `consts.ts`, `wasmbin.ts`, `code.ts`, `unsafe.ts`.
- **IPC:** `src/android/sqlite.ts`, `settings.ts`, `binder.ts`, `inputchannel.ts`, `server/wm.ts`, `src/shell/process-endpoint.ts`.

**Existing pieces the plan builds on**
- `World.group`/`upgradeJob`/`buildUnit` for the second tier shipped in builds.
- `compile-serve.ts` `select` plus `src/jvm/reach.ts` `callClosure` to order image shards.
- `src/jvm/baselineprof.ts` for startup ordering.
- `sites.ts` symbolic imports as the model for late-bound i32 globals.
- `persist.ts`/`aotstore` content keys for shards.
- `scripts/adb.ts` `runDex` for the ART comparison.
- The existing `lat --query` → `workerUrl` forwarding for every `?flag=` switch.
- The profile scripts in the scratchpad (`profcat.ts`, `proftl.ts`, `profunder.ts`); fold them into `scripts/lat/` as `--profile` reports.

## Verification (per change)

```bash
bun run typecheck && bun run test
bun run wasm all            # any compiler, linker or shared front-end change
bun run fwtest && bun run smoke apks/FitNotes.apk   # plus the gate APKs and TikTok for host overlays
bun run conform jsr166      # also guava and ojluni-time for ABI, catch, Unsafe and preemption stages
bun run aot && WEBDROID_URL=http://localhost:4191 bun run wasm aot-profile   # after any src/ edit, before --warm runs
PORT=4191 bun run server.ts
WEBDROID_URL=http://localhost:4191 bun run e2e --jobs 1
WEBDROID_URL=http://localhost:4191 bun run lat calculatorm fitnotes komikku --gpu [--warm] --query <A|B>
```

**Latency runs:** 3 or more matched runs per side, alternating A and B, nothing else running on the host; 5 or more for fps claims. Also do `--engine webkit` once per switch. Check `wasmAotLoaded` > 0, `browserErrors`, and the counters in `run.json`. Compare any regression against the starting commit before attributing it.
