import { expect, spyOn, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JDrawable } from "../src/android/drawable";

class Child extends JDrawable {
  drawn: number[] = [];
  async paint() { await Promise.resolve(); this.drawn.push(this.alpha); }
}
rt.register({ name: "test/TransitionChild", ctor: Child, sup: "android/graphics/drawable/Drawable", methods: {
  "draw(Landroid/graphics/Canvas;)V": function (this: Child) { return this.paint(); },
} });
rt.linkNatives();
test("transitions crossfade, reverse from the current alpha and restore child alpha", async () => {
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const a = rt.make("test/TransitionChild") as Child, b = rt.make("test/TransitionChild") as Child;
    const d = await newObj("android/graphics/drawable/TransitionDrawable", "([Landroid/graphics/drawable/Drawable;)V", [a, b]);
    const draw = () => vcall(d, "draw", "(Landroid/graphics/Canvas;)V", null);
    await vcall(d, "setCrossFadeEnabled", "(Z)V", 1);
    await vcall(d, "startTransition", "(I)V", 100);
    await draw(); now += 50; await draw();
    expect(a.drawn).toEqual([255, 128]); expect(b.drawn).toEqual([127]);
    expect([a.alpha, b.alpha]).toEqual([255, 255]);
    await vcall(d, "reverseTransition", "(I)V", 999);
    await draw(); now += 50; await draw();
    expect(a.drawn.at(-1)).toBe(255);
    expect(b.drawn).toEqual([127, 127]);
    await vcall(d, "startTransition", "(I)V", 100);
    await draw(); now += 100; await draw();
    expect(b.drawn.at(-1)).toBe(255);
    const count = b.drawn.length;
    await vcall(d, "resetTransition", "()V"); await draw();
    expect(b.drawn.length).toBe(count);
    expect(a.drawn.at(-1)).toBe(255);
  } finally { clock.mockRestore(); }
});
