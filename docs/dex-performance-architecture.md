# DEX-to-JavaScript performance architecture

## Outcome

This redesign keeps Webdroid's hybrid JavaScript runtime and removes work from its
cold path. The retained implementation has four parts:

1. bounded, off-by-default phase and method profiling;
2. a compact `PreparedMethod` shared by cold and immediate hot emission;
3. direct cold operands, replacing source-text reparsing;
4. instruction-aware promotion with on-stack replacement (OSR) at yielded loop
   backedges.

The strongest isolated result is Mihon cold compilation: direct operands reduce
the measured compilation phase by about 23%, and compact preparation removes a
further 9–10% in the instrumented comparison. Seven final pairs improve FitNotes
startup by 4.1% and Mihon startup by 14.4%.

The 1.5x balanced target remains a stretch goal. No backend is retained merely
because it wins a microbenchmark. Wasm, compiler workers, persistent generated
code, structured cold blocks, speculative inlining, and cross-origin isolation
are not part of the shipped runtime because their eligibility or application
gates were not met.

## Runtime pipeline

```text
DEX CodeItem
    |
    v
decode -> compact ordered instructions -> CFG leaders -> reaching definitions
                                             |
                         +-------------------+-------------------+
                         |                                       |
                         v                                       v
              shared cold handlers                    specialized JS source
              + per-op constants                      + V8 compilation
                         |                                       |
                         +----------- hotness / OSR -------------+
                                             |
                                             v
                                  existing JS object graph,
                                  natives, DOM and Android shell
```

The cold and hot tiers deliberately share JavaScript values: strings stay JS
strings, objects retain their existing loader identity and property layout,
primitive arrays remain typed arrays, and `long` remains `BigInt`. That makes
promotion a control-transfer problem rather than an object-marshalling problem.
It also avoids a JS/Wasm boundary around the object-heavy Android and Compose
work seen in the scored profiles.

## Observability

`?jvmProfile=1` enables a bounded profiler. Production defaults are unchanged;
disabled profiling performs no per-method record allocation. The profile records
at most 8,192 methods and reports dropped records rather than growing without
bound. `wd.perf` exposes aggregate phase counters, while `wd.jvmProfile()` returns
method entries, backedges, executed instruction estimates, suspensions, source
bytes, tier transitions, and phase timing.

Diagnostic controls are:

- `?jvmTier=auto|cold|js|wasm` — `wasm` is an explicit unavailable request and
  falls back to `auto`; it does not claim a backend exists.
- `?jvmHotness=1024|4096|16384` — selects the calibrated instruction threshold.
- `?jvmProfile=1` — enables bounded JVM attribution.
- `scripts/perf-browser.ts --cpu-profile` — writes a Chrome `.cpuprofile` beside
  the ignored JSON result for a deterministic interaction window.

The existing performance runner owns these controls. No second timing harness or
committed trace format was introduced.

The profiler distinguishes decode, CFG construction, reaching-definition/type
analysis, cold-handler construction, hot emission, `new Function`, class linking,
cold execution, hot execution, and suspension. Cold duration includes nested and
suspended work, so `suspendMs` must be subtracted before treating it as active
time. This is diagnostic attribution, not a replacement for Chrome CPU sampling.

## Compact preparation

`src/jvm/prepared.ts` owns DEX instruction decoding and opcode metadata. Decoded
instructions live in one ordered array; each record contains the PC, numeric
opcode, decoded operands, argument-register list, wide literal, and the two
reaching-definition annotations required for floating constants and null
receivers. Block leaders use one byte per DEX code unit instead of a `Set` of
boxed numbers.

The preparation boundary removes decoder detail from the emitter and replaces
the hottest name-regex classifications with numeric, total opcode metadata:
block termination, destination-register writes, potential suspension,
float/double consumers, and conservative Wasm-region eligibility. The emitter's
large opcode switch remains the semantic source of truth.

Preparation is idempotent. Synchronous methods reuse one preparation for their
cold eligibility decision and immediate JS emission. Async methods reuse it for
cold-handler construction. A promoted async method is deliberately prepared
again: the first OSR prototype retained preparation for every cold method and
raised Mihon retained heap by about 5.5%. Rebuilding only the small promoted set
returned heap to within about 0.5% of baseline. This is an intentional exception
to universal cross-tier reuse, selected by application memory evidence.

## Direct cold operands

The previous cold backend emitted hot-style JavaScript strings and then used one
large regular expression to rediscover registers, temporaries, properties,
numbers, strings, and `BigInt` literals. It reparsed every cold instruction even
though the emitter already knew each operand's kind.

The retained emitter now selects operands directly:

- registers become `F.v[K[n]]`;
- literals and property names enter the instruction's constants array;
- cold temporaries map directly to frame fields;
- suspension emits a generator `yield` as the instruction is built;
- hot emission continues to produce local variables and direct properties.

Cold handlers are still pooled by body, preserving the low code-source footprint.
Constants stay per instruction, preserving exact `BigInt`, signed-zero, float
narrowing, and property semantics without parsing generated source.

Seven phase-decorrelated FitNotes interaction pairs against the preceding OSR
stage show median main-thread task time 46.04 -> 40.04 ms/s (-13.0%), p95
input-to-presentation opportunity 10.7 -> 10.6 ms (-0.9%), and retained heap
173.33 -> 172.59 MB (-0.4%). The per-window median opportunity moved 5.4 ->
6.5 ms; that unfavorable secondary measure is retained as an evidence limit.
All windows completed 14/14 inputs with unchanged presentation rate and no errors.

Three Mihon Reader pairs show main-thread task time 380.40 -> 381.28 ms/s
(+0.23%), p95 opportunity 57.2 -> 53.7 ms (-6.1%), and heap 361.69 ->
356.93 MB (-1.3%). All inputs and frames completed. This differs from the older
rollback evidence because the current comparison includes execution-aware OSR,
uses the corrected phase-decorrelated harness, and independently remeasures the
exact source change.

## Execution-aware promotion and OSR

Call-count promotion remains the fallback at entry 32. Cold execution also counts
instructions and observes backedges. At an actual cooperative-yield boundary, a
method that crosses the configured threshold may compile a resumable version of
the verified hot switch body and transfer the active frame.

The OSR handoff restores all DEX registers, PC, thread token, suspension state,
exception value, invocation result temporaries, and pending fuel state. Promotion
does not occur at arbitrary instructions. The existing fuel/refuel boundary is
the safe point, so Java exception ranges, re-entrant native callbacks, class
initialization, and Promise suspension keep their previous ordering.

The fixed threshold grid was 1,024, 4,096, and 16,384 instructions. Startup was
neutral across the grid; 4,096 was the lowest stable threshold without a retained
heap or primary-workload regression. It is the default. A real DEX fixture covers
one long activation, OSR state transfer, exceptions/finally, double suspension,
native-to-Java re-entry, captured direct/interface entries, and admission denial.

This policy follows the same broad principle as ART: profiling should move useful
work between interpreted and compiled states, and OSR is a distinct capability of
the JIT tier. ART also bounds/profile-collects opportunistically rather than
guaranteeing every event is recorded ([ART JIT documentation](https://source.android.com/docs/core/runtime/jit-compiler)).
CheerpJ independently demonstrates that a browser JVM can profitably interpret
first and JIT optimized JavaScript later while retaining unmodified bytecode and
class-loader behavior ([CheerpJ 3 architecture](https://labs.leaningtech.com/blog/cheerpj-3-deep-dive)).

## Rejected and deferred architectures

### Structured and fused control flow

An earlier controlled implementation fused resumable cold blocks and made a long
cold-loop fixture about 59% faster, but it failed to produce a qualifying
application improvement and was removed. Current Chrome samples give `runCold`
only about 6 ms in the 15-second FitNotes window and 27 ms in Mihon. That is far
below the plan's 15% dispatch threshold. The verified switch emitter therefore
remains the hot and OSR backend; no dormant structured emitter ships.

This is consistent with v86's useful lesson rather than a literal design copy:
compile bounded hot regions, keep fallback paths, and let runtime evidence choose
regions ([v86 architecture](https://github.com/copy/v86/blob/master/docs/how-it-works.md)).
QEMU TCG similarly treats translation blocks and state restoration as explicit
correctness boundaries ([QEMU translator internals](https://www.qemu.org/docs/master/devel/tcg.html)).

### Wasm numeric regions

The conservative eligibility subset allows only primitive signatures, constants,
moves, numeric conversion/arithmetic, comparisons, branches, and returns in a
loop without DEX exception regions. It excludes objects, arrays, fields,
allocation, invocation, monitors, suspension, and Java exceptions.

FitNotes records one eligible 11-instruction method among 3,696 methods, but that
method executes zero instructions in the scored interaction. Chrome attributes
only 18.6 ms (0.12%) of the 15.2-second FitNotes CPU profile to generated DEX JS.
Mihon records zero eligible methods among the bounded 8,192 records. Chrome does
attribute 3,478 ms (22.4%) of the Mihon window to generated DEX JS, but its hot
samples are `ScatterMap`, Compose layout/recomposition, coroutine dispatch,
object checks, and property-heavy collection code. Eligible observed DEX active
share is 0% in both workloads, below the required 10%.

No Wasm backend or worker batcher was therefore implemented. Even if eligible
code existed, Wasm has its own tiering costs: V8 uses a fast baseline compiler and
later optimizing compilation, so boundary and compilation cost cannot be assumed
away ([V8 Liftoff](https://v8.dev/blog/liftoff)). JavaScript itself also has a
mid-tier optimizing compiler, strengthening the case for keeping object-heavy
methods in JS ([V8 Maglev](https://v8.dev/blog/maglev)).

### Workers, shared memory, and JSPI

A compiler worker cannot improve a workload with no qualifying compile batch, and
moving JVM execution would cross the existing per-realm object graph, DOM-facing
natives, cooperative main queue, and process IPC. No worker runtime ships.

Shared JVM memory would require cross-origin isolation and `SharedArrayBuffer`.
Cross-origin isolation changes opener/resource behavior and requires compatible
COOP/COEP delivery ([Chrome isolation guidance](https://web.dev/articles/cross-origin-isolation-guide)).
The sampled evidence does not show the required 20% parallelizable bottleneck, so
WebView, proxy resource, popup/OAuth, and IPC compatibility were not put at risk.

JSPI is also not an instruction-loop shortcut. Its design adapts coarse Promise
transitions across the JS/Wasm boundary; Webdroid needs precise cooperative state
at Java calls, class initialization, fuel exits, and re-entry
([V8 JSPI design](https://v8.dev/blog/jspi)).

### Other rejected experiments

- Replacing `Map<pc, ColdOp>` with a sparse JavaScript array improved a forced-cold
  Mihon component window by about 12%, but normal auto-tier execution improved
  only about 0.5% and the four-workload aggregate did not clear 3%.
- Skipping reaching-definition analysis for apparently irrelevant methods reduced
  that phase by about 10–12%, but Mihon startup regressed about 0.8%; it was
  removed because the safety heuristic did not earn an application-level win.
- A handwritten single-pass replacement for cold-source rewriting was slower
  (about 455 vs 428 ms cold construction). Direct emission superseded it.
- Retaining prepared async methods for later promotion raised heap about 5.5%.
  Promotion now rebuilds only on demand.

## Compatibility and evidence limits

Application and framework DEX remain unchanged. The redesign does not alter
class-loader identity, native registration, Java value representation, exception
matching, frame scheduling, source admission limits, or process isolation. It adds
no runtime dependency, executable cache, storage schema, cross-origin header, or
production worker.

## Final four-workload score

The frozen candidate was compared with starting revision `5681101` in the same
Chrome build. Runs were serial and alternating, with seven pairs per workload.
Interaction windows were 15 seconds after a three-second warmup and issued 14
inputs at a 1,003 ms cadence.

| Workload | Starting median | Final median | Speedup |
| --- | ---: | ---: | ---: |
| FitNotes first usable state | 237.410 ms | 228.104 ms | 1.041x |
| Mihon first usable state | 1,180.594 ms | 1,031.908 ms | 1.144x |
| FitNotes History/Graph main-thread task time | 50.466 ms/s | 50.337 ms/s | 1.003x |
| Mihon Reader main-thread task time | 377.110 ms/s | 376.654 ms/s | 1.001x |

The geometric mean is **1.046x**. This misses the 1.5x stretch goal but clears the
3% aggregate retention gate. No primary workload regresses: FitNotes interaction
CPU improves 0.26% and Mihon improves 0.12%. Their p95 opportunity latency changes
+0.90% and +0.74%, within the 5% guard. Post-GC heap changes are FitNotes startup
+0.12%, Mihon startup -0.91%, FitNotes interaction +0.14%, and Mihon interaction
-0.66%. All 196 scheduled interaction inputs completed, all
windows remained visible/alive with advancing rendering, and no harness or page
error was observed.

FitNotes startup median absolute deviation is 2.95 ms at the start and 2.23 ms
in the candidate; Mihon is 4.03 and 10.27 ms. FitNotes interaction CPU MAD is
0.61 and 0.43 ms/s; Mihon is 0.84 and 1.25 ms/s. Every sample remains in the
reported result.

The interaction proxy is input-to-next-presentation opportunity, not causal INP
or physical display latency. Chrome profiles carry profiler overhead and their
generated-source URL samples are statistical. JVM phase timers are inclusive at
nested calls and their 0.1 ms resolution makes tiny method entries noisy. The
8,192-record Mihon cap reports drops explicitly. Heap figures cover the inspected
realm's post-GC heap, not every browser/GPU/process allocation.

The final decision uses serial alternating runs in one Chrome build, fixed app
flows, advancing ticks/presentations, complete inputs, and raw results outside the
repository. No favorable sample is selected, and negative experiments remain only
as measurements in the implementation history.

## Integrated verification

Production code was frozen before the broad checks. Typecheck and 1212 tests /
26483 assertions pass. Twelve eager/cold smoke compilations across FitNotes,
Mihon, Resy, Doodle, Flappy Bird and Lichess have zero failed methods. All eight
runnable framework exercises pass (295/363 delegates declared; Canvas text
metrics require a browser), and the FitNotes text comparison passes 6/6.

The serialized E2E run exits zero after 12 flows / 159 steps. FitNotes renders
39/39 steps and Mihon app renders 17/17 with no new missing APIs, Java/page
errors, native requirements, or layout/draw/GL errors in either flow. No flow
wedges. The 17-APK corpus renders a first frame for 17/17 APKs; FitNotes and Mihon
reach zero missing APIs.

The E2E `perfsum` comparison uses the starting runtime capture. Flow duration is
not a primary score because it includes configured settling and live/native work,
but the compiler counters corroborate the redesign across every Java-heavy flow:
FitNotes -21%, Mihon app -27%, Mihon onboarding -28%, Calculator -24%, Harmonic
-26%, Reddit -27%, Resy -23%, YouTube -28%, TikTok -30%, Lichess -28%, Flappy
-30%, and Doodle -22%.

Non-scored diagnostics reproduce the starting runtime's recorded limitations:
Window sidecar/extension gaps, YouTube Matrix/SAX/cursor failures and two control
settle timeouts, TikTok layout/native log failures, Lichess pthread/Stockfish
faults, optional Reddit SDK gaps, and the existing status TypeError attributed to
the following Flappy capture. These flows establish regression coverage, not
complete Android compatibility or successful app initialization.
