# Performance: how to measure, and where the time goes

The targets are in-app latency and frame pacing: launch to first app frame, every gated tap at most 80 ms from
`pointerup` to the answering frame (`lat` fails above 150 ms), and scroll presentation intervals. [PLAN.md](../PLAN.md) ranks the open work;
the [implementation history](implementation-history.md) records each measurement and rejected experiment, so check
it before retrying an idea.

## Measuring

```bash
WEBDROID_AOT_STALE=1 PORT=4191 pnpm dev
WEBDROID_URL=http://localhost:4191 pnpm lat fitnotes calculatorm --gpu --warm
WEBDROID_URL=http://localhost:4191 pnpm lat komikku --gpu --cpuprofile
pnpm aot                                                # rebuild the platform build after a source edit
WEBDROID_URL=http://localhost:4191 pnpm wasm aot-profile  # regenerate the bundled app builds
```

- **`lat`** (`scripts/lat/run.ts`) launches the browser with Playwright but drives it over raw CDP with only Page
  and Target enabled (Playwright's `Runtime.enable` makes every Java exception about 5× dearer). It reports launch,
  each gated tap (pointer-up to the intended UI state and response pixels) and a fixed scroll window (`fps` step:
  presentation intervals and page long tasks), on a fixed 1080×2160@480 screen. Scenarios are in `scripts/lat/scenarios/` (calculatorm, fitnotes,
  komikku, mihon; the heavy-app reports youtube, reddit, chatgpt and tiktok carry `"gate": false` and run only when named,
  without failing the gate). Without `--warm` it measures a first launch, which waits for the app's install-time build; `--warm` launches
  twice in one profile, clearing the app's data between, and gates the second. `--gpu` uses the host GPU instead of SwiftShader, `--cpuprofile` profiles every
  Worker, `--timeline` shows the app Worker's startup marks, `--trace` writes a browser-wide trace, and
  `WEBDROID_JS_FLAGS` passes V8 flags; `--engine webkit`, `--json <file>` and `--query <params>` are also
  accepted. For another app, add a temporary scenario and delete it afterwards.
- **What a tap time is.** A tap is timed from `pointerup` to the first presented frame
  that changes a response-region tile the settled frame also changed, outside the tapped node's bounds plus 72 px
  (press and ripple feedback), and outside tiles that already moved while pressed, so a screen still animating at
  `pointerdown` reports "did not change outside the pressed view"; time to the settled semantic state, presentation intervals and missed vsyncs are
  reported beside it. The Worker sends ≤ 128 px crops of the response regions with each presentation, and nothing
  probes the app between `pointerdown` and the end of the window. Tap times before 2026-10-13 used an earlier
  semantic-plus-pixels clock and are not comparable. A step starts once the app has been quiet for 600 ms: nothing
  drawn or queued, no thread but the main one running Java, and no main-looper message due within a second. Each tap and `fps` step also carries the app Worker's
  frame timeline (`src/timeline.ts`: vsyncs, input, doFrame, draw, composite, present, looper idle/wake), read
  after the window. `--ecores` (macOS) runs Chrome on the efficiency cores at background priority, about 6× slower in the page and every Worker alike, for a slower-device pass; CDP CPU throttling is not used because it reaches only the page. `bundles=0` (on by
  default in `lat`) keeps the bundled app builds out, so a run without `--warm` measures a first launch with no shipped build.
- **Claims need matched runs:** the same inputs, serial (`--jobs 1`), nothing else running on the host, at least
  three runs per side, alternating revisions. Compare a failure with the starting commit before calling it a
  regression; Calculator and Lichess are flaky on unchanged code.
- **Scroll needs `--gpu`.** Under SwiftShader the numbers measure the GPU process: in a scroll trace its compositor
  spent 5.5 of 9 s in `SwapBuffers` while the app Worker was busy 0.4 s. Scroll p95 used to be bimodal from run to
  run (about 18 or about 25 ms): a 120 Hz host rAF put every other frame on the 60 Hz virtual vsync's phase
  boundary, so jitter chose between 8 and 25 ms frames. `recordVsync` now bounds the early tolerance by the host
  period; still compare several runs.
- **The probe costs time.** `lat` and e2e read UI state once per app frame; on Compose screens a probe walks the
  accessibility tree on the main looper at 5–10 ms (about 31 ms per Komikku tap). Probing less would lower what
  `lat` reports, not what a user sees.
- **The platform build must match the source.** It is keyed by every file under `src/` and the AOT scripts; after
  any edit the server answers 404 for `/aot/current.json` unless `WEBDROID_AOT_STALE=1`. That flag is right for
  edits outside the compiler and linker; after one inside them, or after adding even a temporary counter under
  `src/`, run `pnpm aot`, or a `--warm` run silently becomes an on-demand one (it fails with "app code is not
  saved"). Check `browserErrors` in `run.json` for a failed `/aot/current.json` and `wasmAotLoaded` above 0 in the
  step counters.
- **`vendor/wasm-aot` is shared** and ignored by Git; a worktree usually symlinks it. `pnpm aot` prunes the
  builds it replaces, including the bundled app builds, so regenerate those afterwards.
- **The dev server serves source fresh.** Do not edit served code while an e2e or `lat` run is in progress; an e2e
  run that reports "0 steps" just after an edit is the bundle rebuilding. Server-side code (`server.ts`,
  `scripts/aot-*.ts`) loads once, so restart the server after editing it.
- **Counters are not frame rates.** Shell ticks, guest instructions, EGL swaps, decoded frames and browser
  presentations measure different work, and an idle or wedged app can advance ticks without presenting. Check that
  rendering works and `wd.ticks` advance before trusting any rate. Keep CPU profiles apart from gated runs, and
  confirm canvas self time with in-page timing (V8 once charged a WebGL canvas resize to width checks).

### Profiling Workers during an e2e flow

e2e has no profiling switch; use Chrome's remote debugging port:

1. Temporarily add `...(process.env.ZZ_CDP ? ["--remote-debugging-port=" + process.env.ZZ_CDP] : [])` to the launch
   `args` in `tests/e2e/drivers/webdroid.ts`, and revert it afterwards.
2. Attach to `webSocketDebuggerUrl` from `http://127.0.0.1:<port>/json/version`. On the page target send
   `Target.setAutoAttach` with `{ autoAttach: true, waitForDebuggerOnStart: true, flatten: true }`. On each
   `Target.attachedToTarget`: for a `worker` target send `Profiler.enable`, `Profiler.setSamplingInterval`
   (`{ interval: 500 }`) and `Profiler.start`; for any other target set auto-attach again; then send
   `Runtime.runIfWaitingForDebugger`.
3. When the step of interest ends, send `Profiler.stop` to each process Worker (URLs contain `process-worker` and
   `pid=<n>`) and write `w<pid>.cpuprofile` for DevTools.

## Current numbers

`--gpu`, Worker processes, one job, Apple M4 Pro (14 cores), first response frame, medians of three alternating runs (2026-10-17). First launches wait for the install-time build; warm launches attach the build an earlier launch saved.

| | First launch | Warm |
|---|---|---|
| Calculator M launch | 2.36 s (build 0.85 s; 2.27 s on demand) | 1.30 s |
| FitNotes launch | 1.99 s (build 0.51 s; 1.58 s on demand) | 1.34 s |
| Komikku launch | 6.69 s (build 3.0 s; 5.97 s on demand) | 2.37 s |
| Calculator M taps | 12–25 ms (`7` 16; 55 on demand) | 15–30 ms |
| FitNotes taps | 11–69 ms (`start` 69) | 10–67 ms (`start` 67) |
| Komikku taps | `next` 16, `start` 101, `more` 52, `settings` 45, `appearance` 82 | `next` 15, `start` 95, `more` 48, `settings` 65, `appearance` 77 |
| TikTok launch (report) | 11.1 s (above the whole-app limit: no wait) | |

Earlier numbers, before the install-time build:

`--gpu`, Worker processes, one job, Apple M4 Pro, medians or ranges of matched runs (2026-10-12/13). The platform
build was rebuilt when the JS tier was deleted, so re-measure both sides before claiming a delta against these.

| | Cold (no saved build) | Warm |
|---|---|---|
| FitNotes launch | 1,365–1,486 ms | 1,449 ms |
| Calculator M launch | 2.7 s | 1,517 ms (1.6 s in the 2026-10-13 tap runs) |
| Komikku launch | 6.7–7.0 s (8.1–8.2 s before compiling ahead) | 2.5–2.75 s |
| FitNotes gated taps | | 12–110 ms |
| Calculator M gated taps | `7` 127 ms, others 43–101 ms | 20–70 ms |
| Komikku taps (Compose) | 190–290 ms | 160–230 ms |
| FitNotes scroll p50 / p95 / p99 | | 16.6 / 18–26 / 19–33 ms |

First response frame (the gate since 2026-10-13; not comparable with the rows above), one `--gpu` run each, 2026-10-13:

| | Cold | Warm |
|---|---|---|
| Calculator M launch / taps | 3.2 s / 6–99 ms | 1.9 s / 10–33 ms |
| FitNotes launch / taps | 2.4 s / 10–53 ms | 1.8 s / 11–53 ms |
| Komikku launch / taps | 7.4 s / 58–149 ms | 2.9–3.1 s / 32–89 ms |
| YouTube launch / taps (report) | 14 s / 205–445 ms | 5.3 s / 7–145 ms |
| Reddit launch (report) | 11.9 s | 6.1 s |
| ChatGPT launch (report) | 6.0 s | page crashed once; 2.4 s on 2026-10-14 |
| TikTok launch (report) | 12.3 s | 8.2 s (its build attached from 2026-10-13); 7.9 s on 2026-10-14 |

On a profiled platform build with worker answers held through input (2026-10-14, three cold runs), Komikku launched
in 5.8–6.4 s and its taps took 36–177 ms (per-tap medians of two three-run series: `next` 48–53, `start` 92–123,
`more` 133–135, `settings` 104–107, `appearance` 129–150). The gate by its criterion (median of three matched `--gpu` runs, current code, 2026-10-14): every tap passes cold and warm;
the highest medians are Komikku `more` 128 ms cold and Calculator M `7` 95 ms cold, and warm medians are 8–73 ms. Single runs
still miss: warm Komikku `next` at 307 ms (the dialog-aftermath race in the history) and cold `more` at 151 ms. An `--ecores` pass (about 6× slower) is in the history under
"A slower device on the efficiency cores".

Scroll pacing (`lat` fps steps) times each presentation by the display frame that shows it since 2026-10-14
(`fc0fa6a9f`); earlier p95s used the composite time and run about 1 ms higher (18.2–19.5 ms). Over five `--gpu`
runs each, FitNotes `scroll-legs` p95 is 17.3–17.8 ms and Komikku `scroll-appearance` 17.6–17.8 ms, with no missed vsyncs.

Repeating a tap bounds what a second tier could save (Komikku, back and then Appearance ten times in one session,
2026-10-14). `appearance` took 167, 93 and 52 ms on its first, second and tenth visits cold, and 82, 64 and 50 ms
warm. Its compiling fell from 33 ms to 0–6 ms after the first cold visit. From 2026-10-14 to 2026-10-16 no second-tier
unit reached an app (history, "Units from the sandboxed frame"); with units and warmed merges, medians over three cold
runs were 129, 69 and 52 ms on the first, second and tenth visits, against 131, 82 and 58 ms without units.

The Wasm tier against ART (`pnpm ts scripts/wasm/g1art.ts --ref <g1.json>`, the reference AVD, 2026-10-14), steady state:

| Kotlin-shaped G1 workload | Chrome ÷ ART |
|---|---|
| final getter chain (`ktGetters`) | 9.3× |
| field updaters (`ktUpdaters`) | 7.5× |
| parameter null checks / slot tables / lone interface impl | 5.2× / 4.8× / 4.4× |
| generic lambdas / state machine / cancellation | 2.4× / 2.3× / 1.6× |
| try/finally | 0.5× |
| geometric mean of the nine | 3.2× |

Heavy-app launches wait for live content, so they vary with the network. Komikku's cold taps sit at the gate; they compile
on demand. Warm YouTube taps compile almost nothing (21 methods in `you`) but run ~90 ms of first-tier Java in input dispatch.

Mihon's launch is not measurable while its live update check opens a "New version available" dialog over
onboarding; use Komikku for a Compose app. For scale, the 2026-10-10 baseline (SwiftShader, iframe processes) had
FitNotes launching in 3,366 ms cold and 2,427 ms warm, Calculator's taps at 60–390 ms, and the Resy e2e flow at
61–66 s wedged, against 32 s now.

## Where the time goes

- **Warm taps** are bound by the app's own screen transitions and by the harness's probes, not by guest compute.
  Komikku's input lands about 16 ms before its first frame, then frames follow at display rate until Compose's
  transition ends; its semantics appear only then. Second-tier planning and adoption take 4–12 ms per tap and
  render replay about 3 ms. V8 tiering is not a lever: a tenth of the default tier-up budget left Komikku's taps
  unchanged.
- **First visits with a build** run compiled code; what remains is the app's Java and first uses. A platform font
  file loads whole on first shaping and its CSS face is validated on registration, so the large fallback files (CJK,
  color emoji, Tibetan) are read ahead while idle after the first frame; a small one costs a few ms on first use.
- **Cold taps without a build** (a background process, code outside the build) are mostly on-demand compiling, one
  module per method. Calculator's first cold tap links 229–342
  methods: 57–78 ms compiling and 18–21 ms creating modules. Across a cold launch `linkSlot` is 52% compiler,
  then `WebAssembly.Module` and `Instance`, encoding and import objects. The main process makes about 6,400
  modules (3,953 from `linkSlot`, 911 `buildClasses`, 603 `linkEnsure`, 318 stub pools).
  Main-thread Java is the larger share on a profiled build (Komikku 80–115 ms a tap); V8 compiling merged
  modules' functions on their first call adds 9–57 ms.
- **Chrome charges a module about four times what Node does:** 18.5 µs against 4.2 µs per unit module, the same
  with every V8 flag tried, so the lever is fewer modules. Instantiation costs about the same in both and grows
  with exports.
- **First launches** wait for the app's build, in shards (6 for Calculator M and FitNotes, 7 for Komikku on the
  14-core host): 0.85, 0.51 and 3.0 s. Without it, first launches compile broadly: Komikku compiles about 15,600 methods in 3.2 s (emit
  1.5 s), about 115 µs a method in Node and 200 µs in the browser, into about 17,900 modules, with no single
  hotspot. The compiler front end allocates about 200 MB/s, `Flow` construction the largest share.
- **Later launches** spend about 280 ms in `loadC` instantiating code modules with about 172 global imports each;
  most of the rest is `addDexes` and `linkSlot`. In Chrome a page Worker has V8 compile the build code earlier launches
  ran, so before the first tap the app Worker compiles 6–19k functions (64–480 ms), against 23–55k (300–1,190 ms)
  before it and the inline literal and cast tests (traced under host load, 2026-10-15). FitNotes' warm app thread
  is busy about 1.3 s (JS 0.7 s, Java 0.38 s). A warm launch compiles 76 (Calculator M) and 138 (Komikku) methods
  on demand, mostly host-class natives. Komikku's first content comes at 2.2–2.4 s. Second-tier upgrades and the compile
  Worker wait for the first frame that composes app content; when its IO coroutine's database build and Firebase's
  dynamite open still run before that frame, main's page calls wait behind them, about 0.1 s in all.
  Firebase's dynamite load opens microG's dex in the app process synchronously in 42–51 ms, mostly namespace entries
  for its 38,000 classes, which join the class hierarchy as they are linked.
- **Native JIT batches share the app's thread:** emitting a batch, compiling its module and V8's lazy compiles of
  its functions hold the Worker 8–21 ms, and broker replies wait behind them, so a block is compiled only after 255
  entries. At 48, Komikku's database startup compiled about 2,100 regions and slipped its first content by 0.8 s.
- **Process contention:** the broker answers app IPC on the page thread, so slow page work starves app queries
  (the probe's synchronous readbacks once starved Komikku's chapter list). In the trio's gated windows the page
  starts serving a call within 0.3 ms, and the main thread waits at most 7.5 ms a window on broker calls
  (`scripts/lat/census.ts`); SQLite runs on background threads.
- **Not levers:** frame production (record, replay, composite) and text measurement and shaping were each under a
  few percent of profiled windows (scrolling, `doFrame` p95 is 2.5–3.6 ms, draw ≤ 0.9 ms and composite ≤ 0.5 ms); guest↔host crossings cost tens of nanoseconds; idle apps use about 2% of the
  thread.
