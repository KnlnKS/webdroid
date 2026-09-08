import { vfs } from "../jvm/natives/jio";

let database: Promise<IDBDatabase> | null = null;
function store(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("webdroid-packages", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("apks");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
let restored: Promise<void> | null = null;
export function restorePackages(): Promise<void> {
  return restored ??= (async () => {
    if (typeof indexedDB === "undefined") return;
    const db = await store();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("apks", "readonly");
      const request = transaction.objectStore("apks").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (typeof cursor.key === "string" && cursor.value instanceof Uint8Array)
          vfs.write(cursor.key, cursor.value);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  })();
}
export async function persistPackage(path: string, bytes: Uint8Array): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await store();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("apks", "readwrite");
    transaction.objectStore("apks").put(bytes, path);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
