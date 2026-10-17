import { expect, test } from "vite-plus/test";
import { queuePointer, type PointerSample } from "./pointer-queue.ts";

const sample = (action: number, x: number): PointerSample => ({ action, pointers: [{ id: 0, x, y: 0 }] });

test("queued gestures retain both releases while consecutive moves coalesce", () => {
  const pending: PointerSample[] = [];
  for (const event of [sample(2, 1), sample(2, 2), sample(1, 3), sample(0, 4), sample(1, 5)]) {
    queuePointer(pending, event);
  }
  expect(pending.map(({ action, pointers }) => [action, pointers[0].x])).toEqual([[2, 2], [1, 3], [0, 4], [1, 5]]);
});
