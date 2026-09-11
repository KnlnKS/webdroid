# Genuine Play Services SDK probes

Build with Java 17, Android SDK 35 and Gradle (`gradle :app:assembleDebug` from this
directory). Keep the APK under `app/build/outputs/apk/debug/`; the shared
`apks/GmsClient.apk` is a separate fixture. Install on a dedicated Android reference
with `adb install -r` to retain test state, or load the rebuilt APK into webdroid.

**Map probe** opens a lifecycle-managed Maps SDK view. Wait for `loaded`, press
Move, Animate, then Marker; tap the marker. `GmsClientMap` logs the SDK's actual
camera state, callbacks, projected marker position, screen/window origins and map size. The reference path reaches
zoom 10, then 11, one animation completion and one marker click; clicking opens the
"SDK marker" title. Initial minimum zoom and projection coordinates depend on screen
geometry. Android can launch it directly:

```sh
adb shell am start -n org.webdroid.gmsclient/.MapProbeActivity
adb logcat -s GmsClientMap:I '*:S'
```

For interruption/lifecycle coverage, press Animate twice within its 500 ms duration:
expect one cancellation and one completion. The intermediate/final zoom depends on
when the second action arrives. Press Move again to establish a fixed camera before
adding a marker. Drag the map, reset with Move, replace the marker and click it, then
go Back and reopen the probe; the new activity should load with fresh callback counts.
Check exceptions as well as callbacks: a partially handled gesture can still move the
map after another gesture listener fails.

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

**Window probe** isolates the geometry used by Maps and other embedded views. Run
Fullscreen, Edge, Normal, Hide, Legacy, Normal, Popup, then Dialog, dismissing overlays
with Back. `GmsClientWindow` logs screen/window origins, view/root sizes and root bar
insets. Dialog logs its initial content size and then a fixed 640x360 bottom window.
Detached views should return zero coordinates and no root insets; popup content starts
at its own window origin. Android can launch it directly:

```sh
adb shell am start -n org.webdroid.gmsclient/.WindowProbeActivity
adb logcat -s GmsClientWindow:I '*:S'
```
