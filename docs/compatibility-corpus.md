# Open-source compatibility corpus

Pinned on 2026-09-24. The twelve F-Droid APKs below are the downloaded repository builds; three existing local fixtures are included. APKs are ignored by Git. Their SHA-256 hashes allow the same bytes to be restored. The initial scan used `WEBDROID_URL=http://localhost:4091 bun run corpus ... --wait 8000` against the starting commit. It observed launch only. An empty missing list does not imply full API or feature coverage. Errors and missing calls in child processes were collected when diagnostics were available.

| App | APK / source | API areas | Initial launch | SHA-256 |
| --- | --- | --- | --- | --- |
| Mihon | `mihon-v0.20.4.apk` ([source](https://github.com/mihonapp/mihon)) | reader, Compose, storage | frame; 0 missing | `49450a6b85ea37a2e1a0a5ff84549b62a00de7c6745d85a0779c30adf7c6894a` |
| Harmonic | `harmonic.apk` ([source](https://github.com/SimonHalvdansson/Harmonic-HN)) | network, WebView, window management | frame; 1 missing | `de65ca1f2ba6c6287cc464c4883c8db32d6b562bf56614aff0fe43869f4e1f00` |
| Lichess | `lichess.apk` ([source](https://github.com/lichess-org/mobile)) | chess, network, native code | frame; 1 missing | `9d8a9fbe6d6a2b1d445b6427b0ccc13ac45ed8da1b52df9a4abcd14d08ae7387` |
| org.schabi.newpipe | `org.schabi.newpipe_1015.apk` ([source](https://f-droid.org/packages/org.schabi.newpipe/)) | video, media playback, network | frame; 2 missing | `1d66d19eedbab969b1be2e44e0ea35f5f8921cbe83b5c5ac810767ca1a84b7e8` |
| de.danoeh.antennapod | `de.danoeh.antennapod_3120295.apk` ([source](https://f-droid.org/packages/de.danoeh.antennapod/)) | podcasts, audio, services, SSL | frame; 1 missing | `3f43a4337a693cdb49141afe06cb596e88c796009ed77bff51e9444ce2d1ebfc` |
| app.organicmaps | `app.organicmaps_26082718.apk` ([source](https://f-droid.org/packages/app.organicmaps/)) | maps, location, native graphics | frame; 3 missing | `c1fc03a8bad4dac3c400c50764a929ec7a07b02ba572336bfdd9e722a4f96519` |
| de.dennisguse.opentracks | `de.dennisguse.opentracks_6751.apk` ([source](https://f-droid.org/packages/de.dennisguse.opentracks/)) | location, sensors, export | frame; 1 missing | `bccb5d20069e2a19fb65a9eb5e74534cfc449ea8ef52bcbfb08cef9c4b5c0cc7` |
| com.kunzisoft.keepass.libre | `com.kunzisoft.keepass.libre_45400.apk` ([source](https://f-droid.org/packages/com.kunzisoft.keepass.libre/)) | crypto, files, autofill | frame; 2 missing | `862f87a30baef06181f049adf7c460611605b25a807eaf3c25841a9dd84bed9e` |
| com.beemdevelopment.aegis | `com.beemdevelopment.aegis_82.apk` ([source](https://f-droid.org/packages/com.beemdevelopment.aegis/)) | authentication, camera, security | no frame; 0 missing; unavailable diagnostics | `0eecec45de0da3ff1358004b51e2960d9178551643a6ed44f6496ea9ec999c19` |
| net.thunderbird.android | `net.thunderbird.android_31.apk` ([source](https://f-droid.org/packages/net.thunderbird.android/)) | mail, SQLite, networking | no frame; 1 missing | `1e4a2e23a4bff8c8d96eae7ed809f1ebd05a4ab24650ab792c226749dd51d936` |
| com.nononsenseapps.feeder | `com.nononsenseapps.feeder_4113.apk` ([source](https://f-droid.org/packages/com.nononsenseapps.feeder/)) | RSS, background sync, text | frame; 3 missing | `0aa5eb094f94ca29ab7956d75b9e5d7c19785ebdac74b9ae512930084338bf3c` |
| org.fossify.filemanager | `org.fossify.filemanager_13.apk` ([source](https://f-droid.org/packages/org.fossify.filemanager/)) | documents, storage, files | frame; 3 missing | `9e97d2faf55fb2702386c3dc51e38a6b073781016b125701d3ab668419a70008` |
| org.fossify.calendar | `org.fossify.calendar_20.apk` ([source](https://f-droid.org/packages/org.fossify.calendar/)) | calendar provider, reminders | frame; 1 missing | `2acbd47fa2abc6dd4846e406ed2fd60c5c01b8613158d10e012135923ee24894` |
| org.fossify.gallery | `org.fossify.gallery_28.apk` ([source](https://f-droid.org/packages/org.fossify.gallery/)) | media store, images, permissions | frame; 5 missing | `ae7e699599e81f70e2b82626bb1dfa883fe096cd938387133e123c116e5641d9` |
| net.gsantner.markor | `net.gsantner.markor_163.apk` ([source](https://f-droid.org/packages/net.gsantner.markor/)) | text editing, widgets, files | frame; 2 missing | `3f9f260dc3e32a1281cb8803eea6f926eef897579f68a5d35f922523974b84b9` |

## Initial observed missing APIs

### Mihon

No missing API was observed at launch.

### Harmonic

- `class androidx/window/extensions/WindowExtensionsProvider`

### Lichess

- `class androidx/window/sidecar/SidecarProvider`

### org.schabi.newpipe

- `java/util/ResourceBundle.getBundle(Ljava/lang/String;Ljava/util/Locale;)Ljava/util/ResourceBundle; is not a function`
- `class android/widget/RadioGroup$OnCheckedChangeListener`

### de.danoeh.antennapod

- `org/conscrypt/NativeCrypto.clinit()V [native]`

### app.organicmaps

- `android/content/Intent.parseIntent(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;)Landroid/content/Intent; is not a function`
- `android/app/Activity.getSplashScreen()Landroid/window/SplashScreen; is not a function`
- `app/organicmaps/sdk/util/Config.nativeGetBoolean(Ljava/lang/String;Z)Z [native]`

### de.dennisguse.opentracks

- `java/lang/String.join(Ljava/lang/CharSequence;Ljava/lang/Iterable;)Ljava/lang/String; is not a function`

### com.kunzisoft.keepass.libre

- `class android/inputmethodservice/InputMethodService`
- `android/view/View.addOnUnhandledKeyEventListener(Landroid/view/View$OnUnhandledKeyEventListener;)V is not a function`

### com.beemdevelopment.aegis

Diagnostics unavailable: the browser page crashed before runtime inspection.

### net.thunderbird.android

- `android/content/Context.openOrCreateDatabase(Ljava/lang/String;ILandroid/database/sqlite/SQLiteDatabase$CursorFactory;)Landroid/database/sqlite/SQLiteDatabase; is not a function`

### com.nononsenseapps.feeder

- `class androidx/window/sidecar/SidecarProvider`
- `class androidx/window/extensions/WindowExtensionsProvider`
- `java/text/Bidi.<init>(Ljava/lang/String;I)V (direct)`

### org.fossify.filemanager

- `class android/hardware/fingerprint/FingerprintManager`
- `systemService FingerprintManager`
- `java/text/SimpleDateFormat.toLocalizedPattern()Ljava/lang/String; is not a function`

### org.fossify.calendar

- `class android/provider/BlockedNumberContract$BlockedNumbers`

### org.fossify.gallery

- `class android/hardware/fingerprint/FingerprintManager`
- `systemService FingerprintManager`
- `java/text/SimpleDateFormat.toLocalizedPattern()Ljava/lang/String; is not a function`
- `android/provider/MediaStore.canManageMedia(Landroid/content/Context;)Z is not a function`
- `android/content/ContentResolver.query(Landroid/net/Uri;[Ljava/lang/String;Landroid/os/Bundle;Landroid/os/CancellationSignal;)Landroid/database/Cursor; is not a function`

### net.gsantner.markor

- `vcall other/writeily/widget/WrMarkorWidgetProvider.onReceive(Landroid/content/Context;Landroid/content/Intent;)V`
- `vcall net/gsantner/markor/widget/TodoWidgetProvider.onReceive(Landroid/content/Context;Landroid/content/Intent;)V`

## Investigation and fixes in progress

- The initial Aegis page crash reproduced in isolation. Chromium reported V8 OOM. An `AutoCompleteTextView` constructor called a virtual two-argument constructor from its three-argument constructor, recursing through the app subclass. The shared text-view constructor path and dropdown accessors now let Aegis render with zero missing APIs or reported errors at launch.
- OpenTracks launched without missing calls or reported errors after `String.join(CharSequence, Iterable)` and the empty-property animator fix. Calendar also stopped reporting the animator rejection.
- NewPipe resource-bundle loading advanced through its bundled `ListResourceBundle` classes. Live search returned video results and a detail page. The player opened after framework package-signature, media notification and progress drawable fixes. Its cache's serialized Java list and atomic counter now round-trip through Android-compatible forms.
- Fossify File Manager and Gallery advanced past `SimpleDateFormat.toLocalizedPattern` and exposed additional storage, media, and layout calls.
- Markor's new-file flow exposed NIO writability, adapter mutations and lookup, a list popup, a selected-item listener, scrollbar width, and the `UpdateLayout` span marker. The file editor saved a 36-byte Markdown document under `/sdcard/Documents/markor/`. Shared external storage previously disappeared on reload because only package-private paths were persisted; the file and directory now restore before app initialization. Reopening needed `TextView.setTextKeepState`; preview exposed `StringBuilder.append(CharSequence, start, end)` incorrectly stringifying its source and recursing through Flexmark's `RepeatedCharSequence`.
- Fossify File Manager created `/sdcard/Compatibility/notes.txt`. Glide's thumbnail worker then reached the absent `MediaMetadataRetriever` class. A shared MP4-backed retriever now returns metadata and a decoded frame for the pinned media fixture; it reports invalid nonmedia sources to Glide. A real MP4 copied into shared storage appeared in File Manager after reload without new missing API reports.
- Fossify Calendar's New Event form probed `DatePickerDialog.OnDateSetListener` and `CalendarContract.Calendars`. Its bytecode also references the CalendarContract event, attendee, reminder and color URIs. The date picker now opens, advances September 24 to October 24, and updates the form. Saving an event first showed a reminder warning, then reached a day view with the event; it remained visible after reload. The notification path exposed `Context.grantUriPermission`, now tracked as a transient grant. The system calendar provider and actual alarm delivery remain unverified.
- Fossify Gallery could browse `/sdcard/DCIM` in its folder picker but stayed empty with a real MP4 there: `ContentResolver.query(content://media/external/file)` returned null because no MediaStore index existed. The shared index now answers projection, selection, arguments and sort through SQLite, backed by external VFS files. Gallery showed the DCIM folder, its media grid, and an MP4 viewer. A generated PNG opened and visibly rendered after adding window color mode, bitmap color space and region decoding. Video play reached ExoPlayer controls after media metrics and `AudioTrack.setLogSessionId` support, with no observed missing calls or errors in that short fixture run. Actual video frames, editing, deletion and broad image formats remain unverified.
- Feeder's Add feed form accepts a URL. Its bundled Moshi adapter initially rejected the Kotlin `GoFeed` type because annotation arrays had no Java array type: Kotlin reflection ignored the `kotlin.Metadata` version and saw a Java constructor with no primary flag. Typed annotation arrays now let a direct `GoFeedAdapter` construction succeed. Searching for the F-Droid feed reaches the bundled Go parser. Raw ARM64 signal, event, descriptor and memory-residency syscalls now let that runtime start; its `SIGURG` handler receives an alternate stack and arm64 context. The XML path exposed missing `InputSource` accessors, now present. A Go thread still sometimes returns from `runtime.futexsleep` to address `0x1`; feed results and article reading remain blocked. This fault reproduces with `?jit=0` and with no missing native syscall report.
- Lichess's Flutter worker previously aborted with native `pthread` error 35. A joinable thread's `pthread_t` allocation was freed at thread exit, so a new thread could reuse its handle before `pthread_join`. The later join then identified the new caller as itself and returned `EDEADLK`. Joinable handles now remain allocated until join or detach. A serialized 15-step flow rendered the home screen, board editor, computer-game setup and a Stockfish level 1 game through three player moves and engine replies. The flow reported no required native calls, GL/layout/draw errors or faults. Its only missing class was the optional OEM `androidx.window.sidecar.SidecarProvider`; a Cronet DNS-configuration warning was logged. Online play, account, persistence and broader chess features remain unverified.
- Organic Maps advanced from welcome to a native-rendered world overview. Its Java downloader writes parallel 512 KiB ranges through separate `RandomAccessFile` handles; stale per-handle snapshots previously overwrote other ranges. Refreshing shared file bytes before each operation produced the CDN's exact World and WorldCoasts file sizes and SHA-1 digests. The map callback needs `SurfaceHolder.getSurfaceFrame()` and `isCreating()`; their former placeholder values prevented renderer creation. A reload loaded both maps and showed coastlines and labels with 159 EGL swaps, roughly 3,000 GL draws, and no observed missing Java/native calls or GL fault. The first session also reached an automatic regional-download dialog. Search opened and accepted `coffee` with no missing API report, but the four-second snapshot still showed loading placeholders. The map data and APK remain untracked local test inputs; a later Monaco run covered search and routing below.
- A Monaco location check exposed a second shared file bug: the region downloaded with the CDN's exact 1,077,264 bytes and SHA-1, but Organic Maps failed its BLAKE3 integrity check. The native file handle reported the new logical length while retaining a shorter view of the same backing buffer. The final read supplied only 8,183 of 28,688 bytes. Updating that view when a VFS write extends it let the unchanged app verify and register `Monaco.mwm`; streets and labels rendered. Search for `Casino` returned nearby places including Casino de Monte Carlo and rendered map markers. Selecting that place exposed `Collections.rotate`, used to order its opening hours. The shared list implementation now updates through a list iterator; the place sheet rendered its title, hours, Wikipedia summary and route controls with no further observed missing Java/native API or native fault. Route to invoked the unchanged native router, which found a 615 m path with 95-second ETA; the map drew the path and route controls without missing calls or fault. Navigation, broader map use and Android visual parity remain open.
- Start and Accept entered Organic Maps' navigation UI with street, distance, speed and Stop controls. Its foreground service first required `Context.createAttributionContext` and `MediaPlayer.setAudioAttributes`; both are now shared implementations. The final observed navigation snapshot had no missing Java/native call or native fault. MediaPlayer's file-descriptor audio loading decoded a generated 0.25-second WAV in Chromium, but actual spoken directions, movement along the route and Android visual parity are unverified.

### Interaction evidence after launch

| App | Reached | Remaining limit |
| --- | --- | --- |
| Mihon | Reader shell launches | Onboarding, library import and reading unverified; a FirebaseSessions boxed-number cast remains in logs |
| Harmonic | Welcome dialog's Get started action | Article navigation and WebView behavior unverified; optional OEM window-extension probes remain |
| Lichess | Home, board editor, and Stockfish level 1 game through e4, Nf3 and Ne5 with engine replies; serialized flow rendered 15/15 steps | Online play, account, persistence, other game modes and Android visual parity unverified |
| NewPipe | Search suggestions, live results, video detail, player service and controls | Video area remains black after 20 seconds with zero presented surface frames; audio playback unverified |
| AntennaPod | Search field; bundled Conscrypt JNI loads | Podcast fetch and audio playback unverified |
| Organic Maps | Downloaded the world overview and Monaco region; rendered both; searched, opened place details, drew a route and entered navigation UI | Actual spoken directions, moving-location route following, broader location use and Android visual parity unverified |
| OpenTracks | Main screen | Track recording, location and export unverified |
| KeePassDX | New-vault password form and notification prompt | Database creation, unlock and file-picker behavior unverified |
| Aegis | Password-protected empty vault; manual entry saved in an unencrypted vault, rendered a six-digit TOTP code and survived page reload | Encrypted-vault entry save and reload, QR scanning and backup unverified |
| Thunderbird | Add Account form | Account setup and mail use unverified |
| Feeder | Feed URL/Search/Add feed form; Kotlin Moshi adapter constructs and bundled Go runtime starts | A Go thread returns from `runtime.futexsleep` to address `0x1`; feed results, article reading and sync remain blocked |
| Fossify File Manager | Created a folder and empty file; an MP4 appeared after reload | Copy, rename, delete, previews and broader media formats unverified |
| Fossify Calendar | Created a local event, changed its date with the date picker, and found the event after reload | System calendar sync, edit/delete, recurrence and actual reminder delivery unverified |
| Fossify Gallery | Indexed a real MP4 and PNG, opened their grid/viewers, and rendered the PNG | Video frame output, editing, deletion, metadata and broader formats unverified |
| Markor | Created, saved and reopened a Markdown file after reload; preview rendered in WebView and search reported 1/1 matches | Export and other editor flows unverified |

`androidx.window` sidecar/extension provider probes in Harmonic, Lichess and Feeder are optional OEM classes, so their absence is retained rather than reported as implemented support. A launch or an empty missing list covers only the exercised path. The Aegis password and manual-entry flows exposed Java character-array decoding, charset encoding, resource-bundle controls, permissions, layout animation, object serialization and drawable null layers after the initial scan. A sample manual entry displayed a TOTP code before and after page reload with no observed missing APIs or errors on that path.

The 2026-09-24 repeat launch scan of these pinned APKs drew 15/15 frames with zero native requirements. Only the two optional `androidx.window` provider classes appeared as missing calls. At that point Lichess still aborted its Flutter worker with native `pthread` error 35; the subsequent handle-lifetime fix and 15-step flow are recorded above. Mihon logged an OkHttp cache recovery and a FirebaseSessions boxed-number cast, NewPipe logged an RxJava undeliverable exception, and File Manager logged Glide failures for `/sdcard/Android`; these need causal checks before treating them as compatibility regressions or harmless probes.

Full usability requires interaction flows and Android reference comparisons for each app. The launch scan is only the first gate.
