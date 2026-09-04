import { describe, expect, test } from "bun:test";
import { Arsc } from "./arsc";

const config = (orientation: number, wdp = 0, hdp = 0) => ({
  density: 0, sdk: 0, orientation, night: 0, lang: "", swdp: 0, wdp, hdp,
  size: 0, dir: 0, uiType: 0, score: 0,
});

describe("resource orientation", () => {
  test("selects a retained -land entry after either axis swap", () => {
    const table: Arsc = Object.create(Arsc.prototype);
    table.pkgId = 0x7f;
    table.types = new Map();
    table.device = {
      density: 480, sdk: 35, orientation: 1, night: 0,
      wdp: 360, hdp: 808, swdp: 360, lang: "en", size: 2, dir: 0x40, uiType: 1,
    };
    table.types.set(1, [
      { id: 1, name: "string", config: config(0), entries: new Map([[0, { key: "mode", value: { type: 0x10, data: 1 } }]]) },
      { id: 1, name: "string", config: config(2, 700, 300), entries: new Map([[0, { key: "mode", value: { type: 0x10, data: 2 } }]]) },
    ]);

    expect(table.entry(0x7f010000)?.value?.data).toBe(1);
    Object.assign(table.device, { orientation: 2, wdp: 808, hdp: 360 });
    expect(table.entry(0x7f010000)?.value?.data).toBe(2);
    Object.assign(table.device, { orientation: 1, wdp: 360, hdp: 808 });
    expect(table.entry(0x7f010000)?.value?.data).toBe(1);
  });
});
