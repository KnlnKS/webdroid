import { serveHost } from "../worker/index.ts";
import { branchOrigin } from "../worker/preview.ts";
import { rendererRoute, sharedRoute } from "../src/shell/serve-routes.ts";

export const onRequest: PagesFunction<Env & { WORKER_PREVIEW_ORIGIN?: string; CF_PAGES_BRANCH?: string }> = ({ request, env }) => {
  const url = new URL(request.url);
  if (!rendererRoute(url)) return new Response("Not found", { status: 404 });
  const host = serveHost(env);
  if (env.WORKER_PREVIEW_ORIGIN) {
    if (!env.CF_PAGES_BRANCH) return new Response("Preview branch unavailable", { status: 503 });
    const origin = branchOrigin(env.WORKER_PREVIEW_ORIGIN, env.CF_PAGES_BRANCH);
    host.bridge = call => {
      const url = new URL(call.url);
      return fetch(new Request(new URL(url.pathname + url.search, origin), call));
    };
  }
  return sharedRoute(url, host)?.(request) ?? new Response("Not found", { status: 404 });
};
