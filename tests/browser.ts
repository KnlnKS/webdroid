// The pages the browser tests drive: modules bundled for a browser, served beside an empty page
import type { Page } from "playwright";
import { build } from "vite/rolldown";
import { launchBrowser } from "../scripts/page.ts";
import { serve, type Served } from "../scripts/serve.ts";

type Route = (request: Request, path: string) => Response | undefined;

/** `entries` (from the repository root) bundled for a browser with their shared chunks, each at "/" and its file name
 *  (src/shell/rpc.ts at /rpc.js); what `route` answers comes first, an empty page anywhere else */
export async function serveModules(entries: string[], route: Route = () => undefined): Promise<Served> {
  const { output } = await build({ input: entries, platform: "browser", write: false, logLevel: "warn" });
  const modules = new Map(output.flatMap((out) => out.type === "chunk" ? [["/" + out.fileName, out.code]] : []));
  return serve({ fetch: (request) => {
    const path = new URL(request.url).pathname, code = modules.get(path);
    return route(request, path) ?? (code === undefined ? new Response("<!doctype html><body>", { headers: { "content-type": "text/html" } })
      : new Response(code, { headers: { "content-type": "text/javascript" } }));
  } });
}

/** what `test` answers given a page of the harnesses' Chrome (`jsFlags` added) opened on serveModules(`entries`) at `host` (127.0.0.1
 *  unless named) and `query`; an uncaught page error fails it, and the browser and server close after */
export async function withPage<T>(entries: string[], test: (page: Page) => Promise<T>,
  { query = "", host, jsFlags }: { query?: string; host?: string; jsFlags?: string } = {}): Promise<T> {
  const [server, browser] = await Promise.all([serveModules(entries), launchBrowser(jsFlags)]);
  try {
    const page = await browser.newPage(), errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://${host ?? server.url.hostname}:${server.port}/${query}`);
    const result = await test(page);
    if (errors.length) throw new Error(`page errors: ${errors.join("\n")}`);
    return result;
  } finally { await browser.close(); server.stop(true); }
}
