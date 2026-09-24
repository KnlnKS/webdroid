#!/bin/sh
set -eu

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl --retry 3 -fsSL https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz -o "$tmp/zig.tar.xz"
echo '70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00  '"$tmp/zig.tar.xz" | sha256sum -c -
mkdir "$tmp/zig"
tar -xJf "$tmp/zig.tar.xz" --strip-components=1 -C "$tmp/zig"

curl --retry 3 -fsSL https://dl.google.com/android/repository/platform-33-ext3_r03.zip -o "$tmp/platform.zip"
echo '394bc86d8d3452aa4d419b67743025a6fb2cd9d0  '"$tmp/platform.zip" | sha1sum -c -
curl --retry 3 -fsSL https://dl.google.com/android/repository/build-tools_r35.0.1_linux.zip -o "$tmp/build-tools.zip"
echo 'e009a9b188cfeb1d2b4c318ab5cb4f1ddc368861  '"$tmp/build-tools.zip" | sha1sum -c -
mkdir -p "$tmp/sdk/platforms" "$tmp/sdk/build-tools"
unzip -q "$tmp/platform.zip" -d "$tmp/sdk/platforms"
unzip -q "$tmp/build-tools.zip" -d "$tmp/sdk/build-tools"
mv "$tmp/sdk/platforms/android-13" "$tmp/sdk/platforms/android-33"
mv "$tmp/sdk/build-tools/android-15" "$tmp/sdk/build-tools/35.0.1"

ANDROID_HOME="$tmp/sdk" WEBDROID_EMSDK="$tmp/emsdk" PATH="$tmp/zig:$PATH" bun run build:prod
