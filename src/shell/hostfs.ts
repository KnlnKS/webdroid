/**
 * The host's filesystem, as far as the browser will expose one: a directory the user picks
 * with the File System Access API. This is the only file that touches those APIs — everything
 * Android-facing sees `FileSystemDirectoryHandle` and nothing else.
 *
 * Where the API does not exist (Firefox, Safari), the same interface is served out of the
 * Origin Private File System, so the code above has one path rather than two. A user who *cancels* the real picker still gets null.
 */

import { openDb } from "./idb.ts";
import { hostUi, onNextGesture, type FilePick } from "./host-ui.ts";
import { gone } from "./diskstore.ts";

// lib.dom types the handles but not the async iteration or the permission calls.
declare global {
  interface FileSystemHandle {
    queryPermission?(o?: { mode?: string }): Promise<PermissionState>;
    requestPermission?(o?: { mode?: string }): Promise<PermissionState>;
  }
  interface FileSystemDirectoryHandle { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }
}

const roots = new Map<string, FileSystemDirectoryHandle>();

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb("webdroid", "roots").then((db) => new Promise<T>((res, rej) => {
    const r = run(db.transaction("roots", mode).objectStore("roots"));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

async function opfsRoot(name: string): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
}

/** The picked directory, or null if the user backed out. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picked = await hostUi().pickDirectory(), h = picked === undefined ? await opfsRoot("storage") : picked;
  if (!h) return null;
  roots.set(h.name, h);
  await tx("readwrite", (s) => s.put(h, h.name)).catch(() => {});
  return h;
}

export const rootHandles = (): Map<string, FileSystemDirectoryHandle> => roots;

/** One or more files the user chose, or null if they backed out. `save` asks for a new one. */
export async function pickFiles(pick: FilePick): Promise<FileSystemFileHandle[] | null> {
  const picked = await hostUi().pickFiles(pick);
  return picked === undefined ? opfsPicked(pick.save) : picked;
}
/** Without a dialog the stand-in is a file in OPFS: a save gets the name it asked for, and an
 *  open can only offer what is already there. */
async function opfsPicked(save?: string): Promise<FileSystemFileHandle[] | null> {
  const dir = await opfsRoot("files");
  if (save) return [await dir.getFileHandle(save, { create: true })];
  const out: FileSystemFileHandle[] = [];
  for await (const [, h] of dir.entries()) if (h.kind === "file") out.push(h as FileSystemFileHandle);
  return out.length ? out.slice(0, 1) : null;
}

/** Re-adopt the directories a previous session picked. Chrome may have downgraded the grant to
 *  "prompt", and only a gesture can lift that, so the ask rides the next press. */
export async function restoreRoots(): Promise<void> {
  const saved = await tx<FileSystemDirectoryHandle[]>("readonly", (s) => s.getAll()).catch(() => []);
  for (const h of saved) {
    roots.set(h.name, h);
    if (await h.queryPermission?.({ mode: "readwrite" }) !== "granted") {
      onNextGesture(() => void h.requestPermission?.({ mode: "readwrite" }));
    }
  }
}

/** the OPFS directory of the Wasm tier's compiled app code (src/wasm/host/persist.ts): not user data, so a reset keeps it */
export const COMPILED_CODE_DIR = "wd-wasm-apps";

export async function clearRoots(): Promise<void> {
  roots.clear();
  await tx("readwrite", (s) => s.clear()).catch(() => {});
  // the OPFS stand-in is ours to empty; a directory the user picked is theirs, and stays
  const opfs = await navigator.storage?.getDirectory().catch(() => null);
  if (!opfs) return;
  for await (const [name] of opfs.entries()) if (name !== COMPILED_CODE_DIR) await opfs.removeEntry(name, { recursive: true }).catch(gone);
}
