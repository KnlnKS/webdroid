# Cold slow runtime and snapshot handoff

2026-10-05. Implemented in the recovery checkout on `a7ba7885` (the cherry-pick
of `58cfa5d9`), after G2 handoff `a1e4f398`. Parent cold/main files were read only.
No later parent G4, CHA or S5 source is included in this test epoch.

## Runtime

The shared GC Wasm loop continues to execute numeric/control instructions without
per-instruction JavaScript. It stops before a slow opcode. `ColdSlowOps` executes
that opcode through the canonical MC emitter, Compiler linkage and World call
helpers, then commits its register/result definitions only after success. Typed
DEX catches use canonical instance-of predicates in declared order; unmatched
Java exceptions propagate unchanged. Host/compiler errors remain host errors.

Object/field/array operations, casts, constants, direct/static/super and dynamic
virtual/interface invokes, throw, explicit monitors, class initialization and
JSPI waits use existing platform semantics. String allocations retain internal
uninitialized identities until the canonical constructor factory supplies the
actual reference and all register aliases are committed.

Preparation/typing is cached per method. Adapter inputs are only the instruction's
used register webs. Native imports are declared before reserving synthetic code,
which preserves canonical String constructor factories. Virtual/interface slow
calls use current dynamic slots rather than copied CHA callees.

The bridge preserves logical frame depth across fresh JSPI engine stacks. It also
preserves a partially constructed Thread peer before binding, and a peer newly
bound by the first currentThread call. Without those two cases, fresh-stack entry
recursed through Thread construction or subsequent currentThread calls returned a
different peer. Scheduler budget yielding bounds nested bridge stacks; synchronous
host Java entries use a plain bridge rather than trying to suspend through JS.

Cold traces carry MethodInfo and activation DEX PCs. Throwable capture freezes
those PCs immediately so later execution does not change an earlier stack.

## Canonical snapshot contract for compiled resume

`src/wasm/cold/state.ts` exports `ColdSnapshot` and `validateColdSnapshot`.
`World.validateColdSnapshot(state, owner)` adds method/World/strand identity,
canonical monitor depth and ordered typed-handler validation. Compiled resume
must call this same World validator **before effects**, rather than copy its checks.

- `pc` is the next DEX instruction; `executedPc` is the last attempted instruction.
- `bits` preserve raw numeric bits; `references` and `kinds` preserve opaque Java references.
- `depth` is the caller's logical depth before the cold activation's own charge.
  Compiled resume replaces that charge; it must not count both frames.
- `sync` records whether the entry is beneath synchronous Java/host frames.
- A pending `result` identifies its producer PC, ABI kind and raw value. Its
  producer must be a valid invoke/filled-new-array whose successor is exactly
  `pc`, with `executedPc` equal to that producer. The next instruction must be
  compatible move-result. A same-kind result from another invoke is rejected.
- A pending exception identifies the fault PC and the same Throwable; the next
  instruction is its selected move-exception. Throwing instructions preserve
  destination registers.
- Explicit held monitor counts remain owned by the original strand; the bytecode
  finally/catch-all releases them. Resume must not reacquire them.
- Uninitialized String alias records travel with the registers.
- In-flight operations cannot be snapshotted or transferred. `transfer` retires
  the old activation before another implementation owns its committed state.

Active compiled resume/OSR remains Gauss's integration work. This runtime does not
claim to install or validate his compiler entry implementation.

## Executed checks and evidence limits

Outputs: `conform-cache/cold-review/` in the recovery checkout.

- `bun run wasm cold-slow`: 140 checks, 55 interpreted methods / 491 activations.
  Real Java/JDK comparisons plus asynchronous native completion and failure,
  20 contended suspended monitor calls, recursive suspension, pending-result and
  exception restoration, invalid producer/cursor rejection before register writes,
  monitor ownership and unsupported-constant preflight. Output `slowops.log`.
- Numeric interpreter: 1,290 JS/JDK comparisons at budgets 1/7/4096 with snapshot
  transfers; linked recursive invokes also execute through the bridge. `numeric.log`.
- Cold `classdiff`: 33/33; eight known JS-tier divergences reported. `classdiff.log`.
- Cold `customdiff`: 375/375, zero threw. `customdiff.log`.
- Cold core differential: 1,105/1,105 across 75 methods. `diff.log`.
- Selected cold threads: 11/11, including initialization race/cycle/failure,
  reentry, deep monitors, contention, ping-pong, start/join and caught stack overflow.
  `threads.log` reports the two existing JS stack-overflow divergences.
- Typecheck passes; output `slowops-typecheck.log`.

The fixture reports 179 adapters, 175 module constructions, 1,049 slow calls,
384 waits, 54 typed methods and 2,816 snapshot register copies. These are work
counters, not evidence of lower latency, memory use or an idle performance win.

Cold remains opt-in. True implicit ACC.SYNCHRONIZED bodies compile before entry;
D8 DECLARED_SYNCHRONIZED bodies containing explicit monitors use this bridge.
const-method-handle/type preflight falls back before effects, retaining the
canonical compiler's unsupported behavior. No new opcode is labeled supported
while discarding its register. Other existing compiler gaps remain explicit.

One module per executed slow PC, whole-method typing on first slow use, and full
register copies at each slow boundary can cost more than whole-body compilation
for object-heavy methods. Batching modules/shared adapters is future measured
work. No broad G2, browser capture or performance rerun was performed here.
