// pnpm release: deploys dist/ (pnpm build:prod) from one build. main deploys the backend Worker, then the page to Pages' production;
// another branch deploys a Pages preview, then the Worker preview its Function forwards to, named by the branch's alias.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  // Pages' alias for the branch, written into each deployment because its unique host does not name the branch (functions/)
  const alias = branch.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 28).replace(/-+$/, "");
  writeFileSync("dist/preview-alias.txt", alias);
  wrangler("pages", "deploy", "--branch", branch);
  const deployed = readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; alias?: string })
    .find(({ type }) => type === "pages-deploy-detailed");
  wrangler("preview", ...worker, "--name", alias, "--var", `PREVIEW_ALIAS:${alias}`);
  await reportDeployment(deployed?.alias ?? `https://${alias}.webdroid.pages.dev`);
}

// The Pages project has no Git integration, so a GitHub deployment is what puts the preview's link on the branch's PRs.
async function reportDeployment(url: string) {
  const token = process.env.GITHUB_TOKEN, ref = process.env.WORKERS_CI_COMMIT_SHA;
  if (!token || !ref) return console.log("No GITHUB_TOKEN or WORKERS_CI_COMMIT_SHA: the preview is not reported to GitHub");
  const github = async (path: string, body: object) => {
    const response = await fetch(`https://api.github.com/repos/KnlnKS/webdroid${path}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "webdroid-deploy" },
    });
    if (!response.ok) throw new Error(`GitHub ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ id: number }>;
  };
  // A failed report leaves a working deployment, so it warns rather than failing the build.
  try {
    const { id } = await github("/deployments", { ref, environment: `Preview (${branch})`, auto_merge: false, required_contexts: [], transient_environment: true });
    await github(`/deployments/${id}/statuses`, { state: "success", environment_url: url, auto_inactive: true });
    console.log(`Reported ${url} to GitHub`);
  } catch (error) {
    console.warn(`The preview was not reported to GitHub: ${error}`);
  }
}
