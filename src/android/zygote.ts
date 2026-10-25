// The zygote's Java, which needs no app: a page runs it in every process while the app downloads, and aot-startup runs it to record the modules a start loads.
import { rt, type Gen } from "../jvm/runtime.ts";
import { callOn, initClass, mainThread, scall } from "../jvm/natives/jentry.ts";
import { asZygote } from "./os.ts";
import { preloadFonts } from "./fonts.ts";
import { initDeviceLocales } from "./configuration.ts";
import { preloadPaint } from "./paint.ts";
import { startMainLooper } from "./mainloop.ts";

/** What the zygote sets up in a forked process before app code runs: libcore's MIME table is
 *  framework.jar's, System.out and System.err reach logcat, RuntimeInit.commonInit's uncaught
 *  exception handlers (LoggingHandler, KillApplicationHandler), time zone, logging, HTTP user
 *  agent and socket tagger are set, the JCA providers are installed and warmed, Typeface is
 *  initialized and the hyphenators registered; the device's languages are set and the text paint
 *  classes, whose constructors read them, initialized. The font map is bindApplication's. */
export async function zygoteInit(): Promise<void> {
  await callOn(mainThread, () => rt.drive(function* (): Gen<void> {
    // System.<clinit> reads user.name from the passwd entry of the zygote, which runs as root
    yield asZygote(() => initClass("java/lang/System"));
    // ZygoteInit.main: DDMS handlers and libcore's MimeMap over framework.jar's mime.types
    yield scall("com/android/internal/os/RuntimeInit", "preForkInit", "()V");
    yield scall("com/android/internal/os/RuntimeInit", "redirectLogStreams", "()V");
    // ZygoteInit.zygoteInit, in the forked process
    yield scall("com/android/internal/os/RuntimeInit", "commonInit", "()V");
    // ZygoteInit.preload: AndroidKeyStoreProvider installed, every provider's services resolved
    yield scall("com/android/internal/os/ZygoteInit", "warmUpJcaProviders", "()V");
    yield* preloadFonts();
    yield scall("com/android/internal/os/ZygoteInit", "preloadTextResources", "()V");
    yield initDeviceLocales();
    yield preloadPaint();
    // ActivityThread.main, once the process is forked
    yield startMainLooper();
  }()));
}
