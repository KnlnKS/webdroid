import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { Arsc } from "../src/android/arsc";
import { TV } from "../src/android/axml";
import { Resources } from "../src/android/res";
import { mkJResources } from "../src/android/resnative";
import { JTypedValue } from "../src/android/util";

rt.linkNatives();
test("resource values retain selected density and resolved reference identity", async () => {
  const table = new Arsc(Uint8Array.of(2, 0, 8, 0, 8, 0, 0, 0));
  const config = { density: 0, sdk: 0, orientation: 0, night: 0, lang: "", region: "", swdp: 0, wdp: 0, hdp: 0, size: 0, dir: 0, uiType: 0, score: 0 };
  table.device.density = 480;
  table.types.set(1, [
    { id: 1, name: "integer", config, entries: new Map([
      [0, { key: "density_value", value: { type: TV.INT_DEC, data: 1 } }],
      [1, { key: "alias", value: { type: TV.REFERENCE, data: 0x7f010000 } }],
      [2, { key: "plain", value: { type: TV.INT_DEC, data: 2 } }],
    ]) },
    { id: 1, name: "integer", config: { ...config, density: 480 }, entries: new Map([
      [0, { key: "density_value", value: { type: TV.INT_DEC, data: 3 } }],
    ]) },
  ]);
  const res = mkJResources(new Resources(table, {}), false), value = new JTypedValue();
  for (const [id, resolve, expected] of [
    [0x7f010000, 1, [TV.INT_DEC, 3, 480, 0x7f010000]],
    [0x7f010001, 1, [TV.INT_DEC, 3, 480, 0x7f010000]],
    [0x7f010001, 0, [TV.REFERENCE, 0x7f010000, 0, 0x7f010001]],
    [0x7f010002, 1, [TV.INT_DEC, 2, 0, 0x7f010002]],
  ] satisfies [number, number, number[]][]) {
    await vcall(res, "getValue", "(ILandroid/util/TypedValue;Z)V", id, value, resolve);
    expect([value.type, value.data, value.density, value.resourceId]).toEqual(expected);
  }
});
