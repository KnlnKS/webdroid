// installd's app data, with the preferences an older build kept outside it.

import { vfs } from "../shell/vfs.ts";
import { storedKeys, storedPackages, storedText, storeText } from "../shell/device-storage.ts";
import type { PackageState } from "../shell/packagedata.ts";

const LEGACY = "wd:prefs:";
const escapeXml = (s: string) => s.replace(/[&<>"]/g, (c) => `&${({ "&": "amp", "<": "lt", ">": "gt", '"': "quot" } as Record<string, string>)[c]};`);
/** an older build's preference file, JSON with a long as {$l} and a string set as an array (or
 *  {$s}), in XmlUtils.writeMapXml's form. A whole number becomes an int: the JSON kept no type. */
function legacyXml(text: string): Uint8Array | null {
  let saved: unknown;
  try { saved = JSON.parse(text); } catch { return null; }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
  const entries: string[] = [];
  for (const [key, value] of Object.entries(saved)) {
    const name = escapeXml(key);
    if (value === null) entries.push(`<null name="${name}" />`);
    else if (typeof value === "string") entries.push(`<string name="${name}">${escapeXml(value)}</string>`);
    else if (typeof value === "boolean") entries.push(`<boolean name="${name}" value="${value}" />`);
    else if (typeof value === "number") entries.push(`<${Number.isInteger(value) ? "int" : "float"} name="${name}" value="${value}" />`);
    else if ("$l" in value && typeof value.$l === "string" && /^-?\d+$/.test(value.$l)) entries.push(`<long name="${name}" value="${value.$l}" />`);
    else {
      const strings: unknown = "$s" in value ? value.$s : value;
      if (Array.isArray(strings) && strings.every((s) => typeof s === "string")) entries.push(`<set name="${name}">${strings.map((s) => `<string>${escapeXml(s)}</string>`).join("")}</set>`);
    }
  }
  return new TextEncoder().encode(`<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n${entries.join("\n")}\n</map>\n`);
}
/** installd's createAppData: the data directory and its cache directories, which apps stat before
 *  ContextImpl ever creates them. The preference files an older build kept in localStorage become
 *  the shared_prefs files SharedPreferencesImpl reads, once; its platform files (__system_*) go. */
export async function createAppData(pkg: string): Promise<void> {
  for (const root of ["/data/data/", "/data/user_de/0/"]) for (const dir of ["", "/cache", "/code_cache"]) vfs.mkdir(`${root}${pkg}${dir}`);
  const legacy = storedKeys(`${LEGACY}${pkg}:`);
  if (!legacy.length) return;
  for (const key of legacy) {
    const file = key.slice(LEGACY.length + pkg.length + 1), path = `/data/data/${pkg}/shared_prefs/${file}.xml`;
    const xml = file.startsWith("__system_") || vfs.stat(path) ? null : legacyXml(storedText(key) ?? "");
    if (xml) vfs.write(path, xml);
  }
  await vfs.flush();
  for (const key of legacy) storeText(key, null);
}
/** an older build's notification policy for a package, a file of the platform's package android */
const LEGACY_POLICY = LEGACY + "android:notification-policy:";
/** the preference files an older build kept, and its notification policy, which go with the package's data */
export const legacyPreferenceData: PackageState = {
  clear(pkg) { for (const key of [...storedKeys(`${LEGACY}${pkg}:`), LEGACY_POLICY + pkg]) storeText(key, null); },
  packages: () => [...storedPackages(LEGACY).filter((pkg) => pkg !== "android"), ...storedPackages(LEGACY_POLICY)],
};
