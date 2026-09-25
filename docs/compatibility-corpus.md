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

## Later evidence

The initial calls above are a launch snapshot, not the current missing-API list.
All 15 apps later drew a first frame. The [corpus handoff](../corpus-plan-v2.md)
records exercised features and remaining work; [implementation history](implementation-history.md)
records shared failure mechanisms. Optional OEM `androidx.window` provider probes
are deliberately left absent.
