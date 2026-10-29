# Deployment

The frontend and every platform asset stay on **Cloudflare Pages**. The HTTP proxy, DNS,
TCP/UDP WebSocket relays and WebView callback bridge run in **Node 24 on Oracle Always Free
compute**. `infra/` provisions the network, VM and Pages configuration with TypeScript and
Pulumi. Wrangler is used only to compile/upload Pages Functions, never to run a server.

## Local development and checks

`pnpm dev` serves the frontend, local assets and the shared Node backend. It can reach the
developer's network; the production backend checks resolved addresses and refuses private
networks, including cloud metadata. Both use the same socket relays and WebView bridge.

```sh
pnpm install
pnpm typecheck
pnpm test tests/backend.test.ts
pnpm deploy:check
pnpm check
```

`pnpm backend:dev` starts only the production backend on loopback port 8787. Set `APP_ORIGIN`
and `WEBVIEW_ORIGIN` to the frontend and renderer origins. `pnpm backend:build` produces the
standalone `dist-backend/server.mjs`; no APK, platform binary or user state goes to the VM.

## Free-tier constraints

The default `arm` profile uses one `VM.Standard.A1.Flex` instance, **1 OCPU, 6 GB RAM, 50 GB boot disk**, and
an Ubuntu platform image. If ARM capacity is unavailable, `pulumi -C infra config set compute micro`
selects the other Always Free shape, `VM.Standard.E2.1.Micro` (1/8 OCPU, 1 GB RAM, 50 GB disk).
These are the only accepted profiles; micro allocation is also checked against its two-instance
free limit. The micro profile has less CPU headroom for concurrent WebView script rewriting.
The program verifies the tenancy's home region and inventories instances,
boot volumes and block volumes across every active compartment before creating resources.
It refuses allocations exceeding **2 OCPUs / 12 GB RAM / 200 GB combined disk**. Failure to
read inventory aborts deployment. Replacement requires explicitly removing Pulumi protection,
then deletes the old VM before creating its replacement; its boot disk is not preserved.
There is no paid-shape fallback when ARM capacity is unavailable.

These are the [current Oracle Always Free limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm),
checked 2026-10-28. The older 4-OCPU/24-GB allowance must not be assumed. Keep the account
unupgraded: trial credit is not a reason to create paid resources. The stack creates no load
balancer, NAT gateway, reserved IP, backup, paid image or paid logging service.

The VM's egress is paced at **20 Mbit/s** by Linux `tc`, less than 7 TB even when saturated
for 31 days, below the 10-TB monthly free allowance. This limits proxy throughput; static
frontend downloads bypass OCI entirely. Other resources share the tenancy's free allowances.
The inventory check is not an account-wide spending lock and cannot prevent concurrent or
out-of-band provisioning or changes to Oracle's pricing. Do not run concurrent applies or
add other paid workloads. Oracle may reclaim idle Always Free instances.

## Provision

Install the [Pulumi CLI](https://www.pulumi.com/docs/install/) and configure an OCI API signing
key in `~/.oci/config`. Keep all private keys out of the repository. Use a Cloudflare API token
with Account/Pages edit permission and the appropriate account scope in `CLOUDFLARE_API_TOKEN`.

```sh
pulumi login --local
pulumi -C infra stack init oci
pulumi -C infra config set oci:tenancyOcid <tenancy-ocid>
pulumi -C infra config set oci:region <home-region>
pulumi -C infra config set cloudflareAccountId <account-id>
pulumi -C infra config set sshPublicKeyPath /absolute/path/to/key.pub
pulumi -C infra config set sshCidr <your-public-ip>/32
```

An existing Pages project must be imported once, preserving its identity:

```sh
pulumi -C infra import cloudflare:index/pagesProject:PagesProject frontend <account-id>/webdroid --generate-code=false
pulumi -C infra preview
pulumi -C infra up --target 'urn:pulumi:oci::webdroid::oci:**'
```

The targeted first apply provisions OCI without changing Pages. Substitute the stack name for
`oci` in the URN if using another stack. Deploy and verify the backend before a full apply points
Pages at it. For a new project, omit the import. `pagesProject` defaults to `webdroid`; `compartmentId`
defaults to the tenancy root. `availabilityDomain` can select another domain in the home region
when free ARM capacity is unavailable. Pulumi state and stack configuration are ignored by
Git; back up the state and its encryption passphrase separately. An unavailable free shape
is a deployment blocker, not permission to upgrade or choose paid compute.

The VM uses an ephemeral public IP and the free hostname `webdroid.<ip>.sslip.io`. Caddy obtains
and renews its free TLS certificate. A replacement VM changes the hostname; reapply and
redeploy both components. DNS and certificate issuance depend on sslip.io and the certificate
authority. SSH is restricted to the configured IPv4 /32; Node listens only on loopback behind
Caddy. The instance has no OCI instance-principal policy.

## Release

```sh
export WEBDROID_SSH_KEY=/absolute/path/to/private-key
pnpm backend:deploy
pulumi -C infra up
pnpm build:prod
pnpm release
```

`backend:deploy` waits for cloud-init, installs the bundle and configuration over SSH, restarts
Node/Caddy, and checks HTTPS health. SSH trusts a previously unseen host key on first use and
rejects changes thereafter. Verify its fingerprint through the OCI console for a first deployment.
`PULUMI_BIN` can name a CLI outside `PATH`. Backend updates restart live sockets and bridge
sessions; reload active apps after an update. The VM holds no durable application state.

Verify the preview, then use `CF_PAGES_BRANCH=main pnpm release` to publish the same build to production.
`release` uploads only the frontend to Pages. `main` publishes production; other branches
publish previews. `CF_PAGES_BRANCH` overrides the Git branch; `CLOUDFLARE_PAGES_PROJECT` overrides the project name.
There is no Wrangler config file: a file with empty bindings would override Pulumi's Pages variables on upload. Both environments point to the
same OCI backend, configured by Pulumi's `BACKEND_ORIGIN` variable. Previews therefore test
against the deployed backend version; this stack does not allocate a VM for each branch.
Optional `GITHUB_TOKEN` and `GITHUB_SHA` report preview deployments to GitHub.

The build requires Node 24, pnpm, Zig 0.16 and `vendor/aosp` from `pnpm gen-framework`.
`scripts/build-cloudflare.sh` can build in CI using a pinned AOSP archive supplied through
`WEBDROID_AOSP_URL` and `WEBDROID_AOSP_SHA256`. There is no Workers Builds runtime or backend
preview dependency. Backend releases use SSH; frontend releases use Pages direct uploads.
### GitHub Actions

`.github/workflows/deploy.yml` builds and deploys each push to `main`. Manual runs are also
restricted to `main`. A single production concurrency group lets an active release finish
before the next starts. The workflow installs the lockfile, verifies the pinned AOSP/Zig
archives, typechecks, runs the core backend tests, compiles Pages Functions and the platform AOT modules, and builds both
components before changing production. It then deploys and health-checks OCI, removes its
SSH rule, and publishes Pages. A failed backend deployment or SSH cleanup prevents the
frontend upload. Infrastructure provisioning remains a separate Pulumi operation.

Configure these GitHub Actions repository variables (or overrides in the `production` environment):

| Variable | Value |
| --- | --- |
| `WEBDROID_AOSP_URL` | Downloadable archive made with `tar -C vendor -czhf aosp.tar.gz aosp` |
| `WEBDROID_AOSP_SHA256` | SHA-256 of that exact archive |
| `CLOUDFLARE_ACCOUNT_ID` | Account containing the Pages project |
| `CLOUDFLARE_PAGES_PROJECT` | Pages project name; defaults to `webdroid` |
| `WEBDROID_DEPLOYMENT` | JSON containing Pulumi's `publicIp`, `backendOrigin`, `frontendOrigin` outputs |
| `OCI_SECURITY_LIST_ID` | Pulumi's `securityListId` output |

Configure these Actions secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Account-scoped Cloudflare Pages Edit token |
| `OCI_CONFIG` | OCI `[DEFAULT]` INI profile with `user`, `tenancy`, `fingerprint`, `region` |
| `OCI_API_KEY` | Unencrypted PEM signing key matching that profile |
| `WEBDROID_SSH_PRIVATE_KEY` | Private SSH key matching the VM's authorized key |
| `WEBDROID_SSH_KNOWN_HOSTS` | Verified OpenSSH known-hosts entry for `publicIp` |

The OCI API identity needs `GetSecurityList` and `UpdateSecurityList` access to the configured
list; it does not need compute provisioning permissions. CI overrides the profile's `key_file`
with its temporary key path. `WEBDROID_DEPLOYMENT` lets the existing backend deployer run
without Pulumi, its state or its passphrase. Local releases still read Pulumi by default.
CI uses strict SSH host verification and batch mode; obtain the known-hosts entry through a
trusted connection, not an unchecked `ssh-keyscan` during a release.

Only the runner's public IPv4 `/32` gets temporary TCP/22 access. The firewall helper preserves
all unrelated ingress and egress, uses the list's ETag to retry concurrent edits, and removes
its marked rule in an `always()` step, including after deployment failure or cancellation.
A forcibly lost runner can leave the rule behind: the next release replaces that stale rule.
To remove it manually, set `OCI_SECURITY_LIST_ID` and run `python scripts/deploy-firewall.py`
with the OCI Python SDK installed (`oci==2.189.0`). Do not overlap releases with manual backend
deployments or Pulumi applies. A VM replacement requires refreshing the deployment JSON,
security-list ID and verified SSH host key before another release.

Backend restarts interrupt live sessions. If Pages upload fails after the backend succeeds,
production temporarily runs the new backend with the old frontend; rerun the release once
the failure is resolved. The workflow does not attempt to roll back either service.

## Assets, origins and transport

Pages serves `dist/`, including fonts, Wasm, reference framework files and optional AOT builds.
Its small Function answers byte ranges, streams files larger than the 25-MiB asset limit from
parts, serves gzip-encoded microG packages, and forwards the backend routes without buffering
their bodies. `/udp` and `/tcp` upgrade to WebSockets; the VM opens the actual outbound UDP/TCP
sockets. No public UDP listener or inbound TCP port range is needed. TLS termination for Java
sockets includes ALPN negotiation and reports the real local socket endpoint; native TLS
stacks continue to send their own bytes unchanged.

The app remains on `webdroid.pages.dev`; WebView runs on the separate sslip.io site so its
pages cannot access the app's window/storage or deadlock synchronous JavaScript callbacks.
The app's own networking remains same-origin through Pages. Browser socket requests must
come from the app origin or its Pages preview hosts. Origin validation is browser isolation,
not user authentication: non-browser clients can forge it. This remains a public outbound
proxy with bounded egress, not a private access service.

## Current installation (2026-10-28)

Stack `oci` runs the micro profile in `us-sanjose-1`, because the ARM create request returned
`Out of host capacity`. The backend is `https://webdroid.163.192.4.18.sslip.io`; the frontend remains
`https://webdroid.pages.dev`. No subscription was upgraded and no paid resource was provisioned.
The former `webdroid-backend` Worker was deleted after production verification. The older all-in-one
`webdroid` Worker's public and preview endpoints are disabled; it is retained as an inactive archive.

On the provisioning machine, the Pulumi CLI is `~/.pulumi/bin/pulumi`, its state is in
`~/.local/share/webdroid/pulumi`, and its passphrase file is `~/.oci/webdroid-pulumi-passphrase`.
The OCI API key is configured in `~/.oci/config`; the SSH key is `~/.ssh/webdroid-oci`.
Use the same state backend rather than initializing a second stack:

```sh
export PATH="$HOME/.pulumi/bin:$PATH"
export PULUMI_BACKEND_URL="file://$HOME/.local/share/webdroid/pulumi"
export PULUMI_CONFIG_PASSPHRASE_FILE="$HOME/.oci/webdroid-pulumi-passphrase"
export WEBDROID_SSH_KEY="$HOME/.ssh/webdroid-oci"
```

Cloudflare changes also require `CLOUDFLARE_API_TOKEN`. Back up state, the ignored stack configuration,
passphrase and keys securely; none are committed. If the administrator's public IP changes,
update `sshCidr` through Pulumi before deploying over SSH.
