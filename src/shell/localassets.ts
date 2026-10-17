import { readFully } from "./lazyfile.ts";
import type { Install } from "./install.ts";
import { EXT_MIME } from "../mime.ts";

interface LocalAssetSession { key: string; install: Install }
let active: LocalAssetSession | null = null;

export function activateLocalAssets(session: LocalAssetSession | null): () => void {
  const previous = active;
  active = session;
  return () => { if (active === session) active = previous; };
}

export async function localAsset(path: unknown): Promise<{ status: number; bytes?: Uint8Array; type?: string }> {
  const match = typeof path === "string" ? /^\/asset\/([^/]+)\/(assets\/.*)$/.exec(path) : null;
  if (!match || !active || decodeURIComponent(match[1]) !== active.key) return { status: 404 };
  const entry = decodeURIComponent(match[2]);
  if (entry.split("/").includes("..")) return { status: 400 };
  const source = active.install.lazyEntries.get(entry);
  const bytes = active.install.zip[entry] ?? (source ? await readFully(source) : null);
  if (!bytes) return { status: 404 };
  const ext = entry.slice(entry.lastIndexOf(".") + 1).toLowerCase();
  const type = EXT_MIME[ext] ?? "application/octet-stream";
  return { status: 200, bytes, type };
}
