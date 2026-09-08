# PLAN — running AOSP's own framework instead of writing it

Work queue for the framework-bytecode effort. **Read `AGENTS.md` first** — it holds current project invariants and verification commands. Historical investigations
and negative results live in [the implementation history](docs/implementation-history.md);
quoted investigation titles below refer to that document.

## Why this exists

Hand-writing `android.*` cannot terminate: the boundary we own has no closed definition, so
the work queue is driven by whichever apk crashed last. AOSP's boundary *is* closed. `View`,
`ViewGroup`, `TextView`, `ViewRootImpl`, `Resources`, `TypedArray` and `StaticLayout` declare
**zero** native methods — the layer that costs the most to hand-write is pure Java sitting on
a fixed JNI line. Run AOSP's bytecode; own only that line.

See “One build, or none” and “The delegates” in the implementation history.

## Where this stands

| | state |
|---|---|
| Framework provenance | `bun run gen-framework` pulls the jar + res pair off the reference AVD and proves the ids agree (0 wrong paired, 3,582 wrong against a relinked table) |
| Policy | `src/jvm/provenance.ts`. `BYTECODE` is empty by default; `?bytecode=<prefix,...>` on the shell URL and `WEBDROID_BYTECODE=` for the e2e driver cut a subtree over **for one run**, no rebuild |
| Delegates | `src/android/delegates.ts` routes framework natives into the same graphics/resource/text implementations used by TS. `fwtest` reports current coverage and real-bytecode evidence. |
| Regression evidence | Current scores and rendered-step counts live in `tests/e2e/report/report.json`; per-step diagnostics and costs live in `tests/e2e/actual/`. The pre-cleanup run had known Mihon scheduler/Compose failures and variable live Harmonic content; compare against the starting commit before attributing a regression. |
| Corpus | `bun run corpus` reports current breadth. Focused Among Us testing reaches Practice; a boot-only corpus pass does not establish gameplay. |
| Native tier | ARM32 **and AArch64**. Among Us executes Unity/IL2CPP through a shared cold interpreter and bounded hot-block compiler. Practice on The Skeld renders and accepts joystick movement, with empty reached missing-API telemetry. Controlled gameplay remains roughly 4–9 fps; online play is unverified. See "Among Us: Practice and code-cache pressure" in the implementation history. |
| Flutter | Lichess executes its ARM64 Flutter/Dart code, renders its UI, connects over verified native TLS, and accepts board and text input. A local game completed ten moves and ten replies from its bundled Fairy-Stockfish engine after allocator reuse fixes. See "Lichess: native heap reuse during computer games" in the implementation history; this does not establish every feature or account flow. |
| Mihon | Keiyoushi repository and MangaDex installation persist. The visible catalog, saved library, chapter reader, page turns, and resume work. Search subscription and selection of the requested host folder remain under investigation; see the implementation history for reached APIs and native image-decoding evidence. |
| Screen | a resolved **setting**, default 1080x2424 @480dpi (360x808dp). `?screen=WxH@dpi`, `WEBDROID_SCREEN`, or the shell's own panel. The gate stays pinned to each flow's goldens — see "The screen is a setting" in the implementation history |

## What a cut costs — measured, not projected

This is the thing that changed the plan, and the next reader should start here. Full write-up:
"What a cut costs, measured" in the implementation history.

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
"Generality: what a device without the thing reports" in the implementation history.

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
yet" in the implementation history in full before touching this.

Summary: 490M sync calls/s against 20M async; the analysis works and says 40% of reachable
bodies cannot suspend; it is off (`?sync=1`) because 67 of our natives return a promise without
being `async` (`HashMap.get` runs a user `hashCode`). Assuming every native suspends is sound
and yields 13.7%, which the existing syntactic rule already gets.

`maySuspend(fn)` now lets a native declare conditional suspension without wrapping the function
or changing its synchronous returns. The oracle and `natcheck` honor it; map insertion uses it.
The declaration audit is incomplete, so a clean Lichess startup scan does not justify enabling
the sync tier globally.

**The move that unblocks it: finish declaring native re-entry.** Not a generated list —
lists are coverage-dependent and were measured failing. Options worth designing:
- Route every re-entry through one helper and mark the natives that use it at registration.
- Split re-entrant natives into a declared category in `NativeSpec`.
- Make `vcall` and friends impossible to call from a native that has not declared it.

`bun run natcheck` is the instrument. **Do not attempt the tier without solving this first** —
it has been tried three ways and measured.

## 5. Native tier — remaining work

- A64 SIMD/FP, JNI, Bionic host services, EGL/GLES3, and NDK libraries are implemented far
  enough for Among Us Practice on The Skeld. Cold instruction families share handlers; hot
  blocks compile after the configured threshold and are bounded by the compiled-code cache.
- Practice renders and accepts movement, but gameplay is not yet smooth. Profile real play
  before changing CPU, graphics, or cache policy; preserve the hardware-oracle and cache tests.
- Local UDP supports process-local sessions. External UDP has no relay. Native TLS uses a
  pinned AOSP trust store and works in Lichess. Google account services and Among Us online
  play remain unfinished or unverified.
- Asset packs use range-backed reads with bounded caching. Do not restore whole-pack browser
  downloads or treat asset data as the cause of the previously measured executable-code GC storm.
- Thumb-2, symbol-version/ifunc support, and additional relocation formats are separate work;
  inspect actual library requirements before extending them. Unsupported relocations must
  continue to fail explicitly.
- A different execution backend remains a measured architectural decision, not cleanup work.
  Preserve split low/high registers, lazy compilation, shared cold handlers, and invalidation.

## 6. Corpus and coverage

- **`gen-framework` should also pull `core-icu4j.jar`** from the i18n apex. Framework bytecode
  on any locale path needs `android/icu/*`, and it is not in `framework.jar`.
- Point `bun run corpus` at an F-Droid pull, not just `apks/`. The ranking is only as good as
  the corpus.
- Automate the tree-diff (`tests/e2e/lib/tree.ts` pairs `uiautomator dump` against
  `wd.uiTree()`) across the corpus: it needs no hand-authored golden, so it gives a numeric
  layout-fidelity score for arbitrary apps. That is the only honest way to claim generality.
- Front-end generality is **done** — quickened opcodes, v41 dex containers, parameter
  annotations and header validation all landed; quickened opcodes, containers and header
  validation have tests (`src/jvm/opcodes.test.ts`, `src/jvm/dex.test.ts`), **parameter
  annotations (`src/jvm/dex.ts`) do not** — that is the one shape with no regression test.
  CompactDex (`cdex001`) is rejected incidentally, by the `dex\n` magic check, which is the
  right answer since its `code_item` differs — but nothing in `dex.ts` names CompactDex, so a
  reader searching for it finds nothing.

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
   leaves the path empty; `setPolyToPoly` reports failure for true perspective mappings. A plausible
   wrong value is worse than an honest empty one, because nothing will ever flag it.
6. **Every commit is one idea**, in the project's lowercase `area: sentence` style, and says
   what was measured.
7. **Negative results get recorded in the implementation history and rejected code deleted.**

# How to verify anything

The commands, the janitor greps and the private-port rule live in **AGENTS.md's "Verify" section** — run them from there, so there is one copy to keep true. The cut-scoring form is
the one thing specific to this file:

```bash
WEBDROID_BYTECODE='android/graphics/Paint,android/graphics/Canvas' \
  WEBDROID_URL=http://localhost:4090 bun run e2e --test fitnotes
```

**Reading the scores.** fitnotes and mihon-onboarding are repeatable to the digit; mihon-app
spreads ~1.4 (measured over seven runs -- see "Harness notes" in the implementation history), so only fitnotes is
a tight gate. **harmonic spreads ~6 points run to run on identical code**
because it renders live Hacker News — see "Harness notes" in the implementation history for the measurements, and
A/B against the parent commit before believing anything. Read `draws`/`drawMs` beside the
per-step content diff, never alone.

After any milestone, *look* at harmonic, mihon and fitnotes in a real browser — a dark-only or
small-region defect can be invisible to the scored diff (the ripple-mask white rectangle was).
On the MCP tab's throttling see "Measure in a page the browser is actually drawing".
