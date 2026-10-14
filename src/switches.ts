// A/B switches for measured changes: page parameters, which process and compile Workers inherit
// (processes.ts workerUrl), so a `lat --query` or e2e run selects one side for every realm. A switch
// that wins its matched runs becomes the code's only path and leaves this table.
const query = typeof location === "undefined" ? null : new URLSearchParams(location.search);

/** the value `name` was given, or `fallback` */
export const switchValue = <T extends string>(name: string, fallback: T): T | string => query?.get(name) ?? fallback;
/** whether `name` is on: `?name=0` turns a default-on switch off, `?name=1` a default-off one on */
export const switchOn = (name: string, fallback: boolean): boolean => {
  const v = query?.get(name);
  return v === null || v === undefined ? fallback : v !== "0" && v !== "false" && v !== "off";
};
