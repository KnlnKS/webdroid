# Android API and graphics fuzzing operator guide

This guide explains how to inventory Android API support, run differential API and graphics
campaigns, fuzz APK user interfaces, replay minimized failures, and turn those failures into safe
webdroid fixes. It is intentionally explicit so a new engineer or coding agent can operate the
harness without inferring contracts from implementation details.

The compatibility oracle is Android API 33 because webdroid advertises SDK 33. API 35 framework
artifacts under `vendor/aosp` remain a separate forward-looking signal and must not be substituted
for the API-33 oracle.

## Non-negotiable rules

- Run the same `WebdroidFuzzProbe.apk` unchanged on Android and webdroid. Do not add platform-
  specific intents, test-only runtime branches, or expected values to make a comparison pass.
- Treat Android API 33 as the behavioral reference. If Android itself varies between identical
  replays, classify the case as unstable before changing webdroid.
- Inventory coverage and behavioral coverage are different. The inventory classifies every public
  API-33 declaration and reached hidden declaration. Only members owned by an explicit recipe are
  behaviorally exercised.
- Never convert an unsupported operation into fabricated success. A missing API, native requirement,
  timeout, or absent process diagnostic is evidence, not an empty or successful result.
- Preserve the minimized failure bundle before editing code. `fuzz-cache/` and `fuzz-results/` are
  intentionally ignored by Git and disappear when their worktree is deleted.
- Fix general Android semantics in the owning runtime module. Do not add app-name, package-name,
  seed, case-ID, or corpus-specific behavior.
- Keep visual goldens unchanged unless a separately proven product correction requires a reviewed
  reference update.
- Run focused checks while iterating. Run the full test, E2E, corpus, and performance matrix only
  after the implementation is frozen.

## What the harness contains

The public entry point is:

```text
bun run fuzz inventory --sdk 33 --json <path>
bun run fuzz api --seed <n> --cases <n> --oracle <serial> --out <dir>
bun run fuzz graphics --seed <n> --cases <n> --oracle <serial> --out <dir>
bun run fuzz ui <apk...> --seed <n> --steps <n> [--oracle <serial>] --out <dir>
bun run fuzz replay <failure.json> [--oracle <serial>]
bun run fuzz smoke
```

| Command | Defaults and requirements |
| --- | --- |
| `inventory` | SDK 33; reached-surface scan enabled; JSON is written only with `--json` |
| `api` | Random printed seed; 1,000 cases; API-33 `--oracle` required; output `fuzz-results/api-<seed>` |
| `graphics` | Random printed seed; 1,000 cases; API-33 `--oracle` required; output `fuzz-results/graphics-<seed>` |
| `ui` | Random printed seed; 100 actions per APK; oracle optional; output `fuzz-results/ui-<seed>` |
| `replay` | One validated failure bundle; real API/graphics bundles require an oracle |
| `smoke` | Fixed seed `0x5eed1234`; injected local mismatches; no oracle |

Numeric CLI values must be non-negative safe integers, and campaign case/action counts must be at
least one. When a seed is generated, it is printed before execution and stored in the campaign.

The main implementation boundaries are:

| File | Ownership |
| --- | --- |
| `scripts/fuzz.ts` | CLI parsing and defaults |
| `scripts/fuzz/model.ts` | Versioned API/graphics wire types and validation |
| `scripts/fuzz/catalog.ts` | Canonical API support classification |
| `scripts/fuzz/generate.ts` | Executable API recipes and graphics generation |
| `scripts/fuzz/probe-runner.ts` | Android/webdroid probe execution |
| `scripts/fuzz/compare.ts` | Result normalization comparison and graphics thresholds |
| `scripts/fuzz/minimize.ts` | API/graphics sequence deletion and argument shrinking |
| `scripts/fuzz/ui-model.ts` | Semantic UI identities, actions, generation, and validation |
| `scripts/fuzz/ui-targets.ts` | Android and webdroid UI mechanics |
| `scripts/fuzz/ui.ts` | Stateful UI orchestration, retention, and minimization |
| `tests/fuzz-probe/.../ProbeActivity.java` | The unchanged on-device probe implementation |
| `tests/e2e/lib/processes.ts` | Tagged per-process diagnostic snapshots |

All cases, results, failure bundles, and actions use `schemaVersion: 1`. Input is validated at the
host boundary and again by the probe protocol. Do not bypass the validators with casts or accept
partially shaped replay data.

## Prerequisites

Use the repository's supported Bun installation and Java 21. The probe compiles Java source with
`--release 17`, but its build tooling runs from the configured Java 21 installation.

Install these Android SDK components:

```bash
sdkmanager \
  'platform-tools' \
  'platforms;android-33' \
  'system-images;android-33;google_apis;arm64-v8a'
```

At least one installed build-tools version must provide `aapt2`, `d8`, and `apksigner`. The harness
selects the numerically newest installed build-tools directory. `avdmanager` must be on `PATH`.

On the expected macOS development setup:

```bash
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH"
bun install
```

If the command-line tools live in a versioned directory rather than `latest`, put that directory's
`bin` on `PATH`. Do not rewrite repository scripts with a machine-specific SDK path.

## Prepare the API-33 oracle

Run the setup script from the repository root:

```bash
bash scripts/fuzz/setup-oracle.sh
```

It performs four operations:

1. Creates or updates the `webdroid_api33_ref` AVD.
2. Uses webdroid's canonical framebuffer geometry and density, currently supplied by
   `src/shell/config.ts` rather than duplicated in the setup script, and replaces any
   persistent `wm size` or `wm density` overrides.
3. boots or validates an API-33 emulator.
4. pulls the matching `framework.jar`, `framework-res.apk`, build fingerprint, and
   `api-versions.xml` into `fuzz-cache/android-33/`.

When more than one Android device is connected, select the intended emulator before running setup:

```bash
export ANDROID_SERIAL=emulator-5554
bash scripts/fuzz/setup-oracle.sh
```

Verify the result instead of assuming the first `adb` device is correct:

```bash
adb devices
adb -s emulator-5554 shell getprop ro.build.version.sdk
adb -s emulator-5554 shell getprop ro.build.fingerprint
adb -s emulator-5554 emu avd name
```

The SDK value must be `33`, and the AVD name should be `webdroid_api33_ref`. The campaign runner
rejects a non-33 oracle or one whose active size and density differ from webdroid's profile.

The cache is deliberately ignored. Do not replace `vendor/aosp/framework.jar` or
`vendor/framework-res.apk` with API-33 files; those checked-in paths have different provenance.

## Build the unchanged probe APK

```bash
bash scripts/fuzz/build-probe.sh
bun run smoke fuzz-cache/WebdroidFuzzProbe.apk
```

The first command creates and signs `fuzz-cache/WebdroidFuzzProbe.apk`. The second verifies that
webdroid can compile its DEX without method failures. Rebuild the probe whenever its Java source,
manifest, graphics operation set, result normalization, or protocol changes.

The probe always contacts `http://127.0.0.1:4876`:

- Android reaches a dynamically allocated host case server through `adb reverse`.
- webdroid's private dev server rewrites that exact loopback origin to its own dynamically allocated
  case server.
- no endpoint, case, or expected result is baked differently for either platform.

Each case has a five-second protocol deadline. UI actions also have a five-second deadline.

## First run

Start with the deterministic harness smoke test. It requires no emulator and intentionally injects
one mismatch into each layer:

```bash
bun run fuzz smoke
```

Expected output reports deterministic API, graphics, and semantic UI generation and writes:

```text
fuzz-results/smoke/api.failure.json
fuzz-results/smoke/graphics.failure.json
fuzz-results/smoke/ui.failure.json
```

These failures verify detection, minimization, serialization, and two-replay retention. They do not
represent Android compatibility defects. Injected bundle replay also needs no oracle:

```bash
bun run fuzz replay fuzz-results/smoke/graphics.failure.json
```

If smoke fails, repair the harness before trusting a real campaign.

## Inventory API support

Create the full API-33 inventory after preparing the oracle cache:

```bash
bun run fuzz inventory --sdk 33 --json fuzz-results/api-33-inventory.json
```

By default, inventory:

- parses public declarations and introduction/removal metadata from API-33 `api-versions.xml`;
- resolves native/JNI registrations through the canonical runtime catalog;
- checks the cached API-33 framework DEX surface for bytecode candidates;
- scans every `.apk` and `.xapk` directly under `apks/`;
- follows APK roots through framework bytecode; and
- adds framework/internal members reached by that static analysis as `reached-hidden` entries.

Useful variants are:

```bash
# Public SDK classification without corpus/framework reachability expansion.
bun run fuzz inventory --sdk 33 --no-reached --json fuzz-results/api-33-public.json

# Explicit framework artifact, normally used only for a controlled provenance check.
bun run fuzz inventory --sdk 33 --framework fuzz-cache/android-33/framework.jar \
  --json fuzz-results/api-33-inventory.json
```

Do not run API-33 classification against the API-35 `vendor/aosp/framework.jar` fallback and then
describe the result as an API-33 behavioral inventory. Prepare the cache or pass the matching
framework explicitly.

Each catalog member has:

- `kind`: `class`, `method`, or `field`;
- `owner`: slash-separated JVM class name;
- `signature`: method name plus JVM descriptor, field name, or class name;
- `source`: `public` or `reached-hidden`;
- `since` and `removed`: platform metadata;
- `support`: classification described below;
- `exercised`: whether an executable API recipe owns the member;
- `sites`: number of reached static references observed in the scanned corpus/framework graph.

Support classifications mean:

| Classification | Meaning | What it does not prove |
| --- | --- | --- |
| `delegate` | A concrete native/JNI/class/field implementation is registered | Correct behavior for every state and argument |
| `placeholder` | Registration resolves to an explicit `stubs()`/`noops()` placeholder | Compatibility; placeholder success is not an implementation |
| `bytecode-candidate` | The member exists in the paired framework bytecode | That all transitive native dependencies work |
| `missing` | No matching delegate, placeholder, or framework member was found | That an application reaches it dynamically |
| `platform-absent` | API metadata says the member was removed by SDK 33 | That webdroid should reintroduce it |

Useful inventory queries:

```bash
jq '.totals' fuzz-results/api-33-inventory.json

jq '[.members[] | select(.source == "public" and .support == "missing")] | length' \
  fuzz-results/api-33-inventory.json

jq '.members[] | select(.sites > 0 and (.support == "missing" or .support == "placeholder"))' \
  fuzz-results/api-33-inventory.json

jq '.members[] | select(.exercised)' fuzz-results/api-33-inventory.json

jq '.members[] | select(.owner == "android/graphics/Matrix")' \
  fuzz-results/api-33-inventory.json
```

Prioritize reached missing/placeholder members by `sites`, but confirm runtime reachability before
implementing them. Static reachability is evidence of a possible call, not proof of an executed
path.

## Run API differential fuzzing

```bash
bun run fuzz api \
  --seed 1592594996 \
  --cases 1000 \
  --oracle emulator-5554 \
  --out fuzz-results/api-1592594996
```

If `--seed` is omitted, the CLI generates a seed and prints it before doing work. Record that seed
immediately. `--cases` defaults to 1,000 and must be at least one. `--oracle` is required.

Current API behavior is recipe-based. `API_RECIPES` in `scripts/fuzz/generate.ts` owns both case
generation and the member metadata used by inventory's `exercised` flag. The initial recipes cover
bounded operations for `Color`, `Rect`, `Uri`, `TextUtils`, and `Matrix`; inspect the registry for
the exact current list.

The generic probe supports:

- null, boolean, byte, char, short, int, long, float, and double arguments;
- strings, enums, int arrays, float arrays, and string arrays;
- public constructors and methods selected by JVM descriptor;
- static calls; and
- replacing the receiver with a returned related object for call chains.

It does not invent `Context`, service, permission, callback, `Looper`, lifecycle, binder, or related-
object state. Those APIs need an explicit, reusable recipe with an honest setup contract.

API results normalize nulls, primitives, long values, non-finite floating values, characters,
enums, supported arrays, `Rect`, `RectF`, `Point`, `Matrix`, bitmap metadata, `Parcelable` bytes, and
`CharSequence`. Other objects normalize to their runtime class name. Values are compared as stable,
key-sorted JSON. If both platforms throw the same normalized exception class, the case currently
passes even if messages differ.

## Run graphics differential fuzzing

```bash
bun run fuzz graphics \
  --seed 1592594996 \
  --cases 1000 \
  --oracle emulator-5554 \
  --out fuzz-results/graphics-1592594996
```

Graphics cases are bounded 128x128 command streams over `Bitmap`, `Canvas`, `Paint`, `Path`,
`Matrix`, `ColorDrawable`, `RenderNode`, text, blend modes, density, clipping, transforms, and
save/restore. The exact discriminated union is `GraphicsCommand` in `scripts/fuzz/model.ts`.

Comparison occurs in this order:

1. value versus exception outcome;
2. normalized exception class;
3. exact non-pixel graphics state, with float-backed path bounds and RenderNode arrays compared
   by float32 value; Canvas matrices use a relative tolerance of `2e-6`;
4. tolerant image comparison if state agrees.

An image passes only when both `contentDiffPct <= 1` and `tolerantPct <= 0.1`. The full strict score
is still recorded. This tolerance prevents normal platform antialiasing noise from failing routine
tests; it is not permission to discard a materially different image.

Graphics failures use two identities:

- `matchKey` is stable enough to decide whether a candidate still reproduces while minimizing;
- `fingerprint` adds differing state fields and the minimized operation shape so unrelated defects
  do not collapse into a single state or pixel bucket.

The campaign retains at most 20 distinct minimized bundles. The printed failure count is the number
of differing generated cases, not the number retained after clustering and the retention cap.
`campaign.json` also records each float32 state value that differs despite passing the tolerance,
with its case ID, field, and maximum absolute delta. The CLI prints that count separately.

## Run semantic UI fuzzing

With an Android oracle, actions are derived from Android's UI hierarchy and replayed on webdroid:

```bash
bun run fuzz ui apks/FitNotes.apk apks/calculatorm.apk \
  --seed 1592594996 \
  --steps 100 \
  --oracle emulator-5554 \
  --out fuzz-results/ui-1592594996
```

Without `--oracle`, the fuzzer explores webdroid alone and retains coverage, tree, frame, diagnostic,
and error novelty:

```bash
bun run fuzz ui FitNotes.apk --seed 1592594996 --steps 100 \
  --out fuzz-results/ui-webdroid-1592594996
```

An APK argument may be an existing path or a file name under `apks/`. The APK must expose a
launchable activity discoverable with `aapt2 dump badging`. Each APK is run independently; its PRNG
stream is derived deterministically from the campaign seed and APK index.

Generated actions are:

- taps on enabled clickable semantic nodes;
- text entry into enabled editable nodes;
- swipes in enabled scrollable regions;
- back and enter;
- background/resume;
- portrait/landscape configuration changes; and
- a normalized blind-coordinate tap only as a recorded fallback when semantic actions are absent.

Semantic identity prefers resource ID, then normalized text, then content description, and finally
class plus ordinal. Normalized coordinates are retained with the identity. If Android selects a
target that webdroid does not expose, or tree overlap falls below the structural threshold, the run
stops at that first divergence because later actions are no longer comparable.

UI runs enable `?fuzzCoverage=1`. Coverage probes are emitted into generated JVM methods only in
that mode and are forwarded to child process frames. With coverage disabled, generated production
methods contain no probe and no per-call conditional branch.

Every successful step records:

- Android/webdroid tree and frame hashes when an oracle is present;
- tolerant pixel scores and optional screenshots/diff images;
- new JVM method coverage;
- missing APIs, native requirements, unread attributes, and runtime/page errors;
- queue and compositor state;
- layout, draw, GL, frame, compilation, and native counters; and
- diagnostics for every relevant webdroid process frame.

Process diagnostics are tagged `ok`, `unavailable`, or `failure`. A relevant foreground or child
process that is missing or not `ok` is a harness failure. Third-party web-content frames are not
Android processes and are excluded by the webdroid process URL contract.

## Understand campaign artifacts

All outputs are ignored by Git. Copy important evidence to a durable external location before
deleting a worktree, cleaning ignored files, or asking another agent to continue elsewhere.

API and graphics directories contain:

```text
<kind>-<seed>.campaign.json
<kind>-<seed>-0.failure.json
<kind>-<seed>-1.failure.json
...
```

The campaign JSON contains the seed and count needed to regenerate inputs, ordered Android results,
ordered webdroid results, platform environment fingerprints, raw diagnostics, the total failure
count, and retained bundle paths. Exact inputs are embedded in retained failure observations rather
than duplicated for every passing case.

Each failure bundle is atomic:

```text
schemaVersion
kind
seed
environment.oracle
environment.webdroid
original.input / original.failure / original.oracle / original.webdroid
minimized.input / minimized.failure / minimized.oracle / minimized.webdroid
reproductions[0..1]
```

Each reproduction owns the exact input and pair of outputs that produced its failure. Never combine
an input from one observation with results from another.

UI directories contain `ui-<seed>.campaign.json`, novelty screenshots/diffs, and one
`<apk-name>.failure.json` per retained failing APK. A UI bundle stores the app package/activity,
original action sequence and run, minimized action sequence and run, and two minimized
reproductions. UI run evidence includes its own environment and step diagnostics.

Useful inspection commands:

```bash
# API/graphics campaign summary.
jq '{kind,seed,cases,failures,retained}' \
  fuzz-results/graphics-1592594996/graphics-1592594996.campaign.json

# Minimized failure and exact platform outputs.
jq '{failure:.minimized.failure,input:.minimized.input,oracle:.minimized.oracle,webdroid:.minimized.webdroid}' \
  fuzz-results/graphics-1592594996/graphics-1592594996-0.failure.json

# Verify that the two retained reproductions have the same fingerprint.
jq '[.minimized.failure.fingerprint,.reproductions[].failure.fingerprint]' \
  fuzz-results/graphics-1592594996/graphics-1592594996-0.failure.json

# UI actions, first divergence, signals, and process diagnostic states.
jq '{actions:.minimized.actions,steps:[.minimized.run.steps[] | {
  index,structuralDivergence,signals,coverageDelta,
  processes:[.diagnostics.processes[]? | {url,status:.diagnostics.status}]
}]}' fuzz-results/ui-1592594996/FitNotes.failure.json
```

## Replay before attempting a fix

API and graphics replay require the API-33 oracle:

```bash
bun run fuzz replay \
  fuzz-results/graphics-1592594996/graphics-1592594996-0.failure.json \
  --oracle emulator-5554
```

UI replay uses the stored APK path and accepts an optional oracle:

```bash
bun run fuzz replay fuzz-results/ui-1592594996/FitNotes.failure.json \
  --oracle emulator-5554
```

A successful command means the minimized failure reproduced twice during this fresh replay. A
retained bundle already contains two reproductions, but fresh replay catches changed machines,
oracles, APKs, and environmental instability.

Do not edit a bundle merely to make it pass validation or replay. If the APK path moved, restore the
same APK bytes at that path or record the provenance change explicitly.

## Finding-to-fix workflow

Follow this sequence for every retained finding.

### 1. Freeze the evidence

Record:

- failure bundle path and a durable copy;
- seed, case count or UI step count;
- exact APK hash for UI cases;
- Android serial, SDK, AVD name, and build fingerprint;
- current webdroid commit;
- failure `kind`, `fingerprint`, `matchKey`, and `detail`; and
- screenshot/diff paths and all non-`ok` diagnostics.

Do not begin with the original large case. Start from `minimized` and consult `original` only when
the minimized case lost useful context.

### 2. Reproduce without code changes

Run public replay at least once. If it fails to reproduce:

1. verify the Android build fingerprint and SDK;
2. verify APK/probe hashes and rebuild only if source changed;
3. ensure the emulator is boot-complete and not showing a permission/system dialog;
4. inspect host load and five-second timeouts;
5. rerun the same seed as a new campaign; and
6. classify the issue as unstable rather than weakening the comparator.

The harness retains only failures that reproduced twice during minimization. A later failure to
replay usually indicates environment drift, nondeterminism, or a changed implementation.

### 3. Classify the failure's owner

Use this order:

| Evidence | Likely owner | First investigation |
| --- | --- | --- |
| Invalid case/result shape, missing results, mixed IDs | Harness/protocol | Validators, case server, probe logs |
| Android result changes across identical runs | Oracle/environment | Emulator state, dialogs, locale, font/render backend |
| API exception/value differs consistently | JVM/framework/native delegate | Minimized descriptor and owning registration |
| Graphics state differs before pixels | Graphics semantics | Exact state key, setter/getter, Canvas/Path/Matrix rules |
| State agrees but pixels materially differ | Raster/draw path | Minimized commands, PNG diff, software renderer |
| UI target absent/tree overlap diverges | UI semantics or hierarchy | First divergent tree, resource/text/class identity |
| `layout:`, `draw:`, or `gl:` signal | Runtime rendering pipeline | Per-process counters and earliest logged error |
| `wedge:` or timeout | Queue/lifecycle/IPC/native execution | `ticks`, queue depth/phase, process logs, paired baseline |
| Relevant process `unavailable`/`failure` | Harness or crashed child | Frame URL, process creation, diagnostic bridge |

Do not call a target-absent result an Android API defect until you determine why the semantic node
differs. It can be caused by layout, text, resource inflation, lifecycle, accessibility exposure, or
an earlier API failure.

### 4. Localize an API mismatch

Read these minimized fields first:

```bash
jq '.minimized | {input,failure,oracle,webdroid}' <failure.json>
```

Then:

1. Decode the JVM descriptor exactly. Do not infer an overload from its Java source name alone.
2. Check inventory classification and whether the member is recipe-exercised.
3. Run `bun run audit <apk>` for ranked reachable gaps when an app is involved.
4. Use `bun run fwscan` and focused `bun run fwtest <prefix>` for framework evidence.
5. Use `bun run inspect`, `bun run dis`, or `bun run jsrc` to inspect app/framework bytecode and
   the actual call path.
6. Search registrations in `src/natives.ts` and the implementation's owning module. Import owner
   symbols rather than mutating another module's registration through `rt.natives.get`.
7. Check generated and direct JNI registrations before declaring a textual name missing or
   conflicting.
8. Compare API-33 framework behavior and documentation. Preserve null, primitive zero, long
   `BigInt`, typed-array, object-array, class-loader, initialization, overload, boxing, callback,
   and suspension semantics.

A `placeholder` finding should normally replace the placeholder with evidence-backed behavior. A
`bytecode-candidate` finding often means a transitive native or resource dependency is missing; do
not replace working framework bytecode with a hand-written approximation merely because the first
call failed.

### 5. Localize a graphics mismatch

Inspect `failure.detail` and `minimized.input.commands`. State mismatches identify the differing
state keys in `matchKey`; resolve those before interpreting pixels.

For pixel findings:

1. Decode `oracle.value.png` and `webdroid.value.png` if separate visual inspection is needed.
2. Inspect the retained diff image or produce one through the existing E2E diff helper.
3. Determine whether the difference is geometry/content, clipping, blend/compositing, density,
   text metrics, or only edge antialiasing.
4. Test inverted/empty bounds, zero/negative sizes, save/restore depth, matrix order, alpha, density,
   and enum state because the generator intentionally selects boundary values.
5. Preserve the software draw path. A fix that only works under one browser GPU backend is not a
   general Android compatibility correction.
6. Do not increase tolerance to hide a deterministic content difference. Change thresholds only
   with a measured cross-platform noise study and explicit review.

If several bundles share `matchKey` but have different fingerprints, they reproduce the same broad
comparison family through different minimized operation shapes. Review each shape before merging
them into one root cause.

### 6. Localize a UI or process failure

Work from the first failing step only. Later actions are invalid after a structural divergence.

1. Compare the action's semantic identity with both trees.
2. Inspect Android and webdroid screenshots and the diff.
3. Check every process diagnostic, not only the foreground frame.
4. Confirm `ticks` advance and `alive` is true.
5. Inspect queue depth/phase, compositor state, layout/draw/GL counters, missing/native APIs,
   unread attributes, runtime errors, and page errors.
6. Determine whether child-process telemetry is genuinely absent or the frame is third-party web
   content outside the webdroid process URL contract.
7. Reproduce the same first step manually with the E2E harness when timing or lifecycle ordering is
   ambiguous.

Missing/native entries are retained as novelty signals even when another signal becomes the bundle's
primary failure. Investigate the earliest causal error instead of implementing every diagnostic
listed after it.

### 7. Implement the smallest general fix

The patch should:

- live in the module that owns the violated Android behavior;
- remove or replace a placeholder only when behavior is known;
- preserve unchanged APK/framework bytecode;
- preserve multi-process, queue, lifecycle, and callback ordering;
- avoid test-only production branches;
- avoid per-call coverage work when `fuzzCoverage` is disabled;
- keep the hot path allocation- and branch-conscious; and
- contain comments only for non-obvious semantic reasons.

Do not add a large regression test for every fuzz case. Add a small deterministic test only when it
protects a core protocol contract or a broadly important semantic rule that would otherwise regress
silently. The minimized failure bundle remains the primary reproduction for narrow compatibility
findings.

### 8. Verify the fix in increasing scope

During iteration:

```bash
bun run fuzz replay <failure.json> --oracle emulator-5554
bun test tests/fuzz-core.test.ts tests/fuzz-catalog.test.ts tests/fuzz-semantic.test.ts
bun run typecheck
bun run smoke <affected.apk>
bun run fwtest <affected-prefix>
```

The replay command is expected to fail after a real fix because the old mismatch should no longer
reproduce. Confirm that the command fails for the intended reason, then rerun the original fixed seed
and verify the corresponding fingerprint is absent. Do not delete unrelated retained findings.

Before merging a completed campaign or runtime fix, run the repository acceptance appropriate to
its scope:

```bash
bun run typecheck
bun run test
bun run smoke apks/FitNotes.apk
bun run fwtest
bun run fuzz smoke
bun run fuzz api --seed <fixed-seed> --cases <bounded-count> --oracle <serial> --out <dir>
bun run fuzz graphics --seed <fixed-seed> --cases <bounded-count> --oracle <serial> --out <dir>
PORT=4090 bun run server.ts
WEBDROID_URL=http://localhost:4090 bun run textcmp FitNotes.apk
WEBDROID_URL=http://localhost:4090 bun run e2e --jobs 1
WEBDROID_URL=http://localhost:4090 bun run corpus
```

Use an unused port, serialize E2E, inspect every relevant process in `run.json`, and stop the server
afterward. Performance-sensitive production changes also require five serialized alternating
baseline/candidate pairs and the existing 3% primary-metric retention gate.

## Add behavioral API coverage safely

To add a generic safe recipe:

1. Add one entry to `API_RECIPES` in `scripts/fuzz/generate.ts`.
2. List every class/method the recipe actually exercises in that entry's `members` array.
3. Generate a valid `ApiCase` with exact JVM descriptors and typed `ProbeArgument` values.
4. Keep generated values bounded and deterministic through the provided `Random` instance.
5. Add no duplicate member list elsewhere; `API_RECIPE_MEMBER_IDS` is derived from the registry.
6. Run the catalog and deterministic-generation tests.
7. Build the unchanged probe and run a small fixed-seed Android/webdroid campaign.

If the API needs context, callbacks, services, loopers, permissions, parcels shared across calls, or
other state that the generic reflection protocol cannot express, design an explicit reusable recipe
contract. Extend the validated discriminated union and implement the same contract in the probe.
Do not synthesize nulls or fake objects to claim the member was exercised. Bump `schemaVersion` when
a wire change is incompatible with existing bundles.

## Add a graphics operation safely

A graphics operation crosses three lockstep boundaries:

1. Add its exact operation and argument tuple to `GraphicsCommand` in `scripts/fuzz/model.ts`.
2. Validate its arity, primitive types, and enum domain in `validateGraphicsCommand`.
3. Add it to `GRAPHICS_OPERATIONS`.
4. Generate it in `scripts/fuzz/generate.ts` with bounded values.
5. Implement the same operation in the probe switch in
   `tests/fuzz-probe/src/org/webdroid/fuzz/ProbeActivity.java`.
6. Decide whether its externally visible state must be added to the normalized graphics result.
7. Rebuild the probe.
8. Run `tests/fuzz-core.test.ts`; it requires the TypeScript manifest and Java switch to agree.
9. Run a small fixed seed on Android and webdroid before starting a long campaign.

Do not represent arguments as an untyped array or accept unknown operations. Strict validation is
what makes old failure bundles meaningful after the harness evolves.

## Extend semantic UI actions safely

When adding an action:

1. Add it to the `UiAction` discriminated union.
2. Add strict replay validation in `validateUiAction`.
3. Generate it only when the current hierarchy supplies the required semantic state.
4. Implement Android mechanics in `AndroidUiTarget.act`.
5. Implement webdroid mechanics in `WebdroidUiTarget.act`/`webAction`.
6. Define deterministic argument shrinking in `shrinkAction` when useful.
7. Update the small semantic selection test.

Keep platform mechanics out of the orchestrator. Preserve normalized coordinates as fallback
evidence, but prefer resource/text/description/class identity over blind coordinates.

## Troubleshooting

### `oracle <serial> is API <n>, expected API 33`

Boot `webdroid_api33_ref`, check `adb devices`, and pass its exact serial. Do not disable this check.

### `missing fuzz-cache/WebdroidFuzzProbe.apk`

Run `bash scripts/fuzz/build-probe.sh`. If build tools are missing, install an Android build-tools
package that contains `aapt2`, `d8`, and `apksigner`.

### `avdmanager not on PATH` or missing system image

Put Android command-line tools on `PATH` and install
`system-images;android-33;google_apis;arm64-v8a`. Rerun setup; it is idempotent.

### Case timeout

Identify the case ID in the error. Check probe UI text, filtered Android logcat in the campaign,
`adb reverse --list`, host load, and whether webdroid is alive. Do not globally raise the deadline
until the cause is known; a timeout can be the compatibility defect.

### Missing process diagnostics

Inspect every page frame URL. A relevant `/` or `/process` frame on the active webdroid origin must
return tagged diagnostics. A third-party web-content frame may be excluded. Never replace missing
child telemetry with an empty array.

### No failure bundle despite a nonzero difference count

The difference may have failed minimization/reproduction, duplicated an already attempted or
retained fingerprint, or exceeded the 20-bundle cap. Inspect the campaign's raw paired results and
rerun a smaller fixed seed. Do not claim a retained deterministic defect without two reproductions.

### UI run stops immediately with `target absent`

This is an intentional first-divergence stop. Compare the initial trees and screenshots. Determine
whether resource inflation, text, accessibility identity, layout, or an earlier startup error caused
the missing target. Random later actions would not be comparable.

### Pixel differences are numerous

Group by minimized fingerprint and inspect content-aware scores. State mismatches are handled before
pixels. Treat small edge noise differently from shifted geometry or missing content, but do not tune
the comparator around a particular seed.

### A replay stopped reproducing after a fix

That is the expected result for the resolved bundle. Confirm the original fixed seed no longer emits
the fingerprint, run focused regression checks, and retain the old bundle as before-fix evidence
outside ignored worktree storage.

## Checklist for an autonomous coding agent

Before running:

- Read this guide, `AGENTS.md`, `PLAN.md`, and the relevant implementation-history section.
- Confirm the working tree and target branch are clean or understand all existing changes.
- Confirm API-33 oracle identity and build fingerprint.
- Confirm probe and APK provenance.
- Choose and record an explicit seed and bounded output directory.

When a finding appears:

- Preserve the ignored bundle and images.
- Inspect `minimized`, not just `original`.
- Replay twice through the public command before editing.
- Distinguish harness, environment, Android nondeterminism, and webdroid behavior.
- Follow the failure to its canonical owner; do not patch symptoms or application identities.
- Use Android/framework/DEX/native evidence for semantics.
- Keep compatibility fixes, harness changes, and cleanup in separate focused commits.
- Report unresolved reproducible findings instead of expanding the task indefinitely.

Before handing off:

- Rerun the fixed seed and show whether the target fingerprint disappeared.
- Report all commands, exact counts, environment fingerprints, and evidence limits.
- State whether ignored artifacts were retained and where.
- State whether child-process diagnostics were complete.
- State whether visual goldens changed; normally they must not.
- Stop emulators and servers started solely for the campaign when they are no longer needed.
- Do not delete the worktree until ignored evidence has been copied or explicitly discarded.

The implementation rationale, measured acceptance results, known compatibility backlog, and evidence
limits are recorded in [`docs/implementation-history.md`](../../docs/implementation-history.md).
Maintainability decisions and deliberately rejected cleanup are recorded in
[`docs/code-quality-audit-2026-09.md`](../../docs/code-quality-audit-2026-09.md).
