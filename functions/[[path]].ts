import worker from "../worker/index.ts";

export const onRequest: PagesFunction<Env> = (context) => {
  const url = new URL(context.request.url), path = url.pathname;
  if (!url.searchParams.has("__wd_bridge") && path !== "/proxy" && path !== "/webview" &&
      path !== "/webview-worker.js" && path !== "/webview-call") return new Response("Not found", { status: 404 });
  return worker.fetch(context.request, context.env, context as unknown as ExecutionContext);
};
