import type { Flow } from "../types.ts";
import type { StepRun } from "../capture-webdroid.ts";

const expectedError = (flow: Flow, message: string) => (flow.expectedErrors ?? []).some((part) => message.includes(part));

export function diagnostics(flow: Flow, runs: StepRun[]): { errors: string[]; gaps: string[] } {
  const errors: string[] = [];
  const gaps: string[] = [];
  const live = flow.clock === "live";
  const brief = (item: string) => item.split("\n", 1)[0]!.slice(0, 300);
  const seenProcessErrors = new Set<string>();
  for (const step of runs) {
    const prefix = `${String(step.index).padStart(2, "0")} ${step.id}`;
    const action = flow.steps[step.index]?.action;
    if (live && action?.type === "tapText" && !action.optional && step.semanticHit !== true)
      errors.push(`${prefix}: required text target ${JSON.stringify(action.text)} was not found`);
    if (step.mainLoopWedged) errors.push(`${prefix}: main loop wedged`);
    if (step.settleTimedOut) errors.push(`${prefix}: completion timed out`);
    if (step.error) errors.push(`${prefix}: ${brief(step.error)}`);
    if (step.evidence === "motion" && (step.perf?.presentations ?? 0) < 2) errors.push(`${prefix}: motion checkpoint presented no motion`);
    // a service lookup that got servicemanager's documented null is a boundary gap the app
    // handles, not a failure; it stays reported until a binder service answers for it
    for (const item of step.newMissing ?? []) (live || item.endsWith(" [binder]") ? gaps : errors).push(`${prefix}: missing ${item}`);
    for (const item of step.nativeRequired ?? []) (live ? gaps : errors).push(`${prefix}: native code required ${item}`);
    for (const item of step.newErrors ?? []) if (!expectedError(flow, item)) (live ? gaps : errors).push(`${prefix}: ${brief(item)}`);
    const processes = step.processes ?? [];
    if (!processes.length) errors.push(`${prefix}: no webdroid process diagnostics`);
    for (const process of processes) {
      const diagnostics = process.diagnostics;
      if (diagnostics.status === "exited") continue;
      if (diagnostics.status !== "ok") {
        errors.push(`${prefix}: ${process.url} diagnostics ${diagnostics.status}`);
        continue;
      }
      for (const item of diagnostics.errors ?? []) {
        const key = `${process.url}:${item}`;
        if (seenProcessErrors.has(key)) continue;
        seenProcessErrors.add(key);
        if (!(step.newErrors ?? []).includes(item) && !expectedError(flow, item)) (live ? gaps : errors).push(`${prefix}: ${process.url}: ${brief(item)}`);
      }
    }
  }
  return { errors, gaps };
}

export function browserFailures(flow: Flow, errors: string[]): string[] {
  return errors.filter((error) => !expectedError(flow, URL.canParse(error) ? new URL(error).searchParams.get("msg") ?? error : error))
    .map((error) => `browser: ${error.slice(0, 300)}`);
}

