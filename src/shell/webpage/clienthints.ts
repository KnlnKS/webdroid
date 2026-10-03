/** Android WebView's User-Agent Client Hints brands at Chromium `version`, as Chromium's
 *  GenerateBrandVersionList orders them: the GREASE brand and the order follow the major version */
export function webViewBrands(version: string, full: boolean): { brand: string; version: string }[] {
  const major = Number.parseInt(version) || 0, chars = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
  const greased = ["8", "99", "24"][major % 3], own = full ? version : String(major);
  const order = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]][major % 6], list: { brand: string; version: string }[] = [];
  list[order[0]] = { brand: "Not" + chars[major % 11] + "A" + chars[(major + 1) % 11] + "Brand", version: full ? greased + ".0.0.0" : greased };
  list[order[1]] = { brand: "Chromium", version: own };
  list[order[2]] = { brand: "Android WebView", version: own };
  return list;
}

/** the user agent metadata the WebView provider reports: getHighEntropyValues' hints */
export type ClientHints = { brands: { brand: string; version: string }[]; fullVersionList: { brand: string; version: string }[];
  uaFullVersion: string; model: string; platformVersion: string; architecture: string; bitness: string; wow64: boolean; formFactors: string[] };

/** NavigatorUAData over the provider's metadata, in the page */
export function installClientHints(hints: ClientHints): void {
  const low = () => ({ brands: hints.brands.map((b) => ({ ...b })), mobile: true, platform: "Android" });
  const high = ["architecture", "bitness", "formFactors", "fullVersionList", "model", "platformVersion", "uaFullVersion", "wow64"] as const;
  const data = {
    get brands() { return low().brands; },
    mobile: true,
    platform: "Android",
    getHighEntropyValues(asked: Iterable<string>) {
      const values: Record<string, unknown> = low(), wanted = [...asked];
      for (const hint of high) if (wanted.includes(hint)) values[hint] = structuredClone(hints[hint]);
      return Promise.resolve(values);
    },
    toJSON: low,
  };
  Object.defineProperty(navigator, "userAgentData", { value: data, configurable: true, enumerable: true });
}
