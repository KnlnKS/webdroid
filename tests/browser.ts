// The pages the browser tests drive: modules bundled for a browser, served beside an empty page
import { build } from "vite/rolldown";
import { serve, type Served } from "../scripts/serve.ts";

/** `entries` (from the repository root) bundled for a browser with their shared chunks, each at "/" and its file name
 *  (src/shell/rpc.ts at /rpc.js); what `route` answers comes first, an empty page anywhere else */
export async function serveModules(entries: string[], route: (request: Request, path: string) => Response | undefined = () => undefined): Promise<Served> {
  const { output } = await build({ input: entries, platform: "browser", write: false, logLevel: "warn" });
  const modules = new Map(output.flatMap((out) => out.type === "chunk" ? [["/" + out.fileName, out.code]] : []));
  return serve({ fetch: (request) => {
    const path = new URL(request.url).pathname, code = modules.get(path);
    return route(request, path) ?? (code === undefined ? new Response("<!doctype html><body>", { headers: { "content-type": "text/html" } })
      : new Response(code, { headers: { "content-type": "text/javascript" } }));
  } });
}
