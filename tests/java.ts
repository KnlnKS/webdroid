import { readFileSync } from "node:fs";
import { rt, type JObj } from "../src/jvm/runtime.ts";
import { classNameOf, newObj, scall } from "../src/jvm/natives/jentry.ts";
import type { AppHost } from "../src/android/apphost.ts";
import type { BrokerCalls } from "../src/shell/broker-contract.ts";
import { connectBroker } from "../src/shell/broker-access.ts";
import { notConnected, unconnected } from "../src/jvm/natives/jthrowable.ts";

export { scall } from "../src/jvm/natives/jentry.ts";

/** the Java exception `call` throws, synchronously or as a rejection, as "class: message", or null */
export const thrown = (call: () => unknown): Promise<string | null> => Promise.resolve().then(call)
  .then(() => null, (e: { msg?: string }) => `${classNameOf(e)}: ${e.msg}`);

/** an AssetFileDescriptor over the whole of a ParcelFileDescriptor served over `bytes` */
export async function assetFd(bytes: Uint8Array): Promise<JObj> {
  const { mkPfd } = await import("../src/android/os.ts");
  return newObj("android/content/res/AssetFileDescriptor", "(Landroid/os/ParcelFileDescriptor;JJ)V", await mkPfd(bytes), 0n, BigInt(bytes.length));
}

/** the JCA engine `cls` (a Cipher, a KeyPairGenerator, ...) for `algo` */
export const getInstance = (cls: string, algo: string) => scall(cls, "getInstance", `(Ljava/lang/String;)L${cls};`, algo);

/** a fixture process that stalls prints the Java threads' states and exits rather than outliving its test */
export function fixtureDeadline(ms = 90_000): void {
  setTimeout(async () => {
    console.log(JSON.stringify({ stalled: (await import("../src/jvm/tier.ts")).wasmThreads() }));
    process.exit(1);
  }, ms).unref();
}

/** the AppHost a booted page sets for `pkg` */
/** a broker of `calls`, whose other calls fail as an unconnected realm's do; the presentation and finish
 *  notices a page or Worker sends go nowhere */
export function testBroker(calls: Partial<BrokerCalls>): BrokerCalls {
  const target: Partial<BrokerCalls> = { activity: { presentation: async () => {}, finish: async () => {}, launch: notConnected }, ...calls };
  return new Proxy(target, { get: (_, name) => (target as Record<string | symbol, unknown>)[name] ?? unconnected() }) as BrokerCalls;
}
let baseBroker: Partial<BrokerCalls> = {}, current = () => connectBroker(undefined, false);
/** connect this realm to `calls` over those bootApp gives, as the page or (`worker`) a Worker, until the
 *  returned function connects it as before */
export function useTestBroker(calls: Partial<BrokerCalls>, worker = false): () => void {
  const previous = current;
  (current = () => connectBroker(testBroker({ ...baseBroker, ...calls }), worker))();
  return () => (current = previous)();
}
export const testAppHost = ({ pkg }: { pkg: string }): AppHost =>
  ({ pkg, assetKey: "", zip: {}, setApplicationNightMode: () => {}, setApplicationLocales: () => {} });

let apex: Promise<void> | null = null;
/** the /apex ICU and tz data every realm mounts */
export function mountApexData(): Promise<void> {
  return apex ??= Promise.all([import("../scripts/aosp.ts"), import("../src/shell/apex.ts")]).then(([aosp, data]) => data.mountPlatformData(aosp.localPlatformData()));
}
let fontMap: Promise<void> | null = null;
/** the font map and text paints the zygote preloads (whose locale scripts are ICU's), as a booted
 *  page has them */
export function loadSystemFonts(): Promise<void> {
  return fontMap ??= (async () => {
    const { loadSystemFontMap } = await import("../src/android/fonts.ts");
    const { callOn, mainThread } = await import("../src/jvm/natives/jentry.ts");
    await mountApexData();
    await callOn(mainThread, () => rt.drive(loadSystemFontMap()));
    await preloadTextPaint();
  })();
}
/** the device's languages and the text paint classes, as the zygote sets them up: a TS TextView
 *  constructs its TextPaint synchronously */
async function preloadTextPaint(): Promise<void> {
  await (await import("../src/android/configuration.ts")).initDeviceLocales();
  await (await import("../src/android/paint.ts")).preloadPaint();
}


/** Styles in a Resources with no table behind it: each entry is (attribute, type, data), a
 *  TYPE_STRING's data indexing `strings`, which stand in for the package's value pool. */
export async function fakeStyles(strings: string[], styles: Record<number, [number, number, number][]>) {
  const { Resources, Bag } = await import("../src/android/res.ts");
  const { deviceQualifiers } = await import("../src/android/configuration.ts");
  const table = { pkgId: 0x7f, packageIds: () => [0x7f], values: { get: (i: number) => strings[i] }, specFlags: () => 0 };
  const res = new Resources([{ table: table as never, zip: {}, lazyEntries: new Map() }], deviceQualifiers());
  for (const [id, entries] of Object.entries(styles)) {
    const sorted = entries.slice().sort((a, b) => a[0] - b[0]);
    res.bagCache.set(+id, new Bag(0, 0, Int32Array.from(sorted, (e) => e[0]), Uint8Array.from(sorted, (e) => e[1]),
      Int32Array.from(sorted, (e) => e[2]), new Int32Array(sorted.length).fill(+id)));
  }
  return res;
}

/** framework.jar, the main looper, framework-res as the system package and the device's locales, as a booted page has them */
export async function loadPlatform(): Promise<void> {
  const { loadFramework } = await import("../src/android/framework.ts");
  await (await import("../src/android/mainloop.ts")).startMainLooper();
  const fetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => url === "/vendor/aosp/framework-res.apk"
    ? new Response(readFileSync(new URL("../vendor/aosp/framework-res.apk", import.meta.url))) : fetch(url)) as typeof fetch;
  try { await loadFramework(); } finally { globalThis.fetch = fetch; }
  const { deviceConfiguration, initDeviceLocales } = await import("../src/android/configuration.ts");
  if (!deviceConfiguration().locales.values.length) await initDeviceLocales();
}

/** AOSP's Resources over `archive`, installed at /data/app/`name`.apk beside framework-res, as
 *  ResourcesManager builds them under the device configuration */
export async function appResources(archive: import("../src/android/packagearchive.ts").PackageArchive, name: string): Promise<JObj> {
  const { javaConfiguration } = await import("../src/android/configuration.ts");
  const { registerPackage } = await import("../src/android/installpackage.ts");
  const { vcall } = await import("../src/jvm/natives/jentry.ts");
  await loadPlatform();
  const path = registerPackage(archive, { path: `/data/app/${name}.apk` }).path;
  const apk = await scall("android/content/res/ApkAssets", "loadFromPath", "(Ljava/lang/String;)Landroid/content/res/ApkAssets;", path);
  const builder = await newObj("android/content/res/AssetManager$Builder", "()V");
  await vcall(builder, "addApkAssets", "(Landroid/content/res/ApkAssets;)Landroid/content/res/AssetManager$Builder;", apk);
  return newObj("android/content/res/Resources", "(Landroid/content/res/AssetManager;Landroid/util/DisplayMetrics;Landroid/content/res/Configuration;)V",
    await vcall(builder, "build", "()Landroid/content/res/AssetManager;"), await newObj("android/util/DisplayMetrics", "()V"), await javaConfiguration());
}

type BootedApp = { app: JObj; info: JObj; loaded: JObj };
const booted = new Map<string, Promise<BootedApp>>();
let started: Promise<unknown> | null = null;
/** `record`'s process as a page boots it: the package installed and naming this process, AOSP's
 *  ActivityThread attached to the activity manager, which binds its Application. Resolves to that
 *  Application once its onCreate ran. Asking for another package takes the process over: its
 *  identity, name and Application, made by its own LoadedApk, are the current ones until another
 *  is asked for. */
export async function bootApp(record: import("../src/android/packages.ts").PackageRecord, pid = 4321): Promise<JObj> {
  const { packages } = await import("../src/android/packages.ts");
  const { setProcessIdentity, setProcessName } = await import("../src/android/os.ts");
  const { setAppHost } = await import("../src/android/apphost.ts");
  const { onMain } = await import("../src/android/mainloop.ts");
  const { vfs } = await import("../src/shell/vfs.ts");
  const { vcall, staticField } = await import("../src/jvm/natives/jentry.ts");
  const { getDeclared, setDeclared } = await import("../src/jvm/runtime.ts");
  const AT = "android/app/ActivityThread", BIND = "android/app/ActivityThread$AppBindData";
  let entry = booted.get(record.pkg);
  if (!entry) {
    packages.set(record.pkg, record);
    // installd's createAppData, as a page's boot does it
    for (const dir of ["", "/cache", "/code_cache"]) vfs.mkdir(`/data/data/${record.pkg}${dir}`);
  }
  setProcessIdentity(pid, record.uid);
  setProcessName(record.pkg);
  setAppHost(testAppHost(record));
  const thread = () => scall(AT, "currentActivityThread", `()L${AT};`);
  if (!started) {
    started = entry = (async () => {
      const { startActivityThread } = await import("../src/android/server/am.ts");
      const { ServiceRecords } = await import("../src/shell/servicerecords.ts");
      // the start state the broker keeps of this realm's services, which no broker holds here
      const starts = new ServiceRecords({ send: () => null, connected: () => {}, persistent: () => false }).starts("", "");
      baseBroker = { starts: starts as unknown as BrokerCalls["starts"] };
      useTestBroker({});
      await loadPlatform();
      await loadSystemFonts();
      await onMain(() => startActivityThread(false));
      // bindApplication is a message to the main looper; the Application exists once it ran
      return onMain(async () => {
        const at = await thread(), bound = getDeclared<JObj>(at, AT, "mBoundApplication");
        // bindApplication enables StrictMode's death on network for the main thread, which test
        // bodies call Java from; a later test does network I/O there
        await scall("android/os/StrictMode", "setThreadPolicy", "(Landroid/os/StrictMode$ThreadPolicy;)V",
          await staticField("android/os/StrictMode$ThreadPolicy", "LAX"));
        return { app: getDeclared<JObj>(at, AT, "mInitialApplication"), info: getDeclared<JObj>(bound, BIND, "appInfo"), loaded: getDeclared<JObj>(bound, BIND, "info") };
      });
    })();
    booted.set(record.pkg, entry);
  } else if (!entry) {
    await started;
    // handleBindApplication's share for the package: its LoadedApk and Application, onCreate called
    booted.set(record.pkg, entry = onMain(async () => {
      const at = await thread();
      const info = await vcall(await scall(AT, "getPackageManager", "()Landroid/content/pm/IPackageManager;"), "getApplicationInfo",
        "(Ljava/lang/String;JI)Landroid/content/pm/ApplicationInfo;", record.pkg, 0x400n, 0);
      const loaded = await vcall(at, "getPackageInfoNoCheck", "(Landroid/content/pm/ApplicationInfo;Landroid/content/res/CompatibilityInfo;)Landroid/app/LoadedApk;",
        info, await staticField("android/content/res/CompatibilityInfo", "DEFAULT_COMPATIBILITY_INFO"));
      const app = await vcall(loaded, "makeApplication", "(ZLandroid/app/Instrumentation;)Landroid/app/Application;", 0, null);
      await vcall(app, "onCreate", "()V");
      return { app, info, loaded };
    }));
  }
  const { app, info, loaded } = await entry;
  // ActivityThread's view of which package this process runs (currentApplication, currentPackageName)
  await onMain(async () => {
    const at = await thread();
    setDeclared(at, AT, { mInitialApplication: app });
    setDeclared(getDeclared<JObj>(at, AT, "mBoundApplication"), BIND, { appInfo: info, info: loaded, processName: record.pkg });
  });
  return app;
}

/** a package `pkg` targeting `target` that requests `permissions`, as the package manager records an
 *  installed one; its archive is an empty table at /data/app/`pkg`.apk */
export async function packageRecord(pkg: string, { target = 35, permissions = [] as string[], certificate = 1, application = [] as import("../src/android/axml.ts").XmlNode[] } = {}) {
  const { PackageRecord, packageUid } = await import("../src/android/packages.ts");
  const { emptyApk } = await import("../src/android/res.ts");
  const { TV } = await import("../src/android/axml.ts");
  const attr = (name: string, str: string | null, data = 0) => ({ name, str, ns: "", resId: 0, type: str === null ? TV.INT_DEC : TV.STRING, data });
  const manifest = { name: "manifest", attrs: [attr("package", pkg)], children: [
    { name: "uses-sdk", attrs: [attr("minSdkVersion", null, 21), attr("targetSdkVersion", null, target)], children: [] },
    ...permissions.map((name) => ({ name: "uses-permission", attrs: [attr("name", name)], children: [] })),
    { name: "application", attrs: [], children: application },
  ] };
  return new PackageRecord(manifest, emptyApk(), `/data/app/${pkg}.apk`, packageUid(pkg), async () => [new Uint8Array([certificate])]);
}
