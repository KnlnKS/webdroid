// pnpm release [--branch name]: ships what pnpm build:prod built. main deploys the backend to its VM (Pulumi's outputs, or WEBDROID_DEPLOYMENT
// where Pulumi's state is not at hand), then the page to Pages' production; another branch publishes a Pages preview, which uses that backend.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "./args.ts";
import { bundle } from "./bundle.ts";
import { withSshAccess } from "./firewall.ts";

const { values } = cli("pnpm release [--branch name]", { branch: { type: "string" } });
const branch = values.branch ?? process.env.GITHUB_REF_NAME ?? execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
if (!branch) throw new Error("A branch name is required to release");
const run = (command: string, ...args: string[]) => execFileSync(command, args, { stdio: "inherit" });
const wrangler = (...args: string[]) => run("pnpm", "exec", "wrangler", ...args);

/** where each file the backend runs with goes on the VM, and as whose */
const FILES = [["server.mjs", "/opt/webdroid/server.mjs", "-o webdroid -g webdroid -m 644"], ["webdroid.env", "/etc/webdroid.env", "-m 644"],
  ["Caddyfile", "/etc/caddy/Caddyfile", "-m 644"]] as const;

/** installs the backend from `work` and waits for its HTTPS health; one that does not come up is replaced by the files it replaced */
async function deployBackend(work: string): Promise<void> {
  const { publicIp, backendOrigin, frontendOrigin } = JSON.parse(process.env.WEBDROID_DEPLOYMENT
    ?? execFileSync(process.env.PULUMI_BIN ?? "pulumi", ["-C", "infra", "stack", "output", "--json"], { encoding: "utf8" })) as Record<string, string>;
  if (!isIPv4(publicIp)) throw new Error("Missing instance IP; run pulumi up first");
  if ([backendOrigin, frontendOrigin].some((origin) => URL.parse(origin)?.protocol !== "https:" || new URL(origin).origin !== origin)) throw new Error("Invalid deployment origin");
  const key = process.env.WEBDROID_SSH_KEY, knownHosts = process.env.WEBDROID_SSH_KNOWN_HOSTS;
  if (!key) throw new Error("Set WEBDROID_SSH_KEY to the private SSH key matching infra's sshPublicKeyPath");
  const target = `ubuntu@${publicIp}`, options = ["-i", key, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=15",
    "-o", `StrictHostKeyChecking=${knownHosts ? "yes" : "accept-new"}`, ...knownHosts ? ["-o", `UserKnownHostsFile=${knownHosts}`] : []];
  const ssh = (...commands: string[]) => run("ssh", ...options, target, commands.join(" && "));
  const each = (command: (file: (typeof FILES)[number]) => string) => FILES.map(command);

  writeFileSync(join(work, "webdroid.env"), `APP_ORIGIN=${frontendOrigin}\nWEBVIEW_ORIGIN=${backendOrigin}\nHOST=127.0.0.1\nPORT=8787\n`);
  writeFileSync(join(work, "Caddyfile"), `${new URL(backendOrigin).hostname} {\n  reverse_proxy 127.0.0.1:8787\n}\n`);
  run("scp", ...options, ...FILES.map(([name]) => join(work, name)), `${target}:`);
  // nothing has changed yet; any .prev is from an earlier release, which a rollback must not restore
  ssh("sudo cloud-init status --wait", `sudo rm -f ${each(([, to]) => `${to}.prev`).join(" ")}`,
    "sudo /usr/local/bin/node --check server.mjs", "caddy validate --adapter caddyfile --config Caddyfile");
  try {
    ssh(...each(([, to]) => `{ [ ! -e ${to} ] || sudo cp -p ${to} ${to}.prev; }`),
      ...each(([name, to, owner]) => `sudo install ${owner} ${name} ${to}.next && sudo mv ${to}.next ${to}`),
      "rm server.mjs webdroid.env Caddyfile", "sudo systemctl enable caddy", "sudo systemctl restart webdroid caddy");
    for (const deadline = Date.now() + 60_000; ;) {
      const healthy = await fetch(`${backendOrigin}/health`, { signal: AbortSignal.timeout(5000) })
        .then(async (r) => r.ok && (await r.json()).status === "ok").catch(() => false);
      if (healthy) break;
      if (Date.now() > deadline) throw new Error("Backend HTTPS health check failed; inspect systemctl status webdroid caddy");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } catch (error) {
    ssh(...each(([, to]) => `{ [ ! -e ${to}.prev ] || sudo mv ${to}.prev ${to}; }`), "sudo systemctl restart webdroid caddy");
    throw error;
  }
  console.log(`Backend deployed: ${backendOrigin}`);
}

const work = mkdtempSync(join(tmpdir(), "webdroid-release-"));
try {
  if (branch === "main") {
    // both components compile before production changes
    wrangler("pages", "functions", "build", "--outdir", join(work, "functions"));
    writeFileSync(join(work, "server.mjs"), await bundle("backend/index.ts", { platform: "node", define: { "process.env.NODE_ENV": '"production"' } }));
    await withSshAccess(() => deployBackend(work));
  }
  wrangler("pages", "deploy", "dist", "--project-name", process.env.CLOUDFLARE_PAGES_PROJECT || "webdroid", "--branch", branch);
} finally {
  rmSync(work, { recursive: true, force: true });
}
