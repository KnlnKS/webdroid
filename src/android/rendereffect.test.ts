import { expect, test } from "bun:test";
import "../natives";
import { linkInit, newObj, vcall } from "../jvm/natives/jlang";
import { JRenderEffect } from "./rendereffect";

test("RenderNode retains, replaces, and clears platform render effects", async () => {
  const type = (await linkInit("android/graphics/RenderEffect")).ctor;
  const tiles = (await linkInit("android/graphics/Shader$TileMode")).ctor;
  const decal = await vcall(tiles, "valueOf", "(Ljava/lang/String;)Landroid/graphics/Shader$TileMode;", "DECAL");
  const blur = await vcall(type, "createBlurEffect", "(FFLandroid/graphics/Shader$TileMode;)Landroid/graphics/RenderEffect;", 8, 2, decal);
  expect(blur).toBeInstanceOf(JRenderEffect);
  expect(blur.effect).toEqual({ kind: "blur", x: 8, y: 2, tile: 3 });
  const node = await newObj("android/graphics/RenderNode", "(Ljava/lang/String;)V", "effect-test");
  const set = (effect: unknown) => vcall(node, "setRenderEffect", "(Landroid/graphics/RenderEffect;)Z", effect);
  expect(await set(blur)).toBe(1);
  expect(await set(blur)).toBe(0);
  expect(node.effect).toBe(blur);
  const offset = await vcall(type, "createOffsetEffect", "(FF)Landroid/graphics/RenderEffect;", 3, -4);
  expect(offset.effect).toEqual({ kind: "offset", x: 3, y: -4 });
  expect(await set(offset)).toBe(1);
  expect(await set(null)).toBe(1);
  expect(node.effect).toBeNull();
  await expect(vcall(type, "createBlurEffect", "(FFLandroid/graphics/Shader$TileMode;)Landroid/graphics/RenderEffect;", -1, 2, decal)).rejects.toBeDefined();
});
