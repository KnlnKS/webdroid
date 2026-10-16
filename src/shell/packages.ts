import { vfs } from "./vfs.ts";
import { openDb, txDone } from "./idb.ts";

let database: Promise<IDBDatabase> | null = null;
const store = () => database ??= openDb("webdroid-packages", "apks");
let restored: Promise<void> | null = null;
export function restorePackages(): Promise<void> {
  return restored ??= (async () => {
    if (typeof indexedDB === "undefined") return;
    const transaction = (await store()).transaction("apks", "readonly");
    const request = transaction.objectStore("apks").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (typeof cursor.key === "string" && cursor.value instanceof Uint8Array) vfs.write(cursor.key, cursor.value);
      cursor.continue();
    };
    await txDone(transaction);
  })();
}
export async function persistPackage(path: string, bytes: Uint8Array): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const transaction = (await store()).transaction("apks", "readwrite");
  transaction.objectStore("apks").put(bytes, path);
  await txDone(transaction);
}
export async function forgetPackage(path: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const transaction = (await store()).transaction("apks", "readwrite");
  transaction.objectStore("apks").delete(path);
  await txDone(transaction);
}
