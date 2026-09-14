# Performance and maintainability audit — September 2026

Starting point: `d018ea99c1d1004439d3a7bb04aa6987608dafe2`. Three parallel audits
covered the compiler, native core, and browser/platform code; the coordinating audit
covered dependencies and APK loading. The retained changes preserve guest bytecode and
existing platform contracts. Measurements below concern individual components, not an
app-wide speedup.

## Retained changes

### Compiler reaching definitions

`src/jvm/compiler.ts` copied every instruction-definition Set on every block transfer
and register move. Transfers only replace register bindings. Definition sets are now
read-only and shared; a join allocates a new Set only when it gains a definition.
The deep-clone helper and unused `src`/`hasBackEdge` fields are removed.

Eight alternating warmed Bun samples, with GC outside timing:

| APK | Baseline source generation | Changed | Reduction |
|---|---:|---:|---:|
| FitNotes | 179.50 ms | 172.65 ms | 3.8% |
| Resy | 1780.97 ms | 1655.18 ms | 7.1% |

Generated JavaScript is byte-for-byte identical across 34,802 classes and 199,464
declared methods. This excludes loading, linking and Function construction. Existing
serialized-bytecode tests cover the core semantics; no compiler tests were added.
The preserved propagation and set-union rules agree with
[Clang's dataflow model](https://clang.llvm.org/docs/DataFlowAnalysisIntro.html).

### Native bulk copying

`src/native/core/mem.zig` now uses Zig 0.16 `@memmove` instead of directional byte
loops. The generated Wasm contains `memory.copy`; callers still own pointer translation,
zero-length handling and executed-page invalidation. ReleaseFast Wasm falls from
298,372 to 296,960 bytes (1,412 bytes smaller).

Seven alternating baseline/current rounds through the real libc entry point, headless
Chromium 151, including translation and invalidation checks:

| Size | Baseline ns/call | Changed ns/call | Speedup across directions |
|---|---:|---:|---:|
| 16 B | 10–11 | 10–11 | neutral |
| 64 B | 15–16 | 9–10 | 1.60–1.67× |
| 256 B | 40–41 | 10 | 4.00–4.10× |
| 4 KiB | 546–552 | 42.7–44.3 | 12.34–12.89× |
| 64 KiB | 8643–8789 | 537–610 | 14.16–16.36× |
| 1 MiB | 141333–141667 | 12000–15333 | 9.22–11.81× |

Bun and Node corroborate larger-copy gains. Node's 16-byte case costs an additional
0.2–3.6 ns; Chromium is neutral, so a special branch is not justified. A baseline/current
A32/A64 matrix checks both copy entry points, overlap in both directions, identical
and disjoint addresses, zero-length invalid pointers, and middle-page invalidation.
One compact regression extends the existing native memory test file.

A follow-up Chromium comparison covers 0/1/2/4/8/12-byte copies. Four-byte calls
cost an additional 0.15–0.85 ns, and 12-byte calls up to 0.55 ns. Other tiny sizes
are neutral or faster. These small costs do not justify another branch without a
measured workload dominated by tiny copies. Raw samples remain with the native evidence.

[Emscripten uses the same Wasm bulk-copy primitive](https://raw.githubusercontent.com/emscripten-core/emscripten/main/system/lib/libc/emscripten_memmove.c).
[Zig documents its overlap guarantee](https://ziglang.org/documentation/0.16.0/#memmove).

### Base64 allocation

`src/android/base64.ts` writes the exact output size directly into an Int8Array.
It eliminates per-group temporary strings, boxed output arrays, the final byte-array
copy and the chunked string-conversion helper. A shared TextDecoder converts the
ASCII output for String entry points. Source shrinks by five lines; decode behavior
is unchanged. The group-level wrapping and output sizing follow
[AOSP Base64.java](https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/util/Base64.java).

Nine alternating Chromium samples with DEFAULT flags:

| Input / output | Baseline | Changed | Speedup |
|---|---:|---:|---:|
| 64 KiB / byte array | 0.456 ms | 0.075 ms | 6.1× |
| 64 KiB / String | 0.500 ms | 0.0875 ms | 5.7× |
| 1 MiB / byte array | 7.51 ms | 1.20 ms | 6.3× |
| 1 MiB / String | 8.22 ms | 1.58 ms | 5.2× |

All 49,632 differential cases match the baseline across flags, slices and lengths.
One core regression checks signed bytes, padding and line boundaries against Node's
Base64 output. Smaller 32-byte and 1-KiB cases also improve in the retained measurements.

### Lazy APK certificate discovery

`src/android/packagearchive.ts` used Object.entries before filtering v1 signature names.
That evaluates every lazy ZIP accessor. It now filters Object.keys first, then reads
only selected signature blocks. Eight alternating Bun trials, fresh lazy trees, warmed
Forge and GC outside timing:

| APK | Baseline certificate lookup | Changed |
|---|---:|---:|
| Flappy Bird | 15.97 ms | 0.202 ms |
| Doodle Jump Christmas | 43.11 ms | 0.240 ms |

Doodle Jump changes from 505 materialized entries (31,675,918 bytes of content) to one
1,354-byte signature block. Of its total content, 3,303,893 bytes are deflated; the
remaining 28,372,025 bytes are stored views, so the content total is **not** an allocation
saving. All certificate SHA-256 hashes match the baseline. One core regression verifies
the actual v1 certificate and that unrelated accessors remain lazy. V2/v3 handling is
unchanged. These measurements precede the Forge entry-point change below.

### Smaller crypto dependency surface

`src/forge.ts` loads Forge's PKCS#7 dependency graph and digest modules through one lazy
entry point. This retains RSA, X.509, ASN.1 and PEM behavior while omitting unused root
features such as TLS and SSH. Its declaration exposes the namespaces used by callers.
Both dynamic import sites use this entry point. No package or lockfile changes are needed.

Bun browser builds of otherwise identical standalone entries, minified:

| Entry | JavaScript | Gzip |
|---|---:|---:|
| node-forge root | 289,526 B | 76,979 B |
| Selected modules | 196,451 B | 52,613 B |
| Reduction | 93,075 B (32.1%) | 24,366 B (31.7%) |

These are dependency bundle measurements, not the whole application. The subset is
verified in fresh Bun and Chromium contexts with all 16 supported OAEP digest/MGF
combinations and self-signed X.509 round trips. The real v1 APK certificate test reaches
PKCS#7 parsing. [Forge's module structure](https://github.com/digitalbazaar/forge#installation)
and [upstream submodule notes](https://github.com/digitalbazaar/forge/blob/main/CHANGELOG.md)
support selecting modules rather than replacing the crypto implementation.

## Alternative-library decisions

| Dependency / candidate | Decision and compatibility cost |
|---|---|
| fflate / zip.js, browser CompressionStream | Retain fflate. The current ZIP tree already inflates selectively and Java/native codecs require synchronous incremental calls. Native streams are asynchronous; zip.js adds an archive abstraction without evidence of a gain in this workload. [fflate benchmarks and API](https://github.com/101arrowz/fflate), [zip.js codec options](https://gildas-lormeau.github.io/zip.js/api/interfaces/Configuration.html). Upstream speed claims are not local APK benchmarks. |
| node-forge / PKI.js, WebCrypto | Keep the smaller Forge module selection. WebCrypto already performs key generation and certificate verification; the existing OAEP bridge permits separate message and MGF digests. PKI.js changes the certificate/ASN.1 object model and does not provide a drop-in replacement for those callers. [PKI.js](https://github.com/PeculiarVentures/PKI.js/). |
| sql.js / official SQLite Wasm | Defer migration. The local build binds exact BigInt through sqlite3_bind_int64; SQLite snapshots preserve live TEMP tables via a separate connection. An alternative needs equivalent bindings, snapshot semantics and measured query/startup benefits. [Official SQLite Wasm APIs](https://www.sqlite.org/wasm/doc/trunk/api-index.md), [sql.js](https://github.com/sql-js/sql.js/). |
| tough-cookie / cookie-es | Retain the jar. WebCookies depends on expiration, domain/public-suffix rules, SameSite and serialization. cookie-es supplies parsing/serialization, requiring substantial new jar logic to replace these semantics. [tough-cookie](https://github.com/salesforce/tough-cookie), [cookie-es](https://github.com/unjs/cookie-es). |
| TypeScript / Acorn | Retain for now. webscript.ts uses symbol resolution to avoid rewriting shadowed location bindings; Acorn is a parser, so a replacement also needs scope analysis and the existing browser contract tests. TypeScript is imported by the server, not the emulator's browser entry. [Acorn](https://github.com/acornjs/acorn). |

## Further opportunities, with evidence limits

- **JIT eviction indexing:** jit_evict scans roughly one million page slots. A populated-page
  or module-to-page index could avoid that scan. Measure actual cache-pressure frequency
  first, then cover eviction/invalidation ownership. [QEMU's translation-cache design](https://www.qemu.org/docs/master/devel/tcg.html)
  is a useful reference; additional indexing has a bookkeeping cost.
- **Code-write invalidation:** host 64-bit/float stores, bulk writes and cross-page stores
  need a focused self-modifying-code audit. Source inspection suggests paths bypass the
  integer-store invalidation helper; this is a hypothesis requiring reproduction, not a
  diagnosed application fault or a change made here.
- **Bounded text wrapping:** TextViewLayouts.breakLines wraps whole overflowing paragraphs
  before maxLines truncation. Stop work after the visible bound only after comparing spans,
  whitespace, line ends and pixels. The other existing line breaker has different semantics;
  merging them just to remove duplication would be unsafe.
- **Archive prefetch:** PackedArchive.read awaits separate raw files serially. Bounded
  independent reads may help remote cold starts; measure network latency and residency first.
- **LocalSocket queues:** repeated reduce/shift could become maintained byte counts and an
  indexed queue. Profile actual traffic before adding state.
- **Base64 decode conformance:** Android and Java currently share lenient padding/alphabet
  handling. Encoding optimization does not address this separate behavior issue.

Existing text-width/font/color caches were reviewed and retained. More aggressive JIT
chaining was not reopened without a changed hypothesis and a representative workload.
No broad abstraction layer, library migration or test deletion was justified by this pass.

## Verification and reproducibility

Raw logs, saved starting sources/binaries and runnable comparison scripts are retained
locally under `webdroid-shots/performance-audit/` (ignored generated evidence). Compiler,
native and Base64 subdirectories include reproduction READMEs. `archive-bench.ts` and
`dependencies/bundle.ts`, `verify-forge.ts`, `verify-browser.ts` reproduce the remaining
comparisons. Timings were serialized; an early native sample overlapping compiler smoke
was discarded. A paused native oracle test timed out and passed in a clean rerun; the
final full unit run is separate and unpaused.

Final integrated verification results are recorded in the implementation history.
