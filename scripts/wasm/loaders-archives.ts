// The loaders suite's archives: an APK's secondary DEX precedence, the DEX identity of the app's own archive and of another one, and a packed
// archive read for its DEX entries alone.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { BytesFile } from "../../src/shell/lazyfile.ts";
import { vfs } from "../../src/shell/vfs.ts";
import { PackedArchive, appArchives, packedArchives, sha256 } from "../../src/shell/packedarchive.ts";
import { openDexes } from "../../src/wasm/host/boot.ts";
import { world } from "./lib.ts";
import { loadDexes } from "../dexes.ts";
import { natives } from "./harness.ts";
import { PLATFORM_PATHS } from "../aosp.ts";
import type { Suite } from "./tools.ts";

/** `app`, `a` and `b` are the suite's dexes; `out` takes the APK built of them */
export async function archives({ check, fail }: Suite, out: string, app: string, a: string, b: string): Promise<void> {
  const bytes = (path: string) => new Uint8Array(readFileSync(path)), apk = join(out, "ordered.apk");
  writeFileSync(apk, zipSync({ "classes10.dex": bytes(b), "classes2.dex": bytes(a), "classes1000.dex": bytes(b), "classes.dex": bytes(app) }));
  const ordered = world([apk, ...PLATFORM_PATHS], { natives });
  check("APK secondary DEX precedence", ordered.entry("Shared", "tag", "()I")(ordered.entry("Shared", "make", "()LShared;")()), 1);

  const ownPath = "/data/app/loader-own/base.apk", otherPath = "/data/app/loader-other/base.apk", ownDexes = loadDexes(a);
  const opened = new Map<string, ReturnType<typeof openDexes>>();
  appArchives.add(ownPath);
  vfs.mount(otherPath, new BytesFile(zipSync({ "classes.dex": bytes(b) })));
  try {
    if (openDexes(ownPath, ownDexes, opened) !== ownDexes) fail("own archive lost DEX identity");
    const other = await openDexes(otherPath, ownDexes, opened);
    if (!other || other === ownDexes || other[0].id === ownDexes[0].id || await openDexes(otherPath, ownDexes, opened) !== other) fail("another APK aliased the app's DEX or lost its cached identity");
  } finally { appArchives.delete(ownPath); }

  const path = "/data/app/loader-packed/base.apk", first = bytes(a), second = bytes(b);
  const zip = zipSync({ "classes2.dex": second, "classes.dex": first, "assets/unused": new Uint8Array([1, 2, 3]) });
  const files = new Map<string, Uint8Array>(), requests: string[] = [], fetchBefore = globalThis.fetch;
  const file = async (bytes: Uint8Array) => { const hash = await sha256(bytes), name = `${hash}.bin`; files.set(`/packed-loader/${name}`, bytes); return { file: name, size: bytes.length, sha256: hash }; };
  const bootstrap = await file(zipSync({ "AndroidManifest.xml": new Uint8Array([0]) })), one = await file(first), two = await file(second), raw = await file(zip);
  const packed = new PackedArchive({ version: 1, pkg: "loader-packed", sha256: raw.sha256, size: zip.length, certificates: [], bootstrap,
    entries: { "classes2.dex": two, "classes.dex": one }, spans: [[0, zip.length, raw.file, 0]] }, "/packed-loader/");
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input), bytes = files.get(url.split("?")[0]); requests.push(url);
    if (!bytes) throw new Error(`unexpected packed fixture request: ${url}`);
    return new Response(new Uint8Array(bytes).buffer);
  }) as typeof fetch;
  packedArchives.set(path, packed); vfs.mount(path, packed);
  try {
    const result = await openDexes(path, ownDexes, opened);
    check("packed DEX precedence", result?.map(d => d.id).join(), [...loadDexes(a), ...loadDexes(b)].map(d => d.id).join());
    if (requests.some(url => url.includes("?raw=")) || requests.length !== 3) fail("packed loader read the whole archive instead of its DEX entries");
    if (await openDexes(path, ownDexes, opened) !== result || requests.length !== 3) fail("packed DEX cache lost identity");
    console.log("packed loader: ordered DEX entries and bootstrap only; cached identity preserved");
  } finally { globalThis.fetch = fetchBefore; packedArchives.delete(path); vfs.delete(path, false); }
}
