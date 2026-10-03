// Build what bun entry points load before any of them does: the wasm core, the WebView renderer's
// programs and the vendored sql.js. Each is a no-op once its output exists.
import { existsSync, readFileSync } from "node:fs";
import { ensureCore } from "./build-core";
import { ensureWebPages } from "./build-web";

const sqljs = new URL("../vendor/sql.js/", import.meta.url).pathname;

async function ensureSqlJs(): Promise<void> {
  // rebuild.sh swaps dist/ in whole with the patch it applied, so a matching copy means a complete build
  const built = sqljs + "dist/sqljs.patch";
  if (existsSync(built) && readFileSync(built, "utf8") === readFileSync(sqljs + "sqljs.patch", "utf8")) return;
  if (await Bun.spawn(["sh", sqljs + "rebuild.sh"], { stdio: ["ignore", "inherit", "inherit"] }).exited !== 0) {
    throw new Error("vendor/sql.js/rebuild.sh failed");
  }
}

await Promise.all([ensureCore(), ensureWebPages(), ensureSqlJs()]);
