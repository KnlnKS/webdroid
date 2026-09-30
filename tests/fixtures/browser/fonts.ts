import { fetchSystemFonts, loadSystemFontMap, mountSystemFonts, registerSystemFonts } from "../../../src/android/fonts";
import { mountPlatformData } from "../../../src/shell/apex";
import { preloadPaint } from "../../../src/android/paint";
import { initDeviceLocales } from "../../../src/android/resnative";

/** the page's system fonts, the font map the zygote preloads (whose locale scripts are ICU's) and its text paints */
export async function systemFonts(): Promise<void> {
  mountPlatformData();
  const bytes = await fetchSystemFonts();
  mountSystemFonts(bytes);
  await registerSystemFonts(bytes);
  await loadSystemFontMap();
  await initDeviceLocales();
  await preloadPaint();
}
