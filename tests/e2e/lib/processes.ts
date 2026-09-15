import type { Page } from "playwright";

export async function readProcesses(page: Page) {
  return Promise.all(page.frames().map(async (frame) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const diagnostics = await Promise.race([frame.evaluate(() => {
        const wd = globalThis.wd;
        return wd ? { pkg: wd.app()?.host.pkg, ticks: wd.ticks, missing: [...wd.rt.missing], native: [...wd.rt.nativeRequired],
          errors: wd.logs?.filter((line: string) => /^(error:|window.error:|unhandledrejection:)/.test(line)) ?? null,
          perf: wd.perf ? { ...wd.perf } : null,
          queue: wd.mainDbg ? { queued: wd.mainDbg.queued, depth: wd.mainDbg.depth, phase: wd.mainDbg.phase } : null,
          compositor: Reflect.get(wd, "compositorStatus") ?? null,
          unreadAttrs: wd.unreadAttrs?.() ?? null,
          coverage: wd.jvmCoverage?.snapshot?.() ?? null } : null;
      }).catch((error) => ({ failure: String(error) })),
      new Promise<{ failure: string }>((resolve) => {
        timer = setTimeout(() => resolve({ failure: "diagnostic timeout" }), 3000);
      })]);
      return { url: frame.url(), diagnostics };
    } finally {
      clearTimeout(timer);
    }
  }));
}

export type ProcessSnapshot = Awaited<ReturnType<typeof readProcesses>>[number];
