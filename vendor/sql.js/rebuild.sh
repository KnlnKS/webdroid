#!/bin/sh
# Build dist/ from the pinned sources. The node preload runs this when dist/ is missing, so progress
# goes to stderr, never into an entry point's stdout.
set -eu
exec >&2
version=4.0.9
output=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
partial="$output/dist.$$"
# builds are shared between checkouts, keyed by what produced them
cache=${XDG_CACHE_HOME:-$HOME/.cache}/webdroid/sqljs-$(cat "$0" "$output/sqljs.patch" | shasum | cut -c1-16)
if [ -f "$cache/sqljs.patch" ]; then
  rm -rf "$partial" "$output/dist"
  cp -R "$cache" "$partial" && mv "$partial" "$output/dist"
  exit 0
fi
if ! emcc --version 2>/dev/null | head -1 | grep -q "$version"; then
  # emsdk tags match the Emscripten release they install
  emsdk=${WEBDROID_EMSDK:-${XDG_CACHE_HOME:-$HOME/.cache}/webdroid/emsdk-$version}
  [ -x "$emsdk/emsdk" ] || git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$version" https://github.com/emscripten-core/emsdk.git "$emsdk"
  "$emsdk/emsdk" install "$version"
  "$emsdk/emsdk" activate "$version" >/dev/null
  eval "$("$emsdk/emsdk" construct_env 2>/dev/null)"
fi
work=$(mktemp -d)
trap 'rm -rf "$work" "$partial"' EXIT
git clone --quiet --depth 1 --branch v1.14.2 https://github.com/sql-js/sql.js.git "$work/sql.js"
cd "$work/sql.js"
git checkout --quiet 9c4e167ec37129192d166ab9223faa9a4bd07c58
git apply "$output/sqljs.patch"
python3 - <<'PY'
import hashlib, io, pathlib, urllib.request, zipfile

def download(url, algorithm, expected):
    data = urllib.request.urlopen(url).read()
    assert hashlib.new(algorithm, data).hexdigest() == expected, url
    return data

archive = download('https://sqlite.org/2025/sqlite-amalgamation-3490100.zip', 'sha3_256', 'e7eb4cfb2d95626e782cfa748f534c74482f2c3c93f13ee828b9187ce05b2da7')
zipfile.ZipFile(io.BytesIO(archive)).extractall('sqlite-src')
extension = download('https://www.sqlite.org/contrib/download/extension-functions.c?get=25', 'sha1', 'c68fa706d6d9ff98608044c00212473f9c14892f')
pathlib.Path('sqlite-src/sqlite-amalgamation-3490100/extension-functions.c').write_bytes(extension)
PY
mkdir -p dist
make -o sqlite-src/sqlite-amalgamation-3490100 EMFLAGS_OPTIMIZED='-Oz -flto' dist/sql-wasm.js dist/sql-wasm-browser.js
# swapped in whole, with the patch as its stamp, so the preload recognises a complete build
mkdir "$partial"
cp dist/sql-wasm.js dist/sql-wasm.wasm dist/sql-wasm-browser.js dist/sql-wasm-browser.wasm "$output/sqljs.patch" "$partial/"
chmod 644 "$partial"/*.wasm
rm -rf "$output/dist" "$cache"
mkdir -p "$(dirname "$cache")"
cp -R "$partial" "$cache"
mv "$partial" "$output/dist"
