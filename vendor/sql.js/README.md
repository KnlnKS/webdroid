# sql.js with exact signed 64-bit bindings and the SQLite C API Android's JNI uses

This local `sql.js` package keeps the upstream API and browser/Node entry points.
The two-line API patch binds JavaScript BigInt through `sqlite3_bind_int64`.
Upstream 1.14.2 binds BigInt as TEXT; converting it to Number loses integer
precision above 2^53. The patch also exports the C functions, `HEAPU8` and `FS`
that `android.database.sqlite.SQLiteConnection`'s and androidx's bundled driver's
natives (`src/android/sqlite.ts`) use to open raw handles on Emscripten files.

Source: sql.js v1.14.2, commit `9c4e167ec37129192d166ab9223faa9a4bd07c58`.
SQLite: 3.49.1, with upstream compilation flags and extension-functions.c.
Toolchain: Emscripten 4.0.9 (native WebAssembly BigInt), `-Oz -flto`.
Closure is omitted so rebuilding does not require Java. Both WASM files are
identical; their names match the upstream entry points.

The build output in `dist/` is not committed. The node preload (`scripts/preload.ts`)
and the Vite config run `rebuild.sh` whenever `dist/` is missing or was built from another patch, before any entry point imports sql.js.
The script uses an active Emscripten 4.0.9, or installs that release through emsdk
pinned to the same tag under `~/.cache/webdroid/` (override with `WEBDROID_EMSDK`).
To rebuild by hand, run `vendor/sql.js/rebuild.sh`.

The script verifies upstream source checksums and applies `sqljs.patch`.
Python 3, Git, Make, and network access are required to build. The workspace
link makes node imports and the server's `/sqljs/` route use the same build.
