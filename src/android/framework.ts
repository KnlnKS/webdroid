// The android: resource package, fetched once per page and read lazily: only resources.arsc is
// inflated up front, every other entry (a layout, a nine-patch, a state list) on the first read
// of that path.
//
// Which package depends on provenance. With nothing cut over to bytecode it is
// vendor/framework-res.apk, relinked from the SDK res tree by `bun run gen-framework-res`,
// which is enough because the hand-written framework asks for resources by name. The moment
// AOSP bytecode runs it has to be vendor/aosp/framework-res.apk, the table its R classes were
// compiled against: 3,582 of the 7,825 ids the framework's own R declares name a DIFFERENT
// resource in the relinked table, because public-final.xml pins the public ids and nothing
// pins the internal ones. See `bun run gen-framework`.

import { Arsc } from "./arsc";
import { centralDir, entryBytes } from "../jvm/natives/jzip";
import { rt, JObj } from "../jvm/runtime";
import { dexesIn, type DexFile } from "../jvm/dex";
import { mangleStaticField } from "../jvm/abi";
import { Resources, setFramework } from "./res";
import { needsFramework, PLATFORM_JARS } from "../jvm/provenance";
import { parseAXML } from "./axml";
import { PackageRecord, packages } from "./packages";
import { apkCertificates } from "./packagearchive";

let pending: Promise<Arsc> | null = null;
let pendingDex: Promise<void> | null = null;

/** a jar's classes*.dex, in load order */
export function jarDexes(jar: Uint8Array, label: string): DexFile[] {
  const dir = centralDir(jar);
  return [...dir.keys()].filter((n) => /^classes\d*\.dex$/.test(n)).sort().flatMap((name) => dexesIn(entryBytes(jar, dir.get(name)!), `${label}:${name}`));
}

let jars: Promise<Uint8Array[]> | null = null;
/** start fetching the platform jars, ahead of the app they are indexed behind */
export function fetchPlatformJars(): Promise<Uint8Array[]> {
  return jars ??= Promise.all(PLATFORM_JARS.map(async (jar) => {
    const res = await fetch(`/vendor/aosp/${jar}`);
    if (!res.ok) throw new Error(`no platform bytecode at ${jar} (${res.status}) — run: bun run gen-framework`);
    return new Uint8Array(await res.arrayBuffer());
  }));
}

/** Index every platform class after the app's own, which loadDex's first-wins keeps ahead.
 *  Indexing 40,860 classes costs ~20ms and compiling is lazy per class. */
export function loadPlatformDex(): Promise<void> {
  return pendingDex ??= fetchPlatformJars().then((bytes) => bytes.forEach((jar, i) => {
    for (const d of jarDexes(jar, PLATFORM_JARS[i])) rt.loadDex(d, true);
  }));
}

export function loadFramework(): Promise<Arsc> {
  return pending ??= (async () => {
    const path = needsFramework() ? "/vendor/aosp/framework-res.apk" : "/vendor/framework-res.apk";
    const res = await fetch(path);
    if (!res.ok) throw new Error(`no framework package at ${path} (${res.status}) — run: bun run ${needsFramework() ? "gen-framework" : "gen-framework-res"}`);
    const apk = new Uint8Array(await res.arrayBuffer());
    const dir = centralDir(apk);
    const inflated = new Map<string, Uint8Array | null>();
    const files = (path: string): Uint8Array | null => {
      let b = inflated.get(path);
      if (b === undefined) {
        const e = dir.get(path);
        inflated.set(path, b = e ? entryBytes(apk, e) : null);
      }
      return b;
    };
    const arsc = new Arsc(files("resources.arsc")!, files);
    const manifest = files("AndroidManifest.xml");
    if (manifest) {
      const signingZip: Record<string, Uint8Array> = {};
      for (const name of dir.keys()) if (/^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(name)) {
        const bytes = files(name);
        if (bytes) signingZip[name] = bytes;
      }
      let pendingCertificates: Promise<Uint8Array[]> | null = null;
      const platform = new PackageRecord(parseAXML(manifest), new Resources(arsc, {}, undefined, true),
        "/system/framework/framework-res.apk", 1000, () => pendingCertificates ??= (async () => {
          const certificates = await apkCertificates(apk, signingZip);
          if (certificates.length) return certificates;
          const response = await fetch("/vendor/platform.x509.pem");
          if (!response.ok) throw new Error("Platform certificate unavailable");
          const encoded = (await response.text()).replace(/-----[^-]+-----|\s/g, "");
          return [Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))];
        })());
      platform.system = true;
      packages.set(platform.pkg, platform);
    }

    // android.R.<type>.<name>. R.java spells a resource name as a java identifier, so the dots in
    // a style name are underscores there. Filled on first use: an app that never names one of
    // these types never pays for its table. Skipped entirely once the framework dex is loaded —
    // it carries the real android/R$* (22 classes, 5,624 fields) and a native registration would
    // shadow them with a table built from a different reading of the same arsc.
    for (const type of needsFramework() ? [] : arsc.allTypes()) {
      const ctor = class extends JObj {};
      rt.register({
        name: `android/R$${type}`, ctor,
        clinit: () => {
          for (const [name, id] of arsc.names(type)) (ctor as any)[mangleStaticField(name.replace(/\./g, "_"))] = id;
        },
      });
    }
    if (!needsFramework()) rt.register({ name: "android/R", ctor: class extends JObj {} });

    setFramework(arsc);
    return arsc;
  })();
}
