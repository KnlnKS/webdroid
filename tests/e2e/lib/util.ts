// Helpers every harness entry point was re-declaring.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stableFrame } from "./settle.ts";
export const E2E_DIR = new URL("..", import.meta.url).pathname;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const readJson = async (path: string | URL) => JSON.parse(await readFile(path, "utf8"));

/** `run` over items, `jobs` at a time and heaviest first; results keep the items' order. */
export async function runQueue<T, R>(items: T[], jobs: number, weight: (item: T) => number, run: (item: T) => Promise<R>): Promise<R[]> {
  const queue = items.map((item, index) => ({ item, index })).sort((a, b) => weight(b.item) - weight(a.item));
  const results: R[] = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) results[next.index] = await run(next.item);
  }));
  return results;
}
export const sha1 = (buf: Uint8Array) => createHash("sha1").update(buf).digest("hex");


/**
 * Wait until `capture` stops returning new frames, on the contract lib/settle.ts defines over
 * samples taken every `intervalMs`. A timeout is recorded, never thrown.
 */
export async function settleOn(
  capture: () => Promise<Buffer>,
  { stableFrames = 4, intervalMs = 250, timeoutMs = 20_000 } = {},
): Promise<{ png: Buffer; timedOut: boolean }> {
  const t0 = Date.now();
  const hashes: string[] = [];
  const frames = new Map<string, Buffer>();
  let png = await capture();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(intervalMs);
    png = await capture();
    const h = sha1(png);
    frames.set(h, png);
    hashes.push(h);
    if (hashes.length > stableFrames * 2) {
      const gone = hashes.shift()!;
      if (!hashes.includes(gone)) frames.delete(gone);
    }
    const settled = stableFrame(hashes, stableFrames);
    if (settled !== undefined) return { png: frames.get(settled)!, timedOut: false };
  }
  return { png, timedOut: true };
}
