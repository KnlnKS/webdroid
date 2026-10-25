// Helpers every harness entry point was re-declaring.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
export const E2E_DIR = new URL("..", import.meta.url).pathname;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const readJson = async (path: string | URL) => JSON.parse(await readFile(path, "utf8"));

export const sha1 = (buf: Uint8Array) => createHash("sha1").update(buf).digest("hex");
