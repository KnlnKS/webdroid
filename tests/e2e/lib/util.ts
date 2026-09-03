// Helpers every harness entry point was re-declaring.
export const E2E_DIR = new URL("..", import.meta.url).pathname;
/** the dev server every driver and script talks to; PLAN.md and AGENTS.md say use a private port */
export const BASE_URL = process.env.WEBDROID_URL ?? "http://localhost:4080";
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const sha1 = (buf: Uint8Array) => new Bun.CryptoHasher("sha1").update(buf).digest("hex");
