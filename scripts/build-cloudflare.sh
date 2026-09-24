#!/bin/sh
set -eu

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl --retry 3 -fsSL https://github.com/KnlnKS/webdroid/releases/download/build-inputs-v1/build-inputs.tar.gz -o "$tmp/build-inputs.tar.gz"
echo '298181acf6b14fd99299302ab4c8c0296f6bc8c9ea7ad5ca7b2221951371e425  '"$tmp/build-inputs.tar.gz" | sha256sum -c -
tar -xzf "$tmp/build-inputs.tar.gz"

curl --retry 3 -fsSL https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz -o "$tmp/zig.tar.xz"
echo '70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00  '"$tmp/zig.tar.xz" | sha256sum -c -
mkdir "$tmp/zig"
tar -xJf "$tmp/zig.tar.xz" --strip-components=1 -C "$tmp/zig"
PATH="$tmp/zig:$PATH" bun run build:prod
