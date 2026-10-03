// Where a trace's Java frame was, resolved to its source file and line when the trace is read. A
// cold frame is at its next instruction. A compiled frame is at a line of the script holding its
// body (codecache's bodyAt), whose instruction the same emitter names when it marks each
// instruction's first line with its pc. The DEX's debug info gives the line of that pc.
import { runtimeOfDex, type ClassInfo, type Runtime } from "./runtime";
import type { ClassDef } from "./dex";
import { markedBody, type LazyMethod } from "./compiler";
import { bodyAt, type Form } from "./codecache";
import type { ColdAt } from "./cold";

/** a compiled frame: the script line its JS stack line names, and the method its function name does */
export interface CompiledAt { readonly url: string; readonly line: number; readonly methodIdx: number }
export type FrameAt = ColdAt | CompiledAt;

/** a body's pc by line, -1 above its first instruction */
const bodyPcs = new WeakMap<LazyMethod, Partial<Record<Form, Int32Array>>>();
function pcsOf(R: Runtime, info: ClassInfo, rec: LazyMethod, form: Form): Int32Array {
  const known = bodyPcs.get(rec) ?? {};
  bodyPcs.set(rec, known);
  if (known[form]) return known[form];
  const lines = markedBody(R, info, rec, form).split("\n"), pcs = new Int32Array(lines.length);
  let pc = -1;
  for (let i = 0; i < lines.length; i++) {
    const mark = /\/\*@(\d+)\*\//.exec(lines[i]);
    if (mark) pc = Number(mark[1]);
    pcs[i] = pc;
  }
  return known[form] = pcs;
}

const sourceFile = (def: ClassDef | undefined): string | null =>
  def && def.sourceFileIdx !== 0xffffffff ? def.dex.string(def.sourceFileIdx) : null;

/** the source file and line of a frame of class `cls` at `at`, -1 when the line cannot be told (an
 *  eagerly compiled class, a body this launch did not load). A frame that names no body (a native
 *  method's) finds its class by name among those `R` linked. */
export function frameSource(R: Runtime, cls: string, at: FrameAt | null): [file: string | null, line: number] {
  if (at && "method" in at) {
    const { R: owner, D, codeOff } = at.method;
    return [sourceFile(owner.classes.get(cls)?.def), codeOff === undefined ? -1 : D.dex.lineAt(codeOff, at.next - 1)];
  }
  const body = at && bodyAt(at.url, at.line), owner = body && body.methodIdx === at.methodIdx ? runtimeOfDex(body.dexId) : undefined;
  const info = owner?.classes.get(cls);
  if (!body || !owner || !info) return [sourceFile(R.classes.get(cls)?.def), -1];
  const rec = info.lazy?.find((r) => r.m.methodIdx === body.methodIdx && r.dex.id === body.dexId);
  const pc = rec ? pcsOf(owner, info, rec, body.form)[body.line] ?? -1 : -1;
  return [sourceFile(info.def), pc < 0 ? -1 : rec!.dex.lineAt(rec!.m.codeOff, pc)];
}
