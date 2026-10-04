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
bun dbg.ts apks/FitNotes.apk 'LA/c;.p'      # disassembly + inference result of one method (DBG=1 / DBG2=1 add web / liveness dumps)
bun undet.ts apks/FitNotes.apk 5            # methods that keep an unconstrained web
```

Files: `load.ts` (open jars/apks), `opinfo.ts` (opcode families, ART "can throw" table), `cfg.ts` (blocks, exception
edges, Hecht-Ullman reducibility), `infer.ts` (type inference), `cha.ts` (class hierarchy), `run.ts` (driver),
`tables.ts` (renderer). Raw numbers: `out/*.json`; this file's tables are `out/tables.md` verbatim.

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

