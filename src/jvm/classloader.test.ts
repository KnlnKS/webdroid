import { beforeAll, expect, test } from "bun:test";
import { JObj, rt } from "./runtime";
import { newObj, vcall } from "./natives/jlang";
import { installClassReflection } from "./natives/jreflect";

let initialized = 0;
const calls: string[] = [];
beforeAll(() => {
  installClassReflection();
  rt.register({ name: "test/LazyLoadTarget", ctor: class extends JObj {}, clinit: () => { initialized++; } });
  const Base = rt.link("java/lang/ClassLoader").ctor;
  rt.register({
    name: "test/ParentLoader", ctor: class extends Base {}, sup: "java/lang/ClassLoader",
    methods: {
      "loadClass(Ljava/lang/String;Z)Ljava/lang/Class;": (name: string) => {
        calls.push("parent:" + name);
        if (name === "parent.Target") return rt.classFor("test/LazyLoadTarget");
        if (name === "denied.Target") throw rt.mkThrowable("java/lang/SecurityException", name);
        rt.link("java/lang/ClassNotFoundException");
        throw rt.mkThrowable("java/lang/ClassNotFoundException", name);
      },
    },
  });
  rt.register({
    name: "test/ChildLoader", ctor: class extends Base {}, sup: "java/lang/ClassLoader",
    methods: {
      "findClass(Ljava/lang/String;)Ljava/lang/Class;": (name: string) => {
        calls.push("child:" + name);
        return rt.classFor("test/LazyLoadTarget");
      },
    },
  });
});

test("ClassLoader preserves its parent, delegates virtually, and falls back only on missing classes", async () => {
  const parent = await newObj("test/ParentLoader", "(Ljava/lang/ClassLoader;)V", null);
  const child = await newObj("test/ChildLoader", "(Ljava/lang/ClassLoader;)V", parent);
  expect(await vcall(child, "getParent", "()Ljava/lang/ClassLoader;")).toBe(parent);
  const target = rt.classFor("test/LazyLoadTarget");
  calls.length = 0;
  expect(await vcall(child, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "parent.Target")).toBe(target);
  expect(calls).toEqual(["parent:parent.Target"]);
  expect(await vcall(child, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "child.Target")).toBe(target);
  expect(calls).toEqual(["parent:parent.Target", "parent:child.Target", "child:child.Target"]);
  await expect(vcall(child, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "denied.Target")).rejects.toMatchObject({ msg: "denied.Target" });
  expect(calls.at(-1)).toBe("parent:denied.Target");
});

test("loading classes does not initialize them and default loaders retain the system parent", async () => {
  const loader = await newObj("java/lang/ClassLoader");
  const parent = await vcall(loader, "getParent", "()Ljava/lang/ClassLoader;");
  expect(parent).not.toBeNull();
  expect(await vcall(rt.link("java/lang/ClassLoader").ctor, "getSystemClassLoader", "()Ljava/lang/ClassLoader;")).toBe(parent);
  expect(await vcall(parent, "getParent", "()Ljava/lang/ClassLoader;")).toBeNull();
  expect(await vcall(loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "test.LazyLoadTarget")).toBe(rt.classFor("test/LazyLoadTarget"));
  expect(initialized).toBe(0);
  await vcall(rt.link("java/lang/Class").ctor, "forName", "(Ljava/lang/String;)Ljava/lang/Class;", "test.LazyLoadTarget");
  expect(initialized).toBe(1);
});

test("PathClassLoader keeps DEX definitions private and preserves their loader through reflection", async () => {
  await import("./natives/jdex");
  const { vfs } = await import("./natives/jio");
  const bytes = new Uint8Array(await Bun.file(new URL("./fixtures/monitor.dex", import.meta.url)).arrayBuffer());
  vfs.write("/data/app/loader-test.apk", bytes);
  const original = rt.dexIndex.get("webdroid/MonitorFixture");
  const a = await newObj("dalvik/system/PathClassLoader", "(Ljava/lang/String;Ljava/lang/ClassLoader;)V", "/data/app/loader-test.apk", null);
  const b = await newObj("dalvik/system/PathClassLoader", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/ClassLoader;)V", "/data/app/loader-test.apk", null, null);
  expect(await vcall(a, "findLoadedClass", "(Ljava/lang/String;)Ljava/lang/Class;", "webdroid.MonitorFixture")).toBeNull();
  const ca = await vcall(a, "findClass", "(Ljava/lang/String;)Ljava/lang/Class;", "webdroid.MonitorFixture");
  const cb = await vcall(b, "findClass", "(Ljava/lang/String;)Ljava/lang/Class;", "webdroid.MonitorFixture");
  expect(ca).not.toBe(cb);
  expect(await vcall(ca, "isAssignableFrom", "(Ljava/lang/Class;)Z", cb)).toBe(0);
  expect(rt.dexIndex.get("webdroid/MonitorFixture")).toBe(original);
  expect(await vcall(ca, "getClassLoader", "()Ljava/lang/ClassLoader;")).toBe(a);
  expect(await vcall(a, "findLoadedClass", "(Ljava/lang/String;)Ljava/lang/Class;", "webdroid.MonitorFixture")).toBe(ca);
  expect(ca.ci.state).toBe(0);
  const object = await vcall(ca, "newInstance", "()Ljava/lang/Object;");
  expect(await vcall(object, "getClass", "()Ljava/lang/Class;")).toBe(ca);
  expect(await vcall(ca, "isInstance", "(Ljava/lang/Object;)Z", object)).toBe(1);
  expect(await vcall(cb, "isInstance", "(Ljava/lang/Object;)Z", object)).toBe(0);
  await vcall(ca.ci.ctor, "enter", "(Ljava/lang/Object;)V", object);
  expect(ca.ci.state).toBe(2);
  expect(cb.ci.state).toBe(0);
  const delegated = await vcall(b, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "webdroid.MonitorFixture");
  expect(await vcall(rt.link("java/lang/Class").ctor, "forName", "(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;", "webdroid.MonitorFixture", 1, b)).toBe(delegated);
  expect(delegated.ci.state).toBe(2);
  await expect(vcall(a, "findClass", "(Ljava/lang/String;)Ljava/lang/Class;", "absent.Target")).rejects.toMatchObject({ msg: "absent.Target" });
  vfs.files.delete("/data/app/loader-test.apk");
});

test("class loader resource URLs stream archive entries and preserve parent search order", async () => {
  await import("./natives/jdex");
  await import("./natives/jnet");
  await import("./natives/jzip");
  rt.link("webdroid/Iter");
  const { zipSync, strToU8 } = await import("fflate");
  const { vfs, readStreamFully } = await import("./natives/jio");
  vfs.write("/data/app/resources-parent.apk", zipSync({ "assets/message.txt": strToU8("parent") }));
  vfs.write("/data/app/resources-child.apk", zipSync({ "assets/message.txt": strToU8("child") }));
  const parent = await newObj("dalvik/system/PathClassLoader", "(Ljava/lang/String;Ljava/lang/ClassLoader;)V", "/data/app/resources-parent.apk", null);
  const child = await newObj("dalvik/system/PathClassLoader", "(Ljava/lang/String;Ljava/lang/ClassLoader;)V", "/data/app/resources-child.apk", parent);
  const stream = await vcall(child, "getResourceAsStream", "(Ljava/lang/String;)Ljava/io/InputStream;", "assets/message.txt");
  expect(new TextDecoder().decode(await readStreamFully(stream))).toBe("parent");
  const own = await vcall(child, "findResource", "(Ljava/lang/String;)Ljava/net/URL;", "assets/message.txt");
  expect(new TextDecoder().decode(await readStreamFully(await vcall(own, "openStream", "()Ljava/io/InputStream;")))).toBe("child");
  const urls = await vcall(child, "getResources", "(Ljava/lang/String;)Ljava/util/Enumeration;", "assets/message.txt");
  const paths: string[] = [];
  while (await vcall(urls, "hasMoreElements", "()Z")) paths.push(await vcall(await vcall(urls, "nextElement", "()Ljava/lang/Object;"), "toString", "()Ljava/lang/String;"));
  expect(paths).toEqual(["jar:file:///data/app/resources-parent.apk!/assets/message.txt", "jar:file:///data/app/resources-child.apk!/assets/message.txt"]);
  expect(await vcall(child, "getResource", "(Ljava/lang/String;)Ljava/net/URL;", "missing")).toBeNull();
  vfs.files.delete("/data/app/resources-parent.apk");
  vfs.files.delete("/data/app/resources-child.apk");
});

async function duplicateLoaderDex() {
  const { vfs } = await import("./natives/jio");
  const bytes = await Bun.file(new URL("./fixtures/monitor.dex", import.meta.url)).bytes();
  const data = Buffer.from(bytes);
  for (let offset = data.indexOf("MonitorFixture"); offset >= 0; offset = data.indexOf("MonitorFixture", offset + 1))
    bytes.set(new TextEncoder().encode("BindingFixture"), offset);
  vfs.write("/data/app/duplicate-loader.dex", bytes);
}

test("parent delegation binds duplicate definitions consistently for bytecode dependencies", async () => {
  await duplicateLoaderDex();
  const parent = await newObj("dalvik/system/PathClassLoader", "(Ljava/lang/String;Ljava/lang/ClassLoader;)V", "/data/app/duplicate-loader.dex", null);
  const child = await newObj("dalvik/system/PathClassLoader", "(Ljava/lang/String;Ljava/lang/ClassLoader;)V", "/data/app/duplicate-loader.dex", parent);
  const name = "webdroid/BindingFixture";
  const loaded = await vcall(child, "loadClass", "(Ljava/lang/String;Z)Ljava/lang/Class;", name.replaceAll("/", "."), 0);
  expect(loaded.ci.owner).toBe(parent.runtime);
  expect(child.runtime.classFor(name)).toBe(loaded);
  expect(await vcall(child, "findLoadedClass", "(Ljava/lang/String;)Ljava/lang/Class;", name)).toBe(loaded);
  expect(loaded.ci.state).toBe(0);
});

test("Mihon's bytecode loader keeps its child-first decision for duplicate parent DEX", async () => {
  const { openDexes } = await import("../../scripts/lib");
  await duplicateLoaderDex();
  const app = rt.fork();
  for (const dex of await openDexes(new URL("../../apks/mihon-v0.20.4.apk", import.meta.url).pathname)) app.loadDex(dex);
  const info = app.link("eu/kanade/tachiyomi/util/system/ChildFirstPathClassLoader");
  await app.initClass(info);
  const parent = await newObj("dalvik/system/PathClassLoader", "(Ljava/lang/String;Ljava/lang/ClassLoader;)V", "/data/app/duplicate-loader.dex", null);
  const child = new info.ctor();
  await vcall(child, "<init>", "(Ljava/lang/ClassLoader;Ljava/lang/String;)V", parent, "/data/app/duplicate-loader.dex");
  const loaded = await vcall(child, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "webdroid.BindingFixture");
  const parentClass = await vcall(parent, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "webdroid.BindingFixture");
  expect(loaded).not.toBe(parentClass);
  expect(loaded.ci.owner).toBe(child.runtime);
  expect(child.runtime.classFor("webdroid/BindingFixture")).toBe(loaded);
  expect(loaded.ci.state).toBe(0);
});

test("array Classes retain component identity and loader across sibling DEX loaders", async () => {
  await import("./natives/jdex");
  await duplicateLoaderDex();
  const a = await newObj("dalvik/system/PathClassLoader", "(Ljava/lang/String;Ljava/lang/ClassLoader;)V", "/data/app/duplicate-loader.dex", null);
  const b = await newObj("dalvik/system/PathClassLoader", "(Ljava/lang/String;Ljava/lang/ClassLoader;)V", "/data/app/duplicate-loader.dex", null);
  const name = "webdroid/BindingFixture", ca = a.runtime.classFor(name), cb = b.runtime.classFor(name);
  const aa = a.runtime.classFor(`[L${name};`), ab = b.runtime.classFor(`[L${name};`);
  expect(aa).not.toBe(ab);
  expect(a.runtime.classFor(`[L${name};`)).toBe(aa);
  expect(await vcall(aa, "getComponentType", "()Ljava/lang/Class;")).toBe(ca);
  expect(await vcall(ab, "getComponentType", "()Ljava/lang/Class;")).toBe(cb);
  expect(await vcall(aa, "getClassLoader", "()Ljava/lang/ClassLoader;")).toBe(a);
  const matrix = a.runtime.classFor(`[[L${name};`);
  expect(await vcall(matrix, "getComponentType", "()Ljava/lang/Class;")).toBe(aa);
  expect(await vcall(matrix, "getClassLoader", "()Ljava/lang/ClassLoader;")).toBe(a);
  expect(a.runtime.classFor("[Ljava/lang/String;")).toBe(rt.classFor("[Ljava/lang/String;"));
  expect(a.runtime.classFor("[I")).toBe(b.runtime.classFor("[I"));
  expect(await vcall(a.runtime.classFor("[I"), "getClassLoader", "()Ljava/lang/ClassLoader;")).toBeNull();
  expect(ca.ci.state).toBe(0);
  expect(cb.ci.state).toBe(0);
  expect(rt.classes.has(name)).toBe(false);
});


test("array class descriptors do not eagerly stub optional component classes", async () => {
  const before = new Set(rt.missing), name = "test/OptionalArrayComponent";
  const array = rt.classFor(`[L${name};`);
  expect(await vcall(array, "isArray", "()Z")).toBe(1);
  expect(rt.classes.has(name)).toBe(false);
  expect(rt.missing).toEqual(before);
});
