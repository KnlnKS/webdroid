/**
 * The host's filesystem, as far as the browser will expose one: a directory the user picks
 * with the File System Access API. This is the only file that touches those APIs — everything
 * Android-facing sees `FileSystemDirectoryHandle` and nothing else.
 *
 * Where the API does not exist (Firefox, Safari, a headless Chromium with no one to click the
 * dialog) the same interface is served out of the Origin Private File System, so the code
 * above has one path rather than two. A user who *cancels* the real picker still gets null.
 */

// lib.dom types the handles but not the picker, the async iteration or the permission calls.
declare global {
  interface Window { showDirectoryPicker?(o?: { mode?: string; id?: string }): Promise<FileSystemDirectoryHandle> }
  interface FileSystemHandle {
    queryPermission?(o?: { mode?: string }): Promise<PermissionState>;
    requestPermission?(o?: { mode?: string }): Promise<PermissionState>;
  }
  interface FileSystemDirectoryHandle { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }
}

const DB = "webdroid", STORE = "roots";
const roots = new Map<string, FileSystemDirectoryHandle>();

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return idb().then((db) => new Promise<T>((res, rej) => {
    const r = run(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

/** Chrome only opens a picker, or re-grants a permission, while a user gesture is still warm.
 *  A request that arrives too late is parked and replayed on the next press rather than lost. */
let pending: (() => void)[] = [];
function onNextGesture(fn: () => void) {
  pending.push(fn);
  if (pending.length > 1) return;
  addEventListener("pointerdown", () => {
    const q = pending;
    pending = [];
    for (const f of q) f();
  }, { capture: true, once: true });
}

async function opfsRoot(name: string): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
}

/** The picked directory, or null if the user backed out. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const show = window.showDirectoryPicker;
  const open = show ? () => show.call(window, { mode: "readwrite", id: "webdroid" }) : () => opfsRoot("storage");
  let h: FileSystemDirectoryHandle | null = await open().catch(async (e: Error) =>
    // AbortError is the user cancelling; SecurityError means the gesture that led here had
    // already gone stale, so ask again on the next press rather than losing the request.
    e?.name === "SecurityError"
      ? new Promise<FileSystemDirectoryHandle>((res, rej) => onNextGesture(() => open().then(res, rej))).catch(() => null)
      : null);
  if (!h) return null;
  roots.set(h.name, h);
  await tx("readwrite", (s) => s.put(h!, h!.name)).catch(() => {});
  return h;
}

export const rootHandles = (): Map<string, FileSystemDirectoryHandle> => roots;

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

export async function clearRoots(): Promise<void> {
  roots.clear();
  await tx("readwrite", (s) => s.clear()).catch(() => {});
  // the OPFS stand-in is ours to empty; a directory the user picked is theirs, and stays
  const opfs = await navigator.storage?.getDirectory().catch(() => null);
  if (!opfs) return;
  for await (const [name] of opfs.entries()) await opfs.removeEntry(name, { recursive: true }).catch(() => {});
}
