import { expect, test } from "bun:test";
import { rt } from "../src/jvm/runtime";
import { handle, deref, release, ownedHandle } from "../src/android/handles";

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

test("a long field holding a stale or plain number claims no owned object", async () => {
  const prior = handle({});
  release(prior);
  let owned: object | undefined, h = 0n;
  for (let i = 0; i < 4096 && !h; i++) {
    const o = {}, candidate = ownedHandle(o);
    if ((candidate & BigInt(SLOT)) === (prior & BigInt(SLOT))) { owned = o; h = candidate; } else release(candidate);
  }
  expect(h).not.toBe(0n);
  // two Java objects that die at once, one holding the slot's previous long and one its bare number
  (() => { rt.claimHandle!({}, prior); rt.claimHandle!({}, BigInt(Number(h) & SLOT)); })();
  for (let i = 0; i < 5; i++) { Bun.gc(true); await new Promise((r) => setTimeout(r, 10)); }
  expect(deref<object>(h)).toBe(owned!);
  release(h);
});
