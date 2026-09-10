import { expect, test } from "bun:test";
import "../natives";
import { rt } from "./runtime";
import { newObj, vcall } from "./natives/jlang";
import { vfs } from "./natives/jio";

test("annotations and their values retain the defining loader across duplicate DEX", async () => {
  rt.link("java/lang/reflect/Field");
  const path = "/data/app/annotations.dex";
  vfs.write(path, await Bun.file(new URL("./fixtures/annotations.dex", import.meta.url)).bytes());
  try {
    const first = await newObj("webdroid/PackageClassLoader", "(Ljava/lang/String;)V", path);
    const second = await newObj("webdroid/PackageClassLoader", "(Ljava/lang/String;)V", path);
    const load = (loader: unknown, name: string) => vcall(loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", name);
    const tagName = "webdroid.AnnotationFixture$Tag", name = "webdroid.AnnotationFixture";
    const foreignTag = await load(second, tagName);
    for (const loader of [first, second]) {
      const cls = await load(loader, name), tag = await load(loader, tagName);
      const annotation = (element: unknown, type = tag) => vcall(element, "getAnnotation", "(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;", type);
      await rt.initClass(cls.ci);
      for (let i = 0; i < 40; i++)
        expect(await vcall(cls.ci.ctor, "lookup", "(Ljava/lang/String;)Ljava/lang/Class;", tagName)).toBe(tag);
      const value = await annotation(cls);
      expect(await vcall(value, "annotationType", "()Ljava/lang/Class;")).toBe(tag);
      expect(await vcall(value, "type", "()Ljava/lang/Class;")).toBe(cls);
      const nested = await vcall(value, "nested", "()Lwebdroid/AnnotationFixture$Nested;");
      expect(await vcall(nested, "annotationType", "()Ljava/lang/Class;")).toBe(await load(loader, "webdroid.AnnotationFixture$Nested"));
      expect(await vcall(nested, "value", "()I")).toBe(9);
      const mode = await vcall(value, "mode", "()Lwebdroid/AnnotationFixture$Mode;");
      expect(await vcall(mode, "name", "()Ljava/lang/String;")).toBe("SECOND");
      expect(await vcall(mode, "getDeclaringClass", "()Ljava/lang/Class;")).toBe(await load(loader, "webdroid.AnnotationFixture$Mode"));
      const field = await vcall(cls, "getDeclaredField", "(Ljava/lang/String;)Ljava/lang/reflect/Field;", "value");
      expect(await vcall(await annotation(field), "annotationType", "()Ljava/lang/Class;")).toBe(tag);
      const declared = await vcall(cls, "getDeclaredAnnotations", "()[Ljava/lang/annotation/Annotation;");
      expect(declared.length).toBe(1);
      expect(await vcall(declared[0], "annotationType", "()Ljava/lang/Class;")).toBe(tag);
      const methods = await vcall(cls, "getDeclaredMethods", "()[Ljava/lang/reflect/Method;");
      let method: unknown;
      for (const candidate of methods) if (await vcall(candidate, "getName", "()Ljava/lang/String;") === "method") method = candidate;
      expect(await vcall(await annotation(method), "annotationType", "()Ljava/lang/Class;")).toBe(tag);
      const parameters = await vcall(method, "getParameterAnnotations", "()[[Ljava/lang/annotation/Annotation;");
      expect(await vcall(parameters[0][0], "annotationType", "()Ljava/lang/Class;")).toBe(tag);
      if (loader === first) {
        expect(await annotation(cls, foreignTag)).toBeNull();
        expect(await annotation(field, foreignTag)).toBeNull();
        expect(await vcall(field, "isAnnotationPresent", "(Ljava/lang/Class;)Z", foreignTag)).toBe(0);
      }
    }
  } finally { vfs.delete(path); }
});
