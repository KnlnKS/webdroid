# Performance and maintainability audit — September 2026

Starting revision: `d018ea99`. These retained changes preserve guest bytecode
and platform contracts. Timings are component measurements, not an app-wide
speedup. Raw logs and comparison scripts were retained locally under ignored
`webdroid-shots/performance-audit/`; Git history has the longer audit.

## Retained changes

| Area | Change | Matched evidence |
| --- | --- | --- |
| Compiler reaching definitions | Share read-only definition sets; allocate a joined Set only when a new definition appears. | Eight alternating Bun samples reduced FitNotes source generation 179.50→172.65 ms (3.8%) and Resy 1780.97→1655.18 ms (7.1%). Generated JS was byte-identical across 34,802 classes and 199,464 methods. |
| Native bulk copy | Replace directional byte loops with Zig 0.16 `@memmove`; callers still own translation and executed-page invalidation. | Seven alternating Chromium rounds through libc: 64 B 1.60–1.67×, 4 KiB 12.34–12.89×, 1 MiB 9.22–11.81×. Sixteen-byte calls were neutral; a small 4/12-byte cost did not justify a branch. A32/A64 overlap, zero-length and invalidation cases passed. Wasm shrank 1,412 B. |
| Base64 encode | Write into one exact-size Int8Array and decode ASCII strings with a shared TextDecoder. | Nine Chromium pairs: 64 KiB byte-array 6.1×, String 5.7×; 1 MiB byte-array 6.3×, String 5.2×. All 49,632 differential flag/slice/length cases matched. |
| APK certificate discovery | Filter lazy ZIP names before reading v1 signature blocks. | Eight Bun pairs: Flappy 15.97→0.202 ms, Doodle 43.11→0.240 ms. SHA-256 certificates matched. The 31.7 MiB archive-content total is not an allocation-saving claim because most content was stored views. V2/v3 handling is unchanged. |
| Forge entry | Lazily load only used PKCS#7, digest, RSA/X.509, ASN.1 and PEM modules. | Standalone browser bundle fell 289,526→196,451 B JS and 76,979→52,613 B gzip. OAEP digest/MGF and X.509 round trips plus real v1 parsing passed. This is dependency size, not whole-app size. |

## Alternatives and open hypotheses

- Retain fflate: the current archive is selective and Java/native codecs need
  synchronous incremental calls. No measured win justifies zip.js or browser
  asynchronous streams.
- Retain the smaller Forge selection and sql.js: WebCrypto/PKI.js would change
  OAEP or certificate object contracts; another SQLite build must preserve
  exact BigInt binding and live connection-local TEMP state.
- Retain tough-cookie's jar semantics and TypeScript's symbol resolution for
  web script rewriting. Parsing libraries alone would not replace those
  contracts.
- JIT eviction indexing may avoid a large page scan, but cache-pressure
  frequency is unmeasured. Code-write invalidation across 64-bit/float and
  bulk stores needs a focused self-modifying-code audit. Both are hypotheses,
  not diagnosed app faults.
- Bounded TextView wrapping, archive read prefetch and LocalSocket queue
  indexing need workload profiles and compatibility tests before adding
  state. Base64 decode conformance is separate from the encode optimization.

Integrated verification is recorded in
[implementation history](implementation-history.md). A paused native oracle
timeout passed on a clean rerun; the final full unit run was separate.
