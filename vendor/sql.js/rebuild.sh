#!/bin/sh
set -eu
emcc --version | head -1 | grep -q '4.0.9' || { echo 'Activate Emscripten 4.0.9 first' >&2; exit 1; }
output=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git clone --quiet --depth 1 --branch v1.14.2 https://github.com/sql-js/sql.js.git "$work/sql.js"
cd "$work/sql.js"
git checkout --quiet 9c4e167ec37129192d166ab9223faa9a4bd07c58
git apply "$output/int64.patch"
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
cp dist/sql-wasm.js dist/sql-wasm.wasm dist/sql-wasm-browser.js dist/sql-wasm-browser.wasm "$output/dist/"
chmod 644 "$output"/dist/*.wasm
