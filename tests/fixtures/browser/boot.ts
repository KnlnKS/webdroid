import { loadSystemFontMap } from "../../../src/android/fonts.ts";
import { mountPlatformData } from "../../../src/shell/apex.ts";
import { preloadPaint } from "../../../src/android/paint.ts";
import { initDeviceLocales } from "../../../src/android/resnative.ts";
import { loadPlatformDex } from "../../../src/android/framework.ts";
import { JObj, rt } from "../../../src/jvm/runtime.ts";
import { tierReady } from "../../../src/jvm/tier.ts";
import { startMainLooper } from "../../../src/android/mainloop.ts";
import { callOn, mainThread } from "../../../src/jvm/natives/jentry.ts";

/** the Wasm tier and the platform class path, as a page boots */
export async function bootPlatform(): Promise<void> {
  await tierReady();
  await loadPlatformDex();
  mountPlatformData();
}
/** the platform, then the font map the zygote preloads (whose locale scripts are ICU's) and its text paints, as a page boots */
export async function bootWithFonts(): Promise<void> {
  await bootPlatform();
  await startMainLooper();
  await callOn(mainThread, () => rt.drive(loadSystemFontMap()));
  await initDeviceLocales();
  await preloadPaint();
}

let listeners = 0;
/** an object of a host class that implements the interface `iface`, answering `name` with `fn` */
export const listener = (iface: string, name: string, desc: string, fn: (...a: any[]) => unknown): object => {
  const cls = "fixture/Listener" + listeners++;
  rt.register({ name: cls, ctor: class extends JObj {}, ifaces: [iface], methods: { [name + desc]: fn } });
  return rt.make(cls);
};
