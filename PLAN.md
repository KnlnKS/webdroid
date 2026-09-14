# DEX-to-JavaScript performance redesign — completed

Starting revision: `5681101`. Integration branch: `codex/dex-performance-redesign`.
The retained runtime improves the four-workload geometric mean by **1.046x**. This
misses the 1.5x stretch goal but clears the 3% aggregate retention gate without
crossing any primary, p95-latency, heap, rendering, or diagnostic regression gate.

## Retained design

- Bounded, off-by-default JVM phase/method profiling exposed through `wd.perf` and
  `wd.jvmProfile()`, with diagnostic tier and hotness controls.
- Compact prepared methods with ordered decoded instructions, byte-array block
  leaders, reaching-type annotations, and numeric opcode metadata.
- Direct cold-operand emission instead of reparsing generated JavaScript with a
  source regex. Cold handlers remain pooled and source admission remains bounded.
- Instruction/backedge heat in addition to entry counts. Long activations can OSR
  at an actual cooperative-yield backedge into the existing verified hot switch
  emitter. The calibrated default threshold is 4096 instructions.
- No runtime dependency, cross-origin isolation, executable cache, worker, or
  persistent profile is added.

## Measured result

Seven serial alternating Chrome pairs compare the frozen candidate with the exact
starting revision. Interaction windows run for 15 seconds after warmup, with all
196 scheduled inputs completed and advancing rendering.

| Workload | Start | Final | Speedup |
| --- | ---: | ---: | ---: |
| FitNotes first usable state | 237.410 ms | 228.104 ms | 1.041x |
| Mihon first usable state | 1180.594 ms | 1031.908 ms | 1.144x |
| FitNotes History/Graph CPU | 50.466 ms/s | 50.337 ms/s | 1.003x |
| Mihon Reader CPU | 377.110 ms/s | 376.654 ms/s | 1.001x |

FitNotes/Mihon interaction CPU improves 0.26%/0.12%; p95 opportunity latency
changes +0.90%/+0.74%; heap changes +0.14%/-0.66%. Startup heap changes
+0.12%/-0.91%. The final E2E rollup independently records 21–30% lower compiler
time across every Java-heavy flow.

## Rejected or deferred

| Experiment | Decision |
| --- | --- |
| Sparse cold-PC array | About 12% in forced-cold Mihon, about 0.5% in normal auto tier; below the aggregate gate. |
| Type-analysis skip | 10–12% phase reduction but about 0.8% slower Mihon startup. |
| Handwritten cold source pooler | Slower than the starting regex path; direct operands supersede it. |
| Retained async preparation | Raised Mihon retained heap about 5.5%; preparation is rebuilt only for promoted methods. |
| Structured/fused control flow | Prior long-loop component win did not qualify at application level; current cold-dispatch samples are below the 15% gate. |
| Numeric Wasm and compiler workers | Eligible observed DEX CPU is 0%, below the 10% feasibility gate. |
| Shared JVM memory / JSPI | No 20% parallelizable bottleneck and no qualifying coarse Wasm transition; cross-origin compatibility is not put at risk. |

## Verification

- `bun run typecheck`: pass.
- `bun run test`: 1212 tests / 26483 assertions pass.
- Twelve eager/cold smoke compilations across FitNotes, Mihon, Resy, Doodle,
  Flappy Bird and Lichess: zero failed methods.
- `bun run fwtest`: eight runnable exercises pass; declared coverage 295/363.
- FitNotes text comparison: 6/6.
- Serialized E2E: exit zero, 12 flows / 159 steps; FitNotes 39/39 and Mihon app
  17/17 rendered, with no diagnostics in either scored app.
- Corpus: 17/17 APKs render a first frame; FitNotes and Mihon have zero reached gaps.
- Full per-step/process diagnostics reproduce only recorded non-DEX limitations;
  no flow wedges and no new fault family appears.

Architecture, external research, phase attribution, rejected measurements and
evidence limits are in [docs/dex-performance-architecture.md](docs/dex-performance-architecture.md).
Historical mechanisms remain in [docs/implementation-history.md](docs/implementation-history.md).
