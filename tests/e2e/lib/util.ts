// Helpers every harness entry point was re-declaring.
import { stableFrame } from "./settle";
export const E2E_DIR = new URL("..", import.meta.url).pathname;
export const BASE_URL = process.env.WEBDROID_URL ?? "http://localhost:4080";
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run items `jobs` at a time, heaviest first. A thrown item becomes its `failed` result, so one
 *  broken flow never discards the others' captures. Results arrive in completion order. */
export async function runQueue<T, R>(items: T[], jobs: number, weight: (item: T) => number,
  run: (item: T) => Promise<R>, failed: (item: T, error: unknown) => R, done: (result: R) => void = () => {}): Promise<R[]> {
  const queue = [...items].sort((a, b) => weight(b) - weight(a));
  const results: R[] = [];
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const result = await run(item).catch((error: unknown) => failed(item!, error));
      results.push(result);
      done(result);
    }
  }));
  return results;
}
export const sha1 = (buf: Uint8Array) => new Bun.CryptoHasher("sha1").update(buf).digest("hex");

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
