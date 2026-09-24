# Deployment

`bun run dev` remains the development server. It lists packages from `apks/` and also accepts local APK, XAPK and APKS files. `bun run build:prod` creates `dist/` for Cloudflare Workers. That build does not copy `apks/` or request `/apks`; users select packages in the browser. Package bytes are read from `File` objects, and local WebView assets are served through the browser service worker.

## Build and check

Install Bun, Zig 0.16 and project dependencies, then run:

```bash
bun install
bun run typecheck
bun run worker:check
```

The production build prepares the pinned system package data and framework resources, bundles both browser entrypoints, and copies their runtime assets. AOSP bytecode provenance assets are excluded by default. To include them, run `bun run gen-framework` and set `WEBDROID_INCLUDE_AOSP=1` for the build and Worker check. The build fails if either requested AOSP file is missing. Files over Cloudflare's static asset size limit are split and streamed by the Worker. The generated `dist/` directory is disposable.

For local Worker testing, use `bun run worker:dev`. To deploy after configuring the sites below, run `bun run build:prod` followed by `bunx wrangler deploy`.

Cloudflare Workers Builds connects to the `main` branch of `KnlnKS/webdroid`. Both Workers use `sh scripts/build-cloudflare.sh` and the build variable `BUN_VERSION=1.4.0`. Deploy the main Worker with `npx wrangler deploy --env=""` and its WebView renderer with `npx wrangler deploy --env webview`. The build script downloads checksum-pinned Zig 0.16.0, Android 33 platform resources, and Android build tools 35.0.1. The existing sql.js build script fetches Emscripten 4.0.9 and its pinned sources. Each build generates assets from the checked out commit; generated assets remain out of Git.

## Sites and configuration

WebView needs a browser origin separate from the main app so loaded pages cannot access its window and storage. The deployment uses `webdroid.kunalan-k-subagaran.workers.dev` for the app and `webdroid-webview.kunalan-k-subagaran.workers.dev` for the renderer. The renderer environment binds to the main Worker's `WebBridgeSession` Durable Object namespace. Other deployments can instead map two HTTPS hostnames to one Worker. Set `WEBVIEW_ORIGIN` to the renderer origin; it must differ from the address users open. JavaScript interfaces and WebView request interception depend on this isolation. The Worker returns 503 from `/webview-origin` until configured. Production `workers.dev` URLs are enabled and preview URLs are disabled.

The Worker serves the static frontend, HTTP proxy, DNS lookup, TCP WebSocket relay and WebView callback bridge. The callback bridge uses one Durable Object per random WebView session ID. No user package is uploaded to the Worker. The public proxy and TCP relay can reach destinations requested by loaded apps, so apply Cloudflare rate limits and access policy appropriate to the site before exposing it publicly.

Cloudflare's socket API does not expose ALPN selection or a reliable local endpoint. TLS socket calls therefore use the default protocol negotiation, and the relay reports the legacy `ok` frame when no endpoint is available. Native TLS carried as bytes over a plain TCP relay remains unchanged. Verify networking with the target apps on the deployed Worker; local Wrangler networking may differ from Cloudflare's edge.
