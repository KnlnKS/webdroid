// State the tab's realms share. Process realms are same-origin frames of one page on one thread,
// so what is immutable, or only ever used from that thread, can live once on the page.

const local = new Map<keyof Window, unknown>();

/** Observe an existing owner without running its initialization factory. */
export function peekPageShared<K extends keyof Window>(key: K): Window[K] | undefined {
  if (typeof window === "undefined") return local.get(key) as Window[K] | undefined;
  let root: Window = window;
  try { if (window.parent.location.origin === location.origin) root = window.parent; } catch { /* another origin */ }
  return root[key];
}

/** `key` on the page, made by the first realm to ask; a realm outside a page (a worker, a test, a
 *  page embedded in another origin) keeps its own */
export function pageShared<K extends keyof Window>(key: K, make: () => NonNullable<Window[K]>): NonNullable<Window[K]> {
  if (typeof window === "undefined") {
    if (!local.has(key)) local.set(key, make());
    return local.get(key) as NonNullable<Window[K]>;
  }
  let root: Window = window;
  try { if (window.parent.location.origin === location.origin) root = window.parent; } catch { /* another origin */ }
  return (root[key] ??= make()) as NonNullable<Window[K]>;
}
