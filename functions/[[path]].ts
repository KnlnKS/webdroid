import worker from "../worker/index.ts";
import { rendererRoute } from "../src/shell/serve-routes.ts";

export const onRequest: PagesFunction<Env> = (context) => rendererRoute(new URL(context.request.url))
  ? worker.fetch(context.request, context.env, context as unknown as ExecutionContext) : new Response("Not found", { status: 404 });
