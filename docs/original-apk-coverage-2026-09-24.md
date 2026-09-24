# Original APK compatibility audit — 2026-09-24

The active scope is the 20 APKs present before the latest additions to `apks/`. The boot sweep at `4c23392c` used `WEBDROID_URL=http://localhost:4197 bun run corpus [20 package names] --json webdroid-shots/corpus-original-20.json`. All 20 drew a frame and supplied diagnostics. The sweep stops shortly after the first drawn frame; zero observed missing entries does not prove full feature coverage. Ad and ad API work is excluded.

| APK | Boot-path missing APIs after targeted fixes | Open functional evidence |
| --- | --- | --- |
| Amazon.xapk | Private Amazon classes/services; optional SLF4J binder | The Weblab Thumb APSR fault is fixed at instruction level; shopping content and sign-in need deeper exercise |
| Among Us.xapk | None observed | Practice works; online service connection failed on deployed relay |
| ChatGPT.xapk | Optional Amazon IAP probe on targeted Bun-server boot | The 24-step guest flow passes; hosted UDP and screen projection remain unsupported; camera and authenticated media paths unvalidated |
| Cut the Rope.xapk | None observed | Level-one tutorial works; intro video and later gameplay speed remain open |
| DoodleJumpChrismas.apk | None observed | Title and gameplay draw without GL errors; title motion remains below the retained 55 fps gate at 44 shell frames/s |
| FitNotes.apk | None observed | Covered by E2E and Android comparison flows |
| GmsClient.apk | None observed | Boot only |
| Google Maps.apk | None observed on targeted rerun | Search and place details work, but the map surface remains blank in both this worktree and the matching starting revision; backup transport is absent |
| Reddit.xapk | Optional App Set, AppsFlyer and MIUI class probes | Boot only |
| Resy.apk | None observed | Boot only |
| Subway Surfers.apk | None observed | Active run works; background Firebase initialization reports an error |
| TikTok.apk | Optional bundled and vendor SDK probes | Playback/input rate and authentication/publishing remain unvalidated |
| Twitch.xapk | Optional MIUI referrer probe | Boot only |
| WebdroidFuzzProbe.apk | None observed | Boot only |
| YouTube.xapk | Optional window extensions | Targeted 16-step playback passes; the later serialized matrix saw a bundled V8 memory-protection error and a fullscreen layout stall |
| calculatorm.apk | None observed | Covered by E2E and Android comparison flows |
| flappybird.apk | None observed | Auxiliary snapshots unavailable |
| harmonic.apk | Optional window extension probe | Article WebView works in deployed build; full navigation remains open |
| lichess.apk | Optional window sidecar probe | A 15-step fast flow now completes without the prior Dart pthread aborts; longer sessions remain unvalidated |
| mihon-v0.20.4.apk | None observed | Boot only |

The current 20-app rerun at `0ac2f429` drew 20/20 frames with diagnostics. Google Maps had zero missing entries, zero required native calls and two process errors. CursorWindow has typed row access and parcel round trip; FileBackupHelper currently supports construction only. Implement and verify backup transport before treating Android backup as supported. A focused Amazon rerun after `a4dbe53b` did not reproduce its prior Thumb APSR fault, and the exact instruction sequence passes a core test; this does not establish a long-session fix. Full use of every app has not been demonstrated.

A fresh 20-app sweep after the YouTube media-metrics work again rendered 20/20 with diagnostics and zero native requirements. Distinct boot-path missing entries fell from 30 to 27, with no new entry in any app. The remaining entries are concentrated in optional AndroidX or vendor class probes and Amazon's private service names; they do not describe all unexercised feature paths. Lichess had no errors in this short boot sweep, which does not resolve its intermittent longer-run pthread faults.

A later ChatGPT rerun on the Bun development server observed the optional Amazon IAP class probe but no UDP transport miss. A local UDP echo round trip verified the relay's binary framing, and ChatGPT smoke compilation had zero method failures. The fast ChatGPT flow exposed `media_projection` and `device_policy` service requests on feature paths. The device-policy camera query now returns the state of a device with no active administrator. Settings, Language and About initially appeared to fail because the flow's top-bar tap missed the visible navigation button; correcting the recorded coordinate let all 24 checkpoints complete. The attachment path displays “Unable to initialize the camera”; the current virtual device exposes no camera IDs. Remote UDP is available in the Bun development server; the hosted Worker has no UDP transport. The ChatGPT flow's other missing entries and the NTP response itself have not been fully validated.

YouTube's APK references playback, bundle and editing media metrics sessions. The new service now creates unique log session IDs, retains bounded reports and builds event values. A direct session/builder/report call passed. Its video player exposed `AudioTrack.setLogSessionId`, which now preserves the assigned ID. The fast flow initially tapped a partially visible result label near the bottom navigation bar and returned to Home; tapping the visible thumbnail reached the video and exposed the audio method. After both fixes, all 16 fast checkpoints completed with no new media-metrics or audio API miss. The remaining boot gaps were optional window-extension probes; the reported DNS warning came from bundled Chromium.

The later serialized 13-flow fast matrix reached 10/13 checkpoints. ChatGPT passed all 24 steps. YouTube opened, paused and resumed the film, but bundled V8 logged an `mprotect` ENOMEM at `0xffdf8000`; fullscreen then left the main queue inside layout, so back and Shorts could not run. A targeted repeat before and after the execute-only `mprotect` correction passed all 16 YouTube steps without that fault; causality remains unproven. Doodle Jump's title step averaged 44 shell frames/s against its retained 55 threshold, with about 23 presentations/s. Lichess again aborted with Dart pthread error 35 during launch. These failures need controlled reproductions; the short boot sweep did not exercise them.

A native ABI follow-up added the reported YouTube pthread attribute and cleanup functions, its API-level query, and Doodle Jump's GLES1 clip-plane and multitexture calls. A targeted two-app corpus then drew both with zero native requirements. The Doodle fast flow still missed its title motion gate at the same 44 shell frames/s seen before the GLES changes; all six steps had zero GL errors or native requirements. Its visual game screen rendered. Lichess's Dart pthread error 35 came from an exited joinable thread whose handle allocation had been freed before `pthread_join`; a later thread could reuse that address. Retaining joinable storage until join or detach removed the boot abort in a 20-second probe, and a subsequent 15-step fast flow completed with no pthread error or native requirement. The fast flow still saw the optional AndroidX sidecar probe and a bundled Chromium DNS warning.

Google Maps reached search results and place details after the typed `SystemProperties` getters were added. Its map surface stayed blank after waiting for tile and result requests, with zero GL draw calls. The starting revision showed the same blank surface under matching inputs. Several `/glm/mmap` requests returned 200 while others failed; the current evidence does not isolate a platform API cause. The typed getter removed an observed reflective `getInt` failure, but did not make the map render.

The serialized original-20 boot sweep after these changes rendered 20/20 apps and collected diagnostics for every process. It reported zero called native requirements and 29 distinct missing entries. The entries include optional AndroidX and vendor class probes and Amazon's private service names; they are not evidence that those absent packages should be fabricated as platform APIs. This is startup coverage only.
