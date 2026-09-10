# microG Services and Companion

Upstream: https://github.com/microg/GmsCore/tree/v0.3.16.252432

Release URLs and SHA-256 digests are pinned in `src/shell/system-packages.ts`.
`bun scripts/system-packages.ts` verifies/downloads the unmodified upstream APKs to
`~/.cache/webdroid/packages` (`WEBDROID_PACKAGE_CACHE` overrides the directory).
The APKs are served as static assets and executed in the browser, never on the server.

microG is Copyright 2013–2025 microG Project Team, Apache License 2.0.
Upstream license: https://github.com/microg/GmsCore/blob/v0.3.16.252432/LICENSE
Bundled dependencies retain their upstream licenses in the APKs.

Signature compatibility reads the APK's own `fake-signature` manifest metadata, only
after verifying the entire pinned APK. Actual signer certificates remain authoritative
for installation/update verification. Arbitrary installed APKs receive no such grant.
