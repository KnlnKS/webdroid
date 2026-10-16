import { androidIds } from "./identity-data.ts";

const secondaryIds = new Set(["system", "radio", "log", "nfc", "bluetooth", "shell", "secure_element", "network_stack"].map((name) => androidIds[name]!));
const namedId = (name: string) => Object.hasOwn(androidIds, name) ? androidIds[name]! : -1;

// Android 15 bionic/libc/bionic/grp_pwd.cpp app_id_from_name and group_ranges.
export function androidGroupId(name: string): number {
  if (/^[0-9]+(?![\s\S])/.test(name)) {
    const value = BigInt(name), max = 0x7fffffffffffffffn;
    return Number(BigInt.asIntN(32, value > max ? max : value));
  }
  const id = namedId(name);
  if (id !== -1) return id;
  const oem = /^oem_[ \t\r\n\v\f]*([+-]?[0-9]+)/.exec(name);
  if (oem) {
    const value = Number(oem[1]) >>> 0;
    return value >= 2900 && value <= 2999 || value >= 5000 && value <= 5999 ? value : -1;
  }
  const match = /^(u([0-9]+)|all)_(.+)(?![\s\S])/.exec(name);
  if (!match) return -1;
  const user = Number(match[2] ?? 0), shared = match[1] === "all", tail = match[3]!;
  if (user > 1000) return -1;
  let app = -1;
  const appName = /^a([0-9]+)(?:_(cache|ext|ext_cache))?$/.exec(tail);
  if (appName) {
    if (shared && (appName[2] || Number(appName[1]) > 9999)) return -1;
    const base = shared ? 50000 : appName[2] === "cache" ? 20000 : appName[2] === "ext" ? 30000 : appName[2] === "ext_cache" ? 40000 : 10000;
    app = Number(appName[1]) + base;
  } else if (/^i[0-9]+$/.test(tail)) app = Number(tail.slice(1)) + 90000;
  else {
    app = namedId(tail);
    if (!secondaryIds.has(app)) return -1;
  }
  if (app < 0 || app >= 100000 || app >= 50000 && app <= 59999 && user !== 0) return -1;
  const valid = app < 10000 ? secondaryIds.has(app) : app <= 59999 || app >= 90000;
  const result = user * 100000 + app;
  return valid && result >= 10000 ? result : -1;
}
