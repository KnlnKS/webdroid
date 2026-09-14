import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { newArrayList } from "../src/jvm/natives/jutil";
rt.linkNatives();

for (const name of ["ArrayBlockingQueue", "LinkedBlockingQueue", "LinkedBlockingDeque", "LinkedTransferQueue", "PriorityBlockingQueue"]) {
  test(`${name} drains a bounded prefix and then the remaining elements`, async () => {
    const queue = await newObj(`java/util/concurrent/${name}`, "(I)V", 8);
    for (const value of ["a", "b", "c"]) await vcall(queue, "offer", "(Ljava/lang/Object;)Z", value);
    const target = newArrayList(["existing"]);
    const drain = (max: number) => vcall(queue, "drainTo", "(Ljava/util/Collection;I)I", target, max);
    expect(await drain(-1)).toBe(0);
    expect(await drain(2)).toBe(2);
    expect(target.a).toEqual(["existing", "a", "b"]);
    expect(await vcall(queue, "peek", "()Ljava/lang/Object;")).toBe("c");
    expect(await vcall(queue, "drainTo", "(Ljava/util/Collection;)I", target)).toBe(1);
    expect(target.a).toEqual(["existing", "a", "b", "c"]);
    expect(await vcall(queue, "size", "()I")).toBe(0);
    expect(await drain(10)).toBe(0);
    expect(await vcall(queue, "drainTo", "(Ljava/util/Collection;I)I", null, 0).catch(e => rt.iof(e, "java/lang/NullPointerException"))).toBe(1);
    expect(await vcall(queue, "drainTo", "(Ljava/util/Collection;)I", queue).catch(e => rt.iof(e, "java/lang/IllegalArgumentException"))).toBe(1);
  });
}

test("draining calls suspending collection overrides and propagates failures", async () => {
  class Target extends JObj { values: unknown[] = []; fail = false; }
  rt.register({ name: "test/DrainTarget", ctor: Target, methods: {
    "add(Ljava/lang/Object;)Z": async function (this: Target, value: unknown) {
      await Promise.resolve();
      if (this.fail) throw rt.mkThrowable("java/lang/UnsupportedOperationException", null);
      this.values.push(value);
      return 1;
    },
  } });
  const queue = await newObj("java/util/concurrent/ArrayBlockingQueue", "(I)V", 8);
  const target = rt.make("test/DrainTarget");
  if (!(target instanceof Target)) throw new Error("Wrong target class");
  await vcall(queue, "offer", "(Ljava/lang/Object;)Z", "first");
  expect(await vcall(queue, "drainTo", "(Ljava/util/Collection;)I", target)).toBe(1);
  expect(target.values).toEqual(["first"]);
  target.fail = true;
  await vcall(queue, "offer", "(Ljava/lang/Object;)Z", "second");
  expect(await vcall(queue, "drainTo", "(Ljava/util/Collection;)I", target).catch(e => rt.iof(e, "java/lang/UnsupportedOperationException"))).toBe(1);
});
