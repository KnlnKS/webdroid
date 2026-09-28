// The android: resource package, fetched once per page and read lazily: only resources.arsc is
// inflated up front, every other entry (a layout, a nine-patch, a state list) on the first read
// of that path.
//
// It is vendor/aosp/framework-res.apk, the table the platform's own R classes were compiled
// against (`bun run gen-framework` checks the pairing). android.R and com.android.internal.R
// come from framework.jar.

import { Arsc } from "./arsc";
import { DEVICE_COLORS } from "./device-colors";

const TYPE_INT_COLOR_ARGB8 = 0x1c;
import { centralDir, entryBytes } from "../jvm/natives/jzip";
import { rt } from "../jvm/runtime";
import { dexesIn, type DexFile } from "../jvm/dex";
import { Resources, setFramework } from "./res";
import { PLATFORM_JARS } from "../jvm/provenance";
import { BOOT_JAR_PATHS } from "../jvm/bootclasspath";
import { vfs } from "../shell/vfs";
import { BytesFile } from "../shell/lazyfile";
import { zygoteInit } from "./delegates";
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

/** the `i`th boot class path jar: at its device path, with its classes indexed behind the app's
 *  and its other entries served as boot resources (libcore reads calendars.properties and its
 *  Hijrah data from core-oj.jar) */
export function loadPlatformJar(bytes: Uint8Array, i: number): void {
  const jar = BOOT_JAR_PATHS[i];
  vfs.mount(jar, new BytesFile(bytes));
  for (const d of jarDexes(bytes, PLATFORM_JARS[i])) rt.loadDex(d, true);
  for (const [name, entry] of centralDir(bytes)) {
    if (!name.endsWith("/") && !/^classes\d*\.dex$/.test(name) && !rt.bootResources.has(name)) rt.bootResources.set(name, { jar, read: () => entryBytes(bytes, entry) });
  }
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
  return pendingDex ??= fetchPlatformJars().then(async (bytes) => {
    bytes.forEach(loadPlatformJar);
    await zygoteInit();
  });
}

export function loadFramework(): Promise<Arsc> {
  return pending ??= (async () => {
    const res = await fetch("/vendor/aosp/framework-res.apk");
    if (!res.ok) throw new Error(`no framework package (${res.status}) — run: bun run gen-framework`);
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

    // the reference device's overlays (SystemUI's Monet palette) replace these defaults
    const colors = arsc.names("color");
    for (const [name, argb] of Object.entries(DEVICE_COLORS)) {
      const id = colors.get(name);
      if (id !== undefined) arsc.overlay(id, { type: TYPE_INT_COLOR_ARGB8, data: argb | 0 });
    }
    setFramework(arsc);
    return arsc;
  })();
}
