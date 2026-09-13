import { expect, test } from "bun:test";
import { Arsc } from "../src/android/arsc";

function stringPool(text = ""): Uint8Array {
  const count = text ? 1 : 0;
  const size = 28 + count * 4 + (text ? 4 + text.length * 2 : 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, 28, true);
  view.setUint32(4, size, true);
  view.setUint32(8, count, true);
  view.setUint32(20, 28 + count * 4, true);
  if (text) {
    let pos = 32;
    view.setUint16(pos, text.length, true);
    pos += 2;
    for (const char of text) {
      view.setUint16(pos, char.charCodeAt(0), true);
      pos += 2;
    }
  }
  return bytes;
}

function packageChunk(typeName: string, key: string, entryIdx: number, typeId = 1, typeIdOffset = 0): Uint8Array {
  const types = stringPool(typeName);
  const keys = stringPool(key);
  const entriesStart = 84 + (entryIdx + 1) * 4;
  const type = new Uint8Array(entriesStart + 16);
  const tv = new DataView(type.buffer);
  tv.setUint16(0, 0x0201, true);
  tv.setUint16(2, 84, true);
  tv.setUint32(4, type.length, true);
  tv.setUint8(8, typeId);
  tv.setUint32(12, entryIdx + 1, true);
  tv.setUint32(16, entriesStart, true);
  tv.setUint32(20, 64, true);
  for (let i = 0; i < entryIdx; i++) tv.setUint32(84 + i * 4, 0xffffffff, true);
  tv.setUint16(entriesStart, 8, true);
  tv.setUint16(entriesStart + 8, 8, true);

  const packageSize = 288 + types.length + keys.length + type.length;
  const bytes = new Uint8Array(packageSize);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x0200, true);
  view.setUint16(2, 288, true);
  view.setUint32(4, packageSize, true);
  view.setUint32(8, 0x7f, true);
  view.setUint32(268, 288, true);
  view.setUint32(276, 288 + types.length, true);
  view.setUint32(284, typeIdOffset, true);
  bytes.set(types, 288);
  bytes.set(keys, 288 + types.length);
  bytes.set(type, 288 + types.length + keys.length);
  return bytes;
}

function resourceTable(...packages: Uint8Array[]): Uint8Array {
  const values = stringPool();
  const bytes = new Uint8Array(12 + values.length + packages.reduce((size, pkg) => size + pkg.length, 0));
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x0002, true);
  view.setUint16(2, 12, true);
  view.setUint32(4, bytes.length, true);
  view.setUint32(8, packages.length, true);
  bytes.set(values, 12);
  let pos = 12 + values.length;
  for (const pkg of packages) { bytes.set(pkg, pos); pos += pkg.length; }
  return bytes;
}

test("package type ID offsets apply to resource lookup", () => {
  const resources = new Arsc(resourceTable(packageChunk("id", "item", 0, 1, 9)));
  expect(resources.findId("id", "item")).toBe(0x7f0a0000);
  expect(resources.entry(0x7f0a0000)?.key).toBe("item");
});

test("resource names use the type pool of each package chunk", () => {
  const resources = new Arsc(resourceTable(
    packageChunk("string", "label", 0),
    packageChunk("id", "target", 1),
  ));
  expect(resources.findId("id", "target")).toBe(0x7f010001);
  expect(resources.typeName(1, 1)).toBe("id");
});
