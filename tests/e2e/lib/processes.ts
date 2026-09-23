import type { Page } from "playwright";

export type ProcessDiagnostics = {
  status: "ok";
  pkg: string | null;
  ticks: number;
  missing: string[];
  native: string[];
  errors: string[] | null;
  perf: Record<string, number> | null;
  queue: { queued: number; depth: number; phase: string } | null;
  compositor: unknown;
  unreadAttrs: string[] | null;
  coverage: { enabled: boolean; methods: string[] } | null;
} | { status: "unavailable" } | { status: "failure"; message: string };

export type ProcessSnapshot = { url: string; diagnostics: ProcessDiagnostics };

export function isWebdroidProcessFrame(url: string, origin: string): boolean {
  if (!URL.canParse(url)) return false;
  const frame = new URL(url), root = new URL(origin);
  return frame.origin === root.origin && (frame.pathname === "/" || frame.pathname === "/process");
}

export async function readProcesses(page: Page): Promise<ProcessSnapshot[]> {
  return Promise.all(page.frames().map(async (frame) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const diagnostics = await Promise.race([frame.evaluate(() => {
        const wd = globalThis.wd;
        return wd ? { status: "ok" as const, pkg: wd.app()?.host.pkg ?? null, ticks: wd.ticks, missing: [...wd.rt.missing], native: [...wd.rt.nativeRequired],
          errors: wd.logs?.filter((line: string) => /^(error:|window.error:|unhandledrejection:)/.test(line)) ?? null,
          perf: wd.perf ? { ...wd.perf } : null,
          queue: wd.mainDbg ? { queued: wd.mainDbg.queued, depth: wd.mainDbg.depth, phase: wd.mainDbg.phase } : null,
          compositor: Reflect.get(wd, "compositorStatus") ?? null,
          unreadAttrs: wd.unreadAttrs?.() ?? null,
          coverage: wd.jvmCoverage?.snapshot?.() ?? null } : { status: "unavailable" as const };
      }).catch((error) => ({ status: "failure" as const, message: String(error) })),
      new Promise<{ status: "failure"; message: string }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "failure", message: "diagnostic timeout" }), 3000);
      })]);
      return { url: frame.url(), diagnostics };
    } finally {
      clearTimeout(timer);
    }
  }));
}
