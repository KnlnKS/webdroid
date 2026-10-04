# Native / host-glue survey: what a non-JS-object Java heap would touch

Scope: static analysis only (no benchmarks, no browser). Source: worktree `webdroid-wasm`, branch
`knlnks/bytecode-wasm`. "Fact" = counted by script or read in code; "Inference" = my estimate.

## 0. Reproduce

All scripts are under `research/wasm/survey/`; run from the repo root with `bun`.

| Script | Produces |
|---|---|
| `ast-survey.ts` | TypeScript type-checker pass over all non-test `src/**/*.ts` (328 files, 68.8k LOC). Writes `out/ast.json`: per-file site counts, every registered native entry with descriptor and body flags, the 79 TS classes that extend `JObj` |
| `summarize.ts` | Aggregates `ast.json`: entries by kind and scope, flag counts, the descriptor x body cross-tab |
| `coupling.ts` | Per-file coupling score, top-25 ranking, zero-coupling files |
| `byte-movers.ts` | Table for the byte-mover and boundary file groups (section 4) |
| `regex-counts.ts` | Regex cross-checks and registration-style inventory |
| `dollar-props.ts` | Histogram of `$`-prefixed hidden slot names |

Method notes:

- "Java-typed" means the checker says the receiver's class derives from `JObj` (`runtime.ts:29`).
- Bytecode classes are not TS classes, so their fields show up as `any`-typed access, `getDeclared`/`setDeclared`, or string-keyed element access. Those counts are noisier than the typed ones.
- Function-level classification inspects only the native's own body, not helpers it calls. Transitive coupling is therefore undercounted; the per-file site counts complement it.
- LOC by scope (non-test): jvm/natives 11.3k, jvm other 6.6k, android 32.7k, native 12.4k, shell 5.0k, src/top 0.8k.

## 1. Inventory of registration styles

### Fact: the registration APIs (`src/jvm/runtime.ts`)

- **`rt.register(NativeSpec)`** (`runtime.ts:332`, interface at `:37`). A TS class `ctor` stands in for a whole Java class.
  - `methods` maps `"name(desc)ret"`, or `"static name(desc)ret"`, to `fn` with `this` = receiver, or to a string alias of a prototype member.
  - `setupNativeMembers` (`:655`) installs each with `setPublic(proto, mangleMethod(..))`.
  - `fields` maps Java name to JS property name, and `serialization` is similar. Only 6 specs use `fields:`.
- **`rt.registerJnis(cls, table)`** (`:446`), also aliased as `delegate` in `delegates.ts:47`. These are the native halves of AOSP bytecode classes (provenance cut). Key is `name(desc)ret`, `this` is the bytecode object, and statics are not marked in the key.
- **`rt.registerJni(cls, sig, fn)`** (`:441`), one entry at a time: 42 call sites.
- **`rt.intrinsic(cls, {mangled: (base, C) => fn})`** (`:344`): 24 call sites, 66 entries. A TS body over a bytecode class's own fields that wraps the AOSP body.
- **`jniResolver`** (`:451`, set in `native/jni.ts:589`): natives of guest `.so` libraries, resolved by `Java_pkg_Cls_m` export or `RegisterNatives` (`jni.ts:499`). These are machine code (ARM/A64), not TS.
- **`src/natives.ts`** only imports modules in dependency order; it assembles nothing structurally.
- **Generated registrations:** none found. The "generated" regex hits only data (`identity-data`, `device-colors`).

### Fact: counts (`ast-survey.ts`, `regex-counts.ts`)

| Item | Count |
|---|---|
| `rt.register({` calls | 182 regex, 168 with a literal `methods` table |
| `registerJnis(` | 153 calls (30 in jvm/natives, 122 in android, 1 elsewhere) |
| `delegate("...")` alias calls | 33 |
| `registerJni(` calls | 42 |
| `intrinsic(` calls | 24 |
| Registered method entries, AST-resolved | **2,682** (spec 1,017, JNI half 1,599, intrinsic 66) |
| Regex count of `"name(desc)ret":` keys | 3,071 |
| Entries with a resolvable function body | 2,519 (163 unresolved or alias) |
| Spread / shared tables not expanded | 366 (`fieldGetters`, `fieldSetters`, `stubs`, `noops`, `without(...)`) |
| `<init>` entries | 37 |
| Static entries (spec only; JNI keys do not mark statics) | 122 |
| Entries with a Java-typed `this` annotation | 372 |
| Entries whose body uses `this` | 426 |
| Natives written as generators (`driven(`) | 403 (63 jvm/natives, 333 android, 7 shell) |
| Generator functions in scope | 645 |
| TS classes extending `JObj` | 79 (46 in jvm/natives), 223 instance fields, 56 methods |

- The 2,682 vs 3,071 gap (about 390) is entries inside tables the AST pass did not expand: spreads and shared tables, and tables built in helper functions. Treat 2,682 as a floor and about 3.1k as the ceiling.
- By scope, the AST entries are jvm/natives 638, android 2,043, jvm other 1.

### Fact: biggest registrars

`android/delegates.ts` 200, `jvm/natives/jnet.ts` 152, `android/rendernode.ts` 106, `assetmanager.ts` 94, `services.ts` 94, `jlang.ts` 87, `surfaceflinger.ts` 77, `paint.ts` 74, `webkit.ts` 74, `jreflect.ts` 61.

### Fact: how a native receives `this` and args

- **Instance specs and JNI halves:** `fn.call(receiver, ...args)` through the mangled public method. `this` is the JS object. For a native class (`extends JObj`) it is the TS instance with TS-declared fields. For a bytecode class it is the compiled class instance and fields are `f$name$hash` properties, reached through `getDeclared`/`setDeclared` (`runtime.ts:1137,1142`).
- **Static natives:** `this` is the constructor; a caller-sensitive static gets a trailing runtime argument (`runtime.ts:677`).
- **Argument encoding is the JS value model** (AGENTS.md): int/float/double are `number`, long is `bigint`, String is a JS `string`, primitive arrays are typed arrays, object arrays are JS arrays with `$t`, and objects are JS objects.
- **Suspension:** generator natives yield each Java result, value or Promise (`Gen`, `runtime.ts:62`).
- **Guest natives (JNI table in `native/jni.ts`):** the JNIEnv table is 233 slots, with 59 literal `def(n, "Name", ...)` plus loops over primitive types.
  - Handles are 32-bit ints into JS tables: locals live per `Cpu` (`jni.ts:25-47`), globals in one array with `GLOBAL_BIT` (`:23`).
  - `deref(h)` returns the actual JS value.
  - jmethodID and jfieldID are 64-byte zeroed guest blocks mapped to JS records (`:62-66`).
  - Field Get/Set is `o[f.prop]` (`jni.ts:451-454`) and method call is `self[m.mangled]` then `fn.apply` (`invokeBody`, `:184-196`).
  - Primitive arrays are copied into guest memory on pin, with both-way sync at call boundaries (`:279-301`, `:175-186`).

## 2. How natives and glue touch Java values

### 2a. Function-level classification (fact; `summarize.ts`)

Descriptors come from the registration key, so they are exact. Body flags come from the function's own body.

Of the 2,484 resolved entries that have a descriptor (intrinsics excluded):

| Bucket | Entries |
|---|---|
| Descriptor has only int-like, long or void types (no reference) | 1,250 |
| ...and body clean of field, call, retain and identity use = **(a) primitives/handles only** | **1,014** (41%) |
| ...and body flagged | 236 |
| Descriptor has a reference type (String, array, object) | 1,234 |
| ...and body clean (marshals the value only) | 759 |
| ...and body flagged | 475 |
| Total with any body flag (F, C, R, I or X) | 711 (29%) |

- Of the 1,014 pure-primitive natives, 824 are JNI halves and 190 are specs. Many are `nAddRect(JFFFFI)V`-style handle natives.
- Only 9 entries are provably pure because the checker could see every parameter annotation. The 1,014 relies on descriptors, not annotations.

Body flags, overlapping, over the 2,484 resolved entries (it is 2,519 for the first line of the table above):

| Flag | Entries |
|---|---|
| **F**, reads or writes object fields | 297 |
| **C**, calls back into Java (`vcall`/`scall`/`newObj`/`callOn`/`yield*`/`after`) | 276 |
| **R**, retains objects (Map/Set/Weak*/handle ops) | 190 |
| **I**, identity or prototype features | 34 |
| **X**, `any`-typed property access | 17 |
| F and C | 44 |

Descriptor value kinds (any occurrence in params or return):

| Kind | Entries |
|---|---|
| `long` | 1,140 |
| String / CharSequence | 410 |
| Primitive array | 190 |
| Object array | 105 |
| Other object | 778 |

Of the String-bearing entries, 239 have no array or object parameter.

Entry kind split: spec entries (985 resolved) have 190 pure, 255 F, 186 C, 14 R, 20 I. JNI-half entries (1,499) have 824 pure, 42 F, 90 C, 176 R, 14 I. So the spec natives (TS-implemented Java classes) are the field- and call-coupled ones, and the JNI halves are mostly handle plumbing.

### 2b. Site-level counts (fact; whole scope; `ast-survey.ts`)

**(b) Field access**

| How the field is named | Sites |
|---|---|
| `this.foo` on a TS class extending `JObj` (typed, receiver `this`): R 478, W 160 | 638 |
| `obj.foo` on a typed Java object (other receiver): R 229, W 151 | 380 |
| Total TS-declared-field sites | 1,018 |
| `getDeclared`/`setDeclared`/`declaredField`/`fieldOf`, bytecode fields by class + Java name | 276 |
| `$`-prefixed hidden slots (`$i` 29, `$t` 11, `$hash`, `$position`, `$limit`, ...) | 74 |
| Hidden slots by raw regex (glue 133, jvm core 57) | 190 |
| Property access on an `any`/`unknown` receiver (bytecode objects reached untyped): R 213, W 20 | 233 |
| String-keyed element access on object/any (`obj[mangled]`, `info.ctor[mangleStaticField(..)]`) | 717 (R 416, W 301) |

- The 717 is an upper bound and noisy: it also catches ordinary `Record<string,..>` lookups.
- The 1,018 typed sites concentrate in 10 files: jreflect 179, jnet 161, webkit 147, jlang 110, jstring 66, jinvoke 61, jthread 60, jthrowable 29, jdex 28, resnative 17 (858 of 1,018). They sit on only 79 TS classes with 223 declared instance fields.
- So the typed-field problem is bounded. The larger unknown is `any`/dynamic/helper access to bytecode-class fields: about 276 + 233 + part of 717.

**(c) Calling into Java**

| Site | Count |
|---|---|
| `vcall` | 812 |
| `newObj` | 303 |
| `scall` | 138 |
| `staticField` | 21 |
| `callOn` | 16 |
| `linkInit` | 8 |
| `vcallOn` | 3 |
| Total Java-call helper sites | **1,301** |
| `after(...)` | 256 |
| `yield*` | 854 |
| `yield` | 1,278 |
| `driven(` | 403 |

- By scope, the helpers are android 1,086, jvm/natives 170 and shell 33.
- 18 files hold 678 of the 1,301 sites (6,957 LOC). They are the hosted system services: notification 122, services 59, printing 55, atm 52, wm 44, accounts 42, pm 34, jnet 32, locationmanager 29, am 27, appwidget 26, webkit 25, jlang 24.
- All of them identify the Java method by name and descriptor at runtime: `obj[mangleMethod(name, desc)]` in `jentry.ts:22-37`.
- Calls are therefore already centralized behind about 8 helper functions. This is a favourable property.

**(d) Retaining Java objects JS-side**

| Declaration | Total `new` | Object-ish value or key | Declared with a Java-typed arg |
|---|---|---|---|
| `Map` | 406 | 321 | 15 |
| `Set` | 187 | 122 | 5 |
| `WeakMap` | 79 | 72 | 11 |
| `WeakSet` | 8 | 5 | 2 |
| `WeakRef` | 5 | 5 | 3 |
| `FinalizationRegistry` | 10 | 7 | n/a |

- Handle ops (`handle`/`weakHandle`/`ownedHandle`/`take`/`release`): 310 sites. `deref`: 236 sites (android 177, native 38, jvm/natives 21).
- Handle table: `src/android/handles.ts:12-60`, a plain `objs[]` array plus a `WeakMap<object,bigint>`.
  - A handle is a Java `long`. The released-slot quarantine (1,024) exists because framework Java compares native pointers.
  - `weakHandle` uses `WeakRef` plus `FinalizationRegistry` (`handles.ts:41-56`).
- JNI tables: `globals: unknown[]` and per-Cpu `refs` (`jni.ts:23-26`), plus `pinned`/`pinsOf` Maps keyed by array.
- Parcels keep binders and other objects in a side table (`parcel.ts:17` `objects = new Map<number, unknown>()`, with `setParcelBytes(..., objects)` at `:180`).
- Lifetime hazards (inference):
  - Many retained values are host classes (NativeBitmap, NativePath, ...) that never are Java objects. The "object-ish" counts overstate Java-object retention.
  - The truly Java-typed retainers are only about 36 declarations by type, plus the unknown share of the `any`-typed ones, JNI globals/locals, `parcel.objects`, and `rt.monitors`.
  - Reachability today is the JS GC's: a `WeakMap<JavaObj,...>` or `FinalizationRegistry` works because Java objects are ordinary JS objects.

**(e) Strings, arrays, longs**

| Item | Count |
|---|---|
| Entries with String/CharSequence in descriptor | 410 |
| `typeof x === "string"` tests | 77 |
| `csText(` calls | 11-12 |
| Entries with a primitive-array descriptor | 190 |
| `new <TypedArray>(` sites | 500 |
| `jarray(` calls (builds a `$t`-tagged object array) | 111 |
| `.$t` reads | 11 |
| Entries with an object-array descriptor | 105 |
| Entries with a `long` descriptor | 1,140 |
| BigInt literals | 639 |

- Strings never need a layout today; they are JS strings.
- Non-movable `byte[]` already lives in guest memory: `nonMovableBytes` returns an `Int8Array` over the core's memory (`jnio.ts:129-137`).

**(f) JS identity and prototype features**

| Feature | Sites |
|---|---|
| `instanceof` a Java class | 36 |
| `instanceof` other (Array, typed arrays, Map, host classes) | 162 |
| `===`/`!==` where either side is a typed Java object | 29 |
| `===`/`!==` between non-primitive, non-any operands | 164 |
| `===`/`!==` between `any` operands | 34 |
| `.constructor` | 41 |
| `.$i` (ClassInfo) | 29 |
| `getPrototypeOf` / prototype `defineProperty` | 15 |
| `TYPE_MARK` (`$I$` type-mark on prototypes; `runtime.ts:124`) | 4 |

Identity-by-`===` on Java refs is cheap to keep: opaque Wasm GC refs still compare with `===` in JS. `instanceof Foo` and `.constructor.$i` do not survive for opaque refs.

## 3. What a mechanical migration looks like (inference built on the counts above)

### 3.0 Common prerequisites in all three designs

- The registration tables (2.7k to 3.1k entries) are keyed by name and descriptor. The key set can stay unchanged; the installer (`setupNativeMembers`, `rt.registerJni`, and `compiler.ts:208`'s `R.jniFn(...)` lookup) changes.
- Entry points are called by emitted Wasm as imports, so the host function signature must be expressible in the Wasm import (i32/i64/f32/f64/externref/anyref).
- The 1,014 pure-primitive natives and the 410 String natives then keep their JS bodies unchanged, if strings stay JS strings via externref or the js-string builtins. If strings move into Wasm memory, the 410 plus 77 `typeof` tests change.

### 3.1 Per category and design

| Category | Sites or functions | (i) Wasm GC + exported accessors | (ii) Linear-memory heap, layout-driven accessor API | (iii) Byte movers rewritten Wasm-side |
|---|---|---|---|---|
| (a) prims/handles only | 1,014 natives | No body edits. Only the bridge import/export signature changes | Same: no body edits | Candidates are the pure numeric ones (matrix, path math, bitmap conversion). 1,014 is the pool, not the cut |
| (a') ref pass-through, body clean | 759 natives | No edits if refs stay opaque. Edits where an array or String must be read (see e) | Every ref is an address or handle. The marshalling wrapper changes, bodies stay | Mostly stays JS |
| (b) typed TS-class fields | 1,018 sites, 79 classes, 223 fields | Rewrite each as a get/set export or generated struct accessor: roughly 223 field accessors plus 1,018 call-site edits. TS classes become Wasm struct types or stay JS objects wrapped by an opaque slot | Same count, but via `heap.i32[addr + OFF_X]` against a layout table. Reads of subclass fields need layout inheritance | Native-class state (jzip's 66 sites; Inflater/Deflater state) moves into Wasm structs along with the algorithm |
| (b') bytecode fields by name | `getDeclared`-family 276 + `any` access 233 + dynamic (part of 717) | 276 helper calls keep their signature (the helper becomes `field_get(cls,name)(obj)`); the 233 `any` accesses must be found and rewritten; the 717 element accesses need triage | Same, with `declaredField` returning an offset instead of a property name | Not applicable |
| (c) call into Java | 1,301 helper sites, about 8 helpers | Helpers `vcall`/`scall`/`newObj`/`callOn`/`staticField`/`linkInit` (`jentry.ts`) are reimplemented against Wasm exports. Edits only where arguments are JS-specific. The 854 `yield*` and 403 `driven` natives keep their shape if suspension stays a JS concern | Same | Not applicable |
| (d) retention | about 36 Java-typed declarations; plus the JNI tables (3), `handles.ts` (1 table), `parcel.objects`, `rt.monitors` | JS can hold opaque refs, so `Map<Obj,...>`, handle tables and JNI globals keep working. Concern: whether `WeakRef`/`FinalizationRegistry` accept GC structs. Needs a probe (see section 6) | A moving or non-JS-visible heap means every JS-held ref must be a rooted slot. 310 handle ops plus 236 `deref` plus about 36 retainers plus JNI globals/locals move to explicit root tables with release discipline | Unchanged |
| (e) strings, arrays | 410 String entries; 190 prim-array; 105 object-array; 500 typed-array constructions; 111 `jarray` | Strings stay externref: no edits. Prim arrays: opaque GC arrays cannot be viewed as typed arrays from JS, so 190 entries + 500 constructions need copy-in/out or a hybrid that keeps `Int8Array` etc. as externref. Object arrays (`$t`) become typed GC arrays: 105 + 111 + 11 | Strings become UTF-16 in memory (410 + 77 tests). Prim arrays are views over memory (consistent with `nonMovableBytes` today). Object arrays carry a class id | Arrays are where this pays off |
| (f) identity / prototype | 36 `instanceof` Java, 29 identity compares of typed Java objects, 41 `.constructor`, 29 `.$i`, 15 proto ops, 4 `TYPE_MARK` | `===` unchanged; the 36 + 41 + 29 + 15 need an export such as `class_of(obj)` or `instance_of(obj, classId)`. Under 150 edit sites | Same, plus identity becomes address equality | Not applicable |

### 3.2 Top ~15 files by Java-object coupling (fact; `coupling.ts`)

Score is field-ish sites + Java-call sites + identity + Java-typed retention + array tagging. Total score across the tree is 3,948; the top 15 hold 1,798.

| # | File | Score | LOC | Why it is coupled |
|---|---|---|---|---|
| 1 | `src/jvm/natives/jreflect.ts` | 297 | 1,034 | Method/Field/Constructor/Class objects as TS classes: 255 field sites and 17 identity sites, invoke by mangled name |
| 2 | `src/jvm/natives/jnet.ts` | 216 | 721 | 152 natives on TS classes (HttpURLConnection, SSL sockets): 181 field sites, 32 Java calls, 26 generator yields |
| 3 | `src/android/webkit.ts` | 177 | 556 | `WebViewChromium` has 34 TS fields, 151 field sites, 74 registered entries |
| 4 | `src/jvm/natives/jlang.ts` | 172 | 575 | `Class`, `ClassLoader`, `Object` natives: 126 field sites, 24 calls, 17 identity |
| 5 | `src/android/notification.ts` | 152 | 804 | Hosted service: 122 Java calls and `getDeclared`/`setDeclared` (26) on `Notification`, 111 `yield*` |
| 6 | `src/jvm/runtime.ts` | 111 | 1,153 | The VM itself: `ClassInfo`, `$i`, type marks, `setPublic`. Replaced, not migrated |
| 7 | `src/jvm/natives/jstring.ts` | 86 | 435 | `String` natives: 69 field sites, 12 calls |
| 8 | `src/jvm/natives/jinvoke.ts` | 81 | 352 | MethodHandle/VarHandle: 74 field sites |
| 9 | `src/jvm/natives/jthread.ts` | 80 | 212 | `JThread` has 24 fields; `$hash` table walk (`jthread.ts:56`) |
| 10 | `src/android/pm.ts` | 74 | 793 | Hosted PackageManager: 34 calls, 13 array tags, 82 `yield*` |
| 11 | `src/android/server/atm.ts` | 73 | 514 | Hosted ActivityTaskManager: 52 calls |
| 12 | `src/android/services.ts` | 73 | 565 | 94 registered entries, 59 calls |
| 13 | `src/jvm/natives/jthrowable.ts` | 71 | 241 | `Throwable` fields, stack trace, 10 identity |
| 14 | `src/android/accounts.ts` | 69 | 339 | 42 calls, 25 field sites |
| 15 | `src/jvm/natives/jzip.ts` | 66 | 296 | `Inflater`/`Deflater` state in 66 field sites. A byte mover in disguise |

Also high: `printing.ts` 64 (55 calls), `native/jni.ts` 58 (45 field sites, 35 handle ops, 11 identity), `server/wm.ts` 52, `binder.ts` 48.

Two clusters:

- **VM-resident classes in `src/jvm/natives/`** (jreflect, jlang, jstring, jinvoke, jthread, jthrowable, jnet): coupling is by field. Under a new heap these classes are best defined in the heap's own type system.
- **Hosted system services in `src/android/`** (notification, pm, atm, wm, am, services, accounts, printing, locationmanager, appwidget): coupling is by call, through the 8 `jentry` helpers plus `getDeclared`. These are the cheaper ones to migrate because the helpers are already the boundary.

## 4. Boundary code that does not need to know Java object layout (fact + inference)

Per group: LOC / coupling score / registered natives / files importing the VM runtime. From `byte-movers.ts`.

| Group | LOC | Coupling | Natives | Notes |
|---|---|---|---|---|
| Graphics: `skia.ts`, `harfbuzz.ts`, `sfnt.ts`, `path.ts`, `matrix.ts`, `hairline.ts`, `region.ts`, `maskfilter.ts`, `patheffect.ts`, `canvas.ts`, `canvas-draw.ts`, `recording.ts`, `rendernode.ts`, `paint.ts`, `fonts.ts`, `shaping.ts`, `gl.ts`, `native/gles3.ts` | 7,019 | 84 | 271 | Canvas recording is a `DisplayList` of ops (`recording.ts:157` `Recorder`); `harfbuzz.ts`, `sfnt.ts`, `hairline.ts`, `skia.ts` have score 0. Their natives are handle-keyed (`handles.ts`). `canvas.ts` 9 and `paint.ts` 15 touch Java only at the edges |
| Bitmap/pixels: `bitmap.ts`, `bitmap-raster.ts`, `decode.ts`, `heif.ts`, `ninepatch.ts`, `animatedimage.ts` | 1,593 | 55 | 89 | `NativeBitmap` is host-owned (`bitmap.ts:40`); Java holds only a handle (AGENTS: Java owns the handle, host owns the object) |
| Parcel / binder: `parcel.ts`, `binder.ts`, `intentipc.ts`, `cursorwindow.ts` | 1,019 | 52 | 108 | Parcel payload is serialized bytes (`Uint8Array`, `parcel.ts:13`). Exception: the `objects` side table (`parcel.ts:17`) carries live binder and other refs. `binder.ts` still has 40 coupling sites |
| Zip / inflate | 629 | 66 | 23 | `native/zlib.ts` (333 LOC) has score 0. `jzip.ts` couples via stream-state fields |
| Crypto / TLS: `ciphers`, `digest`, `conscrypt`, `conscrypt-x509`, `der`, `x509`, `pkey`, `keystore` | 3,094 | 76 | 16 | `ciphers.ts` 504 LOC, `der.ts` 108, score 0. Only `keystore.ts` (41) is object-coupled |
| fs / io: `native/fs.ts`, `fd.ts`, `jio.ts`, `jnio.ts`, `storage.ts`, `vfs.ts`, `hostfs.ts` | 1,929 | 68 | 66 | `native/fs.ts` 872 LOC, `vfs.ts`, `hostfs.ts`: score 0. `jio.ts` 21 and `jnio.ts` 39 carry the Java side (buffers) |
| Regex / text / charset: `jregex`, `jstring`, `android/text`, `minikin`, `hyphenator` | 2,308 | 102 | 38 | `jregex.ts` 732 LOC score 16 (1 native). `minikin.ts` 846 LOC score 4. `jstring.ts` is the coupled one (81) |
| SQL: `android/sqlite.ts` | 393 | 0 | 39 | All 39 are handle natives; sql.js is the engine |
| ARM/A64 core and host: `cpu.ts`, `core.ts`, `mem.ts`, `elf.ts`, `dl.ts`, `libc.ts`, `bionic.ts`, `loader.ts`, `host.ts`, `pthread.ts`, `poll.ts` | 4,006 | 23 | 0 | Plus `src/native/core/*.zig` (11,656 lines). Java coupling is only `jni.ts` (602 LOC, score 58) and a few thread hooks (`cpu.ts:849` `cpuFor(JThread)`) |

### Tree-wide fact

- 128 files (17.9k LOC) have coupling score 0, and 189 files (29.2k of 68.8k LOC) have a score of 3 or less.
- By scope: shell 45 of 51 files at 3 or less (4.3k of 5.0k LOC), native 44 of 52 (8.3k of 12.4k), android 67 of 152 (11.6k of 32.7k), jvm/natives 8 of 36 (1.6k of 11.3k).
- Zero-coupling files of 300+ LOC: `native/fs.ts` 872, `os-constants.ts` 547, `ciphers.ts` 504, `socket/inet.ts` 455, `shaping.ts` 448, `elf.ts` 396, `gl.ts` 398, `sqlite.ts` 393, `arsc.ts` 382, `shell/processes.ts` 384, `zlib.ts` 333, `velocity.ts` 305, `dl.ts` 302, `reach.ts` 305.
- Several of those still register natives (`rendernode.ts` 106 entries, `sqlite.ts` 39, `shaping.ts` 15). They are coupled to the registration mechanism, not to object layout.

### Inference: what the boundary redefinition buys

If the Java-side contract were reduced to `(handle: i64, primitives, byte ranges)` plus a small set of ref-in/ref-out operations, then:

- About 1,014 pure natives (41%) and most of the 7k LOC graphics group already conform.
- The graph of object-coupled code is concentrated in about 15 VM-resident classes and about 18 hosted-service files (6,957 LOC, 678 call sites).

## 5. JNI refs and the native core; effect of one Wasm instance (multi-memory)

### Fact: how it works today

- **The native core is a separate Wasm instance** (`native/core.ts:135`) of the Zig code (`src/native/core/*.zig`, 11.7k lines; `core.wasm` about 420 KB). It imports one `WebAssembly.Memory`, created at `core.ts:98` (shared if the page allows it, maximum 4 GiB less a page).
- **The guest address space is that memory.** Guest pointers are offsets into it (`mem.ts` typed views; `abi.ts:1-30` map). The JS side reads and writes guest bytes through `mem.u8`, `mem.ld32` and so on.
- **The JIT** emits more Wasm modules per hot region batch and links them into a shared function table (`core.ts:154-206`).
- **The execution loop** is `core.run_slice(cpu, budget)` (`cpu.ts:667`). It exits to JS for host calls (`CoreExit.Host` -> `hostDispatch`, `:679`), syscalls and faults. Budget is 3M instructions (`cpu.ts:33`).
- **The Java VM is JS objects** in a separate heap. JNI references are ints into JS arrays (`jni.ts:23-47`). The `JNIEnv` table lives in guest memory with trampolines (`abi.ts` `TRAMP_BASE`); each JNI function is a JS host function that reads its args from guest registers (`ArgReader`), derefs via the JS tables, and writes the result back.
- **Crossing cost** recorded by the repo: 38 ns per guest-to-host call (`docs/performance-plan.md:27`, "Not a lever"). The same document rejects Wasm for Java object code because "crossings would dominate" (`:265`, item 0003).

### Fact: what is on each side of the crossing today

- A JNI call from guest code does:
  1. a host-call trap exit from `run_slice`;
  2. `hostDispatch`;
  3. argument decoding (`readArgs`/`readJvalues`, `jni.ts:128-160`);
  4. `deref` of each ref through JS arrays;
  5. the Java call, possibly suspending;
  6. `retWord`/`toRef` back into the register file.
- Strings and arrays are copied: `GetStringUTFChars` allocates in guest memory (`putUtf8`, `jni.ts:306`); `Get<Prim>ArrayElements` copies in and out with sync at call boundaries.

### Inference: unifying the VM and native core in one Wasm instance (multi-memory)

1. **Crossing cost.**
   - The 38 ns is JS boundary cost plus dispatch. With both sides in Wasm, a JNI call becomes a direct or indirect `call`. This removes the exit from `run_slice`, `hostDispatch`, and arg decoding for the pure-Wasm JNI functions.
   - But most of today's JNI functions (59 literal defs plus loops) deref JS tables. Those would be rewritten Wasm-side only if refs are Wasm-resident.
   - The performance document says crossings are not a lever (38 ns), so the gain is a design simplification (no marshalling copies, a direct field offset for `GetIntField`), not a measured speed-up. I make no performance claim.
2. **Memory shape.** Multi-memory (a second memory for the Java heap, or a GC heap alongside the guest linear memory) lets the core keep its single 4 GiB guest memory, with the Java heap in another memory (design ii) or in the GC heap (design i).
   - A guest pointer into Java memory is not needed. JNI refs stay opaque, since JNI forbids guest code from reading object bytes.
   - Direct byte buffers and non-movable arrays are the exception. They already live in guest memory (`nonMovableBytes`, `jnio.ts:129`; `addressOf`, `capacity`).
3. **Reference tables.**
   - `locals`/`globals` (`jni.ts:23-47`) would move from JS arrays to Wasm tables of `externref`/`anyref` (Wasm GC) or int slots (linear heap). `deref` then becomes `table.get`.
   - For Wasm GC the `FinalizationRegistry` and `WeakRef` paths (`handles.ts`) and `jni.ts` weak refs (`NewWeakGlobalRef` is aliased at `jni.ts:226`) need a Wasm-side replacement (`weakref` type is not in baseline GC).
4. **Pinned arrays** (`jni.ts:279-301`, copy in and out) can become zero-copy only in design (ii). In design (i) Wasm GC arrays cannot be addressed from the guest core, so copy-in/out remains.
5. **`jmethodID`/`jfieldID`** are already zeroed 64-byte blocks mapped to JS records (`jni.ts:62-66`). They would map to method-table indices and field offsets directly.
6. **Suspension.** Cooperative suspension today uses JS generators (`yield*` 854, `driven` 403). A Wasm-resident VM cannot use those. It needs a stack-switching (JSPI) or CPS design. This is outside the native-survey scope, but it is the largest constraint on moving host natives, because `driven` natives are 403 of the registered entries.
7. **Things that stay JS regardless:**
   - the 1,301 Java-call sites reach into hosted services that talk to IndexedDB, fetch and Canvas2D;
   - `src/shell/*` (5.0k LOC, mostly zero coupling) and the browser-facing parts of `android/`.
   Under multi-memory they would call exports. They would not move.

## 6. Open questions to settle by small probes (not run; no browser per brief)

1. Can a Wasm GC `struct`/`array` reference be a `WeakMap` key, `WeakRef` target, or `FinalizationRegistry` target in V8? Affects retention (d) and `handles.ts`.
2. Does Wasm GC have a cheap way to expose a GC `array i8` as a typed array view? The usual answer is no. It decides how much of the 500 `new TypedArray` sites and 190 primitive-array entries survive.
3. Whether JSPI covers the `driven` natives, or whether they must be re-expressed (the 403 generator natives plus the 854 `yield*` sites).
4. Triage of the 717 string-keyed element accesses and 233 `any` property accesses. A short typed pass would separate bytecode-field reads from ordinary maps; it is the largest unknown in (b').
