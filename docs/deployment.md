# Deployment

`pnpm dev` remains the development server. It lists packages from `apks/` and also accepts local APK, XAPK and APKS files. `pnpm build:prod` creates `dist/` for Cloudflare Workers. That build does not copy `apks/` or request `/apks`; users select packages in the browser. Package bytes are read from `File` objects, and local WebView assets are served through the browser service worker.

## Build and check

Install Node 24 (`.node-version`), pnpm, Zig 0.16 and project dependencies, then run:

```bash
pnpm install
pnpm typecheck
pnpm worker:check
pnpm build:renderer
pnpm exec wrangler pages functions build --outdir /tmp/webdroid-pages-check
```

The production build prepares the pinned system package data and framework resources, bundles both browser entrypoints, and copies their runtime assets. It includes the platform class path under `vendor/aosp` (`pnpm gen-framework`) and fails if any of its files is missing. Files over Cloudflare's static asset size limit are split and streamed by the Worker. If `vendor/wasm-aot` holds a platform build (`pnpm aot`), it is copied under `aot/` with immutable cache headers; a build made from other sources fails the production build. The generated `dist/` directory is disposable.

For local Worker testing, use `pnpm worker:dev`. To deploy after configuring the sites below, run `pnpm build:prod` followed by `pnpm exec wrangler deploy --env=""`.

The Pages project deploys from Git automatically.

Cloudflare Workers Builds connects the main Worker to the `main` branch of `KnlnKS/webdroid`. It uses `sh scripts/build-cloudflare.sh`, Node from `.node-version`, build variables `PNPM_VERSION=11.0.8`, `WEBDROID_AOSP_URL` and `WEBDROID_AOSP_SHA256`, and deploy command `npx wrangler deploy --env=""`.

The Pages project `webdroid-renderer` deploys `main` to production and other branches to preview URLs, with `pages-renderer` as its output directory. Pages automatically installs dependencies; set `PNPM_VERSION=11.0.8` and build command `npm run build:renderer --if-present`. The optional script keeps the older `main` revision, which embeds its renderer sources and has no build step, deployable until this branch merges. On this branch, `build:renderer` runs the shared generator with `--pages` to create `src/shell/webpage.gen.ts` before Pages compiles Functions. It needs Node and the locked dependencies, but no Zig, Emscripten or reference-device assets. Pages does not rebuild or upload the emulator assets.

In Pages Settings > Bindings, bind `WEB_BRIDGES` to the main Worker's `webdroid_WebBridgeSession` Durable Object namespace, then redeploy Pages so the binding takes effect.

The Worker build script downloads checksum-pinned Zig 0.16.0 and the platform class path: `vendor/aosp` comes from the reference device, which a build machine lacks, so `WEBDROID_AOSP_URL` names an archive of it made after `pnpm gen-framework` (`tar -C vendor -czhf aosp.tar.gz aosp`) and `WEBDROID_AOSP_SHA256` pins that archive's digest. The existing sql.js build script fetches Emscripten 4.0.9 and its pinned sources. Each Worker build generates assets from the checked out commit; generated assets remain out of Git.

## Sites and configuration

WebView needs a separate browser site from the main app so loaded pages cannot access its window and storage, and so synchronous JavaScript interface calls do not block the main app's event loop. The deployment uses `webdroid.kunalan-k-subagaran.workers.dev` for the app and `webdroid-renderer.pages.dev` for the renderer. Two hostnames under the same `workers.dev` account subdomain remain same-site in Chromium and can deadlock these calls. Set `WEBVIEW_ORIGIN` to the renderer origin on a different registrable domain; changing only the hostname is insufficient. A `*` label in it (`https://*.renderer.example`, served by a wildcard DNS name and route) gives each app install's web origins their own renderer origin, so their storage stays apart as a WebView data directory keeps it and a reinstall starts clean; a fixed origin shares one renderer origin's storage among every app and site. The development server uses `*.localhost`. The Worker returns 503 from `/webview-origin` until configured. The main production URL is public and Worker preview URLs are disabled.

The Worker serves the static frontend, HTTP proxy, DNS lookup, TCP WebSocket relay and WebView callback bridge. Pages serves only the WebView frame, its service worker, proxy and callback routes; other renderer paths return 404. The callback bridge uses one Durable Object per random WebView session ID. No user package is uploaded to the Worker. The public proxy and TCP relay can reach destinations requested by loaded apps, so apply Cloudflare rate limits and access policy appropriate to the site before exposing it publicly.

Cloudflare's socket API does not expose ALPN selection or a reliable local endpoint. TLS socket calls therefore use the default protocol negotiation, and the relay reports the legacy `ok` frame when no endpoint is available. Native TLS carried as bytes over a plain TCP relay remains unchanged. Verify networking with the target apps on the deployed Worker; local Wrangler networking may differ from Cloudflare's edge.
