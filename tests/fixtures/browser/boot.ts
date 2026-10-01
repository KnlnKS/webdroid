import { fetchSystemFonts, loadSystemFontMap, mountSystemFonts, registerSystemFonts } from "../../../src/android/fonts";
import { mountPlatformData } from "../../../src/shell/apex";
import { preloadPaint } from "../../../src/android/paint";
import { initDeviceLocales } from "../../../src/android/resnative";
import { loadPlatformDex } from "../../../src/android/framework";
import { rt } from "../../../src/jvm/runtime";
import { startMainLooper } from "../../../src/android/mainloop";

/** framework.jar on the class path and the natives linked, then the page's system fonts, the font
 *  map the zygote preloads (whose locale scripts are ICU's) and its text paints, as a page boots */
export async function bootWithFonts(): Promise<void> {
  await loadPlatformDex();
  rt.linkNatives();
  await startMainLooper();
  mountPlatformData();
  const bytes = await fetchSystemFonts();
  mountSystemFonts(bytes);
  await registerSystemFonts(bytes);
  await loadSystemFontMap();
  await initDeviceLocales();
  await preloadPaint();
}
