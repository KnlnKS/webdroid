# Removing in-app execution overhead

This investigation starts at `3ab71fd2` (2026-10-21), on `knlnks/bytecode-wasm-experiments`. The target is less
work on the thread answering input: translation, dispatch and repeated register/flag transfers. Passing the
150 ms tap gate does not establish negligible overhead. Measure first and repeated visits separately, with
launch time, code size and memory alongside latency. An Android comparison also needs to account for the
different execution environments before attributing every timing difference to webdroid.

## Implemented experiments

### Observed ARM/Thumb regions

ARM/Thumb regions can cross pages at entries already seen by the interpreter or installed JIT. This removes
register spills, dispatch and reloads between blocks. Regions retain their 40-block/640-instruction bounds,
installation-time source epochs and edge-time pointer/epoch checks. A 32-bit Thumb instruction straddling
pages stays interpreted, including when either half changes. The implementation is in `src/native/core/jit.zig`
and `jit32.zig`; tests cover host/guest code writes, registers, flags and straddling instructions.

### Guarded A64 returns

Direct calls bring up to four continuation blocks into a region. A RET tests its actual destination before
branching internally; every other destination takes the existing spill/dispatch exit. Return edges join
register writeback propagation, and transfers retain instruction-budget checks. Every internal return also
validates its continuation page, even on the same page as the callee. Review reproduced a stale same-page
continuation (7 instead of 9) before that check was added; the test now exercises both layouts.

These two changes adapt the bounded trace and precise-exit ideas in
[Dynamo (Bala, Duesterwald and Banerjia, PLDI 2000)](https://www.cse.iitm.ac.in/~krishna/courses/2022/odd-cs6013/BalaDusterwaldBanerjiaPLDI2000.pdf).
They preserve the existing host-call, signal and callback exits. They do not implement an off-thread native
compiler or unconstrained trace formation.

### Feedback at individual Java call sites

The planner formerly ranked implementations by whole-method counts and keyed guards by the declared method
signature. Two sites with different receivers therefore shared a plan. The first tier now samples actual
dispatch slots by caller identity and DEX PC. Hot units can co-locate each site's likely callees, while every
guarded call retains general dispatch for changed receivers and later classes/loaders.

This applies receiver feedback from
[polymorphic inline caches (Hölzle, Chambers and Ungar, ECOOP 1991)](https://bibliography.selflanguage.org/pics.html)
and makes more calls available to [V8's same-instance Wasm inliner](https://v8.dev/blog/wasm-speculative-optimizations).
The published systems' speedups are not predictions for webdroid.

Feedback uses a fixed 384 KiB table per Wasm World (including compile workers), two target/count pairs per row and at most 1,024 observations
per row. Sampling is decided once per first-tier activation using the existing counter modulo 64, without
crossing into JavaScript. Fewer than four observations permit the old global-ranking fallback; targets
covering less than 75% of a row's observations get no specialization. Hash collisions can reduce optimization
quality, but every specialized call still tests the live slot. Second-tier methods stop sampling. The existing
24-method group, 100-code-unit callee and two-guard limits remain. The implementation reuses the canonical
site identity and compile-worker plan protocol.

Profiles are process-local, not persisted. AOT versions advance to 23 because feedback moves the shared
array-transfer window. App and library bytecode remain unchanged; no APK-specific runtime rule or dependency
was added. One composite linker test covers locally dominant but globally rare receivers, installation from
a compile worker and changed receivers reaching fallback dispatch.

## Measurements and costs

Apple M4 Pro, three alternating fresh processes per side. Each native process warms 25 calls, then records
25 samples; every call checks its answer and exact guest instruction count. Java uses Chrome
151.0.7922.34, 100 repetitions per workload and the median of the latter half of each process's calls.

| Execution workload | Before | After | Result |
| --- | ---: | ---: | --- |
| ARM cross-page loop, Node, 1M iterations | 6.603 ms | 0.994 ms | 6.6× |
| Thumb cross-page loop, Node, 1M iterations | 5.054 ms | 1.013 ms | 5.0× |
| Same-page ARM / Thumb loop controls | 0.286 / 0.284 ms | 0.284 / 0.284 ms | Unchanged |
| A64 cross-page leaf calls, Node, 1M calls | 2.957 ms | 1.463 ms | 2.0× |
| A64 same-page leaf calls, Node, 1M calls | 2.907 ms | 1.257 ms | 2.3× |
| Java two-site dispatch, Chrome | 0.640 ms | 0.145 ms | 4.4× |

The eight other Java workloads change only slightly: allocation, monomorphic/bimorphic and interface-call
controls have identical steady medians; getters are 0.360 → 0.365 ms, lambdas 0.700 → 0.695 ms, updaters
6.400 → 6.280 ms and state machines 0.620 → 0.605 ms. These are mechanism measurements, not all-app speedups.
Initial on-demand calls often cost more: two-site dispatch is 7.600 → 8.295 ms and getters 6.400 → 8.300 ms,
including compilation. Platform code modules grow from 175,829,663 to 181,764,351 bytes (3.4%) once the entry
counter also returns the sampling decision.

[ARM/Thumb samples and app evidence](../research/performance/2026-10-21-native-regions.json),
[A64 samples after the invalidation fix](../research/performance/2026-10-21-a64-returns.json) and
[Java samples and controls](../research/performance/2026-10-21-call-sites.json) retain the individual runs.
For the latter two, source fingerprints were stable and the runner discarded attempts overlapping diagnostic
jobs or CPU-heavy external Node/Chrome processes. Raw Java load-average warnings remain recorded: this is a
shared host, not a dedicated benchmark machine. Earlier Java series collected under competing browser load
were excluded. Reproduce the kernels with `pnpm ts scripts/native-bench.ts same|cross arm|thumb`,
`pnpm ts scripts/native-bench.ts call|call-same a64`, and the G1 command recorded in the Java artifact.

The earlier ARM/Thumb change also has three alternating Doodle Jump full flows per side. Launch plus title
capture was 11.931 → 11.890 s; native execution in those steps was 5.545 → 5.350 s (3.5% less time) for about
10.76B guest instructions on both sides. Play/taps/playing presentation medians were
33.62/32.53/32.56 → 32.87/32.95/32.41 per second, within the run ranges: no frame-rate gain was established.
All six steps rendered in all six runs, with advancing ticks/GL presentations and diagnostics from both
processes. No missing APIs, required natives, Java/draw/GL errors or browser errors were reported. This
unscored flow provides smoke coverage, not visual parity or tap-latency evidence.

The final [Komikku comparison](../research/performance/2026-10-21-app-call-sites.json) isolates Java feedback,
with the retained native changes held fixed on both sides. Three alternating fresh browser profiles use paired
runtime/AOT builds, `--gpu --repeat 3`, no profiling, and no competing diagnostic jobs. Each server restart gets
an excluded first-read run because its Brotli cache is process-local. Those six excluded runs are retained in
the record; each exceeded the tap limit on its first Appearance visit.

| Komikku observation | Before | After |
| --- | ---: | ---: |
| First visible app frame | 5.722 s | 5.848 s |
| Intended launch content rendered | 6.452 s | 6.595 s |
| Repeated Settings longest frame | 19.60 ms | 18.75 ms |
| Repeated Appearance longest frame | 36.25 ms | 28.70 ms |
| Repeated Settings tap response | 44.95 ms | 45.50 ms |
| Repeated Appearance tap response | 61.40 ms | 51.00 ms |

These are medians of three run medians; each repeated measurement uses visits 3 and 4. Appearance frames
improve about 21% at the median, but the first pair is roughly unchanged: run medians are 36.25/33.65/36.75 ms
before and 36.90/28.35/28.70 ms after. The ranges overlap. Launch adds 125 ms at the median; first-frame ranges
are 5.669–5.737 s before and 5.713–5.912 s after. Scroll p95 remains 17.0–17.7 ms with no missed presentation
intervals above 25 ms. All 66 measured taps answer within 150 ms (maximum 99.9 ms before, 89.9 ms after).
All 576 process snapshots return healthy diagnostics with no missing APIs, required natives, uncaught, draw
or GL errors; the app renders and its ticks advance in every run.

This is evidence for one interaction in one APK on one host/browser. It does not establish negligible overhead
across arbitrary APKs, nor a speedup for every interaction. The original broader goal remains open.

## Verification

The combined implementation passes `pnpm typecheck`, all 1,192 unit tests in 65 files, all 16 `pnpm wasm all`
suites, and 31 framework exercises. The Komikku sweep validates all 131,785 methods with no unexplained
failures; 94 expected linkage-error bodies count as validated. The Wasm suites include loader/host-override
invalidation, suspension, differential execution, 14,400 fuzz cases, quick conformance, boot/FitNotes sweeps,
AOT and persistence. The production build also passes with its matching platform artifact.

The final serial quick gate passes seven flows / 105 checkpoints, with 426 process snapshots and no unexpected
diagnostics or gaps. Four flows compare against Android; three are unscored smoke. Komikku's 11 expected SQLite
warning/recovery/autoindex log messages match the existing flow policy; no new exception was added. Visual
goldens are unchanged. The GPU warm gate passes all 18 taps across FitNotes, Calculator M and Komikku (maximum
69.8 ms). Each warm run confirms that code persisted by its preparation launch was attached; all 168 process
snapshots are healthy.

Cold Calculator M and the three measured Komikku after runs pass. One cold FitNotes attempt crashes its page;
three subsequent before and three after runs complete all seven taps within 150 ms. The failed observation is
retained separately from those successful retries. Startup stress diagnosis is not used for performance timing.
The [final verification record](../research/performance/2026-10-21-final-verification.json) retains command results,
tap observations, source fingerprints, diagnostic coverage and the browser failure.

Startup stress reproduces a Chrome 151 `SIGILL` on launch 22 with the native changes present and Java feedback
absent. The final code passes 30 launches; the exact starting runtime passes 130. Separately, a browser adaptation
of [V8's concurrent-wrapper regression](https://github.com/v8/v8/commit/42a63bb146721f2175fa7e557594ce698b3d8cbe)
crashes Chrome 151 in all three attempts without loading webdroid. The upstream fix flushes the ARM64 instruction
cache before publishing a shared Wasm wrapper pointer. This confirms a browser defect and is consistent with the
app SIGILL; it does not prove the original cold failure had the same cause, because that run lacked browser
stderr. No browser upgrade or workaround is included, and this is not an entirely clean cold reliability gate.

## Rejected experiments and next work

- Crossing ARM/Thumb pages at cold decoded targets improved the loop kernels but lowered Doodle presentation
  rates about 5–8%. The retained policy requires observed entries.
- Broader arithmetic/conversion inlining passed differential checks but improved none of six browser workloads
  consistently, so it was removed.
- Asynchronous native engine compilation alone reduced a 64-region blocking interval from 2.85 to 2.48 ms,
  but moved readiness from 2.85 to 8.32 ms. Emission still dominated the pause; the implementation was removed.
  An off-thread compiler needs bounded instruction/epoch snapshots, relocation of runtime addresses and atomic
  installation only while every source epoch still matches. Measure added interpreter work as well as pauses.

The [negative measurements](../research/performance/2026-10-21-rejected-experiments.json) and
[implementation history](implementation-history.md) retain these findings.

A larger Java optimizing tier remains a candidate: typed SSA across calls, explicit exception edges and Java
frame states, bounded inlining, redundant checks/loads, then scalar replacement of allocations proven not to
escape. [Stadler, Würthinger and Mössenböck, CGO 2014](https://ssw.jku.at/Research/Papers/Stadler14/Stadler2014-CGO-PEA.pdf)
show how partial escape analysis can defer materialization to escaping paths. Identity, host/JNI escape,
reflection, class initialization, exception attribution and suspension must remain observable. Keep loop
outlining: long-running activations can delay the browser's optimizing tier, as documented by
[Romano and Wang, ESEC/FSE 2023](https://weihang-wang.github.io/papers/FSE2023.pdf).

Persisting receiver distributions and independently installing late code units are separate future work.
Profiles need APK/split/compiler/loader identities. Late units need relocations, existing live class globals,
dependency validation and atomic slot publication without repeating class initialization. The separation of
materialization, symbols and dependencies in [LLVM ORC](https://llvm.org/docs/ORCv2.html) is useful here, without
introducing LLVM into the browser. These architectures are not implemented by this experiment branch.
