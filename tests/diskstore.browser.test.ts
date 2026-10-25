import { expect, test } from "vite-plus/test";
import { withPage } from "./browser.ts";

test("disk files read what was written before, a read in flight included", async () => {
  await withPage(["src/shell/diskstore.ts", "src/shell/disk-worker.ts"], async (page) => expect(await page.evaluate(async () => {
      const { DiskStore } = await import(location.origin + "/diskstore.js") as typeof import("../src/shell/diskstore.ts");
      const store = new DiskStore(), file = store.create();
      file.write(0, new Uint8Array(2 << 20).fill(1));
      const queued = Array.from(await file.read(8, 2)), at = (1 << 20) + 8;
      // the second chunk, not yet read, is read while a write changes it
      const reading = file.read(at, 2);
      file.write(at, Uint8Array.of(9, 9));
      const raced = Array.from(await reading), after = Array.from(await file.read(at, 2));
      file.truncate(16);
      const holds = [await store.holds(file.id, 16), await store.holds(file.id, 17)];
      await store.remove(file.id);
      const removed = await store.holds(file.id, 16);
      await store.clear();
      return { queued, raced, after, holds, removed };
    })).toEqual({ queued: [1, 1], raced: [1, 1], after: [9, 9], holds: [true, false], removed: false }));
}, 30_000);
