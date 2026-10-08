# 0004: retain Wasm GC while closing the execution gates

Status: provisional decision, 2026-10-05, recovered base `1d7fdeea`.

The Wasm backend continues with engine-managed GC. This records the G8 decision;
it does not pass the unresolved G1 criteria or authorize the S6 default switch.

The research allocation kernels favor engine GC over the experimental linear-memory
mark-sweep collector when live objects are retained. The later compiler measurements
in [the backend plan](../wasm-backend-plan.md), sections 4.10 and 4.16, show a
steady-state geometric mean above G1's 1.3x bar, with individual workload losses and
slower Chrome first calls. These measurements were taken on shared hosts and require
an idle-host repeat before final acceptance.

The recorded losses include copying between GC arrays and native memory, String
allocation compared with JS ropes, locking and fuel checks, module loading and
compilation. Moving the entire heap would require a collector, barriers and root
tracking. No measurement establishes that this would close the first-call and
per-workload gaps. Direct buffers already use native linear memory; this targeted
boundary remains available without replacing the heap.

If corrected measurements identify GC layout or collection as the cause of a failed
gate, compare the linear-memory alternative on that workload with identical Java
semantics, live-heap pressure and completed rendering. Record the result here before
changing the object model. The user's ordering puts the conditional linear-memory
stage and optional extensions after the main stages and gates; this decision does
not start that work.

The 2026-10-07 primary-protocol repeat on production `87facb0e` completes all 74 workloads correctly but fails G1: primary-ten steady means are 0.633x in Node and 0.571x in Chrome; Chrome first-call mean is 0.281x. Source/assets are guarded, while continuous CPU-owner utilization is absent. These measurements supersede the earlier steady-state optimism for this source. They do not attribute the losses to the GC heap. Measure actual symbolic/host crossings, native field and boxing paths, and compile/tier-up work before changing the object model. Raw commands/results and qualification are in `/tmp/webdroid-final-gates-87fac/handoff.json`.

The 2026-10-08 full corrected-loader run on `354c6903` validates 149,480 calls but still fails G1: primary-ten steady means are 0.793× Node and 1.048× Chrome, with individual losses and slower first calls. Its sampled background CPU activity prevents idle-host acceptance. These results use production bootstrap/application ownership; earlier flattened-loader timings are not a causal control. No heap attribution follows. Promotion/callee selection and compiler costs remain the next measured investigations before reconsidering the object model. Evidence: `/tmp/webdroid-g1-symbolic-names/`.
