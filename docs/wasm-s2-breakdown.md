# Wasm backend: S2 (with S0's move, S3 and S4) as work packages

Branch `knlnks/bytecode-wasm`, HEAD `9bc05263`. Companion to [wasm-backend-plan.md](wasm-backend-plan.md) sections 3.5, 3.6 and 7; it does
not repeat their reasoning. Sources: that plan, `research/wasm/{native-survey,runtime-inventory}.md`, `AGENTS.md`, `PLAN.md`, and the code in `src/`
and `research/wasm/j2w/` as of this commit. Counts below were re-run on this tree (fixed-string `grep` over non-test `src/**/*.ts`, so
definitions and comments are included; they agree with the survey within about 10%). Firefox is out of scope; JSPI is available in Chrome 137+ and
the WebKit build (plan G7). "Unverified" marks a claim no command in this document has yet confirmed.

## 0. Two facts that shape the order

1. **S2 as written ("single process, no suspension yet") cannot boot the framework.** `Looper.loop` blocks in `MessageQueue.nativePollOnce`
   (`src/android/mainloop.ts` `pollOnce`, returns `void | Promise`), `<clinit>` waits, `BinderProxy.transactNative` (`driven`) and file/network
   natives all suspend. The prototype runs one Java thread, `monitor-enter` is a null check, and a native that answers a Promise is a recorded
   gap (`natives.ts:328`, "native suspended"). S2 is therefore accepted at harness level (Java entry points driven from Bun/node: `fwtest`,
   conformance, jbench), and the in-browser `?tier=wasm` boot needs S3's C1 and C2 before B-packages can be exercised end to end.
2. **The production natives do not have to be rewritten to start.** `World` (`lazy.ts`) already depends on production only through the
   `NativeSource` interface (`natives.ts:18`); `oracle.ts` binds it to `rt.natives`/`rt.jniFn`, and `Bridge` (`bridge.ts`) lets an unchanged
   native see a Java object as a field-reading `Proxy` facade keyed by the same mangled names (`mangleField`, `m$...`) and arrays as copied typed
   arrays. 41% of the 2,682 registrations never touch objects (survey 2a); the rest run through facades first and are converted only where the
   facade is wrong (identity, async, aliasing; section 2.3). This replaces the survey's "1,018 field-site edits" with a smaller, evidence-driven list.

## 1. Layout, build and tooling

### 1.1 Target tree

`src/wasm/` is new; nothing outside it imports it except through one dynamic import in `src/jvm/tier.ts` (section 5), so the JS-tier bundle is
unchanged. Three layers with an enforced direction (compiler <- link <- host), checked by `tests/wasm-layers.test.ts` (new, a `Glob` plus import
scan like `tests/import-cycles.test.ts`).

| Destination | From `research/wasm/j2w/` | Rule |
|---|---|---|
| `src/wasm/compiler/` | `wasmbin code consts cfg opinfo infer facts method j2w poly fields chars linkage rtfns custom program cha`, new `ids` (`mid()`, from `reach.ts`) and `copy` (array copy loops, element sizes, typed-array views) | No `rt`, no `node:`/`Bun`, no DOM. Runs in a page, a worker, Bun and node. Outside `src/wasm` it imports only the shared front end `src/jvm/{dex,prepared,structure,opcodes,abi}`. P0 deviation: it still imports `link/` (`method` -> `classes`, `poly`/`fields` -> `classes unsafe mhandles`, `j2w` -> `exc strings`, `custom` -> `reflect`), a mutual dependency of the prototype that `tests/wasm-layers.test.ts` allows and only forbids it from reaching `host/`. `reach.ts`'s RTA analysis is a measuring tool and is `scripts/wasm/reach.ts`. |
| `src/wasm/link/` | `lazy`->`world`, `aot` (runtime half), `aotstore`, `exc`, `classes`, `reflect`, `members`, `annotations`, `unsafe`, `memory`, `refs`, `proxy`, `mhandles` (was `handles`), `strings`, `strfactory`, `sched` (was `threads`), `intrinsics` (assembles the emitters above, so it sits here, not in `compiler/`), `inet` (the getaddrinfo emitter), new `hostapi` (the interfaces below) and `module` (compile options TypeScript's lib lacks) | The VM proper. Never imports `host/` or `rt`. `World` takes what it needs of the host as options: `natives: NativeBinder` (which also makes its `HostBridge`), `heapUsed`, `net`; `NativeSource` is declared in `hostapi.ts`. `exc.ts` keeps its constants and `excMessage`; `heapUsed` moved to `host/stats.ts`. |
| `src/wasm/host/` | `natives bridge hostnatives` (all three implement or feed `hostapi`), `inet` (the resolver half: `hostNet`), `nativesource` (from `oracle.ts`: `lookup`, `stringOverrides`, `stores`, `thrown`, `classOf`, `settled`, and the `Natives` built over them), `stats` (`wasmStats`, `heapUsed`), `suspend` (`adaptImport(spec, wrapped)`, the sync default C1 replaces), `boot` (what `tier.ts` loads; throws until S3). `entry.ts` is B1's | The only layer allowed to import `src/jvm/runtime`, `src/jvm/natives/*`, `src/android/*`, `src/shell/*`, `src/native/*`. |
| `scripts/wasm/` | harnesses `diff libdiff classdiff customdiff linkdiff lazytest aottest fuzz irfuzz sweep jbench g1 g1run g1platform g1fs cases watdump trace undernode nodeshim.mjs`, `oracle` (the JS tier as oracle: `jsTier`, bit helpers), `lib` (was `build`: `loadDexes program world`), `reach`, `classfile`, `aot-build`, `aot-startup`, and new `run` `tools` (`shellIn`, `filesIn`, `cutWorkloads`, `dexAndroid`) `paths` | Bun/node only. One entry `scripts/wasm/run.ts <suite>` (package.json: `"wasm": "bun scripts/wasm/run.ts"`, `"aot": "bun scripts/wasm/run.ts aot-build"`) runs `diff libdiff classdiff customdiff linkdiff fuzz jbench aottest` under node via `undernode.ts` (`runUnderNode`; `lazytest sweep g1 watdump` use Bun APIs and run under Bun), because `Reflection.getCallerClass` and stack symbolisation read V8 wasm frames, which Bun's JavaScriptCore lacks (`world.ts` `namesWasmFrames`, plan 4.6). `all` = the suites of the P0 gate; `aottest` builds a fresh AOT first unless `WEBDROID_AOT` is set; `fuzz` without arguments runs seeds 1 to 6. |
| `tests/fixtures/wasm/java/` | `java/*.java` (W, N, T, Vh, Lz, ...) | Compiled by `javac`+`d8` as today. |
| `research/wasm/` (stays) | `micro/ gc/ dexstats/ survey/ probe*.mjs platform-status.md native-survey.md runtime-inventory.md` | History and gate evidence. `aot/` (29 MB of output) is not a source and is deleted. |
| Deleted | `floatbench lazybench` (decisions recorded in plan 4.5/4.7), j2w `dis.ts` (`scripts/dis.ts` covers it), the CLI of `build.ts`, `research/wasm/aot/` (29 MB of output) | Research-only. |

The shared front end (`prepared.ts`, `structure.ts`, `dex.ts`, `abi.ts`, `opcodes.ts`, `provenance.ts`) is owned by both tiers. A change there needs
the JS suites and `scripts/wasm/run.ts all` (plan 4.4b: a `prepared.ts` handler-typing bug was found by the Wasm fuzzer). S6 deletes
`compiler.ts tiering.ts suspend.ts cold.ts codecache.ts aot.ts compileworker.ts` and not these.

### 1.2 Typecheck, tests, preload

- `tsconfig.json` includes `src scripts tests`, so the moved code is typechecked with `strict` and `noUnusedLocals` for the first time (`research/`
  is outside it). An ad hoc `tsc` run with the root options (without Bun types, so the harness-file errors are partly artefacts) shows genuine
  diagnostics in core modules: `handles.ts` (4: `State | undefined`, `(obj) => unknown` assigned to `(mh) => object`), `aot.ts` (unused `groups`;
  `Int32Array<ArrayBufferLike>` vs `Int32Array<ArrayBuffer>`), `custom.ts` (unused `proto`), `unsafe.ts` (unused `wide`), `cases.ts` (unused import).
  P0 fixes these; none needs a behaviour change.
- `tests/import-cycles.test.ts` scans `src/**` for modules that read a cyclic import's binding at evaluation time. The prototype has module-level
  registration (`threads.ts` calls `rt(...)` at load, `classes.ts` calls `def(...)`, `rtfns.ts` is a registry) across `lazy <-> classes <-> reflect
  <-> members`. It passed unchanged after the move (no evaluation-time read of a cyclic binding), so no registration call was moved; the cycles themselves remain.
- `bunfig.toml` preload (`scripts/preload.ts`: core wasm, web pages, sql.js) and `[test]` preload (`tests/platform.ts`: loads the boot jars into `rt`)
  need no change. `bun run test` (Bun, JSC) can host pure-compiler unit tests (`wasmbin`, `infer`, `Flow`, `facts`) under `src/wasm/compiler/*.test.ts`.
  Anything that instantiates a `World` runs under node (suite runner) or headless Chrome (lat/e2e). **Unverified:** Node 24.19 ships V8 13.6, which
  predates Chrome 137's V8 13.7; JSPI probably needs `--experimental-wasm-jspi` there. C1's first commit runs `research/wasm/probe.mjs` against the
  node used by `nodeshim.mjs` and records the flag.
- `bun run typecheck` is unchanged (`build-core.ts` then `tsc` twice). `tsconfig.worker.json` does not include `src/wasm`.

### 1.3 AOT assets: build, serving, loading

- **Build** (`scripts/wasm/aot-build.ts`, today `aotbuild.ts`): needs the registered native set (it imports `natives` from `oracle.ts`, hence
  `src/natives.ts`) because the index records `intrinsics` and a module whose natives are unbound is not used. The cache key is
  `hash(vendor/aosp/*.jar, src/wasm/{compiler,link}/**, sorted registered native keys, AOT VERSION)`. Output goes to `vendor/wasm-aot/<key>/` for
  the dev server (gitignored like `vendor/aosp`) and `dist/aot/<key>/` for production. Measured so far: 7 libcore jars 8,534 classes, 279+279 modules,
  C 36.7 MB, D 7.2 MB, 4 s; plus `framework.jar` 198 MB (44 MB gzip), 1,078+1,078 modules, 31 s and 3.5 GB of memory (plan 4.9). The 3.5 GB is the
  risk for Cloudflare Workers Builds (the production deploy path, `PLAN.md`); A1 decides between building in CI and caching the output by key.
- **Serving**: `server.ts` gets `"/aot/:key/:file"` (immutable cache, `content-type: application/wasm` is required for `compileStreaming`;
  `server.ts` already sets per-file headers via `serveFile`). `scripts/build-prod.ts` copies the directory into `dist/` beside the existing
  `vendor/aosp` copy (largest module 7.1 MB, under the 24 MB `partSize` and the Workers 25 MiB file limit; 2,156 files for the framework build against
  the 20,000-file asset limit, both unverified against the account). `wrangler.jsonc` needs no `run_worker_first` entry.
- **Loading**: `FetchStore` (`aotstore.ts`) prefetches the modules named in `startup.json` with `compileStreaming` off the main thread; `get()` for an
  unlisted module falls back to synchronous XHR, which a page cannot do for an `arraybuffer` response (the file's own comment says "only a worker
  may"). Decision D1 for A1: either prefetch a superset (startup profile plus idle prefetch) and treat a miss as an error in a page, or make
  `link`/`ensure` Suspending (needs C1) so a miss awaits a fetch. Compiled `WebAssembly.Module`s are shared across the process iframes through
  `pageShared("__wdAot", ...)` (`shell/pageshared.ts`; Modules are engine objects usable from a same-origin frame; unverified for streamed modules).
  Streamed modules name their frames by URL, which `FRAME` in `exc.ts` already accepts (plan 4.9).
- App code: `compileworker.ts` shape. A `src/wasm/host/compile-worker.ts` runs `Compiler.buildUnit` for install-time app compilation (route
  `/wasm-compile-worker.js` beside `/compile-worker.js` in `server.ts`, output entry in `build-prod.ts`), persisted per APK hash and build key in
  OPFS or Cache Storage (A3).

## 2. The seams (re-verified)

### 2.1 Where the JS tier is entered

| Seam | Where | Count | Wasm-tier replacement | Package |
|---|---|---|---|---|
| Dex ingress | `rt.loadDex` at `shell/device.ts:149` (app), `android/framework.ts:43` (platform, `loadPlatformJar`), `natives/jdex.ts:43,128` (`DexClassLoader`, in-memory dex), `jvm/compileworker.ts:31`; `linkNatives` at `device.ts:107` | 5 | `World.addDexes` through `tier.loadDex(dex, platform)` | B1 |
| Host calls into Java | `jentry.ts`: `vcall`, `vcallAsync`, `vcallOn`, `callOn`, `scall`, `newObj`, `staticField`, `linkInit`, `after`, `findMethod`, `implement`. Only `findMethod`, `linkInit`, `staticField`, `scall`, `newObj`, `implement` read the JS object model (`mangleMethod`, `rt.link`, `info.ctor`, `setPublic`) | `vcall` 759 (92 files), `newObj` 293 (74), `scall` 146 (61), `callOn` 20 (12), `staticField` 19 (11), `linkInit` 9 (6), `vcallOn` 4 (3). By directory: android 1,009, jvm 161, shell 32, native 0. Eight files hold 400: `android/notification` 105, `services` 55, `printing` 49, `server/atm` 45, `server/wm` 42, `accounts` 41, `jvm/natives/jnet` 32, `pm` 31 | `src/wasm/host/entry.ts` implements the same six names over `World.entry`/`Bridge.method` (`vcall` on a facade resolves `prog.implFor(cls, name, desc)` and calls a generated host function, `bridge.ts` `method`). Call sites are not edited | B1 |
| Field access by name | `getDeclared 25 (9 files)`, `setDeclared 79 (21)`, `declaredField 69 (31)`; top: `pm` 22, `socket` 14, `os` 12, `keystore` 10, `am` 9, `notification` 9 | 173 calls | The helpers in `runtime.ts` take the facade path (`Bridge` accessor per field). Call sites unchanged | B1 |
| Class handle | `rt.link` 57 (24 files), `.ctor` 125 (31), `rt.initClass` 24 (15), `rt.iof` 27 (15), `$i` 58 (21), `mangleMethod` 47 (23), `mangleField` 35 (16), `mangleStaticField` 23 (14), `lateMethod` 10 (4), `setPublic` 15 (7), `rt.natives` 10 (4) | about 330 sites | The one real API change: `ClassInfo.ctor` (`new info.ctor()`, `info.ctor[mangled]`) becomes a `JavaClass` object (`new()`, `static(name)`, `call(name, desc)`) in `src/jvm/tier.ts`, with a JS-tier implementation over `ClassInfo`. Migrate the 330 sites to it first, on the JS tier, as pure refactors | B1 |
| Native registration | `registerJnis` 153 (72 files), `registerJni` 42 (18), `rt.register` 182 (62), `rt.intrinsic` 24 (10) | 2,682 entries (survey) | Unchanged. Read through `nativesource.ts`; installed as Wasm imports by `natives.ts` (`abi()` from the descriptor) | B1 |
| Spec classes with TS state | `class X extends JObj` 66 declarations in 63 files (79 by the survey's transitive AST count), of which the 858 field sites sit in `jreflect, jnet, webkit, jlang, jstring, jinvoke, jthread, jthrowable, jdex, resnative` | 66 | The VM classes among them (`Class, Object, String, Thread, Throwable, reflect/*, invoke/*, ref/*, Unsafe, dalvik/system/*`; `TS_SPECS` "vm:" in `jvm/provenance.ts`) are already Wasm in the prototype (`classes strings threads exc reflect handles refs unsafe memory`), so `jreflect jlang jstring jinvoke jthread jthrowable` are not migrated. The remainder (`jnet`, `webkit`, `resnative`, `jdex`, `webdroid/*` helpers such as `FnRunnable` in `mainloop.ts`) become hybrid objects (2.3) | B2 |
| Throwing from TS | `rt.mkThrowable` 354 (92 files), `throw rt.` 323; `JThrowable` is named in 3 files (35 sites) | | A thrown `JThrowable` is turned into the Wasm exception at the import boundary (`natives.ts` `raise`, `thrown()`); a Java exception leaving an entry is wrapped into a `JThrowable`-compatible host object by `entry.ts`. Call sites unchanged | B1 |
| Retention | `handle(` 157 (39 files; `android/handles.ts` `objs[]` + `WeakMap`), `deref(` 52, `WeakRef` 32 (15), `FinalizationRegistry` 10 (8), `Map<Obj,..>` in `binder.ts` (`proxyData` WeakMap, `local` Map) | | Opaque Wasm references are valid `Map`/`WeakMap` keys and `WeakRef` targets (plan 1.4). A facade is a different object from the reference; `Bridge.facades` is a `WeakMap<ref, proxy>` so one reference has one facade, but TS code that compares a facade with a raw reference fails: B1 makes `toHost` the only producer and a lint test forbids storing raw references from `World.entry` | B1/B2 |
| JNI | `native/jni.ts` (601 lines): `Get/Set<P>Field` `o[f.prop]` (`:451-454`), statics `f.owner[f.prop]`, `invokeBody` `self[m.mangled]`, `info.ctor[m.mangled]` (`:184-196`), local/global ref tables hold JS values, `callGuestNative` through `rt.drive` (`:581-586`) | 50 `deref/toRef` | Field and method records carry a Wasm accessor/entry instead of `prop`/`mangled`; ref tables hold references or facades | B3 |
| Parcels, Binder | `android/parcel.ts` `NativeParcel` (62 sites in 6 files) holds bytes plus a side `objects` Map; `binder.ts` 454 lines | | No change to serialisation. `exportBinder` uses `rt.iof(binder, ...)` and `proxyData.get(binder)`: via facades | B1/C3 |

### 2.2 Where Java values are touched from TS (classification used by the packages)

| Class | Entries | Wasm-tier treatment |
|---|---|---|
| (a) primitives and handles only | 1,014 | plain sync imports, no edits |
| (b) reference pass-through (String, arrays, opaque refs), body clean | 759 | sync imports; strings via `toHost`, arrays copied (2.3 hazard H2) |
| (c) read or write object fields | 297 body-flagged | facades; where the receiver is a hybrid object, `this` is the TS instance |
| (d) call back into Java | 276 body-flagged, plus 403 `driven(` (83 files: android 333, jvm 63, shell 7) | Suspending adapter (section 4) |
| (e) async natives | `async` in 11 files of `jvm/natives`, 45 of `android`, 15 of `native`, 31 of `shell` (not all natives) | Suspending adapter |

Survey figures re-checked: `driven(` 403 and `registerJnis` 153 match; `yield*` is 757 here (survey 854), `after(` 242 and `awaited(` 389 (75 files).

### 2.3 Hybrid objects and the hazards that decide the design

**Hybrid object (decision D2, B2).** For a class registered by `rt.register({ctor, methods, fields})` the Wasm class gets one extra field
`$host: externref` holding the TS instance. Natives of that class receive the TS instance as `this`, so its TS-declared fields (the survey's 1,018
sites) work unmodified; bytecode subclasses (okhttp's `HttpURLConnectionImpl extends HttpURLConnection`) keep their own fields in the Wasm
struct, and the facade merges both namespaces. Alternative (rewrite each TS class into accessors) is the survey's 1,018-site plan and is kept as the fallback if
identity tests in B2 show the merged facade is unsound.

Hazards to design against (each gets a test in the owning package):

- **H1 identity.** TS creates objects of a bytecode class (`newObj`) and Java objects arrive as new facades unless `facades` has them.
  `Bridge.copyObject` copies an object the production runtime made, losing identity. B1 replaces copy with `World.entry` construction and removes `copyObject` for
  everything except `Struct*` result types.
- **H2 array scope across an await.** `Bridge.begin/end` copies arrays in for the length of a native call and writes back at `end`. A native that
  awaits while holding a typed array (socket and file reads into `byte[]`, `Inflater`, Binder reads) writes after `end`. The adapter for Suspending
  imports must hold the scope until the returned Promise settles (C1 and B3 together), and Java code sharing that array meanwhile sees stale data.
  Aliasing natives (`nonMovableBytes` in `jnio.ts`, `VMRuntime.addressOf`/`pinned` which leaks, `Get<Prim>ArrayCritical`, Bitmap pixel arrays) need a
  linear-memory-backed array class or explicit copy; B3 enumerates them from `mem.isGuest` users.
- **H3 unknown property on a facade returns `undefined`** (`bridge.ts` facade `get`). In the JS tier an unknown field on a native spec class is a reported miss
  (`absentField`). B1 makes the facade report through `stats.ts` into `run.json` (`facadeMisses`) so empty telemetry means something.
- **H4 loader identity.** `Program.classes` is one namespace, first definition wins; `Class.forName` and `findLoadedClass` ignore the loader
  (`classes.ts:300-312`). Production forks a `Runtime` per `BaseDexClassLoader` (`jdex.ts:14`). AGENTS.md requires defining-loader identity. A2.
- **H5 eager Program.** `Program.add` builds a `JClass` and a `MethodInfo` per method for every class of every dex up front (287,763 methods with
  framework.jar; the World comment says "hundreds of MB"). One per process iframe plus the page is not viable. A2.

## 3. Work packages

Legend: **Owns** = files only this package edits (collisions are avoided by ownership, not by merge order). **Gate** = the check that closes it.
New commands are marked (new); everything else exists.

### P0. Move and wire (S0 remainder; one commit, before the tracks start)

- **Entry:** `git mv` per section 1.1 with history; `src/jvm/tier.ts` (flag, `JavaClass` interface, JS implementation not yet used); `scripts/wasm/run.ts`; plug-in
  points so the tracks do not edit each other's files: `host/natives.ts` calls `adaptImport(spec)` (default: sync; C1 replaces it in `host/suspend.ts`),
  `host/stats.ts` registry read by `perf.ts` once, `NativeSource` constructed in `host/nativesource.ts`.
- **Owns:** `src/wasm/**` (initial), `scripts/wasm/**`, `package.json`, `tests/wasm-layers.test.ts`.
- **Gate:** `bun run typecheck`; `bun run test` (with import-cycles fixed); `bun run wasm all` (done) reproduces the numbers under node: `diff` 1061/1061, `libdiff` 411 methods 16,440 cases 0 diffs,
  `classdiff` 32/32, `customdiff` 375/375, `linkdiff` 19, `lazytest`, `fuzz` seeds 1 to 6 (2400/2400 each), `jbench` 42/42 MATCH, `sweep` no unexplained failure, `aottest` over a fresh AOT. Tier flag absent: `bun run e2e` unchanged.
- **Risk:** low; the work is mechanical. The cycle fixes touch registration order and can change which intrinsic wins; compare `World.intrinsic` key sets before and after.

### Track A: compiler, linker, delivery

| ID | Entry point and scope | Owns | Gate | Needs | Risk |
|---|---|---|---|---|---|
| **A1** AOT build, serve, load | `scripts/wasm/aot-build.ts --key`; `server.ts` `/aot/:key/:file`; `build-prod.ts`; `FetchStore` + `startup.json` in `host/boot.ts`; `pageShared` module cache; D1 (miss policy); build-key (1.3) | `scripts/wasm/aot-*`, `server.ts`, `scripts/build-prod.ts`, `wrangler.jsonc`, `src/wasm/link/aot*.ts` | (new) `bun run aot` then `bun run wasm aottest`; (new) `scripts/wasm/boot-probe.ts`: headless Chrome, `?tier=wasm` page runs `processState` and reports modules loaded/missed, sync-XHR count (must be 0) and compile time; `bun run worker:check` | P0 | Memory of the framework build; refusal of sync compile above 8 MiB main-thread (`framework.jar` chunking by size, plan 4.9 "Left"); streamed-module frame names |
| **A2** Program: loader namespaces, lazy and shared model | `compiler/program.ts`: per-loader class table keyed `(loader, name)`, class ids per defining loader (platform ids stay build-numbered), `Class.forName`/`findLoadedClass`/`getClassLoader` honour it; JClass/MethodInfo materialised on first `get` from the dex class index instead of at `add`; platform part page-shared (`pageShared`) and immutable | `compiler/program.ts`, `cha.ts`, `link/classes.ts` (loader parts), `link/world.ts` (`addDexes`) | `linkdiff`, `lazytest`, `classdiff` stay green; (new) `loaders` suite with two `DexClassLoader`s defining the same class name (distinct statics, `Class` identity, instanceof across); measure heap of `new Program` for framework+Mihon in node before/after (record in history) | P0 | CHA assumes one hierarchy: per-loader subclass sets multiply `Cha` state; the AOT index numbers one namespace |
| **A3** App compile off-thread and persistence | `host/compile-worker.ts` (`buildUnit` for app dex), tier-2 `World.upgrade` compile requests (limit "10 ms plus 30%" today) moved to the worker, persisted units keyed by APK hash + build key in OPFS/Cache Storage, loaded before launch like `codecache.ts` | `src/wasm/host/compile-worker.ts`, `host/persist.ts`, `server.ts` route (one line, coordinate with A1) | `lat` FitNotes/Calculator M/Mihon cold and warm under `?tier=wasm` (no gated tap above 150 ms, `LIMIT_MS`); worker compile count in `run.json` | A1, B1 | Worker needs its own Program (A2 shared form cannot cross a worker): transfer the index, not the model |

### Track B: host boundary

| ID | Entry point and scope | Owns | Gate | Needs | Risk |
|---|---|---|---|---|---|
| **B1** Seam and entry | `tier.ts` `JavaClass`; migrate the ~330 class-handle sites to it on the JS tier; `tier.loadDex` at the 5 ingress sites; `entry.ts` implementing `vcall/scall/newObj/staticField/linkInit/callOn/after` over `World`; `getDeclared` family; `nativesource.ts`; facade identity (H1) and telemetry (H3); exceptions both ways; `?tier` flag forwarding (section 5); `stats.ts` into `perf.ts`/`run.json` | `src/jvm/tier.ts`, `jvm/natives/jentry.ts`, `jvm/runtime.ts` (helper bodies only), the ~330 call-site files for the mechanical `JavaClass` edit (one commit, JS-tier only, lands first), `shell/device.ts`, `shell/processes.ts` (line 196 list), `main.ts`, `process.ts`, `src/wasm/host/{entry,nativesource,stats}.ts` | JS tier: `typecheck`, `test`, `fwtest`, quick `e2e` unchanged. Wasm tier: (new) `bun run wasm fw` = `scripts/fwtest.ts` cuts executed through `World` under node, same missing-API report as JS; `bun run smoke apks/FitNotes.apk --tier wasm` (new flag) = `sweep.ts`: zero failures except the 7 recorded absent-API gaps of plan 4.8, compared with the JS tier's `smoke` result on the same APK | P0 | The `JavaClass` refactor touches many files at once: land it alone, JS tier only, before anything else in B/C. Any `rt.link(...).ctor.prototype` use (e.g. `jthread.ts` ThreadLocal intrinsics) needs a JS-tier-only escape marked `// js-tier` and counted |
| **B2** Hybrid host-slot classes | `link/hostclass.ts`: Wasm class synthesis for `rt.register` specs outside `TS_SPECS "vm:"` (`jnet` 152 entries, `webkit` 74, `resnative`, `jdex`, `webdroid/*`, `jcoll`, `jbox` helpers), `$host` externref, `fields:` and `serialization`, `setupNativeMembers` semantics (`this`), bytecode subclass of a spec class, interface lists (`ifaces`), `claimOnStore` replaced by a store hook on flagged fields (`runtime.ts` `claimOnStore`, `handles.ts`) | `src/wasm/link/hostclass.ts`, `link/world.ts` (one `addHostClass` call), `host/natives.ts` (spec `this` binding) | (new) `bun run wasm hostclass`: `FnRunnable` posted to a Wasm-side `Handler`, `HttpURLConnection` subclass round trip, identity and `instanceof` across the boundary; `bun test src/jvm/natives` unchanged | B1, A2 for loader-defined subclasses | Spec classes that override methods AOSP also implements (`fallThrough`, `runtime.ts`); the Wasm vtable must pick the spec method, not the bytecode one |
| **B3** JNI, arrays and buffers | `native/jni.ts` field/method/ref access via B1's accessors; JNI refs hold Wasm refs; pinned arrays and direct buffers (H2): enumerate `mem.isGuest`, `nonMovableBytes`, `VMRuntime.addressOf`; fix the `pinned` leak | `src/native/jni.ts` (+ `jni.test.ts`), `jvm/natives/{jnio,jmemory,jvmruntime}.ts` array parts, `host/bridge.ts` array parts | `bun test src/native/jni.test.ts` under a tier switch (new, `WEBDROID_TIER=wasm`); a JNI app (Cut the Rope smoke: `bun run smoke` for the XAPK, then `e2e` flow with `WEBDROID_TIER=wasm`); `fbBulk`/`zipOpen` rows of `bun run wasm g1` do not regress (plan 4.10: 0.16x/1.21x) | B1, C1 for async scope | H2 is a correctness risk for every async byte-moving native; decide linear-memory-backed `byte[]` (aliasing, GC array cannot) versus scoped copies before writing code |
| **V1** Verification drivers (S2 exit) | `scripts/wasm/conform.ts`: runs `ConformRunner` suites (`guava`, `jsr166`, `ojluni-time`, `luni-*`) on `World` under node against the existing `tests/conformance/<suite>.json` baselines; `scripts/wasm/fwtest.ts` | `scripts/wasm/{conform,fwtest}.ts` | S2's own acceptance (plan 7): `fwtest`, `desccheck`, conformance match baselines in Wasm mode | B1 (entries), B2 | JSR-166 TCK needs real threads: it is a C2 gate, not an S2 one; record the split in the baseline notes |

### Track C: suspension and threads (S3)

| ID | Entry point and scope | Owns | Gate | Needs | Risk |
|---|---|---|---|---|---|
| **C1** JSPI substrate | `host/suspend.ts`: `adaptImport(spec)` classifies a native as sync, Suspending (driven `$g`, async, flagged-C) and wraps; `promising` entries per strand; strand id and `thr` global set on every resume; scope hold for arrays (H2); fuel/back-edge `yield` import (`runtime.ts` `refuel`, `yield.ts` `yieldToLoop`/`wakeSoon`); the "native answered a Promise" gap becomes an adaptive report (`nativeSuspended` in `run.json`) | `src/wasm/host/suspend.ts`, `link/sched.ts` (from `threads.ts`), `link/exc.ts` (stack depth counter, `StackOverflowError`), `scripts/wasm/threads.ts` | (new) `bun run wasm threads`: `T.java` cases, 1,000 stacks, a Suspending native calling a nested `promising` export that suspends again, deep recursion on a non-main stack; probe results appended to `platform-status.md` | P0 | Unknowns (probe first): does a Suspending import returning a non-Promise still switch stacks (cost per hot native); JSPI stack size and depth; V8 stack-overflow RangeError cannot be caught in Wasm (plan 4.5) |
| **C2** Threads, monitors, init waits | thin lock in the header (owner id + count, plan 3.1), inflated monitor and wait sets in the host, `Object.wait/notify`, `Thread.start/join/sleep/interrupt`, `LockSupport.park`/`Unsafe.park` (`jthread.ts` `park`, `jsync.ts`), class-init protocol: `ensure` stub tests the state word, waits through a Suspending import using `clinit.ts` strand rules (same-strand re-entry proceeds, a cycle proceeds with partial statics, another chain waits) | `link/sched.ts` (shared with C1 after C1 lands), `link/monitor.ts` (new), `link/world.ts` (`ensure`/init hook), `compiler/rtfns.ts` monitor ops | `diff` thread cases; JSR-166 and `luni-util` suites through V1; `lat` unchanged | C1 | Compiler emits `monitor-enter/exit` as null checks today (`method.ts`); changing it moves every AOT build key |
| **C3** Looper, Binder, main queue | the real `Looper.loop` as a promising stack suspended in `nativePollOnce` (`mainloop.ts` `NativeLooper.pollOnce` as Suspending, `mainDbg.depth` bookkeeping unchanged), `onMain` posting through `callOn(mainThread, ...)` = a new promising stack, `BinderProxy.transactNative`, `onTransact` entered from the broker, `asBroker`/`asSystem` | `src/android/mainloop.ts` (tier-neutral edits only), `src/android/binder.ts`, `host/entry.ts` (strand part, coordinated with B1 through the `callOn` function only) | Boot FitNotes in a process frame: lifecycle order equals the JS tier's EventLog on the quick-gate flows; `WEBDROID_URL=... WEBDROID_TIER=wasm bun run e2e`; `bun run lat` FitNotes, Calculator M, Mihon cold and warm; broker round trip (`transact`, `service`, `broadcast`) between two process frames | B1, C1, C2 | Reply delivery to a caller waiting on the main queue (AGENTS.md): resumption order is JS promise order; keep `wakeSoon` for main. See section 4 |

### Parallel schedule for three engineers

P0 first. Then A: A1, A2, A3. B: B1, then B2, B3, V1. C: C1, C2, C3. File ownership above is disjoint except two named hand-offs: `server.ts`
(A1 owns, A3 adds one route after A1) and `host/entry.ts` (B1 owns, C3 touches only the strand functions after C2). B1's mechanical `JavaClass` commit is the one
cross-cutting change (about 330 sites in 31 files, none in `src/wasm`); it lands before B2/B3/C3 branch, and A/C1 branches do not conflict with it.

## 4. Processes, realms, JSPI

**World per realm.** Each `/process?pid=` iframe (`shell/processes.ts:194`; served from `process.html` by `worker/index.ts:92`) is a same-origin frame on the
page's one JS thread with its own `rt`, so it gets its own `World` (own table, scratch memory, heap). The page realm (`main.ts`) also has a JVM
(`asBroker` = `asSystem(() => rt.drive(work))`), so it gets one too. Shared across them: compiled AOT `Module`s (`pageShared`), the immutable platform
`Program` (A2). Not shared: Java state, statics, classes with app/loader identity, native memory. Wasm GC objects do not cross the iframe boundary
(none do today: broker IPC carries `ParcelData = { bytes, objects }`, `binder.ts`), so nothing changes in `shell/processes.ts` or `process-endpoint.ts`.
Process-per-Worker (S5) later puts a `World` in a worker; JSPI works there, and `FetchStore` may do synchronous XHR there.

**Main-queue ownership.** The rule is a counter, not a thread identity: `mainDbg.depth` is decremented while the main looper polls and incremented after
(`mainloop.ts:20,48-50,95`); AGENTS.md calls it `inMainJob()`, a name that appears only in `docs/implementation-history.md:94` in this tree. The Looper
is Java and stays Java: in the Wasm tier `Looper.loop` is the main thread's `promising` stack, suspended in the `nativePollOnce` Suspending import. A host
`onMain(job)` runs `callOn(mainThread, () => postRunnable(...))`: a second `promising` stack that enqueues the message and calls `nativeWake`, which resolves the
poll's waiter; the main stack resumes in a microtask. `Strand` maps to a stack, `rt.cur`/`owned`/`resumeAs` to the strand id written to the `thr` global
on every resume by the Suspending wrapper, and `waitsOn` (cycle detection for class init and monitors) is kept as host data.

**Entry contract.** A `promising` export always returns a Promise, while the 759 `vcall` sites rely on "value or Promise". Two entry flavours, chosen by
the caller: `World.entry(...)` plain export for calls that cannot block (facade method calls from a native already running inside Wasm,
getters, `toString`; a blocking attempt throws a diagnosable error and is counted), and `promising` for everything that can block (`callOn`, `onMain`,
`scall`/`newObj` with initialisation, hosted-service calls). `entry.ts` returns the value synchronously when the plain flavour is used and a Promise otherwise,
which is the existing `after` contract, so call sites do not change but microtask timing does: lifecycle ordering is checked against the reference
EventLog (C3 gate).

**What becomes a `Suspending` import** (today none exist in the prototype; every one is host data, decided at instantiate time, so the same AOT module
works with or without JSPI):

| Import | Today | Source |
|---|---|---|
| `yield` (back-edge fuel) | `refuel` -> `yieldToLoop`/`wakeSoon` | `runtime.ts` fuel 4096, `yield.ts` |
| contended `monitor-enter`, `Object.wait` | `Monitors` entrants/waiters | `monitor.ts`, `jlang.ts` |
| `park`, `sleep`, `join` | `parkTimeout`, `t.done` | `jthread.ts`, `jsync.ts` |
| class-init wait | `initP`, `initBy` | `clinit.ts` |
| `nativePollOnce` | `NativeLooper.pollOnce` returns `void | Promise` | `mainloop.ts` |
| Binder `transactNative`, `service`, `contentProvider` | `driven` | `binder.ts` (12 `driven`) |
| file, mmap page-in, socket, fetch, `crypto.subtle`, `android_getaddrinfo`, ICU data | async natives, `javaReadFd` Promise for lazy sources, `pagesIn` | `native/fs.ts`, `jmemory.ts`, `jnet.ts`, `conscrypt.ts`, `hostnatives.ts` |
| guest JNI calls | `callGuestNative` via `rt.drive` | `native/jni.ts:581-586` |

The 403 `driven(g)` natives need no rewrite: the generator form is kept as the source for both tiers (`Object.assign(fn, { $g: g })`, `runtime.ts`
`driven`), and the Suspending adapter is `new WebAssembly.Suspending(async (...a) => await rt.drive(g.apply(this, a)))`. Converting them to `async` would make
the JS tier always asynchronous and break its ownership checks. Natives that call Java without being `driven` but can return a Promise (`return vcall(...)`,
`after(...)`) are found by the survey's body flag C (276) and by the runtime report; JS frames between the entry and the import are the only forbidden shape,
so a native on the Wasm side of an import must not itself be entered from a JS frame that is not a `promising` export. The ARM/A64 core keeps its own
async exits (`cpu.ts` `run_slice`): a JNI call from guest code is a JS host function that awaits a `promising` entry, no Wasm stack is involved.

## 5. Tier selection and the JS oracle

- **Flag.** `?tier=wasm` (`js` default); headless tools use `WEBDROID_TIER` like `WEBDROID_BYTECODE`. Parsed once in `src/jvm/tier.ts`, read by
  `main.ts` and `process.ts` next to `jvmTier` (which is the unrelated JS sub-tier `auto|cold|js` in `profile.ts`; do not reuse the name). Forwarded to process
  frames by adding `"tier"` to the list at `shell/processes.ts:196` (`bytecode, jit, fuzzCoverage, testClock`). `tests/e2e/drivers/webdroid.ts:21` gets
  one line for `WEBDROID_TIER` as it has for `CUT`; `scripts/lat/run.ts --query tier=wasm` works already. `wd.tier` reports it.
- **Loading.** `tier.ts` `await import("../wasm/host/boot")` only when `tier === "wasm"`, so a JS-tier production bundle (`bun build --splitting`) carries
  no Wasm code and no measurement changes for the default path.
- **What stays JS in Wasm mode.** `rt` as the registry of natives, specs and intrinsics (read through `nativesource.ts`); every TS service (`android/*`,
  `shell/*`, `native/*`); bytecode never runs on `rt` (a guard in `Runtime.link` throws if reached under `tier=wasm`, so a missed seam fails loudly).
- **Oracle until S6.** Three levels: (1) per method and per library static, the existing differential suites (`diff`, `libdiff`, `classdiff`, `fuzz`,
  `jbench`) run the same Java on Wasm, the JS tier and the JDK; (2) per flow, the same e2e/lat flow with and without the flag, compared by `run.json`
  (`newMissing`, `newErrors`, `nativeRequired`, layout/draw errors, `settled`, `wd.ticks`) and the unchanged goldens; (3) `bun scripts/perfsum.ts` for
  performance against a JS-tier baseline recorded in P0 (`bun run lat --json`, `bun run wasm g1 --json`). A Wasm-tier divergence is investigated against the
  JS tier at the starting commit with matching inputs (AGENTS.md); it is not waived as live content.
- **Removal gate (S6).** `rg "js-tier"` markers (B1) and the `JavaClass` JS implementation are the deletion checklist.

## 6. Verification matrix

`T` typecheck, `U` `bun run test`, `W` `bun run wasm <suites>` (new; node), `SM` `bun run smoke <apk>` / sweep, `FW` `bun run fwtest`, `E` quick `bun run e2e`
(`WEBDROID_URL=... [WEBDROID_TIER=wasm]`), `L` `bun run lat` cold and warm, `C` conformance (`bun run conform` JS baseline; `wasm conform` via V1), `G` `wasm g1`.
"JS" = run on the default tier to prove no regression; "Wasm" = under the flag. Serialize captures (AGENTS.md).

| Package | T | U | W suites | SM / FW | E | L | C | G |
|---|---|---|---|---|---|---|---|---|
| P0 | yes | yes | all (reproduce plan numbers) | JS | JS | JS baseline | JS | baseline `--json` |
| A1 | yes | yes | `aottest`, `lazytest` | | Wasm boot-probe only | | | first-call rows |
| A2 | yes | yes | `linkdiff lazytest classdiff loaders` | `sweep` all jars | | | | heap of Program |
| A3 | yes | yes | `aottest` | | | Wasm | | |
| B1 | yes | yes | `diff libdiff` | JS `smoke FitNotes`, JS `fwtest`; Wasm `wasm fw`, `sweep` | JS (the refactor) | | | |
| B2 | yes | yes | `hostclass` | Wasm `wasm fw` | | | | |
| B3 | yes | yes (`jni.test.ts` both tiers) | `jbench` (`fbBulk zipOpen`) | `smoke` Cut XAPK | Wasm JNI flow | | | `fbBulk zipOpen` |
| V1 | yes | | `conform` | `desccheck` | | | all suites vs baseline | |
| C1 | yes | | `threads` | | | | | `sha256` row |
| C2 | yes | | `threads diff` | | | | `jsr166 luni-util` | |
| C3 | yes | yes | | `fwtest` Wasm | Wasm quick gate, then `--live` and `--full --jobs 1` | Wasm FitNotes, Calculator M, Mihon | | |

Each package also records in `docs/implementation-history.md` the mechanism of any failure it explains. Performance is measured with `--jobs 1`, an idle host, visible
page and advancing `wd.ticks`, preferably headless Playwright with tracing off. Goldens are not updated. Telemetry claims need confirmation that the diagnostics reached the
relevant process (the process frame, not only the page); `stats.ts` is read from each realm's `wd`.

## 7. Risks and what to start

Top risks, ordered by how late they would force a redesign:

1. **Entry contract and ordering (section 4).** Promise-returning entries change microtask timing on the paths that AGENTS.md says are observable
   (lifecycle and callback order, replies to a caller waiting on the main queue). Caught only by C3's EventLog comparison, so C3 should run on FitNotes as soon as C1 and C2 permit, not at the end.
2. **Array scope across awaits and aliasing (H2).** Affects every byte-moving async native and Bitmap/direct-buffer paths; the choice (linear-memory-backed arrays versus scoped copies) touches the compiler's array representation and therefore every AOT key.
3. **Loader identity and eager Program (H4, H5).** The prototype's single namespace and per-realm model are the largest distance from AGENTS.md's invariants and from a viable
   memory budget; GMS/microG and plugin flows depend on `DexClassLoader`.
4. **Hybrid facade merge (D2).** If identity between facade, raw reference and TS instance cannot be kept consistent, the fallback is the accessor rewrite of the 1,018 sites.
5. **AOT delivery limits.** Framework build memory (3.5 GB), the 8 MiB main-thread compile limit, synchronous-miss policy (D1), sharing Modules across frames.
6. **V8-only behaviour.** Caller-class and stack symbolisation read V8 wasm frames; Bun's JSC cannot host World tests, so the test pyramid moves to node and Chrome; JSPI in node needs a flag (unverified).
7. **Thread semantics gap.** Monitors are null checks and one thread exists (plan 4.8 "Limits"); every framework path with a `HandlerThread` or executor depends on C2.

**Start these three together after P0:**

1. **B1**: it fixes the interface every other package codes against (`JavaClass`, `entry.ts`, `nativesource.ts`) and its mechanical refactor is the only change touching shared files.
2. **C1**: it holds the largest unknowns (non-Promise Suspending import cost, JSPI stack depth, node flag) and gates C2/C3 and the in-browser boot; its probes cost little and can redirect H2.
3. **A1**: it makes the platform AOT build servable and the first-call numbers reproducible in a page (G3), and decides D1 which constrains C1's `link` imports.

A2 follows as soon as A1's server work is merged (it reuses `pageShared`), before B2 starts using loader-defined subclasses.
