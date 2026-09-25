# APK compatibility audit — 2026-09-24

Boot audit of the 32 packages present in `apks/` on 2026-09-24, captured at commit `4c23392c` with `WEBDROID_URL=http://localhost:4197 bun run corpus --json webdroid-shots/corpus-32-20260924.json`. The corpus waits for one drawn frame and 1.5 seconds; its missing entries are observed paths across available processes, not an exhaustive list of reachable APIs. A rendered frame does not establish usability. Ads and ad APIs are outside this audit.

30/32 packages drew a frame. Aegis crashed its browser page before diagnostics. Thunderbird reached diagnostics but drew no frame. Every other row had process diagnostics available and no observed required native host call.

## Packages and observed gaps

### Amazon.xapk

Boot: frame drawn; diagnostics: ok; missing: 12; errors: 18.

Observed missing entries:

- `class amazon/os/Build$VERSION`
- `systemService dcp_data_storage_factory`
- `systemService sso_platform`
- `systemService sso_local_datastorage`
- `systemService dcp_system`
- `systemService sso_alarm_maanger`
- `systemService dcp_amazon_account_man`
- `systemService dcp_device_info`
- `systemService dcp_token_mangement`
- `systemService sso_webservice_caller_creator`
- `systemService com.amazon.client.metrics.api`
- `class org/slf4j/impl/StaticLoggerBinder`

### Among Us.xapk

Boot: frame drawn; diagnostics: ok; missing: 0; errors: 2.

No missing entry on the observed boot path.

### ChatGPT.xapk

Boot: frame drawn; diagnostics: ok; missing: 2; errors: 6.

Observed missing entries:

- `class com/amazon/device/iap/PurchasingListener`
- `class java/net/DatagramSocket`

### Cut the Rope.xapk

Boot: frame drawn; diagnostics: ok; missing: 0; errors: 0.

No missing entry on the observed boot path.

### DoodleJumpChrismas.apk

Boot: frame drawn; diagnostics: ok; missing: 0; errors: 1.

No missing entry on the observed boot path.

### FitNotes.apk

Boot: frame drawn; diagnostics: ok; missing: 0; errors: 0.

No missing entry on the observed boot path.

### GmsClient.apk

Boot: frame drawn; diagnostics: ok; missing: 0; errors: 0.

No missing entry on the observed boot path.

### Google Maps.apk

Boot: frame drawn; diagnostics: ok; missing: 4; errors: 2.

Observed missing entries:

- `class android/os/PerformanceHintManager`
- `systemService PerformanceHintManager`
- `class android/database/CursorWindow`
- `class android/app/backup/FileBackupHelper`

### Reddit.xapk

Boot: frame drawn; diagnostics: ok; missing: 0; errors: 2.

No missing entry on the observed boot path.

### Resy.apk

Boot: frame drawn; diagnostics: ok; missing: 0; errors: 8.

No missing entry on the observed boot path.

### Subway Surfers.apk

Boot: frame drawn; diagnostics: ok; missing: 0; errors: 0.

No missing entry on the observed boot path.

### TikTok.apk

Boot: frame drawn; diagnostics: ok; missing: 9; errors: 122.

Observed missing entries:

- `class com/ss/android/ugc/aweme/im/sticker/ai/IMStickerAiImpl`
- `class com/lynx/service/devtool/LynxDevToolService`
- `class com/lynx/service/devtool/LynxInternalDevToolService`
- `class com/bytedance/tpsw/bpea/line/LineService`
- `class com/bytedance/tpsw/bpea/kakao/KakaoServiceImpl`
- `class com/ss/android/ugc/aweme/music/fanspotlight/detailpage/FanSpotlightPanelConfiguration`
- `class com/miui/referrer/api/GetAppsReferrerClient`
- `class com/appsflyer/lvl/AppsFlyerLVL$resultListener`
- `class com/appsflyer/lvl/AppsFlyerLVL`

### Twitch.xapk

Boot: frame drawn; diagnostics: ok; missing: 1; errors: 9.

Observed missing entries:

- `class com/miui/referrer/api/GetAppsReferrerClient`

### WebdroidFuzzProbe.apk

Boot: frame drawn; diagnostics: ok; missing: 0; errors: 1.

No missing entry on the observed boot path.

### YouTube.xapk

Boot: frame drawn; diagnostics: ok; missing: 7; errors: 7.

Observed missing entries:

- `class androidx/window/sidecar/SidecarDeviceState`
- `field androidx/window/sidecar/SidecarDeviceState.posture`
- `class androidx/window/sidecar/SidecarWindowLayoutInfo`
- `field androidx/window/sidecar/SidecarWindowLayoutInfo.displayFeatures`
- `class androidx/window/sidecar/SidecarProvider`
- `class androidx/window/extensions/WindowExtensionsProvider`
- `systemService media_metrics`

### app.organicmaps_26082718.apk

Boot: frame drawn; diagnostics: ok; missing: 3; errors: 6.

Observed missing entries:

- `android/content/Intent.parseIntent(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;)Landroid/content/Intent; is not a function`
- `android/app/Activity.getSplashScreen()Landroid/window/SplashScreen; is not a function`
- `app/organicmaps/sdk/util/Config.nativeGetBoolean(Ljava/lang/String;Z)Z [native]`

### calculatorm.apk

Boot: frame drawn; diagnostics: ok; missing: 0; errors: 0.

No missing entry on the observed boot path.

### com.beemdevelopment.aegis_82.apk

Boot: no frame; diagnostics: unavailable; missing: 0; errors: 1.

No missing entry on the observed boot path.

Failure: Error: waitForTimeout: Page crashed

### com.kunzisoft.keepass.libre_45400.apk

Boot: frame drawn; diagnostics: ok; missing: 2; errors: 2.

Observed missing entries:

- `class android/inputmethodservice/InputMethodService`
- `android/view/View.addOnUnhandledKeyEventListener(Landroid/view/View$OnUnhandledKeyEventListener;)V is not a function`

### com.nononsenseapps.feeder_4113.apk

Boot: frame drawn; diagnostics: ok; missing: 3; errors: 2.

Observed missing entries:

- `class androidx/window/sidecar/SidecarProvider`
- `class androidx/window/extensions/WindowExtensionsProvider`
- `java/text/Bidi.<init>(Ljava/lang/String;I)V (direct)`

### de.danoeh.antennapod_3120295.apk

Boot: frame drawn; diagnostics: ok; missing: 1; errors: 8.

Observed missing entries:

- `org/conscrypt/NativeCrypto.clinit()V [native]`

### de.dennisguse.opentracks_6751.apk

Boot: frame drawn; diagnostics: ok; missing: 1; errors: 4.

Observed missing entries:

- `java/lang/String.join(Ljava/lang/CharSequence;Ljava/lang/Iterable;)Ljava/lang/String; is not a function`

### flappybird.apk

Boot: frame drawn; diagnostics: ok; missing: 0; errors: 0.

No missing entry on the observed boot path.

### harmonic.apk

Boot: frame drawn; diagnostics: ok; missing: 1; errors: 0.

Observed missing entries:

- `class androidx/window/extensions/WindowExtensionsProvider`

### lichess.apk

Boot: frame drawn; diagnostics: ok; missing: 1; errors: 3.

Observed missing entries:

- `class androidx/window/sidecar/SidecarProvider`

### mihon-v0.20.4.apk

Boot: frame drawn; diagnostics: ok; missing: 0; errors: 2.

No missing entry on the observed boot path.

### net.gsantner.markor_163.apk

Boot: frame drawn; diagnostics: ok; missing: 2; errors: 6.

Observed missing entries:

- `vcall other/writeily/widget/WrMarkorWidgetProvider.onReceive(Landroid/content/Context;Landroid/content/Intent;)V`
- `vcall net/gsantner/markor/widget/TodoWidgetProvider.onReceive(Landroid/content/Context;Landroid/content/Intent;)V`

### net.thunderbird.android_31.apk

Boot: no frame; diagnostics: ok; missing: 1; errors: 4.

Observed missing entries:

- `android/content/Context.openOrCreateDatabase(Ljava/lang/String;ILandroid/database/sqlite/SQLiteDatabase$CursorFactory;)Landroid/database/sqlite/SQLiteDatabase; is not a function`

Failure: error: [uncaught] java/lang/NoSuchMethodError android/content/Context.openOrCreateDatabase(Ljava/lang/String;ILandroid/database/sqlite/SQLiteDatabase$CursorFactory;)Landroid/database/sqlite/SQLiteDatabase; is not a function
  at com/fsck/k9/preferences/K9StoragePersister.openDB()Landroid/database/sqlite/SQLiteDatabase;
  at com/fsck/k9/preferences/K9StoragePersister.loadValues()Lnet/thunderbird/core/preference/storage/InMemoryStorage;
  at net/thunderbird/core/preference/privacy/DefaultPrivacySettingsPreferenceManager.loadConfig()Lnet/thunderbird/core/preference/privacy/PrivacySettings;
  at net/thunderbird/core/preference/privacy/DefaultPrivacySettingsPreferenceManager.<init>(Lnet/thunderbird/core/logging/Logger;Lcom/fsck/k9/preferences/K9StoragePersister;Lcom/fsck/k9/preferences/K9StorageEditor;Lnet/thunderbird/core/preference/PreferenceChangeBroker;)V
  at com/fsck/k9/ui/KoinModuleKt$$ExternalSyntheticLambda1.invoke(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;
  at org/koin/core/instance/InstanceFactory.create(Lcom/fsck/k9/mailstore/LocalStore$7;)Ljava/lang/Object;
  at org/koin/core/instance/SingleInstanceFactory.create(Lcom/fsck/k9/mailstore/LocalStore$7;)Ljava/lang/Object;
  at com/fsck/k9/ui/KoinModuleKt$$ExternalSyntheticLambda1.invoke(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;
  at org/koin/core/instance/InstanceFactory.create(Lcom/fsck/k9/mailstore/LocalStore$7;)Ljava/lang/Object;
  at org/koin/core/instance/SingleInstanceFactory.create(Lcom/fsck/k9/mailstore/LocalStore$7;)Ljava/lang/Object;
  at coil3/size/ViewSizeResolver$-CC.m(Ljava/lang/Class;Lorg/koin/core/scope/Scope;Lorg/koin/core/qualifier/Qualifier;Lorg/koin/core/parameter/ParametersHolder;)Ljava/lang/Object;
  at com/fsck/k9/K9$special$$inlined$inject$default$1.invoke()Ljava/lang/Object;
  at kotlin/SynchronizedLazyImpl.getValue()Ljava/lang/Object;
  at net/thunderbird/android/ThunderbirdApp.onCreate$net$thunderbird$app$common$BaseApplication()V
  at net/thunderbird/android/ThunderbirdApp.onCreate()V Error
    at <instance_members_initializer> (http://localhost:4197/chunk-c410awqz.js:60846:13)
    at new JThrowable (http://localhost:4197/chunk-c410awqz.js:60842:16)
    at new c (http://localhost:4197/chunk-c410awqz.js:59795:13)
    at rt.mkThrowable (http://localhost:4197/chunk-c410awqz.js:60961:15)
    at Runtime.jx (http://localhost:4197/chunk-c410awqz.js:3900:21)
    at runCold (http://localhost:4197/chunk-c410awqz.js:1396:21)
    at JObj.invoke [as m$openDB$yu6ykn] (http://localhost:4197/chunk-c410awqz.js:2385:14)
    at Object.eval [as run] (eval at coldOp (http://localhost:4197/chunk-c410awqz.js:1309:17), <anonymous>:3:67)
    at Generator.next (<anonymous>)
    at runCold (http://localhost:4197/chunk-c410awqz.js:1363:31)

### org.fossify.calendar_20.apk

Boot: frame drawn; diagnostics: ok; missing: 1; errors: 2.

Observed missing entries:

- `class android/provider/BlockedNumberContract$BlockedNumbers`

### org.fossify.filemanager_13.apk

Boot: frame drawn; diagnostics: ok; missing: 3; errors: 2.

Observed missing entries:

- `class android/hardware/fingerprint/FingerprintManager`
- `systemService FingerprintManager`
- `java/text/SimpleDateFormat.toLocalizedPattern()Ljava/lang/String; is not a function`

### org.fossify.gallery_28.apk

Boot: frame drawn; diagnostics: ok; missing: 5; errors: 6.

Observed missing entries:

- `class android/hardware/fingerprint/FingerprintManager`
- `systemService FingerprintManager`
- `java/text/SimpleDateFormat.toLocalizedPattern()Ljava/lang/String; is not a function`
- `android/provider/MediaStore.canManageMedia(Landroid/content/Context;)Z is not a function`
- `android/content/ContentResolver.query(Landroid/net/Uri;[Ljava/lang/String;Landroid/os/Bundle;Landroid/os/CancellationSignal;)Landroid/database/Cursor; is not a function`

### org.schabi.newpipe_1015.apk

Boot: frame drawn; diagnostics: ok; missing: 2; errors: 6.

Observed missing entries:

- `java/util/ResourceBundle.getBundle(Ljava/lang/String;Ljava/util/Locale;)Ljava/util/ResourceBundle; is not a function`
- `class android/widget/RadioGroup$OnCheckedChangeListener`

## Follow-up evidence

- `4212f745` removed a conflicting caption style registration; YouTube lost five false missing field reports in the targeted rerun.
- `29abba76` added the process start-request uptime accessor; a targeted Reddit fast run no longer reported it.
- `40e3e82e` gave `IdentityHashMap` reference semantics. Amazon then drew its sign-in screen instead of exhausting V8 memory; skipping sign-in reached the shopping shell after startup work settled. Network-dependent shopping content remains unverified.
- `4c23392c` registered platform callback types. Google Maps then reported four startup gaps instead of six.
- `f18595c0` implemented localized date pattern access and `String.join(CharSequence, Iterable)`. A targeted OpenTracks boot then reported zero missing entries; Fossify apps advanced and exposed new downstream gaps.
- `364af4f8` registered the fingerprint service and reports no hardware on this browser device. A targeted Fossify rerun removed both fingerprint entries in each app. Remaining observed gaps include the modern `ContentResolver.query` overload in both.
- A targeted Thunderbird rerun after `Context.openOrCreateDatabase` was routed to the existing package SQLite path drew a frame, with `javax/xml/parsers/DocumentBuilderFactory` as the next missing class. Smoke compilation had zero method failures.
- The resolver now accepts the modern query Bundle overload with SQL selection, selection arguments, sort columns, direction and limit. The two Fossify apps then advanced past that call. USB enumeration reports an empty device map on this browser device; `MediaStore.canManageMedia` reports no special grant. A later targeted boot observed no missing entries or process errors in Gallery. File Manager's observed missing set reached zero after its StaticLayout constructor used the shared layout engine; its separate background-thread and image-load errors remain.
- A property-less ValueAnimator no longer tries to read an undefined getter name. File Manager's animator TypeError disappeared in a targeted rerun. Unsupported query Bundle keys remain explicit missing capabilities.
- A V8 profile of Aegis's initial out-of-memory crash showed repeated `AutoCompleteTextView` constructor and AppCompat tint-wrapper frames. Its three-argument native constructor used virtual dispatch to call a two-argument constructor, which re-entered an app subclass. Direct construction through the shared TextView helper let Aegis draw. Dropdown anchor/background getters and setters then advanced startup; its latest isolated boot has zero process errors and only `systemService statusbar` reported for Quick Settings tile listening. The StatusBar service and tile UI remain unsupported.

## Functional limits beyond missing entries

- The 13-flow fast run before the new packages reached 11/13 selected checkpoints. Lichess intermittently times out on launch and logs Dart pthread errors 35, 3 and 22; ChatGPT settings navigation timed out. A later Lichess fast run reached checkpoints while still logging pthread errors, so the pass is not a resolution.
- Cut the Rope intro video, TikTok dense-clip playback, YouTube drawing, Among Us online services, Subway Surfers background initialization, and authenticated or later screens listed in `PLAN.md` remain open.
- Further navigation and fresh diagnostics are needed for every app, including rows with zero missing boot entries.
