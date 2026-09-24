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

## Sites and configuration

Map two HTTPS hostnames to the same Worker: one for Webdroid and one for the isolated WebView renderer. Set `WEBVIEW_ORIGIN` in `wrangler.jsonc` to the renderer origin, such as `https://webview.example.com`. The origin must differ from the address users open. JavaScript interfaces and WebView request interception depend on this isolation. The Worker returns an explicit 503 from `/webview-origin` until configured.

The Worker serves the static frontend, HTTP proxy, DNS lookup, TCP WebSocket relay and WebView callback bridge. The callback bridge uses one Durable Object per random WebView session ID. No user package is uploaded to the Worker. The public proxy and TCP relay can reach destinations requested by loaded apps, so apply Cloudflare rate limits and access policy appropriate to the site before exposing it publicly.

Cloudflare's socket API does not expose ALPN selection or a reliable local endpoint. TLS socket calls therefore use the default protocol negotiation, and the relay reports the legacy `ok` frame when no endpoint is available. Native TLS carried as bytes over a plain TCP relay remains unchanged. Verify networking with the target apps on the deployed Worker; local Wrangler networking may differ from Cloudflare's edge.
