// pnpm release: deploys dist/ (pnpm build:prod) from one build. main deploys the backend Worker, then the page to Pages' production;
// another branch deploys a Pages preview first, whose alias then names the Worker preview its Function forwards to.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const branch = process.env.WORKERS_CI_BRANCH ?? execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
if (!branch) throw new Error("A branch name is required to deploy");
const output = join(mkdtempSync(join(tmpdir(), "webdroid-deploy-")), "wrangler.ndjson");
const wrangler = (...args: string[]) => {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], { stdio: "inherit", env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: output } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const worker = ["-c", "worker/wrangler.jsonc"];
if (branch === "main") {
  wrangler("deploy", ...worker, "--env=");
  wrangler("pages", "deploy", "--branch", branch);
} else {
  wrangler("pages", "deploy", "--branch", branch);
  const deployed = readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; alias?: string })
    .find(({ type }) => type === "pages-deploy-detailed");
  const alias = deployed?.alias && new URL(deployed.alias).hostname.split(".")[0];
  if (!alias) throw new Error("Pages gave the deployment no alias");
  wrangler("preview", ...worker, "--name", alias, "--var", `PREVIEW_ALIAS:${alias}`);
}
