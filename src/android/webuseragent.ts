// The WebView provider's version and user agent. Its pages render in the host's Blink, so the
// provider is the host's Chromium: a site's UA feature detection then describes the engine running
// it, as the host's client hints do. WebView keeps the full version (no UA reduction); the host's
// reduced UA gives the major until its client hints answer, and the first reader fixes it. A host
// that is not Chromium has none to give: 120.0.0.0.
import { propertyValue } from "../shell/properties.ts";
import { webViewBrands, type ClientHints } from "../shell/webpage/clienthints.ts";

let webViewVersion = /Chrome\/([\d.]+)/.exec(globalThis.navigator?.userAgent ?? "")?.[1] ?? "120.0.0.0", versionRead = false;
type HostHints = { getHighEntropyValues(hints: string[]): Promise<{ fullVersionList?: { brand: string; version: string }[] }> };
void (globalThis.navigator as { userAgentData?: HostHints } | undefined)?.userAgentData?.getHighEntropyValues(["fullVersionList"]).then((values) => {
  const chromium = values.fullVersionList?.find((b) => b.brand === "Chromium")?.version;
  if (chromium && !versionRead) webViewVersion = chromium;
}, () => {});
export const providerVersion = (): string => { versionRead = true; return webViewVersion; };
/** AwContentClient's user agent: GetAndroidOSInfo with the model and build ID, "; wv", and the
 *  product after Version/4.0 */
export function defaultUserAgent(): string {
  const model = propertyValue("ro.product.model") ?? "", build = propertyValue("ro.build.id") ?? "";
  const info = (model ? `; ${model}` : "") + (build ? `${model ? "" : ";"} Build/${build}` : "");
  return `Mozilla/5.0 (Linux; Android ${propertyValue("ro.build.version.release")}${info}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${providerVersion()} Mobile Safari/537.36`;
}
/** the user agent metadata AwContentClient reports with that user agent, from the same build */
export function clientHints(): ClientHints {
  const version = providerVersion(), release = (propertyValue("ro.build.version.release") ?? "").split(".");
  return { brands: webViewBrands(version, false), fullVersionList: webViewBrands(version, true), uaFullVersion: version,
    model: propertyValue("ro.product.model") ?? "", platformVersion: [0, 1, 2].map((i) => release[i] || "0").join("."),
    architecture: "", bitness: "", wow64: false, formFactors: ["Mobile"] };
}
