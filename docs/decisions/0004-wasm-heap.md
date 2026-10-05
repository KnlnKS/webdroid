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
