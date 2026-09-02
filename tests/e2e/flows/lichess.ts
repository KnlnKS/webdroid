// lichess (Flutter): the whole UI is a Dart AOT snapshot run by an arm64 engine the JVM
// cannot execute, so this is an HONEST-BOOT target — the launch theme's windowBackground
// paints (androidx Theme.SplashScreen over Theme.DeviceDefault.DayNight: #fafafa; the icon
// splash it describes is the system starting window, not modelled), System.loadLibrary
// ("flutter") surfaces as UnsatisfiedLinkError, Flutter's ensureInitializationComplete
// rethrows it as the one RuntimeException in newErrors, nothing wedges. The androidx.startup
// initializers (WorkManager: Room db under no_backup/, SystemJobService enabled; ProfileInstaller;
// EmojiCompat — "font provider not available", as on any device without one) and the lifecycle
// verbs after the failed onCreate (FlutterActivity's own "called after detach" early-outs, Back
// included) all complete; a second boot on the persisted state is identical.
// Expected nativeRequired: libflutter.so (arm64-v8a). No framework API may be in newMissing.
import type { Flow } from "../types";

export const lichess: Flow = {
  app: "lichess",
  pkg: "org.lichess.mobileV2",
  activity: "org.lichess.mobileV2.MainActivity",
  apk: "lichess.apk",
  // no goldens (smoke run): the status bar stays in the frame, only the nav strip is cropped
  crop: { top: 0, bottom: 48, left: 0, right: 0 },
  steps: [
    { id: "launch", label: "Launch — launch theme splash", action: { type: "launch" }, settleDelayMs: 4000 },
    { id: "splash", label: "Splash settled (engine load fails honestly)", action: { type: "settle" } },
    { id: "back", label: "Back", action: { type: "back" } },
  ],
};
