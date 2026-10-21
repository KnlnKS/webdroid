// The page's parameters, read once: a harness's pins (?apk, ?screen, ?hz, ?testClock) and A/B switches for
// measured changes, which process and compile Workers inherit (process-host.ts workerUrl), so a `lat --query`
// or e2e run selects one side for every realm. A switch that wins its matched runs becomes the code's only path.
const query = typeof location === "undefined" ? null : new URLSearchParams(location.search);

/** whether `name` is on: `?name=0` turns a default-on switch off, `?name=1` a default-off one on */
export const switchOn = (name: string, fallback: boolean): boolean => {
  const v = query?.get(name);
  return v === null || v === undefined ? fallback : v !== "0" && v !== "false" && v !== "off";
};
/** the value of `name`, if the page gives one */
export const switchValue = (name: string): string | undefined => query?.get(name) ?? undefined;
/** every parameter, for a Worker's URL to carry on */
export const switches = (): URLSearchParams => new URLSearchParams(query ?? undefined);
