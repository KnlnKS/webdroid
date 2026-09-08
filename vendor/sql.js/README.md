# sql.js with exact signed 64-bit bindings

This local `sql.js` package keeps the upstream API and browser/Node entry points.
The two-line API patch binds JavaScript BigInt through `sqlite3_bind_int64`,
which is added to the exported functions. Upstream 1.14.2 binds BigInt as TEXT;
converting it to Number loses integer precision above 2^53.

Source: sql.js v1.14.2, commit `9c4e167ec37129192d166ab9223faa9a4bd07c58`.
SQLite: 3.49.1, with upstream compilation flags and extension-functions.c.
Toolchain: Emscripten 4.0.9 (native WebAssembly BigInt), `-Oz -flto`.
Closure is omitted so rebuilding does not require Java. Both WASM files are
identical; their names match the upstream entry points.

To rebuild, activate Emscripten 4.0.9 through emsdk, then run:

```sh
vendor/sql.js/rebuild.sh
bun install
bun test src/android/sqlite.test.ts
```

The script verifies upstream source checksums and applies `int64.patch`.
Python 3, Git, Make, and network access are required only for rebuilding.
Normal development uses the committed artifacts. The package file dependency
makes Bun imports and the server's `/sqljs/` route use the same build.
