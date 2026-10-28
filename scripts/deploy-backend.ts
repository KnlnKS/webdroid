import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIPv4 } from "node:net";

const output = JSON.parse(execFileSync(process.env.PULUMI_BIN ?? "pulumi", ["-C", "infra", "stack", "output", "--json"], { encoding: "utf8" })) as {
  publicIp: string; backendOrigin: string; frontendOrigin: string;
};
if (!isIPv4(output.publicIp)) throw new Error("Missing instance IP; run pulumi up first");
for (const origin of [output.backendOrigin, output.frontendOrigin]) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin) throw new Error("Invalid deployment origin");
}
const key = process.env.WEBDROID_SSH_KEY;
if (!key) throw new Error("Set WEBDROID_SSH_KEY to the private SSH key matching infra's sshPublicKeyPath");
const target = `ubuntu@${output.publicIp}`, options = ["-i", key, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15"];
const ssh = (command: string) => execFileSync("ssh", [...options, target, command], { stdio: "inherit" });
const temporary = mkdtempSync(join(tmpdir(), "webdroid-backend-"));
try {
  const env = `APP_ORIGIN=${output.frontendOrigin}\nWEBVIEW_ORIGIN=${output.backendOrigin}\nHOST=127.0.0.1\nPORT=8787\n`;
  writeFileSync(join(temporary, "webdroid.env"), env);
  writeFileSync(join(temporary, "Caddyfile"), `${new URL(output.backendOrigin).hostname} {\n  reverse_proxy 127.0.0.1:8787\n}\n`);
  ssh("sudo cloud-init status --wait");
  execFileSync("scp", [...options, "dist-backend/server.mjs", join(temporary, "webdroid.env"), join(temporary, "Caddyfile"), `${target}:/home/ubuntu/`], { stdio: "inherit" });
  ssh("sudo install -m 644 /home/ubuntu/webdroid.env /etc/webdroid.env && sudo install -m 644 /home/ubuntu/Caddyfile /etc/caddy/Caddyfile && sudo /usr/local/bin/node --check /home/ubuntu/server.mjs && sudo install -o webdroid -g webdroid -m 644 /home/ubuntu/server.mjs /opt/webdroid/server.mjs.next && sudo mv /opt/webdroid/server.mjs.next /opt/webdroid/server.mjs && sudo systemctl enable caddy && sudo systemctl restart webdroid caddy && rm /home/ubuntu/server.mjs /home/ubuntu/webdroid.env /home/ubuntu/Caddyfile");
  let healthy = false;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    healthy = await fetch(`${output.backendOrigin}/health`, { signal: AbortSignal.timeout(5000) }).then(async r => {
      const result = await r.json();
      return r.ok && result.status === "ok";
    }, () => false).catch(() => false);
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!healthy) throw new Error("Backend HTTPS health check failed; inspect systemctl status webdroid caddy");
  console.log(`Backend deployed: ${output.backendOrigin}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
