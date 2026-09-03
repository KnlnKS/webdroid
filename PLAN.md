# PLAN — running AOSP's own framework instead of writing it

Work queue for the framework-bytecode effort. **Read `AGENTS.md` first** — it holds the
project's invariants and the negative results, and this file does not repeat them. Sections
named below in quotes are AGENTS.md sections.

## Why this exists

Hand-writing `android.*` cannot terminate: the boundary we own has no closed definition, so
the work queue is driven by whichever apk crashed last. AOSP's boundary *is* closed. `View`,
`ViewGroup`, `TextView`, `ViewRootImpl`, `Resources`, `TypedArray` and `StaticLayout` declare
**zero** native methods — the layer that costs the most to hand-write is pure Java sitting on
a fixed JNI line. Run AOSP's bytecode; own only that line.

See "One build, or none" and "The delegates" in AGENTS.md.

## Where this stands

| | state |
|---|---|
| Framework provenance | `bun run gen-framework` pulls the jar + res pair off the reference AVD and proves the ids agree (0 wrong paired, 3,582 wrong against a relinked table) |
| Policy | `src/jvm/provenance.ts`. `BYTECODE` is empty by default; `?bytecode=<prefix,...>` on the shell URL and `WEBDROID_BYTECODE=` for the e2e driver cut a subtree over **for one run**, no rebuild |
| Delegates | `src/android/delegates.ts` — Paint 86/86, Canvas 33/33, BaseCanvas 32/32, Matrix 40/40, Path 43/43, Typeface 17/17, Bitmap 42/46, AssetManager 55/55, XmlBlock 22/22, StringBlock 5/5, LineBreaker 10/10, MeasuredText 5/6 + Builder 5/5 |
| Coverage | `fwtest` 295/363 graphics · `fwtest android/content/res/` 82/97 · `fwtest android/graphics/text/` 20/37 |
| Evidence, headless | `bun run fwtest`: `new Paint/Matrix/Path`, `Bitmap.createBitmap` + pixel round-trip, three AssetManager lookups, `android:layout/alert_dialog` opened through `nativeOpenXmlAsset` and walked to END_DOCUMENT |
| Evidence, in a page | `bun run textcmp`: AOSP's own `StaticLayout` against ours, **6/6 paragraphs break identically** |
| e2e (last full run) | fitnotes 43.07 · mihon-onboarding 17.55 · mihon-app 76.96 · harmonic 33.80 · overall 42.85, every step rendered |
| Corpus | `bun run corpus` 9/10 render a frame; only Among Us does not (IL2CPP arm64) |

## What a cut costs — measured, not projected

This is the thing that changed the plan, and the next reader should start here. Full write-up:
"What a cut costs, measured" in AGENTS.md.

With `android/graphics/{Paint,Canvas,BaseCanvas,Matrix,Path,Typeface,Bitmap}` served by
`vendor/aosp/framework.jar`, **fitnotes runs its whole 39-step flow**: 43.33% content diff
against 43.07% without the cut, 39/39 rendered, 36,926 classes indexed, boot 165ms → 221ms.
fitnotes is repeatable to the digit, so that 0.26 is real and small.

**Exactly three things broke**, and the shape of them reorders the work:

1. **`drawRect(FFFF Paint)` and `drawLine` were "not a function" — on the two views the APP
   draws.** Our framework draws in TS, calling `canvasMethods` bodies directly, so it never
   notices. App bytecode calls the *mangled Java* method on the `JCanvas` it was handed, and a
   cut withholds the spec that put those methods on the prototype.
2. `SystemProperties.native_get` — now a delegate.
3. **`android/icu/util/ULocale` is not in `framework.jar`.** It is in the i18n apex
   (`core-icu4j.jar`), which `gen-framework` does not pull.

So the 1,460 references `audit` counts are **not evenly costly**. Most are TS→TS and survive a
cut untouched. What actually breaks is the far smaller set of places where the framework hands
one of these objects *to app bytecode*. That is the real B2 task, and it is much better shaped
than "rehome 1,460 references".

Refreshed with `bun run audit apks/FitNotes.apk --framework --cut <prefix> …`:

```
cut android/content/res/ android/graphics/   90 specs, 1460 references
    129 JCanvas · 125 JDrawable · 116 JRect · 114 JPaint · 83 JBitmap · 70 JPath · 62 JTheme
cut android/view/ android/widget/           209 specs, 1760 references
```

---

# Work items

Do them roughly in order. **[parallel]** items block nothing.

## 1. The delegate layer — essentially done

Shipped: **Bitmap** (raster made lazily, pixels are the store until one exists — which is also
what lets AOSP's `Bitmap.createBitmap` be exercised with no canvas at all), **XmlBlock +
StringBlock** (the layout-inflation path behind `nativeOpenXmlAsset`), **LineBreaker +
MeasuredText** (real AOSP line breaking, routed into `text.ts`'s `greedyBreaks` so both agree
by construction). `handles.ts` is the handle table, now its own module because AOSP bytecode
asks *our* objects for their native pointer too.

Deliberately **not** written, each because nothing reaches it:
- `ApkAssets` (12) — `nativeCreate` hands back a `Resources` and `nativeSetApkAssets` is a no-op.
- `BitmapFactory` (5), `BitmapRegionDecoder` (8), `BitmapShader` (1) — and `createImageBitmap`
  cannot be exercised outside a browser anyway. `textcmp`'s two-page shape is the pattern to
  copy if these need proving.
- `PositionedGlyphs` (13), `TextRunShaper` (2) — a shaping engine, and there is none behind
  Canvas2D.
- `Font`/`FontFamily` (~26) — the text work turned out not to need them.
- The small effects classes: `PathMeasure` (9), `PathIterator` (4), `PathEffect` (1),
  `PathDashPathEffect` (1), `PaintFlagsDrawFilter` (1), `CanvasProperty` (2). Cheap and
  mechanical when `fwtest` names them.

### **Do NOT implement**: BaseRecordingCanvas (32), RenderNode (58), HardwareRenderer (72), SurfaceControl (115)
These are the display-list path. Forcing the **software** draw path is the entire reason they
are off the boundary — that is layoutlib's trick and it takes ~277 natives off the total. RTA
cannot see that `mAttachInfo.mHardwareAccelerated` is false, so the audit lists them; they are
statically reachable and dynamically dead. **Registering their draw ops silently re-opens the
hardware path.** If a delegate for one of these seems necessary, the real bug is that something
is on the hardware path and should not be.

## 2. B2 — the cut. This is now the main line of work.

The measurement above says start here rather than after §3, and says what to do:

1. **Find where the framework hands a cut class to app bytecode, and hand it an AOSP object
   there instead.** For `Canvas` that is `View.onDraw(Canvas)`, `Drawable.draw(Canvas)` and the
   dispatch sites `drawChild()` already walks; for `Paint` it is every widget that builds one
   and passes it on. The receiver needs to be AOSP's class with `mNativePtr` = `handle(ours)`.
   `Paint.getNativeInstance()` (graphics.ts) is the pattern in the other direction and already
   works. Everything TS→TS keeps calling `canvasMethods` directly and does not change.
2. **Flip one downward-closed set at a time** with `WEBDROID_BYTECODE=`, run `bun run e2e`, and
   read `newMissing` per step in `tests/e2e/actual/<flow>/run.json`. That list is the work
   queue and it is short — three entries for the whole graphics cut.
3. Candidate first set: `android/content/res/` + `android/graphics/` (90 specs). No dependency
   on the view stack, and §1's delegates are exactly its natives.
4. **The view stack last** (209 specs, 1,760 refs), which is where the fidelity win is.

**Traps:**
- **`isBytecode` is a PREFIX match.** `android/graphics/Path` also matches `PathMeasure`,
  `PathEffect`, `PathDashPathEffect` and `PathIterator`, whose natives are unwritten; and
  `android/graphics/Paint` matches `PaintFlagsDrawFilter`. Name classes exactly, or accept the
  subtree knowingly. (`android/graphics/Bitmap` matching `Bitmap$Config` is *wanted* — the
  enum has to come from the same side as the class that returns it.)
- **Once the framework jar is loaded, a class with no spec resolves out of AOSP's dex** instead
  of going missing. That is what makes a partial cut boot, and it also means a cut silently
  pulls in framework classes you did not name. `ULocale` was found that way.
- A native spec's `fieldTable` holds only what `fields:` declared — almost nothing. Bytecode
  doing `iget` on a native superclass misses, logs, and reads `undefined` **with no throw**. A
  cut must include the whole super chain. `android/view/View`'s super is `java/lang/Object`,
  which has no fields, so that boundary is clean by construction.
- Natives must materialize **after** every dex is indexed. Already right in `device.ts`; do not
  reorder it. See the commit `runtime: a class's provenance is policy`.
- `vendor/framework-res.apk` (relinked) **cannot** be used with framework bytecode: 3,582 of
  7,825 ids name a different resource. `framework.ts` already switches to the paired package
  when the policy is non-empty. Do not undo that.
- **A failed draw does not cost the frame** (`perf.drawErrors` counts it and the step still
  renders), which is what makes a half-finished cut measurable at all. Read `drawErrors`, not
  just the score.

## 3. The spine — what a Context has to answer

### 3.1 System services without Binder
**Why:** real framework code reaches everything through `Context.getSystemService` →
`ServiceManager` → an AIDL `Stub.Proxy` → `Parcel`. We have no Binder.
**What:** AIDL's generated `Stub.asInterface(IBinder)` calls `obj.queryLocalInterface(DESCRIPTOR)`
and, if it gets a non-null `IInterface`, **returns it directly and never parcels anything**. So
implement `ServiceManager.getService(name)` to return a JS `IBinder` whose
`queryLocalInterface` hands back a TS object implementing that interface. Mechanical, works for
every AIDL service, no transaction codes.
**Verify:** an exercise asking a real `ContextImpl` for a service and getting a local object.
**Traps:** `SystemServiceRegistry` is the machine-readable list of what exists — read it rather
than enumerating by hand. An unmodelled service must be **null**, not a stand-in: see
"Generality: what a device without the thing reports" in AGENTS.md.

### 3.2 Parcel — 57 natives. **Decide before building.**
Needed for `Bundle`, `Parcelable` and saved instance state, *not* for services if 3.1 lands. A
byte buffer with a documented layout: real but bounded. **Open question: is `Bundle` reachable
without it?** Answer with `bun run audit --framework --from android/os/Bundle` before writing
anything.

### 3.3 MotionEvent — 52 natives
Input. `JMotionEvent` exists and is the object. Straightforward, but it is on the tap path, so
measure `inputMs` before and after.

### 3.4 ViewRootImpl / AttachInfo and the software draw path — **decision, then code**
Real `View.draw` has two paths and the flag decides. Establish, with an exercise, that a
`ViewRootImpl` configured for software drawing reaches `draw(Canvas)` and never touches
`RenderNode`. **The whole "do NOT implement" list in §1 depends on this being true.** If it is
not, the cut costs 277 more natives and the plan changes.

## 4. Performance — the sync tier is the largest number in the tree

**Blocked, and not on the analysis.** Read "The sync tier is worth 24x, and we cannot have it
yet" in AGENTS.md in full before touching this.

Summary: 490M sync calls/s against 20M async; the analysis works and says 40% of reachable
bodies cannot suspend; it is off (`?sync=1`) because 67 of our natives return a promise without
being `async` (`HashMap.get` runs a user `hashCode`). Assuming every native suspends is sound
and yields 13.7%, which the existing syntactic rule already gets.

**The one move that unblocks it: make the native layer able to state re-entry.** Not a list —
lists are coverage-dependent and were measured failing. Options worth designing:
- Route every re-entry through one helper and mark the natives that use it at registration.
- Split re-entrant natives into a declared category in `NativeSpec`.
- Make `vcall` and friends impossible to call from a native that has not declared it.

`bun run natcheck` is the instrument. **Do not attempt the tier without solving this first** —
it has been tried three ways and measured.

## 5. Native tier **[parallel]** — what the remaining apks need

- **Thumb-2 is unimplemented** (`thumb.ts` faults on every 32-bit T32 encoding). Nearly every
  current armeabi-v7a `.so` faults immediately. Highest-value native fix by far.
- **No arm64**, yet `Build.SUPPORTED_ABIS` advertises `arm64-v8a` — a lie a library can act on.
  mihon ships arm64-only `.so`; Among Us is IL2CPP arm64. Worth researching whether the CPU
  tier should target **wasm** rather than JS source for AArch64.
- No `DT_RELR` packed relocations (NDK r23+ default), no ifuncs, no symbol versioning.
- Direct `ByteBuffer` unsupported; no `libandroid.so`, no `libjnigraphics.so`, no `libc++`.

## 6. Corpus and coverage **[parallel]**

- **`gen-framework` should also pull `core-icu4j.jar`** from the i18n apex. Framework bytecode
  on any locale path needs `android/icu/*`, and it is not in `framework.jar`.
- Point `bun run corpus` at an F-Droid pull, not just `apks/`. The ranking is only as good as
  the corpus.
- Automate the tree-diff (`tests/e2e/lib/tree.ts` pairs `uiautomator dump` against
  `wd.uiTree()`) across the corpus: it needs no hand-authored golden, so it gives a numeric
  layout-fidelity score for arbitrary apps. That is the only honest way to claim generality.
- Front-end generality is **done** — quickened opcodes, v41 dex containers, parameter
  annotations and header validation all landed with tests. CompactDex (`cdex001`) is still
  rejected at the magic check, which is correct: its `code_item` differs.

---

# Standing rules for this work

1. **`fwtest` (or `textcmp`) first.** A delegate exists because real bytecode reached it.
   Speculative delegates are unverified code that reads as done.
2. **Signatures come from the dex**, via `fwscan`. Never hand-derive a descriptor.
3. **Argument *meanings* come from the dex too.** `nAddStyleRun(JJIIZIIZ)V` is (builder, paint,
   lineBreakStyle, lineBreakWordStyle, hyphenation, start, end, isRtl) and no reading of the
   descriptor gives you that — `bun run dis vendor/aosp/framework.jar <class> <method>` and the
   register moves into the range invoke do. Same for return encodings: `nGetExtent` packs two
   floats into a long and is left unwritten rather than guess the order.
4. **One copy of each body.** `nDraw*` routes into `canvasMethods`, line breaking into
   `greedyBreaks`, Path's coordinate walks into exported helpers. If a delegate needs a body
   that lives in a method table, export the table or the helper — do not copy it.
5. **Where the backend cannot answer, do nothing rather than something wrong.** `getTextPath`
   leaves the path empty; `setPolyToPoly` reports failure for the 4-point solve. A plausible
   wrong value is worse than an honest empty one, because nothing will ever flag it.
6. **Every commit is one idea**, in the project's lowercase `area: sentence` style, and says
   what was measured.
7. **Negative results get written into AGENTS.md and the code deleted.**

# How to verify anything

```bash
bun run typecheck && bun run test          # must be clean
bun run smoke apks/<apk>                   # 0 method failures
bun run fwtest [prefix ...]                # delegate coverage + real-bytecode evidence, headless
PORT=4090 bun run server.ts &              # NOT 4080 — see the harness note below
WEBDROID_URL=http://localhost:4090 bun run textcmp   # AOSP's StaticLayout against ours, in a page
WEBDROID_URL=http://localhost:4090 bun run e2e       # the gate: 4 scored flows, none may regress
WEBDROID_URL=http://localhost:4090 bun run corpus    # breadth: how many apks still render
bun scripts/perfsum.ts tests/e2e/actual <baseline.json>   # cost, not just pixels

# score a provenance cut — the same bundle, against itself
WEBDROID_BYTECODE='android/graphics/Paint,android/graphics/Canvas' \
  WEBDROID_URL=http://localhost:4090 bun run e2e --test fitnotes
```

Janitor, from AGENTS.md's Verify section:

```bash
grep -rhoE 'name: "[a-z][a-z0-9]*(/[A-Za-z0-9_$]+)+"' src | sort | uniq -d   # must be empty
rg -n 'endsWith\("/' src                                                     # no library names
```

**The grep only sees `name: "..."` literals.** A name registered from a loop (jlang's marker
interfaces, jutil's collection families) is invisible to it, and a duplicate of one passes clean
— check the loops by hand when adding an interface.

**Reading the scores.** fitnotes and mihon-onboarding are repeatable to the digit and mihon-app
to ~0.3, so a move there is real. **harmonic spreads ~6 points run to run on identical code**
(measured 31.80 / 35.87 / 37.84) because it renders live Hacker News — A/B it against the
parent commit before believing anything. Read `draws`/`drawMs` beside the per-step content diff,
never alone.

**Use a private port.** A dev server left running in another worktree answers on 4080 and a run
then measures code you did not write. And after any milestone, *look* at harmonic, mihon and
fitnotes in a real browser — a dark-only or small-region defect can be invisible to the scored
diff (the ripple-mask white rectangle was). The MCP Chrome tab is throttled: check
`document.visibilityState` and that `wd.ticks` and `wd.perf.draws` advance before believing
anything read there.
