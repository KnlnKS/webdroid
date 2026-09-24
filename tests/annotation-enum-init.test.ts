import { expect, test } from "bun:test";
import "../src/natives";
import { mangleStaticField } from "../src/jvm/abi";
import type { DexFile, EncAnnotation } from "../src/jvm/dex";
import { vcall } from "../src/jvm/natives/jlang";
import { mkAnnotation } from "../src/jvm/natives/jreflect";
import { JObj, rt } from "../src/jvm/runtime";

test("explicit enum annotation elements wait for class initialization", async () => {
  const modeName = "test/DeferredAnnotationMode";
  const annotationName = "test/DeferredEnumAnnotation";
  const mode = new JObj();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  class Mode extends JObj {}
  rt.register({
    name: modeName,
    ctor: Mode,
    statics: { MAIN: null },
    clinit: async () => {
      await gate;
      (Mode as unknown as Record<string, unknown>)[mangleStaticField("MAIN")] = mode;
    },
  });
  rt.register({
    name: annotationName,
    ctor: class extends JObj {},
    methods: { [`value()L${modeName};`]: () => null },
  });

  const dex = {
    field: () => ({ cls: 0, type: 0, name: "MAIN" }),
    type: () => `L${modeName};`,
  } as unknown as DexFile;
  const annotation: EncAnnotation = {
    visibility: 1,
    type: annotationName,
    elements: { value: { kind: "enum", idx: 0 } },
    dex,
  };

  mkAnnotation(annotation);
  const second = mkAnnotation(annotation);
  const pending = vcall(second, "value", `()L${modeName};`);
  release();

  expect(await pending).toBe(mode);
});

test("annotation arrays retain their declared Java types", async () => {
  const name = "test/ArrayAnnotation";
  rt.register({
    name,
    ctor: class extends JObj {},
    methods: {
      "versions()[I": () => null,
      "names()[Ljava/lang/String;": () => null,
    },
  });
  const annotation = mkAnnotation({
    visibility: 1,
    type: name,
    elements: { versions: [2, 3, 0], names: ["one", "two"] },
    dex: {} as DexFile,
  });

  const versions = await vcall(annotation, "versions", "()[I");
  const names = await vcall(annotation, "names", "()[Ljava/lang/String;");
  expect(versions).toEqual(new Int32Array([2, 3, 0]));
  expect(rt.iof(versions, "[I")).toBe(1);
  expect(names).toEqual(expect.arrayContaining(["one", "two"]));
  expect(rt.iof(names, "[Ljava/lang/String;")).toBe(1);
});
