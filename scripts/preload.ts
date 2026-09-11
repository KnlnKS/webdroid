// Build what bun entry points load before any of them does: the wasm core and the vendored
// sql.js. Each is a no-op once its output exists.
import { existsSync } from "node:fs";
import { ensureCore } from "./build-core";

const sqljs = new URL("../vendor/sql.js/", import.meta.url).pathname;

async function ensureSqlJs(): Promise<void> {
  // rebuild.sh swaps dist/ in whole, so its presence means a complete build
  if (existsSync(sqljs + "dist")) return;
  if (await Bun.spawn(["sh", sqljs + "rebuild.sh"], { stdio: ["ignore", "inherit", "inherit"] }).exited !== 0) {
    throw new Error("vendor/sql.js/rebuild.sh failed");
  }
}

await Promise.all([ensureCore(), ensureSqlJs()]);
