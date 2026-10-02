import type { Page } from "playwright";

export type ProcessDiagnostics = {
  status: "ok";
  pkg: string | null;
  ticks: number;
  missing: string[];
  /** the Java frames that first reached each missing entry */
  missingAt: Record<string, string[]>;
  /** placeholder methods reached, and the Java frames that first reached each */
  placeholders: string[];
  placeholderAt: Record<string, string[]>;
  native: string[];
  errors: string[] | null;
  perf: Record<string, number> | null;
  queue: { queued: number; depth: number; phase: string } | null;
  compositor: unknown;
  coverage: { enabled: boolean; methods: string[] } | null;
} | { status: "unavailable" } | { status: "failure"; message: string };

export type ProcessSnapshot = { url: string; diagnostics: ProcessDiagnostics };

function isWebdroidProcessFrame(url: string, origin: string): boolean {
  if (!URL.canParse(url)) return false;
  const frame = new URL(url), root = new URL(origin);
  return frame.origin === root.origin && (frame.pathname === "/" || frame.pathname === "/process");
}

/** Diagnostics from every webdroid process frame (the shell and its /process children). */
export async function readProcesses(page: Page): Promise<ProcessSnapshot[]> {
  const origin = new URL(page.url()).origin;
  return Promise.all(page.frames().filter((frame) => isWebdroidProcessFrame(frame.url(), origin)).map(async (frame) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = () => frame.evaluate(() => {
        const wd = globalThis.wd;
        return wd ? { status: "ok" as const, pkg: wd.app()?.pkg ?? null, ticks: wd.ticks, missing: [...wd.rt.missing],
          missingAt: Object.fromEntries(wd.rt.missingAt ?? []),
          placeholders: [...wd.rt.placeholders],
          placeholderAt: Object.fromEntries(wd.rt.placeholderAt),
          native: wd.nativeRequirements(),
          errors: wd.logs?.filter((line: string) => /^(error:|window.error:|unhandledrejection:)/.test(line)) ?? null,
          perf: wd.perf ? { ...wd.perf } : null,
          queue: wd.mainDbg ? { queued: wd.mainDbg.queued, depth: wd.mainDbg.depth, phase: wd.mainDbg.phase } : null,
          compositor: Reflect.get(wd, "compositorStatus") ?? null,
          coverage: wd.jvmCoverage?.snapshot?.() ?? null } : { status: "unavailable" as const };
      });
      const diagnostics = await Promise.race([(async () => {
        let result = await read();
        if (result.status === "unavailable") {
          await frame.waitForFunction(() => !!globalThis.wd, null, { timeout: 2_000 });
          result = await read();
        }
        return result;
      })().catch((error) => ({ status: "failure" as const, message: String(error) })),
      new Promise<{ status: "failure"; message: string }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "failure", message: "diagnostic timeout" }), 6000);
      })]);
      return { url: frame.url(), diagnostics };
    } finally {
      clearTimeout(timer);
    }
  }));
}
