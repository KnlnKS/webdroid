# DEX-to-JavaScript performance architecture

The retained redesign keeps the hybrid JavaScript JVM: compact preparation,
direct cold operands, bounded profiling and execution-aware hot promotion with
on-stack replacement (OSR). Seven alternating final pairs improved FitNotes
startup 4.1% and Mihon startup 14.4%; interaction CPU was effectively flat.
The four-workload geometric mean was 1.046×, above the 3% retention gate
but below the 1.5× stretch goal. These are matched Chrome measurements, not
a claim that every APK is faster.

## Runtime boundary

```text
DEX -> decode/CFG/reaching definitions -> PreparedMethod
                                      -> pooled cold handlers with direct operands
                                      -> specialized JS source at hotness threshold
                                      -> OSR at cooperative loop backedges
```

Both tiers use the same JS strings and objects, loader identity, typed
primitive arrays and BigInt longs. `src/jvm/prepared.ts` owns decoding, CFG
leaders, reaching-definition typing and opcode metadata. The emitter's opcode
switch remains the semantic source of truth. Synchronous methods reuse one
preparation for cold eligibility and immediate hot emission. Async methods
are deliberately prepared again only if promoted: retaining every cold
preparation raised Mihon heap about 5.5%, while rebuilding the small promoted
set brought it within about 0.5% of baseline.

Cold emission previously produced JS text and reparsed each instruction
with a large regex. It now maps registers, literals, properties, temporaries
and suspension directly to pooled handler operands. Per-instruction constants
preserve BigInt, signed zero, float narrowing and property semantics. The
direct-operand change reduced instrumented Mihon cold compilation about 23%;
compact preparation removed another 9–10% in that comparison.

Call-count promotion remains a fallback at entry 32. Cold execution also
counts instructions and backedges; after the default 4,096-instruction
threshold, an actual cooperative yield may transfer the live frame to a
resumable hot switch body. The handoff restores DEX registers, PC, thread
token, exception/result temporaries, suspension and fuel state. It never
occurs at an arbitrary instruction, preserving Java exceptions, re-entrant
callbacks, initialization and Promise ordering. The compiled artifact has
separate `invoke` and `resume` entries. A real DEX fixture covers long
activation, finally, double suspension, re-entry, captured entries and
admission denial. Generated specialized async source retains a shared
32 MiB admission limit.

## Diagnostics and decisions

`?jvmProfile=1` enables bounded per-method attribution; the default
allocates no per-method profile record. It retains at most 8,192 entries and
reports drops. `wd.perf` exposes aggregate phases; `wd.jvmProfile()`
exposes methods, backedges, estimated instructions, suspensions, source
bytes and tier transitions. `?jvmTier=auto|cold|js|wasm` and
`?jvmHotness=1024|4096|16384` support diagnosis. The `wasm` selection
explicitly falls back to auto: no Java Wasm backend exists.

Rejected or deferred designs were measured against the actual workloads:

- Fused cold blocks sped a long fixture about 59%, but cold dispatch used
  only about 6 ms of a 15-second FitNotes window and 27 ms in Mihon.
- A conservative numeric Wasm loop subset saw one eligible, unexecuted
  FitNotes method among 3,696 records and zero Mihon methods among 8,192.
  Mihon's generated DEX time was object/Compose/collection heavy. A Wasm
  backend would add JS boundary and compilation costs without an eligible
  application bottleneck.
- Compiler workers, shared JVM memory, cross-origin isolation and JSPI would
  cross per-realm object graphs, DOM natives, cooperative main queues and
  process IPC. No measured parallelizable bottleneck justified that change.
- A sparse cold-op array won a forced-cold microbenchmark but gained only
  about 0.5% under normal auto tiering. An analysis-skipping heuristic
  regressed Mihon startup about 0.8%. A handwritten text-rewrite replacement
  was slower than direct emission. None ships.

## Final comparison and verification

The frozen candidate and starting revision `5681101` ran in one Chrome build,
serially alternating seven pairs per workload. Interaction windows lasted
15 seconds after warmup and completed 14 inputs at a 1,003 ms cadence.

| Workload | Starting median | Final median | Result |
| --- | ---: | ---: | ---: |
| FitNotes usable state | 237.410 ms | 228.104 ms | 1.041× |
| Mihon usable state | 1,180.594 ms | 1,031.908 ms | 1.144× |
| FitNotes interaction task time | 50.466 ms/s | 50.337 ms/s | 1.003× |
| Mihon Reader task time | 377.110 ms/s | 376.654 ms/s | 1.001× |

All 196 scheduled interaction inputs completed with advancing rendering and
no page or harness error. P95 input-to-next-presentation opportunity changed
+0.90% and +0.74%, within the 5% guard; it is not causal INP. Post-GC heap
changes were within ±1%. Chrome profiles have sampling overhead, JVM phase
timers include nested/suspended work, and heap covers the inspected realm,
not all browser or GPU allocations.

Typecheck, 1,212 tests, 12 zero-failure smoke compilations, eight runnable
framework exercises and FitNotes text comparison passed. The serialized
12-flow E2E rendered 159/159 steps with no wedge; the 17-APK corpus rendered
17/17 first frames. Known YouTube, TikTok, Lichess and optional SDK
diagnostics remained, so this gate establishes regression coverage rather
than full app compatibility.
