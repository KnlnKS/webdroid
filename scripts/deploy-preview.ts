import { execFileSync, spawnSync } from "node:child_process";
import { branchAlias } from "../worker/preview.ts";

const branch = process.env.WORKERS_CI_BRANCH ?? execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
if (!branchAlias(branch)) throw new Error("A branch name is required to deploy a preview");
const result = spawnSync("pnpm", ["exec", "wrangler", "preview", "--name", branchAlias(branch), "--var", `PREVIEW_BRANCH:${branch}`], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
