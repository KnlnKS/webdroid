#!/bin/sh
set -eu

# vendor/aosp is pulled from the reference device (pnpm gen-framework), which a build machine has not: the build
# variables name an archive of it (tar -C vendor -czhf aosp.tar.gz aosp) and that archive's digest.
: "${WEBDROID_AOSP_URL:?set it to an archive of vendor/aosp (docs/deployment.md)}"
: "${WEBDROID_AOSP_SHA256:?set it to the sha256 of the WEBDROID_AOSP_URL archive}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Mirrors intermittently answer 404; --retry alone never retries HTTP errors.
fetch() {
  curl --retry 5 --retry-all-errors --retry-delay 5 -fsSL "$1" -o "$tmp/$2"
  echo "$4  $tmp/$2" | "$3" -c -
}

fetch https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz zig.tar.xz sha256sum 70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
fetch "$WEBDROID_AOSP_URL" aosp.tar.gz sha256sum "$WEBDROID_AOSP_SHA256"

mkdir -p "$tmp/zig" vendor
tar -xJf "$tmp/zig.tar.xz" --strip-components=1 -C "$tmp/zig"
tar -xzf "$tmp/aosp.tar.gz" -C vendor

WEBDROID_EMSDK="$tmp/emsdk" PATH="$tmp/zig:$PATH" pnpm build:prod
