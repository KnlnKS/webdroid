import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { JThread, mainThread, setCurThread, newObj, vcall } from "../src/jvm/natives/jlang";
class BarrierAction extends JObj { calls = 0; }
rt.register({ name: "test/BarrierAction", ctor: BarrierAction, ifaces: ["java/lang/Runnable"], methods: {
  "run()V": async function (this: BarrierAction) { await Bun.sleep(1); this.calls++; },
} });
rt.linkNatives();
const wait = (barrier: unknown, thread: JThread, duration?: bigint) => {
  setCurThread(thread);
  const result = duration === undefined ? vcall(barrier, "await", "()I") : vcall(barrier, "await", "(JLjava/util/concurrent/TimeUnit;)I", duration, rt.link("java/util/concurrent/TimeUnit").ctor.s$MILLISECONDS);
  setCurThread(mainThread); return result;
};
test("CyclicBarrier releases every generation after the suspendable action", async () => {
  const action = await newObj("test/BarrierAction");
  const barrier = await newObj("java/util/concurrent/CyclicBarrier", "(ILjava/lang/Runnable;)V", 2, action);
  for (let i = 0; i < 2; i++) {
    const first = wait(barrier, new JThread());
    const second = wait(barrier, new JThread());
    expect(await Promise.all([first, second])).toEqual([1, 0]);
    expect(action.calls).toBe(i + 1);
  }
});
test("timeout and interruption break peers until reset", async () => {
  const barrier = await newObj("java/util/concurrent/CyclicBarrier", "(I)V", 3);
  const peer = wait(barrier, new JThread()).catch((e: unknown) => e);
  await expect(wait(barrier, new JThread(), 1n)).rejects.toMatchObject({ constructor: rt.link("java/util/concurrent/TimeoutException").ctor });
  expect(await peer).toMatchObject({ constructor: rt.link("java/util/concurrent/BrokenBarrierException").ctor });
  await vcall(barrier, "reset", "()V");
  expect(await vcall(barrier, "isBroken", "()Z")).toBe(0);
  const thread = new JThread();
  const interrupted = wait(barrier, thread).catch((e: unknown) => e);
  await vcall(thread, "interrupt", "()V");
  expect(await interrupted).toMatchObject({ constructor: rt.link("java/lang/InterruptedException").ctor });
  expect(await vcall(barrier, "isBroken", "()Z")).toBe(1);
});
