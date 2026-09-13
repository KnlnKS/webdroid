import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { parsePackageArchive } from "../src/android/packagearchive";
import { JTypedArray } from "../src/android/res";
import { TV } from "../src/android/axml";

rt.linkNatives();

test("TypedArray resolves referenced font resources", async () => {
  const bytes = new Uint8Array(await Bun.file("apks/Resy.apk").arrayBuffer());
  const archive = await parsePackageArchive(bytes);
  const id = archive.res.idFor("font", "fontawesome", archive.pkg);
  expect(id).not.toBe(0);
  const typed = new JTypedArray();
  typed.res = archive.res;
  typed.vals = [{ t: TV.REFERENCE, d: id }];
  expect(await vcall(typed, "getFont", "(I)Landroid/graphics/Typeface;", 0)).not.toBeNull();
  typed.vals = [null];
  expect(await vcall(typed, "getFont", "(I)Landroid/graphics/Typeface;", 0)).toBeNull();
});
