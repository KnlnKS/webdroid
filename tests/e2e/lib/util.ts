// Helpers every harness entry point was re-declaring.
export const E2E_DIR = new URL("..", import.meta.url).pathname;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const sha1 = (buf: Uint8Array) => new Bun.CryptoHasher("sha1").update(buf).digest("hex");
