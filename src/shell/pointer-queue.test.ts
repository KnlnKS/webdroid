import { expect, test } from "bun:test";
import { queuePointer, type PointerSample } from "./pointer-queue";

const sample = (action: PointerSample["action"], at: number): PointerSample => ({ action, x: at, y: 0, at });

test("queued gestures retain both releases while consecutive moves coalesce", () => {
  const pending: PointerSample[] = [];
  for (const event of [sample(2, 1), sample(2, 2), sample(1, 3), sample(0, 4), sample(1, 5)]) {
    queuePointer(pending, event);
  }
  expect(pending.map(({ action, at }) => [action, at])).toEqual([[2, 2], [1, 3], [0, 4], [1, 5]]);
});
