# microG Services and Companion

Upstream: https://github.com/microg/GmsCore/tree/v0.3.17.252432

Source URLs, APK SHA-256 digests and generated-index digests are pinned in
`src/shell/system-packages.ts`. Generated files live in `vendor/microg/`, which is
ignored by Git. Do not commit the generated indexes, entries or APKs.

`pnpm ts scripts/system-packages.ts [source-directory]` generates missing bundles.
Server startup runs the same preparation automatically. Complete bundles require no
upstream request or regeneration. Missing entries are regenerated from the cached
APK, downloading the pinned release only if that source is absent or invalid.
The source cache defaults to `~/.cache/webdroid/packages`; `WEBDROID_PACKAGE_CACHE`
or the script's directory argument overrides it.

Preparation verifies APK signatures and hashes, groups resources into a startup
bundle, and separates DEX and native entries for demand loading. Gzip objects use
browser-native decompression. Original deflate streams, ZIP headers and signing
blocks are retained so file reads reconstruct the exact signed APK. Content hashes
verify decoded entries and reconstructed source fragments. No bytecode or native
library is patched. Android execution remains entirely in the browser.

microG is Copyright 2013–2025 microG Project Team, Apache License 2.0.
Upstream license: https://github.com/microg/GmsCore/blob/v0.3.17.252432/LICENSE
Bundled dependencies retain their upstream licenses in the APKs.

Signature compatibility reads the APK's own `fake-signature` manifest metadata, only
after verifying the entire pinned APK. Actual signer certificates remain authoritative
for installation/update verification. Arbitrary installed APKs receive no such grant.

The bundled profile disables microG's optional radio-based network location service
when no explicit component setting exists. Genuine microG then requests Android's
platform network provider, supplied by browser geolocation. Explicit component
settings survive provisioning. Browsers expose no Wi-Fi/cell scans; this configuration
does not manufacture radio observations or modify microG bytecode.
