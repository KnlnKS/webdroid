// A split install (.xapk, .apks, an App Bundle's output) is a zip of apks rather than an apk.
// Shared by the shell, the dev server's /asset route and the bun scripts, so an xapk is an apk
// everywhere or nowhere.

import { parseAXML, attrStr } from "../android/axml";
import { zipTree } from "../jvm/natives/jzip";

/** A split install (.xapk, .apks, an App Bundle's output) is a zip of apks rather than an
 *  apk: a base and its config/feature splits. Merge them into the one tree the rest of the
 *  boot expects — the base wins every conflict, exactly as the base's dex is first on a
 *  device's class path, and each split's dex keeps a distinct name so both survive. */
export interface Install {
  zip: Record<string, Uint8Array>;
  /** the base apk's own bytes: what sourceDir names and what ZipFile(sourceDir) must open */
  base: Uint8Array;
  splits: { name: string; bytes: Uint8Array }[];
}
export function openInstall(bytes: Uint8Array): Install {
  const outer = zipTree(bytes);
  if (outer["AndroidManifest.xml"]) return { zip: outer, base: bytes, splits: [] };
  const apks = Object.keys(outer).filter((n) => n.endsWith(".apk"));
  if (!apks.length) throw new Error("no AndroidManifest.xml and no apks inside: not an apk or a split install");
  const opened = apks.map((n) => outer[n]).map((b) => {
    const z = zipTree(b);
    const m = z["AndroidManifest.xml"];
    return { bytes: b, zip: z, split: m ? attrStr(parseAXML(m), "split") : null, hasManifest: !!m };
  });
  const base = opened.find((o) => o.hasManifest && !o.split);
  if (!base) throw new Error(`split install has no base apk among ${apks.join(", ")}`);
  const merged = base.zip;
  const splits: Install["splits"] = [];
  let extra = 0;
  for (const o of opened) {
    if (o === base) continue;
    zipTree(o.bytes, merged, (path) =>
      path === "AndroidManifest.xml" || path === "resources.arsc" || path.startsWith("META-INF/") ? null
        // a split's own classes.dex would collide with the base's, and both have to load
        : /^classes\d*\.dex$/.test(path) ? `classes${1000 + extra++}.dex` : path);
    // a split with no manifest is not one Android would have installed, but it is in the file
    // and its entries are already merged; name it after nothing rather than invent one
    if (o.split) splits.push({ name: o.split, bytes: o.bytes });
    console.log("[webdroid] split", o.split ?? "(unnamed)", Object.keys(o.zip).length, "entries");
  }
  return { zip: merged, base: base.bytes, splits };
}
