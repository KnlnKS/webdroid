// The android: resource package, fetched once per page and read lazily: only resources.arsc is
// inflated up front, every other entry (a layout, a nine-patch, a state list) on the first read
// of that path.
//
// It is vendor/aosp/framework-res.apk, the table the platform's own R classes were compiled
// against (`pnpm gen-framework` checks the pairing). android.R and com.android.internal.R
// come from framework.jar.

import { Arsc } from "./arsc.ts";
import { DEVICE_OVERLAYS } from "./device-overlays.ts";
import { centralDir, entryBytes } from "../zip.ts";
import { rt } from "../jvm/runtime.ts";
import { dexesIn, dexEntryNames, isDexEntry, type DexFile } from "../jvm/dex.ts";
import { PLATFORM_JARS } from "../jvm/provenance.ts";
import { loadDex } from "../jvm/tier.ts";
import { BOOT_JAR_PATHS } from "../jvm/bootclasspath.ts";
import { vfs } from "../shell/vfs.ts";
import { BytesFile, type FileSource } from "../shell/lazyfile.ts";
import { parseAXML } from "./axml.ts";
import { registerPackage } from "./installpackage.ts";
import { apkCertificates } from "./packagearchive.ts";

let pending: Promise<Arsc> | null = null;
let mounted: Promise<void> | null = null;

/** a jar's classes*.dex, in load order */
export function jarDexes(jar: Uint8Array, label: string): DexFile[] {
  const dir = centralDir(jar);
  return dexEntryNames(dir.keys()).flatMap((name) => dexesIn(entryBytes(jar, dir.get(name)!), `${label}:${name}`));
}

/** the `i`th boot class path jar: at its device path, with its classes indexed behind the app's
 *  and its other entries served as boot resources (libcore reads calendars.properties and its
 *  Hijrah data from core-oj.jar) */
export function loadPlatformJar(bytes: Uint8Array, i: number): void {
  mountPlatformJar(bytes, i);
  for (const d of jarDexes(bytes, PLATFORM_JARS[i])) loadDex(d, true);
}
/** the jar's file and the resources the boot class loader reads from it, without its classes */
export function mountPlatformJar(bytes: Uint8Array, i: number): void {
  const jar = BOOT_JAR_PATHS[i];
  vfs.mount(jar, new BytesFile(bytes));
  for (const [name, entry] of centralDir(bytes)) {
    if (!name.endsWith("/") && !isDexEntry(name) && !rt.bootResources.has(name)) rt.bootResources.set(name, { jar, read: () => entryBytes(bytes, entry) });
  }
}

let blobs: Promise<Blob[]> | null = null, jars: Promise<Uint8Array[]> | null = null;
/** the page's copy, which a process Worker takes rather than fetching its own behind the page's other requests */
export function sendPlatformJars(port: MessagePort): void {
  void platformJarBlobs().then((list) => port.postMessage(list), () => port.postMessage(null)).finally(() => port.close());
}
export function receivePlatformJars(port: MessagePort): void {
  blobs = new Promise<Blob[] | null>((resolve) => { port.onmessage = ({ data }) => { port.close(); resolve(data); }; })
    .then((list) => list ?? (blobs = null, platformJarBlobs()));
}
export const platformJarUrl = (jar: string): string => `/vendor/aosp/${jar}`;
/** The platform jars as the browser holds them: a Blob crosses to another realm as a handle, where bytes are copied for each realm on the sender's thread
 *  (43 MB to each process Worker and compile worker). */
export function platformJarBlobs(): Promise<Blob[]> {
  return blobs ??= Promise.all(PLATFORM_JARS.map(async (jar) => {
    const res = await fetch(platformJarUrl(jar));
    if (!res.ok) throw new Error(`no platform bytecode at ${jar} (${res.status}) — run: pnpm gen-framework`);
    return res.blob();
  }));
}
/** start fetching the platform jars, ahead of the app they are indexed behind */
export function fetchPlatformJars(): Promise<Uint8Array[]> {
  return jars ??= platformJarBlobs().then((list) => Promise.all(list.map(async (blob) => new Uint8Array(await blob.arrayBuffer()))));
}

/** the platform jars at their device paths, with their resources served: a page's platform classes are its tier's build (wasm/host/boot.ts) */
export function mountPlatformJars(): Promise<void> {
  return mounted ??= fetchPlatformJars().then((bytes) => bytes.forEach(mountPlatformJar));
}

export function loadFramework(): Promise<Arsc> {
  return pending ??= (async () => {
    const res = await fetch("/vendor/aosp/framework-res.apk");
    if (!res.ok) throw new Error(`no framework package (${res.status}) — run: pnpm gen-framework`);
    return installFramework(new Uint8Array(await res.arrayBuffer()));
  })();
}

/** framework-res.apk's table as the platform package, with the device's overlays */
export function installFramework(apk: Uint8Array): Arsc {
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
    // every entry, inflated on its first read: asset lists and opens see the whole archive
    const entries = new Map<string, FileSource>();
    for (const [name, e] of dir) entries.set(name, { size: e.size, read: (at, n) => files(name)!.subarray(at, at + n) });
    registerPackage({ root: parseAXML(manifest), apk: { table: arsc, zip: {}, lazyEntries: entries }, certificates: () => pendingCertificates ??= (async () => {
      const certificates = await apkCertificates(apk, signingZip);
      if (certificates.length) return certificates;
      const response = await fetch("/vendor/platform.x509.pem");
      if (!response.ok) throw new Error("Platform certificate unavailable");
      const encoded = (await response.text()).replace(/-----[^-]+-----|\s/g, "");
      return [Uint8Array.fromBase64(encoded)];
    })() }, { path: "/system/framework/framework-res.apk", uid: 1000, system: true });
  }

  // the reference device's overlays (SystemUI's Monet palette, gestural navigation) replace these defaults
  for (const [key, [type, data]] of Object.entries(DEVICE_OVERLAYS)) {
    const slash = key.indexOf("/"), name = key.slice(slash + 1), id = arsc.names(key.slice(0, slash)).get(name);
    if (id !== undefined) arsc.overlay(id, name, { type, data: data | 0 });
  }
  return arsc;
}
