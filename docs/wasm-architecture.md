# How Java runs: the Wasm tier

DEX bytecode is compiled to WebAssembly with GC types and JSPI, and runs unchanged. This note is the map; each file's
header comment holds the detail, and [implementation-history.md](implementation-history.md) holds the measurements and
rejected experiments. The design log that led here (`wasm-backend-plan.md`, `wasm-s2-breakdown.md`,
`dex-performance-architecture.md`) was removed with the JS tier; it remains in Git history.

## Layers

| Layer | Where | Owns |
|---|---|---|
| Front end | `src/jvm/{dex,prepared,structure,abi,opcodes}.ts` | DEX parsing, decoded instructions and CFG, structured regions, mangling |
| Compiler | `src/wasm/compiler/` | one Wasm module per unit of methods (`j2w.ts`, `method.ts`), web-based register typing (`infer.ts`), path facts, CHA, binary encoding |
| Linker and VM | `src/wasm/link/` | the `World` (`world.ts`): classes, table slots, lazy linking; strings, monitors, strands, reflection, method handles, Unsafe, loaders, AOT images |
| Host | `src/wasm/host/` | boot of a realm's World, host→Java entry, the native boundary and bridge, JNI, compile workers, persisted app builds |
| Natives | `src/jvm/natives/`, `src/android/` | platform natives and host classes, registered through `rt` (`src/jvm/runtime.ts`), assembled by `src/natives.ts` |

`src/jvm/tier.ts` loads the host by a dynamic import, so a page fetches the platform build while the rest starts; code
that loads Java (dex files, platform jars) goes through it. `src/jvm/natives/jentry.ts` is how host code calls Java.

## Object model and execution

- An object is a Wasm GC struct: an immutable vtable reference and a header word (identity hash and thin lock), then
  fields typed by layout. Arrays are wrapper structs over GC arrays. Class tests use the vtable's ancestor display,
  not `ref.test`. `java.lang.String` is a struct over an `i16` array with a cached hash and, once a host asked, its
  JS string (`link/strings.ts`).
- Calls between modules go through one shared funcref table. A method's slot starts as a lazy-link stub that compiles
  the method on first call; vtables hold slots. Class-hierarchy devirtualization is recorded per slot and undone when a
  later dex falsifies it. Precompiled platform code relies on no such decision.
- A Java thread is a strand: a JSPI stack. Blocking operations (park, contended monitors, `Object.wait`, class
  initialization waits, waiting natives) are Suspending imports, so only a real wait suspends. Back edges charge fuel;
  a yield suspends only when another turn is due (`link/sched.ts`).
- Exceptions use one Java throwable tag; implicit checks are explicit code (`link/exc.ts`).

## The host boundary

- A native is registered once (`rt.register` for host classes, `rt.registerJni` for functions); its Wasm import is
  derived from its descriptor (`host/natives.ts`). Scalars pass as Wasm values, strings as externref, primitive arrays
  through linear-memory scratch, other references as opaque values that the bridge (`host/bridge.ts`) reaches only
  through generated accessors.
- Intrinsics (`link/intrinsics.ts`, `compiler/chars.ts`) take precedence over registered natives for the same method.
- A host class's Java object and its TS object are one object to both sides (`link/hostclass.ts`).
- JNI for guest ARM code uses the Wasm references themselves as JNI objects (`host/jni.ts` over `src/native/jnivm.ts`).

## Code delivery

- **Platform:** compiled at build time (`scripts/wasm/aot-build.ts`) into class-data ("D") and code ("C") modules
  under `vendor/wasm-aot/`, numbered so that they link into any World. A page streams and compiles them in workers
  (`host/aotload.ts`). A zygote World warms platform code before the app arrives (`src/shell/device.ts`).
- **App:** a compile worker builds the methods an app is likely to run after its first launch and persists the build
  (`host/appcode.ts`, `host/persist.ts`); bundled builds cover the gate apps. Anything not in a build compiles on
  demand through the lazy-link stubs, in batches.
- **Second tier:** hot methods are recompiled in a compile worker under the same numbering and adopted only if the
  World has not renumbered meanwhile (`link/unit.ts`).

## Processes

Every app process runs in its own Worker with its own World, heap and statics; the page realm is `system_server`.
Processes exchange serialized Parcels through the broker, never Java objects.

## Verifying a change

`bun run wasm all` runs the compiler and linker suites, conformance quick sets, the descriptor check, the APK sweep
(`smoke`) and the AOT and persistence checks; `bun run conform` runs the full libcore and Guava suites against their
recorded baselines. AGENTS.md lists the app-level gates.
