import { expect, test } from "bun:test";
import { addReachedMembers, buildCatalog, parseApiVersions } from "../scripts/fuzz/catalog";
import { JObj, Runtime, stubs } from "../src/jvm/runtime";

const XML = `<?xml version="1.0"?>
<api version="3">
  <class name="android/example/Value" since="2">
    <extends name="java/lang/Object"/>
    <method name="&lt;init>()V"/>
    <method name="answer()I" since="3"/>
    <method name="future()V" since="34"/>
    <field name="VALUE"/>
  </class>
  <class name="android/example/Removed" removed="30">
    <method name="gone()V"/>
  </class>
</api>`;

test("API catalog filters future members and distinguishes placeholders", () => {
  expect(parseApiVersions(XML, 33).map((member) => member.signature)).toEqual([
    "android/example/Value", "<init>()V", "answer()I", "VALUE", "android/example/Removed", "gone()V",
  ]);

  class Value extends JObj {}
  const runtime = new Runtime();
  runtime.register({ name: "java/lang/Object", ctor: class extends JObj {} });
  runtime.register({
    name: "android/example/Value", ctor: Value,
    methods: { "<init>()V": function () {}, ...stubs(0, "answer()I") },
    statics: { VALUE: 42 },
  });
  runtime.linkNatives();
  const catalog = buildCatalog({ sdk: 33, xml: XML, runtime, frameworkDexes: [] });
  const status = new Map(catalog.members.map((member) => [`${member.owner}.${member.signature}`, member.support]));
  expect(status.get("android/example/Value.<init>()V")).toBe("delegate");
  expect(status.get("android/example/Value.answer()I")).toBe("placeholder");
  expect(status.get("android/example/Value.VALUE")).toBe("delegate");
  expect(status.get("android/example/Removed.gone()V")).toBe("platform-absent");
  expect(catalog.members.every((member) => !member.exercised)).toBe(true);

  const reached = {
    classes: new Map<string, number>(),
    methods: new Map([["android/example/Value.answer()I", 2], ["android/example/Hidden.call()V", 3]]),
    fields: new Map<string, number>(),
  };
  addReachedMembers(catalog, reached, runtime, []);
  expect(catalog.members.find((member) => member.signature === "answer()I")?.sites).toBe(2);
  expect(catalog.members.find((member) => member.owner === "android/example/Hidden")).toMatchObject({
    source: "reached-hidden", support: "missing", sites: 3,
  });
});
