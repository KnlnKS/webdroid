// A compiled frame's source line, found when a trace is read rather than when it is thrown. A
// body's function name carries its method index; the frame's position in the script that holds the
// body (its own, or a persisted chunk) is a line of the body, whose instruction the same emitter
// names when it marks each instruction's first line with its pc. The DEX's debug info gives the
// line of that pc.
import type { ClassInfo, Runtime } from "./runtime";
import { markedBody, type LazyMethod } from "./compiler";
import { chunkBody } from "./codecache";

type Form = "e" | "r";
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

/** `new Function` puts its parameter list and the opening brace on the two lines above the body */
const FUNCTION_HEADER_LINES = 2;
/** the source line of a frame of compiled method `methodIdx` of `cls` in a JS stack line, -1
 *  when it cannot be told (an eagerly compiled class, a body this launch did not load) */
export function compiledLine(R: Runtime, stackLine: string, cls: string, methodIdx: number): number {
  const at = /\(?([^\s()]+):(\d+):\d+\)?\s*$/.exec(stackLine);
  if (!at || methodIdx < 0) return -1;
  const url = at[1], line = Number(at[2]);
  let form: Form, bodyLine: number;
  if (url.startsWith("wd/")) {
    form = url.endsWith(".resume.js") ? "r" : "e";
    bodyLine = line - FUNCTION_HEADER_LINES - 1;
  } else {
    const persisted = chunkBody(url, line);
    if (!persisted || !persisted.key.endsWith(`:${methodIdx}:${persisted.key.at(-1)}`)) return -1;
    form = persisted.key.at(-1) as Form;
    bodyLine = persisted.line;
  }
  try {
    const info = R.link(cls), rec = info.lazy?.find((r) => r.m.methodIdx === methodIdx);
    if (!rec) return -1;
    const pc = pcsOf(R, info, rec, form)[bodyLine] ?? -1;
    return pc < 0 ? -1 : rec.dex.lineAt(rec.m.codeOff, pc);
  } catch { return -1; }
}
