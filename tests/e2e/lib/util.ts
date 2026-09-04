// Helpers every harness entry point was re-declaring.
export const E2E_DIR = new URL("..", import.meta.url).pathname;
export const BASE_URL = process.env.WEBDROID_URL ?? "http://localhost:4080";
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const sha1 = (buf: Uint8Array) => new Bun.CryptoHasher("sha1").update(buf).digest("hex");

/**
 * Wait until `capture` stops returning new frames. A focused EditText blinks its caret on a
 * 530ms cycle, so those screens never produce N identical frames however long we wait: a
 * settled OSCILLATION between exactly two frames counts as settled, and the more frequent one
 * is returned so the capture is deterministic rather than whichever phase we sampled.
 */
export async function settleOn(
  capture: () => Promise<Buffer>,
  { stableFrames = 4, intervalMs = 250, timeoutMs = 20_000 } = {},
): Promise<{ png: Buffer; timedOut: boolean }> {
  const t0 = Date.now();
  let last = "", stable = 0;
  const win = stableFrames * 2;
  const recent: { h: string; png: Buffer }[] = [];
  const oscillation = () => {
    if (recent.length < win) return null;
    const tally = new Map<string, { png: Buffer; n: number }>();
    for (const r of recent) {
      const e = tally.get(r.h);
      if (e) e.n++; else tally.set(r.h, { png: r.png, n: 1 });
    }
    if (tally.size !== 2) return null;
    const [a, b] = [...tally.values()];
    if (a.n < 2 || b.n < 2) return null;
    return (a.n >= b.n ? a : b).png;
  };
  let png = await capture();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(intervalMs);
    png = await capture();
    const h = sha1(png);
    recent.push({ h, png });
    if (recent.length > win) recent.shift();
    stable = h === last ? stable + 1 : 0;
    last = h;
    const osc = oscillation();
    if (osc) return { png: osc, timedOut: false };
    if (stable >= stableFrames) return { png, timedOut: false };
  }
  return { png, timedOut: true };
}
