# Genuine Play Services SDK probes

Build with Java 17, Android SDK 35 and Gradle (`gradle :app:assembleDebug` from this
directory). Keep the APK under `app/build/outputs/apk/debug/`; the shared
`apks/GmsClient.apk` is a separate fixture. Install on a dedicated Android reference
with `adb install -r` to retain test state, or load the rebuilt APK into webdroid.

**Map probe** opens a lifecycle-managed Maps SDK view. Wait for `loaded`, press
Move, Animate, then Marker; tap the marker. `GmsClientMap` logs the SDK's actual
camera state, callbacks and projected marker position. The reference path reaches
zoom 10, then 11, one animation completion and one marker click; clicking opens the
"SDK marker" title. Initial minimum zoom and projection coordinates depend on screen
geometry. Android can launch it directly:

```sh
adb shell am start -n org.webdroid.gmsclient/.MapProbeActivity
adb logcat -s GmsClientMap:I '*:S'
```

**Bitmap probe** logs 33 resource/decoder observations under `GmsClientBitmap`.
Its 8x6 PNGs cover mdpi, nodpi, default density and a resource alias. Compare with
Android at the same density, including returned dimensions/density/mutability and
Options output fields. On a 480-dpi reference, default mdpi output is 24x18@480;
nodpi stays 8x6@480. Sample size 2 reports 4x3 bounds before density scaling, while
bounds-only mode reports 8x6 and returns null. It can run directly on Android:

```sh
adb shell am start -S -n org.webdroid.gmsclient/.ClientActivity --ez bitmap_probe true
adb logcat -s GmsClientBitmap:I '*:S'
```

These are bounded integration probes, not complete Maps or BitmapFactory parity.
Keep authentication, Firebase configuration and token material outside the repository.
