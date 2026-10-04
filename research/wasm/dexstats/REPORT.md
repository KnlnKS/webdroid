# DEX corpus statistics for a possible DEX -> WebAssembly backend

Scope: research only. Nothing under `src/` was changed. All scripts live in `research/wasm/dexstats/`
and load DEX through the repo's own parser (`src/jvm/dex.ts`, `prepared.ts`, `opcodes.ts`,
`structure.ts`; the zip/APK opening is `zipTree` + `openInstall`, the same path `scripts/lib.ts` uses).

Corpora (9): `framework` = `vendor/aosp/framework.jar`; `core-oj`, `core-libart` = the two boot jars of those names;
`boot-other` = the other 37 `vendor/aosp/boot/*.jar` pooled; apps = `mihon` (mihon-v0.20.4.apk), `fitnotes`
(FitNotes.apk), `harmonic` (harmonic.apk), `newpipe` (org.schabi.newpipe_1015.apk), `komikku`
(Komikku-arm64-v8a-v1.14.1.apk). 704,430 methods with code in total.

## Reproduce

```bash
cd research/wasm/dexstats        # run FROM HERE: the repo-root bunfig.toml preload builds generated blobs
                                 # outside research/; the empty bunfig.toml here avoids it
bun run.ts                       # all 9 corpora -> out/<corpus>.json (about 16 s, one process)
bun run.ts --only fitnotes,core-libart      # subset;  --limit N caps methods per corpus
bun tables.ts > out/tables.md    # the tables below
bun crosscheck.ts apks/FitNotes.apk         # const typing vs the repo's own annotateConstants
bun dbg.ts apks/FitNotes.apk 'LA/c;.p'      # disassembly + inference result of one method
bun undet.ts apks/FitNotes.apk 5            # methods that keep an unconstrained web
```

Files: `load.ts` (open jars/apks), `infer.ts` (statistics over the type inference), `cha.ts` (class hierarchy), `run.ts` (driver),
`tables.ts` (renderer). The analyses they build on are in `../j2w/`: `opinfo.ts` (opcode families, ART "can throw" table), `cfg.ts` (blocks, exception
edges, Hecht-Ullman reducibility), `infer.ts` (the live-range type inference the compiler uses). Raw numbers: `out/*.json`; this file's tables are `out/tables.md` verbatim.

## Summary of decision-relevant numbers

FACTS (measured on these corpora):

1. Type inference: 704,430 / 704,430 methods (100%) infer with zero merge conflicts; 99.5-99.9% per corpus are also
   fully determined (every live range has exactly one kind). The remainder is 0.02-0.31% of live ranges (T6).
2. 14.8-29.8% of vregs hold >= 2 kinds at different points (33-55% of methods have at least one such vreg), so a
   vreg is NOT a stable type; only 5-9% of those are due to const-0 ambiguity alone.
3. Wasm locals per method if each (vreg, kind) gets its own local: mean 3.9-6.0, median 3-4, p99 18-41, max 263
   (framework) / 420 (mihon, komikku). That is +4% (framework) to +29% (harmonic) over treating every vreg as an
   untyped i32 slot (mean 3.3-4.7). One local per live range: mean 7-14, max 6,278 (T7).
4. Leaf (no invoke) methods: 13.4-25.2% of methods; numeric-only leaf (no alloc/throw/monitor/object ops): 5.5-13.9%;
   register-only leaf (no field/array either): 1.9-8.7%. These hold only 0.6-2.1% (numeric) / 2.4-5.9% (leaf) of
   code bytes. 29-48% of methods have <= 4 instructions (T3, T3b).
5. Method sizes: median 18-36 B, p99 0.4-1.1 KiB; > 1 KiB: 0.1-1.1% of methods; > 8 KiB: 0-31 methods per corpus;
   > 64 KiB: none; largest 39,616 B (a `<clinit>` data table) (T10).
6. Irreducible control flow exists but is rare: 0-0.21% of methods with precise exception edges. The repo's
   `Flow` structurer falls back to the dispatch loop for 0-0.5% of the methods it is tried on, almost all Kotlin
   `invokeSuspend` state machines (mihon 171, komikku 196); framework 8 ("too deep", AIDL `Stub.onTransact`) (T11).
7. 4-13.5% of methods have a try; 41-74% of try items are catch-all; `RemoteException`, `Exception`, `IOException`,
   `NoSuchFieldError` are 54% of typed clauses (T4, T4b). Dex try ranges are flat/disjoint: there is no nesting to read.
8. Invokes: virtual 42-58%, interface 6-12%, static 16-27%, direct 15-26%, super ~1%, polymorphic/custom < 0.4%.
   By class-hierarchy analysis over the loaded set, 82-90% of invoke-virtual sites have a statically known target
   (final class / final method / exactly one implementation); invoke-interface is mostly polymorphic (47-85% have 3+
   implementations). Callee in same class 8-25%, same package 21-49%; 35-56% of an app's callees (28% for framework) live outside its own dex (T12-T14).
9. Cost of the analysis: ~2-4 us per method median, 5-10 us mean, 26-53 ms per MiB of dex (indicative, T8).

INFERENCE / INTERPRETATION (not measured, see section "Reading the numbers"):

- A per-kind local split is cheap enough that a typed-locals Wasm backend does not need a verifier-grade type lattice
  beyond {i32, f32, i64, f64, ref}; the only unresolved input is array element kind for 32-bit `aget`/`aput`.
- Most methods are tiny, so per-call overhead (frame, exception edge, JS/Wasm boundary) matters more than local count.
- The CHA numbers are an upper bound for a closed-world compiler; webdroid loads classes lazily so any use needs guards.

## Method and definitions

Type inference (`infer.ts`) is a live-range ("web") analysis, not a forward lattice with a join per vreg:

1. Every definition (parameter or instruction) is a node. Liveness is computed per block, with exception edges
   from each throwing instruction to its handlers carrying that instruction's PRE-state.
2. At a join the nodes of every LIVE register are unioned, so a web is a maximal live range. (A dead register does not
   merge, which is what makes reuse of one vreg for different kinds visible as separate webs.)
3. Each node carries a bitmask of allowed kinds {I = boolean/byte/short/char/int, F, R = reference or null, J, D}.
   Defs and uses AND their opcode-implied masks in: arithmetic and conversions, array ops, field types (`dex.field`),
   invoke arguments and `move-result` types from the proto, `return` from the method descriptor, `new-array` size,
   `if-eqz` and switch operands. `const` (non-zero) = I|F; `const 0` = I|F|R; `const-wide` = J|D. Moves and `if-eq/ne`
   ties link kinds without merging live ranges.
4. A component whose mask reaches 0 is a "true merge conflict". A used web that keeps more than one bit is
   "underdetermined". Everything else is determined.
5. Reference classes are NOT tracked (optional per the brief), so a plain 32-bit `aget`/`aput` is I|F and the array
   element type is not used to decide it.
6. ART's flow rules are modelled where they matter: `return*` is not a throwing instruction (it carries no handler
   edge), and non-throwing ops (moves, consts, goto, cmp, int/float arithmetic except div/rem) add none either. Treating
   `return` as throwing created 98 false conflicts in framework.jar, all the pattern `const v, 1; return v` inside a
   synchronized region whose catch-all handler does `monitor-exit` on the same register. This is a modelling lesson,
   and shows that conflicts are detected (the check is not vacuous).

Wasm local counts: (A) = DEX frame registers (every vreg an untyped i32, wide = 2 slots); (B) = i32 per vreg but one
i64 per wide pair; (C) = distinct (vreg, kind) pairs, a wide value counted once, ambiguous webs placed on an existing
kind of that vreg when they can; (D) = one local per live-range web (upper bound; register allocation would merge them).

Multi-kind vreg = a vreg whose used webs resolve to >= 2 different kinds. "Only because of zero" = it has <= 1 kind
once webs containing a `const 0` def are ignored.

CFG: reducibility is the Hecht-Ullman test (every DFS retreating edge must have a dominating head). Mode A uses the
repo's `Flow` view (entry plus every handler as extra roots, no edges into handlers); mode B adds exception edges
from each throwing block to its handlers with the entry as the only root (the semantically exact graph). `Flow` itself
(`src/jvm/structure.ts`) is run unmodified on every method that has more than one block or a try. Production only
structures hot entry bodies, so these are rates over all methods, an upper bound for the hot subset.

CHA (`cha.ts`): for `invoke-virtual/interface` the receiver's static class is the method ref's class. A site is
"final class" (class_def ACC_FINAL), "final method" (declared final up the chain), else the number of distinct
non-abstract implementations reachable from the loaded concrete subtypes (capped at 3). The loaded set is
framework.jar + all boot jars (+ the app's own dex for app corpora).

## Cross-validation of the inference (fact)

`crosscheck.ts` compares this prototype's resolution of every `const`/`const-wide` against the repo's own constant typing
(`annotateConstants`, `constKind` F/D in `prepared.ts`):

| corpus | float consts (repo) | float consts (mine) | agree | double consts (repo / mine / agree) |
|---|---:|---:|---:|---|
| FitNotes | 410 | 407 | 407 | 250 / 250 / 250 |
| harmonic | 3,194 | 3,151 | 3,149 | 259 / 259 / 259 |
| mihon | 12,427 | 12,412 | 12,411 | 1,931 / 1,931 / 1,929 |
| core-oj | 118 | 117 | 117 | 163 / 162 / 162 |
| framework | 4,320 | 4,241 | 4,238 | 998 / 998 / 998 |

I never claim a float the repo does not; I miss 0.1-1.8% of its float consts, always as an unconstrained I|F web
(the const reaches only an `aput` into a float[] or a move chain ending there; the repo resolves these through array
element kinds that this prototype does not track). So the two analyses agree wherever mine commits.

## Reading the numbers (inference, with caveats)

- "100% no conflict" is a property of verified bytecode plus a deliberately permissive mask for moves/ties; it says
  the DEX can always be given a consistent kind per live range, not that a naive per-vreg typing works. The naive
  per-vreg typing fails for 33-55% of methods (T6 multi-kind row): d8/R8 reuse registers across kinds freely.
- Const-0 is not the main source of multi-kind vregs (5-9%); ordinary register reuse is. A const-0 web is still
  semantically two values (int 0 and null); if refs and ints sit in different Wasm locals, the def must be
  materialised per use-kind. T6 shows 85k such webs in framework (about 5% of webs).
- Underdetermined webs: all sampled cases are an int/float constant whose only consumer is a 32-bit `aput`/`aget`
  or a compare (`LA/c;.p` in FitNotes: `const/4 v0, 1; aput v0, v1, v2`). Array element types would resolve them.
- Wasm limits (not measured here; engine facts from memory, verify before relying on them): V8 allows 50,000 locals
  and a 7.6 MB function body; engines also apply per-function tier-up heuristics. The largest method here has 6,278
  live-range webs / 420 split locals and 39,616 B of dex, well inside those, so size limits would only bite after
  inlining. A handful of per-corpus `<clinit>` and table-builder methods (T10c) are the only large ones.
- The structurer result (T11): 39.9% of framework methods Flow-structured have > 1 region, exactly the methods with
  a try, since each handler starts a region joined by the `pc` dispatch; for Wasm this corresponds to needing a
  try/catch or exception-dispatch construct, not a general CFG fallback.
- Irreducible methods (mode B, 0-0.21%) are concentrated in Kotlin `invokeSuspend`/coroutine state machines and a
  few AOSP loops with entry from handlers. A Wasm backend needs a loop-plus-`br_table` fallback (Relooper style) for
  them; at this rate it is a rarely taken path.
- Call-graph: 52-70% of direct/static callees with code in the same corpus are <= 16 code units and 4-32% are leaves,
  so small-callee inlining would remove a large fraction of calls. This is a possibility, not a measurement of speedup.
- The timings are one warm Bun process on a laptop, single run, decode excluded (instructions are pre-decoded and passed
  in; CFG build, liveness and union-find are included). Do not treat them as benchmarks.

## Limits of this study

- Static counts only; no execution weighting (hot methods are surely not a uniform sample of these).
- Reference classes are not inferred; CHA uses the method ref's declaring class as the receiver type, which is the
  static type javac/d8 emitted but can be less precise than a flow-sensitive type.
- Quickened opcodes (0xe3-0xf2) would be skipped; none occurred in any corpus.
- `core-oj`/`framework` are the on-device binaries (already d8/R8 processed by AOSP's build).
- `boot-other` pools 37 jars; "dex bytes" counts the deduplicated underlying buffers (v41 containers share one).
- App corpora include bundled libraries (androidx, Kotlin, compose, ...) because that is what the emulator would run.

## Tables

### T1. Corpus size

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dex bytes (MiB) | 41.2 | 5.5 | 0.5 | 21.1 | 20.5 | 2.8 | 4.0 | 10.8 | 30.0 |
| dex files | 5 | 1 | 1 | 37 | 3 | 1 | 1 | 3 | 4 |
| classes | 32,713 | 4,199 | 469 | 17,346 | 21,918 | 4,213 | 4,003 | 10,671 | 27,909 |
| methods with code | 219,874 | 34,308 | 3,032 | 114,571 | 95,812 | 22,259 | 21,071 | 61,624 | 131,879 |
| instructions | 3,081,989 | 507,841 | 40,531 | 1,757,281 | 2,086,407 | 274,751 | 561,269 | 1,303,710 | 2,770,720 |
| code-unit bytes (2 x units) | 12,169,904 | 1,911,968 | 153,862 | 6,880,878 | 8,121,846 | 1,079,096 | 2,215,522 | 5,122,568 | 10,895,046 |
| mean instr / method | 14.0 | 14.8 | 13.4 | 15.3 | 21.8 | 12.3 | 26.6 | 21.2 | 21.0 |
| methods with <=4 instructions | 48.3% | 41.7% | 46.3% | 46.8% | 35.8% | 47.6% | 28.7% | 35.9% | 39.7% |

### T2. Opcode-family histogram (% of all instructions)

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| move / move-wide / move-object | 3.70% | 4.40% | 2.60% | 3.08% | 5.75% | 2.11% | 3.70% | 3.98% | 5.39% |
| move-result / move-exception | 14.59% | 13.95% | 15.78% | 14.71% | 12.28% | 15.41% | 12.64% | 11.97% | 11.92% |
| const (32-bit) | 6.41% | 6.18% | 5.47% | 6.53% | 8.21% | 6.13% | 7.16% | 7.67% | 9.00% |
| const-wide | 0.50% | 0.77% | 0.23% | 0.34% | 0.64% | 0.49% | 0.29% | 0.77% | 0.59% |
| const-string / const-class | 4.19% | 2.84% | 3.88% | 4.88% | 2.68% | 3.77% | 3.31% | 3.52% | 4.51% |
| arith int (incl. lit, neg/not) | 2.36% | 3.28% | 3.12% | 2.39% | 3.15% | 1.33% | 2.49% | 2.67% | 2.80% |
|   of which div/rem int | 0.06% | 0.10% | 0.05% | 0.06% | 0.04% | 0.07% | 0.07% | 0.05% | 0.04% |
| arith long | 0.44% | 0.93% | 0.22% | 0.47% | 0.49% | 0.25% | 0.28% | 0.72% | 0.37% |
|   of which div/rem long | 0.01% | 0.08% | 0.05% | 0.01% | 0.01% | 0.07% | 0.01% | 0.04% | 0.01% |
| arith float (+rem) | 0.24% | 0.01% | 0.00% | 0.01% | 0.26% | 0.18% | 0.66% | 0.29% | 0.27% |
| arith double (+rem) | 0.05% | 0.04% | 0.00% | 0.02% | 0.10% | 0.06% | 0.11% | 0.10% | 0.10% |
| conversions | 0.49% | 0.72% | 0.34% | 0.41% | 0.47% | 0.42% | 0.70% | 0.67% | 0.49% |
| cmp-long/float/double | 0.19% | 0.50% | 0.12% | 0.20% | 0.33% | 0.27% | 0.34% | 0.49% | 0.29% |
| iget (all widths) | 8.46% | 7.43% | 6.64% | 8.31% | 7.97% | 8.03% | 10.18% | 9.52% | 7.76% |
|   iget-obj | 5.63% | 5.01% | 4.65% | 5.87% | 5.32% | 6.22% | 6.65% | 6.23% | 5.26% |
|   iget-wide | 0.33% | 0.37% | 0.17% | 0.34% | 0.54% | 0.29% | 0.17% | 0.51% | 0.49% |
|   iget 8/16/32 | 2.50% | 2.04% | 1.82% | 2.11% | 2.11% | 1.51% | 3.36% | 2.77% | 2.01% |
| iput (all widths) | 3.34% | 2.92% | 2.90% | 3.35% | 3.62% | 3.50% | 4.64% | 3.81% | 3.45% |
|   iput-obj | 1.65% | 1.67% | 1.67% | 1.80% | 2.16% | 2.43% | 2.22% | 1.95% | 2.09% |
|   iput-wide | 0.19% | 0.20% | 0.12% | 0.23% | 0.17% | 0.19% | 0.09% | 0.24% | 0.15% |
|   iput 8/16/32 | 1.50% | 1.05% | 1.10% | 1.32% | 1.29% | 0.89% | 2.33% | 1.63% | 1.21% |
| sget (all) | 1.08% | 2.32% | 2.67% | 1.50% | 2.74% | 1.74% | 1.44% | 1.76% | 2.64% |
| sput (all) | 0.35% | 0.68% | 1.89% | 0.46% | 0.62% | 0.62% | 0.40% | 0.51% | 0.59% |
| aget (all) | 0.48% | 1.05% | 0.89% | 0.72% | 0.49% | 0.33% | 0.60% | 0.64% | 0.47% |
|   aget-obj | 0.18% | 0.42% | 0.53% | 0.26% | 0.21% | 0.16% | 0.27% | 0.31% | 0.21% |
|   aget-wide | 0.03% | 0.14% | 0.00% | 0.03% | 0.06% | 0.01% | 0.01% | 0.08% | 0.05% |
|   aget 8/16/32 | 0.27% | 0.50% | 0.36% | 0.42% | 0.22% | 0.16% | 0.32% | 0.26% | 0.21% |
| aput (all) | 0.30% | 1.19% | 0.63% | 0.67% | 0.44% | 0.37% | 0.31% | 2.00% | 1.45% |
|   aput-obj | 0.12% | 0.80% | 0.36% | 0.38% | 0.29% | 0.11% | 0.11% | 1.79% | 1.29% |
|   aput-wide | 0.02% | 0.07% | 0.00% | 0.02% | 0.02% | 0.01% | 0.01% | 0.04% | 0.02% |
|   aput 8/16/32 | 0.17% | 0.31% | 0.27% | 0.27% | 0.14% | 0.25% | 0.19% | 0.17% | 0.13% |
| array-length | 0.25% | 0.69% | 0.50% | 0.36% | 0.25% | 0.20% | 0.23% | 0.31% | 0.22% |
| invoke-virtual | 16.10% | 9.69% | 10.56% | 13.46% | 10.90% | 14.18% | 14.26% | 10.98% | 9.38% |
| invoke-interface | 2.07% | 2.05% | 3.02% | 2.38% | 2.68% | 2.57% | 1.41% | 2.04% | 2.61% |
| invoke-direct | 4.93% | 5.59% | 5.86% | 5.40% | 3.74% | 6.57% | 3.52% | 3.76% | 4.15% |
| invoke-static | 4.36% | 4.05% | 4.72% | 4.80% | 5.75% | 5.51% | 4.49% | 4.83% | 6.17% |
| invoke-super | 0.15% | 0.20% | 0.22% | 0.12% | 0.10% | 0.35% | 0.28% | 0.18% | 0.18% |
| invoke-polymorphic | 0.00% | 0.07% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| invoke-custom | 0.00% | 0.00% | 0.01% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| new-instance | 2.88% | 3.36% | 3.39% | 3.21% | 2.93% | 3.44% | 2.85% | 2.59% | 3.12% |
| new-array | 0.27% | 0.40% | 0.41% | 0.32% | 0.16% | 0.37% | 0.23% | 0.76% | 0.17% |
| filled-new-array | 0.13% | 0.09% | 0.13% | 0.30% | 0.13% | 0.34% | 0.20% | 0.09% | 0.15% |
| fill-array-data | 0.03% | 0.04% | 0.07% | 0.03% | 0.01% | 0.01% | 0.05% | 0.08% | 0.02% |
| monitor-enter/exit | 0.51% | 0.97% | 0.44% | 0.62% | 0.23% | 0.32% | 0.28% | 0.28% | 0.21% |
| check-cast | 1.10% | 1.14% | 1.13% | 1.25% | 3.40% | 1.76% | 2.39% | 2.35% | 3.20% |
| instance-of | 0.18% | 0.30% | 0.32% | 0.19% | 0.41% | 0.26% | 0.36% | 0.42% | 0.37% |
| packed-switch | 0.15% | 0.05% | 0.04% | 0.11% | 0.14% | 0.04% | 0.17% | 0.18% | 0.12% |
| sparse-switch | 0.03% | 0.03% | 0.05% | 0.03% | 0.00% | 0.00% | 0.01% | 0.02% | 0.00% |
| throw | 1.45% | 1.72% | 1.65% | 1.09% | 0.51% | 0.62% | 0.50% | 0.54% | 0.75% |
| if-test (2 regs) | 1.81% | 2.42% | 2.54% | 2.04% | 2.32% | 1.69% | 2.70% | 2.60% | 2.06% |
| if-testz | 3.79% | 5.78% | 4.97% | 4.50% | 5.56% | 4.66% | 6.74% | 5.98% | 5.16% |
| goto | 2.58% | 3.37% | 2.84% | 3.01% | 3.88% | 2.65% | 4.19% | 3.86% | 3.48% |
| return | 9.02% | 8.19% | 9.30% | 8.15% | 6.54% | 9.44% | 5.79% | 6.98% | 6.33% |
| nop | 1.00% | 0.61% | 0.42% | 0.59% | 0.07% | 0.02% | 0.09% | 0.11% | 0.07% |

### T2b. Raw instruction counts for the families the spec names

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cmp-long | 3,446 | 2,296 | 43 | 3,036 | 4,338 | 541 | 875 | 4,398 | 4,709 |
| cmp-float/double | 2,358 | 249 | 4 | 430 | 2,496 | 212 | 1,037 | 2,052 | 3,226 |
| conv-f2i/l (sat) | 1,058 | 37 | 0 | 39 | 458 | 160 | 456 | 585 | 764 |
| conv-d2i/l (sat) | 265 | 38 | 2 | 106 | 157 | 30 | 68 | 208 | 195 |
| divrem-int | 1,715 | 496 | 19 | 1,071 | 783 | 204 | 386 | 672 | 1,182 |
| divrem-long | 437 | 402 | 19 | 228 | 280 | 180 | 79 | 465 | 248 |
| rem-float | 24 | 0 | 0 | 0 | 18 | 0 | 17 | 8 | 26 |
| rem-double | 3 | 0 | 0 | 7 | 27 | 1 | 3 | 8 | 24 |
| monitor | 15,828 | 4,934 | 180 | 10,831 | 4,854 | 878 | 1,574 | 3,589 | 5,860 |
| filled-new-array | 3,903 | 436 | 52 | 5,316 | 2,762 | 922 | 1,106 | 1,230 | 4,202 |
| fill-array-data | 1,001 | 227 | 29 | 543 | 302 | 32 | 276 | 991 | 621 |
| invoke-polymorphic | 3 | 350 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| invoke-custom | 15 | 0 | 3 | 18 | 0 | 0 | 0 | 0 | 0 |
| quickened | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### T3. Method shape (% of methods with code)

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| leaf(no invoke) | 25.2% | 14.3% | 19.5% | 22.8% | 14.5% | 14.8% | 13.4% | 15.9% | 15.3% |
| leaf, no alloc/throw/monitor | 22.7% | 12.9% | 18.1% | 20.3% | 13.5% | 13.4% | 12.4% | 14.7% | 14.3% |
| leaf, no alloc/throw/monitor, no object ops (numeric+prim fields/arrays) | 13.9% | 6.5% | 8.0% | 11.0% | 5.5% | 6.3% | 6.5% | 7.9% | 5.5% |
| register-only leaf (no invoke/alloc/field/array/object) | 8.7% | 2.5% | 4.1% | 5.5% | 2.5% | 1.9% | 3.0% | 4.2% | 2.3% |
| tiny (<=4 instructions) | 48.3% | 41.7% | 46.3% | 46.8% | 35.8% | 47.6% | 28.7% | 35.9% | 39.7% |
| small leaf (<=8 instructions) | 23.8% | 12.4% | 18.0% | 21.0% | 13.4% | 14.2% | 12.1% | 14.3% | 14.4% |
| no try | 86.5% | 91.4% | 93.2% | 90.4% | 95.6% | 96.1% | 93.9% | 94.9% | 96.0% |
| has monitor-enter/exit | 2.1% | 4.0% | 1.7% | 2.7% | 1.2% | 1.2% | 1.9% | 1.7% | 1.1% |
| ACC_SYNCHRONIZED | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| uses long/double (op or signature) | 8.6% | 13.4% | 7.5% | 8.1% | 12.7% | 11.1% | 8.8% | 15.3% | 11.0% |
| has long/double values (inferred) | 8.6% | 14.1% | 7.7% | 9.0% | 12.9% | 12.7% | 7.5% | 14.7% | 11.0% |
| has float/double values (inferred) | 3.7% | 2.5% | 1.0% | 1.8% | 6.0% | 4.3% | 11.1% | 6.4% | 6.3% |
| uses float/double ops | 2.6% | 4.4% | 2.2% | 2.3% | 3.6% | 2.7% | 7.3% | 5.5% | 3.8% |
| has float constants (inferred const->F) | 1.0% | 0.2% | 0.1% | 0.1% | 2.4% | 1.1% | 6.0% | 2.3% | 2.2% |
| int/ref only (no J/F/D values) | 88.9% | 85.3% | 92.1% | 90.8% | 84.2% | 85.6% | 83.6% | 81.6% | 85.6% |

### T3b. Share of code-unit bytes living in leaf / numeric-only methods

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| leaf (no invoke) | 5.6% | 5.1% | 5.8% | 5.9% | 2.4% | 2.9% | 2.7% | 5.8% | 2.7% |
| numeric-only leaf | 2.1% | 1.7% | 1.2% | 1.8% | 0.6% | 1.0% | 0.6% | 1.0% | 0.6% |

### T4. Try / catch

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| methods with try | 29,719 (13.5%) | 2,952 (8.6%) | 207 (6.8%) | 11,011 (9.6%) | 4,246 (4.4%) | 857 (3.9%) | 1,288 (6.1%) | 3,167 (5.1%) | 5,236 (4.0%) |
| try items | 41,334 | 5,423 | 302 | 16,734 | 10,613 | 1,624 | 3,071 | 6,843 | 12,856 |
| typed catch clauses | 13,814 | 2,405 | 243 | 9,051 | 5,081 | 989 | 1,624 | 3,458 | 6,236 |
| catch-all handlers | 30,764 (74.4% of items) | 3,654 (67.4% of items) | 125 (41.4% of items) | 9,902 (59.2% of items) | 7,282 (68.6% of items) | 784 (48.3% of items) | 2,008 (65.4% of items) | 4,345 (63.5% of items) | 8,753 (68.1% of items) |
| items with typed + catch-all | 1,390 | 301 | 12 | 945 | 941 | 58 | 209 | 344 | 1,137 |
| max try items / method | 45 | 41 | 5 | 41 | 53 | 23 | 49 | 56 | 52 |
| max typed clauses / item | 7 | 5 | 5 | 7 | 8 | 6 | 8 | 8 | 8 |

### T4b. Catch-type distribution (all 9 corpora pooled, top 15)

| type | clauses | share |
|---|---:|---:|
| Landroid/os/RemoteException; | 9,281 | 21.6% |
| Ljava/lang/Exception; | 5,460 | 12.7% |
| Ljava/io/IOException; | 4,679 | 10.9% |
| Ljava/lang/NoSuchFieldError; | 3,804 | 8.9% |
| Ljava/lang/NumberFormatException; | 1,196 | 2.8% |
| Ljava/lang/IllegalArgumentException; | 1,158 | 2.7% |
| Ljava/lang/RuntimeException; | 1,134 | 2.6% |
| Ljava/lang/InterruptedException; | 635 | 1.5% |
| Ljava/lang/IllegalAccessException; | 608 | 1.4% |
| Ljava/lang/ClassNotFoundException; | 576 | 1.3% |
| Landroid/database/sqlite/SQLiteException; | 567 | 1.3% |
| Ljava/lang/SecurityException; | 495 | 1.2% |
| Ljava/lang/NullPointerException; | 481 | 1.1% |
| Ljava/lang/NoSuchMethodException; | 468 | 1.1% |
| Landroid/content/pm/PackageManager$NameNotFoundException; | 451 | 1.1% |

### T5. Switches

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| packed-switch count / median / p99 / max size | 4,535 / 3 / 69 / 415 | 267 / 4 / 58 / 58 | 16 / 10 / 12 / 12 | 1,906 / 4 / 65 / 256 | 2,841 / 2 / 56 / 161 | 101 / 8 / 20 / 20 | 947 / 2 / 69 / 284 | 2,320 / 2 / 48 / 238 | 3,378 / 2 / 42 / 161 |
| sparse-switch count / median / p99 / max size | 984 / 5 / 151 / 214 | 144 / 5 / 22 / 25 | 22 / 6 / 17 / 17 | 501 / 4 / 44 / 91 | 97 / 6 / 56 / 56 | 7 / 4 / 21 / 21 | 60 / 5 / 55 / 55 | 206 / 5 / 140 / 238 | 106 / 6 / 123 / 124 |

### T6. Type inference outcome

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| methods analyzed | 219,874 | 34,308 | 3,032 | 114,571 | 95,812 | 22,259 | 21,071 | 61,624 | 131,879 |
| skipped (quickened / too large / no fixpoint) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| methods with NO merge conflict | 219,874 (100.000%) | 34,308 (100.000%) | 3,032 (100.000%) | 114,571 (100.000%) | 95,812 (100.000%) | 22,259 (100.000%) | 21,071 (100.000%) | 61,624 (100.000%) | 131,879 (100.000%) |
| methods fully determined (no conflict, no unconstrained web) | 219,568 (99.86%) | 34,172 (99.60%) | 3,028 (99.87%) | 114,336 (99.79%) | 95,496 (99.67%) | 22,154 (99.53%) | 21,012 (99.72%) | 61,442 (99.70%) | 131,487 (99.70%) |
| true merge conflicts (components) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| live-range webs (used) | 1,766,109 | 295,918 | 23,857 | 1,005,322 | 1,198,685 | 160,127 | 298,149 | 731,267 | 1,635,132 |
| webs left underdetermined | 818 (0.046%) | 520 (0.176%) | 4 (0.017%) | 919 (0.091%) | 816 (0.068%) | 495 (0.309%) | 112 (0.038%) | 522 (0.071%) | 943 (0.058%) |
|   of which contain a const-0 def | 91 | 31 | 0 | 67 | 12 | 4 | 14 | 23 | 35 |
| vregs (with live webs) | 855,969 | 139,260 | 11,404 | 430,753 | 422,378 | 69,854 | 94,068 | 254,054 | 579,758 |
| vregs holding >=2 kinds at different points | 126,419 (14.8%) | 24,580 (17.7%) | 1,800 (15.8%) | 77,593 (18.0%) | 104,314 (24.7%) | 15,057 (21.6%) | 28,030 (29.8%) | 68,765 (27.1%) | 130,592 (22.5%) |
|   ... only because of const-0 (webs w/ const-0 def ignored => <=1 kind) | 11,088 (8.8% of multi-kind) | 1,811 (7.4% of multi-kind) | 148 (8.2% of multi-kind) | 5,387 (6.9% of multi-kind) | 6,991 (6.7% of multi-kind) | 1,001 (6.6% of multi-kind) | 1,572 (5.6% of multi-kind) | 3,484 (5.1% of multi-kind) | 9,135 (7.0% of multi-kind) |
| methods with >=1 multi-kind vreg | 33.4% | 40.3% | 36.4% | 37.0% | 45.1% | 37.2% | 54.5% | 48.8% | 41.5% |
| web kind mix I / F / R / J / D / ? | 30.7% / 1.9% / 63.4% / 3.5% / 0.4% / 0.0% | 31.9% / 0.2% / 60.9% / 6.3% / 0.5% / 0.2% | 31.7% / 0.1% / 65.5% / 2.7% / 0.1% / 0.0% | 30.9% / 0.1% / 65.2% / 3.3% / 0.4% / 0.1% | 30.6% / 2.8% / 61.3% / 4.6% / 0.7% / 0.1% | 24.0% / 1.2% / 70.0% / 3.6% / 0.9% / 0.3% | 34.9% / 5.1% / 57.1% / 2.2% / 0.6% / 0.0% | 33.7% / 2.3% / 57.7% / 5.6% / 0.6% / 0.1% | 30.0% / 2.8% / 62.7% / 3.8% / 0.6% / 0.1% |
| const-0 webs | 84,825 | 12,909 | 988 | 40,673 | 64,336 | 6,255 | 13,160 | 30,387 | 83,548 |
| dead defs (never read) | 93,620 | 7,412 | 546 | 33,215 | 24,037 | 3,524 | 5,492 | 16,243 | 31,249 |

### T7. Wasm local counts per method (min = best case, see text)

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| DEX frame registers: median / p90 / p99 / max | 3 / 8 / 21 / 238 | 3 / 8 / 20 / 157 | 3 / 7 / 15 / 50 | 3 / 8 / 19 / 192 | 3 / 9 / 30 / 417 | 3 / 6 / 15 / 57 | 3 / 9 / 23 / 144 | 3 / 9 / 23 / 303 | 3 / 9 / 29 / 417 |
| (A) untyped i32 per vreg, wide = 2 slots (= regs): mean | 4.33 | 4.42 | 4.04 | 4.07 | 4.68 | 3.34 | 4.63 | 4.46 | 4.70 |
| (B) untyped i32 + one i64 per wide pair: median / p99 / max | 3 / 19 / 148 | 3 / 16 / 157 | 3 / 14 / 33 | 3 / 17 / 192 | 3 / 26 / 417 | 2 / 13 / 57 | 3 / 21 / 144 | 3 / 20 / 303 | 3 / 25 / 417 |
| (C) split by kind: one local per (vreg, kind): mean | 4.52 | 4.85 | 4.38 | 4.48 | 5.65 | 3.87 | 5.97 | 5.39 | 5.53 |
| (C) median / p90 / p99 / max | 3 / 9 / 24 / 263 | 4 / 10 / 23 / 157 | 3 / 9 / 18 / 38 | 3 / 9 / 22 / 246 | 3 / 11 / 41 / 420 | 3 / 8 / 19 / 71 | 4 / 13 / 34 / 160 | 3 / 11 / 32 / 306 | 3 / 11 / 39 / 420 |
| (D) one local per live-range web: mean | 8.03 | 8.63 | 7.87 | 8.77 | 12.51 | 7.19 | 14.15 | 11.87 | 12.40 |
| (D) median / p90 / p99 / max | 4 / 16 / 64 / 2035 | 4 / 18 / 64 / 2680 | 4 / 17 / 60 / 543 | 4 / 18 / 73 / 5050 | 5 / 23 / 133 / 6278 | 4 / 16 / 53 / 422 | 6 / 30 / 134 / 1136 | 5 / 24 / 111 / 3785 | 5 / 22 / 131 / 6278 |
| C / A ratio (total) | 1.042 | 1.095 | 1.084 | 1.099 | 1.208 | 1.159 | 1.289 | 1.208 | 1.177 |
| methods where (C) > frame regs | 29.2% | 34.2% | 32.2% | 33.7% | 42.0% | 34.3% | 52.8% | 44.8% | 37.4% |

### T8. Inference cost (single process, indicative only)

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| inference ms total | 1,143 | 185 | 14 | 584 | 808 | 101 | 213 | 488 | 1,077 |
| us / method (mean) | 5.2 | 5.4 | 4.7 | 5.1 | 8.4 | 4.5 | 10.1 | 7.9 | 8.2 |
| method p50 / p99 / max (us) | 2.5 / 40 / 6,343 | 2.7 / 43 / 1,202 | 2.7 / 33 / 172 | 2.3 / 42 / 1,546 | 2.8 / 101 / 1,843 | 2.4 / 32 / 896 | 3.7 / 109 / 1,211 | 3.0 / 80 / 3,446 | 2.6 / 99 / 6,017 |
| ms per MiB of dex | 28 | 33 | 26 | 28 | 39 | 37 | 53 | 45 | 36 |

### T9. Hardest methods (most multi-kind vregs, then most webs), 2 per corpus

| corpus | method | code units | regs | webs | split locals | multi-kind vregs |
|---|---|---:|---:|---:|---:|---:|
| framework | `Landroid/os/BatteryStats;.dumpLocked(Landroid/content/Context;Ljava/io/PrintWriter;Ljava/lang/String;IIZLandroid/os/BatteryStats$BatteryStatsDumpHelper;)V` | 9590 | 238 | 2035 | 262 | 73 |
| framework | `Landroid/os/BatteryStats;.dumpCheckinLocked(Landroid/content/Context;Ljava/io/PrintWriter;IIZLandroid/os/BatteryStats$BatteryStatsDumpHelper;)V` | 4523 | 218 | 1168 | 263 | 69 |
| core-oj | `Ljava/lang/Character$UnicodeScript;.<clinit>()V` | 12978 | 26 | 2680 | 51 | 25 |
| core-oj | `Ljava/math/BigDecimal;.<clinit>()V` | 1374 | 30 | 304 | 71 | 25 |
| core-libart | `Ljavax/xml/datatype/DatatypeFactory;.newDurationDayTime(J)Ljavax/xml/datatype/Duration;` | 218 | 24 | 102 | 36 | 11 |
| core-libart | `Lorg/xml/sax/helpers/ParserAdapter;.startElement(Ljava/lang/String;Lorg/xml/sax/AttributeList;)V` | 346 | 27 | 98 | 38 | 11 |
| boot-other | `Lorg/apache/xalan/processor/XSLTSchema;.build()V` | 3240 | 172 | 1260 | 246 | 89 |
| boot-other | `Landroid/health/connect/datatypes/validation/ExerciseSessionTypesValidation;.<clinit>()V` | 735 | 55 | 224 | 91 | 36 |
| mihon | `Leu/kanade/domain/chapter/interactor/SyncChaptersWithSource;.await(Ljava/util/List;Ltachiyomi/domain/manga/model/Manga;Leu/kanade/tachiyomi/source/Source;ZLkotlin/Pair;Lkotlin/coroutines/jvm/internal/ContinuationImpl;)Ljava/io/Serializable;` | 2886 | 87 | 768 | 169 | 55 |
| mihon | `Leu/kanade/presentation/more/settings/screen/SettingsReaderScreen;.getPreferences(Landroidx/compose/runtime/Composer;)Ljava/util/List;` | 3094 | 71 | 950 | 120 | 48 |
| fitnotes | `LR/r;.s(J)Ljava/util/List;` | 556 | 35 | 148 | 56 | 17 |
| fitnotes | `LX/o0;.d(Landroid/database/sqlite/SQLiteDatabase;)V` | 1094 | 47 | 252 | 67 | 16 |
| harmonic | `Lpr0;.b([FLey;Ljava/util/List;FF)Lek1;` | 1248 | 43 | 443 | 101 | 28 |
| harmonic | `Lvw;.b(Lpv0;Z)V` | 1919 | 61 | 521 | 102 | 27 |
| newpipe | `Lorg/schabi/newpipe/extractor/utils/jsextractor/Token;.<clinit>()V` | 1821 | 111 | 584 | 209 | 98 |
| newpipe | `Lj$/time/format/h0;.<clinit>()V` | 12609 | 102 | 3785 | 193 | 91 |
| komikku | `Leu/kanade/domain/chapter/interactor/SyncChaptersWithSource;.await(Ljava/util/List;Ltachiyomi/domain/manga/model/Manga;Leu/kanade/tachiyomi/source/Source;ZLkotlin/Pair;Lkotlin/coroutines/jvm/internal/ContinuationImpl;)Ljava/io/Serializable;` | 3044 | 96 | 828 | 175 | 59 |
| komikku | `Lcom/google/zxing/datamatrix/decoder/Version;.<clinit>()V` | 1003 | 63 | 389 | 114 | 51 |

### T9b. Method with the most webs per corpus

| corpus | method | code units | regs | webs | split locals |
|---|---|---:|---:|---:|---:|
| framework | `Landroid/os/BatteryStats;.dumpLocked(Landroid/content/Context;Ljava/io/PrintWriter;Ljava/lang/String;IIZLandroid/os/BatteryStats$BatteryStatsDumpHelper;)V` | 9590 | 238 | 2035 | 262 |
| core-oj | `Ljava/lang/Character$UnicodeScript;.<clinit>()V` | 12978 | 26 | 2680 | 51 |
| core-libart | `Landroid/system/OsConstants;.<clinit>()V` | 3262 | 1 | 543 | 1 |
| boot-other | `Lorg/ccil/cowan/tagsoup/HTMLSchema;.<init>()V` | 18867 | 17 | 5050 | 28 |
| mihon | `Landroidx/glance/appwidget/GeneratedLayoutsKt;.<clinit>()V` | 6519 | 344 | 2030 | 359 |
| fitnotes | `Landroidx/work/impl/WorkDatabase_Impl$a;.g(LD/b;)Landroidx/room/i$b;` | 1385 | 30 | 399 | 42 |
| harmonic | `Lorg/scilab/forge/jlatexmath/PredefinedCommands;.<clinit>()V` | 3969 | 9 | 1136 | 16 |
| newpipe | `Lj$/time/format/h0;.<clinit>()V` | 12609 | 102 | 3785 | 193 |
| komikku | `Lexh/eh/tags/Male;.getTags1()Ljava/util/List;` | 8408 | 149 | 2467 | 172 |

### T10. Method size (bytes of code units)

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| median / p90 / p99 / max bytes | 18 / 114 / 488 / 19,180 | 22 / 122 / 470 / 25,956 | 20 / 118 / 424 / 6,524 | 18 / 132 / 568 / 37,734 | 26 / 168 / 988 / 39,616 | 18 / 114 / 412 / 3,128 | 36 / 224 / 1120 / 7,938 | 26 / 174 / 886 / 25,218 | 24 / 156 / 944 / 39,616 |
| methods > 1 KiB | 583 (0.27%) | 63 (0.18%) | 3 (0.10%) | 389 (0.34%) | 908 (0.95%) | 31 (0.14%) | 232 (1.10%) | 487 (0.79%) | 1,162 (0.88%) |
| methods > 8 KiB | 21 (0.010%) | 3 (0.009%) | 0 (0.000%) | 8 (0.007%) | 7 (0.007%) | 0 (0.000%) | 0 (0.000%) | 7 (0.011%) | 31 (0.024%) |
| methods > 64 KiB | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| blocks / method: median / p99 / max | 1 / 28 / 683 | 1 / 33 / 193 | 1 / 28 / 159 | 1 / 31 / 379 | 1 / 58 / 548 | 1 / 23 / 202 | 1 / 67 / 540 | 1 / 52 / 884 | 1 / 54 / 896 |
| largest method | 19,180 B | 25,956 B | 6,524 B | 37,734 B | 39,616 B | 3,128 B | 7,938 B | 25,218 B | 39,616 B |

### T10b. Method-size histogram (% of methods)

| bytes | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| <=64 | 76.13% | 78.49% | 79.72% | 76.89% | 74.00% | 80.34% | 65.12% | 72.38% | 75.93% |
| <=128 | 15.71% | 12.14% | 11.25% | 12.82% | 12.81% | 11.12% | 16.15% | 13.42% | 11.84% |
| <=256 | 5.16% | 6.13% | 6.33% | 6.54% | 7.13% | 6.03% | 10.42% | 8.21% | 6.62% |
| <=512 | 2.07% | 2.40% | 1.98% | 2.56% | 3.50% | 1.86% | 5.11% | 3.74% | 3.20% |
| <=1024 | 0.66% | 0.65% | 0.63% | 0.85% | 1.62% | 0.51% | 2.09% | 1.45% | 1.53% |
| <=2048 | 0.18% | 0.15% | 0.07% | 0.24% | 0.65% | 0.12% | 0.74% | 0.53% | 0.59% |
| <=4096 | 0.06% | 0.03% | 0.00% | 0.08% | 0.22% | 0.02% | 0.28% | 0.22% | 0.20% |
| <=8192 | 0.02% | 0.00% | 0.03% | 0.02% | 0.07% | 0.00% | 0.08% | 0.03% | 0.07% |
| <=16384 | 0.01% | 0.01% | 0.00% | 0.00% | 0.01% | 0.00% | 0.00% | 0.00% | 0.01% |
| <=32768 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.01% | 0.01% |
| <=65536 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| >65536 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |

### T10c. Largest methods

| corpus | method | bytes |
|---|---|---:|
| framework | `Landroid/os/BatteryStats;.dumpLocked(Landroid/content/Context;Ljava/io/PrintWriter;Ljava/lang/String;IIZLandroid/os/BatteryStats$BatteryStatsDumpHelper;)V` | 19,180 |
| core-oj | `Ljava/lang/Character$UnicodeScript;.<clinit>()V` | 25,956 |
| core-libart | `Landroid/system/OsConstants;.<clinit>()V` | 6,524 |
| boot-other | `Lorg/ccil/cowan/tagsoup/HTMLSchema;.<init>()V` | 37,734 |
| mihon | `Lcom/mohamedrejeb/ksoup/entities/EntityMaps;.<clinit>()V` | 39,616 |
| fitnotes | `LX/w;.a0(Landroid/database/sqlite/SQLiteDatabase;)V` | 3,128 |
| harmonic | `Lorg/scilab/forge/jlatexmath/PredefinedCommands;.<clinit>()V` | 7,938 |
| newpipe | `Lj$/time/format/h0;.<clinit>()V` | 25,218 |
| komikku | `Lcom/mohamedrejeb/ksoup/entities/EntityMaps;.<clinit>()V` | 39,616 |

### T11. Control flow: reducibility and the repo's structurer (src/jvm/structure.ts) over ALL methods

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| methods with a CFG | 219,874 | 34,308 | 3,032 | 114,571 | 95,812 | 22,259 | 21,071 | 61,624 | 131,879 |
| irreducible, handlers as extra roots (mode A) | 270 (0.123%) | 87 (0.254%) | 16 (0.528%) | 168 (0.147%) | 274 (0.286%) | 4 (0.018%) | 59 (0.280%) | 134 (0.217%) | 327 (0.248%) |
| irreducible, precise exception edges (mode B) | 64 (0.029%) | 21 (0.061%) | 0 (0.000%) | 17 (0.015%) | 196 (0.205%) | 0 (0.000%) | 12 (0.057%) | 56 (0.091%) | 231 (0.175%) |
| Flow tried (methods with >1 block or a try) | 74,410 | 13,207 | 1,095 | 39,208 | 34,162 | 6,253 | 10,400 | 25,163 | 42,875 |
| Flow structured OK | 74,402 | 13,207 | 1,095 | 39,207 | 33,991 | 6,253 | 10,388 | 25,117 | 42,679 |
| Flow fell back: irreducible | 0 | 0 | 0 | 1 | 171 | 0 | 12 | 46 | 196 |
| Flow fell back: too deep | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Flow fell back: other | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| fallback rate among Flow-tried | 0.011% | 0.000% | 0.000% | 0.003% | 0.501% | 0.000% | 0.115% | 0.183% | 0.457% |
| Flow OK with >1 region (needs pc dispatch between regions) | 29,719 (39.9%) | 2,952 (22.4%) | 207 (18.9%) | 11,011 (28.1%) | 4,200 (12.4%) | 856 (13.7%) | 1,284 (12.4%) | 3,153 (12.6%) | 5,187 (12.2%) |

### T11b. Irreducible examples (mode B)

- framework: `Landroid/app/ApplicationLoaders;.getClassLoader(Ljava/lang/String;IZLjava/lang/String;Ljava/lang/String;Ljava/lang/ClassLoader;Ljava/lang/String;Ljava/lang/String;Ljava/util/List;Ljava/util/List;Ljava/util/List;)Ljava/lang/ClassLoader;`, `Landroid/app/Instrumentation;.execStartActivitiesAsUser(Landroid/content/Context;Landroid/os/IBinder;Landroid/os/IBinder;Landroid/app/Activity;[Landroid/content/Intent;Landroid/os/Bundle;I)I`, `Landroid/app/Instrumentation;.execStartActivity(Landroid/content/Context;Landroid/os/IBinder;Landroid/os/IBinder;Landroid/app/Activity;Landroid/content/Intent;ILandroid/os/Bundle;)Landroid/app/Instrumentation$ActivityResult;`
- core-oj: `Ljava/util/concurrent/Phaser;.doRegister(I)I`, `Ljava/util/zip/Deflater;.deflate(Ljava/nio/ByteBuffer;I)I`, `Ljava/util/zip/Deflater;.deflate([BIII)I`
- core-libart: (none)
- boot-other: `Lcom/android/org/conscrypt/ConscryptEngine;.unwrap([Ljava/nio/ByteBuffer;II[Ljava/nio/ByteBuffer;II)Ljavax/net/ssl/SSLEngineResult;`, `Landroid/icu/text/DateTimePatternGenerator;.getBestPattern(Ljava/lang/String;Landroid/icu/text/DateTimePatternGenerator$DateTimeMatcher;IZ)Ljava/lang/String;`, `Landroid/bluetooth/le/BluetoothLeAdvertiser;.startAdvertising(Landroid/bluetooth/le/AdvertiseSettings;Landroid/bluetooth/le/AdvertiseData;Landroid/bluetooth/le/AdvertiseData;Landroid/bluetooth/le/AdvertiseCallback;)V`
- mihon: `Landroidx/compose/runtime/Recomposer$recompositionRunner$2$2;.invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;`, `Landroidx/compose/animation/core/AnimateAsStateKt$animateValueAsState$3$1;.invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;`, `Lapp/cash/sqldelight/coroutines/FlowQuery$asFlow$1;.invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;`
- fitnotes: (none)
- harmonic: `Lcn0;.W()V`, `Lff0;.a(Lxe0;Lqx;)Ljava/lang/Object;`, `Lhp;.o(Ljava/lang/Object;)Ljava/lang/Object;`
- newpipe: `Landroidx/collection/Entries$iterator$1;.invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;`, `Landroidx/collection/Keys$iterator$1;.invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;`, `Landroidx/collection/MutableSetWrapper$iterator$1$iterator$1;.invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;`
- komikku: `Landroidx/collection/Keys$iterator$1;.invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;`, `Landroidx/collection/MutableSetWrapper$iterator$1$iterator$1;.invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;`, `Landroidx/compose/animation/core/InfiniteTransition$run$1$1;.invokeSuspend(Ljava/lang/Object;)Ljava/lang/Object;`

### T12. Invoke sites

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| invoke sites | 851,152 | 109,966 | 9,888 | 459,747 | 483,582 | 80,186 | 134,491 | 283,950 | 623,148 |
| sites / method with code (mean) | 3.87 | 3.21 | 3.26 | 4.01 | 5.05 | 3.60 | 6.38 | 4.61 | 4.73 |
| distinct method refs per invoking method: median / p90 / max | 2 / 8 / 449 | 2 / 6 / 79 | 2 / 7 / 42 | 2 / 9 / 267 | 2 / 8 / 200 | 2 / 8 / 78 | 2 / 11 / 228 | 2 / 9 / 184 | 2 / 8 / 204 |
| invoke-static | 15.8% | 18.7% | 19.3% | 18.3% | 24.8% | 18.9% | 18.8% | 22.2% | 27.4% |
| invoke-direct | 17.9% | 25.8% | 24.0% | 20.6% | 16.1% | 22.5% | 14.7% | 17.2% | 18.5% |
| invoke-virtual | 58.3% | 44.7% | 43.3% | 51.5% | 47.0% | 48.6% | 59.5% | 50.4% | 41.7% |
| invoke-interface | 7.5% | 9.5% | 12.4% | 9.1% | 11.6% | 8.8% | 5.9% | 9.4% | 11.6% |
| invoke-super | 0.6% | 0.9% | 0.9% | 0.5% | 0.4% | 1.2% | 1.2% | 0.8% | 0.8% |
| polymorphic + custom | 0.002% | 0.318% | 0.051% | 0.004% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| callee class == caller class | 15.4% | 24.8% | 22.5% | 16.2% | 8.0% | 13.6% | 8.6% | 11.0% | 8.8% |
| callee in same package | 30.0% | 48.8% | 35.9% | 33.7% | 21.3% | 27.0% | 37.9% | 26.8% | 21.6% |
| callee defined in this corpus | 72.2% | 97.9% | 45.5% | 43.8% | 60.0% | 53.6% | 44.1% | 57.1% | 64.4% |
| callee in platform (framework/boot) but not this corpus | 27.7% | 1.5% | 54.3% | 56.1% | 39.9% | 46.2% | 55.8% | 42.8% | 35.5% |
| callee class not in any loaded set | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.1% | 0.1% | 0.1% | 0.0% |
| callee: java/javax | 26.7% | 84.9% | 58.0% | 40.1% | 34.3% | 31.1% | 32.2% | 30.8% | 29.2% |
| callee: android | 63.7% | 0.3% | 6.9% | 35.2% | 5.4% | 15.2% | 22.4% | 11.9% | 6.1% |
| callee: kotlin | 0.0% | 0.0% | 0.0% | 0.0% | 12.0% | 0.0% | 0.0% | 3.2% | 15.3% |
| callee: androidx | 0.0% | 0.0% | 0.0% | 0.0% | 23.9% | 7.9% | 1.7% | 16.8% | 20.7% |
| direct/static callee known with code in corpus | 189,554 | 46,787 | 2,431 | 97,412 | 139,111 | 23,241 | 27,130 | 79,601 | 204,832 |
|   ... that is a leaf (no invoke) | 11.9% | 16.4% | 32.4% | 15.6% | 8.9% | 7.7% | 4.1% | 8.3% | 8.4% |
|   ... <= 16 code units (32 B) | 64.2% | 69.7% | 63.1% | 61.4% | 61.5% | 62.7% | 53.8% | 58.9% | 52.2% |

### T13. invoke-virtual receivers: static type from the method ref + CHA (% of invoke-virtual sites)

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| final class | 56.5% | 48.6% | 66.6% | 57.5% | 55.6% | 36.5% | 36.6% | 48.2% | 59.3% |
| final method | 11.4% | 9.5% | 4.2% | 4.6% | 24.2% | 12.4% | 20.7% | 19.8% | 12.6% |
| CHA: 1 impl (class has no loaded subclass) | 12.4% | 19.7% | 11.7% | 18.2% | 1.8% | 17.2% | 7.3% | 5.3% | 4.7% |
| CHA: exactly 1 impl | 9.8% | 10.1% | 6.3% | 9.2% | 6.1% | 22.2% | 17.5% | 11.8% | 9.2% |
| CHA: 2 impls | 3.5% | 5.0% | 3.5% | 3.9% | 3.9% | 4.1% | 7.9% | 6.7% | 4.6% |
| CHA: 3+ impls | 3.6% | 6.3% | 5.6% | 5.7% | 8.2% | 7.2% | 9.9% | 7.8% | 9.5% |
| no concrete impl loaded | 2.7% | 0.2% | 1.6% | 0.8% | 0.1% | 0.1% | 0.1% | 0.1% | 0.0% |
| array receiver (clone/Object methods) | 0.1% | 0.6% | 0.5% | 0.2% | 0.1% | 0.3% | 0.0% | 0.1% | 0.1% |
| unresolved class (not in loaded set) | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.1% | 0.1% | 0.0% |
| monomorphic-by-CHA total (final class + final method + 1 impl) | 90.1% | 87.9% | 88.8% | 89.4% | 87.7% | 88.3% | 82.0% | 85.2% | 85.8% |

### T14. invoke-interface receivers + CHA (% of invoke-interface sites)

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CHA: exactly 1 impl | 8.1% | 7.5% | 1.8% | 13.0% | 5.2% | 8.6% | 5.0% | 5.1% | 6.5% |
| CHA: 2 impls | 41.5% | 6.5% | 26.5% | 18.8% | 10.7% | 6.9% | 14.3% | 13.6% | 10.5% |
| CHA: 3+ impls | 47.0% | 85.2% | 70.9% | 67.0% | 83.8% | 83.6% | 80.0% | 80.6% | 82.6% |
| no concrete impl loaded | 3.2% | 0.8% | 0.7% | 1.2% | 0.3% | 0.6% | 0.5% | 0.4% | 0.3% |
| array receiver (clone/Object methods) | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| unresolved class (not in loaded set) | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.3% | 0.2% | 0.2% | 0.0% |
| sites | 63,828 | 10,419 | 1,225 | 41,745 | 55,935 | 7,074 | 7,921 | 26,597 | 72,190 |

### A1. All opcode families (% of instructions)

|  | framework | core-oj | core-libart | boot-other | mihon | fitnotes | harmonic | newpipe | komikku |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| invoke-virtual | 16.100% | 9.686% | 10.562% | 13.463% | 10.903% | 14.180% | 14.261% | 10.976% | 9.382% |
| move-result | 13.441% | 13.096% | 15.003% | 13.914% | 11.960% | 15.088% | 12.310% | 11.632% | 11.631% |
| return | 9.024% | 8.190% | 9.297% | 8.147% | 6.536% | 9.440% | 5.788% | 6.982% | 6.335% |
| const32 | 6.415% | 6.179% | 5.472% | 6.531% | 8.209% | 6.128% | 7.164% | 7.667% | 8.999% |
| iget-obj | 5.632% | 5.013% | 4.653% | 5.872% | 5.319% | 6.225% | 6.649% | 6.233% | 5.255% |
| invoke-direct | 4.933% | 5.589% | 5.860% | 5.400% | 3.739% | 6.572% | 3.518% | 3.756% | 4.150% |
| invoke-static | 4.357% | 4.054% | 4.720% | 4.799% | 5.752% | 5.508% | 4.495% | 4.831% | 6.170% |
| const-string | 4.044% | 2.631% | 3.634% | 4.723% | 2.542% | 3.579% | 3.133% | 3.387% | 4.371% |
| if-z | 3.792% | 5.777% | 4.974% | 4.499% | 5.561% | 4.663% | 6.745% | 5.976% | 5.160% |
| new-instance | 2.882% | 3.361% | 3.392% | 3.210% | 2.931% | 3.438% | 2.849% | 2.591% | 3.119% |
| goto | 2.581% | 3.369% | 2.845% | 3.007% | 3.883% | 2.650% | 4.191% | 3.857% | 3.479% |
| arith-int | 2.303% | 3.179% | 3.074% | 2.331% | 3.109% | 1.255% | 2.417% | 2.617% | 2.754% |
| invoke-interface | 2.071% | 2.052% | 3.022% | 2.376% | 2.681% | 2.575% | 1.411% | 2.040% | 2.605% |
| iget-32 | 1.994% | 1.562% | 1.357% | 1.658% | 1.604% | 1.052% | 2.588% | 2.144% | 1.516% |
| move-object | 1.992% | 2.340% | 1.569% | 1.646% | 3.621% | 1.183% | 1.660% | 1.902% | 3.428% |
| if | 1.807% | 2.423% | 2.539% | 2.042% | 2.320% | 1.691% | 2.697% | 2.597% | 2.060% |
| iput-obj | 1.647% | 1.673% | 1.673% | 1.802% | 2.162% | 2.427% | 2.224% | 1.946% | 2.095% |
| move | 1.515% | 1.685% | 0.802% | 1.272% | 1.801% | 0.842% | 1.946% | 1.773% | 1.683% |
| throw | 1.452% | 1.719% | 1.651% | 1.092% | 0.514% | 0.624% | 0.500% | 0.537% | 0.752% |
| move-exception | 1.148% | 0.851% | 0.780% | 0.792% | 0.316% | 0.322% | 0.326% | 0.340% | 0.287% |
| iput-32 | 1.104% | 0.714% | 0.686% | 0.953% | 0.967% | 0.533% | 1.626% | 1.156% | 0.909% |
| check-cast | 1.103% | 1.139% | 1.130% | 1.248% | 3.402% | 1.762% | 2.388% | 2.347% | 3.201% |
| sget-obj | 1.014% | 2.094% | 1.902% | 1.395% | 2.569% | 1.663% | 1.262% | 1.531% | 2.431% |
| nop | 1.001% | 0.606% | 0.422% | 0.594% | 0.074% | 0.020% | 0.092% | 0.110% | 0.071% |
| monitor | 0.514% | 0.972% | 0.444% | 0.616% | 0.233% | 0.320% | 0.280% | 0.275% | 0.211% |
| const-wide | 0.499% | 0.765% | 0.232% | 0.336% | 0.642% | 0.488% | 0.293% | 0.772% | 0.593% |
| iget-8 | 0.480% | 0.421% | 0.353% | 0.427% | 0.500% | 0.433% | 0.760% | 0.612% | 0.489% |
| conv | 0.452% | 0.702% | 0.331% | 0.401% | 0.444% | 0.351% | 0.603% | 0.610% | 0.454% |
| arith-long | 0.429% | 0.851% | 0.173% | 0.452% | 0.478% | 0.186% | 0.267% | 0.679% | 0.359% |
| iput-8 | 0.384% | 0.320% | 0.375% | 0.362% | 0.318% | 0.349% | 0.697% | 0.463% | 0.302% |
| iget-wide | 0.329% | 0.374% | 0.173% | 0.336% | 0.543% | 0.293% | 0.167% | 0.515% | 0.493% |
| sput-obj | 0.319% | 0.576% | 0.481% | 0.427% | 0.582% | 0.600% | 0.371% | 0.465% | 0.547% |
| new-array | 0.273% | 0.398% | 0.407% | 0.316% | 0.165% | 0.368% | 0.229% | 0.758% | 0.172% |
| array-length | 0.253% | 0.688% | 0.498% | 0.359% | 0.254% | 0.202% | 0.233% | 0.314% | 0.218% |
| arith-float | 0.238% | 0.010% | 0.005% | 0.007% | 0.254% | 0.179% | 0.662% | 0.292% | 0.264% |
| aget-32 | 0.214% | 0.254% | 0.047% | 0.253% | 0.142% | 0.123% | 0.247% | 0.180% | 0.140% |
| move-wide | 0.196% | 0.373% | 0.232% | 0.157% | 0.332% | 0.089% | 0.099% | 0.304% | 0.274% |
| iput-wide | 0.192% | 0.200% | 0.123% | 0.226% | 0.174% | 0.186% | 0.087% | 0.240% | 0.147% |
| aget-obj | 0.179% | 0.421% | 0.533% | 0.265% | 0.210% | 0.161% | 0.270% | 0.308% | 0.211% |
| instance-of | 0.177% | 0.301% | 0.321% | 0.195% | 0.414% | 0.259% | 0.356% | 0.416% | 0.369% |
| invoke-super | 0.155% | 0.204% | 0.220% | 0.124% | 0.103% | 0.350% | 0.277% | 0.177% | 0.183% |
| packed-switch | 0.147% | 0.053% | 0.039% | 0.108% | 0.136% | 0.037% | 0.169% | 0.178% | 0.122% |
| const-class | 0.142% | 0.214% | 0.242% | 0.160% | 0.133% | 0.189% | 0.175% | 0.131% | 0.134% |
| aput-32 | 0.131% | 0.165% | 0.037% | 0.153% | 0.101% | 0.229% | 0.151% | 0.120% | 0.099% |
| filled-new-array | 0.127% | 0.086% | 0.128% | 0.303% | 0.132% | 0.336% | 0.197% | 0.094% | 0.152% |
| aput-obj | 0.120% | 0.805% | 0.358% | 0.382% | 0.286% | 0.112% | 0.113% | 1.792% | 1.293% |
| cmp-long | 0.112% | 0.452% | 0.106% | 0.173% | 0.208% | 0.197% | 0.156% | 0.337% | 0.170% |
| cmp-float/double | 0.077% | 0.049% | 0.010% | 0.024% | 0.120% | 0.077% | 0.185% | 0.157% | 0.116% |
| divrem-int | 0.056% | 0.098% | 0.047% | 0.061% | 0.038% | 0.074% | 0.069% | 0.052% | 0.043% |
| arith-double | 0.055% | 0.039% | 0.000% | 0.024% | 0.103% | 0.055% | 0.111% | 0.096% | 0.095% |
| aget-8 | 0.049% | 0.152% | 0.118% | 0.128% | 0.056% | 0.003% | 0.061% | 0.060% | 0.046% |
| sget-8 | 0.037% | 0.031% | 0.153% | 0.062% | 0.015% | 0.016% | 0.033% | 0.022% | 0.014% |
| conv-f2i/l (sat) | 0.034% | 0.007% | 0.000% | 0.002% | 0.022% | 0.058% | 0.081% | 0.045% | 0.028% |
| fill-array-data | 0.032% | 0.045% | 0.072% | 0.031% | 0.014% | 0.012% | 0.049% | 0.076% | 0.022% |
| sparse-switch | 0.032% | 0.028% | 0.054% | 0.029% | 0.005% | 0.003% | 0.011% | 0.016% | 0.004% |
| aget-wide | 0.031% | 0.135% | 0.000% | 0.033% | 0.060% | 0.008% | 0.014% | 0.078% | 0.051% |
| aput-8 | 0.030% | 0.088% | 0.131% | 0.091% | 0.026% | 0.003% | 0.029% | 0.040% | 0.025% |
| sget-32 | 0.026% | 0.129% | 0.607% | 0.034% | 0.093% | 0.054% | 0.097% | 0.157% | 0.157% |
| iget-16 | 0.023% | 0.055% | 0.106% | 0.020% | 0.007% | 0.025% | 0.015% | 0.013% | 0.006% |
| aput-wide | 0.017% | 0.069% | 0.002% | 0.017% | 0.021% | 0.006% | 0.007% | 0.035% | 0.018% |
| iput-16 | 0.015% | 0.014% | 0.042% | 0.010% | 0.002% | 0.004% | 0.008% | 0.007% | 0.002% |
| divrem-long | 0.014% | 0.079% | 0.047% | 0.013% | 0.013% | 0.066% | 0.014% | 0.036% | 0.009% |
| sput-8 | 0.014% | 0.021% | 0.039% | 0.013% | 0.006% | 0.005% | 0.012% | 0.008% | 0.005% |
| sput-32 | 0.013% | 0.044% | 1.362% | 0.012% | 0.013% | 0.009% | 0.007% | 0.010% | 0.022% |
| aget-16 | 0.009% | 0.090% | 0.192% | 0.043% | 0.023% | 0.030% | 0.012% | 0.018% | 0.021% |
| conv-d2i/l (sat) | 0.009% | 0.007% | 0.005% | 0.006% | 0.008% | 0.011% | 0.012% | 0.016% | 0.007% |
| sget-wide | 0.006% | 0.053% | 0.002% | 0.012% | 0.064% | 0.002% | 0.050% | 0.053% | 0.042% |
| aput-16 | 0.005% | 0.060% | 0.106% | 0.022% | 0.011% | 0.019% | 0.006% | 0.008% | 0.011% |
| sput-wide | 0.003% | 0.033% | 0.010% | 0.007% | 0.019% | 0.002% | 0.012% | 0.032% | 0.014% |
| rem-float | 0.001% | 0.000% | 0.000% | 0.000% | 0.001% | 0.000% | 0.003% | 0.001% | 0.001% |
| invoke-custom | 0.000% | 0.000% | 0.007% | 0.001% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sget-16 | 0.000% | 0.014% | 0.005% | 0.000% | 0.000% | 0.001% | 0.000% | 0.000% | 0.000% |
| rem-double | 0.000% | 0.000% | 0.000% | 0.000% | 0.001% | 0.000% | 0.001% | 0.001% | 0.001% |
| invoke-polymorphic | 0.000% | 0.069% | 0.005% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sput-16 | 0.000% | 0.002% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |

