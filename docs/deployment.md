# Deployment

`pnpm dev` remains the development server, which answers the page and its backend on one origin. It lists packages from `apks/` and also accepts local APK, XAPK and APKS files. `pnpm build:prod` creates `dist/`, the shell page for Cloudflare Pages. That build does not copy `apks/` or request `/apks`; users select packages in the browser. Package bytes are read from `File` objects, and local WebView assets are served through the page's service worker (`webview-worker.js`).

The deployment has two parts:

- **Frontend, Cloudflare Pages** (`wrangler.jsonc`, project `webdroid`): `dist/` as static files, and one Function (`functions/[[path]].ts`) for the paths `dist/_routes.json` names. It answers platform files in byte ranges and inflates microg downloads, and forwards the backend's routes (`/proxy`, `/dns`, `/dns-query`, `/tcp`, `/webview-socket`, `/webview-origin`) on the page's own origin. Every other request is a static asset that runs no code.
- **Backend, a Worker** (`worker/wrangler.jsonc`, which Worker commands name with `-c`): the HTTP proxy, DNS lookup, TCP WebSocket relay and WebView callback bridge, whose Durable Object holds one session per random WebView session ID. The Worker is also the WebView renderer's origin: its frames, their service worker, proxy and callback routes. No user package is uploaded to it.

The page's backend calls stay same-origin, so they need no CORS preflight (each proxied URL would need its own) and the page needs no backend address. Production forwards through a service binding (`BACKEND`), which adds no network hop. A static binding cannot select a branch's Worker preview, so previews forward by `BACKEND_ORIGIN` instead: the Pages preview at `<alias>.webdroid.pages.dev` forwards to `https://<alias>-webdroid-backend.kunalan-k-subagaran.workers.dev`. Only alias URLs reach a backend; a deployment's unique hash URL does not.

## Build and check

Install Node 24 (`.node-version`), pnpm, Zig 0.16 and project dependencies, then run:

```bash
pnpm install
pnpm typecheck
pnpm deploy:check
```

`deploy:check` dry-runs the Worker deployment and compiles the Pages Function. The production build prepares the pinned system package data and framework resources, bundles both browser entrypoints, and copies their runtime assets. It includes the platform class path under `vendor/aosp` (`pnpm gen-framework`) and fails if any of its files is missing. Cloudflare's static asset serving ignores `Range` and gives no `Content-Length`, so platform files and certificates pass through the Function, which answers byte ranges by the sizes the build indexes in `asset-sizes.json`. Files over the 25 MiB static asset limit are split into parts, which it streams as one. If `vendor/wasm-aot` holds a platform build (`pnpm aot`), it is copied under `aot/` with immutable cache headers; a build made from other sources fails the production build. The generated `dist/` directory is disposable.

For local production testing, run `pnpm worker:dev` and, beside it, `pnpm pages:dev`, which builds `dist/` and serves it with the Function bound to the local Worker. `wrangler dev` answers every asset 200 with the whole body, so the page stops at its first chunked read unless the Function answers it.

## Deploying

`pnpm build:prod` followed by `pnpm release` deploys one build. From `main` it deploys the Worker to production (`wrangler deploy -c worker/wrangler.jsonc --env=""`), then the page to the Pages production branch. From another branch it deploys the Pages preview first, then a Worker preview named by the alias Pages gave the branch (wrangler's output file reports it), with `PREVIEW_ALIAS` set, so the Function's forward and the Worker's origins resolve the same alias. The branch comes from `WORKERS_CI_BRANCH`, or else the local Git branch.

Cloudflare Workers Builds connects the Worker to `KnlnKS/webdroid`. It uses `sh scripts/build-cloudflare.sh`, Node from `.node-version`, build variables `PNPM_VERSION=11.0.8`, `WEBDROID_AOSP_URL` and `WEBDROID_AOSP_SHA256`, and deploy command `pnpm release` for every branch. Its API token needs Cloudflare Pages edit permission as well as Workers. Create the Pages project once as a direct-upload project with production branch `main` (`pnpm exec wrangler pages project create webdroid --production-branch main`); it has no Git integration of its own, so the page and its backend always come from the same commit.

The Worker build script downloads checksum-pinned Zig 0.16.0 and the platform class path: `vendor/aosp` comes from the reference device, which a build machine lacks, so `WEBDROID_AOSP_URL` names an archive of it made after `pnpm gen-framework` (`tar -C vendor -czhf aosp.tar.gz aosp`) and `WEBDROID_AOSP_SHA256` pins that archive's digest. The existing sql.js build script fetches Emscripten 4.0.9 and its pinned sources. Each build generates assets from the checked out commit; generated assets remain out of Git.

## Sites and configuration

WebView needs a separate browser site from the main app so loaded pages cannot access its window and storage, and so synchronous JavaScript interface calls do not block the main app's event loop. The app is served from `webdroid.pages.dev` and the renderer from the Worker's `webdroid-backend.kunalan-k-subagaran.workers.dev`; `pages.dev` and `workers.dev` are public suffixes, so these are separate sites. Two hostnames under the same `workers.dev` account subdomain remain same-site in Chromium and can deadlock these calls, so a renderer origin must be on a different registrable domain from the app; changing only the hostname is insufficient. `WEBVIEW_ORIGIN` names the renderer origin and `APP_ORIGIN` the page's; in the Worker's preview variables, a `*` in either stands for the branch's alias. A `*` label in a production `WEBVIEW_ORIGIN` (`https://*.renderer.example`, served by a wildcard DNS name and route) gives each app install's web origins their own renderer origin, so their storage stays apart as a WebView data directory keeps it and a reinstall starts clean; a fixed origin shares one renderer origin's storage among every app and site. The development server uses `*.localhost`. `/webview-origin` returns 503 unless the renderer origin differs from the app's.

The renderer's pages share the Worker's origin, so the Worker opens its TCP relay and bridge sockets only to WebSockets whose Origin is `APP_ORIGIN`; the proxy also answers the renderer's own pages. The Worker redirects `/` to the app. The public proxy and TCP relay can reach destinations requested by loaded apps, so apply Cloudflare rate limits and access policy appropriate to the site before exposing it publicly.

Cloudflare's socket API does not expose ALPN selection or a reliable local endpoint. TLS socket calls therefore use the default protocol negotiation, and the relay reports the legacy `ok` frame when no endpoint is available. Native TLS carried as bytes over a plain TCP relay remains unchanged. Verify networking with the target apps on the deployed site; local Wrangler networking may differ from Cloudflare's edge.
