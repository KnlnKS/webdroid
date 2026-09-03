import { expect, test } from "bun:test";
import { dexesIn } from "./dex";

// A v41 container: several logical dex in one physical file, with every section offset relative
// to the CONTAINER rather than to the header it was read from. A reader that assumes one header
// sees only the first classes' worth and silently misses the rest.
function container(versions: string, names: string[]): Uint8Array {
  const HDR = 120, SLOT = 160;                       // header + 40 bytes of that dex's own data
  const buf = new Uint8Array(SLOT * names.length);
  const v = new DataView(buf.buffer);
  names.forEach((name, i) => {
    const h = i * SLOT, data = h + HDR;
    buf.set([0x64, 0x65, 0x78, 0x0a, ...versions.split("").map((c) => c.charCodeAt(0)), 0], h);
    v.setUint32(h + 32, SLOT, true);                 // file_size: this logical dex
    v.setUint32(h + 36, HDR, true);                  // header_size
    v.setUint32(h + 56, 1, true);                    // string_ids_size
    v.setUint32(h + 60, data, true);                 // string_ids_off — container-relative
    v.setUint32(h + 112, buf.length, true);          // container_size
    v.setUint32(h + 116, h, true);                   // header_offset
    v.setUint32(data, data + 8, true);               // string_id[0] -> string_data_item
    buf[data + 8] = name.length;                     // uleb utf16_size
    buf.set(new TextEncoder().encode(name), data + 9);
  });
  return buf;
}

test("a v41 container yields every logical dex, reading container-relative offsets", () => {
  const dexes = dexesIn(container("041", ["alpha", "beta", "gamma"]), "classes.dex");
  expect(dexes.length).toBe(3);
  expect(dexes.map((d) => d.headerOff)).toEqual([0, 160, 320]);
  expect(dexes.map((d) => d.string(0))).toEqual(["alpha", "beta", "gamma"]);
  expect(dexes.map((d) => d.name)).toEqual(["classes.dex", "classes.dex!1", "classes.dex!2"]);
});

test("a pre-container dex is one logical dex whatever follows it", () => {
  const dexes = dexesIn(container("039", ["alpha", "beta"]), "classes.dex");
  expect(dexes.length).toBe(1);
  expect(dexes[0].string(0)).toBe("alpha");
});
