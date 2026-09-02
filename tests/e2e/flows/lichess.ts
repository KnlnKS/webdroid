// lichess (Flutter): the whole UI is a Dart AOT snapshot run by an arm64 engine the JVM
// cannot execute, so this is an HONEST-BOOT target — the launch theme's windowBackground
// paints, System.loadLibrary("flutter") surfaces as UnsatisfiedLinkError, nothing wedges.
// Expected nativeRequired: libflutter.so (arm64-v8a). No framework API may be in newMissing.
import type { Flow } from "../types";

export const lichess: Flow = {
  app: "lichess",
  pkg: "org.lichess.mobileV2",
  activity: "org.lichess.mobileV2.MainActivity",
  apk: "lichess.apk",
  // Flutter's launch theme is full-window: no status bar strip to crop
  crop: { top: 0, bottom: 48, left: 0, right: 0 },
  steps: [
    { id: "launch", label: "Launch — launch theme splash", action: { type: "launch" }, settleDelayMs: 4000 },
    { id: "splash", label: "Splash settled (engine load fails honestly)", action: { type: "settle" } },
    { id: "back", label: "Back", action: { type: "back" } },
  ],
};
