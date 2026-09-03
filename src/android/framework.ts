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
import { dexesIn } from "../jvm/dex";
import { mangleStaticField } from "../jvm/abi";
import { setFramework } from "./res";
import { needsFramework } from "../jvm/provenance";

let pending: Promise<Arsc> | null = null;
let pendingDex: Promise<void> | null = null;

/** AOSP's own android.* and com.android.internal.*, for whatever provenance cut over to it.
 *  43MB of dex across five files; indexing all 32,713 classes costs ~30ms and compiling is
 *  lazy per class, so an apk that touches ten of them pays for ten. */
export function loadFrameworkDex(): Promise<void> {
  if (!needsFramework()) return Promise.resolve();
  return pendingDex ??= (async () => {
    const res = await fetch("/vendor/aosp/framework.jar");
    if (!res.ok) throw new Error(`no framework bytecode (${res.status}) — run: bun run gen-framework`);
    const jar = new Uint8Array(await res.arrayBuffer());
    const dir = centralDir(jar);
    for (const name of [...dir.keys()].filter((n) => /^classes\d*\.dex$/.test(n)).sort()) {
      for (const d of dexesIn(entryBytes(jar, dir.get(name)!), `framework:${name}`)) rt.loadDex(d);
    }
  })();
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
