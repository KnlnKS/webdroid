# Original APK compatibility audit — 2026-09-24

The active scope is the 20 APKs present before the latest additions to `apks/`. The boot sweep at `4c23392c` used `WEBDROID_URL=http://localhost:4197 bun run corpus [20 package names] --json webdroid-shots/corpus-original-20.json`. All 20 drew a frame and supplied diagnostics. The sweep stops shortly after the first drawn frame; zero observed missing entries does not prove full feature coverage. Ad and ad API work is excluded.

| APK | Boot-path missing APIs after targeted fixes | Open functional evidence |
| --- | --- | --- |
| Amazon.xapk | Private Amazon classes/services; optional SLF4J binder | Native ARM fault in Weblab plugin; shopping content and sign-in need deeper exercise |
| Among Us.xapk | None observed | Practice works; online service connection failed on deployed relay |
| ChatGPT.xapk | `java/net/DatagramSocket`; optional Amazon IAP probe | Settings flow fails; authenticated upload and voice unvalidated |
| Cut the Rope.xapk | None observed | Level-one tutorial works; intro video and later gameplay speed remain open |
| DoodleJumpChrismas.apk | None observed | Boot only |
| FitNotes.apk | None observed | Covered by E2E and Android comparison flows |
| GmsClient.apk | None observed | Boot only |
| Google Maps.apk | None observed on targeted rerun | Backup transport is absent; maps interaction still needs feature-path audit |
| Reddit.xapk | None observed | Boot only |
| Resy.apk | None observed | Boot only |
| Subway Surfers.apk | None observed | Active run works; background Firebase initialization reports an error |
| TikTok.apk | Optional bundled and vendor SDK probes | Playback/input rate and authentication/publishing remain unvalidated |
| Twitch.xapk | Optional MIUI referrer probe | Boot only |
| WebdroidFuzzProbe.apk | None observed | Boot only |
| YouTube.xapk | Optional window extensions and `media_metrics` | Full matrix has shown settle timeouts and a draw error |
| calculatorm.apk | None observed | Covered by E2E and Android comparison flows |
| flappybird.apk | None observed | Auxiliary snapshots unavailable |
| harmonic.apk | Optional window extension probe | Article WebView works in deployed build; full navigation remains open |
| lichess.apk | Optional window sidecar probe | Intermittent Dart pthread faults and flow timeouts |
| mihon-v0.20.4.apk | None observed | Boot only |

The Google Maps targeted rerun at `e0045864` drew a frame with zero missing entries, zero required native calls and two process errors. CursorWindow has typed row access and parcel round trip; FileBackupHelper currently supports construction only. Implement and verify backup transport before treating Android backup as supported. The remaining rows use the original sweep unless a focused rerun is recorded elsewhere. Full use of every app has not been demonstrated.
