# DEX corpus statistics for the DEX-to-Wasm compiler

Static statistics from 2026-10-04, taken before the compiler was designed. They covered type inference, method shape,
control flow, try/catch and call sites. The register typing measured here became the compiler's
(`src/wasm/compiler/infer.ts`). The scripts loaded DEX through the repo's parser (`src/jvm/{dex,prepared,structure,abi}.ts`)
and opened APKs with `zipTree` and `openInstall`.

Corpora (9): `framework` = `vendor/aosp/framework.jar`; `core-oj` and `core-libart`, the boot jars of those names;
`boot-other`, the other 37 `vendor/aosp/boot/*.jar` pooled; and the apps `mihon` (mihon-v0.20.4.apk), `fitnotes`
(FitNotes.apk), `harmonic`, `newpipe` (org.schabi.newpipe_1015.apk) and `komikku` (Komikku-arm64-v8a-v1.14.1.apk).
That is 704,430 methods with code.

## Provenance

The scripts (`run.ts` the driver, `infer.ts` the statistics over the compiler's `analyzeWebs`, `tables.ts` the renderer,
`crosscheck.ts`, `dbg.ts`, `undet.ts` and their helpers) were deleted in the move to Node and remain in Git history.
They last ran at `844d12be^`: that commit made `components` private in `src/wasm/compiler/infer.ts` (it is now
`componentMask`) and dropped the web states `zero` and `fcon` that `infer.ts` read. The committed `out/` is from
`28d8da41`. Since then the compiler's analysis has changed, so a rerun can differ. Raw numbers are in `out/*.json`, and
the tables (T1–T14, A1) are in [`out/tables.md`](out/tables.md).

## Decision-relevant numbers (measured)

1. **Inference:** all 704,430 methods typed with no merge conflict. Per corpus, 99.5–99.9% are fully determined
   (every live range has one kind); 0.02–0.31% of live ranges remain undetermined (T6).
2. **Register reuse:** 14.8–29.8% of vregs hold two or more kinds at different points, in 33–55% of methods, so a vreg
   is not a type. Only 5–9% of those are due to const-0 alone.
3. **Locals per method,** one per (vreg, kind): mean 3.9–6.0, median 3–4, p99 18–41, max 263 (framework) and 420 (mihon,
   komikku). That is 4% (framework) to 29% (harmonic) more than one untyped i32 per vreg (mean 3.3–4.7). One local per
   live range: mean 7–14, max 6,278 (T7).
4. **Leaf methods** (no invoke) are 13.4–25.2% of methods but hold only 2.4–5.9% of code bytes. Numeric-only leaves are
   5.5–13.9% (0.6–2.1% of bytes) and register-only leaves 1.9–8.7%. 29–48% of methods have at most 4 instructions (T3, T3b).
5. **Method size:** median 18–36 B, p99 0.4–1.1 KiB. 0.1–1.1% exceed 1 KiB, 0–31 methods per corpus exceed 8 KiB, and
   none exceeds 64 KiB. The largest is 39,616 B, a `<clinit>` data table (T10).
6. **Irreducible control flow** is rare: 0–0.21% of methods with precise exception edges. With `Flow`'s defaults, 0–0.5%
   of the methods it was tried on fell back, nearly all Kotlin `invokeSuspend` state machines (mihon 171, komikku 196).
   Framework had 8 "too deep" (AIDL `Stub.onTransact`) (T11).
7. **Exceptions:** 4–13.5% of methods have a try, and 41–74% of try items are catch-all. `RemoteException`, `Exception`,
   `IOException` and `NoSuchFieldError` make up 54% of typed clauses (T4, T4b). DEX try ranges are flat.
8. **Invokes:** virtual 42–58%, interface 6–12%, static 16–27%, direct 15–26%, super ~1%, polymorphic and custom <0.4%.
   Class-hierarchy analysis over the loaded set gives a static target for 82–90% of invoke-virtual sites. Invoke-interface
   is mostly polymorphic: 47–85% of sites have 3+ implementations. 8–25% of callees are in the same class and 21–49% in
   the same package. 35–56% of an app's callees (28% for framework) are outside its own dex (T12–T14).
9. **Analysis cost:** ~2–4 µs median per method, 5–10 µs mean, 26–53 ms per MiB of dex. One warm process, indicative (T8).

## Method and definitions

- **Inference** is a live-range ("web") analysis.
  - Each definition is a node. Liveness is per block. Exception edges run from each throwing instruction to its handlers
    and carry that instruction's pre-state.
  - At a join, only live registers union their nodes, so a web is a maximal live range and register reuse stays visible.
  - Nodes carry a kind mask over {I (boolean through int), F, R (reference or null), J, D}. Defs and uses AND in the mask
    their opcode implies, from fields, protos, returns, array ops, `if-eqz` and switches. A non-zero `const` is I|F,
    `const 0` is I|F|R and `const-wide` is J|D. Moves and `if-eq`/`if-ne` tie kinds without merging ranges.
  - A mask of 0 is a merge conflict. A used web with more than one bit left is underdetermined.
  - Reference classes are not tracked, so a 32-bit `aget`/`aput` stays I|F.
  - `return*` and the non-throwing ops get no handler edge. Treating `return` as throwing produced 98 false conflicts in
    framework.jar, which also showed that conflict detection is not vacuous.
- **Local counts:** (A) DEX frame registers; (B) one i32 per vreg and one i64 per wide pair; (C) distinct (vreg, kind)
  pairs; (D) one local per web, an upper bound. A multi-kind vreg has used webs of two or more kinds. "Only because of
  zero" means it has at most one kind once const-0 webs are ignored.
- **CFG:** reducibility by Hecht-Ullman. Mode A treats the entry and each handler as roots. Mode B adds exception
  edges from throwing blocks and keeps the entry as the only root, which is exact. `Flow` was run with its default
  depth bound (256) on every method with more than one block or a try. The compiler now calls `structureAny` with no
  depth bound, and an irreducible cycle's heads become extra region entries, so T11's fallbacks overstate what
  compilation pays today.
- **CHA:** the receiver type is the method ref's class. Sites count as final class, final method, or by the number of
  non-abstract implementations reachable from loaded concrete subtypes (capped at 3). The loaded set is framework.jar,
  the boot jars and, for apps, the app's dex.

## Cross-validation

`crosscheck.ts` compared const typing with `prepared.ts`'s `constKind` (raw output: `out/crosscheck.txt`).
- Float consts, repo / mine / agree: FitNotes 410/407/407, harmonic 3,194/3,151/3,149, mihon 12,427/12,412/12,411,
  core-oj 118/117/117, framework 4,320/4,241/4,238.
- Double consts: 250/250/250, 259/259/259, 1,931/1,931/1,929, 163/162/162 and 998/998/998.
- The analysis never claims a float the repo does not. It misses 0.1–1.8% of the repo's float consts, each an
  unconstrained I|F web that only reaches a float[] store. Element kinds resolve those.

## Reading the numbers

- No conflicts means every live range of verified DEX can be given a consistent kind. Typing per vreg fails for 33–55%
  of methods because d8/R8 reuse registers across kinds. A const-0 web is two values, int 0 and null, and needs a def
  per use kind. Framework has 85k such webs, about 5%.
- Every sampled underdetermined web is a constant whose only consumer is a 32-bit array op or a compare. This led to
  {i32, f32, i64, f64, ref} locals per web, with an unconstrained constant typed as int.
- Size limits matter only after inlining. The worst method (6,278 webs, 420 split locals, 39,616 B) sits far inside the
  measured 50,000-local and 7.65 MB body limits (`../platform-status.md`).
- Multi-region `Flow` results (12–40%) are exactly the methods with a try. They need exception dispatch, not a general
  CFG fallback.
- 52–70% of direct and static callees in the same corpus are at most 16 code units, and 4–32% are leaves. That is room
  for inlining, not a measured speedup.
- CHA numbers are a closed-world upper bound. Classes load lazily, so the compiler records devirtualization per slot
  and undoes it when a later dex falsifies it.

## Limits

These are static counts with no execution weighting. Receiver types are declared, not flow-sensitive. Quickened
opcodes (0xe3–0xf2) would be skipped; none occurred. `core-oj` and `framework` are on-device binaries, already
d8/R8-processed. `boot-other` counts shared v41 container buffers once. App corpora include their bundled libraries.
Timings are a single warm run on a laptop with decoding excluded.
