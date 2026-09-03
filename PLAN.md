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
| Policy | `src/jvm/provenance.ts` — `BYTECODE` is **empty**; nothing is cut over yet |
| Delegates | `src/android/delegates.ts` — Paint 86/86, Canvas 33/33, BaseCanvas 32/32, Matrix 40/40, Path 43/43, Typeface 17/17, AssetManager 55/55, XmlBlock 22/22, StringBlock 5/5 |
| Graphics cut coverage | 295/363 declared natives (Bitmap 42/46) |
| Evidence | `bun run fwtest` runs real bytecode headless: `new Paint()`, `new Matrix()`, `new Path()`, three AssetManager lookups against the real framework table, and `android:layout/alert_dialog` opened through `nativeOpenXmlAsset` and walked to END_DOCUMENT |
| e2e | 46.67% overall, every step rendered — flat against main |
| Corpus | `bun run corpus` 9/10 render a frame (only Among Us does not; `WEBDROID_URL` picks the server) |

## The shape of the endgame, and why the order is what it is

A cut is bounded by **two** costs, not one:

1. the natives it needs (what `fwtest` counts), and
2. **the references from `src/` that would have to be rehomed** — every hand-written TS site
   that holds the class and reads its JS properties. Bytecode spells the same fields
   `f$name$hash`, so those sites break.

`bun run audit <apk> --framework --cut <prefix>` reports both. Measured today:

```
cut android/view/ android/widget/      209 specs, 1760 references   (425 hold JView)
cut android/content/res/ android/graphics/    90 specs, 1443 references   (129 hold JCanvas)
```

So **a cut must be downward-closed in the TS reference graph**: the view stack moves with
everything above it, or not at all. Leaves-first moves the problem rather than shrinking it.
That is why B1/B3 (delegates, additive, nothing breaks) come before B2 (the flip).

---

# Work items

Each item says why, what, how it is verified, and the traps. Do them roughly in order;
items marked **[parallel]** do not block anything.

## 1. Finish the delegate layer

The rule for all of these: **write a delegate because `fwtest` said the bytecode reached it,
not because a list has a row.** Run `bun run fwtest <prefix>` first, implement what it names,
re-run. Get the exact descriptors from `bun run fwscan vendor/aosp/framework.jar <prefix>` —
never guess a signature; `nSetTextLocales` returns `I`, not `V`, and that cost a round trip.

### 1.1 Bitmap — **DONE** (42/46)
`graphics: a bitmap does not need a raster to be a bitmap`. 253/363 -> 295/363 on `bun run
fwtest`. `JBitmap`'s raster is lazy and its pixels are the store until one exists, so AOSP's
own `Bitmap.createBitmap` + setPixel/getPixel/getPixels/eraseColor round-trip headless.
Left of the 46: the two Parcel natives and `copyPixelsTo/FromBuffer`, none reached.
`BitmapFactory`/`BitmapRegionDecoder`/`BitmapShader` are unwritten for the same reason.

### 1.2 XmlBlock + StringBlock — the layout-inflation path — **DONE**
`res: the XmlBlock behind nativeOpenXmlAsset, and a file resource is a path`. 53/97 -> 82/97 on
`bun run fwtest android/content/res/`. `axml.ts`'s walk records the pool indices, TEXT and line
numbers the tree drops; the parse state is a `JAttrSet`, so obtainStyledAttributes serves it
unchanged. ApkAssets (12) stays unwritten — no bytecode reaches it. See "The delegates" in
AGENTS.md for the two traps it turned up.

### 1.3 Text: LineBreaker (10) + MeasuredText (11) + Font/FontFamily (~11)
**Why:** `StaticLayout` and `Layout` declare **zero** natives, so real AOSP line breaking
comes free once these exist — and text is both the biggest fidelity gap and the hottest path
(harmonic makes 229,334 measurements per run).
**What:** `nComputeLineBreaks` over the existing `measureText` memo. Start with the greedy
strategy; AOSP's balanced/optimal are a later, separate change.
**Verify:** compare the break positions AOSP's `StaticLayout` produces against the current
`JLayout` on the same paragraph — they should agree on the greedy strategy.
**Traps:** see "Text metrics: ascent/descent are the font's, line boxes are
includeFontPadding's" in AGENTS.md. Do not re-derive that.

### 1.4 The small effects classes **[parallel]**
PathMeasure (9), PathIterator (4), PathEffect (1), PathDashPathEffect (1),
PaintFlagsDrawFilter (1), CanvasProperty (2). `src/android/path.ts` already has a
`JPathMeasure`. Cheap, mechanical, unblocks nothing — do them when they show up in `fwtest`.

### 1.5 Do NOT implement: BaseRecordingCanvas (32), RenderNode (58), HardwareRenderer (72), SurfaceControl (115)
These are the display-list path. Forcing the **software** draw path is the entire reason they
are off the boundary — that is layoutlib's trick and it takes ~277 natives off the total. RTA
cannot see that `mAttachInfo.mHardwareAccelerated` is false, so the audit lists them; they are
statically reachable and dynamically dead. **Registering their draw ops silently re-opens the
hardware path.** If a delegate for one of these seems necessary, the real bug is that
something is on the hardware path and should not be.

## 2. The spine — what a Context has to answer

### 2.1 System services without Binder
**Why:** real framework code reaches everything through `Context.getSystemService` →
`ServiceManager` → an AIDL `Stub.Proxy` → `Parcel`. We have no Binder.
**What:** AIDL's generated `Stub.asInterface(IBinder)` calls
`obj.queryLocalInterface(DESCRIPTOR)` and, if it gets a non-null `IInterface`, **returns it
directly and never parcels anything**. So implement `ServiceManager.getService(name)` to
return a JS `IBinder` whose `queryLocalInterface` hands back a TS object implementing that
interface. Mechanical, works for every AIDL service, no transaction codes.
**Verify:** `fwtest` asking a real `ContextImpl` for a service and getting a local object.
**Traps:** `SystemServiceRegistry` is the machine-readable list of what exists — read it
rather than enumerating by hand. An unmodelled service must be **null**, not a stand-in: see
"Generality: what a device without the thing reports" in AGENTS.md.

### 2.2 Parcel — 57 natives. **Decide before building.**
Needed for `Bundle`, `Parcelable` and saved instance state, *not* for services if 2.1 lands.
It is a byte buffer with a documented layout, so it is real but bounded work. **Open question:
is `Bundle` reachable without it?** Answer that with `bun run audit --framework --from
android/os/Bundle` before writing anything.

### 2.3 MotionEvent — 52 natives
Input. `JMotionEvent` exists and is the object. Straightforward, but it is on the tap path,
so measure `inputMs` before and after.

### 2.4 ViewRootImpl / AttachInfo and the software draw path — **decision, then code**
Real `View.draw` has two paths and the flag decides. Establish, with a `fwtest` exercise, that
a `ViewRootImpl` configured for software drawing reaches `draw(Canvas)` and never touches
`RenderNode`. **Everything in 1.5 depends on this being true.** If it is not, the cut costs
277 more natives and the plan changes.

## 3. B2 — the cut itself. Do not start until 1 and 2 are done.

The 1,760 references are the work, not the natives. Suggested shape, in order:

1. **Rehome the TS references behind accessors first, while everything still works.** Every
   `v.left` on a `JRect`, every `p.color` on a `JPaint`, becomes a call. This is mechanical,
   reviewable, and each step keeps e2e green. It is most of the effort.
2. **Flip one downward-closed set at a time** by adding a prefix to `BYTECODE`, running
   `bun run e2e`, and reading the side-by-sides. Candidate first set: `android/content/res/`
   + `android/graphics/` (90 specs, 1443 refs) — it has no dependency on the view stack, and
   1.1–1.3 are exactly its natives.
3. **The view stack last** (209 specs, 1760 refs), which is where the fidelity win is.

**Traps:**
- A native spec's `fieldTable` holds only what `fields:` declared — almost nothing. Bytecode
  doing `iget` on a native superclass misses, logs, and reads `undefined` **with no throw**.
  A cut must include the whole super chain. `android/view/View`'s super is `java/lang/Object`,
  which has no fields, so that boundary is clean by construction.
- Natives must materialize **after** every dex is indexed. Already fixed in `device.ts`; do
  not reorder it. See the commit `runtime: a class's provenance is policy`.
- `vendor/framework-res.apk` (relinked) **cannot** be used with framework bytecode: 3,582 of
  7,825 ids name a different resource. `framework.ts` already switches to the paired package
  when the policy is non-empty. Do not undo that.

## 4. Performance — the sync tier is the largest number in the tree

**Blocked, and not on the analysis.** Read "The sync tier is worth 24x, and we cannot have it
yet" in AGENTS.md in full before touching this.

Summary: 490M sync calls/s against 20M async; the analysis works and says 40% of reachable
bodies cannot suspend; it is off (`?sync=1`) because 67 of our natives return a promise
without being `async` (`HashMap.get` runs a user `hashCode`). Assuming every native suspends
is sound and yields 13.7%, which the existing syntactic rule already gets.

**The one move that unblocks it: make the native layer able to state re-entry.** Not a list —
lists are coverage-dependent and were measured failing. Options worth designing:
- Route every re-entry through one helper and mark the natives that use it at registration.
- Split re-entrant natives into a declared category in `NativeSpec`.
- Make `vcall` and friends impossible to call from a native that has not declared it.

`bun run natcheck` is the instrument: it wraps every native, boots the apks, and reports which
returned a promise without saying `async`. **Do not attempt the tier without solving this
first** — it has already been tried three ways and measured.

## 5. Front-end generality **[parallel]** — **DONE**

All four landed, each with a test that would have caught it:

- **Quickened opcodes** `0xe3–0xf2` have names and lengths, so an odexed dex walks instead of
  throwing on the first one; the compiler stops at the `-quick` suffix *before* the prefix
  matching that would have read a resolved offset as a field index.
- **Dex container v41**: `dexesIn()` walks the headers, and each logical dex keeps the whole
  buffer so container-relative offsets are what every existing read already computes.
- **Parameter annotations** are parsed and reach `Method`/`Constructor.getParameterAnnotations`.
  FitNotes carries 22 methods with them; harmonic and mihon none, because R8 strips them.
- **Header validation**: version, endian tag, header size and every section's bounds. The
  checksum and SHA-1 stay unverified — the zip already CRC'd the same bytes.

**CompactDex** (`cdex001`) is still rejected at the magic check, which is correct: its
`code_item` differs, so support is more than relaxing the check.

## 6. Native tier **[parallel]** — what the remaining apks need

- **Thumb-2 is unimplemented** (`thumb.ts` faults on every 32-bit T32 encoding). Nearly every
  current armeabi-v7a `.so` faults immediately. Highest-value native fix by far.
- **No arm64**, yet `Build.SUPPORTED_ABIS` advertises `arm64-v8a` — a lie a library can act
  on. mihon ships arm64-only `.so`; Among Us is IL2CPP arm64. Worth researching whether the
  CPU tier should target **wasm** rather than JS source for AArch64.
- No `DT_RELR` packed relocations (NDK r23+ default), no ifuncs, no symbol versioning.
- Direct `ByteBuffer` unsupported; no `libandroid.so`, no `libjnigraphics.so`, no `libc++`.

## 7. Corpus and coverage **[parallel]**

- Point `bun run corpus` at an F-Droid pull, not just `apks/`. The ranking is only as good as
  the corpus.
- Automate the tree-diff (`tests/e2e/lib/tree.ts` pairs `uiautomator dump` against
  `wd.uiTree()`) across the corpus: it needs no hand-authored golden, so it gives a numeric
  layout-fidelity score for arbitrary apps. That is the only honest way to claim generality.
- Remaining ranked gaps are in the corpus output; TikTok's are its own arm64 `.so`.

---

# Standing rules for this work

1. **`fwtest` first.** A delegate exists because real bytecode reached it. Speculative
   delegates are unverified code that reads as done.
2. **Signatures come from the dex**, via `fwscan`. Never hand-derive a descriptor.
3. **One copy of each body.** `nDraw*` routes into `canvasMethods`; Path's coordinate walks
   are exported helpers. If a delegate needs a body that lives in a method table, export the
   table or the helper — do not copy it.
4. **Where the backend cannot answer, do nothing rather than something wrong.** `getTextPath`
   leaves the path empty; `setPolyToPoly` reports failure for the 4-point solve. A plausible
   wrong value is worse than an honest empty one, because nothing will ever flag it.
5. **Every commit is one idea**, in the project's lowercase `area: sentence` style, and says
   what was measured.
6. **Negative results get written into AGENTS.md and the code deleted.** That is the house
   style; three approaches to the sync tier are recorded there precisely so they are not
   retried.

# How to verify anything

```bash
bun run typecheck && bun run test          # must be clean
bun run smoke apks/<apk>                   # 0 method failures
bun run fwtest [prefix ...]                # delegate coverage + real-bytecode evidence
bun run dev &  bun run e2e                 # the gate: 4 scored flows, none may regress
bun run corpus                             # breadth: how many apks still render
bun scripts/perfsum.ts tests/e2e/actual <baseline.json>   # cost, not just pixels
```

Janitor, from AGENTS.md's Verify section:

```bash
grep -rhoE 'name: "[a-z][a-z0-9]*(/[A-Za-z0-9_$]+)+"' src | sort | uniq -d   # must be empty
rg -n 'endsWith\("/' src                                                     # no library names
```

**The grep only sees `name: "..."` literals.** A name registered from a loop (jlang's marker
interfaces, jutil's collection families) is invisible to it, and a duplicate of one passes
clean — check the loops by hand when adding an interface.

Read `draws`/`drawMs` beside the per-step content diff, never alone: a step that wedges draws
fewer frames, so they move with the scroll steps' own instability. See "notes: draws follow
the scroll steps".
