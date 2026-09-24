import worker from "../worker/index";

export const onRequest: PagesFunction<Env> = (context) =>
  worker.fetch(context.request, context.env, context as unknown as ExecutionContext);
