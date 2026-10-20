// The Chrome every harness drives and the dev server it opens.
import { chromium } from "playwright";

export const BASE_URL = process.env.WEBDROID_URL ?? "http://localhost:4080";
export function webdroidUrl(): URL {
  const url = new URL(BASE_URL);
  if (process.env.WEBDROID_BYTECODE) url.searchParams.set("bytecode", process.env.WEBDROID_BYTECODE);
  return url;
}

// WEBDROID_SITE_ISOLATION=0 keeps Playwright's default, which shares a WebView page's renderer with
// the app as Safari and Chrome on Android do
const ISOLATED = process.env.WEBDROID_SITE_ISOLATION !== "0";
/** what every harness's Chrome runs with, `jsFlags` added to WEBDROID_JS_FLAGS */
export function chromeArgs(jsFlags?: string): string[] {
  const js = [process.env.WEBDROID_JS_FLAGS, jsFlags].filter(Boolean).join(" ");
  return [...(ISOLATED ? ["--site-per-process"] : []), "--force-device-scale-factor=1", "--hide-scrollbars", ...(js ? [`--js-flags=${js}`] : [])];
}
export const CONTEXT_OPTS = {
  viewport: { width: 1400, height: 1500 },
  deviceScaleFactor: 1,
  locale: "en-US",
  timezoneId: "UTC",
  colorScheme: "light" as const,
  reducedMotion: "reduce" as const,
  geolocation: { latitude: 37.422, longitude: -122.084, accuracy: 20 },
  permissions: ["geolocation"],
};
/** Chrome's GL on the CPU, SwiftShader behind ANGLE */
export const SOFTWARE_GL = ["--use-gl=angle", "--use-angle=swiftshader"];
/** headless Chrome on software GL, rendering as the e2e goldens were recorded */
export const launchOptions = (jsFlags?: string) => ({
  headless: true,
  args: [...chromeArgs(jsFlags), "--font-render-hinting=none", "--disable-lcd-text",
    ...SOFTWARE_GL, "--disable-partial-raster", "--disable-skia-runtime-opts"],
  ignoreDefaultArgs: ISOLATED ? ["--disable-features=IsolateOrigins,site-per-process"] : [],
});
export const launchBrowser = (jsFlags?: string) => chromium.launch(launchOptions(jsFlags));
