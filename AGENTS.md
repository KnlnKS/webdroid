# webdroid — in-browser Android emulator

Run Android APKs entirely client-side. The server supplies static files, a CORS proxy,
and a TCP relay. Compare rendered behavior with real-device screenshots.

Read [PLAN.md](PLAN.md) for current work and
[implementation history](docs/implementation-history.md) for investigations, measurements,
and negative results. Older source comments that cite investigation titles in AGENTS.md
refer to sections now kept in that history document. Historical coverage statements are not
current status.

## Verify

Use a private port: another checkout may already serve 4080. Never run two E2E captures
concurrently; they share `tests/e2e/actual/` and `tests/e2e/report/`. Do not edit source
while a capture is running. Follow the user's requested verification timing.

```bash
bun run typecheck
bun run test
bun run smoke apks/FitNotes.apk
bun run fwtest
PORT=4090 bun run server.ts
WEBDROID_URL=http://localhost:4090 bun run textcmp
WEBDROID_URL=http://localhost:4090 bun run e2e
WEBDROID_URL=http://localhost:4090 bun run corpus
bun scripts/perfsum.ts tests/e2e/actual <baseline.json>
```

- Typecheck must pass with `noUnusedLocals`. Unit tests cover DEX/resources, ARM32/A64,
  hardware-oracle SIMD, native host services, storage, and the E2E comparison machinery.
  Use the test runner's count rather than maintaining a duplicate count here.
- Smoke compilation must report zero method failures for each APK affected by a change.
- `fwtest [prefix ...]` measures delegate coverage with real framework bytecode.
- E2E's four scored flows are FitNotes, Mihon onboarding, Mihon app, and Harmonic.
  Unscored game/calculator flows still report rendered steps, errors, missing APIs, and fps.
- Inspect `run.json` per-step `newMissing`, `newErrors`, `nativeRequired`, layout/draw errors,
  render completion, and perf. Empty reached telemetry does not imply full API coverage.
- Compare ambiguous failures against the starting commit. Existing Mihon scheduler/Compose
  failures and live Harmonic content make a single score insufficient to establish regression.
- Keep visual goldens unchanged unless explicitly updating reference captures. See
  [the harness guide](tests/e2e/README.md) for geometry, masks, wedge detection, and recording.

A provenance cut uses `WEBDROID_BYTECODE='android/graphics/Paint,android/graphics/Canvas'`.
An alternate `WEBDROID_SCREEN=1080x2424@480` runs as smoke when it differs from the goldens.

## Architecture

- DEX compiles lazily per class into JavaScript; registers become locals and control flow
  uses a switch loop. Suspension is cooperative on one JS thread. The experimental call-graph
  sync tier remains opt-in until native re-entry can be declared soundly.
- Java strings are JS strings, int/float/double are numbers, long is BigInt, primitive arrays
  use typed arrays, and object arrays carry a `$t` tag. Classes share the `JObj` hierarchy.
  Keep method/field mangling and lazy class initialization in the JVM layer.
- App-bundled androidx/Kotlin/library bytecode runs unchanged. Supply platform classes and
  JNI implementations; do not replace app classes to bypass their behavior.
- Android renders into one canvas framebuffer. Screen geometry comes from `shell/config.ts`.
  Binary XML and resource tables drive inflation, styles, fonts, backgrounds, and dimensions.
- Framework resources are real. Package byte 0x01 selects the framework table. AOSP bytecode
  requires the paired jar/resource package from one device build; the relinked resource APK
  cannot be substituted. Provenance is decided in `jvm/provenance.ts`.
- Application host state, context, preferences, intents, package queries, decor, menus, windows,
  and platform fragments have separate owners. Layout, text/editing, image, and search widgets
  live separately from the core view traversal.
- SQLite uses sql.js and persists snapshots per database. Persist without closing/reopening
  the database: connection-local TEMP tables and triggers must survive.
- ARM32 and A64 use the native tier. A64 registers are split low/high Int32 halves; preserve
  zero-extension and signed/unsigned encoding rules. Cold handlers and a bounded hot-code
  cache prevent executable-code GC pressure. One process uses one ABI.
- APK/XAPK installation is shared by shell, server, and scripts. Asset packs can use range
  reads with bounded caching. Preserve split precedence and distinct DEX entries.
- `src/natives.ts` is the central registration list. Import the owning module directly for
  TypeScript symbols; use type-only imports where no runtime dependency is required.

## Regression invariants

- Every main-thread entry goes through `onMain`. Main-thread identity is not queue ownership;
  use `inMainJob()`. Preserve lifecycle ordering and callback Pre/plain/Post variants.
- Concurrent class initialization waits for the in-flight initialization promise. Preserve
  same-class re-entry and cycle handling; never expose half-initialized statics.
- Overloads must reach the overridable Java entry point when required. Preserve `addView`
  funnels, layout-parameter conversion, covariant descriptors, and reflective boxing/unboxing.
- A missing native can poison an app transaction. Fix missing APIs, not downstream symptoms.
  Interface registrations and genuine no-op platform methods are not dead TypeScript code.
- Preserve null/zero normalization and reaching-definition typing of floating constants.
- Collection views remain live; custom-equality buckets must participate in enumeration.
  Preserve synchronous native fast paths without declaring re-entrant callbacks synchronous.
- Resolve CharSequence through Java semantics (`csText`); do not use `String(javaObject)`.
- Resolve widget defaults and subtree themes through resources. Do not synthesize framework
  resources or hardcode app/library names in shared behavior.
- Preserve measure/layout invalidation gates, negative LinearLayout weight distribution,
  pending ListView selection, lifecycle-driven fragment loading, and `computeScroll` before draw.
- Dispatch Back to the topmost window first. Keep dialogs bounded before adding title chrome.
- Text measurements use the shared measurement/metric caches. Draw failures are reported and
  must not permanently stop the frame loop.
- Preserve native cache invalidation and release incoming and outgoing hot links on eviction,
  including when the caller is active. Keep signals, host callbacks, and guest frames ordered.
- Do not fabricate account, network, service, or API success. Unknown services return null;
  unsupported relocations fail explicitly. Device absence and successful emulation differ.
- Read signatures, encodings, argument meanings, and return layouts from DEX/native evidence.
  Keep the software framework draw path; speculative hardware-rendering delegates reopen it.

## Janitor invariants and conventions

```bash
grep -rhoE 'name: "[a-z][a-z0-9]*(/[A-Za-z0-9_$]+)+"' src | sort | uniq -d
rg -n 'endsWith\("/' src
```

The duplicate-name grep must be empty. Use `grep` for it, not `rg -oNh` (`-h` prints help).
Inspect loop-generated registrations manually: the literal grep cannot see them. Library
name matching must remain absent. Do not patch another module's registered spec through
`rt.natives.get`; compose methods in the owning registration.

Keep one canonical copy of helpers such as `guardCall`, `newArrayList`, `defineException`,
`stringHash`, `charsToString`, `mkEnumSet`, `jarray`, `box`, `newObj`/`linkInit`, and resource
lookup helpers. Thin wrappers must earn their indirection. Keep minimal dependencies and
terse TypeScript; performance matters more than abstract purity in hot paths.

Comments explain a non-obvious reason, not the code itself. Follow the user's comment policy.
Commit subjects, when commits are requested, use `area: sentence` and keep each commit focused.
Record useful negative results in the history document; delete rejected implementation paths.
Do not retry attribute-index caching or drawable-padding changes without new measurement.

## Debugging tools

`package.json` lists executable commands. Key tools:

- `inspect`, `dis`, `jsrc`, `opscan`, `findstr`, `layout`: APK, DEX, generated code, and resources.
- `audit [--framework]`: reachable missing methods/fields, including interface dispatch.
- `fwscan`, `fwtest`, `textcmp`: framework signatures, delegate evidence, and text layout.
- `natcheck`, `corpus`, `dbg`, `trace`: suspension contracts, breadth, stuck flows, and calls.
- `scripts/nrun.ts`, `scripts/ndbg.ts`, `scripts/wheel.ts`, `scripts/perfsum.ts`: native bring-up,
  native tracing, real DOM input, and per-step performance comparisons.
- `gen-framework-res` and `gen-framework`: rebuild relinked resources or pull a paired AOSP build.
- `scripts/simd-oracle.ts`: regenerate the AArch64 hardware-oracle fixture on real hardware.
- `__wdNativeTrace`, `__wdNativeStep`, `__wdNativeWatch`, `__wdCallLog`, `__wdJniTrace`,
  `__wdJniCalls`, `__wdLogTrap`, `__wdSlowMs`, `__wdCount`, `__wdWatch`, `__wdIfaces`: browser
  globals that switch on the matching trace; `scripts/ndbg.ts` sets the native ones.

The browser exposes `wd` from `src/main.ts`: runtime, tree/input helpers, logs, perf, native
telemetry, and main-loop diagnostics. Missing APIs are `wd.rt.missing`, not `wd.missing`.
Check visibility and advancing `wd.ticks` before measuring; background-tab throttling can look
like an emulator stall. Prefer headless Playwright for timing. Compare work and render completion
alongside counters: a wedged app can appear faster because it stopped doing work.
