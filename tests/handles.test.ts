import { expect, test } from "vite-plus/test";
import "../src/natives.ts";
import { declaredField } from "../src/jvm/runtime.ts";
import { newObj } from "../src/jvm/natives/jentry.ts";
import { handle, deref, release } from "../src/android/handles.ts";

const SLOT = 0xffffff;

test("a released long names nothing, not its slot's next occupant", () => {
  const first = {}, stale = handle(first);
  release(stale);
  // released slots come back only once enough later releases queue behind them
  let next: object | undefined, reused = 0n;
  for (let i = 0; i < 4096 && !reused; i++) {
    const o = {}, h = handle(o);
    if ((h & BigInt(SLOT)) === (stale & BigInt(SLOT))) { next = o; reused = h; } else release(h);
  }
  expect(reused).not.toBe(0n);
  expect(reused).not.toBe(stale);
  expect(deref(stale)).toBeUndefined();
  expect(deref(BigInt(Number(stale) & SLOT))).toBeUndefined();
  release(stale);
  expect(deref<object>(reused)).toBe(next!);
  release(reused);
});

// Camera's constructor native stores its native state's long from the host; as with a long a Java
// constructor stores, the state goes once its owner is collected
test("the native state a native stores for its receiver goes with the receiver", async () => {
  const cls = "android/graphics/Camera";
  const h = await (async () => (await newObj(cls, "()V") as Record<string, bigint>)[declaredField(cls, "native_instance")])();
  expect(deref(h)).toBeDefined();
  for (let i = 0; i < 20 && deref(h) !== undefined; i++) { globalThis.gc?.(); await new Promise((r) => setTimeout(r, 10)); }
  expect(deref(h)).toBeUndefined();
});
