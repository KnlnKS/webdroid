import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();
const range = (lo: string, hi: string) => newObj("android/util/Range", "(Ljava/lang/Comparable;Ljava/lang/Comparable;)V", lo, hi);
test("ranges intersect, extend and clamp while preserving contained range identity", async () => {
  const outer = await range("a", "z"), inner = await range("c", "f");
  expect(await vcall(outer, "intersect", "(Landroid/util/Range;)Landroid/util/Range;", inner)).toBe(inner);
  expect(await vcall(inner, "extend", "(Landroid/util/Range;)Landroid/util/Range;", outer)).toBe(outer);
  expect(await vcall(inner, "clamp", "(Ljava/lang/Comparable;)Ljava/lang/Comparable;", "z")).toBe("f");
  expect(await vcall(inner, "contains", "(Ljava/lang/Comparable;)Z", "c")).toBe(1);
  expect(await vcall(inner, "contains", "(Landroid/util/Range;)Z", outer)).toBe(0);
  const overlap = await vcall(inner, "intersect", "(Landroid/util/Range;)Landroid/util/Range;", await range("e", "h"));
  expect(await vcall(overlap, "toString", "()Ljava/lang/String;")).toBe("[e, f]");
  expect(await vcall(overlap, "equals", "(Ljava/lang/Object;)Z", await range("e", "f"))).toBe(1);
  let error: unknown;
  try { await vcall(inner, "intersect", "(Landroid/util/Range;)Landroid/util/Range;", await range("k", "m")); } catch (e) { error = e; }
  expect(rt.iof(error, "java/lang/IllegalArgumentException")).toBe(1);
});
