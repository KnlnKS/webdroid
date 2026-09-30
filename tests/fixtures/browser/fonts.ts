import { fetchSystemFonts, loadSystemFontMap, mountSystemFonts, registerSystemFonts } from "../../../src/android/fonts";
import { mountPlatformData } from "../../../src/shell/apex";

/** the page's system fonts and the font map the zygote preloads (whose locale scripts are ICU's) */
export async function systemFonts(): Promise<void> {
  mountPlatformData();
  const bytes = await fetchSystemFonts();
  mountSystemFonts(bytes);
  await registerSystemFonts(bytes);
  await loadSystemFontMap();
}
