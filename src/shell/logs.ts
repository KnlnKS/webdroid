// The console lines and uncaught errors a realm keeps for the harness to read back: the page's wd.logs and
// each process Worker's snapshot. It has no imports, so a Worker captures from its first module on.
type Level = "log" | "warn" | "error";
const describe = (value: unknown): string => {
  if (typeof value === "string") return value;
  const o = value as { msg?: unknown; message?: unknown } | null;
  return String(o?.msg ?? o?.message ?? JSON.stringify(value)?.slice(0, 200) ?? value);
};
const reason = (error: unknown): string => {
  const e = error as { msg?: unknown; message?: unknown; stack?: unknown } | null;
  return `${e?.message ?? e?.msg ?? String(error)}\n${String(e?.stack ?? "").slice(0, 600)}`;
};
/** the console lines of each level `labels` names, under its label, and the realm's uncaught errors; the oldest
 *  quarter goes once there are more than `cap` */
export function captureLogs(labels: Partial<Record<Level, string>>, cap: number): string[] {
  const logs: string[] = [];
  const push = (line: string) => { logs.push(line); if (logs.length > cap) logs.splice(0, cap >> 2); };
  for (const [level, label] of Object.entries(labels) as [Level, string][]) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try { push(label + ": " + args.map(describe).join(" ")); } catch { /* an argument without a description */ }
    };
  }
  addEventListener("error", (e) => push(`window.error: ${e.message} @${e.filename}:${e.lineno}`));
  addEventListener("unhandledrejection", (e) => push("unhandledrejection: " + reason(e.reason)));
  return logs;
}
