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
