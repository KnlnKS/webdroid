// Upload the frontend and assets to Pages; the OCI backend is deployed separately.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const branch = process.env.CF_PAGES_BRANCH ?? process.env.GITHUB_HEAD_REF ?? execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
if (!branch) throw new Error("A branch name is required to deploy");
const output = join(mkdtempSync(join(tmpdir(), "webdroid-deploy-")), "wrangler.ndjson");
const result = spawnSync("pnpm", ["exec", "wrangler", "pages", "deploy", "dist", "--project-name", process.env.CLOUDFLARE_PAGES_PROJECT ?? "webdroid", "--branch", branch], {
  stdio: "inherit", env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: output },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const deployed = readFileSync(output, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string; alias?: string })
  .find(({ type }) => type === "pages-deploy-detailed");
if (branch !== "main" && deployed?.alias) await reportDeployment(deployed.alias);

// The Pages project has no Git integration, so a GitHub deployment is what puts the preview's link on the branch's PRs.
async function reportDeployment(url: string) {
  const token = process.env.GITHUB_TOKEN, ref = process.env.GITHUB_SHA ?? process.env.CF_PAGES_COMMIT_SHA;
  if (!token || !ref) return console.log("No GITHUB_TOKEN or GITHUB_SHA or CF_PAGES_COMMIT_SHA: the preview is not reported to GitHub");
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
