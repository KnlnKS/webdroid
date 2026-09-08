# Android system trust store

Source: [AOSP system/ca-certificates](https://android.googlesource.com/platform/system/ca-certificates/+/45c7f199cb11b08f6d1ae2b75da25e53140a0c7d/), pinned to commit `45c7f199cb11b08f6d1ae2b75da25e53140a0c7d`.
Retrieved 2026-09-08 from `+archive/<commit>/files.tar.gz`.

`android-cacerts.pem` contains the unmodified PEM certificate blocks from all 149
upstream `files/` entries, sorted by filename and concatenated. Human-readable
OpenSSL text dumps following each PEM block were omitted. The index retains
upstream subject-hash filenames and records each PEM block's byte length.

SHA-256 of the concatenated PEM file: `e5800ec5bfb94f7c4dc138886e2a27c3aa3f9f5c81299f7229c71250d35d1fb1`.

The upstream README and licensing METADATA are preserved alongside the bundle.
Certificates are public trust material with their own embedded certificate-policy
identifiers; the upstream METADATA specifies special licensing conditions rather
than a blanket source-code license. No certificate, private key, trust exception,
or app-specific hostname has been added.

The shell mounts the index without network requests. Certificate file reads share
one range-backed asset with a bounded 256 KiB cache, avoiding one request per file.
To update, fetch a reviewed AOSP revision, extract each complete BEGIN/END
CERTIFICATE block in filename order, regenerate the filename/length index and
update the pinned hash in the asset test.
