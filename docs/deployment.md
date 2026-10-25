# Deployment

`pnpm dev` serves the page and its backend on one origin and lists `apks/`. `pnpm build:prod` creates `dist/`, the shell page for Cloudflare Pages; it ships no APKs, so users pick packages in the browser (read from `File` objects, WebView assets served by `webview-worker.js`).

- **Frontend, Cloudflare Pages** (`wrangler.jsonc`, project `webdroid`): static `dist/` plus one Function (`functions/[[path]].ts`) for the paths in `dist/_routes.json`. It answers platform files in byte ranges, inflates microg downloads and forwards the backend routes (`/proxy`, `/dns`, `/dns-query`, `/tcp`, `/webview-socket`, `/webview-origin`) on the page's origin.
- **Backend, Worker `webdroid-backend`** (`worker/wrangler.jsonc`, passed with `-c`): HTTP proxy, DNS, TCP WebSocket relay and the WebView callback bridge, whose Durable Object holds one session per WebView session ID. It is also the WebView renderer's origin. No user package reaches it.

Backend calls stay same-origin, so they need no CORS preflight. Production forwards through the `BACKEND` service binding. A binding cannot select a branch preview, so previews forward by `BACKEND_ORIGIN`: `<alias>.webdroid.pages.dev` → `https://<alias>-webdroid-backend.kunalan-k-subagaran.workers.dev`. Unique hash URLs reach no backend.

## Build and check

With Node 24 (`.node-version`), pnpm and Zig 0.16:

```bash
pnpm install
pnpm typecheck
pnpm deploy:check
```

`deploy:check` dry-runs the Worker deploy and compiles the Function. The production build requires `vendor/aosp` (`pnpm gen-framework`). Cloudflare's asset serving ignores `Range`, so platform files and certificates pass through the Function, which serves ranges from the sizes in `asset-sizes.json` and streams files over the 25 MiB asset limit from parts. A platform build in `vendor/wasm-aot` (`pnpm aot`) is copied to `aot/` with immutable caching; one built from other sources fails the build.

Locally, run `pnpm worker:dev` beside `pnpm pages:dev`. Plain `wrangler dev` ignores ranges, which stalls the page's chunked reads.

## Deploying

`pnpm build:prod && pnpm release` deploys one build (`scripts/deploy.ts`; branch from `WORKERS_CI_BRANCH` or Git). On `main` it deploys the Worker, then Pages production. On other branches it deploys a Pages preview, then a Worker preview named by that alias with `PREVIEW_ALIAS` set. Pages checks the `BACKEND` binding on publish, so `webdroid-backend` must be deployed once before the first branch build.

Workers Builds connects `webdroid-backend` (its name must match `worker/wrangler.jsonc`, or previews land on the connected Worker) to `KnlnKS/webdroid`: build `sh scripts/build-cloudflare.sh`, deploy and preview command `pnpm release`, and variables `PNPM_VERSION=11.0.8`, `WEBDROID_AOSP_URL` and `WEBDROID_AOSP_SHA256` for both production and preview. Its API token needs Workers Scripts and Cloudflare Pages edit. The Pages project is direct-upload with no Git integration (`pnpm exec wrangler pages project create webdroid --production-branch main`), so page and backend come from one commit.

The build script fetches pinned Zig 0.16.0 and the `vendor/aosp` archive, which a build machine cannot generate: `WEBDROID_AOSP_URL` names `tar -C vendor -czhf aosp.tar.gz aosp` and `WEBDROID_AOSP_SHA256` pins it. Generated assets stay out of Git.

## Sites and configuration

WebView runs on a separate site so loaded pages cannot reach the app's window and storage and synchronous JavaScript interface calls cannot block its event loop. The app is on `webdroid.pages.dev`, the renderer on `webdroid-backend.kunalan-k-subagaran.workers.dev`; both suffixes are public, so these are separate sites. Two hosts under one `workers.dev` account subdomain are same-site in Chromium and can deadlock, so the renderer needs a different registrable domain. `WEBVIEW_ORIGIN` and `APP_ORIGIN` name the two origins; in preview variables `*` stands for the alias. A `*` label in a production `WEBVIEW_ORIGIN` (wildcard DNS and route) gives each app install its own renderer storage. Development uses `*.localhost`. `/webview-origin` returns 503 when the origins match.

The Worker accepts relay and bridge WebSockets only from `APP_ORIGIN` and redirects `/` to the app. The public proxy and relay reach whatever loaded apps request, so add rate limits and access policy before exposing them.

Cloudflare sockets expose no ALPN selection or reliable local endpoint, so TLS sockets use default negotiation and the relay sends the legacy `ok` frame. Verify networking on the deployed site; local Wrangler differs from the edge.
