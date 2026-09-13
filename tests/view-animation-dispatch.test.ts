import { expect, test } from "bun:test";
import "../src/natives";
import { uiState } from "../src/android/view";
import { mangleMethod } from "../src/jvm/abi";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { onMain } from "../src/android/mainloop";

rt.linkNatives();

test("view animation frames dispatch through getTransformation overrides", async () => {
  const animation = await newObj("android/view/animation/AlphaAnimation", "(FF)V", 0, 1);
  await vcall(animation, "setDuration", "(J)V", 0n);
  const twoArgs = mangleMethod("getTransformation", "(JLandroid/view/animation/Transformation;)Z");
  const threeArgs = mangleMethod("getTransformation", "(JLandroid/view/animation/Transformation;F)Z");
  const prototype = rt.link("android/view/animation/Animation").ctor.prototype;
  let twoArgCalls = 0, threeArgCalls = 0;
  animation[twoArgs] = async function (now: bigint, transformation: unknown) {
    twoArgCalls++;
    return await prototype[twoArgs].call(this, now, transformation);
  };
  animation[threeArgs] = async function (now: bigint, transformation: unknown, scale: number) {
    threeArgCalls++;
    return await prototype[threeArgs].call(this, now, transformation, scale);
  };

  const view = await newObj("android/view/View", "(Landroid/content/Context;)V", null);
  const existing = new Set(uiState.animHooks);
  await vcall(view, "startAnimation", "(Landroid/view/animation/Animation;)V", animation);
  const hook = [...uiState.animHooks].find((candidate) => !existing.has(candidate));
  expect(hook).toBeDefined();
  hook!();
  await onMain(() => {});

  expect(threeArgCalls).toBe(1);
  expect(twoArgCalls).toBe(1);
  expect(await vcall(view, "getAnimation", "()Landroid/view/animation/Animation;")).toBeNull();
  uiState.animHooks.delete(hook!);
});
