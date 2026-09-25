import { expect, test } from "bun:test";
import "../src/natives";
import { newObj, vcall } from "../src/jvm/natives/jlang";

test("ArrayAdapter keeps a supplied List live", async () => {
  const list = await newObj("java/util/ArrayList", "()V");
  const adapter = await newObj("android/widget/ArrayAdapter", "(Landroid/content/Context;ILjava/util/List;)V", null, 0, list);
  await vcall(list, "add", "(Ljava/lang/Object;)Z", "first");
  expect(await vcall(adapter, "getCount", "()I")).toBe(1);
  expect(await vcall(adapter, "getItem", "(I)Ljava/lang/Object;", 0)).toBe("first");
  await vcall(adapter, "add", "(Ljava/lang/Object;)V", "second");
  expect(await vcall(list, "size", "()I")).toBe(2);
  await vcall(adapter, "clear", "()V");
  expect(await vcall(list, "size", "()I")).toBe(0);
});
