import { validateProbeCase, validateProbeResult, type ProbeCase, type ProbeResult } from "./model.ts";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };

export type CaseServer = {
  url: string;
  results: Promise<ProbeResult[]>;
  stop(): void;
};

export function serveCases(cases: readonly ProbeCase[], port = 0, caseTimeoutMs = 5_000): CaseServer {
  const queue = cases.map(validateProbeCase);
  const expected = new Map(queue.map((item) => [item.id, item]));
  if (expected.size !== queue.length) throw new Error("case ids must be unique");
  const received = new Map<string, ProbeResult>();
  let next = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let resolveResults!: (results: ProbeResult[]) => void;
  let rejectResults!: (error: Error) => void;
  const results = new Promise<ProbeResult[]>((resolve, reject) => { resolveResults = resolve; rejectResults = reject; });
  const arm = (id: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => rejectResults(new Error(`case ${id} timed out after ${caseTimeoutMs}ms`)), caseTimeoutMs);
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (path === "/case" && request.method === "GET") {
        const item = queue[next++];
        if (!item) return new Response(null, { status: 204, headers: CORS });
        arm(item.id);
        return Response.json(item, { headers: CORS });
      }
      if (path === "/result" && request.method === "POST") {
        try {
          const result = validateProbeResult(JSON.parse(await request.text()));
          const wanted = expected.get(result.id);
          if (!wanted) throw new Error(`unexpected result id ${result.id}`);
          if (wanted.kind !== result.kind) throw new Error(`result kind mismatch for ${result.id}`);
          if (received.has(result.id)) throw new Error(`duplicate result ${result.id}`);
          received.set(result.id, result);
          clearTimeout(timer);
          if (received.size === queue.length) resolveResults(queue.map((item) => received.get(item.id)!));
          return new Response(null, { status: 204, headers: CORS });
        } catch (error) {
          rejectResults(error instanceof Error ? error : new Error(String(error)));
          return new Response(String(error), { status: 400, headers: CORS });
        }
      }
      return new Response("not found", { status: 404, headers: CORS });
    },
  });
  if (!queue.length) resolveResults([]);
  return { url: server.url.href, results, stop: () => { clearTimeout(timer); server.stop(true); } };
}
