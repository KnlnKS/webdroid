export type CompilePhase =
  `wasm.${"prepare" | "flow" | "infer" | "facts" | "emit" | "encode" | "classBuild" | "module" | "instantiate"}` |
  `residual.${"wasmSetup" | "wasmBuild" | "wasmUpgrade"}`;
type Span = { phase: CompilePhase; start: number; children: number };
export type CompileReceipt = { schema: 1; source: string; url: string; bornAt: number; at: number; sequence: number;
  spans: number; elapsedMs: number; phases: Readonly<Partial<Record<CompilePhase, number>>>; open: readonly CompilePhase[]; errors: readonly string[]; dropped: number };
const enabled = typeof location !== "undefined" && new URLSearchParams(location.search).get("compileProbe") === "1";
const bornAt = enabled ? performance.timeOrigin + performance.now() : 0;
const stack: Span[] = [], phases: Partial<Record<CompilePhase, number>> = {}, errors: string[] = [];
let sequence = 0, spans = 0, elapsedMs = 0, dropped = 0;
function error(message: string): void { if (errors.length < 8) errors.push(message); else dropped++; }
export const compilerReceiptsEnabled = enabled;
export function beginCompile(phase: CompilePhase): Span | null {
  if (!enabled) return null;
  if (stack.length === 128) { error("compiler span depth exceeded"); return null; }
  const span = { phase, start: performance.now(), children: 0 };
  stack.push(span); return span;
}
export function endCompile(span: Span | null): void {
  if (!span) return;
  const duration = performance.now() - span.start;
  if (stack.pop() !== span) { error("compiler span nesting mismatch"); return; }
  const own = duration - span.children;
  if (!Number.isFinite(own) || own < 0) { error("invalid compiler span elapsed time"); return; }
  phases[span.phase] = (phases[span.phase] ?? 0) + own;
  if (stack.length) stack[stack.length - 1].children += duration; else elapsedMs += duration;
  spans++;
}
export function measureCompile<T>(phase: CompilePhase, run: () => T): T {
  if (!enabled) return run();
  const span = beginCompile(phase);
  try { return run(); } finally { endCompile(span); }
}
export function compilerReceipt(): Readonly<CompileReceipt> | null {
  if (!enabled) return null;
  return Object.freeze({ schema: 1 as const, source: import.meta.url, url: location.href, bornAt, at: performance.timeOrigin + performance.now(),
    sequence: ++sequence, spans, elapsedMs, phases: Object.freeze({ ...phases }), open: Object.freeze(stack.map(s => s.phase)), errors: Object.freeze([...errors]), dropped });
}
